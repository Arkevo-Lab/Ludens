"use client";

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  AlertCircle,
  ArrowDown,
  ArrowDownToLine,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Clock,
  CornerUpLeft,
  Cpu,
  FileText,
  Inbox,
  Infinity as InfinityIcon,
  Lock,
  PanelRight,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Square,
  X,
  Zap,
} from "lucide-react";
import type { EventPoolSnapshot, PoolEvent } from "@ludens/protocol/event-pool";
import { summarizePoolEventPreview } from "@ludens/protocol/event-pool";
import { DeviceContentionDialog } from "@/components/device-contention-dialog";
import { PixelMark } from "@/components/ui/pixel-mark";
import { prefersSmoothScrollBehavior, useAnimatedPresence } from "@/components/use-motion-preferences";
import {
  ModelEffortBadge,
  ModelPickerDialog,
  ServiceTierBadge,
  isModelEffort,
  shortModelLabel,
  type ModelEffort,
  type ModelServiceTier,
} from "@/components/model-picker-dialog";
import { useTranslations } from "@/lib/locale";
import { useWorkspaceService } from "@/lib/use-workspace-service";
import type { ActivityBlock } from "@/features/live/activity-feed-model";
import { activityContentView, printable } from "@/features/live/activity-feed-model";
import { CachedObservationImg } from "@/features/live/live-media-cache";
import {
  getLiveSessionEngine,
  isDeviceBusyError,
  type EventPoolCommand,
  type RuntimeControlCommand,
} from "@/features/live/live-session-store";
import {
  asRecord,
  buildCodexSegments,
  cleanErrorMessage,
  mergePoolSnapshotSegments,
  summarizeStepBlock,
  type BuildSegmentsOptions,
  type StreamSegment,
} from "@/features/live/shiori-segments";
import { useLiveAutoScroll } from "@/features/live/use-live-auto-scroll";
import type { ActivityFeedData } from "@/features/live/use-activity-feed";
import {
  canSwitchShioriModel,
  resolveShioriActiveModel,
  useLiveSession,
  type LiveSessionActions,
} from "@/features/live/use-live-session";
import { clockTime } from "@/features/live/run-visuals";
import { runWindowSummary } from "@/lib/run-identity";
import type { Call, Observation, RunData, RunInfo } from "@/lib/types";

// The run budget is drawn as this many pixel blocks.
const BUDGET_BLOCKS = 24;

export type RuntimeControlAction = RuntimeControlCommand;
export type EventPoolClientCommand = EventPoolCommand;
export {
  buildCodexSegments,
  canSwitchShioriModel,
  mergePoolSnapshotSegments,
  resolveShioriActiveModel,
  type BuildSegmentsOptions,
  type StreamSegment,
};

