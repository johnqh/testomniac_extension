# SSO Popup Login Support

## Problem

Many web apps use popup-based OAuth (Google, Microsoft, GitHub, etc.)
instead of redirect-based OAuth. When the user clicks "Sign in with
Google", the app opens a new browser window/tab with
`accounts.google.com`. The current SSO handler assumes redirect flow —
it expects the same page to navigate to the provider. When a popup opens
instead, the adapter stays on the original tab and the SSO steps timeout.

## Goal

Support popup-based OAuth flows in the Chrome extension so that login
works regardless of whether the target app uses redirect or popup mode.

## Current Architecture

### BrowserAdapter interface (`runner_service/src/adapter.ts`)

Single-tab abstraction. No methods for detecting or switching between
windows/tabs. Both ChromeAdapter and PuppeteerAdapter are bound to one
tab at construction time.

### SSO handler (`runner_service/src/orchestrator/sso-handler.ts`)

`executeSSOFlow()` follows this sequence:

1. Click SSO button on the app's login page.
2. Wait for in-page navigation to the provider.
3. Execute provider-specific steps (type email → next → type password → submit).
4. Poll for URL redirect back to app origin (30 s timeout).

Step 2 fails silently when the provider opens in a popup because the
original page never navigates away.

### LoginManager (`runner_service/src/orchestrator/login-manager.ts`)

Orchestrates login. Calls `executeSSOFlow()` for SSO providers. Falls
back to email/password form login when SSO fails.

### ChromeAdapter (`extension/src/adapters/ChromeAdapter.ts`)

Uses `chrome.tabs`, `chrome.scripting`, `chrome.debugger`. Bound to a
single `tabId`. Already tracks tab creation via `preExistingTabIds` for
`closeOtherTabs()`.

## Design

### Detection strategy: race redirect vs popup

After clicking the SSO button, race two signals:

- **Redirect:** the current tab URL changes to a known provider domain.
- **Popup:** a new tab/window is created (via `chrome.tabs.onCreated`).

Whichever fires first determines the flow. Timeout after 10 s → login
fails.

### New BrowserAdapter methods

Add optional popup-handling methods to `BrowserAdapter`:

```typescript
/** Wait for a new tab to open. Returns the tab ID, or null on timeout. */
waitForNewTab?(timeoutMs?: number): Promise<number | null>;

/** Switch the adapter to operate on a different tab. */
switchToTab?(tabId: number): Promise<void>;

/** Return the current tab ID. */
getCurrentTabId?(): number;
```

Methods are optional (trailing `?`) so PuppeteerAdapter is unaffected
until it needs popup support.

### ChromeAdapter implementation

#### `waitForNewTab(timeoutMs = 10000)`

```
1. Record current set of tab IDs.
2. Add chrome.tabs.onCreated listener.
3. When a new tab is created whose ID is not in the pre-existing set,
   resolve with the new tab ID.
4. Remove listener on resolve or timeout.
5. Return null on timeout.
```

#### `switchToTab(tabId)`

```
1. Detach debugger from current tab (if attached).
2. Update this.tabId to the new tab ID.
3. Reset debuggerAttached, debuggerEventsBound flags.
4. Remove old debugger event listener.
5. Attach debugger to new tab via ensureDebugger().
6. Update this.currentUrl from new tab.
```

#### `getCurrentTabId()`

Return `this.tabId`.

#### Restoring original tab

After the popup closes (detected via `chrome.tabs.onRemoved`) or after
SSO steps complete, call `switchToTab(originalTabId)` to return.

### SSO handler changes (`sso-handler.ts`)

Update `executeSSOFlow()`:

```
1. Record current URL and tab ID.
2. Click SSO button.
3. Race:
   a. adapter.waitForNewTab(10000)   → popup detected
   b. waitForUrlChange(10000)        → redirect detected
4. If popup detected:
   a. adapter.switchToTab(popupTabId)
   b. Wait for popup page to load.
   c. Execute provider-specific steps (same as today).
   d. Wait for popup to close OR for original tab URL to change
      (indicating auth callback received).
   e. adapter.switchToTab(originalTabId)
5. If redirect detected:
   a. Execute provider-specific steps (same as today — no change).
6. Wait for app origin URL on original tab.
```

### Tab lifecycle during popup flow

```
Original tab (app)          Popup tab (provider)
─────────────────           ────────────────────
Click "Sign in              
  with Google"              
        ──────────────────► Tab created
                            accounts.google.com loads
        adapter.switchToTab(popup)
                            Type email, click Next
                            Type password, click Submit
                            Google redirects back / closes popup
        ◄────────────────── Tab removed (or redirect)
adapter.switchToTab(original)
App is now logged in
```

## Changes by file

### `runner_service/src/adapter.ts`

- Add three optional methods: `waitForNewTab`, `switchToTab`,
  `getCurrentTabId`.

