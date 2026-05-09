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

## Runtime Flow

1. [`src/sidepanel/SidePanel.tsx`](src/sidepanel/SidePanel.tsx) collects the
   current URL, workspace, product, and environment.
2. The side panel calls `POST /api/v1/test-environments/resolve` and then
   `POST /api/v1/scan`.
3. The API creates the discovery bundle, root suite run, root case run, and
   root `test_run`.
4. The side panel sends `START_SCAN` to
   [`src/background/index.ts`](src/background/index.ts).
5. The background worker creates `ChromeAdapter`, `ApiClient`, and default
   expertises, then calls `runTestRun()`.
6. Progress is bridged back into the side panel through `SCAN_PROGRESS`
   messages and run-read endpoints.

## Local Responsibilities

- Chrome-specific browser automation via
  [`src/adapters/ChromeAdapter.ts`](src/adapters/ChromeAdapter.ts)
- persisted extension config in `chrome.storage`
- Firebase token sync between UI and service worker
- background-to-side-panel message bridge
- result presentation for:
  - navigation map
  - suite bundle / suite / case / case-run coverage
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

## Commands

```bash
bun run dev
bun run build
bun run type-check
bun run lint
bun run format
```

## Files To Know

- [`src/background/index.ts`](src/background/index.ts): service worker entry
- [`src/adapters/ChromeAdapter.ts`](src/adapters/ChromeAdapter.ts): browser
  adapter implementation
- [`src/sidepanel/SidePanel.tsx`](src/sidepanel/SidePanel.tsx): UI and API
  bootstrap flow
- [`src/shared/environment.ts`](src/shared/environment.ts): environment
  resolution helpers
