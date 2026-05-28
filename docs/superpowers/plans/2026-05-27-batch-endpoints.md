# Batch Scanner Endpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce sequential scanner API calls by adding batch endpoints for test-interactions (+runs), test-run-findings, and scaffolds.

**Architecture:** Three new batch endpoints in testomniac_api that accept arrays. Runner service ApiClient gets batch methods. Generator loops refactored to collect items then batch. All work on main branch, deployed via push_all.sh.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, Vitest

---

## File Map

| Project | File | Action | Purpose |
|---------|------|--------|---------|
| testomniac_types | `src/index.ts` | Modify | Add `BatchTestInteractionItem`, `BatchTestInteractionResult` |
| testomniac_api | `src/routes/scanner.ts` | Modify | Add 3 batch endpoints |
| testomniac_runner_service | `src/api/client.ts` | Modify | Add 3 batch client methods |
| testomniac_runner_service | `src/analyzer/page-analyzer/generators/forms.ts` | Modify | Use batch |
| testomniac_runner_service | `src/analyzer/page-analyzer/generators/scaffolds.ts` | Modify | Use batch |
| testomniac_runner_service | `src/analyzer/page-analyzer/generators/hover-follow-up.ts` | Modify | Use batch |
| testomniac_runner_service | `src/analyzer/page-analyzer/generators/navigation.ts` | Modify | Use batch |
| testomniac_runner_service | `src/analyzer/page-analyzer/generators/content.ts` | Modify | Use batch |
| testomniac_runner_service | `src/analyzer/page-analyzer/generators/dialogs.ts` | Modify | Use batch |
| testomniac_runner_service | `src/analyzer/page-analyzer/generators/keyboard-disclosure.ts` | Modify | Use batch |
| testomniac_runner_service | `src/analyzer/page-analyzer/generators/variants.ts` | Modify | Use batch |
| testomniac_runner_service | `src/analyzer/page-analyzer/generators/semantic-journeys.ts` | Modify | Use batch |
| testomniac_runner_service | `src/orchestrator/test-interaction-executor.ts` | Modify | Use batch for findings |
| testomniac_runner_service | `src/analyzer/page-analyzer/index.ts` | Modify | Use batch for scaffolds |

---

### Task 1: Add batch types to testomniac_types

**Files:**
- Modify: `/Users/johnhuang/projects/testomniac_types/src/index.ts`

- [ ] **Step 1: Add `BatchTestInteractionItem` and `BatchTestInteractionResult`**

In `/Users/johnhuang/projects/testomniac_types/src/index.ts`, add after the `InsertTestInteractionRequest` interface (around line 1301):

```typescript
export interface BatchTestInteractionItem extends InsertTestInteractionRequest {
  testSurfaceRunId: number;
}

export interface BatchTestInteractionResult {
  testInteraction: TestInteractionResponse;
  testInteractionRun: TestInteractionRunResponse;
}
```

- [ ] **Step 2: Verify build**

Run: `cd /Users/johnhuang/projects/testomniac_types && bun run build`
Expected: Success

- [ ] **Step 3: Commit**

```bash
cd /Users/johnhuang/projects/testomniac_types
git add src/index.ts
git commit -m "feat: add BatchTestInteractionItem and BatchTestInteractionResult types"
```

---

### Task 2: Add batch test-interactions endpoint to API

**Files:**
- Modify: `/Users/johnhuang/projects/testomniac_api/src/routes/scanner.ts`

- [ ] **Step 1: Add `POST /test-interactions/batch` handler**

In `/Users/johnhuang/projects/testomniac_api/src/routes/scanner.ts`, add after the existing `POST /test-interactions` handler (after line 1168):

