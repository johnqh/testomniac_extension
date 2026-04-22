# Refactoring Plan: Consolidate Business Logic into testomniac_scanning_service

## Context

The testomniac_extension and testomniac_scanner both implement overlapping business logic independently: element extraction, bug detection, scan orchestration, action classification, form value planning, and direct API calls. This creates maintenance burden — changes to scanning logic must be made in two places.

This refactoring consolidates all shared business logic into `testomniac_scanning_service`, making both consumers thin wrappers that provide a `BrowserAdapter` implementation and handle platform-specific concerns (Chrome APIs vs Puppeteer).

**Dependency chain**: `testomniac_types` → `testomniac_scanning_service` → `testomniac_scanner` + `testomniac_extension`

**Build/deploy**: After modifying scanning_service, run `testomniac_app/scripts/push_all.sh` to build, publish, and update all consumers. Fix any errors if the script fails.

---

## 1. Target scanning_service Directory Layout

```
src/
├── index.ts                          # Public exports (expanded)
├── adapter.ts                        # BrowserAdapter interface (extended with getUrl, submitTextEntry)
│
├── api/
│   └── client.ts                     # ApiClient — unchanged, already has 55+ methods
│
├── browser/
│   ├── page-utils.ts                 # MODIFY: make computeHashes async, universal sha256
│   ├── page-utils.test.ts            # UPDATE tests for async
│   └── dom-snapshot.ts               # NEW: buildDomSnapshot (from extension/extractors/domSnapshot.ts)
│
├── config/
│   └── constants.ts                  # EXISTING — no changes
│
├── detectors/
│   ├── index.ts                      # MODIFY: add new detector exports
│   ├── link-checker.ts               # EXISTING
│   ├── visual-checker.ts             # EXISTING
│   ├── content-checker.ts            # EXISTING
│   ├── functional-checker.ts         # EXISTING
│   ├── bug-detector.ts               # NEW: from extension inline detectors
│   └── modal-handler.ts              # NEW: from extension modal detection
│
├── domain/
│   ├── types.ts                      # EXISTING
│   └── url-ownership.ts              # EXISTING
│
├── extractors/                       # NEW: entire directory from extension
│   ├── index.ts                      # Orchestrates snapshot + all extractors
│   ├── types.ts                      # ExtractorCandidate, DomSnapshotEntry, ItemExtractor
│   ├── helpers.ts                    # createCandidate, withResolvedSelector, uniqueBySelector
│   ├── selectors.ts                  # classifyActionKind, resolveSelectors
│   ├── buttons.ts                    # buttonExtractor
│   ├── clickables.ts                 # clickableExtractor
│   ├── text-inputs.ts               # textInputExtractor
│   ├── selects.ts                    # selectExtractor
│   ├── toggles.ts                    # toggleExtractor
│   ├── product-actions.ts            # productActionExtractor
│   └── form-extractor.ts            # extractForms (from scanner/extractor.ts)
│
├── planners/                         # NEW
│   └── fill-value-planner.ts         # From extension/planners/fillValuePlanner.ts (100% pure)
│
├── scanner/
│   ├── action-queue.ts               # EXISTING
│   ├── state-manager.ts              # EXISTING
│   ├── loop-guard.ts                 # EXISTING
│   ├── phase-timer.ts                # EXISTING
│   ├── issue-detector.ts             # EXISTING
│   ├── component-detector.ts         # EXISTING
│   ├── email-detector.ts             # EXISTING
│   ├── scroll-scanner.ts             # EXISTING
│   ├── pairwise.ts                   # EXISTING
│   ├── navigator.ts                  # NEW: from scanner/scanner/navigator.ts
│   └── action-classifier.ts          # NEW: from extension (normalizeHref, getActionPriority, etc.)
│
├── ai/                               # NEW: from scanner/ai/
│   ├── analyzer.ts                   # runAiAnalysis (parameterized, no singletons)
│   ├── persona-generator.ts          # generatePersonas
│   ├── use-case-generator.ts         # generateUseCases
│   ├── input-generator.ts            # generateInputValues
│   └── token-tracker.ts              # trackOpenAiCall
│
├── generation/                       # NEW: from scanner/generation/
│   ├── generator.ts                  # generateTestCases
│   ├── suite-tagger.ts               # assignPriority, assignSuiteTags
│   ├── render.ts                     # generateRenderTest
│   ├── interaction.ts                # generateInteractionTest
│   ├── form.ts                       # generateFormTest
│   ├── form-negative.ts              # generateFormNegativeTests
│   ├── password.ts                   # generatePasswordTests
│   ├── navigation.ts                 # generateNavigationTest
│   └── e2e.ts                        # generateE2ETest, enumerateE2EPaths
│
├── orchestrator/                     # NEW: shared scan orchestrator
│   ├── types.ts                      # ScanConfig, ScanEventHandler, ScanResult, TestExecutor
│   ├── orchestrator.ts               # runScan() — main entry point
│   ├── mouse-scanning.ts             # Phase 1a: element discovery + interaction
│   ├── ai-analysis.ts                # Phase 1b: persona/useCase/input generation
│   ├── input-scanning.ts             # Phase 1c: pairwise form testing
│   ├── test-generation.ts            # Phase 3: create test cases
│   └── test-execution.ts             # Phase 4: execute via TestExecutor interface
│
└── plugins/                          # NEW: interface + registry from scanner
    ├── types.ts                      # Plugin, PluginContext, PluginResult
    └── registry.ts                   # registerPlugin, getEnabledPlugins
```

