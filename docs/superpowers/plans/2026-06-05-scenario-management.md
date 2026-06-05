# Scenario Management View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a context-aware scenario management view to the side panel that auto-shows when the URL has been scanned before, with CRUD, drill-down into interactions, and sequential execution with progress.

**Architecture:** Three new components (`ScenariosListView`, `ScenarioDetailView`, `ScenarioProgress`) rendered by SidePanel.tsx based on `appView` state. All scenario APIs already exist — no backend changes needed. The background worker already handles `START_SCENARIO` and broadcasts `SCENARIO_PROGRESS` — we just need the sidepanel listener.

**Tech Stack:** React 18, Tailwind CSS 3, TypeScript, Chrome Extension APIs

---

### Task 1: ScenariosListView Component

**Files:**
- Create: `src/sidepanel/components/ScenariosListView.tsx`

This component shows the scenario list with add/edit/delete and a "Detect Scenarios" button.

- [ ] **Step 1: Create ScenariosListView**

Create `src/sidepanel/components/ScenariosListView.tsx`:

```tsx
import { useState, useCallback } from 'react';

interface ScenarioItem {
  id: number;
  title: string;
  startingPath: string;
  prompt: string;
  sizeClass: string;
  personaId?: number | null;
}

interface ScenariosListViewProps {
  scenarios: ScenarioItem[];
  loading: boolean;
  token: string;
  apiUrl: string;
  runnerId: number;
  productId: number;
  testEnvironmentId: number | null;
  onRefresh: () => void;
  onSelectScenario: (scenario: ScenarioItem) => void;
  onRunScenario: (scenario: ScenarioItem) => void;
  onNewScan: () => void;
}

export function ScenariosListView({
  scenarios,
  loading,
  token,
  apiUrl,
  runnerId,
  productId,
  testEnvironmentId,
  onRefresh,
  onSelectScenario,
  onRunScenario,
  onNewScan,
}: ScenariosListViewProps) {
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [formTitle, setFormTitle] = useState('');
  const [formPath, setFormPath] = useState('');
  const [formPrompt, setFormPrompt] = useState('');
  const [saving, setSaving] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  const resetForm = () => {
    setFormTitle('');
    setFormPath('');
    setFormPrompt('');
    setEditingId(null);
    setShowForm(false);
  };

  const handleSave = useCallback(async () => {
    if (!formTitle.trim() || !formPath.trim() || !formPrompt.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const isEdit = editingId != null;
      const url = isEdit
        ? `${apiUrl}/api/v1/runners/${runnerId}/test-scenarios/${editingId}`
        : `${apiUrl}/api/v1/runners/${runnerId}/test-scenarios`;
      const res = await fetch(url, {
        method: isEdit ? 'PUT' : 'POST',
        headers,
        body: JSON.stringify({
          title: formTitle.trim(),
          startingPath: formPath.trim(),
          prompt: formPrompt.trim(),
        }),
      });
      const json = await res.json();
      if (!json.success) {
        setError(json.error ?? 'Failed to save');
        return;
      }
      resetForm();
      onRefresh();
    } catch {
      setError('Failed to save scenario');
    } finally {
      setSaving(false);
    }
  }, [formTitle, formPath, formPrompt, editingId, apiUrl, runnerId, token, onRefresh]);

  const handleDelete = useCallback(
    async (id: number) => {
      try {
        await fetch(
          `${apiUrl}/api/v1/runners/${runnerId}/test-scenarios/${id}`,
          { method: 'DELETE', headers }
        );
        onRefresh();
      } catch {
        // ignore
      }
    },
    [apiUrl, runnerId, token, onRefresh]
  );

  const handleEdit = (s: ScenarioItem) => {
    setEditingId(s.id);
    setFormTitle(s.title);
    setFormPath(s.startingPath);
    setFormPrompt(s.prompt);
    setShowForm(true);
  };

  const handleDetect = useCallback(async () => {
    setDetecting(true);
    setError(null);
    try {
      const res = await fetch(
        `${apiUrl}/api/v1/combined/detect-personas-and-scenarios`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ productId }),
        }
      );
      const json = await res.json();
      if (!json.success) {
        setError(json.error ?? 'Detection failed');
        return;
      }
      onRefresh();
    } catch {
      setError('Detection failed');
    } finally {
      setDetecting(false);
    }
  }, [apiUrl, productId, token, onRefresh]);

  return (
    <div className='space-y-3'>
      {/* Header */}
      <div className='flex items-center justify-between'>
        <div className='font-semibold text-gray-900 text-base'>Scenarios</div>
        <div className='flex items-center gap-2'>
          <button
            onClick={() => {
              resetForm();
              setShowForm(v => !v);
            }}
            className='text-xs font-medium text-blue-600 hover:text-blue-700'
          >
            {showForm && !editingId ? 'Cancel' : '+ Add'}
          </button>
          <button
            onClick={onNewScan}
            className='text-xs font-medium text-gray-500 hover:text-gray-700 border border-gray-300 rounded px-2 py-0.5'
          >
            New Scan
          </button>
        </div>
      </div>

      {error && (
        <div className='p-2 rounded-md bg-red-50 text-red-700 text-xs'>
          {error}
        </div>
      )}

      {/* Add/Edit form */}
      {showForm && (
        <div className='space-y-1.5 rounded-md border border-gray-200 bg-gray-50 p-2'>
          <input
            type='text'
            placeholder='Title (e.g., Checkout flow)'
            value={formTitle}
            onChange={e => setFormTitle(e.target.value)}
            className='w-full text-xs px-2 py-1 border border-gray-300 rounded'
          />
          <input
            type='text'
            placeholder='Starting path (e.g., /store)'
            value={formPath}
            onChange={e => setFormPath(e.target.value)}
            className='w-full text-xs px-2 py-1 border border-gray-300 rounded'
          />
          <textarea
            placeholder='Prompt (e.g., Add item to cart and complete checkout)'
            value={formPrompt}
            onChange={e => setFormPrompt(e.target.value)}
            rows={3}
            className='w-full text-xs px-2 py-1 border border-gray-300 rounded resize-none'
          />
          <div className='flex gap-1.5'>
            <button
              onClick={handleSave}
              disabled={saving || !formTitle.trim()}
              className='flex-1 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 px-3 py-1.5 rounded'
            >
              {saving ? 'Saving...' : editingId ? 'Update' : 'Create'}
            </button>
            <button
              onClick={resetForm}
              className='text-xs font-medium text-gray-600 hover:text-gray-800 px-3 py-1.5'
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Scenario list */}
      {loading && (
        <div className='text-center text-xs text-gray-400 py-4'>
          Loading scenarios...
        </div>
      )}

      {!loading && scenarios.length === 0 && !showForm && (
        <div className='text-center py-6 space-y-3'>
          <div className='text-xs text-gray-400'>No scenarios yet</div>
          <button
            onClick={handleDetect}
            disabled={detecting}
            className='text-xs font-medium text-blue-600 hover:text-blue-700 border border-blue-300 rounded-md px-3 py-1.5 hover:bg-blue-50 disabled:opacity-50'
          >
            {detecting ? 'Detecting...' : 'Detect Scenarios'}
          </button>
        </div>
      )}

      <div className='space-y-1'>
        {scenarios.map(s => (
          <div
            key={s.id}
            className='rounded-md border border-gray-200 bg-white px-2.5 py-2 flex items-center gap-2 hover:bg-gray-50 cursor-pointer'
            onClick={() => onSelectScenario(s)}
          >
            <div className='min-w-0 flex-1'>
              <div className='text-[11px] font-medium text-gray-800 truncate'>
                {s.title}
              </div>
              <div className='text-[10px] text-gray-400 truncate'>
                {s.startingPath}
              </div>
            </div>
            <button
              onClick={e => {
                e.stopPropagation();
                handleEdit(s);
              }}
              className='shrink-0 text-gray-400 hover:text-blue-600 p-1'
              title='Edit'
            >
              <svg
                xmlns='http://www.w3.org/2000/svg'
                viewBox='0 0 16 16'
                fill='currentColor'
                className='w-3 h-3'
              >
                <path d='M13.488 2.513a1.75 1.75 0 0 0-2.475 0L6.75 6.774a2.75 2.75 0 0 0-.596.892l-.848 2.047a.75.75 0 0 0 .98.98l2.047-.848a2.75 2.75 0 0 0 .892-.596l4.261-4.262a1.75 1.75 0 0 0 0-2.474Z' />
                <path d='M4.75 3.5c-.69 0-1.25.56-1.25 1.25v6.5c0 .69.56 1.25 1.25 1.25h6.5c.69 0 1.25-.56 1.25-1.25V9A.75.75 0 0 1 14 9v2.25A2.75 2.75 0 0 1 11.25 14h-6.5A2.75 2.75 0 0 1 2 11.25v-6.5A2.75 2.75 0 0 1 4.75 2H7a.75.75 0 0 1 0 1.5H4.75Z' />
              </svg>
            </button>
            <button
              onClick={e => {
                e.stopPropagation();
                handleDelete(s.id);
              }}
              className='shrink-0 text-gray-400 hover:text-red-600 p-1'
              title='Delete'
            >
              <svg
                xmlns='http://www.w3.org/2000/svg'
                viewBox='0 0 16 16'
                fill='currentColor'
                className='w-3 h-3'
              >
                <path
                  fillRule='evenodd'
                  d='M5 3.25V4H2.75a.75.75 0 0 0 0 1.5h.3l.815 8.15A1.5 1.5 0 0 0 5.357 15h5.285a1.5 1.5 0 0 0 1.493-1.35l.815-8.15h.3a.75.75 0 0 0 0-1.5H11v-.75A2.25 2.25 0 0 0 8.75 1h-1.5A2.25 2.25 0 0 0 5 3.25Zm2.25-.75a.75.75 0 0 0-.75.75V4h3v-.75a.75.75 0 0 0-.75-.75h-1.5ZM6.05 6a.75.75 0 0 1 .787.713l.275 5.5a.75.75 0 0 1-1.498.075l-.275-5.5A.75.75 0 0 1 6.05 6Zm3.9 0a.75.75 0 0 1 .712.787l-.275 5.5a.75.75 0 0 1-1.498-.075l.275-5.5A.75.75 0 0 1 9.95 6Z'
                  clipRule='evenodd'
                />
              </svg>
            </button>
            <button
              onClick={e => {
                e.stopPropagation();
                onRunScenario(s);
              }}
              className='shrink-0 w-6 h-6 flex items-center justify-center rounded-full text-white bg-green-500 hover:bg-green-600 text-[10px]'
              title='Run scenario'
            >
              {'\u25B6'}
            </button>
          </div>
        ))}
      </div>

      {scenarios.length > 0 && (
        <button
          onClick={handleDetect}
          disabled={detecting}
          className='w-full text-[10px] font-medium text-gray-500 hover:text-blue-600 py-1'
        >
          {detecting ? 'Detecting...' : 'Detect more scenarios'}
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify typecheck**

Run: `bun run type-check`
Expected: clean

---

### Task 2: ScenarioDetailView Component

**Files:**
- Create: `src/sidepanel/components/ScenarioDetailView.tsx`

Shows scenario metadata, interactions from the latest sequence, and the run button.

- [ ] **Step 1: Create ScenarioDetailView**

Create `src/sidepanel/components/ScenarioDetailView.tsx`:

```tsx
import { useState, useEffect, useCallback } from 'react';

