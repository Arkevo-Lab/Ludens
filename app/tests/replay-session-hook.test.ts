import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReplayFrame, ReplayItem, ReplayWindow } from "../lib/replay-types";
import { buildReplayFrameIndex, indexedAdjacentFrame, indexedFramesAfter, indexedStageFramesAt, REPLAY_WINDOW_MS,
  replayFrameSignature, replayWindowBounds, upperBoundFrame } from "../features/replay/replay-model";
import { ReplayWindowCache, replayPrefetchPlan, replayWindowKey, type ReplayWindowMode } from "../features/replay/replay-window-cache";
import { replayUpcomingVideos, type VideoSource } from "../features/replay/replay-video-model";
import { readReplayWindow, ReplayClock } from "../features/replay/use-replay-session";

const range = { startAt: 1_000_000, endAt: 1_000_000 + 10 * REPLAY_WINDOW_MS };
const boundsOf = (at: number, windowMs: number) => replayWindowBounds(at, range, windowMs);
const frame = (id: string, at: number, capability = "vision", extra: Partial<ReplayFrame> = {}): ReplayFrame =>
  ({ id, at, capability, sequence: at, media: [], ...extra });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

/** Fake network: every call is recorded and resolved manually, so tests can observe in-flight state. */
function fakeNetwork() {
  const calls: { mode: ReplayWindowMode; startAt: number; endAt: number; signal: AbortSignal; resolve(window?: Partial<ReplayWindow>): void;
    reject(error: Error): void; page(window: Partial<ReplayWindow>): void }[] = [];
  const cache = new ReplayWindowCache((mode, startAt, endAt, signal, onPage) => new Promise<ReplayWindow>((resolve, reject) => {
    const full = (window: Partial<ReplayWindow> = {}) => ({ startAt, endAt, frames: [], items: [], ...window });
    calls.push({ mode, startAt, endAt, signal, resolve: window => resolve(full(window)), reject, page: window => onPage(full(window)) });
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  }), { frames: 4, events: 2 });
  return { cache, calls };
}

test("prefetch plan: current windows required, next frame window and previous window always speculative", () => {
  const at = range.startAt + REPLAY_WINDOW_MS + 1_000;
  const plan = replayPrefetchPlan({ at, speed: 1, range, frameWindowMs: REPLAY_WINDOW_MS, eventWindowMs: REPLAY_WINDOW_MS, boundsOf });
  const frames = plan.filter(entry => entry.mode === "frames");
  assert.deepEqual(frames.map(entry => [entry.startAt - range.startAt, entry.required]),
    [[30_000, true], [60_000, false], [0, false]]);
  // Event window early in its span: only the current one.
  assert.deepEqual(plan.filter(entry => entry.mode === "events").map(entry => entry.startAt - range.startAt), [30_000]);
});

test("prefetch plan: past half of the event window, the next event window is fetched ahead; horizon grows with speed", () => {
  const at = range.startAt + REPLAY_WINDOW_MS * 0.6;
  const plan = replayPrefetchPlan({ at, speed: 1, range, frameWindowMs: REPLAY_WINDOW_MS, eventWindowMs: REPLAY_WINDOW_MS, boundsOf });
  assert.deepEqual(plan.filter(entry => entry.mode === "events").map(entry => [entry.startAt - range.startAt, entry.required]),
    [[0, true], [30_000, false]]);
  const lookahead = (speed: number) => replayPrefetchPlan({ at, speed, range, frameWindowMs: REPLAY_WINDOW_MS, eventWindowMs: REPLAY_WINDOW_MS, boundsOf })
    .filter(entry => entry.mode === "frames" && !entry.required).length;
  assert.equal(lookahead(1), 1, "1x: the next window only");
  assert.equal(lookahead(8), 3, "8x: ~96 s of horizon");
  assert.equal(lookahead(16), 4, "capped at four windows");
  const end = replayPrefetchPlan({ at: range.endAt, speed: 1, range, frameWindowMs: REPLAY_WINDOW_MS, eventWindowMs: REPLAY_WINDOW_MS, boundsOf });
  assert.ok(end.every(entry => entry.endAt <= range.endAt), "never plans past the end of the run");
});

