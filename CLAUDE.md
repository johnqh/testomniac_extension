# Testomniac Extension

AI-powered automated UI testing Chrome extension (Manifest V3).

**Package**: `testomniac_extension` v0.1.9 (private, not published)

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
│   ├── index.ts                      # Service worker (~1,500 lines) — main scan orchestrator
│   ├── extractors/                   # Modular element extraction system
│   │   ├── index.ts                  # Registers extractors in priority order
│   │   ├── types.ts                  # ExtractorCandidate, DomSnapshotEntry types
│   │   ├── helpers.ts                # createCandidate, withResolvedSelector, uniqueBySelector
│   │   ├── domSnapshot.ts            # Two-pass DOM snapshot (base selectors + cursor:pointer scan)
│   │   ├── selectors.ts              # classifyActionKind: navigate|select|fill|toggle|click
│   │   ├── textInputs.ts             # <input>, <textarea>, role="textbox", contenteditable
│   │   ├── selects.ts                # <select>, role="combobox"
│   │   ├── toggles.ts                # checkbox, radio, role="switch"
│   │   ├── productActions.ts         # E-commerce actions (cart, checkout, select options)
│   │   ├── buttons.ts                # <button>, input[type="submit"]
│   │   └── clickables.ts             # Remaining clickable elements (links, divs, etc.)
│   └── planners/
│       └── fillValuePlanner.ts       # Smart form value planning (keyword heuristics, multi-language)
├── adapters/
│   └── ChromeAdapter.ts              # BrowserAdapter impl using Chrome CDP (~500 lines)
├── sidepanel/                        # Side panel UI (replaces old popup)
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
    ├── crypto.ts                     # node:crypto → SubtleCrypto
    ├── devops-components.ts          # Stub for @sudobility/devops-components
    └── subscription-lib.ts           # Stub for @sudobility/subscription_lib
```

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

The background service worker orchestrates a multi-page scanning loop:

1. User clicks "Test [hostname]" in side panel → `POST /api/v1/scan` creates a run → sends `START_SCAN` to background
2. Background loads config from `chrome.storage`, initializes `ChromeAdapter`, navigates to URL
3. Calls API `updateRunPhase(runId, 'mouse_scanning')` to claim the run
4. **Page queue loop**: for each queued page:
   a. Navigate to page, extract interactive elements via DOM snapshot + 6 extractors
   b. Compute 4 hashes (html, normalized, text, actionable) for page state dedup
   c. Take screenshot, create page state in API
   d. Run bug detection (broken links, visual issues, content issues, media issues)
   e. Process each element: hover → interact (click/fill/select/toggle) → screenshot → validate
   f. Enqueue newly discovered pages (from hrefs and URL changes after clicks)
5. Calls API `completeRun(runId)` when all pages processed

### Element Processing Priority

Lower number = processed first:
- **0**: fill/select (form fields)
- **1**: toggle (checkboxes/radios)
- **2**: product actions & submit buttons
- **3**: clicks (mid-page elements)
- **4**: navigation links (non-top)
- **6**: navigation links (top of page, lowest priority)

## Extractors

The extraction system uses a two-pass approach in `domSnapshot.ts`:

**Pass 1**: Query comprehensive CSS selectors for interactive elements (inputs, buttons, links, ARIA roles, event handlers, tabindex, contenteditable)

**Pass 2**: Find `cursor:pointer` elements missed by Pass 1 (framework-specific clickable divs, etc.)

Each element gets a `data-tmnc-id` attribute for stable selection. Elements are classified into action kinds by `selectors.ts`:
- `navigate` — `<a href>`
- `select` — `<select>` or `role="combobox"`
- `fill` — text `<input>`, `<textarea>`, `role="textbox"`
- `toggle` — checkbox/radio
- `click` — everything else

## ChromeAdapter

Implements `BrowserAdapter` interface from `@sudobility/testomniac_scanning_service`. All interactions use **real CDP mouse events** via `chrome.debugger`, not DOM APIs:

- `click()` — scrolls into view, resolves clickable point (checks occlusion), dispatches CDP `Input.dispatchMouseEvent`
- `hover()` — CDP mouseMoved only (no click)
- `type()` — sets value + dispatches input/change/blur events
- `select()` — selects by value, text, or index (`__index__:N`)
- `screenshot()` — CDP `Page.captureScreenshot` (JPEG/PNG)
- `waitForSelector()` — polls for visibility (exists, not hidden, in viewport, opacity >= 0.05)

Shows a yellow interaction marker overlay on clicked elements for visual debugging.

## Fill Value Planner

`fillValuePlanner.ts` uses multi-signal heuristics to determine appropriate test data for form fields:

1. **HTML input type** (highest priority): email, password, tel, date, search, etc.
2. **HTML5 autocomplete attribute**: given-name, street-address, cc-number, etc.
3. **Keyword matching** on combined signals (name, id, placeholder, label): supports English, Spanish, French, German
4. **Default by tag**: `<textarea>` → comment, other → generic

All test values are realistic but fake (no real credentials).

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
- Phase indicators: Scanning → AI Analysis → Input Testing → Generating → Executing
- Real-time screenshot updates
- Counter pills (Pages/States/Actions/Issues)

## Bug Detection

The background worker runs these detectors inline:

- **Broken links**: HEAD requests to same-origin links, flags 404/410/5xx
- **Visual issues**: duplicate headings, empty links, images with invalid src, duplicate element IDs
- **Content issues**: placeholder text (lorem ipsum, TODO), error page patterns (404, 500, "Something went wrong"), blank pages (<50 chars)
- **Media issues**: missing source, broken media elements
- **Navigation issues**: links that don't navigate, submit buttons that don't change state

## API Integration

Uses `ApiClient` from `@sudobility/testomniac_scanning_service` for scanner endpoints, plus direct `fetch` for scan creation.

**Base URL**: loaded from `chrome.storage.local` (default: `http://localhost:8027`)

