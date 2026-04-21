/**
 * Background Service Worker
 *
 * Orchestrates scanning using ChromeAdapter + shared scanning lib.
 * Sends progress updates to the side panel via chrome.runtime.sendMessage.
 */

import { ChromeAdapter } from '../adapters/ChromeAdapter';
import {
  extractActionableItems,
  getRegisteredExtractorNames,
} from './extractors';
import { fillValuePlanner } from './planners/fillValuePlanner';
import {
  ApiClient,
  SCREENSHOT_QUALITY,
  HOVER_DELAY_MS,
  POST_ACTION_SETTLE_MS,
} from '@sudobility/testomniac_scanning_service';
import type { ActionableItem, PageHashes } from '@sudobility/testomniac_types';

const LOG = (...args: unknown[]) => console.log('[Testomniac]', ...args);
const WARN = (...args: unknown[]) => console.warn('[Testomniac]', ...args);
const ERR = (...args: unknown[]) => console.error('[Testomniac]', ...args);

LOG('Background service worker starting...');

// Config — loaded from chrome.storage.local
let apiUrl = 'http://localhost:8027';
let apiKey = '';
let firebaseToken: string | null = null;

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
  LOG('Resetting scan state');
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
    .sendMessage({
      type: 'SCAN_PROGRESS',
      data: { ...scanState },
    })
    .catch(() => {
      // Side panel may not be open
    });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Load config from storage
async function loadConfig() {
  LOG('Loading config from chrome.storage.local');
  const stored = await chrome.storage.local.get(['apiUrl', 'apiKey']);
  if (stored.apiUrl) apiUrl = stored.apiUrl as string;
  if (stored.apiKey) apiKey = stored.apiKey as string;

  // Load Firebase token from session storage (survives service worker restarts)
  const session = await chrome.storage.session.get(['firebaseToken']);
  if (session.firebaseToken) firebaseToken = session.firebaseToken as string;

  LOG('Config loaded:', {
    apiUrl,
    hasApiKey: !!apiKey,
    hasFirebaseToken: !!firebaseToken,
  });
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
  LOG(
    `Computing hashes (html: ${html.length} chars, items: ${actionableItems.length})`
  );
  const normalized = normalizeHtml(html);
  const visibleText = extractVisibleText(html);
  const visibleKeys = actionableItems
    .filter(i => i.visible)
    .map(i => i.stableKey)
    .sort()
    .join('|');

  const hashes = {
    htmlHash: await sha256(html),
    normalizedHtmlHash: await sha256(normalized),
    textHash: await sha256(visibleText),
    actionableHash: await sha256(visibleKeys),
  };
  LOG('Hashes computed:', {
    htmlHash: hashes.htmlHash.slice(0, 8) + '...',
    actionableHash: hashes.actionableHash.slice(0, 8) + '...',
  });
  return hashes;
}

/** Convert Uint8Array to base64 without stack overflow (no spread operator) */
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ============================================================================
// Scanning Logic
// ============================================================================

// ============================================================================
// Bug Detection Helpers (inline until scanning_service detectors are ready)
// ============================================================================

interface BrokenLinkResult {
  href: string;
  text: string;
  error: string;
}

