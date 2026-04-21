import type { BrowserAdapter } from '@sudobility/testomniac_scanning_service';

/**
 * Chrome extension adapter implementing BrowserAdapter.
 * Uses chrome.tabs, chrome.scripting, and chrome.debugger APIs.
 */
export class ChromeAdapter implements BrowserAdapter {
  readonly tabId: number;
  private currentUrl: string = '';
  private debuggerAttached: boolean = false;
  private markerVisible: boolean = false;

  constructor(tabId: number) {
    this.tabId = tabId;
  }

  async goto(
    url: string,
    options?: { waitUntil?: string; timeout?: number }
  ): Promise<void> {
    await chrome.tabs.update(this.tabId, { url });
    await this.waitForTabLoad(options?.timeout || 30000);
    this.currentUrl = (await chrome.tabs.get(this.tabId)).url || url;
  }

  async click(selector: string, options?: { timeout?: number }): Promise<void> {
    const found = await this.waitForSelector(selector, {
      visible: true,
      timeout: options?.timeout || 5000,
    });
    if (!found) throw new Error(`Element not found for click: ${selector}`);

    // Scroll into view and choose a point that is actually over the target.
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: this.tabId },
      func: (sel: string) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) return null;

        el.scrollIntoView({
          block: 'center',
          inline: 'center',
          behavior: 'instant',
        });

        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;

        const inset = 4;
        const left = Math.max(rect.left + inset, 0);
        const right = Math.min(rect.right - inset, window.innerWidth - 1);
        const top = Math.max(rect.top + inset, 0);
        const bottom = Math.min(rect.bottom - inset, window.innerHeight - 1);
        const centerX = Math.min(
          Math.max(rect.left + rect.width / 2, 0),
          window.innerWidth - 1
        );
        const centerY = Math.min(
          Math.max(rect.top + rect.height / 2, 0),
          window.innerHeight - 1
        );

        const candidates = [
          { x: centerX, y: centerY },
          { x: left, y: top },
          { x: right, y: top },
          { x: left, y: bottom },
          { x: right, y: bottom },
        ];

        for (const point of candidates) {
          const topEl = document.elementFromPoint(point.x, point.y);
          if (
            topEl &&
            (topEl === el || el.contains(topEl) || topEl.contains(el))
          ) {
            return { x: point.x, y: point.y };
          }
        }

        return {
          x: centerX,
          y: centerY,
          occludedBy:
            document
              .elementFromPoint(centerX, centerY)
              ?.tagName.toLowerCase() ?? 'unknown',
        };
      },
      args: [selector],
    });

    if (result?.result) {
      const { x, y } = result.result;
      await this.showInteractionMarker(selector, 'click');
      await this.ensureDebugger();

      // Dispatch CDP mouse events (with pointerType for proper click synthesis)
      await chrome.debugger.sendCommand(
        { tabId: this.tabId },
        'Input.dispatchMouseEvent',
        { type: 'mouseMoved', x, y, pointerType: 'mouse' }
      );
      await new Promise(r => setTimeout(r, 50));
      await chrome.debugger.sendCommand(
        { tabId: this.tabId },
        'Input.dispatchMouseEvent',
        {
          type: 'mousePressed',
          x,
          y,
          button: 'left',
          clickCount: 1,
          pointerType: 'mouse',
        }
      );
      await new Promise(r => setTimeout(r, 30));
      await chrome.debugger.sendCommand(
        { tabId: this.tabId },
        'Input.dispatchMouseEvent',
        {
          type: 'mouseReleased',
          x,
          y,
          button: 'left',
          clickCount: 1,
          pointerType: 'mouse',
        }
      );

      await this.hideInteractionMarker();

      return;
    }

    await this.hideInteractionMarker();
    throw new Error(`Could not resolve clickable point for ${selector}`);
  }

  async hover(selector: string, options?: { timeout?: number }): Promise<void> {
    const found = await this.waitForSelector(selector, {
      visible: true,
      timeout: options?.timeout || 5000,
    });
    if (!found) throw new Error(`Element not found for hover: ${selector}`);

    const [result] = await chrome.scripting.executeScript({
      target: { tabId: this.tabId },
      func: (sel: string) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) return null;
        el.scrollIntoView({
          block: 'center',
          inline: 'center',
          behavior: 'instant',
        });
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        const x = Math.min(
          Math.max(rect.left + rect.width / 2, 0),
          window.innerWidth - 1
        );
        const y = Math.min(
          Math.max(rect.top + rect.height / 2, 0),
          window.innerHeight - 1
        );
        return { x, y };
      },
      args: [selector],
    });

    if (result?.result) {
      const { x, y } = result.result;
      await this.showInteractionMarker(selector, 'hover');
      await this.ensureDebugger();
      // Move mouse to element (triggers mouseenter + mouseover on the page)
      await chrome.debugger.sendCommand(
        { tabId: this.tabId },
        'Input.dispatchMouseEvent',
        { type: 'mouseMoved', x, y }
      );
      return;
    }

    throw new Error(`Could not resolve hover point for ${selector}`);
  }

  async type(selector: string, text: string): Promise<void> {
    await chrome.scripting.executeScript({
      target: { tabId: this.tabId },
      func: (sel: string, val: string) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) return;
        el.focus();

        if (
          el instanceof HTMLInputElement ||
          el instanceof HTMLTextAreaElement
        ) {
          el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (el.isContentEditable) {
          el.textContent = val;
          el.dispatchEvent(
            new InputEvent('input', { bubbles: true, data: val })
          );
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }

        el.dispatchEvent(new Event('blur', { bubbles: true }));
      },
      args: [selector, text],
    });
  }

  async submitTextEntry(selector: string): Promise<void> {
    await chrome.scripting.executeScript({
      target: { tabId: this.tabId },
      func: (sel: string) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) return;
        el.focus();
      },
      args: [selector],
    });
    await this.pressKey('Enter');
  }

  async waitForSelector(
    selector: string,
    options?: { visible?: boolean; timeout?: number }
  ): Promise<boolean> {
    const timeout = options?.timeout || 5000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: this.tabId },
        func: (sel: string, checkVisible: boolean) => {
          const el = document.querySelector(sel);
          if (!el) return false;
          if (!checkVisible) return true;
          if (!(el instanceof HTMLElement)) return false;
          if (el.hidden) return false;
          if (el.closest('[hidden], [aria-hidden="true"], [inert]')) {
            return false;
          }
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            el.getClientRects().length > 0 &&
            style.display !== 'none' &&
            style.visibility === 'visible' &&
            style.pointerEvents !== 'none' &&
            Number(style.opacity) >= 0.05
          );
        },
        args: [selector, options?.visible ?? false],
      });
      if (result?.result) return true;
      await new Promise(r => setTimeout(r, 200));
    }
    return false;
  }

  async waitForNavigation(options?: {
    waitUntil?: string;
    timeout?: number;
  }): Promise<void> {
    await this.waitForTabLoad(options?.timeout || 5000);
  }

  async evaluate<T>(
    fn: string | ((...args: unknown[]) => T),
    ...args: unknown[]
  ): Promise<T> {
    const serializedArgs = args.map(arg => (arg === undefined ? null : arg));

    if (typeof fn === 'string') {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: this.tabId },
        func: new Function('return ' + fn) as () => T,
      });
      return result?.result as T;
    }
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: this.tabId },
      func: fn as (...args: unknown[]) => T,
      args: serializedArgs,
    });
    return result?.result as T;
  }

  async content(): Promise<string> {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: this.tabId },
      func: () => document.documentElement.outerHTML,
    });
    return result?.result || '';
  }

  async getUrl(): Promise<string> {
    const tab = await chrome.tabs.get(this.tabId);
    this.currentUrl = tab.url || this.currentUrl;
    return this.currentUrl;
  }

  url(): string {
    return this.currentUrl;
  }

  async screenshot(options?: {
    type?: string;
    quality?: number;
  }): Promise<Uint8Array> {
    await this.ensureDebugger();
    const result = (await chrome.debugger.sendCommand(
      { tabId: this.tabId },
      'Page.captureScreenshot',
      {
        format: (options?.type as 'jpeg' | 'png') || 'jpeg',
        quality: options?.quality || 72,
      }
    )) as { data?: string };

    const base64 = result.data || '';
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  async setViewport(width: number, height: number): Promise<void> {
    await this.ensureDebugger();
    await chrome.debugger.sendCommand(
      { tabId: this.tabId },
      'Emulation.setDeviceMetricsOverride',
      {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      }
    );
  }

  async pressKey(key: string): Promise<void> {
    await this.ensureDebugger();
    await chrome.debugger.sendCommand(
      { tabId: this.tabId },
      'Input.dispatchKeyEvent',
      {
        type: 'keyDown',
        key,
      }
    );
    await chrome.debugger.sendCommand(
      { tabId: this.tabId },
      'Input.dispatchKeyEvent',
      {
        type: 'keyUp',
        key,
      }
    );
  }

  async select(selector: string, value: string): Promise<void> {
    await chrome.scripting.executeScript({
      target: { tabId: this.tabId },
      func: (sel: string, val: string) => {
        const el = document.querySelector(sel) as HTMLSelectElement | null;
        if (!el) return;

        if (val.startsWith('__index__:')) {
          const index = Number(val.slice('__index__:'.length));
          if (
            Number.isFinite(index) &&
            index >= 0 &&
            index < el.options.length
          ) {
            el.selectedIndex = index;
          }
        } else {
          el.value = val;
          if (el.value !== val) {
            const option = Array.from(el.options).find(
              candidate => candidate.textContent?.trim() === val
            );
            if (option) {
              el.value = option.value;
            }
          }
        }

        el.dispatchEvent(new Event('change', { bubbles: true }));
      },
      args: [selector, value],
    });
  }

  async close(): Promise<void> {
    if (this.debuggerAttached) {
      try {
        await chrome.debugger.detach({ tabId: this.tabId });
      } catch {
        // Already detached
      }
      this.debuggerAttached = false;
    }
    await chrome.tabs.remove(this.tabId);
  }

  on(
    _event: 'console' | 'response',
    _handler: (...args: unknown[]) => void
  ): void {
    // Console and network monitoring would need CDP Runtime.enable / Network.enable
    // For now, these are no-ops — the content script handles error monitoring
  }

  // --- Private helpers ---

  private async ensureDebugger(): Promise<void> {
    if (this.debuggerAttached) return;
    try {
      await chrome.debugger.attach({ tabId: this.tabId }, '1.3');
      this.debuggerAttached = true;
    } catch {
      // May already be attached
      this.debuggerAttached = true;
    }
  }

  private async showInteractionMarker(
    selector: string,
    mode: 'hover' | 'click'
  ): Promise<void> {
    this.markerVisible = true;
    await chrome.scripting.executeScript({
      target: { tabId: this.tabId },
      func: (sel: string, interaction: 'hover' | 'click') => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) return;

        const rect = el.getBoundingClientRect();
        let marker = document.getElementById(
          '__tmnc-interaction-marker'
        ) as HTMLDivElement | null;
        if (!marker) {
          marker = document.createElement('div');
          marker.id = '__tmnc-interaction-marker';
          marker.style.position = 'fixed';
          marker.style.pointerEvents = 'none';
          marker.style.zIndex = '2147483647';
          marker.style.boxSizing = 'border-box';
          marker.style.border = '2px solid rgba(245, 158, 11, 0.9)';
          marker.style.background = 'rgba(245, 158, 11, 0.2)';
          marker.style.borderRadius = '8px';
          marker.style.opacity = '1';
          marker.style.transition =
            'left 120ms ease-out, top 120ms ease-out, width 120ms ease-out, height 120ms ease-out, opacity 180ms ease-out';
          document.documentElement.appendChild(marker);
        }

        marker.style.left = `${rect.left - 4}px`;
        marker.style.top = `${rect.top - 4}px`;
        marker.style.width = `${rect.width + 8}px`;
        marker.style.height = `${rect.height + 8}px`;
        marker.style.opacity = '1';
        marker.dataset.phase = interaction;
      },
      args: [selector, mode],
    });
  }

  private async hideInteractionMarker(): Promise<void> {
    if (!this.markerVisible) return;
    this.markerVisible = false;

    await chrome.scripting.executeScript({
      target: { tabId: this.tabId },
      func: () => {
        const marker = document.getElementById('__tmnc-interaction-marker');
        if (!marker) return;
        marker.style.opacity = '0';
        window.setTimeout(() => marker.remove(), 180);
      },
    });
  }

  private async waitForTabLoad(timeout: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const tab = await chrome.tabs.get(this.tabId);
      if (tab.status === 'complete') {
        this.currentUrl = tab.url || this.currentUrl;
        return;
      }
      await new Promise(r => setTimeout(r, 200));
    }
  }
}