test("seamless boundary: lookahead window is in memory before the playhead crosses, with zero new requests", async () => {
  const { cache, calls } = fakeNetwork();
  const at = range.startAt + 20_000;
  for (const entry of replayPrefetchPlan({ at, speed: 1, range, frameWindowMs: REPLAY_WINDOW_MS, eventWindowMs: REPLAY_WINDOW_MS, boundsOf }))
    void cache.ensure(entry.mode, entry.startAt, entry.endAt, { required: entry.required });
  const next = calls.find(call => call.mode === "frames" && call.startAt === range.startAt + REPLAY_WINDOW_MS)!;
  assert.ok(next, "next frame window requested while still inside the current one");
  next.resolve({ frames: [frame("n1", range.startAt + 30_100)] });
  for (const call of calls) if (call !== next) call.resolve();
  await tick();
  const before = calls.length;
  const crossed = boundsOf(range.startAt + 30_050, REPLAY_WINDOW_MS);
  assert.equal(cache.get("frames", crossed.startAt, crossed.endAt)?.frames[0].id, "n1", "crossing reads from memory synchronously");
  await cache.ensure("frames", crossed.startAt, crossed.endAt, { required: true });
  assert.equal(calls.length, before, "no request for an already complete window");
});

test("interval merge across windows and back-scrub hits the cache", async () => {
  const { cache, calls } = fakeNetwork();
  void cache.ensure("frames", range.startAt, range.startAt + 30_000);
  void cache.ensure("frames", range.startAt + 30_000, range.startAt + 60_000);
  calls[0].resolve({ frames: [frame("a", range.startAt + 10), frame("b", range.startAt + 29_000, "depth")] });
  calls[1].resolve({ frames: [frame("c", range.startAt + 30_500)] });
  await tick();
  assert.deepEqual(cache.frames().map(value => value.id).sort(), ["a", "b", "c"]);
  // Stage at the start of window 2 keeps the sparse "depth" capability from window 1 (no blank flash at the boundary).
  const index = buildReplayFrameIndex(cache.frames());
  const stage = indexedStageFramesAt(index, range.startAt + 30_100, "", range.startAt, range.startAt + 60_000);
  assert.deepEqual(stage.map(value => value.id), ["b", "a"]);
  const count = calls.length;
  assert.equal((await cache.ensure("frames", range.startAt, range.startAt + 30_000))?.frames.length, 2);
  assert.equal(calls.length, count, "dragging back re-uses memory");
});

test("concurrent ensures share one request; stale speculative loads are aborted and later restart cleanly", async () => {
  const { cache, calls } = fakeNetwork();
  const a = cache.ensure("frames", range.startAt, range.startAt + 30_000);
  const b = cache.ensure("frames", range.startAt, range.startAt + 30_000, { required: true });
  assert.equal(calls.length, 1, "deduplicated in-flight promise");
  void cache.ensure("frames", range.startAt + 90_000, range.startAt + 120_000);
  cache.cancelStale([replayWindowKey("frames", range.startAt, range.startAt + 30_000)]);
  assert.equal(calls[1].signal.aborted, true, "scrubbed-away window is cancelled");
  assert.equal(calls[0].signal.aborted, false, "wanted window continues");
  calls[0].resolve({ frames: [frame("x", range.startAt + 5)] });
  assert.equal((await a)?.frames[0].id, "x");
  assert.equal(await b, await a);
  await tick();
  assert.equal(cache.entry("frames", range.startAt + 90_000, range.startAt + 120_000), undefined, "aborted partial entry dropped");
  void cache.ensure("frames", range.startAt + 90_000, range.startAt + 120_000);
  assert.equal(calls.length, 3, "a later visit restarts from page one");
});

