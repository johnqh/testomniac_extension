# Side Panel Declutter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce visual clutter in the side panel through progressive disclosure — collapsible config, fewer tabs, collapsed tree nodes, and a thinner status bar.

**Architecture:** All changes are in `SidePanel.tsx` (2615 lines). We add one small component (`ConfigSummary`) and modify the existing file's JSX and state. No new data fetching, no API changes, no background worker changes.

**Tech Stack:** React 18, Tailwind CSS 3, TypeScript

---

### Task 1: Collapsible Config Summary Card

**Files:**
- Create: `src/sidepanel/components/ConfigSummary.tsx`
- Modify: `src/sidepanel/SidePanel.tsx:452-475` (state), `src/sidepanel/SidePanel.tsx:1636-1975` (config JSX)

- [ ] **Step 1: Create ConfigSummary component**

Create `src/sidepanel/components/ConfigSummary.tsx`:

```tsx
interface ConfigSummaryProps {
  entityName: string;
  productName: string;
  environmentLabel: string;
  scanMode: string;
  expertiseCount: number;
  totalExpertises: number;
  onExpand: () => void;
}

export function ConfigSummary({
  entityName,
  productName,
  environmentLabel,
  scanMode,
  expertiseCount,
  totalExpertises,
  onExpand,
}: ConfigSummaryProps) {
  const modeLabel =
    scanMode === 'full'
      ? 'Full scan'
      : scanMode === 'partial'
        ? 'Partial scan'
        : 'Minimum scan';
  const expertiseLabel =
    expertiseCount === totalExpertises
      ? 'all expertises'
      : `${expertiseCount} of ${totalExpertises} expertises`;

  return (
    <button
      onClick={onExpand}
      className='w-full text-left rounded-md border border-gray-200 bg-gray-50 px-3 py-2 hover:bg-gray-100 transition-colors'
    >
      <div className='flex items-center justify-between'>
        <span className='text-xs font-medium text-gray-800 truncate'>
          {entityName} / {productName} / {environmentLabel}
        </span>
        <svg
          xmlns='http://www.w3.org/2000/svg'
          viewBox='0 0 16 16'
          fill='currentColor'
          className='w-3 h-3 text-gray-400 shrink-0 ml-1'
        >
          <path d='M13.488 2.513a1.75 1.75 0 0 0-2.475 0L6.75 6.774a2.75 2.75 0 0 0-.596.892l-.848 2.047a.75.75 0 0 0 .98.98l2.047-.848a2.75 2.75 0 0 0 .892-.596l4.261-4.262a1.75 1.75 0 0 0 0-2.474Z' />
          <path d='M4.75 3.5c-.69 0-1.25.56-1.25 1.25v6.5c0 .69.56 1.25 1.25 1.25h6.5c.69 0 1.25-.56 1.25-1.25V9A.75.75 0 0 1 14 9v2.25A2.75 2.75 0 0 1 11.25 14h-6.5A2.75 2.75 0 0 1 2 11.25v-6.5A2.75 2.75 0 0 1 4.75 2H7a.75.75 0 0 1 0 1.5H4.75Z' />
        </svg>
      </div>
      <div className='text-[10px] text-gray-500 mt-0.5'>
        {modeLabel}, {expertiseLabel}
      </div>
    </button>
  );
}
```

- [ ] **Step 2: Add config expanded/collapsed state to SidePanel**

In `SidePanel.tsx`, near the other state declarations (around line 472), add:

```tsx
const [configExpanded, setConfigExpanded] = useState(false);
```

Add a derived boolean that decides whether to show the summary or the full form. The rule: show summary when workspace, product are already selected AND not scanning:

```tsx
const canCollapseConfig = !!(selectedEntityId && selectedProductId);
const showConfigSummary = canCollapseConfig && !configExpanded && !isScanning;
const showConfigForm = !canCollapseConfig || configExpanded || isScanning;
```

- [ ] **Step 3: Wire up the summary/form toggle in JSX**

Import `ConfigSummary` at the top of `SidePanel.tsx`:

```tsx
import { ConfigSummary } from './components/ConfigSummary';
```

Replace the `{!isScanning && (` block (lines ~1637-1975) that wraps the workspace/product/environment/expertise/scanMode/credentials form. Wrap it in a conditional:

