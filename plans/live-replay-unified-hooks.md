# Live & Replay Unified Data Hooks and Smoothness Optimization

## 1. Context & Measured Bottlenecks

### 1.1 Live (`?view=live`) — Measured on `switch2-diablo3` (`:3015`, read-only)
Latest run `2026-11-12T09-29-29.971Z` (562 model calls, 29,283 total blocks / 767 visible non-diagnostic blocks, 9 runs):
- **Initial load & view-switch chaos**:
  - `use-activity-feed.ts:96-178` runs a sequential waterfall: `mode=changes&limit=100` (`170.8 ms`, returning mostly diagnostic blocks without clearing `loading`), followed by `mode=history&limit=100` (`1,664.7 ms`).
  - Meanwhile `GET /api/run?epoch=all` (`708.3 KB`, `189.3 ms`) arrives first while `feed.blocks` is still empty; `shiori-segments.ts:632-640` (`orphanInputCalls`) misclassifies all 100 calls as orphan screenshot cards, firing dozens of `/api/media` decodes before collapsing to 3 blocks and then jumping to ~40 conversation turns.
  - Four uncoordinated pollers (`catalog`, `run`, `activity`, `event-pool`) plus `update(() => emptyState())` on `enabled=false` (`use-activity-feed.ts:94`) and component-local `useState` for `loadedOlderRuns` / `poolSnapshot` (`shiori-cockpit.tsx:2175, 2198`) wipe state whenever switching tabs.
- **Unexplained network reads during vertical scrolling**:
  1. `shiori-cockpit.tsx:702-709` renders `<img src="/api/media?..." loading="lazy" />`, while `core/src/core/query/data.ts:327-328` serves timeline video frame decodes (`0.91–1.71 MB` PNG, `271.6–343.3 ms` each on single-threaded `dashboardWorker`) with `Cache-Control: no-store`. Scrolling up and down evicts lazy-loaded images and re-triggers full server-side frame decodes.
  2. `use-activity-feed.ts:148-178` re-runs `mode=history` on `snapshot` / `reload` (`feed.latest()`) and truncates `blocks` back to `ACTIVITY_WINDOW_SIZE` (300), discarding previously paged history and forcing re-fetches on upward scroll.
  3. `shiori-cockpit.tsx:2246` depends on `data.updatedAt` (regenerated on every `/api/run` poll in `data.ts:265`), aborting and re-fetching `/api/event-pool` every 2.5s.
  4. `shiori-cockpit.tsx:2997` triggers `loadNextUpwardHistory()` whenever `scrollTop < 280` regardless of scroll direction, and jumping to an older run via `RunPicker` leaves `feed.hasMore` open, causing mid-stream history fetches.
- **Backend & React render bottlenecks**:
  - `core/src/core/query/activity.ts:380, 434-471`: `saveBlock` skips updating `recipe` when a block's digest is unchanged, leaving sibling blocks of the same `model` call with divergent `(streamOffset, eventCutoff)` recipes. `blockReader` misses its per-request recipe cache, repeatedly gunzipping/parsing the same `streams/<model>.jsonl` (`mode=history` takes `1.66s`, older run `limit=300` takes `4.33s`, blocking the shared `dashboardWorker`).
  - `shiori-cockpit.tsx:2201, 2341` runs a top-level `1Hz` `setInterval(() => setNowMs(Date.now()), 1000)` that re-renders the entire 3,855-line tree every second; `buildCodexSegments` + `mergePoolSnapshotSegments` recompute across all runs every 2.5s; `handleScroll` (`:2970-2979`) forces synchronous layout via `querySelectorAll` + `getBoundingClientRect()`.

### 1.2 Replay (`?view=replay`) — Measured on `switch2-diablo3` (`:3015`, read-only)
Run `2026-11-11T12-26-01.948Z` (18.7h, 63k events, 1.71M timeline index entries, 5-min fMP4 segments):
- **Time-window boundary stalls**:
  - `timeline-player.tsx:390-413` prefetches only one next window passively upon entering window `N`, retaining only 2 windows (`replay-model.ts:125`).
  - `timeline-player.tsx:494-495` reads stage frames exclusively from `activeWindow`, dropping low-frequency capability frames across window boundaries and pausing `requestAnimationFrame` whenever `ready` turns `false` (`:516, :541, :553-570`).
  - `timeline-player.tsx:419-420` clears `eventWindow` (`setEventWindow(null)`) across `eventBounds`, flashing empty lanes for `7–160 ms` and wiping on every `archiveRevision` bump (`:428`).
- **5-minute fMP4 segment boundary stutter**:
  - `replay-video.tsx:107` mounts the next `<video>` `Surface` only after `source` switches to the new `assetId`, stalling `rAF` while `moov` + first frame decode.
