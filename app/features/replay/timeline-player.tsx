"use client";

import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import type { ReplayFrame, ReplayItem, ReplayOverview, ReplayOverviewResult } from "@/lib/replay-types";
import { clampReplayTime, coalesceReplayFrameTicks, indexedFramesAfter, nearbyReplayItems, REPLAY_WINDOW_MS,
  replayDuration, replayItemActive, replayTracks, type CoalescedReplayFrameTick } from "@/features/replay/replay-model";
import { useBufferedMedia } from "@/features/live/use-buffered-media";
import type { BufferedImage } from "@/features/replay/image-buffer";
import { ReplayVideo } from "@/features/replay/replay-video";
import { replayUpcomingVideos, replayVideoReady, type VideoSource } from "@/features/replay/replay-video-model";
import { REPLAY_COARSE_TICK_MS, useReplayClock, useReplaySession, type ReplayClock } from "@/features/replay/use-replay-session";
import "@/features/replay/timeline-player.css";
import { useTranslations } from "@/lib/locale";
import { ChevronLeft, ChevronRight, PanelRight, RefreshCw, RotateCcw, RotateCw, Search, Share2, X } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ReplayTimeJump } from "@/features/replay/replay-time-jump";
import { ReplayEventSearch } from "@/features/replay/replay-event-search";
import { ReplayEvidencePanel, type ReplayEvidenceSelection } from "@/features/replay/replay-evidence-panel";
import { replayElapsedInput, replayEvidenceKey, replayEvidencePatch } from "@/features/replay/replay-navigation";
import { useAnimatedPresence } from "@/components/use-motion-preferences";

const DESKTOP_DOCK_QUERY = "(min-width: 1100px)";

const subscribeDesktopDock = (listener: () => void) => {
  const query = window.matchMedia(DESKTOP_DOCK_QUERY);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
};
const isDesktopDock = () => window.matchMedia(DESKTOP_DOCK_QUERY).matches;

/** Render 3 ticks on narrow lanes (<420px) and 5 ticks on wider lanes. */
export function replayRulerRatios(laneWidth: number): readonly number[] {
  return laneWidth > 0 && laneWidth < 420 ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1];
}

