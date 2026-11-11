"use client";

import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import type { ReplayFrame, ReplayItem, ReplayOverview, ReplayOverviewResult, ReplayCoverage, ReplayWindow } from "@/lib/replay-types";
import { adjacentReplayFrame, clampReplayTime, coalesceReplayFrameTicks, mergeReplayPages, nearbyReplayItems, REPLAY_WINDOW_MS,
  replayDuration, replayFramesAt, replayItemActive, replayStageFramesAt, replayTracks, replayWindowBounds,
  retainReplayWindows } from "@/features/replay/replay-model";
import { useBufferedMedia } from "@/features/live/use-buffered-media";
import type { BufferedImage } from "@/features/replay/image-buffer";
import { ReplayVideo } from "@/features/replay/replay-video";
import { replayVideoReady } from "@/features/replay/replay-video-model";
import { readArchiveJson } from "@/lib/archive-client";
import "@/features/replay/timeline-player.css";
import { useTranslations } from "@/lib/locale";
import { ChevronLeft, ChevronRight, RefreshCw, RotateCcw, RotateCw, Search, Share2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ReplayTimeJump } from "@/features/replay/replay-time-jump";
import { ReplayEventSearch } from "@/features/replay/replay-event-search";
import { ReplayEvidencePanel, type ReplayEvidenceSelection } from "@/features/replay/replay-evidence-panel";
import { replayElapsedInput, replayEvidenceKey, replayEvidencePatch } from "@/features/replay/replay-navigation";

const subscribeWide = (listener: () => void) => {
  const query = window.matchMedia("(min-width: 860px)"); query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
};
const isWideScreen = () => window.matchMedia("(min-width: 860px)").matches;

const read = readArchiveJson;

const endpoint = (scope: string, params: Record<string, string | number>) =>
  "/api/replay?" + scope + "&" + new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]));

