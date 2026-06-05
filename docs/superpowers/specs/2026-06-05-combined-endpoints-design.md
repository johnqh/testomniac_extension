# Combined API Endpoints Design

**Date:** 2026-06-05  
**Status:** Approved

## Problem

When the runner lands on a new page, it makes ~20+ sequential API calls to resolve page state and generate test interactions. Each round-trip adds ~30ms network latency plus server processing, totaling ~2s+ per page landing.

## Solution

Two combined endpoints under `/api/v1/combined/` that batch the sequential calls server-side.

## Endpoint A: POST /combined/ensure-page-state

Replaces 7-8 sequential calls with 1:
- POST /scaffolds/batch
- GET /page-states/match
- GET /page-states/match-content-body (conditional)
- POST /html-elements (conditional)
- POST /actionable-items (conditional)
- POST /page-states (conditional)
- PUT /page-states/:id/decomposed-hashes (conditional)
- POST /page-state-scaffolds (conditional)

### Request

```typescript
{
  pageId: number;
  runnerId: number;
  sizeClass: string;
  screenshotPath?: string;
  html: string;
  contentText: string;
  hashes: {
    htmlHash: string;
    normalizedHtmlHash: string;
    textHash: string;
    actionableHash: string;
  };
  fixedBodyHash?: string;
  actionableItems: ActionableItem[];
  scaffolds: Array<{
    type: string;
    html: string;
    hash: string;
    selector: string;
  }>;
  scaffoldSelectorByItemSelector: Record<string, string>;
  createdByTestRunId?: number;
}
```

### Response

```typescript
{
  pageStateId: number;
  isNew: boolean;
  scaffoldIdsBySelector: Record<string, number>;
}
```

### Server Logic

1. Find or create scaffolds (batch) — returns scaffold IDs by selector
2. Map scaffold IDs to actionable items via scaffoldSelectorByItemSelector
3. Try exact hash match (pageId + sizeClass + all 4 hashes)
4. If match → link scaffolds to page state → return existing
5. If no match and scaffolds present and fixedBodyHash provided → try content-body match
6. If content-body match → link scaffolds → return existing
7. If no match at all:
   a. Find or create html-element by hash
   b. Insert actionable items (with scaffoldId mapped)
   c. Create page state with hashes + contentText + screenshotPath
   d. Update decomposed hashes if scaffolds present (best-effort)
   e. Link scaffolds to page state
   f. Return new page state

## Endpoint B: POST /combined/generate-surface-interactions

Replaces 3 calls per generator with 1:
- POST /test-surfaces/ensure-with-run
- POST /test-interactions/batch
- POST /test-interactions/reconcile

### Request

```typescript
{
  runnerId: number;
  testEnvironmentId?: number;
  sizeClass: string;
  testSurface: TestSurface;
  testSurfaceBundleId: number;
  testSurfaceBundleRunId: number;
  interactions: BatchTestInteractionItem[];
  desiredKeys: string[];
  dependencyTestInteractionId?: number;
}
```

### Response

```typescript
{
  surface: TestSurfaceResponse;
  surfaceRun: TestSurfaceRunResponse;
  interactions: BatchTestInteractionResult[];
  retiredIds: number[];
}
```

### Server Logic

1. Ensure test surface + surface run (find-or-create surface, link to bundle, find-or-create run)
2. Batch create/update test interactions + interaction runs
3. Reconcile: retire generated interactions not in desiredKeys
4. Return all results

### Coverage

8 of 11 generators use the standard pattern (surface + batch + reconcile):
- render, forms, semantic-journeys, e2e, dialogs, scaffolds, content, keyboard-disclosure, variants

Non-standard generators keep using individual endpoints:
- **navigation**: no surface creation, no reconcile
- **hover-follow-up**: reuses existing surface, per-interaction context
- **login**: sequential dependency chains via dependencyTestInteractionId

## Runner Service Changes

### ApiClient

Add two new methods:
- `ensurePageStateCombined(params)` → calls POST /combined/ensure-page-state
- `generateSurfaceInteractions(params)` → calls POST /combined/generate-surface-interactions

### PageAnalyzer.ensureTargetPageState

Replace the multi-call sequence with a single call to `ensurePageStateCombined`. Still handle the `currentPageStateId > 0` early-return branch locally (just link scaffolds).

### Generators (standard pattern)

Replace the 3-call pattern with a single call to `generateSurfaceInteractions`. Non-standard generators unchanged.

## Expected Savings

- Page state resolution: 7-8 calls → 1 (~450ms saved)
- Surface+interaction generation: 3 calls × 5-8 generators → 1 each (~1250ms saved)
- Total: ~20+ calls → ~8 calls per page landing
