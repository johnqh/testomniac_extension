import { useState, useEffect, useCallback, useMemo } from 'react';

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

export interface ScenarioProgress {
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

  const headers = useMemo(
    () => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    }),
    [token]
  );

  const fetchInteractions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const seqRes = await fetch(
        `${apiUrl}/api/v1/test-scenarios/${scenario.id}/sequences`,
        { headers }
      );
      const seqJson = await seqRes.json();
      if (!seqJson.success || !seqJson.data?.length) {
        setInteractions([]);
        return;
      }
      const latestSeq = seqJson.data[seqJson.data.length - 1];
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
  }, [apiUrl, scenario.id, headers]);

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
  }, [apiUrl, scenario.id, testEnvironmentId, headers, fetchInteractions]);

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
        <div
          className={`rounded-md border p-2 ${
            scenarioProgress.status === 'completed'
              ? 'border-green-200 bg-green-50'
              : scenarioProgress.status === 'error'
                ? 'border-red-200 bg-red-50'
                : 'border-blue-200 bg-blue-50'
          }`}
        >
          <div
            className={`text-[11px] font-medium ${
              scenarioProgress.status === 'completed'
                ? 'text-green-700'
                : scenarioProgress.status === 'error'
                  ? 'text-red-700'
                  : 'text-blue-700'
            }`}
          >
            {scenarioProgress.status === 'completed'
              ? 'Scenario complete!'
              : scenarioProgress.status === 'error'
                ? 'Scenario failed'
                : `Step ${scenarioProgress.step} of ${scenarioProgress.totalSteps}`}
          </div>
          {scenarioProgress.error && (
            <div className='text-[10px] text-red-600 mt-0.5'>
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
            const isSuccess =
              scenarioProgress?.status === 'completed' ||
              (scenarioProgress &&
                scenarioProgress.status === 'running' &&
                scenarioProgress.step > stepNum);
            const isCurrent =
              scenarioProgress &&
              scenarioProgress.step === stepNum &&
              scenarioProgress.status === 'running';
            const isFailed =
              scenarioProgress &&
              scenarioProgress.step === stepNum &&
              scenarioProgress.status === 'error';

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
                  {link.testInteraction?.title ??
                    `Interaction #${link.testInteractionId}`}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