```tsx
{/* Config: summary or full form */}
{!isScanning && showConfigSummary && (
  <ConfigSummary
    entityName={entityOptions.find(e => e.value === selectedEntityId)?.label ?? ''}
    productName={productOptions.find(p => p.value === selectedProductId)?.label ?? ''}
    environmentLabel={isLocalEnvironment ? `Local (${activeHostname})` : resolvedEnvironmentLabel || activeHostname || ''}
    scanMode={scanMode}
    expertiseCount={selectedExpertiseSlugs.length}
    totalExpertises={EXPERTISE_OPTIONS.length}
    onExpand={() => setConfigExpanded(true)}
  />
)}
{!isScanning && showConfigForm && (
  <div className='space-y-2'>
    {canCollapseConfig && (
      <button
        onClick={() => setConfigExpanded(false)}
        className='text-[10px] text-blue-600 hover:text-blue-700 font-medium'
      >
        Collapse
      </button>
    )}
    {/* ...existing workspace/product/environment/expertise/scanMode/credentials JSX stays here unchanged... */}
  </div>
)}
```

- [ ] **Step 4: Reset configExpanded when scan starts**

In the `handleTestCurrentPage` function, add `setConfigExpanded(false)` at the beginning so the config collapses when a scan starts.

- [ ] **Step 5: Verify and commit**

Run: `bun run type-check`
Expected: clean

```bash
git add src/sidepanel/components/ConfigSummary.tsx src/sidepanel/SidePanel.tsx
git commit -m "feat: collapsible config summary card for side panel"
```

---

### Task 2: Simplify Counter Grid — Remove FlipNumbers and Button Styling

**Files:**
- Modify: `src/sidepanel/SidePanel.tsx:2091-2158` (counter grid)

- [ ] **Step 1: Replace counter buttons with plain divs**

Replace the counter grid block (lines ~2091-2158). Remove `FlipNumbers` usage and button styling. Replace with plain text counters:

```tsx
{/* Counters */}
{(isScanning || progress.isComplete) && (
  <div className='grid grid-cols-4 gap-1'>
    {([
      { label: 'Pages', value: progress.pagesFound, color: 'text-blue-600' },
      { label: 'States', value: progress.pageStatesFound, color: 'text-purple-600' },
      { label: 'Tests', value: progress.testRunsCompleted, color: 'text-green-600' },
      { label: 'Errors', value: errorCount, color: 'text-red-600' },
    ] as const).map(c => (
      <div key={c.label} className='text-center py-1.5'>
        <div className={`text-lg font-bold font-mono tabular-nums ${c.color}`}>
          {c.value}
        </div>
        <div className='text-[10px] text-gray-500'>{c.label}</div>
      </div>
    ))}
  </div>
)}
```

- [ ] **Step 2: Remove FlipNumbers import**

Remove the import at line 14:
```tsx
// DELETE this line:
import FlipNumbers from 'react-flip-numbers';
```

- [ ] **Step 3: Verify and commit**

Run: `bun run type-check`
Expected: clean

```bash
git add src/sidepanel/SidePanel.tsx
git commit -m "feat: simplify counter grid to plain text, remove FlipNumbers"
```

---

### Task 3: Reduce Tab Bar from 5 to 3 Tabs

**Files:**
- Modify: `src/sidepanel/SidePanel.tsx:447-449` (ResultTab type), `src/sidepanel/SidePanel.tsx:2160-2185` (tab bar), `src/sidepanel/SidePanel.tsx:2246-2474` (tab content for map/coverage/events)

- [ ] **Step 1: Update ResultTab type**

Change the `ResultTab` type (around line 447-449) from:

```tsx
type ResultTab = 'overview' | 'map' | 'issues' | 'coverage' | 'events';
```

to:

```tsx
type ResultTab = 'overview' | 'issues' | 'details';
```

Fix any resulting type errors — the counter grid no longer sets tabs by key (removed in Task 2). Search for `setResultTab` calls that use `'map'`, `'coverage'`, or `'events'` and change them to `'details'`.

- [ ] **Step 2: Update tab bar JSX**

Replace the tab bar array (lines ~2163-2170):

```tsx
{([
  { key: 'overview', label: 'Overview' },
  { key: 'issues', label: 'Issues' },
  { key: 'details', label: 'Details' },
] as const).map(tab => (
```

- [ ] **Step 3: Merge Navigation + Coverage + Events into Details tab**

Replace the three separate `resultTab === 'map'`, `resultTab === 'coverage'`, and `resultTab === 'events'` blocks with a single `resultTab === 'details'` block containing collapsible sections:

```tsx
{resultTab === 'details' && (
  <div className='flex-1 overflow-y-auto'>
    {/* Navigation Section */}
    <DetailsSection title='Navigation' count={navigationMap?.discoveredPages?.length ?? 0}>
      {/* ...existing map content (lines ~2251-2277)... */}
    </DetailsSection>

    {/* Coverage Section */}
    <DetailsSection title='Coverage' count={runStructure?.surfaces?.length ?? 0}>
      {/* ...existing coverage content (lines ~2316-2413)... */}
    </DetailsSection>

    {/* Events Section */}
    <DetailsSection title='Events' count={progress.events.length}>
      {/* ...existing events content but limited — see Task 4... */}
    </DetailsSection>
  </div>
)}
```