```typescript
scannerRouter.post("/test-interactions/batch", async c => {
  const { items } = await c.req.json<{
    items: Array<
      InsertTestInteractionRequest & {
        testSurfaceRunId: number;
        existingTestInteractionId?: number;
      }
    >;
  }>();

  if (!Array.isArray(items) || items.length === 0) {
    return c.json(successResponse([]));
  }

  const results: Array<{
    testInteraction: typeof testInteractions.$inferSelect;
    testInteractionRun: typeof testInteractionRuns.$inferSelect;
  }> = [];

  for (const item of items) {
    // --- Begin: same logic as POST /test-interactions ---
    const existingTestInteractionId = Number(item.existingTestInteractionId);
    const generatedTestInteraction = item.testInteraction as TestInteraction & {
      generatedKey?: string;
    };
    const isGenerated = Boolean(
      (item as InsertTestInteractionRequest & { isGenerated?: boolean })
        .isGenerated
    );
    const generatedKey =
      generatedTestInteraction.generatedKey?.trim() || null;
    const incomingSteps = Array.isArray(item.testInteraction.steps)
      ? item.testInteraction.steps
      : [];
    const firstIncomingStep = incomingSteps[0] as
      | { action?: { actionType?: string; path?: string } }
      | undefined;
    const firstIncomingActionType =
      firstIncomingStep?.action?.actionType?.trim() || null;
    const firstIncomingPath =
      firstIncomingStep?.action?.path?.trim() || null;

    let testInteraction: typeof testInteractions.$inferSelect;

    if (
      item.testSurfaceId &&
      (item.testInteraction.title || generatedKey)
    ) {
      const generatedTitleMatch =
        isGenerated &&
        !generatedKey &&
        item.testInteraction.title &&
        firstIncomingActionType &&
        firstIncomingPath
          ? ((
              await db.query.testInteractions.findMany({
                where: and(
                  eq(testInteractions.runnerId, item.runnerId),
                  eq(testInteractions.testSurfaceId, item.testSurfaceId),
                  eq(testInteractions.title, item.testInteraction.title),
                  eq(testInteractions.isGenerated, true),
                  eq(testInteractions.isActive, true)
                ),
              })
            ).find(candidate => {
              const candidateSteps = Array.isArray(candidate.stepsJson)
                ? candidate.stepsJson
                : [];
              const firstCandidateStep = candidateSteps[0] as
                | { action?: { actionType?: string; path?: string } }
                | undefined;
              return (
                firstCandidateStep?.action?.actionType?.trim() ===
                  firstIncomingActionType &&
                firstCandidateStep?.action?.path?.trim() === firstIncomingPath
              );
            }) ?? null)
          : null;

      const existing =
        (existingTestInteractionId
          ? await db.query.testInteractions.findFirst({
              where: and(
                eq(testInteractions.id, existingTestInteractionId),
                eq(testInteractions.testSurfaceId, item.testSurfaceId)
              ),
            })
          : null) ??
        (generatedKey
          ? await db.query.testInteractions.findFirst({
              where: and(
                eq(testInteractions.testSurfaceId, item.testSurfaceId),
                eq(testInteractions.generatedKey, generatedKey)
              ),
            })
          : null) ??
        generatedTitleMatch ??
        (!isGenerated && item.testInteraction.title
          ? await db.query.testInteractions.findFirst({
              where: and(
                eq(testInteractions.testSurfaceId, item.testSurfaceId),
                eq(testInteractions.title, item.testInteraction.title)
              ),
            })
          : null);

      if (existing) {
        const nextDependencyTestInteractionId =
          item.testInteraction.dependencyTestInteractionId === existing.id
            ? existing.dependencyTestInteractionId
            : item.testInteraction.dependencyTestInteractionId;
        const nextGeneratedKey =
          generatedKey ?? existing.generatedKey ?? null;
        const [updated] = await db
          .update(testInteractions)
          .set({
            title: item.testInteraction.title,
            testType: item.testInteraction.type,
            sizeClass: item.testInteraction.sizeClass,
            surfaceTags: item.testInteraction.surface_tags,
            priority: item.testInteraction.priority,
            scaffoldId: item.testInteraction.scaffoldId,
            patternType: item.testInteraction.patternType,
            dependencyTestInteractionId: nextDependencyTestInteractionId,
            pageId: item.testInteraction.page_id,
            targetPageId: item.testInteraction.target_page_id,
            testEnvironmentId: item.testEnvironmentId,
            personaId: item.testInteraction.persona_id,
            useCaseId: item.testInteraction.use_case_id,
            startingPageStateId: item.testInteraction.startingPageStateId,
            startingPath: item.testInteraction.startingPath,
            stepsJson: item.testInteraction.steps,
            globalExpectationsJson: item.testInteraction.globalExpectations,
            estimatedDurationMs: item.testInteraction.estimatedDurationMs,
            uid: item.testInteraction.uid,
            generatedKey: nextGeneratedKey,
            isActive: true,
            isGenerated: isGenerated || existing.isGenerated,
            generatedAt: new Date(),
          })
          .where(eq(testInteractions.id, existing.id))
          .returning();
        testInteraction = updated;
      } else {
        const [row] = await db
          .insert(testInteractions)
          .values({
            runnerId: item.runnerId,
            testSurfaceId: item.testSurfaceId,
            title: item.testInteraction.title,
            testType: item.testInteraction.type,
            sizeClass: item.testInteraction.sizeClass,
            surfaceTags: item.testInteraction.surface_tags,
            priority: item.testInteraction.priority,
            scaffoldId: item.testInteraction.scaffoldId,
            patternType: item.testInteraction.patternType,
            dependencyTestInteractionId:
              item.testInteraction.dependencyTestInteractionId,
            pageId: item.testInteraction.page_id,
            targetPageId: item.testInteraction.target_page_id,
            testEnvironmentId: item.testEnvironmentId,
            personaId: item.testInteraction.persona_id,
            useCaseId: item.testInteraction.use_case_id,
            startingPageStateId: item.testInteraction.startingPageStateId,
            startingPath: item.testInteraction.startingPath,
            stepsJson: item.testInteraction.steps,
            globalExpectationsJson: item.testInteraction.globalExpectations,
            estimatedDurationMs: item.testInteraction.estimatedDurationMs,
            uid: item.testInteraction.uid,
            generatedKey,
            isActive: true,
            isGenerated,
          })
          .returning();
        testInteraction = row;
      }
    } else {
      const [row] = await db
        .insert(testInteractions)
        .values({
          runnerId: item.runnerId,
          testSurfaceId: item.testSurfaceId,
          title: item.testInteraction.title,
          testType: item.testInteraction.type,
          sizeClass: item.testInteraction.sizeClass,
          surfaceTags: item.testInteraction.surface_tags,
          priority: item.testInteraction.priority,
          scaffoldId: item.testInteraction.scaffoldId,
          patternType: item.testInteraction.patternType,
          dependencyTestInteractionId:
            item.testInteraction.dependencyTestInteractionId,
          pageId: item.testInteraction.page_id,
          targetPageId: item.testInteraction.target_page_id,
          testEnvironmentId: item.testEnvironmentId,
          personaId: item.testInteraction.persona_id,
          useCaseId: item.testInteraction.use_case_id,
          startingPageStateId: item.testInteraction.startingPageStateId,
          startingPath: item.testInteraction.startingPath,
          stepsJson: item.testInteraction.steps,
          globalExpectationsJson: item.testInteraction.globalExpectations,
          estimatedDurationMs: item.testInteraction.estimatedDurationMs,
          uid: item.testInteraction.uid,
          generatedKey,
          isActive: true,
          isGenerated,
        })
        .returning();
      testInteraction = row;
    }
    // --- End: same logic as POST /test-interactions ---

    // --- Begin: same logic as POST /test-interaction-runs ---
    let testInteractionRun: typeof testInteractionRuns.$inferSelect;

    if (item.testSurfaceRunId != null) {
      const currentSurfaceRun = await db.query.testSurfaceRuns.findFirst({
        where: eq(testSurfaceRuns.id, item.testSurfaceRunId),
      });

      if (currentSurfaceRun) {
        const bundleSurfaceRuns = await db.query.testSurfaceRuns.findMany({
          where: eq(
            testSurfaceRuns.testSurfaceBundleRunId,
            currentSurfaceRun.testSurfaceBundleRunId
          ),
        });
        const bundleSurfaceRunIds = bundleSurfaceRuns.map(sr => sr.id);

        const existingRun = await db.query.testInteractionRuns.findFirst({
          where:
            bundleSurfaceRunIds.length > 0
              ? and(
                  eq(
                    testInteractionRuns.testInteractionId,
                    testInteraction.id
                  ),
                  inArray(
                    testInteractionRuns.testSurfaceRunId,
                    bundleSurfaceRunIds
                  )
                )
              : and(
                  eq(
                    testInteractionRuns.testInteractionId,
                    testInteraction.id
                  ),
                  eq(
                    testInteractionRuns.testSurfaceRunId,
                    item.testSurfaceRunId
                  )
                ),
          orderBy: (testInteractionRuns, { asc }) => [
            asc(testInteractionRuns.id),
          ],
        });

        if (existingRun && existingRun.status !== "cancelled") {
          testInteractionRun = existingRun;
        } else {
          const [row] = await db
            .insert(testInteractionRuns)
            .values({
              testInteractionId: testInteraction.id,
              testSurfaceRunId: item.testSurfaceRunId,
            })
            .returning();
          testInteractionRun = row;
        }
      } else {
        const [row] = await db
          .insert(testInteractionRuns)
          .values({
            testInteractionId: testInteraction.id,
            testSurfaceRunId: item.testSurfaceRunId,
          })
          .returning();
        testInteractionRun = row;
      }
    } else {
      const [row] = await db
        .insert(testInteractionRuns)
        .values({
          testInteractionId: testInteraction.id,
          testSurfaceRunId: item.testSurfaceRunId,
        })
        .returning();
      testInteractionRun = row;
    }
    // --- End: same logic as POST /test-interaction-runs ---

    results.push({ testInteraction, testInteractionRun });
  }

  return c.json(successResponse(results));
});
```

