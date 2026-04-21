import type { ChromeAdapter } from '../../adapters/ChromeAdapter';
import type { DomSnapshotEntry } from './types';

export async function buildDomSnapshot(
  adapter: ChromeAdapter
): Promise<DomSnapshotEntry[]> {
  const rawItems = await adapter.evaluate(() => {
    const BASE_SELECTOR = [
      'a[href]',
      'button',
      'input:not([type="hidden"])',
      'select',
      'textarea',
      'summary',
      '[contenteditable=""]',
      '[contenteditable="true"]',
      '[role="button"]',
      '[role="link"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[role="switch"]',
      '[role="tab"]',
      '[role="menuitem"]',
      '[role="textbox"]',
      '[role="combobox"]',
      '[role="option"]',
      '[onclick]',
      '[ondblclick]',
      '[onmousedown]',
      '[onmouseup]',
      '[onmouseover]',
      '[onmouseenter]',
      '[onpointerdown]',
      '[onpointerup]',
    ].join(', ');

    function isVisible(el: Element): boolean {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden';
    }

    function isClickableAncestor(el: Element): boolean {
      const style = window.getComputedStyle(el);
      return (
        el.hasAttribute('onclick') ||
        el.hasAttribute('ondblclick') ||
        el.hasAttribute('onmousedown') ||
        el.hasAttribute('onmouseup') ||
        el.hasAttribute('onmouseover') ||
        el.hasAttribute('onmouseenter') ||
        el.hasAttribute('onpointerdown') ||
        el.hasAttribute('onpointerup') ||
        style.cursor === 'pointer' ||
        style.cursor === 'copy' ||
        el.hasAttribute('data-toggle')
      );
    }

    function bestTarget(el: Element): Element {
      let current: Element | null = el;
      let best = el;

      while (current && current !== document.body) {
        const parent: HTMLElement | null = current.parentElement;
        if (!parent) break;
        if (!isClickableAncestor(parent)) break;

        const currentRect = current.getBoundingClientRect();
        const parentRect = parent.getBoundingClientRect();
        const currentArea = currentRect.width * currentRect.height;
        const parentArea = parentRect.width * parentRect.height;

        if (parentArea > currentArea * 6) break;
        best = parent;
        current = parent;
      }

      return best;
    }

    function shouldKeepExactInteractiveTarget(el: Element): boolean {
      return el.matches(
        [
          'a[href]',
          'button',
          'input:not([type="hidden"])',
          'select',
          'textarea',
          'summary',
          '[contenteditable=""]',
          '[contenteditable="true"]',
          '[role="button"]',
          '[role="link"]',
          '[role="checkbox"]',
          '[role="radio"]',
          '[role="switch"]',
          '[role="tab"]',
          '[role="menuitem"]',
          '[role="textbox"]',
          '[role="combobox"]',
          '[role="option"]',
        ].join(', ')
      );
    }

    const entries: Array<DomSnapshotEntry> = [];
    const seen = new Set<Element>();
    let idx = 0;

    function pushEntry(el: Element, sourceHint?: string) {
      if (seen.has(el)) return;
      seen.add(el);

      const rect = el.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) return;

      const uid = `tmnc-${idx++}`;
      el.setAttribute('data-tmnc-id', uid);

      const tagName = el.tagName;
      const role = el.getAttribute('role') || undefined;
      const ariaLabel = el.getAttribute('aria-label') || '';
      const textContent = el.textContent?.trim().slice(0, 80) || '';
      const name = ariaLabel || textContent;
      const href = el.getAttribute('href') || undefined;
      const inputType =
        el instanceof HTMLInputElement ? el.type || undefined : undefined;
      const hints: string[] = [];

      if (el.matches('a[href]')) hints.push('anchor');
      if (el.matches('button')) hints.push('button');
      if (el.matches('input:not([type="hidden"])')) hints.push('input');
      if (el.matches('select')) hints.push('select');
      if (el.matches('textarea')) hints.push('textarea');
      if (el.matches('summary')) hints.push('summary');
      if (el.matches('[contenteditable=""], [contenteditable="true"]')) {
        hints.push('contenteditable');
      }
      if (role) hints.push(`role:${role}`);
      if (sourceHint) hints.push(sourceHint);
      if (
        el.hasAttribute('onclick') ||
        el.hasAttribute('ondblclick') ||
        el.hasAttribute('onmousedown') ||
        el.hasAttribute('onmouseup') ||
        el.hasAttribute('onmouseover') ||
        el.hasAttribute('onmouseenter') ||
        el.hasAttribute('onpointerdown') ||
        el.hasAttribute('onpointerup')
      ) {
        hints.push('mouse-handler');
      }

      entries.push({
        selector: `[data-tmnc-id="${uid}"]`,
        tagName,
        role,
        inputType,
        accessibleName: name || undefined,
        textContent: textContent || undefined,
        href,
        disabled:
          (el instanceof HTMLButtonElement ||
            el instanceof HTMLInputElement ||
            el instanceof HTMLSelectElement ||
            el instanceof HTMLTextAreaElement) &&
          el.disabled,
        visible: isVisible(el),
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        attributes: {},
        sourceHints: hints,
      });
    }

    document.querySelectorAll(BASE_SELECTOR).forEach(sourceEl => {
      if (shouldKeepExactInteractiveTarget(sourceEl)) {
        pushEntry(sourceEl, 'exact-target');
      } else {
        const promotedTarget = bestTarget(sourceEl);
        if (promotedTarget !== sourceEl) {
          pushEntry(sourceEl, 'source-target');
          pushEntry(promotedTarget, 'promoted-target');
        } else {
          pushEntry(sourceEl, 'source-target');
        }
      }
    });

    return entries;
  });

  return ((rawItems as DomSnapshotEntry[]) || []).filter(Boolean);
}
