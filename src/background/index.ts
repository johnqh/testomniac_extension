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

const LOG = (...args: unknown[]) => console.log('[Testomniac]', ...args);
const ERR = (...args: unknown[]) => console.error('[Testomniac]', ...args);

LOG('Background service worker starting...');

// Config — defaults from build-time env, overridable via chrome.storage.local
const DEFAULT_API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8027';
const DEFAULT_API_KEY = import.meta.env.VITE_SCANNER_API_KEY || '';
let apiUrl = DEFAULT_API_URL;
let apiKey = DEFAULT_API_KEY;
const REQUIRED_EXPERTISE_SLUG = 'tester';

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
  latestScreenshotDataUrl: string | null;
  aiSummary: string | null;
  expertiseSummary: Record<
    string,
    {
      warnings: number;
      errors: number;
    }
  > | null;
  events: Array<{ type: string; message: string; timestamp: number }>;
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
  latestScreenshotDataUrl: null,
  aiSummary: null,
  expertiseSummary: null,
  events: [],
  isComplete: false,
};

const SCAN_STATE_STORAGE_KEY = 'scanState';
const EXTENSION_INSTANCE_ID_STORAGE_KEY = 'extensionInstanceId';
let extensionInstanceId: string | null = null;
let activeRunPromise: Promise<void> | null = null;

