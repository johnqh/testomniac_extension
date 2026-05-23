# Finding Deduplication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deduplicate findings by path (ignoring query params) with a 1:many finding-to-interaction-run relationship using an ensure pattern.

**Architecture:** Add a `path` field and `testRunId` to findings for path-based dedup. Replace the 1:1 `testInteractionRunId` FK with a junction table `testRunFindingRuns`. The runner service uses `ensureTestRunFinding` which upserts by `type + normalizedTitle + path + testRunId`. Merge 404 page-load and network-error findings into one.

**Tech Stack:** Drizzle ORM (PostgreSQL), TypeScript, Hono (API), testomniac_runner_service

---

### Task 1: Update types in testomniac_types

**Files:**
- Modify: `/Users/johnhuang/projects/testomniac_types/src/index.ts:1516-1534`

- [ ] **Step 1: Add EnsureTestRunFindingRequest and update TestRunFindingResponse**

In `/Users/johnhuang/projects/testomniac_types/src/index.ts`, add the new request type after `CreateTestRunFindingRequest` (line 1523) and update the response type:

```typescript
export interface EnsureTestRunFindingRequest {
  testRunId: number;
  testInteractionRunId: number;
  type: FindingType;
  priority: number;
  title: string;
  description: string;
  path?: string;
}
```

Update `TestRunFindingResponse` (lines 1525-1534) to:

```typescript
export interface TestRunFindingResponse {
  id: number;
  testRunId: number | null;
  path: string | null;
  expertiseRuleId: number | null;
  type: string;
  priority: number;
  title: string;
  description: string;
  interactionRunIds: number[];
  createdAt: string | null;
}
```

Keep `CreateTestRunFindingRequest` unchanged for backward compatibility.

- [ ] **Step 2: Build and verify**

```bash
cd /Users/johnhuang/projects/testomniac_types
bun run build
```

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: add EnsureTestRunFindingRequest and update TestRunFindingResponse for finding dedup"
```

---

### Task 2: Add schema migration in testomniac_api

**Files:**
- Modify: `/Users/johnhuang/projects/testomniac_api/src/db/schema.ts:798-811`

- [ ] **Step 1: Update testRunFindings table and add junction table**

In `/Users/johnhuang/projects/testomniac_api/src/db/schema.ts`, replace the `testRunFindings` table definition (lines 798-811) with:

```typescript
export const testRunFindings = starterSchema.table("test_run_findings", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  testRunId: bigserial("test_run_id", { mode: "number" })
    .references(() => testRuns.id)
    .notNull(),
  testInteractionRunId: bigserial("test_interaction_run_id", {
    mode: "number",
  }).references(() => testInteractionRuns.id),
  expertiseRuleId: bigserial("expertise_rule_id", {
    mode: "number",
  }).references(() => expertiseRules.id),
  type: text("type").notNull(),
  priority: integer("priority").notNull().default(3),
  title: text("title").notNull(),
  description: text("description").notNull(),
  path: text("path"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});
```

Note: we keep `testInteractionRunId` for now as nullable — it will be dropped in a later task after all read code migrates to the junction table.

Add the junction table after `testRunFindings`:

```typescript
export const testRunFindingRuns = starterSchema.table(
  "test_run_finding_runs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    testRunFindingId: bigserial("test_run_finding_id", { mode: "number" })
      .references(() => testRunFindings.id)
      .notNull(),
    testInteractionRunId: bigserial("test_interaction_run_id", {
      mode: "number",
    })
      .references(() => testInteractionRuns.id)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  }
);
```

Also add `testRunFindingRuns` to the db exports in `/Users/johnhuang/projects/testomniac_api/src/db/index.ts` if there is a barrel export.

- [ ] **Step 2: Generate and run migration**

```bash
cd /Users/johnhuang/projects/testomniac_api
bunx drizzle-kit generate
bunx drizzle-kit migrate
```

If drizzle-kit is not used for migrations, apply the SQL manually:

```sql
ALTER TABLE test_run_findings ADD COLUMN test_run_id bigint REFERENCES test_runs(id);
ALTER TABLE test_run_findings ADD COLUMN path text;
ALTER TABLE test_run_findings ALTER COLUMN test_interaction_run_id DROP NOT NULL;