test("partial pages publish immediately; a refresh keeps the old window until the replacement completes", async () => {
  const { cache, calls } = fakeNetwork();
  void cache.ensure("frames", range.startAt, range.startAt + 30_000);
  calls[0].page({ frames: [frame("p1", range.startAt + 1)], nextCursor: "c" });
  assert.equal(cache.get("frames", range.startAt, range.startAt + 30_000)?.frames.length, 1);
  assert.equal(cache.entry("frames", range.startAt, range.startAt + 30_000)?.complete, false);
  calls[0].resolve({ frames: [frame("p1", range.startAt + 1), frame("p2", range.startAt + 2)] });
  await tick();
  void cache.ensure("frames", range.startAt, range.startAt + 30_000, { refresh: true });
  calls[1].page({ frames: [] });
  assert.equal(cache.get("frames", range.startAt, range.startAt + 30_000)?.frames.length, 2, "no clearing during refresh");
  calls[1].resolve({ frames: [frame("p1", range.startAt + 1), frame("p2", range.startAt + 2), frame("p3", range.startAt + 3)] });
  await tick();
  assert.equal(cache.get("frames", range.startAt, range.startAt + 30_000)?.frames.length, 3);
});

test("LRU eviction never drops pinned playhead windows; errors are retryable", async () => {
  const { cache, calls } = fakeNetwork();
  const keys = [0, 1, 2, 3, 4, 5].map(n => [range.startAt + n * 30_000, range.startAt + (n + 1) * 30_000] as const);
  cache.pin([replayWindowKey("frames", ...keys[0])]);
  for (const [startAt, endAt] of keys) { void cache.ensure("frames", startAt, endAt); calls.at(-1)!.resolve(); await tick(); }
  assert.ok(cache.get("frames", ...keys[0]), "pinned window survives");
  assert.equal(cache.get("frames", ...keys[1]), undefined, "least recently used evicted");
  assert.ok(cache.get("frames", ...keys[5]));
  void cache.ensure("events", range.startAt, range.startAt + 30_000);
  calls.at(-1)!.reject(new Error("boom"));
  await tick();
  assert.equal(cache.entry("events", range.startAt, range.startAt + 30_000)?.error, "boom");
  void cache.ensure("events", range.startAt, range.startAt + 30_000);
  assert.equal(calls.at(-1)!.mode, "events", "retry starts a new request");
});

test("event items: cached overlapping windows cover a new window size until the exact one lands", async () => {
  const { cache, calls } = fakeNetwork();
  const item = (id: string, startAt: number): ReplayItem => ({ id, track: "tool", startAt, endAt: startAt + 10, label: id, source: { seq: 1 } });
  void cache.ensure("events", range.startAt, range.startAt + 300_000);
  calls[0].resolve({ items: [item("a", range.startAt + 5_000), item("b", range.startAt + 200_000)] });
  await tick();
  assert.deepEqual(cache.items(range.startAt, range.startAt + 30_000).map(value => value.id), ["a"]);
});

test("binary-search lookups match a brute-force scan on random multi-capability data", () => {
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const frames = Array.from({ length: 2000 }, (_, i) => frame("f" + i, Math.floor(random() * 60_000), ["a", "b", "c"][i % 3], { sequence: i }));
  const index = buildReplayFrameIndex(frames);
  for (let n = 0; n < 200; n++) {
    const at = Math.floor(random() * 62_000) - 1_000;
    for (const capability of ["", "a"]) {
      const expected = [...new Set(frames.map(value => value.capability))].filter(name => !capability || name === capability).sort().flatMap(name => {
        const own = frames.filter(value => value.capability === name).sort((x, y) => x.at - y.at || x.sequence - y.sequence);
        const past = own.filter(value => value.at <= at).at(-1);
        return past ? [past] : own.length ? [own[0]] : [];
      });
      assert.deepEqual(indexedStageFramesAt(index, at, capability).map(value => value.id), expected.map(value => value.id));
    }
    const next = frames.filter(value => value.at > at).sort((x, y) => x.at - y.at || x.sequence - y.sequence)[0];
    assert.equal(indexedAdjacentFrame(index, at, 1)?.id, next?.id);
    const previous = frames.filter(value => value.at < at).sort((x, y) => x.at - y.at || x.sequence - y.sequence).at(-1);
    assert.equal(indexedAdjacentFrame(index, at, -1)?.at, previous?.at);
  }
  assert.equal(upperBoundFrame(index.all, -1), 0);
  assert.equal(upperBoundFrame(index.all, 1e9), index.all.length);
  assert.equal(indexedFramesAfter(index, -1, "a", 3).length, 3);
});