function formatDurationCompact(secondsTotal: number | null | undefined): string {
  if (secondsTotal == null || !Number.isFinite(secondsTotal)) return "—";
  const clamped = Math.max(0, Math.round(secondsTotal));
  if (clamped >= 3600) {
    const h = Math.floor(clamped / 3600);
    const m = Math.floor((clamped % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const m = Math.floor(clamped / 60);
  const s = clamped % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** Isolated 1Hz clock hook used ONLY inside leaf timer badges so the chat stream never re-renders per second. */
function useLiveUpdatedDeltaSec(enabled: boolean, statusAnchorMs: number): number {
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) {
      setNowMs(null);
      return;
    }
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);

  if (!enabled || nowMs === null || !Number.isFinite(statusAnchorMs)) return 0;
  return Math.max(0, Math.min(15, Math.floor((nowMs - statusAnchorMs) / 1000)));
}

function computeLiveTimerValues(options: {
  isAuto: boolean;
  activeMaxSeconds: number | null;
  baseCycleElapsed: number;
  rawRemainingSeconds: number | null;
  updatedDeltaSec: number;
}) {
  const { isAuto, activeMaxSeconds, baseCycleElapsed, rawRemainingSeconds, updatedDeltaSec } = options;
  const cycleElapsedSeconds =
    activeMaxSeconds != null
      ? Math.min(activeMaxSeconds, baseCycleElapsed + updatedDeltaSec)
      : baseCycleElapsed + updatedDeltaSec;
  const liveRemainingSeconds =
    isAuto && typeof rawRemainingSeconds === "number"
      ? Math.max(0, Math.round(rawRemainingSeconds) - updatedDeltaSec)
      : isAuto && activeMaxSeconds != null
        ? Math.max(0, Math.round(activeMaxSeconds - cycleElapsedSeconds))
        : null;
  const budgetRatio =
    activeMaxSeconds != null && activeMaxSeconds > 0
      ? Math.min(100, Math.round((cycleElapsedSeconds / activeMaxSeconds) * 100))
      : 0;
  return { cycleElapsedSeconds, liveRemainingSeconds, budgetRatio };
}

const LivePhaseInlineBadge = memo(function LivePhaseInlineBadge({
  phaseLabel,
  phaseElapsedMs,
  tickEnabled,
  statusAnchorMs,
}: {
  phaseLabel: string;
  phaseElapsedMs?: number | null;
  tickEnabled: boolean;
  statusAnchorMs: number;
}) {
  const updatedDeltaSec = useLiveUpdatedDeltaSec(tickEnabled, statusAnchorMs);
  const displayPhaseElapsedMs =
    phaseElapsedMs != null ? phaseElapsedMs + updatedDeltaSec * 1000 : null;
  const text = `${phaseLabel}${displayPhaseElapsedMs != null ? ` ${Math.max(0, Math.round(displayPhaseElapsedMs / 1000))}s` : ""}`;
  return (
    <span className="codex-phase-inline codex-live-phase" title={text}>
      {text}
    </span>
  );
});

/** Shared contract between `ShioriWorkbench` (Col 3 dock host) and `EventPoolOverviewPanel`. */
export interface EventPoolOverviewPanelProps {
  snapshot: EventPoolSnapshot | null;
  pendingInboundCount: number;
  pendingOutboundCount: number;
  canMutate: boolean;
  canResumeAuto: boolean;
  submitting?: boolean;
  focusedEventId?: string | null;
  onFocusEvent?: (eventId: string | null) => void;
  onComposeNewEvent: () => void;
  onReply: (event: PoolEvent, resumeAuto: boolean) => void;
  onAck: (eventId: string) => Promise<void> | void;
  onWithdraw: (eventId: string) => Promise<void> | void;
  onLocateInStream: (event: PoolEvent) => void;
}

/** `HH:MM:SS` for today, `MM-DD HH:MM:SS` otherwise (local time). */
export function formatPoolTimestamp(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "—";
  const pad = (value: number) => String(value).padStart(2, "0");
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return sameDay ? clock : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
}

function poolLatencySeconds(event: Pick<PoolEvent, "createdAt">, handledAt: string | null | undefined): number | null {
  const created = Date.parse(event.createdAt);
  const handled = handledAt ? Date.parse(handledAt) : NaN;
  if (!Number.isFinite(created) || !Number.isFinite(handled) || handled < created) return null;
  return Math.round((handled - created) / 1000);
}

/** Minimal built-in Event Pool list used when no `renderEventPoolPanel` slot is wired (isolated tests). */
function FallbackEventPoolPanel({ snapshot, focusedEventId, onFocusEvent, onLocateInStream }: EventPoolOverviewPanelProps) {
  const t = useTranslations("shioriCockpit");
  const events = [...(snapshot?.events ?? [])].sort((a, b) => b.seq - a.seq);
  if (events.length === 0) {
    return (
      <div className="codex-pool-fallback-empty" data-event-pool-fallback>
        {t("poolEmptyAllTitle")}
      </div>
    );
  }
  return (
    <ul className="codex-pool-fallback-list" data-event-pool-fallback aria-label={t("poolPanelAria")}>
      {events.map(item => (
        <li key={item.id} data-focused={focusedEventId === item.id || undefined}>
          <button type="button" className="codex-pool-fallback-row" onClick={() => onFocusEvent?.(item.id)}>
            <span className="codex-pool-seq">#{item.seq}</span>
            <span className="codex-pool-fallback-text">{item.title || summarizePoolEventPreview(item.text).preview}</span>
          </button>
          <button type="button" className="codex-pool-receipt-jump" onClick={() => onLocateInStream(item)}>
            {t("poolLocateInStreamBtn")}
          </button>
        </li>
      ))}
    </ul>
  );
}

const CodexPoolReceiptCard = memo(function CodexPoolReceiptCard({
  segment,
  poolById,
  streamEnter,
  onJumpSource,
}: {
  segment: Extract<StreamSegment, { kind: "pool_receipt" }>;
  poolById: Map<string, PoolEvent>;
  streamEnter?: boolean;
  onJumpSource: (event: PoolEvent) => void;
}) {
  const t = useTranslations("shioriCockpit");
  const events = segment.ids
    .map(id => segment.events.find(item => item.id === id) ?? poolById.get(id))
    .filter((item): item is PoolEvent => Boolean(item));
  const seqs = events.map(item => `#${item.seq}`);
  const primary = events[0];
  const isHuman = segment.actor === "human";
  const title = isHuman
    ? t("poolReceiptHumanResolved").replace("{seq}", primary ? String(primary.seq) : "—")
    : seqs.length > 1
      ? t("poolReceiptShioriReadMulti").replace("{seqs}", seqs.join(", "))
      : t("poolReceiptShioriReadSingle").replace("{seq}", primary ? String(primary.seq) : "—");
  const latency = primary ? poolLatencySeconds(primary, segment.at) : null;
  return (
    <article
      className="codex-pool-receipt"
      data-actor={segment.actor}
      data-pool-receipt={segment.ids.join(",")}
      data-stream-enter={streamEnter ? "true" : undefined}
      id={segment.id}
    >
      <span className="codex-pool-receipt-icon" aria-hidden="true">
        {isHuman ? <Check className="size-3.5" /> : <Inbox className="size-3.5" />}
      </span>
      <div className="codex-pool-receipt-main">
        <strong className="codex-pool-receipt-title">{title}</strong>
        {events.slice(0, 3).map(item => (
          <span key={item.id} className="codex-pool-receipt-quote" title={item.text}>
            {item.title ? `${item.title} · ` : ""}
            {summarizePoolEventPreview(item.text).preview}
          </span>
        ))}
      </div>
      <div className="codex-pool-receipt-meta">
        {latency != null && (
          <span className="codex-pool-receipt-latency">
            {t("poolReceiptLatency").replace("{duration}", formatDurationCompact(latency))}
          </span>
        )}
        <time dateTime={segment.at}>{formatPoolTimestamp(segment.at)}</time>
        {primary && (
          <button
            type="button"
            className="codex-pool-receipt-jump"
            title={t("poolReceiptJumpSource")}
            onClick={() => onJumpSource(primary)}
          >
            <CornerUpLeft className="size-3" aria-hidden="true" />
            <span>{t("poolReceiptJumpSource")}</span>
          </button>
        )}
      </div>
    </article>
  );
});

function renderInlineFormatting(text: string): ReactNode[] {
  const tokens = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return tokens.map((token, idx) => {
    if (token.startsWith("`") && token.endsWith("`") && token.length > 2) {
      return (
        <code key={idx} className="codex-inline-code">
          {token.slice(1, -1)}
        </code>
      );
    }
    if (token.startsWith("**") && token.endsWith("**") && token.length > 4) {
      return (
        <strong key={idx} className="font-semibold text-foreground">
          {token.slice(2, -2)}
        </strong>
      );
    }
    return token;
  });
}

function formatStopReason(reason: string | null, t: (key: string) => string): string | null {
  if (!reason || reason === "enabled") return null;
  if (reason === "manual") return t("stopReasonManual");
  if (reason === "awaiting human") return t("stopReasonAwaitingHuman");
  if (reason.toLowerCase().includes("budget exhausted") || reason === "time budget") return t("stopReasonBudget");
  return reason;
}

const CodexSessionDivider = memo(function CodexSessionDivider({
  segment,
  highlighted,
  streamEnter,
}: {
  segment: Extract<StreamSegment, { kind: "session_divider" }>;
  highlighted?: boolean;
  streamEnter?: boolean;
}) {
  const t = useTranslations("shioriCockpit");
  const isPostCycle = Boolean(segment.epoch?.startsWith("post:"));
  const windowInfo = runWindowSummary({
    id: isPostCycle ? segment.id : segment.epoch || segment.id,
    startedAt: segment.startedAt,
    endedAt: segment.endedAt ?? undefined,
  });
  const timeSummary = windowInfo.summary ?? clockTime(segment.startedAt);
  const stopLabel = formatStopReason(segment.stopReason, t);

  return (
    <div
      id={segment.id}
      className="codex-session-divider"
      data-session-divider
      data-run-id={segment.runId}
      data-epoch={isPostCycle ? undefined : (segment.epoch ?? undefined)}
      data-segment-anchor={!isPostCycle && segment.epoch ? `${segment.runId}#${segment.epoch}` : segment.runId}
      data-active={segment.isActive || undefined}
      data-highlighted={highlighted || undefined}
      data-stream-enter={streamEnter ? "true" : undefined}
    >
      {segment.gapSeconds != null && segment.gapSeconds >= 5 && (
        <div className="codex-session-gap" data-session-gap>
          <span>
            ⏸ {t("sessionGapLabel").replace("{gap}", formatDurationCompact(segment.gapSeconds))}
          </span>
        </div>
      )}
      <div className="codex-session-divider-bar">
        <span className="codex-session-divider-line" />
        <div className="codex-session-divider-pill">
          <span
            className="codex-session-divider-dot"
            data-active={segment.isActive || undefined}
          />
          <strong className="codex-session-divider-status">
            {isPostCycle ? t("postCycleMaintenance") : segment.isActive ? t("segmentActive") : t("segmentCompleted")}
          </strong>
          <span className="codex-session-divider-time">{timeSummary}</span>
          {!isPostCycle && <span className="codex-session-divider-tag">#{segment.cycleIndex}</span>}
          {segment.durationSeconds != null && !segment.isActive && (
            <span className="codex-session-divider-meta">
              {t("segmentRanFor").replace("{duration}", formatDurationCompact(segment.durationSeconds))}
            </span>
          )}
          {segment.isActive && (
            <span className="codex-session-divider-meta">
              {segment.maxSeconds != null
                ? `${t("segmentLimitLabel")} ${formatDurationCompact(segment.maxSeconds)}`
                : `∞ ${t("durationUnbounded")}`}
            </span>
          )}
          {stopLabel && (
            <span className="codex-session-divider-reason">· {stopLabel}</span>
          )}
        </div>
        <span className="codex-session-divider-line" />
      </div>
    </div>
  );
});

function CodexStepPreDisclosure({ open, text }: { open: boolean; text: string }) {
  const presence = useAnimatedPresence(open, 150);
  const retainedTextRef = useRef(text);
  if (open) retainedTextRef.current = text;
  if (!presence.mounted) return null;
  return (
    <div className="codex-disclosure-grid" data-motion-state={presence.state}>
      <div className="codex-disclosure-grid-inner">
        <pre className="codex-step-pre">{open ? text : retainedTextRef.current}</pre>
      </div>
    </div>
  );
}

function CodexStepGroup({
  steps,
  forceExpanded,
  defaultOpen = false,
  selectedBlock,
  onSelect,
}: {
  steps: ActivityBlock[];
  forceExpanded: boolean;
  defaultOpen?: boolean;
  selectedBlock?: string;
  onSelect?: (block: ActivityBlock) => void;
}) {
  const t = useTranslations("shioriCockpit");
  const [open, setOpen] = useState(() => defaultOpen);
  const [expandedStepId, setExpandedStepId] = useState<string | null>(null);
  const containsSelected = Boolean(selectedBlock && steps.some(s => s.id === selectedBlock));
  const isExpanded = forceExpanded || open || containsSelected;
  const listPresence = useAnimatedPresence(steps.length > 0 && isExpanded, 160);

  if (steps.length === 0) return null;

  const toolCount = steps.filter(s => s.kind === "tool").length;
  const thinkCount = steps.filter(s => s.kind === "thinking").length;
  const obsCount = steps.filter(
    s => s.kind === "text" || s.title.toLowerCase().includes("observe"),
  ).length;

  const breakdown: string[] = [];
  if (toolCount > 0) breakdown.push(`${toolCount} ${t("stepTools")}`);
  if (obsCount > 0) breakdown.push(`${obsCount} ${t("stepObserves")}`);
  if (thinkCount > 0) breakdown.push(`${thinkCount} ${t("stepThinks")}`);

  return (
    <div className="codex-step-group" data-open={isExpanded || undefined}>
      <button
        type="button"
        className="codex-step-group-toggle"
        data-step-group-toggle=""
        aria-expanded={isExpanded}
        onClick={() => setOpen(prev => !prev)}
      >
        <span>
          {t("collapsedStepsPrefix").replace("{count}", String(steps.length))}
          {breakdown.length > 0 ? ` · ${breakdown.join(" / ")}` : ""}
        </span>
        <ChevronRight
          className={"size-3.5 codex-disclosure-chevron" + (isExpanded ? " is-open" : "")}
          aria-hidden="true"
        />
      </button>

      {listPresence.mounted && (
        <div
          className="codex-disclosure-grid"
          data-motion-state={listPresence.state}
          inert={!isExpanded || undefined}
        >
          <div className="codex-disclosure-grid-inner">
            <div className="codex-step-list">
              {steps.map(step => {
                const { badge, detail } = summarizeStepBlock(step);
                const isStepOpen = expandedStepId === step.id || selectedBlock === step.id;
                const fullText =
                  step.text ||
                  (step.tool?.result !== undefined
                    ? printable(step.tool.result)
                    : step.data !== undefined
                      ? printable(step.data)
                      : "");
                const view = fullText ? activityContentView(fullText, true) : null;

                return (
                  <div
                    key={step.id}
                    id={step.id}
                    className="codex-step-item"
                    data-selected={selectedBlock === step.id || undefined}
                    data-status={step.status}
                  >
                    <div className="codex-step-row">
                      <button
                        type="button"
                        className="codex-step-main"
                        onClick={() => {
                          setExpandedStepId(prev => (prev === step.id ? null : step.id));
                          onSelect?.(step);
                        }}
                      >
                        <span className="codex-step-badge" data-kind={step.kind}>
                          {badge}
                        </span>
                        <span className="codex-step-detail">{detail}</span>
                      </button>
                      <div className="codex-step-meta">
                        <time className="font-mono text-[11px] text-muted-foreground">
                          {clockTime(step.at)}
                        </time>
                      </div>
                    </div>

                    {view && <CodexStepPreDisclosure open={isStepOpen} text={view.text} />}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const CodexInputCard = memo(function CodexInputCard({
  segId,
  project,
  run,
  call,
  observations,
  bgBlock,
  at,
  isSelected,
  streamEnter,
  onInspectInput,
  onOpenReplayAt,
}: {
  segId: string;
  project: string;
  run: string;
  call?: Call;
  observations: Observation[];
  bgBlock?: ActivityBlock;
  at: string;
  isSelected: boolean;
  streamEnter?: boolean;
  onInspectInput: (runId: string, segId: string, call?: Call, imageId?: string, at?: string) => void;
  onOpenReplayAt?: (frame: { run?: string; at?: number; record: string; sequence: number }) => void;
}) {
  const t = useTranslations("shioriCockpit");
  const [expandedPayload, setExpandedPayload] = useState(false);
  const payloadPresence = useAnimatedPresence(expandedPayload, 160);

  const perception = call?.perception;
  const snapshot = perception?.snapshot;
  const timeline = snapshot?.timeline ?? observations[0]?.timeline;
  const replayRecordId = timeline?.recordId;
  const replaySequence = timeline?.sequence;
  const sequence = snapshot?.sequence ?? timeline?.sequence;
  const capability = snapshot?.capability ?? observations[0]?.origin ?? null;
  const durationMs = perception?.durationMs;

  const bgData = asRecord(bgBlock?.data);
  const bgJobId = typeof bgData?.jobId === "string" ? bgData.jobId : null;
  const bgLabel =
    typeof bgData?.label === "string"
      ? bgData.label
      : typeof bgData?.command === "string"
        ? bgData.command
        : null;
  const bgResultRec = asRecord(bgData?.result);
  const bgResult =
    typeof bgData?.result === "string"
      ? bgData.result.trim().slice(0, 240)
      : bgResultRec && (bgResultRec.encoding === "ludens-json-v1" || typeof bgResultRec.path === "string")
        ? `Archived output${typeof bgResultRec.bytes === "number" ? ` (${bgResultRec.bytes.toLocaleString()} B)` : ""}`
        : null;
  const bgExitCode = typeof bgData?.exitCode === "number" ? bgData.exitCode : null;
  const bgStatus = typeof bgData?.status === "string" ? bgData.status : null;
  const bgDurationMs = typeof bgData?.durationMs === "number" ? bgData.durationMs : null;

  const textSnippets: string[] = [];
  if (call?.inputText && call.inputText.trim()) {
    textSnippets.push(cleanErrorMessage(call.inputText.trim()));
  }
  for (const obs of observations) {
    if (obs.text && obs.text.trim()) {
      const cleaned = cleanErrorMessage(obs.text.trim());
      if (!textSnippets.includes(cleaned)) textSnippets.push(cleaned);
    }
  }
  if (perception?.records) {
    for (const rec of perception.records) {
      if (rec.text && rec.text.trim()) {
        const cleaned = cleanErrorMessage(rec.text.trim());
        if (!textSnippets.includes(cleaned)) textSnippets.push(cleaned);
      }
    }
  }
  if (perception?.deliveryError && perception.deliveryError.trim()) {
    const cleanedErr = cleanErrorMessage(perception.deliveryError);
    if (!textSnippets.some(s => s.includes(cleanedErr))) {
      textSnippets.push(`⚠ ${cleanedErr}`);
    }
  }
  if (bgLabel && bgLabel.trim()) {
    textSnippets.push(bgLabel.trim());
  }
  if (bgResult && bgResult.trim() && bgResult.trim() !== bgLabel?.trim()) {
    textSnippets.push(bgResult.trim());
  }

  const recordedObservations = observations.filter(obs => obs.mediaStorage !== "unrecorded");
  const visibleObservations = recordedObservations.slice(0, 4);
  const extraObservationCount = Math.max(0, recordedObservations.length - visibleObservations.length);

  return (
    <article
      className="codex-input-card"
      data-call-id={call?.id}
      data-run-segment={run}
      data-selected={isSelected || undefined}
      data-stream-enter={streamEnter ? "true" : undefined}
      onClick={() => onInspectInput(run, segId, call, observations[0]?.id, at)}
    >
      <header className="codex-input-header">
        <div className="codex-input-header-left">
          <span className="codex-input-badge">{t("inputBadge")}</span>
          {call && (
            <span className="codex-input-req">
              {t("inputRequestTag").replace("{number}", String(call.index).padStart(3, "0"))}
            </span>
          )}
          <span className="codex-input-title">
            {bgBlock
              ? `${t("inputBgResultTitle")}${bgJobId ? ` · ${bgJobId}` : ""}`
              : capability || t("inputPerceptionTitle")}
          </span>
        </div>

        <div className="codex-input-header-right">
          {replayRecordId && typeof replaySequence === "number" && onOpenReplayAt ? (
            <button
              type="button"
              className="codex-replay-jump-link"
              title={t("jumpToReplayAt").replace("{time}", clockTime(at))}
              onClick={event => {
                event.stopPropagation();
                const parsedAt = Date.parse(at);
                onOpenReplayAt({
                  run,
                  at: Number.isFinite(parsedAt) ? parsedAt : undefined,
                  record: replayRecordId,
                  sequence: replaySequence,
                });
              }}
            >
              ⏱ {t("jumpToReplayAt").replace("{time}", clockTime(at))}
            </button>
          ) : (
            <time className="font-mono text-[11px] text-muted-foreground">{clockTime(at)}</time>
          )}
        </div>
      </header>

      <div className="codex-input-body">
        {visibleObservations.length > 0 && (
          <div className="codex-input-thumbs">
            {visibleObservations.map((obs, idx) => (
              <button
                key={obs.id}
                type="button"
                className="codex-input-thumb"
                title={t("inputPreviewInStage")}
                onClick={event => {
                  event.stopPropagation();
                  onInspectInput(run, segId, call, obs.id, at);
                }}
              >
                <CachedObservationImg
                  src={`/api/media?project=${encodeURIComponent(project)}&run=${encodeURIComponent(run)}&id=${encodeURIComponent(obs.id)}`}
                  alt={obs.origin || obs.id}
                  width={96}
                  height={54}
                />
                {idx === visibleObservations.length - 1 && extraObservationCount > 0 && (
                  <span className="codex-input-thumb-more">+{extraObservationCount}</span>
                )}
              </button>
            ))}
          </div>
        )}

        <div className="codex-input-content">
          {textSnippets.length > 0 && (
            <div className="codex-input-text">
              {textSnippets.map((snippet, idx) => (
                <p key={idx}>{snippet}</p>
              ))}
            </div>
          )}

          <div className="codex-input-meta-chips">
            {observations.length > 0 && (
              <span className="codex-input-chip">
                🖼 {t("inputFramesCount").replace("{count}", String(observations.length))}
              </span>
            )}
            {sequence != null && (
              <span className="codex-input-chip">
                {t("inputSeqLabel").replace("{seq}", String(sequence))}
              </span>
            )}
            {durationMs != null && (
              <span className="codex-input-chip">
                {t("inputSamplingMs").replace("{ms}", durationMs.toFixed(1))}
              </span>
            )}
            {bgDurationMs != null && (
              <span className="codex-input-chip">
                {(bgDurationMs / 1000).toFixed(1)}s
              </span>
            )}
            {(bgExitCode != null || bgStatus) && (
              <span className="codex-input-chip">
                {bgExitCode != null ? `exit ${bgExitCode}` : bgStatus}
              </span>
            )}
            <button
              type="button"
              className="codex-input-payload-toggle"
              aria-expanded={expandedPayload}
              onClick={event => {
                event.stopPropagation();
                setExpandedPayload(prev => !prev);
              }}
            >
              <ChevronRight
                className={"size-3 codex-disclosure-chevron" + (expandedPayload ? " is-open" : "")}
                aria-hidden="true"
              />
              <span>{t("inputExpandPayload")}</span>
            </button>
          </div>

          {payloadPresence.mounted && (
            <div
              className="codex-disclosure-grid"
              data-motion-state={payloadPresence.state}
              inert={!expandedPayload || undefined}
              onClick={event => event.stopPropagation()}
            >
              <div className="codex-disclosure-grid-inner">
                <pre className="codex-input-payload-pre">
                  {printable(
                    call
                      ? {
                          callIndex: call.index,
                          callId: call.id,
                          ...(call.inputText ? { inputText: call.inputText } : {}),
                          ...(call.inputObservations.length > 0 ? { inputObservations: call.inputObservations } : {}),
                          ...(call.perception ? { perception: call.perception } : {}),
                        }
                      : (bgBlock?.data ?? bgBlock),
                  )}
                </pre>
              </div>
            </div>
          )}
        </div>
      </div>
    </article>
  );
});

const CodexTurnAssistantRow = memo(function CodexTurnAssistantRow({
  segment,
  fallbackRunId,
  showAllSteps,
  isLastSegment,
  selectedStepId,
  streamEnter,
  onInspectBlock,
}: {
  segment: Extract<StreamSegment, { kind: "turn" }>;
  fallbackRunId: string;
  showAllSteps: boolean;
  isLastSegment: boolean;
  selectedStepId?: string;
  streamEnter?: boolean;
  onInspectBlock: (runId: string, block: ActivityBlock, siblingSteps: ActivityBlock[]) => void;
}) {
  const paragraphs = segment.responseText
    ? segment.responseText.split(/\n{2,}/).filter(Boolean)
    : [];
  const ownerRunId = segment.runId || fallbackRunId;

  return (
    <article
      id={segment.responseBlock?.id}
      className="codex-turn-assistant"
      data-stream-enter={streamEnter ? "true" : undefined}
    >
      <CodexStepGroup
        steps={segment.steps}
        forceExpanded={showAllSteps}
        defaultOpen={paragraphs.length === 0 && isLastSegment}
        selectedBlock={selectedStepId}
        onSelect={step => onInspectBlock(ownerRunId, step, segment.steps)}
      />

      {paragraphs.length > 0 && (
        <div className="codex-assistant-prose">
          {paragraphs.map((para, idx) => (
            <p key={idx}>{renderInlineFormatting(para)}</p>
          ))}
        </div>
      )}
    </article>
  );
});

function resolveCallForTurn(
  block: ActivityBlock,
  siblingSteps: ActivityBlock[],
  calls: Call[],
): Call | undefined {
  if (!calls.length) return undefined;
  const directId = block.trace?.modelCallId;
  if (directId) {
    const found = calls.find(c => c.id === directId);
    if (found) return found;
  }
  for (let i = siblingSteps.length - 1; i >= 0; i--) {
    const stepCallId = siblingSteps[i].trace?.modelCallId;
    if (stepCallId) {
      const found = calls.find(c => c.id === stepCallId);
      if (found) return found;
    }
  }
  const targetMs = Date.parse(block.at) || Date.parse(siblingSteps.at(-1)?.at ?? "") || 0;
  if (targetMs > 0) {
    const candidates = calls.filter(c => (c.atMs || Date.parse(c.at)) <= targetMs + 15_000);
    const withObs = [...candidates].reverse().find(c => c.inputObservations.length > 0);
    if (withObs) return withObs;
    if (candidates.length > 0) return candidates[candidates.length - 1];
  }
  return [...calls].reverse().find(c => c.inputObservations.length > 0) ?? calls.at(-1);
}

export type ComposerMode = "event" | "start" | "steer";

function LiveStopTimerControl({
  remainingSeconds,
  disabled = false,
  placement = "down",
  compact = false,
  onApplyTimer,
  onExtendTimer,
}: {
  remainingSeconds: number | null;
  disabled?: boolean;
  placement?: "up" | "down";
  compact?: boolean;
  onApplyTimer: (seconds: number | null) => Promise<void>;
  onExtendTimer?: (deltaSeconds: number) => Promise<void>;
}) {
  const t = useTranslations("shioriCockpit");
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const popoverPresence = useAnimatedPresence(open, 140);
  const [busy, setBusy] = useState(false);
  const [customMinutes, setCustomMinutes] = useState("30");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const handleKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    };
    const handlePointer = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", handleKey);
    window.addEventListener("mousedown", handlePointer);
    return () => {
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("mousedown", handlePointer);
    };
  }, [open]);

  const apply = async (seconds: number | null) => {
    if (busy || disabled) return;
    setBusy(true);
    setErr(null);
    try {
      await onApplyTimer(seconds);
      setOpen(false);
    } catch (cause) {
      setErr(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const isTimed = remainingSeconds != null;
  const formattedRemaining = formatDurationCompact(remainingSeconds);
  const pillLabel = isTimed
    ? compact
      ? formattedRemaining
      : t("timerCountdownBadge").replace("{remaining}", formattedRemaining)
    : t("timerUnboundedBadge");

  const quickPresets: Array<{ short: string; label: string; seconds: number }> = [
    { short: "15m", label: t("timerStopIn15m"), seconds: 900 },
    { short: "30m", label: t("timerStopIn30m"), seconds: 1800 },
    { short: "1h", label: t("timerStopIn60m"), seconds: 3600 },
    { short: "2h", label: t("timerStopIn2h"), seconds: 7200 },
  ];

  return (
    <div ref={wrapRef} className="codex-live-timer-wrap">
      <button
        type="button"
        className="codex-runtime-timer-pill"
        data-timed={isTimed ? "true" : undefined}
        data-compact={compact ? "true" : undefined}
        aria-expanded={open}
        disabled={disabled || busy}
        title={t("timerSetBtnHint")}
        onClick={() => {
          setErr(null);
          setOpen(prev => !prev);
        }}
      >
        {isTimed ? (
          <Clock className="size-3.5 shrink-0" aria-hidden="true" />
        ) : (
          <InfinityIcon className="size-3.5 shrink-0" aria-hidden="true" />
        )}
        <span>{pillLabel}</span>
        <ChevronDown className="size-3 shrink-0 opacity-70" aria-hidden="true" />
      </button>

      {popoverPresence.mounted && (
        <div
          className="codex-runtime-timer-popover"
          data-placement={placement}
          data-motion-state={popoverPresence.state}
          inert={!open || undefined}
          role="dialog"
          aria-label={t("timerLiveMenuTitle")}
        >
          <div className="codex-runtime-timer-head">
            <strong>{t("timerLiveMenuTitle")}</strong>
            <p>{t("timerLiveMenuDesc")}</p>
          </div>

          <div className="codex-runtime-timer-grid">
            {quickPresets.map(opt => (
              <button
                key={opt.seconds}
                type="button"
                className="codex-runtime-preset-btn"
                disabled={busy}
                onClick={() => void apply(opt.seconds)}
              >
                <strong>{opt.short}</strong>
                <span>{opt.label}</span>
              </button>
            ))}
          </div>

          {isTimed ? (
            <div className="codex-runtime-timer-actions">
              <button
                type="button"
                className="codex-runtime-extend-btn"
                disabled={busy}
                onClick={() => {
                  if (onExtendTimer) {
                    setBusy(true);
                    setErr(null);
                    void onExtendTimer(900)
                      .then(() => setOpen(false))
                      .catch(cause => setErr(cause instanceof Error ? cause.message : String(cause)))
                      .finally(() => setBusy(false));
                  } else {
                    void apply(Math.max(60, Math.round((remainingSeconds ?? 0) + 900)));
                  }
                }}
              >
                <Clock className="size-3.5 shrink-0" aria-hidden="true" />
                <span>{t("timerExtend15m")}</span>
              </button>
              <button
                type="button"
                className="codex-runtime-unbounded-btn"
                disabled={busy}
                onClick={() => void apply(null)}
              >
                <InfinityIcon className="size-3.5 shrink-0" aria-hidden="true" />
                <div className="codex-runtime-unbounded-copy">
                  <strong>{t("timerSwitchUnbounded")}</strong>
                  <small>{t("timerSwitchUnboundedDesc")}</small>
                </div>
              </button>
            </div>
          ) : (
            <div className="codex-runtime-unbounded-active">
              <InfinityIcon className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
              <span>{t("durationUnbounded")} ✓</span>
              <small>{t("durationUnboundedDesc")}</small>
            </div>
          )}

          <div className="codex-duration-custom">
            <label className="codex-duration-custom-label" htmlFor={`live-stop-mins-${placement}`}>
              {t("timerCustomStopLabel")}
            </label>
            <div className="codex-duration-custom-row">
              <input
                id={`live-stop-mins-${placement}`}
                type="number"
                min={1}
                max={1440}
                value={customMinutes}
                onChange={event => setCustomMinutes(event.target.value)}
                onKeyDown={event => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    const mins = Number(customMinutes);
                    if (Number.isFinite(mins) && mins > 0) {
                      void apply(Math.round(mins * 60));
                    }
                  }
                }}
                className="codex-duration-custom-input"
              />
              <button
                type="button"
                className="codex-duration-custom-btn"
                disabled={busy}
                onClick={() => {
                  const mins = Number(customMinutes);
                  if (Number.isFinite(mins) && mins > 0) {
                    void apply(Math.round(mins * 60));
                  }
                }}
              >
                {t("durationCustomApply")}
              </button>
            </div>
          </div>

          {err && (
            <p className="codex-composer-feedback codex-composer-feedback-err !m-0" role="alert">
              {err}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export interface LiveTimerSpec {
  tickEnabled: boolean;
  statusAnchorMs: number;
  activeMaxSeconds: number | null;
  baseCycleElapsed: number;
  rawRemainingSeconds: number | null;
}

const LiveComposerTimerSlot = memo(function LiveComposerTimerSlot({
  spec,
  fallbackRemainingSeconds,
  disabled,
  onApplyTimer,
  onExtendTimer,
}: {
  spec?: LiveTimerSpec | null;
  fallbackRemainingSeconds: number | null;
  disabled: boolean;
  onApplyTimer: (seconds: number | null) => Promise<void>;
  onExtendTimer?: (deltaSeconds: number, currentRemainingSeconds: number) => Promise<void>;
}) {
  const updatedDeltaSec = useLiveUpdatedDeltaSec(
    Boolean(spec?.tickEnabled),
    spec?.statusAnchorMs ?? NaN,
  );
  const computedRemaining = spec
    ? computeLiveTimerValues({
        isAuto: true,
        activeMaxSeconds: spec.activeMaxSeconds,
        baseCycleElapsed: spec.baseCycleElapsed,
        rawRemainingSeconds: spec.rawRemainingSeconds,
        updatedDeltaSec,
      }).liveRemainingSeconds
    : fallbackRemainingSeconds;

  return (
    <LiveStopTimerControl
      remainingSeconds={computedRemaining}
      disabled={disabled}
      placement="up"
      compact
      onExtendTimer={
        onExtendTimer
          ? delta => onExtendTimer(delta, computedRemaining ?? 0)
          : undefined
      }
      onApplyTimer={onApplyTimer}
    />
  );
});

const LiveRuntimeTelemetryHeader = memo(function LiveRuntimeTelemetryHeader({
  isAuto,
  hostOnline,
  elapsedSeconds,
  stateTitle,
  spec,
  onApplyTimer,
  onExtendTimer,
}: {
  isAuto: boolean;
  hostOnline: boolean;
  elapsedSeconds: number;
  stateTitle: string;
  spec: LiveTimerSpec;
  onApplyTimer: (seconds: number | null) => Promise<void>;
  onExtendTimer: (deltaSeconds: number, currentRemainingSeconds: number) => Promise<void>;
}) {
  const t = useTranslations("shioriCockpit");
  const updatedDeltaSec = useLiveUpdatedDeltaSec(spec.tickEnabled, spec.statusAnchorMs);
  const { cycleElapsedSeconds, liveRemainingSeconds, budgetRatio } = computeLiveTimerValues({
    isAuto,
    activeMaxSeconds: spec.activeMaxSeconds,
    baseCycleElapsed: spec.baseCycleElapsed,
    rawRemainingSeconds: spec.rawRemainingSeconds,
    updatedDeltaSec,
  });

  return (
    <>
      <div className="codex-runtime-header shiori-budget-header">
        <h3 className="codex-dock-heading" title={t("telemetryCardTitle")}>
          {t("telemetryCardTitle")}
        </h3>
        <div className="codex-runtime-header-right">
          {isAuto && hostOnline ? (
            <>
              <span className="codex-runtime-elapsed">
                {t("runtimeElapsedPrefix").replace(
                  "{elapsed}",
                  formatDurationCompact(cycleElapsedSeconds),
                )}
              </span>
              <LiveStopTimerControl
                remainingSeconds={liveRemainingSeconds}
                placement="down"
                onApplyTimer={onApplyTimer}
                onExtendTimer={delta => onExtendTimer(delta, liveRemainingSeconds ?? 0)}
              />
            </>
          ) : (
            <span
              className="codex-runtime-status-summary"
              title={`${formatDurationCompact(elapsedSeconds)} · ${stateTitle}`}
            >
              {formatDurationCompact(elapsedSeconds)} · {stateTitle}
            </span>
          )}
        </div>
      </div>

      {isAuto && spec.activeMaxSeconds != null && liveRemainingSeconds != null && (
        <div
          className="shiori-budget-bar"
          role="progressbar"
          aria-valuenow={budgetRatio}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          {Array.from({ length: BUDGET_BLOCKS }, (_, index) => {
            const lit = Math.round((budgetRatio / 100) * BUDGET_BLOCKS);
            return (
              <i
                key={index}
                data-on={index < lit || undefined}
                data-head={(index === lit - 1 && lit < BUDGET_BLOCKS) || undefined}
              />
            );
          })}
        </div>
      )}
    </>
  );
});

export function ShioriComposer({
  project,
  workspace,
  data,
  isLiveRun,
  sessionActions,
  hostStatusOverride,
  onHostStatusChange,
  activeModelOverride,
  activeServiceTierOverride,
  activeEffortOverride,
  submittingOverride,
  spawningCore = false,
  preemptSuccessSeq = 0,
  onModelChange,
  liveRemainingSeconds,
  liveTimerSpec,
  onApplyLiveTimer,
  onExtendLiveTimer,
  poolSnapshot,
  replyTarget,
  replyAutoResumeDefault,
  onSelectReplyTarget,
  onPoolMutated,
  externalMode,
  externalDraft,
  onExternalConsumed,
  onReturnLatest,
  onMessageSubmitted,
  onUpdated,
}: {
  project: string;
  workspace: string | null;
  data: RunData;
  isLiveRun: boolean;
  sessionActions?: LiveSessionActions;
  hostStatusOverride?: Record<string, unknown> | null;
  onHostStatusChange?: (status: Record<string, unknown>) => void;
  activeModelOverride?: string | null;
  activeServiceTierOverride?: ModelServiceTier | null;
  activeEffortOverride?: ModelEffort | null;
  submittingOverride?: boolean;
  spawningCore?: boolean;
  preemptSuccessSeq?: number;
  onModelChange?: (model: string) => void;
  liveRemainingSeconds?: number | null;
  liveTimerSpec?: LiveTimerSpec | null;
  onApplyLiveTimer?: (seconds: number | null) => Promise<void>;
  onExtendLiveTimer?: (deltaSeconds: number, currentRemainingSeconds?: number) => Promise<void>;
  poolSnapshot?: EventPoolSnapshot | null;
  replyTarget?: PoolEvent | null;
  replyAutoResumeDefault?: boolean;
  onSelectReplyTarget?: (event: PoolEvent | null, autoResume?: boolean) => void;
  onPoolMutated?: (snapshot: EventPoolSnapshot, hostStatus?: Record<string, unknown>) => void;
  externalMode?: ComposerMode | null;
  externalDraft?: string | null;
  onExternalConsumed?(): void;
  onReturnLatest?(): void;
  onMessageSubmitted?(): void;
  onUpdated(): void;
}) {
  const t = useTranslations("shioriCockpit");
  const composerDockRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [draft, setDraft] = useState("");
  const [selectedTab, setSelectedTab] = useState<ComposerMode | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [durationMenuOpen, setDurationMenuOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelLockNotice, setModelLockNotice] = useState<string | null>(null);
  const [resumeOnReply, setResumeOnReply] = useState(false);

  useEffect(() => {
    if (!menuOpen && !durationMenuOpen) return;
    const handleKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        setDurationMenuOpen(false);
      }
    };
    const handlePointer = (event: MouseEvent) => {
      if (composerDockRef.current && !composerDockRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
        setDurationMenuOpen(false);
      }
    };
    window.addEventListener("keydown", handleKey);
    window.addEventListener("mousedown", handlePointer);
    return () => {
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("mousedown", handlePointer);
    };
  }, [menuOpen, durationMenuOpen]);
  const [durationSeconds, setDurationSeconds] = useState<number | null>(null);
  const [customMinutes, setCustomMinutes] = useState("45");
  const [localSubmitting, setLocalSubmitting] = useState(false);
  const submitting = Boolean(localSubmitting || submittingOverride);
  const [error, setError] = useState<string | null>(null);
  const [lastSent, setLastSent] = useState<string | null>(null);
  const pendingContentionDraftRef = useRef<{ clearDraft: boolean; feedback: string } | null>(null);
  const [localModelOverride, setLocalModelOverride] = useState<{
    project: string;
    baseServerModel: string | null;
    model: string;
    serviceTier?: ModelServiceTier | null;
    effort?: ModelEffort | null;
  } | null>(null);
  const [localHostOverride, setLocalHostOverride] = useState<{
    project: string;
    run: string;
    baseUpdatedAt: string;
    status: Record<string, unknown>;
  } | null>(null);

  useEffect(() => {
    setLocalModelOverride(null);
    setLocalHostOverride(null);
    setModelPickerOpen(false);
    setModelLockNotice(null);
    setError(null);
    setLastSent(null);
    try {
      if (typeof window !== "undefined" && project) {
        const stored = window.localStorage.getItem(`ludens:takeover-duration:${project}`);
        if (!stored || stored === "unbounded") {
          setDurationSeconds(null);
        } else {
          const parsed = Number(stored);
          if (Number.isFinite(parsed) && parsed > 0) setDurationSeconds(parsed);
        }
      }
    } catch {
      // Ignore storage errors
    }
  }, [project]);

  useEffect(() => {
    if (!modelLockNotice) return;
    const timer = setTimeout(() => setModelLockNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [modelLockNotice]);

  useEffect(() => {
    if (!preemptSuccessSeq || !pendingContentionDraftRef.current) return;
    const pending = pendingContentionDraftRef.current;
    pendingContentionDraftRef.current = null;
    if (pending.clearDraft) setDraft("");
    onSelectReplyTarget?.(null);
    setError(null);
    setLastSent(pending.feedback);
  }, [preemptSuccessSeq, onSelectReplyTarget]);

  const updateDurationSeconds = (next: number | null) => {
    setDurationSeconds(next);
    setDurationMenuOpen(false);
    try {
      if (typeof window !== "undefined" && project) {
        window.localStorage.setItem(
          `ludens:takeover-duration:${project}`,
          next == null ? "unbounded" : String(next),
        );
      }
    } catch {
      // Ignore storage errors
    }
  };

  const activeLocalStatus =
    localHostOverride &&
    localHostOverride.project === project &&
    localHostOverride.run === data.run &&
    localHostOverride.baseUpdatedAt === data.updatedAt
      ? localHostOverride.status
      : null;

  const effectiveHost = (hostStatusOverride ?? activeLocalStatus ?? data.live) as (NonNullable<RunData["live"]> & {
    consolidating?: boolean;
    model?: string | null;
    serviceTier?: ModelServiceTier | null;
    effort?: ModelEffort | null;
    hostOffline?: boolean;
    coreOffline?: boolean;
  }) | null;
  const control = data.lastControl as (RunData["lastControl"] & {
    model?: string | null;
    serviceTier?: ModelServiceTier | null;
    effort?: ModelEffort | null;
  }) | undefined;
  const runtimeMode =
    effectiveHost?.mode ?? (typeof control?.mode === "string" ? control.mode : "manual");
  const consolidating = Boolean(effectiveHost?.consolidating ?? control?.consolidating);
  const thinking = Boolean(effectiveHost?.thinking ?? control?.thinking);
  const isAuto = runtimeMode === "auto";
  const isSyntheticOffline = Boolean(effectiveHost?.coreOffline ?? effectiveHost?.hostOffline);
  const hostOnline = Boolean(isLiveRun && ((!isSyntheticOffline && effectiveHost) || data.controlAllowed));
  const canResumeFromReply = Boolean(!isAuto && !consolidating);
  const canSwitchModel = canSwitchShioriModel({
    isLiveRun,
    hostOnline,
    mode: runtimeMode,
    consolidating,
    thinking,
  });

  useEffect(() => {
    if (canSwitchModel && modelLockNotice) {
      setModelLockNotice(null);
    }
  }, [canSwitchModel, modelLockNotice]);

  const serverModel = resolveShioriActiveModel({
    liveModel: typeof effectiveHost?.model === "string" ? effectiveHost.model : null,
    controlModel: typeof control?.model === "string" ? control.model : null,
    manifestModel: data.manifest.model ?? null,
  });
  const validLocalModel =
    localModelOverride &&
    localModelOverride.project === project &&
    (serverModel === localModelOverride.baseServerModel || serverModel === localModelOverride.model)
      ? localModelOverride.model
      : null;
  const activeModel = resolveShioriActiveModel({
    localModelOverride: activeModelOverride ?? validLocalModel,
    liveModel: typeof effectiveHost?.model === "string" ? effectiveHost.model : null,
    controlModel: typeof control?.model === "string" ? control.model : null,
    manifestModel: data.manifest.model ?? null,
  });
  const activeServiceTier: ModelServiceTier | null =
    activeServiceTierOverride !== undefined
      ? activeServiceTierOverride
      : validLocalModel && activeModel === localModelOverride?.model
        ? (localModelOverride.serviceTier ?? null)
        : (effectiveHost?.serviceTier ?? control?.serviceTier ?? null);
  const activeEffort: ModelEffort | null =
    activeEffortOverride !== undefined
      ? activeEffortOverride
      : validLocalModel && activeModel === localModelOverride?.model
        ? (localModelOverride.effort ?? null)
        : isModelEffort(effectiveHost?.effort)
          ? effectiveHost.effort
          : isModelEffort(control?.effort)
            ? control.effort
            : null;

  useEffect(() => {
    if (!replyTarget) {
      setResumeOnReply(false);
      return;
    }
    setResumeOnReply(
      Boolean(
        canResumeFromReply &&
          (replyAutoResumeDefault ?? Boolean(replyTarget.pauseRequested)),
      ),
    );
    const timer = setTimeout(() => textareaRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [replyTarget?.id, replyAutoResumeDefault, canResumeFromReply]);

  useEffect(() => {
    if (externalDraft == null && externalMode == null) return;
    if (externalDraft != null) setDraft(externalDraft);
    if (externalMode != null) setSelectedTab(externalMode);
    onExternalConsumed?.();
    const timer = setTimeout(() => textareaRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [externalDraft, externalMode, onExternalConsumed]);

  const validModes: ComposerMode[] = isAuto
    ? ["event", "steer"]
    : !consolidating
      ? ["start", "event"]
      : ["event", "start"];

  const effectiveTab: ComposerMode = replyTarget
    ? "event"
    : selectedTab && validModes.includes(selectedTab)
      ? selectedTab
      : isAuto
        ? "event"
        : !consolidating
          ? "start"
          : "event";

  const showPreStartDurationPill =
    !isAuto && (effectiveTab === "start" || Boolean(replyTarget && resumeOnReply));

  const cycleModeTab = () => {
    if (replyTarget) {
      onSelectReplyTarget?.(null);
    }
    setDurationMenuOpen(false);
    const idx = validModes.indexOf(effectiveTab);
    const next = validModes[(idx >= 0 ? idx + 1 : 0) % validModes.length];
    setSelectedTab(next);
  };

  const applyHostStatusObject = (status: Record<string, unknown> | undefined | null) => {
    if (!status) return;
    setLocalHostOverride({ project, run: data.run, baseUpdatedAt: data.updatedAt, status });
    onHostStatusChange?.(status);
    if (typeof status.model === "string" && status.model.trim()) {
      const nextModel = status.model.trim();
      setLocalModelOverride({
        project,
        baseServerModel: serverModel,
        model: nextModel,
        serviceTier: status.serviceTier === "priority" || status.serviceTier === "ultrafast" ? status.serviceTier : null,
        effort: isModelEffort(status.effort) ? status.effort : null,
      });
      onModelChange?.(nextModel);
    }
  };

  const handleSelectModel = async (
    nextModel: string,
    nextServiceTier: ModelServiceTier | null,
    nextEffort: ModelEffort | null,
  ) => {
    const trimmed = nextModel.trim();
    if (!trimmed || !project) return;
    if (!canSwitchModel) {
      setModelLockNotice(t("modelSwitchLockedHint"));
      throw new Error(t("modelSwitchLockedHint"));
    }
    setError(null);
    setModelLockNotice(null);

    const { persistedOffline } = sessionActions
      ? await sessionActions.switchModel(trimmed, nextServiceTier, nextEffort)
      : await getLiveSessionEngine(project).switchModel({
          workspace,
          run: data.run,
          baseUpdatedAt: data.updatedAt,
          baseServerModel: serverModel,
          expectedEpoch: effectiveHost?.epoch ?? null,
          hostOnline,
          model: trimmed,
          serviceTier: nextServiceTier,
          effort: nextEffort,
          onUpdated,
        });

    setLocalModelOverride({
      project,
      baseServerModel: serverModel,
      model: trimmed,
      serviceTier: nextServiceTier,
      effort: nextEffort,
    });
    onModelChange?.(trimmed);
    setLastSent(
      (persistedOffline ? t("modelSwitchedOfflineFeedback") : t("modelSwitchedFeedback")).replace(
        "{model}",
        trimmed,
      ),
    );
  };

  const dismissOutboundEvent = async (eventId: string) => {
    if (submitting || !project || !workspace) return;
    setLocalSubmitting(true);
    setError(null);
    try {
      const res = sessionActions
        ? await sessionActions.ackPoolEvent(eventId, { fromComposer: true })
        : await getLiveSessionEngine(project).mutatePool({
            workspace,
            run: data.run,
            baseUpdatedAt: data.updatedAt,
            baseServerModel: serverModel,
            command: { action: "ack", ids: [eventId] },
            fromComposer: true,
            onUpdated,
          });
      if (res) {
        applyHostStatusObject(res.hostStatus);
        onPoolMutated?.(res.snapshot, res.hostStatus);
      }
      if (replyTarget?.id === eventId) onSelectReplyTarget?.(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLocalSubmitting(false);
    }
  };

  const submitMessage = async (overrideText?: string, forceResumeAuto?: boolean) => {
    const text = (overrideText ?? draft).trim();
    if (submitting || !project || !workspace) return;
    if (effectiveTab !== "start" && !text) return;
    setLocalSubmitting(true);
    setError(null);
    setDurationMenuOpen(false);
    onMessageSubmitted?.();
    try {
      const engine = sessionActions ? null : getLiveSessionEngine(project);
      if (effectiveTab === "event") {
        const shouldResume = Boolean((forceResumeAuto ?? resumeOnReply) && canResumeFromReply);
        const res = sessionActions
          ? replyTarget
            ? await sessionActions.replyPoolEvent({
                replyTo: replyTarget.id,
                text,
                resumeAuto: shouldResume,
                seconds: shouldResume ? durationSeconds : undefined,
              })
            : await sessionActions.sendPoolEvent(text)
          : await engine!.mutatePool({
              workspace,
              run: data.run,
              baseUpdatedAt: data.updatedAt,
              baseServerModel: serverModel,
              command: replyTarget
                ? {
                    action: "reply",
                    replyTo: replyTarget.id,
                    text,
                    ...(shouldResume ? { resumeAuto: true, seconds: durationSeconds } : {}),
                  }
                : { action: "send", text },
              fromComposer: true,
              onUpdated,
            });
        applyHostStatusObject(res.hostStatus);
        onPoolMutated?.(res.snapshot, res.hostStatus);
        pendingContentionDraftRef.current = null;
        if (!overrideText) setDraft("");
        onSelectReplyTarget?.(null);
        setLastSent(res.hostOnline ? text : `${t("poolOfflineQueuedFeedback")} · ${text}`);
        return;
      }

      if (effectiveTab === "steer") {
        const { fellBackToAutoOn, status } = sessionActions
          ? await sessionActions.steerOrStartAuto(text, durationSeconds)
          : await engine!.steerOrStartAuto({
              workspace,
              run: data.run,
              baseUpdatedAt: data.updatedAt,
              baseServerModel: serverModel,
              expectedEpoch: effectiveHost?.epoch ?? null,
              message: text,
              fallbackSeconds: durationSeconds,
              mightSpawnCore: !hostOnline,
              onUpdated,
            });
        if (fellBackToAutoOn) setSelectedTab(null);
        applyHostStatusObject(status);
      } else {
        const { status } = sessionActions
          ? await sessionActions.startAuto({
              message: text || undefined,
              seconds: durationSeconds,
            })
          : await engine!.runRuntimeCommand({
              workspace,
              run: data.run,
              baseUpdatedAt: data.updatedAt,
              baseServerModel: serverModel,
              mightSpawnCore: !hostOnline,
              command: {
                action: "auto_on",
                ...(text ? { message: text } : {}),
                seconds: durationSeconds,
                ...(data.run ? { runId: data.run } : {}),
                expectedEpoch: effectiveHost?.epoch ?? null,
              },
              onUpdated,
            });
        applyHostStatusObject(status);
      }
      pendingContentionDraftRef.current = null;
      if (!overrideText) setDraft("");
      setLastSent(text || t("resumedDefaultPrompt"));
    } catch (cause) {
      if (isDeviceBusyError(cause)) {
        pendingContentionDraftRef.current = {
          clearDraft: !overrideText,
          feedback: text || t("resumedDefaultPrompt"),
        };
      } else {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      setLocalSubmitting(false);
    }
  };

  const runComposerAction = async (command: RuntimeControlAction, feedbackLabel: string) => {
    if (submitting || !project || !workspace) return;
    setLocalSubmitting(true);
    setError(null);
    setMenuOpen(false);
    setDurationMenuOpen(false);
    try {
      const { status } = sessionActions
        ? await sessionActions.runRuntimeCommand(command)
        : await getLiveSessionEngine(project).runRuntimeCommand({
            workspace,
            run: data.run,
            baseUpdatedAt: data.updatedAt,
            baseServerModel: serverModel,
            command,
            onUpdated,
          });
      applyHostStatusObject(status);
      setLastSent(feedbackLabel);
    } catch (cause) {
      if (!isDeviceBusyError(cause)) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      setLocalSubmitting(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submitMessage();
    }
  };

  const presets: Array<{ label: string; prompt: string; tab: ComposerMode }> = [
    ...(isAuto
      ? []
      : [{ label: t("presetExploreStart"), prompt: t("presetExploreStartPrompt"), tab: "start" as ComposerMode }]),
    { label: t("presetEval"), prompt: t("presetEvalPrompt"), tab: isAuto ? "event" : "start" },
    { label: t("presetAdapt"), prompt: t("presetAdaptPrompt"), tab: isAuto ? "steer" : "event" },
    { label: t("presetMemory"), prompt: t("presetMemoryPrompt"), tab: "event" },
  ];

  const pendingOutboundEvents = useMemo(
    () =>
      (poolSnapshot?.events ?? []).filter(
        item => item.direction === "outbound" && item.status === "pending" && item.id !== replyTarget?.id,
      ),
    [poolSnapshot, replyTarget?.id],
  );

  const durationPresets: Array<{ label: string; seconds: number | null; desc: string }> = [
    { label: `∞ ${t("durationUnbounded")}`, seconds: null, desc: t("durationUnboundedDesc") },
    { label: "15m", seconds: 900, desc: "900s" },
    { label: "30m", seconds: 1800, desc: "1800s" },
    { label: "60m", seconds: 3600, desc: "3600s" },
    { label: "2h", seconds: 7200, desc: "7200s" },
  ];

  const durationPillLabel =
    durationSeconds == null
      ? t("durationUnbounded")
      : durationSeconds % 3600 === 0
        ? `${durationSeconds / 3600}h`
        : durationSeconds % 60 === 0
          ? `${durationSeconds / 60}m`
          : `${durationSeconds}s`;

  const modelShort = shortModelLabel(activeModel, t("deviceOnly"));

  const menuPresence = useAnimatedPresence(Boolean(isLiveRun && menuOpen), 140);
  const durationPresence = useAnimatedPresence(Boolean(isLiveRun && durationMenuOpen), 140);
  const outboundTrayPresence = useAnimatedPresence(
    Boolean(isLiveRun && pendingOutboundEvents.length > 0),
    140,
  );
  const retainedOutboundEventsRef = useRef<PoolEvent[]>([]);
  if (pendingOutboundEvents.length > 0) {
    retainedOutboundEventsRef.current = pendingOutboundEvents;
  }
  const visibleOutboundEvents =
    pendingOutboundEvents.length > 0
      ? pendingOutboundEvents
      : outboundTrayPresence.mounted
        ? retainedOutboundEventsRef.current
        : [];
  const replyBarPresence = useAnimatedPresence(Boolean(isLiveRun && replyTarget), 140);
  const retainedReplyTargetRef = useRef<PoolEvent | null>(null);
  if (replyTarget) {
    retainedReplyTargetRef.current = replyTarget;
  }
  const activeReplyTarget =
    replyTarget ?? (replyBarPresence.mounted ? retainedReplyTargetRef.current : null);

  if (!isLiveRun) {
    return (
      <div ref={composerDockRef} className="codex-composer-wrap" data-shiori-composer="readonly">
        <div className="codex-pill-composer">
          <div className="codex-composer-notice codex-composer-notice-standalone">
            <span>{t("readonlyHint")}</span>
            {onReturnLatest && (
              <button type="button" className="codex-notice-link" onClick={onReturnLatest}>
                {t("returnToLiveBtn")} →
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={composerDockRef} className="codex-composer-wrap" data-shiori-composer={effectiveTab}>
      {menuPresence.mounted && (
        <div
          className="codex-preset-popover"
          data-motion-state={menuPresence.state}
          inert={!menuOpen || undefined}
          role="menu"
        >
          <div className="codex-preset-popover-title">{t("quickPromptsTitle")}</div>
          {presets.map(preset => (
            <button
              key={preset.label}
              type="button"
              role="menuitem"
              className="codex-preset-item"
              onClick={() => {
                setSelectedTab(preset.tab);
                setDraft(preset.prompt);
                setMenuOpen(false);
                textareaRef.current?.focus();
              }}
            >
              <span>{preset.label}</span>
              <small>{preset.prompt}</small>
            </button>
          ))}
          <div className="codex-preset-popover-title mt-1 border-t border-border pt-2">
            {t("dockToolsTitle")}
          </div>
          <button
            type="button"
            role="menuitem"
            className="codex-preset-item"
            disabled={submitting || isAuto || consolidating}
            onClick={() =>
              void runComposerAction(
                {
                  action: "consolidate",
                  runId: data.run,
                  expectedEpoch: effectiveHost?.epoch ?? null,
                },
                t("consolidateBtn"),
              )
            }
          >
            <span>✨ {t("consolidateBtn")}</span>
            <small>{t("consolidateDesc")}</small>
          </button>
        </div>
      )}

      {durationPresence.mounted && (
        <div
          className="codex-preset-popover codex-duration-popover"
          data-motion-state={durationPresence.state}
          inert={!durationMenuOpen || undefined}
          role="menu"
        >
          <div className="codex-preset-popover-title">{t("durationMenuTitle")}</div>
          {durationPresets.map(opt => {
            const active = durationSeconds === opt.seconds;
            return (
              <button
                key={opt.label}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                className="codex-preset-item"
                data-active={active || undefined}
                onClick={() => updateDurationSeconds(opt.seconds)}
              >
                <span>
                  {opt.label}
                  {active ? " ✓" : ""}
                </span>
                <small>{opt.desc}</small>
              </button>
            );
          })}
          <div className="codex-duration-custom">
            <label className="codex-duration-custom-label" htmlFor="shiori-custom-minutes">
              {t("durationCustomLabel")}
            </label>
            <div className="codex-duration-custom-row">
              <input
                id="shiori-custom-minutes"
                type="number"
                min={1}
                max={1440}
                value={customMinutes}
                onChange={event => setCustomMinutes(event.target.value)}
                className="codex-duration-custom-input"
              />
              <button
                type="button"
                className="codex-duration-custom-btn"
                onClick={() => {
                  const mins = Number(customMinutes);
                  if (Number.isFinite(mins) && mins > 0) {
                    updateDurationSeconds(Math.round(mins * 60));
                  }
                }}
              >
                {t("durationCustomApply")}
              </button>
            </div>
          </div>
        </div>
      )}

      {outboundTrayPresence.mounted && visibleOutboundEvents.length > 0 && (
        <div
          className="codex-pool-tray"
          data-event-pool-tray
          data-motion-state={outboundTrayPresence.state}
          inert={pendingOutboundEvents.length === 0 || undefined}
        >
          {visibleOutboundEvents.map(item => {
            const isHelp = item.kind === "help_request";
            return (
              <div
                key={item.id}
                className="codex-pool-tray-card"
                data-kind={item.kind}
                data-pool-outbound-card={item.id}
              >
                <div className="codex-pool-tray-summary">
                  <span className="codex-outbound-badge">
                    {isHelp ? "🆘" : "📌"} {isHelp ? t("poolHelpRequestBadge") : t("poolNoticeBadge")}
                  </span>
                  {item.pauseRequested && (
                    <span className="codex-outbound-paused">{t("poolPausedTag")}</span>
                  )}
                  <span className="codex-pool-tray-inline-text" title={item.text}>
                    {item.title ? (
                      <>
                        <strong className="font-semibold text-foreground">{item.title}</strong>
                        <span className="text-muted-foreground"> · {item.text}</span>
                      </>
                    ) : (
                      item.text
                    )}
                  </span>
                </div>
                <div className="codex-pool-tray-actions">
                  <button
                    type="button"
                    className="codex-pool-btn"
                    data-variant={canResumeFromReply ? undefined : "primary"}
                    disabled={submitting}
                    onClick={() => {
                      setSelectedTab("event");
                      onSelectReplyTarget?.(item, false);
                      textareaRef.current?.focus();
                    }}
                  >
                    <CornerUpLeft className="size-3" aria-hidden="true" />
                    <span>{t("poolReplyBtn")}</span>
                  </button>
                  {canResumeFromReply && (
                    <button
                      type="button"
                      className="codex-pool-btn"
                      data-variant="primary"
                      disabled={submitting}
                      onClick={() => {
                        setSelectedTab("event");
                        if (replyTarget?.id === item.id && draft.trim()) {
                          void submitMessage(undefined, true);
                        } else {
                          onSelectReplyTarget?.(item, true);
                          textareaRef.current?.focus();
                        }
                      }}
                    >
                      <Play className="size-3 fill-current" aria-hidden="true" />
                      <span>{t("poolReplyResumeBtn")}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="codex-pool-btn"
                    data-variant="ghost"
                    title={t("poolDismissBtn")}
                    aria-label={t("poolDismissBtn")}
                    disabled={submitting}
                    onClick={() => void dismissOutboundEvent(item.id)}
                  >
                    <Check className="size-3" aria-hidden="true" />
                    <span>{t("poolDismissBtn")}</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="codex-pill-composer">
        {!isLiveRun && (
          <div className="codex-composer-notice">
            <span>{t("readonlyHint")}</span>
            {onReturnLatest && (
              <button type="button" className="codex-notice-link" onClick={onReturnLatest}>
                {t("returnToLiveBtn")} →
              </button>
            )}
          </div>
        )}

        {replyBarPresence.mounted && activeReplyTarget && (
          <div
            className="codex-reply-context-bar"
            data-reply-context={activeReplyTarget.id}
            data-motion-state={replyBarPresence.state}
            inert={!replyTarget || undefined}
          >
            <div className="codex-reply-context-main">
              <CornerUpLeft className="size-3.5 text-primary shrink-0" aria-hidden="true" />
              <strong className="shrink-0">
                {t("poolReplyingTo").replace(
                  "{kind}",
                  activeReplyTarget.kind === "help_request" ? t("poolHelpRequestBadge") : t("poolNoticeBadge"),
                )}
              </strong>
              <span className="codex-reply-context-quote">
                {activeReplyTarget.title || activeReplyTarget.text}
              </span>
            </div>
            <div className="codex-reply-context-right">
              {canResumeFromReply && (
                <button
                  type="button"
                  className="codex-reply-resume-toggle"
                  data-active={resumeOnReply ? "true" : undefined}
                  aria-pressed={resumeOnReply}
                  onClick={() => setResumeOnReply(prev => !prev)}
                >
                  <Play className="size-2.5 fill-current" aria-hidden="true" />
                  <span>{t("poolAutoResumeToggle")}</span>
                </button>
              )}
              <button
                type="button"
                className="codex-icon-btn !size-5"
                title={t("poolCancelReply")}
                aria-label={t("poolCancelReply")}
                onClick={() => onSelectReplyTarget?.(null)}
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>
        )}

        <textarea
          ref={textareaRef}
          rows={2}
          className="codex-pill-textarea"
          placeholder={
            replyTarget
              ? t("eventReplyPlaceholder")
              : effectiveTab === "start"
                ? t("startPlaceholder")
                : effectiveTab === "steer"
                  ? t("steerPlaceholder")
                  : t("eventPoolPlaceholder")
          }
          value={draft}
          disabled={submitting || (effectiveTab !== "event" && consolidating)}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
        />

        <div className="codex-pill-bar">
          <div className="codex-pill-left">
            <button
              type="button"
              className="codex-icon-btn"
              title={t("quickPromptsTitle")}
              aria-expanded={menuOpen}
              onClick={() => {
                setDurationMenuOpen(false);
                setMenuOpen(prev => !prev);
              }}
            >
              <Plus className="size-4" aria-hidden="true" />
            </button>

            {/* Codex-style Mode Pill */}
            <button
              type="button"
              className="codex-access-pill"
              data-mode={effectiveTab}
              title={isAuto ? t("clickToSwitchModeAuto") : t("clickToSwitchModeManual")}
              onClick={cycleModeTab}
            >
              {effectiveTab === "start" ? (
                <>
                  <RotateCcw className="size-3.5" aria-hidden="true" />
                  <span>{t("modeLaunchLoop")}</span>
                </>
              ) : effectiveTab === "steer" ? (
                <>
                  <Zap className="size-3.5" aria-hidden="true" />
                  <span>{t("deliverySteer")}</span>
                </>
              ) : (
                <>
                  <Inbox className="size-3.5" aria-hidden="true" />
                  <span>{t("deliveryEventPool")}</span>
                </>
              )}
              <ChevronDown className="size-3 opacity-70" aria-hidden="true" />
            </button>

            {/* Optional Pre-Start Takeover Duration Pill (only shown before launching/resuming loop) */}
            {showPreStartDurationPill && (
              <button
                type="button"
                className="codex-subtle-pill codex-duration-pill"
                aria-expanded={durationMenuOpen}
                data-active={durationSeconds != null || undefined}
                title={t("durationPillHint")}
                onClick={() => {
                  setMenuOpen(false);
                  setDurationMenuOpen(prev => !prev);
                }}
              >
                {durationSeconds == null ? (
                  <InfinityIcon className="size-3.5" aria-hidden="true" />
                ) : (
                  <Clock className="size-3.5" aria-hidden="true" />
                )}
                <span>{durationPillLabel}</span>
                <ChevronDown className="size-3 opacity-70" aria-hidden="true" />
              </button>
            )}
          </div>

          <div className="codex-pill-right">
            <button
              type="button"
              className="codex-model-pill"
              data-model-picker-trigger
              data-locked={!canSwitchModel ? "true" : undefined}
              aria-disabled={!canSwitchModel || submitting}
              title={
                canSwitchModel
                  ? `${activeModel ?? t("deviceOnly")} · ${t("modelSwitchHint")}`
                  : t("modelSwitchLockedHint")
              }
              onClick={() => {
                if (submitting) return;
                setMenuOpen(false);
                setDurationMenuOpen(false);
                if (!canSwitchModel) {
                  setError(null);
                  setModelLockNotice(t("modelSwitchLockedHint"));
                  return;
                }
                setModelLockNotice(null);
                setModelPickerOpen(true);
              }}
            >
              <Cpu className="size-3.5 shrink-0 opacity-80" aria-hidden="true" />
              <span className="codex-model-pill-text">{modelShort}</span>
              {activeModel && <ModelEffortBadge effort={activeEffort} compact />}
              {activeModel && <ServiceTierBadge tier={activeServiceTier} iconOnly showStandard />}
              {canSwitchModel ? (
                <ChevronDown className="size-3 shrink-0 opacity-70" aria-hidden="true" />
              ) : (
                <Lock className="size-3 shrink-0 opacity-65" aria-hidden="true" />
              )}
            </button>

            {isAuto && hostOnline && onApplyLiveTimer && (
              <LiveComposerTimerSlot
                spec={liveTimerSpec}
                fallbackRemainingSeconds={liveRemainingSeconds ?? null}
                disabled={submitting}
                onExtendTimer={
                  onExtendLiveTimer
                    ? async (delta, currentRemaining) => {
                        await onExtendLiveTimer(delta, currentRemaining);
                        setLastSent(t("timerExtend15m"));
                      }
                    : undefined
                }
                onApplyTimer={async seconds => {
                  await onApplyLiveTimer(seconds);
                  setLastSent(
                    seconds == null
                      ? t("timerUpdatedUnboundedFeedback")
                      : t("timerUpdatedCountdownFeedback").replace(
                          "{duration}",
                          formatDurationCompact(seconds),
                        ),
                  );
                }}
              />
            )}

            {isAuto && (
              <button
                type="button"
                className="codex-subtle-pill text-destructive"
                disabled={submitting}
                title={t("handbackStop")}
                onClick={() =>
                  void runComposerAction(
                    {
                      action: "auto_off",
                      runId: data.run,
                      expectedEpoch: effectiveHost?.epoch ?? undefined,
                    },
                    t("handbackStop"),
                  )
                }
              >
                <Square className="size-3 fill-current" aria-hidden="true" />
              </button>
            )}

            <button
              type="button"
              className="codex-send-circle"
              disabled={
                submitting ||
                (effectiveTab !== "event" && consolidating) ||
                (effectiveTab !== "start" && !draft.trim())
              }
              title={
                effectiveTab === "steer"
                  ? t("sendSteer")
                  : effectiveTab === "event"
                    ? replyTarget
                      ? resumeOnReply && canResumeFromReply
                        ? t("sendReplyAndResume")
                        : t("sendReply")
                      : t("sendEventPool")
                    : draft.trim()
                      ? t("sendStartWithPrompt")
                      : t("sendResumeLoop")
              }
              onClick={() => void submitMessage()}
            >
              <Play className="size-3.5 fill-current translate-x-[0.5px]" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>

      {error && (
        <p className="codex-composer-feedback codex-composer-feedback-err" role="alert">
          {error}
        </p>
      )}
      {!error && spawningCore && (
        <p className="codex-composer-feedback" role="status" data-live-spawning-core="">
          <RefreshCw className="inline size-3 motion-safe:animate-spin mr-1.5" aria-hidden="true" />
          {t("spawningCoreStatus")}
        </p>
      )}
      {!error && !spawningCore && modelLockNotice && (
        <p className="codex-composer-feedback codex-composer-feedback-warn" role="status">
          <Lock className="inline size-3 -translate-y-[1px] mr-1" aria-hidden="true" />
          {modelLockNotice}
        </p>
      )}
      {!error && !spawningCore && !modelLockNotice && lastSent && (
        <p className="codex-composer-feedback" role="status">
          ✓ {t("sentFeedback")}: <code>{lastSent.length > 72 ? `${lastSent.slice(0, 72)}…` : lastSent}</code>
        </p>
      )}

      <ModelPickerDialog
        open={modelPickerOpen}
        onOpenChange={setModelPickerOpen}
        value={activeModel}
        serviceTier={activeServiceTier}
        effort={activeEffort}
        projectId={project}
        disabled={!canSwitchModel}
        disabledReason={!canSwitchModel ? t("modelSwitchLockedHint") : undefined}
        allowUnauthenticated={false}
        onSelect={handleSelectModel}
      />
    </div>
  );
}

export interface ShioriWorkbenchProps {
  project: string;
  workspace: string | null;
  workspaceTitle?: string;
  runs?: RunInfo[];
  jumpTarget?: {
    value: string;
    call?: string;
    block?: string;
    image?: string;
    seq: number;
  } | null;
  onClearJumpTarget?: () => void;
  onActiveSegmentChange?: (segment: string) => void;
  data: RunData;
  feed: ActivityFeedData;
  isLiveRun: boolean;
  refresh?: boolean;
  phaseLabel?: string | null;
  phaseElapsedMs?: number | null;
  requestedCall?: string;
  selectedImage?: string;
  selectedBlock?: string;
  onSelectBlock?: (block: ActivityBlock) => void;
  onUpdated(): void;
  onRunSpawned?: (runId: string) => void;
  onSwitchWorkspace?: (projectId: string) => void;
  onOpenPerf(): void;
  onOpenCaps(): void;
  onOpenReplay?(): void;
  onOpenReplayAt?: (frame: { run?: string; at?: number; record: string; sequence: number }) => void;
  onReturnLatest(): void;
  renderObservation?: (options: {
    data: RunData;
    call: Call | undefined;
    selectedImage: string | undefined;
    onSelectImage: (id: string) => void;
  }) => ReactNode;
  observationSlot: ReactNode;
  /** Compact RunPicker (quickJump mode) rendered inside .codex-thread-header right actions */
  runPicker?: ReactNode;
  /** Mobile <=680px sidebar drawer trigger rendered at the start of .codex-thread-header */
  mobileNavSlot?: ReactNode;
  /** Col 3 `事件池` tab body (wired to `EventPoolOverviewPanel` by ConsoleShell); falls back to a minimal list. */
  renderEventPoolPanel?: (props: EventPoolOverviewPanelProps) => ReactNode;
}

export function ShioriWorkbench({
  project,
  workspace,
  workspaceTitle,
  runs = [],
  jumpTarget = null,
  onClearJumpTarget,
  onActiveSegmentChange,
  data: rawData,
  feed,
  isLiveRun,
  refresh = true,
  phaseLabel,
  phaseElapsedMs,
  requestedCall,
  selectedImage,
  selectedBlock,
  onSelectBlock,
  onUpdated,
  onRunSpawned,
  onSwitchWorkspace,
  onOpenPerf: _onOpenPerf,
  onOpenCaps: _onOpenCaps,
  onOpenReplay: _onOpenReplay,
  onOpenReplayAt,
  onReturnLatest,
  renderObservation,
  observationSlot,
  runPicker,
  mobileNavSlot,
  renderEventPoolPanel,
}: ShioriWorkbenchProps) {
  const t = useTranslations("shioriCockpit");
  const session = useLiveSession({
    project,
    workspace,
    runs,
    data: rawData,
    feed,
    isLiveRun,
    refresh,
    olderRunLoadFailedText: t("olderRunLoadFailed"),
    onUpdated,
    onRunSpawned,
  });
  const {
    data,
    live,
    statusAnchorMs,
    hostOnline,
    isAuto,
    consolidating,
    thinking,
    activeModel,
    activeServiceTier,
    activeEffort,
    submitting: sessionSubmitting,
    poolSubmitting,
    spawningCore,
    pendingContention,
    preemptError,
    preemptSuccessSeq,
    confirmPreempt,
    dismissContention,
    poolSnapshot,
    poolEventsById,
    resolveLivePoolEvent,
    pendingInboundCount,
    pendingOutboundCount,
    pendingPoolCount,
    olderRuns,
    loadingOlderRun,
    olderRunError,
    hasMoreUpwardHistory,
    earliestLoadedMs,
    segments,
    allCalls,
    loadNextUpwardHistory,
    loadOlderRunSegment,
    clearOlderRunError,
    actions,
  } = session;

  const scrollRafRef = useRef<number | null>(null);
  const lastReportedSegmentRef = useRef("");
  const [showAllSteps, setShowAllSteps] = useState(false);
  const [desktopDockOpen, setDesktopDockOpen] = useState(true);
  const [drawerDockOpen, setDrawerDockOpen] = useState(false);
  const [isOverlayDock, setIsOverlayDock] = useState(false);
  const dockOpen = isOverlayDock ? drawerDockOpen : desktopDockOpen;
  const openDock = useCallback(() => {
    setDesktopDockOpen(true);
    setDrawerDockOpen(true);
  }, []);
  const closeDock = useCallback(() => {
    if (isOverlayDock) setDrawerDockOpen(false);
    else setDesktopDockOpen(false);
  }, [isOverlayDock]);
  const toggleDock = useCallback(() => {
    if (isOverlayDock) setDrawerDockOpen(prev => !prev);
    else setDesktopDockOpen(prev => !prev);
  }, [isOverlayDock]);
  const [dockTab, setDockTab] = useState<"stage" | "pool">("stage");
  const [focusedPoolEventId, setFocusedPoolEventId] = useState<string | null>(null);
  const [pendingPoolLocateEvent, setPendingPoolLocateEvent] = useState<PoolEvent | null>(null);
  const [poolFlashId, setPoolFlashId] = useState<string | null>(null);
  const poolFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openDockOnStage = useCallback(() => {
    setDockTab("stage");
    openDock();
  }, [openDock]);
  const openPoolOverview = useCallback(
    (eventId?: string | null) => {
      setDockTab("pool");
      if (eventId !== undefined) setFocusedPoolEventId(eventId);
      openDock();
    },
    [openDock],
  );
  const togglePoolOverview = useCallback(() => {
    if (dockOpen && dockTab === "pool") {
      closeDock();
      return;
    }
    openPoolOverview();
  }, [dockOpen, dockTab, closeDock, openPoolOverview]);

  const [highlightedSegmentId, setHighlightedSegmentId] = useState<string | null>(null);
  const [inspectedTurn, setInspectedTurn] = useState<{
    runId: string;
    blockId: string;
    callId: string | null;
    imageId: string | null;
    at: string;
  } | null>(null);
  const [workflowCommand, setWorkflowCommand] = useState<{
    mode: ComposerMode;
    prompt: string | null;
  } | null>(null);
  const [replyTarget, setReplyTarget] = useState<PoolEvent | null>(null);
  const [replyAutoResumeDefault, setReplyAutoResumeDefault] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    setHighlightedSegmentId(null);
    setInspectedTurn(null);
    setReplyTarget(null);
    setReplyAutoResumeDefault(undefined);
    setFocusedPoolEventId(null);
    setPendingPoolLocateEvent(null);
    setPoolFlashId(null);
    lastReportedSegmentRef.current = "";
  }, [project]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia("(max-width: 1099px)");
    setIsOverlayDock(mql.matches);
    const handleMediaChange = (event: MediaQueryListEvent) => {
      setIsOverlayDock(event.matches);
      if (event.matches) {
        setDrawerDockOpen(false);
      }
    };
    mql.addEventListener("change", handleMediaChange);
    return () => mql.removeEventListener("change", handleMediaChange);
  }, []);

  useEffect(() => {
    if (!isOverlayDock || !drawerDockOpen) return;
    const handleKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        setDrawerDockOpen(false);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [isOverlayDock, drawerDockOpen]);

  useEffect(() => {
    if (!requestedCall && !selectedImage) return;
    const matchedCall = requestedCall ? data.calls.find(c => c.id === requestedCall) : undefined;
    setInspectedTurn({
      runId: data.run,
      blockId: requestedCall ? `input-call:${requestedCall}` : "url-image",
      callId: matchedCall?.id ?? requestedCall ?? null,
      imageId: selectedImage ?? null,
      at: matchedCall?.at ?? data.updatedAt,
    });
    setDockTab("stage");
    setDesktopDockOpen(true);
    setDrawerDockOpen(true);
  }, [requestedCall, selectedImage, data.run, data.calls, data.updatedAt]);

  const canMutatePool = Boolean(isLiveRun && project && workspace);
  const canResumeAuto = !isAuto && !consolidating;
  const lastJumpedSeqRef = useRef<number | null>(null);

  const reportActiveSegment = useCallback(
    (nextSegment: string) => {
      if (!onActiveSegmentChange || lastReportedSegmentRef.current === nextSegment) return;
      lastReportedSegmentRef.current = nextSegment;
      onActiveSegmentChange(nextSegment);
    },
    [onActiveSegmentChange],
  );

  const poolLatestSeq = useMemo(
    () => (poolSnapshot?.events ?? []).reduce((max, item) => Math.max(max, item.seq), 0),
    [poolSnapshot?.events],
  );

  const handleReachedBottom = useCallback(() => {
    reportActiveSegment("");
  }, [reportActiveSegment]);

  const followingStateMirrorRef = useRef(true);

  const handleScrolledAwayFromBottom = useCallback(
    (el: HTMLDivElement) => {
      if (!onActiveSegmentChange || scrollRafRef.current != null) return;
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = null;
        if (!el.isConnected || followingStateMirrorRef.current) return;
        const containerTop = el.getBoundingClientRect().top;
        const dividers = el.querySelectorAll<HTMLElement>("[data-session-divider]");
        let currentAnchor: HTMLElement | null = null;
        for (const div of dividers) {
          if (div.getBoundingClientRect().top <= containerTop + 96) {
            currentAnchor = div;
          } else {
            break;
          }
        }
        if (!currentAnchor && dividers.length > 0) {
          currentAnchor = dividers[0];
        }
        if (currentAnchor) {
          const divRunId = currentAnchor.dataset.runId ?? "";
          const divEpoch = currentAnchor.dataset.epoch ?? "";
          if (divRunId && divRunId !== data.run) {
            reportActiveSegment(divRunId);
          } else if (divRunId === data.run && data.cycles.length > 1 && divEpoch) {
            const isLatestCycle = data.cycles.at(-1)?.epoch === divEpoch;
            reportActiveSegment(isLatestCycle ? "" : `${divRunId}#${divEpoch}`);
          } else {
            reportActiveSegment("");
          }
        }
      });
    },
    [data.run, data.cycles, onActiveSegmentChange, reportActiveSegment],
  );

  const upwardHistoryGateRef = useRef<() => void>(() => {});

  const {
    streamRef,
    contentRef,
    isFollowing,
    unreadCount,
    isJumpingRef,
    prependScrollAnchorRef,
    capturePrependAnchor,
    markProgrammaticScroll,
    scrollToBottom: rawScrollToBottom,
    pauseFollow,
    toggleFollow,
    scrollContainerProps,
  } = useLiveAutoScroll({
    project,
    run: data.run,
    blocks: feed.blocks,
    segments,
    olderRunsCount: olderRuns.length,
    loadingOlder: feed.loadingOlder,
    loadingOlderRun,
    historical: feed.historical,
    loading: feed.loading,
    poolLatestSeq,
    thinking,
    consolidating,
    onNearTopScrollUp: () => upwardHistoryGateRef.current(),
    onReachedBottom: handleReachedBottom,
    onScrolledAwayFromBottom: handleScrolledAwayFromBottom,
  });
  followingStateMirrorRef.current = isFollowing;

  const triggerUpwardHistory = useCallback(() => {
    if (isJumpingRef.current) return;
    loadNextUpwardHistory(capturePrependAnchor);
  }, [loadNextUpwardHistory, capturePrependAnchor, isJumpingRef]);

  upwardHistoryGateRef.current = () => {
    if (!olderRunError && hasMoreUpwardHistory) {
      triggerUpwardHistory();
    }
  };

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = prefersSmoothScrollBehavior()) => {
      rawScrollToBottom({
        behavior,
        onBeforeScroll: () => {
          if (feed.historical) {
            feed.latest();
          }
          onClearJumpTarget?.();
        },
      });
    },
    [feed, onClearJumpTarget, rawScrollToBottom],
  );

  const flashPoolEvent = useCallback((eventId: string) => {
    setPoolFlashId(eventId);
    if (poolFlashTimerRef.current) clearTimeout(poolFlashTimerRef.current);
    poolFlashTimerRef.current = setTimeout(() => {
      setPoolFlashId(prev => (prev === eventId ? null : prev));
    }, 2400);
  }, []);

  const scrollToPoolEvent = useCallback(
    (eventId: string): boolean => {
      const container = streamRef.current;
      if (!container) return false;
      const targetEl = container.querySelector<HTMLElement>(`[data-pool-event-id="${CSS.escape(eventId)}"]`);
      if (!targetEl) return false;
      markProgrammaticScroll(900);
      pauseFollow({ manualHold: false });
      const top =
        container.scrollTop + (targetEl.getBoundingClientRect().top - container.getBoundingClientRect().top) - 72;
      container.scrollTo({ top: Math.max(0, top), behavior: prefersSmoothScrollBehavior() });
      flashPoolEvent(eventId);
      return true;
    },
    [flashPoolEvent, markProgrammaticScroll, pauseFollow, streamRef],
  );

  const poolLocateContextRef = useRef({
    isOverlayDock,
    hasMoreUpwardHistory,
    earliestLoadedMs,
  });
  poolLocateContextRef.current = {
    isOverlayDock,
    hasMoreUpwardHistory,
    earliestLoadedMs,
  };

  const locatePoolEventInStream = useCallback(
    (event: PoolEvent) => {
      const ctx = poolLocateContextRef.current;
      if (ctx.isOverlayDock) setDrawerDockOpen(false);
      if (scrollToPoolEvent(event.id)) {
        setPendingPoolLocateEvent(null);
        return;
      }
      const createdMs = Date.parse(event.createdAt);
      if (ctx.hasMoreUpwardHistory && (!Number.isFinite(ctx.earliestLoadedMs) || !(createdMs >= ctx.earliestLoadedMs))) {
        setPendingPoolLocateEvent(event);
        return;
      }
      requestAnimationFrame(() => {
        scrollToPoolEvent(event.id);
      });
    },
    [scrollToPoolEvent],
  );

  // Page upward history until a requested Event Pool item enters the loaded stream window.
  useEffect(() => {
    if (!pendingPoolLocateEvent) return;
    if (scrollToPoolEvent(pendingPoolLocateEvent.id)) {
      setPendingPoolLocateEvent(null);
      return;
    }
    if (!hasMoreUpwardHistory || olderRunError) {
      setPendingPoolLocateEvent(null);
      return;
    }
    triggerUpwardHistory();
  }, [
    pendingPoolLocateEvent,
    segments.length,
    hasMoreUpwardHistory,
    feed.loadingOlder,
    loadingOlderRun,
    olderRunError,
    scrollToPoolEvent,
    triggerUpwardHistory,
  ]);

  useEffect(
    () => () => {
      if (poolFlashTimerRef.current) clearTimeout(poolFlashTimerRef.current);
      if (scrollRafRef.current != null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(scrollRafRef.current);
      }
    },
    [],
  );

  const ackPoolEvent = useCallback(
    async (eventId: string) => {
      if (!project || !workspace) return;
      try {
        await actions.ackPoolEvent(eventId);
        setReplyTarget(prev => (prev?.id === eventId ? null : prev));
      } catch {
        // Optimistic rollback & snapshot polling surface authoritative state; keep non-fatal.
      }
    },
    [project, workspace, actions],
  );

  const eventPoolPanelProps: EventPoolOverviewPanelProps = {
    snapshot: poolSnapshot,
    pendingInboundCount,
    pendingOutboundCount,
    canMutate: canMutatePool,
    canResumeAuto,
    submitting: poolSubmitting,
    focusedEventId: focusedPoolEventId,
    onFocusEvent: setFocusedPoolEventId,
    onComposeNewEvent: () => {
      if (isOverlayDock) setDrawerDockOpen(false);
      setWorkflowCommand({ mode: "event", prompt: null });
    },
    onReply: (event, resumeAuto) => {
      if (isOverlayDock) setDrawerDockOpen(false);
      setReplyTarget(event);
      setReplyAutoResumeDefault(resumeAuto);
    },
    onAck: ackPoolEvent,
    onWithdraw: ackPoolEvent,
    onLocateInStream: locatePoolEventInStream,
  };

  // Auto-fill preceding run history when viewport has spare room so sessions form one continuous stream
  useEffect(() => {
    if (feed.loading || feed.loadingOlder || loadingOlderRun || olderRunError || isJumpingRef.current) {
      return;
    }
    if (!hasMoreUpwardHistory) return;
    const el = streamRef.current;
    if (!el) return;
    if (el.scrollHeight <= el.clientHeight + 140) {
      triggerUpwardHistory();
    }
  }, [
    segments.length,
    feed.loading,
    feed.loadingOlder,
    loadingOlderRun,
    olderRunError,
    hasMoreUpwardHistory,
    triggerUpwardHistory,
  ]);

  // Handle Quick-Jump Segment selection from top-right RunPicker or deep-link without page reload
  useEffect(() => {
    if (!jumpTarget || lastJumpedSeqRef.current === jumpTarget.seq) return;
    if (!jumpTarget.value) {
      lastJumpedSeqRef.current = jumpTarget.seq;
      scrollToBottom();
      return;
    }
    isJumpingRef.current = true;
    markProgrammaticScroll(1800);
    pauseFollow({ manualHold: false });

    const [targetRunId, targetEpoch] = jumpTarget.value.split("#");
    const runAlreadyLoaded =
      !targetRunId ||
      targetRunId === data.run ||
      olderRuns.some(r => r.runId === targetRunId);

    if (!runAlreadyLoaded) {
      if (!loadingOlderRun) {
        prependScrollAnchorRef.current = null;
        void loadOlderRunSegment(targetRunId, {
          evidence:
            jumpTarget.call || jumpTarget.image
              ? { targetRunId, call: jumpTarget.call, image: jumpTarget.image }
              : undefined,
        });
      }
      return;
    }

    if (
      targetRunId === data.run &&
      targetEpoch &&
      feed.hasMore &&
      !feed.blocks.some(b => b.trace?.epoch === targetEpoch)
    ) {
      if (!feed.loadingOlder) {
        void feed.earlier();
      }
      return;
    }

    const container = streamRef.current;
    if (!container) return;

    let targetEl: HTMLElement | null = null;
    if (jumpTarget.call) {
      targetEl = container.querySelector<HTMLElement>(`[data-call-id="${CSS.escape(jumpTarget.call)}"]`);
    }
    if (!targetEl && jumpTarget.block) {
      targetEl = container.querySelector<HTMLElement>(`#${CSS.escape(jumpTarget.block)}`);
    }
    if (!targetEl && targetEpoch) {
      targetEl = container.querySelector<HTMLElement>(
        `[data-segment-anchor="${CSS.escape(`${targetRunId}#${targetEpoch}`)}"]`,
      );
    }
    if (!targetEl && targetRunId) {
      targetEl = container.querySelector<HTMLElement>(`[data-run-id="${CSS.escape(targetRunId)}"]`);
    }

    if (targetEl) {
      lastJumpedSeqRef.current = jumpTarget.seq;
      reportActiveSegment(jumpTarget.value);
      if (jumpTarget.call || jumpTarget.image) {
        const ownerData =
          targetRunId === data.run
            ? data
            : (olderRuns.find(r => r.runId === targetRunId)?.data ?? data);
        const matchedCall = jumpTarget.call
          ? (ownerData.selectedCall?.id === jumpTarget.call ? ownerData.selectedCall : undefined) ??
            ownerData.calls.find(c => c.id === jumpTarget.call)
          : undefined;
        setInspectedTurn({
          runId: targetRunId || data.run,
          blockId: jumpTarget.call ? `input-call:${jumpTarget.call}` : "jump-image",
          callId: matchedCall?.id ?? jumpTarget.call ?? null,
          imageId: jumpTarget.image ?? null,
          at: matchedCall?.at ?? ownerData.updatedAt,
        });
        openDockOnStage();
      }

      const rawTargetTop = Math.max(
        0,
        container.scrollTop +
          (targetEl.getBoundingClientRect().top - container.getBoundingClientRect().top) -
          16,
      );
      const distance = Math.abs(rawTargetTop - container.scrollTop);
      if (distance > 2200) {
        const approachOffset = rawTargetTop < container.scrollTop ? 540 : -540;
        container.scrollTop = Math.max(0, rawTargetTop + approachOffset);
        requestAnimationFrame(() => {
          const refinedTop = Math.max(
            0,
            container.scrollTop +
              (targetEl!.getBoundingClientRect().top - container.getBoundingClientRect().top) -
              16,
          );
          container.scrollTo({ top: refinedTop, behavior: prefersSmoothScrollBehavior() });
        });
      } else {
        container.scrollTo({ top: rawTargetTop, behavior: prefersSmoothScrollBehavior() });
      }

      const highlightId =
        targetEl.dataset.sessionDivider !== undefined
          ? targetEl.id
          : container.querySelector<HTMLElement>(
              targetEpoch
                ? `[data-segment-anchor="${CSS.escape(`${targetRunId}#${targetEpoch}`)}"]`
                : `[data-run-id="${CSS.escape(targetRunId)}"]`,
            )?.id ?? null;
      if (highlightId) {
        setHighlightedSegmentId(highlightId);
        setTimeout(() => {
          setHighlightedSegmentId(prev => (prev === highlightId ? null : prev));
        }, 2400);
      }
      setTimeout(() => {
        isJumpingRef.current = false;
      }, 650);
    } else if (!olderRunError) {
      lastJumpedSeqRef.current = jumpTarget.seq;
      isJumpingRef.current = false;
    }
  }, [
    jumpTarget?.seq,
    jumpTarget?.value,
    jumpTarget?.call,
    jumpTarget?.block,
    jumpTarget?.image,
    segments.length,
    data,
    olderRuns,
    loadingOlderRun,
    olderRunError,
    feed,
    loadOlderRunSegment,
    markProgrammaticScroll,
    openDockOnStage,
    pauseFollow,
    prependScrollAnchorRef,
    reportActiveSegment,
    scrollToBottom,
    streamRef,
    isJumpingRef,
  ]);

  const inspectContextRef = useRef({
    data,
    olderRuns,
    allCalls,
    inspectedTurn,
    onSelectBlock,
  });
  inspectContextRef.current = {
    data,
    olderRuns,
    allCalls,
    inspectedTurn,
    onSelectBlock,
  };

  const handleInspectBlock = useCallback(
    (runId: string, block: ActivityBlock, siblingSteps: ActivityBlock[] = []) => {
      const ctx = inspectContextRef.current;
      const ownerCalls =
        runId === ctx.data.run
          ? ctx.data.calls
          : (ctx.olderRuns.find(r => r.runId === runId)?.data.calls ?? ctx.allCalls);
      const matchedCall = resolveCallForTurn(block, siblingSteps, ownerCalls);
      const isDeselecting = ctx.inspectedTurn?.blockId === block.id;
      setInspectedTurn(
        isDeselecting
          ? null
          : {
              runId,
              blockId: block.id,
              callId: matchedCall?.id ?? null,
              imageId: null,
              at: block.at,
            },
      );
      if (!isDeselecting) openDockOnStage();
      ctx.onSelectBlock?.(block);
    },
    [openDockOnStage],
  );

  const handleInspectInput = useCallback(
    (runId: string, segId: string, call?: Call, imageId?: string, at?: string) => {
      const ctx = inspectContextRef.current;
      const isDeselecting =
        ctx.inspectedTurn?.blockId === segId && ctx.inspectedTurn?.imageId === (imageId ?? null);
      setInspectedTurn(
        isDeselecting
          ? null
          : {
              runId,
              blockId: segId,
              callId: call?.id ?? null,
              imageId: imageId ?? null,
              at: at ?? call?.at ?? ctx.data.updatedAt,
            },
      );
      if (!isDeselecting) openDockOnStage();
    },
    [openDockOnStage],
  );

  const inspectedRunData =
    inspectedTurn && inspectedTurn.runId !== data.run
      ? (olderRuns.find(r => r.runId === inspectedTurn.runId)?.data ?? data)
      : data;
  const inspectedCall = inspectedTurn?.callId
    ? (inspectedRunData.selectedCall?.id === inspectedTurn.callId
        ? inspectedRunData.selectedCall
        : undefined) ??
      inspectedRunData.calls.find(c => c.id === inspectedTurn.callId) ??
      allCalls.find(c => c.id === inspectedTurn.callId)
    : undefined;
  const activeBlockId = inspectedTurn?.blockId ?? selectedBlock ?? jumpTarget?.block;

  const summary = data.summary;
  const latestCycle = data.cycles.at(-1);
  const activeMaxSeconds =
    isAuto && live && "maxSeconds" in live
      ? (live.maxSeconds ?? null)
      : latestCycle && "maxSeconds" in latestCycle
        ? (latestCycle.maxSeconds ?? null)
        : (data.manifest.seconds ?? null);
  const elapsedSeconds = summary?.elapsedSeconds ?? 0;
  const latestCycleDurationSeconds =
    latestCycle?.startedAt && latestCycle?.endedAt
      ? Math.max(0, Math.round((Date.parse(latestCycle.endedAt) - Date.parse(latestCycle.startedAt)) / 1000))
      : null;
  const baseCycleElapsed =
    isAuto && activeMaxSeconds != null && typeof live?.remainingSeconds === "number"
      ? Math.max(0, activeMaxSeconds - live.remainingSeconds)
      : isAuto && latestCycle?.startedAt && Number.isFinite(Date.parse(latestCycle.startedAt))
        ? Math.max(0, Math.floor((statusAnchorMs - Date.parse(latestCycle.startedAt)) / 1000))
        : (latestCycleDurationSeconds ?? elapsedSeconds);
  const rawRemainingSeconds = typeof live?.remainingSeconds === "number" ? live.remainingSeconds : null;
  const timerTickEnabled = Boolean(isLiveRun && isAuto && refresh);

  const liveTimerSpec = useMemo<LiveTimerSpec>(
    () => ({
      tickEnabled: timerTickEnabled,
      statusAnchorMs,
      activeMaxSeconds,
      baseCycleElapsed,
      rawRemainingSeconds,
    }),
    [timerTickEnabled, statusAnchorMs, activeMaxSeconds, baseCycleElapsed, rawRemainingSeconds],
  );

  const applyLiveStopTimer = useCallback(
    async (seconds: number | null) => {
      if (!project || !workspace) return;
      await actions.setAutoStopTimer(seconds);
    },
    [project, workspace, actions],
  );

  const extendLiveStopTimer = useCallback(
    async (deltaSeconds: number, currentRemainingSeconds = 0) => {
      if (!project || !workspace) return;
      await actions.extendAutoStopTimer(deltaSeconds, currentRemainingSeconds);
    },
    [project, workspace, actions],
  );

  const workspaceService = useWorkspaceService({
    workspaceId: isLiveRun ? project : null,
    fallbackError: t("hostStartFailedTitle"),
    onSuccess: result => {
      if (result.operation === "up" || result.operation === "reload") {
        onReturnLatest();
      }
      onUpdated();
    },
  });

  const handleSwitchToHolder = useCallback(
    (holderProjectId: string) => {
      if (onSwitchWorkspace) {
        onSwitchWorkspace(holderProjectId);
        return;
      }
      if (typeof window === "undefined") return;
      const next = `/?view=live&project=${encodeURIComponent(holderProjectId)}`;
      if (next === window.location.pathname + window.location.search) return;
      window.history.pushState(null, "", next);
      window.dispatchEvent(new PopStateEvent("popstate"));
    },
    [onSwitchWorkspace],
  );

  const isSpawningCore = Boolean(spawningCore || workspaceService.pendingOperation === "up");
  const stateTitle = !isLiveRun
    ? t("stateSnapshot")
    : isSpawningCore
      ? t("spawningCoreStatus")
      : !hostOnline
        ? t("stateCoreOffline")
        : consolidating
          ? t("stateConsolidating")
          : isAuto
            ? thinking
              ? t("stateAutoThinking")
              : t("stateAutoIdle")
            : t("stateManual");
  const statePillTitle =
    hostOnline && live?.launchedBy
      ? `${stateTitle} · ${t(live.launchedBy === "cli" ? "coreOriginCli" : "coreOriginApp")}`
      : stateTitle;

  const runScopeKey = `${project}/${data.run}`;
  const seenSegmentsScopeRef = useRef<string>("");
  const seenSegmentsInitializedRef = useRef(false);
  const seenSegmentIdsRef = useRef<Set<string>>(new Set());
  const enteringSegmentIdsRef = useRef<Set<string>>(new Set());

  const sameRunScope = seenSegmentsScopeRef.current === runScopeKey;
  const canDetectStreamEntries = sameRunScope && seenSegmentsInitializedRef.current;
  let lastSeenSegmentIdx = -1;
  if (canDetectStreamEntries) {
    for (let i = segments.length - 1; i >= 0; i--) {
      if (seenSegmentIdsRef.current.has(segments[i]!.id)) {
        lastSeenSegmentIdx = i;
        break;
      }
    }
  }
  const isSegmentStreamEntering = (segId: string, segIdx: number): boolean => {
    if (!canDetectStreamEntries) return false;
    if (enteringSegmentIdsRef.current.has(segId)) return true;
    if (seenSegmentIdsRef.current.has(segId)) return false;
    if (lastSeenSegmentIdx >= 0) {
      return segIdx > lastSeenSegmentIdx;
    }
    return !feed.historical && segments.length <= 3;
  };

  useEffect(() => {
    if (seenSegmentsScopeRef.current !== runScopeKey) {
      seenSegmentsScopeRef.current = runScopeKey;
      seenSegmentsInitializedRef.current = !feed.loading || segments.length > 0;
      seenSegmentIdsRef.current = new Set(segments.map(seg => seg.id));
      enteringSegmentIdsRef.current = new Set();
      return;
    }
    if (!seenSegmentsInitializedRef.current) {
      if (!feed.loading || segments.length > 0) {
        seenSegmentsInitializedRef.current = true;
        for (const seg of segments) {
          seenSegmentIdsRef.current.add(seg.id);
        }
      }
      return;
    }
    let lastSeenIdx = -1;
    for (let i = segments.length - 1; i >= 0; i--) {
      if (seenSegmentIdsRef.current.has(segments[i]!.id)) {
        lastSeenIdx = i;
        break;
      }
    }
    for (let i = 0; i < segments.length; i++) {
      const segId = segments[i]!.id;
      if (seenSegmentIdsRef.current.has(segId)) continue;
      const enteredLive =
        lastSeenIdx >= 0
          ? i > lastSeenIdx
          : !feed.historical && segments.length <= 3;
      if (enteredLive) {
        enteringSegmentIdsRef.current.add(segId);
      }
      seenSegmentIdsRef.current.add(segId);
    }
  }, [runScopeKey, segments, feed.loading, feed.historical]);

  const hasServiceError = Boolean(isLiveRun && project && workspaceService.error);
  const serviceErrorPresence = useAnimatedPresence(hasServiceError, 140);
  const retainedServiceErrorRef = useRef<string | null>(null);
  if (hasServiceError && workspaceService.error) {
    retainedServiceErrorRef.current = workspaceService.error;
  }
  const displayedServiceError =
    workspaceService.error ?? (serviceErrorPresence.mounted ? retainedServiceErrorRef.current : null);

  const showJumpLocateToast = Boolean(
    jumpTarget && lastJumpedSeqRef.current !== jumpTarget.seq && jumpTarget.value && loadingOlderRun,
  );
  const jumpToastPresence = useAnimatedPresence(showJumpLocateToast, 140);

  const poolToastPresence = useAnimatedPresence(Boolean(pendingPoolLocateEvent), 140);
  const retainedPoolLocateRef = useRef<PoolEvent | null>(null);
  if (pendingPoolLocateEvent) {
    retainedPoolLocateRef.current = pendingPoolLocateEvent;
  }
  const displayedPoolLocate =
    pendingPoolLocateEvent ?? (poolToastPresence.mounted ? retainedPoolLocateRef.current : null);

  const showFollowPill = !isFollowing || feed.historical;
  const followPillPresence = useAnimatedPresence(showFollowPill, 140);
  const backdropPresence = useAnimatedPresence(dockOpen && isOverlayDock, 180);

  return (
    <div className="codex-workbench" data-dock-open={dockOpen || undefined}>
      {/* ── LEFT / CENTER MAIN PANE: CODEX CHAT STREAM + FLOATING PILL COMPOSER ── */}
      <section className="codex-chat-pane" aria-label={t("ariaLabel")}>
        {/* 1-Line Clean Thread Header (just like ChatGPT/Codex desktop window bar) */}
        <header className="codex-thread-header codex-cockpit-header">
          <div className="codex-thread-title">
            {mobileNavSlot}
            <FileText className="codex-thread-doc-icon size-4 text-muted-foreground shrink-0" aria-hidden="true" />
            <strong className="codex-thread-heading" title={`Shiori · ${workspaceTitle || project}`}>
              <span className="codex-thread-brand">Shiori</span>
              <span className="codex-thread-workspace"> · {workspaceTitle || project}</span>
            </strong>
            <span
              className="codex-status-pill"
              data-tone={isAuto && hostOnline ? "auto" : hostOnline ? "manual" : "standby"}
              data-spawning-core={isSpawningCore ? "true" : undefined}
              title={statePillTitle}
            >
              <PixelMark
                size={14}
                className="codex-status-mark"
                state={!isLiveRun ? "idle" : isSpawningCore || consolidating || (isAuto && thinking) ? "reasoning" : !hostOnline ? "waiting" : "idle"}
                filled={hostOnline && !isAuto}
              />
              <span className="codex-status-text">{stateTitle}</span>
            </span>
            {phaseLabel && (
              <LivePhaseInlineBadge
                phaseLabel={phaseLabel}
                phaseElapsedMs={phaseElapsedMs}
                tickEnabled={timerTickEnabled}
                statusAnchorMs={statusAnchorMs}
              />
            )}
          </div>

          <div className="codex-thread-actions">
            {runPicker && <div className="codex-thread-run-picker">{runPicker}</div>}
            <button
              type="button"
              className="codex-header-btn codex-follow-toggle-btn"
              data-live-follow-toggle=""
              data-active={(isFollowing && !feed.historical) || undefined}
              data-paused={(!isFollowing || feed.historical) || undefined}
              aria-pressed={isFollowing && !feed.historical}
              title={
                isFollowing && !feed.historical
                  ? t("autoFollowOnHint")
                  : t("autoFollowPausedHint")
              }
              aria-label={
                isFollowing && !feed.historical
                  ? t("autoFollowOnHint")
                  : t("autoFollowPausedHint")
              }
              onClick={() =>
                toggleFollow(() => {
                  if (feed.historical) feed.latest();
                  onClearJumpTarget?.();
                })
              }
            >
              <ArrowDownToLine className="size-3.5 shrink-0" aria-hidden="true" />
              {(!isFollowing || feed.historical) && unreadCount > 0 && (
                <span className="codex-follow-unread-count">
                  {unreadCount > 99 ? "99+" : unreadCount}
                </span>
              )}
              <span className="codex-follow-toggle-label">
                {isFollowing && !feed.historical ? t("autoFollowOn") : t("autoFollowPaused")}
              </span>
            </button>
            <button
              type="button"
              className="codex-header-btn codex-expand-all-btn"
              data-active={showAllSteps || undefined}
              title={showAllSteps ? t("collapseStepsBtn") : t("expandAllStepsBtn")}
              aria-label={showAllSteps ? t("collapseStepsBtn") : t("expandAllStepsBtn")}
              onClick={() => setShowAllSteps(prev => !prev)}
            >
              <ChevronsUpDown className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="codex-expand-all-label">
                {showAllSteps ? t("collapseStepsBtn") : t("expandAllStepsBtn")}
              </span>
            </button>
            <button
              type="button"
              className="codex-header-btn codex-pool-trigger-btn"
              data-tone={pendingOutboundCount > 0 ? "outbound" : pendingInboundCount > 0 ? "inbound" : undefined}
              data-active={(dockOpen && dockTab === "pool") || undefined}
              aria-pressed={dockOpen && dockTab === "pool"}
              title={t("poolHeaderTriggerHint")}
              aria-label={t("poolHeaderTriggerHint")}
              onClick={togglePoolOverview}
            >
              {pendingOutboundCount > 0 ? (
                <span className="codex-pool-trigger-icon" aria-hidden="true">🆘</span>
              ) : (
                <Inbox className="size-3.5 shrink-0" aria-hidden="true" />
              )}
              {pendingPoolCount > 0 && <span className="codex-pool-trigger-count">{pendingPoolCount}</span>}
              <span className="codex-pool-trigger-label">{t("poolHeaderTrigger")}</span>
            </button>
            <button
              type="button"
              className="codex-header-btn codex-dock-toggle-btn"
              data-active={dockOpen || undefined}
              aria-pressed={dockOpen}
              title={t("toggleDockHint")}
              aria-label={t("toggleDockHint")}
              onClick={toggleDock}
            >
              <PanelRight className="size-4" aria-hidden="true" />
            </button>
          </div>
        </header>

        {/* Workspace Service Error Alert (Codex-style clean header when Core is idle/offline without errors) */}
        {serviceErrorPresence.mounted && displayedServiceError && (
          <div
            className="codex-host-offline-bar"
            data-has-error="true"
            data-motion-state={serviceErrorPresence.state}
            inert={!hasServiceError || undefined}
          >
            <div className="codex-host-offline-error" role="alert" data-live-service-error="">
              <div className="codex-host-offline-error-head">
                <div className="codex-host-offline-error-title">
                  <AlertCircle className="size-3.5 shrink-0" aria-hidden="true" />
                  <strong>{t("hostStartFailedTitle")}</strong>
                  <span className="codex-host-offline-error-hint">{t("hostStartFailedHint")}</span>
                </div>
                <button
                  type="button"
                  className="codex-host-error-dismiss"
                  aria-label={t("dismissServiceError")}
                  title={t("dismissServiceError")}
                  onClick={workspaceService.clearError}
                >
                  <X className="size-3.5" aria-hidden="true" />
                </button>
              </div>
              <pre className="codex-host-offline-error-pre">{displayedServiceError}</pre>
            </div>
          </div>
        )}

        {/* Scrollable Chat Stream + Safely Anchored Scroll-to-Bottom Button */}
        <div className="codex-chat-scroll-stage">
          {jumpToastPresence.mounted && (
            <div className="codex-jump-toast" data-motion-state={jumpToastPresence.state} role="status">
              <span className="codex-thinking-dot" />
              <span>{t("locatingSegmentBanner")}</span>
            </div>
          )}
          {poolToastPresence.mounted && displayedPoolLocate && (
            <div
              className="codex-jump-toast"
              data-motion-state={poolToastPresence.state}
              role="status"
              data-pool-locating={displayedPoolLocate.id}
            >
              <span className="codex-thinking-dot" />
              <span>{t("locatingPoolEventBanner").replace("{seq}", String(displayedPoolLocate.seq))}</span>
            </div>
          )}
          <div ref={streamRef} className="codex-chat-scroll" {...scrollContainerProps}>
          <div ref={contentRef} className="codex-chat-column">
            {(feed.loadingOlder || loadingOlderRun || olderRunError) ? (
              <div className="codex-load-older">
                {olderRunError && !feed.loadingOlder && !loadingOlderRun ? (
                  <button
                    type="button"
                    className="codex-step-group-toggle"
                    onClick={() => {
                      clearOlderRunError();
                      triggerUpwardHistory();
                    }}
                  >
                    <span>
                      {t("olderRunLoadFailed")}: {olderRunError} · {t("retryOlderRun")}
                    </span>
                    <ChevronRight className="size-3.5" aria-hidden="true" />
                  </button>
                ) : (
                  <div className="codex-history-status" role="status">
                    <span className="codex-thinking-dot" />
                    <span>{t("loadingOlder")}</span>
                  </div>
                )}
              </div>
            ) : (
              !hasMoreUpwardHistory &&
              (olderRuns.length > 0 || segments.length > 6) && (
                <div className="codex-history-origin">
                  <span>{t("sessionBeginningReached")}</span>
                </div>
              )
            )}

            {segments.length === 0 ? (
              feed.loading ? (
                <div className="codex-load-older">
                  <div className="codex-history-status" role="status">
                    <span className="codex-thinking-dot" />
                    <span>{t("loadingOlder")}</span>
                  </div>
                </div>
              ) : (
                <div className="codex-empty-thread">
                  <Bot className="size-8 text-muted-foreground/60" aria-hidden="true" />
                  <h3>{t("emptyThreadTitle")}</h3>
                  <p>{t("emptyThreadDesc")}</p>
                  <div className="codex-starter-chips">
                    <button
                      type="button"
                      className="codex-starter-chip"
                      onClick={() =>
                        setWorkflowCommand({
                          mode: !isAuto && !consolidating ? "start" : "steer",
                          prompt: t("presetExploreStartPrompt"),
                        })
                      }
                    >
                      {t("presetExploreStart")}
                    </button>
                    <button
                      type="button"
                      className="codex-starter-chip"
                      onClick={() =>
                        setWorkflowCommand({
                          mode: !isAuto && !consolidating ? "start" : "steer",
                          prompt: t("presetEvalPrompt"),
                        })
                      }
                    >
                      {t("presetEval")}
                    </button>
                    <button
                      type="button"
                      className="codex-starter-chip"
                      onClick={() =>
                        setWorkflowCommand({
                          mode: !isAuto && !consolidating ? "start" : "steer",
                          prompt: t("presetAdaptPrompt"),
                        })
                      }
                    >
                      {t("presetAdapt")}
                    </button>
                  </div>
                </div>
              )
            ) : (
              segments.map((seg, segIdx) => {
                const streamEnter = isSegmentStreamEntering(seg.id, segIdx);
                if (seg.kind === "session_divider") {
                  return (
                    <CodexSessionDivider
                      key={seg.id}
                      segment={seg}
                      highlighted={highlightedSegmentId === seg.id}
                      streamEnter={streamEnter}
                    />
                  );
                }

                if (seg.kind === "user") {
                  const livePoolItem = seg.poolEvent ? resolveLivePoolEvent(seg.poolEvent) : undefined;
                  const isReply = livePoolItem?.kind === "reply";
                  const isRead = livePoolItem?.status === "handled";
                  const isWithdrawn = isRead && livePoolItem?.handledBy === "human";
                  const seqTag = livePoolItem ? ` · #${livePoolItem.seq}` : "";
                  return (
                    <article
                      key={seg.id}
                      id={seg.block.id}
                      className={`codex-turn-user${livePoolItem && poolFlashId === livePoolItem.id ? " is-pool-target-flash" : ""}`}
                      data-pool-event-id={livePoolItem?.id}
                      data-pool-seq={livePoolItem?.seq}
                      data-stream-enter={streamEnter ? "true" : undefined}
                    >
                      <div className="codex-user-bubble" data-mode={seg.mode} data-withdrawn={isWithdrawn || undefined}>
                        {seg.mode !== "start" &&
                          (livePoolItem ? (
                            <button
                              type="button"
                              className="codex-user-mode-tag codex-pool-seq-link"
                              title={t("poolOpenInOverviewHint").replace("{seq}", String(livePoolItem.seq))}
                              onClick={() => openPoolOverview(livePoolItem.id)}
                            >
                              {isReply ? `↩ ${t("poolReplyBtn")}` : `📥 ${t("deliveryEventPool")}`}
                              {seqTag}
                            </button>
                          ) : (
                            <span className="codex-user-mode-tag">
                              {seg.mode === "steer" ? "⚡ Steer" : `📥 ${t("deliveryEventPool")}`}
                            </span>
                          ))}
                        {livePoolItem?.title && (
                          <strong className="codex-user-event-title">{livePoolItem.title}</strong>
                        )}
                        <p>{seg.text}</p>
                        {livePoolItem && (
                          <div className="codex-user-event-footer">
                            <span
                              className="codex-user-event-status"
                              data-read={isRead && !isWithdrawn ? "true" : undefined}
                              data-withdrawn={isWithdrawn ? "true" : undefined}
                            >
                              {isWithdrawn
                                ? `⊘ ${livePoolItem.handledAt ? t("poolStatusWithdrawnAt").replace("{time}", formatPoolTimestamp(livePoolItem.handledAt)) : t("poolStatusWithdrawn")}`
                                : isRead
                                  ? `✓ ${livePoolItem.handledAt ? t("poolStatusReadAt").replace("{time}", formatPoolTimestamp(livePoolItem.handledAt)) : t("poolStatusRead")}`
                                  : `⏳ ${t("poolStatusPendingShort")}`}
                            </span>
                            {!isRead && canMutatePool && (
                              <button
                                type="button"
                                className="codex-pool-withdraw-btn"
                                title={t("poolWithdrawHint")}
                                disabled={poolSubmitting}
                                onClick={() => void ackPoolEvent(livePoolItem.id)}
                              >
                                {t("poolWithdrawBtn")}
                              </button>
                            )}
                            <time dateTime={livePoolItem.createdAt}>{formatPoolTimestamp(livePoolItem.createdAt)}</time>
                          </div>
                        )}
                      </div>
                    </article>
                  );
                }

                if (seg.kind === "pool_receipt") {
                  return (
                    <CodexPoolReceiptCard
                      key={seg.id}
                      segment={seg}
                      poolById={poolEventsById}
                      streamEnter={streamEnter}
                      onJumpSource={locatePoolEventInStream}
                    />
                  );
                }

                if (seg.kind === "outbound_event") {
                  const liveEvent = resolveLivePoolEvent(seg.event);
                  const isHelp = liveEvent.kind === "help_request";
                  const isPending = liveEvent.status === "pending";
                  return (
                    <article
                      key={seg.id}
                      id={seg.block.id}
                      className={`codex-outbound-card${poolFlashId === liveEvent.id ? " is-pool-target-flash" : ""}`}
                      data-kind={liveEvent.kind}
                      data-handled={!isPending ? "true" : undefined}
                      data-pool-stream-card={liveEvent.id}
                      data-pool-event-id={liveEvent.id}
                      data-pool-seq={liveEvent.seq}
                      data-stream-enter={streamEnter ? "true" : undefined}
                    >
                      <header className="codex-outbound-header">
                        <div className="codex-outbound-badges">
                          <button
                            type="button"
                            className="codex-outbound-badge codex-pool-seq-link"
                            title={t("poolOpenInOverviewHint").replace("{seq}", String(liveEvent.seq))}
                            onClick={() => openPoolOverview(liveEvent.id)}
                          >
                            {isHelp ? "🆘" : "📌"}{" "}
                            {isHelp ? t("poolHelpRequestBadge") : t("poolNoticeBadge")} · #{liveEvent.seq}
                          </button>
                          {liveEvent.pauseRequested && (
                            <span className="codex-outbound-paused">{t("poolPausedTag")}</span>
                          )}
                        </div>
                        <div className="codex-outbound-meta">
                          <span
                            className="codex-outbound-status"
                            data-pending={isPending ? "true" : undefined}
                          >
                            {isPending
                              ? `● ${t("poolStatusAwaitingHuman")}`
                              : `✓ ${t("poolStatusHandled")}${liveEvent.handledAt ? ` · ${formatPoolTimestamp(liveEvent.handledAt)}` : ""}`}
                          </span>
                          <time dateTime={liveEvent.createdAt}>{formatPoolTimestamp(liveEvent.createdAt)}</time>
                        </div>
                      </header>
                      {liveEvent.title && <h4 className="codex-outbound-title">{liveEvent.title}</h4>}
                      <p className="codex-outbound-body">{liveEvent.text}</p>
                      {isLiveRun && isPending && (
                        <div className="codex-outbound-actions">
                          <button
                            type="button"
                            className="codex-pool-btn"
                            data-variant={canResumeAuto ? undefined : "primary"}
                            onClick={() => {
                              setReplyTarget(liveEvent);
                              setReplyAutoResumeDefault(false);
                            }}
                          >
                            <CornerUpLeft className="size-3" aria-hidden="true" />
                            <span>{t("poolReplyBtn")}</span>
                          </button>
                          {canResumeAuto && (
                            <button
                              type="button"
                              className="codex-pool-btn"
                              data-variant="primary"
                              onClick={() => {
                                setReplyTarget(liveEvent);
                                setReplyAutoResumeDefault(true);
                              }}
                            >
                              <Play className="size-3 fill-current" aria-hidden="true" />
                              <span>{t("poolReplyResumeBtn")}</span>
                            </button>
                          )}
                          {workspace && (
                            <button
                              type="button"
                              className="codex-pool-btn"
                              data-variant="ghost"
                              disabled={poolSubmitting}
                              onClick={() => void ackPoolEvent(liveEvent.id)}
                            >
                              <Check className="size-3" aria-hidden="true" />
                              <span>{t("poolDismissBtn")}</span>
                            </button>
                          )}
                        </div>
                      )}
                    </article>
                  );
                }

                if (seg.kind === "input") {
                  const segRunId = seg.runId || data.run;
                  const isInputSelected = Boolean(
                    activeBlockId === seg.id ||
                      (seg.call && inspectedTurn?.callId === seg.call.id),
                  );
                  return (
                    <CodexInputCard
                      key={seg.id}
                      segId={seg.id}
                      project={project}
                      run={segRunId}
                      call={seg.call}
                      observations={seg.observations}
                      bgBlock={seg.bgBlock}
                      at={seg.at}
                      isSelected={isInputSelected}
                      streamEnter={streamEnter}
                      onInspectInput={handleInspectInput}
                      onOpenReplayAt={onOpenReplayAt}
                    />
                  );
                }

                return (
                  <CodexTurnAssistantRow
                    key={seg.id}
                    segment={seg}
                    fallbackRunId={data.run}
                    showAllSteps={showAllSteps}
                    isLastSegment={segIdx === segments.length - 1}
                    selectedStepId={activeBlockId}
                    streamEnter={streamEnter}
                    onInspectBlock={handleInspectBlock}
                  />
                );
              })
            )}

            {/* Live active indicator when Shiori is thinking or consolidating */}
            {hostOnline && (thinking || consolidating) && (
              <div className="codex-live-thinking">
                <span className="codex-thinking-dot" />
                <span>{consolidating ? t("stateConsolidating") : t("stateAutoThinking")}</span>
              </div>
            )}
          </div>
        </div>

          {/* Floating Follow-Latest / Unread Activity Pill (anchored inside scroll stage above composer) */}
          {followPillPresence.mounted && (
            <button
              type="button"
              className="codex-follow-pill codex-scroll-bottom-btn"
              data-live-follow-pill=""
              data-has-unread={unreadCount > 0 ? "true" : undefined}
              data-motion-state={followPillPresence.state}
              inert={!showFollowPill || undefined}
              aria-label={
                unreadCount > 0
                  ? t("followPillUnreadLabel").replace(
                      "{count}",
                      unreadCount > 99 ? "99+" : String(unreadCount),
                    )
                  : t("scrollToBottomAria")
              }
              onClick={() => scrollToBottom(prefersSmoothScrollBehavior())}
            >
              {unreadCount > 0 ? (
                <>
                  <span className="codex-thinking-dot codex-follow-pill-dot" aria-hidden="true" />
                  <span className="codex-follow-pill-text">
                    {t("followPillUnreadLabel").replace(
                      "{count}",
                      unreadCount > 99 ? "99+" : String(unreadCount),
                    )}
                  </span>
                  <ArrowDown className="size-3.5 shrink-0" aria-hidden="true" />
                </>
              ) : (
                <>
                  <ArrowDown className="size-3.5 shrink-0" aria-hidden="true" />
                  <span className="codex-follow-pill-text">{t("followPillLatestLabel")}</span>
                </>
              )}
            </button>
          )}
        </div>

        {/* Bottom Floating Pill Composer */}
        <ShioriComposer
          project={project}
          workspace={workspace}
          data={data}
          isLiveRun={isLiveRun}
          sessionActions={actions}
          hostStatusOverride={live as Record<string, unknown> | null}
          activeModelOverride={activeModel}
          activeServiceTierOverride={activeServiceTier}
          activeEffortOverride={activeEffort}
          submittingOverride={sessionSubmitting}
          spawningCore={spawningCore}
          preemptSuccessSeq={preemptSuccessSeq}
          liveTimerSpec={liveTimerSpec}
          onApplyLiveTimer={applyLiveStopTimer}
          onExtendLiveTimer={extendLiveStopTimer}
          poolSnapshot={poolSnapshot}
          replyTarget={replyTarget}
          replyAutoResumeDefault={replyAutoResumeDefault}
          onSelectReplyTarget={(event, autoResume) => {
            setReplyTarget(event);
            setReplyAutoResumeDefault(autoResume);
          }}
          externalMode={workflowCommand?.mode ?? null}
          externalDraft={workflowCommand?.prompt ?? null}
          onExternalConsumed={() => setWorkflowCommand(null)}
          onMessageSubmitted={() => scrollToBottom(prefersSmoothScrollBehavior())}
          onReturnLatest={onReturnLatest}
          onUpdated={onUpdated}
        />
      </section>

      {/* ── RIGHT WORKBENCH DOCK: LIVE VIEWPORT + COMPACT HOST OPS + TELEMETRY ── */}
      {backdropPresence.mounted && (
        <div
          className="codex-dock-backdrop"
          data-dock-backdrop
          data-motion-state={backdropPresence.state}
          aria-hidden="true"
          onClick={closeDock}
        />
      )}
      <aside
        className="codex-right-dock"
        data-dock-state={dockOpen ? "open" : "closed"}
        data-overlay={isOverlayDock ? "true" : undefined}
        aria-hidden={!dockOpen || undefined}
        inert={!dockOpen || undefined}
        aria-label={t("stageColumnAria")}
      >
          <header className="codex-dock-header">
            <div className="codex-dock-seg" role="tablist" aria-label={t("stageColumnAria")}>
              <button
                type="button"
                role="tab"
                className="codex-dock-seg-tab"
                aria-selected={dockTab === "stage"}
                data-active={dockTab === "stage" || undefined}
                onClick={() => setDockTab("stage")}
              >
                <span className="codex-dock-header-title">{t("dockTabStageTelemetry")}</span>
              </button>
              <button
                type="button"
                role="tab"
                className="codex-dock-seg-tab"
                aria-selected={dockTab === "pool"}
                data-active={dockTab === "pool" || undefined}
                data-dock-tab-pool
                onClick={() => setDockTab("pool")}
              >
                <span className="codex-dock-seg-label">{t("dockTabEventPool")}</span>
                {pendingPoolCount > 0 && (
                  <span
                    className="codex-dock-seg-badge"
                    data-tone={pendingOutboundCount > 0 ? "warn" : "ok"}
                  >
                    <i aria-hidden="true" />
                    {pendingPoolCount}
                  </span>
                )}
              </button>
            </div>
            <button
              type="button"
              className="codex-header-btn codex-dock-close-btn"
              title={t("closeDock")}
              aria-label={t("closeDock")}
              onClick={closeDock}
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </header>
          {dockTab === "pool" && (
            <div className="codex-dock-body codex-dock-scroll" data-dock-tab="pool" role="tabpanel">
              {renderEventPoolPanel ? (
                renderEventPoolPanel(eventPoolPanelProps)
              ) : (
                <FallbackEventPoolPanel {...eventPoolPanelProps} />
              )}
            </div>
          )}
          {/* Stage stays mounted while the pool tab is shown so live frames/streams are not torn down. */}
          <div className="codex-dock-body" data-dock-tab="stage" role="tabpanel" hidden={dockTab !== "stage"}>
            {/* 1. Primary Live Game / Device Viewport */}
            <div className="codex-dock-viewport">
              {inspectedTurn && (
                <div className="codex-inspected-banner" role="status">
                  <span>
                    {t("inspectingCallBanner").replace(
                      "{number}",
                      String(inspectedCall?.index ?? "—").padStart(3, "0"),
                    )}{" "}
                    · {clockTime(inspectedTurn.at)}
                  </span>
                  <button
                    type="button"
                    className="codex-inspected-clear"
                    onClick={() => setInspectedTurn(null)}
                  >
                    <X className="size-3" aria-hidden="true" />
                    <span>{t("clearInspectedBtn")}</span>
                  </button>
                </div>
              )}
              {renderObservation
                ? renderObservation({
                    data: inspectedRunData,
                    call: inspectedCall,
                    selectedImage: inspectedTurn?.imageId ?? undefined,
                    onSelectImage: id =>
                      setInspectedTurn(prev =>
                        prev
                          ? { ...prev, imageId: id || null }
                          : id
                            ? {
                                runId: data.run,
                                blockId: "manual-image",
                                callId: null,
                                imageId: id,
                                at: data.updatedAt,
                              }
                            : null,
                      ),
                  })
                : observationSlot}
            </div>

            {/* 2. Session Runtime & Live Stop-Timer + OMP Telemetry */}
            {summary && (
              <div className="codex-dock-section">
                <LiveRuntimeTelemetryHeader
                  isAuto={isAuto}
                  hostOnline={hostOnline}
                  elapsedSeconds={elapsedSeconds}
                  stateTitle={stateTitle}
                  spec={liveTimerSpec}
                  onApplyTimer={applyLiveStopTimer}
                  onExtendTimer={extendLiveStopTimer}
                />

                <div className="codex-stat-cards">
                  <div className="codex-stat-card shiori-stat-card">
                    <div className="codex-stat-card-top">
                      <span className="shiori-stat-label">{t("tileTurns")}</span>
                      <strong>{summary.completed}</strong>
                    </div>
                    <small>{t("tileTotalCalls").replace("{total}", String(data.paging.totalCalls))}</small>
                  </div>
                  <div className="codex-stat-card shiori-stat-card">
                    <div className="codex-stat-card-top">
                      <span className="shiori-stat-label">{t("tileActions")}</span>
                      <strong>{summary.actions}</strong>
                    </div>
                    <small>{t("tileObserves").replace("{count}", String(summary.explicitObserves))}</small>
                  </div>
                  <div className="codex-stat-card shiori-stat-card">
                    <div className="codex-stat-card-top">
                      <span className="shiori-stat-label">{t("tileLatency")}</span>
                      <strong>{summary.medianMs != null ? `${(summary.medianMs / 1000).toFixed(1)}s` : "—"}</strong>
                    </div>
                    <small>P95 {summary.p95Ms != null ? `${(summary.p95Ms / 1000).toFixed(1)}s` : "—"}</small>
                  </div>
                  <div className="codex-stat-card shiori-stat-card">
                    <div className="codex-stat-card-top">
                      <span className="shiori-stat-label">{t("tileCache")}</span>
                      <strong>{summary.cacheHit != null ? `${Math.round(summary.cacheHit * 100)}%` : "—"}</strong>
                    </div>
                    <small>
                      {t("tileWarmCache").replace(
                        "{pct}",
                        summary.warmCacheHit != null ? `${Math.round(summary.warmCacheHit * 100)}%` : "—",
                      )}
                    </small>
                  </div>
                </div>

                {/* Collapsible Provenance Footer */}
                <details className="codex-provenance-details">
                  <summary className="codex-provenance-summary">
                    <span>{t("provenanceTitle")}</span>
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {data.manifest.shiori?.implementation ?? "omp"} ·{" "}
                      {shortModelLabel(activeModel, t("deviceOnly"))}
                    </span>
                  </summary>
                  <dl className="codex-provenance-list">
                    <div className="codex-provenance-row">
                      <dt>{t("provShiori")}</dt>
                      <dd>
                        {data.manifest.shiori?.implementation ?? "omp"}{" "}
                        {data.manifest.shiori?.implementationVersion ?? ""}
                      </dd>
                    </div>
                    <div className="codex-provenance-row">
                      <dt>{t("provModel")}</dt>
                      <dd data-provenance-model>{activeModel ?? t("deviceOnly")}</dd>
                    </div>
                    <div className="codex-provenance-row">
                      <dt>{t("provCompaction")}</dt>
                      <dd>{data.manifest.compactionThreshold?.toLocaleString() ?? "default"}</dd>
                    </div>
                    <div className="codex-provenance-row">
                      <dt>{t("provRun")}</dt>
                      <dd className="font-mono">{data.run || "—"}</dd>
                    </div>
                    <div className="codex-provenance-row">
                      <dt>{t("provEpoch")}</dt>
                      <dd className="font-mono">{data.selectedEpoch ?? "—"}</dd>
                    </div>
                  </dl>
                </details>

                {isLiveRun && project && (
                  !hostOnline ? (
                    <div className="codex-host-ops-grid">
                      <button
                        type="button"
                        className="codex-host-op-btn"
                        disabled={workspaceService.busy}
                        onClick={() => void workspaceService.startWorkspace()}
                        data-dock-service-op="up"
                      >
                        {workspaceService.pendingOperation === "up" ? (
                          <RefreshCw className="size-3.5 motion-safe:animate-spin shrink-0" aria-hidden="true" />
                        ) : (
                          <Play className="size-3.5 fill-current shrink-0" aria-hidden="true" />
                        )}
                        <span>
                          {t(
                            workspaceService.pendingOperation === "up"
                              ? "startingWorkspaceBtn"
                              : "startWorkspaceBtn",
                          )}
                        </span>
                      </button>
                    </div>
                  ) : (
                    <div className="codex-host-ops-grid" data-cols="2">
                      <button
                        type="button"
                        className="codex-host-op-btn"
                        disabled={workspaceService.busy || isAuto || consolidating}
                        onClick={() => void workspaceService.reloadWorkspace()}
                        data-dock-service-op="reload"
                      >
                        {workspaceService.pendingOperation === "reload" ? (
                          <RefreshCw className="size-3.5 motion-safe:animate-spin shrink-0" aria-hidden="true" />
                        ) : (
                          <RotateCcw className="size-3.5 shrink-0" aria-hidden="true" />
                        )}
                        <span>
                          {t(
                            workspaceService.pendingOperation === "reload"
                              ? "reloadingWorkspaceBtn"
                              : "reloadWorkspaceBtn",
                          )}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="codex-host-op-btn"
                        disabled={workspaceService.busy || consolidating}
                        onClick={() => void workspaceService.stopWorkspace()}
                        data-dock-service-op="down"
                      >
                        {workspaceService.pendingOperation === "down" ? (
                          <RefreshCw className="size-3.5 motion-safe:animate-spin shrink-0" aria-hidden="true" />
                        ) : (
                          <Square className="size-3 fill-current shrink-0" aria-hidden="true" />
                        )}
                        <span>
                          {t(
                            workspaceService.pendingOperation === "down"
                              ? "stoppingWorkspaceBtn"
                              : "stopWorkspaceBtn",
                          )}
                        </span>
                      </button>
                    </div>
                  )
                )}
              </div>
            )}
          </div>
        </aside>
      <DeviceContentionDialog
        conflict={pendingContention}
        busy={spawningCore || sessionSubmitting}
        error={preemptError}
        onConfirmPreempt={confirmPreempt}
        onDismiss={dismissContention}
        onSwitchToHolder={handleSwitchToHolder}
      />
    </div>
  );
}