**Key endpoints called**:
- `POST /api/v1/scan` — create run (from side panel, direct fetch)
- `PATCH /api/v1/scanner/runs/:id/phase` — claim/update run phase
- `GET /api/v1/scanner/runs/pending` — get app metadata
- `POST /api/v1/scanner/pages` — find or create page
- `POST /api/v1/scanner/page-states` — capture page state with hashes
- `POST /api/v1/scanner/actionable-items` — store discovered elements
- `POST /api/v1/scanner/actions` — log interactions
- `PATCH /api/v1/scanner/runs/:id/stats` — update progress counters
- `PATCH /api/v1/scanner/runs/:id/complete` — mark run finished

**Auth**: Optional Bearer token (Firebase) in Authorization header, or API key in `X-Scanner-Key`.

## Chrome Permissions

`identity`, `storage`, `activeTab`, `scripting`, `tabs`, `debugger`, `sidePanel`

Host permissions: `<all_urls>`

## Path Aliases

```
@/           → src/
@background/ → src/background/
```

## Vite Shims

The build resolves these aliases to browser-compatible stubs:
- `node:crypto` → `src/shims/crypto.ts` (uses `crypto.subtle` for SHA-256)
- `@sudobility/devops-components` → empty stub
- `@sudobility/subscription_lib` → empty stub

## Message Protocol

Background ↔ Side Panel communication via `chrome.runtime.sendMessage`:

**Side Panel → Background**:
- `START_SCAN` — begin scan with URL and runId
- `STOP_SCAN` — stop immediately
- `GET_STATUS` — return current scan state
- `SET_AUTH_TOKEN` — update Firebase token
- `SAVE_CONFIG` — store API URL/key

**Background → Side Panel**:
- `SCAN_PROGRESS` — state update (phase, counters, screenshot, events)

## Related Projects (Testomniac Ecosystem)

- **testomniac_api** (`localhost:8027`) — REST API backend; this extension calls it via HTTP
- **testomniac_scanning_service** (`@sudobility/testomniac_scanning_service`) — Shared library providing `BrowserAdapter` interface, `ApiClient`, detectors, scanner utilities
- **testomniac_scanner** — Server-side Puppeteer worker; does the same scanning as this extension but with AI analysis, test generation, and execution
- **testomniac_types** (`@sudobility/testomniac_types`) — Shared TypeScript type definitions
- **testomniac_app** — Web frontend that displays scan results

## Coding Patterns

- **Background service worker orchestrates the scan**: All scanning logic lives in `background/index.ts`. It navigates tabs, runs extractors, calls API endpoints, and manages the page queue.
- **Modular extractor system**: 6 extractors registered in priority order (textInputs → selects → toggles → productActions → buttons → clickables). Each returns candidates that are deduplicated and classified.
- **CDP for real interactions**: All mouse events use Chrome DevTools Protocol via `chrome.debugger`. This produces realistic user behavior that catches hover-triggered menus, tooltips, etc.
- **4-hash page state dedup**: html, normalizedHtml, text, and actionable hashes prevent redundant processing when a page hasn't meaningfully changed.
- **Element tagging with data-tmnc-id**: Before extraction, elements get `data-tmnc-id` attributes. Before interaction, elements are "retagged" to handle DOM mutations.
- **Modal detection and dismissal**: Detects Bootstrap, Popup Maker, ARIA dialog, Fancybox modals. Dismisses via close button, overlay click, or Escape key.
- **Same-origin enforcement**: Cross-origin URLs are skipped; non-browsable URLs (mailto:, javascript:, .pdf) are filtered.
- **API communication via ApiClient**: Uses the shared `ApiClient` from `@sudobility/testomniac_scanning_service`. Config (API URL, API key) stored in `chrome.storage.local`.

## Gotchas

- **API URL defaults to localhost:8027**: Configurable from the side panel settings. Must match the running `testomniac_api` instance.
- **Side panel, not popup**: The UI is a Chrome side panel (`side_panel` in manifest), NOT a popup. The old popup code has been replaced.
- **Elements tracked by content key, not position**: Uses `"type:text|href"` content keys and style fingerprints. Do not identify elements by index or DOM position.
- **Chrome debugger warning bar**: The `debugger` permission triggers "Extension is debugging this browser". Users must not dismiss it during testing.
- **Zustand v5**: This extension uses Zustand 5. Do not copy store patterns from packages using Zustand 4.x without accounting for API differences.
- **Shims required for browser compatibility**: `node:crypto`, `@sudobility/devops-components`, and `@sudobility/subscription_lib` are shimmed in `vite.config.ts`. If new Node.js-only dependencies are added, they may need shims too.
- **Firebase auth is optional**: The extension works without authentication for local development. Firebase config comes from environment variables at build time.
- **Max 50 events in side panel**: The event log is capped at 50 entries. Older entries are dropped.

## Testing Notes

- No test suite currently exists
- If adding tests, use Vitest to stay consistent with other testomniac packages
- Consider extracting pure logic (hash computation, URL filtering, bug detection) into testable modules
- Mock `chrome.debugger`, `chrome.tabs`, `chrome.scripting`, and `chrome.storage` APIs
