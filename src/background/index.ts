/**
 * Background Service Worker
 *
 * Thin wrapper that creates a ChromeAdapter and calls the shared
 * runTestRun() orchestrator from testomniac_runner_service.
 * Sends progress updates to the side panel via chrome.runtime.sendMessage.
 */

import { ChromeAdapter } from '../adapters/ChromeAdapter';
import {
  ApiClient,
  runTestRun,
  type ScanEventHandler,
  type Expertise,
  TesterExpertise,
  SeoExpertise,
  SecurityExpertise,
  PerformanceExpertise,
  NoopExpertise,
} from '@sudobility/testomniac_runner_service';
import { ChromeStorageDedupStore } from '../storage/ChromeStorageDedupStore';

const dedupStore = new ChromeStorageDedupStore();

// ---------------------------------------------------------------------------
// Persistent log ring buffer — survives service worker restarts
// ---------------------------------------------------------------------------
const LOG_STORAGE_KEY = 'debugLog';
const MAX_LOG_LINES = 500;
const LOG_FLUSH_INTERVAL_MS = 2000;
const LOG_FLUSH_THRESHOLD = 50;
let logBuffer: string[] = [];
let logDirtySinceFlush = 0;
let logFlushTimer: ReturnType<typeof setTimeout> | null = null;

function persistLog() {
  logDirtySinceFlush = 0;
  return chrome.storage.local
    .set({ [LOG_STORAGE_KEY]: logBuffer })
    .catch(() => {});
}

function scheduleLogFlush() {
  if (logFlushTimer !== null) return;
  logFlushTimer = setTimeout(() => {
    logFlushTimer = null;
    if (logDirtySinceFlush > 0) persistLog();
  }, LOG_FLUSH_INTERVAL_MS);
}

function flushLogs() {
  if (logFlushTimer !== null) {
    clearTimeout(logFlushTimer);
    logFlushTimer = null;
  }
  if (logDirtySinceFlush > 0) return persistLog();
}

function appendLog(level: string, args: unknown[]) {
  const ts = new Date().toISOString();
  const msg = args
    .map(a => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  const line = `${ts} [${level}] ${msg}`;
  logBuffer.push(line);
  if (logBuffer.length > MAX_LOG_LINES) {
    logBuffer = logBuffer.slice(-MAX_LOG_LINES);
  }
  logDirtySinceFlush++;
  if (logDirtySinceFlush >= LOG_FLUSH_THRESHOLD) {
    persistLog();
  } else {
    scheduleLogFlush();
  }
}

const LOG = (...args: unknown[]) => {
  console.log('[Testomniac]', ...args);
  appendLog('LOG', args);
};
const ERR = (...args: unknown[]) => {
  console.error('[Testomniac]', ...args);
  appendLog('ERR', args);
};

// ---------------------------------------------------------------------------
// Flush-on-shutdown registry — shared by log buffer, scan state, dedup store
// ---------------------------------------------------------------------------
const flushCallbacks: Array<() => void | Promise<void>> = [];

function registerFlush(fn: () => void | Promise<void>) {
  flushCallbacks.push(fn);
}

async function flushAll() {
  await Promise.allSettled(
    flushCallbacks.map(fn => {
      try {
        return fn();
      } catch {
        // best-effort
      }
    })
  );
}

registerFlush(flushLogs);

// Restore log buffer from previous worker lifetime
chrome.storage.local.get([LOG_STORAGE_KEY]).then(stored => {
  const saved = stored[LOG_STORAGE_KEY];
  if (Array.isArray(saved)) logBuffer = saved;
});

LOG('Background service worker starting...');

// Config — defaults from build-time env, overridable via chrome.storage.local
const DEFAULT_API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8027';
const DEFAULT_API_KEY = import.meta.env.VITE_SCANNER_API_KEY || '';
let apiUrl = DEFAULT_API_URL;
let apiKey = DEFAULT_API_KEY;
let clickWaitMs = 500;
const REQUIRED_EXPERTISE_SLUG = 'tester';

// ---------------------------------------------------------------------------
// Finding deduplication
// ---------------------------------------------------------------------------

/**
 * Strip leading count numbers that vary between evaluations so
 * "5 broken image(s)" and "3 broken image(s)" produce the same key.
 * Mirrors PageAnalyzer.normalizeFindingText.
 */
function normalizeFindingText(text: string): string {
  return text.replace(/^(\[[^\]]+\]\s*)\d+\s+/, '$1').replace(/^\d+\s+/, '');
}

/**
 * Create an ApiClient whose createTestRunFinding method deduplicates
 * findings within a single scan session.  Duplicate findings (same
 * type + normalized title + normalized description) are logged and
 * silently dropped so the DB sees only one record per unique issue.
 */