- [ ] **Step 2: Verify build**

Run: `cd /Users/johnhuang/projects/testomniac_api && bun run build`
Expected: Success

- [ ] **Step 3: Commit**

```bash
cd /Users/johnhuang/projects/testomniac_api
git add src/routes/scanner.ts
git commit -m "feat: add POST /test-interactions/batch endpoint"
```

---

### Task 3: Add batch test-run-findings/ensure endpoint to API

**Files:**
- Modify: `/Users/johnhuang/projects/testomniac_api/src/routes/scanner.ts`

- [ ] **Step 1: Add `POST /test-run-findings/ensure-batch` handler**

Add after the existing `POST /test-run-findings/ensure` handler:

```typescript
scannerRouter.post("/test-run-findings/ensure-batch", async c => {
  const { items } = await c.req.json<{
    items: Array<{
      testRunId: number;
      testInteractionRunId: number;
      type: string;
      priority: number;
      title: string;
      description: string;
      path?: string;
    }>;
  }>();

  if (!Array.isArray(items) || items.length === 0) {
    return c.json(successResponse([]));
  }

  const results: Array<typeof testRunFindings.$inferSelect & { interactionRunIds: number[] }> = [];

  for (const item of items) {
    const normalizedTitle = normalizeFindingText(item.title);
    const path = item.path ?? null;

    const conditions = [
      eq(testRunFindings.testRunId, item.testRunId),
      eq(testRunFindings.type, item.type),
    ];
    if (path) {
      conditions.push(eq(testRunFindings.path, path));
    }

    const candidates = await db
      .select()
      .from(testRunFindings)
      .where(and(...conditions));

    const existing = candidates.find(
      f => normalizeFindingText(f.title) === normalizedTitle
    );

    if (existing) {
      try {
        await db.insert(testRunFindingRuns).values({
          testRunFindingId: existing.id,
          testInteractionRunId: item.testInteractionRunId,
        });
      } catch {
        // Unique constraint violation — already linked
      }

      const junctionRows = await db
        .select({
          testInteractionRunId: testRunFindingRuns.testInteractionRunId,
        })
        .from(testRunFindingRuns)
        .where(eq(testRunFindingRuns.testRunFindingId, existing.id));

      results.push({
        ...existing,
        interactionRunIds: junctionRows.map(r => r.testInteractionRunId),
      });
    } else {
      const [row] = await db
        .insert(testRunFindings)
        .values({
          testRunId: item.testRunId,
          testInteractionRunId: item.testInteractionRunId,
          type: item.type,
          priority: item.priority,
          title: item.title,
          description: item.description,
          path,
        })
        .returning();

      await db.insert(testRunFindingRuns).values({
        testRunFindingId: row.id,
        testInteractionRunId: item.testInteractionRunId,
      });

      results.push({
        ...row,
        interactionRunIds: [item.testInteractionRunId],
      });
    }
  }

  return c.json(successResponse(results));
});
```

