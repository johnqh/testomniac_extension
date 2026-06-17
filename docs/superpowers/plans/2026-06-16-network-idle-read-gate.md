# Network-Idle Read Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace fixed-duration page-settle waits with a shared `waitForNetworkIdle` primitive so the scanner reads page HTML 10ms after the network goes quiet, on both the Chrome extension and the Puppeteer server runtime.

**Architecture:** A pure `NetworkIdleTracker` + `waitForNetworkIdle` loop lives in `testomniac_runner_service` and is the single source of truth for the idle algorithm. A new optional `waitForNetworkIdle?()` method is added to the `BrowserAdapter` interface. `ChromeAdapter` and `PuppeteerAdapter` each feed their native request-lifecycle events into a tracker instance and delegate. The shared executor calls the adapter method as the "page is ready to read" gate before every `content()` read and after clicks, replacing the 1s background settle and the `clickWaitMs` delay.

**Tech Stack:** TypeScript, Bun, Vitest (runner_service), `bun test` (runner), Puppeteer (`puppeteer-core`), Chrome MV3 CDP (`chrome.debugger`).

## Global Constraints

- Idle window: **10ms** of zero non-persistent in-flight requests.
- Dispatch-race floor: **50ms** minimum before idle may be declared.
- Stale cutoff: ignore a request still open after **5000ms**.
- Hard cap: stop waiting and read anyway after **10000ms**.
- Poll interval: **10ms**.
- Persistent resource types excluded from the busy count (case-insensitive): `websocket`, `eventsource`.
- All `@sudobility/*` deps resolve from **published npm** — no local source aliases, `file:` refs, or symlinks. Consumer repos pick up runner_service changes only after a publish + `bun install`.
- `clickWaitMs` / `setClickWaitMs` is **deprecated**, not repurposed. Stop reading it; leave the plumbing for a later cleanup. Do not migrate UI/storage.
- The new `waitForNetworkIdle?` interface method is **optional** so consumers compile before they call it.

---

### Task 1: `NetworkIdleTracker` + `waitForNetworkIdle` loop (runner_service)

**Files:**
- Create: `/Users/johnhuang/projects/testomniac_runner_service/src/browser/network-idle.ts`
- Test: `/Users/johnhuang/projects/testomniac_runner_service/src/browser/network-idle.test.ts`
- Modify: `/Users/johnhuang/projects/testomniac_runner_service/src/index.ts`

**Interfaces:**
- Produces:
  - `class NetworkIdleTracker` with `start(requestId: string, resourceType: string): void`, `end(requestId: string): void`, `clear(): void`, `activeCount(now: number, staleMs: number): number`, and constructor `(now?: () => number)`.
  - `function waitForNetworkIdle(tracker: NetworkIdleTracker, options?: NetworkIdleOptions, deps?: NetworkIdleDeps): Promise<void>`
  - `interface NetworkIdleOptions { idleMs?: number; floorMs?: number; staleMs?: number; timeout?: number; pollMs?: number }`
  - `interface NetworkIdleDeps { now?: () => number; sleep?: (ms: number) => Promise<void>; onTimeout?: () => void }`
  - `const NETWORK_IDLE_DEFAULTS: Required<NetworkIdleOptions>` = `{ idleMs: 10, floorMs: 50, staleMs: 5000, timeout: 10000, pollMs: 10 }`

- [ ] **Step 1: Write the failing test**

