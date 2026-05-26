# Entity Manager & ScanMode Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two bugs — workspace selector empty after db:reset (missing retry) and scanMode resetting to 'full' on side panel reopen (no persistence) — by adding proper business logic to the shared library stack.

**Architecture:** Add `getEntities()` to testomniac_client, create `useEntities` TanStack Query hook in testomniac_client, create `useEntityManager` orchestration hook in testomniac_lib (with retry-on-empty), create `usePersistedState` hook in testomniac_lib (storage-adapter pattern for cross-platform persistence). Wire up testomniac_extension SidePanel to consume these hooks instead of raw fetch + local state.

**Tech Stack:** TypeScript, React 18, TanStack Query 5, Zustand 5, Vitest, `@sudobility/types` NetworkClient

---

## File Map

### testomniac_client (3 files changed, 1 created)

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `src/network/TestomniacClient.ts` | Add `getEntities()` method |
| Modify | `src/types.ts` | Add `entities` query key to `QUERY_KEYS` |
| Create | `src/hooks/useEntities.ts` | TanStack Query hook wrapping `getEntities()` |
| Modify | `src/hooks/index.ts` | Export `useEntities` |

### testomniac_lib (3 files created, 2 modified)

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/business/hooks/useEntityManager.ts` | Orchestrates entity fetching with retry-on-empty |
| Create | `src/business/hooks/usePersistedState.ts` | Generic persisted state hook with storage adapter |
| Create | `src/business/hooks/__tests__/usePersistedState.test.ts` | Tests for persistence hook |
| Modify | `src/business/hooks/index.ts` | Export new hooks |
| Modify | `src/business/index.ts` | Re-export if needed |

### testomniac_extension (1 file modified)

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `src/sidepanel/SidePanel.tsx` | Replace raw entity fetch with `useEntityManager`, replace `useState` scanMode with `usePersistedState` |

---

## Task 1: Add `getEntities()` to TestomniacClient

**Files:**
- Modify: `/Users/johnhuang/projects/testomniac_client/src/network/TestomniacClient.ts`
- Modify: `/Users/johnhuang/projects/testomniac_client/src/types.ts`

- [ ] **Step 1: Add `entities` query key to QUERY_KEYS**

In `/Users/johnhuang/projects/testomniac_client/src/types.ts`, add after the `user` key (line ~197):

```typescript
entities: () => ['testomniac', 'entities'] as const,
```

- [ ] **Step 2: Add `getEntities()` method to TestomniacClient**

In `/Users/johnhuang/projects/testomniac_client/src/network/TestomniacClient.ts`, add near the entity-related methods (after `getUser`, before `getEntityProducts`). The method follows the same pattern as `getEntityProducts`:

```typescript
async getEntities(
  token: FirebaseIdToken
): Promise<BaseResponse<EntityWithRole[]>> {
  const url = buildUrl(this.baseUrl, '/api/v1/entities');
  const response = await this.networkClient.get(url, {
    headers: createAuthHeaders(token),
  });
  return validateResponse<EntityWithRole[]>(response.data, 'getEntities');
}
```

Add `EntityWithRole` to the imports from `@sudobility/testomniac_types` at the top of the file. If `EntityWithRole` is not re-exported from `testomniac_types`, import it from `@sudobility/types` directly.

- [ ] **Step 3: Verify types compile**

Run: `cd /Users/johnhuang/projects/testomniac_client && bun run typecheck`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
cd /Users/johnhuang/projects/testomniac_client
git add src/network/TestomniacClient.ts src/types.ts
git commit -m "feat: add getEntities() method and query key"
```

---

## Task 2: Add `useEntities` hook to testomniac_client

**Files:**
- Create: `/Users/johnhuang/projects/testomniac_client/src/hooks/useEntities.ts`
- Modify: `/Users/johnhuang/projects/testomniac_client/src/hooks/index.ts`

- [ ] **Step 1: Create the `useEntities` hook**

Create `/Users/johnhuang/projects/testomniac_client/src/hooks/useEntities.ts`:

```typescript
import { useQuery } from '@tanstack/react-query';
import type { NetworkClient } from '@sudobility/types';
import { TestomniacClient } from '../network/TestomniacClient';
import { DEFAULT_STALE_TIME, type FirebaseIdToken, QUERY_KEYS } from '../types';

interface UseEntitiesConfig {
  networkClient: NetworkClient;
  baseUrl: string;
  token: FirebaseIdToken;
  enabled?: boolean;
}

export function useEntities(config: UseEntitiesConfig) {
  const { networkClient, baseUrl, token, enabled = true } = config;
  const client = new TestomniacClient({ baseUrl, networkClient });

  const query = useQuery({
    queryKey: QUERY_KEYS.entities(),
    queryFn: () => client.getEntities(token),
    enabled: enabled && !!token,
    staleTime: DEFAULT_STALE_TIME,
  });

  return {
    entities: query.data?.data ?? [],
    isLoading: query.isLoading,
    error: query.error?.message ?? query.data?.error ?? null,
    refetch: query.refetch,
  };
}
```

- [ ] **Step 2: Export the hook**

Add to `/Users/johnhuang/projects/testomniac_client/src/hooks/index.ts`:

```typescript
export { useEntities } from './useEntities';
```

- [ ] **Step 3: Verify types compile and tests pass**

Run: `cd /Users/johnhuang/projects/testomniac_client && bun run typecheck && bun run test`
Expected: All pass

- [ ] **Step 4: Build and commit**

```bash
cd /Users/johnhuang/projects/testomniac_client
bun run build
git add src/hooks/useEntities.ts src/hooks/index.ts
git commit -m "feat: add useEntities hook"
```

---

## Task 3: Add `usePersistedState` hook to testomniac_lib

**Files:**
- Create: `/Users/johnhuang/projects/testomniac_lib/src/business/hooks/usePersistedState.ts`
- Create: `/Users/johnhuang/projects/testomniac_lib/src/business/hooks/__tests__/usePersistedState.test.ts`

- [ ] **Step 1: Write the failing test**

Create `/Users/johnhuang/projects/testomniac_lib/src/business/hooks/__tests__/usePersistedState.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePersistedState } from '../usePersistedState';
import type { StorageAdapter } from '../usePersistedState';

function createMockStorage(initial: Record<string, string> = {}): StorageAdapter {
  const store = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    }),
  };
}

describe('usePersistedState', () => {
  it('returns defaultValue before storage loads', () => {
    const storage = createMockStorage();
    const { result } = renderHook(() =>
      usePersistedState('testKey', 'default', storage)
    );
    expect(result.current[0]).toBe('default');
  });

  it('loads persisted value from storage', async () => {
    const storage = createMockStorage({ testKey: JSON.stringify('saved') });
    const { result } = renderHook(() =>
      usePersistedState('testKey', 'default', storage)
    );
    // Wait for async load
    await vi.waitFor(() => {
      expect(result.current[0]).toBe('saved');
    });
  });

  it('persists value on set', async () => {
    const storage = createMockStorage();
    const { result } = renderHook(() =>
      usePersistedState('testKey', 'default', storage)
    );
    act(() => {
      result.current[1]('updated');
    });
    expect(result.current[0]).toBe('updated');
    await vi.waitFor(() => {
      expect(storage.setItem).toHaveBeenCalledWith(
        'testKey',
        JSON.stringify('updated')
      );
    });
  });

  it('validates loaded value and falls back to default', async () => {
    const storage = createMockStorage({ testKey: JSON.stringify('invalid') });
    const validate = (v: unknown): v is string =>
      typeof v === 'string' && ['a', 'b'].includes(v);
    const { result } = renderHook(() =>
      usePersistedState('testKey', 'a', storage, validate)
    );
    // Invalid value should not replace default
    await vi.waitFor(() => {
      expect(storage.getItem).toHaveBeenCalled();
    });
    expect(result.current[0]).toBe('a');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/johnhuang/projects/testomniac_lib && bun test src/business/hooks/__tests__/usePersistedState.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement usePersistedState**

Create `/Users/johnhuang/projects/testomniac_lib/src/business/hooks/usePersistedState.ts`:

```typescript
import { useState, useEffect, useCallback } from 'react';

/**
 * Platform-agnostic storage adapter.
 * - Browser: wrap localStorage
 * - Chrome extension: wrap chrome.storage.local
 */
export interface StorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/**
 * Like useState, but the value is loaded from and persisted to a StorageAdapter.
 * Accepts an optional validate function to guard against stale/invalid stored values.
 */
