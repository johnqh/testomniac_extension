# Scanner Implementation Plan

## Goal

Build a scanner that:

1. Starts from a target URL.
2. Discovers all public links and verifies they can be directly navigated to.
3. Discovers actionable UI elements and verifies they can be acted upon.
4. Detects shared scaffolds and avoids retesting them on every page.
5. Lets expertises contribute findings across areas like testing, security, content, and UI.
6. Organizes suites, cases, actions, and runs cleanly.
7. Stores enough structured data to support future diffs and reruns.
8. Treats environments separately.
9. Supports localhost scans as user-owned local environments in the extension.

## Environment Rules

The extension must resolve environments using this rule:

- If the active tab host is `localhost` or `127.0.0.1`, the scan belongs to a personal local environment tied to the logged-in user.
- Otherwise, the user must choose an environment label:
  - `production`
  - `staging`
  - `qa`
  - custom label

Recommended uniqueness rules:

- Local environment:
  - `productId + ownerUserId + normalizedBaseUrl + kind=local`
- Non-local environment:
  - `productId + normalizedBaseUrl + label`

## Target Architecture

The scanner should move from the current action-driven discovery loop to a staged pipeline:

1. Resolve environment.
2. Create root discovery run.
3. Crawl public links from the starting URL.
4. Build page inventory for the environment.
5. Verify direct navigation for every discovered page.
6. Capture page states and structural fingerprints.
7. Detect scaffolds and classify actionables by ownership.
8. Generate scaffold and page interaction suites.
9. Execute interaction tests.
10. Run expertises over stored scan artifacts.
11. Compare against prior runs in the same environment.

## Repository Responsibilities

### `testomniac_extension`

Owns:

- active tab URL detection
- localhost-aware environment UX
- non-local environment label selection
- scan submission
- background orchestration through `ChromeAdapter`
- progress display

Does not own:

- environment inference rules beyond URL classification for UX
- page inventory persistence
- test generation policy
- expertise execution logic

### `testomniac_api`

Owns:

- environment resolution
- scan creation
- page inventory persistence
- page visit persistence
- scaffold persistence
- run hierarchy persistence
- expertise execution persistence
- baseline lookup

### `testomniac_runner_service`

Owns:

- crawl-first discovery
- navigation verification
- page-state capture
- scaffold detection
- interaction generation
- action execution
- expertise execution orchestration

### `testomniac_types`

Owns:

- request/response contracts
- environment types
- discovery inventory types
- scaffold types
- expertise execution types

## Workstreams

### 1. Environment Resolution

#### Extension

Update [src/sidepanel/SidePanel.tsx](/Users/johnhuang/projects/testomniac_extension/src/sidepanel/SidePanel.tsx:1):

- If URL host is `localhost` or `127.0.0.1`, auto-resolve personal local environment.
- Otherwise, require environment selection through `Combobox`.
- Support preset values `production`, `staging`, `qa`, and `custom`.
- If `custom` is selected, require a free-form label.
- Block scan submission until environment input is valid.

Update [src/background/index.ts](/Users/johnhuang/projects/testomniac_extension/src/background/index.ts:101):

- include resolved environment context in scan start state once API supports it

#### API

Add environment resolver endpoint in `testomniac_api`:

- `POST /api/v1/test-environments/resolve`

Input should include:

- `productId`
- `url`
- `baseUrl`
- `userId`
- `source`
- `environmentLabel` for non-local extension scans

Output should include:

- `testEnvironmentId`
- `kind`
- `label`
- `ownerUserId`
- `resolutionMode`

#### Types

Add types in `testomniac_types`:

- `EnvironmentKind`
- `ResolveEnvironmentRequest`
- `ResolveEnvironmentResponse`
- `ResolvedEnvironmentMode`

### 2. Scan Creation

#### API

Update `POST /api/v1/scan` in `testomniac_api`:

- require `testEnvironmentId`
- stop inferring environment from URL
- create root discovery run scoped to that environment

#### Extension

Before calling `POST /api/v1/scan`:

1. resolve environment
2. send `testEnvironmentId`
3. send environment metadata for traceability if useful

#### Cleanup

Fix the current runner mismatch:

- the extension currently creates a runner
- the scan API currently creates or chooses its own runner

Choose one source of truth. Recommended:

- environment and runner resolution should be owned by the API

### 3. Crawl-First Discovery

#### Runner Service

Add crawler modules:

