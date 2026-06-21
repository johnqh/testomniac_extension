# Plan C — testomniac_runner: Reuse Chromium, Isolate Per-Run Contexts

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Target repo:** `testomniac_runner` (headless server-side polling worker; uses `PuppeteerAdapter`).

**Goal:** Stop launching and closing a whole Chromium process per claimed run. Launch one browser per worker process and give each run its own isolated `BrowserContext` + page — eliminating per-run browser startup cost (the most expensive operation in a run) and the shared-`userDataDir` contention between concurrent runs.

**Architecture:** `ChromiumManager` becomes a long-lived, shared browser owner with `createContext()` / `closeContext()` built on `browser.createBrowserContext()` (isolated cookies/cache/storage per context). `RunnerManager` owns one `ChromiumManager`, launches the browser once at startup, and each `runClaimedRun` acquires a context and releases it in `finally`. `orchestrator.runFullScan`/`runSequenceScan` stop constructing their own browser and instead receive a page.

**Tech Stack:** TypeScript, Bun, `bun test` (Vitest-compatible), `puppeteer-core ^24.31.0`.

## Global Constraints

- Package manager: **Bun only**.
- Test runner: `bun test`. CI splits unit vs integration by name: `test:unit` runs `--test-name-pattern '^(?!scanner service)'`, so **integration/browser tests must be `describe("scanner service: …")`** to be excluded from the unit job. Pure-logic tests use a plain `describe("<name>")`.
- Verify gate: `bun run verify` = `typecheck && lint && test && build`.
- `puppeteer-core ^24.31.0` supports `browser.createBrowserContext()` (isolated context) and `context.newPage()`. Use `createBrowserContext()` (not the deprecated `createIncognitoBrowserContext`).
- One browser per worker process; never close the shared browser between runs — only close the per-run context.

---

### Task 1: Make `ChromiumManager` a shared-browser, per-context manager

**Files:**
- Modify: `testomniac_runner/src/browser/chromium.ts:64-94`
- Test: `testomniac_runner/src/browser/chromium.test.ts` (new)

**Interfaces:**
- Consumes: `Config` (existing).
- Produces on `ChromiumManager`:
  - `constructor(config: Config, launcher?: (opts: PuppeteerLaunchOptions) => Promise<Browser>)` — `launcher` defaults to `puppeteer.launch`; injectable for tests.
  - `launch(): Promise<Browser>` — idempotent; reuses the existing browser if already launched.
  - `createContext(screen?: Screen): Promise<{ context: BrowserContext; page: Page }>` — new isolated context + page, viewport applied.
  - `closeContext(context: BrowserContext): Promise<void>` — closes just that context.
  - `close(): Promise<void>` — closes the whole browser (process shutdown only).

- [ ] **Step 1: Write the failing test** (inject a fake browser; no real Chromium)

Create `testomniac_runner/src/browser/chromium.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { ChromiumManager } from "./chromium";
import { loadConfig } from "../config";

function fakeBrowser() {
  const page = { setViewport: vi.fn().mockResolvedValue(undefined) };
  const context = { newPage: vi.fn().mockResolvedValue(page), close: vi.fn().mockResolvedValue(undefined) };
  const browser = {
    createBrowserContext: vi.fn().mockResolvedValue(context),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return { browser, context, page };
}

describe("ChromiumManager shared browser", () => {
  it("launches the browser only once across multiple launch() calls", async () => {
    const { browser } = fakeBrowser();
    const launcher = vi.fn().mockResolvedValue(browser);
    const mgr = new ChromiumManager(loadConfig(), launcher as any);
    await mgr.launch();
    await mgr.launch();
    expect(launcher).toHaveBeenCalledTimes(1);
  });

  it("creates an isolated context + page per run and closes only the context", async () => {
    const { browser, context, page } = fakeBrowser();
    const launcher = vi.fn().mockResolvedValue(browser);
    const mgr = new ChromiumManager(loadConfig(), launcher as any);
    await mgr.launch();
    const acquired = await mgr.createContext();
    expect(acquired.page).toBe(page);
    await mgr.closeContext(acquired.context);
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(browser.close).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd testomniac_runner && bun test src/browser/chromium.test.ts`
Expected: FAIL — `createContext`/`closeContext` not defined; `launch` not idempotent / constructor ignores `launcher`.

- [ ] **Step 3: Implement**

Replace the class body in `src/browser/chromium.ts`:

