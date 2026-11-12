import type { ReplayFrame, ReplayItem, ReplayWindow } from "@/lib/replay-types";

/**
 * Interval cache for replay windows. Pure TypeScript (no React) so prefetch, dedupe,
 * cancellation and eviction are unit-testable; `useReplaySession` binds it to React.
 *
 * - One entry per grid-aligned `(mode, startAt, endAt)` window; concurrent `ensure` calls share one in-flight load.
 * - Each load owns its AbortController. `cancelStale(keep)` aborts loads nobody wants anymore (fast scrubbing).
 * - Partial pages are published while a window paginates, so the stage never waits for the last page.
 * - Completed windows are evicted LRU, except windows pinned by the current playhead neighbourhood.
 */
export type ReplayWindowMode = "frames" | "events";
export type ReplayWindowFetcher = (mode: ReplayWindowMode, startAt: number, endAt: number, signal: AbortSignal,
  onPage: (page: ReplayWindow) => void) => Promise<ReplayWindow>;

export interface ReplayWindowEntry {
  key: string;
  mode: ReplayWindowMode;
  startAt: number;
  endAt: number;
  /** Latest published data (partial while `loading`). A refresh keeps it until the replacement lands. */
  window?: ReplayWindow;
  complete: boolean;
  loading: boolean;
  error?: string;
  used: number;
}

interface Flight { controller: AbortController; promise: Promise<ReplayWindow | undefined>; required: boolean }

export const replayWindowKey = (mode: ReplayWindowMode, startAt: number, endAt: number) => `${mode}:${startAt}:${endAt}`;

export class ReplayWindowCache {
  private entries = new Map<string, ReplayWindowEntry>();
  private flights = new Map<string, Flight>();
  private listeners = new Set<() => void>();
  private pinned = new Set<string>();
  private clock = 0;
  /** Bumped on every observable change; React reads it through useSyncExternalStore. */
  version = 0;

  constructor(private fetcher: ReplayWindowFetcher, private limits = { frames: 12, events: 8 }) {}

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getVersion = () => this.version;
  private emit() { this.version++; for (const listener of this.listeners) listener(); }

  entry(mode: ReplayWindowMode, startAt: number, endAt: number) {
    const entry = this.entries.get(replayWindowKey(mode, startAt, endAt));
    if (entry) entry.used = ++this.clock;
    return entry;
  }
  get(mode: ReplayWindowMode, startAt: number, endAt: number) { return this.entry(mode, startAt, endAt)?.window; }
  isLoading(key: string) { return this.flights.has(key); }
  inFlight() { return [...this.flights.keys()]; }

  /** Load (or join the in-flight load of) one window. Resolves undefined when aborted or failed. */
  ensure(mode: ReplayWindowMode, startAt: number, endAt: number, options: { required?: boolean; refresh?: boolean } = {}) {
    const key = replayWindowKey(mode, startAt, endAt);
    const flight = this.flights.get(key);
    if (flight) { flight.required ||= !!options.required; return flight.promise; }
    const existing = this.entries.get(key);
    if (existing?.complete && !options.refresh) { existing.used = ++this.clock; return Promise.resolve(existing.window); }
    return this.start(key, mode, startAt, endAt, !!options.required, !!options.refresh);
  }

  private start(key: string, mode: ReplayWindowMode, startAt: number, endAt: number, required: boolean, refresh: boolean) {
    const controller = new AbortController();
    const entry: ReplayWindowEntry = this.entries.get(key) ?? { key, mode, startAt, endAt, complete: false, loading: true, used: 0 };
    entry.loading = true; entry.error = undefined; entry.used = ++this.clock;
    this.entries.set(key, entry);
    const current = () => this.entries.get(key) === entry && this.flights.get(key)?.controller === controller;
    const promise = this.fetcher(mode, startAt, endAt, controller.signal, page => {
      // A refresh keeps the previous complete window on screen until the full replacement is ready.
      if (!current() || controller.signal.aborted || (refresh && entry.complete)) return;
      entry.window = page; this.emit();
    }).then(window => {
      if (!current() || controller.signal.aborted) return undefined;
      entry.window = window; entry.complete = true;
      return window;
    }, error => {
      if (!current() || controller.signal.aborted) return undefined;
      entry.error = error instanceof Error ? error.message : String(error);
      return undefined;
    }).finally(() => {
      if (this.flights.get(key)?.controller !== controller) return;
      this.flights.delete(key);
      entry.loading = false;
      // An aborted first load leaves nothing worth keeping: a later ensure must restart from page one.
      if (controller.signal.aborted && !entry.complete) this.entries.delete(key);
      this.evict();
      this.emit();
    });
    this.flights.set(key, { controller, promise, required });
    this.emit();
    return promise;
  }

