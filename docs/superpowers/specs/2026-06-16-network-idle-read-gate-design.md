# Network-Idle Read Gate — Design

**Date:** 2026-06-16
**Status:** Approved (pending spec review)
**Repos touched:** `testomniac_runner_service` (origin), `testomniac_runner`, `testomniac_extension`

## Problem

Today the scanner waits a **fixed duration** before reading page HTML, and the two
runtimes behave inconsistently:

- **Extension** (`background/index.ts:701`): a hard `setTimeout(1000)` "settle" after
  the initial `goto`, plus `ChromeAdapter.waitForTabLoad` which only polls
  `tab.status === 'complete'` (not network state).
- **Shared executor** (`test-interaction-executor.ts:1452`/`:1461`): a fixed
  `setTimeout(_clickWaitMs)` (default 500ms) after every click.
- **Server** (`PuppeteerAdapter`): `goto`/`waitForNavigation` use `networkidle0`
  (Puppeteer's built-in 500ms-quiet window).

Fixed waits are simultaneously too long (wasted time on fast pages) and too short
(slow pages read mid-render). The HTML is read in the **shared** `runner_service`
at `test-interaction-executor.ts:515` (decompose) and `:1508` (snapshot).

## Goal

Read the page **10ms after the network goes idle** — i.e. after the HTML document,
JS, and all endpoint/XHR calls have finished — so the screen has had a chance to
render. Apply consistently on both the extension (Chrome) and server (Puppeteer)
runtimes, for both the initial navigation and post-interaction reads.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Scope | **Both runtimes**, via a shared adapter primitive |
| Hang safety | **Ignore persistent connection types** (websocket, SSE/eventsource) and stale requests; plus a hard timeout cap |
| Applies to | **Initial navigation AND post-click** reads |
| Idle window | **10ms** of zero non-persistent in-flight requests |
| Dispatch-race floor | **50ms** minimum before idle may be declared |

## Approach (chosen): adapter primitive + shared read-gate

Add one method to the `BrowserAdapter` contract and call it as the single
"page is ready to read" gate in the shared executor.

### 1. New adapter method — `runner_service/src/adapter.ts`

```ts
/**
 * Resolve once the network has been quiet (no non-persistent in-flight
 * requests) for `idleMs`, or once `timeout` elapses (then resolve anyway).
 * Optional so adapters that cannot observe network activity still compile.
 */
waitForNetworkIdle?(opts?: {
  idleMs?: number;   // quiet window — default 10
  timeout?: number;  // hard cap before giving up and reading — default 10000
  staleMs?: number;  // ignore a request still open after this — default 5000
  floorMs?: number;  // minimum wait before idle may be declared — default 50
}): Promise<void>;
```

### 2. Shared idle algorithm (identical semantics in both adapters)

- Keep an in-flight map keyed by request id; each entry stores `startTs` and
  `resourceType`.
- A request counts toward **busy** only if BOTH:
  - its `resourceType` is a normal resource (document/script/xhr/fetch/
    stylesheet/image/font/etc.), **not** `eventsource` or `websocket`, and
  - it is **not stale**: `now - startTs < staleMs`.
- Wait loop (poll ~10ms):
  - Track `lastBusyAt` = last time busy-count was > 0.
  - The idle timer cannot fire before `floorMs` (50ms) has elapsed since the
    call began — absorbs the click→XHR dispatch race so a not-yet-fired request
    isn't mistaken for "already idle".
  - Resolve when busy-count has been 0 for `idleMs` (10ms) continuously **and**
    `floorMs` has passed.
  - If `timeout` (10s) elapses first, resolve anyway and log a warning. This is
    the safety valve for pages that never go idle (websocket/long-poll/hung XHR).

### 3. ChromeAdapter — `extension/src/adapters/ChromeAdapter.ts`

The CDP `Network.*` events are already wired (`:974` `requestWillBeSent`, `:996`
`responseReceived`, `:1029` `loadingFinished`/`loadingFailed`). Changes:

- Extend `requestMetadata` entries (`:988`) to also store `startTs: Date.now()`
  and `type` (from `Network.requestWillBeSent` params `type`).
- Add `waitForNetworkIdle()` that runs the algorithm against that map.
- `requestMetadata` eviction (`MAX_REQUEST_METADATA`) is unchanged — evicted
  entries are old/stale and already excluded from the busy count.

### 4. PuppeteerAdapter — `runner/src/adapters/PuppeteerAdapter.ts`

- Track `page.on('request' | 'requestfinished' | 'requestfailed')` into an
  in-flight map using `request.resourceType()` (returns `eventsource`,
  `websocket`, `fetch`, `xhr`, `document`, `script`, …) and a `startTs`.
- Add `waitForNetworkIdle()` running the same algorithm.
- Relax `goto`/`waitForNavigation` default `waitUntil` from `networkidle0` →
  `load`, so the new 10ms gate is the single idle authority (otherwise
  Puppeteer's built-in 500ms idle dominates and the 10ms window never takes
  effect on the server).

### 5. Shared executor wiring — `test-interaction-executor.ts`

- Before the decompose read (`:515`) and snapshot read (`:1508`):
  `await adapter.waitForNetworkIdle?.({ idleMs: 10, timeout, staleMs, floorMs })`.
- Replace the post-click `setTimeout(_clickWaitMs)` at `:1452`/`:1461` with
  `await adapter.waitForNetworkIdle?.(...)`. The subsequent `waitForNavigation`
  becomes redundant for the idle purpose (a click-triggered navigation's document
  request is observed by the idle gate); keep a short `waitForNavigation` only if
  needed for URL bookkeeping.
- `floorMs` is a fixed constant (50ms), independent of `clickWaitMs`. The
  `clickWaitMs` config/setter (`setClickWaitMs`, extension UI field, default 500)
  is **deprecated** — no longer used as a post-click delay. Leave the plumbing in
  place for now (no UI/storage migration) but stop reading it in the executor;
  remove in a later cleanup. This avoids conflating a 500ms legacy delay with the
  50ms idle floor.

### 6. Extension background — `background/index.ts`

- Remove the hard `setTimeout(1000)` "settle" at `:701` — the idle gate replaces it.

### 7. goto() empty-content handling

`ChromeAdapter.goto` keeps its existing `waitForTabLoad` + `stopPageLoadAndWaitForContent`
logic (ensures the document actually loads); `waitForNetworkIdle` is an additional
settle layered after navigation, not a replacement for load detection.

## Rollout

Per CLAUDE.md (all `@sudobility/*` deps resolve from published npm; no local
aliases):

1. Implement + test in `testomniac_runner_service`.
2. Publish a new version (via `push_all.sh`).
3. `bun install` in `testomniac_runner` and `testomniac_extension` to pick it up;
   apply the consumer-side changes (PuppeteerAdapter, ChromeAdapter, background).

The new interface method is **optional**, so consumers compile before they call it.

## Tradeoffs accepted

- **10ms is aggressive.** A page that fetches in sequential bursts with >10ms
  thinking-gaps can be declared idle between bursts. The 50ms floor and `staleMs`
  cap mitigate but don't eliminate this; chosen deliberately for minimal latency.
- Three repos change plus a republish cycle.

## Testing

- **runner_service unit tests:** a fake `BrowserAdapter` driving
  `waitForNetworkIdle` through scripted request open/close timelines —
  verify: resolves ~floorMs+idleMs after last close; never before floorMs;
  ignores eventsource/websocket; ignores stale requests; resolves at `timeout`
  when never idle.
- **PuppeteerAdapter:** integration test against a local fixture page that fires
  delayed XHRs and an SSE stream — assert read happens after XHRs settle and is
  not blocked by SSE.
- **Extension ChromeAdapter:** manual/Playwright check that the 1s settle is gone
  and pages with late XHRs are read fully.
```
