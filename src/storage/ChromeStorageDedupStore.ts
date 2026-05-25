import type { DedupStore } from '@sudobility/testomniac_runner_service';

const STORAGE_PREFIX = 'dedup:';

/**
 * DedupStore backed by chrome.storage.local.
 *
 * Collections are stored as objects (`{ key: 1 }`) for O(1) lookups.
 * Writes are batched in a small pending buffer and flushed every 2s
 * or when the buffer reaches 50 entries.
 */
export class ChromeStorageDedupStore implements DedupStore {
  private static readonly FLUSH_INTERVAL_MS = 2000;
  private static readonly FLUSH_BATCH_SIZE = 50;

  private pendingAdds = new Map<string, Set<string>>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  private storageKey(collection: string): string {
    return `${STORAGE_PREFIX}${collection}`;
  }

  async has(collection: string, key: string): Promise<boolean> {
    // Check pending buffer first
    if (this.pendingAdds.get(collection)?.has(key)) return true;

    // O(1) property lookup on the stored object
    const sk = this.storageKey(collection);
    const stored = await chrome.storage.local.get([sk]);
    const obj = stored[sk];
    return (
      obj != null &&
      typeof obj === 'object' &&
      (obj as Record<string, number>)[key] === 1
    );
  }

  async add(collection: string, key: string): Promise<void> {
    let pending = this.pendingAdds.get(collection);
    if (!pending) {
      pending = new Set();
      this.pendingAdds.set(collection, pending);
    }
    pending.add(key);

    let total = 0;
    for (const s of this.pendingAdds.values()) total += s.size;
    if (total >= ChromeStorageDedupStore.FLUSH_BATCH_SIZE) {
      await this.flush();
      return;
    }

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

    const keys = entries.map(([c]) => this.storageKey(c));
    const stored: Record<string, unknown> = await chrome.storage.local
      .get(keys)
      .catch(() => ({}) as Record<string, unknown>);
    const updates: Record<string, Record<string, number>> = {};

    for (const [collection, pending] of entries) {
      const sk = this.storageKey(collection);
      const existing =
        stored[sk] != null && typeof stored[sk] === 'object'
          ? (stored[sk] as Record<string, number>)
          : {};
      const merged = { ...existing };
      for (const k of pending) merged[k] = 1;
      updates[sk] = merged;
    }

    await chrome.storage.local.set(updates).catch(() => {});
  }

  async clear(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pendingAdds.clear();

    const all = await chrome.storage.local.get(null);
    const dedupKeys = Object.keys(all).filter(k =>
      k.startsWith(STORAGE_PREFIX)
    );
    if (dedupKeys.length > 0) {
      await chrome.storage.local.remove(dedupKeys).catch(() => {});
    }
  }
}