test("stage window: stale frames older than `from` and previews beyond `to` are never shown", () => {
  const index = buildReplayFrameIndex([frame("old", 10, "x"), frame("future", 900, "y"), frame("near", 450, "z")]);
  assert.deepEqual(indexedStageFramesAt(index, 500, "", 100, 800).map(value => value.id), ["near"]);
  assert.equal(replayFrameSignature(indexedStageFramesAt(index, 500, "", 100, 800)), "near|");
});

test("next video segment is warmed with the exact URL the slot will switch to, within the horizon only", () => {
  const video = (assetId: string, url: string, status: VideoSource["status"] = "ready"): VideoSource =>
    ({ assetId, revision: status, url, originAt: 0, width: 1, height: 1, durationSeconds: 300, status });
  const media = (source: VideoSource) => [{ index: 0, mediaType: "image/jpeg", url: "m", video: source }];
  const current = video("seg-1", "u1");
  const index = buildReplayFrameIndex([
    frame("a", 1_000, "cam", { media: media(current) }),
    frame("b", 2_000, "cam", { media: media(video("seg-1", "u1b")) }),
    frame("c", 6_000, "cam", { media: media(video("seg-2", "u2")) }),
    frame("d", 7_000, "cam", { media: media(video("seg-2", "u2b")) }),
  ]);
  const slots = [{ slot: "cam:0", capability: "cam", index: 0, video: current }];
  assert.equal(replayUpcomingVideos(index, slots, 1_500, 8_000).get("cam:0")?.url, "u2");
  assert.equal(replayUpcomingVideos(index, slots, 1_500, 2_000).size, 0, "outside the horizon nothing is mounted");
});

test("window reader follows cursors, publishes merged pages and rejects a stalled cursor", async () => {
  const pages: Record<string, ReplayWindow> = {
    "": { startAt: 0, endAt: 30_000, frames: [frame("1", 1)], items: [], nextCursor: "c1" },
    c1: { startAt: 0, endAt: 30_000, frames: [frame("2", 2)], items: [] },
  };
  const seen: number[] = [];
  const read = async <T,>(url: string) => pages[new URL(url, "http://x").searchParams.get("cursor") ?? ""] as T;
  const window = await readReplayWindow("project=p&run=r", "frames", 0, 30_000, new AbortController().signal, page => seen.push(page.frames.length), undefined, read);
  assert.deepEqual(window.frames.map(value => value.id), ["1", "2"]);
  assert.deepEqual(seen, [1, 2]);
  const stalled = async <T,>() => ({ startAt: 0, endAt: 1, frames: [], items: [], nextCursor: "same" }) as T;
  await assert.rejects(readReplayWindow("s", "events", 0, 1, new AbortController().signal, undefined, undefined, stalled), /stalled/);
});

test("clock store notifies subscribers only on change", () => {
  const clock = new ReplayClock(5);
  let calls = 0;
  const off = clock.subscribe(() => calls++);
  clock.set(5); clock.set(6); off(); clock.set(7);
  assert.equal(calls, 1);
  assert.equal(clock.get(), 7);
});
