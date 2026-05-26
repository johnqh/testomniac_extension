import type { StorageAdapter } from '@sudobility/testomniac_lib';

export const chromeStorageAdapter: StorageAdapter = {
  async getItem(key: string): Promise<string | null> {
    const result = await chrome.storage.local.get([key]);
    return (result[key] as string) ?? null;
  },
  async setItem(key: string, value: string): Promise<void> {
    await chrome.storage.local.set({ [key]: value });
  },
};
