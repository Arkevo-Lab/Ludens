import type { ReplayFrame } from "@/lib/replay-types";

export type VideoSource = NonNullable<ReplayFrame["media"][number]["video"]>;
export const videoResourceKey = (source: VideoSource) => `${source.assetId}:${source.revision}`;

/** Keep one decoder while its snapshot still contains the requested sample.
 * New proof URLs for unchanged bytes must not restart playback. */
export function selectVideoSource(previous: VideoSource, next: VideoSource, at: number, sampledAt: number, failed: boolean): VideoSource {
  if (videoResourceKey(previous) === videoResourceKey(next)) return { ...next, url: previous.url };
  if (!failed && previous.assetId === next.assetId && previous.status === "pending" && next.status === "pending"
      && previous.streaming && previous.readableUntil !== undefined
      && Math.min(at, sampledAt) <= previous.readableUntil && at < previous.originAt + previous.durationSeconds * 1000)
    return previous;
  return next;
}

export function replayVideoReady(source: VideoSource, state?: { url: string; ready: boolean }) {
  return source.status === "gap" || source.status === "error"
    || !!((source.status === "ready" || source.streaming === true) && state?.url === source.assetId && state.ready);
}

export function videoPosition(at: number, originAt: number) {
  return Math.max(0, (at - originAt) / 1000);
}

export function videoSyncState(state: { at: number; originAt: number; sampledAt: number; duration: number;
  currentTime: number; readyState: number; seeking: boolean; ended: boolean; playing: boolean; clockReady: boolean;
  explicitSeek?: boolean; driftMs?: number; waiting?: boolean }) {
  const clock = videoPosition(state.at, state.originAt);
  // Chromium can report ended with HAVE_METADATA (and while a seek is settling)
  // at the last sample PTS, before the container's final display interval ends.
  // Holding that frame must not stop the common clock from reaching the next clip.
  if (state.ended && clock >= state.currentTime - 0.000001)
    return { target: state.currentTime, seek: false, ready: true, play: false };
  const sample = videoPosition(Math.min(state.at, state.sampledAt), state.originAt);
  // Only a sparse recording's final-sample region may need a precise decoder
  // recovery. Ordinary mid-stream waits must be left to the media element.
  const tailRecovery = state.playing && state.readyState < 2 && !state.ended
    && state.duration * 1000 - (state.sampledAt - state.originAt) <= 100 && state.currentTime > sample;
  const target = state.ended || clock >= state.duration || state.playing && state.readyState < 2 && !state.explicitSeek ? sample : clock;
  // Natural playback tolerates short-lived drift. A large discrepancy must
  // remain visible for one second before it justifies another decoder seek.
  const resync = state.playing && state.clockReady && !state.waiting && state.readyState >= 2
    && Math.abs(state.currentTime - clock) > 1 && (state.driftMs ?? 0) >= 1000;
  const seek = state.readyState > 0 && !state.seeking && Math.abs(state.currentTime - target) > 0.000001
    && (state.explicitSeek || !state.playing || tailRecovery || resync);
  const ready = !seek && !state.seeking && !state.waiting && (state.readyState >= 2 || state.ended);
  return { target, seek, ready,
    // React retains playback intent while the shared clock is frozen. Holding
    // the decoder too prevents it from running ahead and forcing a later resync.
    play: state.playing && !state.ended && state.at < state.originAt + state.duration * 1000 && state.clockReady };
}
