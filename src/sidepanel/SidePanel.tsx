import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useAuthStatus } from '@sudobility/auth-components';
import { getFirebaseAuth } from '@sudobility/auth_lib';
import type { NetworkClient } from '@sudobility/types';
import {
  useEntityManager,
  usePersistedState,
} from '@sudobility/testomniac_lib';
import { chromeStorageAdapter } from '../storage/chromeStorageAdapter';
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
} from 'firebase/auth';
import FlipNumbers from 'react-flip-numbers';
import { LoginPage } from '@sudobility/building_blocks';
import { Combobox, Input } from '@sudobility/components';
import { useAuthTokenSync } from './hooks/useAuthTokenSync';
import { chromeGoogleSignIn } from './auth/googleSignIn';
import {
  environmentOptions,
  resolveEnvironmentContext,
  type EnvironmentChoice,
} from '../shared/environment';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8027';

function logPanel(step: string, details?: Record<string, unknown>): void {
  console.log('[SidePanel]', step, details ?? {});
}

function normalizeApiError(
  error: unknown,
  fallback: string = 'Request failed'
): string {
  if (typeof error === 'string' && error.trim().length > 0) {
    return error;
  }

  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;

    if (
      typeof record.message === 'string' &&
      record.message.trim().length > 0
    ) {
      return record.message;
    }

    if (typeof record.error === 'string' && record.error.trim().length > 0) {
      return record.error;
    }

    if (record.data && typeof record.data === 'object') {
      const data = record.data as Record<string, unknown>;
      if (typeof data.message === 'string' && data.message.trim().length > 0) {
        return data.message;
      }
      if (typeof data.error === 'string' && data.error.trim().length > 0) {
        return data.error;
      }
    }
  }

  return fallback;
}

interface ProductOption {
  id: number;
  title: string;
  entityId: string | null;
}

interface ExpertiseOption {
  slug: string;
  label: string;
  required?: boolean;
}

interface ResolveEnvironmentApiResponse {
  testEnvironmentId: number;
  kind: 'local' | 'shared';
  label: string;
  ownerUserId: string | null;
  resolutionMode: 'local_user_owned' | 'shared_labeled';
}

interface ScanProgress {
  isRunning?: boolean;
  isPaused?: boolean;
  scanId?: number | null;
  phase: string;
  pagesFound: number;
  pageStatesFound: number;
  testRunsCompleted: number;
  findingsFound: number;
  aiSummary?: string | null;
  expertiseSummary?: Record<
    string,
    {
      warnings: number;
      errors: number;
    }
  > | null;
  environmentKind?: 'local' | 'shared';
  environmentLabel?: string | null;
  environmentHostname?: string | null;
  elapsedMs?: number;
  currentPageUrl: string | null;
  status_update?: string | null;
  latestScreenshotDataUrl: string | null;
  isComplete: boolean;
  events: Array<{
    type: string;
    message: string;
    timestamp: number;
    findingTitle?: string;
  }>;
}

interface RunSummary {
  runId: number;
  rootRunId: number;
  runnerId: number;
  testEnvironmentId: number | null;
  status: string;
  status_update?: string | null;
  aiSummary: string | null;
  pagesFound: number | null;
  pageStatesFound: number | null;
  testRunsCompleted: number | null;
  totalFindings: number;
  expertiseSummary: Record<
    string,
    {
      warnings: number;
      errors: number;
      findings: number;
    }
  >;
  recentFindings: Array<{
    id: number;
    type: string;
    title: string;
    description: string;
    expertise: string | null;
    createdAt: string | null;
  }>;
  completedAt: string | null;
  createdAt: string | null;
}

interface NavigationMapData {
  runId: number;
  rootRunId: number;
  testEnvironmentId: number | null;
  discoveredPages: Array<{
    id: number;
    testEnvironmentId: number;
    relativePath: string;
    sourcePagePath: string | null;
    sourceLabel: string | null;
    isPublic: boolean;
    createdAt: string | null;
    updatedAt: string | null;
  }>;
  pageVisits: Array<{
    id: number;
    testRunId: number;
    testEnvironmentId: number;
    relativePath: string;
    status: string;
    redirectPath: string | null;
    requiresLogin: boolean | null;
    errorMessage: string | null;
    createdAt: string | null;
  }>;
}

interface RunStructureData {
  runId: number;
  rootRunId: number;
  bundle: {
    id: number;
    runnerId: number;
    title: string;
    uid: string | null;
    createdAt: string | null;
  };
  bundleRun: {
    id: number;
    testSurfaceBundleId: number;
    status: string;
    startedAt: string | null;
    completedAt: string | null;
    createdAt: string | null;
  };
  surfaces: Array<{
    id: number;
    title: string;
    priority: number;
    surfaceTags: string[];
    surfaceRuns: Array<{
      id: number;
      status: string;
      startedAt: string | null;
      completedAt: string | null;
    }>;
    testInteractions: Array<{
      id: number;
      title: string;
      testType: string;
      priority: number;
      dependencyTestInteractionId: number | null;
      startingPath: string | null;
      startingPageStateId: number | null;
      interactionRuns: Array<{
        id: number;
        status: string;
        durationMs: number | null;
        findings: Array<{
          id: number;
          type: string;
          title: string;
        }>;
      }>;
    }>;
  }>;
}

interface RunPageSummary {
  pageId: number;
  relativePath: string;
  latestScreenshotPath: string | null;
  pageStatesCount: number;
  testInteractionRunsCount: number;
  errors: number;
}