async function detectBrokenLinks(
  adapter: ChromeAdapter,
  pageUrl: string
): Promise<BrokenLinkResult[]> {
  LOG('Detecting broken links...');
  const origin = new URL(pageUrl).origin;

  // Extract all <a href> elements from the page
  const links = (await adapter.evaluate((...args: unknown[]) => {
    const orig = args[0] as string;
    const anchors = document.querySelectorAll('a[href]');
    const results: Array<{ href: string; text: string }> = [];
    anchors.forEach(a => {
      const href = (a as HTMLAnchorElement).href;
      const text = a.textContent?.trim().slice(0, 80) || '';
      // Filter to same-origin only
      try {
        if (new URL(href).origin === orig) {
          results.push({ href, text });
        }
      } catch {
        // Invalid URL, skip
      }
    });
    return results;
  }, origin)) as Array<{ href: string; text: string }>;

  if (!links || links.length === 0) {
    LOG('No same-origin links found');
    return [];
  }

  LOG(`Checking ${links.length} same-origin links...`);

  // Deduplicate by href
  const uniqueLinks = new Map<string, string>();
  for (const link of links) {
    if (!uniqueLinks.has(link.href)) {
      uniqueLinks.set(link.href, link.text);
    }
  }

  const broken: BrokenLinkResult[] = [];
  for (const [href, text] of uniqueLinks) {
    try {
      const resp = await fetch(href, {
        method: 'HEAD',
        redirect: 'manual',
      });

      // Treat only clear "missing/server failure" responses as broken.
      // Skip auth-gated routes, redirects, and CSP/network-blocked cases.
      if (resp.status === 404 || resp.status === 410 || resp.status >= 500) {
        LOG(`  Broken: ${href} (${resp.status})`);
        broken.push({ href, text, error: `HTTP ${resp.status}` });
      } else if (resp.status >= 300) {
        LOG(`  Skipping redirected/auth-gated link: ${href} (${resp.status})`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'fetch failed';
      LOG(`  Skipping unreachable/CSP-blocked link check: ${href} (${msg})`);
    }
  }

  LOG(`Found ${broken.length} broken links out of ${uniqueLinks.size} unique`);
  return broken;
}

interface VisualIssue {
  type: string;
  description: string;
}

interface MediaIssue {
  type: string;
  description: string;
}

function detectVisualIssues(html: string): VisualIssue[] {
  LOG('Detecting visual issues...');
  const issues: VisualIssue[] = [];

  // 1. Duplicate headings — same h1-h6 text appearing more than once
  const headingRegex = /<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi;
  const headingTexts = new Map<string, number>();
  let headingMatch: RegExpExecArray | null;
  while ((headingMatch = headingRegex.exec(html)) !== null) {
    const text = headingMatch[2]
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    if (text) {
      headingTexts.set(text, (headingTexts.get(text) || 0) + 1);
    }
  }
  for (const [text, count] of headingTexts) {
    if (count > 1) {
      issues.push({
        type: 'duplicate_heading',
        description: `Heading "${text.slice(0, 60)}" appears ${count} times`,
      });
    }
  }

  // 2. Empty links — <a> with no text content
  const linkRegex = /<a\s[^>]*>([\s\S]*?)<\/a>/gi;
  let linkMatch: RegExpExecArray | null;
  let emptyLinkCount = 0;
  while ((linkMatch = linkRegex.exec(html)) !== null) {
    const innerText = linkMatch[1]
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, '')
      .trim();
    // Also check for img alt as acceptable content
    const hasImg = /<img\s[^>]*alt\s*=\s*"[^"]+"/i.test(linkMatch[1]);
    const hasAriaLabel = /aria-label\s*=\s*"[^"]+"/i.test(linkMatch[0]);
    if (!innerText && !hasImg && !hasAriaLabel) {
      emptyLinkCount++;
    }
  }
  if (emptyLinkCount > 0) {
    issues.push({
      type: 'empty_link',
      description: `${emptyLinkCount} link(s) with no accessible text content`,
    });
  }

  // 3. Images with empty/invalid src
  const imgRegex = /<img\s([^>]*)>/gi;
  let imgMatch: RegExpExecArray | null;
  let brokenImgCount = 0;
  while ((imgMatch = imgRegex.exec(html)) !== null) {
    const attrs = imgMatch[1];
    const srcMatch = /src\s*=\s*"([^"]*)"/i.exec(attrs);
    if (
      !srcMatch ||
      !srcMatch[1] ||
      srcMatch[1].trim() === '' ||
      srcMatch[1] === '#'
    ) {
      brokenImgCount++;
    }
  }
  if (brokenImgCount > 0) {
    issues.push({
      type: 'broken_image',
      description: `${brokenImgCount} image(s) with empty or invalid src`,
    });
  }

  // 4. Duplicate element IDs
  const idRegex = /\sid\s*=\s*"([^"]+)"/gi;
  const idCounts = new Map<string, number>();
  let idMatch: RegExpExecArray | null;
  while ((idMatch = idRegex.exec(html)) !== null) {
    const id = idMatch[1];
    idCounts.set(id, (idCounts.get(id) || 0) + 1);
  }
  const duplicateIds: string[] = [];
  for (const [id, count] of idCounts) {
    if (count > 1) {
      duplicateIds.push(id);
    }
  }
  if (duplicateIds.length > 0) {
    issues.push({
      type: 'duplicate_id',
      description: `${duplicateIds.length} duplicate element ID(s): ${duplicateIds.slice(0, 5).join(', ')}${duplicateIds.length > 5 ? '...' : ''}`,
    });
  }

  LOG(`Found ${issues.length} visual issues`);
  return issues;
}

interface ContentIssue {
  type: string;
  description: string;
}

function detectContentIssues(text: string): ContentIssue[] {
  LOG('Detecting content issues...');
  const issues: ContentIssue[] = [];

  // 1. Lorem ipsum / placeholder patterns
  const placeholderPatterns = [
    /lorem ipsum/i,
    /dolor sit amet/i,
    /placeholder text/i,
    /todo[:\s]/i,
    /fixme[:\s]/i,
    /your (?:name|email|text) here/i,
    /example\.com/i,
    /test@test/i,
    /foo\s*bar/i,
  ];
  for (const pattern of placeholderPatterns) {
    if (pattern.test(text)) {
      issues.push({
        type: 'placeholder_text',
        description: `Placeholder text detected: matches "${pattern.source}"`,
      });
      break; // Only report once for placeholder text
    }
  }

  // 2. Error page patterns
  const errorPatterns: Array<{ pattern: RegExp; label: string }> = [
    { pattern: /404\s*(not found|error|page)/i, label: '404 Not Found' },
    { pattern: /500\s*(internal|server|error)/i, label: '500 Server Error' },
    {
      pattern: /503\s*(service|unavailable)/i,
      label: '503 Service Unavailable',
    },
    { pattern: /502\s*(bad gateway)/i, label: '502 Bad Gateway' },
    { pattern: /page\s*not\s*found/i, label: 'Page Not Found' },
    { pattern: /server\s*error/i, label: 'Server Error' },
    { pattern: /internal\s*server\s*error/i, label: 'Internal Server Error' },
    { pattern: /access\s*denied/i, label: 'Access Denied' },
    { pattern: /403\s*forbidden/i, label: '403 Forbidden' },
    { pattern: /something\s*went\s*wrong/i, label: 'Something Went Wrong' },
    { pattern: /an?\s*error\s*(has\s*)?occurred/i, label: 'Error Occurred' },
    { pattern: /application\s*error/i, label: 'Application Error' },
  ];
  for (const { pattern, label } of errorPatterns) {
    if (pattern.test(text)) {
      issues.push({
        type: 'error_page',
        description: `Error page detected: ${label}`,
      });
      break; // Only report the first matching error pattern
    }
  }

  // 3. Empty/blank page (<50 chars)
  if (text.trim().length < 50) {
    issues.push({
      type: 'blank_page',
      description: `Page appears blank or nearly empty (${text.trim().length} characters)`,
    });
  }

  LOG(`Found ${issues.length} content issues`);
  return issues;
}

