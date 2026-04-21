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

const LOG = (...args: unknown[]) => console.log('[Testomniac]', ...args);
const WARN = (...args: unknown[]) => console.warn('[Testomniac]', ...args);
const ERR = (...args: unknown[]) => console.error('[Testomniac]', ...args);

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

// Load config from storage
async function loadConfig() {
  LOG('Loading config from chrome.storage.local');
  const stored = await chrome.storage.local.get(['apiUrl', 'apiKey']);
  if (stored.apiUrl) apiUrl = stored.apiUrl as string;
  if (stored.apiKey) apiKey = stored.apiKey as string;
  LOG('Config loaded:', { apiUrl, hasApiKey: !!apiKey });
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

async function extractActionableItems(
  adapter: ChromeAdapter
): Promise<ActionableItem[]> {
  LOG('Extracting actionable items from page...');
  // Tag each element with a unique data attribute for reliable selection
  const rawItems = await adapter.evaluate(() => {
    const SELECTORS =
      'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"]';

    function isVisible(el: Element): boolean {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden';
    }

    const elements: unknown[] = [];
    let idx = 0;
    document.querySelectorAll(SELECTORS).forEach(el => {
      // Assign a unique attribute for reliable re-selection
      const uid = `tmnc-${idx++}`;
      el.setAttribute('data-tmnc-id', uid);
      const selector = `[data-tmnc-id="${uid}"]`;

      const tag = el.tagName;
      const role = el.getAttribute('role') || '';
      const ariaLabel = el.getAttribute('aria-label') || '';
      const text = el.textContent?.trim().slice(0, 80) || '';
      const name = ariaLabel || text;
      const rect = el.getBoundingClientRect();
      const href = el.getAttribute('href') || undefined;
      const inputType = (el as HTMLInputElement).type || undefined;

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

  const items = (rawItems as Record<string, unknown>[]) || [];
  LOG(`Extracted ${items.length} raw elements`);

  const mapped = items.map(item => ({
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

  const visible = mapped.filter(i => i.visible);
  const clickable = visible.filter(i => !i.disabled && i.actionKind !== 'fill');
  LOG(
    `Items: ${mapped.length} total, ${visible.length} visible, ${clickable.length} clickable`
  );
  return mapped;
}

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
      const resp = await fetch(href, { method: 'HEAD' });
      if (resp.status >= 400) {
        LOG(`  Broken: ${href} (${resp.status})`);
        broken.push({ href, text, error: `HTTP ${resp.status}` });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'fetch failed';
      LOG(`  Broken: ${href} (${msg})`);
      broken.push({ href, text, error: msg });
    }
  }

  LOG(`Found ${broken.length} broken links out of ${uniqueLinks.size} unique`);
  return broken;
}

interface VisualIssue {
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

    scanState.currentPageUrl = await adapter.getUrl();
    LOG(`Current URL: ${scanState.currentPageUrl}`);
    addEvent('navigate', scanState.currentPageUrl);

    // Create initial page
    const appId = scanState.appId;
    LOG(`Creating page in API (appId: ${appId})...`);
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
    const items = await extractActionableItems(adapter);

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

    // === Bug Detection Phase ===
    LOG('Running bug detectors on page...');

    // 1. Check links on this page
    const linkResults = await detectBrokenLinks(adapter, url);
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

    // 3. Content checks
    const contentText2 = await adapter.evaluate(
      () => document.body.innerText || ''
    );
    const contentIssues = detectContentIssues(contentText2 as string);
    for (const issue of contentIssues) {
      scanState.issuesFound++;
      addEvent('bug', `${issue.type}: ${issue.description}`);
    }

    LOG(`Bug detection complete: ${scanState.issuesFound} issues found`);

    // Process visible, clickable items
    const clickableItems = items.filter(
      i => i.visible && !i.disabled && i.actionKind !== 'fill'
    );
    LOG(
      `\n========== SCANNING ${clickableItems.length} CLICKABLE ITEMS ==========`
    );

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

      // Click
      try {
        const beforeUrl = await adapter.getUrl();
        LOG(`  Clicking... (current URL: ${beforeUrl.slice(0, 60)})`);
        addEvent('click', itemInfo);
        await adapter.click(item.selector, { timeout: 3000 });
        LOG(`  Click done, waiting for page to settle...`);
        // Wait for potential navigation to complete
        await adapter.waitForNavigation({ timeout: 3000 }).catch(() => {});
        await new Promise(r => setTimeout(r, POST_ACTION_SETTLE_MS));

        const afterUrl = await adapter.getUrl();
        LOG(`  After URL: ${afterUrl.slice(0, 60)}`);
        scanState.currentPageUrl = afterUrl;

        // Check if navigated to a non-web page (devtools, chrome://, etc.)
        if (
          !afterUrl.startsWith('http://') &&
          !afterUrl.startsWith('https://')
        ) {
          LOG(`  NON-WEB PAGE: ${afterUrl} — navigating back`);
          addEvent('warning', `Navigated to ${afterUrl}, going back`);
          await adapter.goto(url, { timeout: 30000 });
          continue;
        }

        // Check for cross-origin navigation
        if (new URL(afterUrl).origin !== new URL(url).origin) {
          LOG(`  CROSS-ORIGIN: ${afterUrl} — navigating back`);
          addEvent('cross_origin', `Navigated to ${afterUrl}, going back`);
          await adapter.goto(url, { timeout: 30000 });
          continue;
        }

        // Check if URL changed (new page discovered)
        if (afterUrl !== beforeUrl) {
          scanState.pagesFound++;
          LOG(`  NEW PAGE: ${afterUrl}`);
          addEvent('page_discovered', afterUrl);
          if (api && appId) {
            await api.findOrCreatePage(appId, afterUrl);
          }
        } else {
          LOG('  Same page (no navigation)');
        }

        // Take screenshot after click
        LOG('  Taking post-click screenshot...');
        const newScreenshot = await adapter.screenshot({
          type: 'jpeg',
          quality: SCREENSHOT_QUALITY,
        });
        const newBase64 = uint8ToBase64(newScreenshot);
        scanState.latestScreenshotDataUrl = `data:image/jpeg;base64,${newBase64}`;

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

        if (api) {
          await api.createAction({
            runId,
            type: 'click',
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
