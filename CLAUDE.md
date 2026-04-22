# Testomniac Extension

AI-powered automated UI testing Chrome extension (Manifest V3). Thin wrapper that creates a `ChromeAdapter` and calls `runScan()` from `@sudobility/testomniac_scanning_service`.

**Package**: `testomniac_extension` v0.1.12 (private, not published)

## Tech Stack

- **Language**: TypeScript (strict mode, JSX)
- **Runtime**: Bun
- **Package Manager**: Bun (do not use npm/yarn/pnpm for installing dependencies)
- **Build**: Vite 5 + @crxjs/vite-plugin (HMR on port 7175)
- **UI**: React 18, Tailwind CSS 3
- **State**: Zustand 5
- **Browser API**: webextension-polyfill, Chrome DevTools Protocol
- **Auth**: Firebase 12 (Google Sign-in via `chrome.identity`)

## Project Structure

```
src/
├── manifest.json                     # Chrome Manifest V3
├── background/
│   └── index.ts                      # Service worker (~260 lines) — thin scan wrapper
├── adapters/
│   └── ChromeAdapter.ts              # BrowserAdapter impl using Chrome CDP (~500 lines)
├── sidepanel/                        # Side panel UI (React)
│   ├── index.html                    # Entry HTML
│   ├── main.tsx                      # React mount point
│   ├── SidePanel.tsx                 # Main UI (~540 lines): tabs, controls, progress
│   ├── index.css                     # Tailwind imports
│   ├── config/
│   │   └── initialize.ts             # Firebase initialization via @sudobility/di_web
│   ├── auth/
│   │   └── googleSignIn.ts           # Chrome identity-based Google OAuth flow
│   ├── components/
│   │   └── AuthProviderWrapper.tsx    # Firebase AuthProvider wrapper
│   └── hooks/
│       └── useAuthTokenSync.ts       # Syncs Firebase token to chrome.storage + background
└── shims/                            # Browser compatibility shims for Vite
    ├── crypto.ts                     # node:crypto → SubtleCrypto (needed by scanning_service's component-detector)
    ├── devops-components.ts          # Stub for @sudobility/devops-components
    └── subscription-lib.ts           # Stub for @sudobility/subscription_lib
```

### Deleted (moved to scanning_service)

The following directories were removed during refactoring. All this logic now lives in `@sudobility/testomniac_scanning_service`:

- `background/extractors/` (11 files: index, types, helpers, domSnapshot, selectors, textInputs, selects, toggles, productActions, buttons, clickables)
- `background/planners/` (fillValuePlanner.ts)

## Commands

```bash
bun run dev          # Vite dev server (hot reload extension, port 7175)
bun run build        # TypeScript check + Vite build
bun run type-check   # TypeScript only (tsc --noEmit)
bun run lint         # ESLint
bun run lint:fix     # ESLint auto-fix
bun run format       # Prettier write
bun run format:check # Prettier check
```

## Architecture: Scan Flow

The background service worker is a thin wrapper around `runScan()` from scanning_service:

1. User clicks "Test [hostname]" in side panel -> `POST /api/v1/scan` creates a run -> sends `START_SCAN` to background
2. Background loads config from `chrome.storage.local`, creates `ApiClient` via scanning_service
3. Gets or creates a Chrome tab, creates `ChromeAdapter`
4. Builds a `ScanEventHandler` that bridges events to the side panel via `chrome.runtime.sendMessage`
5. Calls `runScan(adapter, config, api, eventHandler)` with `phases: ['mouse_scanning']`
6. All scanning logic (element extraction, bug detection, modal handling, action classification, page navigation) executes inside scanning_service

The extension only runs the `mouse_scanning` phase. AI analysis, input scanning, test generation, and test execution run on the server-side scanner.

### What the extension handles locally

- `chrome.storage` config management (API URL, API key)
- Message handlers (`START_SCAN`, `STOP_SCAN`, `GET_STATUS`, `SET_AUTH_TOKEN`, `SAVE_CONFIG`)
- Side panel communication (`SCAN_PROGRESS` events)
- Tab management (get/create active tab)
- Scan state tracking (for side panel display)

### What comes from scanning_service

- `runScan()` orchestrator
- `ApiClient` / `getApiClient`
- `ScanEventHandler` interface
- All extractors (DOM snapshot, text inputs, selects, toggles, buttons, clickables, product actions)
- All detectors (bug detection, modal handling, link/visual/content/functional checkers)
- Action classification and priority
- Fill value planning
- Navigator, loop guard, state manager, action queue
- Page hashing (`computeHashes`)
- Constants (timeouts, limits, patterns)

## ChromeAdapter

Implements `BrowserAdapter` interface from `@sudobility/testomniac_scanning_service`. All interactions use **real CDP mouse events** via `chrome.debugger`, not DOM APIs:

- `click()` — scrolls into view, resolves clickable point (checks occlusion), dispatches CDP `Input.dispatchMouseEvent`
- `hover()` — CDP mouseMoved only (no click)
- `type()` — sets value + dispatches input/change/blur events
- `select()` — selects by value, text, or index (`__index__:N`)
- `screenshot()` — CDP `Page.captureScreenshot` (JPEG/PNG)
- `waitForSelector()` — polls for visibility (exists, not hidden, in viewport, opacity >= 0.05)

