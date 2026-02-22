# Testomniac Extension

AI-powered automated UI testing Chrome extension (Manifest V3).

**Package**: `testomniac_extension` (private, not published)

## Tech Stack

- **Language**: TypeScript (strict mode, JSX)
- **Runtime**: Bun
- **Package Manager**: Bun (do not use npm/yarn/pnpm for installing dependencies)
- **Build**: Vite 5 + @crxjs/vite-plugin
- **UI**: React 18, Tailwind CSS 3
- **State**: Zustand 5
- **Browser API**: webextension-polyfill

## Project Structure

```
src/
├── manifest.json                     # Chrome Manifest V3
├── background/
│   └── index.ts                      # Service worker (~750 lines)
├── content/
│   └── index.ts                      # Content script (element extraction)
├── popup/
│   ├── index.html                    # Popup entry
│   ├── main.tsx                      # React mount
│   ├── App.tsx                       # URL input + logs + controls
│   └── index.css                     # Tailwind imports
└── shared/
    ├── types/
    │   └── messaging.ts              # Internal message types
    └── security/
        └── networkGuard.ts           # Fetch/XHR monkey-patch
```

## Commands

```bash
bun run dev          # Vite dev server (hot reload extension)
bun run build        # TypeScript check + Vite build
bun run type-check   # TypeScript only (tsc --noEmit)
```

## Architecture: AI Test Loop

The background service worker orchestrates the main test loop:

1. Creates a new tab, navigates to target URL
2. Injects content script to extract interactive elements (with coordinates)
3. Calls API `POST /pick-element` — AI selects which element to interact with
4. Clicks element via Chrome DevTools Protocol (real mouse events, not DOM clicks)
5. Captures screenshot via CDP
6. Calls API `POST /validate-page` — AI validates navigation result
7. Loops back to step 2

## Content Script

Extracts interactive elements with limits:
- Links: max 30
- Buttons: max 40
- Inputs: max 50

Also captures console errors and network errors.

### Element Tracking

Elements are tracked by **content key** (`"type:text|href"`), not by position. Style fingerprinting uses tag + parent hierarchy + CSS classes for stable identification across page changes.

## Popup

Simple UI with:
- URL input field
- Start/Stop test button
- Live log output

## Network Guard

`networkGuard.ts` monkey-patches `fetch` and `XMLHttpRequest` in the content script context. Reports any unauthorized domain calls.

## API Integration

- `API_BASE_URL` is hardcoded to `http://localhost:3001/api/v1`
- Does NOT use `@testomniac/client` — makes raw `fetch` calls directly
- `@testomniac/types` and `@testomniac/lib` are dependencies but usage is minimal

## Chrome Permissions

`activeTab`, `scripting`, `tabs`, `storage`, `debugger`

## Path Aliases

```
@/        -> src/
@shared/  -> src/shared/
@background/ -> src/background/
@popup/   -> src/popup/
```

## Related Projects

- **@testomniac/types** (`testomniac_types`) — Shared type definitions; used for messaging types and element payloads
- **@testomniac/lib** (`testomniac_lib`) — Listed as a dependency but usage is minimal
- **@testomniac/api** (`testomniac_api`) — The backend this extension calls directly via raw `fetch` (NOT via the client SDK)
- **@testomniac/client** (`testomniac_client`) — NOT used. The extension bypasses the client SDK entirely and makes direct fetch calls to the API.
- **@testomniac/app** (`testomniac_app`) — Sibling consumer of the same API; no direct dependency between extension and app

## Coding Patterns

- **Background service worker orchestrates the test loop**: The main logic (~750 lines) lives in `background/index.ts`. It creates tabs, injects content scripts, calls AI endpoints, and loops.
- **Content script extracts elements with hard limits**: Links (max 30), buttons (max 40), inputs (max 50). These limits prevent overwhelming the AI with too many elements.
- **Chrome DevTools Protocol for real interactions**: Mouse clicks and screenshots use CDP (`chrome.debugger`), not DOM click events. This produces more realistic user behavior.
- **Style fingerprinting for element tracking**: Elements are tracked by content key (`"type:text|href"`) and style fingerprint (tag + parent hierarchy + CSS classes), not by DOM position or index.
- **Zustand v5 for popup state**: The popup UI uses Zustand 5 (NOT v4.5 like `@testomniac/lib`). Be aware of API differences between versions.
- **Raw fetch calls to API**: All API communication uses direct `fetch()` calls with `API_BASE_URL` prefix. No abstraction layer.

## Gotchas

- **API_BASE_URL hardcoded to localhost:3001**: `API_BASE_URL` is set to `http://localhost:3001/api/v1`. This only works when the API server is running locally. There is no configuration UI for changing it.
- **Does NOT use @testomniac/client**: Despite the client SDK existing, this extension makes raw `fetch` calls. If the API contract changes, both the client SDK AND the extension's fetch calls must be updated separately.
- **Elements tracked by content key, not position**: If you try to identify elements by index or DOM position, it will break. The system uses `"type:text|href"` content keys and style fingerprints for stable tracking across page changes.
- **Max 50 log entries in popup**: The popup log display is capped at 50 entries. Older entries are dropped. Do not rely on the popup for complete test history.
- **Chrome debugger permission needed for screenshots**: The `debugger` permission triggers a Chrome warning bar ("Extension is debugging this browser"). Users must not dismiss it during testing.
- **Zustand v5 vs v4.5**: This extension uses Zustand 5, while `@testomniac/lib` uses Zustand 4.5. Do not copy store patterns between the two without accounting for API differences (`createStore` vs `create`, different middleware signatures).
- **Network guard monkey-patches fetch/XHR**: `networkGuard.ts` overrides `window.fetch` and `XMLHttpRequest` in the content script context. This can interfere with the page being tested if not handled carefully.

## Testing

- **No test suite currently exists**. There are no unit or integration tests.
- If adding tests, use Vitest to stay consistent with other testomniac packages.
- Background service worker logic is the highest priority for testing but is difficult to test due to Chrome API dependencies. Consider extracting pure logic functions from `background/index.ts` into testable modules.
- Content script element extraction logic can be tested by mocking DOM structures.
- Mock `chrome.debugger`, `chrome.tabs`, and `chrome.scripting` APIs using libraries like `jest-chrome` or manual mocks.
- The popup React components can be tested with React Testing Library.