CREATE TABLE test_run_finding_runs (
  id bigserial PRIMARY KEY,
  test_run_finding_id bigint NOT NULL REFERENCES test_run_findings(id),
  test_interaction_run_id bigint NOT NULL REFERENCES test_interaction_runs(id),
  created_at timestamptz DEFAULT NOW(),
  UNIQUE (test_run_finding_id, test_interaction_run_id)
);

-- Backfill test_run_id from existing data
UPDATE test_run_findings f
SET test_run_id = (
  SELECT tr.id FROM test_runs tr
  JOIN test_surface_bundle_runs tbr ON tbr.id = tr.test_surface_bundle_run_id
  JOIN test_surface_runs tsr ON tsr.test_surface_bundle_run_id = tbr.id
  JOIN test_interaction_runs tir ON tir.test_surface_run_id = tsr.id
  WHERE tir.id = f.test_interaction_run_id
  LIMIT 1
);

-- Backfill junction table from existing 1:1 relationships
INSERT INTO test_run_finding_runs (test_run_finding_id, test_interaction_run_id)
SELECT id, test_interaction_run_id FROM test_run_findings
WHERE test_interaction_run_id IS NOT NULL;

-- Make test_run_id NOT NULL after backfill
ALTER TABLE test_run_findings ALTER COLUMN test_run_id SET NOT NULL;
```

- [ ] **Step 3: Build and verify**

```bash
bun run typecheck
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add path and testRunId columns to findings, add junction table"
```

---

### Task 3: Add ensure endpoint in testomniac_api

**Files:**
- Modify: `/Users/johnhuang/projects/testomniac_api/src/routes/scanner.ts:1586-1641`

- [ ] **Step 1: Add POST /test-run-findings/ensure endpoint**

In `/Users/johnhuang/projects/testomniac_api/src/routes/scanner.ts`, add the new endpoint BEFORE the existing `POST /test-run-findings` endpoint (before line 1586). Import `testRunFindingRuns` at the top if not already imported.

```typescript
scannerRouter.post("/test-run-findings/ensure", async c => {
  const body = await c.req.json<{
    testRunId: number;
    testInteractionRunId: number;
    type: string;
    priority: number;
    title: string;
    description: string;
    path?: string;
  }>();

  const normalizedTitle = normalizeFindingText(body.title);
  const path = body.path ?? null;

  // Look for existing finding with same type + normalized title + path within this run
  const conditions = [
    eq(testRunFindings.testRunId, body.testRunId),
    eq(testRunFindings.type, body.type),
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
    // Add junction record (ignore duplicate)
    try {
      await db.insert(testRunFindingRuns).values({
        testRunFindingId: existing.id,
        testInteractionRunId: body.testInteractionRunId,
      });
    } catch {
      // Unique constraint violation — already linked
    }

    // Return with interactionRunIds
    const junctionRows = await db
      .select({ testInteractionRunId: testRunFindingRuns.testInteractionRunId })
      .from(testRunFindingRuns)
      .where(eq(testRunFindingRuns.testRunFindingId, existing.id));

    return c.json(
      successResponse({
        ...existing,
        interactionRunIds: junctionRows.map(r => r.testInteractionRunId),
      })
    );
  }

  // Create new finding
  const [row] = await db
    .insert(testRunFindings)
    .values({
      testRunId: body.testRunId,
      type: body.type,
      priority: body.priority,
      title: body.title,
      description: body.description,
      path,
    })
    .returning();

  // Create junction record
  await db.insert(testRunFindingRuns).values({
    testRunFindingId: row.id,
    testInteractionRunId: body.testInteractionRunId,
  });

  return c.json(
    successResponse({
      ...row,
      interactionRunIds: [body.testInteractionRunId],
    }),
    201
  );
});
```

- [ ] **Step 2: Update clearSupersededFindings endpoint**

Replace the DELETE endpoint at lines 352-384 with:

```typescript
scannerRouter.delete(
  "/test-interaction-runs/:id/superseded-findings",
  async c => {
    const id = Number(c.req.param("id"));
    const currentRun = await db.query.testInteractionRuns.findFirst({
      where: eq(testInteractionRuns.id, id),
    });

    if (!currentRun) {
      return c.json(errorResponse("Test interaction run not found"), 404);
    }

    const siblingRuns = await db.query.testInteractionRuns.findMany({
      where: eq(
        testInteractionRuns.testInteractionId,
        currentRun.testInteractionId
      ),
    });
    const supersededRunIds = siblingRuns
      .map(run => run.id)
      .filter(runId => runId !== currentRun.id);

    if (supersededRunIds.length === 0) {
      return c.json(successResponse(null));
    }

    // Delete junction records for superseded runs
    await db
      .delete(testRunFindingRuns)
      .where(
        inArray(testRunFindingRuns.testInteractionRunId, supersededRunIds)
      );

    // Delete orphaned findings (no remaining junction records)
    // Also clean up legacy findings that used the old testInteractionRunId column
    await db
      .delete(testRunFindings)
      .where(inArray(testRunFindings.testInteractionRunId, supersededRunIds));

    return c.json(successResponse(null));
  }
);
```

- [ ] **Step 3: Update loadRunFindings in runs-read.ts**

In `/Users/johnhuang/projects/testomniac_api/src/routes/runs-read.ts`, update `loadRunFindings` (lines 33-88) to also query via the junction table and return `interactionRunIds`:

Replace the findings query (lines 77-85) with:

```typescript
  // Load findings directly linked via testRunId
  const directFindings = await db.query.testRunFindings.findMany({
    where: eq(testRunFindings.testRunId, rootRunId),
  });

  // Also load legacy findings via interaction run IDs
  const legacyFindings =
    interactionRunIds.length === 0
      ? []
      : await db.query.testRunFindings.findMany({
          where: and(
            inArray(testRunFindings.testInteractionRunId, interactionRunIds),
            isNull(testRunFindings.testRunId)
          ),
        });

  // Merge and deduplicate by ID
  const findingMap = new Map<number, typeof directFindings[0]>();
  for (const f of [...directFindings, ...legacyFindings]) {
    findingMap.set(f.id, f);
  }
  const allFindings = Array.from(findingMap.values());

  // Load junction records for all findings
  const findingIds = allFindings.map(f => f.id);
  const junctionRecords =
    findingIds.length === 0
      ? []
      : await db
          .select()
          .from(testRunFindingRuns)
          .where(inArray(testRunFindingRuns.testRunFindingId, findingIds));

  const junctionByFindingId = new Map<number, number[]>();
  for (const jr of junctionRecords) {
    const arr = junctionByFindingId.get(jr.testRunFindingId) ?? [];
    arr.push(jr.testInteractionRunId);
    junctionByFindingId.set(jr.testRunFindingId, arr);
  }

  const findings = allFindings.map(f => ({
    ...f,
    interactionRunIds: junctionByFindingId.get(f.id) ??
      (f.testInteractionRunId ? [f.testInteractionRunId] : []),
  }));
