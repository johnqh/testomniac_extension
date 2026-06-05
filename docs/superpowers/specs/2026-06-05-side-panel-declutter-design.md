# Side Panel Declutter Design

**Date:** 2026-06-05
**Status:** Approved
**Approach:** Smart Defaults + Collapsible Sections (progressive disclosure)

## Problem

The side panel shows all configuration, progress, and result data simultaneously in a 340px-wide space. Every option, every metric, every tree node competes for attention. Power users don't need dumbing down — they need better organization so the panel shows what matters *right now* and hides the rest behind one click.

## Principle

Nothing is removed. Everything is reachable. But the default state shows less. Power is one click away, not zero clicks.

## Design

### 1. Configuration Section — Collapsible Summary Card

**First run:** Full form expanded (workspace, product, environment, expertise checkboxes, scan depth, credential section). Same as today.

**Subsequent runs:** Config collapses into a 2-line summary card:
```
acme / store / production          [edit]
Full scan, all expertises
```

- Line 1: workspace / product / environment + edit icon
- Line 2: scan depth + expertise count summary (e.g., "Full scan, 5 of 7 expertises")
- Clicking the card or edit icon expands the full form
- Values persist in `chrome.storage.local` (already happens today)
- Credential section stays hidden unless "Continue with login" is checked (already works this way)
- Settings panel stays hidden by default (already works this way)

**Implementation notes:**
- Add a `hasRunBefore` flag (or check if workspace+product are already selected) to decide collapsed vs expanded
- Summary card is a new small component (~30 lines)
- Full form component stays as-is, just conditionally rendered

### 2. Scanning/Progress Section — Simplified Counters, Fewer Tabs

**Counters:**
- Change from clickable buttons to plain text with subtle labels
- Remove flip animation on number changes
- Keep the 4-column grid layout (Pages / States / Tests / Errors)
- Keep phase indicator dots and elapsed timer as-is

**Scan controls:**
- Pause/Resume/Stop buttons stay as-is

**Tab bar — reduce from 5 tabs to 3:**

| Old Tabs | New Tabs | What Changed |
|----------|----------|--------------|
| Overview | **Overview** | Unchanged — screenshot + AI summary + expertise error grid |
| Issues (Errors) | **Issues** | Unchanged — findings list sorted by timestamp with severity badges |
| Navigation + Coverage + All Events | **Details** | Merged into one tab with collapsible sections |

### 3. Details Tab — Progressive Disclosure

The Details tab contains 3 collapsible sections in a vertical stack. Last-opened section is remembered.

**Navigation section:**
- Unchanged — the tree structure is already progressive disclosure
- Section header: "Navigation" + page count badge

**Coverage section:**
- Each tree level starts **collapsed**, showing title + count badge
- Level 0 (Bundle): `Discovery Bundle (8 surfaces)`
- Level 1 (Surface): `Page: /checkout (12 tests, 2 errors)` — click to expand
- Level 2 (Interaction): one-liner with title + status dot (green/red/gray) — click to expand
- Level 3 (Run detail): expands inline to show run ID, duration, steps, findings metadata
- Section header: "Coverage" + surface count badge

**Events section:**
- Show **last 20 events** by default (not 200)
- Each event is a one-liner: `timestamp  type  message`
- Click event row to expand and show context tags (test type, surface, element ID, run ID, path, dependency)
- "Show all" link at bottom loads the full 200-event list
- Section header: "Events" + event count badge

### 4. Bottom Status Bar — Thinner

- Reduce height — one line, smaller text (text-xs)
- Remove pulse animation on status dot (phase indicator already communicates "active")
- Keep the status dot color (green/yellow/red) and current-page text

## Component Changes

| File | Change |
|------|--------|
| `SidePanel.tsx` | Add collapsed/expanded config state, render summary card when collapsed, reduce tab bar from 5 to 3, merge Nav/Coverage/Events into Details tab |
| New: `ConfigSummary.tsx` | Small component (~30 lines) showing the 2-line summary card |
| Coverage rendering section | Wrap each tree level in collapsible containers, start collapsed |
| Events rendering section | Limit to 20 events, add expand-on-click per row, add "Show all" link |
| Counter grid section | Remove button styling and flip animation, use plain text |
| Status bar section | Reduce padding/font-size, remove pulse animation |

## What Stays Unchanged

- Authentication flow (LoginPage component)
- Settings panel (already hidden by default)
- Scenarios view
- Overview tab content
- Issues tab content
- Navigation tree rendering
- All scan control buttons (Test, Pause, Resume, Stop)
- All data fetching and message passing
- Background service worker

## Out of Scope

- Responsive breakpoints for different panel widths
- Theming or color changes
- New features or additional data views
- Restructuring the background/sidepanel message protocol