### `extension/src/adapters/ChromeAdapter.ts`

- Make `tabId` mutable (currently `readonly`).
- Implement `waitForNewTab()` using `chrome.tabs.onCreated`.
- Implement `switchToTab()`: detach debugger from old tab, attach to
  new tab, rebind events.
- Implement `getCurrentTabId()`.
- Add `chrome.tabs.onRemoved` listener to detect popup close.

### `runner_service/src/orchestrator/sso-handler.ts`

- After clicking SSO button, race popup detection vs redirect detection.
- If popup: switch adapter, run steps, switch back.
- If redirect: existing flow unchanged.
- Add helper `waitForUrlChange(adapter, timeoutMs)`.

### `runner_service/src/orchestrator/login-manager.ts`

- No structural changes. `executeSSOFlow` is already called correctly.
- May need to suppress scope-boundary checks while operating on the
  popup tab (already suppresses during `isInLoginFlow`).

### `runner/src/adapters/PuppeteerAdapter.ts`

- Store a `browser` reference (the `Browser` instance that owns the
  page). The adapter currently only holds a `Page` — it needs the
  parent browser to listen for new targets.
- Make the internal `page` field mutable so `switchToTab()` can swap it.
- Implement the three popup methods:

#### `waitForNewTab(timeoutMs = 10000)`

```
1. Call browser.on('targetcreated', handler).
2. In handler, filter for target.type() === 'page'.
3. Resolve with the new target's page.
4. Remove listener on resolve or timeout.
5. Return null on timeout.
```

Puppeteer fires `targetcreated` for every new tab, popup, or window.
The handler should ignore non-page targets (service workers, iframes).

#### `switchToTab(tabId)`

`tabId` is abstract in the interface. For Puppeteer, use the target's
page index or store a `Map<number, Page>` mapping synthetic IDs to
Puppeteer `Page` objects.

```
1. Store current page reference as previousPage.
2. Set this.page = newPage (from the target).
3. Call newPage.bringToFront().
4. Rebind console/network event listeners on the new page.
5. Reset runtime artifact buffers.
```

#### `getCurrentTabId()`

Return a synthetic numeric ID derived from the target. One approach:
assign incrementing IDs as pages are discovered and store in the map.

#### Constructor change

Accept `Browser` in addition to `Page`:

```typescript
constructor(page: Page, browser?: Browser)
```

The runner's `orchestrator.ts` already has the browser reference from
`ChromiumManager` — pass it through when creating the adapter.

### `runner/src/orchestrator.ts`

- Pass `browser` to `PuppeteerAdapter` constructor so it can listen
  for new targets.

### `runner/src/browser/chromium.ts`

- No changes needed. `ChromiumManager` already exposes the browser
  instance.

## Edge cases

| Case | Handling |
|------|----------|
| App uses redirect, not popup | Redirect wins the race. No behavior change. |
| Popup blocked by browser | `waitForNewTab` times out → fall back to email/password form login (existing fallback). |
| Popup opens but is on `chrome-extension://` URL | `ensureAccessiblePage()` already rejects these. Skip and timeout. |
| Multiple popups (e.g., consent screen after login) | Handle sequentially — after first popup closes, check if another opened. |
| Popup doesn't close after auth | After SSO steps complete, wait up to 10 s for original tab URL to change. If it does, force-close the popup and switch back. |
| User manually closes popup | `chrome.tabs.onRemoved` fires → switch back to original tab, report login failed. |
| Provider opens in iframe, not popup | Not a popup flow — the SSO handler's existing in-page steps would apply. No change needed. |
| Puppeteer headless popup blocked | Some headless configs block popups. `waitForNewTab` times out → fallback to email/password. |
| Puppeteer popup opens as new tab in same window | `targetcreated` still fires. Same handling. |

## Testing

### Extension (ChromeAdapter)

1. Find a test app that uses Google popup OAuth (e.g., a Firebase app
   with `signInWithPopup`).
2. Verify redirect-based OAuth still works (regression).
3. Verify popup-based OAuth works with Google credentials.
4. Verify fallback to email/password when popup is blocked.
5. Verify `closeOtherTabs()` does not close the popup prematurely
   during the login flow.

### Server runner (PuppeteerAdapter)

6. Verify Puppeteer `targetcreated` fires for popup-based OAuth.
7. Verify page switching works (debugger rebind, event listeners).
8. Verify headless mode handles popups (may need `--disable-popup-blocking`
   Chromium flag in `ChromiumManager`).
9. Verify redirect-based OAuth still works (regression).

## Sequence

1. Add optional methods to `BrowserAdapter` interface in runner_service.
2. Implement in `ChromeAdapter` (extension).
3. Implement in `PuppeteerAdapter` (runner). Pass `browser` from
   orchestrator.
4. Update `sso-handler.ts` with popup detection race.
5. Test extension with popup-based OAuth app.
6. Test server runner with popup-based OAuth app.
