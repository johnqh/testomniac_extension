# API Call Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce redundant API calls during scans by batching test-interaction-run queries (12 calls/loop → 1) and merging side panel polling (4 calls/2s → 1).

**Architecture:** Three consolidations: (1) batch `test-interaction-runs` endpoint to accept comma-separated surface run IDs with `blocked` annotation replacing `includeBlocked` dual-call, (2) new `live-dashboard` endpoint combining 4 polling queries server-side, (3) client-side filtering of blocked runs.

**Tech Stack:** TypeScript, Hono (API routes), Drizzle ORM, React, @tanstack/react-query, Vitest

---

## File Map

| Project | File | Action | Purpose |
|---------|------|--------|---------|
| testomniac_types | `src/index.ts` | Modify | Add `blocked` to `TestInteractionRunResponse`, add `BatchTestInteractionRunsResponse` |
| testomniac_api | `src/routes/scanner.ts` | Modify | Batch `testSurfaceRunIds` support + `blocked` annotation |
| testomniac_api | `src/routes/runs-read.ts` | Modify | Add `live-dashboard` route |
| testomniac_client | `src/types.ts` | Modify | Add `RunLiveDashboard` type |
| testomniac_client | `src/network/TestomniacClient.ts` | Modify | Add `getRunLiveDashboard()` method |
| testomniac_client | `src/hooks/useRunLiveDashboard.ts` | Create | New hook for consolidated polling |
| testomniac_client | `src/hooks/index.ts` | Modify | Export new hook |
| testomniac_runner_service | `src/api/client.ts` | Modify | Add `getOpenTestInteractionRunsBatch()` |
| testomniac_runner_service | `src/orchestrator/runner.ts` | Modify | Use batch method in `loadPendingInteractionRuns()` |
| testomniac_extension | `src/sidepanel/SidePanel.tsx` | Modify | Use `live-dashboard` endpoint |

---

### Task 1: Add `blocked` field to `TestInteractionRunResponse` and batch response type

**Files:**
- Modify: `/Users/johnhuang/projects/testomniac_types/src/index.ts:1414-1430`

- [ ] **Step 1: Add `blocked` field to `TestInteractionRunResponse`**

In `/Users/johnhuang/projects/testomniac_types/src/index.ts`, find the `TestInteractionRunResponse` interface and add the `blocked` field:

```typescript
export interface TestInteractionRunResponse {
  id: number;
  testInteractionId: number;
  testSurfaceRunId: number | null;
  testEnvironmentId: number | null;
  status: string;
  durationMs: number | null;
  errorMessage: string | null;
  expectedOutcome: string | null;
  observedOutcome: string | null;
  screenshotPath: string | null;
  consoleLog: string | null;
  networkLog: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string | null;
  blocked?: boolean;
}
```

- [ ] **Step 2: Add `BatchTestInteractionRunsResponse` type**

Add after `TestInteractionRunResponse`:

```typescript
export type BatchTestInteractionRunsResponse = Record<
  string,
  TestInteractionRunResponse[]
>;
```

- [ ] **Step 3: Verify type-check passes**

Run: `cd /Users/johnhuang/projects/testomniac_types && bun run build`
Expected: Success with no errors

- [ ] **Step 4: Commit**

```bash
cd /Users/johnhuang/projects/testomniac_types
git add src/index.ts
git commit -m "feat: add blocked field to TestInteractionRunResponse and BatchTestInteractionRunsResponse type"
```

---

### Task 2: Modify scanner route to support batch `testSurfaceRunIds` and `blocked` annotation

**Files:**
- Modify: `/Users/johnhuang/projects/testomniac_api/src/routes/scanner.ts:246-329`

- [ ] **Step 1: Replace the GET `/test-interaction-runs` handler**

In `/Users/johnhuang/projects/testomniac_api/src/routes/scanner.ts`, replace the handler at lines 246-329 with:

```typescript
scannerRouter.get("/test-interaction-runs", async c => {
  const testSurfaceRunIdsParam = c.req.query("testSurfaceRunIds");
  const testSurfaceRunIdParam = c.req.query("testSurfaceRunId");
  const status = c.req.query("status");

  // Parse surface run IDs — plural param takes precedence
  let surfaceRunIds: number[];
  let isBatchMode: boolean;

  if (testSurfaceRunIdsParam) {
    surfaceRunIds = testSurfaceRunIdsParam
      .split(",")
      .map(Number)
      .filter(id => !isNaN(id) && id > 0);
    if (surfaceRunIds.length === 0) {
      return c.json(errorResponse("testSurfaceRunIds must contain valid IDs"), 400);
    }
    isBatchMode = true;
  } else if (testSurfaceRunIdParam) {
    const id = Number(testSurfaceRunIdParam);
    if (!id) {
      return c.json(errorResponse("testSurfaceRunId query param required"), 400);
    }
    surfaceRunIds = [id];
    isBatchMode = false;
  } else {
    return c.json(errorResponse("testSurfaceRunId or testSurfaceRunIds query param required"), 400);
  }

  // Query interaction runs for all requested surface run IDs
  const whereClause = status
    ? and(
        inArray(testInteractionRuns.testSurfaceRunId, surfaceRunIds),
        eq(testInteractionRuns.status, status)
      )
    : inArray(testInteractionRuns.testSurfaceRunId, surfaceRunIds);

  const result = await db.query.testInteractionRuns.findMany({
    where: whereClause,
    orderBy: (testInteractionRuns, { asc }) => [asc(testInteractionRuns.id)],
  });

  // For non-pending queries, return immediately (no blocked annotation needed)
  if (status !== "pending" || result.length === 0) {
    if (isBatchMode) {
      const grouped: Record<string, typeof result> = {};
      for (const id of surfaceRunIds) grouped[String(id)] = [];
      for (const row of result) {
        const key = String(row.testSurfaceRunId);
        if (grouped[key]) grouped[key].push(row);
      }
      return c.json(successResponse(grouped));
    }
    return c.json(successResponse(result));
  }

  // Load dependency context for blocked annotation
  const firstSurfaceRun = await db.query.testSurfaceRuns.findFirst({
    where: inArray(testSurfaceRuns.id, surfaceRunIds),
  });
  if (!firstSurfaceRun) {
    if (isBatchMode) {
      const grouped: Record<string, typeof result> = {};
      for (const id of surfaceRunIds) grouped[String(id)] = [];
      return c.json(successResponse(grouped));
    }
    return c.json(errorResponse("Test surface run not found"), 404);
  }

  const testInteractionIds = result.map(row => row.testInteractionId);
  const pendingElements = await db.query.testInteractions.findMany({
    where: inArray(testInteractions.id, testInteractionIds),
  });
  const elementById = new Map(
    pendingElements.map(testInteraction => [testInteraction.id, testInteraction])
  );

  // Filter to active interactions only
  const activeResult = result.filter(elementRun => {
    const testInteraction = elementById.get(elementRun.testInteractionId);
    return Boolean(testInteraction?.isActive);
  });

  const dependencyIds = pendingElements
    .map(testInteraction => testInteraction.dependencyTestInteractionId)
    .filter((id): id is number => typeof id === "number");

  // Compute blocked status for each run
  let dependencyRunByTestInteractionId = new Map<number, (typeof result)[number]>();

  if (dependencyIds.length > 0) {
    const bundleSurfaceRuns = await db.query.testSurfaceRuns.findMany({
      where: eq(
        testSurfaceRuns.testSurfaceBundleRunId,
        firstSurfaceRun.testSurfaceBundleRunId
      ),
    });
    const bundleSurfaceRunIds = bundleSurfaceRuns.map(sr => sr.id);

    const dependencyRuns = await db.query.testInteractionRuns.findMany({
      where: and(
        inArray(testInteractionRuns.testSurfaceRunId, bundleSurfaceRunIds),
        inArray(testInteractionRuns.testInteractionId, dependencyIds)
      ),
    });
    dependencyRunByTestInteractionId = new Map(
      dependencyRuns.map(elementRun => [elementRun.testInteractionId, elementRun])
    );
  }

  const annotatedResult = activeResult.map(elementRun => {
    const testInteraction = elementById.get(elementRun.testInteractionId);
    let blocked = false;
    if (testInteraction?.dependencyTestInteractionId) {
      const dependencyRun = dependencyRunByTestInteractionId.get(
        testInteraction.dependencyTestInteractionId
      );
      blocked = !dependencyRun || dependencyRun.status === "pending";
    }
    return { ...elementRun, blocked };
  });

  if (isBatchMode) {
    const grouped: Record<string, typeof annotatedResult> = {};
    for (const id of surfaceRunIds) grouped[String(id)] = [];
    for (const row of annotatedResult) {
      const key = String(row.testSurfaceRunId);
      if (grouped[key]) grouped[key].push(row);
    }
    return c.json(successResponse(grouped));
  }

  return c.json(successResponse(annotatedResult));
});
```

- [ ] **Step 2: Verify the API compiles**

Run: `cd /Users/johnhuang/projects/testomniac_api && bun run build`
Expected: Success with no errors

- [ ] **Step 3: Manually test backward compatibility with singular param**

Run: `cd /Users/johnhuang/projects/testomniac_api && bun run dev`

Then in another terminal:
```bash
curl "http://localhost:8027/api/v1/scanner/test-interaction-runs?testSurfaceRunId=1&status=pending" \
  -H "X-Scanner-Key: <your-key>"
```
Expected: 200 response with array of interaction runs (flat array, not grouped), each with `blocked` field

- [ ] **Step 4: Test batch mode with plural param**

```bash
curl "http://localhost:8027/api/v1/scanner/test-interaction-runs?testSurfaceRunIds=1,2,3&status=pending" \
  -H "X-Scanner-Key: <your-key>"
```
Expected: 200 response with object keyed by surface run ID strings, each value is an array of interaction runs with `blocked` field

- [ ] **Step 5: Commit**

```bash
cd /Users/johnhuang/projects/testomniac_api
git add src/routes/scanner.ts
git commit -m "feat: support batch testSurfaceRunIds param and blocked annotation on test-interaction-runs"
```

---

### Task 3: Add `live-dashboard` route to runs-read

**Files:**
- Modify: `/Users/johnhuang/projects/testomniac_api/src/routes/runs-read.ts`

- [ ] **Step 1: Add the `live-dashboard` route handler**

In `/Users/johnhuang/projects/testomniac_api/src/routes/runs-read.ts`, add this route handler before the closing export (after the existing `/:runId/structure` handler around line 1112):