- **High-frequency full-tree re-renders & scrubbing storms**:
  - `timeline-player.tsx:560` calls top-level `setAt` every `60ms` (~16Hz), re-rendering the 1,275-line component, linearly scanning frames/items, recreating `Map` / `playback` props (breaking `FrameMedia` `memo`), and re-reconciling up to 1,679 track buttons.
  - `timeline-player.tsx:581-591` fires un-debounced `seek` + abort cycles on every slider `input` event and wipes the entire window cache (`cached.current = []`) when seeking backward with `nextCursor`.
- **Backend `timelineWindow` linear prefix scan**:
  - `core/src/core/query/timeline-record.ts:184-202` linearly scans `[scopeStart, low - 1]` from sequence 0 on every window request to find each capability's latest prior frame (`12 ms` at 2% -> `48 ms` in Bun / ~`100 ms` in Node at 90% across 193k pointers), plus 500 individual `open`/`stat`/`close` syscalls (`~35 ms`) per page.

---

## 2. Strict Disjoint File Ownership (`F_live ∩ F_replay = ∅`)

### Slice A — `@live-hook` (`feat/live-unified-hook`)
- `app/features/live/**` (including new `use-live-session.ts`, `live-session-store.ts`, `live-media-cache.ts`, and updates to `shiori-cockpit.tsx`, `shiori-segments.ts`, `use-activity-feed.ts`, `activity-feed-model.ts`, `run-visuals.tsx`, `use-buffered-media.ts`, `event-pool-panel.tsx`)
- `app/lib/live-follow.ts`
- `app/lib/read-poller.ts`
- `core/src/core/query/activity.ts` (bounded `WeakMap<LogIndex, ...>` immutable block cache keyed by `(generation, id, revision)` + safe latest-pointer `model` recipe coalescing)
- `app/tests/live-*.test.ts` (and new Live hook / activity cache unit tests)

### Slice B — `@replay-hook` (`feat/replay-unified-hook`)
- `app/features/replay/**` (including new `use-replay-session.ts`, `replay-window-cache.ts`, and updates to `timeline-player.tsx`, `replay-video.tsx`, `replay-video-model.ts`, `replay-model.ts`, `image-buffer.ts`, `replay-event-search.tsx`, `replay-evidence-panel.tsx`)
- `core/src/core/query/timeline-record.ts` (reverse segment scan + `(resolvedRoot, stem, firstSequence, lastSequence, count)` segment summary cache + per-file handle reuse within `timelineWindow`)
- `app/tests/replay-*.test.ts` (and new Replay hook / window cache / timeline-record unit tests)

### Integration & Docs — `@perf-verifier` (`perf/live-and-replay-unified-hooks`)
- `PLANS.md` & `plans/live-replay-unified-hooks.md` (deleted prior to final PR commit per `AGENTS.md`)
- `docs/en/reference/dashboard-ui.md` & `docs/zh/reference/dashboard-ui.md` (1:1 bilingual parity)

---

## 3. Architecture & Verification Guardrails

1. **Live (`useLiveSession` + `activity.ts`)**:
   - Coalesce `model` recipes (`max(streamOffset, eventCutoff)`) **only** when `store.meta(item.id)?.revision === item.revision` (latest pointers), preserving exact historical version immutability in `store.versions()` delta pagination; invalidate `WeakMap<LogIndex, ...>` entries whenever `index.generation` changes.
   - Use reference-counted or unmounted-only LRU eviction in `live-media-cache.ts` so `URL.revokeObjectURL` never breaks still-mounted `<img>` thumbnails in the session stream, and never cache failed media reads (preserving explicit same-resource retry).
   - Preserve dual-timestamp Event Pool receipts, `ModelPickerDialog` speed/effort badges, `RunPicker` Quick-Jump segment navigation, and `atBottom` scroll-lock.
2. **Replay (`useReplaySession` + `timeline-record.ts`)**:
   - Key segment summaries on `(resolvedRoot, stem, firstSequence, lastSequence, count)` and avoid stale-caching the active growing tail segment or deleted/expired files (`410` in `timeline-record.test.ts`).
   - Strictly uphold the evidence rule: never display a frame with `frame.at > at` as recorded evidence (except the existing initial unmoved preview at `at <= overview.startAt`), and preserve recording gap / missing-media states.
   - Bound simultaneous `<video>` decoders per channel (cleanup `src` on unmount) and preserve immediate 60fps range-input feedback during scrubbing while committing URL state on pointer/key release.
3. **Verification Gates**:
   - `npm --prefix protocol run typecheck`
   - `bun run --cwd core typescript:typecheck` & `bun test` (relevant core/query tests)
   - `npm --prefix app run typecheck`
   - `cd app && npx tsx --test tests/docs.test.ts` + full `app/tests/*.test.ts` suite
   - `npm --prefix app run build && npm --prefix app run build:check`