Add a `DetailsSection` helper inside `SidePanel.tsx` (or as a small inline component) that handles the collapsible section pattern:

```tsx
function DetailsSection({
  title,
  count,
  children,
  defaultOpen = false,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className='border-b border-gray-200 last:border-0'>
      <button
        onClick={() => setOpen(o => !o)}
        className='w-full flex items-center justify-between px-2 py-1.5 bg-gray-50 hover:bg-gray-100 text-xs font-medium text-gray-700'
      >
        <span>{title}</span>
        <span className='flex items-center gap-1'>
          <span className='text-[10px] font-normal text-gray-500'>
            {count}
          </span>
          <span className='text-gray-400'>{open ? '\u25B4' : '\u25BE'}</span>
        </span>
      </button>
      {open && children}
    </div>
  );
}
```

- [ ] **Step 4: Verify and commit**

Run: `bun run type-check`
Expected: clean

```bash
git add src/sidepanel/SidePanel.tsx
git commit -m "feat: merge navigation/coverage/events into collapsible Details tab"
```

---

### Task 4: Progressive Disclosure for Coverage Tree and Events

**Files:**
- Modify: `src/sidepanel/SidePanel.tsx` (coverage and events sections inside the Details tab)

- [ ] **Step 1: Make coverage surfaces collapsible**

Wrap each surface's test interactions in a collapsible. The surface row shows title + interaction count + status. Click to expand and see the test interactions. Replace the surface rendering block:

```tsx
{(runStructure?.surfaces ?? []).map(surface => {
  const statusText = surface.surfaceRuns.map(r => r.status).join(', ') || 'pending';
  return (
    <CollapsibleRow
      key={surface.id}
      label={surface.title}
      badge={`${surface.testInteractions.length} tests`}
      status={statusText}
    >
      {surface.testInteractions.map(ti => (
        <CollapsibleRow
          key={ti.id}
          label={ti.title}
          badge={ti.testType}
          status={ti.interactionRuns.length > 0
            ? ti.interactionRuns.map(r => r.status).join(', ')
            : 'pending'}
          indent
        >
          {ti.interactionRuns.map(run => {
            const errorCount = run.findings.filter(f => f.type === 'error').length;
            return (
              <div key={run.id} className='px-4 py-1 text-[10px] text-gray-600'>
                run {run.id} · {run.status}
                {run.durationMs != null ? ` · ${run.durationMs}ms` : ''}
                {errorCount > 0 ? ` · ${errorCount} error${errorCount === 1 ? '' : 's'}` : ''}
              </div>
            );
          })}
        </CollapsibleRow>
      ))}
    </CollapsibleRow>
  );
})}
```

Add a `CollapsibleRow` helper:

```tsx
function CollapsibleRow({
  label,
  badge,
  status,
  indent,
  children,
}: {
  label: string;
  badge?: string;
  status?: string;
  indent?: boolean;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const hasChildren = React.Children.count(children) > 0;
  return (
    <div className={indent ? 'ml-2' : ''}>
      <button
        onClick={() => hasChildren && setOpen(o => !o)}
        className={`w-full text-left flex items-center justify-between gap-1 px-2 py-1 border-b border-gray-100 text-[10px] font-mono ${
          hasChildren ? 'hover:bg-gray-50 cursor-pointer' : 'cursor-default'
        }`}
      >
        <span className='text-gray-700 truncate min-w-0'>{label}</span>
        <span className='flex items-center gap-1 shrink-0'>
          {badge && (
            <span className='rounded bg-slate-200 px-1 py-0.5 text-[9px] uppercase text-slate-600'>
              {badge}
            </span>
          )}
          {status && (
            <span className={`text-[9px] ${status === 'completed' ? 'text-green-600' : status === 'failed' ? 'text-red-600' : 'text-gray-500'}`}>
              {status}
            </span>
          )}
          {hasChildren && (
            <span className='text-gray-400 text-[9px]'>{open ? '\u25B4' : '\u25BE'}</span>
          )}
        </span>
      </button>
      {open && children}
    </div>
  );
}
```

- [ ] **Step 2: Limit events to 20 with expand**

Replace the events rendering inside the Details tab. Show last 20 events by default. Each event is a one-liner that expands on click to show context tags:

```tsx
{(() => {
  const [showAllEvents, setShowAllEvents] = useState(false);
  const allEvents = enrichedEventRows;
  const visibleEvents = showAllEvents ? allEvents : allEvents.slice(-20);
  return (
    <div className='font-mono text-[10px]'>
      {visibleEvents.map(({ key, event, testInteractionRunId, context }) => (
        <CollapsibleEventRow
          key={key}
          event={event}
          context={context}
          testInteractionRunId={testInteractionRunId}
        />
      ))}
      {!showAllEvents && allEvents.length > 20 && (
        <button
          onClick={() => setShowAllEvents(true)}
          className='w-full py-1.5 text-center text-[10px] text-blue-600 hover:text-blue-700 font-medium border-t border-gray-100'
        >
          Show all {allEvents.length} events
        </button>
      )}
    </div>
  );
})()}
```