Create `/Users/johnhuang/projects/testomniac_runner_service/src/browser/network-idle.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  NetworkIdleTracker,
  waitForNetworkIdle,
  NETWORK_IDLE_DEFAULTS,
} from "./network-idle";

describe("NetworkIdleTracker.activeCount", () => {
  it("counts normal in-flight requests", () => {
    const t = new NetworkIdleTracker(() => 1000);
    t.start("a", "document");
    t.start("b", "xhr");
    expect(t.activeCount(1000, 5000)).toBe(2);
    t.end("a");
    expect(t.activeCount(1000, 5000)).toBe(1);
  });

  it("ignores persistent types (websocket, eventsource) case-insensitively", () => {
    const t = new NetworkIdleTracker(() => 1000);
    t.start("ws", "WebSocket");
    t.start("sse", "eventsource");
    t.start("x", "fetch");
    expect(t.activeCount(1000, 5000)).toBe(1);
  });

  it("ignores requests older than staleMs", () => {
    const t = new NetworkIdleTracker(() => 1000);
    t.start("old", "xhr"); // started at 1000
    expect(t.activeCount(5999, 5000)).toBe(1); // 4999ms old -> still counts
    expect(t.activeCount(6000, 5000)).toBe(0); // 5000ms old -> stale
  });

  it("clear() empties the map", () => {
    const t = new NetworkIdleTracker(() => 1000);
    t.start("a", "xhr");
    t.clear();
    expect(t.activeCount(1000, 5000)).toBe(0);
  });
});

// Deterministic virtual clock: sleep() advances time and fires any actions
// scheduled at-or-before the new time, so requests can open/close mid-wait.
function makeClock() {
  let t = 0;
  const scheduled: Array<{ at: number; fn: () => void; done: boolean }> = [];
  const drain = () => {
    for (const e of scheduled) {
      if (!e.done && e.at <= t) {
        e.done = true;
        e.fn();
      }
    }
  };
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
      drain();
    },
    at: (when: number, fn: () => void) =>
      scheduled.push({ at: when, fn, done: false }),
  };
}

describe("waitForNetworkIdle", () => {
  it("returns at ~floorMs when no requests ever open", async () => {
    const clock = makeClock();
    const tracker = new NetworkIdleTracker(clock.now);
    await waitForNetworkIdle(tracker, {}, { now: clock.now, sleep: clock.sleep });
    // floorMs=50 dominates; first poll boundary at or after 50ms
    expect(clock.now()).toBeGreaterThanOrEqual(NETWORK_IDLE_DEFAULTS.floorMs);
    expect(clock.now()).toBeLessThan(NETWORK_IDLE_DEFAULTS.timeout);
  });

  it("waits until ~idleMs after the last request closes", async () => {
    const clock = makeClock();
    const tracker = new NetworkIdleTracker(clock.now);
    tracker.start("a", "xhr"); // open at t=0
    clock.at(200, () => tracker.end("a")); // closes at t=200
    await waitForNetworkIdle(tracker, {}, { now: clock.now, sleep: clock.sleep });
    // Must not return before the request closed at 200
    expect(clock.now()).toBeGreaterThanOrEqual(200);
    // Returns shortly after (within a couple poll intervals + idle window)
    expect(clock.now()).toBeLessThan(
      200 + NETWORK_IDLE_DEFAULTS.idleMs + 3 * NETWORK_IDLE_DEFAULTS.pollMs
    );
  });

  it("never returns before floorMs even if idle immediately", async () => {
    const clock = makeClock();
    const tracker = new NetworkIdleTracker(clock.now);
    // No requests -> idle from t=0, but floor must hold.
    await waitForNetworkIdle(
      tracker,
      { floorMs: 100 },
      { now: clock.now, sleep: clock.sleep }
    );
    expect(clock.now()).toBeGreaterThanOrEqual(100);
  });

  it("gives up at timeout when the network never goes idle", async () => {
    const clock = makeClock();
    const tracker = new NetworkIdleTracker(clock.now);
    tracker.start("hang", "fetch"); // opens and never closes
    let timedOut = false;
    await waitForNetworkIdle(
      tracker,
      { staleMs: 1_000_000 }, // disable stale so only the cap can end it
      { now: clock.now, sleep: clock.sleep, onTimeout: () => (timedOut = true) }
    );
    expect(timedOut).toBe(true);
    expect(clock.now()).toBeGreaterThanOrEqual(NETWORK_IDLE_DEFAULTS.timeout);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/johnhuang/projects/testomniac_runner_service && bun run test src/browser/network-idle.test.ts`
Expected: FAIL — `Cannot find module './network-idle'` / exports undefined.

- [ ] **Step 3: Write minimal implementation**

Create `/Users/johnhuang/projects/testomniac_runner_service/src/browser/network-idle.ts`:

```ts
/**
 * Shared "wait until the network is quiet" primitive used by every
 * BrowserAdapter. Adapters feed their native request-lifecycle events into a
 * NetworkIdleTracker; the scanner calls waitForNetworkIdle() before reading
 * page HTML so late-arriving XHR/JS content is captured.
 */

export interface NetworkIdleOptions {
  /** Quiet window: required ms of zero busy requests before resolving. */
  idleMs?: number;
  /** Minimum ms before idle may be declared (absorbs click->request race). */
  floorMs?: number;
  /** A request still open after this many ms stops counting (hung/long-poll). */
  staleMs?: number;
  /** Hard cap: resolve anyway after this many ms. */
  timeout?: number;
  /** Poll cadence. */
  pollMs?: number;
}

export interface NetworkIdleDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Invoked when the hard cap is hit before idle was reached. */
  onTimeout?: () => void;
}

export const NETWORK_IDLE_DEFAULTS: Required<NetworkIdleOptions> = {
  idleMs: 10,
  floorMs: 50,
  staleMs: 5000,
  timeout: 10000,
  pollMs: 10,
};

/** Resource types that hold a connection open indefinitely by design. */
const PERSISTENT_TYPES = new Set(["websocket", "eventsource"]);

export class NetworkIdleTracker {
  private inflight = new Map<string, { type: string; startTs: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  start(requestId: string, resourceType: string): void {
    this.inflight.set(requestId, {
      type: (resourceType || "other").toLowerCase(),
      startTs: this.now(),
    });
  }

  end(requestId: string): void {
    this.inflight.delete(requestId);
  }

  clear(): void {
    this.inflight.clear();
  }

  /** In-flight requests that should gate idle: not persistent, not stale. */
  activeCount(now: number, staleMs: number): number {
    let count = 0;
    for (const { type, startTs } of this.inflight.values()) {
      if (PERSISTENT_TYPES.has(type)) continue;
      if (now - startTs >= staleMs) continue;
      count++;
    }
    return count;
  }
}

export async function waitForNetworkIdle(
  tracker: NetworkIdleTracker,
  options: NetworkIdleOptions = {},
  deps: NetworkIdleDeps = {}
): Promise<void> {
  const { idleMs, floorMs, staleMs, timeout, pollMs } = {
    ...NETWORK_IDLE_DEFAULTS,
    ...options,
  };
  const now = deps.now ?? (() => Date.now());
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const startedAt = now();
  let lastBusyAt = startedAt;

  for (;;) {
    const t = now();
    const elapsed = t - startedAt;
    const active = tracker.activeCount(t, staleMs);
    if (active > 0) lastBusyAt = t;

    if (elapsed >= timeout) {
      deps.onTimeout?.();
      return;
    }
    if (elapsed >= floorMs && active === 0 && t - lastBusyAt >= idleMs) {
      return;
    }
    await sleep(pollMs);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/johnhuang/projects/testomniac_runner_service && bun run test src/browser/network-idle.test.ts`
Expected: PASS — all cases green.

- [ ] **Step 5: Export from package index**

Modify `/Users/johnhuang/projects/testomniac_runner_service/src/index.ts` — add near the other `./browser/*` exports (e.g. after the `buildDomSnapshot` export on line 45):

```ts
export {
  NetworkIdleTracker,
  waitForNetworkIdle,
  NETWORK_IDLE_DEFAULTS,
  type NetworkIdleOptions,
  type NetworkIdleDeps,
} from "./browser/network-idle";
```

- [ ] **Step 6: Typecheck**

Run: `cd /Users/johnhuang/projects/testomniac_runner_service && bun run typecheck`
Expected: PASS — no errors.

- [ ] **Step 7: Commit**

```bash
cd /Users/johnhuang/projects/testomniac_runner_service
git add src/browser/network-idle.ts src/browser/network-idle.test.ts src/index.ts
git commit -m "feat: add NetworkIdleTracker + waitForNetworkIdle primitive

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Adapter interface method + executor read-gate (runner_service)

**Files:**
- Modify: `/Users/johnhuang/projects/testomniac_runner_service/src/adapter.ts` (add optional method)
- Create: `/Users/johnhuang/projects/testomniac_runner_service/src/orchestrator/settle-for-read.ts`
- Test: `/Users/johnhuang/projects/testomniac_runner_service/src/orchestrator/settle-for-read.test.ts`
- Modify: `/Users/johnhuang/projects/testomniac_runner_service/src/orchestrator/test-interaction-executor.ts` (call gate at read/click sites; drop clickWaitMs delay)

**Interfaces:**
- Consumes: `BrowserAdapter` (from Task 0 baseline), nothing from Task 1 directly (the adapter implements `waitForNetworkIdle`).
- Produces: `function settleForRead(adapter: Pick<BrowserAdapter, "waitForNetworkIdle">): Promise<void>` — calls `adapter.waitForNetworkIdle?.()` with default options; no-ops if the adapter doesn't implement it.

- [ ] **Step 1: Add the optional interface method**

Modify `/Users/johnhuang/projects/testomniac_runner_service/src/adapter.ts` — add inside the `BrowserAdapter` interface, just before the closing brace (after `getCurrentTabId?(): number;` on line 101):

```ts
  /**
   * Resolve once the network has been quiet (no non-persistent in-flight
   * requests) for the idle window, or once the hard cap elapses. Optional:
   * adapters that cannot observe network activity simply omit it.
   */
  waitForNetworkIdle?(opts?: {
    idleMs?: number;
    floorMs?: number;
    staleMs?: number;
    timeout?: number;
    pollMs?: number;
  }): Promise<void>;