export function usePersistedState<T>(
  key: string,
  defaultValue: T,
  storage: StorageAdapter,
  validate?: (value: unknown) => value is T
): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(defaultValue);

  // Load from storage on mount
  useEffect(() => {
    let cancelled = false;
    storage.getItem(key).then(raw => {
      if (cancelled || raw == null) return;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (validate ? validate(parsed) : true) {
          setValue(parsed as T);
        }
      } catch {
        // Corrupted storage value — keep default
      }
    });
    return () => { cancelled = true; };
  }, [key, storage, validate]);

  // Persist on change
  const set = useCallback(
    (next: T) => {
      setValue(next);
      storage.setItem(key, JSON.stringify(next)).catch(() => {});
    },
    [key, storage]
  );

  return [value, set];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/johnhuang/projects/testomniac_lib && bun test src/business/hooks/__tests__/usePersistedState.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/johnhuang/projects/testomniac_lib
git add src/business/hooks/usePersistedState.ts src/business/hooks/__tests__/usePersistedState.test.ts
git commit -m "feat: add usePersistedState hook with StorageAdapter"
```

---

## Task 4: Add `useEntityManager` hook to testomniac_lib

**Files:**
- Create: `/Users/johnhuang/projects/testomniac_lib/src/business/hooks/useEntityManager.ts`
- Modify: `/Users/johnhuang/projects/testomniac_lib/src/business/hooks/index.ts`

- [ ] **Step 1: Create the useEntityManager hook**

Create `/Users/johnhuang/projects/testomniac_lib/src/business/hooks/useEntityManager.ts`:

```typescript
import { useEffect, useRef } from 'react';
import type { NetworkClient } from '@sudobility/types';
import type { FirebaseIdToken } from '@sudobility/testomniac_client';
import { useEntities } from '@sudobility/testomniac_client';

interface UseEntityManagerConfig {
  networkClient: NetworkClient;
  baseUrl: string;
  token: FirebaseIdToken;
  enabled?: boolean;
}

/**
 * Orchestrates entity (workspace) fetching with automatic retry when the list
 * comes back empty.  After a fresh database or first login the backend
 * auto-creates the user's personal workspace asynchronously — this hook
 * retries once after a short delay so the UI doesn't get stuck.
 */
export function useEntityManager(config: UseEntityManagerConfig) {
  const { networkClient, baseUrl, token, enabled = true } = config;

  const { entities, isLoading, error, refetch } = useEntities({
    networkClient,
    baseUrl,
    token,
    enabled,
  });

  // Retry once if entities come back empty (workspace may still be creating)
  const retried = useRef(false);
  useEffect(() => {
    if (isLoading || !enabled || retried.current) return;
    if (entities.length === 0 && !error) {
      retried.current = true;
      const timer = setTimeout(() => { void refetch(); }, 1500);
      return () => clearTimeout(timer);
    }
  }, [entities.length, isLoading, enabled, error, refetch]);

  // Reset retry flag when token changes (new login session)
  useEffect(() => {
    retried.current = false;
  }, [token]);

  return {
    entities,
    isLoading,
    error,
    refetchEntities: refetch,
  };
}
```

- [ ] **Step 2: Export the new hooks**

Update `/Users/johnhuang/projects/testomniac_lib/src/business/hooks/index.ts` — add:

```typescript
export { useEntityManager } from './useEntityManager';
export { usePersistedState } from './usePersistedState';
export type { StorageAdapter } from './usePersistedState';
```

- [ ] **Step 3: Verify types compile and all tests pass**

Run: `cd /Users/johnhuang/projects/testomniac_lib && bun run typecheck && bun test`
Expected: All pass

- [ ] **Step 4: Build and commit**

```bash
cd /Users/johnhuang/projects/testomniac_lib
bun run build
git add src/business/hooks/useEntityManager.ts src/business/hooks/usePersistedState.ts src/business/hooks/__tests__/usePersistedState.test.ts src/business/hooks/index.ts
git commit -m "feat: add useEntityManager (retry-on-empty) and usePersistedState hooks"
```

---

## Task 5: Wire up testomniac_extension SidePanel

**Files:**
- Modify: `/Users/johnhuang/projects/testomniac_extension/src/sidepanel/SidePanel.tsx`

This task replaces the raw entity fetch and ephemeral scanMode state with the shared hooks. The SidePanel needs a `NetworkClient` and wrapping in `QueryClientProvider` — check whether these are already set up from existing deps; if not, add them.

- [ ] **Step 1: Check if QueryClientProvider is already set up**

Read the side panel entry point (`src/sidepanel/index.tsx` or similar) to see if `QueryClientProvider` wraps the SidePanel. If not, it must be added.

- [ ] **Step 2: Check if `useApi` or a NetworkClient is already available**

The extension has `@sudobility/building_blocks` which exports `useApi` from `building_blocks/firebase`. Check if the SidePanel's component tree includes `ApiProvider`. If `useApi` is available, use it for `{ networkClient, token }`. If not, create a simple `NetworkClient` from the existing token.

- [ ] **Step 3: Create a chrome.storage StorageAdapter**

Add a small adapter (can be inline in SidePanel or a small utility file) that implements `StorageAdapter` for `chrome.storage.local`:

```typescript
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
```

- [ ] **Step 4: Replace raw entity fetch with `useEntityManager`**

In `SidePanel.tsx`, replace the entity fetch `useEffect` (lines ~544-566) and the manual `EntityOption` type with:

```typescript
import { useEntityManager, usePersistedState } from '@sudobility/testomniac_lib';

