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
  createDefaultExpertises,
  type ScanEventHandler,
} from '@sudobility/testomniac_runner_service';

const LOG = (...args: unknown[]) => console.log('[Testomniac]', ...args);
const ERR = (...args: unknown[]) => console.error('[Testomniac]', ...args);

LOG('Background service worker starting...');

// Config — defaults from build-time env, overridable via chrome.storage.local
const DEFAULT_API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8027';
const DEFAULT_API_KEY = import.meta.env.VITE_SCANNER_API_KEY || '';
let apiUrl = DEFAULT_API_URL;
let apiKey = DEFAULT_API_KEY;

interface ScanState {
  isRunning: boolean;
  scanId: number | null;
  runnerId: number | null;
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
  scanId: null,
  runnerId: null,
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
    });
  } catch (error) {
    ERR('Failed to restore scan state', error);
  }
}

function resetState() {
  scanState = {
    isRunning: false,
    scanId: null,
    runnerId: null,
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

// ============================================================================
// Scan Orchestration — delegates to shared runTestRun()
// ============================================================================

let scanAbortController: AbortController | null = null;

async function startScan(
  url: string,
  runId: number,
  environment?: {
    kind?: 'local' | 'shared';
    label?: string;
    hostname?: string;
  }
) {
  // Cancel any previous scan
  scanAbortController?.abort();
  scanAbortController = new AbortController();
  LOG(`========== STARTING SCAN ==========`);
  LOG(`URL: ${url}, Run ID: ${runId}`);
  await loadConfig();

  resetState();
  scanState.isRunning = true;
  scanState.phase = 'scanning';
  scanState.scanId = runId;
  scanState.environmentKind = environment?.kind ?? null;
  scanState.environmentLabel = environment?.label ?? null;
  scanState.environmentHostname = environment?.hostname ?? null;
  addEvent(
    'scan_started',
    `Scanning ${url}${environment?.label ? ` [${environment.label}]` : ''}`
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
    // Get runner info from this specific run
    LOG(`Fetching run ${runId} from API...`);
    const run = await api.getTestRun(runId);
    LOG(`getTestRun result:`, run);
    if (!run) {
      throw new Error(`Run ${runId} not found`);
    }
    scanState.runnerId = run.runnerId;
    const runnerId = run.runnerId;
    LOG(`Runner ID: ${runnerId}`);

    // Get or create a tab
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

    // Navigate to target URL if needed
    if (activeTab.url !== url) {
      LOG(`Navigating to ${url}...`);
      await adapter.goto(url, { timeout: 30000 });
      LOG('Navigation complete');
    } else {
      LOG('Already on target URL');
    }
    LOG('Waiting 1s for page to settle...');
    await new Promise(r => setTimeout(r, 1000));

    // Build ScanEventHandler that bridges to side panel
    const eventHandler: ScanEventHandler = {
      onPageFound(page) {
        LOG(`[event] pageFound: ${page.relativePath} (id=${page.pageId})`);
        scanState.phase = 'scanning';
        scanState.currentPageUrl = page.relativePath;
        addEvent('page_discovered', page.relativePath);
      },
      onPageStateCreated(state) {
        LOG(
          `[event] pageStateCreated: id=${state.pageStateId} pageId=${state.pageId}`
        );
        scanState.phase = 'scanning';
        addEvent('state_captured', 'Page state captured');
      },
      onTestSuiteCreated(suite) {
        LOG(
          `[event] testSuiteCreated: suiteId=${suite.suiteId} title=${suite.title}`
        );
        scanState.phase = 'testing';
        addEvent('test_suite_created', suite.title);
      },
      onTestCaseRunCompleted(run) {
        LOG(
          `[event] testCaseRunCompleted: testCaseRunId=${run.testCaseRunId} passed=${run.passed}`
        );
        scanState.phase = 'testing';
        addEvent(
          run.passed ? 'test_case_passed' : 'test_case_failed',
          `Test case run ${run.testCaseRunId}`
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
        addEvent('finding', `${finding.type}: ${finding.title}`);
      },
      onStatsUpdated(stats) {
        LOG(
          `[event] statsUpdated: pages=${stats.pagesFound} states=${stats.pageStatesFound} testRuns=${stats.testRunsCompleted} findings=${stats.findingsFound}`
        );
        scanState.pagesFound = stats.pagesFound;
        scanState.pageStatesFound = stats.pageStatesFound;
        scanState.testRunsCompleted = stats.testRunsCompleted;
        scanState.findingsFound = stats.findingsFound;
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
        scanState.phase = 'failed';
        addEvent('error', error.message);
      },
    };

    // Call the shared orchestrator
    const expertises = createDefaultExpertises();
    LOG(
      `Calling runTestRun(adapter, {testRunId=${runId}, runnerId=${runnerId}, baseUrl=${new URL(url).origin}}, api, expertises, eventHandler)`
    );
    const result = await runTestRun(
      adapter,
      {
        testRunId: runId,
        runnerId,
        testEnvironmentId: run.testEnvironmentId ?? undefined,
        baseUrl: new URL(url).origin,
        sizeClass: 'desktop',
        runnerInstanceId: crypto.randomUUID(),
        runnerInstanceName: 'chrome-extension',
        signal: scanAbortController?.signal,
      },
      api,
      expertises,
      eventHandler
    );
    LOG(`runTestRun returned:`, result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Scan failed';
    ERR('SCAN FAILED:', err);
    scanState.phase = 'failed';
    scanState.isComplete = true;
    addEvent('error', message);
    chrome.runtime.sendMessage({ type: 'SCAN_ERROR', error: message });
  } finally {
    scanState.isRunning = false;
    sendProgressToSidePanel();
    LOG('Scan finished, isRunning=false');
  }
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
    startScan(message.url, message.runId, {
      kind: message.environmentKind,
      label: message.environmentLabel,
      hostname: message.environmentHostname,
    });
    sendResponse({ ok: true });
  } else if (message.type === 'STOP_SCAN') {
    LOG('STOP_SCAN — aborting scan');
    scanAbortController?.abort();
    scanState.isRunning = false;
    scanState.isComplete = true;
    scanState.phase = 'stopped';
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
void Promise.all([loadConfig(), restoreScanState()]);