```

Add necessary imports at the top of runs-read.ts:

```typescript
import { testRunFindingRuns } from "../db";
import { isNull } from "drizzle-orm";
```

- [ ] **Step 4: Build and verify**

```bash
cd /Users/johnhuang/projects/testomniac_api
bun run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add ensure finding endpoint, update read queries for junction table"
```

---

### Task 4: Add ensureTestRunFinding to runner service ApiClient

**Files:**
- Modify: `/Users/johnhuang/projects/testomniac_runner_service/src/api/client.ts:516-520`

- [ ] **Step 1: Add ensureTestRunFinding method**

In `/Users/johnhuang/projects/testomniac_runner_service/src/api/client.ts`, add after the `createTestRunFinding` method (line 520):

```typescript
  ensureTestRunFinding(
    params: EnsureTestRunFindingRequest
  ): Promise<TestRunFindingResponse> {
    return this.post("/test-run-findings/ensure", params);
  }
```

Add `EnsureTestRunFindingRequest` to the import from `@sudobility/testomniac_types` at the top of the file.

- [ ] **Step 2: Build and verify**

```bash
cd /Users/johnhuang/projects/testomniac_runner_service
bun run build
```

- [ ] **Step 3: Commit**

```bash
git add src/api/client.ts
git commit -m "feat: add ensureTestRunFinding method to ApiClient"
```

---

### Task 5: Update test-interaction-executor to use ensureTestRunFinding

**Files:**
- Modify: `/Users/johnhuang/projects/testomniac_runner_service/src/orchestrator/test-interaction-executor.ts`

- [ ] **Step 1: Update all three finding creation sites**

The executor needs `testRunId` which comes from `testRun.id`. The `path` is extracted from the current URL.

**Call 1 (lines 598-604) — Expectation failures.** Replace:

```typescript
            await api.createTestRunFinding({
              testInteractionRunId: testInteractionRun.id,
              type: findingType,
              priority,
              title: findingTitle,
              description: outcome.observed,
            });
