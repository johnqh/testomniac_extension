import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuthStatus } from '@sudobility/auth-components';
import { getFirebaseAuth } from '@sudobility/auth_lib';
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
} from 'firebase/auth';
import { LoginPage } from '@sudobility/building_blocks';
import { Combobox } from '@sudobility/components';
import { useAuthTokenSync } from './hooks/useAuthTokenSync';
import { chromeGoogleSignIn } from './auth/googleSignIn';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8027';

interface EntityOption {
  id: string;
  entitySlug: string;
  displayName: string;
}

interface ProductOption {
  id: number;
  title: string;
  entityId: string | null;
}

interface ScanProgress {
  phase: string;
  pagesFound: number;
  pageStatesFound: number;
  testRunsCompleted: number;
  findingsFound: number;
  currentPageUrl: string | null;
  latestScreenshotDataUrl: string | null;
  isComplete: boolean;
  events: Array<{ type: string; message: string; timestamp: number }>;
}

const initialProgress: ScanProgress = {
  phase: 'idle',
  pagesFound: 0,
  pageStatesFound: 0,
  testRunsCompleted: 0,
  findingsFound: 0,
  currentPageUrl: null,
  latestScreenshotDataUrl: null,
  isComplete: false,
  events: [],
};

type ResultTab = 'overview' | 'pages' | 'issues' | 'actions' | 'events';

