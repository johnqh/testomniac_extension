/**
 * Background Service Worker
 *
 * Core of the Testomniac extension. Handles:
 * - Test orchestration
 * - Communication with Testomniac API
 * - State management between popup and content scripts
 * - Screenshot capture via debugger API
 */

// Initialize network guard first
import { initNetworkGuard } from '../shared/security/networkGuard';
initNetworkGuard();

import browser from 'webextension-polyfill';
import type { Runtime } from 'webextension-polyfill';
import { MessageType } from '../shared/types/messaging';
import type { TestRun, TestStep, DetectedIssue } from '@testomniac/types';

console.log('[Testomniac] Background service worker starting...');

// API Configuration
const API_BASE_URL = 'http://localhost:3001/api/v1';

// Current test state
interface TestState {
  isRunning: boolean;
  currentTestRun: TestRun | null;
  currentStep: number;
  tabId: number | null;
  logs: string[];
  visitedUrls: Set<string>;
  visitedElements: Set<string>; // Track by "text|href" to avoid revisiting same links across pages
  loopInProgress: boolean;
  lastUrl: string;
  samePageClicks: number;
}

const testState: TestState = {
  isRunning: false,
  currentTestRun: null,
  currentStep: 0,
  tabId: null,
  logs: [],
  visitedUrls: new Set(),
  visitedElements: new Set(),
  loopInProgress: false,
  lastUrl: '',
  samePageClicks: 0,
};

function log(message: string): void {
  const timestamp = new Date().toISOString().substr(11, 8);
  const logEntry = `[${timestamp}] ${message}`;
  testState.logs.push(logEntry);
  console.log('[Testomniac]', message);

  if (testState.logs.length > 50) {
    testState.logs.shift();
  }
}

/**
 * Wait for tab to finish loading
 */
function waitForTabLoad(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    const checkTab = async () => {
      try {
        const tab = await browser.tabs.get(tabId);
        if (tab.status === 'complete') {
          resolve();
        } else {
          setTimeout(checkTab, 200);
        }
      } catch {
        resolve();
      }
    };
    checkTab();
  });
}

/**
 * Capture screenshot of the current tab
 */
async function captureScreenshot(tabId: number): Promise<string | null> {
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    const result = await chrome.debugger.sendCommand(
      { tabId },
      'Page.captureScreenshot',
      { format: 'png', quality: 80 }
    ) as { data: string };
    await chrome.debugger.detach({ tabId });
    return result.data;
  } catch (error) {
    log(`Screenshot failed: ${error}`);
    return null;
  }
}

/**
 * Interactive element from content script
 */