Shows a yellow interaction marker overlay on clicked elements for visual debugging.

## Side Panel UI

React 18 + Tailwind CSS interface with 5 tabs:

1. **Overview** — current page URL + live screenshot
2. **Pages** — discovered pages list
3. **Issues** — detected bugs (broken links, visual, content, error pages)
4. **Actions** — logged interactions (clicks, fills, selects, toggles)
5. **All Events** — raw event log (last 50)

### Authentication
- Google Sign-in via `chrome.identity.launchWebAuthFlow()` (Chrome's OAuth flow)
- Firebase token synced to `chrome.storage.session` and background worker
- Token auto-refreshes via `onIdTokenChanged` listener

### Progress Display
- Phase indicators: Scanning -> AI Analysis -> Input Testing -> Generating -> Executing
- Real-time screenshot updates
- Counter pills (Pages/States/Actions/Issues)

## API Integration

Uses `ApiClient` from `@sudobility/testomniac_scanning_service` for all scanner endpoints.

**Base URL**: loaded from `chrome.storage.local` (default: `http://localhost:8027`)

**Auth**: Optional Bearer token (Firebase) in Authorization header, or API key in `X-Scanner-Key`.

## Message Protocol

Background <-> Side Panel communication via `chrome.runtime.sendMessage`:

**Side Panel -> Background**:
- `START_SCAN` — begin scan with URL and runId
- `STOP_SCAN` — stop immediately
- `GET_STATUS` — return current scan state
- `SET_AUTH_TOKEN` — update Firebase token
- `SAVE_CONFIG` — store API URL/key

**Background -> Side Panel**:
- `SCAN_PROGRESS` — state update (phase, counters, screenshot, events)

## Chrome Permissions

`identity`, `storage`, `activeTab`, `scripting`, `tabs`, `debugger`, `sidePanel`

Host permissions: `<all_urls>`

## Path Aliases

```
@/           -> src/
@background/ -> src/background/
```

## Vite Shims

The build resolves these aliases to browser-compatible stubs:
- `node:crypto` -> `src/shims/crypto.ts` (uses `crypto.subtle` for SHA-256) — needed because scanning_service's `component-detector.ts` imports `node:crypto`
- `@sudobility/devops-components` -> empty stub
- `@sudobility/subscription_lib` -> empty stub

## Related Projects (Testomniac Ecosystem)

- **testomniac_scanning_service** (`@sudobility/testomniac_scanning_service`) — Shared library containing ALL scanning logic. This extension calls `runScan()` from it and imports `ApiClient` and `ScanEventHandler`.
- **testomniac_api** (`localhost:8027`) — REST API backend; this extension calls it via the shared ApiClient
- **testomniac_scanner** — Server-side Puppeteer worker; calls the same `runScan()` with all 5 phases. Uses `PuppeteerAdapter` instead of `ChromeAdapter`.
- **testomniac_types** (`@sudobility/testomniac_types`) — Shared TypeScript type definitions
- **testomniac_app** — Web frontend that displays scan results

## Coding Patterns

- **Thin wrapper around `runScan()`**: `background/index.ts` (~260 lines) only handles Chrome-specific concerns (storage, messages, tabs) and delegates all scanning to scanning_service.
- **`ScanEventHandler` bridges to side panel**: The event handler implementation translates scanning events into `SCAN_PROGRESS` messages sent to the side panel UI.
- **CDP for real interactions**: All mouse events use Chrome DevTools Protocol via `chrome.debugger`. This produces realistic user behavior that catches hover-triggered menus, tooltips, etc.
- **Only `mouse_scanning` phase**: The extension runs only the first scanning phase. AI analysis, test generation, and execution happen server-side.
- **API communication via shared ApiClient**: Uses `ApiClient` from scanning_service. Config (API URL, API key) stored in `chrome.storage.local`.
- **No local business logic**: Extractors, detectors, planners, action classification, and orchestration all come from scanning_service imports.

## Gotchas

- **API URL defaults to localhost:8027**: Configurable from the side panel settings. Must match the running `testomniac_api` instance.
- **Side panel, not popup**: The UI is a Chrome side panel (`side_panel` in manifest), NOT a popup.
- **Chrome debugger warning bar**: The `debugger` permission triggers "Extension is debugging this browser". Users must not dismiss it during testing.
- **Zustand v5**: This extension uses Zustand 5. Do not copy store patterns from packages using Zustand 4.x without accounting for API differences.
- **crypto.ts shim is still required**: Even though extractors and planners were moved to scanning_service, the `node:crypto` shim is needed because scanning_service's `component-detector.ts` imports `node:crypto` at the module level. Vite resolves it to the browser shim.
- **Firebase auth is optional**: The extension works without authentication for local development. Firebase config comes from environment variables at build time.
- **Max 100 events in background state**: The event log is capped at 100 entries. The side panel displays the last 50.
- **No extractors/ or planners/ directories**: These were deleted. If you see imports referencing `./extractors/` or `./planners/`, they should be updated to import from `@sudobility/testomniac_scanning_service`.

## Testing Notes

- No test suite currently exists
- If adding tests, use Vitest to stay consistent with other testomniac packages
- The background service worker is now thin enough to test by mocking `runScan()`, `chrome.storage`, and `chrome.runtime`
- `ChromeAdapter` is the main complex local code — test by mocking `chrome.debugger` CDP calls
