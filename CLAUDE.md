# Testomniac Extension

Chrome side-panel extension for launching and monitoring Testomniac discovery
runs against the active tab.

## Purpose

This package is the browser-hosted runner client. It:

- authenticates the user with Firebase
- resolves the product and test environment for the current URL
- creates a discovery `test_run` through `testomniac_api`
- executes that run locally in Chrome through `ChromeAdapter`
- shows navigation, coverage, findings, and event progress in the side panel

The extension is intentionally thin. Coverage generation and test execution
logic live in `@sudobility/testomniac_runner_service`.

## Tech Stack

- **Language**: TypeScript (strict mode, JSX)
- **Runtime**: Bun
- **Package Manager**: Bun (do not use npm/yarn/pnpm for installing dependencies)
- **Framework**: React 18
- **Build**: Vite 5 + @crxjs/vite-plugin (Chrome extension bundling)
- **Styling**: Tailwind CSS 3
- **Auth**: Firebase Auth
- **State**: React hooks + chrome.storage.local persistence

## Runtime Flow

1. [`src/sidepanel/SidePanel.tsx`](src/sidepanel/SidePanel.tsx) collects the
   current URL, workspace, product, and environment.
2. The side panel calls `POST /api/v1/test-environments/resolve` and then
   `POST /api/v1/scan`.
3. The API creates the discovery bundle, root surface run, root element run, and
   root `test_run`.
4. The side panel sends `START_SCAN` to
   [`src/background/index.ts`](src/background/index.ts).
5. The background worker creates `ChromeAdapter`, `ApiClient`, and default
   expertises, then calls `runTestRun()`.
6. Progress is bridged back into the side panel through `SCAN_PROGRESS`
   messages and run-read endpoints.

`POST /api/v1/scan` is kept on purpose as the simple URL bootstrap endpoint.
It does not represent a separate execution path. Its only job is to create the
initial discovery run records so the standard `runTestRun()` loop can take
over.

## Project Structure

```
src/
├── manifest.json                      # Chrome MV3 manifest
├── background/
│   └── index.ts                       # Service worker (~1300 lines)
│                                       # - runTestRun() orchestration
│                                       # - Deduplication (DedupApiClient)
│                                       # - State persistence & auto-resume
│                                       # - Message routing (START/PAUSE/RESUME/STOP_SCAN)
│                                       # - Scenario execution
│                                       # - Keepalive timer
├── adapters/
│   └── ChromeAdapter.ts               # BrowserAdapter via chrome.tabs/scripting/debugger
├── storage/
│   ├── chromeStorageAdapter.ts         # StorageAdapter for chrome.storage.local
│   └── ChromeStorageDedupStore.ts      # DedupStore (batched writes every 2s or 50 items)
├── shared/
│   └── environment.ts                 # Environment resolution (local vs shared)
├── sidepanel/
│   ├── main.tsx                       # React entry (QueryClient, AuthProviderWrapper)
│   ├── SidePanel.tsx                  # Main UI (~1000 lines)
│   │                                   # - Auth flow, environment/product selection
│   │                                   # - Scan initiation & progress monitoring
│   │                                   # - Results tabs, settings, scenarios
│   ├── index.html                     # Side panel entry point
│   ├── index.css                      # Global styles
│   ├── auth/
│   │   └── googleSignIn.ts            # Chrome-specific Google auth flow
│   ├── components/
│   │   └── AuthProviderWrapper.tsx     # Firebase AuthProvider wrapper
│   ├── config/
│   │   └── initialize.ts              # App bootstrap (Firebase init)
│   └── hooks/
│       └── useAuthTokenSync.ts        # Firebase token sync to storage & background
└── shims/
    ├── crypto.ts                      # node:crypto → browser createHash shim
    ├── devops-components.ts           # Stub
    └── subscription-lib.ts            # Stub
```

## Local Responsibilities

- Chrome-specific browser automation via
  [`src/adapters/ChromeAdapter.ts`](src/adapters/ChromeAdapter.ts)
- persisted extension config in `chrome.storage`
- Firebase token sync between UI and service worker
- background-to-side-panel message bridge
- finding deduplication via `ChromeStorageDedupStore`
- service worker auto-recovery (detects mid-scan state and resumes)
- result presentation for:
  - navigation map
  - surface bundle / surface / element / element-run coverage
  - findings
  - raw event stream

## Shared Runner Responsibilities

These come from `@sudobility/testomniac_runner_service`:

- `runTestRun()`
- `PageAnalyzer`
- expertise evaluation
- actionable-item extraction
- scaffold and pattern detection
- target-page-state creation
- discovery-time test-case generation

## Important Architecture Notes

