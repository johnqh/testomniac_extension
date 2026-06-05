# Scenario Management View Design

**Date:** 2026-06-05
**Status:** Approved

## Problem

The side panel only supports scanning. When a user visits a previously-scanned URL, they have no way to manage or run existing test scenarios without opening the full testomniac_app.

## Solution

A context-aware side panel that automatically shows a scenario management view when the current URL has been scanned before, with CRUD, drill-down, and sequential execution.

## Navigation Model

Three views driven by `appView` state:

| State | When Shown | Content |
|-------|-----------|---------|
| `home` | No runner for this URL, or user clicks "New Scan" | Scan config (existing) |
| `scenarios` | Runner exists + not scanning (auto-detected) | Scenario list with CRUD |
| `scenario-detail` | User clicks into a scenario | Interactions list + run button |

**Auto-detection logic:** When the side panel resolves the product/runner for the current URL, if a runner exists and no scan is running, set `appView = 'scenarios'`. A "New Scan" button lets the user switch to scan config.

**During/after scan:** The scan progress view takes over as today. When scan completes, the scenarios detected by the combined endpoint appear inline (already implemented). User can tap into one to reach scenario-detail.

## Scenarios List View

**Header:**
- "Scenarios" title
- "New Scan" button (top-right, switches to home/config view)
- "+" add button

**Scenario rows:**
- Title (bold, truncated)
- Starting path (subtitle, gray)
- Persona badge (if assigned, small colored pill)
- Tap row → navigate to scenario-detail
- Edit icon → expands inline edit form
- Delete icon → confirm and delete
- Play icon → shortcut to run (navigates to detail and auto-starts)

**Empty state:**
- "No scenarios yet" message
- "Detect Scenarios" button (calls `POST /combined/detect-personas-and-scenarios`)

**Add/Edit form (inline, collapsible):**
- Title input
- Starting path input
- Prompt textarea (3 rows)
- Save / Cancel buttons
- Same fields as testomniac_app's AddScenarioForm

## Scenario Detail View

**Header:**
- Back arrow → scenarios list
- Scenario title
- Edit icon (pencil) → inline edit of title/path/prompt

**Metadata:**
- Starting path
- Prompt (collapsible if long)
- Persona badge (if assigned)

**"Run Scenario" button** (prominent green, full-width)

**Interactions list:**
- Fetched from the latest sequence for this scenario
- If no sequence exists: "Generate Sequence" button (calls `POST /test-scenarios/{id}/generate-sequence`)
- Each row: step number, interaction title
- Ordered by stepOrder

## Scenario Execution Progress

When "Run Scenario" is pressed, the detail view switches to progress mode:

**Progress indicator:**
- "Step N of M" header
- Vertical step list: each interaction as a row
  - Completed: green checkmark + title
  - Current: blue pulse dot + title (bold)
  - Pending: gray dot + title
- Error: red dot + error message on the failed step

**Controls:**
- Stop button (sends existing STOP mechanism)

**Message flow:**
- Sidepanel sends `START_SCENARIO` message (already implemented)
- Background broadcasts `SCENARIO_PROGRESS` messages (already implemented)
- Sidepanel adds a listener for `SCENARIO_PROGRESS` to update step state
- On completion: show "Scenario complete!" banner, reset to detail view

## API Endpoints

All existing except the PUT for edit:

| Action | Method | Endpoint |
|--------|--------|----------|
| List | GET | `/runners/{runnerId}/test-scenarios` |
| Create | POST | `/runners/{runnerId}/test-scenarios` |
| **Edit** | **PUT** | **`/test-scenarios/{id}`** |
| Delete | DELETE | `/test-scenarios/{id}` |
| Get sequences | GET | `/test-scenarios/{id}/sequences` |
| Sequence interactions | GET | `/test-scenarios/sequences/{id}/test-interactions` |
| Generate sequence | POST | `/test-scenarios/{id}/generate-sequence` |
| Detect all | POST | `/combined/detect-personas-and-scenarios` |

**New endpoint — PUT /test-scenarios/:id:**
- Accepts: `{ title?, startingPath?, prompt?, personaId?, sizeClass? }`
- Updates only provided fields
- Returns updated scenario
- Add to `detail-read.ts` alongside existing scenario routes

## Component Structure

New components (keep SidePanel.tsx as orchestrator, extract views):

| Component | Responsibility |
|-----------|---------------|
| `ScenariosListView.tsx` | Scenario list, add form, detect button, delete |
| `ScenarioDetailView.tsx` | Scenario detail, interactions list, run button, edit |
| `ScenarioProgress.tsx` | Execution progress overlay with step indicators |

These are rendered inside SidePanel.tsx based on `appView` state. They receive props (token, runnerId, API_URL, callbacks) — no direct chrome.runtime calls.

## State Changes in SidePanel.tsx

- `appView` type expands: `'home' | 'scenarios' | 'scenario-detail'`
- New state: `selectedScenarioId: number | null`
- New state: `scenarioProgress: { step: number; totalSteps: number; status: string; error?: string } | null`
- Add `SCENARIO_PROGRESS` message listener in the existing chrome.runtime.onMessage handler
- Auto-detection: in the effect that resolves product/runner, if runner exists and !isScanning, set `appView = 'scenarios'`

## What Stays Unchanged

- Background worker's `runScenario()` function
- `START_SCENARIO` message protocol
- `SCENARIO_PROGRESS` broadcast protocol
- Scan flow (home view, scanning, results)
- Settings panel
- Auth flow
