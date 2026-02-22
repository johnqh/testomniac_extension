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
  fullHref?: string;  // Full resolved URL for validation
  styleFingerprint: string;  // For grouping similar elements
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Generate a style fingerprint for an element
 * Based on: tag + parent hierarchy (3 levels) + sorted CSS classes
 */
function getStyleFingerprint(el: Element): string {
  const tag = el.tagName.toLowerCase();

  // Get parent path (up to 3 levels)
  const parentPath: string[] = [];
  let parent = el.parentElement;
  for (let i = 0; i < 3 && parent; i++) {
    const parentTag = parent.tagName.toLowerCase();
    const parentClasses = Array.from(parent.classList).sort().slice(0, 3).join('.');
    parentPath.push(parentClasses ? `${parentTag}.${parentClasses}` : parentTag);
    parent = parent.parentElement;
  }

  // Get element's own classes (sorted, max 5)
  const classes = Array.from(el.classList).sort().slice(0, 5).join('.');

  return `${tag}|${parentPath.join('>')}|${classes}`;
}

/**
 * Resolve a potentially relative href to a full URL
 */
function resolveHref(href: string): string {
  try {
    return new URL(href, window.location.href).href;
  } catch {
    return href;
  }
}

/**
 * Extract main text content from the page as simplified markdown-like text
 * Removes scripts, styles, and extracts meaningful structure
 */
function getPageTextContent(): string {
  const lines: string[] = [];

  // Get title
  if (document.title) {
    lines.push(`# ${document.title}`);
    lines.push('');
  }

  // Get headings
  document.querySelectorAll('h1, h2, h3').forEach((h) => {
    const text = h.textContent?.trim().replace(/\s+/g, ' ');
    if (text && text.length > 2) {
      const level = h.tagName === 'H1' ? '#' : h.tagName === 'H2' ? '##' : '###';
      lines.push(`${level} ${text}`);
    }
  });

  // Get main content paragraphs (limit to first 10)
  let pCount = 0;
  document.querySelectorAll('main p, article p, [role="main"] p, .content p, #content p').forEach((p) => {
    if (pCount >= 10) return;
    const text = p.textContent?.trim().replace(/\s+/g, ' ');
    if (text && text.length > 20) {
      lines.push(text);
      pCount++;
    }
  });

  // If no main content found, try body paragraphs
  if (pCount === 0) {
    document.querySelectorAll('body p').forEach((p) => {
      if (pCount >= 10) return;
      const text = p.textContent?.trim().replace(/\s+/g, ' ');
      if (text && text.length > 20) {
        lines.push(text);
        pCount++;
      }
    });
  }

  // Get navigation links for context
  const navLinks: string[] = [];
  document.querySelectorAll('nav a, header a').forEach((a) => {
    const text = a.textContent?.trim();
    if (text && text.length > 1 && text.length < 30 && navLinks.length < 10) {
      navLinks.push(text);
    }
  });
  if (navLinks.length > 0) {
    lines.push('');
    lines.push(`Navigation: ${navLinks.join(', ')}`);
  }

  const result = lines.join('\n').slice(0, 2000); // Limit to 2000 chars
  console.log(`[Testomniac] Extracted ${result.length} chars of page content`);
  return result;
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

    const fullHref = resolveHref(href);

    elements.push({
      index: index++,
      type: 'link',
      text,
      href: href.length > 80 ? href.slice(0, 80) + '...' : href,
      fullHref,
      styleFingerprint: getStyleFingerprint(el),
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
      styleFingerprint: getStyleFingerprint(el),
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
      styleFingerprint: getStyleFingerprint(el),
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
    const pageContent = getPageTextContent();
    return {
      success: true,
      url: window.location.href,
      title: document.title,
      elements,
      pageContent,
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