```

with:

```typescript
            await api.ensureTestRunFinding({
              testRunId: testRun.id,
              testInteractionRunId: testInteractionRun.id,
              type: findingType,
              priority,
              title: findingTitle,
              description: outcome.observed,
              path: currentPath,
            });
```

Note: `currentPath` is already defined earlier in the executor at line 464: `const currentPath = \`${currentUrlParsed.pathname}${currentUrlParsed.search}\`;` — but we need just the pathname without query params. Add a new variable after line 464:

```typescript
    const findingPath = currentUrlParsed.pathname;
```

Then use `findingPath` instead of `currentPath` in all ensure calls.

**Call 2 (lines 641-647) — Page health issues.** Replace:

```typescript
        await api.createTestRunFinding({
          testInteractionRunId: testInteractionRun.id,
          type: findingType,
          priority,
          title: findingTitle,
          description: issue.description,
        });
```

with:

```typescript
        await api.ensureTestRunFinding({
          testRunId: testRun.id,
          testInteractionRunId: testInteractionRun.id,
          type: findingType,
          priority,
          title: findingTitle,
          description: issue.description,
          path: findingPath,
        });
```

**Call 3 (lines 859-865) — Test execution errors.** Replace:

```typescript
      await api.createTestRunFinding({
        testInteractionRunId: testInteractionRun.id,
        type: "error",
        priority: FindingPriority.Crash,
        title: `Test execution error`,
        description: errorMessage,
      });
```

with:

```typescript
      let errorPath: string | undefined;
      try {
        errorPath = new URL(await adapter.getUrl()).pathname;
      } catch {
        // URL may not be available after crash
      }
      await api.ensureTestRunFinding({
        testRunId: testRun.id,
        testInteractionRunId: testInteractionRun.id,
        type: "error",
        priority: FindingPriority.Crash,
        title: `Test execution error`,
        description: errorMessage,
        path: errorPath,
      });
```

- [ ] **Step 2: Build and test**

```bash
cd /Users/johnhuang/projects/testomniac_runner_service
bun run build
bun run test
```

- [ ] **Step 3: Commit**

```bash
git add src/orchestrator/test-interaction-executor.ts
git commit -m "feat: switch finding creation to ensureTestRunFinding with path-based dedup"
```

---

### Task 6: Merge 404 page-load and network-error findings

**Files:**
- Modify: `/Users/johnhuang/projects/testomniac_runner_service/src/orchestrator/test-interaction-executor.ts`

- [ ] **Step 1: Add 404 merge logic in the finding emission loop**

In the executor, after the expectation evaluation loop (after line 618), add logic to detect and suppress the redundant network-error finding when a page-load 404 was already reported.

Before the loop at line 560, add tracking:

```typescript
    let reported404Path: string | null = null;
```

Inside the outcomes loop (around line 583), after creating a finding for a page-load 404, record it:

```typescript
            // Track if we reported a 404 page-load error so we can suppress
            // the redundant network-error finding for the same URL
            if (
              outcome.result === "error" &&
              outcome.observed.includes("Page returned HTTP 404")
            ) {
              reported404Path = findingPath;
            }
```

Then, before creating each finding (at line 584), add a check to suppress network-error findings that duplicate a 404:

```typescript
          const findingType = getFindingTypeForOutcome(outcome);
          if (findingType) {
            const findingTitle = `[${expertise.name}] ${outcome.expected}`;

            // Suppress network-error finding when a 404 page-load error
            // was already reported for the same path
            if (
              reported404Path === findingPath &&
              outcome.expected.includes("No network errors") &&
              outcome.observed.includes("404")
            ) {
              continue;
            }
```