function createDedupApiClient(baseUrl: string, key: string): ApiClient {
  const client = new ApiClient(baseUrl, key);

  // Wrap the private `request` method with retry logic for transient network
  // failures.  Chrome MV3 service workers can wake from suspension mid-fetch,
  // and brief connectivity blips produce `TypeError: Failed to fetch`.
  // Without retries the entire scan crashes.
  const MAX_RETRIES = 3;
  const clientAny = client as any;
  const origRequest = (clientAny.request as Function).bind(client);
  clientAny.request = async function (
    method: string,
    path: string,
    body?: unknown
  ) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await origRequest(method, path, body);
      } catch (err: unknown) {
        const isNetworkError =
          err instanceof TypeError &&
          (err.message === 'Failed to fetch' ||
            err.message.includes('NetworkError') ||
            err.message.includes('network'));
        if (!isNetworkError || attempt === MAX_RETRIES) {
          throw err;
        }
        const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
        LOG(
          `[retry] ${method} ${path} failed (attempt ${attempt + 1}/${MAX_RETRIES}): ${err.message}, retrying in ${delay}ms`
        );
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  };

  const MAX_SEEN_KEYS = 5000;
  const seenKeys = new Set<string>();
  const origEnsure = client.ensureTestRunFinding.bind(client);

  client.ensureTestRunFinding = async (
    params: Parameters<ApiClient['ensureTestRunFinding']>[0]
  ) => {
    const normTitle = normalizeFindingText(params.title);
    const dedupKey = `${params.type}\0${normTitle}\0${params.path ?? ''}`;
    if (seenKeys.has(dedupKey)) {
      LOG(`[dedup] Skipping duplicate finding: ${params.title}`);
      return {
        id: 0,
        testRunId: params.testRunId,
        path: params.path ?? null,
        expertiseRuleId: null,
        type: params.type,
        priority: params.priority,
        title: params.title,
        description: params.description,
        interactionRunIds: [params.testInteractionRunId],
        createdAt: null,
      };
    }
    // Evict oldest entries when approaching the cap. The API-side
    // ensureTestRunFinding already deduplicates, so a few extra writes
    // after eviction are harmless.
    if (seenKeys.size >= MAX_SEEN_KEYS) {
      // Sets iterate in insertion order — delete the oldest batch
      const toDelete: string[] = [];
      const it = seenKeys.values();
      for (let i = 0; i < 500; i++) {
        const v = it.next();
        if (v.done) break;
        toDelete.push(v.value);
      }
      for (const k of toDelete) seenKeys.delete(k);
    }
    seenKeys.add(dedupKey);
    return origEnsure(params);
  };

  return client;
}

function createExpertises(slugs?: string[] | null): Expertise[] {
  const registry: Record<string, () => Expertise> = {
    tester: () => new TesterExpertise(),
    seo: () => new SeoExpertise(),
    security: () => new SecurityExpertise(),
    performance: () => new PerformanceExpertise(),
    content: () => new NoopExpertise('content'),
    ui: () => new NoopExpertise('ui'),
    accessibility: () => new NoopExpertise('accessibility'),
  };
  const normalized = Array.from(
    new Set(
      (slugs ?? [REQUIRED_EXPERTISE_SLUG])
        .map(slug => slug.trim().toLowerCase())
        .filter(Boolean)
    )
  );
  const selected = normalized.includes(REQUIRED_EXPERTISE_SLUG)
    ? normalized
    : [REQUIRED_EXPERTISE_SLUG, ...normalized];

  return selected
    .map(slug => registry[slug]?.())
    .filter((expertise): expertise is Expertise => Boolean(expertise));
}

interface ScanState {
  isRunning: boolean;
  isPaused: boolean;
  scanId: number | null;
  runnerId: number | null;
  runnerInstanceId: string | null;
  runnerInstanceName: string | null;
  targetUrl: string | null;
  phase: string;
  pagesFound: number;
  pageStatesFound: number;
  testRunsCompleted: number;
  findingsFound: number;
  environmentKind: 'local' | 'shared' | null;
  environmentLabel: string | null;
  environmentHostname: string | null;
  currentPageUrl: string | null;
  status_update: string | null;
  latestScreenshotDataUrl: string | null;
  aiSummary: string | null;
  expertiseSummary: Record<
    string,
    {
      warnings: number;
      errors: number;
    }
  > | null;
  elapsedMs: number;
  events: Array<{
    type: string;
    message: string;
    timestamp: number;
    findingTitle?: string;
  }>;
  scanMode: 'full' | 'partial' | 'minimum' | null;
  isComplete: boolean;
}

interface ScanCompleteSummary {
  totalPages: number;
  totalFindings: number;
  durationMs: number;
  aiSummary?: string;
  expertiseSummary?: Record<
    string,
    {
      warnings: number;
      errors: number;
    }
  >;
}

let scanState: ScanState = {
  isRunning: false,
  isPaused: false,
  scanId: null,
  runnerId: null,
  runnerInstanceId: null,
  runnerInstanceName: null,
  targetUrl: null,
  phase: 'idle',
  pagesFound: 0,
  pageStatesFound: 0,
  testRunsCompleted: 0,
  findingsFound: 0,
  environmentKind: null,
  environmentLabel: null,
  environmentHostname: null,
  currentPageUrl: null,
  status_update: null,
  latestScreenshotDataUrl: null,
  aiSummary: null,
  expertiseSummary: null,
  elapsedMs: 0,
  events: [],
  scanMode: null,
  isComplete: false,
};

const SCAN_STATE_STORAGE_KEY = 'scanState';
const EXTENSION_INSTANCE_ID_STORAGE_KEY = 'extensionInstanceId';
let extensionInstanceId: string | null = null;
let activeRunPromise: Promise<void> | null = null;
let scanStarting = false; // synchronous latch — prevents race in START_SCAN handler
let activeScanGeneration = 0; // monotonic counter — lets finalizer detect if it still owns the scan

function getSerializableScanState(): ScanState {
  // Exclude latestScreenshotDataUrl from persisted state — it's large
  // (base64 PNG) and transient.  Screenshots flow through the dedicated
  // SCREENSHOT_CAPTURED message instead.
  return {
    ...scanState,
    latestScreenshotDataUrl: null,
    events: [...scanState.events],
  };
}