async function readWindow(scope: string, start: number, end: number, signal: AbortSignal,
  mode: "frames" | "events" = "frames", onPage?: (page: ReplayWindow) => void, initial?: ReplayWindow,
  stalledMessage = "Replay pagination stalled; please retry") {
  const pages: ReplayWindow[] = initial ? [initial] : [], cursors = new Set<string>();
  let cursor = initial?.nextCursor;
  for (let n = 0; n < 10; n++) {
    const page = await read<ReplayWindow>(endpoint(scope, { mode, start, end, ...(cursor ? { cursor } : {}) }), signal);
    pages.push(page);
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const merged = mergeReplayPages(pages);
    // History remains accessible through the cursor; the browser keeps a bounded working page.
    merged.frames = merged.frames.slice(-5000); merged.items = merged.items.slice(-5000);
    onPage?.(merged);
    cursor = page.nextCursor;
    if (!cursor) return merged;
    if (cursors.has(cursor)) throw new Error(stalledMessage);
    cursors.add(cursor);
    pages.splice(0, pages.length, merged);
  }
  return mergeReplayPages(pages);
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

type VideoPlayback = { at: number; playing: boolean; clockReady: boolean; speed: number; revision: number; onReady(slot: string, url: string, ready: boolean): void };
function ReplayMedia({ media, label, sampledAt, image, playback, slot }: { media: ReplayFrame["media"][number]; label: string; image?: BufferedImage;
  sampledAt: number; playback: VideoPlayback; slot: string }) {
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
  if (media.video) return <ReplayVideo source={media.video} sampledAt={sampledAt} {...playback} slot={slot} label={label} />;
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

const FrameMedia = memo(function FrameMedia({ frame, images, playback, onInspect }: {
  frame: ReplayFrame; images: Map<string, BufferedImage>; playback: VideoPlayback;
  onInspect?: (trigger: HTMLElement) => void;
}) {
  const t = useTranslations("timelinePlayer");
  return <><div className="replay-media-grid">
    {frame.media.map(media => <div className={"replay-media" + (media.mediaType.startsWith("image/") ? " replay-image" : "")} key={media.index}>
      <ReplayMedia media={media} sampledAt={frame.at} image={images.get(media.url)} playback={playback} slot={frame.capability + ":" + media.index}
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

export function TimelinePlayer({ project, run, epoch, position, evidence = null, onPosition, onEvidence, onOverview, archiveRevision }: {
  project: string; run: string; epoch?: string; position?: string | null; evidence?: ReplayEvidenceSelection | null;
  onPosition(at: number, selection?: ReplayEvidenceSelection | null, options?: { replace?: boolean }): void;
  onEvidence(selection: ReplayEvidenceSelection | null): void;
  onOverview?(value: ReplayOverviewResult): void;
  archiveRevision?: number;
}) {
  const t = useTranslations("timelinePlayer");
  const nt = useTranslations("replayNavigation");
  const controlsId = useId();
  const wide = useSyncExternalStore(subscribeWide, isWideScreen, () => false);
  const evidenceKey = replayEvidenceKey(evidence);
  const [inspectorTab, setInspectorTab] = useState("events");
  const evidencePanel = useRef<HTMLElement>(null);
  const evidenceOpener = useRef<HTMLElement | null>(null);
  const eventsTab = useRef<HTMLButtonElement>(null);
  const eventSearchInput = useRef<HTMLInputElement>(null);
  const player = useRef<HTMLDivElement>(null);
  const evidencePresentation = useRef({ wide, evidenceKey, inspectorTab });
  evidencePresentation.current = { wide, evidenceKey, inspectorTab };
  const lastEvidence = useRef("");
  const restoreEvidenceFocus = () => {
    const opener = evidenceOpener.current;
    if (opener?.isConnected && opener.getClientRects().length) opener.focus();
    else if (eventsTab.current?.getClientRects().length) eventsTab.current.focus();
    else player.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (evidenceKey) {
      const newEvidence = evidenceKey !== lastEvidence.current;
      if (newEvidence) setInspectorTab("details");
      // A retained evidence URL does not override an explicit return to Events on resize.
      if (wide && (newEvidence || evidencePresentation.current.inspectorTab === "details")) requestAnimationFrame(() => {
        const current = evidencePresentation.current;
        if (!current.wide || current.evidenceKey !== evidenceKey || current.inspectorTab !== "details") return;
        evidencePanel.current?.focus({ preventScroll: true }); evidencePanel.current?.scrollIntoView({ block: "nearest" });
      });
    } else {
      if (lastEvidence.current) setInspectorTab("events");
      if (lastEvidence.current && wide && document.activeElement === document.body) requestAnimationFrame(restoreEvidenceFocus);
    }
    lastEvidence.current = evidenceKey;
  }, [evidenceKey, wide]);
  const requestedScope = new URLSearchParams({ project, run, ...(epoch ? { epoch } : {}) }).toString();
  const [overview, setOverview] = useState<ReplayOverview | null>(null);
  const resolvedEpoch = overview ? overview.epoch : epoch;
  const scope = new URLSearchParams({ project, run, ...(resolvedEpoch ? { epoch: resolvedEpoch } : {}) }).toString();
  const [coverage, setCoverage] = useState<ReplayCoverage | null>(null);
  const [eventWindow, setEventWindow] = useState<ReplayWindow | null>(null);
  const [eventError, setEventError] = useState("");
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventPage, setEventPage] = useState(0);
  const [overviewError, setOverviewError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [overviewPoll, setOverviewPoll] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [at, setAt] = useState<number>(0);
  const atRef = useRef(at);
  const [clockRevision, setClockRevision] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [capability, setCapability] = useState("");
  const [windowMs, setWindowMs] = useState(REPLAY_WINDOW_MS);
  const [windows, setWindows] = useState<ReplayWindow[]>([]);
  const cached = useRef(windows);
  const [windowError, setWindowError] = useState("");
  const [retry, setRetry] = useState(0);
  const [shareState, setShareState] = useState("");
  const stepRequest = useRef<AbortController | null>(null);
  const [stepping, setStepping] = useState(false);
  const [videoReadiness, setVideoReadiness] = useState<Record<string, { url: string; ready: boolean }>>({});
  const onVideoReady = useCallback((slot: string, url: string, ready: boolean) => {
    setVideoReadiness(previous => previous[slot]?.url === url && previous[slot].ready === ready
      ? previous : { ...previous, [slot]: { url, ready } });
  }, []);
  const initialPosition = useRef(position);
  const userMovedRef = useRef(Boolean(position != null || evidence));
  const [knownCapabilities, setKnownCapabilities] = useState<string[]>([]);
  const [initialPreviewFrame, setInitialPreviewFrame] = useState<ReplayFrame | null>(null);
  const initialProbeDoneRef = useRef(false);
  const hasOverview = useRef(false);
  const previousEpoch = useRef<string | null>(null);
  const positionApplied = useRef<string | null | undefined>(undefined);
  const move = useCallback((next: number) => { atRef.current = next; setAt(next); setClockRevision(value => value + 1); }, []);
  const commitPosition = useCallback((next: number, selection: ReplayEvidenceSelection | null = null, options?: { replace?: boolean }) => {
    positionApplied.current = String(Math.round(next));
    onPosition(Math.round(next), selection, options);
  }, [onPosition]);

  useEffect(() => {
    userMovedRef.current = Boolean(position != null || evidence);
    setKnownCapabilities([]);
    setInitialPreviewFrame(null);
    initialProbeDoneRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedScope]);

  useEffect(() => {
    if (!project || !run) return;
    const controller = new AbortController();
    setRefreshing(true); setOverviewError("");
    void read<ReplayOverviewResult>(endpoint(requestedScope, { mode: "overview" }), controller.signal).then(next => {
      if (controller.signal.aborted) return;
      onOverview?.(next);
      setCoverage(next.coverage ?? null);
      if (next.startAt === null) return;
      if (hasOverview.current && previousEpoch.current !== next.epoch) {
        cached.current = []; setWindows([]); setEventWindow(null); setPlaying(false);
        move(next.startAt);
      }
      previousEpoch.current = next.epoch;
      if (!hasOverview.current) {
        hasOverview.current = true;
        move(clampReplayTime(Number(initialPosition.current ?? next.startAt), next));
      }
      setOverview(next);
    }).catch(error => { if (!controller.signal.aborted) setOverviewError(error.message); })
      .finally(() => { if (!controller.signal.aborted) setRefreshing(false); });
    return () => controller.abort();
  }, [requestedScope, project, run, refresh, overviewPoll, move, onOverview, archiveRevision]);

  useEffect(() => {
    if (!coverage || coverage.complete || overviewError) return;
    const timer = setTimeout(() => setOverviewPoll(value => value + 1), 750);
    return () => clearTimeout(timer);
  }, [coverage, overviewError]);

  useEffect(() => {
    if (!overview || position === positionApplied.current) return;
    positionApplied.current = position;
    if (position != null) { setPlaying(false); move(clampReplayTime(Number(position), overview)); }
  }, [position, overview, move]);
  useEffect(() => () => stepRequest.current?.abort(), []);

  // Video sampling stays bounded even when event inspection spans fifteen minutes.
  const bounds = overview ? replayWindowBounds(at, overview) : { startAt: 0, endAt: 0 };
  const eventBounds = overview ? replayWindowBounds(at, overview, windowMs) : { startAt: 0, endAt: 0 };
  const activeWindow = windows.find(window => window.startAt === bounds.startAt && window.endAt === bounds.endAt);
  const frameLoads = useRef(new Map<string, AbortController>());
  const [framePass, setFramePass] = useState(0);
  const currentStart = useRef(bounds.startAt);
  currentStart.current = bounds.startAt;
  const storeWindow = useCallback((next: ReplayWindow) => {
    cached.current = retainReplayWindows([...cached.current.filter(value => value.startAt !== next.startAt), next], currentStart.current);
    setWindows(cached.current);
  }, []);
  useEffect(() => {
    if (!overview || overview.endAt < overview.startAt) return;
    const controller = new AbortController();
    setWindowError("");
    const load = async (start: number, end: number, required: boolean) => {
      if (cached.current.some(window => window.startAt === start && window.endAt === end)) return;
      const key = `${start}:${end}`;
      frameLoads.current.set(key, controller);
      try {
        const result = await readWindow(scope, start, end, controller.signal, "frames", page => {
          if (!controller.signal.aborted) storeWindow(page);
        });
        if (!controller.signal.aborted) storeWindow(result);
      } catch (error) {
        if (!controller.signal.aborted && required) setWindowError(String(error));
      } finally {
        if (frameLoads.current.get(key) === controller) frameLoads.current.delete(key);
        setFramePass(value => value + 1);
      }
    };
    void load(bounds.startAt, bounds.endAt, true);
    if (bounds.endAt < overview.endAt) void load(bounds.endAt, Math.min(bounds.endAt + REPLAY_WINDOW_MS, overview.endAt), false);
    return () => controller.abort();
  }, [scope, bounds.startAt, bounds.endAt, overview?.startAt, overview?.endAt, retry, storeWindow]);

  useEffect(() => {
    if (!overview) return;
    const controller = new AbortController();
    setEventError(""); setEventsLoading(true);
    const prior = eventWindow?.startAt === eventBounds.startAt && eventWindow.endAt === eventBounds.endAt && eventPage ? eventWindow : undefined;
    if (!prior) setEventWindow(null);
    void readWindow(scope, eventBounds.startAt, eventBounds.endAt, controller.signal, "events", page => {
      if (!controller.signal.aborted) setEventWindow(page);
    }, prior).catch(error => { if (!controller.signal.aborted) setEventError(String(error)); })
      .finally(() => { if (!controller.signal.aborted) setEventsLoading(false); });
    return () => controller.abort();
    // Events have their own cursor and never gate frame readiness.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, eventBounds.startAt, eventBounds.endAt, eventPage, retry, overview?.coverage?.complete, archiveRevision]);

  const moreFrameRequest = useRef<AbortController | null>(null);
  const frameTail = activeWindow?.frames.at(-1)?.at;
  const needsFrames = !!activeWindow?.nextCursor && frameTail !== undefined && at >= frameTail - 1000;
  useEffect(() => {
    if (!needsFrames || !activeWindow || frameLoads.current.has(`${activeWindow.startAt}:${activeWindow.endAt}`)) return;
    const controller = new AbortController(); moreFrameRequest.current = controller;
    void readWindow(scope, activeWindow.startAt, activeWindow.endAt, controller.signal, "frames", undefined, activeWindow)
      .then(page => { if (!controller.signal.aborted) storeWindow(page); })
      .catch(error => { if (!controller.signal.aborted) setWindowError(String(error)); });
    return () => { controller.abort(); moreFrameRequest.current = null; };
    // A new buffered tail schedules the next page only when the playhead approaches it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, needsFrames, bounds.startAt, activeWindow?.nextCursor, storeWindow, framePass]);

  const frames = useMemo(() => mergeReplayPages(windows).frames, [windows]);
  useEffect(() => {
    const discovered = [...(overview?.capabilities ?? []), ...frames.map(frame => frame.capability)];
    if (!discovered.length) return;
    setKnownCapabilities(previous => {
      const merged = [...new Set([...previous, ...discovered])];
      return merged.length === previous.length ? previous : merged;
    });
  }, [overview?.capabilities, frames]);

  useEffect(() => {
    if (
      !overview ||
      !activeWindow ||
      activeWindow.startAt !== overview.startAt ||
      activeWindow.frames.length > 0 ||
      Boolean(activeWindow.nextCursor) ||
      userMovedRef.current ||
      initialPreviewFrame ||
      initialProbeDoneRef.current
    ) {
      return;
    }
    const controller = new AbortController();
    void (async () => {
      let edge = activeWindow.endAt;
      for (let i = 0; i < 12 && edge < overview.endAt; i += 1) {
        const targetBounds = replayWindowBounds(edge, overview);
        const result = await readWindow(scope, targetBounds.startAt, targetBounds.endAt, controller.signal, "frames");
        if (controller.signal.aborted) return;
        if (result.frames.length > 0) {
          const caps = [...new Set(result.frames.map(frame => frame.capability))];
          setKnownCapabilities(previous => {
            const merged = [...new Set([...previous, ...caps])];
            return merged.length === previous.length ? previous : merged;
          });
          const preview = result.frames.find(frame => frame.media.length > 0 || Boolean(frame.text)) ?? result.frames[0];
          initialProbeDoneRef.current = true;
          setInitialPreviewFrame(preview);
          return;
        }
        edge = targetBounds.endAt;
      }
      if (!controller.signal.aborted) initialProbeDoneRef.current = true;
    })().catch(() => {
      if (!controller.signal.aborted) initialProbeDoneRef.current = true;
    });
    return () => controller.abort();
  }, [overview, activeWindow, scope, initialPreviewFrame]);

  const pastFrames = useMemo(() => replayFramesAt(activeWindow?.frames ?? [], at, capability), [activeWindow, at, capability]);
  const rawVisibleFrames = useMemo(() => replayStageFramesAt(activeWindow?.frames ?? [], at, capability), [activeWindow, at, capability]);
  const visibleFrames = useMemo(
    () =>
      rawVisibleFrames.length > 0
        ? rawVisibleFrames
        : !userMovedRef.current && overview && at <= overview.startAt && initialPreviewFrame && initialPreviewFrame.at > at && (!capability || initialPreviewFrame.capability === capability)
          ? [initialPreviewFrame]
          : [],
    [rawVisibleFrames, overview, initialPreviewFrame, at, capability],
  );
  const pastCapabilities = useMemo(() => new Set(pastFrames.map(frame => frame.capability)), [pastFrames]);
  // Records are immutable. Keep frame identity stable while the playhead moves within one sample.
  const frameKey = JSON.stringify(visibleFrames.map(frame => [frame.id, frame.media]));
  const target = useMemo(() => activeWindow ? { key: frameKey, value: visibleFrames,
    urls: visibleFrames.flatMap(frame => frame.media.filter(media => media.mediaType.startsWith("image/") && !media.video).map(media => media.url)) } : null,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [frameKey, !!activeWindow]);
  const future = frames.filter(frame => frame.at > at && (!capability || frame.capability === capability)).slice(0, 2)
    .flatMap(frame => frame.media.filter(media => media.mediaType.startsWith("image/") && !media.video).map(media => media.url));
  const { displayed, pending } = useBufferedMedia(scope + ":" + capability + ":" + refresh + ":" + retry, target, future, !activeWindow || stepping);
  // Video frames share a decoder for the entire segment; advancing record metadata must not pause playback.
  const imageReady = !!activeWindow && (!activeWindow.nextCursor || frameTail === undefined || at <= frameTail) && (!target?.urls.length || !pending) && !stepping;
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
  const videoSlots = visibleFrames.flatMap(frame => frame.media.filter(media => media.video)
    .map(media => ({ slot: frame.capability + ":" + media.index, video: media.video! })));
  const slotsKey = JSON.stringify(videoSlots.map(({ slot }) => slot));
  useEffect(() => {
    const keep = new Set<string>(JSON.parse(slotsKey));
    setVideoReadiness(previous => {
      if (Object.keys(previous).every(slot => keep.has(slot))) return previous;
      return Object.fromEntries(Object.entries(previous).filter(([slot]) => keep.has(slot)));
    });
  }, [slotsKey]);
  const ready = imageReady && videoSlots.every(({ slot, video }) => replayVideoReady(video, videoReadiness[slot]));
  const pendingSegments = !!activeWindow?.frames.some(frame => frame.media.some(media => media.video?.status === "pending"));
  useEffect(() => {
    if (!pendingSegments || !activeWindow) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void readWindow(scope, activeWindow.startAt, activeWindow.endAt, controller.signal)
        .then(window => { if (!controller.signal.aborted) storeWindow(window); })
        .catch(error => { if (!controller.signal.aborted) setWindowError(String(error)); });
    }, 2000);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [pendingSegments, activeWindow, scope, storeWindow]);
  useEffect(() => {
    if (!playing || !ready || !overview) return;
    let animation = 0, previous = performance.now(), lastPaint = previous;
    const tick = (now: number) => {
      const next = Math.min(overview.endAt, atRef.current + (now - previous) * speed);
      previous = now;
      atRef.current = next;
      if (now - lastPaint >= 60 || next >= overview.endAt) { setAt(next); lastPaint = now; }
      if (next >= overview.endAt) {
        setPlaying(false);
        commitPosition(next, evidence, { replace: true });
        return;
      }
      animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animation);
  }, [playing, speed, ready, overview, commitPosition, evidence]);

  const items = eventWindow?.startAt === eventBounds.startAt && eventWindow.endAt === eventBounds.endAt ? eventWindow.items : [];
  const activeItems = items.filter(item => item.track !== "log" && replayItemActive(item, at));
  const logs = nearbyReplayItems(items.filter(item => item.track === "log"), at, 8);
  const capabilities = [...new Set([
    ...knownCapabilities,
    ...(overview?.capabilities ?? []),
    ...frames.map(frame => frame.capability),
    ...(capability ? [capability] : []),
  ])];
  const seek = (next: number, commit = true, selection: ReplayEvidenceSelection | null = null) => {
    if (!overview) return;
    userMovedRef.current = true;
    stepRequest.current?.abort(); moreFrameRequest.current?.abort(); setStepping(false); setPlaying(false);
    const value = clampReplayTime(next, overview);
    if (activeWindow?.nextCursor && value < (activeWindow.frames[0]?.at ?? value)) {
      cached.current = []; setWindows([]); setRetry(current => current + 1);
    }
    setShareState(""); move(value);
    if (commit) commitPosition(value, selection);
  };
  const step = async (direction: -1 | 1) => {
    if (!overview) return;
    userMovedRef.current = true;
    setPlaying(false); stepRequest.current?.abort();
    const nearby = adjacentReplayFrame(activeWindow?.frames ?? [], at, direction, capability);
    if (nearby) { seek(nearby.at); return; }
    const controller = new AbortController(); stepRequest.current = controller; setStepping(true);
    try {
      if (direction === 1 && activeWindow?.nextCursor) {
        const rest = await readWindow(scope, activeWindow.startAt, activeWindow.endAt, controller.signal, "frames", undefined, activeWindow);
        if (controller.signal.aborted) return;
        storeWindow(rest);
        const withinActive = adjacentReplayFrame(rest.frames, at, direction, capability);
        if (withinActive) { move(withinActive.at); commitPosition(withinActive.at); return; }
      }
      let edge = direction === 1 ? bounds.endAt : bounds.startAt;
      while (direction === 1 ? edge < overview.endAt : edge > overview.startAt) {
        const targetBounds = replayWindowBounds(direction === 1 ? edge : edge - 1, overview);
        const result = await readWindow(scope, targetBounds.startAt, targetBounds.endAt, controller.signal);
        if (controller.signal.aborted) return;
        const next = adjacentReplayFrame(result.frames, at, direction, capability);
        if (next) { move(next.at); storeWindow(result); commitPosition(next.at); return; }
        edge = direction === 1 ? targetBounds.endAt : targetBounds.startAt;
      }
    } catch (error) { if (!controller.signal.aborted) setWindowError(String(error)); }
    finally { if (!controller.signal.aborted) setStepping(false); }
  };
  const selectFrame = (frame: ReplayFrame, trigger: HTMLElement) => {
    evidenceOpener.current = trigger; setInspectorTab("details");
    seek(frame.at, true, { kind: "frame", record: frame.id, sequence: frame.sequence });
    if (wide) requestAnimationFrame(() => evidencePanel.current?.focus({ preventScroll: true }));
  };
  const selectItem = (item: ReplayItem, trigger: HTMLElement) => {
    evidenceOpener.current = trigger; setInspectorTab("details");
    seek(item.startAt, true, { kind: "item", id: item.id });
    if (wide) requestAnimationFrame(() => evidencePanel.current?.focus({ preventScroll: true }));
  };
  const closeEvidence = () => {
    setInspectorTab("events"); onEvidence(null);
    if (wide) requestAnimationFrame(restoreEvidenceFocus);
  };
  const evidenceUrl = (item: ReplayItem) => {
    const url = new URL(window.location.href);
    url.searchParams.set("view", "replay"); url.searchParams.set("project", project); url.searchParams.set("run", run);
    url.searchParams.set("epoch", overview?.epoch ?? "all"); url.searchParams.set("at", String(item.startAt));
    for (const [key, value] of Object.entries(replayEvidencePatch({ kind: "item", id: item.id }))) {
      if (value === null) url.searchParams.delete(key); else url.searchParams.set(key, value);
    }
    return url.pathname + url.search;
  };
  const evidenceView = evidence && <ReplayEvidencePanel key={scope + evidenceKey} scope={scope} selection={evidence} refreshRevision={refresh} focusRef={evidencePanel} onClose={closeEvidence}
    onLoaded={detail => {
      if (position == null && overview && detail.summary) seek(detail.summary.startAt, true, evidence);
    }} />;
  const share = async () => {
    commitPosition(at, evidence);
    const url = new URL(window.location.href);
    url.searchParams.set("view", "replay"); url.searchParams.set("at", String(Math.round(at)));
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

  if (!project || !run) return <section className="surface empty-state"><h2>{t("emptyTitle")}</h2><p>{t("emptyDescription")}</p></section>;
  if (!overview) return <section className="surface empty-state"><h1>{overviewError ? t("unavailable") : t("preparing")}</h1>
    {overviewError ? <Alert variant="destructive"><AlertDescription>{overviewError}</AlertDescription></Alert>
      : <p role="status">{coverage ? <>{t("readingSourceDir")} {Math.round(coverage.bytes / Math.max(1, coverage.totalBytes) * 100)}% · {t("loadIndependent")}</> : t("readingFromRecords")}</p>}
    {overviewError && <Button type="button" variant="outline" size="sm" onClick={() => setRefresh(value => value + 1)}>{t("retryLoad")}</Button>}</section>;

  const duration = overview.endAt - overview.startAt;
  const windowSpan = Math.max(1, eventBounds.endAt - eventBounds.startAt);
  const x = (time: number) => Math.max(0, Math.min(100, (time - eventBounds.startAt) / windowSpan * 100));
  const sampledLeftPct = x(bounds.startAt);
  const sampledRightPct = x(bounds.endAt);
  const hasUnsampledPerceptionEdges = windowSpan > bounds.endAt - bounds.startAt + 500;

  const seekOnLaneClick = (event: MouseEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    seek(eventBounds.startAt + ratio * windowSpan);
  };

  const rulerTicks = [0, 0.25, 0.5, 0.75, 1].map(ratio => ({
    ratio,
    time: eventBounds.startAt + ratio * windowSpan - overview.startAt,
  }));

  return <div ref={player} tabIndex={-1} className="replay-player outline-none">
    {overviewError && <Alert variant="destructive"><AlertDescription>{overviewError}{t("keepLoaded")}</AlertDescription></Alert>}

    <div className="replay-workbench">
      <section className="surface replay-studio-main" aria-label={t("stageTitle")}>
        <header className="replay-studio-topbar">
          <div className="replay-studio-topbar-left">
            <span className="replay-readonly-pill"><i /> {t("readonlyNotice")}</span>
            {(capabilities.length > 1 || Boolean(capability)) && (
              <div className="replay-capability">
                <Label htmlFor={`${controlsId}-capability`} className="sr-only">{t("capabilityLabel")}</Label>
                <NativeSelect id={`${controlsId}-capability`} size="sm" className="max-w-[180px] pr-7 text-xs" value={capability} onChange={event => {
                  stepRequest.current?.abort(); setStepping(false); setCapability(event.target.value);
                }}>
                  <NativeSelectOption value="">{t("allCapabilities")}</NativeSelectOption>
                  {capabilities.map(value => <NativeSelectOption key={value} value={value}>{shortCapabilityName(value)}</NativeSelectOption>)}
                </NativeSelect>
              </div>
            )}
            {coverage && !coverage.complete && (
              <span className="replay-coverage-pill" role="status">
                {t("coverageReadPrefix")} {Math.round(coverage.bytes / Math.max(1, coverage.totalBytes) * 100)}%
              </span>
            )}
          </div>
          <div className="replay-studio-topbar-right">
            {shareState && <span className="replay-share-feedback" role="status">{shareState}</span>}
            <Button type="button" variant="ghost" size="xs" onClick={() => {
              setInspectorTab("events");
              requestAnimationFrame(() => eventSearchInput.current?.focus());
            }}>
              <Search className="size-3.5" aria-hidden="true" />
              {nt("findEvent")}
            </Button>
            <Button type="button" variant="ghost" size="xs" disabled={refreshing} onClick={() => { cached.current = []; setWindows([]); setRefresh(value => value + 1); setRetry(value => value + 1); }}>
              <RefreshCw className={"size-3.5" + (refreshing ? " animate-spin" : "")} aria-hidden="true" />
              {refreshing ? t("refreshing") : t("refreshRecords")}
            </Button>
            <Button type="button" variant="outline" size="xs" onClick={share}>
              <Share2 className="size-3.5" aria-hidden="true" />
              {t("shareMoment")}
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
                        <Button type="button" variant="ghost" size="xs" title={frame.capability} onClick={event => selectFrame(frame, event.currentTarget)}>
                          {shortCapabilityName(frame.capability)} · #{frame.sequence} ↗
                        </Button>
                        {isPreview ? (
                          <div className="replay-preview-actions">
                            <span className="replay-preview-badge">
                              {t("initialPreview")} · {wallTime(frame.at)}
                            </span>
                            {frame.at - at > 3000 && (
                              <Button type="button" variant="outline" size="xs" onClick={() => seek(frame.at)}>
                                {t("jumpToSample").replace("{time}", replayDuration(frame.at - overview.startAt))}
                              </Button>
                            )}
                          </div>
                        ) : (
                          <span>
                            {t("sampled")} {wallTime(frame.at)}
                            {ready ? " · " + formatSampleAge(at - frame.at, t("secondsAgo")) : t("previousFrame")}
                          </span>
                        )}
                      </div>
                      <FrameMedia
                        key={refresh + ":" + retry}
                        frame={frame}
                        images={displayed?.images ?? new Map()}
                        playback={{ at, playing: playing && !isPreview, clockReady: ready, speed, revision: clockRevision, onReady: onVideoReady }}
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
                          <Button type="button" variant="ghost" size="xs" title={frame.capability} onClick={event => selectFrame(frame, event.currentTarget)}>
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
          <span>{windowError}</span><Button type="button" variant="outline" size="xs" onClick={() => setRetry(value => value + 1)}>{t("retrySegment")}</Button>
        </AlertDescription></Alert>}

        <div className="replay-controls">
          {/* The media scrubber keeps native pointer/key commit semantics and millisecond steps. */}
          <input className="replay-seek accent-primary focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
            type="range" min={overview.startAt} max={Math.max(overview.endAt, overview.startAt + 1)} step="1" value={at}
            disabled={duration <= 0} aria-label={t("seekLabel")} aria-valuetext={replayDuration(at - overview.startAt) + " / " + replayDuration(duration)}
            onChange={event => seek(Number(event.target.value), false)} onPointerUp={() => commitPosition(atRef.current)}
            onKeyUp={() => commitPosition(atRef.current)} />

          <div className="replay-control-row">
            <div className="replay-transport">
              <Button type="button" size="xs" className="min-w-[54px] px-2 font-medium" aria-label={playing ? t("pauseReplay") : t("playReplay")} disabled={duration <= 0 || !!windowError}
                onClick={() => {
                  userMovedRef.current = true;
                  stepRequest.current?.abort(); setStepping(false);
                  if (playing) {
                    setPlaying(false);
                    commitPosition(atRef.current, evidence, { replace: true });
                    return;
                  }
                  if (at >= overview.endAt) {
                    if (activeWindow?.nextCursor) { cached.current = []; setWindows([]); setRetry(current => current + 1); }
                    move(overview.startAt);
                    commitPosition(overview.startAt, evidence, { replace: true });
                  }
                  setPlaying(true);
                }}>
                {playing ? t("pause") : t("play")}
              </Button>
              <Button type="button" variant="outline" size="xs" className="px-2" aria-label={nt("backTen")} disabled={at <= overview.startAt} onClick={() => seek(at - 10_000)}>
                <RotateCcw className="size-3" aria-hidden="true" />10s
              </Button>
              <Button type="button" variant="outline" size="xs" className="px-2" aria-label={t("prevFrame")} disabled={stepping || at <= overview.startAt} onClick={() => void step(-1)}>
                {t("prevFrameShort")}
              </Button>
              <Button type="button" variant="outline" size="xs" className="px-2" aria-label={t("nextFrame")} disabled={stepping || at >= overview.endAt} onClick={() => void step(1)}>
                {t("nextFrameShort")}
              </Button>
              <Button type="button" variant="outline" size="xs" className="px-2" aria-label={nt("forwardTen")} disabled={at >= overview.endAt} onClick={() => seek(at + 10_000)}>
                <RotateCw className="size-3" aria-hidden="true" />10s
              </Button>
              <ReplayTimeJump elapsed={at - overview.startAt} duration={duration} onJump={elapsed => seek(overview.startAt + elapsed)} />
            </div>

            <div className="replay-clock">
              <span className="replay-wallclock-pill mono">{wallTime(at)}</span>
              <NativeSelect size="sm" className="h-6 min-w-[66px] rounded-[5px] py-0 pl-2 pr-6 text-xs data-[size=sm]:h-6 data-[size=sm]:py-0" aria-label={t("speedLabel")} value={speed} onChange={event => setSpeed(Number(event.target.value))}>
                {[0.25, 0.5, 1, 2, 4, 8].map(value => <NativeSelectOption key={value} value={value}>{value}×</NativeSelectOption>)}
              </NativeSelect>
            </div>
          </div>
        </div>

        <div className="replay-timeline" role="region" aria-label={t("timelineLabel")}>
          <div className="replay-timeline-header">
            <div className="replay-timeline-title-group">
              <h2>{t("timelineTitle")}</h2>
              <span className="replay-window-range-pill mono">
                {replayElapsedInput(eventBounds.startAt - overview.startAt, "seconds")} – {replayElapsedInput(eventBounds.endAt - overview.startAt, "seconds")}
              </span>
              {eventsLoading && <span className="replay-timeline-status" role="status">{t("supplementingEvents")}</span>}
              {eventWindow?.nextCursor && !eventsLoading && (
                <Button type="button" variant="ghost" size="xs" onClick={() => setEventPage(value => value + 1)}>{t("continueEvents")}</Button>
              )}
            </div>
            <div className="replay-window-size">
              <Label htmlFor={`${controlsId}-window`} className="text-xs font-normal">{t("windowLabel")}</Label>
              <NativeSelect id={`${controlsId}-window`} size="sm" className="h-6 min-w-[78px] rounded-[5px] py-0 pl-2.5 pr-7 text-xs data-[size=sm]:h-6 data-[size=sm]:py-0" aria-label={t("windowSelectLabel")} value={windowMs} onChange={event => {
                setEventPage(0); setWindowMs(Number(event.target.value));
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

          <div className="replay-time-axis" onClick={seekOnLaneClick}>
            {rulerTicks.map(({ ratio, time }) => (
              <time key={ratio} style={{ left: `${ratio * 100}%` }} className="replay-ruler-tick mono">
                {replayElapsedInput(time, "seconds")}
              </time>
            ))}
            <i className="replay-playhead-cap" style={{ left: x(at) + "%" }} aria-hidden="true" />
          </div>

          <div className="replay-tracks-stack">
            <div className="replay-track-row">
              <span className="replay-track-label"><i className="replay-track-dot perception" />{t("track.perception")}</span>
              <div className="replay-track-lane" onClick={seekOnLaneClick}>
                {hasUnsampledPerceptionEdges && sampledLeftPct > 0.25 && (
                  <span
                    className="replay-unsampled-region"
                    aria-hidden="true"
                    title={nt("frameWindowNote")}
                    style={{ left: "0%", width: `${sampledLeftPct}%` }}
                  />
                )}
                {hasUnsampledPerceptionEdges && sampledRightPct < 99.75 && (
                  <span
                    className="replay-unsampled-region"
                    aria-hidden="true"
                    title={nt("frameWindowNote")}
                    style={{ left: `${sampledRightPct}%`, width: `${100 - sampledRightPct}%` }}
                  />
                )}
                <span
                  className="replay-sampled-window"
                  aria-hidden="true"
                  title={t("sampledWindowHint")}
                  style={{ left: sampledLeftPct + "%", width: Math.max(0.5, sampledRightPct - sampledLeftPct) + "%" }}
                />
                {coalescedTrackTicks.map(tick => (
                  <button type="button" key={tick.frame.id}
                    className={"replay-frame-tick focus-visible:z-10 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring" + (tick.count > 1 ? " coalesced" : "")}
                    style={{ left: x(tick.startAt) + "%", width: tick.count > 1 ? Math.max(0.35, x(tick.endAt) - x(tick.startAt)) + "%" : undefined }}
                    aria-label={t("viewPerception") + " " + wallTime(tick.frame.at)}
                    title={tick.frame.capability + " · " + wallTime(tick.frame.at) + (tick.count > 1 ? ` (${tick.count})` : "")}
                    onClick={event => { event.stopPropagation(); selectFrame(tick.frame, event.currentTarget); }} />
                ))}
                <i className="replay-cursor" style={{ left: x(at) + "%" }} />
              </div>
            </div>

            {replayTracks.map(track => (
              <div key={track} className="replay-track-row">
                <span className="replay-track-label"><i className={"replay-track-dot " + track} />{t(`track.${track}`)}</span>
                <div className="replay-track-lane" onClick={seekOnLaneClick}>
                  {items.filter(item => item.track === track).map(item => {
                    const leftPct = x(item.startAt);
                    const rawWidthPct = x(item.track === "log" ? item.startAt : item.endAt ?? eventBounds.endAt) - leftPct;
                    const widthPct = Math.max(0.45, rawWidthPct);
                    return (
                      <button type="button" key={item.id}
                        className={"replay-span focus-visible:z-10 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring " + track + (replayItemActive(item, at) ? " active" : "") + (/error|failed/.test(item.status ?? "") ? " failed" : "")}
                        style={{ left: leftPct + "%", width: widthPct + "%" }}
                        title={item.label + " · " + wallTime(item.startAt)}
                        aria-label={t(`track.${track}`) + " · " + item.label}
                        onClick={event => { event.stopPropagation(); selectItem(item, event.currentTarget); }}>
                        {track === "log" || widthPct < 4.5 ? "" : item.label}
                      </button>
                    );
                  })}
                  <i className="replay-cursor" style={{ left: x(at) + "%" }} />
                </div>
              </div>
            ))}
          </div>

          {eventError && <Alert variant="destructive" className="mx-4 mt-2"><AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>{t("eventTrackPrefix")}{eventError}{t("videoContinues")}</span>
            <Button type="button" variant="outline" size="xs" onClick={() => setEventPage(value => value + 1)}>{t("retry")}</Button>
          </AlertDescription></Alert>}
        </div>
      </section>

      <aside className="replay-inspector" data-evidence-open={wide && !!evidence && inspectorTab === "details"}>
        <Tabs value={inspectorTab} onValueChange={setInspectorTab} className="replay-inspector-tabs">
          <TabsList variant="line" aria-label={nt("inspectorTabs")} className="replay-inspector-tablist w-full">
            <TabsTrigger ref={eventsTab} value="events">{nt("eventsTab")}</TabsTrigger>
            <TabsTrigger value="moment">
              {nt("momentTab")}
              {activeItems.length > 0 && <span className="replay-tab-count">{activeItems.length}</span>}
            </TabsTrigger>
            <TabsTrigger value="details" onClick={() => { if (evidence && !wide) setInspectorTab("details"); }}>
              {nt("evidenceTab")}
              {evidence && <i className="replay-tab-dot" aria-hidden="true" />}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="events" forceMount className="replay-inspector-content data-[state=inactive]:hidden">
            <ReplayEventSearch
              key={scope}
              scope={scope}
              startAt={overview.startAt}
              at={at}
              refreshRevision={refresh}
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
              wide ? evidenceView : <Button type="button" variant="outline" onClick={() => setInspectorTab("details")}>{nt("evidenceTab")}</Button>
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

    <Dialog open={!wide && !!evidence && inspectorTab === "details"} onOpenChange={open => { if (!open) closeEvidence(); }}>
      <DialogContent showCloseButton={false} className="replay-evidence-dialog p-0" onOpenAutoFocus={event => { event.preventDefault(); evidencePanel.current?.focus(); }}
        onCloseAutoFocus={event => {
          event.preventDefault();
          const outgoing = event.target instanceof HTMLElement ? event.target : null;
          requestAnimationFrame(() => {
            const focused = document.activeElement;
            // A newer navigation or a user's focus move takes precedence over late teardown.
            if (focused instanceof HTMLElement && focused !== document.body && focused.isConnected
              && focused.getClientRects().length && !outgoing?.contains(focused)) return;
            const current = evidencePresentation.current;
            // Leaving the Dialog for the inline inspector is relocation, not dismissal.
            // Focusing its old Events opener here would reactivate that tab and hide evidence.
            if (current.evidenceKey && (current.wide || current.inspectorTab === "details")) {
              evidencePanel.current?.focus({ preventScroll: true });
            } else restoreEvidenceFocus();
          });
        }}>
        <DialogHeader className="sr-only"><DialogTitle>{t("detailsTitle")}</DialogTitle><DialogDescription>{nt("evidenceDialogHint")}</DialogDescription></DialogHeader>
        {!wide && evidenceView}
      </DialogContent>
    </Dialog>
  </div>;
}
