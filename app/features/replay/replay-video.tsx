"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReplayFrame } from "@/lib/replay-types";
import { selectVideoSource, videoPosition, videoResourceKey, videoSyncState } from "@/features/replay/replay-video-model";
import { useTranslations } from "@/lib/locale";

type Source = NonNullable<ReplayFrame["media"][number]["video"]>;
type Ready = (slot: string, url: string, ready: boolean) => void;

/** Each mounted segment has its own decoder; the old surface stays until the new frame has decoded. */
function Surface({ source, at, liveAt, sampledAt, playing, clockReady, speed, visible, current, revision, onReady, onError, label }: {
  source: Source; at: number; liveAt?: () => number; sampledAt: number; playing: boolean; clockReady: boolean; speed: number; visible: boolean; current: boolean; revision: number;
  onReady(url: string, ready: boolean): void; onError(url: string): void; label: string;
}) {
  const element = useRef<HTMLVideoElement>(null);
  // A warmed (not yet current) decoder already sits at its segment start: crossing into it is not an explicit seek.
  const lastRevision = useRef(current ? -1 : revision);
  const driftSince = useRef<number | null>(null);
  const waiting = useRef(false);
  const control = useRef({ source, at, liveAt, sampledAt, playing, clockReady, speed, current, revision, onReady });
  control.current = { source, at, liveAt, sampledAt, playing, clockReady, speed, current, revision, onReady };
  const sync = useCallback(() => {
    const video = element.current, c = control.current;
    // The coarse React clock lags by up to 250 ms (2 s of video at 8x); drift is measured against the live clock.
    const now_at = c.liveAt?.() ?? c.at;
    if (!video || !c.current) { video?.pause(); return; }
    if (video.error) { onError(c.source.url); return; }
    if (!video.readyState) { c.onReady(c.source.url, false); return; }
    const now = performance.now();
    const explicitSeek = lastRevision.current !== c.revision;
    const drift = Math.abs(video.currentTime - videoPosition(now_at, c.source.originAt));
    const drifting = c.playing && c.clockReady && !waiting.current && video.readyState >= 2 && !video.seeking && drift > 1;
    if (drifting && driftSince.current === null) driftSince.current = now;
    else if (!drifting) driftSince.current = null;
    const state = videoSyncState({ at: now_at, sampledAt: c.sampledAt, originAt: c.source.originAt,
      duration: c.source.durationSeconds, currentTime: video.currentTime, readyState: video.readyState,
      seeking: video.seeking, ended: video.ended, playing: c.playing, clockReady: c.clockReady,
      explicitSeek, driftMs: drifting && driftSince.current !== null ? now - driftSince.current : 0, waiting: waiting.current });
    video.playbackRate = c.speed;
    if (state.seek) {
      video.currentTime = state.target;
      lastRevision.current = c.revision;
      driftSince.current = null;
      c.onReady(c.source.url, false);
      return;
    }
    if (explicitSeek && !video.seeking) lastRevision.current = c.revision;
    c.onReady(c.source.url, state.ready);
    if (state.play) {
      if (video.paused) void video.play().catch(error => {
        if (error.name !== "AbortError") onError(c.source.url);
      });
    } else video.pause();
  }, [onError]);
  const resumed = useCallback(() => { waiting.current = false; sync(); }, [sync]);
  useEffect(sync, [sync, source.url, source.originAt, source.durationSeconds, at, sampledAt, playing, clockReady, speed, current, revision]);
  useEffect(() => {
    const video = element.current;
    // Development StrictMode replays setup after cleanup without remounting the DOM node.
    if (video && video.getAttribute("src") !== source.url) video.src = source.url;
    return () => {
      queueMicrotask(() => {
        if (video && !video.isConnected) {
          video.pause();
          video.removeAttribute("src");
          video.load();
        }
      });
    };
  }, [source.url]);
  return <video ref={element} src={source.url} muted playsInline preload="auto" aria-label={label} aria-hidden={!visible}
    width={source.width} height={source.height} className={visible ? "replay-video-surface visible" : "replay-video-surface"}
    onLoadedMetadata={sync} onLoadedData={resumed} onSeeked={resumed} onCanPlay={resumed} onPlaying={resumed} onEnded={resumed}
    onTimeUpdate={() => { if (element.current && element.current.readyState >= 2 && !element.current.seeking) waiting.current = false; sync(); }}
    onWaiting={() => { waiting.current = true; sync(); }} onError={() => current && onError(source.url)} />;
}

export function ReplayVideo({ source, at, liveAt, sampledAt, playing, clockReady, speed, slot, revision, onReady, label, upcoming }: {
  source: Source; at: number; liveAt?: () => number; sampledAt: number; playing: boolean; clockReady: boolean; speed: number; slot: string; revision: number; onReady: Ready; label: string;
  /** Next segment of this slot: mounted paused and hidden so its metadata and first frame are decoded before the boundary. */
  upcoming?: Source;
}) {
  const t = useTranslations("replayVideo");
  const resource = useRef(source);
  const [shown, setShown] = useState<Source | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  resource.current = selectVideoSource(resource.current, source, at, sampledAt,
    failure === videoResourceKey(resource.current));
  source = resource.current;
  const target = useRef(source);
  target.current = source;
  const report = useCallback((url: string, ready: boolean) => {
    if (target.current.url !== url) return;
    if (ready) setShown(previous => previous?.url === url ? previous : target.current);
    onReady(slot, target.current.assetId, ready);
  }, [slot, onReady]);
  const failed = useCallback((url: string) => {
    if (target.current.url === url) {
      setFailure(videoResourceKey(target.current));
      onReady(slot, target.current.assetId, target.current.status !== "pending");
    }
  }, [slot, onReady]);
  const failedResource = failure === videoResourceKey(source);
  const error = source.status === "gap" || source.status === "error" || failedResource && source.status !== "pending";
  // Fragmented segments stream while pending; legacy ones stay paused until ready.
  const pending = source.status === "pending" && (!source.streaming || failedResource);
  useEffect(() => {
    if (pending) onReady(slot, source.assetId, false);
  }, [pending, slot, source.assetId, onReady]);
  const playable = !error && !pending;
  // At most three decoders per channel: the frame still shown, the current segment, and the warmed next segment.
  const sources = [...(shown && (shown.url !== source.url || !playable) && !error ? [shown] : []), ...(playable ? [source] : [])];
  if (upcoming && upcoming.assetId !== source.assetId && !sources.some(value => value.url === upcoming.url)) sources.push(upcoming);
  return <div className="replay-video-stack">
    {sources.map(value => <Surface key={value.url} source={value} at={at} liveAt={liveAt} sampledAt={sampledAt} playing={playing} clockReady={clockReady}
      speed={speed} revision={revision} current={playable && value.url === source.url} visible={shown?.url === value.url}
      onReady={report} onError={failed} label={label} />)}
    {error ? <div className="replay-media-missing" role="status">{source.reason ?? t("unavailable")}<small>{t("gapKept")}</small></div>
      : pending ? <span className="replay-video-status" role="status">{failedResource ? t("unreadableWaiting") : t("writingSegment")}{shown && ` · ${t("keepPrevious")}`}</span>
      : shown?.url !== source.url ? <span className="replay-video-status" role="status">{t("buffering")}</span> : null}
  </div>;
}