function persistScanState() {
  return chrome.storage.local
    .set({
      [SCAN_STATE_STORAGE_KEY]: getSerializableScanState(),
    })
    .catch(error => {
      ERR('Failed to persist scan state', error);
    });
}

async function restoreScanState() {
  try {
    const stored = await chrome.storage.local.get([SCAN_STATE_STORAGE_KEY]);
    const saved = stored[SCAN_STATE_STORAGE_KEY] as ScanState | undefined;
    if (!saved) return;

    scanState = {
      ...scanState,
      ...saved,
      events: Array.isArray(saved.events) ? saved.events : [],
    };
    LOG('Restored persisted scan state', {
      scanId: scanState.scanId,
      phase: scanState.phase,
      isComplete: scanState.isComplete,
      isRunning: scanState.isRunning,
      isPaused: scanState.isPaused,
    });
    pauseController = new PauseController(scanState.isPaused);
  } catch (error) {
    ERR('Failed to restore scan state', error);
  }
}

function resetState() {
  scanState = {
    isRunning: false,
    isPaused: false,
    scanId: null,
    runnerId: null,
    runnerInstanceId: null,
    runnerInstanceName: null,
    targetUrl: null,
    phase: 'idle',
    pagesFound: 0,
    pageStatesFound: 0,
    testRunsCompleted: 0,
    findingsFound: 0,
    environmentKind: null,
    environmentLabel: null,
    environmentHostname: null,
    currentPageUrl: null,
    status_update: null,
    latestScreenshotDataUrl: null,
    aiSummary: null,
    expertiseSummary: null,
    elapsedMs: 0,
    events: [],
    scanMode: null,
    isComplete: false,
  };
  void persistScanState();
}

class PauseController {
  private paused = false;
  private waiters = new Set<() => void>();

  constructor(initialPaused = false) {
    this.paused = initialPaused;
  }

  setPaused(paused: boolean) {
    this.paused = paused;
    if (!paused) {
      for (const resolve of this.waiters) {
        resolve();
      }
      this.waiters.clear();
    }
  }

  isPaused() {
    return this.paused;
  }

  async waitIfPaused(signal?: globalThis.AbortSignal): Promise<void> {
    if (!this.paused) return;

    await new Promise<void>((resolve, reject) => {
      const handleAbort = () => {
        cleanup();
        const error = new Error('Scan aborted');
        error.name = 'AbortError';
        reject(error);
      };

      const resume = () => {
        cleanup();
        resolve();
      };

      const cleanup = () => {
        signal?.removeEventListener('abort', handleAbort);
        this.waiters.delete(resume);
      };

      if (signal?.aborted) {
        handleAbort();
        return;
      }

      signal?.addEventListener('abort', handleAbort, { once: true });
      this.waiters.add(resume);
    });
  }
}

let pauseController = new PauseController(false);

function addEvent(type: string, message: string, findingTitle?: string) {
  LOG(`[event] ${type}: ${message}`);
  scanState.status_update = message;
  scanState.events.push({ type, message, timestamp: Date.now(), findingTitle });
  if (scanState.events.length > 100) scanState.events.shift();
  sendProgressToSidePanel();
}

const SCAN_STATE_FLUSH_INTERVAL = 10; // persist every Nth progress update
let scanStateSinceFlush = 0;

let progressThrottleTimer: ReturnType<typeof setTimeout> | null = null;
let progressPending = false;

function sendProgressToSidePanel(forcePersist = false) {
  if (forcePersist) {
    scanStateSinceFlush = 0;
    void persistScanState();
  } else if (++scanStateSinceFlush >= SCAN_STATE_FLUSH_INTERVAL) {
    scanStateSinceFlush = 0;
    void persistScanState();
  }

  // Throttle progress messages to max 1 per second to avoid side panel flicker
  if (forcePersist) {
    // Force: send immediately and reset throttle
    if (progressThrottleTimer) {
      clearTimeout(progressThrottleTimer);
      progressThrottleTimer = null;
    }
    progressPending = false;
    doSendProgress();
  } else if (!progressThrottleTimer) {
    doSendProgress();
    progressThrottleTimer = setTimeout(() => {
      progressThrottleTimer = null;
      if (progressPending) {
        progressPending = false;
        doSendProgress();
      }
    }, 1000);
  } else {
    progressPending = true;
  }
}

function doSendProgress() {
  chrome.runtime
    .sendMessage({
      type: 'SCAN_PROGRESS',
      data: { ...scanState, latestScreenshotDataUrl: null },
    })
    .catch(err =>
      LOG(
        'send-progress:failed',
        err instanceof Error ? err.message : String(err)
      )
    );
}

function flushScanState() {
  scanStateSinceFlush = 0;
  return persistScanState();
}

registerFlush(flushScanState);

async function loadConfig() {
  LOG('Loading config from chrome.storage.local...');
  const stored = await chrome.storage.local.get([
    'apiUrl',
    'apiKey',
    'clickWaitMs',
  ]);
  if (stored.apiUrl) apiUrl = stored.apiUrl as string;
  if (stored.apiKey) apiKey = stored.apiKey as string;
  if (stored.clickWaitMs != null) clickWaitMs = Number(stored.clickWaitMs);
  LOG(
    `Config loaded: apiUrl=${apiUrl}, hasApiKey=${!!apiKey}, clickWaitMs=${clickWaitMs}`
  );
}