---

## 2. BrowserAdapter Interface Changes

File: `testomniac_scanning_service/src/adapter.ts`

Add 2 new methods to the existing 15-method interface:

```typescript
/** Get the current URL (async — needed by ChromeAdapter which queries chrome.tabs) */
getUrl(): Promise<string>;

/** Submit a text entry by pressing Enter on the focused field */
submitTextEntry(selector: string): Promise<void>;
```

Both already exist in `ChromeAdapter` (extension lines 304, 217). `PuppeteerAdapter` needs trivial implementations:
```typescript
async getUrl(): Promise<string> { return this.page.url(); }
async submitTextEntry(selector: string): Promise<void> {
  await this.page.focus(selector);
  await this.page.keyboard.press('Enter');
}
```

---

## 3. Orchestrator Design

### 3.1 Core Interfaces (`orchestrator/types.ts`)

```typescript
type ScanPhase = 'mouse_scanning' | 'ai_analysis' | 'input_scanning' | 'test_generation' | 'test_execution';

interface ScanConfig {
  runId: number;
  appId: number;
  baseUrl: string;
  phases: ScanPhase[];
  sizeClass?: string;           // default: 'desktop'
  openaiApiKey?: string;        // required for ai_analysis phase
  openaiModel?: string;         // default: 'gpt-4o'
  testWorkerCount?: number;     // default: 3
}

interface ScanEventHandler {
  onPageFound(page: { url: string; pageId: number }): void;
  onPageStateCreated(state: { pageStateId: number; pageId: number; screenshotPath?: string }): void;
  onActionCompleted(action: { type: string; selector?: string; pageUrl: string }): void;
  onIssueDetected(issue: { type: string; description: string }): void;
  onPhaseChanged(phase: string): void;
  onStatsUpdated(stats: { pagesFound: number; pageStatesFound: number; actionsCompleted: number; issuesFound: number }): void;
  onScreenshotCaptured(data: { dataUrl: string; pageUrl: string }): void;
  onScanComplete(summary: { totalPages: number; totalIssues: number; durationMs: number }): void;
  onError(error: { message: string; phase?: string }): void;
}

interface TestExecutor {
  executeTestCase(actions: TestAction[], screen: Screen): Promise<{ passed: boolean; error?: string; durationMs: number }>;
}

interface ScanResult {
  runId: number;
  pagesFound: number;
  pageStatesFound: number;
  actionsCompleted: number;
  issuesFound: number;
  durationMs: number;
}
```

### 3.2 Main Entry Point (`orchestrator/orchestrator.ts`)

```typescript
async function runScan(
  adapter: BrowserAdapter,
  config: ScanConfig,
  api: ApiClient,
  eventHandler: ScanEventHandler,
  testExecutor?: TestExecutor
): Promise<ScanResult>
```