  /** Abort in-flight loads whose window is no longer wanted. Kept windows continue unaffected. */
  cancelStale(keep: Iterable<string>) {
    const wanted = new Set(keep);
    for (const [key, flight] of this.flights) if (!wanted.has(key)) flight.controller.abort();
  }

  /** Publish a window obtained outside `ensure` (e.g. an explicit "continue" page). */
  store(mode: ReplayWindowMode, startAt: number, endAt: number, window: ReplayWindow) {
    const key = replayWindowKey(mode, startAt, endAt);
    this.entries.set(key, { key, mode, startAt, endAt, window, complete: true, loading: false, used: ++this.clock });
    this.evict(); this.emit();
  }

  /** Windows around the playhead are never evicted, regardless of LRU order. */
  pin(keys: Iterable<string>) { this.pinned = new Set(keys); this.evict(); }

  private evict() {
    for (const mode of ["frames", "events"] as const) {
      const candidates = [...this.entries.values()].filter(entry => entry.mode === mode && !this.flights.has(entry.key));
      const excess = candidates.length - this.limits[mode];
      if (excess <= 0) continue;
      candidates.filter(entry => !this.pinned.has(entry.key)).sort((a, b) => a.used - b.used).slice(0, excess)
        .forEach(entry => this.entries.delete(entry.key));
    }
  }

  /** Frames of every cached frame window overlapping [from, to], deduplicated and ordered. */
  frames(from = -Infinity, to = Infinity): ReplayFrame[] {
    const frames = new Map<string, ReplayFrame>();
    for (const entry of [...this.entries.values()].sort((a, b) => a.startAt - b.startAt)) {
      if (entry.mode !== "frames" || !entry.window || entry.endAt < from || entry.startAt > to) continue;
      for (const frame of entry.window.frames) frames.set(frame.id, frame);
    }
    return [...frames.values()];
  }

  /** Items of every cached event window overlapping [from, to]. */
  items(from: number, to: number): ReplayItem[] {
    const items = new Map<string, ReplayItem>();
    for (const entry of this.entries.values()) {
      if (entry.mode !== "events" || !entry.window || entry.endAt < from || entry.startAt > to) continue;
      for (const item of entry.window.items) if (item.startAt <= to && (item.endAt ?? item.startAt) >= from) items.set(item.id, item);
    }
    return [...items.values()].sort((a, b) => a.startAt - b.startAt || a.id.localeCompare(b.id));
  }

  /** Drop everything (scope/epoch change or explicit refresh) and abort all loads. */
  clear(mode?: ReplayWindowMode) {
    for (const [key, flight] of this.flights) if (!mode || key.startsWith(mode + ":")) { flight.controller.abort(); this.flights.delete(key); }
    for (const [key, entry] of this.entries) if (!mode || entry.mode === mode) this.entries.delete(key);
    this.emit();
  }

}

export interface ReplayWindowRequest { mode: ReplayWindowMode; startAt: number; endAt: number; required: boolean; key: string }

/**
 * Which windows the playhead needs now. The current windows are required; the previous frame window stays for
 * stage continuity and back-scrubbing; the lookahead horizon grows with speed so a window boundary is crossed with
 * data already in memory. The next event window is fetched once the playhead passes half of the current one.
 */
export function replayPrefetchPlan(input: { at: number; speed: number; range: { startAt: number; endAt: number };
  frameWindowMs: number; eventWindowMs: number; boundsOf: (at: number, windowMs: number) => { startAt: number; endAt: number };
  maxLookahead?: number }): ReplayWindowRequest[] {
  const { at, range, frameWindowMs, eventWindowMs, boundsOf } = input;
  const speed = Math.max(1, input.speed), plan: ReplayWindowRequest[] = [];
  const add = (mode: ReplayWindowMode, bounds: { startAt: number; endAt: number }, required: boolean) => {
    const key = replayWindowKey(mode, bounds.startAt, bounds.endAt);
    if (bounds.endAt > bounds.startAt && !plan.some(entry => entry.key === key)) plan.push({ mode, ...bounds, required, key });
  };
  const frame = boundsOf(at, frameWindowMs);
  add("frames", frame, true);
  const horizon = at + Math.max(frameWindowMs, 12_000 * speed);
  for (let edge = frame.endAt, n = 0; edge < range.endAt && edge <= horizon && n < (input.maxLookahead ?? 4); n++) {
    const next = boundsOf(edge, frameWindowMs); add("frames", next, false); edge = next.endAt;
  }
  if (frame.startAt > range.startAt) add("frames", boundsOf(frame.startAt - 1, frameWindowMs), false);
  const event = boundsOf(at, eventWindowMs);
  add("events", event, true);
  const elapsed = (at - event.startAt) / Math.max(1, event.endAt - event.startAt);
  if (event.endAt < range.endAt && (elapsed >= 0.5 || event.endAt - at <= 10_000 * speed)) add("events", boundsOf(event.endAt, eventWindowMs), false);
  return plan;
}
