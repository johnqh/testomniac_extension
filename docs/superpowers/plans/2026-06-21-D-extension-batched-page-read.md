# Plan D — testomniac_extension: Batched Page Read in ChromeAdapter

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Target repo:** `testomniac_extension` (Chrome MV3 side-panel extension).

**Goal:** Implement the optional `capturePageSnapshot()` seam (added to `BrowserAdapter` in Plan B Task 3) in `ChromeAdapter`, collapsing the separate `content()` and `getBodyTextLength()` `chrome.scripting.executeScript` injections into a single round trip. This is the first concrete instance of REC #6 (reduce injection count); the runner_service decomposition read (`readPageHtml`) automatically uses it once present.

**Architecture:** Extract the page-evaluated collector as a standalone, serializable, exported function `collectPageSnapshot()` (so `chrome.scripting.executeScript({ func })` can serialize it, and so it is unit-testable under jsdom without mocking the chrome API). `ChromeAdapter.capturePageSnapshot()` injects it once. Per-injection detector calls owned by runner_service (scaffolds/forms/actionable items) are out of scope — batching those requires exposing their page-functions from runner_service and is a separate effort.

**Tech Stack:** TypeScript, Vite 5, React 18, Vitest + jsdom (added here — the repo currently has no test runner).

## Global Constraints

- Package manager: **Bun only** (`bun install`, `bun add -d`).
- Build/check commands today: `bun run build` (`tsc && vite build`), `bun run type-check` (`tsc --noEmit`), `bun run lint`. **No `test` script exists** — Task 1 adds one.
- This depends on Plan B Task 3 being **published**: `BrowserAdapter.capturePageSnapshot?` must exist in the installed `@sudobility/testomniac_runner_service` types. Verify with: `grep -r "capturePageSnapshot" node_modules/@sudobility/testomniac_runner_service/dist`.
- Vite caches pre-bundled deps in `node_modules/.vite`; if the runner_service type bump isn't picked up, `rm -rf node_modules/.vite`.
- `node:crypto` is shimmed; jsdom env must not pull in the service worker globals — keep the collector free of `chrome.*`.

---

### Task 1: Stand up a Vitest + jsdom test harness

**Files:**
- Modify: `testomniac_extension/package.json` (devDeps + `test` script)
- Create: `testomniac_extension/vitest.config.ts`
- Create: `testomniac_extension/src/adapters/collectPageSnapshot.test.ts` (smoke test proving the harness runs)

**Interfaces:**
- Produces: `bun run test` → `vitest run`, jsdom environment available for DOM-based unit tests.

- [ ] **Step 1: Add Vitest + jsdom as dev dependencies**

Run:
```bash
cd testomniac_extension && bun add -d vitest jsdom @vitest/ui
```

- [ ] **Step 2: Create `vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
  },
});
```

- [ ] **Step 3: Add the `test` script to package.json**

Add to `"scripts"`:
```json
    "test": "vitest run",
    "test:watch": "vitest",
```

- [ ] **Step 4: Write a smoke test**

Create `src/adapters/collectPageSnapshot.test.ts`:

```typescript
import { describe, it, expect } from "vitest";

describe("vitest jsdom harness", () => {
  it("provides a document", () => {
    document.body.innerHTML = "<p>hi</p>";
    expect(document.querySelector("p")?.textContent).toBe("hi");
  });
});
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd testomniac_extension && bun run test`
Expected: PASS — 1 test, jsdom document available.

- [ ] **Step 6: Commit**

```bash
cd testomniac_extension
git add package.json bun.lockb vitest.config.ts src/adapters/collectPageSnapshot.test.ts
git commit -m "test: add vitest + jsdom harness"
```

---

### Task 2: Extract `collectPageSnapshot` as a pure, serializable collector

**Files:**
- Create: `testomniac_extension/src/adapters/collectPageSnapshot.ts`
- Modify: `testomniac_extension/src/adapters/collectPageSnapshot.test.ts` (replace smoke test)

**Interfaces:**
- Produces: `collectPageSnapshot(): { html: string; bodyTextLength: number }` — reads `document.documentElement.outerHTML` and the trimmed length of `document.body.innerText`. Self-contained (no module references, no closures) so `chrome.scripting.executeScript({ func: collectPageSnapshot })` can serialize and inject it. Replaces the work done today by `content()` (ChromeAdapter.ts:599-606) and `getBodyTextLength()` (ChromeAdapter.ts:~1258).

- [ ] **Step 1: Write the failing test**

Replace `src/adapters/collectPageSnapshot.test.ts` with:

```typescript
import { describe, it, expect } from "vitest";
import { collectPageSnapshot } from "./collectPageSnapshot";

describe("collectPageSnapshot", () => {
  it("returns outerHTML and trimmed body text length in one shot", () => {
    document.documentElement.innerHTML = "<head></head><body>  hello world  </body>";
    const snap = collectPageSnapshot();
    expect(snap.html).toContain("hello world");
    expect(snap.html).toBe(document.documentElement.outerHTML);
    // jsdom's innerText falls back to textContent; trimmed length of "hello world" = 11
    expect(snap.bodyTextLength).toBe("hello world".length);
  });

  it("handles a missing body without throwing", () => {
    const original = document.body;
    Object.defineProperty(document, "body", { value: null, configurable: true });
    expect(() => collectPageSnapshot()).not.toThrow();
    expect(collectPageSnapshot().bodyTextLength).toBe(0);
    Object.defineProperty(document, "body", { value: original, configurable: true });
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd testomniac_extension && bun run test`
Expected: FAIL — module `./collectPageSnapshot` not found.