Iterates `config.phases` in order, calling phase functions. Tracks timing via `PhaseTimer`. Reports progress via `eventHandler`.

### 3.3 Phase Functions

Each phase is a standalone async function:

- **`runMouseScanning(adapter, config, api, events)`** — Consolidates extension's `runScan` loop and scanner's `mouse-scanner.ts`. Uses server-driven action queue (API `getNextOpenAction`). Calls shared extractors, bug detectors, modal handler, action classifier, fill value planner.
- **`runAiAnalysis(config, api, events)`** — No adapter needed. Calls GPT-4o for personas/useCases/inputValues.
- **`runInputScanning(adapter, config, api, events)`** — Pairwise form testing with AI-generated values.
- **`runTestGeneration(config, api)`** — Creates JSON test cases from discovered page states.
- **`runTestExecution(adapter, config, api, events, testExecutor)`** — Delegates to `TestExecutor` provided by consumer. Scanner provides worker-pool executor, extension can skip or provide single-tab executor.

---

## 4. Breaking Change: `computeHashes` becomes async

File: `scanning_service/src/browser/page-utils.ts`

Create a universal `sha256` helper that works in both Node.js and browser:
```typescript
async function sha256(input: string): Promise<string> {
  if (typeof globalThis.process !== 'undefined') {
    const { createHash } = await import('node:crypto');
    return createHash('sha256').update(input).digest('hex');
  }
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
```

Change `computeHashes` signature from sync to async:
```typescript
export async function computeHashes(html: string, actionableItems: ActionableItem[]): Promise<PageHashes>
```

Both consumers already `await` hash results (extension uses SubtleCrypto, scanner calls sync but in async contexts).

---

## 5. Files to Create in scanning_service

| New File | Source | Notes |
|----------|--------|-------|
| `src/extractors/types.ts` | extension `background/extractors/types.ts` | Pure types, no changes |
| `src/extractors/helpers.ts` | extension `background/extractors/helpers.ts` | Pure functions, no changes |
| `src/extractors/selectors.ts` | extension `background/extractors/selectors.ts` | Pure functions, no changes |
| `src/extractors/buttons.ts` | extension `background/extractors/buttons.ts` | Pure, no changes |
| `src/extractors/clickables.ts` | extension `background/extractors/clickables.ts` | Pure, no changes |
| `src/extractors/text-inputs.ts` | extension `background/extractors/textInputs.ts` | Pure, no changes |
| `src/extractors/selects.ts` | extension `background/extractors/selects.ts` | Pure, no changes |
| `src/extractors/toggles.ts` | extension `background/extractors/toggles.ts` | Pure, no changes |
| `src/extractors/product-actions.ts` | extension `background/extractors/productActions.ts` | Pure, no changes |
| `src/extractors/index.ts` | extension `background/extractors/index.ts` | Change imports to use BrowserAdapter |
| `src/extractors/form-extractor.ts` | scanner `scanner/extractor.ts` `extractForms()` | Port from Page to BrowserAdapter |
| `src/browser/dom-snapshot.ts` | extension `background/extractors/domSnapshot.ts` | Change import to BrowserAdapter |
| `src/planners/fill-value-planner.ts` | extension `background/planners/fillValuePlanner.ts` | 100% pure, no changes |
| `src/detectors/bug-detector.ts` | extension `background/index.ts` lines 200-494 | Extract 4 detect* functions, use BrowserAdapter |
| `src/detectors/modal-handler.ts` | extension `background/index.ts` lines 500-578 | Use BrowserAdapter |
| `src/scanner/action-classifier.ts` | extension `background/index.ts` lines 580-655 | Pure functions, no changes |
| `src/scanner/navigator.ts` | scanner `scanner/navigator.ts` | Port from Page to BrowserAdapter, remove pino |
| `src/ai/analyzer.ts` | scanner `ai/analyzer.ts` | Accept ApiClient + OpenAI as params, remove pino/singleton |
| `src/ai/persona-generator.ts` | scanner `ai/persona-generator.ts` | Remove pino |
| `src/ai/use-case-generator.ts` | scanner `ai/use-case-generator.ts` | Remove pino |
| `src/ai/input-generator.ts` | scanner `ai/input-generator.ts` | Remove pino |
| `src/ai/token-tracker.ts` | scanner `ai/token-tracker.ts` | Accept ApiClient as param |
| `src/generation/generator.ts` | scanner `generation/generator.ts` | Accept ApiClient as param, remove pino |
| `src/generation/suite-tagger.ts` | scanner `generation/suite-tagger.ts` | Use local constants |
| `src/generation/render.ts` | scanner `generation/render.ts` | Pure, fix imports |
| `src/generation/interaction.ts` | scanner `generation/interaction.ts` | Pure, fix imports |
| `src/generation/form.ts` | scanner `generation/form.ts` | Pure, fix imports |
| `src/generation/form-negative.ts` | scanner `generation/form-negative.ts` | Pure, fix imports |
| `src/generation/password.ts` | scanner `generation/password.ts` | Pure, fix imports |
| `src/generation/navigation.ts` | scanner `generation/navigation.ts` | Pure, fix imports |
| `src/generation/e2e.ts` | scanner `generation/e2e.ts` | Pure, fix imports |
| `src/plugins/types.ts` | scanner `plugins/types.ts` | Use BrowserAdapter in PluginContext |
| `src/plugins/registry.ts` | scanner `plugins/registry.ts` | Remove pino |
| `src/orchestrator/types.ts` | NEW | ScanConfig, ScanEventHandler, ScanResult, TestExecutor |
| `src/orchestrator/orchestrator.ts` | NEW (consolidates ext + scanner) | runScan() main entry |
| `src/orchestrator/mouse-scanning.ts` | NEW (consolidates ext + scanner) | Phase 1a shared logic |
| `src/orchestrator/ai-analysis.ts` | NEW (wraps ai/analyzer) | Phase 1b |
| `src/orchestrator/input-scanning.ts` | scanner `scanner/input-scanner.ts` | Phase 1c, port to BrowserAdapter |
| `src/orchestrator/test-generation.ts` | NEW (wraps generation/generator) | Phase 3 |
| `src/orchestrator/test-execution.ts` | NEW | Phase 4 via TestExecutor interface |