// Inside the component:
const { entities, isLoading: loadingEntities } = useEntityManager({
  networkClient,
  baseUrl: API_URL,
  token: token ?? '',
  enabled: isAuthenticated && !!token,
});

// Auto-select first entity
useEffect(() => {
  if (entities.length > 0 && !selectedEntityId) {
    setSelectedEntityId(entities[0].id);
  }
}, [entities, selectedEntityId]);
```

Remove:
- The `EntityOption` interface (line ~61-65) — use `EntityWithRole` from `@sudobility/types`
- The `loadingEntities` state and `setLoadingEntities`
- The entity fetch `useEffect` (lines ~544-566)

- [ ] **Step 5: Replace scanMode useState with usePersistedState**

Replace:
```typescript
const [scanMode, setScanMode] = useState<ScanMode>('full');
```

With:
```typescript
const isScanMode = (v: unknown): v is ScanMode =>
  typeof v === 'string' && ['full', 'partial', 'minimum'].includes(v);
const [scanMode, setScanMode] = usePersistedState<ScanMode>(
  'scanMode',
  'full',
  chromeStorageAdapter,
  isScanMode
);
```

- [ ] **Step 6: Add scanMode to handleTestCurrentPage log**

In the `handleTestCurrentPage` callback's log object, add `scanMode`:

```typescript
console.log('[SidePanel] handleTestCurrentPage called', {
  activeTabUrl,
  hasToken: !!token,
  selectedEntityId,
  selectedProductId,
  selectedEnvironment,
  resolvedEnvironmentLabel,
  userId: user?.uid,
  scanMode,
});
```

- [ ] **Step 7: Install updated local packages**

```bash
cd /Users/johnhuang/projects/testomniac_extension
bun install
```

- [ ] **Step 8: Verify types compile and build succeeds**

Run: `cd /Users/johnhuang/projects/testomniac_extension && bun run type-check && bun run build`
Expected: Both pass

- [ ] **Step 9: Commit**

```bash
cd /Users/johnhuang/projects/testomniac_extension
git add src/sidepanel/SidePanel.tsx
git commit -m "refactor: use shared useEntityManager and usePersistedState hooks from testomniac_lib"
```

---

## Task 6: Manual Verification

- [ ] **Step 1: Test workspace empty after db:reset**

1. Run `bun run db:reset` in testomniac_app
2. Open the extension, log in
3. Verify the workspace selector populates within ~2 seconds (retry fires at 1.5s)
4. Verify no need to log out and back in

- [ ] **Step 2: Test scanMode persistence**

1. Open the side panel, select "Minimum"
2. Close the side panel
3. Reopen the side panel
4. Verify "Minimum" is still selected (not reset to "Full")
5. Start a scan — verify the console log shows `scanMode: 'minimum'` in the `handleTestCurrentPage` output and `scanMode=minimum` in the `START_SCAN` background log
6. Verify only navigation interactions run (no hover highlighting on elements)

- [ ] **Step 3: Test scanMode validation**

1. Open chrome DevTools → Application → Storage → chrome.storage.local
2. Set `scanMode` to `"bogus"`
3. Reopen the side panel
4. Verify it falls back to "Full" (the default), not "bogus"
