import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuthStatus } from '@sudobility/auth-components';
import { getFirebaseAuth } from '@sudobility/auth_lib';
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  signInWithPopup,
} from 'firebase/auth';
import { LoginPage } from '@sudobility/building_blocks';
import { useAuthTokenSync } from './hooks/useAuthTokenSync';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8027';

interface ScanProgress {
  phase: string;
  pagesFound: number;
  pageStatesFound: number;
  actionsCompleted: number;
  issuesFound: number;
  currentPageUrl: string | null;
  latestScreenshotDataUrl: string | null;
  isComplete: boolean;
  events: Array<{ type: string; message: string; timestamp: number }>;
}

const initialProgress: ScanProgress = {
  phase: 'idle',
  pagesFound: 0,
  pageStatesFound: 0,
  actionsCompleted: 0,
  issuesFound: 0,
  currentPageUrl: null,
  latestScreenshotDataUrl: null,
  isComplete: false,
  events: [],
};

export function SidePanel() {
  const { user, isAuthenticated, loading, signOut } = useAuthStatus();
  const token = useAuthTokenSync();
  const [activeTabUrl, setActiveTabUrl] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [progress, setProgress] = useState<ScanProgress>(initialProgress);
  const eventLogRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  // Get active tab URL
  useEffect(() => {
    async function getActiveTab() {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tab?.url && tab.url.startsWith('http')) {
        setActiveTabUrl(tab.url);
      }
    }
    getActiveTab();

    // Update when tab changes
    const listener = () => {
      getActiveTab();
    };
    chrome.tabs.onActivated.addListener(listener);
    const updateListener = (
      _tabId: number,
      _changeInfo: unknown,
      tab: chrome.tabs.Tab
    ) => {
      if (tab.active && tab.url && tab.url.startsWith('http')) {
        setActiveTabUrl(tab.url);
      }
    };
    chrome.tabs.onUpdated.addListener(updateListener);
    return () => {
      chrome.tabs.onActivated.removeListener(listener);
      chrome.tabs.onUpdated.removeListener(updateListener);
    };
  }, []);

  // Submit current page URL to API (same as testomniac_app HomePage)
  const handleTestCurrentPage = useCallback(async () => {
    if (!activeTabUrl) return;
    setError(null);
    setIsSubmitting(true);
    try {
      const response = await fetch(`${API_URL}/api/v1/scan`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ url: activeTabUrl }),
      });
      const data = await response.json();
      if (data.success && data.data?.runId) {
        setProgress({
          ...initialProgress,
          phase: 'mouse_scanning',
          currentPageUrl: activeTabUrl,
        });
        setIsScanning(true);
        // Tell background worker to start scanning the current tab
        chrome.runtime.sendMessage({
          type: 'START_SCAN',
          url: activeTabUrl,
          runId: data.data.runId,
        });
        setError(null);
      } else {
        setError(data.data?.message || data.error || 'Failed to submit scan');
      }
    } catch {
      setError('Failed to connect to API');
    } finally {
      setIsSubmitting(false);
    }
  }, [activeTabUrl, token]);

  // Auto-scroll event log to bottom
  useEffect(() => {
    if (eventLogRef.current) {
      eventLogRef.current.scrollTop = eventLogRef.current.scrollHeight;
    }
  }, [progress.events.length]);

  // Listen for progress updates from background
  useEffect(() => {
    const listener = (message: { type: string; data?: ScanProgress }) => {
      if (message.type === 'SCAN_PROGRESS' && message.data) {
        setProgress(message.data);
        if (message.data.isComplete) {
          setIsScanning(false);
        }
      }
      if (message.type === 'SCAN_ERROR') {
        setError(
          String((message as { error?: string }).error || 'Scan failed')
        );
        setIsScanning(false);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const handleStop = useCallback(() => {
    chrome.runtime.sendMessage({ type: 'STOP_SCAN' });
    setIsScanning(false);
  }, []);

  const phases = [
    { key: 'mouse_scanning', label: 'Scanning' },
    { key: 'ai_analysis', label: 'AI Analysis' },
    { key: 'input_scanning', label: 'Input Testing' },
    { key: 'test_generation', label: 'Generating' },
    { key: 'test_execution', label: 'Executing' },
  ];

  const currentPhaseIndex = phases.findIndex(p => p.key === progress.phase);

  if (loading) {
    return (
      <div className='p-3 text-sm text-gray-500 flex items-center justify-center h-32'>
        Loading...
      </div>
    );
  }

  if (!isAuthenticated) {
    const auth = getFirebaseAuth();
    if (!auth) {
      return (
        <div className='p-3 text-sm text-red-600'>Firebase not configured</div>
      );
    }
    return (
      <LoginPage
        appName='Testomniac'
        className='!min-h-0 !pt-4 !pb-4'
        onEmailSignIn={async (email, password) => {
          await signInWithEmailAndPassword(auth, email, password);
        }}
        onEmailSignUp={async (email, password) => {
          await createUserWithEmailAndPassword(auth, email, password);
        }}
        onGoogleSignIn={async () => {
          await signInWithPopup(auth, new GoogleAuthProvider());
        }}
        onSuccess={() => {}}
      />
    );
  }

  return (
    <div className='p-3 space-y-3 text-sm'>
      {/* Header */}
      <div className='flex items-center justify-between'>
        <div className='font-semibold text-gray-900 text-base'>
          Testomniac Scanner
        </div>
        <div className='flex items-center gap-2'>
          <span className='text-xs text-gray-500 truncate max-w-[140px]'>
            {user?.email}
          </span>
          <button
            onClick={() => signOut()}
            className='text-xs text-gray-400 hover:text-gray-600'
          >
            Sign out
          </button>
        </div>
      </div>

      {/* Test Current Page Button */}
      {activeTabUrl && !isScanning && (
        <button
          onClick={handleTestCurrentPage}
          disabled={isSubmitting}
          className='w-full py-2.5 px-3 text-sm font-medium rounded-md bg-green-600 hover:bg-green-700 disabled:bg-green-400 text-white truncate'
        >
          {isSubmitting
            ? 'Submitting...'
            : `Test ${new URL(activeTabUrl).hostname}`}
        </button>
      )}

      {/* Stop button when scanning */}
      {isScanning && (
        <button
          onClick={handleStop}
          className='w-full py-2 px-3 text-sm font-medium rounded-md bg-red-600 hover:bg-red-700 text-white'
        >
          Stop Scan
        </button>
      )}

      {error && (
        <div className='p-2 rounded-md bg-red-50 text-red-700 text-xs'>
          {error}
        </div>
      )}

      {/* Phase Indicator */}
      {isScanning && (
        <div className='flex items-center gap-1 flex-wrap'>
          {phases.map((phase, i) => {
            const isActive = i === currentPhaseIndex;
            const isComplete = i < currentPhaseIndex;
            return (
              <div key={phase.key} className='flex items-center gap-1'>
                <div
                  className={`w-2 h-2 rounded-full ${
                    isComplete
                      ? 'bg-green-500'
                      : isActive
                        ? 'bg-blue-500 animate-pulse'
                        : 'bg-gray-300'
                  }`}
                />
                <span
                  className={`text-xs ${
                    isActive
                      ? 'text-blue-600 font-medium'
                      : isComplete
                        ? 'text-green-600'
                        : 'text-gray-400'
                  }`}
                >
                  {phase.label}
                </span>
                {i < phases.length - 1 && (
                  <div className='w-3 h-px bg-gray-300 mx-0.5' />
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Counters */}
      {(isScanning || progress.isComplete) && (
        <div className='grid grid-cols-4 gap-2'>
          {[
            {
              label: 'Pages',
              value: progress.pagesFound,
              color: 'text-blue-600',
            },
            {
              label: 'States',
              value: progress.pageStatesFound,
              color: 'text-purple-600',
            },
            {
              label: 'Actions',
              value: progress.actionsCompleted,
              color: 'text-green-600',
            },
            {
              label: 'Issues',
              value: progress.issuesFound,
              color: 'text-red-600',
            },
          ].map(c => (
            <div key={c.label} className='text-center'>
              <div className={`text-lg font-bold tabular-nums ${c.color}`}>
                {c.value}
              </div>
              <div className='text-[10px] text-gray-500'>{c.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Current Page */}
      {progress.currentPageUrl && (
        <div className='rounded-md border border-gray-200 overflow-hidden'>
          <div className='bg-gray-50 px-2 py-1 border-b border-gray-200 flex items-center justify-between'>
            <span className='text-[10px] font-medium text-gray-500'>
              Current Page
            </span>
            <span className='text-[10px] font-mono text-gray-400 truncate ml-2 max-w-[200px]'>
              {progress.currentPageUrl}
            </span>
          </div>
          {progress.latestScreenshotDataUrl && (
            <img
              src={progress.latestScreenshotDataUrl}
              alt='Current page'
              className='w-full h-auto'
            />
          )}
        </div>
      )}

      {/* Event Log */}
      {progress.events.length > 0 && (
        <div className='rounded-md border border-gray-200 overflow-hidden'>
          <div className='bg-gray-50 px-2 py-1 border-b border-gray-200'>
            <span className='text-[10px] font-medium text-gray-500'>
              Events ({progress.events.length})
            </span>
          </div>
          <div
            ref={eventLogRef}
            className='max-h-[200px] overflow-y-auto font-mono text-[10px]'
          >
            {progress.events.slice(-50).map((event, i) => (
              <div
                key={i}
                className='px-2 py-0.5 border-b border-gray-100 last:border-0'
              >
                <span className='text-gray-400'>
                  {new Date(event.timestamp).toLocaleTimeString()}
                </span>{' '}
                <span className='text-blue-600'>{event.type}</span>{' '}
                <span className='text-gray-600'>{event.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Complete */}
      {progress.isComplete && (
        <div className='p-2 rounded-md bg-green-50 text-green-700 text-xs font-medium'>
          Scan complete!
        </div>
      )}
    </div>
  );
}