---

## 6. Files to Modify in scanning_service

| File | Change |
|------|--------|
| `src/adapter.ts` | Add `getUrl(): Promise<string>` and `submitTextEntry(selector): Promise<void>` |
| `src/browser/page-utils.ts` | Make `computeHashes` async, add universal `sha256` |
| `src/detectors/index.ts` | Add exports for bug-detector and modal-handler |
| `src/index.ts` | Add all new exports (extractors, planners, orchestrator, ai, generation, plugins) |
| `package.json` | Bump version to `0.1.0` |

---

## 7. Extension Changes

### Files to DELETE

All of `src/background/extractors/` (11 files) — moved to scanning_service  
`src/background/planners/fillValuePlanner.ts` — moved to scanning_service  
`src/shims/crypto.ts` — scanning_service handles hashing universally

### `src/background/index.ts` — REWRITE (~1500 lines → ~200 lines)

The entire file reduces to:
1. **Config**: Load API URL/key from `chrome.storage.local`
2. **Message handlers**: `START_SCAN`, `STOP_SCAN`, `GET_STATUS`, `SET_AUTH_TOKEN`, `SAVE_CONFIG`
3. **On START_SCAN**: Create `ChromeAdapter`, create `ApiClient`, create `ScanEventHandler` that calls `sendProgressToSidePanel()`, then call `runScan(adapter, config, api, eventHandler)` from scanning_service
4. **ScanEventHandler implementation**: Maps orchestrator events to `chrome.runtime.sendMessage` for the side panel
5. **Chrome-specific glue**: Tab management, new-tab detection, `chrome.action.onClicked` for side panel

Everything else (scan loop, extractors, bug detectors, hashing, modal handling, action classification, fill value planning) is deleted — replaced by the single `runScan()` call.

### `src/sidepanel/SidePanel.tsx` — MODIFY for testomniac_client

Replace `chrome.runtime.onMessage` progress listener with TanStack Query hooks from `@sudobility/testomniac_client`:

