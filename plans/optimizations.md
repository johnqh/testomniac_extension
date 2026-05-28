# Performance Optimization Opportunities

Cross-cutting analysis of `testomniac_runner_service`, `testomniac_extension`, `testomniac_runner`, and `testomniac_api`.

---

## Priority Matrix

| # | Area | Repo | Impact | Effort | Est. Savings |
|---|------|------|--------|--------|--------------|
| **0** | [**Fix concurrent scan guard (bug)**](#0-fix-concurrent-scan-guard-bug) | **extension** | **Critical** | **Low** | **Prevents orphaned scans** |
| 1 | [Parallelize page decomposition](#1-parallelize-page-decomposition-pipeline) | runner_service | Low | Low | 5-50ms both adapters (serialized execution contexts) |
| 2 | [Reduce POST /scan sequential queries](#2-reduce-post-apiscan-sequential-queries) | api | Critical | Medium | 500-1000ms/scan creation |
| 3 | [Parallelize test interaction generators](#3-parallelize-test-interaction-generators) | runner_service | Critical | Medium | 2-10s/discovery page |
| 4 | [Reduce live-dashboard query count](#4-reduce-live-dashboard-query-count) | api | Critical | Medium | 60-80% fewer queries |
| 5 | [Batch writes in test-interactions/batch](#5-batch-writes-in-test-interactionsbatch-loop) | api | Critical | High | O(N) -> O(1) DB calls (requires raw SQL or upsert) |
| 6 | [SSE stream polling efficiency](#6-sse-stream-polling-efficiency) | api | Critical | Low | 50-70% fewer queries |
| 7 | [Batch log persistence](#7-batch-log-persistence) | extension | High | Low | 50-100x fewer writes |
| 8 | [Cache materializeSelector results](#8-cache-materializeselector-results) | extension + runner | Medium | Medium | 10-25% fewer DOM evals (cache strategy, not marker; measure before committing) |
| 9 | [Debounce scanState persistence](#9-debounce-scanstate-persistence) | extension | High | Low | ~9x fewer writes |
| 10 | [Increase ApiClient cache TTL](#10-increase-apiclient-cache-ttl) | runner_service | High | Low | 100-300ms/iteration |
| 11 | [Cache normalized HTML](#11-cache-normalized-html) | runner_service | Medium | Low | 10-50ms/interaction (only 1-2 calls hit expensive path) |
| 12 | [Add missing database indexes](#12-add-missing-database-indexes) | api | Medium | Low | Eliminates full scans (measure write cost) |
| 13 | [Screenshot capture optimization](#13-screenshot-capture-optimization) | runner_service + extension | Medium | Medium | 200-800ms/interaction (requires product input on sampling) |
| 14 | [Browser pool in server runner](#14-browser-pool-in-server-runner) | runner | Medium | High | 2-3s/run startup |
| 15 | [Chromium launch flags](#15-chromium-launch-flags) | runner | Medium | Low | 20-40% less memory |
| 16 | [Adaptive polling backoff](#16-adaptive-polling-backoff) | runner + extension | Low | Low | 80% fewer idle calls |
| 17 | [Push pages-summary to DB](#17-push-pages-summary-aggregation-to-database) | api | Medium | Medium | Memory + latency |
| 18 | [Plugin parallelization](#18-plugin-parallelization) | runner | Medium | Medium | 30-50% faster plugins |
| 19 | [waitForSelector polling backoff](#19-waitforselector-polling-backoff) | extension | Low | Low | Fewer executeScript calls |
| 20 | [Remove dead code in dedup eviction](#20-remove-dead-code-in-dedup-eviction) | extension | Low | Low | Dead code removal |
| 21 | [test-surfaces/ensure-with-run parallelism](#21-test-surfacesensure-with-run-parallelism) | api | Low | Low | 3 queries parallelized |
| 22 | [test-run-findings/ensure-batch junction](#22-test-run-findingsensure-batch-junction-queries) | api | Low | Low | Batch junction queries |
| 23 | [Increase ChromeStorageDedupStore thresholds](#23-increase-chromestoragededupstore-thresholds) | extension | Low | Low | Fewer flushes (needs flush-on-shutdown first) |
| 24 | [test-interactions/reconcile pagination](#24-test-interactionsreconcile-pagination) | api | Low | Medium | Bounds unbounded queries |

---

## Implementation Order

Items are grouped into phases that account for cross-repo dependencies and risk.

### Phase 0: Bug fix (do first)
- **#0 Concurrent scan guard** -- Bug, not optimization. Ship independently.

### Phase 1: Extension-only (no API changes, no cross-repo coordination)
- **#7 Batch log persistence**
- **#9 Debounce scanState persistence**
- **#20 Remove dead code in dedup eviction**

### Phase 2: API database prep (deploy before query optimizations)
- **#12 Add missing indexes** -- Must land before #4 and #6 so the new query patterns hit indexes, not sequential scans. Use `CREATE INDEX CONCURRENTLY` to avoid locking during active scans. Run `EXPLAIN ANALYZE` on production first; measure insert-side regression on high-write tables.

### Phase 3: API query optimizations (deploy after indexes)
- **#6 SSE stream polling** -- Low effort, high impact.
- **#4 Live-dashboard query consolidation**
- **#2 POST /scan parallelism**
- **#5 Batch writes** -- Higher effort (raw SQL needed); can follow independently.
- **#17 Pages-summary aggregation**

### Phase 4: runner_service changes (shared library, requires coordinated release with extension + runner)
- **#10 Cache TTL increase** -- Low risk, ship first.
- **#11 Cache normalized HTML**
- **#3 Parallelize generators** -- Safe to parallelize (generators treat context as read-only). Remove per-generator `invalidateSurfacesCache()` calls; do one invalidation after `Promise.all`.
- **#1 Parallelize page decomposition** -- Both adapters serialize execution; savings are marginal (5-50ms). Low priority unless measurement proves otherwise.

### Phase 5: Extension adapter + runner adapter (independent per repo)
- **#8 Cache materializeSelector**
- **#13 Screenshot optimization**
- **#15 Chromium launch flags**
- **#14 Browser pool**
- **#16 Adaptive polling backoff**
- **#18 Plugin parallelization**

### Phase 6: Lower priority / quick wins (independent, any order)
- **#19 waitForSelector polling backoff**
- **#21 test-surfaces/ensure-with-run parallelism**
- **#22 test-run-findings/ensure-batch junction**
- **#23 Increase ChromeStorageDedupStore thresholds** (requires flush-on-shutdown from Phase 1)
- **#24 test-interactions/reconcile pagination**

### Cross-repo coordination notes
- Items #1, #3, #10, #11 change `testomniac_runner_service`, which is aliased via `vite.config.ts` in the extension and imported as a package in the runner. Both consumers must be tested after changes.
- Items #2, #4, #5, #6, #12, #17, #21, #22, #24 are API-only. Deploy independently; no client changes needed.
- Items #7, #8, #9, #19, #20, #23 are extension-only. No coordination needed.
- Items #14, #15, #18 are runner-only. No coordination needed.

---

## Measurement Plan

Before starting any optimization, capture baselines. After each item, re-measure and compare.

| Metric | How to measure | Applies to | Acceptance threshold |
|--------|---------------|------------|---------------------|
| Per-interaction time | Add timer around `executeTestInteraction()` in runner_service, log p50/p95 | #1, #8, #11, #13 | p50 < 1.5s, p95 < 3s |
| Scan creation latency | Time the POST /scan handler end-to-end (API response time) | #2 | < 700ms |
| Discovery page analysis time | Timer around `PageAnalyzer.generateTestInteractions()` | #3 | p50 < 3s, p95 < 6s |
| Dashboard endpoint latency | API response time for `/runs/:id/live-dashboard` | #4, #12 | < 200ms |
| Batch endpoint latency | API response time for `test-interactions/batch` with N items | #5, #12 | < 500ms for N=50 |
| SSE query load | `pg_stat_statements` query count for SSE-related queries over 1 minute | #6, #12 | < 600/min at 100 clients |
| chrome.storage write count | Counter in `persistLog()` and `persistScanState()` over one full scan | #7, #9 | < 100 writes/scan |
| Selector resolution time | Timer around `materializeSelector()`, log hit/miss/validation-fail rates | #8 | Strategy cache hit rate > 20% for replay selectors; validation cost < 5ms |
| Browser startup time | Timer from `puppeteer.launch()` to first `page.goto()` | #14, #15 | < 1s warm, < 3s cold |
| Index write regression | Measure insert throughput on indexed tables before/after #12 | #12 | < 10% insert latency increase |

---

## Bug Fix (Do First)

### 0. Fix concurrent scan guard (bug)

**Repo:** `testomniac_extension`
**File:** `src/background/index.ts` (~line 1129)

If two `START_SCAN` messages arrive in quick succession, both call `startScan()` via fire-and-forget (`void startScan(...)`). The second call overwrites `activeRunPromise`, orphaning the first scan -- it continues running but can no longer be paused, resumed, or stopped. This is a correctness bug, not just a performance issue.

**Fix:** Add a synchronous latch that is set **before** any async work. The current `scanState.isRunning` is set too late (inside `runScanSession()` after `dedupStore.clear()` awaits), so checking it alone leaves a race window between `START_SCAN` receipt and the first await in `startScan()`.

```typescript
let scanStarting = false; // synchronous latch

if (message.type === 'START_SCAN' && message.url && message.runId) {
  if (scanStarting || scanState.isRunning || activeRunPromise) {
    sendResponse({ ok: false, error: 'Scan already running' });
    return true;
  }
  scanStarting = true; // set synchronously, before any await
  void startScan(...).finally(() => { scanStarting = false; });
  sendResponse({ ok: true });
}
```

---

## Critical Priority

### 1. Parallelize page decomposition pipeline

**Repo:** `testomniac_runner_service`
**File:** `src/orchestrator/test-interaction-executor.ts` (~lines 455-464)

After an interaction executes, 7 independent operations run **sequentially**:

```typescript
const html = normalizeHtml(await adapter.content());
const scaffolds = await detectScaffoldRegions(adapter);
const patterns = await detectPatternsWithInstances(adapter);
const items = await extractActionableItems(adapter);
const forms = await extractForms(adapter);
const finalUiSnapshot = await captureUiSnapshot(adapter);
const finalControlStates = await captureControlStates(adapter);
```

**Fix:** `Promise.all` the six calls after `adapter.content()`:

```typescript
const html = normalizeHtml(await adapter.content());
const [scaffolds, patterns, items, forms, finalUiSnapshot, finalControlStates] =
  await Promise.all([
    detectScaffoldRegions(adapter),
    detectPatternsWithInstances(adapter),
    extractActionableItems(adapter),
    extractForms(adapter),
    captureUiSnapshot(adapter),
    captureControlStates(adapter),
  ]);
```

**Why savings are marginal (5-50ms):** Both adapters serialize JS execution through a single page context:
- **ChromeAdapter** serializes `chrome.scripting.executeScript` calls through a single tab. `Promise.all` queues all six calls but the browser executes them one at a time.
- **PuppeteerAdapter** serializes `page.evaluate()` calls internally through Puppeteer's protocol queue.

The only savings come from reduced JS-to-native scheduling overhead between calls. These are all synchronous DOM evaluations -- no async work (timers, network) that could benefit from concurrent scheduling.

**Priority: Low.** Still worth doing (low effort, cleaner code), but do not expect measurable wall-clock improvement. Only revisit if measurement shows any of these functions contain async work internally.

---

### 2. Reduce POST /api/scan sequential queries

**Repo:** `testomniac_api` (API-only change, no client coordination needed)
**File:** `src/routes/scan.ts` (~lines 159-623)

Scan creation performs **19 sequential database operations**. Many have FK dependencies that prevent naive parallelism: runner ID is needed before surfaces/bundles, bundle run ID before surface run, surface run ID before interaction run, etc. (See `scan.ts` lines 309, 341, 459, 522.)

**Fix:** Respect the dependency chain, but parallelize within each tier and use upserts to collapse find-then-create pairs:

```
Tier 1 (independent lookup):
  - resolveEnvironment

Tier 2 (depends on environment):
  - findOrCreateRunner (upsert)

Tier 3 (depends on runner -- can parallelize these two):
  - findOrCreateSurface (upsert)         ─┐
  - findOrCreateBundle (upsert)          ─┘ parallel

Tier 4 (depends on surface):
  - findOrCreateInteraction (upsert)
  - findOrCreateAction (upsert)

Tier 5 (depends on bundle + surface):
  - linkSurfaceToBundle (idempotent)

Tier 6 (depends on bundle):
  - insert bundleRun

Tier 7 (depends on bundleRun + surface):
  - insert surfaceRun

Tier 8 (depends on surfaceRun + interaction):
  - insert interactionRun

Tier 9 (depends on interactionRun + bundleRun -- can parallelize):
  - insert testRun                       ─┐
  - insert credentials (if provided)     ─┘ parallel
```

This reduces from 19 sequential queries to 9 tiers (with parallelism within tiers 3 and 9). Each upsert collapses a find + conditional create into a single DB call.

**Expected:** ~1-2s down to ~400-700ms (2-3x improvement). The previous estimate of 200-400ms was overconfident -- the dependency chain limits how much can be parallelized.

**Scope note:** API-only change. The extension and runner call POST /scan and receive the same response shape -- no client changes needed.

---

### 3. Parallelize test interaction generators

**Repo:** `testomniac_runner_service`
**File:** `src/analyzer/page-analyzer/index.ts` (~lines 613-637)

After page analysis, 11 generator functions run sequentially. Each makes multiple API calls internally:

```typescript
await generateRenderTestInteractions(this, ctx);
await generateFormTestInteractions(this, ctx);
await generateLoginTestInteractions(this, ctx);
await generateSemanticJourneyTestInteractions(this, ctx);
await generateE2ETestInteractions(this, ctx);
await generateDialogLifecycleTestInteractions(this, ctx);
await generateScaffoldTestInteractions(this, ctx);
await generateContentTestInteractions(this, ctx);
await generateKeyboardAndDisclosureTestInteractions(this, ctx);
await generateVariantTestInteractions(this, ctx);
await generateNavigationTestInteractions(this, ctx);
```

**Fix:** Wrap in `Promise.all`. Note: `generateHoverFollowUpCases` runs earlier and must stay sequential (it mutates state used by these generators).

**Mutable state risk is low:** Code inspection confirms that generators receive a shared `AnalyzerContext` but treat it as **read-only** in practice. Each generator creates its own surfaces and interactions via API calls -- they don't write to each other's output. The PageAnalyzer dedup sets (`generatedPaths`, `generatedSelectors`, etc.) are populated by the earlier `generateHoverFollowUpCases` call, and the 11 generators listed above only read from them.

The main concern is `invalidateSurfacesCache()`, which is called between generators in the current sequential flow. When parallelized, these per-generator cache invalidations become no-ops (each generator fetches fresh data anyway). **Remove per-generator `invalidateSurfacesCache()` calls and do a single invalidation after `Promise.all` completes.**

**Validation requirement:** Before shipping, run both sequential and parallel paths on the same page and diff the outputs (surfaces created, interactions generated). Any discrepancy indicates hidden ordering dependencies that need to be resolved before parallelizing.

```typescript
await Promise.all([
  generateRenderTestInteractions(this, ctx),
  generateFormTestInteractions(this, ctx),
  generateLoginTestInteractions(this, ctx),
  generateSemanticJourneyTestInteractions(this, ctx),
  generateE2ETestInteractions(this, ctx),
  generateDialogLifecycleTestInteractions(this, ctx),
  generateScaffoldTestInteractions(this, ctx),
  generateContentTestInteractions(this, ctx),
  generateKeyboardAndDisclosureTestInteractions(this, ctx),
  generateVariantTestInteractions(this, ctx),
  generateNavigationTestInteractions(this, ctx),
]);
this.api.invalidateSurfacesCache();
```

---

### 4. Reduce live-dashboard query count

**Repo:** `testomniac_api`
**File:** `src/routes/runs-read.ts` (~line 1466)

The `/runs/:runId/live-dashboard` endpoint performs 6-8 sequential queries:

1. Get testRun by id
2. Get testRun again for rootRunId (redundant)
3. Get all related testRuns (children)
4. Get testSurfaceRuns by bundle IDs
5. Get testInteractionRuns by surface run IDs
6. Get testRunFindings (direct + legacy)
7. Get testRunFindingRuns junction
8. Then 3 parallel loads (pages summary, navigation, structure)

**Fix:**
- Eliminate query #2 (rootRunId is already on the result of query #1)
- Consolidate queries #1 + #3 into a single query: `WHERE id = ? OR rootTestRunId = ?`
- Consolidate queries #4 + #5 with a single JOIN
- Pre-compute findings summary with a DB aggregate instead of fetching all rows

---

### 5. Batch writes in test-interactions/batch loop

**Repo:** `testomniac_api`
**File:** `src/routes/scanner.ts` (~lines 1309-1607)

The batch endpoint correctly pre-fetches data (2 parallel queries), but then performs **per-item** `db.update()` or `db.insert()` inside the loop (N items = N queries). Interaction run creation adds another N queries.

**Fix:** Collect all updates and inserts, then execute as two bulk operations.

**Implementation note:** Drizzle ORM does not natively support multi-row updates with different values per row. The bulk insert is straightforward (`db.insert().values([...])`) but bulk updates require one of:

- **`INSERT ... ON CONFLICT DO UPDATE` (upsert):** If interactions have a natural key, this collapses find-or-create + update into a single statement per batch. Preferred if the schema supports it.
- **Raw SQL with `unnest()` arrays** (PostgreSQL-specific):
  ```sql
  UPDATE testomniac.test_interactions AS t
  SET title = v.title, steps_json = v.steps_json, ...
  FROM (SELECT unnest($1::int[]) AS id, unnest($2::text[]) AS title, unnest($3::jsonb[]) AS steps_json) AS v
  WHERE t.id = v.id;
  ```
- **CTE approach:** Build a VALUES CTE and JOIN against it
- **Parallel individual updates:** `Promise.all(toUpdate.map(u => db.update(...).where(...)))` -- simpler, still avoids sequential awaits even if not a single SQL statement

For interaction runs, use a single multi-row insert.

**Effort revised to High** due to raw SQL complexity for the update path.

---

### 6. SSE stream polling efficiency

**Repo:** `testomniac_api`
**File:** `src/routes/runs-read.ts` (~line 1206)

The SSE stream endpoint polls the database every 3 seconds per connected client. Each poll runs 3 queries (current run, latest scan state with JOIN, new findings with 3-way JOIN).

At 100 concurrent dashboards = 2,000 queries/minute.

**Fixes:**
- Increase polling interval to 5-10 seconds (dashboard also receives SCAN_PROGRESS messages from the extension directly)
- Replace `getLatestScanState()` full JOIN with a targeted indexed query
- Add composite index on the findings table for the SSE query (see #12 for the exact column choice — verify with `EXPLAIN ANALYZE` whether the SSE findings query joins through `test_interaction_run_id` or `test_surface_bundle_run_id`)

**Future consideration (not in scope):** PostgreSQL `LISTEN/NOTIFY` could replace polling entirely, but requires persistent DB connections (incompatible with connection pooling) and significant architectural changes. Defer unless polling optimizations above prove insufficient.

---

## High Priority

### 7. Batch log persistence (highest-impact extension fix)

**Repo:** `testomniac_extension`
**File:** `src/background/index.ts` (~lines 33-57)

`persistLog()` writes to `chrome.storage.local` on **every single log call** via `appendLog()`. Verified: 300-1000+ `persistLog()` calls per scan, each doing a full `chrome.storage.local.set()`. This is the single worst source of storage thrashing in the extension.

**Fix:** Flush log buffer on a timer (every 1-2s) or threshold (50 entries), matching the pattern already used by `ChromeStorageDedupStore`. Must also flush on service worker shutdown (see [Flush-on-shutdown pattern](#flush-on-shutdown-pattern) below).

---

### 8. Cache materializeSelector results

**Repos:** `testomniac_extension` (`ChromeAdapter.ts` ~lines 56-208) and `testomniac_runner` (`PuppeteerAdapter.ts` ~lines 24-148)

`materializeSelector()` is called before every interaction (click, hover, type, select, waitForSelector). Not every call is expensive -- the function has three fast-paths:
1. Non-replay selectors (no `tmnc-replay:` prefix) return immediately (~lines 57-59)
2. CSS-spec selectors try `querySelector` first (~lines 95-98)
3. ID selectors try `getElementById` (~lines 111-114)

The expensive `querySelectorAll(tagName || "*")` path only triggers when all fast lookups fail. Caching only helps for replay selectors that hit the slow path.

**Why naive caching doesn't work:** `materializeSelector()` injects a synthetic `[data-tmnc-replay-target]` marker into the live DOM and returns that marker as the resolved selector. Any interaction (hover, click, type, etc.) can mutate the DOM and invalidate the marker. If we clear the cache after every interaction, there are almost no cross-interaction cache hits — `materializeSelector()` is called at the *start* of each interaction method, so the only window for a hit is between consecutive calls with no intervening interaction, which rarely happens in this scanner.

**Fix:** Cache the *resolution strategy* — the stable CSS selector path discovered during the expensive `querySelectorAll` search — rather than the injected marker attribute. On cache hit, verify the element still exists via a lightweight `querySelector` check before returning it. This survives DOM mutations as long as the element itself wasn't removed.

```typescript
private selectorStrategyCache = new Map<string, string>(); // replay selector → CSS path
private currentTabId: number | null = null;

private async materializeSelector(selector: string): Promise<string> {
  if (!selector.startsWith(REPLAY_SELECTOR_PREFIX)) return selector;

  const cacheKey = `${this.currentTabId}:${selector}`;
  const cachedCssPath = this.selectorStrategyCache.get(cacheKey);
  if (cachedCssPath) {
    // Validate: does the element still exist at this path?
    const exists = await this.executeScript(
      (sel) => !!document.querySelector(sel),
      cachedCssPath
    );
    if (exists) return cachedCssPath;
    this.selectorStrategyCache.delete(cacheKey); // stale, fall through
  }

  const resolved = await this._doMaterialize(selector);

  // Extract the stable CSS path used during resolution (if available)
  // and cache it instead of the injected marker attribute
  const stablePath = this.lastResolvedCssPath; // set by _doMaterialize
  if (stablePath) {
    this.selectorStrategyCache.set(cacheKey, stablePath);
  }

  return resolved;
}

// Clear only on navigation and tab switch (element identity changes):
async goto(url) { this.selectorStrategyCache.clear(); ... }
async switchToTab(tabId) { this.currentTabId = tabId; this.selectorStrategyCache.clear(); ... }
// No clear needed after click/hover/type/select/pressKey — the
// querySelector validation check handles stale entries.
```

**Implementation note:** This requires `_doMaterialize()` to expose the CSS selector path it discovers during the `querySelectorAll` search (e.g., building a path like `div.container > button:nth-child(2)` from the matched element). If this is impractical, an alternative is to cache the element's `id`/`data-testid`/unique attribute found during resolution — any stable selector that doesn't depend on injected markers.

**Cache invalidation:** Only clear on `goto()` (new document) and `switchToTab()` (different document). The `querySelector` validation on cache hit handles DOM mutations without requiring aggressive clearing. This preserves cache hits across hover/click/type sequences.

**Note on waitForSelector:** In the current ChromeAdapter, `waitForSelector()` calls `materializeSelector()` once *before* the polling loop (`ChromeAdapter.ts` line 512), not on every 200ms iteration. The polling loop uses the already-resolved selector for its `executeScript` checks. So caching does not help within `waitForSelector` — the benefit is across separate method calls on the same replay selector.

**Revised estimate: 10-25% fewer DOM evaluations.** The strategy cache survives across interactions (unlike the marker cache), but the validation `querySelector` call adds a small cost per hit. Net savings depend on how many replay selectors hit the expensive `querySelectorAll` path and are reused across interactions. Measure hit/miss/validation-fail rates before committing to this approach.

---

### 9. Debounce scanState persistence

**Repo:** `testomniac_extension`
**File:** `src/background/index.ts` (~lines 296-437)

`sendProgressToSidePanel()` calls `persistScanState()` unconditionally on every invocation. It is called from 9+ code paths, but the highest-frequency caller during active scanning is `addEvent()` (~line 419), which fires on every scanner event. `onStatsUpdated()` (~line 670) is the second highest. Together these can produce dozens of `persistScanState()` calls per second during peak scanning.

**Fix:** Persist every Nth update (e.g., 10) or on a debounce timer:

```typescript
let statsSinceFlush = 0;
function sendProgressToSidePanel() {
  if (++statsSinceFlush >= 10) {
    statsSinceFlush = 0;
    void persistScanState();
  }
  chrome.runtime.sendMessage({ type: 'SCAN_PROGRESS', ... });
}
```

Always persist on phase transitions (scanning -> paused -> completed).

**Service worker termination risk:** Chrome can terminate the service worker between debounce intervals (30s idle, 5min hard limit). If terminated mid-debounce, the last few state updates are lost. Mitigations:
- Always flush on phase transitions (already noted above)
- Best-effort: side panel `beforeunload` → message → `flushAll()` (unreliable — browser may not deliver the message before the service worker handles it; treat as supplementary, not a guarantee)
- Accept that losing a few numeric counter updates (pagesFound, findingsCount) between flushes is tolerable -- the auto-resume mechanism re-derives state from the API on restart
- The keepalive alarm prevents termination during active scans, so this mainly affects the transition window after scan completion

**Note:** `chrome.runtime.onSuspend` is NOT available in MV3 service workers. Do not attempt to use it.

---

### 10. Increase ApiClient cache TTL

**Repo:** `testomniac_runner_service`
**File:** `src/api/client.ts` (~lines 85-94)

Both `getTestSurfacesByRunner` and `getTestInteractionsByRunner` caches use a 5-second TTL. In the main loop, if an iteration takes >5s (common during page analysis), the cache expires and causes redundant refetches.

**Fix:** Increase TTL to 15-30 seconds. The caches are already invalidated on mutation (e.g., after creating new surfaces/interactions), so staleness risk is low.

---

## Medium Priority

### 11. Cache normalized HTML

**Repo:** `testomniac_runner_service`
**Files:** `src/orchestrator/test-interaction-executor.ts`, `src/browser/page-utils.ts`

There are two different `normalizeHtml()` functions:
- **`page-utils.ts`**: The expensive one -- 7 sequential regex replacements on the full HTML string. Called during `computeHashes()` and for page state creation.
- **`test-interaction-executor.ts`**: A trivial type-guard wrapper that just ensures the value is a string. Zero cost.

The "called multiple times" claim is accurate, but only 1-2 of those calls hit the expensive `page-utils.ts` version. The rest are the trivial wrapper.

Additionally, `computeHashes()` calls the expensive `normalizeHtml()` AND `htmlToMarkdown()` (which also parses HTML). If `computeHashes()` is called after the initial normalization, the HTML gets normalized twice.

**Fix:** Compute the expensive `normalizeHtml(html)` once after `adapter.content()` and pass the result to `computeHashes()` to avoid double-normalization. Same for markdown conversion if used more than once.

**Revised estimate: 10-50ms/interaction** (down from "50-200ms") since only 1-2 calls per interaction hit the expensive path.

---

### 12. Add missing database indexes

**Repo:** `testomniac_api`
**File:** `src/db/schema.ts`

Hot query paths missing composite indexes:

```sql
-- Findings query in SSE stream (polled every 3s per client)
-- NOTE: Verify with EXPLAIN ANALYZE which column the SSE query actually filters on.
-- If the query joins through test_interaction_run_id:
CREATE INDEX idx_trf_interaction_created
  ON testomniac.test_run_findings(test_interaction_run_id, created_at DESC);
-- If the query filters by test_surface_bundle_run_id (via a JOIN or denormalized column):
-- CREATE INDEX idx_trf_bundle_created
--   ON testomniac.test_run_findings(test_surface_bundle_run_id, created_at DESC);

-- Batch interaction lookups
CREATE INDEX idx_ti_surface_active
  ON testomniac.test_interactions(test_surface_id, is_active);

-- Surface run lookups by bundle + status
CREATE INDEX idx_tsr_bundle_status
  ON testomniac.test_surface_runs(test_surface_bundle_run_id, status);

-- Structure data loading
CREATE INDEX idx_tir_surface_run_status
  ON testomniac.test_interaction_runs(test_surface_run_id, status);
```

**Before adding, verify two things:**
1. **Read benefit:** Run `EXPLAIN ANALYZE` on the target queries with production data to confirm they currently do sequential scans and would benefit from the index.
2. **Write cost:** These tables receive heavy inserts during active scans (especially `test_interaction_runs` and `test_run_findings`). Each additional index slows inserts. Measure insert throughput before/after on a staging dataset. If insert regression exceeds 10%, consider partial indexes (e.g., `WHERE is_active = true` for the interactions index) to reduce write amplification.

**Use `CREATE INDEX CONCURRENTLY`** to avoid holding `ACCESS EXCLUSIVE` locks on production tables during active scans. Schedule during low-traffic windows if possible.

---

### 13. Screenshot capture optimization

**Repos:** `testomniac_runner_service` + `testomniac_extension`

Screenshots are captured and sent as base64 in messages on every interaction.

**Engineering fixes:**
- Send screenshot reference (stored in extension storage) instead of full base64 in messages
- Consider lower resolution for live preview

**Note:** Both the runner (Puppeteer) and extension (CDP) already use JPEG at quality 72. The original claim that the extension uses PNG is stale (`ChromeAdapter.ts` ~line 600 confirms JPEG/72).

**Product decisions required (discuss with product before implementing):**
- Make live screenshots optional/configurable
- Sample every Nth interaction instead of every one

---

### 14. Browser pool in server runner

**Repo:** `testomniac_runner`
**File:** `src/browser/chromium.ts`

A new browser instance is launched for each scan (~2-3s cold start) and closed immediately after.

**Fix:** Maintain a pool of 1-3 warm browser instances. Reuse across consecutive runs. Close only after inactivity timeout (30s). This avoids paying the Chromium startup cost for each run.

---

### 15. Chromium launch flags

**Repo:** `testomniac_runner`
**File:** `src/browser/chromium.ts` (~lines 11-17)

Currently only `--no-sandbox` and `--disable-setuid-sandbox`. Missing performance flags:

```typescript
args: [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",         // Container /dev/shm fix
  "--disable-gpu",                   // Not needed for headless
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-default-apps",
  "--no-first-run",
  "--mute-audio",
]
```

Expected: 15-30% faster launch, 20-40% lower memory.

---

### 16. Adaptive polling backoff

**Repos:** `testomniac_runner` (10s fixed polling), `testomniac_extension` (3s dashboard polling)

Both use fixed-interval polling even when no work is available or no data has changed.

**Fix:** Exponential backoff when idle (10s -> 20s -> 40s -> 60s max), reset to base interval when new work detected. For the extension dashboard, increase base from 3s to 5s.

---

### 17. Push pages-summary aggregation to database

**Repo:** `testomniac_api`
**File:** `src/routes/runs-read.ts` (~lines 343-483)

Pages summary loads all page states, all interactions, all interaction runs, and all findings into memory, then aggregates in JavaScript with 4 separate Maps.

**Fix:** Replace with a single SQL aggregate query:

```sql
SELECT p.id, p.relative_path,
  COUNT(DISTINCT trf.id) AS total_findings,
  SUM(CASE WHEN trf.type = 'error' THEN 1 ELSE 0 END) AS errors,
  SUM(CASE WHEN trf.type = 'warning' THEN 1 ELSE 0 END) AS warnings
FROM pages p
LEFT JOIN test_interactions ti ON ti.page_id = p.id
LEFT JOIN test_interaction_runs tir ON tir.test_interaction_id = ti.id
LEFT JOIN test_run_findings trf ON trf.test_interaction_run_id = tir.id
WHERE p.runner_id = ?
GROUP BY p.id;
```

---

### 18. Plugin parallelization

**Repo:** `testomniac_runner`
**Files:** `src/plugins/`

- UI consistency plugin re-navigates to pages already visited during the scan
- Content plugin makes sequential OpenAI API calls per page

**Fixes:**
- Cache page HTML/text during main scan, reuse in plugins (skip re-navigation)
- Parallelize AI spelling/grammar checks across pages with `Promise.all`
- Use `waitUntil: "domcontentloaded"` instead of `"networkidle0"` for plugin analysis phases

---

## Lower Priority / Quick Wins

### 19. waitForSelector polling backoff

**Repo:** `testomniac_extension`
**File:** `src/adapters/ChromeAdapter.ts` (~lines 512-550)

`waitForSelector` polls with `executeScript` every 200ms for up to 5 seconds (25 calls). Use exponential backoff: start at 200ms, increase to 500ms as timeout approaches.

### 20. Remove dead code in dedup eviction

**Repo:** `testomniac_extension`
**File:** `src/background/index.ts` (~lines 157-169)

The `seenKeys` Set eviction has a first loop that advances an iterator 500 positions but discards the results -- this is dead code. A second loop creates a fresh iterator and collects the first 500 entries for deletion. The first loop does nothing. Remove it and simplify to a single pass.

### 21. test-surfaces/ensure-with-run parallelism

**Repo:** `testomniac_api`
**File:** `src/routes/scanner.ts` (~lines 2301-2389)

6 sequential queries (find surface, update/insert, find link, insert link, find run, insert run). The three lookups (surface, link, run) can run in parallel.

### 22. test-run-findings/ensure-batch junction queries

**Repo:** `testomniac_api`
**File:** `src/routes/scanner.ts` (~lines 2525-2622)

Per-item junction table queries after inserts. Batch all junction lookups into a single query at the end.

### 23. Increase ChromeStorageDedupStore thresholds

**Repo:** `testomniac_extension`
**File:** `src/storage/ChromeStorageDedupStore.ts` (~lines 13-14)

Current: flush every 2s or 50 items. Increase to 3s / 100 items. Findings dedup is not critical during the scan; server-side dedup catches duplicates.

**Risk:** `ChromeStorageDedupStore` has no lifecycle hook -- no `onSuspend` or flush-on-demand. If the service worker is killed by Chrome, pending entries in the in-memory `pendingAdds` Map are silently lost. Increasing thresholds from 2s/50 to 3s/100 increases the data loss window by 50%. **Before changing thresholds, first add a `flush()` method and wire it into the shutdown path** (see [Flush-on-shutdown pattern](#flush-on-shutdown-pattern)).

### 24. test-interactions/reconcile pagination

**Repo:** `testomniac_api`
**File:** `src/routes/scanner.ts` (~lines 1760-1845)

Loads ALL interactions for a surface with no LIMIT. For surfaces with 10,000+ interactions, this is a large unbounded query followed by cascade deletes. Add pagination or batch the cascade.

---

## Shared Pattern: Flush-on-shutdown

Items #7 (log persistence), #9 (scanState persistence), and #23 (dedup store) all introduce or increase write buffering. None currently handle the case where Chrome terminates the service worker mid-buffer.

**Establish this pattern once and reuse across all three:**

```typescript
// Shared flush registry
const flushCallbacks: Array<() => Promise<void>> = [];

function registerFlush(fn: () => Promise<void>) {
  flushCallbacks.push(fn);
}

async function flushAll() {
  await Promise.allSettled(flushCallbacks.map(fn => fn()));
}

// Wire into shutdown paths:
// 1. Phase transitions (scanning -> paused -> completed -> failed)
// 2. STOP_SCAN handler
// 3. Before scan completion in onScanComplete()
// 4. Side panel beforeunload -> message to service worker -> flushAll()
//
// Note: chrome.runtime.onSuspend is NOT available in MV3 service workers.
//       The keepalive alarm prevents termination during active scans,
//       so the main risk window is the few seconds after scan completion
//       before the final flush timer fires. The side panel beforeunload
//       handler (#4) covers the case where the user closes the side panel
//       while buffers are pending.
```

Each buffered writer (#7, #9, #23) registers its flush function. All shutdown/completion paths call `flushAll()`.

**Required flush points (reliable):** phase transitions, `STOP_SCAN` handler, `onScanComplete()`, error/failure paths. These are the guaranteed flush points.

**Best-effort flush points (supplementary):** side panel `beforeunload` → message → `flushAll()`. This is unreliable (the message may not be delivered before the service worker is terminated) and must not be the sole flush mechanism for any buffer.

**Important:** MV3 service workers do not have `chrome.runtime.onSuspend`. The keepalive alarm prevents termination during active scans, so the risk window is narrow (a few seconds after scan completion). Accepting this small window of potential data loss is reasonable -- the auto-resume mechanism re-derives state from the API on restart.

---

## Estimated Aggregate Impact

If all critical + high priority items are implemented:

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| Per-interaction overhead | ~2-4s | ~1-2.5s | 30-40% |
| Scan creation latency | ~1-2s | ~400-700ms | 50-65% |
| Dashboard query load | 6-8 queries/req | 2-3 queries/req | 60% |
| SSE query load at 100 clients | 2,000/min | 600/min | 70% |
| chrome.storage writes/scan | ~500+ | ~50 | 90% |
| Discovery page analysis | ~3-12s | ~1-4s | 65% (requires #3 mutable state audit) |

**Notes on revised estimates:**
- Per-interaction improvement is modest because #1 (page decomposition) provides marginal benefit with serialized adapters (5-50ms), and #8 (selector strategy caching) has uncertain hit rate (10-25%) — measure before committing to the implementation complexity.
- Discovery page analysis improvement depends on #3 (generator parallelism), which is safe to parallelize (generators treat context as read-only; remove per-generator cache invalidation and do it once after).
- Scan creation improvement revised from 75-80% to 50-65% because FK dependency chains limit parallelism to ~9 tiers, not 3 waves.
- The biggest reliable wins are API-side: #2 (scan bootstrap), #4 (dashboard queries), #5 (batch writes), and #6 (SSE polling). These are independent of adapter serialization constraints.
- Extension-side quick wins (#7, #9, #20) reduce I/O contention and are low-risk. #7 (log batching) is the single highest-impact extension fix (300-1000+ storage writes per scan eliminated).
