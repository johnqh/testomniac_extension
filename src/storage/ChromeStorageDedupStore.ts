import type { DedupStore } from '@sudobility/testomniac_runner_service';

const STORAGE_PREFIX = 'dedup:';

/**
 * DedupStore backed by chrome.storage.local.
 *
 * Each collection is stored as a single key whose value is an array of
 * strings.  This keeps dedup data out of the service worker's heap and
 * survives worker restarts.
 *
 * Reads are cached in-memory per collection on first access, then kept
 * in sync via writes.  This avoids a storage round-trip on every `has`
 * call while still persisting for crash recovery.
 */
export class ChromeStorageDedupStore implements DedupStore {
  private cache = new Map<string, Set<string>>();
  private loaded = new Set<string>();
  private flushTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private storageKey(collection: string): string {
    return `${STORAGE_PREFIX}${collection}`;
  }

  private async ensureLoaded(collection: string): Promise<Set<string>> {
    let set = this.cache.get(collection);
    if (set && this.loaded.has(collection)) return set;

    const key = this.storageKey(collection);
    const stored = await chrome.storage.local.get([key]);
    const arr: string[] = Array.isArray(stored[key]) ? stored[key] : [];
    set = new Set(arr);
    this.cache.set(collection, set);
    this.loaded.add(collection);
    return set;
  }

  /** Schedule a debounced flush to storage (max 2s delay). */
  private scheduleFlush(collection: string): void {
    if (this.flushTimers.has(collection)) return;
    const timer = setTimeout(() => {
      this.flushTimers.delete(collection);
      const set = this.cache.get(collection);
      if (!set) return;
      const key = this.storageKey(collection);
      chrome.storage.local.set({ [key]: [...set] }).catch(() => {
        // Best effort — storage may be full
      });
    }, 2000);
    this.flushTimers.set(collection, timer);
  }

  async has(collection: string, key: string): Promise<boolean> {
    const set = await this.ensureLoaded(collection);
    return set.has(key);
  }

  async add(collection: string, key: string): Promise<void> {
    const set = await this.ensureLoaded(collection);
    set.add(key);
    this.scheduleFlush(collection);
  }

  /** Clear all collections (call when starting a new scan). */
  async clear(): Promise<void> {
    const keys = [...this.cache.keys()].map(c => this.storageKey(c));
    this.cache.clear();
    this.loaded.clear();
    for (const t of this.flushTimers.values()) clearTimeout(t);
    this.flushTimers.clear();
    if (keys.length > 0) {
      await chrome.storage.local.remove(keys).catch(() => {});
    }
  }
}
