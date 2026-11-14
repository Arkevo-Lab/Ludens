"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AppRpcParams, ReplayRpcQuery } from "@ludens/protocol/app-rpc";
import type { ReplayFrame, ReplayItem, ReplayOverview, ReplayOverviewResult, ReplayCoverage, ReplayWindow } from "@/lib/replay-types";
import { buildReplayFrameIndex, clampReplayTime, indexedAdjacentFrame, indexedStageFramesAt, mergeReplayPages, REPLAY_WINDOW_MS,
  replayFrameSignature, replayWindowBounds, type ReplayFrameIndex } from "@/features/replay/replay-model";
import { ReplayWindowCache, replayPrefetchPlan, replayWindowKey, type ReplayWindowMode } from "@/features/replay/replay-window-cache";
import { readArchiveJson } from "@/lib/archive-client";
import { useLudensEvent, useOptionalLudensRpc } from "@/lib/ludens-rpc";
import { replayRpcParams } from "@/features/replay/replay-evidence-model";

/**
 * Single owner of every Replay read and of the playback clock:
 * overview + coverage updates, frame/event windows (interval cache, lookahead prefetch, dedupe, stale cancellation),
 * pending-segment refresh, frame stepping and the playhead.
 *
 * The playhead runs in a ref driven by requestAnimationFrame and is published two ways:
 * - `clock` (external store, every animation frame) for the cursor, scrubber and wall clock;
 * - `at` (React state) only when the frame set on stage changes, at most every 250 ms otherwise, and on seeks.
 */
export const REPLAY_COARSE_TICK_MS = 250;
const SCRUB_SETTLE_MS = 120;
const PENDING_REFRESH_MS = 2000;

export type ReplayWindowReader = (params: AppRpcParams<"replay/get">, signal: AbortSignal) => Promise<ReplayWindow>;

/** Follow a window's cursor to the end (bounded), publishing each merged page as it arrives. */
export async function readReplayWindow(
  scope: string,
  mode: ReplayWindowMode,
  startAt: number,
  endAt: number,
  signal: AbortSignal,
  onPage?: (page: ReplayWindow) => void,
  initial?: ReplayWindow,
  read?: ReplayWindowReader,
) {
  if (!read) throw new Error("Replay RPC reader is unavailable");
  let merged = initial, cursor = initial?.nextCursor;
  const seen = new Set<string>();
  const maxPages = mode === "frames" ? 50 : 20;
  for (let n = 0; n < maxPages; n++) {
    const query: ReplayRpcQuery = { mode, start: startAt, end: endAt, ...(cursor ? { cursor } : {}) };
    const page = await read(replayRpcParams(scope, query), signal);
    signal.throwIfAborted();
    merged = merged ? mergeReplayPages([merged, page]) : page;
    onPage?.(merged);
    cursor = page.nextCursor;
    if (!cursor) return merged;
    if (seen.has(cursor)) throw new Error("Replay pagination stalled; please retry");
    seen.add(cursor);
  }
  return merged!;
}

/** Playhead store: written by the animation loop, read by tiny subscribers without re-rendering the player. */
export class ReplayClock {
  private listeners = new Set<() => void>();
  constructor(private value = 0) {}
  get = () => this.value;
  set(value: number) { if (value === this.value) return; this.value = value; for (const listener of this.listeners) listener(); }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
}
export function useReplayClock(clock: ReplayClock) {
  return useSyncExternalStore(clock.subscribe, clock.get, clock.get);
}

export interface ReplaySessionOptions {
  project: string;
  run: string;
  epoch?: string;
  initialOverview?: ReplayOverview | null;
  /** Position requested by the URL at mount. */
  initialPosition?: string | null;
  archiveRevision?: number;
  capability: string;
  eventWindowMs: number;
  onOverview?(value: ReplayOverviewResult): void;
  /** Called once when playback reaches the end of the range. */
  onEnded?(at: number): void;
  /** Whether a user action already chose a position (suppresses the initial preview probe). */
  userMoved: () => boolean;
}