```typescript
import puppeteer, {
  type Browser,
  type BrowserContext,
  type Page,
  type PuppeteerLaunchOptions,
} from "puppeteer-core";
import type { Config } from "../config";
import type { Screen } from "@sudobility/testomniac_types";
import { resolveChromiumPath } from "./resolve-path"; // keep existing import path

type Launcher = (opts: PuppeteerLaunchOptions) => Promise<Browser>;

export class ChromiumManager {
  private browser: Browser | null = null;

  constructor(
    private config: Config,
    private launcher: Launcher = puppeteer.launch
  ) {}

  async launch(): Promise<Browser> {
    if (this.browser) return this.browser;
    this.browser = await this.launcher({
      executablePath: resolveChromiumPath(this.config.chromiumPath),
      userDataDir: this.config.userDataDir,
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    return this.browser;
  }

  async createContext(
    screen?: Screen
  ): Promise<{ context: BrowserContext; page: Page }> {
    if (!this.browser) throw new Error("Browser not launched");
    const context = await this.browser.createBrowserContext();
    const page = await context.newPage();
    if (screen) {
      await page.setViewport({ width: screen.width, height: screen.height });
    }
    return { context, page };
  }

  async closeContext(context: BrowserContext): Promise<void> {
    await context.close();
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}
```