```typescript
import { useRun, useRunPages, useRunIssues, useRunActions } from '@sudobility/testomniac_client';
```

The side panel uses `runId` (obtained after `POST /api/v1/scan`) to query:
- `useRun(runId)` — run status, phase, counters
- `useRunPages(runId)` — discovered pages
- `useRunIssues(runId)` — detected issues
- `useRunActions(runId)` — logged actions

Keep `START_SCAN` / `STOP_SCAN` messages for controlling the background worker.
Keep screenshot display via message (captured locally by adapter, not stored in API initially).

### `src/sidepanel/main.tsx` — MODIFY

Wrap with `QueryClientProvider` from `@tanstack/react-query` (already a dependency).

### `src/adapters/ChromeAdapter.ts` — NO CHANGES

Already has `getUrl()` (line 304) and `submitTextEntry()` (line 217). Already implements `BrowserAdapter`.

### `vite.config.ts` — MODIFY

Remove the `node:crypto` shim alias since scanning_service now handles hashing universally:
```diff
-'node:crypto': path.resolve(__dirname, './src/shims/crypto.ts'),
```

### `package.json` — UPDATE

Update `@sudobility/testomniac_scanning_service` to `^0.1.0`.

---

## 8. Scanner Changes

### Files to DELETE

**Moved to scanning_service (duplicates or relocated)**:
- `src/scanner/extractor.ts` + test
- `src/scanner/mouse-scanner.ts` + test  
- `src/scanner/input-scanner.ts` + test
- `src/scanner/navigator.ts` + test
- `src/scanner/action-queue.ts` + test (already in scanning_service)
- `src/scanner/state-manager.ts` + test (already in scanning_service)
- `src/scanner/issue-detector.ts` + test (already in scanning_service)
- `src/scanner/loop-guard.ts` + test (already in scanning_service)
- `src/scanner/pairwise.ts` + test (already in scanning_service)
- `src/scanner/phase-timer.ts` + test (already in scanning_service)
- `src/scanner/scroll-scanner.ts` + test (already in scanning_service)
- `src/scanner/email-detector.ts` + test (already in scanning_service)
- `src/scanner/component-detector.ts` + test (already in scanning_service)
- `src/ai/` (entire directory — moved to scanning_service)
- `src/generation/` (entire directory — moved to scanning_service)
- `src/browser/page-utils.ts` + test (already in scanning_service)
- `src/domain/types.ts` (already in scanning_service)
- `src/domain/url-ownership.ts` (already in scanning_service)
- `src/config/constants.ts` (already in scanning_service)
- `src/api/client.ts` (duplicate of scanning_service ApiClient)
- `src/plugins/types.ts` (moved to scanning_service)
- `src/plugins/registry.ts` (moved to scanning_service)

### `src/orchestrator.ts` — REWRITE (~170 lines → ~80 lines)

Replace manual phase chaining with shared orchestrator:
```typescript
import { runScan, getApiClient, type ScanEventHandler } from '@sudobility/testomniac_scanning_service';

export async function runFullScan(options: RunOptions): Promise<void> {
  const config = loadConfig();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const adapter = new PuppeteerAdapter(page);
  const api = getApiClient(config.apiUrl, config.scannerApiKey);

  const eventHandler: ScanEventHandler = {
    onPhaseChanged: (phase) => logger.info({ phase }, 'phase changed'),
    onIssueDetected: (issue) => logger.warn(issue, 'issue detected'),
    // ... map to pino logging
  };

  await runScan(adapter, {
    runId: options.runId,
    appId: options.appId,
    baseUrl: options.url,
    phases: ['mouse_scanning', 'ai_analysis', 'input_scanning', 'test_generation', 'test_execution'],
    openaiApiKey: config.openaiApiKey,
  }, api, eventHandler, workerPoolExecutor);

  await browser.close();
}
```

### `src/index.ts` — MODIFY

Change `getApiClient` import from local to scanning_service:
```typescript
import { getApiClient } from '@sudobility/testomniac_scanning_service';
```

### `src/adapters/PuppeteerAdapter.ts` — ADD 2 methods

```typescript
async getUrl(): Promise<string> {
  return this.page.url();
}

async submitTextEntry(selector: string): Promise<void> {
  await this.page.focus(selector);
  await this.page.keyboard.press('Enter');
}
```