const wallTime = (at: number) => new Date(at).toLocaleTimeString("zh-CN", {
  timeZone: "Asia/Shanghai", hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3,
});
const shortCapabilityName = (capability: string) => {
  const colon = capability.lastIndexOf(":");
  if (colon !== -1 && colon < capability.length - 1) return capability.slice(colon + 1);
  const slash = capability.lastIndexOf("/");
  return slash !== -1 && slash < capability.length - 1 ? capability.slice(slash + 1) : capability;
};
const formatSampleAge = (deltaMs: number, secondsAgoLabel: string) => {
  const clamped = Math.max(0, deltaMs);
  if (clamped < 60_000) return `${(clamped / 1000).toFixed(1)} ${secondsAgoLabel}`;
  const suffix = secondsAgoLabel.includes("秒") ? "前" : "ago";
  const totalSec = Math.round(clamped / 1000);
  if (totalSec >= 3600) {
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    return `${h}h ${m}m ${suffix}`;
  }
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s ${suffix}`;
};
const statusKey: Record<string, string> = { completed: "completed", success: "completed", error: "failed", failed: "failed",
  cancelled: "cancelled", pending: "pending", running: "running" };

type VideoPlayback = { at: number; liveAt?: () => number; playing: boolean; clockReady: boolean; speed: number; revision: number; onReady(slot: string, url: string, ready: boolean): void };
function ReplayMedia({ media, label, sampledAt, image, playback, slot, upcoming }: { media: ReplayFrame["media"][number]; label: string; image?: BufferedImage;
  sampledAt: number; playback: VideoPlayback; slot: string; upcoming?: VideoSource }) {
  const t = useTranslations("timelinePlayer");
  const [failure, setFailure] = useState<{ url: string; message: string } | null>(null);
  const error = failure?.url === media.url ? failure.message : "";
  const setError = (message: string) => setFailure({ url: media.url, message });
  const [text, setText] = useState("");
  const isText = media.mediaType.startsWith("text/") || media.mediaType === "application/json";
  useEffect(() => {
    setError(""); setText("");
    if (!isText) return;
    const controller = new AbortController();
    fetch(media.url, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(response.status === 410 ? t("recordExpired") : t("recordUnreadable"));
      const value = await response.text();
      if (!controller.signal.aborted) setText(value);
    }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [media.url, isText]);
  if (media.video) return <ReplayVideo source={media.video} sampledAt={sampledAt} {...playback} slot={slot} label={label} upcoming={upcoming} />;
  if (image?.error || error) return <div className="replay-media-missing" role="status">{image?.error || error}<small>{t("mediaKeepPosition")}</small></div>;
  if (media.mediaType.startsWith("image/")) return <img src={image?.src} width={image?.width} height={image?.height} alt={label} draggable={false}
    onError={() => setError(t("imageUnavailable"))} />;
  if (media.mediaType.startsWith("audio/")) return <audio controls preload="none" src={media.url}
    aria-label={label} onError={() => setError(t("audioUnavailable"))} />;
  if (media.mediaType.startsWith("video/")) return <video controls preload="metadata" src={media.url}
    aria-label={label} onError={() => setError(t("videoUnavailable"))} />;
  if (isText) return <pre>{text || t("readingText")}</pre>;
  return <a href={media.url} target="_blank" rel="noreferrer">{t("view")} {media.mediaType} {t("record")} ↗</a>;
}

const FrameMedia = memo(function FrameMedia({ frame, images, playback, upcoming, onInspect }: {
  frame: ReplayFrame; images: Map<string, BufferedImage>; playback: VideoPlayback; upcoming: ReadonlyMap<string, VideoSource>;
  onInspect?: (trigger: HTMLElement) => void;
}) {
  const t = useTranslations("timelinePlayer");
  return <><div className="replay-media-grid">
    {frame.media.map(media => <div className={"replay-media" + (media.mediaType.startsWith("image/") ? " replay-image" : "")} key={media.index}>
      <ReplayMedia media={media} sampledAt={frame.at} image={images.get(media.url)} playback={playback} slot={frame.capability + ":" + media.index}
        upcoming={upcoming.get(frame.capability + ":" + media.index)}
        label={frame.capability + " · " + wallTime(frame.at) + " · " + (media.index + 1)} />
    </div>)}
    {!frame.media.length && (
      <div className="replay-no-media-row">
        <p className="replay-no-media">{t("noMedia")}</p>
        {onInspect && (
          <Button type="button" variant="outline" size="xs" onClick={event => onInspect(event.currentTarget)}>
            {t("inspectRecordDetails")}
          </Button>
        )}
      </div>
    )}
  </div>
    {frame.text && <details className="replay-frame-text"><summary>{t("frameText")}</summary><pre>{frame.text}</pre></details>}
  </>;
});

const EMPTY_IMAGES = new Map<string, BufferedImage>();

/** Native range input bound to the animation clock; it re-renders alone, never the player tree. */
function ReplaySeekInput({ clock, startAt, endAt, label, onScrub, onSeek, onRelease }: {
  clock: ReplayClock; startAt: number; endAt: number; label: string; onScrub(value: number): void; onSeek(value: number): void; onRelease(): void;
}) {
  const at = useReplayClock(clock), duration = endAt - startAt;
  // Only a pointer drag is a scrub (network settles on release); any other change seeks and commits at once.
  const dragging = useRef(false);
  const release = () => { if (!dragging.current) return; dragging.current = false; onRelease(); };
  return <input className="replay-seek accent-primary focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
    type="range" min={startAt} max={Math.max(endAt, startAt + 1)} step="1" value={at}
    disabled={duration <= 0} aria-label={label} aria-valuetext={replayDuration(at - startAt) + " / " + replayDuration(duration)}
    onPointerDown={() => { dragging.current = true; }}
    onChange={event => { const value = Number(event.target.value); if (dragging.current) onScrub(value); else onSeek(value); }}
    onPointerUp={release} onPointerCancel={release} onBlur={release} onKeyUp={onRelease} />;
}

function ReplayClockText({ clock, className }: { clock: ReplayClock; className: string }) {
  return <span className={className}>{wallTime(useReplayClock(clock))}</span>;
}

function ReplayCursor({ clock, className, startAt, span }: { clock: ReplayClock; className: string; startAt: number; span: number }) {
  const at = useReplayClock(clock);
  const pct = Math.max(0, Math.min(100, (at - startAt) / span * 100));
  return <i className={className} style={{ transform: `translateX(${pct}cqi)` }} />;
}

/** Event lanes only re-render when items, the window, or the set of active items change. */
const ReplayTrackStack = memo(function ReplayTrackStack({ clock, items, activeKey, startAt, endAt, sampledStartAt, sampledEndAt, ticks,
  onSelectFrame, onSelectItem, onSeek }: {
  clock: ReplayClock; items: ReplayItem[]; activeKey: string; startAt: number; endAt: number; sampledStartAt: number; sampledEndAt: number;
  ticks: CoalescedReplayFrameTick[]; onSelectFrame(frame: ReplayFrame, trigger: HTMLElement): void;
  onSelectItem(item: ReplayItem, trigger: HTMLElement): void; onSeek(at: number): void;
}) {
  const t = useTranslations("timelinePlayer");
  const nt = useTranslations("replayNavigation");
  const span = Math.max(1, endAt - startAt);
  const x = (time: number) => Math.max(0, Math.min(100, (time - startAt) / span * 100));
  const active = new Set(activeKey ? activeKey.split("|") : []);
  const sampledLeftPct = x(sampledStartAt), sampledRightPct = x(sampledEndAt);
  const hasUnsampledPerceptionEdges = span > sampledEndAt - sampledStartAt + 500;
  const byTrack = useMemo(() => new Map(replayTracks.map(track => [track, items.filter(item => item.track === track)])), [items]);
  const seekOnLaneClick = (event: MouseEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    onSeek(startAt + Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * span);
  };
  return <div className="replay-tracks-stack">
    <div className="replay-track-row">
      <span className="replay-track-label"><i className="replay-track-dot perception" />{t("track.perception")}</span>
      <div className="replay-track-lane" onClick={seekOnLaneClick}>
        {hasUnsampledPerceptionEdges && sampledLeftPct > 0.25 && (
          <span className="replay-unsampled-region" aria-hidden="true" title={nt("frameWindowNote")}
            style={{ left: "0%", width: `${sampledLeftPct}%` }} />
        )}
        {hasUnsampledPerceptionEdges && sampledRightPct < 99.75 && (
          <span className="replay-unsampled-region" aria-hidden="true" title={nt("frameWindowNote")}
            style={{ left: `${sampledRightPct}%`, width: `${100 - sampledRightPct}%` }} />
        )}
        <span className="replay-sampled-window" aria-hidden="true" title={t("sampledWindowHint")}
          style={{ left: sampledLeftPct + "%", width: Math.max(0.5, sampledRightPct - sampledLeftPct) + "%" }} />
        {ticks.map(tick => (
          <button type="button" key={tick.frame.id}
            className={"replay-frame-tick focus-visible:z-10 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring" + (tick.count > 1 ? " coalesced" : "")}
            style={{ left: x(tick.startAt) + "%", width: tick.count > 1 ? Math.max(0.35, x(tick.endAt) - x(tick.startAt)) + "%" : undefined }}
            aria-label={t("viewPerception") + " " + wallTime(tick.frame.at)}
            title={tick.frame.capability + " · " + wallTime(tick.frame.at) + (tick.count > 1 ? ` (${tick.count})` : "")}
            onClick={event => { event.stopPropagation(); onSelectFrame(tick.frame, event.currentTarget); }} />
        ))}
        <ReplayCursor clock={clock} className="replay-cursor" startAt={startAt} span={span} />
      </div>
    </div>

    {replayTracks.map(track => (
      <div key={track} className="replay-track-row">
        <span className="replay-track-label"><i className={"replay-track-dot " + track} />{t(`track.${track}`)}</span>
        <div className="replay-track-lane" onClick={seekOnLaneClick}>
          {byTrack.get(track)!.map(item => {
            const leftPct = x(item.startAt);
            const rawWidthPct = x(item.track === "log" ? item.startAt : item.endAt ?? endAt) - leftPct;
            const widthPct = Math.max(0.45, rawWidthPct);
            return (
              <button type="button" key={item.id}
                className={"replay-span focus-visible:z-10 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring " + track + (active.has(item.id) ? " active" : "") + (/error|failed/.test(item.status ?? "") ? " failed" : "")}
                style={{ left: leftPct + "%", width: widthPct + "%" }}
                title={item.label + " · " + wallTime(item.startAt)}
                aria-label={t(`track.${track}`) + " · " + item.label}
                onClick={event => { event.stopPropagation(); onSelectItem(item, event.currentTarget); }}>
                {track === "log" || widthPct < 4.5 ? "" : item.label}
              </button>
            );
          })}
          <ReplayCursor clock={clock} className="replay-cursor" startAt={startAt} span={span} />
        </div>
      </div>
    ))}
  </div>;
});

export interface TimelinePlayerProps {
  project: string;
  run: string;
  epoch?: string;
  position?: string | null;
  evidence?: ReplayEvidenceSelection | null;
  onPosition(at: number, selection?: ReplayEvidenceSelection | null, options?: { replace?: boolean }): void;
  onEvidence(selection: ReplayEvidenceSelection | null): void;
  onOverview?(value: ReplayOverviewResult): void;
  archiveRevision?: number;
  /** Optional preloaded overview for SSR / deterministic component tests */
  initialOverview?: ReplayOverview | null;
  /** Compact RunPicker rendered at the start of .replay-studio-topbar-left */
  runPicker?: ReactNode;
  /** Mobile <=680px sidebar drawer trigger rendered at the start of .replay-studio-topbar-left */
  mobileNavSlot?: ReactNode;
}

export function TimelinePlayer({
  project,
  run,
  epoch,
  position,
  evidence = null,
  onPosition,
  onEvidence,
  onOverview,
  archiveRevision,
  initialOverview = null,
  runPicker,
  mobileNavSlot,
}: TimelinePlayerProps) {
  const t = useTranslations("timelinePlayer");
  const nt = useTranslations("replayNavigation");
  const controlsId = useId();
  const desktopDock = useSyncExternalStore(subscribeDesktopDock, isDesktopDock, () => true);
  const evidenceKey = replayEvidenceKey(evidence);
  const initialEvidenceKeyRef = useRef(evidenceKey);
  const [dockOpen, setDockOpen] = useState(() =>
    typeof window === "undefined" ? true : window.matchMedia(DESKTOP_DOCK_QUERY).matches || Boolean(evidence),
  );
  const { mounted: overlayBackdropMounted, state: overlayBackdropState } = useAnimatedPresence(!desktopDock && dockOpen, 180);
  const userDesktopPrefRef = useRef<boolean | null>(null);
  const prevDesktopDockRef = useRef<boolean | null>(null);
  const [inspectorTab, setInspectorTab] = useState("events");
  const evidencePanel = useRef<HTMLElement>(null);
  const evidenceOpener = useRef<HTMLElement | null>(null);
  const eventsTab = useRef<HTMLButtonElement>(null);
  const eventSearchInput = useRef<HTMLInputElement>(null);
  const dockToggleRef = useRef<HTMLButtonElement>(null);
  const player = useRef<HTMLDivElement>(null);
  const stageMainRef = useRef<HTMLElement>(null);
  const timeAxisRef = useRef<HTMLDivElement>(null);
  const [stageWidth, setStageWidth] = useState(0);
  const [laneWidth, setLaneWidth] = useState(0);
  const evidencePresentation = useRef({ dockOpen, evidenceKey, inspectorTab });
  evidencePresentation.current = { dockOpen, evidenceKey, inspectorTab };
  const lastEvidence = useRef("");

  useEffect(() => {
    if (prevDesktopDockRef.current === null) {
      prevDesktopDockRef.current = desktopDock;
      setDockOpen(desktopDock || Boolean(initialEvidenceKeyRef.current));
      return;
    }
    if (prevDesktopDockRef.current !== desktopDock) {
      prevDesktopDockRef.current = desktopDock;
      setDockOpen(desktopDock ? (userDesktopPrefRef.current ?? true) : false);
    }
  }, [desktopDock]);

  useEffect(() => {
    if (desktopDock || !dockOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        setDockOpen(false);
        requestAnimationFrame(() => dockToggleRef.current?.focus());
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [desktopDock, dockOpen]);

  const restoreEvidenceFocus = () => {
    const opener = evidenceOpener.current;
    if (opener?.isConnected && opener.getClientRects().length) opener.focus();
    else if (eventsTab.current?.getClientRects().length) eventsTab.current.focus();
    else player.current?.focus({ preventScroll: true });
  };

  useEffect(() => {
    if (evidenceKey) {
      const newEvidence = evidenceKey !== lastEvidence.current;
      if (newEvidence) {
        setDockOpen(true);
        setInspectorTab("details");
      }
      if (newEvidence || evidencePresentation.current.inspectorTab === "details") {
        requestAnimationFrame(() => {
          const current = evidencePresentation.current;
          if (!current.dockOpen || current.evidenceKey !== evidenceKey || current.inspectorTab !== "details") return;
          evidencePanel.current?.focus({ preventScroll: true });
          evidencePanel.current?.scrollIntoView({ block: "nearest" });
        });
      }
    } else {
      if (lastEvidence.current) setInspectorTab("events");
      if (lastEvidence.current && document.activeElement === document.body) requestAnimationFrame(restoreEvidenceFocus);
    }
    lastEvidence.current = evidenceKey;
  }, [evidenceKey]);

  const requestedScope = new URLSearchParams({ project, run, ...(epoch ? { epoch } : {}) }).toString();
  const [capability, setCapability] = useState("");
  const [windowMs, setWindowMs] = useState(REPLAY_WINDOW_MS);
  const [shareState, setShareState] = useState("");
  const [videoReadiness, setVideoReadiness] = useState<Record<string, { url: string; ready: boolean }>>({});
  const onVideoReady = useCallback((slot: string, url: string, ready: boolean) => {
    setVideoReadiness(previous => previous[slot]?.url === url && previous[slot].ready === ready
      ? previous : { ...previous, [slot]: { url, ready } });
  }, []);
  const initialPosition = useRef(position);
  const userMovedRef = useRef(Boolean(position != null || evidence));
  const [knownCapabilities, setKnownCapabilities] = useState<string[]>(initialOverview?.capabilities ?? []);
  const positionApplied = useRef<string | null | undefined>(undefined);
  const evidenceRef = useRef(evidence);
  evidenceRef.current = evidence;
  const commitPosition = useCallback((next: number, selection: ReplayEvidenceSelection | null = null, options?: { replace?: boolean }) => {
    positionApplied.current = String(Math.round(next));
    onPosition(Math.round(next), selection, options);
  }, [onPosition]);

  const session = useReplaySession({
    project, run, epoch, initialOverview, initialPosition: initialPosition.current, archiveRevision, capability, eventWindowMs: windowMs,
    onOverview, onEnded: next => commitPosition(next, evidenceRef.current, { replace: true }), userMoved: () => userMovedRef.current,
  });
  const { overview, scope, coverage, overviewError, refreshing, at, clock, clockRevision, playing, setPlaying, speed, setSpeed, move,
    bounds, eventBounds, index, activeWindow, items, stepping, initialPreviewFrame, windowError } = session;

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const stageEl = stageMainRef.current;
    const axisEl = timeAxisRef.current;
    if (!stageEl && !axisEl) return;
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        const inlineWidth = entry.contentRect.width;
        if (entry.target === stageEl) setStageWidth(inlineWidth);
        if (entry.target === axisEl) setLaneWidth(inlineWidth);
      }
    });
    if (stageEl) {
      setStageWidth(stageEl.getBoundingClientRect().width);
      observer.observe(stageEl);
    }
    if (axisEl) {
      setLaneWidth(axisEl.getBoundingClientRect().width);
      observer.observe(axisEl);
    }
    return () => observer.disconnect();
  }, [Boolean(overview), Boolean(project && run)]);

  useEffect(() => {
    userMovedRef.current = Boolean(position != null || evidence);
    setKnownCapabilities([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedScope]);

  useEffect(() => {
    if (!overview || position === positionApplied.current) return;
    positionApplied.current = position;
    if (position != null) { setPlaying(false); move(clampReplayTime(Number(position), overview)); }
  }, [position, overview, move, setPlaying]);

  useEffect(() => {
    const discovered = [...(overview?.capabilities ?? []), ...index.byCapability.keys()];
    if (!discovered.length) return;
    setKnownCapabilities(previous => {
      const merged = [...new Set([...previous, ...discovered])];
      return merged.length === previous.length ? previous : merged;
    });
  }, [overview?.capabilities, index]);

  const visibleFrames = useMemo(
    () =>
      session.stageFrames.length > 0
        ? session.stageFrames
        : !userMovedRef.current && overview && at <= overview.startAt && initialPreviewFrame && initialPreviewFrame.at > at && (!capability || initialPreviewFrame.capability === capability)
          ? [initialPreviewFrame]
          : [],
    [session.stageFrames, overview, initialPreviewFrame, at, capability],
  );
  const pastCapabilities = useMemo(() => new Set(visibleFrames.filter(frame => frame.at <= at).map(frame => frame.capability)), [visibleFrames, at]);
  // Records are immutable. Keep frame identity stable while the playhead moves within one sample.
  const frameKey = useMemo(() => JSON.stringify(visibleFrames.map(frame => [frame.id, frame.media])), [visibleFrames]);
  const target = useMemo(() => activeWindow ? { key: frameKey, value: visibleFrames,
    urls: visibleFrames.flatMap(frame => frame.media.filter(media => media.mediaType.startsWith("image/") && !media.video).map(media => media.url)) } : null,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [frameKey, !!activeWindow]);
  const future = useMemo(() => indexedFramesAfter(index, at, capability, 6)
    .flatMap(frame => frame.media.filter(media => media.mediaType.startsWith("image/") && !media.video).map(media => media.url)), [index, at, capability]);
  const { displayed, pending } = useBufferedMedia(scope + ":" + capability + ":" + session.refreshRevision + ":" + session.retryRevision, target, future, !activeWindow || stepping);
  // Video frames share a decoder for the entire segment; advancing record metadata must not pause playback.
  const frameTail = activeWindow?.frames.at(-1)?.at;
  const imageReady = !!activeWindow && (session.frameWindowComplete || frameTail === undefined || at <= frameTail) && (!target?.urls.length || !pending) && !stepping;
  const shownFrames = (target && !target.urls.length ? visibleFrames : displayed?.value ?? [])
    .filter(frame => frame.at <= at || !pastCapabilities.has(frame.capability));
  const visualFrames = [...shownFrames.filter(frame => frame.media.length > 0 || Boolean(frame.text))].sort((a, b) => {
    const aPrimary = /perception\.sample$/i.test(a.capability) ? 1 : 0;
    const bPrimary = /perception\.sample$/i.test(b.capability) ? 1 : 0;
    if (aPrimary !== bPrimary) return bPrimary - aPrimary;
    const aVideo = a.media.some(m => Boolean(m.video)) ? 1 : 0;
    const bVideo = b.media.some(m => Boolean(m.video)) ? 1 : 0;
    if (aVideo !== bVideo) return bVideo - aVideo;
    return a.capability.localeCompare(b.capability);
  });
  const dataOnlyFrames = shownFrames.filter(frame => frame.media.length === 0 && !frame.text);
  const compactDataFrames = visualFrames.length > 0 ? dataOnlyFrames : dataOnlyFrames.length > 1 ? dataOnlyFrames : [];
  const stageFrames = visualFrames.length > 0 ? visualFrames : dataOnlyFrames.length === 1 ? dataOnlyFrames : [];
  const videoSlots = useMemo(() => visibleFrames.flatMap(frame => frame.media.filter(media => media.video)
    .map(media => ({ slot: frame.capability + ":" + media.index, capability: frame.capability, index: media.index, video: media.video! }))), [visibleFrames]);
  const slotsKey = JSON.stringify(videoSlots.map(({ slot }) => slot));
  useEffect(() => {
    const keep = new Set<string>(JSON.parse(slotsKey));
    setVideoReadiness(previous => {
      if (Object.keys(previous).every(slot => keep.has(slot))) return previous;
      return Object.fromEntries(Object.entries(previous).filter(([slot]) => keep.has(slot)));
    });
  }, [slotsKey]);
  // Warm the next segment's decoder before the playhead crosses into it.
  const upcomingVideos = useMemo(() => replayUpcomingVideos(index, videoSlots, at, Math.max(1, speed) * 8_000), [index, videoSlots, at, speed]);
  const ready = imageReady && videoSlots.every(({ slot, video }) => replayVideoReady(video, videoReadiness[slot]));
  session.readyRef.current = ready;

  const coarseAt = Math.floor(at / REPLAY_COARSE_TICK_MS) * REPLAY_COARSE_TICK_MS;
  const activeItems = useMemo(() => items.filter(item => item.track !== "log" && replayItemActive(item, coarseAt)), [items, coarseAt]);
  const logs = useMemo(() => nearbyReplayItems(items.filter(item => item.track === "log"), coarseAt, 8), [items, coarseAt]);
  const activeKey = activeItems.map(item => item.id).join("|");
  const capabilities = [...new Set([
    ...knownCapabilities,
    ...(overview?.capabilities ?? []),
    ...(capability ? [capability] : []),
  ])];
  const seek = (next: number, commit = true, selection: ReplayEvidenceSelection | null = null, scrub = false) => {
    if (!overview) return;
    userMovedRef.current = true;
    session.cancelStep(); setPlaying(false);
    const value = clampReplayTime(next, overview);
    setShareState(""); move(value, { scrub });
    if (commit) commitPosition(value, selection);
  };
  const step = async (direction: -1 | 1) => {
    if (!overview) return;
    userMovedRef.current = true;
    setPlaying(false);
    const next = await session.findAdjacent(direction);
    if (next) seek(next.at);
  };
  const selectFrame = (frame: ReplayFrame, trigger: HTMLElement) => {
    evidenceOpener.current = trigger;
    setDockOpen(true);
    setInspectorTab("details");
    seek(frame.at, true, { kind: "frame", record: frame.id, sequence: frame.sequence });
    requestAnimationFrame(() => evidencePanel.current?.focus({ preventScroll: true }));
  };
  const selectItem = (item: ReplayItem, trigger: HTMLElement) => {
    evidenceOpener.current = trigger;
    setDockOpen(true);
    setInspectorTab("details");
    seek(item.startAt, true, { kind: "item", id: item.id });
    requestAnimationFrame(() => evidencePanel.current?.focus({ preventScroll: true }));
  };
  // Stable handles for memoized lanes: the latest closure runs, the identity never changes.
  const latest = useRef({ selectFrame, selectItem, seek });
  latest.current = { selectFrame, selectItem, seek };
  const onSelectFrame = useCallback((frame: ReplayFrame, trigger: HTMLElement) => latest.current.selectFrame(frame, trigger), []);
  const onSelectItem = useCallback((item: ReplayItem, trigger: HTMLElement) => latest.current.selectItem(item, trigger), []);
  const onSeekTo = useCallback((value: number) => latest.current.seek(value), []);
  const closeEvidence = () => {
    setInspectorTab("events");
    onEvidence(null);
    requestAnimationFrame(restoreEvidenceFocus);
  };
  const toggleDock = () => {
    setDockOpen(previous => {
      const next = !previous;
      if (desktopDock) userDesktopPrefRef.current = next;
      return next;
    });
  };
  const evidenceUrl = (item: ReplayItem) => {
    const url = new URL(typeof window === "undefined" ? "http://localhost/" : window.location.href);
    url.searchParams.set("view", "replay"); url.searchParams.set("project", project); url.searchParams.set("run", run);
    url.searchParams.set("epoch", overview?.epoch ?? "all"); url.searchParams.set("at", String(item.startAt));
    for (const [key, value] of Object.entries(replayEvidencePatch({ kind: "item", id: item.id }))) {
      if (value === null) url.searchParams.delete(key); else url.searchParams.set(key, value);
    }
    return url.pathname + url.search;
  };
  const evidenceView = evidence && <ReplayEvidencePanel key={scope + evidenceKey} scope={scope} selection={evidence} refreshRevision={session.refreshRevision} focusRef={evidencePanel} onClose={closeEvidence}
    onLoaded={detail => {
      if (position == null && overview && detail.summary) seek(detail.summary.startAt, true, evidence);
    }} />;
  const share = async () => {
    const now = session.atRef.current;
    commitPosition(now, evidence);
    const url = new URL(window.location.href);
    url.searchParams.set("view", "replay"); url.searchParams.set("at", String(Math.round(now)));
    url.searchParams.set("project", project); url.searchParams.set("run", run);
    url.searchParams.set("epoch", overview?.epoch ?? "all");
    for (const [key, value] of Object.entries(replayEvidencePatch(evidence))) {
      if (value === null) url.searchParams.delete(key); else url.searchParams.set(key, value);
    }
    try { await navigator.clipboard.writeText(url.toString()); setShareState(t("linkCopied")); }
    catch { setShareState(t("timeInUrl")); }
  };

  const trackFrames = useMemo(
    () => (activeWindow?.frames ?? []).filter(frame => frame.at >= bounds.startAt && (!capability || frame.capability === capability)),
    [activeWindow, bounds.startAt, capability],
  );
  const coalescedTrackTicks = useMemo(
    () => coalesceReplayFrameTicks(trackFrames, eventBounds.startAt, eventBounds.endAt, 120),
    [trackFrames, eventBounds.startAt, eventBounds.endAt],
  );
  const playbackLive = useMemo<VideoPlayback>(() => ({ at, liveAt: clock.get, playing, clockReady: ready, speed, revision: clockRevision, onReady: onVideoReady }),
    [at, clock, playing, ready, speed, clockRevision, onVideoReady]);
  const playbackPreview = useMemo<VideoPlayback>(() => ({ ...playbackLive, liveAt: undefined, playing: false }), [playbackLive]);

  if (!project || !run) {
    return (
      <div className="replay-player outline-none">
        {(mobileNavSlot || runPicker) && (
          <header className="replay-studio-topbar">
            <div className="replay-studio-topbar-left">{mobileNavSlot}{runPicker}</div>
          </header>
        )}
        <section className="surface empty-state m-4">
          <h2>{t("emptyTitle")}</h2>
          <p>{t("emptyDescription")}</p>
        </section>
      </div>
    );
  }

  if (!overview) {
    return (
      <div className="replay-player outline-none">
        {(mobileNavSlot || runPicker) && (
          <header className="replay-studio-topbar">
            <div className="replay-studio-topbar-left">{mobileNavSlot}{runPicker}</div>
          </header>
        )}
        <section className="surface empty-state m-4">
          <h1>{overviewError ? t("unavailable") : t("preparing")}</h1>
          {overviewError ? (
            <Alert variant="destructive"><AlertDescription>{overviewError}</AlertDescription></Alert>
          ) : (
            <p role="status">
              {coverage
                ? <>{t("readingSourceDir")} {Math.round(coverage.bytes / Math.max(1, coverage.totalBytes) * 100)}% · {t("loadIndependent")}</>
                : t("readingFromRecords")}
            </p>
          )}
          {overviewError && (
            <Button type="button" variant="outline" size="sm" onClick={session.refreshOverview}>
              {t("retryLoad")}
            </Button>
          )}
        </section>
      </div>
    );
  }

  const duration = overview.endAt - overview.startAt;
  const windowSpan = Math.max(1, eventBounds.endAt - eventBounds.startAt);
  const x = (time: number) => Math.max(0, Math.min(100, (time - eventBounds.startAt) / windowSpan * 100));

  const seekOnLaneClick = (event: MouseEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    seek(eventBounds.startAt + ratio * windowSpan);
  };

  const ratios = replayRulerRatios(laneWidth);
  const narrowLane = ratios.length === 3;
  const compactStage = stageWidth > 0 && stageWidth < 740;
  const rulerTicks = ratios.map(ratio => ({
    ratio,
    time: eventBounds.startAt + ratio * windowSpan - overview.startAt,
  }));

  const refreshLabel = refreshing ? t("refreshing") : t("refreshRecords");
  const dockToggleLabel = nt(dockOpen ? "hideInspector" : "showInspector");

  return <div ref={player} tabIndex={-1} className="replay-player outline-none">
    {overviewError && <Alert variant="destructive"><AlertDescription>{overviewError}{t("keepLoaded")}</AlertDescription></Alert>}

    <div
      className="replay-workbench"
      data-dock-open={dockOpen ? "true" : undefined}
      data-overlay-dock={!desktopDock ? "true" : undefined}
    >
      <section
        ref={stageMainRef}
        className="surface replay-studio-main"
        data-compact-stage={compactStage ? "true" : undefined}
        aria-label={t("stageTitle")}
      >
        <header className="replay-studio-topbar">
          <div className="replay-studio-topbar-left">
            {mobileNavSlot}
            {runPicker}
            {(capabilities.length > 1 || Boolean(capability)) && (
              <div className="replay-capability">
                <Label htmlFor={`${controlsId}-capability`} className="sr-only">{t("capabilityLabel")}</Label>
                <NativeSelect
                  id={`${controlsId}-capability`}
                  size="sm"
                  className="h-7 max-w-[156px] py-0 pr-7 text-xs data-[size=sm]:h-7 data-[size=sm]:py-0"
                  value={capability}
                  onChange={event => {
                    session.cancelStep(); setCapability(event.target.value);
                  }}
                >
                  <NativeSelectOption value="">{t("allCapabilities")}</NativeSelectOption>
                  {capabilities.map(value => <NativeSelectOption key={value} value={value}>{shortCapabilityName(value)}</NativeSelectOption>)}
                </NativeSelect>
              </div>
            )}
            {coverage && !coverage.complete && (
              <span
                className="replay-coverage-pill"
                role="status"
                title={`${t("coverageReadPrefix")} ${Math.round(coverage.bytes / Math.max(1, coverage.totalBytes) * 100)}%`}
              >
                <span className="replay-coverage-label">{t("coverageReadPrefix")} </span>
                {Math.round(coverage.bytes / Math.max(1, coverage.totalBytes) * 100)}%
              </span>
            )}
          </div>

          <div className="replay-studio-topbar-right">
            {shareState && <span className="replay-share-feedback" role="status">{shareState}</span>}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="replay-topbar-action-btn"
              title={nt("findEvent")}
              aria-label={nt("findEvent")}
              onClick={() => {
                setDockOpen(true);
                setInspectorTab("events");
                requestAnimationFrame(() => eventSearchInput.current?.focus());
              }}
            >
              <Search className="size-3.5" aria-hidden="true" />
              <span className="replay-topbar-btn-label">{nt("findEvent")}</span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="replay-topbar-action-btn"
              disabled={refreshing}
              title={refreshLabel}
              aria-label={refreshLabel}
              onClick={session.refresh}
            >
              <RefreshCw className={"size-3.5" + (refreshing ? " motion-safe:animate-spin" : "")} aria-hidden="true" />
              <span className="replay-topbar-btn-label">{refreshLabel}</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="replay-topbar-action-btn"
              title={t("shareMoment")}
              aria-label={t("shareMoment")}
              onClick={share}
            >
              <Share2 className="size-3.5" aria-hidden="true" />
              <span className="replay-topbar-btn-label">{t("shareMoment")}</span>
            </Button>
            <Button
              ref={dockToggleRef}
              type="button"
              variant="ghost"
              size="icon-xs"
              className="replay-dock-toggle-btn"
              data-replay-dock-toggle=""
              data-active={dockOpen ? "true" : undefined}
              aria-expanded={dockOpen}
              title={dockToggleLabel}
              aria-label={dockToggleLabel}
              onClick={toggleDock}
            >
              <PanelRight className="size-3.5" aria-hidden="true" />
            </Button>
          </div>
        </header>

        <div className="replay-frames" aria-busy={!ready}>
          {shownFrames.length ? (
            <>
              <div className={"replay-stage-grid" + (stageFrames.length > 1 ? " multi" : "")}>
                {stageFrames.map(frame => {
                  const isPreview = frame.at > at;
                  return (
                    <article className="replay-frame" key={frame.capability} data-frame-id={frame.id}>
                      <div className="replay-frame-meta">
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          className="replay-frame-inspect-btn min-w-0 flex-1 shrink justify-start overflow-hidden"
                          title={frame.capability}
                          onClick={event => selectFrame(frame, event.currentTarget)}
                        >
                          <span className="truncate">{shortCapabilityName(frame.capability)} · #{frame.sequence} ↗</span>
                        </Button>
                        {isPreview ? (
                          <div className="replay-preview-actions">
                            <span className="replay-preview-badge">
                              {t("initialPreview")} · {wallTime(frame.at)}
                            </span>
                            {frame.at - at > 3000 && (
                              <Button type="button" variant="outline" size="xs" className="shrink-0 whitespace-nowrap" onClick={() => seek(frame.at)}>
                                {t("jumpToSample").replace("{time}", replayDuration(frame.at - overview.startAt))}
                              </Button>
                            )}
                          </div>
                        ) : (
                          <span className="replay-frame-sample-meta">
                            {t("sampled")} {wallTime(frame.at)}
                            {ready ? " · " + formatSampleAge(at - frame.at, t("secondsAgo")) : t("previousFrame")}
                          </span>
                        )}
                      </div>
                      <FrameMedia
                        key={session.refreshRevision + ":" + session.retryRevision}
                        frame={frame}
                        images={displayed?.images ?? EMPTY_IMAGES}
                        playback={isPreview ? playbackPreview : playbackLive}
                        upcoming={upcomingVideos}
                        onInspect={trigger => selectFrame(frame, trigger)}
                      />
                    </article>
                  );
                })}
              </div>
              {compactDataFrames.length > 0 && (
                <div className="replay-data-frames">
                  {compactDataFrames.map(frame => {
                    const isPreview = frame.at > at;
                    return (
                      <article className="replay-frame replay-frame-compact" key={frame.capability} data-frame-id={frame.id}>
                        <div className="replay-frame-meta">
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            className="replay-frame-inspect-btn"
                            title={frame.capability}
                            onClick={event => selectFrame(frame, event.currentTarget)}
                          >
                            {shortCapabilityName(frame.capability)} · #{frame.sequence} ↗
                          </Button>
                          {isPreview ? (
                            <span className="replay-preview-badge">
                              {t("initialPreview")} · {wallTime(frame.at)}
                            </span>
                          ) : (
                            <span>
                              {t("sampled")} {wallTime(frame.at)}
                              {ready ? " · " + formatSampleAge(at - frame.at, t("secondsAgo")) : t("previousFrame")}
                            </span>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
              {!stageFrames.length && <p className="replay-no-media">{t("noMedia")}</p>}
            </>
          ) : (
            <div className="replay-loading">
              {!ready ? t("loadingFrames") : capability ? t("noFramesFiltered") : t("noFramesAll")}
              <small>{t("playbackContinues")}</small>
              {ready && (
                <div className="replay-empty-actions">
                  {at < overview.endAt && (
                    <Button type="button" variant="outline" size="xs" disabled={stepping} onClick={() => void step(1)}>
                      {t("jumpNextFrame")}
                    </Button>
                  )}
                  {capability && (
                    <Button type="button" variant="ghost" size="xs" onClick={() => setCapability("")}>
                      {t("showAllCapabilities")}
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
          {!ready && <span className="replay-buffering" role="status">{windowError ? t("segmentFailed") : t("buffering")}</span>}
        </div>

        {windowError && <Alert variant="destructive" className="mx-4 my-2"><AlertDescription className="flex flex-wrap items-center justify-between gap-2">
          <span>{windowError}</span><Button type="button" variant="outline" size="xs" onClick={session.retry}>{t("retrySegment")}</Button>
        </AlertDescription></Alert>}

        <div className="replay-controls">
          {/* The media scrubber keeps native pointer/key commit semantics and millisecond steps. */}
          <ReplaySeekInput clock={clock} startAt={overview.startAt} endAt={overview.endAt} label={t("seekLabel")}
            onScrub={value => seek(value, false, null, true)} onSeek={value => seek(value)}
            onRelease={() => { const now = session.atRef.current; move(now); commitPosition(now); }} />

          <div className="replay-control-row">
            <div className="replay-transport">
              <Button type="button" size="xs" className="min-w-[50px] px-1.5 font-medium" aria-label={playing ? t("pauseReplay") : t("playReplay")} disabled={duration <= 0 || !!windowError}
                onClick={() => {
                  userMovedRef.current = true;
                  session.cancelStep();
                  if (playing) {
                    setPlaying(false);
                    move(session.atRef.current);
                    commitPosition(session.atRef.current, evidence, { replace: true });
                    return;
                  }
                  if (session.atRef.current >= overview.endAt) {
                    move(overview.startAt);
                    commitPosition(overview.startAt, evidence, { replace: true });
                  }
                  setPlaying(true);
                }}>
                {playing ? t("pause") : t("play")}
              </Button>
              <Button type="button" variant="outline" size="xs" className="px-1.5" aria-label={nt("backTen")} disabled={at <= overview.startAt} onClick={() => seek(at - 10_000)}>
                <RotateCcw className="size-3" aria-hidden="true" />10s
              </Button>
              <Button type="button" variant="outline" size="xs" className="px-1.5" aria-label={t("prevFrame")} disabled={stepping || at <= overview.startAt} onClick={() => void step(-1)}>
                {t("prevFrameShort")}
              </Button>
              <Button type="button" variant="outline" size="xs" className="px-1.5" aria-label={t("nextFrame")} disabled={stepping || at >= overview.endAt} onClick={() => void step(1)}>
                {t("nextFrameShort")}
              </Button>
              <Button type="button" variant="outline" size="xs" className="px-1.5" aria-label={nt("forwardTen")} disabled={at >= overview.endAt} onClick={() => seek(at + 10_000)}>
                <RotateCw className="size-3" aria-hidden="true" />10s
              </Button>
              <ReplayTimeJump elapsed={at - overview.startAt} duration={duration} onJump={elapsed => seek(overview.startAt + elapsed)} />
            </div>

            <div className="replay-clock">
              <ReplayClockText clock={clock} className="replay-wallclock-pill mono" />
              <NativeSelect size="sm" className="h-6 min-w-[62px] rounded-[5px] py-0 pl-2 pr-6 text-xs data-[size=sm]:h-6 data-[size=sm]:py-0" aria-label={t("speedLabel")} value={speed} onChange={event => setSpeed(Number(event.target.value))}>
                {[0.25, 0.5, 1, 2, 4, 8].map(value => <NativeSelectOption key={value} value={value}>{value}×</NativeSelectOption>)}
              </NativeSelect>
            </div>
          </div>
        </div>

        <div className="replay-timeline" role="region" aria-label={t("timelineLabel")} data-narrow-lane={narrowLane ? "true" : undefined}>
          <div className="replay-timeline-header">
            <div className="replay-timeline-title-group">
              <h2>{t("timelineTitle")}</h2>
              <span className="replay-window-range-pill mono">
                {replayElapsedInput(eventBounds.startAt - overview.startAt, "seconds")} – {replayElapsedInput(eventBounds.endAt - overview.startAt, "seconds")}
              </span>
              {session.eventsLoading && <span className="replay-timeline-status" role="status">{t("supplementingEvents")}</span>}
              {session.eventsHaveMore && !session.eventsLoading && (
                <Button type="button" variant="ghost" size="xs" className="h-5 px-1.5 text-[11px]" onClick={() => void session.continueEvents()}>{t("continueEvents")}</Button>
              )}
            </div>
            <div className="replay-window-size">
              <Label htmlFor={`${controlsId}-window`} className="replay-window-label text-xs font-normal">{t("windowLabel")}</Label>
              <NativeSelect id={`${controlsId}-window`} size="sm" className="h-6 min-w-[74px] rounded-[5px] py-0 pl-2 pr-6 text-xs data-[size=sm]:h-6 data-[size=sm]:py-0" aria-label={t("windowSelectLabel")} value={windowMs} onChange={event => {
                setWindowMs(Number(event.target.value));
              }}>
                {[5, 15, 30, 60, 300, 900].map(seconds => (
                  <NativeSelectOption key={seconds} value={seconds * 1000}>
                    {seconds >= 60 ? `${seconds / 60} ${nt("minutes")}` : `${seconds} ${t("seconds")}`}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <Button type="button" variant="outline" size="icon-xs" aria-label={nt("previousWindow")} disabled={eventBounds.startAt <= overview.startAt} onClick={() => seek(at - windowMs)}>
                <ChevronLeft className="size-3.5" aria-hidden="true" />
              </Button>
              <Button type="button" variant="outline" size="icon-xs" aria-label={nt("nextWindow")} disabled={eventBounds.endAt >= overview.endAt} onClick={() => seek(at + windowMs)}>
                <ChevronRight className="size-3.5" aria-hidden="true" />
              </Button>
            </div>
          </div>

          <div ref={timeAxisRef} className="replay-time-axis" onClick={seekOnLaneClick}>
            {rulerTicks.map(({ ratio, time }) => (
              <time key={`label-${ratio}`} style={{ left: `${ratio * 100}%` }} className="replay-ruler-tick mono">
                {replayElapsedInput(time, "seconds")}
              </time>
            ))}
            <div className="replay-time-axis-track" aria-hidden="true">
              {rulerTicks.map(({ ratio }) => (
                <span key={`tick-${ratio}`} style={{ left: `${ratio * 100}%` }} className="replay-ruler-hairline" />
              ))}
              <ReplayCursor clock={clock} className="replay-playhead-cap" startAt={eventBounds.startAt} span={windowSpan} />
            </div>
          </div>

          <ReplayTrackStack clock={clock} items={items} activeKey={activeKey} startAt={eventBounds.startAt} endAt={eventBounds.endAt}
            sampledStartAt={bounds.startAt} sampledEndAt={bounds.endAt} ticks={coalescedTrackTicks}
            onSelectFrame={onSelectFrame} onSelectItem={onSelectItem} onSeek={onSeekTo} />

          {session.eventError && <Alert variant="destructive" className="mx-4 mt-2"><AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>{t("eventTrackPrefix")}{session.eventError}{t("videoContinues")}</span>
            <Button type="button" variant="outline" size="xs" onClick={session.retry}>{t("retry")}</Button>
          </AlertDescription></Alert>}
        </div>
      </section>

      {overlayBackdropMounted && (
        <div
          className="replay-inspector-backdrop"
          data-state={overlayBackdropState}
          aria-hidden="true"
          onClick={() => setDockOpen(false)}
        />
      )}

      <aside
        className="replay-inspector"
        data-dock-open={dockOpen ? "true" : undefined}
        data-dock-state={dockOpen ? "open" : "closed"}
        data-evidence-open={dockOpen && !!evidence && inspectorTab === "details"}
        aria-hidden={!dockOpen || undefined}
        inert={!dockOpen || undefined}
      >
        <Tabs value={inspectorTab} onValueChange={setInspectorTab} className="replay-inspector-tabs gap-0">
          <div className="replay-inspector-header">
            <TabsList
              variant="line"
              aria-label={nt("inspectorTabs")}
              className="replay-inspector-tablist h-[46px] min-h-[46px] flex-1 min-w-0 group-data-[orientation=horizontal]/tabs:h-[46px]"
            >
              <TabsTrigger ref={eventsTab} value="events">{nt("eventsTab")}</TabsTrigger>
              <TabsTrigger value="moment">
                {nt("momentTab")}
                {activeItems.length > 0 && <span className="replay-tab-count">{activeItems.length}</span>}
              </TabsTrigger>
              <TabsTrigger value="details">
                {nt("evidenceTab")}
                {evidence && <i className="replay-tab-dot" aria-hidden="true" />}
              </TabsTrigger>
            </TabsList>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="replay-inspector-close shrink-0"
              title={nt("closeInspector")}
              aria-label={nt("closeInspector")}
              onClick={() => {
                setDockOpen(false);
                requestAnimationFrame(() => dockToggleRef.current?.focus());
              }}
            >
              <X className="size-3.5" aria-hidden="true" />
            </Button>
          </div>

          <TabsContent value="events" forceMount className="replay-inspector-content data-[state=inactive]:hidden">
            <ReplayEventSearch
              key={scope}
              scope={scope}
              startAt={overview.startAt}
              at={Math.floor(at / 500) * 500}
              refreshRevision={session.refreshRevision}
              itemUrl={evidenceUrl}
              onSelect={selectItem}
              selectedId={evidence?.kind === "item" ? evidence.id : undefined}
              inputId={`${controlsId}-event-query`}
              inputRef={eventSearchInput}
            />
          </TabsContent>

          <TabsContent value="moment" className="replay-inspector-content">
            <div className="replay-moment-pane">
              <div className="replay-moment-clock">
                <span className="mono">{replayDuration(at - overview.startAt)}</span>
                <small className="mono">{wallTime(at)}</small>
              </div>

              <section className="replay-context-section">
                <div className="replay-context-heading">
                  <h3>{t("currentActions")}</h3>
                  <span>{activeItems.length} {t("items")}</span>
                </div>
                {activeItems.length ? (
                  <div className="replay-context-list">
                    {activeItems.map(item => (
                      <button type="button" key={item.id}
                        className="replay-context-item focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                        onClick={event => selectItem(item, event.currentTarget)}>
                        <span className={"replay-track-badge " + item.track}>{t(`track.${item.track}`)}</span>
                        <strong>{item.label}</strong>
                        <small>{item.status && statusKey[item.status] ? t(`status.${statusKey[item.status]}`) : (item.status ?? (item.endAt === null ? t("status.notEnded") : t("status.recorded")))}</small>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="replay-empty-context">{t("noActiveItems")}</p>
                )}
              </section>

              <section className="replay-context-section">
                <div className="replay-context-heading">
                  <h3>{t("nearbyLogs")}</h3>
                  <span>{t("clickToLocate")}</span>
                </div>
                {logs.length ? (
                  <div className="replay-context-list">
                    {logs.map(item => (
                      <button type="button" key={item.id}
                        className={"replay-context-item focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring" + (item.startAt <= at ? " past" : " future")}
                        onClick={event => selectItem(item, event.currentTarget)}>
                        <time className="mono">{wallTime(item.startAt)}</time>
                        <strong>{item.label}</strong>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="replay-empty-context">{t("noLogs")}</p>
                )}
              </section>
            </div>
          </TabsContent>

          <TabsContent value="details" className="replay-inspector-content">
            {evidence ? (
              evidenceView
            ) : (
              <div className="replay-empty-details">
                <h3>{t("emptyDetailsTitle")}</h3>
                <p>{t("emptyDetailsHint")}</p>
                {shownFrames[0] && (
                  <Button type="button" variant="outline" size="sm" onClick={event => selectFrame(shownFrames[0], event.currentTarget)}>
                    {t("inspectCurrentFrame")} ({shownFrames[0].capability} · #{shownFrames[0].sequence})
                  </Button>
                )}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </aside>
    </div>
  </div>;
}