async function detectMediaIssues(
  adapter: ChromeAdapter
): Promise<MediaIssue[]> {
  LOG('Detecting media issues...');
  const issues = (await adapter.evaluate(() => {
    const results: Array<{ type: string; description: string }> = [];
    const media = document.querySelectorAll('video, audio');

    media.forEach((element, index) => {
      const mediaEl = element as HTMLMediaElement;
      const tag = element.tagName.toLowerCase();
      const hasSource =
        Boolean(mediaEl.getAttribute('src')) ||
        element.querySelector('source[src]') !== null;

      if (!hasSource) {
        results.push({
          type: 'missing_media_source',
          description: `${tag} #${index + 1} has no source`,
        });
        return;
      }

      if (mediaEl.error) {
        results.push({
          type: 'broken_media',
          description: `${tag} #${index + 1} has media error code ${mediaEl.error.code}`,
        });
      } else if (mediaEl.networkState === HTMLMediaElement.NETWORK_NO_SOURCE) {
        results.push({
          type: 'broken_media',
          description: `${tag} #${index + 1} has no playable source`,
        });
      }
    });

    return results;
  })) as MediaIssue[];

  LOG(`Found ${issues.length} media issues`);
  return issues;
}

// ============================================================================
// Modal Detection & Dismissal
// ============================================================================

async function detectAndHandleModal(
  adapter: ChromeAdapter
): Promise<{ found: boolean; content: string | null }> {
  const result = await adapter.evaluate(() => {
    // Look for common modal/popup patterns
    const modalSelectors = [
      '.pum-active .pum-container',
      '.modal.show .modal-content',
      '[role="dialog"][aria-modal="true"]',
      '.modal-overlay.active',
      '.popup.active',
      '.lightbox.active',
      '[data-modal].active',
      '.fancybox-container',
    ];

    for (const sel of modalSelectors) {
      const modal = document.querySelector(sel);
      if (modal && (modal as HTMLElement).offsetWidth > 0) {
        const text = modal.textContent?.trim().slice(0, 500) || '';
        return { found: true, content: text };
      }
    }
    return { found: false, content: null };
  });
  return (
    (result as { found: boolean; content: string | null }) || {
      found: false,
      content: null,
    }
  );
}

async function dismissModal(adapter: ChromeAdapter): Promise<boolean> {
  const dismissed = await adapter.evaluate(() => {
    // Try common close button selectors
    const closeSelectors = [
      '.pum-active .pum-close',
      '.pum-active .popmake-close',
      '.modal.show .close',
      '.modal.show .btn-close',
      '[role="dialog"] [aria-label="Close"]',
      '[role="dialog"] .close-button',
      '.modal-overlay.active .close',
      '.popup.active .close',
      '.fancybox-close',
    ];

    for (const sel of closeSelectors) {
      const btn = document.querySelector(sel) as HTMLElement | null;
      if (btn && btn.offsetWidth > 0) {
        btn.click();
        return true;
      }
    }

    // Try clicking the overlay to dismiss (click-to-close modals)
    const overlay = document.querySelector(
      '.pum-overlay.pum-active.pum-click-to-close'
    ) as HTMLElement | null;
    if (overlay) {
      // Click outside the modal container
      overlay.click();
      return true;
    }

    // Try pressing Escape
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
    return false;
  });

  if (dismissed) {
    // Wait for dismiss animation
    await new Promise(r => setTimeout(r, 500));
  }
  return dismissed as boolean;
}

