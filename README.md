# testomniac_extension

AI-powered automated UI testing Chrome extension (Manifest V3). Navigates websites autonomously, interacts with elements via Chrome DevTools Protocol, and uses AI to validate page behavior.

## Setup

```bash
bun install
bun run dev          # Build with hot reload
```

Load in Chrome: go to `chrome://extensions`, enable Developer Mode, click "Load unpacked", and select the `dist/` folder.

## How It Works

1. User enters a target URL in the popup and clicks Start
2. Extension creates a new tab and navigates to the URL
3. Content script extracts interactive elements (links, buttons, inputs) with coordinate data
4. AI endpoint (`POST /pick-element`) selects which element to interact with
5. Element is clicked via Chrome DevTools Protocol (real mouse events)
6. Screenshot is captured via CDP
7. AI endpoint (`POST /validate-page`) validates the navigation result
8. Loop repeats from step 3

## Architecture

- **Background** (`src/background/`) -- Service worker orchestrating the test loop (~750 lines)
- **Content** (`src/content/`) -- Element extraction with hard limits (30 links, 40 buttons, 50 inputs)
- **Popup** (`src/popup/`) -- React UI with URL input, start/stop controls, and live logs
- **Shared** (`src/shared/`) -- Message types and network guard (fetch/XHR monkey-patch)

## Development

```bash
bun run dev          # Vite dev server (hot reload)
bun run build        # TypeScript check + Vite build
bun run type-check   # TypeScript only
```

## Chrome Permissions

`activeTab`, `scripting`, `tabs`, `storage`, `debugger`

## Related Packages

- `testomniac_types` -- Shared type definitions (via file: link)
- `testomniac_lib` -- Business logic (via file: link, minimal usage)
- `testomniac_api` -- Backend API server (called directly via fetch)

## License

BUSL-1.1
