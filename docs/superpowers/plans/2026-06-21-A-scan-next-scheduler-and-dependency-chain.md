# Plan A — `/scan/next` Server-Side Scheduler + Dependency Chain

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Target repos:** `testomniac_types` (base), then `testomniac_api`. Both publish via npm; `testomniac_types` must publish before `testomniac_api` builds against it, and both before Plan B (runner_service) can consume them.

**Goal:** Make the `/scan/next` response's `next` field an *authoritative* scheduler result — same interaction ordering the runner computes today — and bundle the selected interaction's full dependency chain into it, so the runner can drive its loop entirely from `next` (Plan B) without re-reading bundle state.

**Architecture:** Port the runner's pure selection algorithm (surface-execution-group ordering, hover-priority, `activeDependencyBranch` continuity) into a server module `scan-scheduler.ts`. `selectNextInteraction` loads the same candidate data the runner fetches today (open surface runs + eligible/blocked pending interaction runs + surfaces + interactions) — but as in-process DB queries co-located with the database — runs the ported algorithm, then walks `dependencyTestInteractionId` to attach the full chain. The win is that selection inputs move from client-over-network reads to server-local DB queries.

**Tech Stack:** TypeScript, Bun, Vitest, Drizzle + raw `postgres.js`, Hono.

## Global Constraints

- Package manager: **Bun only** (`bun install`, `bun test`). Never npm/yarn/pnpm.
- Publish/dependency order (push_all): `testomniac_types` → `testomniac_api` → `testomniac_runner_service` → `testomniac_runner`/`testomniac_extension`. A consumer cannot build against an unpublished producer.
- `postgres.js` returns BIGSERIAL/int8 as **strings** — every ID read from raw SQL must be wrapped in `Number()`.
- `CHAR(N)` columns are space-padded — `.trim()` before comparing.
- Verify gate per repo: `bun run verify` = `typecheck && lint && test && build`.
- Behavior parity is the hard requirement for the scheduler port: the server's selection MUST produce the same interaction the runner's `selectNextInteractionAcrossBundle` produces for identical inputs. Parity tests are mandatory.
- Validate runtime behavior by curling `localhost:8027` and querying the remote DB directly (per project convention) — do not ask the user to run scans.

---

### Task 1: Add `dependencyChain` to `ScanNextResponseNext` (testomniac_types)

**Files:**
- Modify: `testomniac_types/src/index.ts:2436-2440`
- Test: `testomniac_types/src/index.test.ts`

**Interfaces:**
- Produces: `ScanNextResponseNext.dependencyChain: TestInteractionResponse[]` — the selected interaction's dependency chain ordered **root-first, INCLUDING the selected interaction as the last element**. When the interaction has no dependency, this is `[selectedInteraction]`. Plan B derives `setupCases = dependencyChain.slice(0, -1)` and `journeySteps = dependencyChain.flatMap(i => parseStoredSteps(i.stepsJson))` from it — exactly mirroring today's `buildDependencyChain` output.

- [ ] **Step 1: Write the failing test**

Add to `testomniac_types/src/index.test.ts`:

```typescript
import type { ScanNextResponseNext, TestInteractionResponse } from './index';

describe('ScanNextResponseNext.dependencyChain', () => {
  it('carries a root-first chain of full interaction rows including self', () => {
    const self = { id: 7 } as TestInteractionResponse;
    const parent = { id: 5 } as TestInteractionResponse;
    const next: ScanNextResponseNext = {
      interactionRunId: 100,
      surfaceRunId: 10,
      testInteraction: self,
      dependencyChain: [parent, self],
    };
    expect(next.dependencyChain[next.dependencyChain.length - 1]).toBe(self);
    expect(next.dependencyChain[0]).toBe(parent);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd testomniac_types && bun test src/index.test.ts -t dependencyChain`
Expected: FAIL — `Object literal may only specify known properties, and 'dependencyChain' does not exist in type 'ScanNextResponseNext'` (typecheck) / compile error.

