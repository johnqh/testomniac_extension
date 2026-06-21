# Plan B — runner_service: Capture Dedup, Snapshot Tiering, Loop-from-`next`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Target repo:** `testomniac_runner_service` (`@sudobility/testomniac_runner_service`). Consumed by `testomniac_runner` and `testomniac_extension` as a published npm package.

**Goal:** Cut redundant browser work per interaction (one screenshot instead of two; skip intermediate snapshots when no expectation needs them; add a batched page-read seam), and — as a separate, higher-risk phase — drive the scan loop from the now-authoritative `/scan/next` `next` field.

**Architecture:** Tasks 1-3 are independent, low/medium-risk, and ship immediately. Task 4 (loop-from-`next`) depends on Plan A being published AND on scan-mode/`sizeClass` filtering also moving server-side; it is fenced off as Phase 2 with explicit prerequisites.

**Tech Stack:** TypeScript, Vitest, `tsc` build. Pure-function-heavy; browser work behind the `BrowserAdapter` interface.

## Global Constraints

- Package manager: **Bun only**.
- Publish/dependency order (push_all): `testomniac_types` → `testomniac_runner_service` → `testomniac_runner`/`testomniac_extension`.
- Test runner: **Vitest** (`vitest run`). Test naming: existing tests use `describe("<functionName>", …)` — match that (the `describe("scanner service: …")` convention is a `testomniac_runner` CI concern, not this repo).
- Verify gate: `bun run verify` = `typecheck && lint && test && build`.
- `executeTestInteraction` currently returns `Promise<void>` (test-interaction-executor.ts:206). Task 4 changes that signature — anything depending on it (the `runTestRun` loop) updates in the same task.
- Do not re-add local source aliases; the extension picks this up only after a published version bump.

---

### Task 1: Deduplicate screenshot capture (REC #5)

Today `executeTestInteraction` captures a PNG twice for the same frame: once for page-state upload (`test-interaction-executor.ts:~856`) and once inside `emitLiveScreenshot` for the live side panel (`:1050-1068`). Capture once, reuse the bytes.

**Files:**
- Modify: `testomniac_runner_service/src/orchestrator/test-interaction-executor.ts`
- Test: `testomniac_runner_service/src/orchestrator/test-interaction-executor.test.ts`

**Interfaces:**
- Produces: `emitLiveScreenshot(adapter, events, pageUrl, preCaptured?: Uint8Array): Promise<void>` — when `preCaptured` is supplied, it skips `adapter.screenshot()` and reuses those bytes.

- [ ] **Step 1: Write the failing test** — verify a single capture feeds both consumers.

Add to `test-interaction-executor.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { emitLiveScreenshot } from "./test-interaction-executor";

describe("emitLiveScreenshot", () => {
  it("reuses pre-captured bytes instead of calling adapter.screenshot", async () => {
    const screenshot = vi.fn();
    const adapter = { screenshot, url: () => "http://x" } as any;
    const events = { onScreenshotCaptured: vi.fn() } as any;
    const bytes = new Uint8Array([1, 2, 3]);

    await emitLiveScreenshot(adapter, events, "http://x", bytes);

    expect(screenshot).not.toHaveBeenCalled();
    expect(events.onScreenshotCaptured).toHaveBeenCalledWith(
      expect.objectContaining({ pageUrl: "http://x" })
    );
  });

  it("captures itself when no bytes are provided", async () => {
    const bytes = new Uint8Array([4, 5, 6]);
    const screenshot = vi.fn().mockResolvedValue(bytes);
    const adapter = { screenshot, url: () => "http://x" } as any;
    const events = { onScreenshotCaptured: vi.fn() } as any;

    await emitLiveScreenshot(adapter, events, "http://x");

    expect(screenshot).toHaveBeenCalledTimes(1);
  });
});
```

(If `emitLiveScreenshot` is not currently exported, export it in this step.)

- [ ] **Step 2: Run to verify fail**

Run: `cd testomniac_runner_service && bun test src/orchestrator/test-interaction-executor.test.ts -t emitLiveScreenshot`
Expected: FAIL — `emitLiveScreenshot` not exported / does not accept 4th arg.

- [ ] **Step 3: Implement**

Change `emitLiveScreenshot` (lines 1050-1068) to accept optional bytes:

```typescript
export async function emitLiveScreenshot(
  adapter: BrowserAdapter,
  events: ScanEventHandler,
  pageUrl: string,
  preCaptured?: Uint8Array
): Promise<void> {
  try {
    const bytes = preCaptured ?? (await adapter.screenshot({ type: "png" }));
    const base64 = uint8ArrayToBase64(bytes);
    events.onScreenshotCaptured({
      dataUrl: `data:image/png;base64,${base64}`,
      pageUrl,
    });
  } catch (err) {
    logExecutor("live-screenshot:failed", {
      pageUrl: adapter.url(),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
```

Then at the page-state capture site (~line 856), capture once and thread the bytes to the live emit. Replace the standalone `const screenshotBytes = await adapter.screenshot({ type: "png" });` so the same `screenshotBytes` is reused: find the `emitLiveScreenshot(adapter, events, ...)` call (invoked around line 565 per the executor flow) and pass the already-captured `screenshotBytes`. Where the upload path is skipped (non-discovery mode) `screenshotBytes` is undefined and `emitLiveScreenshot` falls back to capturing — preserving current behavior.

Concretely, hoist the capture above both uses:

```typescript
    // Capture the live/upload screenshot exactly once for this frame.
    let screenshotBytes: Uint8Array | undefined;
    try {
      screenshotBytes = await adapter.screenshot({ type: "png" });
    } catch {
      screenshotBytes = undefined;
    }
```

Use `screenshotBytes` for `api.uploadScreenshot(...)` (replacing the second capture in the upload block) and pass it as the 4th arg wherever `emitLiveScreenshot` is called.

- [ ] **Step 4: Run to verify pass**

Run: `cd testomniac_runner_service && bun test src/orchestrator/test-interaction-executor.test.ts -t emitLiveScreenshot && bun run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd testomniac_runner_service
git add src/orchestrator/test-interaction-executor.ts src/orchestrator/test-interaction-executor.test.ts
git commit -m "perf(executor): capture interaction screenshot once and reuse bytes"
```

---

### Task 2: Tier snapshot capture by expectation need (REC #4)

`captureExecutionSnapshot` runs `content()` + `captureUiSnapshot()` + `captureControlStates()` for every step's before/after (lines 396, 428, 470), unconditionally. When a step carries no step-level expectations, those per-step snapshots are never read (expectations are evaluated from final snapshots — see `buildExpectationEvaluationGroups`). Skip them when no step has expectations. Final snapshots (533-536) are always kept.

**Files:**
- Modify: `testomniac_runner_service/src/orchestrator/test-interaction-executor.ts`
- Test: `test-interaction-executor.test.ts`

**Interfaces:**
- Produces: `interactionNeedsStepSnapshots(steps: { expectations?: unknown[] }[]): boolean` — `true` iff any step has ≥1 expectation. Pure, exported, unit-tested.

- [ ] **Step 1: Write the failing test**

```typescript
import { interactionNeedsStepSnapshots } from "./test-interaction-executor";

describe("interactionNeedsStepSnapshots", () => {
  it("is false when no step has expectations", () => {
    expect(interactionNeedsStepSnapshots([{ expectations: [] }, {}])).toBe(false);
  });
  it("is true when any step has an expectation", () => {
    expect(
      interactionNeedsStepSnapshots([{ expectations: [] }, { expectations: [{ x: 1 }] }])
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd testomniac_runner_service && bun test src/orchestrator/test-interaction-executor.test.ts -t interactionNeedsStepSnapshots`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement the predicate + gate the per-step captures**

Add the predicate:

```typescript
export function interactionNeedsStepSnapshots(
  steps: Array<{ expectations?: unknown[] }>
): boolean {
  return steps.some(s => Array.isArray(s.expectations) && s.expectations.length > 0);
}
```

In the step-execution loop, compute once before the loop:

```typescript
    const needsStepSnapshots = interactionNeedsStepSnapshots(steps);
```

Then make the per-step `captureExecutionSnapshot` calls (success path ~428 and error path ~470) conditional. Keep `initialSnapshot` cheap by reusing it as the placeholder when snapshots are skipped:

```typescript
        const afterSnapshot = needsStepSnapshots
          ? await captureExecutionSnapshot(adapter)
          : previousSnapshot; // reuse; not read when there are no step expectations
        previousSnapshot = afterSnapshot;
```

Apply the same guard to the error-path `captureExecutionSnapshotSafe` call (skip when `!needsStepSnapshots`, reuse `beforeSnapshot`). The final UI/control capture (533-536) stays unconditional.

- [ ] **Step 4: Run to verify pass + full suite (guards regressions in expectation grouping)**

Run: `cd testomniac_runner_service && bun test src/orchestrator/test-interaction-executor.test.ts && bun run typecheck`
Expected: PASS — including the existing `buildExpectationEvaluationGroups` test.