interface ProductEnvironmentOption {
  id: number;
  productId: number;
  title: string;
  baseUrl: string;
  kind: 'local' | 'shared';
  label: string;
  ownerUserId: string | null;
  githubBranch: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

interface EntityCredentialOption {
  id: number;
  entityId: string;
  label: string;
  authProvider: string;
  loginUrl: string | null;
  email: string | null;
  username: string | null;
  hasPassword: boolean;
  hasTwoFactorCode: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

const AUTH_PROVIDER_OPTIONS = [
  { value: 'email_password', label: 'Email / Password' },
  { value: 'google', label: 'Google' },
  { value: 'apple', label: 'Apple' },
  { value: 'microsoft', label: 'Microsoft' },
  { value: 'github', label: 'GitHub' },
  { value: 'okta', label: 'Okta' },
  { value: 'saml', label: 'SAML' },
];

const initialProgress: ScanProgress = {
  scanId: null,
  phase: 'idle',
  pagesFound: 0,
  pageStatesFound: 0,
  testRunsCompleted: 0,
  findingsFound: 0,
  aiSummary: null,
  expertiseSummary: null,
  currentPageUrl: null,
  status_update: null,
  latestScreenshotDataUrl: null,
  isComplete: false,
  events: [],
};

type ResultTab = 'overview' | 'map' | 'coverage' | 'issues' | 'events';
type AppView = 'home' | 'scenarios';

const EXPERTISE_OPTIONS: ExpertiseOption[] = [
  { slug: 'tester', label: 'Tester', required: true },
  { slug: 'seo', label: 'SEO' },
  { slug: 'security', label: 'Security' },
  { slug: 'performance', label: 'Performance' },
  { slug: 'content', label: 'Content' },
  { slug: 'ui', label: 'UI' },
  { slug: 'accessibility', label: 'Accessibility' },
];

const PHASE_ORDER: Record<string, number> = {
  idle: 0,
  scanning: 1,
  paused: 2,
  testing: 3,
  completed: 4,
  failed: 4,
  stopped: 4,
};

function normalizeHostname(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^www\./, '');
}

function getEnvironmentMatchScore(
  activeUrl: URL,
  environmentBaseUrl: string
): number {
  try {
    const environmentUrl = new URL(environmentBaseUrl);
    const activeOrigin = activeUrl.origin.toLowerCase();
    const environmentOrigin = environmentUrl.origin.toLowerCase();
    const activeHostname = normalizeHostname(activeUrl.hostname);
    const environmentHostname = normalizeHostname(environmentUrl.hostname);

    if (activeOrigin === environmentOrigin) {
      return 3;
    }

    if (activeHostname === environmentHostname) {
      return 2;
    }

    return 0;
  } catch {
    return 0;
  }
}

function formatElapsedTime(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Self-contained timer display that locally interpolates between runner stats
 * updates. Only this component re-renders on tick — the parent SidePanel does not.
 */
function ElapsedTimer({
  baseElapsedMs,
  isActive,
  className,
}: {
  baseElapsedMs: number;
  isActive: boolean;
  className?: string;
}) {
  const [displaySeconds, setDisplaySeconds] = useState(
    Math.floor(baseElapsedMs / 1000)
  );
  const baseRef = useRef({ ms: baseElapsedMs, receivedAt: Date.now() });

  // Sync when runner reports a new elapsed value
  useEffect(() => {
    baseRef.current = { ms: baseElapsedMs, receivedAt: Date.now() };
    setDisplaySeconds(Math.floor(baseElapsedMs / 1000));
  }, [baseElapsedMs]);

  // Tick locally between runner updates
  useEffect(() => {
    if (!isActive) return;
    baseRef.current = { ...baseRef.current, receivedAt: Date.now() };

    const interval = setInterval(() => {
      const localElapsed = Date.now() - baseRef.current.receivedAt;
      setDisplaySeconds(Math.floor((baseRef.current.ms + localElapsed) / 1000));
    }, 1000);

    return () => clearInterval(interval);
  }, [isActive]);

  return (
    <span className={className ?? 'text-xs font-mono text-gray-500'}>
      {formatElapsedTime(displaySeconds)}
    </span>
  );
}

export function SidePanel() {
  const { user, isAuthenticated, loading, signOut } = useAuthStatus();
  const token = useAuthTokenSync();

  // NetworkClient for shared hooks (wraps fetch with the existing token)
  const networkClient = useMemo<NetworkClient>(
    () => ({
      async request(url, options) {
        const res = await fetch(url, {
          method: options?.method ?? 'GET',
          headers: options?.headers ?? undefined,
          body: options?.body as string | undefined,
          signal: options?.signal ?? undefined,
        });
        const data = await res.json();
        return {
          success: data.success ?? res.ok,
          data,
          ok: res.ok,
          status: res.status,
          statusText: res.statusText,
          headers: {},
          timestamp: new Date().toISOString(),
        };
      },
      async get(url, options) {
        return this.request(url, { ...options, method: 'GET' });
      },
      async post(url, body, options) {
        return this.request(url, {
          ...options,
          method: 'POST',
          body: body != null ? JSON.stringify(body) : undefined,
          headers: { 'Content-Type': 'application/json', ...options?.headers },
        });
      },
      async put(url, body, options) {
        return this.request(url, {
          ...options,
          method: 'PUT',
          body: body != null ? JSON.stringify(body) : undefined,
          headers: { 'Content-Type': 'application/json', ...options?.headers },
        });
      },
      async delete(url, options) {
        return this.request(url, { ...options, method: 'DELETE' });
      },
    }),
    []
  );
  const [activeTabUrl, setActiveTabUrl] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [progress, setProgress] = useState<ScanProgress>(initialProgress);
  const [runSummary, setRunSummary] = useState<RunSummary | null>(null);
  const [navigationMap, setNavigationMap] = useState<NavigationMapData | null>(
    null
  );
  const [runStructure, setRunStructure] = useState<RunStructureData | null>(
    null
  );
  const [runPageSummaries, setRunPageSummaries] = useState<RunPageSummary[]>(
    []
  );
  const [liveScreenshotDataUrl, setLiveScreenshotDataUrl] = useState<
    string | null
  >(null);
  const eventLogRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [resultTab, setResultTab] = useState<ResultTab>('overview');
  const [appView, setAppView] = useState<AppView>('home');
  const [showSettings, setShowSettings] = useState(false);
  const [settingsApiUrl, setSettingsApiUrl] = useState('');
  const [settingsApiKey, setSettingsApiKey] = useState('');
  const [settingsClickWaitMs, setSettingsClickWaitMs] = useState('500');

  // Scenario state
  interface ScenarioItem {
    id: number;
    title: string;
    startingPath: string;
    prompt: string;
    sizeClass: string;
  }
  const [scenarios, setScenarios] = useState<ScenarioItem[]>([]);
  const [loadingScenarios, setLoadingScenarios] = useState(false);
  const [showNewScenarioForm, setShowNewScenarioForm] = useState(false);
  const [newScenarioTitle, setNewScenarioTitle] = useState('');
  const [newScenarioPath, setNewScenarioPath] = useState('');
  const [newScenarioPrompt, setNewScenarioPrompt] = useState('');
  const [creatingScenario, setCreatingScenario] = useState(false);
  const [runningScenarioId, setRunningScenarioId] = useState<number | null>(
    null
  );

  // Load settings from storage when settings panel opens
  useEffect(() => {
    if (!showSettings) return;
    chrome.storage.local
      .get(['apiUrl', 'apiKey', 'clickWaitMs'])
      .then(stored => {
        if (stored.apiUrl) setSettingsApiUrl(stored.apiUrl as string);
        if (stored.apiKey) setSettingsApiKey(stored.apiKey as string);
        if (stored.clickWaitMs != null)
          setSettingsClickWaitMs(String(stored.clickWaitMs));
      });
  }, [showSettings]);

  // Entity & product selection
  const { entities, isLoading: loadingEntities } = useEntityManager({
    networkClient,
    baseUrl: API_URL,
    token: token ?? '',
    enabled: isAuthenticated && !!token,
  });
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [selectedProductId, setSelectedProductId] = useState<string>('');
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [selectedEnvironment, setSelectedEnvironment] =
    useState<EnvironmentChoice>('production');
  const [customEnvironmentLabel, setCustomEnvironmentLabel] = useState('');
  const [selectedExpertiseSlugs, setSelectedExpertiseSlugs] = useState<
    string[]
  >(['tester']);

  // Login credential state
  const [continueWithLogin, setContinueWithLogin] = useState(false);
  type ScanMode = 'full' | 'partial' | 'minimum';
  const isScanMode = useCallback(
    (v: unknown): v is ScanMode =>
      typeof v === 'string' && ['full', 'partial', 'minimum'].includes(v),
    []
  );
  const [scanMode, setScanMode] = usePersistedState<ScanMode>(
    'scanMode',
    'full',
    chromeStorageAdapter,
    isScanMode
  );
  const [credentials, setCredentials] = useState<EntityCredentialOption[]>([]);
  const [loadingCredentials, setLoadingCredentials] = useState(false);
  const [selectedCredentialId, setSelectedCredentialId] = useState<string>('');
  const [loginUrl, setLoginUrl] = useState('');
  const [showNewCredentialForm, setShowNewCredentialForm] = useState(false);
  const [newCredLabel, setNewCredLabel] = useState('');
  const [newCredEmail, setNewCredEmail] = useState('');
  const [newCredPassword, setNewCredPassword] = useState('');
  const [newCredAuthProvider, setNewCredAuthProvider] =
    useState('email_password');
  const [savingCredential, setSavingCredential] = useState(false);

  const mergeProgress = useCallback(
    (prev: ScanProgress, next: ScanProgress): ScanProgress => {
      const isFreshRun =
        prev.scanId == null ||
        next.scanId == null ||
        prev.scanId !== next.scanId ||
        prev.phase === 'idle' ||
        next.phase === 'idle';

      if (isFreshRun || next.isComplete) {
        return next;
      }

      const prevPhaseRank = PHASE_ORDER[prev.phase] ?? 0;
      const nextPhaseRank = PHASE_ORDER[next.phase] ?? 0;
      const mergedPhase =
        (prev.phase === 'paused' && next.phase === 'scanning') ||
        (prev.phase === 'scanning' && next.phase === 'paused')
          ? next.phase
          : nextPhaseRank >= prevPhaseRank
            ? next.phase
            : prev.phase;

      return {
        ...prev,
        ...next,
        phase: mergedPhase,
        pagesFound: Math.max(prev.pagesFound, next.pagesFound),
        pageStatesFound: Math.max(prev.pageStatesFound, next.pageStatesFound),
        testRunsCompleted: Math.max(
          prev.testRunsCompleted,
          next.testRunsCompleted
        ),
        findingsFound: Math.max(prev.findingsFound, next.findingsFound),
        elapsedMs: Math.max(prev.elapsedMs ?? 0, next.elapsedMs ?? 0),
        events:
          next.events.length >= prev.events.length ? next.events : prev.events,
      };
    },
    []
  );

  // Auto-select first entity when entities load
  useEffect(() => {
    if (entities.length > 0 && !selectedEntityId) {
      setSelectedEntityId(entities[0].id);
    }
  }, [entities, selectedEntityId]);

  // Fetch products when entity is selected
  useEffect(() => {
    if (!selectedEntityId || !token) {
      setProducts(prev => (prev.length === 0 ? prev : []));
      setSelectedProductId(prev => (prev === '' ? prev : ''));
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
      .catch(err =>
        logPanel('fetch-products:failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      )
      .finally(() => setLoadingProducts(false));
  }, [selectedEntityId, token, entities]);

  useEffect(() => {
    if (!token || !activeTabUrl || products.length === 0) {
      if (products.length === 0) {
        setSelectedProductId(prev =>
          prev === '__create__' ? prev : '__create__'
        );
      }
      return;
    }

    let cancelled = false;
    const currentTabUrl = activeTabUrl;

    async function autoSelectProductFromEnvironment() {
      let activeUrl: URL;
      try {
        activeUrl = new URL(currentTabUrl);
      } catch {
        setSelectedProductId('__create__');
        return;
      }

      const environmentResponses = await Promise.all(
        products.map(async product => {
          try {
            const response = await fetch(
              `${API_URL}/api/v1/products/${product.id}/environments`,
              {
                headers: { Authorization: `Bearer ${token}` },
              }
            );
            const data = await response.json();
            const environments =
              data.success && Array.isArray(data.data)
                ? (data.data as ProductEnvironmentOption[])
                : [];
            return { product, environments };
          } catch (err) {
            logPanel('fetch-environments:failed', {
              productId: product.id,
              error: err instanceof Error ? err.message : String(err),
            });
            return { product, environments: [] as ProductEnvironmentOption[] };
          }
        })
      );

      if (cancelled) {
        return;
      }

      let bestMatch: { productId: string; score: number } | null = null;

      for (const { product, environments } of environmentResponses) {
        for (const environment of environments) {
          const score = getEnvironmentMatchScore(
            activeUrl,
            environment.baseUrl
          );
          if (
            score > 0 &&
            (!bestMatch ||
              score > bestMatch.score ||
              (score === bestMatch.score &&
                Number(product.id) < Number(bestMatch.productId)))
          ) {
            bestMatch = {
              productId: String(product.id),
              score,
            };
          }
        }
      }

      setSelectedProductId(bestMatch?.productId ?? '__create__');
    }

    void autoSelectProductFromEnvironment();

    return () => {
      cancelled = true;
    };
  }, [activeTabUrl, products, token]);

  // Fetch entity credentials when "Continue with login" is enabled
  const selectedEntity = entities.find(e => e.id === selectedEntityId);
  const fetchCredentials = useCallback(async () => {
    if (!selectedEntity || !token) {
      setCredentials([]);
      return;
    }
    setLoadingCredentials(true);
    try {
      const res = await fetch(
        `${API_URL}/api/v1/entities/${selectedEntity.entitySlug}/credentials`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const data = await res.json();
      if (data.success && Array.isArray(data.data)) {
        setCredentials(data.data);
      }
    } catch (err) {
      logPanel('fetch-credentials:failed', {
        entitySlug: selectedEntity?.entitySlug,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoadingCredentials(false);
    }
  }, [selectedEntity, token]);

  useEffect(() => {
    if (!continueWithLogin) return;
    void fetchCredentials();
  }, [continueWithLogin, fetchCredentials]);

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

  const environmentContext = resolveEnvironmentContext(
    activeTabUrl,
    selectedEnvironment,
    customEnvironmentLabel
  );
  const {
    hostname: activeHostname,
    isLocalEnvironment,
    kind: environmentKind,
    label: resolvedEnvironmentLabel,
  } = environmentContext;

  useEffect(() => {
    if (isLocalEnvironment) {
      setSelectedEnvironment('production');
      setCustomEnvironmentLabel('');
    }
  }, [isLocalEnvironment, activeTabUrl]);

  const isEnvironmentSelectionValid = isLocalEnvironment
    ? true
    : resolvedEnvironmentLabel.length > 0;

  // Submit: create/select product → create/reuse runner → create scan → start
  const handleTestCurrentPage = useCallback(async () => {
    console.log('[SidePanel] handleTestCurrentPage called', {
      activeTabUrl,
      hasToken: !!token,
      selectedEntityId,
      selectedProductId,
      selectedEnvironment,
      resolvedEnvironmentLabel,
      userId: user?.uid,
      scanMode,
    });
    if (
      !activeTabUrl ||
      !token ||
      !selectedEntityId ||
      !isEnvironmentSelectionValid
    ) {
      console.log('[SidePanel] Aborting: missing required fields', {
        activeTabUrl: !!activeTabUrl,
        token: !!token,
        selectedEntityId: !!selectedEntityId,
        isEnvironmentSelectionValid,
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

      const baseUrl = new URL(activeTabUrl).origin;

      // Resolve environment before scan creation
      console.log('[SidePanel] Resolving environment for product', productId);
      const environmentRes = await fetch(
        `${API_URL}/api/v1/test-environments/resolve`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            productId,
            url: activeTabUrl,
            baseUrl,
            source: 'extension',
            environmentLabel: isLocalEnvironment
              ? undefined
              : resolvedEnvironmentLabel,
          }),
        }
      );
      const environmentData = await environmentRes.json();
      console.log('[SidePanel] Resolve environment response:', environmentData);
      if (
        !environmentData.success ||
        !environmentData.data?.testEnvironmentId
      ) {
        const err = normalizeApiError(
          environmentData,
          'Failed to resolve scan environment'
        );
        console.error('[SidePanel] Environment resolution failed:', err);
        setError(err);
        return;
      }
      const resolvedEnvironment =
        environmentData.data as ResolveEnvironmentApiResponse;
      console.log(
        '[SidePanel] Environment resolved:',
        resolvedEnvironment.testEnvironmentId,
        resolvedEnvironment.label
      );

      // Create scan
      console.log('[SidePanel] Creating scan for URL:', activeTabUrl);
      const scanBody: Record<string, unknown> = {
        url: activeTabUrl,
        productId,
        testEnvironmentId: resolvedEnvironment.testEnvironmentId,
        expertiseSlugs: selectedExpertiseSlugs,
        createdByUserId: user?.uid,
        ownedByUserId: user?.uid,
        environmentLabel: resolvedEnvironmentLabel,
        environmentKind,
        ...(scanMode !== 'full' ? { scanMode } : {}),
      };
      if (continueWithLogin) {
        scanBody.continueWithLogin = true;
        if (selectedCredentialId && selectedCredentialId !== '__new__') {
          scanBody.entityCredentialId = Number(selectedCredentialId);
        }
        if (loginUrl.trim()) {
          scanBody.loginUrl = loginUrl.trim();
        }
      }
      const scanRes = await fetch(`${API_URL}/api/v1/scan`, {
        method: 'POST',
        headers,
        body: JSON.stringify(scanBody),
      });
      const scanData = await scanRes.json();
      console.log('[SidePanel] Create scan response:', scanData);
      if (scanData.success && scanData.data?.testRunId) {
        console.log(
          '[SidePanel] Scan created, testRunId:',
          scanData.data.testRunId,
          'environment:',
          resolvedEnvironment.testEnvironmentId
        );
        setProgress({
          ...initialProgress,
          scanId: scanData.data.testRunId,
          phase: 'scanning',
          environmentKind: resolvedEnvironment.kind,
          environmentLabel: resolvedEnvironment.label,
          environmentHostname: activeHostname,
          currentPageUrl: activeTabUrl,
        });
        setRunSummary(null);
        setNavigationMap(null);
        setRunStructure(null);
        setRunPageSummaries([]);
        setLiveScreenshotDataUrl(null);
        setResultTab('overview');
        setIsScanning(true);
        chrome.runtime.sendMessage({
          type: 'START_SCAN',
          url: activeTabUrl,
          runId: scanData.data.testRunId,
          environmentLabel: resolvedEnvironment.label,
          environmentKind: resolvedEnvironment.kind,
          environmentHostname: activeHostname,
          scanMode: scanMode !== 'full' ? scanMode : undefined,
          continueWithLogin,
          entityCredentialId:
            continueWithLogin &&
            selectedCredentialId &&
            selectedCredentialId !== '__new__'
              ? Number(selectedCredentialId)
              : undefined,
          loginUrl:
            continueWithLogin && loginUrl.trim() ? loginUrl.trim() : undefined,
        });
        setError(null);
      } else {
        const err = normalizeApiError(scanData, 'Failed to submit scan');
        console.error('[SidePanel] Scan creation failed:', err, scanData);
        setError(err);
      }
    } catch (err) {
      console.error('[SidePanel] handleTestCurrentPage error:', err);
      setError('Failed to connect to API');
    } finally {
      setIsSubmitting(false);
    }
  }, [
    activeTabUrl,
    activeHostname,
    environmentKind,
    token,
    selectedEntityId,
    selectedProductId,
    selectedEnvironment,
    resolvedEnvironmentLabel,
    selectedExpertiseSlugs,
    isLocalEnvironment,
    isEnvironmentSelectionValid,
    user?.uid,
    continueWithLogin,
    selectedCredentialId,
    loginUrl,
    scanMode,
  ]);

  // Auto-scroll event log
  useEffect(() => {
    if (eventLogRef.current) {
      eventLogRef.current.scrollTop = eventLogRef.current.scrollHeight;
    }
  }, [progress.events.length]);

  // Listen for progress updates from background
  useEffect(() => {
    chrome.runtime
      .sendMessage({ type: 'GET_SCAN_STATE' })
      .then(response => {
        const data = response?.data as ScanProgress | undefined;
        if (!data) return;
        setProgress(prev => mergeProgress(prev, data));
        if (data.latestScreenshotDataUrl) {
          setLiveScreenshotDataUrl(data.latestScreenshotDataUrl);
        }
        if (data.isRunning || data.isPaused) {
          setIsScanning(true);
        } else if (data.isComplete) {
          setIsScanning(false);
        }
      })
      .catch(err =>
        logPanel('fetch-scan-state:failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      );

    const listener = (message: { type: string; data?: ScanProgress }) => {
      if (message.type === 'SCAN_PROGRESS' && message.data) {
        setProgress(prev => mergeProgress(prev, message.data as ScanProgress));
        if (message.data.latestScreenshotDataUrl) {
          setLiveScreenshotDataUrl(message.data.latestScreenshotDataUrl);
        }
        if (message.data.isComplete) {
          setIsScanning(false);
        } else if (message.data.isRunning || message.data.isPaused) {
          setIsScanning(true);
        }
      }
      if (
        message.type === 'SCREENSHOT_CAPTURED' &&
        message.data &&
        typeof message.data === 'object'
      ) {
        const payload = message.data as {
          dataUrl?: string;
          pageUrl?: string;
        };
        const dataUrl = payload.dataUrl;
        if (dataUrl) {
          setLiveScreenshotDataUrl(dataUrl);
          setProgress(prev => ({
            ...prev,
            latestScreenshotDataUrl: dataUrl,
            currentPageUrl: payload.pageUrl ?? prev.currentPageUrl ?? null,
          }));
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
  }, [mergeProgress]);

  useEffect(() => {
    if (!token || !progress.scanId) return;
    let cancelled = false;

    const fetchLiveData = () =>
      fetch(`${API_URL}/api/v1/runs/${progress.scanId}/live-dashboard`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(response => response.json())
        .then(
          (dashboardData: {
            success: boolean;
            data: {
              summary: RunSummary;
              pagesSummary: RunPageSummary[];
              navigationMap: NavigationMapData;
              structure: RunStructureData | null;
            };
          }) => {
            if (cancelled || !dashboardData?.success) return;
            const {
              summary,
              pagesSummary: pages,
              navigationMap,
              structure,
            } = dashboardData.data;

            if (summary) {
              setRunSummary(summary);
              setProgress(prev => ({
                ...prev,
                pagesFound: Math.max(
                  prev.pagesFound,
                  summary.pagesFound ?? initialProgress.pagesFound
                ),
                pageStatesFound: Math.max(
                  prev.pageStatesFound,
                  summary.pageStatesFound ?? initialProgress.pageStatesFound
                ),
                testRunsCompleted: Math.max(
                  prev.testRunsCompleted,
                  summary.testRunsCompleted ?? initialProgress.testRunsCompleted
                ),
                aiSummary: summary.aiSummary ?? prev.aiSummary ?? null,
                status_update:
                  summary.status_update ?? prev.status_update ?? null,
                expertiseSummary:
                  Object.keys(summary.expertiseSummary ?? {}).length > 0
                    ? Object.fromEntries(
                        Object.entries(summary.expertiseSummary).map(
                          ([name, counts]) => [
                            name,
                            {
                              warnings: counts.warnings,
                              errors: counts.errors,
                            },
                          ]
                        )
                      )
                    : (prev.expertiseSummary ?? null),
              }));
            }

            if (Array.isArray(pages)) {
              setRunPageSummaries(pages);
              setProgress(prev => ({
                ...prev,
                pagesFound: Math.max(prev.pagesFound, pages.length),
                pageStatesFound: Math.max(
                  prev.pageStatesFound,
                  pages.reduce(
                    (total, page) => total + (page.pageStatesCount ?? 0),
                    0
                  )
                ),
                testRunsCompleted: Math.max(
                  prev.testRunsCompleted,
                  pages.reduce(
                    (total, page) =>
                      total + (page.testInteractionRunsCount ?? 0),
                    0
                  )
                ),
                findingsFound: Math.max(
                  prev.findingsFound,
                  pages.reduce((total, page) => total + (page.errors ?? 0), 0)
                ),
              }));
            }

            if (navigationMap) {
              setNavigationMap(navigationMap);
            }

            if (structure) {
              setRunStructure(structure);
            }
          }
        )
        .catch(err =>
          logPanel('fetch-live-data:failed', {
            error: err instanceof Error ? err.message : String(err),
          })
        );

    void fetchLiveData();

    if (progress.isComplete || progress.phase === 'completed') {
      return () => {
        cancelled = true;
      };
    }

    // Use sequential polling: wait for previous request to complete
    // before starting the next one, preventing request pile-up when
    // the dashboard response is slow
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const pollAfterDelay = () => {
      timeoutId = setTimeout(async () => {
        if (cancelled) return;
        await fetchLiveData();
        if (!cancelled) pollAfterDelay();
      }, 3000);
    };
    pollAfterDelay();

    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [token, progress.scanId, progress.isComplete, progress.phase]);

  // Load scenarios when switching to scenarios tab
  const fetchScenarios = useCallback(async () => {
    const runnerId = runSummary?.runnerId;
    if (!token || !runnerId) return;
    setLoadingScenarios(true);
    try {
      const res = await fetch(
        `${API_URL}/api/v1/runners/${runnerId}/test-scenarios`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const json = await res.json();
      if (json.success) setScenarios(json.data ?? []);
    } catch {
      // ignore
    } finally {
      setLoadingScenarios(false);
    }
  }, [token, runSummary?.runnerId]);

  useEffect(() => {
    if (appView === 'scenarios') void fetchScenarios();
  }, [appView, fetchScenarios]);

  const handleCreateScenario = useCallback(async () => {
    const runnerId = runSummary?.runnerId;
    if (!token || !runnerId || !newScenarioTitle.trim()) return;
    setCreatingScenario(true);
    try {
      // Create scenario
      const createRes = await fetch(
        `${API_URL}/api/v1/runners/${runnerId}/test-scenarios`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            runnerId,
            title: newScenarioTitle.trim(),
            startingPath: newScenarioPath.trim() || '/',
            prompt: newScenarioPrompt.trim(),
          }),
        }
      );
      const createJson = await createRes.json();
      if (createJson.success && createJson.data?.id) {
        // Generate test interactions from prompt
        if (runSummary?.testEnvironmentId) {
          await fetch(
            `${API_URL}/api/v1/test-scenarios/${createJson.data.id}/generate-sequence`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({
                testEnvironmentId: runSummary.testEnvironmentId,
              }),
            }
          );
        }
        setNewScenarioTitle('');
        setNewScenarioPath('');
        setNewScenarioPrompt('');
        setShowNewScenarioForm(false);
        void fetchScenarios();
      }
    } catch {
      // ignore
    } finally {
      setCreatingScenario(false);
    }
  }, [
    token,
    runSummary?.runnerId,
    runSummary?.testEnvironmentId,
    newScenarioTitle,
    newScenarioPath,
    newScenarioPrompt,
    fetchScenarios,
  ]);

  const handleRunScenario = useCallback(
    async (scenario: ScenarioItem) => {
      const runnerId = runSummary?.runnerId;
      if (!runnerId || isScanning || runningScenarioId != null) return;
      setRunningScenarioId(scenario.id);
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
      }
    },
    [runSummary, isScanning, runningScenarioId]
  );

  const handleStop = useCallback(() => {
    chrome.runtime.sendMessage({ type: 'STOP_SCAN' });
    setIsScanning(false);
  }, []);

  const handlePause = useCallback(() => {
    chrome.runtime.sendMessage({ type: 'PAUSE_SCAN' }).catch(err =>
      logPanel('pause-scan:failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    );
  }, []);

  const handleResume = useCallback(() => {
    chrome.runtime.sendMessage({ type: 'RESUME_SCAN' }).catch(err =>
      logPanel('resume-scan:failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    );
  }, []);

  const phases = [
    { key: 'scanning', label: 'Scanning' },
    { key: 'paused', label: 'Paused' },
    { key: 'completed', label: 'Complete' },
  ];

  const currentPhaseIndex = phases.findIndex(p => p.key === progress.phase);
  const expertiseSummaryEntries = Object.entries(
    progress.expertiseSummary ?? {}
  )
    .filter(([, counts]) => counts.errors > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  const summaryErrorCount =
    runSummary != null
      ? Object.values(runSummary.expertiseSummary ?? {}).reduce(
          (total, counts) => total + counts.errors,
          0
        )
      : 0;
  const eventFindingRows = progress.events
    .filter(event => event.type === 'finding')
    .map((event, index) => ({
      key: `${event.timestamp}-${index}`,
      timestamp: event.timestamp,
      badge: 'error',
      message: event.message,
      description: '',
      findingTitle: event.findingTitle ?? '',
    }));
  const summaryFindingRows = runSummary?.recentFindings
    ?.filter(finding => finding.type === 'error')
    .map(finding => ({
      key: String(finding.id),
      timestamp: finding.createdAt
        ? new Date(finding.createdAt).getTime()
        : Date.now(),
      badge: finding.type,
      message: finding.title,
      description: finding.description,
      findingTitle: finding.title,
    }));
  const errorCount = Math.max(summaryErrorCount, progress.findingsFound);
  const findingRows = [...(summaryFindingRows ?? []), ...eventFindingRows]
    .filter(
      (finding, index, rows) =>
        rows.findIndex(candidate =>
          candidate.findingTitle && finding.findingTitle
            ? candidate.findingTitle === finding.findingTitle
            : candidate.message === finding.message &&
              candidate.description === finding.description
        ) === index
    )
    .sort((left, right) => right.timestamp - left.timestamp);
  const currentRelativePath = progress.currentPageUrl
    ? (() => {
        try {
          return progress.currentPageUrl.startsWith('http')
            ? `${new URL(progress.currentPageUrl).pathname}${new URL(progress.currentPageUrl).search}`
            : progress.currentPageUrl;
        } catch {
          return progress.currentPageUrl;
        }
      })()
    : null;
  const activeStatusUpdate =
    progress.status_update ??
    (currentRelativePath ? `Current page: ${currentRelativePath}` : null);
  const fallbackScreenshotPath =
    runPageSummaries.find(
      page =>
        currentRelativePath != null &&
        page.relativePath === currentRelativePath &&
        page.latestScreenshotPath
    )?.latestScreenshotPath ??
    [...runPageSummaries].reverse().find(page => page.latestScreenshotPath)
      ?.latestScreenshotPath ??
    null;
  const overviewScreenshotUrl = progress.latestScreenshotDataUrl
    ? progress.latestScreenshotDataUrl
    : liveScreenshotDataUrl
      ? liveScreenshotDataUrl
      : fallbackScreenshotPath
        ? `${API_URL}/api/v1/artifacts/${fallbackScreenshotPath}`
        : null;
  const elementRunContext = new Map<
    number,
    {
      testInteractionId: number;
      title: string;
      testType: string;
      surfaceTitle: string;
      startingPath: string | null;
      status: string;
      durationMs: number | null;
      findingsCount: number;
      dependencyTestInteractionId: number | null;
    }
  >();
  for (const surface of runStructure?.surfaces ?? []) {
    for (const testInteraction of surface.testInteractions) {
      for (const elementRun of testInteraction.interactionRuns) {
        elementRunContext.set(elementRun.id, {
          testInteractionId: testInteraction.id,
          title: testInteraction.title,
          testType: testInteraction.testType,
          surfaceTitle: surface.title,
          startingPath: testInteraction.startingPath,
          status: elementRun.status,
          durationMs: elementRun.durationMs,
          findingsCount: elementRun.findings.length,
          dependencyTestInteractionId:
            testInteraction.dependencyTestInteractionId,
        });
      }
    }
  }
  const enrichedEventRows = progress.events.slice(-200).map((event, index) => {
    const runMatch = /Test case run (\d+)/.exec(event.message);
    const testInteractionRunId = runMatch ? Number(runMatch[1]) : null;
    const context = testInteractionRunId
      ? (elementRunContext.get(testInteractionRunId) ?? null)
      : null;
    return {
      key: `${event.timestamp}-${index}`,
      event,
      testInteractionRunId,
      context,
    };
  });

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

  const homeView = (
    <div className='p-3 space-y-3 text-sm flex flex-col h-screen'>
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
            onClick={() => setShowSettings(s => !s)}
            className={`${showSettings ? 'text-blue-600' : 'text-gray-400 hover:text-gray-600'}`}
            title='Settings'
          >
            <svg
              xmlns='http://www.w3.org/2000/svg'
              viewBox='0 0 20 20'
              fill='currentColor'
              className='w-4 h-4'
            >
              <path
                fillRule='evenodd'
                d='M7.84 1.804A1 1 0 0 1 8.82 1h2.36a1 1 0 0 1 .98.804l.331 1.652a6.993 6.993 0 0 1 1.929 1.115l1.598-.54a1 1 0 0 1 1.186.447l1.18 2.044a1 1 0 0 1-.205 1.251l-1.267 1.113a7.047 7.047 0 0 1 0 2.228l1.267 1.113a1 1 0 0 1 .206 1.25l-1.18 2.045a1 1 0 0 1-1.187.447l-1.598-.54a6.993 6.993 0 0 1-1.929 1.115l-.33 1.652a1 1 0 0 1-.98.804H8.82a1 1 0 0 1-.98-.804l-.331-1.652a6.993 6.993 0 0 1-1.929-1.115l-1.598.54a1 1 0 0 1-1.186-.447l-1.18-2.044a1 1 0 0 1 .205-1.251l1.267-1.114a7.05 7.05 0 0 1 0-2.227L1.821 7.773a1 1 0 0 1-.206-1.25l1.18-2.045a1 1 0 0 1 1.187-.447l1.598.54A6.992 6.992 0 0 1 7.51 3.456l.33-1.652ZM10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z'
                clipRule='evenodd'
              />
            </svg>
          </button>
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

      {/* Settings Panel */}
      {showSettings && (
        <div className='bg-gray-50 border border-gray-200 rounded-lg p-3 space-y-3'>
          <div className='font-medium text-xs text-gray-700'>Settings</div>
          <div>
            <label className='block text-[11px] font-medium text-gray-500 mb-0.5'>
              API URL
            </label>
            <input
              type='text'
              value={settingsApiUrl}
              onChange={e => setSettingsApiUrl(e.target.value)}
              placeholder='http://localhost:8027'
              className='w-full border border-gray-300 rounded px-2 py-1 text-xs'
            />
          </div>
          <div>
            <label className='block text-[11px] font-medium text-gray-500 mb-0.5'>
              API Key
            </label>
            <input
              type='password'
              value={settingsApiKey}
              onChange={e => setSettingsApiKey(e.target.value)}
              placeholder='Scanner API key'
              className='w-full border border-gray-300 rounded px-2 py-1 text-xs'
            />
          </div>
          <div>
            <label className='block text-[11px] font-medium text-gray-500 mb-0.5'>
              Click Wait Time (ms)
            </label>
            <input
              type='number'
              value={settingsClickWaitMs}
              onChange={e => setSettingsClickWaitMs(e.target.value)}
              min='0'
              step='100'
              className='w-full border border-gray-300 rounded px-2 py-1 text-xs'
            />
            <p className='text-[10px] text-gray-400 mt-0.5'>
              Delay after each click to wait for navigation. Default: 500ms.
            </p>
          </div>
          <button
            onClick={() => {
              chrome.runtime.sendMessage({
                type: 'SAVE_CONFIG',
                apiUrl: settingsApiUrl,
                apiKey: settingsApiKey,
                clickWaitMs: Number(settingsClickWaitMs) || 500,
              });
              setShowSettings(false);
            }}
            className='w-full bg-blue-600 text-white text-xs font-medium py-1.5 rounded hover:bg-blue-700'
          >
            Save Settings
          </button>
        </div>
      )}

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

          {activeTabUrl && (
            <>
              <div>
                <label className='block text-[11px] font-medium text-gray-500 mb-0.5'>
                  Environment
                </label>
                {isLocalEnvironment ? (
                  <div className='rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700'>
                    Local environment for {user?.email || 'current user'} on{' '}
                    {activeHostname}
                  </div>
                ) : (
                  <div className='space-y-2'>
                    <Combobox
                      options={environmentOptions}
                      value={selectedEnvironment}
                      onChange={value =>
                        setSelectedEnvironment(value as EnvironmentChoice)
                      }
                      placeholder='Select environment'
                      emptyMessage='No environments found'
                      className='w-full'
                    />
                    {selectedEnvironment === 'custom' && (
                      <Input
                        value={customEnvironmentLabel}
                        onChange={e =>
                          setCustomEnvironmentLabel(e.target.value)
                        }
                        placeholder='Enter environment label'
                      />
                    )}
                    <div className='text-[10px] text-gray-500'>
                      Scans for {activeHostname} will be stored under{' '}
                      <span className='font-medium text-gray-700'>
                        {resolvedEnvironmentLabel || 'an environment label'}
                      </span>
                      .
                    </div>
                  </div>
                )}
              </div>

              <div>
                <label className='block text-[11px] font-medium text-gray-500 mb-1'>
                  Expertises
                </label>
                <div className='rounded-md border border-gray-200 bg-gray-50 px-2 py-2 space-y-1.5'>
                  {EXPERTISE_OPTIONS.map(option => {
                    const checked = selectedExpertiseSlugs.includes(
                      option.slug
                    );
                    return (
                      <label
                        key={option.slug}
                        className='flex items-center justify-between gap-2 text-[11px] text-gray-700'
                      >
                        <span>
                          {option.label}
                          {option.required ? ' (required)' : ''}
                        </span>
                        <input
                          type='checkbox'
                          checked={checked}
                          disabled={option.required}
                          onChange={event => {
                            if (option.required) return;
                            setSelectedExpertiseSlugs(prev =>
                              event.target.checked
                                ? [...prev, option.slug]
                                : prev.filter(slug => slug !== option.slug)
                            );
                          }}
                        />
                      </label>
                    );
                  })}
                </div>
              </div>

              {/* Scan Mode */}
              <div>
                <div className='text-[11px] font-medium text-gray-700 mb-1'>
                  Scan depth
                </div>
                <div className='flex gap-1'>
                  {(
                    [
                      { value: 'full', label: 'Full' },
                      { value: 'partial', label: 'Partial' },
                      { value: 'minimum', label: 'Minimum' },
                    ] as const
                  ).map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => setScanMode(opt.value)}
                      className={`flex-1 text-[10px] font-medium py-1 rounded border transition-colors ${
                        scanMode === opt.value
                          ? 'bg-blue-600 text-white border-blue-600'
                          : 'bg-white text-gray-600 border-gray-300 hover:border-gray-400'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <p className='text-[10px] text-gray-500 mt-1'>
                  {scanMode === 'full' &&
                    'Run all interactions including hover'}
                  {scanMode === 'partial' && 'Skip hover interactions'}
                  {scanMode === 'minimum' && 'Navigation only — fastest'}
                </p>
              </div>

              {/* Continue with login */}
              <div>
                <label className='flex items-center gap-2 text-[11px] font-medium text-gray-700 cursor-pointer'>
                  <input
                    type='checkbox'
                    checked={continueWithLogin}
                    onChange={e => {
                      setContinueWithLogin(e.target.checked);
                      if (!e.target.checked) {
                        setSelectedCredentialId('');
                        setLoginUrl('');
                        setShowNewCredentialForm(false);
                      }
                    }}
                  />
                  Continue with login
                </label>
              </div>

              {continueWithLogin && (
                <div className='rounded-md border border-gray-200 bg-gray-50 px-3 py-2 space-y-2'>
                  <div>
                    <label className='block text-[11px] font-medium text-gray-500 mb-0.5'>
                      Credential
                    </label>
                    <Combobox
                      options={[
                        ...credentials.map(c => ({
                          value: String(c.id),
                          label: `${c.label} (${c.email || c.username || c.authProvider})`,
                        })),
                        { value: '__new__', label: '+ Add new' },
                      ]}
                      value={selectedCredentialId}
                      onChange={value => {
                        setSelectedCredentialId(value);
                        setShowNewCredentialForm(value === '__new__');
                        // Pre-fill loginUrl from selected credential
                        if (value !== '__new__') {
                          const cred = credentials.find(
                            c => String(c.id) === value
                          );
                          if (cred?.loginUrl && !loginUrl) {
                            setLoginUrl(cred.loginUrl);
                          }
                        }
                      }}
                      placeholder={
                        loadingCredentials
                          ? 'Loading...'
                          : 'Select credential...'
                      }
                      disabled={loadingCredentials}
                      emptyMessage='No credentials — add a new one'
                      className='w-full'
                    />
                  </div>

                  {showNewCredentialForm && (
                    <div className='space-y-1.5 border-t border-gray-200 pt-2'>
                      <div>
                        <label className='block text-[10px] font-medium text-gray-500 mb-0.5'>
                          Label
                        </label>
                        <input
                          type='text'
                          value={newCredLabel}
                          onChange={e => setNewCredLabel(e.target.value)}
                          placeholder='e.g. Admin account'
                          className='w-full border border-gray-300 rounded px-2 py-1 text-xs'
                        />
                      </div>
                      <div>
                        <label className='block text-[10px] font-medium text-gray-500 mb-0.5'>
                          Email
                        </label>
                        <input
                          type='email'
                          value={newCredEmail}
                          onChange={e => setNewCredEmail(e.target.value)}
                          placeholder='user@example.com'
                          className='w-full border border-gray-300 rounded px-2 py-1 text-xs'
                        />
                      </div>
                      <div>
                        <label className='block text-[10px] font-medium text-gray-500 mb-0.5'>
                          Password
                        </label>
                        <input
                          type='password'
                          value={newCredPassword}
                          onChange={e => setNewCredPassword(e.target.value)}
                          placeholder='Password'
                          className='w-full border border-gray-300 rounded px-2 py-1 text-xs'
                        />
                      </div>
                      <div>
                        <label className='block text-[10px] font-medium text-gray-500 mb-0.5'>
                          Auth Provider
                        </label>
                        <Combobox
                          options={AUTH_PROVIDER_OPTIONS}
                          value={newCredAuthProvider}
                          onChange={value => setNewCredAuthProvider(value)}
                          placeholder='Select provider'
                          emptyMessage='No providers'
                          className='w-full'
                        />
                      </div>
                      <button
                        onClick={async () => {
                          if (!newCredLabel.trim() || !selectedEntity || !token)
                            return;
                          setSavingCredential(true);
                          try {
                            const res = await fetch(
                              `${API_URL}/api/v1/entities/${selectedEntity.entitySlug}/credentials`,
                              {
                                method: 'POST',
                                headers: {
                                  'Content-Type': 'application/json',
                                  Authorization: `Bearer ${token}`,
                                },
                                body: JSON.stringify({
                                  entityId: selectedEntity.id,
                                  label: newCredLabel.trim(),
                                  email: newCredEmail.trim() || undefined,
                                  password: newCredPassword || undefined,
                                  authProvider: newCredAuthProvider,
                                }),
                              }
                            );
                            const data = await res.json();
                            if (data.success && data.data) {
                              await fetchCredentials();
                              setSelectedCredentialId(String(data.data.id));
                              setShowNewCredentialForm(false);
                              setNewCredLabel('');
                              setNewCredEmail('');
                              setNewCredPassword('');
                              setNewCredAuthProvider('email_password');
                              if (data.data.loginUrl && !loginUrl) {
                                setLoginUrl(data.data.loginUrl);
                              }
                            } else {
                              setError(
                                normalizeApiError(
                                  data,
                                  'Failed to save credential'
                                )
                              );
                            }
                          } catch (err) {
                            logPanel('save-credential:failed', {
                              error:
                                err instanceof Error
                                  ? err.message
                                  : String(err),
                            });
                            setError('Failed to save credential');
                          } finally {
                            setSavingCredential(false);
                          }
                        }}
                        disabled={savingCredential || !newCredLabel.trim()}
                        className='w-full bg-blue-600 text-white text-xs font-medium py-1.5 rounded hover:bg-blue-700 disabled:bg-blue-400'
                      >
                        {savingCredential ? 'Saving...' : 'Save Credential'}
                      </button>
                    </div>
                  )}

                  <div>
                    <label className='block text-[10px] font-medium text-gray-500 mb-0.5'>
                      Login URL (optional)
                    </label>
                    <input
                      type='text'
                      value={loginUrl}
                      onChange={e => setLoginUrl(e.target.value)}
                      placeholder='https://example.com/login'
                      className='w-full border border-gray-300 rounded px-2 py-1 text-xs'
                    />
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Test Current Page Button + Scenarios */}
      {activeTabUrl && !isScanning && (
        <div className='space-y-1.5'>
          <button
            onClick={handleTestCurrentPage}
            disabled={
              isSubmitting ||
              !selectedProductId ||
              !selectedEntityId ||
              !isEnvironmentSelectionValid
            }
            className='w-full py-2.5 px-3 text-sm font-medium rounded-md bg-green-600 hover:bg-green-700 disabled:bg-green-400 text-white truncate'
          >
            {isSubmitting
              ? 'Submitting...'
              : `Test ${new URL(activeTabUrl).hostname}`}
          </button>
          {runSummary?.runnerId && (
            <button
              onClick={() => setAppView('scenarios')}
              className='w-full py-1.5 px-3 text-xs font-medium rounded-md border border-gray-300 text-gray-600 hover:bg-gray-50'
            >
              Scenarios
            </button>
          )}
        </div>
      )}

      {/* Scan controls when active */}
      {isScanning && (
        <div className='grid grid-cols-2 gap-2'>
          {progress.isPaused ? (
            <button
              onClick={handleResume}
              className='w-full py-2 px-3 text-sm font-medium rounded-md bg-blue-600 hover:bg-blue-700 text-white'
            >
              Resume Scan
            </button>
          ) : (
            <button
              onClick={handlePause}
              className='w-full py-2 px-3 text-sm font-medium rounded-md bg-amber-500 hover:bg-amber-600 text-white'
            >
              Pause Scan
            </button>
          )}
          <button
            onClick={handleStop}
            className='w-full py-2 px-3 text-sm font-medium rounded-md bg-red-600 hover:bg-red-700 text-white'
          >
            Stop Scan
          </button>
        </div>
      )}

      {error && (
        <div className='p-2 rounded-md bg-red-50 text-red-700 text-xs'>
          {error}
        </div>
      )}

      {activeTabUrl && (
        <div className='flex items-center justify-between rounded-md border border-gray-200 bg-gray-50 px-2 py-1.5 text-[11px] text-gray-600'>
          <span className='font-medium text-gray-500'>Environment</span>
          <span className='truncate ml-2 text-gray-700'>
            {isLocalEnvironment
              ? `Local (${activeHostname})`
              : `${resolvedEnvironmentLabel} (${activeHostname})`}
          </span>
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
          <ElapsedTimer
            baseElapsedMs={progress.elapsedMs ?? 0}
            isActive={isScanning && !progress.isPaused}
            className='ml-auto text-xs font-mono text-gray-500'
          />
        </div>
      )}

      {/* Counters */}
      {(isScanning || progress.isComplete) && (
        <div className='grid grid-cols-4 gap-1'>
          {(
            [
              {
                key: 'map',
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
                key: 'coverage',
                label: 'Tests',
                value: progress.testRunsCompleted,
                color: 'text-green-600',
                ring: 'ring-green-300',
              },
              {
                key: 'issues',
                label: 'Errors',
                value: errorCount,
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
              <div className={`text-lg font-bold ${c.color}`}>
                <div className='flex items-center justify-center font-mono tabular-nums'>
                  <FlipNumbers
                    key={`${c.key}-${c.value}`}
                    height={18}
                    width={12}
                    color='currentColor'
                    background='transparent'
                    numbers={String(c.value)}
                    play
                    perspective={120}
                    duration={0.35}
                    numberStyle={{
                      fontSize: '1.125rem',
                      fontWeight: 700,
                    }}
                  />
                </div>
              </div>
              <div className='text-[10px] text-gray-500'>{c.label}</div>
            </button>
          ))}
        </div>
      )}

      {/* Tab bar */}
      {(isScanning || progress.isComplete) && (
        <div className='flex border-b border-gray-200'>
          {(
            [
              { key: 'overview', label: 'Overview' },
              { key: 'map', label: 'Navigation' },
              { key: 'issues', label: 'Errors' },
              { key: 'coverage', label: 'Coverage' },
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
        <div className='rounded-md border border-gray-200 overflow-hidden min-h-0 flex-1 flex flex-col'>
          {resultTab === 'overview' && (
            <div className='flex-1 overflow-y-auto'>
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
              {overviewScreenshotUrl && (
                <img
                  src={overviewScreenshotUrl}
                  alt='Current page'
                  className='w-full h-auto'
                />
              )}
              {!overviewScreenshotUrl && (
                <div className='p-4 text-center text-xs text-gray-400'>
                  Waiting for screenshot...
                </div>
              )}
              {(progress.aiSummary || expertiseSummaryEntries.length > 0) && (
                <div className='border-t border-gray-200 bg-white'>
                  {progress.aiSummary && (
                    <div className='px-3 py-2 text-[11px] leading-5 text-gray-700'>
                      {progress.aiSummary}
                    </div>
                  )}
                  {expertiseSummaryEntries.length > 0 && (
                    <div className='px-3 py-2 grid grid-cols-2 gap-2'>
                      {expertiseSummaryEntries.map(([name, counts]) => (
                        <div
                          key={name}
                          className='rounded-md border border-gray-200 bg-gray-50 px-2 py-1.5'
                        >
                          <div className='text-[10px] font-medium uppercase tracking-wide text-gray-500'>
                            {name}
                          </div>
                          <div className='mt-1 text-[11px]'>
                            <span className='text-red-600'>
                              {counts.errors} error
                              {counts.errors === 1 ? '' : 's'}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {resultTab === 'map' && (
            <div
              ref={eventLogRef}
              className='flex-1 overflow-y-auto font-mono text-[10px]'
            >
              {(navigationMap?.discoveredPages ?? []).map(page => {
                const visit = navigationMap?.pageVisits.find(
                  item => item.relativePath === page.relativePath
                );
                return (
                  <div
                    key={page.id}
                    className='px-2 py-1 border-b border-gray-100 last:border-0'
                  >
                    <div className='flex items-center justify-between gap-2'>
                      <span className='text-gray-700'>{page.relativePath}</span>
                      <span className='text-blue-600'>
                        {visit?.status ?? 'discovered'}
                      </span>
                    </div>
                    <div className='mt-0.5 text-gray-500 leading-4'>
                      from {page.sourcePagePath || 'root'}
                      {page.sourceLabel ? ` via ${page.sourceLabel}` : ''}
                    </div>
                  </div>
                );
              })}
              {(navigationMap?.discoveredPages.length ?? 0) === 0 && (
                <div className='p-3 text-center text-gray-400'>
                  No navigation map yet
                </div>
              )}
            </div>
          )}

          {resultTab === 'issues' && (
            <div
              ref={eventLogRef}
              className='flex-1 overflow-y-auto font-mono text-[10px]'
            >
              {findingRows.map(finding => (
                <div
                  key={finding.key}
                  className='px-2 py-1 border-b border-gray-100 last:border-0'
                >
                  <span className='text-gray-400'>
                    {new Date(finding.timestamp).toLocaleTimeString()}
                  </span>{' '}
                  <span className='text-red-600'>{finding.badge}</span>{' '}
                  <span className='text-gray-700'>{finding.message}</span>
                  {finding.description && (
                    <div className='mt-0.5 text-gray-500 leading-4'>
                      {finding.description}
                    </div>
                  )}
                </div>
              ))}
              {findingRows.length === 0 && (
                <div className='p-3 text-center text-gray-400'>
                  No errors yet
                </div>
              )}
            </div>
          )}

          {resultTab === 'coverage' && (
            <div
              ref={eventLogRef}
              className='flex-1 overflow-y-auto font-mono text-[10px]'
            >
              {runStructure && (
                <div className='border-b border-gray-100 px-2 py-1.5 bg-gray-50'>
                  <div className='text-gray-700 font-semibold'>
                    Bundle: {runStructure.bundle.title}
                  </div>
                  <div className='text-gray-500'>
                    Run {runStructure.bundleRun.id} ·{' '}
                    {runStructure.bundleRun.status}
                  </div>
                </div>
              )}
              {(runStructure?.surfaces ?? []).map(surface => (
                <div
                  key={surface.id}
                  className='border-b border-gray-100 last:border-0'
                >
                  <div className='px-2 py-1 bg-white border-b border-gray-100'>
                    <div className='flex items-center justify-between gap-2'>
                      <span className='text-gray-800'>{surface.title}</span>
                      <span className='text-green-600'>
                        {surface.surfaceRuns
                          .map(run => run.status)
                          .join(', ') || 'pending'}
                      </span>
                    </div>
                    <div className='text-gray-500'>
                      {surface.testInteractions.length} element
                      {surface.testInteractions.length === 1 ? '' : 's'}
                    </div>
                  </div>
                  {surface.testInteractions.map(testInteraction => (
                    <div
                      key={testInteraction.id}
                      className='px-3 py-1 border-b border-gray-50 last:border-0 bg-gray-50/50'
                    >
                      <div className='flex items-start justify-between gap-2'>
                        <div className='min-w-0'>
                          <div className='text-gray-700 break-words'>
                            {testInteraction.title}
                          </div>
                          <div className='mt-0.5 flex flex-wrap items-center gap-1 text-[9px]'>
                            <span className='rounded bg-slate-200 px-1.5 py-0.5 uppercase tracking-wide text-slate-700'>
                              {testInteraction.testType}
                            </span>
                            <span className='rounded bg-white px-1.5 py-0.5 text-gray-600'>
                              element #{testInteraction.id}
                            </span>
                            <span className='rounded bg-white px-1.5 py-0.5 text-gray-600'>
                              {testInteraction.interactionRuns.length} run
                              {testInteraction.interactionRuns.length === 1
                                ? ''
                                : 's'}
                            </span>
                          </div>
                        </div>
                        <span className='text-gray-500 whitespace-nowrap'>
                          p{testInteraction.priority}
                        </span>
                      </div>
                      <div className='text-gray-500'>
                        start {testInteraction.startingPath || '/'}
                        {testInteraction.dependencyTestInteractionId
                          ? ` · depends on #${testInteraction.dependencyTestInteractionId}`
                          : ''}
                      </div>
                      {testInteraction.interactionRuns.map(elementRun => (
                        <div
                          key={elementRun.id}
                          className='mt-1 rounded border border-gray-200 bg-white px-2 py-1 text-gray-600'
                        >
                          {(() => {
                            const errorFindings = elementRun.findings.filter(
                              finding => finding.type === 'error'
                            );
                            return (
                              <>
                                run {elementRun.id} · {elementRun.status}
                                {elementRun.durationMs != null
                                  ? ` · ${elementRun.durationMs}ms`
                                  : ''}
                                {errorFindings.length > 0
                                  ? ` · ${errorFindings.length} error${errorFindings.length === 1 ? '' : 's'}`
                                  : ''}
                              </>
                            );
                          })()}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              ))}
              {(runStructure?.surfaces.length ?? 0) === 0 && (
                <div className='p-3 text-center text-gray-400'>
                  No coverage tree yet
                </div>
              )}
            </div>
          )}

          {resultTab === 'events' && (
            <div
              ref={eventLogRef}
              className='flex-1 overflow-y-auto font-mono text-[10px]'
            >
              {enrichedEventRows.map(
                ({ key, event, testInteractionRunId, context }) => (
                  <div
                    key={key}
                    className='px-2 py-0.5 border-b border-gray-100 last:border-0'
                  >
                    <span className='text-gray-400'>
                      {new Date(event.timestamp).toLocaleTimeString()}
                    </span>{' '}
                    <span className='text-blue-600'>{event.type}</span>{' '}
                    <span className='text-gray-600'>{event.message}</span>
                    {context && (
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
                        <span className='rounded bg-gray-100 px-1.5 py-0.5'>
                          run #{testInteractionRunId}
                        </span>
                        {context.startingPath && (
                          <span className='rounded bg-gray-100 px-1.5 py-0.5'>
                            {context.startingPath}
                          </span>
                        )}
                        {context.dependencyTestInteractionId != null && (
                          <span className='rounded bg-gray-100 px-1.5 py-0.5'>
                            depends on #{context.dependencyTestInteractionId}
                          </span>
                        )}
                      </div>
                    )}
                    {context && (
                      <div className='mt-0.5 text-gray-700 break-words'>
                        {context.title}
                        {context.durationMs != null
                          ? ` · ${context.durationMs}ms`
                          : ''}
                        {context.findingsCount > 0
                          ? ` · ${context.findingsCount} finding${context.findingsCount === 1 ? '' : 's'}`
                          : ''}
                      </div>
                    )}
                  </div>
                )
              )}
            </div>
          )}
        </div>
      )}

      {progress.isComplete && (
        <div className='p-2 rounded-md bg-green-50 text-green-700 text-xs font-medium flex items-center justify-between'>
          <span>Scan complete!</span>
          {(progress.elapsedMs ?? 0) > 0 && (
            <span className='font-mono text-green-600'>
              {formatElapsedTime(Math.floor((progress.elapsedMs ?? 0) / 1000))}
            </span>
          )}
        </div>
      )}
    </div>
  );

  // =========================================================================
  // Scenarios View
  // =========================================================================

  const scenariosView = (
    <div className='flex flex-col h-full p-3 space-y-3'>
      <div className='flex items-center justify-between'>
        <button
          onClick={() => setAppView('home')}
          className='text-xs text-blue-600 hover:text-blue-700 font-medium'
        >
          &larr; Back
        </button>
        <span className='text-sm font-semibold text-gray-800'>Scenarios</span>
        <div className='w-10' />
      </div>

      <button
        onClick={() => setShowNewScenarioForm(v => !v)}
        className='w-full text-left text-xs font-medium text-blue-600 hover:text-blue-700 px-2 py-1.5 rounded-md border border-dashed border-blue-300 hover:bg-blue-50'
      >
        {showNewScenarioForm ? '- Cancel' : '+ New Scenario'}
      </button>

      {showNewScenarioForm && (
        <div className='space-y-1.5 rounded-md border border-gray-200 bg-gray-50 p-2'>
          <input
            type='text'
            placeholder='Title (e.g., Checkout flow)'
            value={newScenarioTitle}
            onChange={e => setNewScenarioTitle(e.target.value)}
            className='w-full text-xs px-2 py-1 border border-gray-300 rounded'
          />
          <input
            type='text'
            placeholder='Starting path (e.g., /store)'
            value={newScenarioPath}
            onChange={e => setNewScenarioPath(e.target.value)}
            className='w-full text-xs px-2 py-1 border border-gray-300 rounded'
          />
          <textarea
            placeholder='Prompt (e.g., Add item to cart and complete checkout)'
            value={newScenarioPrompt}
            onChange={e => setNewScenarioPrompt(e.target.value)}
            rows={3}
            className='w-full text-xs px-2 py-1 border border-gray-300 rounded resize-none'
          />
          <button
            onClick={handleCreateScenario}
            disabled={creatingScenario || !newScenarioTitle.trim()}
            className='w-full text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 px-3 py-1.5 rounded'
          >
            {creatingScenario ? 'Creating...' : 'Create'}
          </button>
        </div>
      )}

      {loadingScenarios && (
        <div className='text-center text-xs text-gray-400 py-4'>
          Loading scenarios...
        </div>
      )}

      {!loadingScenarios && scenarios.length === 0 && !showNewScenarioForm && (
        <div className='text-center text-xs text-gray-400 py-8'>
          No scenarios yet
        </div>
      )}

      <div className='flex-1 overflow-y-auto space-y-2'>
        {scenarios.map(s => (
          <div
            key={s.id}
            className='rounded-md border border-gray-200 bg-white px-2.5 py-2 flex items-center justify-between'
          >
            <div className='min-w-0 flex-1'>
              <div className='text-xs font-medium text-gray-800 truncate'>
                {s.title}
              </div>
              <div className='text-[10px] text-gray-400 truncate'>
                {s.startingPath}
                {s.prompt ? ` — ${s.prompt}` : ''}
              </div>
            </div>
            <button
              onClick={() => handleRunScenario(s)}
              disabled={isScanning || runningScenarioId != null}
              className='ml-2 shrink-0 w-7 h-7 flex items-center justify-center rounded-full text-white bg-green-500 hover:bg-green-600 disabled:opacity-40'
              title='Run scenario'
            >
              {runningScenarioId === s.id ? (
                <span className='text-[10px]'>...</span>
              ) : (
                <span className='text-sm'>&#9654;</span>
              )}
            </button>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className='relative min-h-screen pb-11'>
      {appView === 'scenarios' ? scenariosView : homeView}
      {(isScanning || activeStatusUpdate) && (
        <div className='fixed inset-x-0 bottom-0 z-50 border-t border-gray-200 bg-white/95 px-3 py-2 text-xs text-gray-700 shadow-sm backdrop-blur'>
          <div className='flex items-center gap-2'>
            <span
              className={`h-2 w-2 rounded-full ${
                isScanning && !progress.isPaused
                  ? 'bg-blue-500 animate-pulse'
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
    </div>
  );
}