```typescript
runsReadRouter.get("/:runId/live-dashboard", async c => {
  const runId = Number(c.req.param("runId"));
  const testRun = await db.query.testRuns.findFirst({
    where: eq(testRuns.id, runId),
  });
  if (!testRun) return c.json(errorResponse("Test run not found"), 404);

  const rootRunId = testRun.rootTestRunId ?? testRun.id;
  const rootRun = await db.query.testRuns.findFirst({
    where: eq(testRuns.id, rootRunId),
  });
  if (!rootRun) return c.json(errorResponse("Root test run not found"), 404);

  // Run all 4 data loads in parallel
  const [findingsResult, elementContext, navData, structureData] =
    await Promise.all([
      loadRunFindings(runId),
      loadRunElementContext(runId),
      loadNavigationData(rootRun),
      loadStructureData(testRun, rootRun),
    ]);

  // Build summary
  const { findings } = findingsResult;
  const expertiseSummary: Record<
    string,
    { warnings: number; errors: number; findings: number }
  > = {};
  for (const finding of findings) {
    const expertiseName = extractExpertiseName(finding.title) ?? "ungrouped";
    const bucket = expertiseSummary[expertiseName] ?? {
      warnings: 0,
      errors: 0,
      findings: 0,
    };
    if (finding.type === "error") bucket.errors += 1;
    if (finding.type === "warning") bucket.warnings += 1;
    bucket.findings += 1;
    expertiseSummary[expertiseName] = bucket;
  }
  const recentFindings = findings
    .sort((left, right) => {
      const leftTime = left.createdAt ? new Date(left.createdAt).getTime() : 0;
      const rightTime = right.createdAt
        ? new Date(right.createdAt).getTime()
        : 0;
      return rightTime - leftTime;
    })
    .slice(0, 200)
    .map(finding => ({
      id: finding.id,
      type: finding.type,
      title: finding.title,
      description: finding.description,
      expertise: extractExpertiseName(finding.title),
      createdAt: finding.createdAt,
    }));

  const summary = {
    runId: testRun.id,
    rootRunId,
    runnerId: rootRun.runnerId,
    testEnvironmentId: rootRun.testEnvironmentId,
    status: rootRun.status,
    aiSummary: rootRun.aiSummary,
    pagesFound: rootRun.pagesFound,
    pageStatesFound: rootRun.pageStatesFound,
    testRunsCompleted: rootRun.testRunsCompleted,
    totalFindings: findings.length,
    expertiseSummary,
    recentFindings,
    completedAt: rootRun.completedAt,
    createdAt: rootRun.createdAt,
  };

  return c.json(
    successResponse({
      summary,
      pagesSummary: elementContext.pagesSummary,
      navigationMap: navData,
      structure: structureData,
    })
  );
});
```

- [ ] **Step 2: Extract `loadNavigationData` helper**

Add this helper function before the route handlers (after `loadRunElementContext`):

```typescript
async function loadNavigationData(rootRun: typeof testRuns.$inferSelect) {
  const rootRunId = rootRun.rootTestRunId ?? rootRun.id;
  const discovered =
    rootRun.testEnvironmentId == null
      ? []
      : await db.query.pages.findMany({
          where: eq(pages.testEnvironmentId, rootRun.testEnvironmentId),
        });
  const visits = await db.query.pageVisits.findMany({
    where: eq(pageVisits.testRunId, rootRun.id),
  });

  return {
    runId: rootRun.id,
    rootRunId,
    testEnvironmentId: rootRun.testEnvironmentId,
    discoveredPages: discovered.map(p => ({
      id: p.id,
      testEnvironmentId: p.testEnvironmentId,
      relativePath: p.relativePath,
      sourcePagePath: null,
      sourceLabel: null,
      isPublic: !p.requiresLogin,
      createdAt: p.createdAt,
      updatedAt: null,
    })),
    pageVisits: visits,
  };
}
```

- [ ] **Step 3: Extract `loadStructureData` helper**

Add this helper function after `loadNavigationData`:

```typescript
async function loadStructureData(
  testRun: typeof testRuns.$inferSelect,
  rootRun: typeof testRuns.$inferSelect
) {
  const rootRunId = rootRun.rootTestRunId ?? rootRun.id;

  if (!rootRun.testSurfaceBundleRunId) {
    return null;
  }

  const bundleRun = await db.query.testSurfaceBundleRuns.findFirst({
    where: eq(testSurfaceBundleRuns.id, rootRun.testSurfaceBundleRunId),
  });
  if (!bundleRun) return null;

  const bundle = await db.query.testSurfaceBundles.findFirst({
    where: eq(testSurfaceBundles.id, bundleRun.testSurfaceBundleId),
  });
  if (!bundle) return null;

  const bundleLinks = await db.query.testSurfaceBundleSurfaces.findMany({
    where: eq(testSurfaceBundleSurfaces.testSurfaceBundleId, bundle.id),
  });

  const surfaceIds = bundleLinks
    .map(link => link.testSurfaceId)
    .filter((value): value is number => typeof value === "number");

  const surfaces =
    surfaceIds.length === 0
      ? []
      : await db.query.testSurfaces.findMany({
          where: inArray(testSurfaces.id, surfaceIds),
        });

  const surfaceRuns = await db.query.testSurfaceRuns.findMany({
    where: eq(testSurfaceRuns.testSurfaceBundleRunId, bundleRun.id),
  });

  const interactionList =
    surfaceIds.length === 0
      ? []
      : await db.query.testInteractions.findMany({
          where: and(
            inArray(testInteractions.testSurfaceId, surfaceIds),
            eq(testInteractions.isActive, true)
          ),
        });

  const surfaceRunIds = surfaceRuns.map(sr => sr.id);
  const interactionRuns =
    surfaceRunIds.length === 0
      ? []
      : await db.query.testInteractionRuns.findMany({
          where: inArray(testInteractionRuns.testSurfaceRunId, surfaceRunIds),
        });

  const elementRunIds = interactionRuns.map(er => er.id);
  const structureFindings =
    elementRunIds.length === 0
      ? []
      : await db.query.testRunFindings.findMany({
          where: inArray(testRunFindings.testInteractionRunId, elementRunIds),
        });

  const surfaceRunsBySurfaceId = new Map<number, typeof surfaceRuns>();
  for (const sr of surfaceRuns) {
    const existing = surfaceRunsBySurfaceId.get(sr.testSurfaceId) ?? [];
    existing.push(sr);
    surfaceRunsBySurfaceId.set(sr.testSurfaceId, existing);
  }

  const interactionRunsByTestInteractionId = new Map<
    number,
    typeof interactionRuns
  >();
  for (const er of interactionRuns) {
    const testInteraction = interactionList.find(i => i.id === er.testInteractionId);
    if (!testInteraction) continue;
    const existing =
      interactionRunsByTestInteractionId.get(testInteraction.id) ?? [];
    existing.push(er);
    interactionRunsByTestInteractionId.set(testInteraction.id, existing);
  }

  const findingsByCaseRunId = new Map<number, typeof structureFindings>();
  for (const finding of structureFindings) {
    const existing =
      findingsByCaseRunId.get(finding.testInteractionRunId) ?? [];
    existing.push(finding);
    findingsByCaseRunId.set(finding.testInteractionRunId, existing);
  }

  const surfacesWithElements = surfaces
    .sort((left, right) => left.priority - right.priority)
    .map(surface => {
      const surfaceElements = interactionList
        .filter(ti => ti.testSurfaceId === surface.id)
        .sort((left, right) => left.priority - right.priority)
        .map(ti => {
          const runs = (
            interactionRunsByTestInteractionId.get(ti.id) ?? []
          ).map(er => ({
            ...er,
            findings: findingsByCaseRunId.get(er.id) ?? [],
          }));
          return { ...ti, interactionRuns: runs };
        });

      return {
        ...surface,
        surfaceRuns: surfaceRunsBySurfaceId.get(surface.id) ?? [],
        testInteractions: surfaceElements,
      };
    });

  return {
    runId: testRun.id,
    rootRunId,
    bundle,
    bundleRun,
    surfaces: surfacesWithElements,
  };
}
```

- [ ] **Step 4: Refactor `loadRunElementContext` to also build pages summary**

The existing `loadRunElementContext` returns raw `testInteractionRunIds`. For `live-dashboard`, we need the full pages-summary aggregation. Extend `loadRunElementContext` to accept an optional flag, or build the pages-summary inline in the dashboard handler.

The simplest approach: build pages-summary data inline in the `live-dashboard` handler, reusing the same logic from the existing `/:runId/pages-summary` handler. Replace the `elementContext.pagesSummary` reference in Step 1 with the inline build:

Replace the `live-dashboard` handler's usage of `elementContext` with a dedicated `loadPagesSummary` helper:

```typescript
async function loadPagesSummary(
  rootRun: typeof testRuns.$inferSelect,
  testInteractionRunIds: number[]
) {
  const runnerPages = await db.query.pages.findMany({
    where: eq(pages.runnerId, rootRun.runnerId),
  });
  if (runnerPages.length === 0) return [];

  const pageIds = runnerPages.map(page => page.id);
  const runnerPageStates = await db.query.pageStates.findMany({
    where: inArray(pageStates.pageId, pageIds),
  });
  const runnerTestInteractions = await db.query.testInteractions.findMany({
    where: and(
      eq(testInteractions.runnerId, rootRun.runnerId),
      eq(testInteractions.isActive, true)
    ),
  });
  const relevantCaseRuns =
    testInteractionRunIds.length === 0
      ? []
      : await db.query.testInteractionRuns.findMany({
          where: inArray(testInteractionRuns.id, testInteractionRunIds),
        });
  const pageFindings =
    testInteractionRunIds.length === 0
      ? []
      : await db.query.testRunFindings.findMany({
          where: inArray(
            testRunFindings.testInteractionRunId,
            testInteractionRunIds
          ),
        });

  const testInteractionById = new Map(
    runnerTestInteractions.map(ti => [ti.id, ti])
  );
  const elementRunById = new Map(
    relevantCaseRuns.map(er => [er.id, er])
  );
  const pageStateCounts = new Map<number, number>();
  const latestStateByPageId = new Map<
    number,
    (typeof runnerPageStates)[number]
  >();

  for (const state of runnerPageStates) {
    pageStateCounts.set(
      state.pageId,
      (pageStateCounts.get(state.pageId) ?? 0) + 1
    );
    const currentLatest = latestStateByPageId.get(state.pageId);
    if (!currentLatest || state.id > currentLatest.id) {
      latestStateByPageId.set(state.pageId, state);
    }
  }

  const buckets = new Map<
    number,
    {
      testInteractionIds: Set<number>;
      testInteractionRunIds: Set<number>;
      findings: number;
      errors: number;
      warnings: number;
      expertiseSummary: Record<
        string,
        { findings: number; errors: number; warnings: number }
      >;
    }
  >();

  for (const finding of pageFindings) {
    const elementRun = elementRunById.get(finding.testInteractionRunId);
    if (!elementRun) continue;
    const testInteraction = testInteractionById.get(elementRun.testInteractionId);
    const pageId = testInteraction?.pageId;
    if (!pageId) continue;

    const bucket = buckets.get(pageId) ?? {
      testInteractionIds: new Set<number>(),
      testInteractionRunIds: new Set<number>(),
      findings: 0,
      errors: 0,
      warnings: 0,
      expertiseSummary: {},
    };

    bucket.testInteractionIds.add(testInteraction.id);
    bucket.testInteractionRunIds.add(elementRun.id);
    bucket.findings += 1;
    if (finding.type === "error") bucket.errors += 1;
    if (finding.type === "warning") bucket.warnings += 1;

    const expertiseName = extractExpertiseName(finding.title) ?? "ungrouped";
    const expertiseBucket = bucket.expertiseSummary[expertiseName] ?? {
      findings: 0,
      errors: 0,
      warnings: 0,
    };
    expertiseBucket.findings += 1;
    if (finding.type === "error") expertiseBucket.errors += 1;
    if (finding.type === "warning") expertiseBucket.warnings += 1;
    bucket.expertiseSummary[expertiseName] = expertiseBucket;

    buckets.set(pageId, bucket);
  }

  const summaries = runnerPages.map(page => {
    const bucket = buckets.get(page.id);
    const latestState = latestStateByPageId.get(page.id);
    return {
      pageId: page.id,
      relativePath: page.relativePath,
      routeKey: page.routeKey,
      requiresLogin: page.requiresLogin,
      latestPageStateId: latestState?.id ?? null,
      latestScreenshotPath: latestState?.screenshotPath ?? null,
      pageStatesCount: pageStateCounts.get(page.id) ?? 0,
      testInteractionsCount: bucket?.testInteractionIds.size ?? 0,
      testInteractionRunsCount: bucket?.testInteractionRunIds.size ?? 0,
      findings: bucket?.findings ?? 0,
      errors: bucket?.errors ?? 0,
      warnings: bucket?.warnings ?? 0,
      expertiseSummary: bucket?.expertiseSummary ?? {},
    };
  });

  summaries.sort((left, right) => {
    if (right.findings !== left.findings) return right.findings - left.findings;
    return left.relativePath.localeCompare(right.relativePath);
  });

  return summaries;
}
```

- [ ] **Step 5: Update the `live-dashboard` handler to use helpers**

Replace the `live-dashboard` handler from Step 1 with the corrected version that uses all helpers:

```typescript
runsReadRouter.get("/:runId/live-dashboard", async c => {
  const runId = Number(c.req.param("runId"));
  const testRun = await db.query.testRuns.findFirst({
    where: eq(testRuns.id, runId),
  });
  if (!testRun) return c.json(errorResponse("Test run not found"), 404);

  const rootRunId = testRun.rootTestRunId ?? testRun.id;
  const rootRun = await db.query.testRuns.findFirst({
    where: eq(testRuns.id, rootRunId),
  });
  if (!rootRun) return c.json(errorResponse("Root test run not found"), 404);

  // Collect testInteractionRunIds for pages-summary
  const relatedRuns = await db.query.testRuns.findMany({
    where: or(
      eq(testRuns.id, rootRunId),
      eq(testRuns.rootTestRunId, rootRunId)
    ),
  });
  const testInteractionRunIds = relatedRuns
    .map(run => run.testInteractionRunId)
    .filter((value): value is number => typeof value === "number");

  // Run all 4 data loads in parallel
  const [findingsResult, pagesSummary, navigationMap, structure] =
    await Promise.all([
      loadRunFindings(runId),
      loadPagesSummary(rootRun, testInteractionRunIds),
      loadNavigationData(rootRun),
      loadStructureData(testRun, rootRun),
    ]);

  // Build summary from findings
  const { findings } = findingsResult;
  const expertiseSummary: Record<
    string,
    { warnings: number; errors: number; findings: number }
  > = {};
  for (const finding of findings) {
    const expertiseName = extractExpertiseName(finding.title) ?? "ungrouped";
    const bucket = expertiseSummary[expertiseName] ?? {
      warnings: 0,
      errors: 0,
      findings: 0,
    };
    if (finding.type === "error") bucket.errors += 1;
    if (finding.type === "warning") bucket.warnings += 1;
    bucket.findings += 1;
    expertiseSummary[expertiseName] = bucket;
  }
  const recentFindings = findings
    .sort((left, right) => {
      const leftTime = left.createdAt ? new Date(left.createdAt).getTime() : 0;
      const rightTime = right.createdAt
        ? new Date(right.createdAt).getTime()
        : 0;
      return rightTime - leftTime;
    })
    .slice(0, 200)
    .map(finding => ({
      id: finding.id,
      type: finding.type,
      title: finding.title,
      description: finding.description,
      expertise: extractExpertiseName(finding.title),
      createdAt: finding.createdAt,
    }));

  const summary = {
    runId: testRun.id,
    rootRunId,
    runnerId: rootRun.runnerId,
    testEnvironmentId: rootRun.testEnvironmentId,
    status: rootRun.status,
    aiSummary: rootRun.aiSummary,
    pagesFound: rootRun.pagesFound,
    pageStatesFound: rootRun.pageStatesFound,
    testRunsCompleted: rootRun.testRunsCompleted,
    totalFindings: findings.length,
    expertiseSummary,
    recentFindings,
    completedAt: rootRun.completedAt,
    createdAt: rootRun.createdAt,
  };

  return c.json(
    successResponse({
      summary,
      pagesSummary,
      navigationMap,
      structure,
    })
  );
});
```