- `src/crawler/url-normalizer.ts`
- `src/crawler/link-extractor.ts`
- `src/crawler/discovery-queue.ts`
- `src/orchestrator/discovery.ts`

Behavior:

- extract same-origin public links
- normalize URLs
- remove fragments
- track discovery source page
- avoid duplicate queue entries
- cap crawl depth and page count

#### API

Add persistence for:

- `discovered_pages`
- `page_visits`

Endpoints:

- `POST /scanner/discovered-pages`
- `GET /scanner/discovered-pages?testEnvironmentId=...`
- `POST /scanner/page-visits`
- `GET /scanner/page-visits?testRunId=...`

#### Types

Add:

- `DiscoveredPage`
- `PageDiscoverySource`
- `PageVisit`
- `CreateDiscoveredPagesRequest`
- `CreatePageVisitRequest`

### 4. Direct Navigation Verification

Every discovered public page should produce direct-navigation coverage.

#### Runner Service

For each discovered page:

- navigate directly
- record status
- record redirect target if any
- record auth gate / blocked page
- capture initial page state when navigation succeeds

#### Suite Organization

Create a dedicated suite category:

- `Direct Navigation`

Each page should have a corresponding navigation case or run record.

### 5. Page State Capture

Persist enough data to support future baselines.

For each successful page visit capture:

- canonical path
- page HTML hash
- normalized HTML hash
- text hash
- actionable hash
- scaffold hash
- pattern hash
- content excerpt
- page-state-to-run linkage

### 6. Scaffold Detection and Deduplication

The scanner should detect shared UI and avoid regenerating redundant tests.

#### Runner Service

Use scaffold detection to:

- fingerprint scaffold structure
- associate actionables to scaffolds where possible
- distinguish scaffold-owned vs page-owned interactions

#### API

Persist:

- scaffold fingerprints
- page-state-to-scaffold links
- scaffold coverage links

#### Suite Organization

Create dedicated scaffold suites:

- `Shared Scaffold: Header`
- `Shared Scaffold: Footer`
- `Shared Scaffold: Navigation`

Rules:

- generate scaffold suites once per environment and fingerprint
- link covered pages back to the shared scaffold artifact

### 7. Interaction Test Generation

Interaction generation should be split by ownership.

Generate:

- scaffold interaction suites
- page-specific interaction suites
- later, form-specific suites if needed

Do not rely solely on “new path after click” for discovery. That can still exist as a secondary expansion mechanism, but it should not be the only discovery path.

Recommended suite categories:

- `Direct Navigation`
- `Shared Scaffold`
- `Page Interactions`
- `Forms`
- `Expertise: <name>`

### 8. Expertise Execution

Expertises should operate on shared scan artifacts rather than embedding custom crawl logic.

#### Runner Service

Add expertise registry and executors:

- `security`
- `ui`
- `content`
- `testing`

They should consume:

- page states
- discovered links
- scaffolds
- forms
- screenshots
- findings
- console/network information if available

#### API

Persist:

- `expertise_executions`
- expertise findings

#### Types

Add:

- `ExpertiseExecutionResponse`
- execution request and target types

### 9. Baselines and Future Runs

Comparison must always stay inside the same environment.

Rules:

- localhost runs for user A must not compare against localhost runs for user B
- local runs must not compare against staging or production
- staging and production must remain isolated

#### API

Add environment-scoped baseline lookup endpoints for:

- page states
- scaffold fingerprints
- pattern fingerprints

#### Runner Service

Use baseline matches to:

- reduce duplicate test generation
- highlight changes
- keep direct-navigation verification even when structure is unchanged

## Extension UI Plan

### Immediate UI Behavior

For localhost:

- show read-only environment status
- indicate this is a user-owned local environment

For non-local URLs:

- show environment `Combobox`
- show custom label input only when `custom` is selected
- keep scan button disabled until valid

### Progress UI

Replace the generic scan phase display with:

- `Discovering Pages`
- `Verifying Navigation`
- `Capturing States`
- `Generating Tests`
- `Executing Tests`
- `Running Expertises`

Counters should evolve toward:

- pages discovered
- pages directly navigable
- page states captured
- shared scaffolds detected
- tests executed
- findings created

## Recommended Ticket Order