- [ ] **Step 3: Add the field**

In `testomniac_types/src/index.ts`, change the interface at line 2436:

```typescript
export interface ScanNextResponseNext {
  interactionRunId: number;
  surfaceRunId: number;
  testInteraction: TestInteractionResponse;
  /**
   * Dependency chain for `testInteraction`, ordered ROOT-FIRST and INCLUDING
   * the selected interaction as the final element. Replayed by the runner as
   * setup before the selected interaction's own steps. `[testInteraction]`
   * when there is no dependency.
   */
  dependencyChain: TestInteractionResponse[];
}
```

- [ ] **Step 4: Run test + typecheck to verify pass**

Run: `cd testomniac_types && bun run typecheck && bun test src/index.test.ts -t dependencyChain`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd testomniac_types
git add src/index.ts src/index.test.ts
git commit -m "feat(types): add dependencyChain to ScanNextResponseNext"
```

> **Publish gate:** This field must be published (via push_all) before `testomniac_api` can reference it. Coordinate the version bump through push_all rather than hand-editing versions.

---

### Task 2: Port pure selection algorithm into `scan-scheduler.ts` (testomniac_api)

This is the parity-critical task. Port the runner's pure functions verbatim so the server selects identically. Keep them pure (no DB) so they are unit-testable against the same cases the runner uses.

**Files:**
- Create: `testomniac_api/src/services/scan-scheduler.ts`
- Test: `testomniac_api/src/services/scan-scheduler.test.ts`

**Interfaces:**
- Consumes: minimal shapes (not full DB rows) so callers can pass projected data:
  - `SchedulerInteraction = { id: number; testSurfaceId: number; pageId: number | null; priority: number; surfaceTags: string[]; title: string; testType: string; dependencyTestInteractionId: number | null }`
  - `SchedulerSurface = { id: number; title: string; priority: number }`
  - `SchedulerRun = { id: number; testInteractionId: number; surfaceRunId: number }`
- Produces:
  - `getSurfaceExecutionGroup(surface): number`
  - `isHoverInteraction(interaction): boolean`
  - `buildDependencyBranchIds(interactionId, interactions): number[]` (root-first ids)
  - `selectAcrossBundle(entries, surfaces, interactions, activeBranch): { surfaceRun; run } | null`
  These mirror `runner.ts` exactly (lines 848-1125). Plan B relies on the server using these.

- [ ] **Step 1: Write the failing parity tests** (mirror `runner_service/src/orchestrator/runner.test.ts`)

Create `testomniac_api/src/services/scan-scheduler.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  isHoverInteraction,
  getSurfaceExecutionGroup,
  buildDependencyBranchIds,
  selectAcrossBundle,
  type SchedulerInteraction,
  type SchedulerSurface,
  type SchedulerRun,
} from "./scan-scheduler";

const ti = (id: number, o: Partial<SchedulerInteraction> = {}): SchedulerInteraction => ({
  id, testSurfaceId: 1, pageId: null, priority: 3, surfaceTags: [],
  title: `I${id}`, testType: "interaction", dependencyTestInteractionId: null, ...o,
});

