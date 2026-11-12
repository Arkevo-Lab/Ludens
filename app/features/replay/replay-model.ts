import type { ReplayFrame, ReplayItem, ReplayOverview, ReplayWindow } from "@/lib/replay-types";

export const REPLAY_WINDOW_MS = 30_000;
export const replayTracks = ["action", "model", "tool", "log"] as const;
export const replayTrackLabels = { action: "动作", model: "模型", tool: "工具", log: "日志" };

export function clampReplayTime(at: number, range: Pick<ReplayOverview, "startAt" | "endAt">) {
  return Math.max(range.startAt, Math.min(range.endAt, Number.isFinite(at) ? at : range.startAt));
}

export function replayWindowBounds(at: number, range: Pick<ReplayOverview, "startAt" | "endAt">, windowMs = REPLAY_WINDOW_MS) {
  const position = clampReplayTime(at, range);
  const index = Math.floor(Math.max(0, Math.min(position, range.endAt - 1) - range.startAt) / windowMs);
  const startAt = range.startAt + index * windowMs;
  return { startAt, endAt: Math.min(range.endAt, startAt + windowMs) };
}

export function mergeReplayPages(pages: ReplayWindow[]): ReplayWindow {
  const frames = new Map<string, ReplayFrame>(), items = new Map<string, ReplayItem>();
  for (const page of pages) {
    for (const frame of page.frames) frames.set(frame.id, frame);
    for (const item of page.items) items.set(item.id, item);
  }
  return { startAt: pages[0]?.startAt ?? 0, endAt: pages[0]?.endAt ?? 0,
    frames: [...frames.values()].sort((a, b) => a.at - b.at || a.sequence - b.sequence),
    items: [...items.values()].sort((a, b) => a.startAt - b.startAt || a.id.localeCompare(b.id)),
    ...(pages.at(-1)?.nextCursor ? { nextCursor: pages.at(-1)!.nextCursor } : {}),
    ...(pages.at(-1)?.coverage ? { coverage: pages.at(-1)!.coverage } : {}) };
}

export function replayItemActive(item: ReplayItem, at: number) {
  return item.startAt <= at && (item.endAt === null || at <= item.endAt);
}

export function nearbyReplayItems(items: ReplayItem[], at: number, limit = 10) {
  return [...items].sort((a, b) => Math.abs(a.startAt - at) - Math.abs(b.startAt - at))
    .slice(0, limit).sort((a, b) => a.startAt - b.startAt);
}

export function replayDuration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  return [hours ? String(hours) : null, String(Math.floor(seconds / 60) % 60).padStart(2, "0"),
    String(seconds % 60).padStart(2, "0")].filter(value => value !== null).join(":");
}

export interface CoalescedReplayFrameTick {
  frame: ReplayFrame;
  startAt: number;
  endAt: number;
  count: number;
}

/**
 * Coalesce dense sub-pixel perception samples into at most `maxTicks` visual buckets
 * so 30–60 fps windows render cleanly without mounting 900–1,800 `<button>` nodes.
 */
export function coalesceReplayFrameTicks(
  frames: ReplayFrame[],
  rangeStart: number,
  rangeEnd: number,
  maxTicks = 120,
): CoalescedReplayFrameTick[] {
  const inRange = frames.filter(frame => frame.at >= rangeStart && frame.at <= rangeEnd);
  if (inRange.length <= maxTicks || maxTicks <= 0 || rangeEnd <= rangeStart) {
    return inRange.map(frame => ({ frame, startAt: frame.at, endAt: frame.at, count: 1 }));
  }
  const bucketSpan = (rangeEnd - rangeStart) / maxTicks;
  const buckets = new Map<number, ReplayFrame[]>();
  for (const frame of inRange) {
    const idx = Math.min(maxTicks - 1, Math.max(0, Math.floor((frame.at - rangeStart) / bucketSpan)));
    const group = buckets.get(idx);
    if (group) group.push(frame);
    else buckets.set(idx, [frame]);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, group]) => ({
      frame: group[0],
      startAt: group[0].at,
      endAt: group[group.length - 1].at,
      count: group.length,
    }));
}

