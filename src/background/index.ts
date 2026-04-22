/**
 * Background Service Worker
 *
 * Thin wrapper that creates a ChromeAdapter and calls the shared
 * runScan() orchestrator from testomniac_scanning_service.
 * Sends progress updates to the side panel via chrome.runtime.sendMessage.
 */

import { ChromeAdapter } from '../adapters/ChromeAdapter';
import {
  ApiClient,
  runScan,
  type ScanEventHandler,
} from '@sudobility/testomniac_scanning_service';

const LOG = (...args: unknown[]) => console.log('[Testomniac]', ...args);

LOG('Background service worker starting...');

// Config — loaded from chrome.storage.local
let apiUrl = 'http://localhost:8027';
let apiKey = '';

interface ScanState {
  isRunning: boolean;
  runId: number | null;
  appId: number | null;
  phase: string;
  pagesFound: number;
  pageStatesFound: number;
  actionsCompleted: number;
  issuesFound: number;
  currentPageUrl: string | null;
  latestScreenshotDataUrl: string | null;
  events: Array<{ type: string; message: string; timestamp: number }>;
  isComplete: boolean;
}

let scanState: ScanState = {
  isRunning: false,
  runId: null,
  appId: null,
  phase: 'idle',
  pagesFound: 0,
  pageStatesFound: 0,
  actionsCompleted: 0,
  issuesFound: 0,
  currentPageUrl: null,
  latestScreenshotDataUrl: null,
  events: [],
  isComplete: false,
};

function resetState() {
  scanState = {
    isRunning: false,
    runId: null,
    appId: null,
    phase: 'idle',
    pagesFound: 0,
    pageStatesFound: 0,
    actionsCompleted: 0,
    issuesFound: 0,
    currentPageUrl: null,
    latestScreenshotDataUrl: null,
    events: [],
    isComplete: false,
  };
}

function addEvent(type: string, message: string) {
  scanState.events.push({ type, message, timestamp: Date.now() });
  if (scanState.events.length > 100) scanState.events.shift();
  sendProgressToSidePanel();
}

function sendProgressToSidePanel() {
  chrome.runtime
    .sendMessage({ type: 'SCAN_PROGRESS', data: { ...scanState } })
    .catch(() => {});
}

async function loadConfig() {
  const stored = await chrome.storage.local.get(['apiUrl', 'apiKey']);
  if (stored.apiUrl) apiUrl = stored.apiUrl as string;
  if (stored.apiKey) apiKey = stored.apiKey as string;
  // Firebase token is read from chrome.storage.session by the side panel directly
}

// ============================================================================
// Scan Orchestration — delegates to shared runScan()
// ============================================================================

async function startScan(url: string, runId: number) {
  LOG(`========== STARTING SCAN ==========`);
  LOG(`URL: ${url}, Run ID: ${runId}`);
  await loadConfig();

  resetState();
  scanState.isRunning = true;
  scanState.phase = 'mouse_scanning';
  scanState.runId = runId;
  addEvent('scan_started', `Scanning ${url}`);

  const api = apiKey ? new ApiClient(apiUrl + '/api/v1/scanner', apiKey) : null;

  if (!api) {
    addEvent('error', 'No API key configured');
    scanState.phase = 'failed';
    scanState.isComplete = true;
    scanState.isRunning = false;
    sendProgressToSidePanel();
    return;
  }

  try {
    // Get app info from the pending run
    const pendingRun = await api.getPendingRun();
    if (pendingRun && pendingRun.id === runId) {
      scanState.appId = pendingRun.appId;
    }
    const appId = scanState.appId;
    if (!appId) {
      throw new Error('Could not determine app ID for this run');
    }

    // Get or create a tab
    let [activeTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    const isWebPage =
      activeTab?.url?.startsWith('http://') ||
      activeTab?.url?.startsWith('https://');
    if (!activeTab?.id || !isWebPage) {
      activeTab = await chrome.tabs.create({ url, active: true });
      if (!activeTab?.id) throw new Error('Failed to create tab');
    }

    const adapter = new ChromeAdapter(activeTab.id);

    // Navigate to target URL if needed
    if (activeTab.url !== url) {
      await adapter.goto(url, { timeout: 30000 });
    }
    await new Promise(r => setTimeout(r, 1000));

    // Build ScanEventHandler that bridges to side panel
    const eventHandler: ScanEventHandler = {
      onPageFound(page) {
        scanState.currentPageUrl = page.url;
        addEvent('page_discovered', page.url);
      },
      onPageStateCreated() {
        addEvent('state_captured', 'Page state captured');
      },
      onActionCompleted(action) {
        addEvent(action.type, action.selector || action.pageUrl);
      },
      onIssueDetected(issue) {
        addEvent('bug', `${issue.type}: ${issue.description}`);
      },
      onPhaseChanged(phase) {
        scanState.phase = phase;
        addEvent('phase', `Phase: ${phase}`);
      },
      onStatsUpdated(stats) {
        scanState.pagesFound = stats.pagesFound;
        scanState.pageStatesFound = stats.pageStatesFound;
        scanState.actionsCompleted = stats.actionsCompleted;
        scanState.issuesFound = stats.issuesFound;
        sendProgressToSidePanel();
      },
      onScreenshotCaptured(data) {
        scanState.latestScreenshotDataUrl = data.dataUrl;
        scanState.currentPageUrl = data.pageUrl;
        sendProgressToSidePanel();
      },
      onScanComplete(summary) {
        scanState.isComplete = true;
        scanState.phase = 'completed';
        addEvent(
          'run_completed',
          `Completed: ${summary.totalPages} pages, ${summary.totalIssues} issues`
        );
      },
      onError(error) {
        scanState.phase = 'failed';
        addEvent('error', error.message);
      },
    };

    // Call the shared orchestrator — this is where all scanning logic now lives
    await runScan(
      adapter,
      {
        runId,
        appId,
        baseUrl: url,
        phases: ['mouse_scanning'],
        sizeClass: 'desktop',
      },
      api,
      eventHandler
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Scan failed';
    LOG('SCAN FAILED:', err);
    scanState.phase = 'failed';
    scanState.isComplete = true;
    addEvent('error', message);
    chrome.runtime.sendMessage({ type: 'SCAN_ERROR', error: message });
  } finally {
    scanState.isRunning = false;
    sendProgressToSidePanel();
  }
}

// ============================================================================
// Message Handlers
// ============================================================================

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'START_SCAN' && message.url && message.runId) {
    startScan(message.url, message.runId);
    sendResponse({ ok: true });
  } else if (message.type === 'STOP_SCAN') {
    scanState.isRunning = false;
    scanState.isComplete = true;
    scanState.phase = 'stopped';
    addEvent('stopped', 'Scan stopped by user');
    sendResponse({ ok: true });
  } else if (message.type === 'GET_STATUS') {
    sendResponse({ ...scanState });
  } else if (message.type === 'SET_AUTH_TOKEN') {
    // Store token in session storage for persistence across service worker restarts
    chrome.storage.session.set({ firebaseToken: message.token || null });
    sendResponse({ ok: true });
  } else if (message.type === 'SAVE_CONFIG') {
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
  if (tab.id) {
    await chrome.sidePanel.open({ tabId: tab.id });
  }
});

// Load config on startup
loadConfig();