- [ ] **Step 6: Verify the API compiles**

Run: `cd /Users/johnhuang/projects/testomniac_api && bun run build`
Expected: Success with no errors

- [ ] **Step 7: Manually test the endpoint**

```bash
curl "http://localhost:8027/api/v1/runs/5/live-dashboard" \
  -H "Authorization: Bearer <token>"
```
Expected: 200 response with `{ success: true, data: { summary: {...}, pagesSummary: [...], navigationMap: {...}, structure: {...} } }`

- [ ] **Step 8: Commit**

```bash
cd /Users/johnhuang/projects/testomniac_api
git add src/routes/runs-read.ts
git commit -m "feat: add live-dashboard endpoint consolidating summary, pages-summary, navigation-map, and structure"
```

---

### Task 4: Add `getOpenTestInteractionRunsBatch` to runner service API client

**Files:**
- Modify: `/Users/johnhuang/projects/testomniac_runner_service/src/api/client.ts:918-925`

- [ ] **Step 1: Add the batch method**

In `/Users/johnhuang/projects/testomniac_runner_service/src/api/client.ts`, add this method after `getOpenTestInteractionRuns` (around line 925):

```typescript
  getOpenTestInteractionRunsBatch(
    testSurfaceRunIds: number[]
  ): Promise<BatchTestInteractionRunsResponse> {
    const ids = testSurfaceRunIds.join(",");
    return this.get(
      `/test-interaction-runs?testSurfaceRunIds=${ids}&status=pending`
    );
  }
```

- [ ] **Step 2: Add the import for `BatchTestInteractionRunsResponse`**

In the imports at the top of `client.ts`, add `BatchTestInteractionRunsResponse` to the import from `@sudobility/testomniac_types`:

```typescript
import type {
  // ... existing imports ...
  BatchTestInteractionRunsResponse,
} from "@sudobility/testomniac_types";
```

- [ ] **Step 3: Verify it compiles**

Run: `cd /Users/johnhuang/projects/testomniac_runner_service && npx tsc --noEmit`
Expected: Success with no errors

- [ ] **Step 4: Commit**

```bash
cd /Users/johnhuang/projects/testomniac_runner_service
git add src/api/client.ts
git commit -m "feat: add getOpenTestInteractionRunsBatch method for batched interaction run queries"
```

---

### Task 5: Update `loadPendingInteractionRuns` to use batch method

**Files:**
- Modify: `/Users/johnhuang/projects/testomniac_runner_service/src/orchestrator/runner.ts:868-879`

- [ ] **Step 1: Replace `loadPendingInteractionRuns`**

In `/Users/johnhuang/projects/testomniac_runner_service/src/orchestrator/runner.ts`, replace the function at lines 868-879:

Old:
```typescript
async function loadPendingInteractionRuns(
  api: ApiClient,
  openSurfaceRuns: TestSurfaceRunResponse[]
): Promise<PendingInteractionRunsBySurface[]> {
  return Promise.all(
    openSurfaceRuns.map(async surfaceRun => ({
      surfaceRun,
      eligibleRuns: await api.getOpenTestInteractionRuns(surfaceRun.id),
      allPendingRuns: await api.getOpenTestInteractionRuns(surfaceRun.id, true),
    }))
  );
}
```

New:
```typescript
async function loadPendingInteractionRuns(
  api: ApiClient,
  openSurfaceRuns: TestSurfaceRunResponse[]
): Promise<PendingInteractionRunsBySurface[]> {
  if (openSurfaceRuns.length === 0) return [];
  const ids = openSurfaceRuns.map(sr => sr.id);
  const batchResult = await api.getOpenTestInteractionRunsBatch(ids);
  return openSurfaceRuns.map(surfaceRun => {
    const allPendingRuns = batchResult[String(surfaceRun.id)] ?? [];
    return {
      surfaceRun,
      eligibleRuns: allPendingRuns.filter(r => !r.blocked),
      allPendingRuns,
    };
  });
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd /Users/johnhuang/projects/testomniac_runner_service && npx tsc --noEmit`
Expected: Success with no errors

- [ ] **Step 3: Run existing tests**

Run: `cd /Users/johnhuang/projects/testomniac_runner_service && vitest run`
Expected: All existing tests pass

- [ ] **Step 4: Commit**

