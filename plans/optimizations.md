# Performance Optimization Opportunities

Cross-cutting analysis of `testomniac_runner_service`, `testomniac_extension`, `testomniac_runner`, and `testomniac_api`.

---

## Priority Matrix

| # | Area | Repo | Impact | Effort | Est. Savings |
|---|------|------|--------|--------|--------------|
| **0** | [**Fix concurrent scan guard (bug)**](#0-fix-concurrent-scan-guard-bug) | **extension** | **Bug fix** | **Low** | **Prevents orphaned scans** |
| 1 | [Parallelize page decomposition](#1-parallelize-page-decomposition-pipeline) | runner_service | High | Low | PuppeteerAdapter: 350-1400ms; ChromeAdapter: marginal (see caveats) |
| 2 | [Parallelize POST /scan queries](#2-parallelize-post-apiscan-bootstrap) | api | Critical | Medium | 750-1500ms/scan creation |
| 3 | [Parallelize test interaction generators](#3-parallelize-test-interaction-generators) | runner_service | Critical | High | 2-10s/discovery page (requires mutable-state audit) |
| 4 | [Reduce live-dashboard query count](#4-reduce-live-dashboard-query-count) | api | Critical | Medium | 60-80% fewer queries |
| 5 | [Batch writes in test-interactions/batch](#5-batch-writes-in-test-interactionsbatch-loop) | api | Critical | High | O(N) -> O(1) DB calls (requires raw SQL) |
| 6 | [SSE stream polling efficiency](#6-sse-stream-polling-efficiency) | api | Critical | Low | 50-70% fewer queries |
| 7 | [Batch log persistence](#7-batch-log-persistence) | extension | High | Low | 50-100x fewer writes |
| 8 | [Cache materializeSelector results](#8-cache-materializeselector-results) | extension + runner | High | Medium | 50-90% fewer DOM evals (limited by mutation invalidation) |
| 9 | [Debounce scanState persistence](#9-debounce-scanstate-persistence) | extension | High | Low | ~9x fewer writes |
| 10 | [Increase ApiClient cache TTL](#10-increase-apiclient-cache-ttl) | runner_service | High | Low | 100-300ms/iteration |
| 11 | [Cache normalized HTML](#11-cache-normalized-html) | runner_service | Medium | Low | 50-200ms/interaction |
| 12 | [Add missing database indexes](#12-add-missing-database-indexes) | api | Medium | Low | Eliminates full scans (measure write cost) |
| 13 | [Screenshot capture optimization](#13-screenshot-capture-optimization) | runner_service + extension | Medium | Medium | 200-800ms/interaction |
| 14 | [Browser pool in server runner](#14-browser-pool-in-server-runner) | runner | Medium | High | 2-3s/run startup |
| 15 | [Chromium launch flags](#15-chromium-launch-flags) | runner | Medium | Low | 20-40% less memory |
| 16 | [Adaptive polling backoff](#16-adaptive-polling-backoff) | runner + extension | Low | Low | 80% fewer idle calls |
| 17 | [Push pages-summary to DB](#17-push-pages-summary-aggregation-to-database) | api | Medium | Medium | Memory + latency |
| 18 | [Plugin parallelization](#18-plugin-parallelization) | runner | Medium | Medium | 30-50% faster plugins |

---

## Implementation Order

Items are grouped into phases that account for cross-repo dependencies and risk.

### Phase 0: Bug fix (do first)
- **#0 Concurrent scan guard** -- Bug, not optimization. Ship independently.

### Phase 1: Extension-only (no API changes, no cross-repo coordination)
- **#7 Batch log persistence**
- **#9 Debounce scanState persistence**
- **#20 Simplify dedup eviction** (dead code removal)

### Phase 2: API database prep (deploy before query optimizations)
- **#12 Add missing indexes** -- Must land before #4 and #6 so the new query patterns hit indexes, not sequential scans. Run `EXPLAIN ANALYZE` on production first; measure insert-side regression on high-write tables.

### Phase 3: API query optimizations (deploy after indexes)
- **#6 SSE stream polling** -- Low effort, high impact.
- **#4 Live-dashboard query consolidation**
- **#2 POST /scan parallelism**
- **#5 Batch writes** -- Higher effort (raw SQL needed); can follow independently.
- **#17 Pages-summary aggregation**

### Phase 4: runner_service changes (shared library, requires coordinated release with extension + runner)
- **#10 Cache TTL increase** -- Low risk, ship first.
- **#11 Cache normalized HTML**
- **#1 Parallelize page decomposition** -- Real benefit is PuppeteerAdapter only.
- **#3 Parallelize generators** -- Requires mutable-state audit first (see investigation checklist below).

### Phase 5: Extension adapter + runner adapter (independent per repo)
- **#8 Cache materializeSelector**
- **#13 Screenshot optimization**
- **#15 Chromium launch flags**
- **#14 Browser pool**
- **#16 Adaptive polling backoff**
- **#18 Plugin parallelization**

### Cross-repo coordination notes
- Items #1, #3, #10, #11 change `testomniac_runner_service`, which is aliased via `vite.config.ts` in the extension and imported as a package in the runner. Both consumers must be tested after changes.
- Items #2, #4, #5, #6, #12, #17 are API-only. Deploy independently; no client changes needed.
- Items #7, #8, #9 are extension-only. No coordination needed.
- Items #14, #15, #18 are runner-only. No coordination needed.

---

## Measurement Plan

Before starting any optimization, capture baselines. After each item, re-measure and compare.

| Metric | How to measure | Applies to |
|--------|---------------|------------|
| Per-interaction time | Add timer around `executeTestInteraction()` in runner_service, log p50/p95 | #1, #8, #11, #13 |
| Scan creation latency | Time the POST /scan handler end-to-end (API response time) | #2 |
| Discovery page analysis time | Timer around `PageAnalyzer.generateTestInteractions()` | #3 |
| Dashboard endpoint latency | API response time for `/runs/:id/live-dashboard` | #4, #12 |
| Batch endpoint latency | API response time for `test-interactions/batch` with N items | #5, #12 |
| SSE query load | `pg_stat_statements` query count for SSE-related queries over 1 minute | #6, #12 |
| chrome.storage write count | Counter in `persistLog()` and `persistScanState()` over one full scan | #7, #9 |
| Selector resolution time | Timer around `materializeSelector()`, log hit/miss rate | #8 |
| Browser startup time | Timer from `puppeteer.launch()` to first `page.goto()` | #14, #15 |

---

## Bug Fix (Do First)

### 0. Fix concurrent scan guard (bug)

**Repo:** `testomniac_extension`
**File:** `src/background/index.ts` (~line 1129)

If two `START_SCAN` messages arrive in quick succession, both call `startScan()` via fire-and-forget (`void startScan(...)`). The second call overwrites `activeRunPromise`, orphaning the first scan -- it continues running but can no longer be paused, resumed, or stopped. This is a correctness bug, not just a performance issue.

**Fix:** Add an explicit guard at the top of the `START_SCAN` handler:

```typescript
if (message.type === 'START_SCAN' && message.url && message.runId) {
  if (scanState.isRunning || activeRunPromise) {
    sendResponse({ ok: false, error: 'Scan already running' });
    return true;
  }
  void startScan(...);
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

Each is a browser-side evaluation (50-200ms). Sequential = 350-1400ms. They share no dependencies.

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

**Important caveat -- adapter serialization:**
- **ChromeAdapter** serializes all `chrome.scripting.executeScript` calls through a single tab. `Promise.all` will still execute sequentially at the browser level. The only savings come from reduced JS-to-native round-trip overhead between calls, which is marginal. **The 350-1400ms estimate does not apply to the extension.**
- **PuppeteerAdapter** evaluates on a single page context. Puppeteer serializes `page.evaluate()` calls internally. The benefit is similar -- marginal round-trip savings, not true parallelism.
- **Real benefit:** This optimization mainly helps if any of these functions do async JS work (timers, network) rather than pure DOM reads. If they're all synchronous DOM evaluations, `Promise.all` provides negligible improvement over sequential `await`.
- **Revised estimate:** Marginal for both adapters (5-50ms savings from reduced scheduling overhead). Downgraded from "Critical" to "High" -- still worth doing as it's low effort, but temper expectations.

---

### 2. Parallelize POST /api/scan bootstrap

**Repo:** `testomniac_api` (API-only change, no client coordination needed)
**File:** `src/routes/scan.ts` (~lines 159-623)

Scan creation performs **19 sequential database operations**: resolve environment, find/create runner, find/create surface, find/create interaction, find/create action, find/create bundle, link surface to bundle, create bundle run, create surface run, create interaction run, create test run, optionally store credentials.

**Fix:** Three waves of parallelism:

```
Wave 1 (parallel lookups):
  - findEnvironment
  - findRunner
  - findSurfaces
  - findBundle

Wave 2 (conditional creates, parallel where independent):
  - createRunner (if needed)
  - createSurface (if needed)
  - createBundle (if needed)

Wave 3 (all run records, parallel):
  - insert bundleRun
  - insert surfaceRun
  - insert interactionRun
  - insert testRun
  - insert credentials (if provided)
```

**Expected:** ~1-2s down to ~200-400ms (5x improvement).

**Scope note:** This is an API-only change. The extension and runner call POST /scan and receive the same response shape -- no client changes needed.

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

**Prerequisite -- mutable state audit (must complete before implementing):**

The generators share mutable state in PageAnalyzer via dedup sets (`generatedPaths`, `generatedSelectors`, `reportedPageFindings`, `reportedFindingKeys`, `reportedDescriptions`, `generatedActionableHashes`). Running generators concurrently risks race conditions where two generators both check `has(key)` before either calls `add(key)`, producing duplicate test interactions.

This is not a minor issue -- duplicate interactions waste execution time (each one runs browser automation), not just API calls. The API dedup catches duplicate *findings* but not duplicate *interactions*.

**Investigation checklist before implementing:**
1. For each generator, list which dedup sets it reads and writes
2. Identify which generators could produce overlapping keys (e.g., both navigation and scaffold generators might generate interactions for the same element)
3. Determine if any generator's output depends on another generator's side effects (beyond hover follow-ups)
4. If overlap exists, choose one of:
   - (a) Per-generator local dedup buffers, merged after `Promise.all` with conflict resolution
   - (b) Wrap dedup sets in a mutex (simple but reduces parallelism benefit)
   - (c) Accept duplicates and add interaction-level dedup on the API side (adds API complexity)

**Effort revised to High** due to this investigation requirement.

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

**Fix:** Collect all updates and inserts, then execute as two bulk operations:

```typescript
const toUpdate = [];
const toInsert = [];

for (const item of items) {
  if (existing) toUpdate.push({ id: existing.id, data: { ... } });
  else toInsert.push({ ... });
}

await Promise.all([
  toUpdate.length ? batchUpdate(testInteractions, toUpdate) : null,
  toInsert.length ? db.insert(testInteractions).values(toInsert) : null,
]);
```

For interaction runs, use a single multi-row insert.

---

### 6. SSE stream polling efficiency

**Repo:** `testomniac_api`
**File:** `src/routes/runs-read.ts` (~line 1206)

The SSE stream endpoint polls the database every 3 seconds per connected client. Each poll runs 3 queries (current run, latest scan state with JOIN, new findings with 3-way JOIN).

At 100 concurrent dashboards = 2,000 queries/minute.

**Fixes:**
- Increase polling interval to 5-10 seconds (dashboard also receives SCAN_PROGRESS messages from the extension directly)
- Replace `getLatestScanState()` full JOIN with a targeted indexed query
- Add composite index: `(test_surface_bundle_run_id, created_at DESC)` for the findings query
- Consider PostgreSQL `LISTEN/NOTIFY` for event-driven updates instead of polling

---

## High Priority

### 7. Batch log persistence

**Repo:** `testomniac_extension`
**File:** `src/background/index.ts` (~lines 33-57)

`persistLog()` writes to `chrome.storage.local` on **every single log call** via `appendLog()`. During active scans with hundreds of log messages, this thrashes chrome.storage.

**Fix:** Flush log buffer on a timer (every 1-2s) or threshold (50 entries), matching the pattern already used by `ChromeStorageDedupStore`.

---

### 8. Cache materializeSelector results

**Repos:** `testomniac_extension` (`ChromeAdapter.ts` ~lines 56-208) and `testomniac_runner` (`PuppeteerAdapter.ts` ~lines 24-148)

`materializeSelector()` is called before every interaction (click, hover, type, select, waitForSelector). Each call runs a full `executeScript` with DOM traversal across all elements matching `querySelectorAll(tagName || "*")`. Identical selectors are re-resolved repeatedly.

**Fix:** Add an LRU cache (size ~100) keyed by selector string. Invalidate on navigation (new page = new DOM). The cache is valid within a single page load.

```typescript
private selectorCache = new Map<string, string>();

private async materializeSelector(selector: string): Promise<string> {
  if (!selector.startsWith(REPLAY_SELECTOR_PREFIX)) return selector;
  const cached = this.selectorCache.get(selector);
  if (cached) return cached;
  const resolved = await this._doMaterialize(selector);
  this.selectorCache.set(selector, resolved);
  return resolved;
}

// Clear on navigation:
async goto(url) { this.selectorCache.clear(); ... }
```

---

### 9. Debounce scanState persistence

**Repo:** `testomniac_extension`
**File:** `src/background/index.ts` (~lines 296-437)

`sendProgressToSidePanel()` calls `persistScanState()` unconditionally on every invocation. During active scanning, stats update frequently.

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

`normalizeHtml()` runs 7 sequential regex replacements on the full HTML string. It's called multiple times per interaction:
- Once for initial page state
- Once per expectation group context (up to 5 groups)
- Once in discovery context

Additionally, `computeHashes()` calls `normalizeHtml()` again AND `htmlToMarkdown()` (which also parses HTML).

**Fix:** Compute `normalizeHtml(html)` once after `adapter.content()` and pass the result through the pipeline. Same for markdown conversion.

---

### 12. Add missing database indexes

**Repo:** `testomniac_api`
**File:** `src/db/schema.ts`

Hot query paths missing composite indexes:

```sql
-- Findings query in SSE stream (polled every 3s per client)
CREATE INDEX idx_trf_bundle_created
  ON testomniac.test_run_findings(test_interaction_run_id, created_at DESC);

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

Verify with `EXPLAIN ANALYZE` on production queries before adding.

---

### 13. Screenshot capture optimization

**Repos:** `testomniac_runner_service` + `testomniac_extension`

Screenshots are captured as full PNG, converted to base64, and sent as messages. This happens on every interaction.

**Fixes:**
- Use JPEG (already done in runner at quality 72; extension uses PNG via CDP)
- Make live screenshots optional/configurable
- Sample every Nth interaction instead of every one
- Send screenshot reference (stored in extension storage) instead of full base64 in messages
- Consider lower resolution for live preview

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

### 20. Simplify dedup eviction

**Repo:** `testomniac_extension`
**File:** `src/background/index.ts` (~lines 157-169)

The `seenKeys` Set eviction iterates twice (one loop does nothing). Simplify to a single pass deleting the first 500 entries.

### 21. Guard concurrent scan starts

**Repo:** `testomniac_extension`
**File:** `src/background/index.ts` (~line 1129)

If two `START_SCAN` messages arrive in quick succession, both fire. Add an explicit guard returning an error if a scan is already running.

### 22. test-surfaces/ensure-with-run parallelism

**Repo:** `testomniac_api`
**File:** `src/routes/scanner.ts` (~lines 2301-2389)

6 sequential queries (find surface, update/insert, find link, insert link, find run, insert run). The three lookups (surface, link, run) can run in parallel.

### 23. test-run-findings/ensure-batch junction queries

**Repo:** `testomniac_api`
**File:** `src/routes/scanner.ts` (~lines 2525-2622)

Per-item junction table queries after inserts. Batch all junction lookups into a single query at the end.

### 24. Increase ChromeStorageDedupStore thresholds

**Repo:** `testomniac_extension`
**File:** `src/storage/ChromeStorageDedupStore.ts` (~lines 13-14)

Current: flush every 2s or 50 items. Increase to 3s / 100 items. Findings dedup is not critical during the scan; server-side dedup catches duplicates.

### 25. test-interactions/reconcile pagination

**Repo:** `testomniac_api`
**File:** `src/routes/scanner.ts` (~lines 1760-1845)

Loads ALL interactions for a surface with no LIMIT. For surfaces with 10,000+ interactions, this is a large unbounded query followed by cascade deletes. Add pagination or batch the cascade.

---

## Estimated Aggregate Impact

If all critical + high priority items are implemented:

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| Per-interaction overhead | ~2-4s | ~0.5-1.5s | 60-75% |
| Scan creation latency | ~1-2s | ~200-400ms | 75-80% |
| Dashboard query load | 6-8 queries/req | 2-3 queries/req | 60% |
| SSE query load at 100 clients | 2,000/min | 600/min | 70% |
| chrome.storage writes/scan | ~500+ | ~50 | 90% |
| Discovery page analysis | ~3-12s | ~1-4s | 65% |

The biggest single wins come from parallelizing the page decomposition pipeline (#1) and the scan bootstrap (#2), as these are on the critical path of every interaction and every scan respectively.