- [ ] **Step 3: Implement**

Create `src/adapters/collectPageSnapshot.ts`:

```typescript
/**
 * Runs INSIDE the page via chrome.scripting.executeScript. Must be fully
 * self-contained (no imports, no closure variables) so it serializes cleanly.
 * Collapses the previous separate content() + getBodyTextLength() injections
 * into one round trip.
 */
export function collectPageSnapshot(): { html: string; bodyTextLength: number } {
  const html = document.documentElement.outerHTML;
  const body = document.body;
  const text = body ? (body.innerText ?? body.textContent ?? "") : "";
  return { html, bodyTextLength: text.trim().length };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd testomniac_extension && bun run test && bun run type-check`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd testomniac_extension
git add src/adapters/collectPageSnapshot.ts src/adapters/collectPageSnapshot.test.ts
git commit -m "feat(adapter): pure serializable collectPageSnapshot collector"
```

---

### Task 3: Implement `ChromeAdapter.capturePageSnapshot()` and route `content()` through it

**Files:**
- Modify: `testomniac_extension/src/adapters/ChromeAdapter.ts` (add method; reuse in `content()`/`getBodyTextLength()`)
- Test: `src/adapters/collectPageSnapshot.test.ts` covers the injected function; the thin adapter wrapper is verified by type-check + the existing scan flow.

**Interfaces:**
- Consumes: `collectPageSnapshot` (Task 2); `BrowserAdapter.capturePageSnapshot?` (Plan B Task 3, published).
- Produces on `ChromeAdapter`: `capturePageSnapshot(): Promise<{ html: string; bodyTextLength: number }>` satisfying the optional interface method.

- [ ] **Step 1: Verify the published interface has the seam**

Run: `cd testomniac_extension && grep -r "capturePageSnapshot" node_modules/@sudobility/testomniac_runner_service/dist/adapter.d.ts`
Expected: prints the optional method signature. If absent, STOP — Plan B Task 3 has not been published; `bun install` the new runner_service version first.

- [ ] **Step 2: Add the method to ChromeAdapter**

Add the import at the top of `ChromeAdapter.ts`:

```typescript
import { collectPageSnapshot } from "./collectPageSnapshot";
```

Add the method (near `content()`, ~line 599):

```typescript
  async capturePageSnapshot(): Promise<{ html: string; bodyTextLength: number }> {
    await this.ensureAccessiblePage();
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: this.tabId },
      func: collectPageSnapshot,
    });
    return result?.result ?? { html: "", bodyTextLength: 0 };
  }
```

- [ ] **Step 3: Reuse the collector inside `content()` and `getBodyTextLength()`** (so the two legacy injection sites also collapse to the shared collector — no duplicate page logic)

Change `content()` (599-606) to:

```typescript
  async content(): Promise<string> {
    return (await this.capturePageSnapshot()).html;
  }
```

Change `getBodyTextLength()` (~1258) to:

```typescript
  private async getBodyTextLength(): Promise<number> {
    return (await this.capturePageSnapshot()).bodyTextLength;
  }
```

(If `getBodyTextLength` is called in a poll loop, this preserves its single-injection cost; the win is that the runner_service decomposition path now makes ONE injection via `capturePageSnapshot()` instead of separate `content()` + body-text calls.)

- [ ] **Step 4: Type-check, lint, build**

Run: `cd testomniac_extension && bun run type-check && bun run lint && bun run build`
Expected: clean. `capturePageSnapshot` satisfies the optional `BrowserAdapter` method.

- [ ] **Step 5: Verify in a real scan** — load the dev extension (`bun run dev`, port 7175), toggle the extension off/on in `chrome://extensions` (service workers cache stale JS), run a scan, and confirm via the background log that decomposition reads go through `capturePageSnapshot` (one injection) without regressing HTML capture or page-found events.

- [ ] **Step 6: Commit**

```bash
cd testomniac_extension
git add src/adapters/ChromeAdapter.ts
git commit -m "feat(adapter): ChromeAdapter.capturePageSnapshot batches html + body text"
```

---

### Out of scope (documented, not planned here)

Batching the remaining per-injection detector reads (`detectScaffoldRegions`, `detectPatternsWithInstances`, `extractActionableItems`, `extractForms`, `captureUiSnapshot`, `captureControlStates` — executor ~line 365-385) into one injection requires those detectors (which live in `@sudobility/testomniac_runner_service`) to expose their page-evaluated functions so a single `capturePageSnapshot` can run them all and return a composite. That is a larger runner_service refactor; this plan deliberately lands the `content()` + body-text collapse first as the proven, low-risk increment.

## Self-Review

- **Spec coverage:** #6 (extension side, first increment) → Tasks 1-3. Remaining detector batching → explicitly scoped out with the reason. ✅
- **Placeholder scan:** Full code for the harness, collector, and adapter method. The dependency on Plan B's published interface is a verified precondition (Task 3 Step 1), not a placeholder. ✅
- **Type consistency:** `{ html: string; bodyTextLength: number }` return shape identical across `collectPageSnapshot`, `capturePageSnapshot`, and Plan B Task 3's `capturePageSnapshot?` interface. ✅