interface InteractiveElement {
  index: number;
  type: 'link' | 'button' | 'input' | 'select' | 'textarea';
  text: string;
  href?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Get all interactive elements with their coordinates from the page
 */
async function getElementsFromPage(tabId: number): Promise<{
  url: string;
  title: string;
  elements: InteractiveElement[];
  consoleErrors: string[];
  networkErrors: string[];
} | null> {
  try {
    const response = await browser.tabs.sendMessage(tabId, { type: 'GET_ELEMENTS' }) as {
      success: boolean;
      url: string;
      title: string;
      elements: InteractiveElement[];
      consoleErrors: string[];
      networkErrors: string[];
    };

    if (response?.success) {
      return {
        url: response.url,
        title: response.title,
        elements: response.elements,
        consoleErrors: response.consoleErrors,
        networkErrors: response.networkErrors,
      };
    }
    return null;
  } catch (error) {
    log(`Failed to get elements: ${error}`);
    return null;
  }
}

/**
 * Normalize href to create consistent keys
 * Removes domain, normalizes trailing slashes
 */
function normalizeHref(href: string): string {
  try {
    // If it's a full URL, extract just the path
    if (href.startsWith('http://') || href.startsWith('https://')) {
      const url = new URL(href);
      return url.pathname.replace(/\/$/, '') || '/';
    }
    // Relative URL - just normalize trailing slash
    return href.replace(/\/$/, '') || '/';
  } catch {
    return href;
  }
}

/**
 * Get a unique key for an element based on its content (not position)
 */
function getElementKey(el: InteractiveElement): string {
  if (el.type === 'link' && el.href) {
    const normalizedHref = normalizeHref(el.href);
    return `link:${el.text}|${normalizedHref}`;
  }
  return `${el.type}:${el.text}`;
}

/**
 * Call API to pick which element to click (by index)
 * AI only sees element descriptions, not coordinates
 */
async function pickElementViaAPI(
  elements: InteractiveElement[],
  url: string,
  title: string
): Promise<number | null> {
  log('Calling API to pick element...');

  // Format elements for AI - mark visited ones based on content
  const elementDescriptions = elements.map((el, i) => {
    const key = getElementKey(el);
    const visited = testState.visitedElements.has(key) ? ' [VISITED]' : '';
    if (el.type === 'link') {
      return `${i}: [LINK] "${el.text}" -> ${el.href || '?'}${visited}`;
    } else if (el.type === 'button') {
      return `${i}: [BUTTON] "${el.text}"${visited}`;
    } else {
      return `${i}: [${el.type.toUpperCase()}] "${el.text}"${visited}`;
    }
  }).join('\n');

  const response = await fetch(`${API_BASE_URL}/ai/pick-element`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url,
      title,
      elements: elementDescriptions,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  if (!data.success) {
    throw new Error(data.error || 'API returned failure');
  }

  return data.data.selectedIndex;
}

/**
 * Perform a real mouse click using Chrome DevTools Protocol
 * This creates trusted events that websites can't distinguish from real user input
 */
async function performRealClick(tabId: number, x: number, y: number): Promise<void> {
  log(`performRealClick at (${x}, ${y})`);

  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    log('Debugger attached');

    // Move mouse to position (triggers hover/CSS :hover)
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
    });
    log('Mouse moved');

    // Wait for hover effects (dropdowns, etc.)
    await new Promise(r => setTimeout(r, 500));

    // Mouse down
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
    log('Mouse pressed');

    // Small delay between press and release
    await new Promise(r => setTimeout(r, 50));

    // Mouse up
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
    log('Mouse released');

    await chrome.debugger.detach({ tabId });
    log('Debugger detached');
  } catch (error) {
    log(`Debugger error: ${error}`);
    try {
      await chrome.debugger.detach({ tabId });
    } catch {}
    throw error;
  }
}

/**
 * Inject content script into tab
 */
async function injectContentScript(tabId: number): Promise<boolean> {
  try {
    // Check if content script is already injected
    const response = await browser.tabs.sendMessage(tabId, { type: 'PING' }).catch(() => null) as { pong?: boolean } | null;
    if (response?.pong) {
      return true;
    }
  } catch {
    // Content script not present, need to inject
  }

  try {
    // Get the content script file from manifest
    const manifest = chrome.runtime.getManifest();
    const contentScriptFile = manifest.content_scripts?.[0]?.js?.[0];

    if (!contentScriptFile) {
      log('No content script found in manifest');
      return false;
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      files: [contentScriptFile],
    });
    // Wait for script to initialize
    await new Promise(resolve => setTimeout(resolve, 500));
    return true;
  } catch (error) {
    log(`Failed to inject content script: ${error}`);
    return false;
  }
}

/**
 * Normalize URL for comparison (remove trailing slashes, fragments, etc.)
 */
function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Remove fragment and trailing slash
    return `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}${parsed.search}`;
  } catch {
    return url;
  }
}

/**
 * Main test loop - get elements with coordinates, pick one via AI, click at coordinates
 */
