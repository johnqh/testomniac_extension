import type { BrowserAdapter } from "@sudobility/testomniac_scanning_service";

/**
 * Chrome extension adapter implementing BrowserAdapter.
 * Uses chrome.tabs, chrome.scripting, and chrome.debugger APIs.
 */
export class ChromeAdapter implements BrowserAdapter {
  private tabId: number;
  private currentUrl: string = "";
  private debuggerAttached: boolean = false;

  constructor(tabId: number) {
    this.tabId = tabId;
  }

  async goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<void> {
    await chrome.tabs.update(this.tabId, { url });
    await this.waitForTabLoad(options?.timeout || 30000);
    this.currentUrl = (await chrome.tabs.get(this.tabId)).url || url;
  }

  async click(selector: string, options?: { timeout?: number }): Promise<void> {
    const found = await this.waitForSelector(selector, { visible: true, timeout: options?.timeout || 5000 });
    if (!found) return;

    // Get element coordinates
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: this.tabId },
      func: (sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      },
      args: [selector],
    });

    if (result?.result) {
      // Use CDP for trusted click events
      await this.ensureDebugger();
      await chrome.debugger.sendCommand({ tabId: this.tabId }, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: result.result.x,
        y: result.result.y,
        button: "left",
        clickCount: 1,
      });
      await chrome.debugger.sendCommand({ tabId: this.tabId }, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: result.result.x,
        y: result.result.y,
        button: "left",
        clickCount: 1,
      });
    }
  }

  async hover(selector: string, options?: { timeout?: number }): Promise<void> {
    const found = await this.waitForSelector(selector, { visible: true, timeout: options?.timeout || 5000 });
    if (!found) return;

    const [result] = await chrome.scripting.executeScript({
      target: { tabId: this.tabId },
      func: (sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      },
      args: [selector],
    });

    if (result?.result) {
      await this.ensureDebugger();
      await chrome.debugger.sendCommand({ tabId: this.tabId }, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: result.result.x,
        y: result.result.y,
      });
    }
  }

  async type(selector: string, text: string): Promise<void> {
    await chrome.scripting.executeScript({
      target: { tabId: this.tabId },
      func: (sel: string, val: string) => {
        const el = document.querySelector(sel) as HTMLInputElement | null;
        if (!el) return;
        el.focus();
        el.value = val;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      },
      args: [selector, text],
    });
  }

  async waitForSelector(selector: string, options?: { visible?: boolean; timeout?: number }): Promise<boolean> {
    const timeout = options?.timeout || 5000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: this.tabId },
        func: (sel: string, checkVisible: boolean) => {
          const el = document.querySelector(sel);
          if (!el) return false;
          if (!checkVisible) return true;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
        },
        args: [selector, options?.visible ?? false],
      });
      if (result?.result) return true;
      await new Promise(r => setTimeout(r, 200));
    }
    return false;
  }

  async waitForNavigation(options?: { waitUntil?: string; timeout?: number }): Promise<void> {
    await this.waitForTabLoad(options?.timeout || 5000);
  }

  async evaluate<T>(fn: string | ((...args: unknown[]) => T), ...args: unknown[]): Promise<T> {
    if (typeof fn === "string") {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: this.tabId },
        func: new Function("return " + fn) as () => T,
      });
      return result?.result as T;
    }
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: this.tabId },
      func: fn as (...args: unknown[]) => T,
      args: args,
    });
    return result?.result as T;
  }

  async content(): Promise<string> {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: this.tabId },
      func: () => document.documentElement.outerHTML,
    });
    return result?.result || "";
  }

  url(): string {
    return this.currentUrl;
  }

  async screenshot(options?: { type?: string; quality?: number }): Promise<Uint8Array> {
    const dataUrl = await chrome.tabs.captureVisibleTab({
      format: (options?.type as "jpeg" | "png") || "jpeg",
      quality: options?.quality || 72,
    });
    // Convert data URL to Uint8Array
    const base64 = dataUrl.split(",")[1];
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  async setViewport(width: number, height: number): Promise<void> {
    await this.ensureDebugger();
    await chrome.debugger.sendCommand({ tabId: this.tabId }, "Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  async pressKey(key: string): Promise<void> {
    await this.ensureDebugger();
    await chrome.debugger.sendCommand({ tabId: this.tabId }, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
    });
    await chrome.debugger.sendCommand({ tabId: this.tabId }, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
    });
  }

  async select(selector: string, value: string): Promise<void> {
    await chrome.scripting.executeScript({
      target: { tabId: this.tabId },
      func: (sel: string, val: string) => {
        const el = document.querySelector(sel) as HTMLSelectElement | null;
        if (!el) return;
        el.value = val;
        el.dispatchEvent(new Event("change", { bubbles: true }));
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

  on(_event: "console" | "response", _handler: (...args: unknown[]) => void): void {
    // Console and network monitoring would need CDP Runtime.enable / Network.enable
    // For now, these are no-ops — the content script handles error monitoring
  }

  // --- Private helpers ---

  private async ensureDebugger(): Promise<void> {
    if (this.debuggerAttached) return;
    try {
      await chrome.debugger.attach({ tabId: this.tabId }, "1.3");
      this.debuggerAttached = true;
    } catch {
      // May already be attached
      this.debuggerAttached = true;
    }
  }

  private async waitForTabLoad(timeout: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const tab = await chrome.tabs.get(this.tabId);
      if (tab.status === "complete") {
        this.currentUrl = tab.url || this.currentUrl;
        return;
      }
      await new Promise(r => setTimeout(r, 200));
    }
  }
}