```bash
cd /Users/johnhuang/projects/testomniac_runner_service
git add src/orchestrator/runner.ts
git commit -m "feat: use batched getOpenTestInteractionRunsBatch in loadPendingInteractionRuns"
```

---

### Task 6: Add `RunLiveDashboard` type and `getRunLiveDashboard` client method

**Files:**
- Modify: `/Users/johnhuang/projects/testomniac_client/src/types.ts`
- Modify: `/Users/johnhuang/projects/testomniac_client/src/network/TestomniacClient.ts`

- [ ] **Step 1: Add `RunLiveDashboard` type**

In `/Users/johnhuang/projects/testomniac_client/src/types.ts`, add after `RunStructure` (around line 163):

```typescript
export interface RunLiveDashboard {
  summary: RunSummary;
  pagesSummary: RunPageSummary[];
  navigationMap: RunNavigationMap;
  structure: RunStructure | null;
}
```

- [ ] **Step 2: Add `QUERY_KEYS.runLiveDashboard`**

In the `QUERY_KEYS` object in `/Users/johnhuang/projects/testomniac_client/src/types.ts`, add:

```typescript
  runLiveDashboard: (runId: number) =>
    ['testomniac', 'run', runId, 'live-dashboard'] as const,
```

- [ ] **Step 3: Export `RunLiveDashboard` from index**

In `/Users/johnhuang/projects/testomniac_client/src/index.ts`, add `RunLiveDashboard` to the type exports:

```typescript
export {
  type FirebaseIdToken,
  type RunNavigationMap,
  type RunPageDetailSummary,
  type RunPageSummary,
  type RunStructure,
  type RunSummary,
  type RunLiveDashboard,
  QUERY_KEYS,
  DEFAULT_STALE_TIME,
  DEFAULT_GC_TIME,
} from './types';
```

- [ ] **Step 4: Add `getRunLiveDashboard` method to `TestomniacClient`**

In `/Users/johnhuang/projects/testomniac_client/src/network/TestomniacClient.ts`, add after `getRunStructure` (around line 306):

```typescript
  async getRunLiveDashboard(
    runId: number,
    token: FirebaseIdToken
  ): Promise<BaseResponse<RunLiveDashboard>> {
    const url = buildUrl(this.baseUrl, `/api/v1/runs/${runId}/live-dashboard`);
    const response = await this.networkClient.get(url, {
      headers: createAuthHeaders(token),
    });
    return validateResponse<RunLiveDashboard>(
      response.data,
      'getRunLiveDashboard'
    );
  }
```

- [ ] **Step 5: Add `RunLiveDashboard` import in TestomniacClient.ts**

Add `RunLiveDashboard` to the import from `'../types'` at the top of TestomniacClient.ts.

- [ ] **Step 6: Verify it compiles**

Run: `cd /Users/johnhuang/projects/testomniac_client && npx tsc --noEmit`
Expected: Success with no errors

- [ ] **Step 7: Commit**

```bash
cd /Users/johnhuang/projects/testomniac_client
git add src/types.ts src/network/TestomniacClient.ts src/index.ts
git commit -m "feat: add RunLiveDashboard type and getRunLiveDashboard client method"
```

---

### Task 7: Create `useRunLiveDashboard` hook and export it

**Files:**
- Create: `/Users/johnhuang/projects/testomniac_client/src/hooks/useRunLiveDashboard.ts`
- Modify: `/Users/johnhuang/projects/testomniac_client/src/hooks/index.ts`

- [ ] **Step 1: Create the hook file**

Create `/Users/johnhuang/projects/testomniac_client/src/hooks/useRunLiveDashboard.ts`:

```typescript
import { useQuery } from '@tanstack/react-query';
import type { NetworkClient } from '@sudobility/types';
import { TestomniacClient } from '../network/TestomniacClient';
import { DEFAULT_STALE_TIME, type FirebaseIdToken, QUERY_KEYS } from '../types';

interface UseRunLiveDashboardConfig {
  networkClient: NetworkClient;
  baseUrl: string;
  runId: number;
  token: FirebaseIdToken;
  enabled?: boolean;
  refetchInterval?: number | false;
}

export function useRunLiveDashboard(config: UseRunLiveDashboardConfig) {
  const {
    networkClient,
    baseUrl,
    runId,
    token,
    enabled = true,
    refetchInterval = false,
  } = config;
  const client = new TestomniacClient({ baseUrl, networkClient });

  const query = useQuery({
    queryKey: QUERY_KEYS.runLiveDashboard(runId),
    queryFn: () => client.getRunLiveDashboard(runId, token),
    enabled: enabled && !!runId && !!token,
    staleTime: DEFAULT_STALE_TIME,
    refetchInterval,
  });

  return {
    dashboard: query.data?.data ?? null,
    isLoading: query.isLoading,
    error: query.error?.message ?? query.data?.error ?? null,
    refetch: query.refetch,
  };
}
```

- [ ] **Step 2: Export the hook**

In `/Users/johnhuang/projects/testomniac_client/src/hooks/index.ts`, add after the `useRunStructure` export (line 10):

```typescript
export { useRunLiveDashboard } from './useRunLiveDashboard';
```

- [ ] **Step 3: Verify it compiles**

Run: `cd /Users/johnhuang/projects/testomniac_client && npx tsc --noEmit`
Expected: Success with no errors