export function useReplaySession(options: ReplaySessionOptions) {
  const { project, run, epoch, initialOverview = null, archiveRevision, capability, eventWindowMs } = options;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const requestedScope = new URLSearchParams({ project, run, ...(epoch ? { epoch } : {}) }).toString();
  const [overview, setOverview] = useState<ReplayOverview | null>(initialOverview);
  const resolvedEpoch = overview ? overview.epoch : epoch;
  const scope = new URLSearchParams({ project, run, ...(resolvedEpoch ? { epoch: resolvedEpoch } : {}) }).toString();
  const [coverage, setCoverage] = useState<ReplayCoverage | null>(initialOverview?.coverage ?? null);
  const [overviewError, setOverviewError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [overviewPoll, setOverviewPoll] = useState(0);
  const [retryRevision, setRetryRevision] = useState(0);

  // ---- clock ----------------------------------------------------------------------------------
  const initialAt = initialOverview ? clampReplayTime(Number(options.initialPosition ?? initialOverview.startAt), initialOverview) : 0;
  const clock = useMemo(() => new ReplayClock(initialAt), []); // eslint-disable-line react-hooks/exhaustive-deps
  const atRef = useRef(initialAt);
  const [at, setAt] = useState(initialAt);
  const [clockRevision, setClockRevision] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [scrubbing, setScrubbing] = useState(false);
  /** Media readiness gate written by the player every render; the animation loop holds the clock while false. */
  const readyRef = useRef(false);
  const move = useCallback((next: number, motion: { scrub?: boolean } = {}) => {
    atRef.current = next; clock.set(next); setAt(next); setClockRevision(value => value + 1); setScrubbing(!!motion.scrub);
  }, [clock]);

  const rpc = useOptionalLudensRpc();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const readWindow = useCallback<ReplayWindowReader>(
    (params, signal) =>
      readArchiveJson<ReplayWindow>(async readSignal => {
        const caller = rpcRef.current;
        if (!caller) throw new Error("RPC client is unavailable");
        return (await caller.call("replay/get", params, { signal: readSignal })) as ReplayWindow;
      }, signal),
    [],
  );

  // ---- window cache ---------------------------------------------------------------------------
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const cache = useMemo(() => new ReplayWindowCache((mode, startAt, endAt, signal, onPage) =>
    readReplayWindow(scopeRef.current, mode, startAt, endAt, signal, onPage, undefined, readWindow)), [readWindow]);
  // Abort in-flight reads on unmount; StrictMode remounts reuse the same (still valid) cache.
  useEffect(() => () => cache.clear(), [cache]);
  const version = useSyncExternalStore(cache.subscribe, cache.getVersion, cache.getVersion);
  // A different scope (run/epoch) invalidates every window. Declared before the prefetch effect so it runs first.
  const cacheScope = useRef(scope);
  useEffect(() => {
    if (cacheScope.current === scope) return;
    cacheScope.current = scope; cache.clear();
  }, [scope, cache]);

  // ---- overview -------------------------------------------------------------------------------
  const hasOverview = useRef(Boolean(initialOverview));
  const previousEpoch = useRef<string | null>(initialOverview?.epoch ?? null);
  useEffect(() => {
    if (!project || !run) return;
    const controller = new AbortController();
    setRefreshing(true); setOverviewError("");
    void readArchiveJson<ReplayOverviewResult>(async signal => {
      const caller = rpcRef.current;
      if (!caller) throw new Error("RPC client is unavailable");
      return (await caller.call("replay/get", replayRpcParams(requestedScope, { mode: "overview" }), {
        signal,
      })) as ReplayOverviewResult;
    }, controller.signal).then(next => {
      if (controller.signal.aborted) return;
      optionsRef.current.onOverview?.(next);
      setCoverage(next.coverage ?? null);
      if (next.startAt === null) return;
      if (hasOverview.current && previousEpoch.current !== next.epoch) {
        cache.clear(); setPlaying(false); move(next.startAt);
      }
      previousEpoch.current = next.epoch;
      if (!hasOverview.current) {
        hasOverview.current = true;
        move(clampReplayTime(Number(optionsRef.current.initialPosition ?? next.startAt), next));
      }
      // Keep the previous object when nothing observable changed so memoized consumers stay stable while polling.
      setOverview(previous => previous && previous.startAt === next.startAt && previous.endAt === next.endAt && previous.epoch === next.epoch
        && previous.cycles.length === next.cycles.length && previous.capabilities.join() === next.capabilities.join()
        && previous.coverage?.complete === next.coverage?.complete ? previous : next);
    }).catch(error => { if (!controller.signal.aborted) setOverviewError(error.message); })
      .finally(() => { if (!controller.signal.aborted) setRefreshing(false); });
    return () => controller.abort();
  }, [requestedScope, project, run, refreshRevision, overviewPoll, move, archiveRevision, cache, rpc?.reconnectGeneration ?? 0, Boolean(rpc)]);
  useLudensEvent(
    "run",
    event => {
      if (event.workspaceId === project && (!event.runId || event.runId === run)) {
        setOverviewPoll(value => value + 1);
      }
    },
    { enabled: Boolean(project && run), workspaceId: project, runId: run },
  );
  useEffect(() => {
    if (!coverage || coverage.complete || overviewError) return;
    const timer = setTimeout(() => setOverviewPoll(value => value + 1), 750);
    return () => clearTimeout(timer);
  }, [coverage, overviewError]);

  // ---- windows around the playhead ------------------------------------------------------------
  const range = overview && overview.endAt >= overview.startAt ? overview : null;
  const bounds = range ? replayWindowBounds(at, range) : { startAt: 0, endAt: 0 };
  const eventBounds = range ? replayWindowBounds(at, range, eventWindowMs) : { startAt: 0, endAt: 0 };
  const plan = useMemo(() => range ? replayPrefetchPlan({ at, speed, range, frameWindowMs: REPLAY_WINDOW_MS, eventWindowMs,
    boundsOf: (value, windowMs) => replayWindowBounds(value, range, windowMs) }) : [],
  // Re-plan when a window boundary or the half-window threshold may have changed, not on every coarse tick.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [range, speed, eventWindowMs, bounds.startAt, eventBounds.startAt, Math.floor(at / 5000)]);
  const planKey = plan.map(entry => entry.key + (entry.required ? "!" : "")).join(",");
  useEffect(() => {
    if (!plan.length) return;
    const run = () => {
      cache.pin(plan.map(entry => entry.key));
      cache.cancelStale(plan.map(entry => entry.key));
      for (const entry of plan) void cache.ensure(entry.mode, entry.startAt, entry.endAt, { required: entry.required });
    };
    // While dragging, only settle on the window the pointer rests on; no request storm per input event.
    if (!scrubbing) { run(); return; }
    const timer = setTimeout(run, SCRUB_SETTLE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey, scrubbing, retryRevision, scope, cache]);
  // Archive revisions append events: refresh the current event window in place, without clearing the lane.
  const lastArchive = useRef(archiveRevision);
  useEffect(() => {
    if (lastArchive.current === archiveRevision || !range) return;
    lastArchive.current = archiveRevision;
    void cache.ensure("events", eventBounds.startAt, eventBounds.endAt, { required: true, refresh: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [archiveRevision]);

  const frameEntry = range ? cache.peek("frames", bounds.startAt, bounds.endAt) : undefined;
  const activeWindow = frameEntry?.window;

  // ---- frame index (rebuilt only when cached windows change) ----------------------------------
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const index = useMemo<ReplayFrameIndex>(() => buildReplayFrameIndex(cache.frames()), [version, cache]);
  const indexRef = useRef(index);
  indexRef.current = index;
  const stageRange = useCallback((value: number) => {
    if (!range) return { from: 0, to: 0 };
    const current = replayWindowBounds(value, range);
    // Any recorded past sample in the run remains valid evidence; previews stay bounded to the current window.
    return { from: range.startAt, to: current.endAt };
  }, [range]);
  const stageAt = useCallback((value: number) => {
    const { from, to } = stageRange(value);
    return indexedStageFramesAt(indexRef.current, value, optionsRef.current.capability, from, to);
  }, [stageRange]);
  const stageFrames = useMemo(() => stageAt(at), [stageAt, at, index, capability]); // eslint-disable-line react-hooks/exhaustive-deps

  // Segments still being written: refresh the current window in place until they settle.
  const pendingSegments = !!(activeWindow?.frames.some(frame => frame.media.some(media => media.video?.status === "pending"))
    || stageFrames.some(frame => frame.media.some(media => media.video?.status === "pending")));
  useEffect(() => {
    if (!pendingSegments || !frameEntry?.complete || frameEntry.error) return;
    const timer = setTimeout(() => void cache.ensure("frames", bounds.startAt, bounds.endAt, { refresh: true }), PENDING_REFRESH_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSegments, frameEntry?.complete, frameEntry?.error, frameEntry?.window, bounds.startAt, bounds.endAt, cache]);

  // ---- playback loop --------------------------------------------------------------------------
  useEffect(() => {
    if (!playing || !range) return;
    let animation = 0, previous = performance.now(), lastCommit = previous;
    let signature = replayFrameSignature(stageAt(atRef.current));
    const tick = (now: number) => {
      if (!readyRef.current) { previous = now; animation = requestAnimationFrame(tick); return; }
      const next = Math.min(range.endAt, atRef.current + (now - previous) * speed);
      previous = now;
      atRef.current = next;
      clock.set(next);
      const nextSignature = replayFrameSignature(stageAt(next));
      if (nextSignature !== signature || now - lastCommit >= REPLAY_COARSE_TICK_MS || next >= range.endAt) {
        signature = nextSignature; lastCommit = now; setAt(next);
      }
      if (next >= range.endAt) { setPlaying(false); optionsRef.current.onEnded?.(next); return; }
      animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animation);
  }, [playing, speed, range, clock, stageAt]);

  // ---- initial preview probe (first non-empty window when the run starts silent) -------------
  const [initialPreviewFrame, setInitialPreviewFrame] = useState<ReplayFrame | null>(null);
  const probeDone = useRef(false);
  useEffect(() => { setInitialPreviewFrame(null); probeDone.current = false; }, [requestedScope]);
  const firstWindowEmpty = !!range && frameEntry?.complete && bounds.startAt === range.startAt && !activeWindow?.frames.length;
  useEffect(() => {
    if (!range || !firstWindowEmpty || probeDone.current || optionsRef.current.userMoved()) return;
    probeDone.current = true;
    let cancelled = false;
    void (async () => {
      let edge = bounds.endAt;
      for (let i = 0; i < 12 && edge < range.endAt && !cancelled; i += 1) {
        const target = replayWindowBounds(edge, range);
        const result = await cache.ensure("frames", target.startAt, target.endAt);
        if (cancelled || !result) return;
        if (result.frames.length) {
          setInitialPreviewFrame(result.frames.find(frame => frame.media.length > 0 || Boolean(frame.text)) ?? result.frames[0]);
          return;
        }
        edge = target.endAt;
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstWindowEmpty, range, cache]);

  // ---- events ---------------------------------------------------------------------------------
  const eventEntry = range ? cache.peek("events", eventBounds.startAt, eventBounds.endAt) : undefined;
  // Until the exact window lands, show whatever cached windows already cover it instead of an empty lane.
  const items = useMemo<ReplayItem[]>(() => eventEntry?.window?.items
    ?? (range ? cache.items(eventBounds.startAt, eventBounds.endAt) : []),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [eventEntry?.window, version, eventBounds.startAt, eventBounds.endAt]);
  const [continuing, setContinuing] = useState(false);
  const [continueError, setContinueError] = useState("");
  const continueRequest = useRef<AbortController | null>(null);
  const refreshGeneration = useRef(0);
  // A scope change, refresh or unmount abandons an explicit continuation; it must never land over newer state.
  useEffect(() => () => { continueRequest.current?.abort(); continueRequest.current = null; }, [scope, refreshRevision]);
  useEffect(() => setContinueError(""), [scope, refreshRevision, retryRevision, eventBounds.startAt, eventBounds.endAt]);
  const continueEvents = useCallback(async () => {
    const current = cache.get("events", eventBounds.startAt, eventBounds.endAt);
    if (!current?.nextCursor) return;
    continueRequest.current?.abort();
    const controller = new AbortController(), origin = scopeRef.current, gen = refreshGeneration.current;
    continueRequest.current = controller;
    setContinuing(true); setContinueError("");
    try {
      const next = await readReplayWindow(origin, "events", eventBounds.startAt, eventBounds.endAt, controller.signal, undefined, current, readWindow);
      if (!controller.signal.aborted && scopeRef.current === origin && refreshGeneration.current === gen) {
        cache.store("events", eventBounds.startAt, eventBounds.endAt, next);
      }
    } catch (error) {
      if (!controller.signal.aborted) setContinueError(error instanceof Error ? error.message : String(error));
    } finally {
      if (continueRequest.current === controller) { continueRequest.current = null; setContinuing(false); }
    }
  }, [cache, eventBounds.startAt, eventBounds.endAt]);

  // ---- stepping -------------------------------------------------------------------------------
  const stepRequest = useRef(0);
  const [stepping, setStepping] = useState(false);
  /** Resolve the adjacent frame, loading windows outward only when the cache has none. */
  const findAdjacent = useCallback(async (direction: -1 | 1) => {
    if (!range) return undefined;
    const token = ++stepRequest.current, from = atRef.current, cap = optionsRef.current.capability;
    const cached = indexedAdjacentFrame(indexRef.current, from, direction, cap);
    const current = replayWindowBounds(from, range);
    // Short-circuit only inside a fully loaded current window; otherwise walk outward from it so no frame is skipped.
    if (cached && cache.peek("frames", current.startAt, current.endAt)?.complete && cached.at >= current.startAt && cached.at <= current.endAt) return cached;
    setStepping(true);
    try {
      let edge = direction === 1 ? current.startAt : current.endAt;
      while (direction === 1 ? edge < range.endAt : edge > range.startAt) {
        const target = replayWindowBounds(direction === 1 ? edge : edge - 1, range);
        const window = await cache.ensure("frames", target.startAt, target.endAt, { required: true });
        if (token !== stepRequest.current) return undefined;
        if (!window) return undefined;
        const found = indexedAdjacentFrame(buildReplayFrameIndex(window.frames), from, direction, cap);
        if (found) return found;
        edge = direction === 1 ? target.endAt : target.startAt;
      }
      return undefined;
    } finally { if (token === stepRequest.current) setStepping(false); }
  }, [cache, range]);
  const cancelStep = useCallback(() => { stepRequest.current++; setStepping(false); }, []);

  const retry = useCallback(() => setRetryRevision(value => value + 1), []);
  const refresh = useCallback(() => {
    refreshGeneration.current++;
    continueRequest.current?.abort();
    continueRequest.current = null;
    cache.clear();
    setRefreshRevision(value => value + 1);
    setRetryRevision(value => value + 1);
  }, [cache]);
  const refreshOverview = useCallback(() => setRefreshRevision(value => value + 1), []);

  return {
    scope, overview, overviewError, coverage, refreshing, refreshRevision, retryRevision,
    clock, atRef, at, clockRevision, playing, setPlaying, speed, setSpeed, move, readyRef,
    bounds, eventBounds, index, stageFrames, activeWindow,
    frameWindowComplete: !!frameEntry?.complete,
    windowError: frameEntry?.error ?? "",
    items, eventsLoading: !!eventEntry?.loading || continuing, eventError: eventEntry?.error ?? continueError,
    eventsHaveMore: !!eventEntry?.window?.nextCursor, continueEvents,
    initialPreviewFrame, stepping, findAdjacent, cancelStep,
    retry, refresh, refreshOverview,
    windowKey: replayWindowKey("frames", bounds.startAt, bounds.endAt),
  };
}
export type ReplaySession = ReturnType<typeof useReplaySession>;