Add `CollapsibleEventRow`:

```tsx
function CollapsibleEventRow({
  event,
  context,
  testInteractionRunId,
}: {
  event: { type: string; message: string; timestamp: number };
  context: any;
  testInteractionRunId?: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className='px-2 py-0.5 border-b border-gray-100 last:border-0 cursor-pointer hover:bg-gray-50'
      onClick={() => setOpen(o => !o)}
    >
      <div>
        <span className='text-gray-400'>
          {new Date(event.timestamp).toLocaleTimeString()}
        </span>{' '}
        <span className='text-blue-600'>{event.type}</span>{' '}
        <span className='text-gray-600'>{event.message}</span>
      </div>
      {open && context && (
        <>
          <div className='mt-0.5 flex flex-wrap items-center gap-1 text-[9px] text-gray-500'>
            <span className='rounded bg-slate-200 px-1.5 py-0.5 uppercase tracking-wide text-slate-700'>
              {context.testType}
            </span>
            <span className='rounded bg-gray-100 px-1.5 py-0.5'>
              {context.surfaceTitle}
            </span>
            <span className='rounded bg-gray-100 px-1.5 py-0.5'>
              element #{context.testInteractionId}
            </span>
            {testInteractionRunId && (
              <span className='rounded bg-gray-100 px-1.5 py-0.5'>
                run #{testInteractionRunId}
              </span>
            )}
            {context.startingPath && (
              <span className='rounded bg-gray-100 px-1.5 py-0.5'>
                {context.startingPath}
              </span>
            )}
          </div>
          <div className='mt-0.5 text-gray-700 break-words'>
            {context.title}
            {context.durationMs != null ? ` · ${context.durationMs}ms` : ''}
            {context.findingsCount > 0
              ? ` · ${context.findingsCount} finding${context.findingsCount === 1 ? '' : 's'}`
              : ''}
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Verify and commit**

Run: `bun run type-check`
Expected: clean

```bash
git add src/sidepanel/SidePanel.tsx
git commit -m "feat: collapsible coverage tree and limited events with expand"
```

---

### Task 5: Thinner Status Bar

**Files:**
- Modify: `src/sidepanel/SidePanel.tsx:2595-2612` (status bar)

- [ ] **Step 1: Slim down the status bar**

Replace the status bar JSX (lines ~2595-2612):

```tsx
{(isScanning || activeStatusUpdate) && (
  <div className='fixed inset-x-0 bottom-0 z-50 border-t border-gray-200 bg-white/95 px-3 py-1 text-[10px] text-gray-600 backdrop-blur'>
    <div className='flex items-center gap-1.5'>
      <span
        className={`h-1.5 w-1.5 rounded-full shrink-0 ${
          isScanning && !progress.isPaused
            ? 'bg-blue-500'
            : progress.phase === 'failed'
              ? 'bg-red-500'
              : progress.phase === 'completed'
                ? 'bg-green-500'
                : 'bg-gray-400'
        }`}
      />
      <span className='truncate'>{activeStatusUpdate ?? 'Ready'}</span>
    </div>
  </div>
)}
```

Changes from original:
- `py-2` → `py-1` (thinner)
- `text-xs` → `text-[10px]` (smaller text)
- `text-gray-700` → `text-gray-600` (subtler)
- `h-2 w-2` → `h-1.5 w-1.5` (smaller dot)
- Removed `animate-pulse` from the blue dot
- Removed `shadow-sm` (less visual weight)

Also update `pb-11` on the outer container (line ~2593) to `pb-8` since the bar is thinner:

```tsx
<div className='relative min-h-screen pb-8'>
```

- [ ] **Step 2: Verify and commit**

Run: `bun run type-check`
Expected: clean

```bash
git add src/sidepanel/SidePanel.tsx
git commit -m "feat: thinner status bar without pulse animation"
```

---

### Task 6: Final Cleanup and Push

- [ ] **Step 1: Run full validation**

```bash
bun run type-check
bun run lint
bun run build
```

All should pass.

- [ ] **Step 2: Remove `react-flip-numbers` dependency**

Since we removed FlipNumbers usage in Task 2:

```bash
bun remove react-flip-numbers
```

- [ ] **Step 3: Final commit and push**

```bash
bun run type-check && bun run build
git add -A
git commit -m "chore: remove react-flip-numbers dependency"
```

Run `push_all.sh` if desired.