1. Add centralized environment resolver with localhost-aware and label-aware rules.
2. Require `testEnvironmentId` in `POST /api/v1/scan`.
3. Remove environment ambiguity in the extension and resolve it before scan creation.
4. Fix runner ownership so API and extension do not disagree.
5. Add crawl-first discovered page inventory.
6. Add direct-navigation verification for all discovered pages.
7. Add scaffold fingerprint persistence and dedupe.
8. Split interaction suites into scaffold and page scopes.
9. Add expertise execution persistence and orchestration.
10. Add environment-scoped baseline lookup and delta-aware reruns.

## Acceptance Criteria

The scanner is considered aligned with the target design when:

- localhost scans in the extension always resolve to personal local environments tied to the logged-in user
- non-local extension scans require an environment label
- every discovered public page receives direct-navigation verification
- scaffolds are tested once per environment fingerprint
- interaction tests are organized separately from direct-navigation checks
- expertise findings are attached to first-class expertise executions
- reruns compare only within the same environment lineage

## Engineering Backlog

### Milestone 1: Environment Resolution and Scan Ownership

Goal:

- make environment resolution deterministic
- make scan creation environment-explicit
- remove runner ambiguity between extension and API

#### Ticket 1.1: Add environment resolution contracts

Repo:

- `testomniac_types`

Files:

- `src/index.ts`

Tasks:

- add `EnvironmentKind`
- add `ResolvedEnvironmentMode`
- add `ResolveEnvironmentRequest`
- add `ResolveEnvironmentResponse`
- add optional environment label fields to scan creation request if needed

Acceptance:

- types can represent localhost personal-local resolution and non-local labeled resolution

#### Ticket 1.2: Add environment resolver endpoint

Repo:

- `testomniac_api`

Files:

- `src/routes/test-environments.ts` or equivalent
- `src/db/schema.ts`
- `src/db/index.ts`

Tasks:

- add `POST /api/v1/test-environments/resolve`
- implement rules:
  - extension + `localhost` or `127.0.0.1` => `kind=local`, `ownerUserId=user`
  - extension + non-local => require `environmentLabel`
- enforce uniqueness:
  - local => `productId + ownerUserId + normalizedBaseUrl + kind=local`
  - non-local => `productId + normalizedBaseUrl + label`

Acceptance:

- repeated resolution returns stable environments
- localhost environments never mix across users

#### Ticket 1.3: Require environment in scan creation

Repo:

- `testomniac_api`

Files:

- `src/routes/scan.ts`

Tasks:

- require `testEnvironmentId` in `POST /api/v1/scan`
- stop creating or inferring environment from URL
- attach `testEnvironmentId` to root discovery runs

Acceptance:

- no discovery run can be created without explicit environment context

#### Ticket 1.4: Update extension environment UX

Repo:

- `testomniac_extension`

Files:

- [src/sidepanel/SidePanel.tsx](/Users/johnhuang/projects/testomniac_extension/src/sidepanel/SidePanel.tsx:1)

Tasks:

- auto-handle localhost and `127.0.0.1`
- show non-local environment `Combobox`
- support `production`, `staging`, `qa`, `custom`
- show custom label input only for `custom`
- block submission until valid
- call environment resolver before scan creation

Acceptance:

- localhost scans resolve automatically to a user local environment
- non-local scans cannot start without a valid environment label

#### Ticket 1.5: Remove runner ownership mismatch

Repo:

- `testomniac_api`
- `testomniac_extension`

Files:

- `testomniac_api/src/routes/scan.ts`
- [src/sidepanel/SidePanel.tsx](/Users/johnhuang/projects/testomniac_extension/src/sidepanel/SidePanel.tsx:1)
- [src/background/index.ts](/Users/johnhuang/projects/testomniac_extension/src/background/index.ts:101)

Tasks:

- choose one source of truth for runner resolution
- recommended:
  - API owns runner lookup/creation for the resolved environment
  - extension stops pre-creating runners

Acceptance:

- root test run, environment, and runner are created consistently from one path

### Milestone 2: Crawl-First Page Discovery

Goal:

- discover public pages directly from links
- persist environment-scoped page inventory

#### Ticket 2.1: Add discovery inventory contracts

Repo:

- `testomniac_types`

Files:

- `src/index.ts`

Tasks:

- add `DiscoveredPage`
- add `PageDiscoverySource`
- add `PageVisit`
- add `CreateDiscoveredPagesRequest`
- add `CreatePageVisitRequest`
- add response types as needed

Acceptance:

- types support page inventory and page visit persistence

#### Ticket 2.2: Add discovered pages and page visits persistence

Repo:

- `testomniac_api`

Files:

- `src/db/schema.ts`
- `src/db/index.ts`
- `src/routes/scanner.ts`