- [ ] **Step 5: Commit**

```bash
cd testomniac_runner_service
git add src/orchestrator/test-interaction-executor.ts src/orchestrator/test-interaction-executor.test.ts
git commit -m "perf(executor): skip per-step snapshots when no step has expectations"
```

> **Note:** This is intentionally conservative (gate on *step expectations*, not on `testType`). It captures the common navigation/render win (those interactions rarely carry step expectations) without risking expectation evaluation for interactions that do.

---

### Task 3: Add an optional batched page-read seam to `BrowserAdapter` (REC #6, interface side)

The 7 sequential reads after each interaction (`content()` + `detectScaffoldRegions` + `detectPatternsWithInstances` + `extractActionableItems` + `extractForms` + `captureUiSnapshot` + `captureControlStates`, executor ~line 365-385) each cross the adapter boundary. Add an **optional** `capturePageSnapshot()` method to the interface so adapters that can do one round trip (e.g. ChromeAdapter, Plan D) may; adapters that don't implement it fall back to the existing per-call path. No behavior change in this repo until an adapter implements it.

**Files:**
- Modify: `testomniac_runner_service/src/adapter.ts` (the `BrowserAdapter` interface source)
- Modify: `testomniac_runner_service/src/orchestrator/test-interaction-executor.ts` (use the seam when present)
- Test: `test-interaction-executor.test.ts`

**Interfaces:**
- Produces on `BrowserAdapter`:
  ```typescript
  capturePageSnapshot?(): Promise<{ html: string; bodyTextLength: number }>;
  ```
  Minimal first cut: `html` (replaces `content()`) + `bodyTextLength`. Extracting scaffolds/forms/etc. from a serialized snapshot is a later increment — this task only establishes the seam and routes `html` through it.
- Produces helper: `readPageHtml(adapter): Promise<string>` — uses `capturePageSnapshot().html` when available, else `adapter.content()`.

- [ ] **Step 1: Write the failing test**

```typescript
import { readPageHtml } from "./test-interaction-executor";

describe("readPageHtml", () => {
  it("uses capturePageSnapshot when the adapter implements it", async () => {
    const adapter = {
      capturePageSnapshot: async () => ({ html: "<batched>", bodyTextLength: 5 }),
      content: async () => "<fallback>",
    } as any;
    expect(await readPageHtml(adapter)).toBe("<batched>");
  });
  it("falls back to content() when capturePageSnapshot is absent", async () => {
    const adapter = { content: async () => "<fallback>" } as any;
    expect(await readPageHtml(adapter)).toBe("<fallback>");
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd testomniac_runner_service && bun test src/orchestrator/test-interaction-executor.test.ts -t readPageHtml`
Expected: FAIL — `readPageHtml` not exported.

- [ ] **Step 3: Implement interface + helper, route the decomposition `content()` through it**

In `src/adapter.ts`, add to the `BrowserAdapter` interface (near the other optional methods):

```typescript
  /**
   * Optional single-round-trip page read. Adapters where injection round
   * trips dominate (e.g. Chrome extension) may batch html + body text in one
   * call. Omit it and the executor falls back to content().
   */
  capturePageSnapshot?(): Promise<{ html: string; bodyTextLength: number }>;
```

In `test-interaction-executor.ts`:

```typescript
export async function readPageHtml(adapter: BrowserAdapter): Promise<string> {
  if (adapter.capturePageSnapshot) {
    const snap = await adapter.capturePageSnapshot();
    return snap.html;
  }
  return adapter.content();
}
```

At the decomposition read (~line 365, `const html = normalizeHtml(await adapter.content());`), replace `adapter.content()` with `readPageHtml(adapter)`:

```typescript
    const html = normalizeHtml(await readPageHtml(adapter));
```

- [ ] **Step 4: Run to verify pass**

Run: `cd testomniac_runner_service && bun test src/orchestrator/test-interaction-executor.test.ts -t readPageHtml && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd testomniac_runner_service
git add src/adapter.ts src/orchestrator/test-interaction-executor.ts src/orchestrator/test-interaction-executor.test.ts
git commit -m "feat(adapter): optional capturePageSnapshot seam for batched page reads"
```

> **Publish gate:** Plan D (extension `capturePageSnapshot` implementation) depends on this interface addition being published.

---

### Task 4 (PHASE 2 — higher risk): Drive the loop from `next` (REC #1)