- [ ] **Step 2: Verify build**

Run: `cd /Users/johnhuang/projects/testomniac_api && bun run build`
Expected: Success

- [ ] **Step 3: Commit**

```bash
cd /Users/johnhuang/projects/testomniac_api
git add src/routes/scanner.ts
git commit -m "feat: add POST /test-run-findings/ensure-batch endpoint"
```

---

### Task 4: Add batch scaffolds endpoint to API

**Files:**
- Modify: `/Users/johnhuang/projects/testomniac_api/src/routes/scanner.ts`

- [ ] **Step 1: Add `POST /scaffolds/batch` handler**

Add after the existing `POST /scaffolds` handler:

```typescript
scannerRouter.post("/scaffolds/batch", async c => {
  const { items } = await c.req.json<{
    items: Array<FindOrCreateScaffoldRequest>;
  }>();

  if (!Array.isArray(items) || items.length === 0) {
    return c.json(successResponse([]));
  }

  const results: Array<typeof scaffolds.$inferSelect> = [];

  for (const item of items) {
    let htmlElement = await db.query.htmlElements.findFirst({
      where: eq(htmlElements.hash, item.hash),
    });
    if (!htmlElement) {
      const [row] = await db
        .insert(htmlElements)
        .values({ html: item.html, hash: item.hash })
        .returning();
      htmlElement = row;
    }

    const existing = await db.query.scaffolds.findFirst({
      where: and(
        eq(scaffolds.runnerId, item.runnerId),
        eq(scaffolds.type, item.type)
      ),
    });
    if (existing) {
      if (
        existing.htmlElementId !== htmlElement.id ||
        existing.htmlHash !== item.hash
      ) {
        const [updated] = await db
          .update(scaffolds)
          .set({ htmlElementId: htmlElement.id, htmlHash: item.hash })
          .where(eq(scaffolds.id, existing.id))
          .returning();
        results.push(updated ?? existing);
      } else {
        results.push(existing);
      }
    } else {
      const [scaffold] = await db
        .insert(scaffolds)
        .values({
          runnerId: item.runnerId,
          type: item.type,
          htmlElementId: htmlElement.id,
          htmlHash: item.hash,
        })
        .returning();
      results.push(scaffold);
    }
  }

  return c.json(successResponse(results));
});
```