- The extension uses `runTestRun()`, not the removed legacy `runScan()` path.
- Discovery-time follow-up coverage is created by `PageAnalyzer`.
- Hover is the primary interaction primitive for actionable items. Additional
  click or nested-hover cases are generated after the hover result is analyzed.
- The side panel is a side panel, not a popup.
- Service worker has keepalive timer to prevent Chrome from terminating it mid-scan.

## Commands

```bash
bun run dev            # Vite dev server with HMR (port 7175)
bun run build          # Compile TS + bundle for dist/
bun run type-check     # tsc --noEmit
bun run lint           # ESLint on src/**/*.{ts,tsx}
bun run lint:fix       # Auto-fix lint issues
bun run format         # Prettier format
bun run format:check   # Check formatting
```

## Files To Know

- [`src/background/index.ts`](src/background/index.ts): service worker entry
  (orchestration, message handling, state persistence)
- [`src/adapters/ChromeAdapter.ts`](src/adapters/ChromeAdapter.ts): browser
  adapter (chrome.tabs, chrome.scripting, chrome.debugger)
- [`src/sidepanel/SidePanel.tsx`](src/sidepanel/SidePanel.tsx): UI and API
  bootstrap flow
- [`src/shared/environment.ts`](src/shared/environment.ts): environment
  resolution helpers
- [`src/storage/ChromeStorageDedupStore.ts`](src/storage/ChromeStorageDedupStore.ts):
  batched deduplication persistence

## Related Projects

- **testomniac_runner_service** (`@sudobility/testomniac_runner_service`) — Shared execution library; provides `runTestRun()` and all scanning logic
- **testomniac_api** — Backend API; extension calls scan and environment endpoints
- **testomniac_types** (`@sudobility/testomniac_types`) — Shared type definitions
- **testomniac_client** (`@sudobility/testomniac_client`) — API client SDK used for data fetching
- **testomniac_lib** (`@sudobility/testomniac_lib`) — Business logic hooks
- **testomniac_runner** — Server-side runner (uses PuppeteerAdapter instead of ChromeAdapter)

## Deployment

- `testomniac_app/scripts/push_all.sh` — formats, validates (typecheck/lint/test/build), version-bumps, commits, and pushes all repos in dependency order
- All repos must be on `main` branch with no uncommitted changes for push_all.sh to work
- push_all.sh auto-updates `@sudobility/*` dependency versions across repos
- Database is remote (50.118.250.186) — connection pool set to 50, queries have ~33ms network latency
- Database indexes are managed manually via SQL, not through Drizzle migrations

## Performance Patterns

- Batch endpoints accept arrays: `/test-interactions/batch`, `/test-run-findings/ensure-batch`, `/scaffolds/batch`, `/test-interaction-runs/complete-batch`, `/test-surface-runs/complete-batch`
- `GET /scanner/runner-state?bundleRunId=X` — consolidated endpoint combining open surface runs + pending interaction runs with blocked status (raw SQL)
- `GET /scanner/test-interactions?slim=true` — excludes heavy stepsJson/globalExpectationsJson fields
- `GET /scanner/page-states?pageIds=1,2,3` — batch page states by comma-separated IDs
- `POST /test-surfaces/ensure-with-run` — combines surface creation + bundle link + surface run in one call
- `POST /test-interactions/reconcile` — server-side reconciliation replacing client-side fetch + retire
- `GET /runs/:id/live-dashboard` — consolidated polling endpoint replacing 4 separate calls
- ApiClient caches `getTestSurfacesByRunner` and `getTestInteractionsByRunner` with 5s TTL, auto-invalidated on mutation
- Side panel uses sequential polling (wait for response + 3s delay) instead of setInterval to prevent request pile-up

## Gotchas

- `@sudobility/testomniac_runner_service` is aliased to sibling directory source in vite.config.ts (not from node_modules)
- Vite caches pre-bundled deps in `node_modules/.vite` — after changing runner_service source, run `rm -rf node_modules/.vite` and restart dev server
- Chrome service workers can also cache stale JS — toggle extension off/on in chrome://extensions if code changes aren't reflected
- postgres.js returns BIGSERIAL/int8 columns as strings (not numbers). When using raw SQL instead of Drizzle, always `Number()` ID fields in the response mapping
- CHAR(N) columns are space-padded in PostgreSQL — use `.trim()` when comparing cached DB values against unpadded input
- `testRunFindingRuns` has a FK to `testRunFindings.id` — always delete junction records before deleting findings
- `node:crypto` is shimmed to a browser-compatible hash function
- Vite HMR runs on port 7175
- Chrome service workers can be terminated at any time — state must be persisted to chrome.storage
- `DedupApiClient` batches writes every 2 seconds or 50 items to reduce storage churn