Tasks:

- add `discovered_pages` table
- add `page_visits` table
- add endpoints:
  - `POST /scanner/discovered-pages`
  - `GET /scanner/discovered-pages?testEnvironmentId=...`
  - `POST /scanner/page-visits`
  - `GET /scanner/page-visits?testRunId=...`

Acceptance:

- page inventory can be stored and queried per environment and run

#### Ticket 2.3: Implement crawler modules

Repo:

- `testomniac_runner_service`

Files:

- `src/crawler/url-normalizer.ts`
- `src/crawler/link-extractor.ts`
- `src/crawler/discovery-queue.ts`
- `src/orchestrator/discovery.ts`

Tasks:

- extract same-origin links
- normalize paths and strip fragments
- track source page and anchor text if useful
- avoid duplicate queue entries
- support crawl caps

Acceptance:

- starting from one URL, scanner can enumerate a stable set of public pages

### Milestone 3: Direct Navigation Verification

Goal:

- ensure every discovered public page can be visited directly

#### Ticket 3.1: Create direct-navigation suite generation

Repo:

- `testomniac_runner_service`

Files:

- `src/orchestrator/orchestrator.ts`
- `src/orchestrator/discovery.ts`

Tasks:

- generate direct-navigation work for all discovered pages
- create a distinct suite category:
  - `Direct Navigation`

Acceptance:

- every discovered page has direct-navigation coverage

#### Ticket 3.2: Record page visit outcomes

Repo:

- `testomniac_runner_service`
- `testomniac_api`

Files:

- `testomniac_runner_service/src/orchestrator/discovery.ts`
- `testomniac_api/src/routes/scanner.ts`

Tasks:

- capture:
  - success/failure
  - redirect target
  - auth requirement
  - unreachable/broken result

Acceptance:

- direct-navigation results are queryable independently of interaction tests

### Milestone 4: Page State Capture and Baseline Inputs

Goal:

- persist enough structure to support future reruns and change detection

#### Ticket 4.1: Expand page-state capture

Repo:

- `testomniac_runner_service`

Files:

- `src/orchestrator/orchestrator.ts`
- `src/browser/page-utils.ts`

Tasks:

- ensure captured hashes include:
  - html
  - normalized html
  - text
  - actionable
  - scaffold
  - pattern

Acceptance:

- page states contain the minimum comparison inputs for future diffs

#### Ticket 4.2: Scope page states to environment and run lineage

Repo:

- `testomniac_api`

Files:

- `src/db/schema.ts`
- `src/routes/scanner.ts`

Tasks:

- ensure page states can be traced to:
  - page
  - environment
  - creating test run

Acceptance:

- API can answer which environment and run produced a given page state

### Milestone 5: Scaffold Detection and Deduplication

Goal:

- detect shared UI and test it once per environment fingerprint

#### Ticket 5.1: Add scaffold fingerprint contracts

Repo:

- `testomniac_types`

Files:

- `src/index.ts`

Tasks:

- add `ScaffoldFingerprint`
- add `ActionableOwnership`

Acceptance:

- types can express shared-vs-page-owned interactions

#### Ticket 5.2: Associate actionables with scaffolds

Repo:

- `testomniac_runner_service`

Files:

- `src/scanner/component-detector.ts`
- `src/orchestrator/decomposition.ts`
- `src/extractors/index.ts`

Tasks:

- detect scaffold regions
- fingerprint scaffold structure
- classify actionables as scaffold-owned or page-owned when possible

Acceptance:

- repeated header/footer/nav elements can be recognized across pages

#### Ticket 5.3: Persist scaffold coverage

Repo:

- `testomniac_api`

Files:

- `src/db/schema.ts`
- `src/routes/scanner.ts`

Tasks:

- store scaffold fingerprints
- store page-state-to-scaffold links
- store scaffold coverage relationships if needed

Acceptance:

- API can answer which pages share a scaffold and whether it was already covered

#### Ticket 5.4: Generate scaffold suites once

Repo:

- `testomniac_runner_service`

Files:

- `src/orchestrator/decomposition.ts`

Tasks:

- generate shared scaffold suites only once per environment fingerprint
- create suite naming such as:
  - `Shared Scaffold: Header`
  - `Shared Scaffold: Footer`

Acceptance:

- shared scaffold tests are not regenerated on every page

### Milestone 6: Interaction Suite Organization

Goal:

- separate direct-navigation checks from page and scaffold interactions