(Keep `resolveChromiumPath`'s real import path as it currently is in the file.)

- [ ] **Step 4: Run to verify pass**

Run: `cd testomniac_runner && bun test src/browser/chromium.test.ts && bun run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd testomniac_runner
git add src/browser/chromium.ts src/browser/chromium.test.ts
git commit -m "feat(browser): shared browser with isolated per-run contexts"
```

---

### Task 2: Make the orchestrator accept an injected page instead of launching a browser

**Files:**
- Modify: `testomniac_runner/src/orchestrator.ts` — `runFullScan` (47-160) and `runSequenceScan` (170-247)
- Test: covered via Task 3 wiring + localhost; orchestrator has no standalone unit test today.

**Interfaces:**
- Produces: `runFullScan(options: RunOptions & { page: Page }): Promise<void>` and `runSequenceScan(options: SequenceRunOptions & { page: Page }): Promise<void>` — they no longer construct `ChromiumManager` or call `launch()`/`close()`. They build the `PuppeteerAdapter` from the injected `page`, run, then `await page.close()` (the caller closes the context).

- [ ] **Step 1: Remove browser lifecycle from `runFullScan`**

Delete these lines from `runFullScan`:

```typescript
  const chromium = new ChromiumManager(config);
  await chromium.launch();
```
and
```typescript
    const page = await chromium.newPage(defaultScreen);
```
and the `finally { await chromium.close(); }` wrapper.

Replace with using the injected page:

```typescript
export async function runFullScan(
  options: RunOptions & { page: Page }
): Promise<void> {
  const config = loadConfig();
  const api = getApiClient(config.apiUrl, config.scannerApiKey);
  const { scanUrl, baseUrl, userEmail, page } = options;
  // ... unchanged setup ...
  const adapter = new PuppeteerAdapter(page);
  // ... unchanged: eventHandler, expertises, runTestRun(adapter, {...}, api, expertises, eventHandler) ...
  // email report block unchanged
  try {
    await page.close();
  } catch (err) {
    logger.debug({ err }, "page already closed during scan cleanup");
  }
  logger.info({ scanId, sizeClass, totalDurationMs: elapsed(runStart) }, "run complete");
}
```

No `try/finally` browser close — the caller owns the context.

- [ ] **Step 2: Same change for `runSequenceScan`** — drop the `ChromiumManager` construction/`launch()`/`close()`, take `page` from options, build adapter from it, `await page.close()` at the end.

- [ ] **Step 3: Typecheck (expected to fail at call sites — fixed in Task 3)**

Run: `cd testomniac_runner && bun run typecheck`
Expected: FAIL at `runner-manager.ts` call sites (no `page` provided) — that is wired in Task 3. Do not commit yet.

- [ ] **Step 4: (commit deferred to Task 3 — these changes are not independently green)**

---

### Task 3: `RunnerManager` owns one browser; each run gets a context

**Files:**
- Modify: `testomniac_runner/src/runner-manager.ts` (11-161)
- Modify: `testomniac_runner/src/index.ts` (server bootstrap / shutdown — wire browser launch + close)
- Test: `testomniac_runner/src/runner-manager.test.ts` (new, pure-logic with mocked manager)

**Interfaces:**
- Consumes: `ChromiumManager` (Task 1), `runFullScan({ ..., page })` (Task 2).
- Produces: `RunnerManager` constructed with a `ChromiumManager`; `start()` launches the browser once; `runClaimedRun` acquires a context per run and releases it in `finally`; `shutdown()` closes the browser.

- [ ] **Step 1: Write the failing test** (a context is created per run and always released)

Create `src/runner-manager.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { RunnerManager } from "./runner-manager";

describe("RunnerManager context lifecycle", () => {
  it("acquires and releases a context for each claimed run, even on failure", async () => {
    const context = {};
    const page = {};
    const chromium = {
      launch: vi.fn().mockResolvedValue({}),
      createContext: vi.fn().mockResolvedValue({ context, page }),
      closeContext: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const mgr = new RunnerManager(1000, 2, chromium as any);
    // runClaimedRun is private; expose a test seam or test via a thin wrapper.
    await (mgr as any).withRunContext(async (p: unknown) => {
      expect(p).toBe(page);
      throw new Error("boom");
    }).catch(() => {});
    expect(chromium.createContext).toHaveBeenCalledTimes(1);
    expect(chromium.closeContext).toHaveBeenCalledWith(context);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd testomniac_runner && bun test src/runner-manager.test.ts`
Expected: FAIL — constructor arity / `withRunContext` not defined.

- [ ] **Step 3: Implement**

Update `RunnerManager`:

```typescript
  constructor(
    private readonly pollIntervalMs: number,
    private readonly maxConcurrentRunners: number,
    private readonly chromium: ChromiumManager
  ) {}

  async start(): Promise<void> {
    await this.chromium.launch();
  }

  async shutdown(): Promise<void> {
    this.stopAllRuns();
    await this.chromium.close();
  }

  /** Acquire an isolated context, run `fn(page)`, always release the context. */
  async withRunContext<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    const { context, page } = await this.chromium.createContext();
    try {
      return await fn(page);
    } finally {
      await this.chromium.closeContext(context);
    }
  }
```

In `runClaimedRun`, wrap the `runFullScan` call:

```typescript
      await this.withRunContext(page =>
        runFullScan({
          page,
          runnerId: params.runnerId,
          scanId: params.runId,
          scanUrl: params.scanUrl,
          baseUrl: params.scanUrl,
          sizeClass: params.sizeClass,
          runnerName: params.runnerName,
          runnerInstanceId: params.runnerInstanceId,
          runnerInstanceName: params.runnerInstanceName,
          quickScan: params.quickScan,
          scanMode: params.scanMode,
          signal: params.signal,
        })
      );
```

In `src/index.ts`, construct `ChromiumManager`, pass it to `new RunnerManager(pollIntervalMs, maxConcurrentRunners, chromium)`, `await manager.start()` before polling, and call `await manager.shutdown()` on SIGTERM/SIGINT.

- [ ] **Step 4: Run to verify pass + full verify**

Run: `cd testomniac_runner && bun test src/runner-manager.test.ts && bun run typecheck && bun run build`
Expected: PASS, typecheck + build clean (Task 2 call sites now satisfied).

- [ ] **Step 5: Verify on localhost** — point the runner at `localhost:8027`, enqueue two test runs, confirm in logs that `puppeteer.launch` (the injected launcher) fires **once** and each run logs context create/close. Confirm cookies/storage do not leak across the two runs (isolated contexts).

- [ ] **Step 6: Commit**

```bash
cd testomniac_runner
git add src/orchestrator.ts src/runner-manager.ts src/index.ts src/runner-manager.test.ts
git commit -m "feat(runner): reuse one browser, isolate each run in its own context"
```

---

### Task 4: Per-slot user data dirs (REC #10) — document as resolved by context isolation

**Decision:** With one shared browser and an isolated `BrowserContext` per run (Task 1-3), concurrent runs no longer share writable profile state — `createBrowserContext()` gives each run its own cookies/cache/storage. The original `userDataDir` contention (multiple browser processes writing one profile dir) **no longer occurs**, so per-slot `userDataDir/slot-N` is unnecessary.

**Files:**
- Modify: `testomniac_runner/src/config/index.ts` (comment only) — document the decision so a future reader doesn't re-add per-process profiles.

- [ ] **Step 1: Add a clarifying comment at the `userDataDir` config line**

```typescript
    // Single browser per worker; each run uses an isolated BrowserContext
    // (own cookies/cache/storage), so this dir is shared safely. Do NOT shard
    // per-run — context isolation already prevents cross-run profile contention.
    userDataDir: process.env.USER_DATA_DIR || "./testomniac-browser-profile",
```

- [ ] **Step 2: Commit**

```bash
cd testomniac_runner
git add src/config/index.ts
git commit -m "docs(config): note context isolation supersedes per-slot user data dirs"
```

> **Escape hatch (only if a future requirement forces separate browser *processes* per slot):** shard with `userDataDir: \`${base}/slot-${slotNumber}\`` at launch and run N `ChromiumManager`s. Not needed under the Task 1-3 design.

---

## Self-Review

- **Spec coverage:** #9 (reuse Chromium) → Tasks 1-3; #10 (profile isolation) → resolved by context isolation, documented in Task 4. ✅
- **Placeholder scan:** Full code in Tasks 1, 3, 4; Task 2 is concrete deletions/edits with the resulting signature shown. The one cross-task dependency (Task 2 not independently green) is called out explicitly with the commit deferred to Task 3. ✅
- **Type consistency:** `createContext`/`closeContext`/`withRunContext`/`{ page }` option shape consistent across Tasks 1-3. ✅