- [ ] **Step 2: Verify build**

Run: `cd /Users/johnhuang/projects/testomniac_api && bun run build`
Expected: Success

- [ ] **Step 3: Commit**

```bash
cd /Users/johnhuang/projects/testomniac_api
git add src/routes/scanner.ts
git commit -m "feat: add POST /scaffolds/batch endpoint"
```

---

### Task 5: Add batch methods to runner service ApiClient

**Files:**
- Modify: `/Users/johnhuang/projects/testomniac_runner_service/src/api/client.ts`

- [ ] **Step 1: Add import for new types**

Add `BatchTestInteractionItem` and `BatchTestInteractionResult` to the import from `@sudobility/testomniac_types`:

```typescript
import type {
  // ... existing imports ...
  BatchTestInteractionItem,
  BatchTestInteractionResult,
} from "@sudobility/testomniac_types";
```

- [ ] **Step 2: Add `ensureTestInteractionBatch` method**

Add after `ensureTestInteraction` (around line 792):

```typescript
  ensureTestInteractionBatch(
    items: BatchTestInteractionItem[]
  ): Promise<BatchTestInteractionResult[]> {
    if (items.length === 0) return Promise.resolve([]);
    return this.post("/test-interactions/batch", {
      items: items.map(item => ({
        ...item,
        isGenerated: true,
      })),
    });
  }
```

- [ ] **Step 3: Add `ensureTestRunFindingBatch` method**

Add after `ensureTestRunFinding` (around line 573):

```typescript
  ensureTestRunFindingBatch(
    items: EnsureTestRunFindingRequest[]
  ): Promise<TestRunFindingResponse[]> {
    if (items.length === 0) return Promise.resolve([]);
    return this.post("/test-run-findings/ensure-batch", { items });
  }
```

- [ ] **Step 4: Add `findOrCreateScaffoldBatch` method**

Add after `findOrCreateScaffold` (around line 653):

```typescript
  findOrCreateScaffoldBatch(
    items: FindOrCreateScaffoldRequest[]
  ): Promise<ScaffoldResponse[]> {
    if (items.length === 0) return Promise.resolve([]);
    return this.post("/scaffolds/batch", { items });
  }
```

- [ ] **Step 5: Copy rebuilt types dist to node_modules**

```bash
cd /Users/johnhuang/projects/testomniac_types && bun run build
cp /Users/johnhuang/projects/testomniac_types/dist/index.d.ts /Users/johnhuang/projects/testomniac_runner_service/node_modules/@sudobility/testomniac_types/dist/index.d.ts
cp /Users/johnhuang/projects/testomniac_types/dist/index.js /Users/johnhuang/projects/testomniac_runner_service/node_modules/@sudobility/testomniac_types/dist/index.js
```

