import { useState, useEffect, useCallback } from 'react';
import browser from 'webextension-polyfill';
import type { Tabs } from 'webextension-polyfill';
import { MessageType, MessageTarget, generateMessageId } from '../shared/types/messaging';
import type { TestRun } from '@testomniac/types';

interface TestStatus {
  isRunning: boolean;
  currentTestRun: TestRun | null;
  currentStep: number;
  logs: string[];
}

export default function App() {
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState<TestStatus>({
    isRunning: false,
    currentTestRun: null,
    currentStep: 0,
    logs: [],
  });
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const response = await browser.runtime.sendMessage({
        id: generateMessageId(),
        type: MessageType.TEST_STATUS,
        target: MessageTarget.BACKGROUND,
        timestamp: Date.now(),
      }) as TestStatus;
      setStatus(response);
    } catch (err) {
      console.error('Failed to get status:', err);
    }
  }, []);

  // Get current tab URL on mount
  useEffect(() => {
    browser.tabs.query({ active: true, currentWindow: true }).then((tabs: Tabs.Tab[]) => {
      if (tabs[0]?.url && !tabs[0].url.startsWith('chrome://')) {
        setUrl(tabs[0].url);
      }
    });

    // Get current test status
    refreshStatus();

    // Poll for updates while test is running
    const interval = setInterval(refreshStatus, 1000);
    return () => clearInterval(interval);
  }, [refreshStatus]);

  const handleStartTest = async () => {
    if (!url.trim()) {
      setError('Please enter a URL');
      return;
    }

    setError(null);

    try {
      await browser.runtime.sendMessage({
        id: generateMessageId(),
        type: MessageType.START_TEST,
        target: MessageTarget.BACKGROUND,
        timestamp: Date.now(),
        payload: { url: url.trim() },
      });

      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start test');
    }
  };

  const handleStopTest = async () => {
    try {
      await browser.runtime.sendMessage({
        id: generateMessageId(),
        type: MessageType.STOP_TEST,
        target: MessageTarget.BACKGROUND,
        timestamp: Date.now(),
      });

      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop test');
    }
  };

  return (
    <div className="p-4 bg-gray-50 min-h-full">
      <div className="flex items-center gap-2 mb-4">
        <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
          <span className="text-white font-bold text-sm">T</span>
        </div>
        <h1 className="text-lg font-bold text-gray-900">Testomniac</h1>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {!status.isRunning ? (
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Test URL
            </label>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
            />
          </div>

          <button
            onClick={handleStartTest}
            className="w-full py-2 px-4 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
          >
            Start Test
          </button>

          <div className="text-xs text-gray-500 text-center">
            AI will automatically explore and test the page
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="p-4 bg-white rounded-lg border border-gray-200">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-3 h-3 bg-green-500 rounded-full animate-pulse"></div>
              <span className="font-medium text-gray-900">Test Running</span>
            </div>

            <div className="text-sm text-gray-600 space-y-1">
              <div>
                <span className="text-gray-500">URL:</span>{' '}
                <span className="truncate block text-xs">{status.currentTestRun?.startUrl}</span>
              </div>
              <div>
                <span className="text-gray-500">Step:</span>{' '}
                {status.currentStep}
              </div>
              <div>
                <span className="text-gray-500">Issues:</span>{' '}
                {status.currentTestRun?.issues.length || 0}
              </div>
            </div>
          </div>

          {/* Logs */}
          <div className="bg-gray-900 rounded-lg p-3 max-h-48 overflow-y-auto">
            <div className="text-xs font-mono text-gray-300 space-y-1">
              {status.logs && status.logs.length > 0 ? (
                status.logs.map((log, i) => (
                  <div key={i} className="text-green-400">{log}</div>
                ))
              ) : (
                <div className="text-gray-500">Waiting for logs...</div>
              )}
            </div>
          </div>

          <button
            onClick={handleStopTest}
            className="w-full py-2 px-4 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors font-medium"
          >
            Stop Test
          </button>
        </div>
      )}
    </div>
  );
}
