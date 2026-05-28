# Batch Scanner Endpoints Design

**Date:** 2026-05-27
**Scope:** testomniac_types, testomniac_api, testomniac_runner_service

## Problem

During scan execution, several scanner endpoints are called repeatedly in tight loops:

1. **`POST /scanner/test-interactions`** — called per form field, per nav path, per hover follow-up item. Each call is immediately followed by `POST /scanner/test-interaction-runs` to create the paired run. With N items per generator, that's 2N sequential calls.

2. **`POST /scanner/test-run-findings/ensure`** — called per expertise outcome, per page health issue, per slow step. Multiple findings per test interaction run.

3. **`POST /scanner/scaffolds`** — called per scaffold during page analysis, find-or-create with HTML element deduplication.

## Solution Overview

Add 3 batch endpoints that accept arrays of payloads. Existing single-item endpoints remain untouched.

| Endpoint | Before | After |
|----------|--------|-------|
| test-interactions + test-interaction-runs | 2N calls per generator | 1 call |
| test-run-findings/ensure | N calls per interaction run | 1 call |
| scaffolds | N calls per page analysis | 1 call |

---

## Batch 1: `POST /scanner/test-interactions/batch`

### Request

```typescript
{
  items: Array<InsertTestInteractionRequest & { testSurfaceRunId: number }>
}
```

Uses new type `BatchTestInteractionItem`:
```typescript
interface BatchTestInteractionItem extends InsertTestInteractionRequest {
  testSurfaceRunId: number;
}
```

### Response

```typescript
Array<BatchTestInteractionResult>
```

Where:
```typescript
interface BatchTestInteractionResult {
  testInteraction: TestInteractionResponse;
  testInteractionRun: TestInteractionRunResponse;
}
```

Results are in the same order as input items.

### Server Logic

For each item in `items`:
1. Run existing find-or-create + deduplication logic (same as current `POST /test-interactions` handler)
2. Create a `TestInteractionRun` for the resulting interaction (same as current `POST /test-interaction-runs` handler)
3. Return both in the result entry

### Runner Service Changes

Add `ensureTestInteractionBatch()` method to `ApiClient`.

Refactor generator loops in:
- `src/analyzer/page-analyzer/generators/forms.ts` — collect form test interactions, batch at end
- `src/analyzer/page-analyzer/generators/scaffolds.ts` — collect scaffold test interactions, batch at end
- `src/analyzer/page-analyzer/generators/hover-follow-up.ts` — collect revealed item interactions, batch at end
- `src/analyzer/page-analyzer/generators/navigation.ts` — collect navigation interactions, batch at end
- Other generators following the same pattern

Each generator changes from:
```typescript
for (const item of items) {
  const tc = await api.ensureTestInteraction(runnerId, surface.id, interaction, envId);
  await api.createTestInteractionRun({ testInteractionId: tc.id, testSurfaceRunId });
  desiredKeys.push(analyzer.getGeneratedKey(interaction));
}
```

To:
```typescript
const batchItems = items.map(item => ({
  runnerId,
  testSurfaceId: surface.id,
  testInteraction: interaction,
  testEnvironmentId: envId,
  testSurfaceRunId,
}));
const results = await api.ensureTestInteractionBatch(batchItems);
// Use results for desiredKeys, downstream logic
```

---

## Batch 2: `POST /scanner/test-run-findings/ensure-batch`

### Request

```typescript
{ items: Array<EnsureTestRunFindingRequest> }
```

No new types needed — reuses existing `EnsureTestRunFindingRequest`.

### Response

```typescript
TestRunFindingResponse[]
```

Same order as input items.

### Server Logic

For each item in `items`:
1. Normalize title, find existing finding by type + normalized title + path within the run
2. If found, add junction record (idempotent)
3. If not found, create new finding + junction record
4. Return finding response

### Runner Service Changes

Add `ensureTestRunFindingBatch()` method to `ApiClient`.

Refactor loops in `src/orchestrator/test-interaction-executor.ts`:
- Expertise evaluation loop (lines 605-640): collect findings, batch after loop
- Page health loop (lines 685-710): collect findings, batch after loop
- Slow step detection (lines 472-490): single item, can use batch or keep single call

The return value of `ensureTestRunFinding` is never used by callers. The `events.onFindingCreated()` callbacks fire from the locally collected array, not from the API response.

---

## Batch 3: `POST /scanner/scaffolds/batch`

### Request

```typescript
{ items: Array<FindOrCreateScaffoldRequest> }
```

No new types needed — reuses existing `FindOrCreateScaffoldRequest` and `ScaffoldResponse`.

### Response

```typescript
ScaffoldResponse[]
```

Same order as input items.

### Server Logic

For each item in `items`:
1. Find or create HTML element by hash
2. Find existing scaffold by runner + type, or create new
3. Update HTML element reference if scaffold content changed
4. Return scaffold response

### Runner Service Changes

Add `findOrCreateScaffoldBatch()` method to `ApiClient`.

Refactor `ensureScaffolds()` in `src/analyzer/page-analyzer/index.ts` (lines 1154-1182):
- Collect scaffold requests into array
- Call `api.findOrCreateScaffoldBatch(items)` once
- Iterate results to build `scaffoldIdsBySelector` map and handle screenshot updates

---

## Type Changes (`testomniac_types`)

```typescript
// New types for test-interactions batch
export interface BatchTestInteractionItem extends InsertTestInteractionRequest {
  testSurfaceRunId: number;
}

export interface BatchTestInteractionResult {
  testInteraction: TestInteractionResponse;
  testInteractionRun: TestInteractionRunResponse;
}
```

No new types needed for findings or scaffolds batches — they reuse existing request/response types.

## Projects Affected

| Project | Changes | Scope |
|---------|---------|-------|
| `testomniac_types` | Add `BatchTestInteractionItem`, `BatchTestInteractionResult` | Small |
| `testomniac_api` | Add 3 batch endpoints in `scanner.ts` | Medium |
| `testomniac_runner_service` | Add 3 batch methods to `ApiClient`, refactor generators and executor | Medium |
| All other projects | No changes | None |

## Execution Order

1. `testomniac_types` — add types (no runtime impact)
2. `testomniac_api` — add batch endpoints (backward compatible, existing endpoints untouched)
3. `testomniac_runner_service` — add batch client methods, refactor callers

## Deployment

All changes go directly on `main` branch. Deploy via `testomniac_app/scripts/push_all.sh`.

## Backward Compatibility

All existing single-item endpoints remain untouched. Batch endpoints are purely additive.
