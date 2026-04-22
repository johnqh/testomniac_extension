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
const ERR = (...args: unknown[]) => console.error('[Testomniac]', ...args);

LOG('Background service worker starting...');

// Config — defaults from build-time env, overridable via chrome.storage.local
const DEFAULT_API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8027';
const DEFAULT_API_KEY = import.meta.env.VITE_SCANNER_API_KEY || '';
let apiUrl = DEFAULT_API_URL;
let apiKey = DEFAULT_API_KEY;

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
  LOG(`[event] ${type}: ${message}`);
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
  LOG('Loading config from chrome.storage.local...');
  const stored = await chrome.storage.local.get(['apiUrl', 'apiKey']);
  if (stored.apiUrl) apiUrl = stored.apiUrl as string;
  if (stored.apiKey) apiKey = stored.apiKey as string;
  LOG(`Config loaded: apiUrl=${apiUrl}, hasApiKey=${!!apiKey}`);
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
    // Get app info from this specific run
    LOG(`Fetching run ${runId} from API...`);
    const run = await api.getRun(runId);
    LOG(`getRun result:`, run);
    if (!run) {
      throw new Error(`Run ${runId} not found`);
    }
    scanState.appId = run.appId;
    const appId = run.appId;
    LOG(`App ID: ${appId}`);

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
        LOG(`[event] pageFound: ${page.url} (id=${page.pageId})`);
        scanState.currentPageUrl = page.url;
        addEvent('page_discovered', page.url);
      },
      onPageStateCreated(state) {
        LOG(
          `[event] pageStateCreated: id=${state.pageStateId} pageId=${state.pageId}`
        );
        addEvent('state_captured', 'Page state captured');
      },
      onActionCompleted(action) {
        LOG(`[event] actionCompleted: ${action.type} ${action.selector || ''}`);
        addEvent(action.type, action.selector || action.pageUrl);
      },
      onIssueDetected(issue) {
        LOG(`[event] issueDetected: ${issue.type}: ${issue.description}`);
        addEvent('bug', `${issue.type}: ${issue.description}`);
      },
      onPhaseChanged(phase) {
        LOG(`[event] phaseChanged: ${phase}`);
        scanState.phase = phase;
        addEvent('phase', `Phase: ${phase}`);
      },
      onStatsUpdated(stats) {
        LOG(
          `[event] statsUpdated: pages=${stats.pagesFound} states=${stats.pageStatesFound} actions=${stats.actionsCompleted} issues=${stats.issuesFound}`
        );
        scanState.pagesFound = stats.pagesFound;
        scanState.pageStatesFound = stats.pageStatesFound;
        scanState.actionsCompleted = stats.actionsCompleted;
        scanState.issuesFound = stats.issuesFound;
        sendProgressToSidePanel();
      },
      onScreenshotCaptured(data) {
        LOG(`[event] screenshotCaptured: ${data.pageUrl}`);
        scanState.latestScreenshotDataUrl = data.dataUrl;
        scanState.currentPageUrl = data.pageUrl;
        sendProgressToSidePanel();
      },
      onScanComplete(summary) {
        LOG(
          `[event] scanComplete: pages=${summary.totalPages} issues=${summary.totalIssues} duration=${summary.durationMs}ms`
        );
        scanState.isComplete = true;
        scanState.phase = 'completed';
        addEvent(
          'run_completed',
          `Completed: ${summary.totalPages} pages, ${summary.totalIssues} issues`
        );
      },
      onError(error) {
        ERR(`[event] scanError: ${error.message} (phase=${error.phase})`);
        scanState.phase = 'failed';
        addEvent('error', error.message);
      },
    };

    // Call the shared orchestrator
    LOG(
      `Calling runScan(adapter, {runId=${runId}, appId=${appId}, baseUrl=${url}, phases=["mouse_scanning"]}, api, eventHandler)`
    );
    const result = await runScan(
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
    LOG(`runScan returned:`, result);
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

  if (message.type === 'START_SCAN' && message.url && message.runId) {
    LOG(`START_SCAN: url=${message.url}, runId=${message.runId}`);
    startScan(message.url, message.runId);
    sendResponse({ ok: true });
  } else if (message.type === 'STOP_SCAN') {
    LOG('STOP_SCAN');
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

// Load config on startup
loadConfig();