- [ ] **Step 6: Verify compile**

Run: `cd /Users/johnhuang/projects/testomniac_runner_service && npx tsc --noEmit`
Expected: Success

- [ ] **Step 7: Commit**

```bash
cd /Users/johnhuang/projects/testomniac_runner_service
git add src/api/client.ts
git commit -m "feat: add ensureTestInteractionBatch, ensureTestRunFindingBatch, findOrCreateScaffoldBatch methods"
```

---

### Task 6: Refactor generator loops to use batch

**Files:**
- Modify: `/Users/johnhuang/projects/testomniac_runner_service/src/analyzer/page-analyzer/generators/content.ts`
- Modify: `/Users/johnhuang/projects/testomniac_runner_service/src/analyzer/page-analyzer/generators/dialogs.ts`
- Modify: `/Users/johnhuang/projects/testomniac_runner_service/src/analyzer/page-analyzer/generators/keyboard-disclosure.ts`
- Modify: `/Users/johnhuang/projects/testomniac_runner_service/src/analyzer/page-analyzer/generators/variants.ts`
- Modify: `/Users/johnhuang/projects/testomniac_runner_service/src/analyzer/page-analyzer/generators/scaffolds.ts`
- Modify: `/Users/johnhuang/projects/testomniac_runner_service/src/analyzer/page-analyzer/generators/navigation.ts`
- Modify: `/Users/johnhuang/projects/testomniac_runner_service/src/analyzer/page-analyzer/generators/hover-follow-up.ts`
- Modify: `/Users/johnhuang/projects/testomniac_runner_service/src/analyzer/page-analyzer/generators/semantic-journeys.ts`
- Modify: `/Users/johnhuang/projects/testomniac_runner_service/src/analyzer/page-analyzer/generators/forms.ts`

All 9 generator files follow the same pattern. For each file, the refactor replaces:

```typescript
// OLD: sequential calls inside loop
for (const item of items) {
  const testInteraction = /* build interaction */;
  desiredKeys.push(analyzer.getGeneratedKey(testInteraction));
  const tc = await api.ensureTestInteraction(runnerId, surface.id, testInteraction, testEnvironmentId);
  await api.createTestInteractionRun({ testInteractionId: tc.id, testSurfaceRunId: surfaceRun.id });
}
```

With:

```typescript
// NEW: collect then batch
const batchItems: BatchTestInteractionItem[] = [];
for (const item of items) {
  const testInteraction = /* build interaction */;
  desiredKeys.push(analyzer.getGeneratedKey(testInteraction));
  batchItems.push({
    runnerId,
    testSurfaceId: surface.id,
    testInteraction,
    testEnvironmentId,
    testSurfaceRunId: surfaceRun.id,
  });
}
await api.ensureTestInteractionBatch(batchItems);
```

- [ ] **Step 1: Add `BatchTestInteractionItem` import**

In each generator file, add the import:

```typescript
import type { BatchTestInteractionItem } from "@sudobility/testomniac_types";
```

- [ ] **Step 2: Refactor `content.ts`**

In `/Users/johnhuang/projects/testomniac_runner_service/src/analyzer/page-analyzer/generators/content.ts`, replace the loop (lines 53-104) that calls `ensureTestInteraction` + `createTestInteractionRun`:

Change from sequential calls to collecting `batchItems`, then call `api.ensureTestInteractionBatch(batchItems)` after the loop. Keep the `desiredKeys.push(...)` inside the loop since it only needs local data.

- [ ] **Step 3: Refactor `dialogs.ts`**

Same pattern in `/Users/johnhuang/projects/testomniac_runner_service/src/analyzer/page-analyzer/generators/dialogs.ts` (lines 78-89).

- [ ] **Step 4: Refactor `keyboard-disclosure.ts`**

In `/Users/johnhuang/projects/testomniac_runner_service/src/analyzer/page-analyzer/generators/keyboard-disclosure.ts` (lines 65-87). Note: this file also calls `analyzer.markGeneratedSelectorForBasePath()` after each item — move those calls to iterate over `batchItems` after the batch call.

- [ ] **Step 5: Refactor `variants.ts`**