#### Ticket 6.1: Split suite categories

Repo:

- `testomniac_runner_service`
- `testomniac_api`

Files:

- `testomniac_runner_service/src/orchestrator/decomposition.ts`
- `testomniac_runner_service/src/orchestrator/test-execution.ts`
- `testomniac_api/src/routes/scanner.ts`

Tasks:

- introduce suite categories:
  - `Direct Navigation`
  - `Shared Scaffold`
  - `Page Interactions`
  - `Forms`
  - later `Expertise:*`

Acceptance:

- generated tests and runs are grouped by purpose rather than one flat auto-generated bucket

### Milestone 7: Expertise Execution

Goal:

- let specialized analyzers contribute findings from shared artifacts

#### Ticket 7.1: Add expertise execution contracts

Repo:

- `testomniac_types`

Files:

- `src/index.ts`

Tasks:

- add execution request and response types
- add execution target types

Acceptance:

- expertises are first-class contracts instead of ad hoc findings

#### Ticket 7.2: Persist expertise executions

Repo:

- `testomniac_api`

Files:

- `src/db/schema.ts`
- `src/routes/scanner.ts`

Tasks:

- add `expertise_executions` table
- add create/list endpoints

Acceptance:

- expertise runs and findings can be queried separately from interaction runs

#### Ticket 7.3: Implement expertise registry

Repo:

- `testomniac_runner_service`

Files:

- `src/expertise/registry.ts`
- `src/expertise/executors/security.ts`
- `src/expertise/executors/ui.ts`
- `src/expertise/executors/content.ts`
- `src/expertise/executors/testing.ts`

Tasks:

- run expertises against:
  - page states
  - links
  - scaffolds
  - screenshots
  - forms
  - findings

Acceptance:

- expertises add findings without owning crawl or navigation logic

### Milestone 8: Baselines and Reruns

Goal:

- compare only inside the same environment lineage
- reduce duplicate work on repeat scans

#### Ticket 8.1: Add environment-scoped baseline lookup

Repo:

- `testomniac_api`

Files:

- `src/routes/scanner.ts`
- `src/db/schema.ts`

Tasks:

- add baseline lookup for:
  - page states
  - scaffold fingerprints
  - pattern fingerprints
- ensure lookups are scoped to environment

Acceptance:

- localhost runs for one user never compare against another user or shared environment

#### Ticket 8.2: Reuse baselines in runner orchestration

Repo:

- `testomniac_runner_service`

Files:

- `src/orchestrator/orchestrator.ts`
- `src/orchestrator/decomposition.ts`

Tasks:

- use prior baselines to reduce duplicate suite and case generation
- keep direct-navigation verification even when structure is unchanged

Acceptance:

- reruns become delta-aware while still verifying availability

### Milestone 9: Extension Progress and Results UX

Goal:

- reflect the actual pipeline and environment model in the side panel

#### Ticket 9.1: Show environment classification clearly

Repo:

- `testomniac_extension`

Files:

- [src/sidepanel/SidePanel.tsx](/Users/johnhuang/projects/testomniac_extension/src/sidepanel/SidePanel.tsx:1)

Tasks:

- for localhost show:
  - personal local environment tied to logged-in user
- for non-local show:
  - selected environment label

Acceptance:

- users can tell exactly where scan data will land

#### Ticket 9.2: Replace generic phases with real pipeline phases

Repo:

- `testomniac_extension`

Files:

- [src/background/index.ts](/Users/johnhuang/projects/testomniac_extension/src/background/index.ts:101)
- [src/sidepanel/SidePanel.tsx](/Users/johnhuang/projects/testomniac_extension/src/sidepanel/SidePanel.tsx:1)

Tasks:

- update phase labels to:
  - `Discovering Pages`
  - `Verifying Navigation`
  - `Capturing States`
  - `Generating Tests`
  - `Executing Tests`
  - `Running Expertises`

Acceptance:

- extension UI matches actual scanner behavior

## Recommended Execution Order

1. Milestone 1
2. Milestone 2
3. Milestone 3
4. Milestone 4
5. Milestone 5
6. Milestone 6
7. Milestone 7
8. Milestone 8
9. Milestone 9

## Notes

- The extension-side `Combobox` environment work is already partially implemented in this repo, but the API and scan contracts do not yet support the full resolution flow.
- The current shared runner still behaves like an action-driven discovery loop. The crawl-first inventory work must land before the scanner can satisfy the full public-page coverage requirement.