- [ ] **Step 2: Build and test**

```bash
cd /Users/johnhuang/projects/testomniac_runner_service
bun run build
bun run test
```

- [ ] **Step 3: Commit**

```bash
git add src/orchestrator/test-interaction-executor.ts
git commit -m "fix: suppress redundant network-error finding when 404 page-load already reported"
```

---

### Task 7: Update extension dedup wrapper

**Files:**
- Modify: `/Users/johnhuang/projects/testomniac_extension/src/background/index.ts:55-84`

- [ ] **Step 1: Update createDedupApiClient to wrap ensureTestRunFinding**

Replace the `createDedupApiClient` function (lines 55-84) with:

```typescript
function createDedupApiClient(baseUrl: string, key: string): ApiClient {
  const client = new ApiClient(baseUrl, key);
  const seenKeys = new Set<string>();
  const origEnsure = client.ensureTestRunFinding.bind(client);

  client.ensureTestRunFinding = async (
    params: Parameters<ApiClient['ensureTestRunFinding']>[0]
  ) => {
    const normTitle = normalizeFindingText(params.title);
    const dedupKey = `${params.type}\0${normTitle}\0${params.path ?? ''}`;
    if (seenKeys.has(dedupKey)) {
      LOG(`[dedup] Skipping duplicate finding: ${params.title}`);
      return {
        id: 0,
        testRunId: params.testRunId,
        path: params.path ?? null,
        expertiseRuleId: null,
        type: params.type,
        priority: params.priority,
        title: params.title,
        description: params.description,
        interactionRunIds: [params.testInteractionRunId],
        createdAt: null,
      };
    }
    seenKeys.add(dedupKey);
    return origEnsure(params);
  };

  return client;
}
```

- [ ] **Step 2: Build and verify**

```bash
cd /Users/johnhuang/projects/testomniac_extension
bun run type-check
bun run build
```

- [ ] **Step 3: Commit**

```bash
git add src/background/index.ts
git commit -m "feat: update dedup wrapper to use ensureTestRunFinding with path-based key"
```

---

### Task 8: Update app finding display components

**Files:**
- Modify: `/Users/johnhuang/projects/testomniac_app/src/pages/FindingsListPage.tsx:138`
- Modify: `/Users/johnhuang/projects/testomniac_app/src/pages/PageDetailPage.tsx:249,259`

- [ ] **Step 1: Update FindingsListPage to show interactionRunIds**

In `FindingsListPage.tsx`, replace the reference to `finding.testInteractionRunId` (line 138):

```typescript
                      Run #{finding.testInteractionRunId}
```

with:

```typescript
                      {(finding.interactionRunIds?.length ?? 0) > 0
                        ? `Run #${finding.interactionRunIds.join(', #')}`
                        : finding.testInteractionRunId
                          ? `Run #${finding.testInteractionRunId}`
                          : ''}
```

- [ ] **Step 2: Update PageDetailPage finding references**

In `PageDetailPage.tsx`, update the `key` prop at line 249 and text at line 259 to handle the new shape. Replace `signal.testInteractionRunId` with `signal.interactionRunIds?.[0] ?? signal.testInteractionRunId ?? signal.id`:

At line 249:
```typescript
                    key={signal.interactionRunIds?.[0] ?? signal.testInteractionRunId ?? signal.id}
```

At line 259:
```typescript
                          Case run #{signal.interactionRunIds?.[0] ?? signal.testInteractionRunId}
```

- [ ] **Step 3: Build and verify**

```bash
cd /Users/johnhuang/projects/testomniac_app
bun run type-check
```

- [ ] **Step 4: Commit**

```bash
git add src/pages/FindingsListPage.tsx src/pages/PageDetailPage.tsx
git commit -m "feat: update finding display to handle interactionRunIds array"
```

---

### Task 9: Push all projects

- [ ] **Step 1: Run push_all.sh**

```bash
cd /Users/johnhuang/projects/testomniac_app
bash scripts/push_all.sh
```

This will update dependencies, validate, version bump, and push all projects in dependency order.
