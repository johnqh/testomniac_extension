# Schema Refactor Plan: Align Data Model to Domain Requirements

## Context

The current schema evolved organically and has several structural mismatches with the intended domain model. This refactor aligns the database, types, API, and scanning logic to the correct relationships.

## Target Data Model

```
Entity (0..N) → Project (0..N) → App
  App has:
    - 0..N Pages (unique URL per app)
    - 0..N Actions (definitions: "click login button on page X")
    - 0..N Scans (formerly "runs")
    - 0..N Test Cases (persistent across scans)
    - 0..N Credentials

  Page has:
    - 1..N Page States

  Page State has:
    - 0..N Reusable HTML Components (via junction)
    - 1 Content HTML Component

  HTML Component (HtmlElement) has:
    - 0..N Actionable Items (structural: selector, role, kind)

  Action (definition, app-level):
    - navigate: URL destination, no starting page state
    - hover: starting page state, target page state (same or different)
    - click: starting page state, target page state (same or different)
    - fill: text input (name, email, URL, date, etc.)
    - select: HTML select element
    - radio_select: radio button selection

  Scan (formerly "run"):
    - Belongs to app
    - Has 0..N Action Executions (references action definitions)

  Action Execution (scan-level):
    - References: action definition + scan
    - Captures: screenshots, console logs, network logs, duration

  Test Case (app-level):
    - Series of action references via junction table (ordered)
    - Has starting URL (first action is navigate)

  Test Run:
    - Belongs to scan + test case
    - Captures: pass/fail, duration, error, screenshots
```

## Schema Changes

### 1. Rename `runs` → `scans`

**Table**: `runs` → `scans`
**All FK columns**: `run_id` → `scan_id` everywhere
**All types**: `RunDetailResponse` → `ScanDetailResponse`, etc.

Affected tables with `run_id` FK:
- `actions` (current) → `action_executions` (new)
- `test_cases` → `test_cases` (change to `app_id`)
- `test_runs` → `test_runs` (change `run_id` to `scan_id`)
- `issues` → `issues` (change `run_id` to `scan_id`)
- `ai_usage` → `ai_usage` (change `run_id` to `scan_id`)
- `report_emails` → `report_emails` (change `run_id` to `scan_id`)

### 2. Split actions into definitions + executions

**New table: `actions`** (definitions, app-level)
```sql
CREATE TABLE testomniac.actions (
  id BIGSERIAL PRIMARY KEY,
  app_id BIGINT NOT NULL REFERENCES testomniac.apps(id),
  type TEXT NOT NULL,                    -- navigate, hover, click, fill, select, radio_select
  starting_page_state_id BIGINT REFERENCES testomniac.page_states(id),
  target_url TEXT,                       -- for navigate actions
  actionable_item_id BIGINT REFERENCES testomniac.actionable_items(id),
  html_element_id BIGINT REFERENCES testomniac.html_elements(id),
  input_value TEXT,                      -- for fill actions
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Renamed table: current `actions` → `action_executions`** (scan-level)
```sql
CREATE TABLE testomniac.action_executions (
  id BIGSERIAL PRIMARY KEY,
  scan_id BIGINT NOT NULL REFERENCES testomniac.scans(id),
  action_id BIGINT NOT NULL REFERENCES testomniac.actions(id),
  status TEXT NOT NULL DEFAULT 'open',   -- open, completed
  target_page_state_id BIGINT REFERENCES testomniac.page_states(id),
  duration_ms INTEGER,
  screenshot_before TEXT,
  screenshot_after TEXT,
  console_log TEXT,
  network_log TEXT,
  started_at TIMESTAMPTZ,
  executed_at TIMESTAMPTZ
);
```

### 3. Re-parent actionable items from page states to HTML components

**Modified table: `actionable_items`**
```sql
-- Remove: page_state_id FK
-- Add: html_element_id FK
-- Drop: x, y, width, height (position resolved at interaction time)

ALTER TABLE testomniac.actionable_items DROP COLUMN IF EXISTS page_state_id;
ALTER TABLE testomniac.actionable_items ADD COLUMN IF NOT EXISTS html_element_id BIGINT REFERENCES testomniac.html_elements(id);
ALTER TABLE testomniac.actionable_items DROP COLUMN IF EXISTS x;
ALTER TABLE testomniac.actionable_items DROP COLUMN IF EXISTS y;
ALTER TABLE testomniac.actionable_items DROP COLUMN IF EXISTS width;
ALTER TABLE testomniac.actionable_items DROP COLUMN IF EXISTS height;
```

New schema:
```sql
actionable_items (
  id BIGSERIAL PRIMARY KEY,
  html_element_id BIGINT REFERENCES testomniac.html_elements(id),
  stable_key TEXT,
  selector TEXT,
  tag_name TEXT,
  role TEXT,
  action_kind TEXT,              -- click, fill, toggle, select, navigate, radio_select
  accessible_name TEXT,
  disabled BOOLEAN,
  visible BOOLEAN,
  attributes_json JSONB,
  reusable_html_element_id BIGINT REFERENCES testomniac.reusable_html_elements(id)
);
```

### 4. Re-parent test cases from runs to apps

**Modified table: `test_cases`**
```sql
-- Remove: run_id FK
-- Add: app_id FK

