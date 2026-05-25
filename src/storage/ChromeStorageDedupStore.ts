import type { DedupStore } from '@sudobility/testomniac_runner_service';

const STORAGE_PREFIX = 'dedup:';

/**
 * DedupStore backed by chrome.storage.local.
 *
 * All data lives in chrome.storage.local — NOT in memory. Each `has()`
 * and `add()` call reads/writes storage directly. This keeps the
 * service worker's heap small regardless of how many dedup keys
 * accumulate during a long scan.
 *
 * A small write buffer batches `add()` calls to reduce storage I/O.
 * The buffer is flushed every 2 seconds or when it reaches 50 entries.
 */
export class ChromeStorageDedupStore implements DedupStore {
  private static readonly FLUSH_INTERVAL_MS = 2000;
  private static readonly FLUSH_BATCH_SIZE = 50;

  /** Pending adds not yet flushed to storage. Keyed by collection. */
  private pendingAdds = new Map<string, Set<string>>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  private storageKey(collection: string): string {
    return `${STORAGE_PREFIX}${collection}`;
  }

  async has(collection: string, key: string): Promise<boolean> {
    // Check pending adds first (not yet flushed to storage)
    if (this.pendingAdds.get(collection)?.has(key)) return true;

    // Read from storage
    const storageKey = this.storageKey(collection);
    const stored = await chrome.storage.local.get([storageKey]);
    const arr: string[] = Array.isArray(stored[storageKey])
      ? stored[storageKey]
      : [];
    return arr.includes(key);
  }

  async add(collection: string, key: string): Promise<void> {
    let pending = this.pendingAdds.get(collection);
    if (!pending) {
      pending = new Set();
      this.pendingAdds.set(collection, pending);
    }
    pending.add(key);

    // Flush if batch is large enough
    let totalPending = 0;
    for (const s of this.pendingAdds.values()) totalPending += s.size;
    if (totalPending >= ChromeStorageDedupStore.FLUSH_BATCH_SIZE) {
      await this.flush();
      return;
    }

    // Otherwise schedule a debounced flush
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flush();
      }, ChromeStorageDedupStore.FLUSH_INTERVAL_MS);
    }
  }

  private async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const entries = [...this.pendingAdds.entries()];
    this.pendingAdds.clear();
    if (entries.length === 0) return;

    // Read current values, merge pending, write back
    const keys = entries.map(([c]) => this.storageKey(c));
    const stored: Record<string, unknown> = await chrome.storage.local
      .get(keys)
      .catch(() => ({}) as Record<string, unknown>);
    const updates: Record<string, string[]> = {};

    for (const [collection, pending] of entries) {
      const storageKey = this.storageKey(collection);
      const raw = stored[storageKey];
      const existing: string[] = Array.isArray(raw) ? (raw as string[]) : [];
      const merged = new Set(existing);
      for (const k of pending) merged.add(k);
      updates[storageKey] = [...merged];
    }

    await chrome.storage.local.set(updates).catch(() => {
      // Best effort — storage may be full
    });
  }

  /** Clear all collections (call when starting a new scan). */
  async clear(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pendingAdds.clear();

    // Remove all dedup keys from storage
    const all = await chrome.storage.local.get(null);
    const dedupKeys = Object.keys(all).filter(k =>
      k.startsWith(STORAGE_PREFIX)
    );
    if (dedupKeys.length > 0) {
      await chrome.storage.local.remove(dedupKeys).catch(() => {});
    }
  }
}
