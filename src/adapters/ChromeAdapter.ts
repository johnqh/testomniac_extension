import type { BrowserAdapter } from '@sudobility/testomniac_runner_service';

const REPLAY_SELECTOR_PREFIX = 'tmnc-replay:';

function logAdapter(step: string, details?: Record<string, unknown>): void {
  console.log('[ChromeAdapter]', step, details ?? {});
}

/**
 * Chrome extension adapter implementing BrowserAdapter.
 * Uses chrome.tabs, chrome.scripting, and chrome.debugger APIs.
 */
export class ChromeAdapter implements BrowserAdapter {
  readonly tabId: number;
  private currentUrl: string = '';
  private debuggerAttached: boolean = false;
  private markerVisible: boolean = false;
  private debuggerEventsBound: boolean = false;
  private consoleHandlers = new Set<(...args: unknown[]) => void>();
  private responseHandlers = new Set<(...args: unknown[]) => void>();
  private requestMetadata = new Map<string, { method: string; url: string }>();
  private consoleLogBuffer: string[] = [];
  private networkLogBuffer: Array<{
    method: string;
    url: string;
    status: number;
    contentType: string;
  }> = [];

  constructor(tabId: number) {
    this.tabId = tabId;
  }

  private async materializeSelector(selector: string): Promise<string> {
    if (!selector.startsWith(REPLAY_SELECTOR_PREFIX)) {
      return selector;
    }

    await this.ensureAccessiblePage();
    const token = `tmnc-replay-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: this.tabId },
      func: (rawSelector: string, replayToken: string, prefix: string) => {
        const normalize = (value: string | null | undefined) =>
          (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
        const isVisible = (el: Element) => {
          if (!(el instanceof HTMLElement)) return false;
          const rect = el.getBoundingClientRect();
          return !el.hidden && rect.width > 0 && rect.height > 0;
        };
        const params = new URLSearchParams(rawSelector.slice(prefix.length));
        const spec = {
          css: params.get('css')?.trim() || '',
          tagName: params.get('tagName')?.trim() || '',
          role: params.get('role')?.trim() || '',
          inputType: params.get('inputType')?.trim() || '',
          accessibleName: params.get('accessibleName')?.trim() || '',
          textContent: params.get('textContent')?.trim() || '',
          href: params.get('href')?.trim() || '',
          testId: params.get('testId')?.trim() || '',
          id: params.get('id')?.trim() || '',
          name: params.get('name')?.trim() || '',
          placeholder: params.get('placeholder')?.trim() || '',
        };
        const mark = (el: Element | null) => {
          if (!(el instanceof HTMLElement)) return null;
          el.setAttribute('data-tmnc-replay-target', replayToken);
          return `[data-tmnc-replay-target="${replayToken}"]`;
        };

        if (spec.css) {
          const match = document.querySelector(spec.css);
          if (match && isVisible(match)) return mark(match);
        }

        for (const testSelector of spec.testId
          ? [
              `[data-testid="${spec.testId}"]`,
              `[data-test-id="${spec.testId}"]`,
              `[data-test="${spec.testId}"]`,
            ]
          : []) {
          const match = document.querySelector(testSelector);
          if (match && isVisible(match)) return mark(match);
        }

        if (spec.id) {
          const match = document.getElementById(spec.id);
          if (match && isVisible(match)) return mark(match);
        }

        const candidates = Array.from(
          document.querySelectorAll(spec.tagName || '*')
        );
        const match = candidates.find(candidate => {
          if (!isVisible(candidate)) return false;
          if (
            spec.role &&
            normalize(candidate.getAttribute('role')) !== normalize(spec.role)
          ) {
            const tagName = candidate.tagName.toLowerCase();
            const roleMatchesImplicitTag =
              (spec.role === 'link' && tagName === 'a') ||
              (spec.role === 'button' && tagName === 'button');
            if (!roleMatchesImplicitTag) return false;
          }
          if (
            spec.inputType &&
            normalize((candidate as HTMLInputElement).type) !==
              normalize(spec.inputType)
          ) {
            return false;
          }
          if (
            spec.href &&
            normalize(candidate.getAttribute('href')) !== normalize(spec.href)
          ) {
            return false;
          }
          if (
            spec.name &&
            normalize(candidate.getAttribute('name')) !== normalize(spec.name)
          ) {
            return false;
          }
          if (
            spec.placeholder &&
            normalize(candidate.getAttribute('placeholder')) !==
              normalize(spec.placeholder)
          ) {
            return false;
          }

          // Gather all accessible name sources for the candidate
          const labelledById = candidate.getAttribute('aria-labelledby');
          const labelledByText = labelledById
            ? normalize(
                labelledById
                  .split(/\s+/)
                  .map(refId => document.getElementById(refId)?.textContent)
                  .filter(Boolean)
                  .join(' ')
              )
            : '';
          const associatedLabel =
            candidate instanceof HTMLElement && 'labels' in candidate
              ? normalize(
                  Array.from((candidate as HTMLInputElement).labels ?? [])
                    .map(l => l.textContent)
                    .join(' ')
                )
              : '';
          const candidateNames = [
            normalize(candidate.getAttribute('aria-label')),
            labelledByText,
            associatedLabel,
            normalize(candidate.getAttribute('title')),
            normalize(candidate.textContent),
          ].filter(Boolean);

          const expectedNames = [
            normalize(spec.accessibleName),
            normalize(spec.textContent),
          ].filter(Boolean);
          return (
            expectedNames.length === 0 ||
            expectedNames.some(expected =>
              candidateNames.some(
                name =>
                  name === expected ||
                  name.includes(expected) ||
                  expected.includes(name)
              )
            )
          );
        });

        return mark(match ?? null);
      },
      args: [selector, token, REPLAY_SELECTOR_PREFIX],
    });

    return result?.result || selector;
  }

  async goto(
    url: string,
    options?: { waitUntil?: string; timeout?: number }
  ): Promise<void> {
    await this.ensureDebugger();
    await chrome.tabs.update(this.tabId, { url });
    await this.waitForTabLoad(options?.timeout || 30000);
    this.currentUrl = (await chrome.tabs.get(this.tabId)).url || url;
  }

  async click(selector: string, options?: { timeout?: number }): Promise<void> {
    const resolvedSelector = await this.materializeSelector(selector);
    const found = await this.waitForSelector(resolvedSelector, {
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
      args: [resolvedSelector],
    });

    if (result?.result) {
      const { x, y } = result.result;
      await this.withInteractionMarker(resolvedSelector, 'click', async () => {
        await this.ensureDebugger();

        // Dispatch CDP mouse events (with pointerType for proper click synthesis)
        try {
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
        } catch (err) {
          // Click may have triggered navigation that destroyed the frame.
          // Wait for the page to settle and re-establish the debugger.
          logAdapter('click:navigation-recovery', {
            tabId: this.tabId,
            error: err instanceof Error ? err.message : String(err),
          });
          this.debuggerAttached = false;
          await this.waitForTabLoad(5000);
          await this.ensureAccessiblePage();
          await this.ensureDebugger();
        }
      });
      return;
    }
    throw new Error(`Could not resolve clickable point for ${selector}`);
  }

  async hover(selector: string, options?: { timeout?: number }): Promise<void> {
    const resolvedSelector = await this.materializeSelector(selector);
    const found = await this.waitForSelector(resolvedSelector, {
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
      args: [resolvedSelector],
    });

    if (result?.result) {
      const { x, y } = result.result;
      await this.withInteractionMarker(resolvedSelector, 'hover', async () => {
        await this.ensureDebugger();
        // Move mouse to element (triggers mouseenter + mouseover on the page)
        await chrome.debugger.sendCommand(
          { tabId: this.tabId },
          'Input.dispatchMouseEvent',
          { type: 'mouseMoved', x, y }
        );
      });
      return;
    }

    throw new Error(`Could not resolve hover point for ${selector}`);
  }

  async type(selector: string, text: string): Promise<void> {
    const resolvedSelector = await this.materializeSelector(selector);
    await this.withInteractionMarker(resolvedSelector, 'input', async () => {
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
        args: [resolvedSelector, text],
      });
    });
  }

  async submitTextEntry(selector: string): Promise<void> {
    const resolvedSelector = await this.materializeSelector(selector);
    await this.withInteractionMarker(resolvedSelector, 'keyboard', async () => {
      await chrome.scripting.executeScript({
        target: { tabId: this.tabId },
        func: (sel: string) => {
          const el = document.querySelector(sel) as HTMLElement | null;
          if (!el) return;
          el.focus();
        },
        args: [resolvedSelector],
      });
      await this.pressKey('Enter');
    });
  }

  async waitForSelector(
    selector: string,
    options?: { visible?: boolean; timeout?: number }
  ): Promise<boolean> {
    const resolvedSelector = await this.materializeSelector(selector);
    const timeout = options?.timeout || 5000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      await this.ensureAccessiblePage();
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
        args: [resolvedSelector, options?.visible ?? false],
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
    await this.ensureAccessiblePage();
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
    await this.ensureAccessiblePage();
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
    await this.ensureAccessiblePage();
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
    await this.withActiveElementMarker('keyboard', async () => {
      await this.ensureAccessiblePage();
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
    });
  }

  async select(selector: string, value: string): Promise<void> {
    const resolvedSelector = await this.materializeSelector(selector);
    await this.withInteractionMarker(resolvedSelector, 'select', async () => {
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
        args: [resolvedSelector, value],
      });
    });
  }

  async close(): Promise<void> {
    if (this.debuggerAttached) {
      try {
        await chrome.debugger.detach({ tabId: this.tabId });
      } catch (err) {
        // Already detached
        logAdapter('debugger-detach:skipped', {
          tabId: this.tabId,
          error: String(err),
        });
      }
      this.debuggerAttached = false;
    }
    this.requestMetadata.clear();
    await chrome.tabs.remove(this.tabId);
  }

  on(
    event: 'console' | 'response',
    handler: (...args: unknown[]) => void
  ): () => void {
    if (event === 'console') {
      this.consoleHandlers.add(handler);
      void this.ensureDebugger();
      return () => {
        this.consoleHandlers.delete(handler);
      };
    }

    this.responseHandlers.add(handler);
    void this.ensureDebugger();
    return () => {
      this.responseHandlers.delete(handler);
    };
  }

  getRuntimeArtifacts() {
    return {
      consoleLogs: [...this.consoleLogBuffer],
      networkLogs: [...this.networkLogBuffer],
    };
  }

  resetRuntimeArtifacts(): void {
    this.consoleLogBuffer = [];
    this.networkLogBuffer = [];
  }

  // --- Private helpers ---

  /**
   * Verify the tab is not on a browser-internal page that
   * chrome.scripting.executeScript cannot access (chrome-extension:// of
   * another extension, chrome://, devtools://, etc.).
   *
   * Uses a blocklist so that about:blank, data:, http(s):, file: and other
   * scriptable URLs are not rejected.
   */
  private async ensureAccessiblePage(): Promise<void> {
    const tab = await chrome.tabs.get(this.tabId);
    const url = tab.url || '';
    if (
      url.startsWith('chrome-extension://') ||
      url.startsWith('chrome://') ||
      url.startsWith('chrome-error://') ||
      url.startsWith('devtools://')
    ) {
      throw new Error(
        `Cannot access a non-web page (${url}), skipping interaction`
      );
    }
  }

  private async ensureDebugger(): Promise<void> {
    if (this.debuggerAttached) {
      this.bindDebuggerEvents();
      return;
    }
    try {
      await chrome.debugger.attach({ tabId: this.tabId }, '1.3');
      this.debuggerAttached = true;
    } catch (err) {
      // May already be attached
      logAdapter('debugger-attach:skipped', {
        tabId: this.tabId,
        error: String(err),
      });
      this.debuggerAttached = true;
    }
    this.bindDebuggerEvents();
    await chrome.debugger.sendCommand({ tabId: this.tabId }, 'Runtime.enable');
    await chrome.debugger.sendCommand({ tabId: this.tabId }, 'Log.enable');
    await chrome.debugger.sendCommand({ tabId: this.tabId }, 'Network.enable');
    await chrome.debugger.sendCommand({ tabId: this.tabId }, 'Page.enable');
  }

  private bindDebuggerEvents(): void {
    if (this.debuggerEventsBound) return;
    this.debuggerEventsBound = true;

    chrome.debugger.onEvent.addListener((source, method, params) => {
      if (source.tabId !== this.tabId) {
        return;
      }

      if (method === 'Runtime.consoleAPICalled') {
        const payload = params as {
          type?: string;
          args?: Array<{ value?: unknown; description?: string }>;
        };
        const parts = (payload.args ?? []).map(arg => {
          if (arg.value != null) return String(arg.value);
          if (arg.description) return arg.description;
          return '';
        });
        const message = [payload.type, ...parts]
          .filter(Boolean)
          .join(': ')
          .trim();
        if (message) {
          this.consoleLogBuffer.push(message);
          for (const handler of this.consoleHandlers) {
            handler(message);
          }
        }
        return;
      }

      if (method === 'Log.entryAdded') {
        const payload = params as {
          entry?: {
            level?: string;
            text?: string;
            url?: string;
          };
        };
        const text = payload.entry?.text?.trim();
        if (text) {
          const prefix = payload.entry?.level ? `${payload.entry.level}: ` : '';
          const suffix = payload.entry?.url ? ` (${payload.entry.url})` : '';
          const message = `${prefix}${text}${suffix}`;
          this.consoleLogBuffer.push(message);
          for (const handler of this.consoleHandlers) {
            handler(message);
          }
        }
        return;
      }

      if (method === 'Network.requestWillBeSent') {
        const payload = params as {
          requestId?: string;
          request?: {
            method?: string;
            url?: string;
          };
        };
        if (payload.requestId && payload.request) {
          this.requestMetadata.set(payload.requestId, {
            method: payload.request.method || 'GET',
            url: payload.request.url || '',
          });
        }
        return;
      }

      if (method === 'Network.responseReceived') {
        const payload = params as {
          requestId?: string;
          response?: {
            url?: string;
            status?: number;
            mimeType?: string;
          };
        };
        if (!payload.requestId || !payload.response) {
          return;
        }
        const request = this.requestMetadata.get(payload.requestId);
        const entry = {
          method: request?.method || 'GET',
          url: payload.response.url || request?.url || '',
          status: payload.response.status || 0,
          contentType: payload.response.mimeType || '',
          timestampMs: Date.now(),
        };
        this.networkLogBuffer.push(entry);
        for (const handler of this.responseHandlers) {
          handler(entry);
        }
        return;
      }

      if (
        method === 'Network.loadingFailed' ||
        method === 'Network.loadingFinished'
      ) {
        const payload = params as { requestId?: string };
        if (payload.requestId) {
          this.requestMetadata.delete(payload.requestId);
        }
      }
    });
  }

  private async withInteractionMarker<T>(
    selector: string,
    mode: 'hover' | 'click' | 'input' | 'keyboard' | 'select',
    action: () => Promise<T>
  ): Promise<T> {
    await this.showInteractionMarker(selector, mode);
    try {
      return await action();
    } finally {
      await this.hideInteractionMarker();
    }
  }

  private async withActiveElementMarker<T>(
    mode: 'keyboard' | 'input' | 'select',
    action: () => Promise<T>
  ): Promise<T> {
    let selector: string | null = null;
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: this.tabId },
        func: () => {
          const active = document.activeElement as HTMLElement | null;
          if (!active) return null;
          if (active === document.body || active === document.documentElement) {
            return null;
          }
          if (active.hasAttribute('data-tmnc-id')) {
            return `[data-tmnc-id="${active.getAttribute('data-tmnc-id')}"]`;
          }
          if (active.id) {
            const cssEscape = globalThis.CSS?.escape?.bind(globalThis.CSS);
            if (!cssEscape) {
              return null;
            }
            return `#${cssEscape(active.id)}`;
          }
          return null;
        },
      });
      selector = result?.result ?? null;
    } catch (err) {
      // Page may be on a non-scriptable URL — skip the marker and
      // let the action itself report the real error.
      logAdapter('active-element-marker:skipped', {
        tabId: this.tabId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (!selector) {
      return action();
    }

    return this.withInteractionMarker(selector, mode, action);
  }

  private async showInteractionMarker(
    selector: string,
    mode: 'hover' | 'click' | 'input' | 'keyboard' | 'select'
  ): Promise<void> {
    this.markerVisible = true;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: this.tabId },
        func: (
          sel: string,
          interaction: 'hover' | 'click' | 'input' | 'keyboard' | 'select'
        ) => {
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
            marker.style.borderRadius = '8px';
            marker.style.opacity = '1';
            marker.style.transition =
              'left 120ms ease-out, top 120ms ease-out, width 120ms ease-out, height 120ms ease-out, opacity 180ms ease-out, border-color 120ms ease-out, background 120ms ease-out';
            document.documentElement.appendChild(marker);
          }

          // Distinct colors by interaction type for quick visual scanning
          if (interaction === 'click') {
            marker.style.border = '2px solid rgba(245, 158, 11, 0.9)';
            marker.style.background = 'rgba(245, 158, 11, 0.2)';
          } else if (interaction === 'hover') {
            marker.style.border = '2px solid rgba(59, 130, 246, 0.9)';
            marker.style.background = 'rgba(59, 130, 246, 0.2)';
          } else if (interaction === 'select') {
            marker.style.border = '2px solid rgba(168, 85, 247, 0.9)';
            marker.style.background = 'rgba(168, 85, 247, 0.2)';
          } else {
            marker.style.border = '2px solid rgba(34, 197, 94, 0.9)';
            marker.style.background = 'rgba(34, 197, 94, 0.2)';
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
    } catch (err) {
      // Marker display is cosmetic — don't break the test if the page
      // is on a non-scriptable URL (e.g. chrome-extension://).
      logAdapter('show-marker:skipped', {
        tabId: this.tabId,
        error: err instanceof Error ? err.message : String(err),
      });
      this.markerVisible = false;
    }
  }

  private async hideInteractionMarker(): Promise<void> {
    if (!this.markerVisible) return;
    this.markerVisible = false;

    try {
      await chrome.scripting.executeScript({
        target: { tabId: this.tabId },
        func: () => {
          const marker = document.getElementById('__tmnc-interaction-marker');
          if (!marker) return;
          marker.style.opacity = '0';
          window.setTimeout(() => marker.remove(), 180);
        },
      });
    } catch (err) {
      // Marker cleanup is cosmetic — don't break the test if the page
      // navigated to a non-scriptable URL (e.g. chrome-extension://).
      logAdapter('hide-marker:skipped', {
        tabId: this.tabId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async closeOtherTabs(): Promise<void> {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const otherTabIds = tabs
      .filter(t => t.id !== this.tabId && t.id != null)
      .map(t => t.id!);
    if (otherTabIds.length > 0) {
      await chrome.tabs.remove(otherTabIds);
    }
    // Re-focus the original tab
    await chrome.tabs.update(this.tabId, { active: true });
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
