/**
 * Content Script
 *
 * Runs in the context of web pages and:
 * - Collects interactive elements with their screen coordinates
 * - Monitors for errors and issues
 * - Captures DOM state
 */

import browser from 'webextension-polyfill';

console.log('[Testomniac] Content script loaded on:', window.location.href);

// Store console errors
const consoleErrors: string[] = [];
const networkErrors: string[] = [];

// Override console.error to capture errors
const originalConsoleError = console.error;
console.error = (...args: unknown[]) => {
  const errorMessage = args.map(arg =>
    typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
  ).join(' ');
  consoleErrors.push(errorMessage);
  originalConsoleError.apply(console, args);
};

// Listen for network errors
window.addEventListener('error', (event) => {
  if (event.target instanceof HTMLImageElement ||
      event.target instanceof HTMLScriptElement ||
      event.target instanceof HTMLLinkElement) {
    networkErrors.push(`Failed to load: ${(event.target as HTMLImageElement).src || (event.target as HTMLLinkElement).href}`);
  }
});

// Listen for unhandled promise rejections
window.addEventListener('unhandledrejection', (event) => {
  consoleErrors.push(`Unhandled rejection: ${event.reason}`);
});

/**
 * Interactive element with its screen coordinates
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
 * Extract all interactive elements with their screen coordinates
 * This is the core function - we get positions at extraction time,
 * not at click time. No CSS selectors needed.
 */
function getInteractiveElements(): InteractiveElement[] {
  const elements: InteractiveElement[] = [];
  let index = 0;

  // Helper to check if element is visible
  function isVisible(el: Element): boolean {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0;
  }

  // Helper to get clean text
  function getText(el: Element): string {
    const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
    return text.length > 60 ? text.slice(0, 60) + '...' : text;
  }

  // Extract links (most important for navigation)
  document.querySelectorAll('a[href]').forEach((el) => {
    if (!isVisible(el) || elements.length >= 30) return;
    const href = el.getAttribute('href') || '';
    if (!href || href === '#' || href.startsWith('javascript:')) return;

    const rect = el.getBoundingClientRect();
    const text = getText(el);
    if (!text) return;

    elements.push({
      index: index++,
      type: 'link',
      text,
      href: href.length > 80 ? href.slice(0, 80) + '...' : href,
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
  });

  // Extract buttons
  document.querySelectorAll('button, input[type="button"], input[type="submit"]').forEach((el) => {
    if (!isVisible(el) || elements.length >= 40) return;

    const rect = el.getBoundingClientRect();
    const text = getText(el) || (el as HTMLInputElement).value || 'Button';

    elements.push({
      index: index++,
      type: 'button',
      text,
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
  });

  // Extract form inputs
  document.querySelectorAll('input:not([type="hidden"]):not([type="button"]):not([type="submit"]), textarea, select').forEach((el) => {
    if (!isVisible(el) || elements.length >= 50) return;

    const rect = el.getBoundingClientRect();
    const inputEl = el as HTMLInputElement;
    const type = inputEl.type || el.tagName.toLowerCase();
    const placeholder = inputEl.placeholder || '';
    const name = inputEl.name || '';

    elements.push({
      index: index++,
      type: el.tagName.toLowerCase() === 'select' ? 'select' : el.tagName.toLowerCase() === 'textarea' ? 'textarea' : 'input',
      text: placeholder || name || type,
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
  });

  console.log(`[Testomniac] Found ${elements.length} interactive elements`);
  return elements;
}

// Message listener
browser.runtime.onMessage.addListener(async (message: unknown) => {
  const msg = message as { type: string; payload?: unknown };
  console.log('[Testomniac] Content script received:', msg.type);

  // Handle PING for detection
  if (msg.type === 'PING') {
    return { pong: true };
  }

  // Handle GET_ELEMENTS - returns all interactive elements with their coordinates
  if (msg.type === 'GET_ELEMENTS') {
    const elements = getInteractiveElements();
    return {
      success: true,
      url: window.location.href,
      title: document.title,
      elements,
      consoleErrors: [...consoleErrors],
      networkErrors: [...networkErrors],
    };
  }

  // Handle SCROLL_TO - scroll to a specific position before clicking
  if (msg.type === 'SCROLL_TO') {
    const { x, y } = msg.payload as { x: number; y: number };
    // Scroll so the target point is roughly in the center of the viewport
    window.scrollTo({
      left: Math.max(0, x - window.innerWidth / 2),
      top: Math.max(0, y - window.innerHeight / 2),
      behavior: 'instant',
    });
    await new Promise(r => setTimeout(r, 100));
    return { success: true };
  }

  return { success: true };
});

console.log('[Testomniac] Content script ready');