function getSerializableScanState(): ScanState {
  return { ...scanState, events: [...scanState.events] };
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
    latestScreenshotDataUrl: null,
    aiSummary: null,
    expertiseSummary: null,
    events: [],
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

function addEvent(type: string, message: string) {
  LOG(`[event] ${type}: ${message}`);
  scanState.events.push({ type, message, timestamp: Date.now() });
  if (scanState.events.length > 100) scanState.events.shift();
  sendProgressToSidePanel();
}

function sendProgressToSidePanel() {
  void persistScanState();
  chrome.runtime
    .sendMessage({ type: 'SCAN_PROGRESS', data: { ...scanState } })
    .catch(() => {});
}

async function loadConfig() {
  LOG('Loading config from chrome.storage.local...');
  const stored = await chrome.storage.local.get(['apiUrl', 'apiKey']);
  if (stored.apiUrl) apiUrl = stored.apiUrl as string;
  if (stored.apiKey) apiKey = stored.apiKey as string;
  LOG(`Config loaded: apiUrl=${apiUrl}, hasApiKey=${!!apiKey}`);
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
  }
) {
  const environment = options?.environment;
  const resumeExisting = options?.resumeExisting ?? false;
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
  scanState.runnerInstanceId = runnerInstanceId;
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
  const api = apiKey ? new ApiClient(apiUrl, apiKey) : null;

  if (!api) {
    ERR('No API key configured — cannot scan');
    addEvent('error', 'No API key configured');
    scanState.phase = 'failed';
    scanState.isComplete = true;
    scanState.isRunning = false;
    sendProgressToSidePanel();
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
    LOG('Waiting 1s for page to settle...');
    await new Promise(r => setTimeout(r, 1000));

    const eventHandler: ScanEventHandler = {
      onPageFound(page) {
        LOG(`[event] pageFound: ${page.relativePath} (id=${page.pageId})`);
        scanState.phase = scanState.isPaused ? 'paused' : 'scanning';
        scanState.currentPageUrl = page.relativePath;
        addEvent('page_discovered', page.relativePath);
      },
      onPageStateCreated(state) {
        LOG(
          `[event] pageStateCreated: id=${state.pageStateId} pageId=${state.pageId}`
        );
        scanState.phase = scanState.isPaused ? 'paused' : 'scanning';
        addEvent('state_captured', 'Page state captured');
      },
      onTestSurfaceCreated(surface) {
        LOG(
          `[event] testSurfaceCreated: surfaceId=${surface.surfaceId} title=${surface.title}`
        );
        scanState.phase = scanState.isPaused ? 'paused' : 'scanning';
        addEvent('test_surface_created', surface.title);
      },
      onTestElementRunCompleted(run) {
        LOG(
          `[event] testElementRunCompleted: testElementRunId=${run.testElementRunId} passed=${run.passed}`
        );
        scanState.phase = scanState.isPaused ? 'paused' : 'scanning';
        addEvent(
          run.passed ? 'test_element_passed' : 'test_element_failed',
          `Test case run ${run.testElementRunId}`
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
          addEvent('finding', `${finding.type}: ${finding.title}`);
        }
      },
      onStatsUpdated(stats) {
        LOG(
          `[event] statsUpdated: pages=${stats.pagesFound} states=${stats.pageStatesFound} testRuns=${stats.testRunsCompleted} findings=${stats.findingsFound}`
        );
        scanState.pagesFound = stats.pagesFound;
        scanState.pageStatesFound = stats.pageStatesFound;
        scanState.testRunsCompleted = stats.testRunsCompleted;
        sendProgressToSidePanel();
      },
      onScreenshotCaptured(data) {
        LOG(`[event] screenshotCaptured: ${data.pageUrl}`);
        scanState.latestScreenshotDataUrl = data.dataUrl;
        scanState.currentPageUrl = data.pageUrl;
        sendProgressToSidePanel();
      },
      onScanComplete(summary: ScanCompleteSummary) {
        LOG(
          `[event] scanComplete: pages=${summary.totalPages} findings=${summary.totalFindings} duration=${summary.durationMs}ms`
        );
        scanState.isComplete = true;
        scanState.phase = 'completed';
        scanState.aiSummary = summary.aiSummary ?? null;
        scanState.expertiseSummary = summary.expertiseSummary ?? null;
        addEvent(
          'run_completed',
          `Completed: ${summary.totalPages} pages, ${summary.totalFindings} findings`
        );
      },
      onError(error) {
        ERR(`[event] scanError: ${error.message}`);
        if (scanAbortController?.signal.aborted) return;
        scanState.phase = scanState.isPaused ? 'paused' : 'failed';
        addEvent('error', error.message);
      },
    };

    const runExpertiseSlugs =
      (run as { expertiseSlugsJson?: string[] | null }).expertiseSlugsJson ??
      undefined;
    const expertises = createExpertises(runExpertiseSlugs);
    LOG(
      `Calling runTestRun(adapter, {testRunId=${runId}, runnerId=${runnerId}, baseUrl=${new URL(url).origin}}, api, expertises=${expertises.map(expertise => expertise.name).join(',')}, eventHandler)`
    );
    const result = await runTestRun(
      adapter,
      {
        testRunId: runId,
        runnerId,
        testEnvironmentId: run.testEnvironmentId ?? undefined,
        baseUrl: new URL(url).origin,
        sizeClass: 'desktop',
        runnerInstanceId,
        runnerInstanceName,
        signal: scanAbortController?.signal,
        waitForCheckpoint: async () => {
          if (!scanState.isPaused) return;
          scanState.phase = 'paused';
          sendProgressToSidePanel();
          await pauseController.waitIfPaused(scanAbortController?.signal);
          scanState.phase = 'scanning';
          sendProgressToSidePanel();
        },
      },
      api,
      expertises,
      eventHandler
    );
    LOG(`runTestRun returned:`, result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Scan failed';
    if (err instanceof Error && err.name === 'AbortError') {
      LOG('Scan aborted');
      return;
    }
    ERR('SCAN FAILED:', err);
    scanState.phase = 'failed';
    scanState.isComplete = true;
    addEvent('error', message);
    chrome.runtime.sendMessage({ type: 'SCAN_ERROR', error: message });
  } finally {
    activeRunPromise = null;
    if (!scanState.isPaused) {
      scanState.isRunning = false;
    }
    sendProgressToSidePanel();
    LOG('Scan finished, isRunning=', scanState.isRunning);
  }
}

async function startScan(
  url: string,
  runId: number,
  environment?: {
    kind?: 'local' | 'shared';
    label?: string;
    hostname?: string;
  }
) {
  activeRunPromise = runScanSession(url, runId, { environment });
  await activeRunPromise;
}

async function resumePausedScan() {
  if (!scanState.scanId) {
    throw new Error('No paused scan to resume');
  }

  pauseController.setPaused(false);
  scanState.isPaused = false;
  scanState.phase = 'scanning';
  sendProgressToSidePanel();

  if (activeRunPromise) {
    return;
  }

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
    resumeExisting: true,
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
    LOG(`START_SCAN: url=${message.url}, runId=${message.runId}`);
    void startScan(message.url, message.runId, {
      kind: message.environmentKind,
      label: message.environmentLabel,
      hostname: message.environmentHostname,
    });
    sendResponse({ ok: true });
  } else if (message.type === 'PAUSE_SCAN') {
    LOG('PAUSE_SCAN — pausing at next checkpoint');
    scanState.isPaused = true;
    scanState.isRunning = true;
    scanState.phase = 'paused';
    pauseController.setPaused(true);
    addEvent('paused', 'Scan paused');
    sendResponse({ ok: true, data: { ...scanState } });
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
    scanState.isRunning = false;
    scanState.isComplete = true;
    scanState.phase = 'stopped';
    activeRunPromise = null;
    addEvent('stopped', 'Scan stopped by user');
    sendResponse({ ok: true });
  } else if (message.type === 'GET_STATUS') {
    sendResponse({ ...scanState });
  } else if (message.type === 'SET_AUTH_TOKEN') {
    chrome.storage.session.set({ firebaseToken: message.token || null });
    sendResponse({ ok: true });
  } else if (message.type === 'SAVE_CONFIG') {
    LOG(`SAVE_CONFIG: apiUrl=${message.apiUrl}, hasApiKey=${!!message.apiKey}`);
    chrome.storage.local.set({
      apiUrl: message.apiUrl || apiUrl,
      apiKey: message.apiKey || apiKey,
    });
    apiUrl = message.apiUrl || apiUrl;
    apiKey = message.apiKey || apiKey;
    sendResponse({ ok: true });
  }
  return true;
});

// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener(async tab => {
  LOG('Extension icon clicked, opening side panel for tab', tab.id);
  if (tab.id) {
    await chrome.sidePanel.open({ tabId: tab.id });
  }
});

// Load config and restore persisted scan state on startup
void Promise.all([
  loadConfig(),
  restoreScanState(),
  ensureExtensionInstanceId(),
]);
