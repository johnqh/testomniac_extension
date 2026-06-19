import { useState, useCallback } from 'react';
import type { NetworkClient } from '@sudobility/types';
import {
  useCreateTestScenario,
  useUpdateTestScenario,
  useDeleteTestScenario,
  useEndScan,
} from '@sudobility/testomniac_client';

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
  networkClient: NetworkClient;
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
  networkClient,
  runnerId,
  productId,
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

  const baseUrl = `${apiUrl}/api/v1`;
  const createTestScenarioMutation = useCreateTestScenario(
    networkClient,
    baseUrl
  );
  const updateTestScenarioMutation = useUpdateTestScenario(
    networkClient,
    baseUrl
  );
  const deleteTestScenarioMutation = useDeleteTestScenario(
    networkClient,
    baseUrl
  );
  const endScanMutation = useEndScan(networkClient, baseUrl);

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
      const json =
        editingId != null
          ? await updateTestScenarioMutation.mutateAsync({
              token,
              runnerId,
              scenarioId: editingId,
              data: {
                title: formTitle.trim(),
                startingPath: formPath.trim(),
                prompt: formPrompt.trim(),
              },
            })
          : await createTestScenarioMutation.mutateAsync({
              token,
              runnerId,
              data: {
                runnerId,
                title: formTitle.trim(),
                startingPath: formPath.trim(),
                prompt: formPrompt.trim(),
              },
            });
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
  }, [
    formTitle,
    formPath,
    formPrompt,
    editingId,
    runnerId,
    token,
    createTestScenarioMutation,
    updateTestScenarioMutation,
    onRefresh,
  ]);

  const handleDelete = useCallback(
    async (id: number) => {
      try {
        await deleteTestScenarioMutation.mutateAsync({
          token,
          runnerId,
          scenarioId: id,
        });
        onRefresh();
      } catch {
        // ignore
      }
    },
    [deleteTestScenarioMutation, token, runnerId, onRefresh]
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
      const json = await endScanMutation.mutateAsync({
        token,
        data: { productId },
      });
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
  }, [productId, token, endScanMutation, onRefresh]);

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