**Do not start until:** Plan A is published AND scan-mode/`sizeClass` filtering also moves server-side (see prerequisites). This task is fenced off because it changes scan scheduling end-to-end.

**Prerequisites (must land first):**
1. Plan A published: `/scan/next` returns an authoritative `next` with `dependencyChain`.
2. **Scan-mode parity gap:** the runner loop currently skips interactions for `minimum`/`partial` scan modes (`runner.ts` batch-cancel block, ~lines using `isHoverInteraction` + `hasNavigationInteractionForSameElement`). The server's `selectNextInteraction` does NOT. Before the runner can stop fetching the full interaction set, this filtering must move into Plan A's scheduler — which also requires adding `scanMode` to `ScanNextRequest` (a `testomniac_types` change) and threading it from `executeTestInteraction`'s `scanNext` call.
3. A dedicated brainstorm/review on (2) — it is a behavior change to which interactions get skipped.

**Files (once prerequisites met):**
- Modify: `testomniac_runner_service/src/orchestrator/test-interaction-executor.ts` — `executeTestInteraction` returns `ScanNextResponse` instead of `void`; use `next.dependencyChain` for replay rather than `cachedTestInteractions`.
- Modify: `testomniac_runner_service/src/orchestrator/runner.ts` — restructure the `while (true)` loop (lines 367-638) to consume `next`.
- Test: `runner.test.ts`, `test-interaction-executor.test.ts`.

**Interfaces:**
- `executeTestInteraction(...): Promise<ScanNextResponse>` — returns the full `/scan/next` result so the loop reads `result.next`.

- [ ] **Step 1: Change `executeTestInteraction` to return the scan result**

Change the signature (line 206) from `Promise<void>` to `Promise<ScanNextResponse>` and `return scanResult;` after the `scanNext` call (~line 902). Update the existing `Promise.race` call site in `runner.ts` (currently discards the result) to capture it.

- [ ] **Step 2: Replace dependency replay source with `next.dependencyChain`**

In `executeTestInteraction`, the dependency chain currently comes from `buildDependencyChain(testInteraction, testInteractionById)` built from `cachedTestInteractions`. When the interaction is delivered via `next` (Phase 2), pass `next.dependencyChain` straight through: `setupCases = dependencyChain.slice(0, -1)`, `journeySteps = dependencyChain.flatMap(i => parseStoredSteps(i.stepsJson))`. Add a parameter `prefetchedChain?: TestInteractionResponse[]` and prefer it over rebuilding from `testInteractionById`.

- [ ] **Step 3: Restructure the loop to drive from `next`**

Replace the per-iteration `getRunnerState` / `getTestSurfacesByRunner` / `getTestInteractionsByRunner` + `selectNextInteractionAcrossBundle` block with: execute the current interaction, read `result.next`; if `next` is non-null, execute it next using `next.interactionRunId`, `next.surfaceRunId`, `next.testInteraction`, `next.dependencyChain`; loop until `next === null`. Keep a single initial `getRunnerState` to seed the first interaction (or add a `/scan/begin` call that returns the first `next`). Delete the now-dead scan-mode batch-cancel block (moved server-side per prerequisite 2).

- [ ] **Step 4: Tests** — update `runner.test.ts` to assert the loop calls `executeTestInteraction` once per `next` and stops when `next` is null; assert no per-iteration `getRunnerState` calls after seeding. Add an executor test that `prefetchedChain` is used verbatim when supplied.

- [ ] **Step 5: Verify on localhost end-to-end** before committing — run a real scan against `localhost:8027` + the dev extension and confirm interaction counts/ordering match a pre-change baseline scan of the same URL.

- [ ] **Step 6: Commit** once parity is confirmed.

> **Recommendation:** Ship Tasks 1-3 first (they stand alone and are low-risk). Treat Task 4 as a separate follow-up project gated on its prerequisites and a dedicated review — it is the highest-value but highest-risk item.

---

## Self-Review

- **Spec coverage:** #5 → Task 1; #4 → Task 2; #6 (interface) → Task 3; #1 → Task 4 (fenced, with prerequisites). ✅
- **Placeholder scan:** Tasks 1-3 contain full code. Task 4 is deliberately step-level (not code-complete) because its code depends on unpublished Plan A + an unresolved scan-mode design decision — flagged explicitly rather than faked. ✅
- **Type consistency:** `emitLiveScreenshot` 4-arg signature, `interactionNeedsStepSnapshots`, `readPageHtml`, `capturePageSnapshot?` shape consistent across tasks and with Plan A's `dependencyChain`. ✅