describe("scan-scheduler parity", () => {
  it("treats hover tag and 'Hover over ' title as hover", () => {
    expect(isHoverInteraction(ti(1, { surfaceTags: ["hover"] }))).toBe(true);
    expect(isHoverInteraction(ti(2, { title: "Hover over Menu" }))).toBe(true);
    expect(isHoverInteraction(ti(3))).toBe(false);
  });

  it("orders Direct Navigations surface group before others", () => {
    expect(getSurfaceExecutionGroup({ id: 1, title: "Direct Navigations", priority: 3 })).toBe(0);
    expect(getSurfaceExecutionGroup({ id: 2, title: "Page: Home", priority: 3 })).toBe(1);
    expect(getSurfaceExecutionGroup({ id: 3, title: "Other", priority: 3 })).toBe(7);
  });

  it("builds a root-first dependency branch", () => {
    const all = [ti(5), ti(6, { dependencyTestInteractionId: 5 }), ti(7, { dependencyTestInteractionId: 6 })];
    expect(buildDependencyBranchIds(7, all)).toEqual([5, 6, 7]);
  });

  it("prefers hover interaction before non-hover sibling within a surface", () => {
    const surfaces: SchedulerSurface[] = [{ id: 1, title: "Page: Home", priority: 3 }];
    const interactions = [ti(11, { surfaceTags: ["hover"], priority: 4 }), ti(12, { priority: 4 })];
    const runs: SchedulerRun[] = [
      { id: 101, testInteractionId: 12, surfaceRunId: 10 },
      { id: 102, testInteractionId: 11, surfaceRunId: 10 },
    ];
    const entries = [{ surfaceRun: { id: 10, testSurfaceId: 1 }, eligibleRuns: runs }];
    const selected = selectAcrossBundle(entries, surfaces, interactions, []);
    expect(selected?.run.id).toBe(102); // hover first
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd testomniac_api && bun test src/services/scan-scheduler.test.ts`
Expected: FAIL — module `./scan-scheduler` not found.

- [ ] **Step 3: Implement the ported module**

Create `testomniac_api/src/services/scan-scheduler.ts`. Port `runner.ts:940-1125` verbatim, adapted to the minimal shapes:

```typescript
export interface SchedulerInteraction {
  id: number;
  testSurfaceId: number;
  pageId: number | null;
  priority: number;
  surfaceTags: string[];
  title: string;
  testType: string;
  dependencyTestInteractionId: number | null;
}
export interface SchedulerSurface { id: number; title: string; priority: number; }
export interface SchedulerRun { id: number; testInteractionId: number; surfaceRunId: number; }
export interface SchedulerSurfaceRun { id: number; testSurfaceId: number; }
export interface SchedulerEntry {
  surfaceRun: SchedulerSurfaceRun;
  eligibleRuns: SchedulerRun[];
}

export function isHoverInteraction(i: SchedulerInteraction | undefined): boolean {
  if (!i) return false;
  return i.surfaceTags.includes("hover") || i.title.startsWith("Hover over ");
}

export function getSurfaceExecutionGroup(s: SchedulerSurface | undefined): number {
  const title = s?.title ?? "";
  if (title === "Direct Navigations") return 0;
  if (title.startsWith("Page: ")) return 1;
  if (title.startsWith("Variants: ")) return 2;
  if (title.startsWith("Keyboard: ")) return 3;
  if (title.startsWith("Dialogs: ")) return 4;
  if (title.startsWith("Render: ")) return 5;
  if (title.startsWith("Journeys: ")) return 6;
  return 7;
}

export function buildDependencyBranchIds(
  interactionId: number,
  interactions: SchedulerInteraction[]
): number[] {
  const byId = new Map(interactions.map(i => [i.id, i]));
  const chain: number[] = [];
  const seen = new Set<number>();
  let current = byId.get(interactionId);
  while (current) {
    if (seen.has(current.id)) break;
    seen.add(current.id);
    chain.unshift(current.id);
    current = current.dependencyTestInteractionId
      ? byId.get(current.dependencyTestInteractionId)
      : undefined;
  }
  return chain;
}

function sortRuns(
  runs: SchedulerRun[],
  byId: Map<number, SchedulerInteraction>
): SchedulerRun[] {
  return [...runs].sort((l, r) => {
    const li = byId.get(l.testInteractionId);
    const ri = byId.get(r.testInteractionId);
    const hoverDiff = Number(isHoverInteraction(ri)) - Number(isHoverInteraction(li));
    if (hoverDiff !== 0) return hoverDiff;
    const prioDiff = (li?.priority ?? 999) - (ri?.priority ?? 999);
    if (prioDiff !== 0) return prioDiff;
    return l.id - r.id;
  });
}

function selectRun(
  runs: SchedulerRun[],
  interactions: SchedulerInteraction[],
  activeBranch: number[]
): SchedulerRun {
  if (runs.length <= 1) return runs[0]!;
  const byId = new Map(interactions.map(i => [i.id, i]));
  const byDep = new Map<number | null, SchedulerRun[]>();
  for (const run of runs) {
    const dep = byId.get(run.testInteractionId)?.dependencyTestInteractionId ?? null;
    const bucket = byDep.get(dep) ?? [];
    bucket.push(run);
    byDep.set(dep, bucket);
  }
  for (let i = activeBranch.length - 1; i >= 0; i -= 1) {
    const children = byDep.get(activeBranch[i]!) ?? [];
    if (children.length > 0) return sortRuns(children, byId)[0]!;
  }
  return sortRuns(runs, byId)[0]!;
}

export function selectAcrossBundle(
  entries: SchedulerEntry[],
  surfaces: SchedulerSurface[],
  interactions: SchedulerInteraction[],
  activeBranch: number[]
): { surfaceRun: SchedulerSurfaceRun; run: SchedulerRun } | null {
  const runnable = entries.filter(e => e.eligibleRuns.length > 0);
  if (runnable.length === 0) return null;
  const surfaceById = new Map(surfaces.map(s => [s.id, s]));

  if (activeBranch.length > 0) {
    const sorted = [...runnable].sort(
      (a, b) =>
        getSurfaceExecutionGroup(surfaceById.get(a.surfaceRun.testSurfaceId)) -
        getSurfaceExecutionGroup(surfaceById.get(b.surfaceRun.testSurfaceId))
    );
    for (const entry of sorted) {
      const run = selectRun(entry.eligibleRuns, interactions, activeBranch);
      return { surfaceRun: entry.surfaceRun, run };
    }
  }

  // No active branch: pick surface by execution group, then priority, then id.
  const bySurface = [...runnable].sort((a, b) => {
    const sa = surfaceById.get(a.surfaceRun.testSurfaceId);
    const sb = surfaceById.get(b.surfaceRun.testSurfaceId);
    const g = getSurfaceExecutionGroup(sa) - getSurfaceExecutionGroup(sb);
    if (g !== 0) return g;
    const p = (sa?.priority ?? 999) - (sb?.priority ?? 999);
    if (p !== 0) return p;
    return a.surfaceRun.id - b.surfaceRun.id;
  });
  const entry = bySurface[0]!;
  return { surfaceRun: entry.surfaceRun, run: selectRun(entry.eligibleRuns, interactions, []) };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd testomniac_api && bun test src/services/scan-scheduler.test.ts`
Expected: PASS (all 4 cases).

- [ ] **Step 5: Commit**

```bash
cd testomniac_api
git add src/services/scan-scheduler.ts src/services/scan-scheduler.test.ts
git commit -m "feat(api): port runner selection algorithm into scan-scheduler"
```

---

### Task 3: Build the dependency chain rows server-side (testomniac_api)

**Files:**
- Modify: `testomniac_api/src/routes/scan-lifecycle.ts` (add a helper near `selectNextInteraction`)
- Test: `testomniac_api/src/services/scan-scheduler.test.ts` (pure-mapping unit) + manual localhost verification

**Interfaces:**
- Produces: `buildDependencyChainRows(interactionId: number): Promise<TestInteractionResponse[]>` — full rows, root-first, including self. Reuses the exact walk pattern already proven in `src/services/playwright-script.ts:217-234` (`buildFindingScript`'s loop over `dependencyTestInteractionId` with a `seen` cycle guard).

- [ ] **Step 1: Add a pure mapper test** (the DB walk is integration-verified on localhost; the row→response mapping is unit-tested)

Add to `scan-scheduler.test.ts`:

```typescript
import { mapInteractionRow } from "../routes/scan-lifecycle";

describe("mapInteractionRow", () => {
  it("Number()-coerces id fields from postgres string output", () => {
    const row = {
      id: "7", runner_id: "1", test_surface_id: "2", title: "t", test_type: "navigation",
      size_class: "desktop", surface_tags: [], priority: 3, scaffold_id: null,
      pattern_type: null, dependency_test_interaction_id: "5", page_id: "9",
      target_page_id: null, test_environment_id: null, persona_id: null, use_case_id: null,
      starting_page_state_id: null, starting_path: "/", steps_json: null,
      global_expectations_json: null, estimated_duration_ms: null, uid: null,
      generated_key: null, is_active: true, is_generated: true, generated_at: null,
    };
    const mapped = mapInteractionRow(row);
    expect(mapped.id).toBe(7);
    expect(mapped.dependencyTestInteractionId).toBe(5);
    expect(mapped.pageId).toBe(9);
    expect(mapped.targetPageId).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd testomniac_api && bun test src/services/scan-scheduler.test.ts -t mapInteractionRow`
Expected: FAIL — `mapInteractionRow` is not exported.

- [ ] **Step 3: Implement `mapInteractionRow` + `buildDependencyChainRows`**

In `scan-lifecycle.ts`, add (export `mapInteractionRow` so it is unit-testable):

```typescript
export function mapInteractionRow(row: any): TestInteractionResponse {
  return {
    id: Number(row.id),
    runnerId: Number(row.runner_id),
    testEnvironmentId: row.test_environment_id != null ? Number(row.test_environment_id) : null,
    testSurfaceId: Number(row.test_surface_id),
    title: row.title,
    testType: row.test_type,
    sizeClass: row.size_class,
    surfaceTags: row.surface_tags ?? [],
    priority: Number(row.priority),
    scaffoldId: row.scaffold_id != null ? Number(row.scaffold_id) : null,
    patternType: row.pattern_type,
    dependencyTestInteractionId:
      row.dependency_test_interaction_id != null ? Number(row.dependency_test_interaction_id) : null,
    pageId: row.page_id != null ? Number(row.page_id) : null,
    targetPageId: row.target_page_id != null ? Number(row.target_page_id) : null,
    personaId: row.persona_id != null ? Number(row.persona_id) : null,
    useCaseId: row.use_case_id != null ? Number(row.use_case_id) : null,
    startingPageStateId:
      row.starting_page_state_id != null ? Number(row.starting_page_state_id) : null,
    startingPath: row.starting_path,
    stepsJson: row.steps_json,
    globalExpectationsJson: row.global_expectations_json,
    estimatedDurationMs: row.estimated_duration_ms != null ? Number(row.estimated_duration_ms) : null,
    uid: row.uid,
    generatedKey: row.generated_key,
    isActive: row.is_active,
    isGenerated: row.is_generated,
    generatedAt: row.generated_at,
  };
}

async function buildDependencyChainRows(
  interactionId: number
): Promise<TestInteractionResponse[]> {
  const client = (db as any)._.session.client as import("postgres").Sql;
  const chain: TestInteractionResponse[] = [];
  const seen = new Set<number>();
  let currentId: number | null = interactionId;
  while (currentId != null) {
    if (seen.has(currentId)) break; // cycle guard
    seen.add(currentId);
    const rows = await client`
      SELECT * FROM testomniac.test_interactions WHERE id = ${currentId} LIMIT 1
    `;
    if (rows.length === 0) break;
    const row = mapInteractionRow(rows[0]);
    chain.unshift(row);
    currentId = row.dependencyTestInteractionId;
  }
  return chain;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd testomniac_api && bun test src/services/scan-scheduler.test.ts -t mapInteractionRow`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd testomniac_api
git add src/routes/scan-lifecycle.ts src/services/scan-scheduler.test.ts
git commit -m "feat(api): add buildDependencyChainRows + mapInteractionRow helper"
```

---

### Task 4: Rewrite `selectNextInteraction` to use the scheduler + chain, keyed on the completed interaction

**Files:**
- Modify: `testomniac_api/src/routes/scan-lifecycle.ts` — `selectNextInteraction` (lines 534-605) and its call site at the Step 6 of the `/next` handler (line ~347).
- Test: manual localhost verification (DB-backed; the pure logic is already covered by Task 2/3).

**Interfaces:**
- Consumes: `selectAcrossBundle`, `buildDependencyBranchIds` (Task 2), `buildDependencyChainRows`, `mapInteractionRow` (Task 3); the existing runner-state query used by `GET /runner-state` (`test-runs.ts:169-262`) for eligible/blocked pending interaction runs.
- Produces: new signature `selectNextInteraction(bundleRunId: number, completedInteractionId: number | null): Promise<ScanNextResponse["next"]>` returning `next` with a populated `dependencyChain`.

- [ ] **Step 1: Replace the handler call site**

In the `/next` handler Step 6 (line ~347), change:

```typescript
    const next = await selectNextInteraction(bundleRunId);
```

to pass the just-completed interaction so the server can compute `activeDependencyBranch` (mirrors the runner setting `activeDependencyBranch` after each interaction):

```typescript
    const next = await selectNextInteraction(
      bundleRunId,
      completion?.testInteractionId ?? null
    );
```

- [ ] **Step 2: Rewrite `selectNextInteraction`**

Replace the body (lines 534-605) with a version that loads candidates, runs the ported scheduler, and attaches the chain. Reuse the existing runner-state SQL — factor the eligible/blocked pending-run query out of `test-runs.ts:169-262` into an exported `loadRunnerStateRows(bundleRunId)` and import it here (do NOT duplicate the SQL):

```typescript
async function selectNextInteraction(
  bundleRunId: number,
  completedInteractionId: number | null
): Promise<ScanNextResponse["next"]> {
  const client = (db as any)._.session.client as import("postgres").Sql;

  // 1. Open surface runs for this bundle (+ surface metadata for grouping).
  const surfaceRunRows = await client`
    SELECT tsr.id AS surface_run_id, tsr.test_surface_id, ts.title, ts.priority
    FROM testomniac.test_surface_runs tsr
    JOIN testomniac.test_surfaces ts ON tsr.test_surface_id = ts.id
    WHERE tsr.test_surface_bundle_run_id = ${bundleRunId} AND tsr.status = 'pending'
  `;
  if (surfaceRunRows.length === 0) return null;

  // 2. Eligible (non-blocked) pending interaction runs, grouped by surface run.
  //    loadRunnerStateRows is the existing /runner-state query, exported from test-runs.ts.
  const { eligibleBySurfaceRun } = await loadRunnerStateRows(bundleRunId);

  // 3. Candidate interactions (full rows) referenced by the eligible runs.
  const interactionRows = await client`
    SELECT * FROM testomniac.test_interactions ti
    WHERE ti.id IN (
      SELECT DISTINCT tir.test_interaction_id
      FROM testomniac.test_interaction_runs tir
      JOIN testomniac.test_surface_runs tsr ON tir.test_surface_run_id = tsr.id
      WHERE tsr.test_surface_bundle_run_id = ${bundleRunId}
    )
  `;
  const interactions: SchedulerInteraction[] = interactionRows.map((r: any) => ({
    id: Number(r.id),
    testSurfaceId: Number(r.test_surface_id),
    pageId: r.page_id != null ? Number(r.page_id) : null,
    priority: Number(r.priority),
    surfaceTags: r.surface_tags ?? [],
    title: r.title,
    testType: r.test_type,
    dependencyTestInteractionId:
      r.dependency_test_interaction_id != null ? Number(r.dependency_test_interaction_id) : null,
  }));

  const surfaces: SchedulerSurface[] = surfaceRunRows.map((r: any) => ({
    id: Number(r.test_surface_id),
    title: r.title,
    priority: Number(r.priority),
  }));

  const entries: SchedulerEntry[] = surfaceRunRows.map((r: any) => {
    const surfaceRunId = Number(r.surface_run_id);
    return {
      surfaceRun: { id: surfaceRunId, testSurfaceId: Number(r.test_surface_id) },
      eligibleRuns: (eligibleBySurfaceRun.get(surfaceRunId) ?? []).map(run => ({
        id: run.id,
        testInteractionId: run.testInteractionId,
        surfaceRunId,
      })),
    };
  });

  const activeBranch =
    completedInteractionId != null
      ? buildDependencyBranchIds(completedInteractionId, interactions)
      : [];

  const selected = selectAcrossBundle(entries, surfaces, interactions, activeBranch);
  if (!selected) return null;

  const chain = await buildDependencyChainRows(selected.run.testInteractionId);
  const testInteraction = chain[chain.length - 1];
  if (!testInteraction) return null;

  return {
    interactionRunId: selected.run.id,
    surfaceRunId: selected.surfaceRun.id,
    testInteraction,
    dependencyChain: chain,
  };
}
```

Add the imports at the top of `scan-lifecycle.ts`:

```typescript
import {
  selectAcrossBundle,
  buildDependencyBranchIds,
  type SchedulerInteraction,
  type SchedulerSurface,
  type SchedulerEntry,
} from "../services/scan-scheduler";
import { loadRunnerStateRows } from "./test-runs";
```

- [ ] **Step 3: Factor out `loadRunnerStateRows` from test-runs.ts**

In `test-runs.ts`, extract the eligible/blocked pending-run query from the `GET /runner-state` handler (lines 169-262) into an exported function returning `{ eligibleBySurfaceRun: Map<number, { id: number; testInteractionId: number }[]> }`, and have the route call it. (Pure refactor — the route's response must be byte-identical; verify by diffing a `curl localhost:8027/.../runner-state?bundleRunId=X` before/after.)

- [ ] **Step 4: Typecheck, lint, build**

Run: `cd testomniac_api && bun run typecheck && bun run lint && bun run build`
Expected: clean.

- [ ] **Step 5: Verify parity on localhost** (per project convention — do not ask the user to run a scan)

Start the API against the remote DB, then for an in-progress bundle run with known pending interactions, compare the chosen `next.interactionRunId` to what the runner's algorithm would pick (cross-check the ordering by querying the DB):

```bash
cd testomniac_api && bun run dev   # serves :8027
# In another shell, POST a /scan/next with a real completion payload and inspect `next`:
curl -s -X POST localhost:8027/api/v1/scan/next \
  -H 'content-type: application/json' \
  -d '{"runnerId":<R>,"testRunId":<T>,"bundleRunId":<B>,"testSurfaceBundleId":<SB>,"sizeClass":"desktop","completion":{"testInteractionId":<COMPLETED>, ... }}' | jq '.data.next | {interactionRunId, surfaceRunId, chain: [.dependencyChain[].id]}'
```
Expected: `next.dependencyChain` is root-first ending in the selected interaction; `interactionRunId` matches the surface-group + hover + branch ordering for that bundle (confirm against a direct DB query of pending runs).

- [ ] **Step 6: Commit**

```bash
cd testomniac_api
git add src/routes/scan-lifecycle.ts src/routes/test-runs.ts
git commit -m "feat(api): scan/next selects via ported scheduler and returns dependencyChain"
```

> **Risk note (carry into review):** This changes how `next` is chosen. The parity tests (Task 2) and the localhost cross-check (Task 4 Step 5) are the guard. If `loadRunnerStateRows` extraction is non-trivial, keep the old `ORDER BY priority, id` query as a temporary fallback behind a query flag and compare outputs before deleting it.

---

## Self-Review

- **Spec coverage:** #2/#12 residual (dependency chain in `next`) → Tasks 1, 3, 4. #1 server-side scheduler parity → Tasks 2, 4. ✅
- **Placeholder scan:** No TBDs; the one explicit reuse (`loadRunnerStateRows`) points to a concrete existing query (test-runs.ts:169-262) to factor out, not invent. ✅
- **Type consistency:** `dependencyChain` (Task 1) is `TestInteractionResponse[]` everywhere; `selectAcrossBundle`/`buildDependencyBranchIds`/`mapInteractionRow` signatures match across Tasks 2-4. ✅