/** Grid-aligned window starts intersecting [from, to], at most `limit`. */
export function replayWindowsBetween(from: number, to: number, range: Pick<ReplayOverview, "startAt" | "endAt">,
  windowMs = REPLAY_WINDOW_MS, limit = 8) {
  const result: { startAt: number; endAt: number }[] = [];
  if (range.endAt < range.startAt) return result;
  let bounds = replayWindowBounds(Math.max(range.startAt, from), range, windowMs);
  while (result.length < limit) {
    result.push(bounds);
    if (bounds.endAt >= Math.min(to, range.endAt) || bounds.endAt >= range.endAt) break;
    bounds = replayWindowBounds(bounds.endAt, range, windowMs);
  }
  return result;
}

/** Sorted by (at, sequence); `upperBound` returns the first index whose frame is strictly after `at`. */
const compareFrames = (a: ReplayFrame, b: ReplayFrame) => a.at - b.at || a.sequence - b.sequence;
export function upperBoundFrame(frames: readonly ReplayFrame[], at: number) {
  let lo = 0, hi = frames.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (frames[mid].at <= at) lo = mid + 1; else hi = mid; }
  return lo;
}

export interface ReplayFrameIndex {
  /** Every frame, ordered by (at, sequence), deduplicated by id. */
  all: readonly ReplayFrame[];
  byCapability: ReadonlyMap<string, readonly ReplayFrame[]>;
}
export const emptyReplayFrameIndex: ReplayFrameIndex = { all: [], byCapability: new Map() };

/** Build once per cached-window change; every playhead lookup is then O(capabilities · log N). */
export function buildReplayFrameIndex(frames: Iterable<ReplayFrame>): ReplayFrameIndex {
  const unique = new Map<string, ReplayFrame>();
  for (const frame of frames) unique.set(frame.id, frame);
  const all = [...unique.values()].sort(compareFrames);
  const byCapability = new Map<string, ReplayFrame[]>();
  for (const frame of all) {
    const list = byCapability.get(frame.capability);
    if (list) list.push(frame); else byCapability.set(frame.capability, [frame]);
  }
  return { all, byCapability };
}

const indexCapabilities = (index: ReplayFrameIndex, capability: string) =>
  capability ? (index.byCapability.has(capability) ? [capability] : []) : [...index.byCapability.keys()];

/** Same contract as `replayFramesAt`, by binary search per capability. */
export function indexedFramesAt(index: ReplayFrameIndex, at: number, capability = "") {
  const result: ReplayFrame[] = [];
  for (const name of indexCapabilities(index, capability)) {
    const list = index.byCapability.get(name)!, position = upperBoundFrame(list, at);
    if (position > 0) result.push(list[position - 1]);
  }
  return result.sort((a, b) => a.capability.localeCompare(b.capability));
}

/**
 * Stage frames by binary search per capability: the latest frame at or before `at` (no older than `from`),
 * otherwise that capability's first frame before `to` as a preview, so the stage never goes blank at frame 0.
 */
export function indexedStageFramesAt(index: ReplayFrameIndex, at: number, capability = "", from = -Infinity, to = Infinity) {
  const result: ReplayFrame[] = [];
  for (const name of indexCapabilities(index, capability)) {
    const list = index.byCapability.get(name)!, position = upperBoundFrame(list, at);
    const past = position > 0 ? list[position - 1] : undefined, next = list[position];
    if (past && past.at >= from) result.push(past);
    else if (next && next.at < to) result.push(next);
  }
  return result.sort((a, b) => a.capability.localeCompare(b.capability));
}

export function indexedAdjacentFrame(index: ReplayFrameIndex, at: number, direction: -1 | 1, capability = "") {
  const list = capability ? index.byCapability.get(capability) ?? [] : index.all;
  if (direction === 1) return list[upperBoundFrame(list, at)];
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (list[mid].at < at) lo = mid + 1; else hi = mid; }
  return lo > 0 ? list[lo - 1] : undefined;
}

/** Frames strictly after `at`, in order, at most `limit`. */
export function indexedFramesAfter(index: ReplayFrameIndex, at: number, capability = "", limit = 8) {
  const list = capability ? index.byCapability.get(capability) ?? [] : index.all;
  const start = upperBoundFrame(list, at);
  return list.slice(start, start + limit);
}

/** Identity of the frame set on stage: changes only when a different record becomes current. */
export function replayFrameSignature(frames: readonly ReplayFrame[]) {
  let signature = "";
  for (const frame of frames) signature += frame.id + "|";
  return signature;
}