function normalizeHref(href: string, baseUrl: string): string | null {
  try {
    const url = new URL(href, baseUrl);
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function shouldExpectNavigation(
  item: ActionableItem,
  beforeUrl: string
): boolean {
  if (item.actionKind !== 'navigate' || !item.href) return false;
  const target = normalizeHref(item.href, beforeUrl);
  if (!target) return false;
  return target !== beforeUrl.split('#')[0];
}

function looksLikeSubmitAction(item: ActionableItem): boolean {
  const text =
    `${item.accessibleName || ''} ${item.textContent || ''}`.toLowerCase();
  const inputType = (item.inputType || '').toLowerCase();

  return (
    inputType === 'submit' ||
    text.includes('submit') ||
    text.includes('send') ||
    text.includes('search') ||
    text.includes('book') ||
    text.includes('report') ||
    text.includes('save')
  );
}

function looksLikeEnterCommitField(item: ActionableItem): boolean {
  const text =
    `${item.accessibleName || ''} ${item.textContent || ''}`.toLowerCase();
  const inputType = (item.inputType || '').toLowerCase();
  const role = (item.role || '').toLowerCase();

  return (
    inputType === 'search' ||
    role === 'combobox' ||
    text.includes('search') ||
    text.includes('query')
  );
}

function getActionPriority(item: ActionableItem): number {
  const y = item.y || 0;
  const text =
    `${item.accessibleName || ''} ${item.textContent || ''}`.toLowerCase();
  const href = (item.href || '').toLowerCase();
  if (item.actionKind === 'fill' || item.actionKind === 'select') return 0;
  if (item.actionKind === 'toggle') return 1;
  if (
    href.includes('/store/') ||
    href.includes('ec_action=addtocart') ||
    href.includes('/my-cart/')
  ) {
    return 2;
  }
  if (looksLikeSubmitAction(item)) return 2;
  if (
    text.includes('add to cart') ||
    text.includes('checkout') ||
    text.includes('select options')
  ) {
    return 2;
  }
  if (item.actionKind === 'navigate') return y < 120 ? 6 : 4;
  if (item.actionKind === 'click') return y < 120 ? 4 : 3;
  return 3;
}

async function pickSelectValue(
  adapter: ChromeAdapter,
  selector: string
): Promise<string | null> {
  const value = await adapter.evaluate((...args: unknown[]) => {
    const sel = args[0] as string;
    const element = document.querySelector(sel) as HTMLSelectElement | null;
    if (!element) return null;

    const options = Array.from(element.options);
    const candidate = options.find(option => {
      if (option.disabled) return false;
      const text = option.textContent?.trim().toLowerCase() || '';
      return !(
        text.startsWith('select') ||
        text.startsWith('choose') ||
        text.startsWith('pick')
      );
    });

    if (!candidate) return null;
    if (candidate.value) return candidate.value;
    const index = options.indexOf(candidate);
    return index >= 0 ? `__index__:${index}` : null;
  }, selector);

  return (value as string | null) ?? null;
}

async function pickSelectValues(
  adapter: ChromeAdapter,
  selector: string
): Promise<string[]> {
  const values = await adapter.evaluate((...args: unknown[]) => {
    const sel = args[0] as string;
    const element = document.querySelector(sel) as HTMLSelectElement | null;
    if (!element) return [];

    const options = Array.from(element.options);
    return options
      .map((option, index) => {
        const text = option.textContent?.trim().toLowerCase() || '';
        if (option.disabled) return null;
        if (
          text.startsWith('select') ||
          text.startsWith('choose') ||
          text.startsWith('pick') ||
          text.startsWith('default')
        ) {
          return null;
        }

        if (option.value) return option.value;
        return `__index__:${index}`;
      })
      .filter(Boolean)
      .slice(0, 4);
  }, selector);

  return Array.isArray(values) ? (values as string[]) : [];
}

async function isToggleChecked(
  adapter: ChromeAdapter,
  selector: string
): Promise<boolean> {
  const checked = await adapter.evaluate((...args: unknown[]) => {
    const sel = args[0] as string;
    const element = document.querySelector(sel) as
      | HTMLInputElement
      | HTMLElement
      | null;
    if (!element) return false;
    if ('checked' in element) return Boolean(element.checked);
    return element.getAttribute('aria-checked') === 'true';
  }, selector);

  return Boolean(checked);
}

async function getInputName(
  adapter: ChromeAdapter,
  selector: string
): Promise<string | null> {
  const name = await adapter.evaluate((...args: unknown[]) => {
    const sel = args[0] as string;
    const element = document.querySelector(sel) as HTMLInputElement | null;
    return element?.name || null;
  }, selector);

  return (name as string | null) ?? null;
}

async function runScan(url: string, runId: number) {
  LOG(`========== STARTING SCAN ==========`);
  LOG(`URL: ${url}`);
  LOG(`Run ID: ${runId}`);
  await loadConfig();

  resetState();
  scanState.isRunning = true;
  scanState.phase = 'mouse_scanning';
  scanState.runId = runId;
  addEvent('scan_started', `Scanning ${url}`);

  // Immediately claim the run so the server scanner doesn't pick it up
  const api = apiKey ? new ApiClient(apiUrl + '/api/v1/scanner', apiKey) : null;
  LOG(
    `API client: ${api ? 'initialized' : 'NO API KEY — running without API'}`
  );

  try {
    // Claim the run immediately by setting phase to mouse_scanning
    if (api) {
      LOG('Claiming run via API...');
      await api.updateRunPhase(runId, 'mouse_scanning');
      addEvent('run_claimed', `Run #${runId} claimed by extension`);

      // Get app info from the run
      LOG('Fetching pending run info...');
      const pendingRun = await api.getPendingRun();
      LOG('Pending run:', pendingRun);
      if (pendingRun && pendingRun.id === runId) {
        scanState.appId = pendingRun.appId;
        LOG(`App ID: ${pendingRun.appId}`);
      } else {
        WARN('Run already claimed or not found as pending');
      }
    }

    // Use the ACTIVE tab if it's a regular web page, otherwise create a new one
    LOG('Querying active tab...');
    let [activeTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    LOG('Active tab:', {
      id: activeTab?.id,
      url: activeTab?.url?.slice(0, 60),
      status: activeTab?.status,
    });

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
      LOG(`Navigating from ${activeTab.url?.slice(0, 60)} to ${url}`);
      await adapter.goto(url, { timeout: 30000 });
      LOG('Navigation complete');
    } else {
      LOG('Already on target URL');
    }

    // Wait for page to settle
    LOG('Waiting 1s for page to settle...');
    await new Promise(r => setTimeout(r, 1000));

    // ================================================================
    // Multi-page scan: process each page from a queue so every
    // discovered page gets its own extraction + element loop.
    // ================================================================
    const startOrigin = new URL(url).origin;
    const appId = scanState.appId;
    const pageQueue: string[] = [await adapter.getUrl()];
    const visitedPages = new Set<string>();

    while (pageQueue.length > 0 && scanState.isRunning) {
      const currentPageUrl = pageQueue.shift()!;
      const normalizedCurrentUrl = currentPageUrl.split('#')[0];

      if (visitedPages.has(normalizedCurrentUrl)) continue;
      visitedPages.add(normalizedCurrentUrl);

      // Navigate to this page (skip if already there)
      const currentActualUrl = await adapter.getUrl();
      if (currentActualUrl.split('#')[0] !== normalizedCurrentUrl) {
        LOG(`Navigating to queued page: ${currentPageUrl}`);
        await adapter.goto(currentPageUrl, { timeout: 30000 });
        await sleep(1000);
      }

      scanState.currentPageUrl = await adapter.getUrl();
      LOG(`\n========== SCANNING PAGE: ${scanState.currentPageUrl} ==========`);
      addEvent('navigate', scanState.currentPageUrl);

      // Create page record in API
      const page =
        api && appId
          ? await api.findOrCreatePage(appId, scanState.currentPageUrl)
          : null;
      LOG(
        'Page record:',
        page ? { id: page.id, url: page.url } : 'skipped (no API)'
      );
      scanState.pagesFound++;
      addEvent('page_discovered', scanState.currentPageUrl);

      // Extract elements
      LOG('Extracting elements...');
      LOG(
        `Extracting elements with focused extractors: ${getRegisteredExtractorNames().join(', ')}`
      );
      const items = await extractActionableItems(adapter);
      const visible = items.filter(i => i.visible);
      const clickable = visible.filter(
        i => !i.disabled && i.actionKind !== 'fill'
      );
      LOG(
        `Items: ${items.length} total, ${visible.length} visible, ${clickable.length} clickable`
      );

      LOG('Getting page HTML...');
      const html = await adapter.content();
      LOG(`HTML length: ${html.length}`);

      LOG('Computing hashes...');
      const hashes = await computeHashes(html, items);

      // Take screenshot
      LOG('Taking screenshot...');
      const screenshotData = await adapter.screenshot({
        type: 'jpeg',
        quality: SCREENSHOT_QUALITY,
      });
      LOG(`Screenshot: ${screenshotData.length} bytes`);
      const screenshotBase64 = uint8ToBase64(screenshotData);
      scanState.latestScreenshotDataUrl = `data:image/jpeg;base64,${screenshotBase64}`;
      LOG('Screenshot converted to data URL');
      sendProgressToSidePanel();

      // Create page state in API
      let pageStateId: number | null = null;
      if (api && page) {
        LOG('Creating page state in API...');
        const contentText = await adapter.evaluate(
          () => document.body.innerText || ''
        );
        LOG(`Content text: ${(contentText as string).length} chars`);
        const pageState = await api.createPageState({
          pageId: page.id,
          sizeClass: 'desktop',
          hashes,
          screenshotPath: '',
          contentText: contentText as string,
        });
        pageStateId = pageState.id;
        LOG(`Page state created: ${pageStateId}`);
        await api.insertActionableItems(pageState.id, items);
        LOG(`Inserted ${items.length} actionable items`);
      }
      scanState.pageStatesFound++;
      addEvent('state_captured', `${items.length} elements found`);

      // Proactively enqueue pages from extracted navigate-action hrefs
      // so we don't miss pages we happen not to click.
      for (const item of items) {
        if (item.actionKind !== 'navigate' || !item.href) continue;
        try {
          const target = new URL(item.href, currentPageUrl);
          if (target.origin !== startOrigin) continue;
          // Skip anchors (#), javascript:, and mailto:
          if (target.protocol !== 'http:' && target.protocol !== 'https:')
            continue;
          const normalized = target.href.split('#')[0];
          if (
            !visitedPages.has(normalized) &&
            !pageQueue.includes(target.href)
          ) {
            pageQueue.push(target.href);
          }
        } catch {
          // Invalid URL, skip
        }
      }
      LOG(`Page queue after href scan: ${pageQueue.length} pending`);

      // === Bug Detection Phase ===
      LOG('Running bug detectors on page...');

      // 1. Check links on this page
      const linkResults = await detectBrokenLinks(adapter, currentPageUrl);
      for (const broken of linkResults) {
        scanState.issuesFound++;
        addEvent(
          'bug',
          `Broken link: "${broken.text}" → ${broken.href} (${broken.error})`
        );
      }

      // 2. Visual checks
      const visualIssues = detectVisualIssues(html);
      for (const issue of visualIssues) {
        scanState.issuesFound++;
        addEvent('bug', `${issue.type}: ${issue.description}`);
      }

      // 3. Media checks
      const mediaIssues = await detectMediaIssues(adapter);
      for (const issue of mediaIssues) {
        scanState.issuesFound++;
        addEvent('bug', `${issue.type}: ${issue.description}`);
      }

      // 4. Content checks
      const contentText2 = await adapter.evaluate(
        () => document.body.innerText || ''
      );
      const contentIssues = detectContentIssues(contentText2 as string);
      for (const issue of contentIssues) {
        scanState.issuesFound++;
        addEvent('bug', `${issue.type}: ${issue.description}`);
      }

      LOG(`Bug detection complete: ${scanState.issuesFound} issues found`);

      // Process visible actionable items, including form fields.
      const clickableItems = items
        .filter(i => i.visible && !i.disabled)
        .sort((a, b) => getActionPriority(a) - getActionPriority(b));
      LOG(
        `\n========== SCANNING ${clickableItems.length} CLICKABLE ITEMS ==========`
      );
      const handledRadioGroups = new Set<string>();

      for (
        let idx = 0;
        idx < clickableItems.length && scanState.isRunning;
        idx++
      ) {
        const item = clickableItems[idx];
        if (!item.selector) {
          LOG(`[${idx}] Skipping — no selector`);
          continue;
        }

        const itemInfo = [
          `<${item.tagName?.toLowerCase()}>`,
          item.textContent ? `"${item.textContent.slice(0, 40)}"` : '',
          item.href ? `→ ${item.href}` : '',
          `(${item.actionKind})`,
        ]
          .filter(Boolean)
          .join(' ');

        LOG(`\n--- [${idx + 1}/${clickableItems.length}] ${itemInfo} ---`);
        LOG(`  selector: ${item.selector}`);
        LOG(
          `  position: (${Math.round(item.x || 0)}, ${Math.round(item.y || 0)}) ${Math.round(item.width || 0)}x${Math.round(item.height || 0)}`
        );

        // Re-tag the element (page may have reloaded, losing data-tmnc-id)
        const retagged = await adapter.evaluate(
          (...args: unknown[]) => {
            const sel = args[0] as string;
            const href = args[1] as string | undefined;
            const text = args[2] as string | undefined;
            const tag = args[3] as string | undefined;
            const match = sel.match(/\[data-tmnc-id="([^"]+)"\]/);
            const uid = match?.[1];

            // First try the original selector
            const el = document.querySelector(sel);
            if (el) {
              if (uid) {
                el.setAttribute('data-tmnc-id', uid);
              }
              return true;
            }

            // If not found, try to locate by href + text
            if (uid && href && tag) {
              const candidates = document.querySelectorAll(tag.toLowerCase());
              for (const c of candidates) {
                const cHref =
                  (c as HTMLAnchorElement).href || c.getAttribute('href') || '';
                const cText = c.textContent?.trim().slice(0, 80) || '';
                if (cHref === href || (text && cText === text)) {
                  c.setAttribute('data-tmnc-id', uid);
                  return true;
                }
              }
            }
            return false;
          },
          item.selector,
          item.href,
          item.textContent,
          item.tagName
        );

        if (!retagged) {
          LOG(`  Element not found on page, skipping`);
          addEvent('warning', `Element not found: ${itemInfo}`);
          continue;
        }

        // Mouseover
        try {
          LOG(`  Hovering...`);
          addEvent('mouseover', itemInfo);
          await adapter.hover(item.selector, { timeout: 3000 });
          LOG(`  Hover done, waiting ${HOVER_DELAY_MS}ms...`);
          await new Promise(r => setTimeout(r, HOVER_DELAY_MS));

          // Check if hover triggered a modal/popup
          const hoverModal = await detectAndHandleModal(adapter);
          if (hoverModal.found) {
            LOG(
              `  Modal detected after hover: ${hoverModal.content?.slice(0, 80)}`
            );
            addEvent(
              'modal',
              `Hover triggered modal: ${hoverModal.content?.slice(0, 60) || 'unknown'}`
            );
            // Dismiss the modal before continuing
            await dismissModal(adapter);
            LOG(`  Modal dismissed`);
          }
        } catch (e) {
          WARN(`  Could not hover:`, e);
          addEvent('warning', `Could not hover ${itemInfo}`);
          continue;
        }

        // Record action in API
        if (api) {
          LOG('  Recording mouseover action in API...');
          await api.createAction({
            runId,
            type: 'mouseover',
            actionableItemId: undefined,
            startingPageStateId: pageStateId ?? undefined,
            sizeClass: 'desktop',
          });
        }
        scanState.actionsCompleted++;

        // Dismiss any open modal before performing action
        const preActionModal = await detectAndHandleModal(adapter);
        if (preActionModal.found) {
          LOG(`  Dismissing open modal before action...`);
          await dismissModal(adapter);
          await new Promise(r => setTimeout(r, 300));
        }

        // Perform action
        try {
          const beforeUrl = await adapter.getUrl();
          const beforeText = (await adapter.evaluate(
            () => document.body.innerText || ''
          )) as string;
          if (item.actionKind === 'fill') {
            const value = fillValuePlanner.planValue(item);
            LOG(`  Filling with "${value}"`);
            addEvent('fill', `${itemInfo} = ${value}`);
            await adapter.type(item.selector, value);
            if (looksLikeEnterCommitField(item)) {
              LOG('  Committing text entry with Enter');
              await adapter.submitTextEntry(item.selector);
            }
          } else if (item.actionKind === 'select') {
            const values = await pickSelectValues(adapter, item.selector);
            if (values.length === 0) {
              const fallbackValue = await pickSelectValue(
                adapter,
                item.selector
              );
              if (fallbackValue) values.push(fallbackValue);
            }

            if (values.length === 0) {
              LOG('  No suitable option found, skipping');
              addEvent('warning', `No option to select for ${itemInfo}`);
              continue;
            }

            for (const value of values) {
              LOG(`  Selecting "${value}"`);
              addEvent('select', `${itemInfo} = ${value}`);
              await adapter.select(item.selector, value);
              await new Promise(r => setTimeout(r, 300));
            }
          } else if (item.actionKind === 'toggle') {
            const inputType = (item.inputType || '').toLowerCase();
            if (inputType === 'radio') {
              const groupName = await getInputName(adapter, item.selector);
              if (groupName && handledRadioGroups.has(groupName)) {
                LOG(`  Radio group "${groupName}" already handled, skipping`);
                continue;
              }
              if (groupName) handledRadioGroups.add(groupName);
            } else {
              const checked = await isToggleChecked(adapter, item.selector);
              if (checked) {
                LOG('  Already checked, skipping');
                addEvent('warning', `Already toggled ${itemInfo}`);
                continue;
              }
            }
            LOG(`  Toggling... (current URL: ${beforeUrl.slice(0, 60)})`);
            addEvent('toggle', itemInfo);
            await adapter.click(item.selector, { timeout: 3000 });
          } else {
            LOG(`  Clicking... (current URL: ${beforeUrl.slice(0, 60)})`);
            addEvent('click', itemInfo);
            await adapter.click(item.selector, { timeout: 3000 });
          }

          LOG(`  Action done, waiting for page to settle...`);
          const settleStart = Date.now();
          // Wait for potential navigation to complete
          await adapter.waitForNavigation({ timeout: 3000 }).catch(() => {});
          const minimumSettleMs = POST_ACTION_SETTLE_MS;
          const remainingSettleMs = Math.max(
            0,
            minimumSettleMs - (Date.now() - settleStart)
          );
          LOG(
            `  Settling for ${minimumSettleMs}ms minimum (${remainingSettleMs}ms remaining after navigation wait)`
          );
          await sleep(remainingSettleMs);

          // Check if click triggered a modal/popup
          const clickModal = await detectAndHandleModal(adapter);
          if (clickModal.found) {
            LOG(
              `  Modal detected after click: ${clickModal.content?.slice(0, 80)}`
            );
            addEvent(
              'modal',
              `Click triggered modal: ${clickModal.content?.slice(0, 60) || 'unknown'}`
            );

            // Extract any links/actions from the modal content
            const modalContent = clickModal.content || '';
            if (modalContent.length > 10) {
              const mContentIssues = detectContentIssues(modalContent);
              for (const issue of mContentIssues) {
                scanState.issuesFound++;
                addEvent('bug', `Modal ${issue.type}: ${issue.description}`);
              }
            }

            // Dismiss modal before continuing
            await dismissModal(adapter);
            LOG(`  Modal dismissed`);
            await new Promise(r => setTimeout(r, 300));
          }

          // Check if the click opened a new tab (target="_blank" etc.)
          const allTabs = await chrome.tabs.query({
            currentWindow: true,
          });
          const newTabs = allTabs.filter(
            t => t.id !== adapter.tabId && t.id !== undefined
          );
          // If a new tab appeared and our tab is no longer active, a
          // target="_blank" link likely opened it. Close the new tab
          // and re-activate ours.
          for (const nt of newTabs) {
            if (nt.active && nt.id !== adapter.tabId && nt.id !== undefined) {
              LOG(`  New tab opened (${nt.url?.slice(0, 60)}), closing it`);
              addEvent(
                'new_tab_closed',
                `Closed tab: ${nt.url?.slice(0, 60) || 'unknown'}`
              );
              await chrome.tabs.remove(nt.id);
              await chrome.tabs.update(adapter.tabId, { active: true });
              break;
            }
          }

          const afterUrl = await adapter.getUrl();
          LOG(`  After URL: ${afterUrl.slice(0, 60)}`);
          scanState.currentPageUrl = afterUrl;
          sendProgressToSidePanel();

          // Check if navigated to a non-web page (devtools, chrome://, etc.)
          if (
            !afterUrl.startsWith('http://') &&
            !afterUrl.startsWith('https://')
          ) {
            LOG(`  NON-WEB PAGE: ${afterUrl} — navigating back`);
            addEvent('warning', `Navigated to ${afterUrl}, going back`);
            await adapter.goto(currentPageUrl, { timeout: 30000 });
            continue;
          }

          // Check for cross-origin navigation
          if (new URL(afterUrl).origin !== startOrigin) {
            LOG(`  CROSS-ORIGIN: ${afterUrl} — navigating back`);
            addEvent('cross_origin', `Navigated to ${afterUrl}, going back`);
            await adapter.goto(currentPageUrl, { timeout: 30000 });
            continue;
          }

          // Check if URL changed (new page discovered)
          const normalizedAfter = afterUrl.split('#')[0];
          const normalizedBefore = beforeUrl.split('#')[0];
          if (normalizedAfter !== normalizedBefore) {
            LOG(`  NEW PAGE: ${afterUrl}`);
            addEvent('page_discovered', afterUrl);
            if (api && appId) {
              await api.findOrCreatePage(appId, afterUrl);
            }

            // Enqueue the new page for later processing and go back
            if (!visitedPages.has(normalizedAfter)) {
              pageQueue.push(afterUrl);
              LOG(`  Enqueued for later, navigating back to ${currentPageUrl}`);
            }
            await adapter.goto(currentPageUrl, { timeout: 30000 });
            await sleep(500);
          } else {
            LOG('  Same page (no navigation)');
          }

          // Take screenshot after action
          LOG('  Taking post-action screenshot...');
          const newScreenshot = await adapter.screenshot({
            type: 'jpeg',
            quality: SCREENSHOT_QUALITY,
          });
          const newBase64 = uint8ToBase64(newScreenshot);
          scanState.latestScreenshotDataUrl = `data:image/jpeg;base64,${newBase64}`;
          sendProgressToSidePanel();

          // Check if click led to an error page
          const postClickText = (await adapter.evaluate(
            () => document.body.innerText || ''
          )) as string;
          const postClickIssues = detectContentIssues(postClickText);
          if (postClickIssues.some(i => i.type === 'error_page')) {
            scanState.issuesFound++;
            addEvent(
              'bug',
              `Click on "${item.textContent}" led to error page at ${afterUrl}`
            );
          }

          const textChanged = postClickText.trim() !== beforeText.trim();

          if (
            shouldExpectNavigation(item, beforeUrl) &&
            normalizedAfter === normalizedBefore &&
            !textChanged
          ) {
            scanState.issuesFound++;
            addEvent(
              'bug',
              `navigation_no_effect: Clicking "${item.textContent || item.accessibleName || item.href}" did not navigate or change page state`
            );
          }

          if (
            looksLikeSubmitAction(item) &&
            normalizedAfter === normalizedBefore &&
            !textChanged &&
            !postClickIssues.some(i => i.type === 'error_page')
          ) {
            scanState.issuesFound++;
            addEvent(
              'bug',
              `action_no_effect: "${item.textContent || item.accessibleName || 'submit action'}" did not change page state`
            );
          }

          if (api) {
            await api.createAction({
              runId,
              type:
                item.actionKind === 'navigate' || item.actionKind === 'click'
                  ? 'click'
                  : item.actionKind,
              startingPageStateId: pageStateId ?? undefined,
              sizeClass: 'desktop',
            });
          }
          scanState.actionsCompleted++;
          LOG(
            `  Actions completed: ${scanState.actionsCompleted} (pages: ${scanState.pagesFound})`
          );
        } catch (e) {
          WARN(`  Could not click:`, e);
          addEvent('warning', `Could not click ${itemInfo}`);
        }

        // Update run stats periodically
        if (api && idx % 5 === 0) {
          LOG('  Updating run stats in API...');
          await api.updateRunStats(runId, {
            pagesFound: scanState.pagesFound,
            pageStatesFound: scanState.pageStatesFound,
            actionsCompleted: scanState.actionsCompleted,
          });
        }

        sendProgressToSidePanel();
      }

      LOG(
        `Finished page ${currentPageUrl} — ${pageQueue.length} page(s) remaining in queue`
      );
    }

    // Mark run as completed
    LOG(`\n========== SCAN COMPLETE ==========`);
    LOG(
      `Actions: ${scanState.actionsCompleted}, Pages: ${scanState.pagesFound}, States: ${scanState.pageStatesFound}`
    );
    scanState.phase = 'completed';
    scanState.isComplete = true;
    if (api) {
      LOG('Marking run as completed in API...');
      await api.completeRun(runId);
    }
    addEvent(
      'run_completed',
      `Completed with ${scanState.actionsCompleted} actions`
    );
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
    LOG('Scan state finalized, isRunning=false');
  }
}

// ============================================================================
// Message Handlers
// ============================================================================

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  LOG(
    'Message received:',
    message.type,
    message.url ? `url=${message.url}` : '',
    message.runId ? `runId=${message.runId}` : ''
  );

  if (message.type === 'START_SCAN' && message.url && message.runId) {
    LOG('Starting scan...');
    runScan(message.url, message.runId);
    sendResponse({ ok: true });
  } else if (message.type === 'STOP_SCAN') {
    LOG('Stopping scan');
    scanState.isRunning = false;
    scanState.isComplete = true;
    scanState.phase = 'stopped';
    addEvent('stopped', 'Scan stopped by user');
    sendResponse({ ok: true });
  } else if (message.type === 'GET_STATUS') {
    LOG('Status requested');
    sendResponse({ ...scanState });
  } else if (message.type === 'SET_AUTH_TOKEN') {
    firebaseToken = (message.token as string) || null;
    LOG('Firebase token updated:', firebaseToken ? 'present' : 'cleared');
    sendResponse({ ok: true });
  } else if (message.type === 'SAVE_CONFIG') {
    LOG('Saving config:', {
      apiUrl: message.apiUrl,
      hasApiKey: !!message.apiKey,
    });
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
  LOG('Extension icon clicked, opening side panel for tab', tab.id);
  if (tab.id) {
    await chrome.sidePanel.open({ tabId: tab.id });
  }
});

// Load config on startup
loadConfig();
