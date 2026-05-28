# API Call Consolidation Design

**Date:** 2026-05-27
**Scope:** testomniac_types, testomniac_api, testomniac_client, testomniac_runner_service, testomniac_extension, testomniac_app (optional)

## Problem

During a scan, the extension generates excessive redundant API calls:

1. **`test-interaction-runs` fan-out:** `loadPendingInteractionRuns()` calls `getOpenTestInteractionRuns()` twice per open surface run (once with `includeBlocked=false`, once with `includeBlocked=true`). With 6 surfaces, that's 12 HTTP requests per main loop iteration.

2. **Side panel polling:** `SidePanel.tsx` polls 4 endpoints every 2 seconds (`summary`, `pages-summary`, `navigation-map`, `structure`), all for the same run ID.

3. **`includeBlocked` dual-call:** The `includeBlocked=true` response is a superset of `includeBlocked=false`. Both are always fetched together, making the non-blocked call redundant.

## Solution Overview

Three targeted consolidations:

| Change | Before | After | Reduction |
|--------|--------|-------|-----------|
| Batch test-interaction-runs | 12 calls/loop | 1 call/loop | 92% |
| Merge side panel polling | 4 calls/2s | 1 call/2s | 75% |
| Eliminate includeBlocked dual-call | 2 calls/surface | 0 extra (folded into batch) | 100% |

---

## Consolidation 1: Batch `test-interaction-runs` by Multiple Surface Run IDs

### Current Behavior

```
GET /api/v1/scanner/test-interaction-runs?testSurfaceRunId=142&status=pending&includeBlocked=false
GET /api/v1/scanner/test-interaction-runs?testSurfaceRunId=142&status=pending&includeBlocked=true
GET /api/v1/scanner/test-interaction-runs?testSurfaceRunId=143&status=pending&includeBlocked=false
GET /api/v1/scanner/test-interaction-runs?testSurfaceRunId=143&status=pending&includeBlocked=true
... (repeated for each surface run)
```

### New Behavior

```
GET /api/v1/scanner/test-interaction-runs?testSurfaceRunIds=142,143,144,145,146,147&status=pending
```

### API Changes

**New query parameter:** `testSurfaceRunIds` (plural, comma-separated integers)

**Backward compatibility:** The existing singular `testSurfaceRunId` parameter continues to work. If both are provided, `testSurfaceRunIds` takes precedence.

**Response shape:**

- When `testSurfaceRunId` (singular) is used: response remains `TestInteractionRunResponse[]` (unchanged)
- When `testSurfaceRunIds` (plural) is used: response is `Record<string, TestInteractionRunResponse[]>` keyed by surface run ID as string

**`includeBlocked` removal:** The `includeBlocked` parameter is removed. All pending runs are always returned. Each `TestInteractionRunResponse` gains a `blocked: boolean` field indicating whether the run is blocked by unresolved dependencies. Callers filter client-side.

### Type Changes (`testomniac_types`)

Add to `TestInteractionRunResponse`:
```typescript
blocked?: boolean; // true if dependencies have not completed; omitted for non-pending queries
```

Add new type:
```typescript
type BatchTestInteractionRunsResponse = Record<string, TestInteractionRunResponse[]>;
```

### API Route Changes (`testomniac_api`)

File: `src/routes/scanner.ts` (lines 246-333)

- Parse `testSurfaceRunIds` query param, split by comma, coerce to `number[]`
- If present, query `testInteractionRuns` with `IN (...)` filter on `testSurfaceRunId`
- Run dependency-chain analysis (existing logic) but instead of filtering blocked runs out, set `blocked: true` on each blocked run
- Group results by `testSurfaceRunId` into a `Record<string, TestInteractionRunResponse[]>`
- Fall back to existing singular behavior if only `testSurfaceRunId` is provided

### Runner Service Changes (`testomniac_runner_service`)

File: `src/api/client.ts`

Add new method:
```typescript
getOpenTestInteractionRunsBatch(
  testSurfaceRunIds: number[]
): Promise<BatchTestInteractionRunsResponse> {
  const ids = testSurfaceRunIds.join(",");
  return this.get(`/test-interaction-runs?testSurfaceRunIds=${ids}&status=pending`);
}
```

Keep `getOpenTestInteractionRuns()` for backward compatibility but mark as deprecated.

File: `src/orchestrator/runner.ts` (lines 868-879)

Replace `loadPendingInteractionRuns()`:
```typescript
async function loadPendingInteractionRuns(
  api: ApiClient,
  openSurfaceRuns: TestSurfaceRunResponse[]
): Promise<PendingInteractionRunsBySurface[]> {
  const ids = openSurfaceRuns.map(sr => sr.id);
  const batchResult = await api.getOpenTestInteractionRunsBatch(ids);
  return openSurfaceRuns.map(surfaceRun => ({
    surfaceRun,
    eligibleRuns: (batchResult[surfaceRun.id] ?? []).filter(r => !r.blocked),
    allPendingRuns: batchResult[surfaceRun.id] ?? [],
  }));
}
```

---

## Consolidation 2: Merged Side Panel Polling Endpoint

### Current Behavior

