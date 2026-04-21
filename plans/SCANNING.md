# Testomniac Extension — Scanning Integration Plan

## Overview

The Testomniac Chrome extension runs the same scanning logic as the server-side scanner, but uses Chrome APIs instead of Puppeteer. A shared library (`@sudobility/testomniac_scanning_service`) provides the scanning logic with a `BrowserAdapter` abstraction.

## Architecture

```
@sudobility/testomniac_scanning_service (shared library)
  ├── BrowserAdapter interface
  ├── Scanning logic (mouse-scanner, extractor, issue-detector, etc.)
  ├── API client (talks to testomniac_api)
  ├── Config constants
  └── React hooks (useScanner, useScanProgress)

testomniac_extension (this project)
  ├── ChromeAdapter implements BrowserAdapter
  │   └── Uses: chrome.tabs, chrome.scripting, chrome.debugger
  ├── Side Panel UI (Chrome Side Panel API)
  │   ├── React + @sudobility/design + Tailwind
  │   └── Components: ScanForm, PhaseIndicator, LiveCounters, EventLog, Screenshot
  ├── Background service worker
  │   └── Orchestrates scanning via ChromeAdapter + shared lib
  └── Content script (minimal — element extraction helper)
```

## ChromeAdapter Implementation

The `ChromeAdapter` wraps Chrome extension APIs to implement `BrowserAdapter`:

| BrowserAdapter method | Chrome API |
|----------------------|------------|
| `goto(url)` | `chrome.tabs.update(tabId, { url })` + wait for `onUpdated` complete |
| `click(selector)` | `chrome.scripting.executeScript` → `document.querySelector(sel).click()` |
| `hover(selector)` | `chrome.scripting.executeScript` → dispatch `mouseover` + `mouseenter` events |
| `type(selector, text)` | `chrome.scripting.executeScript` → focus + set value + dispatch input events |
| `waitForSelector(selector)` | Poll via `chrome.scripting.executeScript` |
| `waitForNavigation()` | Wait for `chrome.tabs.onUpdated` with `status: 'complete'` |
| `evaluate(fn)` | `chrome.scripting.executeScript({ func: fn })` |
| `content()` | `chrome.scripting.executeScript` → `document.documentElement.outerHTML` |
| `url()` | `chrome.tabs.get(tabId)` → `tab.url` |
| `screenshot()` | `chrome.tabs.captureVisibleTab()` → base64 → Uint8Array |
| `setViewport(w, h)` | `chrome.debugger.sendCommand('Emulation.setDeviceMetricsOverride')` |
| `pressKey(key)` | `chrome.debugger.sendCommand('Input.dispatchKeyEvent')` |
| `select(selector, value)` | `chrome.scripting.executeScript` → set select value |
| `close()` | `chrome.tabs.remove(tabId)` |
| `on('console', handler)` | `chrome.debugger.sendCommand('Runtime.enable')` + `onEvent` listener |
| `on('response', handler)` | `chrome.debugger.sendCommand('Network.enable')` + `onEvent` listener |

### Key Considerations

- **`chrome.debugger`** triggers a "debugging" banner in Chrome — needed for viewport control, console/network monitoring
- **`chrome.scripting.executeScript`** runs in the page context — used for DOM queries, clicks, typing
- **Tab management**: Extension creates a new tab for scanning, watches it via `tabId`
- **Navigation waits**: Use `chrome.tabs.onUpdated` listener with `status: 'complete'` and `url` change detection

## Side Panel UI

Uses Chrome Side Panel API (Manifest V3):

### Manifest Changes

```json
{
  "permissions": ["activeTab", "scripting", "tabs", "storage", "debugger", "sidePanel"],
  "side_panel": {
    "default_path": "sidepanel.html"
  }
}
```

### Side Panel Layout

```
┌─────────────────────────────┐
│  Testomniac Scanner         │
├��────────────────────────────┤
│  URL: [________________]    │
│  [Start Scan]  [Stop]       │
├─────────────────────────────┤
│  Phase: ● Scanning          │
│  ○ AI  ○ Input  ○ Gen  ○ Run│
├─────────────────────────────┤
│  Pages: 12  States: 34      │
│  Actions: 156  Issues: 3    │
├─────────────────────────────┤
│  Current Page               │
│  https://example.com/about  │
│  ┌───────────────────────┐  │
│  │    [screenshot]        │  │
│  └───────────────────────┘  │
├─────────────────────────────┤
│  Event Log                  │
│  12:01 click #btn-submit    ��
│  12:01 page discovered /pay │
│  12:00 mouseover .nav-link  │
│  11:59 navigate /about      │
└───────────���─────────────────┘
```

### Reusable Components

Import from `testomniac_app` pattern (or create local equivalents):
- `PhaseIndicator` — horizontal phase stepper
- `LiveCounters` — 4 stat counters
- `StatusBadge` — colored status pill
- `EventLog` — scrollable event list
- `ScanForm` — URL input with validation

### State Management

Use `zustand` store in the side panel (same pattern as `scanProgressStore`):
- Phase, counters, events, screenshot URL, current page URL
- Background script sends updates via `chrome.runtime.sendMessage`
- Side panel listens via `chrome.runtime.onMessage`

## Background Service Worker

The background script orchestrates scanning:

```ts
import { ApiClient } from "@sudobility/testomniac_scanning_service";
import { runMouseScanner } from "@sudobility/testomniac_scanning_service";
import { ChromeAdapter } from "../adapters/ChromeAdapter";

async function startScan(url: string) {
  // 1. Create tab
  const tab = await chrome.tabs.create({ url });
  const adapter = new ChromeAdapter(tab.id!);

  // 2. Initialize API client
  const api = new ApiClient(apiUrl, apiKey);

  // 3. Create project + app + run via API
  const project = await api.createProject({ name: url });
  const app = await api.createApp(project.id, url, url, normalizeUrl(url));
  const run = await api.createRun(app.id, "desktop");

  // 4. Run scanning phases (from shared lib)
  await runMouseScanner(adapter, { appId: app.id, runId: run.id, baseUrl: url, sizeClass: "desktop" });

  // 5. Send progress to side panel
  chrome.runtime.sendMessage({ type: "scan_progress", data: { phase, counters, screenshot } });
}
```

## Implementation Order

### Step 1: ChromeAdapter
- Create `src/adapters/ChromeAdapter.ts`
- Implement all `BrowserAdapter` methods
- Test with a simple navigate + screenshot flow

### Step 2: Side Panel Setup
- Add `sidePanel` to manifest
- Create `sidepanel.html` + React entry point
- Basic UI: URL input, start button, status display

### Step 3: Background Integration
- Import scanning functions from `@sudobility/testomniac_scanning_service`
- Wire up `ChromeAdapter` + API client
- Send progress messages to side panel

### Step 4: Full UI
- PhaseIndicator, LiveCounters, EventLog, Screenshot display
- Start/stop controls
- Error handling and display

### Step 5: Cleanup
- Remove old popup-based scanning code
- Update CLAUDE.md
- Verify build

## Dependencies

```json
{
  "@sudobility/testomniac_scanning_service": "^0.0.1",
  "@sudobility/testomniac_types": "^0.0.21",
  "@sudobility/design": "^1.1.29"
}
```

## Environment

The extension needs these settings (stored in `chrome.storage.local`):
- `apiUrl` — URL of testomniac_api (default: `http://localhost:8027`)
- `apiKey` — Scanner API key (for authenticating with the API)

These are configured in the side panel settings section.