### Files that STAY in scanner

| File | Reason |
|------|--------|
| `src/adapters/PuppeteerAdapter.ts` | Puppeteer-specific BrowserAdapter impl |
| `src/browser/chromium.ts` | Puppeteer browser launch/close |
| `src/config/index.ts` | Server env var loading |
| `src/runner/executor.ts` | Maps JSON test actions to Puppeteer commands |
| `src/runner/worker-pool.ts` | Concurrent test execution (update imports) |
| `src/runner/reporter.ts` | Pass/fail summary |
| `src/email/*` | Postmark email sending, deep links, templates |
| `src/auth/*` | Form identification, credentials, login, Signic |
| `src/scanner/email-checker.ts` | Signic inbox polling (server-specific) |
| `src/plugins/seo/*` | SEO plugin implementations (update imports) |
| `src/plugins/security/*` | Security plugin implementations (update imports) |
| `src/plugins/content/*` | Content plugin implementations (update imports) |
| `src/plugins/ui-consistency/*` | UI consistency plugin (update imports) |

---

## 9. Key Design Decisions

### Mouse scanning: Server-driven action queue

The extension currently uses a local page queue (breadth-first, in-memory). The scanner uses API-driven action queue (`getNextOpenAction`). The shared orchestrator uses the **server-driven approach** because:
- Both consumers have API access
- Actions are persisted (resume-after-crash)
- Proven in production via scanner

The extension's scanning behavior changes slightly: instead of processing all elements on one page before moving to the next, it follows the API's action ordering. Functionally equivalent.

### Logging: No logger in scanning_service

The library reports events via `ScanEventHandler` callbacks. Consumers decide how to log:
- Extension: `chrome.runtime.sendMessage` to side panel
- Scanner: `pino` structured logging

### Test execution: Consumer-provided TestExecutor

The scanner's worker pool (3 concurrent Puppeteer pages) stays in scanner. The orchestrator's `test_execution` phase delegates to a `TestExecutor` interface. Extension can skip this phase or provide a single-tab executor.

### Plugin implementations stay in scanner

Plugin interface/registry moves to scanning_service. Concrete plugin implementations (SEO, security, content, UI consistency) stay in scanner because they currently use Puppeteer `Page` directly. Porting to `BrowserAdapter` is a follow-up task.

---

## 10. Execution Order

1. **scanning_service**: Create all new files, modify existing files, bump to 0.1.0
2. **Run**: `bun run verify` in scanning_service
3. **Run**: `testomniac_app/scripts/push_all.sh` to publish scanning_service and update all consumers
4. **scanner**: Delete moved files, rewrite orchestrator.ts and index.ts, update PuppeteerAdapter, update remaining imports
5. **Run**: `bun run verify` in scanner
6. **extension**: Delete moved files, rewrite background/index.ts, update side panel, update vite.config.ts
7. **Run**: `bun run build` in extension
8. **Run**: `testomniac_app/scripts/push_all.sh` to deploy everything
9. **Manual test**: Load extension in Chrome, run a scan, verify end-to-end

---

## 11. Verification

### scanning_service
```bash
cd /Users/johnhuang/projects/testomniac_scanning_service
bun run verify   # typecheck + lint + test + build
```
Check: no circular deps, all exports resolve, computeHashes async works, new tests pass.

### scanner
```bash
cd /Users/johnhuang/projects/testomniac_scanner
bun run verify
```
Check: all imports from scanning_service, PuppeteerAdapter satisfies extended BrowserAdapter, existing runner/auth/plugin tests pass.

### extension
```bash
cd /Users/johnhuang/projects/testomniac_extension
bun run build
```
Then manual test:
1. Load unpacked extension in Chrome
2. Open side panel, sign in
3. Click "Test [hostname]" on a test site
4. Verify: pages discovered, elements extracted, actions performed
5. Verify: progress updates appear (counters, screenshots, events)
6. Verify: scan completes, results visible in testomniac_app

### Integration
Run both scanner and extension against the same site. Verify both produce consistent results (same pages, similar issues) since they now share the same scanning logic.