- [ ] **Step 4: Commit**

```bash
cd /Users/johnhuang/projects/testomniac_client
git add src/hooks/useRunLiveDashboard.ts src/hooks/index.ts
git commit -m "feat: add useRunLiveDashboard hook for consolidated polling"
```

---

### Task 8: Update extension SidePanel to use `live-dashboard`

**Files:**
- Modify: `/Users/johnhuang/projects/testomniac_extension/src/sidepanel/SidePanel.tsx:1106-1197`

- [ ] **Step 1: Replace the 4 fetch calls with single `live-dashboard` call**

In `/Users/johnhuang/projects/testomniac_extension/src/sidepanel/SidePanel.tsx`, replace the `fetchLiveData` function body (lines 1106-1197).

Old (lines 1106-1119):
```typescript
      Promise.all([
        fetch(`${API_URL}/api/v1/runs/${progress.scanId}/summary`, {
          headers: { Authorization: `Bearer ${token}` },
        }).then(response => response.json()),
        fetch(`${API_URL}/api/v1/runs/${progress.scanId}/pages-summary`, {
          headers: { Authorization: `Bearer ${token}` },
        }).then(response => response.json()),
        fetch(`${API_URL}/api/v1/runs/${progress.scanId}/navigation-map`, {
          headers: { Authorization: `Bearer ${token}` },
        }).then(response => response.json()),
        fetch(`${API_URL}/api/v1/runs/${progress.scanId}/structure`, {
          headers: { Authorization: `Bearer ${token}` },
        }).then(response => response.json()),
      ])
        .then(([summaryData, pagesData, mapData, structureData]) => {
```

New:
```typescript
      fetch(`${API_URL}/api/v1/runs/${progress.scanId}/live-dashboard`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(response => response.json())
        .then((dashboardData: { success: boolean; data: { summary: unknown; pagesSummary: unknown; navigationMap: unknown; structure: unknown } }) => {
          if (cancelled || !dashboardData?.success) return;
          const { summary: summaryData, pagesSummary: pagesData, navigationMap: mapData, structure: structureData } = dashboardData.data;
```

The rest of the `.then()` body stays the same, but each section no longer checks `.success` on individual responses since they're already unwrapped. Update the processing:

- Replace `if (summaryData?.success && summaryData.data)` with `if (summaryData)` and use `summaryData` directly instead of `summaryData.data`
- Replace `if (pagesData?.success && pagesData.data)` with `if (pagesData)` and use `pagesData` directly instead of `pagesData.data`
- Replace `if (mapData?.success && mapData.data)` with `if (mapData)` and use `mapData` directly instead of `mapData.data`
- Replace `if (structureData?.success && structureData.data)` with `if (structureData)` and use `structureData` directly instead of `structureData.data`

Close the `.then()` with the same error handler:
```typescript
        .catch(err =>
          logPanel('fetch-live-data:failed', {
            error: err instanceof Error ? err.message : String(err),
          })
        );
```

- [ ] **Step 2: Verify type-check passes**

Run: `cd /Users/johnhuang/projects/testomniac_extension && bun run type-check`
Expected: Success with no errors

- [ ] **Step 3: Verify dev build works**

Run: `cd /Users/johnhuang/projects/testomniac_extension && bun run build`
Expected: Build completes successfully

- [ ] **Step 4: Commit**

```bash
cd /Users/johnhuang/projects/testomniac_extension
git add src/sidepanel/SidePanel.tsx
git commit -m "feat: use consolidated live-dashboard endpoint for side panel polling"
```

---

### Task 9: End-to-end verification

**Files:** None (testing only)

- [ ] **Step 1: Start the API server**

Run: `cd /Users/johnhuang/projects/testomniac_api && bun run dev`

- [ ] **Step 2: Verify batch test-interaction-runs endpoint**

```bash
# Singular param (backward compat)
curl -s "http://localhost:8027/api/v1/scanner/test-interaction-runs?testSurfaceRunId=1&status=pending" \
  -H "X-Scanner-Key: <key>" | jq '.data | length'

# Batch param
curl -s "http://localhost:8027/api/v1/scanner/test-interaction-runs?testSurfaceRunIds=1,2,3&status=pending" \
  -H "X-Scanner-Key: <key>" | jq '.data | keys'
```

Expected: Singular returns array, batch returns object with string keys "1", "2", "3"

- [ ] **Step 3: Verify live-dashboard endpoint**

```bash
curl -s "http://localhost:8027/api/v1/runs/5/live-dashboard" \
  -H "Authorization: Bearer <token>" | jq '.data | keys'
```

Expected: `["summary", "pagesSummary", "navigationMap", "structure"]`

- [ ] **Step 4: Load extension and verify polling**

1. Build extension: `cd /Users/johnhuang/projects/testomniac_extension && bun run build`
2. Load in Chrome (chrome://extensions → Load unpacked → select `dist/`)
3. Open side panel and start a scan
4. Monitor API server logs — should see single `GET /api/v1/runs/:id/live-dashboard` calls every 2s instead of 4 separate calls

- [ ] **Step 5: Verify runner still works**

Run a test scan using the extension or runner to verify that `loadPendingInteractionRuns` correctly uses the batch endpoint and splits `eligibleRuns` vs `allPendingRuns` by `blocked` field.