Same pattern as keyboard-disclosure in `/Users/johnhuang/projects/testomniac_runner_service/src/analyzer/page-analyzer/generators/variants.ts` (lines 65-86). Also has `markGeneratedSelectorForBasePath` calls.

- [ ] **Step 6: Refactor `scaffolds.ts`**

In `/Users/johnhuang/projects/testomniac_runner_service/src/analyzer/page-analyzer/generators/scaffolds.ts` (lines 53-82). Inner loop over `scaffoldItems`.

- [ ] **Step 7: Refactor `navigation.ts`**

In `/Users/johnhuang/projects/testomniac_runner_service/src/analyzer/page-analyzer/generators/navigation.ts` (lines 115-135). The existing try-catch around `createTestInteractionRun` is no longer needed since the batch endpoint handles dedup internally.

- [ ] **Step 8: Refactor `hover-follow-up.ts`**

In `/Users/johnhuang/projects/testomniac_runner_service/src/analyzer/page-analyzer/generators/hover-follow-up.ts` (lines 172-191). Uses `context.api` instead of `api`.

- [ ] **Step 9: Refactor `semantic-journeys.ts`**

In `/Users/johnhuang/projects/testomniac_runner_service/src/analyzer/page-analyzer/generators/semantic-journeys.ts` (lines 44-55).

- [ ] **Step 10: Refactor `forms.ts`**

In `/Users/johnhuang/projects/testomniac_runner_service/src/analyzer/page-analyzer/generators/forms.ts` (lines 45-198). This is the most complex — has multiple inner loops (search tests, positive, negative fields, correction, password). Collect all items across all inner loops into one `batchItems` array per outer form iteration, batch at end of each form.

- [ ] **Step 11: Verify compile**

Run: `cd /Users/johnhuang/projects/testomniac_runner_service && npx tsc --noEmit`
Expected: Success

- [ ] **Step 12: Run tests**

Run: `cd /Users/johnhuang/projects/testomniac_runner_service && npx vitest run`
Expected: All tests pass

- [ ] **Step 13: Commit**

```bash
cd /Users/johnhuang/projects/testomniac_runner_service
git add src/analyzer/page-analyzer/generators/
git commit -m "feat: refactor generator loops to use ensureTestInteractionBatch"
```

---

### Task 7: Refactor executor findings loops to use batch

**Files:**
- Modify: `/Users/johnhuang/projects/testomniac_runner_service/src/orchestrator/test-interaction-executor.ts`

- [ ] **Step 1: Refactor expertise evaluation loop (lines 588-662)**

Replace sequential `ensureTestRunFinding` calls with a collect-then-batch pattern. The local dedup checks (`analyzer?.hasReportedPageFinding`, `analyzer?.hasReportedDescription`) and `continue` statements stay in the loop — only surviving items get collected for batching.

Change from:

```typescript
for (const outcome of outcomes) {
  // ... skip checks ...
  await api.ensureTestRunFinding({...});
  events.onFindingCreated({...});
  await analyzer?.markPageFindingReported(...);
  await analyzer?.markReportedDescription(...);
}
```

To:

```typescript
const findingItems: EnsureTestRunFindingRequest[] = [];
const findingEvents: Array<{ type: string; priority: number; title: string; description: string }> = [];

for (const outcome of outcomes) {
  // ... skip checks stay the same ...
  const findingTitle = `[${expertise.name}] ${outcome.expected}`;
  const priority = derivePriority(outcome);
  findingItems.push({
    testRunId: testRun.id,
    testInteractionRunId: testInteractionRun.id,
    type: findingType,
    priority,
    title: findingTitle,
    description: outcome.observed,
    path: findingPath,
  });
  findingEvents.push({
    type: findingType,
    priority,
    title: findingTitle,
    description: outcome.observed,
  });
  await analyzer?.markPageFindingReported(currentPath, findingTitle, outcome.observed);
  await analyzer?.markReportedDescription(outcome.observed);
  // ... 404 tracking stays ...
}

// Batch after all expertise/group loops complete
```

After all the expertise/group nested loops finish, batch the collected items:

```typescript
if (findingItems.length > 0) {
  await api.ensureTestRunFindingBatch(findingItems);
}
for (const event of findingEvents) {
  events.onFindingCreated(event);
}
```

- [ ] **Step 2: Refactor page health loop (lines 683-709)**

Same pattern — collect findings, batch after loop:

```typescript
const healthFindingItems: EnsureTestRunFindingRequest[] = [];
const healthFindingEvents: Array<{ type: string; priority: number; title: string; description: string }> = [];

for (const issue of healthIssues) {
  const healthKey = `page-health:${issue.type}:${currentPath}`;
  if (await analyzer?.hasReportedFindingByKey(healthKey)) continue;
  const findingTitle = `[page-health] ${issue.title}`;
  const findingType = issue.severity === "error" ? "error" : "warning";
  const priority = derivePageHealthPriority(issue.severity);
  healthFindingItems.push({
    testRunId: testRun.id,
    testInteractionRunId: testInteractionRun.id,
    type: findingType,
    priority,
    title: findingTitle,
    description: issue.description,
    path: findingPath,
  });
  healthFindingEvents.push({
    type: findingType,
    priority,
    title: findingTitle,
    description: issue.description,
  });
  await analyzer?.markReportedFindingByKey(healthKey);
}
if (healthFindingItems.length > 0) {
  await api.ensureTestRunFindingBatch(healthFindingItems);
}
for (const event of healthFindingEvents) {
  events.onFindingCreated(event);
}
```

- [ ] **Step 3: Keep slow step detection as single call**

The slow step detection (lines 472-490) has a `break` after the first finding — only ever creates 0 or 1 findings. Keep it as the existing single `ensureTestRunFinding` call.

- [ ] **Step 4: Add import for `EnsureTestRunFindingRequest`**

Add to imports at top of file:

```typescript
import type { EnsureTestRunFindingRequest } from "@sudobility/testomniac_types";
```

- [ ] **Step 5: Verify compile**

Run: `cd /Users/johnhuang/projects/testomniac_runner_service && npx tsc --noEmit`
Expected: Success

- [ ] **Step 6: Run tests**

Run: `cd /Users/johnhuang/projects/testomniac_runner_service && npx vitest run`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
cd /Users/johnhuang/projects/testomniac_runner_service
git add src/orchestrator/test-interaction-executor.ts
git commit -m "feat: refactor findings loops to use ensureTestRunFindingBatch"
```

---

### Task 8: Refactor ensureScaffolds to use batch

**Files:**
- Modify: `/Users/johnhuang/projects/testomniac_runner_service/src/analyzer/page-analyzer/index.ts`

- [ ] **Step 1: Refactor `ensureScaffolds` method (lines 1154-1182)**

Replace sequential `findOrCreateScaffold` calls with batch:

```typescript
private async ensureScaffolds(
  context: AnalyzerContext
): Promise<Map<string, number>> {
  const scaffoldIdsBySelector = new Map<string, number>();
  if (context.scaffolds.length === 0) return scaffoldIdsBySelector;

  const items = context.scaffolds.map(scaffold => ({
    runnerId: context.runnerId,
    type: scaffold.type,
    html: scaffold.outerHtml,
    hash: scaffold.hash,
  }));

  const results = await context.api.findOrCreateScaffoldBatch(items);

  for (let i = 0; i < context.scaffolds.length; i++) {
    const scaffold = context.scaffolds[i];
    const result = results[i];
    scaffoldIdsBySelector.set(scaffold.selector, result.id);

    if (!result.screenshotPath && context.screenshotPath) {
      try {
        await context.api.updateScaffoldScreenshot(
          result.id,
          context.screenshotPath
        );
      } catch {
        // Best effort
      }
    }
  }

  return scaffoldIdsBySelector;
}
```

- [ ] **Step 2: Verify compile**

Run: `cd /Users/johnhuang/projects/testomniac_runner_service && npx tsc --noEmit`
Expected: Success

- [ ] **Step 3: Run tests**

Run: `cd /Users/johnhuang/projects/testomniac_runner_service && npx vitest run`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
cd /Users/johnhuang/projects/testomniac_runner_service
git add src/analyzer/page-analyzer/index.ts
git commit -m "feat: refactor ensureScaffolds to use findOrCreateScaffoldBatch"
```

---

### Task 9: Deploy via push_all.sh

- [ ] **Step 1: Run push_all.sh**

```bash
cd /Users/johnhuang/projects/testomniac_app && bash scripts/push_all.sh
```

Expected: All projects with changes are validated, version-bumped, and pushed to main.

- [ ] **Step 2: Verify all projects passed**

Check output for `[SUCCESS] All projects updated, validated, versioned, and pushed`.
