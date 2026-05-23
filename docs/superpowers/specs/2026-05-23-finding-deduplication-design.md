# Finding Deduplication Design

**Date:** 2026-05-23
**Status:** Approved

## Problem

Findings are duplicated in two ways:

1. **Same error, two findings:** A 404 page produces both a "page should load" error and a "network errors" warning — these should be one finding.
2. **Same error, different query params:** The same broken path (e.g., `/store/product/`) is reported separately for every query param variation (`?size=S`, `?size=M`). Each interaction run creates its own finding even though the root cause is identical.

The current schema ties each finding to exactly one `testInteractionRunId` (1:1), making dedup impossible without discarding the association to other runs that also observed the same issue.

## Design

### Schema Changes

#### `testRunFindings` table

Remove `testInteractionRunId` column. Add:

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `testRunId` | bigserial FK → testRuns | NOT NULL | Scopes dedup to a single scan run |
| `path` | text | YES | URL path (no query params) where the finding was observed. Used as dedup key alongside type + normalized title. |

#### New `testRunFindingRuns` junction table

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `id` | bigserial PK | NOT NULL | Auto-increment ID |
| `testRunFindingId` | bigserial FK → testRunFindings | NOT NULL | The finding |
| `testInteractionRunId` | bigserial FK → testInteractionRuns | NOT NULL | The interaction run that observed it |
| `createdAt` | timestamp | YES | Defaults to NOW() |

Unique constraint on `(testRunFindingId, testInteractionRunId)`.

### API Changes

#### New endpoint: `POST /test-run-findings/ensure`

Request body:
```typescript
{
  testRunId: number;
  testInteractionRunId: number;
  type: "error" | "warning";
  priority: number;
  title: string;
  description: string;
  path?: string;  // URL pathname without query params
}
```

Logic:
1. Normalize the title (strip leading count numbers).
2. Query for an existing finding matching `testRunId + type + normalizedTitle + path`.
3. If found:
   - Insert a junction record linking the existing finding to `testInteractionRunId` (ignore if duplicate).
   - Return the existing finding.
4. If not found:
   - Insert a new finding with `testRunId`, `type`, `priority`, `title`, `description`, `path`.
   - Insert a junction record linking the new finding to `testInteractionRunId`.
   - Return the new finding.

The old `POST /test-run-findings` endpoint remains for backward compatibility but is no longer called by the runner service.

#### Updated read endpoints

All endpoints that return findings join through the junction table. `TestRunFindingResponse` changes from:
```typescript
{ id, testInteractionRunId, type, priority, title, description, ... }
```
to:
```typescript
{ id, testRunId, path, type, priority, title, description, interactionRunIds: number[], ... }
```

#### Updated `clearSupersededFindings`

When a test interaction re-runs:
1. Delete junction records for superseded interaction run IDs.
2. Delete any findings that have zero remaining junction records (orphan cleanup).

### Runner Service Changes

#### `ApiClient`

New method `ensureTestRunFinding(params)` calls `POST /test-run-findings/ensure`. The old `createTestRunFinding` method remains but is unused.

#### `test-interaction-executor.ts`

All three finding creation sites (expectation failures, page health issues, test execution errors) switch from `api.createTestRunFinding` to `api.ensureTestRunFinding`, passing:
- `testRunId` from `testRun.id`
- `path` extracted from the current URL as `new URL(currentUrl).pathname` (no query params)
- `testInteractionRunId` from the current interaction run

#### 404 finding merge

In the TesterExpertise evaluation, when a page returns HTTP 404:
- The "page should load with valid HTML" check detects the 404 and records the outcome.
- The "no network errors" check also detects the 404 response.
- Before emitting findings, the executor checks: if the outcomes contain both a page-load 404 error and a network-error warning referencing the same URL, merge them into a single finding:
  - Type: `error`
  - Title: `[tester] Page returned HTTP 404`
  - Description: combined details from both outcomes
- This merge happens in the executor's finding emission loop, not in the expertise itself, so expertise evaluation logic stays pure.

### Extension Changes

#### `createDedupApiClient`

The in-session dedup wrapper in the background script switches from `createTestRunFinding` to `ensureTestRunFinding`. The dedup key changes from `type + normalizedTitle + normalizedDescription` to `type + normalizedTitle + path` to match the server-side ensure logic.

### Types Changes

#### `EnsureTestRunFindingRequest` (new)
```typescript
{
  testRunId: number;
  testInteractionRunId: number;
  type: FindingType;
  priority: number;
  title: string;
  description: string;
  path?: string;
}
```

#### `TestRunFindingResponse` (updated)
```typescript
{
  id: number;
  testRunId: number;
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

### Migration Strategy

1. Add `testRunId` and `path` columns to `testRunFindings` (nullable initially).
2. Create `testRunFindingRuns` junction table.
3. Migrate existing data: for each existing finding, populate `testRunId` from the linked interaction run's test run, and insert a junction record.
4. Make `testRunId` NOT NULL after migration.
5. Drop `testInteractionRunId` from `testRunFindings`.

### Affected Repos

| Repo | Changes |
|------|---------|
| `testomniac_types` | Add `EnsureTestRunFindingRequest`, update `TestRunFindingResponse` |
| `testomniac_api` | Schema migration, new ensure endpoint, update read endpoints, update superseded cleanup |
| `testomniac_runner_service` | New `ensureTestRunFinding` in ApiClient, update executor to use it, 404 merge logic |
| `testomniac_extension` | Update dedup wrapper to use `ensureTestRunFinding` |
| `testomniac_app` | Update finding display components to handle `interactionRunIds` array instead of single `testInteractionRunId` |
| `testomniac_app_rn` | Same as testomniac_app |