```

- [ ] **Step 2: Write the failing test for settleForRead**

Create `/Users/johnhuang/projects/testomniac_runner_service/src/orchestrator/settle-for-read.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { settleForRead } from "./settle-for-read";

describe("settleForRead", () => {
  it("calls waitForNetworkIdle when the adapter implements it", async () => {
    const waitForNetworkIdle = vi.fn().mockResolvedValue(undefined);
    await settleForRead({ waitForNetworkIdle });
    expect(waitForNetworkIdle).toHaveBeenCalledTimes(1);
  });

  it("no-ops when the adapter does not implement it", async () => {
    await expect(settleForRead({})).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /Users/johnhuang/projects/testomniac_runner_service && bun run test src/orchestrator/settle-for-read.test.ts`
Expected: FAIL — `Cannot find module './settle-for-read'`.

- [ ] **Step 4: Write minimal implementation**

Create `/Users/johnhuang/projects/testomniac_runner_service/src/orchestrator/settle-for-read.ts`:

```ts
import type { BrowserAdapter } from "../adapter";

/**
 * Single read-gate: wait for the page network to settle before the scanner
 * reads HTML / decomposes the page. Uses adapter defaults (10ms idle window,
 * 50ms floor, 5s stale cutoff, 10s cap). No-ops for adapters that cannot
 * observe network activity.
 */
export async function settleForRead(
  adapter: Pick<BrowserAdapter, "waitForNetworkIdle">
): Promise<void> {
  await adapter.waitForNetworkIdle?.();
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Users/johnhuang/projects/testomniac_runner_service && bun run test src/orchestrator/settle-for-read.test.ts`
Expected: PASS.

- [ ] **Step 6: Wire the gate before the decompose read**

Modify `/Users/johnhuang/projects/testomniac_runner_service/src/orchestrator/test-interaction-executor.ts`.

First add the import near the top with the other local imports:

```ts
import { settleForRead } from "./settle-for-read";
```

Then at the decompose site (currently line 513-515):

```ts
    // Decompose the page using local detectors
    currentPhase = "decomposing-page";
    const html = normalizeHtml(await adapter.content());
```

change to:

```ts
    // Decompose the page using local detectors
    currentPhase = "decomposing-page";
    await settleForRead(adapter);
    const html = normalizeHtml(await adapter.content());
```

- [ ] **Step 7: Wire the gate before the snapshot read**

In the same file, at `captureExecutionSnapshot` (currently line 1508):

```ts
async function captureExecutionSnapshot(
  adapter: BrowserAdapter
): Promise<ExecutionSnapshot> {
  const html = normalizeHtml(await adapter.content());
```

change to:

```ts
async function captureExecutionSnapshot(
  adapter: BrowserAdapter
): Promise<ExecutionSnapshot> {
  await settleForRead(adapter);
  const html = normalizeHtml(await adapter.content());
```

- [ ] **Step 8: Replace the post-click fixed delay with the idle gate**

In the same file, the `click` case (currently lines 1451-1454):

```ts
        await adapter.click(action.path);
        if (_clickWaitMs > 0)
          await new Promise(r => setTimeout(r, _clickWaitMs));
        await adapter.waitForNavigation({ timeout: 5000 });
```

change to:

```ts
        await adapter.click(action.path);
        await settleForRead(adapter);
        await adapter.waitForNavigation({ timeout: 5000 });
```

And the `dblclick` case (currently lines 1459-1462):

```ts
        await adapter.click(action.path);
        if (_clickWaitMs > 0)
          await new Promise(r => setTimeout(r, _clickWaitMs));
        await adapter.waitForNavigation({ timeout: 5000 });
```

change to:

```ts
        await adapter.click(action.path);
        await settleForRead(adapter);
        await adapter.waitForNavigation({ timeout: 5000 });
```

Note: `waitForNavigation({ timeout: 5000 })` is kept for URL bookkeeping; it returns immediately if no navigation is pending. Leave the `_clickWaitMs` variable and `setClickWaitMs` export in place (deprecated) — they are now unused by the click path. Do not delete them in this task.

- [ ] **Step 9: Relax the executor's explicit `networkidle0` navigation waits**

The executor passes `waitUntil: "networkidle0"` explicitly at four sites, which would otherwise override the relaxed PuppeteerAdapter default (Task 4) and re-impose Puppeteer's 500ms idle floor on the server — defeating the 10ms gate. Replace each with `"load"` so `settleForRead` is the single idle authority. (On the extension these args are already ignored by `ChromeAdapter.goto`, so only the server runtime changes.)

In `/Users/johnhuang/projects/testomniac_runner_service/src/orchestrator/test-interaction-executor.ts`, change:

- Line ~320: `await adapter.goto(absoluteUrl, { waitUntil: "networkidle0" });` → `await adapter.goto(absoluteUrl, { waitUntil: "load" });`
- Line ~1413: `await adapter.goto(url, { waitUntil: "networkidle0" });` → `await adapter.goto(url, { waitUntil: "load" });`
- Line ~1417: `await adapter.goto(await adapter.getUrl(), { waitUntil: "networkidle0" });` → `await adapter.goto(await adapter.getUrl(), { waitUntil: "load" });`
- Line ~1428: inside the `waitForNavigation({ ... })` call, `waitUntil: "networkidle0",` → `waitUntil: "load",`

Verify there are no remaining `networkidle0` literals in this file afterward:

Run: `grep -n networkidle0 /Users/johnhuang/projects/testomniac_runner_service/src/orchestrator/test-interaction-executor.ts`
Expected: no output.

- [ ] **Step 10: Run the full runner_service test + typecheck**

Run: `cd /Users/johnhuang/projects/testomniac_runner_service && bun run test && bun run typecheck`
Expected: PASS — existing suite green (the unused `_clickWaitMs` will warn only if lint flags unused; if `bun run lint` fails on it, add `// eslint-disable-next-line @typescript-eslint/no-unused-vars` above the `let _clickWaitMs = 500;` declaration on line 35).

- [ ] **Step 11: Commit**

```bash
cd /Users/johnhuang/projects/testomniac_runner_service
git add src/adapter.ts src/orchestrator/settle-for-read.ts src/orchestrator/settle-for-read.test.ts src/orchestrator/test-interaction-executor.ts
git commit -m "feat: gate page reads on network idle in shared executor

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Publish runner_service + bump consumers

**Files:**
- Modify (automated by script): version fields and `@sudobility/testomniac_runner_service` ranges across repos.

This task has no code test; its deliverable is that `testomniac_runner` and `testomniac_extension` resolve the new published `runner_service` so Tasks 4-5 can import `NetworkIdleTracker`.

- [ ] **Step 1: Verify runner_service is clean and on main**

Run: `cd /Users/johnhuang/projects/testomniac_runner_service && git status --short && git branch --show-current`
Expected: no uncommitted changes, branch `main`.

- [ ] **Step 2: Publish + propagate versions**

Run: `cd /Users/johnhuang/projects/testomniac_app && ./scripts/push_all.sh`
Expected: formats, validates (typecheck/lint/test/build), version-bumps, commits, pushes all repos in dependency order, and updates `@sudobility/testomniac_runner_service` to the new version in `testomniac_runner` and `testomniac_extension`.

(If `push_all.sh` is unavailable in this environment, fall back to: publish `testomniac_runner_service` to npm, then in each consumer run `bun add @sudobility/testomniac_runner_service@latest`.)

- [ ] **Step 3: Confirm consumers see the new version**

Run: `grep testomniac_runner_service /Users/johnhuang/projects/testomniac_runner/package.json /Users/johnhuang/projects/testomniac_extension/package.json`
Expected: both reference the newly published version (greater than `0.1.142`).

- [ ] **Step 4: Clear stale Vite pre-bundle in the extension**

Run: `rm -rf /Users/johnhuang/projects/testomniac_extension/node_modules/.vite`
Expected: no output (per CLAUDE.md, forces Vite to re-bundle the upgraded dep).

---

### Task 4: PuppeteerAdapter wiring (testomniac_runner)

**Files:**
- Modify: `/Users/johnhuang/projects/testomniac_runner/src/adapters/PuppeteerAdapter.ts`
- Test: `/Users/johnhuang/projects/testomniac_runner/src/adapters/PuppeteerAdapter.networkidle.test.ts`

**Interfaces:**
- Consumes: `NetworkIdleTracker`, `waitForNetworkIdle` from `@sudobility/testomniac_runner_service` (Task 1).
- Produces: `PuppeteerAdapter.waitForNetworkIdle(opts?)` satisfying the `BrowserAdapter` optional method.

This is an **integration** test: it launches real Chromium via `ChromiumManager`, so it needs a Chromium binary resolvable by `loadConfig()` and a `SCANNER_API_KEY` env var set (required by `loadConfig`). Run it with the runner's normal env (the same prerequisites as the existing scanner-service tests). If the environment lacks Chromium, this test errors at setup rather than asserting — that still counts as "not passing" for the red step.

- [ ] **Step 1: Write the failing integration test**

Create `/Users/johnhuang/projects/testomniac_runner/src/adapters/PuppeteerAdapter.networkidle.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createServer, type Server } from "node:http";
import puppeteer, { type Browser } from "puppeteer-core";
import { PuppeteerAdapter } from "./PuppeteerAdapter";
import { ChromiumManager } from "../browser/chromium";
import { loadConfig } from "../config";

let server: Server;
let baseUrl: string;
let browser: Browser;

beforeAll(async () => {
  // Fixture page: fires a delayed XHR 150ms after load that injects text.
  server = createServer((req, res) => {
    if (req.url === "/late.json") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }, 150);
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><html><body><div id="late"></div>
      <script>
        fetch('/late.json').then(r => r.json()).then(() => {
          document.getElementById('late').textContent = 'LOADED';
        });
      </script></body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  const config = loadConfig();
  browser = await new ChromiumManager(config).launch();
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((r) => server.close(() => r()));
});

describe("PuppeteerAdapter.waitForNetworkIdle", () => {
  it("waits for the late XHR so the injected content is present", async () => {
    const page = await browser.newPage();
    const adapter = new PuppeteerAdapter(page);
    await adapter.goto(`${baseUrl}/`, { waitUntil: "load" });
    await adapter.waitForNetworkIdle?.();
    const html = await adapter.content();
    expect(html).toContain("LOADED");
    await page.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/johnhuang/projects/testomniac_runner && bun test src/adapters/PuppeteerAdapter.networkidle.test.ts`
Expected: FAIL — `adapter.waitForNetworkIdle` is `undefined`, so the read can race the XHR and `LOADED` is missing (or method-not-a-function).

- [ ] **Step 3: Wire the tracker into PuppeteerAdapter**

Modify `/Users/johnhuang/projects/testomniac_runner/src/adapters/PuppeteerAdapter.ts`.

Add the import at the top of the file (with the other imports):

```ts
import {
  NetworkIdleTracker,
  waitForNetworkIdle,
} from "@sudobility/testomniac_runner_service";
```

Add a field and event wiring in the constructor (replacing lines 20-22):

```ts
  private readonly idleTracker = new NetworkIdleTracker();

  constructor(page: Page) {
    this.page = page;
    this.bindNetworkIdleTracking(page);
  }

  private bindNetworkIdleTracking(page: Page): void {
    page.on("request", (req) => {
      this.idleTracker.start(req.url() + "\0" + req.resourceType(), req.resourceType());
    });
    const done = (req: { url: () => string; resourceType: () => string }) =>
      this.idleTracker.end(req.url() + "\0" + req.resourceType());
    page.on("requestfinished", done);
    page.on("requestfailed", done);
  }
```

(Note: Puppeteer `HTTPRequest` has no stable id across events, so the request URL + resourceType is used as the tracking key. Collisions only cause a marginally early `end`, which is harmless.)

Add the adapter method anywhere in the class body (e.g. after `goto`):

```ts
  async waitForNetworkIdle(opts?: {
    idleMs?: number;
    floorMs?: number;
    staleMs?: number;
    timeout?: number;
    pollMs?: number;
  }): Promise<void> {
    await waitForNetworkIdle(this.idleTracker, opts);
  }
```

- [ ] **Step 4: Relax goto / waitForNavigation default waitUntil**

In the same file, `goto` (line 155) — change the default from `networkidle0` to `load`:

```ts
      waitUntil: (options?.waitUntil as any) || "load",
```

And `waitForNavigation` (line 213) — change the default likewise:

```ts
        waitUntil: (options?.waitUntil as any) || "load",
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Users/johnhuang/projects/testomniac_runner && bun test src/adapters/PuppeteerAdapter.networkidle.test.ts`
Expected: PASS — `html` contains `LOADED`.

- [ ] **Step 6: Typecheck**

Run: `cd /Users/johnhuang/projects/testomniac_runner && bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /Users/johnhuang/projects/testomniac_runner
git add src/adapters/PuppeteerAdapter.ts src/adapters/PuppeteerAdapter.networkidle.test.ts
git commit -m "feat: implement waitForNetworkIdle in PuppeteerAdapter; relax nav to load

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: ChromeAdapter wiring (testomniac_extension)

**Files:**
- Modify: `/Users/johnhuang/projects/testomniac_extension/src/adapters/ChromeAdapter.ts`

**Interfaces:**
- Consumes: `NetworkIdleTracker`, `waitForNetworkIdle` from `@sudobility/testomniac_runner_service` (Task 1).
- Produces: `ChromeAdapter.waitForNetworkIdle(opts?)`.

There is no test runner in `testomniac_extension` (no `test` script in package.json), so this task is verified by typecheck + manual scan. Keep edits minimal and mechanical.

- [ ] **Step 1: Import the primitive**

Add to the existing import block at the top of `/Users/johnhuang/projects/testomniac_extension/src/adapters/ChromeAdapter.ts` (it already imports from `@sudobility/testomniac_runner_service` — add to that import or a new one):

```ts
import {
  NetworkIdleTracker,
  waitForNetworkIdle,
} from "@sudobility/testomniac_runner_service";
```

- [ ] **Step 2: Add the tracker field and extend requestMetadata entries**

Change the field declaration (line 21) from:

```ts
  private requestMetadata = new Map<string, { method: string; url: string }>();
```

to:

```ts
  private requestMetadata = new Map<
    string,
    { method: string; url: string; type: string; startTs: number }
  >();
  private readonly idleTracker = new NetworkIdleTracker();
```

- [ ] **Step 3: Feed request-start events into the tracker**

In the `Network.requestWillBeSent` branch (line 974), widen the payload type and record start + type. Replace the block (lines 974-993):

```ts
      if (method === 'Network.requestWillBeSent') {
        const payload = params as {
          requestId?: string;
          request?: {
            method?: string;
            url?: string;
          };
        };
        if (payload.requestId && payload.request) {
          // Evict oldest entries if metadata map is too large
          if (this.requestMetadata.size >= ChromeAdapter.MAX_REQUEST_METADATA) {
            const firstKey = this.requestMetadata.keys().next().value;
            if (firstKey) this.requestMetadata.delete(firstKey);
          }
          this.requestMetadata.set(payload.requestId, {
            method: payload.request.method || 'GET',
            url: payload.request.url || '',
          });
        }
        return;
      }
```

with:

```ts
      if (method === 'Network.requestWillBeSent') {
        const payload = params as {
          requestId?: string;
          type?: string;
          request?: {
            method?: string;
            url?: string;
          };
        };
        if (payload.requestId && payload.request) {
          // Evict oldest entries if metadata map is too large
          if (this.requestMetadata.size >= ChromeAdapter.MAX_REQUEST_METADATA) {
            const firstKey = this.requestMetadata.keys().next().value;
            if (firstKey) this.requestMetadata.delete(firstKey);
          }
          const resourceType = payload.type || 'Other';
          this.requestMetadata.set(payload.requestId, {
            method: payload.request.method || 'GET',
            url: payload.request.url || '',
            type: resourceType,
            startTs: Date.now(),
          });
          this.idleTracker.start(payload.requestId, resourceType);
        }
        return;
      }
```

- [ ] **Step 4: Feed request-end events into the tracker**

In the `Network.loadingFailed`/`Network.loadingFinished` branch (lines 1029-1037), replace:

```ts
      if (
        method === 'Network.loadingFailed' ||
        method === 'Network.loadingFinished'
      ) {
        const payload = params as { requestId?: string };
        if (payload.requestId) {
          this.requestMetadata.delete(payload.requestId);
        }
      }
```

with:

```ts
      if (
        method === 'Network.loadingFailed' ||
        method === 'Network.loadingFinished'
      ) {
        const payload = params as { requestId?: string };
        if (payload.requestId) {
          this.requestMetadata.delete(payload.requestId);
          this.idleTracker.end(payload.requestId);
        }
      }
```

- [ ] **Step 5: Clear the tracker wherever requestMetadata is cleared**

There are two clear sites (lines 770 and 796) that call `this.requestMetadata.clear();`. Add `this.idleTracker.clear();` immediately after each:

```ts
    this.requestMetadata.clear();
    this.idleTracker.clear();
```

(Apply at both occurrences. Use the surrounding context to disambiguate; both are inside reset/cleanup methods.)

- [ ] **Step 6: Add the adapter method**

Add a method to the `ChromeAdapter` class (e.g. just after `waitForNavigation`, around line 558):

```ts
  async waitForNetworkIdle(opts?: {
    idleMs?: number;
    floorMs?: number;
    staleMs?: number;
    timeout?: number;
    pollMs?: number;
  }): Promise<void> {
    await waitForNetworkIdle(this.idleTracker, opts);
  }
```

- [ ] **Step 7: Typecheck**

Run: `cd /Users/johnhuang/projects/testomniac_extension && bun run type-check`
Expected: PASS — no errors.

- [ ] **Step 8: Commit**

```bash
cd /Users/johnhuang/projects/testomniac_extension
git add src/adapters/ChromeAdapter.ts
git commit -m "feat: implement waitForNetworkIdle in ChromeAdapter

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Remove the fixed background settle (testomniac_extension)

**Files:**
- Modify: `/Users/johnhuang/projects/testomniac_extension/src/background/index.ts`

**Interfaces:**
- Consumes: `ChromeAdapter.waitForNetworkIdle` (Task 5) — but the gate is invoked inside the shared executor (Task 2), so this task only removes the now-redundant fixed waits.

- [ ] **Step 1: Remove the 1s "settle" after navigation**

In `/Users/johnhuang/projects/testomniac_extension/src/background/index.ts`, delete the two lines at 701-702:

```ts
    LOG('Waiting 1s for page to settle...');
    await new Promise(r => setTimeout(r, 1000));
```

Replace them with a single log line so the surrounding flow/log narrative stays intact:

```ts
    LOG('Navigation complete — network-idle gate will settle reads');
```

- [ ] **Step 2: Stop pushing clickWaitMs into the executor**

`clickWaitMs` is deprecated (the executor no longer uses it after Task 2). Leave the stored config and UI field intact, but remove the now-pointless calls to `setClickWaitMs` so the dead value isn't propagated. Delete the `setClickWaitMs` call at line 546:

```ts
  setClickWaitMs(clickWaitMs);
```

and at line 1368:

```ts
    setClickWaitMs(clickWaitMs);
```

Then remove `setClickWaitMs` from the `@sudobility/testomniac_runner_service` import in this file (it is no longer referenced). If `clickWaitMs` the variable becomes unused after this, leave it — it is still loaded/saved for the SAVE_CONFIG round-trip; only the setter calls are removed.

- [ ] **Step 3: Typecheck**

Run: `cd /Users/johnhuang/projects/testomniac_extension && bun run type-check`
Expected: PASS. (If lint flags an unused import or variable, remove only the specifically-flagged unused symbol — do not touch `clickWaitMs` storage/SAVE_CONFIG handling.)

- [ ] **Step 4: Commit**

```bash
cd /Users/johnhuang/projects/testomniac_extension
git add src/background/index.ts
git commit -m "refactor: drop fixed 1s settle and clickWaitMs propagation (network-idle replaces them)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: End-to-end manual verification

**Files:** none (verification only).

- [ ] **Step 1: Build the extension**

Run: `cd /Users/johnhuang/projects/testomniac_extension && bun run build`
Expected: PASS — `dist/` produced with no errors.

- [ ] **Step 2: Reload the extension in Chrome**

Toggle the extension off/on in `chrome://extensions` (per CLAUDE.md, service workers cache stale JS).
Expected: extension reloads cleanly.

- [ ] **Step 3: Run a scan against a content-heavy page that loads data via XHR**

Open the side panel, pick a product/environment, and scan a URL whose main content arrives via XHR after initial HTML (e.g. a dashboard or a SPA route).
Expected: in the side panel event stream and captured HTML/screenshots, the page content (XHR-injected text) is present in the read — not a blank/skeleton state. The scan should feel snappier on fast pages (no flat 1s settle) and not truncate on slow ones.

- [ ] **Step 4: Verify a streaming page does not hang**

Scan a page with a persistent connection (SSE/websocket — e.g. a live feed).
Expected: the scan proceeds (does not stall waiting for the stream); reads occur within the 10s cap at worst.

- [ ] **Step 5: Confirm server runner parity (if a runner is available)**

Run a one-shot server scan: `cd /Users/johnhuang/projects/testomniac_runner && node dist/index.js --run-id=<id> --runner-id=<id> --base-url=<url> --size-class=desktop` (or via the polling worker).
Expected: same behavior — late XHR content captured; no networkidle0-induced 500ms floor.

---

## Notes for the implementer

- **Order matters:** Tasks 1-2 land in `runner_service` and must be published (Task 3) before Tasks 4-6 can import `NetworkIdleTracker`. Do not add a local source alias to work around this (CLAUDE.md).
- **Why a tracking-key for Puppeteer but requestId for CDP:** CDP gives a stable `requestId` across `requestWillBeSent`/`loadingFinished`; Puppeteer's request objects don't expose a comparable id across the `request`/`requestfinished` events, so URL+resourceType is used as a best-effort key.
- **The 10ms window is intentionally aggressive.** If field testing shows reads firing mid-render between request bursts, the only knob to raise is `idleMs` (passed via `settleForRead` → `waitForNetworkIdle` opts). The floor (50ms) and stale cutoff (5s) are already in place.
```
