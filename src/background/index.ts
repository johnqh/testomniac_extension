/**
 * Background Service Worker
 *
 * Orchestrates scanning using ChromeAdapter + shared scanning lib.
 * Sends progress updates to the side panel via chrome.runtime.sendMessage.
 */

import { ChromeAdapter } from '../adapters/ChromeAdapter';
import {
  ApiClient,
  SCREENSHOT_QUALITY,
  HOVER_DELAY_MS,
  POST_ACTION_SETTLE_MS,
} from '@sudobility/testomniac_scanning_service';
import type { ActionableItem, PageHashes } from '@sudobility/testomniac_types';

console.log('[Testomniac] Background service worker starting...');

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
    .sendMessage({
      type: 'SCAN_PROGRESS',
      data: { ...scanState },
    })
    .catch(() => {
      // Side panel may not be open
    });
}

// Load config from storage
async function loadConfig() {
  const stored = await chrome.storage.local.get(['apiUrl', 'apiKey']);
  if (stored.apiUrl) apiUrl = stored.apiUrl as string;
  if (stored.apiKey) apiKey = stored.apiKey as string;
}

// ============================================================================
// Hashing (browser-compatible using SubtleCrypto)
// ============================================================================

async function sha256(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function normalizeHtml(html: string): string {
  return html
    .replace(/\s+/g, ' ')
    .replace(/\s*=\s*/g, '=')
    .replace(/<(\w+)\s+([^>]*)>/g, (_, tag, attrs) => {
      const sorted = attrs.trim().split(/\s+/).sort().join(' ');
      return `<${tag} ${sorted}>`;
    })
    .replace(/>\s+/g, '>')
    .replace(/\s+</g, '<')
    .trim();
}

function extractVisibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function computeHashes(
  html: string,
  actionableItems: ActionableItem[]
): Promise<PageHashes> {
  const normalized = normalizeHtml(html);
  const visibleText = extractVisibleText(html);
  const visibleKeys = actionableItems
    .filter(i => i.visible)
    .map(i => i.stableKey)
    .sort()
    .join('|');

  return {
    htmlHash: await sha256(html),
    normalizedHtmlHash: await sha256(normalized),
    textHash: await sha256(visibleText),
    actionableHash: await sha256(visibleKeys),
  };
}

// ============================================================================
// Scanning Logic
// ============================================================================

async function extractActionableItems(
  adapter: ChromeAdapter
): Promise<ActionableItem[]> {
  // Run element extraction in the page context via the adapter
  const rawItems = await adapter.evaluate(() => {
    const SELECTORS =
      'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"]';

    function bestSelector(el: Element): string {
      if (el.id) return '#' + el.id;
      const testid = el.getAttribute('data-testid');
      if (testid) return `[data-testid="${testid}"]`;
      const name = el.getAttribute('name');
      if (name) return `[name="${name}"]`;
      return el.tagName.toLowerCase();
    }

    function isVisible(el: Element): boolean {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden';
    }

    const elements: unknown[] = [];
    document.querySelectorAll(SELECTORS).forEach(el => {
      const tag = el.tagName;
      const role = el.getAttribute('role') || '';
      const ariaLabel = el.getAttribute('aria-label') || '';
      const text = el.textContent?.trim().slice(0, 80) || '';
      const name = ariaLabel || text;
      const rect = el.getBoundingClientRect();
      const href = el.getAttribute('href') || undefined;
      const inputType = (el as HTMLInputElement).type || undefined;
      const selector = bestSelector(el);

      elements.push({
        stableKey: '',
        selector,
        tagName: tag,
        role: role || undefined,
        inputType,
        actionKind: '',
        accessibleName: name || undefined,
        textContent: text || undefined,
        href,
        disabled: (el as HTMLButtonElement).disabled || false,
        visible: isVisible(el),
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        attributes: {},
      });
    });
    return elements;
  });

  // Compute stable keys and action kinds on the extension side
  const items = (rawItems as Record<string, unknown>[]) || [];
  return items.map(item => ({
    ...(item as unknown as ActionableItem),
    stableKey:
      `${item.tagName}|${item.role || ''}|${item.accessibleName || ''}|${item.selector}`.slice(
        0,
        32
      ),
    actionKind: classifyActionKind(
      item.tagName as string,
      item.inputType as string | undefined,
      item.href as string | undefined
    ),
  }));
}

function classifyActionKind(
  tagName: string,
  inputType?: string,
  href?: string
): ActionableItem['actionKind'] {
  if (tagName === 'A' && href) return 'navigate';
  if (tagName === 'INPUT' && ['checkbox', 'radio'].includes(inputType || ''))
    return 'toggle';
  if (tagName === 'SELECT') return 'select';
  if (tagName === 'INPUT' || tagName === 'TEXTAREA') return 'fill';
  return 'click';
}

async function runScan(url: string) {
  await loadConfig();

  if (!apiKey) {
    chrome.runtime.sendMessage({
      type: 'SCAN_ERROR',
      error: 'API key not configured. Set it in extension settings.',
    });
    return;
  }

  resetState();
  scanState.isRunning = true;
  scanState.phase = 'mouse_scanning';
  addEvent('scan_started', `Scanning ${url}`);

  const api = new ApiClient(apiUrl, apiKey);

  try {
    // Try to get a pending run from the API, or report an error
    const pendingRun = await api.getPendingRun();
    if (!pendingRun) {
      throw new Error(
        'No pending run found. Create a run from the Testomniac web app first.'
      );
    }

    const runId = pendingRun.id;
    const appId = pendingRun.appId;
    scanState.runId = runId;
    scanState.appId = appId;
    addEvent('run_found', `Run #${runId} (app #${appId})`);

    // Update run phase
    await api.updateRunPhase(runId, 'mouse_scanning');

    // Create a new tab for scanning
    const tab = await chrome.tabs.create({ url, active: true });
    if (!tab.id) throw new Error('Failed to create tab');

    const adapter = new ChromeAdapter(tab.id);

    // Wait for initial page load
    await adapter.waitForNavigation({ timeout: 30000 });
    await new Promise(r => setTimeout(r, 1000)); // Extra settle time

    scanState.currentPageUrl = url;
    addEvent('navigate', url);

    // Create initial page
    const page = await api.findOrCreatePage(appId, adapter.url());
    scanState.pagesFound++;
    addEvent('page_discovered', adapter.url());

    // Extract elements
    const items = await extractActionableItems(adapter);
    const html = await adapter.content();
    const hashes = await computeHashes(html, items);

    // Take screenshot
    const screenshotData = await adapter.screenshot({
      type: 'jpeg',
      quality: SCREENSHOT_QUALITY,
    });
    const screenshotBase64 = btoa(String.fromCharCode(...screenshotData));
    scanState.latestScreenshotDataUrl = `data:image/jpeg;base64,${screenshotBase64}`;

    // Create page state
    const pageState = await api.createPageState({
      pageId: page.id,
      sizeClass: 'desktop',
      hashes,
      screenshotPath: '',
      contentText: await adapter.evaluate(() => document.body.innerText || ''),
    });
    scanState.pageStatesFound++;

    // Insert actionable items
    await api.insertActionableItems(pageState.id, items);
    addEvent('state_captured', `${items.length} elements found`);

    // Process visible, clickable items
    const clickableItems = items.filter(
      i => i.visible && !i.disabled && i.actionKind !== 'fill'
    );

    for (
      let idx = 0;
      idx < clickableItems.length && scanState.isRunning;
      idx++
    ) {
      const item = clickableItems[idx];
      if (!item.selector) continue;

      // Mouseover
      try {
        addEvent('mouseover', item.selector);
        await adapter.hover(item.selector, { timeout: 3000 });
        await new Promise(r => setTimeout(r, HOVER_DELAY_MS));
      } catch {
        addEvent('warning', `Could not hover ${item.selector}`);
        continue;
      }

      // Record action
      await api.createAction({
        runId,
        type: 'mouseover',
        actionableItemId: undefined,
        startingPageStateId: pageState.id,
        sizeClass: 'desktop',
      });
      scanState.actionsCompleted++;

      // Click
      try {
        const beforeUrl = adapter.url();
        addEvent('click', item.selector);
        await adapter.click(item.selector, { timeout: 3000 });
        await new Promise(r => setTimeout(r, POST_ACTION_SETTLE_MS));

        const afterUrl = adapter.url();
        scanState.currentPageUrl = afterUrl;

        // Check for cross-origin navigation
        if (new URL(afterUrl).origin !== new URL(url).origin) {
          addEvent('cross_origin', `Navigated to ${afterUrl}, going back`);
          await adapter.goto(url, { timeout: 30000 });
          continue;
        }

        // Check if URL changed (new page discovered)
        if (afterUrl !== beforeUrl) {
          scanState.pagesFound++;
          addEvent('page_discovered', afterUrl);
          await api.findOrCreatePage(appId, afterUrl);
        }

        // Take screenshot after click
        const newScreenshot = await adapter.screenshot({
          type: 'jpeg',
          quality: SCREENSHOT_QUALITY,
        });
        const newBase64 = btoa(String.fromCharCode(...newScreenshot));
        scanState.latestScreenshotDataUrl = `data:image/jpeg;base64,${newBase64}`;

        await api.createAction({
          runId,
          type: 'click',
          startingPageStateId: pageState.id,
          sizeClass: 'desktop',
        });
        scanState.actionsCompleted++;
      } catch {
        addEvent('warning', `Could not click ${item.selector}`);
      }

      // Update run stats periodically
      if (idx % 5 === 0) {
        await api.updateRunStats(runId, {
          pagesFound: scanState.pagesFound,
          pageStatesFound: scanState.pageStatesFound,
          actionsCompleted: scanState.actionsCompleted,
        });
      }

      sendProgressToSidePanel();
    }

    // Mark run as completed
    scanState.phase = 'completed';
    scanState.isComplete = true;
    await api.completeRun(runId);
    addEvent(
      'run_completed',
      `Completed with ${scanState.actionsCompleted} actions`
    );
  } catch (err: unknown) {
    scanState.phase = 'failed';
    scanState.isComplete = true;
    const message = err instanceof Error ? err.message : 'Scan failed';
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
  if (message.type === 'START_SCAN' && message.url) {
    runScan(message.url);
    sendResponse({ ok: true });
  } else if (message.type === 'STOP_SCAN') {
    scanState.isRunning = false;
    scanState.isComplete = true;
    scanState.phase = 'stopped';
    addEvent('stopped', 'Scan stopped by user');
    sendResponse({ ok: true });
  } else if (message.type === 'GET_STATUS') {
    sendResponse({ ...scanState });
  } else if (message.type === 'SAVE_CONFIG') {
    chrome.storage.local.set({
      apiUrl: message.apiUrl || apiUrl,
      apiKey: message.apiKey || apiKey,
    });
    apiUrl = message.apiUrl || apiUrl;
    apiKey = message.apiKey || apiKey;
    sendResponse({ ok: true });
  }
  return true; // Keep message channel open for async
});

// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener(async tab => {
  if (tab.id) {
    await chrome.sidePanel.open({ tabId: tab.id });
  }
});

// Load config on startup
loadConfig();