async function ensureExtensionInstanceId(): Promise<string> {
  if (extensionInstanceId) return extensionInstanceId;

  const stored = await chrome.storage.local.get([
    EXTENSION_INSTANCE_ID_STORAGE_KEY,
  ]);
  const saved = stored[EXTENSION_INSTANCE_ID_STORAGE_KEY];
  if (typeof saved === 'string' && saved.length > 0) {
    extensionInstanceId = saved;
    return saved;
  }

  const created = crypto.randomUUID();
  extensionInstanceId = created;
  await chrome.storage.local.set({
    [EXTENSION_INSTANCE_ID_STORAGE_KEY]: created,
  });
  return created;
}

function getRunnerInstanceName(instanceId: string): string {
  return `chrome-extension:${instanceId.slice(0, 8)}`;
}

// ============================================================================
// Scan Orchestration — delegates to shared runTestRun()
// ============================================================================

let scanAbortController: AbortController | null = null;

async function runScanSession(
  url: string,
  runId: number,
  options?: {
    environment?: {
      kind?: 'local' | 'shared';
      label?: string;
      hostname?: string;
    };
    resumeExisting?: boolean;
    scanMode?: 'full' | 'partial' | 'minimum';
    loginOptions?: {
      continueWithLogin?: boolean;
      entityCredentialId?: number;
      loginUrl?: string;
    };
  }
) {
  const myGeneration = ++activeScanGeneration;
  const environment = options?.environment;
  const resumeExisting = options?.resumeExisting ?? false;
  const scanMode = options?.scanMode;
  const loginOptions = options?.loginOptions;
  const instanceId =
    scanState.runnerInstanceId ?? (await ensureExtensionInstanceId());
  const runnerInstanceId = resumeExisting
    ? (scanState.runnerInstanceId ?? instanceId)
    : instanceId;
  const runnerInstanceName =
    scanState.runnerInstanceName ?? getRunnerInstanceName(runnerInstanceId);

  // Cancel any previous active session if this is a new run.
  if (!resumeExisting) {
    scanAbortController?.abort();
  }
  scanAbortController = new AbortController();
  const localSignal = scanAbortController.signal;
  pauseController.setPaused(scanState.isPaused);

  LOG(`========== STARTING SCAN ==========`);
  LOG(`URL: ${url}, Run ID: ${runId}, resumeExisting=${resumeExisting}`);
  await loadConfig();

  if (!resumeExisting) {
    resetState();
  }
  scanState.isRunning = true;
  scanState.isPaused = false;
  scanState.phase = 'scanning';
  scanState.scanId = runId;
  scanState.targetUrl = url;
  scanState.scanMode = scanMode ?? scanState.scanMode ?? null;
  scanState.runnerInstanceId = runnerInstanceId;
  startKeepalive();
  scanState.runnerInstanceName = runnerInstanceName;
  scanState.environmentKind =
    environment?.kind ?? scanState.environmentKind ?? null;
  scanState.environmentLabel =
    environment?.label ?? scanState.environmentLabel ?? null;
  scanState.environmentHostname =
    environment?.hostname ?? scanState.environmentHostname ?? null;
  addEvent(
    resumeExisting ? 'scan_resumed' : 'scan_started',
    resumeExisting
      ? `Resuming scan ${runId}`
      : `Scanning ${url}${environment?.label ? ` [${environment.label}]` : ''}`
  );

  LOG(`Creating ApiClient with baseUrl=${apiUrl}, hasApiKey=${!!apiKey}`);
  const api = apiKey ? createDedupApiClient(apiUrl, apiKey) : null;

  if (!api) {
    ERR('No API key configured — cannot scan');
    addEvent('error', 'No API key configured');
    scanState.phase = 'failed';
    scanState.isComplete = true;
    scanState.isRunning = false;
    sendProgressToSidePanel(true);
    return;
  }

  try {
    LOG(`Fetching run ${runId} from API...`);
    const run = await api.getTestRun(runId);
    LOG(`getTestRun result:`, run);
    if (!run) {
      throw new Error(`Run ${runId} not found`);
    }
    scanState.runnerId = run.runnerId;
    const runnerId = run.runnerId;
    LOG(`Runner ID: ${runnerId}`);

    LOG('Querying active tab...');
    let [activeTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    LOG(`Active tab: id=${activeTab?.id}, url=${activeTab?.url?.slice(0, 60)}`);

    const isWebPage =
      activeTab?.url?.startsWith('http://') ||
      activeTab?.url?.startsWith('https://');
    if (!activeTab?.id || !isWebPage) {
      LOG('Active tab is not a web page — creating new tab');
      activeTab = await chrome.tabs.create({ url, active: true });
      if (!activeTab?.id) throw new Error('Failed to create tab');
      LOG(`Created new tab: ${activeTab.id}`);
    }

    const adapter = new ChromeAdapter(activeTab.id);
    LOG(`ChromeAdapter created for tab ${activeTab.id}`);

    if (activeTab.url !== url) {
      LOG(`Navigating to ${url}...`);
      await adapter.goto(url, { timeout: 30000 });
      LOG('Navigation complete');
    } else {
      LOG('Already on target URL');
    }
    LOG('Navigation complete — network-idle gate will settle reads');

    const eventHandler: ScanEventHandler & {
      onStatusUpdate?: (update: {
        message: string;
        testRunId?: number;
      }) => void;
    } = {
      onPageFound(page) {
        LOG(`[event] pageFound: ${page.relativePath} (id=${page.pageId})`);
        scanState.phase = scanState.isPaused ? 'paused' : 'scanning';
        scanState.currentPageUrl = page.relativePath;
        scanState.status_update = `Discovered page ${page.relativePath}`;
        addEvent('page_discovered', page.relativePath);
      },
      onPageStateCreated(state) {
        LOG(
          `[event] pageStateCreated: id=${state.pageStateId} pageId=${state.pageId}`
        );
        scanState.phase = scanState.isPaused ? 'paused' : 'scanning';
        scanState.status_update = 'Captured page state';
        addEvent('state_captured', 'Page state captured');
      },
      onTestSurfaceCreated(surface) {
        LOG(
          `[event] testSurfaceCreated: surfaceId=${surface.surfaceId} title=${surface.title}`
        );
        scanState.phase = scanState.isPaused ? 'paused' : 'scanning';
        scanState.status_update = `Created test surface: ${surface.title}`;
        addEvent('test_surface_created', surface.title);
      },
      onTestInteractionRunCompleted(run) {
        LOG(
          `[event] testInteractionRunCompleted: testInteractionRunId=${run.testInteractionRunId} passed=${run.passed}`
        );
        scanState.phase = scanState.isPaused ? 'paused' : 'scanning';
        scanState.status_update = `Completed interaction run ${run.testInteractionRunId}`;
        addEvent(
          run.passed ? 'test_interaction_passed' : 'test_interaction_failed',
          `Test case run ${run.testInteractionRunId}`
        );
      },
      onTestRunCompleted(run) {
        LOG(
          `[event] testRunCompleted: testRunId=${run.testRunId} passed=${run.passed}`
        );
        addEvent(
          run.passed ? 'test_passed' : 'test_failed',
          `Test run ${run.testRunId}`
        );
      },
      onFindingCreated(finding) {
        LOG(`[event] findingCreated: ${finding.type}: ${finding.title}`);
        if (finding.type === 'error') {
          scanState.findingsFound += 1;
          const detail = (
            finding as typeof finding & { description?: string }
          ).description?.trim();
          const summaryLine = detail ? detail.split('\n')[0] : '';
          addEvent(
            'finding',
            summaryLine
              ? `${finding.type}: ${finding.title} — ${summaryLine}`
              : `${finding.type}: ${finding.title}`,
            finding.title
          );
        }
      },
      onStatsUpdated(stats) {
        scanState.pagesFound = stats.pagesFound;
        scanState.pageStatesFound = stats.pageStatesFound;
        scanState.testRunsCompleted = stats.testRunsCompleted;
        if (typeof stats.elapsedMs === 'number') {
          scanState.elapsedMs = stats.elapsedMs;
        }
        const statusMessage = (stats as { status_update?: string })
          .status_update;
        if (statusMessage) {
          scanState.status_update = statusMessage;
        }
        sendProgressToSidePanel();
      },
      onStatusUpdate(update) {
        LOG(`[event] status_update: ${update.message}`);
        scanState.status_update = update.message;
        addEvent('status_update', update.message);
      },
      onScreenshotCaptured(data) {
        LOG(`[event] screenshotCaptured: ${data.pageUrl}`);
        scanState.latestScreenshotDataUrl = data.dataUrl;
        scanState.currentPageUrl = data.pageUrl;
        sendProgressToSidePanel();
        chrome.runtime
          .sendMessage({ type: 'SCREENSHOT_CAPTURED', data })
          .catch(err =>
            LOG(
              'send-screenshot:failed',
              err instanceof Error ? err.message : String(err)
            )
          );
      },
      onScanComplete(summary: ScanCompleteSummary) {
        LOG(
          `[event] scanComplete: pages=${summary.totalPages} findings=${summary.totalFindings} duration=${summary.durationMs}ms`
        );
        scanState.isComplete = true;
        scanState.phase = 'completed';
        scanState.elapsedMs = summary.durationMs;
        scanState.aiSummary = summary.aiSummary ?? null;
        scanState.expertiseSummary = summary.expertiseSummary ?? null;
        addEvent(
          'run_completed',
          `Completed: ${summary.totalPages} pages, ${summary.totalFindings} findings`
        );
      },
      onError(error) {
        ERR(`[event] scanError: ${error.message}`);
        if (localSignal.aborted) return;
        scanState.phase = scanState.isPaused ? 'paused' : 'failed';
        addEvent('error', error.message);
      },
    };

    // Credentials now live in the per-environment userData blob, which
    // runner_service fetches itself by testEnvironmentId. The background only
    // resolves the login URL here.
    const resolvedLoginUrl =
      loginOptions?.loginUrl ??
      (run as { loginUrl?: string | null }).loginUrl ??
      undefined;

    const runExpertiseSlugs =
      (run as { expertiseSlugsJson?: string[] | null }).expertiseSlugsJson ??
      undefined;
    const expertises = createExpertises(runExpertiseSlugs);
    LOG(
      `Calling runTestRun(adapter, {testRunId=${runId}, runnerId=${runnerId}, baseUrl=${new URL(url).origin}}, api, expertises=${expertises.map(expertise => expertise.name).join(',')}, eventHandler)`
    );
    // Restrict scanning to the subpath of the scan URL.  For example,
    // scanning https://example.com/shop/shoes scopes to /shop/shoes.
    const parsedUrl = new URL(url);
    const scanScopePath =
      parsedUrl.pathname !== '/' ? parsedUrl.pathname : undefined;

    const result = await runTestRun(
      adapter,
      {
        testRunId: runId,
        runnerId,
        testEnvironmentId: run.testEnvironmentId ?? undefined,
        baseUrl: parsedUrl.origin,
        sizeClass: 'desktop',
        runnerInstanceId,
        runnerInstanceName,
        signal: localSignal,
        waitForCheckpoint: async () => {
          if (!scanState.isPaused) return;
          scanState.phase = 'paused';
          sendProgressToSidePanel(true);
          await pauseController.waitIfPaused(localSignal);
          scanState.phase = 'scanning';
          sendProgressToSidePanel(true);
        },
        loginUrl: resolvedLoginUrl,
        scanMode,
        scanScopePath,
      },
      api,
      expertises,
      eventHandler,
      { dedupStore }
    );
    LOG(`runTestRun returned:`, result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Scan failed';
    const stack = err instanceof Error ? err.stack : undefined;
    if (err instanceof Error && err.name === 'AbortError') {
      LOG('Scan aborted');
      return;
    }
    ERR('SCAN FAILED:', message);
    ERR('SCAN FAILED stack:', stack);
    ERR('SCAN FAILED raw:', err);
    scanState.phase = 'failed';
    scanState.isComplete = true;
    addEvent('error', message);
    chrome.runtime.sendMessage({ type: 'SCAN_ERROR', error: message });
  } finally {
    // Only clean up if this session still owns the scan. A newer
    // START_SCAN after STOP_SCAN increments activeScanGeneration,
    // so the old finalizer must not clobber the new scan's state.
    const ownsActiveScan = myGeneration === activeScanGeneration;
    if (ownsActiveScan) {
      activeRunPromise = null;
    }
    LOG('runScanSession finally block', {
      isPaused: scanState.isPaused,
      isRunning: scanState.isRunning,
      phase: scanState.phase,
      isComplete: scanState.isComplete,
      scanId: scanState.scanId,
      ownsActiveScan,
    });
    if (ownsActiveScan && !scanState.isPaused) {
      scanState.isRunning = false;
      stopKeepalive();
    }
    if (ownsActiveScan) {
      sendProgressToSidePanel(true);
    }
    LOG('Scan finished, isRunning=', scanState.isRunning);
    await flushAll();
  }
}

async function startScan(
  url: string,
  runId: number,
  environment?: {
    kind?: 'local' | 'shared';
    label?: string;
    hostname?: string;
  },
  scanMode?: 'full' | 'partial' | 'minimum',
  loginOptions?: {
    continueWithLogin?: boolean;
    entityCredentialId?: number;
    loginUrl?: string;
  }
) {
  await dedupStore.clear();
  activeRunPromise = runScanSession(url, runId, {
    environment,
    scanMode,
    loginOptions,
  });
  await activeRunPromise;
}

async function resumePausedScan() {
  LOG('resumePausedScan called', {
    scanId: scanState.scanId,
    isPaused: scanState.isPaused,
    isRunning: scanState.isRunning,
    phase: scanState.phase,
    hasActiveRunPromise: activeRunPromise != null,
    targetUrl: scanState.targetUrl,
  });

  if (!scanState.scanId) {
    throw new Error('No paused scan to resume');
  }

  pauseController.setPaused(false);
  scanState.isPaused = false;
  scanState.phase = 'scanning';
  sendProgressToSidePanel(true);

  if (activeRunPromise) {
    LOG('resumePausedScan: activeRunPromise exists, just unpaused controller');
    return;
  }

  LOG(
    'resumePausedScan: no activeRunPromise — restarting scan session with resumeExisting=true'
  );

  const url = scanState.targetUrl;
  if (!url) {
    throw new Error('Paused scan is missing its target URL');
  }

  activeRunPromise = runScanSession(url, scanState.scanId, {
    environment: {
      kind: scanState.environmentKind ?? undefined,
      label: scanState.environmentLabel ?? undefined,
      hostname: scanState.environmentHostname ?? undefined,
    },
    scanMode: scanState.scanMode ?? undefined,
    resumeExisting: true,
  });
}

// ============================================================================
// Scenario Execution
// ============================================================================

// Persisted test action plus the locator fields the scenario runner relies on
// (returned by the API but not part of the shared TestActionResponse type).
interface ScenarioAction {
  actionType: string;
  stepOrder: number;
  path?: string | null;
  value?: string | null;
  playwrightLocator?: string | null;
  selector?: string | null;
}

async function runScenario(
  scenarioId: number,
  _runnerId: number,
  startingPath: string,
  _testEnvironmentId?: number
): Promise<void> {
  await loadConfig();
  const baseUrl = apiUrl;
  const key = apiKey;
  if (!baseUrl || !key) {
    ERR('runScenario: missing API config');
    return;
  }

  // Scanner-key-authenticated client (service workers can't use React hooks).
  const api = new ApiClient(baseUrl, key);

  try {
    startKeepalive();

    // Validate the scenario exists before doing any work.
    const scenario = await api.getTestScenario(scenarioId);
    if (!scenario) {
      ERR('runScenario: failed to fetch scenario');
      return;
    }

    // Fetch sequences for this scenario
    const sequences = await api.getTestScenarioSequencesByScenario(scenarioId);

    if (sequences.length === 0) {
      LOG('runScenario: no sequences found');
      broadcastProgress('SCENARIO_PROGRESS', {
        step: 0,
        totalSteps: 0,
        status: 'no_sequences',
      });
      return;
    }

    // Use the first sequence
    const sequence = sequences[0];

    // Fetch linked test interactions for this sequence
    const links = await api.getSequenceTestInteractions(sequence.id);

    if (links.length === 0) {
      LOG('runScenario: no interactions in sequence');
      broadcastProgress('SCENARIO_PROGRESS', {
        step: 0,
        totalSteps: 0,
        status: 'no_interactions',
      });
      return;
    }

    // Sort by stepOrder
    links.sort(
      (a: { stepOrder: number }, b: { stepOrder: number }) =>
        a.stepOrder - b.stepOrder
    );

    // Get active tab
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.id) {
      ERR('runScenario: no active tab');
      return;
    }

    const adapter = new ChromeAdapter(tab.id);

    // Navigate to starting path
    const baseOrigin = tab.url ? new URL(tab.url).origin : '';
    const fullUrl = startingPath.startsWith('http')
      ? startingPath
      : `${baseOrigin}${startingPath}`;
    await adapter.goto(fullUrl, { timeout: 30000 });

    const totalSteps = links.length;
    broadcastProgress('SCENARIO_PROGRESS', {
      step: 0,
      totalSteps,
      status: 'running',
    });

    // Execute each interaction's actions sequentially
    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      broadcastProgress('SCENARIO_PROGRESS', {
        step: i + 1,
        totalSteps,
        interactionId: link.testInteractionId,
        status: 'running',
      });

      // Fetch test actions for this interaction. The endpoint returns extra
      // locator fields not present on the shared TestActionResponse type.
      const actions = (await api.getTestInteractionActions(
        link.testInteractionId
      )) as ScenarioAction[];

      // Sort by stepOrder
      actions.sort(
        (a: { stepOrder: number }, b: { stepOrder: number }) =>
          a.stepOrder - b.stepOrder
      );

      for (const action of actions) {
        try {
          switch (action.actionType) {
            case 'goto':
              if (action.path) {
                const navUrl = action.path.startsWith('http')
                  ? action.path
                  : `${baseOrigin}${action.path}`;
                await adapter.goto(navUrl, { timeout: 30000 });
              }
              break;
            case 'click':
              if (action.playwrightLocator || action.selector) {
                await adapter.click(
                  (action.playwrightLocator || action.selector)!,
                  { timeout: 10000 }
                );
              }
              break;
            case 'hover':
              if (action.playwrightLocator || action.selector) {
                await adapter.hover(
                  (action.playwrightLocator || action.selector)!,
                  { timeout: 10000 }
                );
              }
              break;
            case 'fill':
            case 'type':
              if (
                (action.playwrightLocator || action.selector) &&
                action.value != null
              ) {
                await adapter.type(
                  (action.playwrightLocator || action.selector)!,
                  action.value
                );
              }
              break;
            case 'press':
              if (action.value) {
                await adapter.pressKey(action.value);
              }
              break;
            case 'selectOption':
              if (
                (action.playwrightLocator || action.selector) &&
                action.value != null
              ) {
                await adapter.select(
                  (action.playwrightLocator || action.selector)!,
                  action.value
                );
              }
              break;
          }
          // Brief pause between actions
          await new Promise(r => setTimeout(r, 500));
        } catch (err) {
          LOG(
            `runScenario: action failed: ${action.actionType} — ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }

    broadcastProgress('SCENARIO_PROGRESS', {
      step: totalSteps,
      totalSteps,
      status: 'completed',
    });
  } catch (err) {
    ERR('runScenario failed', err);
    broadcastProgress('SCENARIO_PROGRESS', {
      step: 0,
      totalSteps: 0,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    stopKeepalive();
  }
}

function broadcastProgress(type: string, data: Record<string, unknown>): void {
  chrome.runtime.sendMessage({ type, ...data }).catch(() => {
    // Side panel may not be open
  });
}

// ============================================================================
// Message Handlers
// ============================================================================

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  LOG(`Message received: ${message.type}`);

  if (message.type === 'GET_SCAN_STATE') {
    sendResponse({ ok: true, data: { ...scanState } });
    return true;
  }

  if (message.type === 'START_SCAN' && message.url && message.runId) {
    if (scanStarting || scanState.isRunning || activeRunPromise) {
      LOG('START_SCAN rejected — scan already running or starting');
      sendResponse({ ok: false, error: 'Scan already running' });
      return true;
    }
    scanStarting = true;
    LOG(
      `START_SCAN: url=${message.url}, runId=${message.runId}, scanMode=${message.scanMode ?? 'full'}`
    );
    void startScan(
      message.url,
      message.runId,
      {
        kind: message.environmentKind,
        label: message.environmentLabel,
        hostname: message.environmentHostname,
      },
      message.scanMode,
      {
        continueWithLogin: message.continueWithLogin,
        entityCredentialId: message.entityCredentialId,
        loginUrl: message.loginUrl,
      }
    ).finally(() => {
      scanStarting = false;
    });
    sendResponse({ ok: true });
  } else if (message.type === 'PAUSE_SCAN') {
    LOG('PAUSE_SCAN — pausing at next checkpoint');
    scanState.isPaused = true;
    scanState.isRunning = true;
    scanState.phase = 'paused';
    pauseController.setPaused(true);
    addEvent('paused', 'Scan paused');
    void flushAll().then(() => {
      sendResponse({ ok: true, data: { ...scanState } });
    });
    return true;
  } else if (message.type === 'RESUME_SCAN') {
    LOG('RESUME_SCAN — resuming scan');
    void resumePausedScan()
      .then(() => {
        sendResponse({ ok: true, data: { ...scanState } });
      })
      .catch(error => {
        const message =
          error instanceof Error ? error.message : 'Failed to resume scan';
        ERR('RESUME_SCAN failed', error);
        sendResponse({ ok: false, error: message });
      });
    return true;
  } else if (message.type === 'STOP_SCAN') {
    LOG('STOP_SCAN — aborting scan');
    scanAbortController?.abort();
    pauseController.setPaused(false);
    scanState.isPaused = false;
    // Let runTestRun() handle the stopped status via API.
    // We still set local state for the extension UI:
    scanState.isRunning = false;
    scanState.isComplete = true;
    scanState.phase = 'stopped';
    // Do NOT stop keepalive yet: the in-flight runTestRun() still has to call
    // /scan/end for server-side closeout after the abort propagates. Killing
    // keepalive now lets the MV3 service worker suspend mid-closeout. The
    // detached run is tracked by activeRunPromise, and runScanSession()'s
    // finally stops keepalive once it settles — so we hand off to that. Only
    // stop now if nothing is in flight (otherwise the worker is pinned forever).
    if (activeRunPromise) {
      // .catch swallows a rejected run: finally() re-raises the original
      // rejection, which would otherwise be an unhandled promise rejection here
      // (the run's own handling already reported the error).
      void activeRunPromise.finally(() => stopKeepalive()).catch(() => {});
    } else {
      stopKeepalive();
    }
    addEvent('stopped', 'Scan stopped by user');
    void flushAll().then(() => {
      sendResponse({ ok: true });
    });
    return true;
  } else if (message.type === 'GET_STATUS') {
    sendResponse({ ...scanState });
  } else if (message.type === 'GET_DEBUG_LOG') {
    sendResponse({ ok: true, log: logBuffer });
  } else if (message.type === 'SET_AUTH_TOKEN') {
    chrome.storage.session.set({ firebaseToken: message.token || null });
    sendResponse({ ok: true });
  } else if (
    message.type === 'START_SCENARIO' &&
    message.scenarioId &&
    message.runnerId
  ) {
    LOG(
      `START_SCENARIO: scenarioId=${message.scenarioId}, runnerId=${message.runnerId}`
    );
    void runScenario(
      message.scenarioId,
      message.runnerId,
      message.startingPath ?? '/',
      message.testEnvironmentId
    );
    sendResponse({ ok: true });
  } else if (message.type === 'SAVE_CONFIG') {
    LOG(
      `SAVE_CONFIG: apiUrl=${message.apiUrl}, hasApiKey=${!!message.apiKey}, clickWaitMs=${message.clickWaitMs}`
    );
    const newClickWaitMs =
      message.clickWaitMs != null ? Number(message.clickWaitMs) : clickWaitMs;
    chrome.storage.local.set({
      apiUrl: message.apiUrl || apiUrl,
      apiKey: message.apiKey || apiKey,
      clickWaitMs: newClickWaitMs,
    });
    apiUrl = message.apiUrl || apiUrl;
    apiKey = message.apiKey || apiKey;
    clickWaitMs = newClickWaitMs;
    sendResponse({ ok: true });
  }
  return true;
});

// ---------------------------------------------------------------------------
// Service worker keepalive
// ---------------------------------------------------------------------------
// Chrome MV3 terminates idle service workers after ~30s and enforces a 5-min
// hard limit.  During an active scan the worker must stay alive.  We use
// chrome.alarms (minimum 30s interval) to periodically nudge the worker and
// extend its lifetime.

const KEEPALIVE_ALARM = 'testomniac-keepalive';

function startKeepalive() {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  LOG('Keepalive alarm started');
}

function stopKeepalive() {
  chrome.alarms.clear(KEEPALIVE_ALARM);
  LOG('Keepalive alarm stopped');
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === KEEPALIVE_ALARM) {
    if (scanState.isRunning) {
      LOG('Keepalive tick — scan active');
    } else {
      stopKeepalive();
    }
  }
});

// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener(async tab => {
  LOG('Extension icon clicked, opening side panel for tab', tab.id);
  if (tab.id) {
    await chrome.sidePanel.open({ tabId: tab.id });
  }
});

// Load config and restore persisted scan state on startup.
// If the service worker was killed mid-scan, auto-resume.
void Promise.all([
  loadConfig(),
  restoreScanState(),
  ensureExtensionInstanceId(),
]).then(() => {
  if (
    (scanState.isRunning || scanState.isPaused) &&
    !scanState.isComplete &&
    scanState.scanId &&
    scanState.targetUrl &&
    !activeRunPromise
  ) {
    LOG('Service worker restarted with active scan — auto-resuming', {
      scanId: scanState.scanId,
      targetUrl: scanState.targetUrl,
      phase: scanState.phase,
    });
    activeRunPromise = runScanSession(scanState.targetUrl, scanState.scanId, {
      environment: {
        kind: scanState.environmentKind ?? undefined,
        label: scanState.environmentLabel ?? undefined,
        hostname: scanState.environmentHostname ?? undefined,
      },
      scanMode: scanState.scanMode ?? undefined,
      resumeExisting: true,
    });
  }
});