async function runTestLoop(): Promise<void> {
  if (!testState.isRunning || !testState.tabId || !testState.currentTestRun) {
    return;
  }

  // Prevent concurrent loops
  if (testState.loopInProgress) {
    log('Loop already in progress, skipping');
    return;
  }

  testState.loopInProgress = true;

  try {
    // Wait for page to be ready
    await waitForTabLoad(testState.tabId);
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Ensure content script is injected after navigation
    const injected = await injectContentScript(testState.tabId);
    if (!injected) {
      log('Failed to inject content script, retrying...');
      await new Promise(resolve => setTimeout(resolve, 2000));
      testState.loopInProgress = false;
      runTestLoop();
      return;
    }

    // Get elements with their coordinates from the page
    const pageData = await getElementsFromPage(testState.tabId);
    if (!pageData) {
      log('Failed to get elements, retrying...');
      await new Promise(resolve => setTimeout(resolve, 2000));
      testState.loopInProgress = false;
      runTestLoop();
      return;
    }

    const { url, title, elements, consoleErrors, networkErrors } = pageData;
    const normalizedUrl = normalizeUrl(url);

    log(`Page: ${title} (${url})`);
    log(`Found ${elements.length} interactive elements`);

    // Track visited URL
    testState.visitedUrls.add(normalizedUrl);

    // Check if we're on same page (click didn't navigate)
    if (testState.lastUrl === normalizedUrl) {
      testState.samePageClicks++;
      log(`Same page click #${testState.samePageClicks}`);
      if (testState.samePageClicks >= 10) {
        log('Too many clicks on same page, stopping');
        testState.loopInProgress = false;
        await stopTest();
        return;
      }
    } else {
      testState.samePageClicks = 0;
      testState.lastUrl = normalizedUrl;
    }

    // Capture screenshot
    const screenshot = await captureScreenshot(testState.tabId);

    // Record step
    const step: TestStep = {
      id: `step-${testState.currentStep}`,
      testRunId: testState.currentTestRun.id,
      sequenceNumber: testState.currentStep,
      action: 'navigate',
      target: url,
      targetDescription: title,
      screenshotPath: screenshot || undefined,
      timestamp: new Date().toISOString(),
      success: true,
    };
    testState.currentTestRun.steps.push(step);

    // Record issues
    if (consoleErrors.length > 0) {
      const issue: DetectedIssue = {
        id: `issue-${Date.now()}`,
        testRunId: testState.currentTestRun.id,
        stepId: step.id,
        type: 'console_error',
        severity: 'high',
        title: 'Console errors detected',
        description: consoleErrors.join('\n'),
        screenshots: screenshot ? [screenshot] : [],
        consoleErrors,
        createdAt: new Date().toISOString(),
      };
      testState.currentTestRun.issues.push(issue);
    }

    if (networkErrors.length > 0) {
      const issue: DetectedIssue = {
        id: `issue-${Date.now() + 1}`,
        testRunId: testState.currentTestRun.id,
        stepId: step.id,
        type: 'network_error',
        severity: 'medium',
        title: 'Network errors detected',
        description: networkErrors.join('\n'),
        screenshots: screenshot ? [screenshot] : [],
        networkErrors,
        createdAt: new Date().toISOString(),
      };
      testState.currentTestRun.issues.push(issue);
    }

    testState.currentStep++;

    // Count unvisited elements (based on content, not position)
    const unvisitedCount = elements.filter(el => !testState.visitedElements.has(getElementKey(el))).length;
    log(`Unvisited elements: ${unvisitedCount}/${elements.length}`);

    // If no elements or all visited, stop
    if (elements.length === 0 || unvisitedCount === 0) {
      log('No unvisited elements, test complete');
      testState.loopInProgress = false;
      await stopTest();
      return;
    }

    // Ask AI to pick an element (by index)
    try {
      const selectedIndex = await pickElementViaAPI(elements, url, title);

      if (selectedIndex === null || selectedIndex < 0 || selectedIndex >= elements.length) {
        log('AI returned invalid index, stopping');
        testState.loopInProgress = false;
        await stopTest();
        return;
      }

      let element = elements[selectedIndex];
      let elementKey = getElementKey(element);
      log(`AI picked element ${selectedIndex}: ${element.type} "${element.text}" at (${element.x}, ${element.y})`);

      // If AI picked a visited element, find the first unvisited one instead
      if (testState.visitedElements.has(elementKey)) {
        log(`AI picked visited element, finding unvisited one...`);
        const unvisitedElement = elements.find(el => !testState.visitedElements.has(getElementKey(el)));
        if (!unvisitedElement) {
          log('No unvisited elements found, stopping');
          testState.loopInProgress = false;
          await stopTest();
          return;
        }
        element = unvisitedElement;
        elementKey = getElementKey(element);
        log(`Using unvisited element instead: ${element.type} "${element.text}" at (${element.x}, ${element.y})`);
      }

      // Mark as visited by content (persists across pages)
      testState.visitedElements.add(elementKey);
      log(`Marked as visited: ${elementKey}`);

      // Click at the element's coordinates using CDP
      await performRealClick(testState.tabId, element.x, element.y);

      log('Click executed, waiting for page...');
      await new Promise(resolve => setTimeout(resolve, 2000));
      testState.loopInProgress = false;
      runTestLoop();

    } catch (error) {
      log(`AI pick failed: ${error}`);
      testState.loopInProgress = false;
      await stopTest();
    }

  } catch (error) {
    log(`Test loop error: ${error}`);
    if (testState.isRunning) {
      log('Retrying after error...');
      await new Promise(resolve => setTimeout(resolve, 2000));
      testState.loopInProgress = false;
      runTestLoop();
    } else {
      testState.loopInProgress = false;
    }
  }
}