export function SidePanel() {
  const { user, isAuthenticated, loading, signOut } = useAuthStatus();
  const token = useAuthTokenSync();
  const [activeTabUrl, setActiveTabUrl] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [progress, setProgress] = useState<ScanProgress>(initialProgress);
  const eventLogRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [resultTab, setResultTab] = useState<ResultTab>('overview');

  // Entity & product selection
  const [entities, setEntities] = useState<EntityOption[]>([]);
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [selectedProductId, setSelectedProductId] = useState<string>('');
  const [loadingEntities, setLoadingEntities] = useState(false);
  const [loadingProducts, setLoadingProducts] = useState(false);

  // Fetch entities when authenticated
  useEffect(() => {
    if (!isAuthenticated || !token) return;
    setLoadingEntities(true);
    fetch(`${API_URL}/api/v1/entities`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(data => {
        if (data.success && Array.isArray(data.data)) {
          setEntities(data.data);
          if (data.data.length > 0 && !selectedEntityId) {
            setSelectedEntityId(data.data[0].id);
          }
        }
      })
      .catch(() => {})
      .finally(() => setLoadingEntities(false));
  }, [isAuthenticated, token]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch products when entity is selected
  useEffect(() => {
    if (!selectedEntityId || !token) {
      setProducts([]);
      return;
    }
    const entity = entities.find(e => e.id === selectedEntityId);
    if (!entity) return;
    setLoadingProducts(true);
    fetch(`${API_URL}/api/v1/entities/${entity.entitySlug}/products`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(data => {
        if (data.success && Array.isArray(data.data)) {
          setProducts(data.data);
          // Auto-select "Create Product" if no existing products
          if (data.data.length === 0) {
            setSelectedProductId('__create__');
          } else {
            setSelectedProductId('');
          }
        }
      })
      .catch(() => {})
      .finally(() => setLoadingProducts(false));
  }, [selectedEntityId, token, entities]);

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

  // Submit: create/select product → create/reuse runner → create scan → start
  const handleTestCurrentPage = useCallback(async () => {
    console.log('[SidePanel] handleTestCurrentPage called', {
      activeTabUrl,
      hasToken: !!token,
      selectedEntityId,
      selectedProductId,
      userId: user?.uid,
    });
    if (!activeTabUrl || !token || !selectedEntityId) {
      console.log('[SidePanel] Aborting: missing required fields', {
        activeTabUrl: !!activeTabUrl,
        token: !!token,
        selectedEntityId: !!selectedEntityId,
      });
      return;
    }
    setError(null);
    setIsSubmitting(true);

    try {
      // Force-refresh the Firebase token before API calls to avoid stale tokens
      const auth = (await import('firebase/auth')).getAuth();
      const freshToken = auth.currentUser
        ? await auth.currentUser.getIdToken(true)
        : token;
      console.log('[SidePanel] Token refreshed before API calls');

      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${freshToken}`,
      };

      let productId: number;

      if (selectedProductId === '__create__') {
        const [activeTab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        const title = activeTab?.title || new URL(activeTabUrl).hostname;
        console.log('[SidePanel] Creating new product:', {
          entityId: selectedEntityId,
          title,
        });
        const createRes = await fetch(`${API_URL}/api/v1/products`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            entityId: selectedEntityId,
            title,
          }),
        });
        const createData = await createRes.json();
        console.log('[SidePanel] Create product response:', createData);
        if (!createData.success || !createData.data?.id) {
          const err =
            createData.error ||
            createData.data?.message ||
            'Failed to create product';
          console.error('[SidePanel] Product creation failed:', err);
          setError(err);
          return;
        }
        productId = createData.data.id;
        console.log('[SidePanel] Product created, id:', productId);
        setProducts(prev => [...prev, createData.data]);
        setSelectedProductId(String(productId));
      } else {
        productId = Number(selectedProductId);
        console.log('[SidePanel] Using existing product:', productId);
      }

      // Create or reuse runner under the product
      console.log('[SidePanel] Creating runner under product', productId);
      const runnerRes = await fetch(
        `${API_URL}/api/v1/products/${productId}/runners`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            productId,
            title: new URL(activeTabUrl).hostname,
            type: 'extension',
          }),
        }
      );
      const runnerData = await runnerRes.json();
      console.log('[SidePanel] Create runner response:', runnerData);
      if (!runnerData.success || !runnerData.data?.id) {
        const err = runnerData.error || 'Failed to create runner';
        console.error('[SidePanel] Runner creation failed:', err);
        setError(err);
        return;
      }
      const runnerId = runnerData.data.id;
      console.log('[SidePanel] Runner created, id:', runnerId);

      // Create scan
      console.log('[SidePanel] Creating scan for URL:', activeTabUrl);
      const scanRes = await fetch(`${API_URL}/api/v1/scan`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          url: activeTabUrl,
          createdByUserId: user?.uid,
          ownedByUserId: user?.uid,
        }),
      });
      const scanData = await scanRes.json();
      console.log('[SidePanel] Create scan response:', scanData);
      if (scanData.success && scanData.data?.testRunId) {
        console.log(
          '[SidePanel] Scan created, testRunId:',
          scanData.data.testRunId,
          'runnerId:',
          runnerId
        );
        setProgress({
          ...initialProgress,
          phase: 'scanning',
          currentPageUrl: activeTabUrl,
        });
        setIsScanning(true);
        chrome.runtime.sendMessage({
          type: 'START_SCAN',
          url: activeTabUrl,
          runId: scanData.data.testRunId,
          runnerId,
        });
        setError(null);
      } else {
        const err =
          scanData.data?.message || scanData.error || 'Failed to submit scan';
        console.error('[SidePanel] Scan creation failed:', err, scanData);
        setError(err);
      }
    } catch (err) {
      console.error('[SidePanel] handleTestCurrentPage error:', err);
      setError('Failed to connect to API');
    } finally {
      setIsSubmitting(false);
    }
  }, [activeTabUrl, token, selectedEntityId, selectedProductId, user?.uid]);

  // Auto-scroll event log
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
    { key: 'scanning', label: 'Scanning' },
    { key: 'decomposing', label: 'Analyzing' },
    { key: 'testing', label: 'Testing' },
    { key: 'completed', label: 'Complete' },
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
        className='!min-h-0 !pt-4 !pb-4 !px-3'
        onEmailSignIn={async (email, password) => {
          await signInWithEmailAndPassword(auth, email, password);
        }}
        onEmailSignUp={async (email, password) => {
          await createUserWithEmailAndPassword(auth, email, password);
        }}
        onGoogleSignIn={async () => {
          await chromeGoogleSignIn(auth);
        }}
        onSuccess={() => {}}
      />
    );
  }

  // Build combobox options
  const entityOptions = entities.map(e => ({
    value: e.id,
    label: e.displayName || e.entitySlug,
  }));

  const productOptions = [
    ...products.map(p => ({ value: String(p.id), label: p.title })),
    { value: '__create__', label: '+ Create Product' },
  ];

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
          {!isScanning && (
            <button
              onClick={() => signOut()}
              className='text-xs text-red-500 hover:text-red-700 font-medium'
            >
              Log out
            </button>
          )}
        </div>
      </div>

      {/* Workspace & Product selectors */}
      {!isScanning && (
        <div className='space-y-2'>
          <div>
            <label className='block text-[11px] font-medium text-gray-500 mb-0.5'>
              Workspace
            </label>
            <Combobox
              options={entityOptions}
              value={selectedEntityId || ''}
              onChange={value => {
                setSelectedEntityId(value);
                setSelectedProductId('');
              }}
              placeholder={loadingEntities ? 'Loading...' : 'Select workspace'}
              disabled={loadingEntities}
              emptyMessage='No workspaces found'
              className='w-full'
            />
          </div>

          <div>
            <label className='block text-[11px] font-medium text-gray-500 mb-0.5'>
              Product
            </label>
            <Combobox
              options={productOptions}
              value={selectedProductId}
              onChange={value => setSelectedProductId(value)}
              placeholder={loadingProducts ? 'Loading...' : 'Select product...'}
              disabled={loadingProducts}
              emptyMessage='No products — select "Create Product"'
              className='w-full'
            />
          </div>
        </div>
      )}

      {/* Test Current Page Button */}
      {activeTabUrl && !isScanning && (
        <button
          onClick={handleTestCurrentPage}
          disabled={isSubmitting || !selectedProductId || !selectedEntityId}
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
        <div className='grid grid-cols-4 gap-1'>
          {(
            [
              {
                key: 'pages',
                label: 'Pages',
                value: progress.pagesFound,
                color: 'text-blue-600',
                ring: 'ring-blue-300',
              },
              {
                key: 'overview',
                label: 'States',
                value: progress.pageStatesFound,
                color: 'text-purple-600',
                ring: 'ring-purple-300',
              },
              {
                key: 'actions',
                label: 'Tests',
                value: progress.testRunsCompleted,
                color: 'text-green-600',
                ring: 'ring-green-300',
              },
              {
                key: 'issues',
                label: 'Findings',
                value: progress.findingsFound,
                color: 'text-red-600',
                ring: 'ring-red-300',
              },
            ] as const
          ).map(c => (
            <button
              key={c.key}
              onClick={() => setResultTab(c.key)}
              className={`text-center py-1.5 rounded-md transition-colors ${
                resultTab === c.key
                  ? `bg-white ring-2 ${c.ring} shadow-sm`
                  : 'hover:bg-gray-50'
              }`}
            >
              <div className={`text-lg font-bold tabular-nums ${c.color}`}>
                {c.value}
              </div>
              <div className='text-[10px] text-gray-500'>{c.label}</div>
            </button>
          ))}
        </div>
      )}

      {/* Tab bar */}
      {(isScanning || progress.isComplete) && progress.events.length > 0 && (
        <div className='flex border-b border-gray-200'>
          {(
            [
              { key: 'overview', label: 'Overview' },
              { key: 'pages', label: 'Pages' },
              { key: 'issues', label: 'Findings' },
              { key: 'actions', label: 'Tests' },
              { key: 'events', label: 'All Events' },
            ] as const
          ).map(tab => (
            <button
              key={tab.key}
              onClick={() => setResultTab(tab.key)}
              className={`px-2 py-1.5 text-[11px] font-medium border-b-2 transition-colors ${
                resultTab === tab.key
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {/* Tab content */}
      {(isScanning || progress.isComplete) && (
        <div className='rounded-md border border-gray-200 overflow-hidden'>
          {resultTab === 'overview' && (
            <>
              {progress.currentPageUrl && (
                <div className='bg-gray-50 px-2 py-1 border-b border-gray-200 flex items-center justify-between'>
                  <span className='text-[10px] font-medium text-gray-500'>
                    Current Page
                  </span>
                  <span className='text-[10px] font-mono text-gray-400 truncate ml-2 max-w-[200px]'>
                    {progress.currentPageUrl}
                  </span>
                </div>
              )}
              {progress.latestScreenshotDataUrl && (
                <img
                  src={progress.latestScreenshotDataUrl}
                  alt='Current page'
                  className='w-full h-auto'
                />
              )}
              {!progress.latestScreenshotDataUrl && (
                <div className='p-4 text-center text-xs text-gray-400'>
                  Waiting for screenshot...
                </div>
              )}
            </>
          )}

          {resultTab === 'pages' && (
            <div
              ref={eventLogRef}
              className='max-h-[300px] overflow-y-auto font-mono text-[10px]'
            >
              {progress.events
                .filter(
                  e => e.type === 'page_discovered' || e.type === 'navigate'
                )
                .map((event, i) => (
                  <div
                    key={i}
                    className='px-2 py-1 border-b border-gray-100 last:border-0'
                  >
                    <span className='text-gray-400'>
                      {new Date(event.timestamp).toLocaleTimeString()}
                    </span>{' '}
                    <span
                      className={
                        event.type === 'page_discovered'
                          ? 'text-blue-600'
                          : 'text-gray-500'
                      }
                    >
                      {event.type === 'page_discovered'
                        ? 'discovered'
                        : 'navigated'}
                    </span>{' '}
                    <span className='text-gray-700'>{event.message}</span>
                  </div>
                ))}
              {progress.events.filter(
                e => e.type === 'page_discovered' || e.type === 'navigate'
              ).length === 0 && (
                <div className='p-3 text-center text-gray-400'>
                  No pages yet
                </div>
              )}
            </div>
          )}

          {resultTab === 'issues' && (
            <div
              ref={eventLogRef}
              className='max-h-[300px] overflow-y-auto font-mono text-[10px]'
            >
              {progress.events
                .filter(e => e.type === 'finding')
                .map((event, i) => (
                  <div
                    key={i}
                    className='px-2 py-1 border-b border-gray-100 last:border-0'
                  >
                    <span className='text-gray-400'>
                      {new Date(event.timestamp).toLocaleTimeString()}
                    </span>{' '}
                    <span className='text-red-600'>finding</span>{' '}
                    <span className='text-gray-700'>{event.message}</span>
                  </div>
                ))}
              {progress.events.filter(e => e.type === 'finding').length ===
                0 && (
                <div className='p-3 text-center text-gray-400'>
                  No findings yet
                </div>
              )}
            </div>
          )}

          {resultTab === 'actions' && (
            <div
              ref={eventLogRef}
              className='max-h-[300px] overflow-y-auto font-mono text-[10px]'
            >
              {progress.events
                .filter(e =>
                  [
                    'test_passed',
                    'test_failed',
                    'test_suite_created',
                    'decomposition_started',
                    'decomposition_completed',
                  ].includes(e.type)
                )
                .map((event, i) => (
                  <div
                    key={i}
                    className='px-2 py-1 border-b border-gray-100 last:border-0'
                  >
                    <span className='text-gray-400'>
                      {new Date(event.timestamp).toLocaleTimeString()}
                    </span>{' '}
                    <span
                      className={
                        event.type === 'test_failed'
                          ? 'text-red-600'
                          : 'text-green-600'
                      }
                    >
                      {event.type}
                    </span>{' '}
                    <span className='text-gray-600'>{event.message}</span>
                  </div>
                ))}
              {progress.events.filter(e =>
                ['test_passed', 'test_failed', 'test_suite_created'].includes(
                  e.type
                )
              ).length === 0 && (
                <div className='p-3 text-center text-gray-400'>
                  No test runs yet
                </div>
              )}
            </div>
          )}

          {resultTab === 'events' && (
            <div
              ref={eventLogRef}
              className='max-h-[300px] overflow-y-auto font-mono text-[10px]'
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
          )}
        </div>
      )}

      {progress.isComplete && (
        <div className='p-2 rounded-md bg-green-50 text-green-700 text-xs font-medium'>
          Scan complete!
        </div>
      )}
    </div>
  );
}