ALTER TABLE testomniac.test_cases DROP COLUMN IF EXISTS run_id;
ALTER TABLE testomniac.test_cases ADD COLUMN IF NOT EXISTS app_id BIGINT REFERENCES testomniac.apps(id);
ALTER TABLE testomniac.test_cases DROP COLUMN IF EXISTS actions_json;
```

### 5. New junction table: `test_case_actions`

```sql
CREATE TABLE testomniac.test_case_actions (
  id BIGSERIAL PRIMARY KEY,
  test_case_id BIGINT NOT NULL REFERENCES testomniac.test_cases(id),
  action_id BIGINT NOT NULL REFERENCES testomniac.actions(id),
  step_order INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX testomniac_tca_test_case_idx ON testomniac.test_case_actions(test_case_id);
```

### 6. New table: `credentials`

```sql
CREATE TABLE testomniac.credentials (
  id BIGSERIAL PRIMARY KEY,
  app_id BIGINT NOT NULL REFERENCES testomniac.apps(id),
  username TEXT,
  email TEXT,
  password TEXT NOT NULL,
  two_factor_code TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 7. Add unique constraint on pages

```sql
CREATE UNIQUE INDEX IF NOT EXISTS testomniac_pages_app_url_uniq
ON testomniac.pages(app_id, url);
```

### 8. Update ActionType enum

Current: `navigate, mouseover, click, fill, select, check, toggle, check_email`
New: `navigate, hover, click, fill, select, radio_select`

Remove: `mouseover` (rename to `hover`), `check`, `toggle` (split into `click` for checkbox, `radio_select` for radio), `check_email`

## Complete Table Inventory (after refactor)

```
-- Infrastructure
users, entities, entity_members, entity_invitations, histories

-- Core hierarchy
projects (entity_id FK)
apps (project_id FK)
pages (app_id FK, UNIQUE(app_id, url))
page_states (page_id FK, body_html_element_id FK, content_html_element_id FK)

-- HTML decomposition
html_elements (hash UNIQUE)
reusable_html_elements (app_id FK, html_element_id FK)
page_state_reusable_elements (page_state_id FK, reusable_html_element_id FK)

-- Actionable items (belong to HTML components)
actionable_items (html_element_id FK, reusable_html_element_id FK)

-- Action definitions (app-level)
actions (app_id FK, type, starting_page_state_id, target_url, actionable_item_id, html_element_id)

-- Scanning
scans (app_id FK, status, phase, counters, durations)  [formerly "runs"]
action_executions (scan_id FK, action_id FK, status, screenshots, logs)

-- Testing
test_cases (app_id FK, name, type, priority, tags)
test_case_actions (test_case_id FK, action_id FK, step_order)
test_runs (test_case_id FK, scan_id FK, status, duration, error)

-- Issues
issues (scan_id FK, action_execution_id FK, test_case_id FK, test_run_id FK, type, description)

-- Auth
credentials (app_id FK, username, email, password, two_factor_code)

-- Personas (AI-generated)
personas (app_id FK)
use_cases (persona_id FK)
input_values (use_case_id FK)

-- Analytics
ai_usage (scan_id FK)
report_emails (scan_id FK)

-- Legacy (deprecated, to be dropped)
components, component_instances
```

## Implementation Phases

### Phase 1: Types (`testomniac_types`)
- Rename all `Run*` types to `Scan*` (RunDetailResponse → ScanDetailResponse, etc.)
- Update `ActionType` enum (add `hover`, `radio_select`; remove `mouseover`, `check`, `toggle`)
- Add `ActionDefinition` / `ActionDefinitionResponse` types
- Add `ActionExecutionResponse` / `CreateActionExecutionRequest` types
- Add `CredentialResponse` / `CreateCredentialRequest` types
- Add `TestCaseActionRequest` type
- Update `ActionableItem` to remove x/y/width/height, change pageStateId to htmlElementId
- Update `CreateActionRequest` to be app-level (appId instead of runId)
- Remove `actionsJson` from `TestCase`, add `appId`

### Phase 2: API (`testomniac_api`)
- Rename `runs` table to `scans` in schema + init SQL
- Create `action_executions` table (with data from old `actions`)
- Create new `actions` table (definitions)
- Create `test_case_actions` junction table
- Create `credentials` table
- Modify `actionable_items` table (drop coordinates, change FK)
- Modify `test_cases` table (appId instead of runId, drop actionsJson)
- Modify `issues` table (scanId, actionExecutionId)
- Add unique constraint on pages(app_id, url)
- Update ALL route files: scanner.ts, runs-read.ts → scans-read.ts, projects.ts, etc.

### Phase 3: Scanning Service (`testomniac_scanning_service`)
- Update `ApiClient` methods: rename run→scan, add action definition methods, update action execution flow
- Update orchestrator: create action definitions when discovering items, create executions when performing actions
- Update mouse-scanning: work with new action model
- Update all types imports

### Phase 4: Client + Lib (`testomniac_client`, `testomniac_lib`)
- Rename all run hooks to scan hooks
- Update query keys
- Update TestomniacClient methods

### Phase 5: Frontend + Consumers (`testomniac_app`, `testomniac_scanner`, `testomniac_extension`)
- Update all references from run→scan
- Update action display
- Update extension background worker

### Phase 6: Deploy
- `push_all.sh` for the full chain

## Verification
1. `bun run verify` in each project
2. Start API, verify new tables created
3. Run a scan, verify:
   - Action definitions created at app level
   - Action executions created per scan
   - Actionable items belong to HTML elements
   - Test cases belong to app, not scan
   - Pages have unique URL constraint
4. Check frontend displays scan results correctly