/**
 * Start a new test run
 */
async function startTest(url: string, configId?: string): Promise<void> {
  log(`Starting test for: ${url}`);

  const tab = await browser.tabs.create({ url, active: true });

  if (!tab.id) {
    throw new Error('Failed to create test tab');
  }

  testState.isRunning = true;
  testState.tabId = tab.id;
  testState.currentStep = 0;
  testState.logs = [];
  testState.visitedUrls = new Set();
  testState.visitedElements = new Set();
  testState.loopInProgress = false;
  testState.lastUrl = '';
  testState.samePageClicks = 0;
  testState.currentTestRun = {
    id: `run-${Date.now()}`,
    userId: 'extension-user',
    configId,
    status: 'running',
    startUrl: url,
    steps: [],
    issues: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  log('Test run created');

  // Start the test loop
  await waitForTabLoad(tab.id);
  log('Page loaded, starting analysis');
  await new Promise(resolve => setTimeout(resolve, 1000));
  runTestLoop();
}

/**
 * Stop the current test
 */
async function stopTest(): Promise<TestRun | null> {
  if (!testState.currentTestRun) {
    return null;
  }

  testState.currentTestRun.status = 'completed';
  testState.currentTestRun.completedAt = new Date().toISOString();
  testState.currentTestRun.updatedAt = new Date().toISOString();

  const completedRun = { ...testState.currentTestRun };

  log(`Test completed: ${completedRun.steps.length} steps, ${completedRun.issues.length} issues`);

  testState.isRunning = false;
  testState.currentTestRun = null;
  testState.currentStep = 0;
  testState.tabId = null;
  testState.visitedUrls.clear();
  testState.visitedElements.clear();
  testState.loopInProgress = false;
  testState.lastUrl = '';
  testState.samePageClicks = 0;

  return completedRun;
}

// Message types for internal use
interface BackgroundMessage {
  type: string;
  payload?: {
    url?: string;
    configId?: string;
    [key: string]: unknown;
  };
}

// Message listener
browser.runtime.onMessage.addListener(async (message: unknown, _sender: Runtime.MessageSender) => {
  const msg = message as BackgroundMessage;

  if (msg.type === 'PING') {
    return { pong: true };
  }

  log(`Received: ${msg.type}`);

  switch (msg.type) {
    case MessageType.START_TEST:
      if (msg.payload?.url) {
        await startTest(msg.payload.url, msg.payload.configId);
      }
      return { success: true };

    case MessageType.STOP_TEST:
      const result = await stopTest();
      return { success: true, testRun: result };

    case MessageType.TEST_STATUS:
      return {
        isRunning: testState.isRunning,
        currentTestRun: testState.currentTestRun,
        currentStep: testState.currentStep,
        logs: testState.logs,
      };

    default:
      return { success: true };
  }
});

// Extension install event
browser.runtime.onInstalled.addListener((details: Runtime.OnInstalledDetailsType) => {
  log(`Extension installed: ${details.reason}`);
});

// Handle tab updates (navigation) during tests
// Note: The test loop handles page changes internally via polling

// Handle tab close during tests
browser.tabs.onRemoved.addListener((tabId) => {
  if (tabId === testState.tabId && testState.isRunning) {
    log('Test tab closed, stopping test');
    stopTest();
  }
});

console.log('[Testomniac] Background service worker ready');
