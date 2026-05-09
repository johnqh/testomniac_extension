# testomniac_extension

Chrome extension for Testomniac. It lets a signed-in user pick a workspace and
product, start a scan from the current tab URL, and watch coverage/findings as
the scan runs.

The extension is built with `React`, `Vite`, and Chrome Manifest V3 APIs.

## What It Does

The extension is the interactive entry point for URL scanning:

1. The side panel authenticates the user with Firebase
2. The user selects workspace, product, and environment label
3. The extension asks `testomniac_api` to bootstrap a discovery run from the
   URL through `POST /api/v1/scan`
4. The background worker creates a `ChromeAdapter`
5. The shared runner service scans pages and generates coverage
6. Progress and results stream back into the side panel

`POST /api/v1/scan` is intentionally kept as the simple public entrypoint for
"scan this URL". It is only a bootstrap route. Internally it creates the root
discovery run and related records, and the actual execution continues through
the normal run loop.

## Architecture

- [src/sidepanel/SidePanel.tsx](/Users/johnhuang/projects/testomniac_extension/src/sidepanel/SidePanel.tsx)
  Main UI for auth, environment selection, scan start, and results
- [src/background/index.ts](/Users/johnhuang/projects/testomniac_extension/src/background/index.ts)
  Background service worker that starts and monitors scans
- [src/adapters/ChromeAdapter.ts](/Users/johnhuang/projects/testomniac_extension/src/adapters/ChromeAdapter.ts)
  BrowserAdapter implementation backed by `chrome.tabs`, `chrome.scripting`,
  and `chrome.debugger`
- [src/shared/environment.ts](/Users/johnhuang/projects/testomniac_extension/src/shared/environment.ts)
  Local vs shared environment resolution

## Development

```bash
bun install
bun run dev
```

Build and validation:

```bash
bun run build
bun run type-check
bun run lint
```

## Load In Chrome

1. Run `bun run build`
2. Open `chrome://extensions`
3. Enable Developer Mode
4. Click `Load unpacked`
5. Select the generated `dist/` directory

## Required Runtime Config

The extension reads these values from Vite env or saved local config:

- `VITE_API_URL`
- `VITE_SCANNER_API_KEY`

It also depends on Firebase client configuration used by the auth components.

## Permissions

- `identity`
- `storage`
- `activeTab`
- `scripting`
- `tabs`
- `debugger`
- `sidePanel`

## Related Repos

- `testomniac_api`
  Creates runs, stores state, and returns summaries
- `testomniac_runner_service`
  Shared scan and coverage-generation engine
- `testomniac_types`
  Shared request, response, and domain types