Every 2 seconds, `SidePanel.tsx` fires 4 parallel requests:
```
GET /api/v1/runs/5/summary          (800ms-2s)
GET /api/v1/runs/5/pages-summary    (1.3s-2s)
GET /api/v1/runs/5/navigation-map   (200ms-700ms)
GET /api/v1/runs/5/structure        (1.2s-2.6s)
```

### New Behavior

```
GET /api/v1/runs/5/live-dashboard
```

### Type Changes (`testomniac_types`)

Add new type:
```typescript
type RunLiveDashboard = {
  summary: RunSummary;
  pagesSummary: RunPageSummary[];
  navigationMap: RunNavigationMap;
  structure: RunStructure;
};
```

### API Route Changes (`testomniac_api`)

File: `src/routes/runs-read.ts`

Add new route handler `GET /:runId/live-dashboard`:
- Auth: Firebase auth middleware (same as existing `/runs/*` endpoints)
- Implementation: run the 4 existing query blocks in parallel via `Promise.all`
- Response: `BaseResponse<RunLiveDashboard>`
- Latency: ~max(summary, pages-summary, navigation-map, structure) since queries run in parallel server-side

### Client Changes (`testomniac_client`)

File: `src/network/TestomniacClient.ts`

Add method:
```typescript
getRunLiveDashboard(runId: number, token: FirebaseIdToken): Promise<BaseResponse<RunLiveDashboard>>
```

File: new `src/hooks/useRunLiveDashboard.ts`

Add hook:
```typescript
useRunLiveDashboard(config: { networkClient, baseUrl, runId, token }): {
  dashboard: RunLiveDashboard | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}
```

### Extension Changes (`testomniac_extension`)

File: `src/sidepanel/SidePanel.tsx` (lines 1101-1215)

Replace `fetchLiveData()`:
- Call single `getRunLiveDashboard()` instead of 4 separate fetches
- Destructure `{ summary, pagesSummary, navigationMap, structure }` from response
- Feed into existing state setters unchanged

### App Changes (`testomniac_app`) — Optional

File: `src/pages/RunDetailsPage.tsx`

Could replace 4 individual hooks (`useRunSummary`, `useRunPagesSummary`, `useRunNavigationMap`, `useRunStructure`) with `useRunLiveDashboard`. This is optional since the individual endpoints remain available and the app uses EventSource for real-time updates rather than polling.

### MCP Changes — None

`testomniac_api_mcp` and `testomniac_runner_mcp` call individual endpoints which remain available.

---

## Consolidation 3: Eliminate `includeBlocked` Dual-Call

This is folded into Consolidation 1. No separate endpoint changes needed.

### Behavioral Change

**Before:** Server computes dependency chains and either includes or excludes blocked runs based on `includeBlocked` param. Caller must make two calls to get both sets.

**After:** Server always computes dependency chains and annotates each run with `blocked: boolean`. Caller makes one call and filters client-side.

### API Change (`testomniac_api`)

File: `src/routes/scanner.ts`

The existing dependency-chain logic (which loads test interactions, checks `dependencyTestInteractionId` chains across bundle surface runs) is preserved. Instead of filtering out blocked runs, it sets `blocked: true` on each blocked `TestInteractionRunResponse`.

The `includeBlocked` query parameter is ignored (treated as always `true`). It is not removed from URL parsing to maintain backward compatibility with older clients.

### Runner Service Change

Already covered in Consolidation 1 — `loadPendingInteractionRuns()` filters `blocked` client-side.

---

## Migration & Backward Compatibility

- **Singular `testSurfaceRunId`** continues to work — returns flat array as before, with `blocked` field added
- **`includeBlocked` param** is accepted but ignored (always returns all pending runs with `blocked` field)
- **Individual polling endpoints** (`summary`, `pages-summary`, `navigation-map`, `structure`) remain available — no breaking changes for `testomniac_app` or MCP tools
- **`getOpenTestInteractionRuns()`** in runner_service kept but deprecated — no immediate removal needed

## Projects Affected

| Project | Changes | Scope |
|---------|---------|-------|
| `testomniac_types` | Add `blocked` to `TestInteractionRunResponse`, add `BatchTestInteractionRunsResponse`, add `RunLiveDashboard` | Small |
| `testomniac_api` | Modify scanner route for batch IDs + blocked annotation, add `live-dashboard` route | Medium |
| `testomniac_client` | Add `getRunLiveDashboard()` method, add `useRunLiveDashboard()` hook | Small |
| `testomniac_runner_service` | Add `getOpenTestInteractionRunsBatch()`, update `loadPendingInteractionRuns()` | Small |
| `testomniac_extension` | Update `SidePanel.tsx` polling to use `live-dashboard` | Small |
| `testomniac_runner` | No changes (uses runner_service) | None |
| `testomniac_app` | Optional: use `useRunLiveDashboard()` on RunDetailsPage | Optional |
| `testomniac_api_mcp` | No changes | None |
| `testomniac_runner_mcp` | No changes | None |

## Execution Order

1. `testomniac_types` — add types (no runtime impact)
2. `testomniac_api` — add batch support + live-dashboard (backward compatible)
3. `testomniac_runner_service` — switch to batch client method
4. `testomniac_client` — add new client method and hook
5. `testomniac_extension` — switch to live-dashboard polling
6. `testomniac_app` — optional hook migration