interface ScenarioItem {
  id: number;
  title: string;
  startingPath: string;
  prompt: string;
  sizeClass: string;
}

interface SequenceInteraction {
  id: number;
  testScenarioSequenceId: number;
  testInteractionId: number;
  stepOrder: number;
  testInteraction?: {
    id: number;
    title: string;
    testType: string;
  };
}

interface ScenarioProgress {
  step: number;
  totalSteps: number;
  status: 'running' | 'completed' | 'error';
  interactionId?: number;
  error?: string;
}

interface ScenarioDetailViewProps {
  scenario: ScenarioItem;
  token: string;
  apiUrl: string;
  runnerId: number;
  testEnvironmentId: number | null;
  scenarioProgress: ScenarioProgress | null;
  onBack: () => void;
  onRun: (scenario: ScenarioItem) => void;
  onStop: () => void;
}

export function ScenarioDetailView({
  scenario,
  token,
  apiUrl,
  runnerId,
  testEnvironmentId,
  scenarioProgress,
  onBack,
  onRun,
  onStop,
}: ScenarioDetailViewProps) {
  const [interactions, setInteractions] = useState<SequenceInteraction[]>([]);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  // Fetch latest sequence and its interactions
  const fetchInteractions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Get sequences for this scenario
      const seqRes = await fetch(
        `${apiUrl}/api/v1/test-scenarios/${scenario.id}/sequences`,
        { headers }
      );
      const seqJson = await seqRes.json();
      if (!seqJson.success || !seqJson.data?.length) {
        setInteractions([]);
        return;
      }
      // Use the latest sequence (last in array)
      const latestSeq = seqJson.data[seqJson.data.length - 1];
      // Get interactions for this sequence
      const intRes = await fetch(
        `${apiUrl}/api/v1/test-scenarios/sequences/${latestSeq.id}/test-interactions`,
        { headers }
      );
      const intJson = await intRes.json();
      if (intJson.success && Array.isArray(intJson.data)) {
        const sorted = [...intJson.data].sort(
          (a: SequenceInteraction, b: SequenceInteraction) =>
            a.stepOrder - b.stepOrder
        );
        setInteractions(sorted);
      }
    } catch {
      setError('Failed to load interactions');
    } finally {
      setLoading(false);
    }
  }, [apiUrl, scenario.id, token]);

  useEffect(() => {
    void fetchInteractions();
  }, [fetchInteractions]);

  const handleGenerate = useCallback(async () => {
    if (!testEnvironmentId) {
      setError('No environment available');
      return;
    }
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch(
        `${apiUrl}/api/v1/test-scenarios/${scenario.id}/generate-sequence`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ testEnvironmentId }),
        }
      );
      const json = await res.json();
      if (!json.success) {
        setError(json.error ?? 'Generation failed');
        return;
      }
      await fetchInteractions();
    } catch {
      setError('Failed to generate sequence');
    } finally {
      setGenerating(false);
    }
  }, [apiUrl, scenario.id, testEnvironmentId, token, fetchInteractions]);

  const isRunning = scenarioProgress?.status === 'running';

  return (
    <div className='space-y-3'>
      {/* Header */}
      <div className='flex items-center gap-2'>
        <button
          onClick={onBack}
          className='text-xs text-blue-600 hover:text-blue-700 font-medium shrink-0'
        >
          &larr; Back
        </button>
        <div className='min-w-0 flex-1'>
          <div className='text-sm font-semibold text-gray-900 truncate'>
            {scenario.title}
          </div>
          <div className='text-[10px] text-gray-500 truncate'>
            {scenario.startingPath}
          </div>
        </div>
      </div>

      {/* Prompt (collapsible) */}
      {scenario.prompt && (
        <div>
          <button
            onClick={() => setShowPrompt(v => !v)}
            className='text-[10px] text-gray-500 hover:text-gray-700 font-medium'
          >
            {showPrompt ? 'Hide prompt' : 'Show prompt'}
          </button>
          {showPrompt && (
            <div className='mt-1 text-[11px] text-gray-600 bg-gray-50 rounded-md border border-gray-200 p-2 leading-relaxed'>
              {scenario.prompt}
            </div>
          )}
        </div>
      )}

      {error && (
        <div className='p-2 rounded-md bg-red-50 text-red-700 text-xs'>
          {error}
        </div>
      )}

      {/* Run / Stop button */}
      {!isRunning ? (
        <button
          onClick={() => onRun(scenario)}
          disabled={interactions.length === 0 || generating}
          className='w-full py-2 px-3 text-sm font-medium rounded-md bg-green-600 hover:bg-green-700 disabled:bg-green-400 text-white'
        >
          Run Scenario ({interactions.length} steps)
        </button>
      ) : (
        <button
          onClick={onStop}
          className='w-full py-2 px-3 text-sm font-medium rounded-md bg-red-600 hover:bg-red-700 text-white'
        >
          Stop
        </button>
      )}

      {/* Progress */}
      {scenarioProgress && (
        <div className='rounded-md border border-gray-200 bg-white p-2'>
          <div className='text-[11px] font-medium text-gray-700 mb-1.5'>
            {scenarioProgress.status === 'completed'
              ? 'Scenario complete!'
              : scenarioProgress.status === 'error'
                ? 'Scenario failed'
                : `Step ${scenarioProgress.step} of ${scenarioProgress.totalSteps}`}
          </div>
          {scenarioProgress.error && (
            <div className='text-[10px] text-red-600 mb-1'>
              {scenarioProgress.error}
            </div>
          )}
        </div>
      )}

      {/* Interactions */}
      {loading && (
        <div className='text-center text-xs text-gray-400 py-4'>
          Loading interactions...
        </div>
      )}

      {!loading && interactions.length === 0 && (
        <div className='text-center py-4 space-y-2'>
          <div className='text-xs text-gray-400'>
            No interactions yet — generate a sequence first
          </div>
          <button
            onClick={handleGenerate}
            disabled={generating}
            className='text-xs font-medium text-blue-600 hover:text-blue-700 border border-blue-300 rounded-md px-3 py-1.5 hover:bg-blue-50 disabled:opacity-50'
          >
            {generating ? 'Generating...' : 'Generate Sequence'}
          </button>
        </div>
      )}

      {interactions.length > 0 && (
        <div className='rounded-md border border-gray-200 overflow-hidden'>
          {interactions.map((link, idx) => {
            const stepNum = idx + 1;
            const isCompleted =
              scenarioProgress &&
              scenarioProgress.step > stepNum &&
              scenarioProgress.status === 'running';
            const isCurrent =
              scenarioProgress &&
              scenarioProgress.step === stepNum &&
              scenarioProgress.status === 'running';
            const isFailed =
              scenarioProgress &&
              scenarioProgress.step === stepNum &&
              scenarioProgress.status === 'error';
            const isSuccess =
              scenarioProgress?.status === 'completed' ||
              (scenarioProgress &&
                scenarioProgress.step > stepNum);

            return (
              <div
                key={link.id}
                className={`flex items-center gap-2 px-2.5 py-1.5 border-b border-gray-100 last:border-0 text-[11px] ${
                  isCurrent ? 'bg-blue-50' : ''
                }`}
              >
                <span className='shrink-0 w-4 text-center'>
                  {isSuccess ? (
                    <span className='text-green-500'>&#10003;</span>
                  ) : isCurrent ? (
                    <span className='text-blue-500 animate-pulse'>&#9679;</span>
                  ) : isFailed ? (
                    <span className='text-red-500'>&#10007;</span>
                  ) : (
                    <span className='text-gray-300'>&#9679;</span>
                  )}
                </span>
                <span className='text-[10px] text-gray-400 shrink-0 w-4'>
                  {stepNum}
                </span>
                <span
                  className={`truncate ${isCurrent ? 'text-blue-700 font-medium' : 'text-gray-700'}`}
                >
                  {link.testInteraction?.title ?? `Interaction #${link.testInteractionId}`}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify typecheck**

Run: `bun run type-check`
Expected: clean

---

### Task 3: Wire Views into SidePanel.tsx

**Files:**
- Modify: `src/sidepanel/SidePanel.tsx`

- [ ] **Step 1: Update AppView type and add imports**

Change the `AppView` type (line ~454):

```tsx
type AppView = 'home' | 'scenarios' | 'scenario-detail';
```

Add imports at the top:

```tsx
import { ScenariosListView } from './components/ScenariosListView';
import { ScenarioDetailView } from './components/ScenarioDetailView';
```

- [ ] **Step 2: Add scenario management state**

Near the existing scenario state (lines ~647-664), add:

```tsx
const [selectedScenario, setSelectedScenario] = useState<ScenarioItem | null>(
  null
);
const [scenarioProgress, setScenarioProgress] = useState<{
  step: number;
  totalSteps: number;
  status: 'running' | 'completed' | 'error';
  interactionId?: number;
  error?: string;
} | null>(null);
```

- [ ] **Step 3: Add SCENARIO_PROGRESS message listener**

In the existing `chrome.runtime.onMessage` listener (search for `listener`), add handling for `SCENARIO_PROGRESS`:

```tsx
if (message.type === 'SCENARIO_PROGRESS') {
  setScenarioProgress({
    step: message.step ?? 0,
    totalSteps: message.totalSteps ?? 0,
    status: message.status ?? 'running',
    interactionId: message.interactionId,
    error: message.error,
  });
  if (message.status === 'completed' || message.status === 'error') {
    setRunningScenarioId(null);
  }
}
```

- [ ] **Step 4: Add auto-detection logic**

After the `runSummary` is set (look for the existing effect that fetches the live dashboard and sets `runSummary`), add an effect that auto-switches to scenarios view:

```tsx
useEffect(() => {
  if (
    runSummary?.runnerId &&
    !isScanning &&
    !progress.isComplete &&
    appView === 'home'
  ) {
    setAppView('scenarios');
    void fetchScenarios();
  }
}, [runSummary?.runnerId, isScanning, progress.isComplete]);
```

Note: This triggers when `runSummary` is loaded from a previous scan (stored in chrome.storage) and no scan is active.

- [ ] **Step 5: Update handleRunScenario to navigate to detail and set progress**

Replace the existing `handleRunScenario`:

```tsx
const handleRunScenario = useCallback(
  async (scenario: ScenarioItem) => {
    const runnerId = runSummary?.runnerId;
    if (!runnerId || isScanning || runningScenarioId != null) return;
    setSelectedScenario(scenario);
    setAppView('scenario-detail');
    setRunningScenarioId(scenario.id);
    setScenarioProgress({ step: 0, totalSteps: 0, status: 'running' });
    try {
      chrome.runtime.sendMessage({
        type: 'START_SCENARIO',
        scenarioId: scenario.id,
        runnerId,
        startingPath: scenario.startingPath,
        testEnvironmentId: runSummary?.testEnvironmentId,
      });
    } catch {
      setRunningScenarioId(null);
      setScenarioProgress(null);
    }
  },
  [runSummary, isScanning, runningScenarioId]
);
```

- [ ] **Step 6: Render scenario views in the return statement**

In the main return (where `appView === 'scenarios'` already shows `scenariosView`), update the conditional rendering. Replace:

```tsx
{appView === 'scenarios' ? scenariosView : homeView}
```

With:

```tsx
{appView === 'scenario-detail' && selectedScenario ? (
  <div className='p-3 space-y-3 text-sm flex flex-col h-screen'>
    <ScenarioDetailView
      scenario={selectedScenario}
      token={token ?? ''}
      apiUrl={API_URL}
      runnerId={runSummary?.runnerId ?? 0}
      testEnvironmentId={runSummary?.testEnvironmentId ?? null}
      scenarioProgress={scenarioProgress}
      onBack={() => {
        setAppView('scenarios');
        setSelectedScenario(null);
        setScenarioProgress(null);
      }}
      onRun={handleRunScenario}
      onStop={() => {
        chrome.runtime.sendMessage({ type: 'STOP_SCAN' });
        setRunningScenarioId(null);
        setScenarioProgress(null);
      }}
    />
  </div>
) : appView === 'scenarios' ? (
  <div className='p-3 space-y-3 text-sm flex flex-col h-screen'>
    <ScenariosListView
      scenarios={scenarios}
      loading={loadingScenarios}
      token={token ?? ''}
      apiUrl={API_URL}
      runnerId={runSummary?.runnerId ?? 0}
      productId={Number(selectedProductId) || 0}
      testEnvironmentId={runSummary?.testEnvironmentId ?? null}
      onRefresh={fetchScenarios}
      onSelectScenario={s => {
        setSelectedScenario(s);
        setAppView('scenario-detail');
      }}
      onRunScenario={handleRunScenario}
      onNewScan={() => setAppView('home')}
    />
  </div>
) : (
  homeView
)}
```

- [ ] **Step 7: Verify and lint**

```bash
bun run type-check
bun run lint:fix
bun run lint
bun run build
```

All should pass.

---

### Task 4: Final Validation and Push

- [ ] **Step 1: Full validation**

```bash
bun run type-check && bun run lint && bun run build
```

- [ ] **Step 2: Push all repos**

```bash
cd /Users/johnhuang/projects/testomniac_app && bash scripts/push_all.sh
```
