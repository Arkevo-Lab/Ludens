"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  ArrowDown,
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
  RotateCcw,
  Square,
  X,
  Zap,
} from "lucide-react";
import type { EventPoolSnapshot, PoolEvent } from "@ludens/protocol/event-pool";
import { PixelMark } from "@/components/ui/pixel-mark";
import { ModelPickerDialog, shortModelLabel, type ModelServiceTier } from "@/components/model-picker-dialog";
import { useTranslations } from "@/lib/locale";
import type { ActivityBlock } from "@/features/live/activity-feed-model";
import { activityContentView, printable } from "@/features/live/activity-feed-model";
import type { ActivityFeedData } from "@/features/live/use-activity-feed";
import { clockTime } from "@/features/live/run-visuals";
import { readArchiveJson } from "@/lib/archive-client";
import { runWindowSummary } from "@/lib/run-identity";
import type { Call, Observation, RunData, RunInfo } from "@/lib/types";
import { requestActivity } from "@ludens/protocol/activity";

// The run budget is drawn as this many pixel blocks.
const BUDGET_BLOCKS = 24;

export type RuntimeControlAction =
  | { action: "status" }
  | { action: "auto_on"; message?: string; seconds?: number | null; runId?: string; expectedEpoch?: string | null }
  | { action: "auto_off"; runId?: string; expectedEpoch?: string | null }
  | { action: "auto_budget"; seconds: number | null; runId?: string; expectedEpoch?: string | null }
  | { action: "steer"; message: string; runId?: string; expectedEpoch?: string | null }
  | { action: "consolidate"; seconds?: number; runId?: string; expectedEpoch?: string | null }
  | { action: "set_model"; model: string; serviceTier?: ModelServiceTier | null; runId?: string; expectedEpoch?: string | null }
  | { action: "perception_inject"; enabled: boolean; runId?: string }
  | { action: "perception_reload"; runId?: string };

export function canSwitchShioriModel(state: {
  isLiveRun: boolean;
  hostOnline: boolean;
  mode: string;
  consolidating?: boolean;
  thinking?: boolean;
}): boolean {
  if (!state.isLiveRun) return false;
  if (state.mode === "auto" || state.mode === "acquiring") return false;
  if (state.consolidating) return false;
  if (state.hostOnline && (state.thinking || state.mode !== "manual")) return false;
  return true;
}

export function resolveShioriActiveModel(options: {
  localModelOverride?: string | null;
  liveModel?: string | null;
  controlModel?: string | null;
  manifestModel?: string | null;
}): string | null {
  const candidates = [
    options.localModelOverride,
    options.liveModel,
    options.controlModel,
    options.manifestModel,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

export type EventPoolClientCommand =
  | { action: "send"; text: string; title?: string }
  | { action: "reply"; replyTo: string; text: string; resumeAuto?: boolean; seconds?: number | null }
  | { action: "ack"; ids: string[] };

interface EventPoolApiReadPayload {
  snapshot: EventPoolSnapshot;
  hostOnline: boolean;
  hostStatus?: Record<string, unknown>;
}

interface EventPoolApiMutatePayload extends EventPoolApiReadPayload {
  createdEvent?: PoolEvent;
  resolvedOutbound?: PoolEvent;
  updatedEvents?: PoolEvent[];
}

async function fetchEventPool(
  project: string,
  workspace: string,
  signal?: AbortSignal,
): Promise<EventPoolApiReadPayload> {
  const params = new URLSearchParams({ project, workspace });
  const response = await fetch(`/api/event-pool?${params}`, { signal, cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof payload?.error === "string" ? payload.error : `Event Pool read failed (${response.status})`);
  }
  return payload as EventPoolApiReadPayload;
}

async function mutateEventPool(
  project: string,
  workspace: string,
  command: EventPoolClientCommand,
): Promise<EventPoolApiMutatePayload> {
  const response = await fetch("/api/event-pool", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project, workspace, command }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof payload?.error === "string" ? payload.error : `Event Pool request failed (${response.status})`);
  }
  return payload as EventPoolApiMutatePayload;
}

async function sendRuntimeControl(
  project: string,
  workspace: string,
  command: RuntimeControlAction,
) {
  const response = await fetch("/api/runtime/control", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project, workspace, command }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof payload?.error === "string" ? payload.error : `Control request failed (${response.status})`);
  }
  return payload;
}

async function updateWorkspaceShioriModel(project: string, model: string, serviceTier: ModelServiceTier | null) {
  const response = await fetch("/api/workspaces", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "workspaceShiori",
      id: project,
      shiori: { model, serviceTier },
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      typeof payload?.error === "string"
        ? payload.error
        : `Workspace model update failed (${response.status})`,
    );
  }
  return payload;
}

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

import {
  asRecord,
  buildCodexSegments,
  cleanErrorMessage,
  cleanInlinePreview,
  extractReadableText,
  summarizeStepBlock,
  type BuildSegmentsOptions,
  type StreamSegment,
} from "@/features/live/shiori-segments";
export { buildCodexSegments, type BuildSegmentsOptions, type StreamSegment };

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

function CodexSessionDivider({
  segment,
  highlighted,
}: {
  segment: Extract<StreamSegment, { kind: "session_divider" }>;
  highlighted?: boolean;
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
        onClick={() => setOpen(prev => !prev)}
      >
        <span>
          {t("collapsedStepsPrefix").replace("{count}", String(steps.length))}
          {breakdown.length > 0 ? ` · ${breakdown.join(" / ")}` : ""}
        </span>
        {isExpanded ? (
          <ChevronDown className="size-3.5" aria-hidden="true" />
        ) : (
          <ChevronRight className="size-3.5" aria-hidden="true" />
        )}
      </button>

      {isExpanded && (
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

                {isStepOpen && view && (
                  <pre className="codex-step-pre">{view.text}</pre>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CodexInputCard({
  project,
  run,
  call,
  observations,
  bgBlock,
  at,
  isSelected,
  onSelect,
  onOpenReplayAt,
}: {
  project: string;
  run: string;
  call?: Call;
  observations: Observation[];
  bgBlock?: ActivityBlock;
  at: string;
  isSelected: boolean;
  onSelect: (imageId?: string) => void;
  onOpenReplayAt?: (frame: { run?: string; at?: number; record: string; sequence: number }) => void;
}) {
  const t = useTranslations("shioriCockpit");
  const [expandedPayload, setExpandedPayload] = useState(false);

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
      onClick={() => onSelect(observations[0]?.id)}
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
                  onSelect(obs.id);
                }}
              >
                <img
                  src={`/api/media?project=${encodeURIComponent(project)}&run=${encodeURIComponent(run)}&id=${encodeURIComponent(obs.id)}`}
                  alt={obs.origin || obs.id}
                  width={96}
                  height={54}
                  loading="lazy"
                  decoding="async"
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
              onClick={event => {
                event.stopPropagation();
                setExpandedPayload(prev => !prev);
              }}
            >
              {expandedPayload ? (
                <ChevronDown className="size-3" aria-hidden="true" />
              ) : (
                <ChevronRight className="size-3" aria-hidden="true" />
              )}
              <span>{t("inputExpandPayload")}</span>
            </button>
          </div>

          {expandedPayload && (
            <pre
              className="codex-input-payload-pre"
              onClick={event => event.stopPropagation()}
            >
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
          )}
        </div>
      </div>
    </article>
  );
}

function isHostOfflineError(cause: unknown): boolean {
  const msg = cause instanceof Error ? cause.message : String(cause);
  return (
    msg.includes("未在线") ||
    msg.includes("HOST_OFFLINE") ||
    msg.includes("ENOENT") ||
    msg.includes("ECONNREFUSED")
  );
}

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

      {open && (
        <div
          className="codex-runtime-timer-popover"
          data-placement={placement}
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

export function ShioriComposer({
  project,
  workspace,
  data,
  isLiveRun,
  hostStatusOverride,
  onHostStatusChange,
  activeModelOverride,
  onModelChange,
  liveRemainingSeconds,
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
  onUpdated,
}: {
  project: string;
  workspace: string | null;
  data: RunData;
  isLiveRun: boolean;
  hostStatusOverride?: Record<string, unknown> | null;
  onHostStatusChange?: (status: Record<string, unknown>) => void;
  activeModelOverride?: string | null;
  onModelChange?: (model: string) => void;
  liveRemainingSeconds?: number | null;
  onApplyLiveTimer?: (seconds: number | null) => Promise<void>;
  onExtendLiveTimer?: (deltaSeconds: number) => Promise<void>;
  poolSnapshot?: EventPoolSnapshot | null;
  replyTarget?: PoolEvent | null;
  replyAutoResumeDefault?: boolean;
  onSelectReplyTarget?: (event: PoolEvent | null, autoResume?: boolean) => void;
  onPoolMutated?: (snapshot: EventPoolSnapshot, hostStatus?: Record<string, unknown>) => void;
  externalMode?: ComposerMode | null;
  externalDraft?: string | null;
  onExternalConsumed?(): void;
  onReturnLatest?(): void;
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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSent, setLastSent] = useState<string | null>(null);
  const [localModelOverride, setLocalModelOverride] = useState<{
    project: string;
    baseServerModel: string | null;
    model: string;
    serviceTier?: ModelServiceTier | null;
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
    hostOffline?: boolean;
  }) | null;
  const control = data.lastControl as (RunData["lastControl"] & { model?: string | null; serviceTier?: ModelServiceTier | null }) | undefined;
  const runtimeMode =
    effectiveHost?.mode ?? (typeof control?.mode === "string" ? control.mode : "manual");
  const consolidating = Boolean(effectiveHost?.consolidating ?? control?.consolidating);
  const thinking = Boolean(effectiveHost?.thinking ?? control?.thinking);
  const isAuto = runtimeMode === "auto";
  const isSyntheticOffline = Boolean(effectiveHost?.hostOffline);
  const hostOnline = Boolean(isLiveRun && ((!isSyntheticOffline && effectiveHost) || data.controlAllowed));
  const canResumeFromReply = Boolean(hostOnline && !isAuto && !consolidating);
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
  const activeServiceTier = validLocalModel && activeModel === localModelOverride?.model
    ? localModelOverride.serviceTier ?? null
    : effectiveHost?.serviceTier ?? control?.serviceTier ?? null;

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
    : hostOnline && !consolidating
      ? ["start", "event"]
      : ["event", "start"];

  const effectiveTab: ComposerMode = replyTarget
    ? "event"
    : selectedTab && validModes.includes(selectedTab)
      ? selectedTab
      : isAuto
        ? "event"
        : hostOnline && !consolidating
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
      });
      onModelChange?.(nextModel);
    }
  };

  const applyReturnedStatus = (res: unknown) => {
    const record = asRecord(res);
    const status = asRecord(record?.status) ?? (typeof record?.mode === "string" ? record : null);
    applyHostStatusObject(status);
    return status;
  };

  const handleSelectModel = async (nextModel: string, nextServiceTier: ModelServiceTier | null) => {
    const trimmed = nextModel.trim();
    if (!trimmed || !project) return;
    if (!canSwitchModel) {
      setModelLockNotice(t("modelSwitchLockedHint"));
      throw new Error(t("modelSwitchLockedHint"));
    }
    setError(null);
    setModelLockNotice(null);

    let persistedOffline = !hostOnline;
    let appliedServiceTier = nextServiceTier;
    if (workspace) {
      try {
        const res = await sendRuntimeControl(project, workspace, {
          action: "set_model",
          model: trimmed,
          serviceTier: nextServiceTier,
          runId: data.run,
          expectedEpoch: effectiveHost?.epoch ?? null,
        });
        const status = applyReturnedStatus(res);
        if (status && "serviceTier" in status) {
          appliedServiceTier = status.serviceTier === "priority" || status.serviceTier === "ultrafast" ? status.serviceTier : null;
        }
        persistedOffline = Boolean(status?.hostOffline) || !hostOnline;
      } catch (cause) {
        if (isHostOfflineError(cause)) {
          await updateWorkspaceShioriModel(project, trimmed, nextServiceTier);
          persistedOffline = true;
        } else {
          throw cause;
        }
      }
    } else {
      await updateWorkspaceShioriModel(project, trimmed, nextServiceTier);
      persistedOffline = true;
    }

    setLocalModelOverride({ project, baseServerModel: serverModel, model: trimmed, serviceTier: appliedServiceTier });
    onModelChange?.(trimmed);
    setLastSent(
      (persistedOffline ? t("modelSwitchedOfflineFeedback") : t("modelSwitchedFeedback")).replace(
        "{model}",
        trimmed,
      ),
    );
    onUpdated();
  };

  const dismissOutboundEvent = async (eventId: string) => {
    if (submitting || !project || !workspace) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await mutateEventPool(project, workspace, { action: "ack", ids: [eventId] });
      applyHostStatusObject(res.hostStatus);
      onPoolMutated?.(res.snapshot, res.hostStatus);
      if (replyTarget?.id === eventId) onSelectReplyTarget?.(null);
      onUpdated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const submitMessage = async (overrideText?: string, forceResumeAuto?: boolean) => {
    const text = (overrideText ?? draft).trim();
    if (submitting || !project || !workspace) return;
    if (effectiveTab !== "start" && !text) return;
    setSubmitting(true);
    setError(null);
    setDurationMenuOpen(false);
    try {
      if (effectiveTab === "event") {
        const shouldResume = Boolean((forceResumeAuto ?? resumeOnReply) && canResumeFromReply);
        const res = await mutateEventPool(
          project,
          workspace,
          replyTarget
            ? {
                action: "reply",
                replyTo: replyTarget.id,
                text,
                ...(shouldResume ? { resumeAuto: true, seconds: durationSeconds } : {}),
              }
            : { action: "send", text },
        );
        applyHostStatusObject(res.hostStatus);
        onPoolMutated?.(res.snapshot, res.hostStatus);
        if (!overrideText) setDraft("");
        onSelectReplyTarget?.(null);
        setLastSent(res.hostOnline ? text : `${t("poolOfflineQueuedFeedback")} · ${text}`);
        onUpdated();
        return;
      }

      let res: unknown;
      if (effectiveTab === "steer") {
        try {
          res = await sendRuntimeControl(project, workspace, {
            action: "steer",
            message: text,
            runId: data.run,
            expectedEpoch: effectiveHost?.epoch ?? undefined,
          });
        } catch (steerErr) {
          const msg = steerErr instanceof Error ? steerErr.message : String(steerErr);
          if (msg.includes("Auto loop is not active")) {
            res = await sendRuntimeControl(project, workspace, {
              action: "auto_on",
              ...(text ? { message: text } : {}),
              seconds: durationSeconds,
              runId: data.run,
              expectedEpoch: effectiveHost?.epoch ?? null,
            });
            setSelectedTab(null);
          } else {
            throw steerErr;
          }
        }
      } else {
        res = await sendRuntimeControl(project, workspace, {
          action: "auto_on",
          ...(text ? { message: text } : {}),
          seconds: durationSeconds,
          runId: data.run,
          expectedEpoch: effectiveHost?.epoch ?? null,
        });
      }
      applyReturnedStatus(res);
      if (!overrideText) setDraft("");
      setLastSent(text || t("resumedDefaultPrompt"));
      onUpdated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const runComposerAction = async (command: RuntimeControlAction, feedbackLabel: string) => {
    if (submitting || !project || !workspace) return;
    setSubmitting(true);
    setError(null);
    setMenuOpen(false);
    setDurationMenuOpen(false);
    try {
      const res = await sendRuntimeControl(project, workspace, command);
      applyReturnedStatus(res);
      setLastSent(feedbackLabel);
      onUpdated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
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
      {menuOpen && (
        <div className="codex-preset-popover" role="menu">
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

      {durationMenuOpen && (
        <div className="codex-preset-popover codex-duration-popover" role="menu">
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

      {pendingOutboundEvents.length > 0 && (
        <div className="codex-pool-tray" data-event-pool-tray>
          {pendingOutboundEvents.map(item => {
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

        {replyTarget && (
          <div className="codex-reply-context-bar" data-reply-context={replyTarget.id}>
            <div className="codex-reply-context-main">
              <CornerUpLeft className="size-3.5 text-primary shrink-0" aria-hidden="true" />
              <strong className="shrink-0">
                {t("poolReplyingTo").replace(
                  "{kind}",
                  replyTarget.kind === "help_request" ? t("poolHelpRequestBadge") : t("poolNoticeBadge"),
                )}
              </strong>
              <span className="codex-reply-context-quote">
                {replyTarget.title || replyTarget.text}
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
              {canSwitchModel ? (
                <ChevronDown className="size-3 shrink-0 opacity-70" aria-hidden="true" />
              ) : (
                <Lock className="size-3 shrink-0 opacity-65" aria-hidden="true" />
              )}
            </button>

            {isAuto && hostOnline && onApplyLiveTimer && (
              <LiveStopTimerControl
                remainingSeconds={liveRemainingSeconds ?? null}
                disabled={submitting}
                placement="up"
                compact
                onExtendTimer={
                  onExtendLiveTimer
                    ? async delta => {
                        await onExtendLiveTimer(delta);
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
      {!error && modelLockNotice && (
        <p className="codex-composer-feedback codex-composer-feedback-warn" role="status">
          <Lock className="inline size-3 -translate-y-[1px] mr-1" aria-hidden="true" />
          {modelLockNotice}
        </p>
      )}
      {!error && !modelLockNotice && lastSent && (
        <p className="codex-composer-feedback" role="status">
          ✓ {t("sentFeedback")}: <code>{lastSent.length > 72 ? `${lastSent.slice(0, 72)}…` : lastSent}</code>
        </p>
      )}

      <ModelPickerDialog
        open={modelPickerOpen}
        onOpenChange={setModelPickerOpen}
        value={activeModel}
        serviceTier={activeServiceTier}
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
}

export function ShioriWorkbench({
  project,
  workspace,
  workspaceTitle,
  runs = [],
  jumpTarget = null,
  onClearJumpTarget,
  onActiveSegmentChange,
  data,
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
  onOpenPerf,
  onOpenCaps,
  onOpenReplay,
  onOpenReplayAt,
  onReturnLatest,
  renderObservation,
  observationSlot,
  runPicker,
  mobileNavSlot,
}: ShioriWorkbenchProps) {
  const t = useTranslations("shioriCockpit");
  const streamRef = useRef<HTMLDivElement | null>(null);
  const prependScrollAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const isJumpingRef = useRef(false);
  const prevRunRef = useRef(data.run);
  const cachedSegmentsRef = useRef<{ run: string; segments: StreamSegment[] }>({
    run: "",
    segments: [],
  });
  const [showAllSteps, setShowAllSteps] = useState(false);
  const [desktopDockOpen, setDesktopDockOpen] = useState(true);
  const [drawerDockOpen, setDrawerDockOpen] = useState(false);
  const [isOverlayDock, setIsOverlayDock] = useState(false);
  const dockOpen = isOverlayDock ? drawerDockOpen : desktopDockOpen;
  const openDock = () => {
    setDesktopDockOpen(true);
    setDrawerDockOpen(true);
  };
  const closeDock = () => {
    if (isOverlayDock) setDrawerDockOpen(false);
    else setDesktopDockOpen(false);
  };
  const toggleDock = () => {
    if (isOverlayDock) setDrawerDockOpen(prev => !prev);
    else setDesktopDockOpen(prev => !prev);
  };
  const [atBottom, setAtBottom] = useState(true);
  const [modelOverride, setModelOverride] = useState<{
    project: string;
    baseServerModel: string | null;
    model: string;
  } | null>(null);
  const [hostStatusOverride, setHostStatusOverride] = useState<{
    project: string;
    run: string;
    baseUpdatedAt: string;
    appliedAtMs: number;
    status: Record<string, unknown>;
  } | null>(null);
  const [loadedOlderRuns, setLoadedOlderRuns] = useState<
    Array<{
      runId: string;
      data: RunData;
      blocks: ActivityBlock[];
      before: string | null;
      hasMore: boolean;
    }>
  >([]);
  const [loadingOlderRun, setLoadingOlderRun] = useState(false);
  const [olderRunError, setOlderRunError] = useState<string | null>(null);
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
    prompt: string;
  } | null>(null);
  const [poolSnapshot, setPoolSnapshot] = useState<EventPoolSnapshot | null>(null);
  const [replyTarget, setReplyTarget] = useState<PoolEvent | null>(null);
  const [replyAutoResumeDefault, setReplyAutoResumeDefault] = useState<boolean | undefined>(undefined);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    setLoadedOlderRuns([]);
    setOlderRunError(null);
    setHighlightedSegmentId(null);
    setInspectedTurn(null);
    setModelOverride(null);
    setHostStatusOverride(null);
    setPoolSnapshot(null);
    setReplyTarget(null);
    setReplyAutoResumeDefault(undefined);
  }, [project]);

  useEffect(() => {
    if (!isLiveRun || !project || !workspace) return;
    let cancelled = false;
    const controller = new AbortController();
    const pull = async () => {
      try {
        const payload = await fetchEventPool(project, workspace, controller.signal);
        if (cancelled) return;
        setPoolSnapshot(payload.snapshot);
      } catch {
        // Non-fatal background refresh
      }
    };
    void pull();
    if (!refresh) {
      return () => {
        cancelled = true;
        controller.abort();
      };
    }
    const timer = setInterval(() => {
      void pull();
    }, 3500);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [isLiveRun, project, workspace, data.updatedAt, refresh]);

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
    setDesktopDockOpen(true);
    setDrawerDockOpen(true);
  }, [requestedCall, selectedImage, data.run, data.calls, data.updatedAt]);

  const activeHostOverride =
    hostStatusOverride &&
    hostStatusOverride.project === project &&
    hostStatusOverride.run === data.run &&
    hostStatusOverride.baseUpdatedAt === data.updatedAt
      ? hostStatusOverride.status
      : null;

  const live = (activeHostOverride ?? data.live) as (NonNullable<RunData["live"]> & {
    maxSeconds?: number | null;
    remainingSeconds?: number | null;
    consolidating?: boolean;
    model?: string | null;
    hostOffline?: boolean;
    queue?: { steering?: number };
    eventPool?: { pendingInbound?: number; pendingOutbound?: number; latestSeq?: number };
  }) | null;
  const control = data.lastControl as (RunData["lastControl"] & { model?: string | null }) | undefined;
  const isSyntheticOffline = Boolean(live?.hostOffline);
  const hostOnline = Boolean(isLiveRun && ((!isSyntheticOffline && live) || data.controlAllowed));
  const mode = live?.mode ?? (typeof control?.mode === "string" ? control.mode : "manual");
  const consolidating = Boolean(live?.consolidating ?? control?.consolidating);
  const thinking = Boolean(live?.thinking ?? control?.thinking);
  const isAuto = mode === "auto";
  const serverModel = resolveShioriActiveModel({
    liveModel: typeof live?.model === "string" ? live.model : null,
    controlModel: typeof control?.model === "string" ? control.model : null,
    manifestModel: data.manifest.model ?? null,
  });
  const activeModelOverride =
    modelOverride &&
    modelOverride.project === project &&
    (serverModel === modelOverride.baseServerModel || serverModel === modelOverride.model)
      ? modelOverride.model
      : null;
  const activeModel = resolveShioriActiveModel({
    localModelOverride: activeModelOverride,
    liveModel: typeof live?.model === "string" ? live.model : null,
    controlModel: typeof control?.model === "string" ? control.model : null,
    manifestModel: data.manifest.model ?? null,
  });

  useEffect(() => {
    if (prevRunRef.current !== data.run) {
      prevRunRef.current = data.run;
      setLoadedOlderRuns([]);
      setOlderRunError(null);
    }
  }, [data.run]);

  useEffect(() => {
    if (!isLiveRun || !isAuto || !refresh) return;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isLiveRun, isAuto, refresh]);

  const earliestOlderRun = loadedOlderRuns[0] ?? null;
  const earliestLoadedRunId = earliestOlderRun?.runId ?? data.run;
  const earliestIdxInCatalog = runs.findIndex(r => r.id === earliestLoadedRunId);
  const nextOlderRun =
    earliestIdxInCatalog >= 0 && earliestIdxInCatalog + 1 < runs.length
      ? runs[earliestIdxInCatalog + 1]
      : null;

  const hasMoreUpwardHistory = Boolean(
    loadedOlderRuns.length === 0
      ? feed.hasMore || nextOlderRun
      : earliestOlderRun?.hasMore || nextOlderRun || feed.hasMore,
  );

  const olderRunAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => olderRunAbortRef.current?.abort();
  }, [project, data.run]);

  const fetchHistoricalRun = async (
    targetRunId: string,
    signal: AbortSignal,
    evidence?: { targetRunId: string; call?: string; image?: string },
  ) => {
    const runParams = new URLSearchParams({ project, run: targetRunId, epoch: "all" });
    if (evidence && evidence.targetRunId === targetRunId) {
      if (evidence.call) runParams.set("call", evidence.call);
      if (evidence.image) runParams.set("image", evidence.image);
    }
    const actParams = new URLSearchParams({
      project,
      run: targetRunId,
      epoch: "all",
      mode: "history",
      kind: "all",
      limit: "300",
    });
    const [runPayload, actPayload] = await Promise.all([
      readArchiveJson<RunData>(`/api/run?${runParams}`, signal),
      requestActivity(actParams, signal),
    ]);
    return {
      runId: targetRunId,
      data: runPayload,
      blocks: Array.isArray(actPayload.blocks) ? actPayload.blocks : [],
      before: typeof actPayload.before === "string" ? actPayload.before : null,
      hasMore: Boolean(actPayload.hasMore && actPayload.before),
    };
  };

  const capturePrependAnchor = () => {
    const el = streamRef.current;
    if (el && !atBottom && !isJumpingRef.current) {
      prependScrollAnchorRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
    }
  };

  const loadEarlierBlocksOfOlderRun = async (targetRunId: string, beforeCursor: string) => {
    if (loadingOlderRun || !project) return;
    olderRunAbortRef.current?.abort();
    const controller = new AbortController();
    olderRunAbortRef.current = controller;
    setLoadingOlderRun(true);
    setOlderRunError(null);
    capturePrependAnchor();
    try {
      const actParams = new URLSearchParams({
        project,
        run: targetRunId,
        epoch: "all",
        mode: "history",
        kind: "all",
        before: beforeCursor,
        limit: "250",
      });
      const actPayload = await requestActivity(actParams, controller.signal);
      if (controller.signal.aborted) return;
      const earlierBlocks = Array.isArray(actPayload.blocks) ? actPayload.blocks : [];
      setLoadedOlderRuns(prev =>
        prev.map(entry => {
          if (entry.runId !== targetRunId) return entry;
          const seenIds = new Set(entry.blocks.map(b => b.id));
          const dedupedEarlier = earlierBlocks.filter(b => !seenIds.has(b.id));
          return {
            ...entry,
            blocks: [...dedupedEarlier, ...entry.blocks],
            before: typeof actPayload.before === "string" ? actPayload.before : null,
            hasMore: Boolean(actPayload.hasMore && actPayload.before && dedupedEarlier.length > 0),
          };
        }),
      );
    } catch (cause) {
      if (controller.signal.aborted) return;
      prependScrollAnchorRef.current = null;
      setOlderRunError(cause instanceof Error ? cleanErrorMessage(cause.message) : t("olderRunLoadFailed"));
    } finally {
      if (olderRunAbortRef.current === controller) {
        setLoadingOlderRun(false);
      }
    }
  };

  const loadOlderRunSegment = async (
    upToRunId?: string,
    options?: {
      preserveScroll?: boolean;
      evidence?: { targetRunId: string; call?: string; image?: string };
    },
  ) => {
    if (loadingOlderRun || !project) return;
    olderRunAbortRef.current?.abort();
    const controller = new AbortController();
    olderRunAbortRef.current = controller;
    setLoadingOlderRun(true);
    setOlderRunError(null);
    if (options?.preserveScroll !== false) {
      capturePrependAnchor();
    } else {
      prependScrollAnchorRef.current = null;
    }
    try {
      const existingIds = new Set([data.run, ...loadedOlderRuns.map(r => r.runId)]);
      const toFetch: string[] = [];
      if (upToRunId) {
        const startIdx = runs.findIndex(r => r.id === earliestLoadedRunId);
        const endIdx = runs.findIndex(r => r.id === upToRunId);
        if (startIdx >= 0 && endIdx > startIdx) {
          for (let i = startIdx + 1; i <= endIdx; i++) {
            if (!existingIds.has(runs[i].id)) toFetch.push(runs[i].id);
          }
        } else if (!existingIds.has(upToRunId)) {
          toFetch.push(upToRunId);
        }
      } else if (nextOlderRun && !existingIds.has(nextOlderRun.id)) {
        toFetch.push(nextOlderRun.id);
      }

      if (toFetch.length === 0) return;
      const fetched = await Promise.all(
        toFetch.map(id => fetchHistoricalRun(id, controller.signal, options?.evidence)),
      );
      if (controller.signal.aborted) return;
      // fetched is newest-to-oldest; reverse so loadedOlderRuns stays chronological (oldest first)
      const chronologicalFetched = [...fetched].reverse();
      setLoadedOlderRuns(prev => {
        const merged = [...chronologicalFetched, ...prev];
        const seen = new Set<string>();
        return merged.filter(item => {
          if (seen.has(item.runId)) return false;
          seen.add(item.runId);
          return true;
        });
      });
    } catch (cause) {
      if (controller.signal.aborted) return;
      prependScrollAnchorRef.current = null;
      setOlderRunError(cause instanceof Error ? cleanErrorMessage(cause.message) : t("olderRunLoadFailed"));
    } finally {
      if (olderRunAbortRef.current === controller) {
        setLoadingOlderRun(false);
      }
    }
  };

  const loadNextUpwardHistory = () => {
    if (feed.loading || feed.loadingOlder || loadingOlderRun || isJumpingRef.current) return;
    if (loadedOlderRuns.length === 0 && feed.hasMore) {
      capturePrependAnchor();
      void feed.earlier();
      return;
    }
    if (earliestOlderRun?.hasMore && earliestOlderRun.before) {
      void loadEarlierBlocksOfOlderRun(earliestOlderRun.runId, earliestOlderRun.before);
      return;
    }
    if (nextOlderRun) {
      void loadOlderRunSegment();
      return;
    }
    if (feed.hasMore) {
      capturePrependAnchor();
      void feed.earlier();
    }
  };

  const allCalls = useMemo(
    () => [...loadedOlderRuns.flatMap(r => r.data.calls), ...data.calls],
    [loadedOlderRuns, data.calls],
  );

  const poolEventsById = useMemo(
    () => new Map((poolSnapshot?.events ?? []).map(item => [item.id, item])),
    [poolSnapshot],
  );
  const pendingOutboundCount =
    poolSnapshot?.summary.pendingOutbound ?? live?.eventPool?.pendingOutbound ?? 0;
  const pendingInboundCount =
    poolSnapshot?.summary.pendingInbound ?? live?.eventPool?.pendingInbound ?? 0;

  const computedSegments = useMemo(() => {
    const allSegments: StreamSegment[] = [];
    // Determine the run immediately preceding the earliest loaded run in `runs` (if any) so we can show inter-run gap
    let prevEndedAt: string | null = nextOlderRun?.endedAt ?? nextOlderRun?.startedAt ?? null;

    for (const older of loadedOlderRuns) {
      const olderInfo = runs.find(r => r.id === older.runId);
      const segs = buildCodexSegments(older.blocks, older.data.calls, older.data.observations, {
        runId: older.runId,
        cycles: older.data.cycles,
        fallbackStartedAt: olderInfo?.startedAt ?? older.data.updatedAt,
        prevEndedAt,
        isLatestRun: false,
        isAuto: false,
      });
      allSegments.push(...segs);
      prevEndedAt =
        older.data.cycles.at(-1)?.endedAt ??
        olderInfo?.endedAt ??
        older.blocks.at(-1)?.at ??
        older.data.updatedAt ??
        prevEndedAt;
    }

    const liveSyncedCycles =
      isAuto && live && "maxSeconds" in live && data.cycles.length > 0
        ? data.cycles.map((cycle, idx) =>
            idx === data.cycles.length - 1 ? { ...cycle, maxSeconds: live.maxSeconds ?? null } : cycle,
          )
        : data.cycles;

    const currentSegs = buildCodexSegments(feed.blocks, data.calls, data.observations, {
      runId: data.run,
      cycles: liveSyncedCycles,
      prevEndedAt,
      isLatestRun: isLiveRun,
      isAuto,
    });
    allSegments.push(...currentSegs);

    // Append workspace Event Pool items not yet projected in `feed.blocks` (e.g. standby/offline submissions)
    if (isLiveRun && !feed.historical && poolSnapshot?.events.length) {
      const seenPoolIds = new Set<string>();
      for (const seg of allSegments) {
        if (seg.kind === "user" && seg.poolEvent?.id) seenPoolIds.add(seg.poolEvent.id);
        if (seg.kind === "outbound_event") seenPoolIds.add(seg.event.id);
      }
      const runWindowStartMs = Date.parse(data.cycles[0]?.startedAt ?? data.updatedAt) - 60_000;
      for (const item of poolSnapshot.events) {
        if (seenPoolIds.has(item.id)) continue;
        // Show all pending events plus any offline/current-run events created at or after this run's window
        const createdMs = Date.parse(item.createdAt) || 0;
        if (item.status !== "pending" && item.runId && item.runId !== data.run && createdMs < runWindowStartMs) {
          continue;
        }
        const syntheticBlock: ActivityBlock = {
          id: `pool-live:${item.id}`,
          kind: "text",
          at: item.createdAt,
          title: item.direction === "inbound" ? (item.kind === "reply" ? "Reply" : "Event") : "Help Request",
          text: item.text,
          status: "complete",
          createdRevision: item.seq,
          revision: item.seq,
        };
        if (item.direction === "inbound") {
          allSegments.push({
            kind: "user",
            id: syntheticBlock.id,
            block: syntheticBlock,
            text: item.text,
            mode: "event",
            poolEvent: item,
          });
        } else {
          allSegments.push({
            kind: "outbound_event",
            id: syntheticBlock.id,
            block: syntheticBlock,
            event: item,
          });
        }
      }
    }

    return allSegments;
  }, [loadedOlderRuns, runs, nextOlderRun, feed.blocks, feed.historical, data.calls, data.observations, data.run, data.cycles, data.updatedAt, isLiveRun, isAuto, live, poolSnapshot]);

  if (computedSegments.length > 0) {
    cachedSegmentsRef.current = { run: data.run, segments: computedSegments };
  }
  const segments =
    computedSegments.length === 0 && feed.loading && cachedSegmentsRef.current.run === data.run
      ? cachedSegmentsRef.current.segments
      : computedSegments;

  const programmaticScrollUntilRef = useRef(0);
  const lastJumpedSeqRef = useRef<number | null>(null);

  // Preserve scroll position when prepending earlier history or older run segments
  useLayoutEffect(() => {
    const anchor = prependScrollAnchorRef.current;
    const el = streamRef.current;
    if (!anchor || !el) return;
    const delta = el.scrollHeight - anchor.scrollHeight;
    if (delta !== 0) {
      programmaticScrollUntilRef.current = Date.now() + 300;
      el.scrollTop = Math.max(0, anchor.scrollTop + delta);
    }
    prependScrollAnchorRef.current = null;
  }, [segments.length, feed.blocks.length, loadedOlderRuns.length]);

  const scrollToBottom = () => {
    if (feed.historical) {
      feed.latest();
    }
    isJumpingRef.current = false;
    onClearJumpTarget?.();
    onActiveSegmentChange?.("");
    const el = streamRef.current;
    if (!el) return;
    programmaticScrollUntilRef.current = Date.now() + 700;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance > 2200) {
      el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 520);
      requestAnimationFrame(() => {
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      });
    } else {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
    setAtBottom(true);
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
      loadNextUpwardHistory();
    }
  }, [
    segments.length,
    feed.loading,
    feed.loadingOlder,
    loadingOlderRun,
    olderRunError,
    hasMoreUpwardHistory,
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
    programmaticScrollUntilRef.current = Date.now() + 1800;
    setAtBottom(false);

    const [targetRunId, targetEpoch] = jumpTarget.value.split("#");
    const runAlreadyLoaded =
      !targetRunId ||
      targetRunId === data.run ||
      loadedOlderRuns.some(r => r.runId === targetRunId);

    if (!runAlreadyLoaded) {
      if (!loadingOlderRun) {
        void loadOlderRunSegment(targetRunId, {
          preserveScroll: false,
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
      onActiveSegmentChange?.(jumpTarget.value);
      if (jumpTarget.call || jumpTarget.image) {
        const ownerData =
          targetRunId === data.run
            ? data
            : (loadedOlderRuns.find(r => r.runId === targetRunId)?.data ?? data);
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
        openDock();
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
          container.scrollTo({ top: refinedTop, behavior: "smooth" });
        });
      } else {
        container.scrollTo({ top: rawTargetTop, behavior: "smooth" });
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
    loadedOlderRuns,
    loadingOlderRun,
    olderRunError,
  ]);

  // Keep scrolled to bottom when new blocks arrive while following
  useLayoutEffect(() => {
    const el = streamRef.current;
    if (!el || !atBottom || feed.historical || isJumpingRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [segments.length, feed.blocks.length, loadedOlderRuns.length, atBottom, feed.historical]);

  const handleScroll = () => {
    const el = streamRef.current;
    if (!el) return;
    if (Date.now() < programmaticScrollUntilRef.current) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nextAtBottom = distance < 48;
    setAtBottom(nextAtBottom);

    if (nextAtBottom) {
      onActiveSegmentChange?.("");
    } else if (onActiveSegmentChange) {
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
          onActiveSegmentChange(divRunId);
        } else if (divRunId === data.run && data.cycles.length > 1 && divEpoch) {
          const isLatestCycle = data.cycles.at(-1)?.epoch === divEpoch;
          onActiveSegmentChange(isLatestCycle ? "" : `${divRunId}#${divEpoch}`);
        } else {
          onActiveSegmentChange("");
        }
      }
    }

    if (el.scrollTop < 280 && !olderRunError && hasMoreUpwardHistory) {
      loadNextUpwardHistory();
    }
  };

  const handleInspectBlock = (runId: string, block: ActivityBlock, siblingSteps: ActivityBlock[] = []) => {
    const ownerCalls =
      runId === data.run
        ? data.calls
        : (loadedOlderRuns.find(r => r.runId === runId)?.data.calls ?? allCalls);
    const matchedCall = resolveCallForTurn(block, siblingSteps, ownerCalls);
    const isDeselecting = inspectedTurn?.blockId === block.id;
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
    if (!isDeselecting) openDock();
    onSelectBlock?.(block);
  };

  const handleInspectInput = (runId: string, segId: string, call?: Call, imageId?: string, at?: string) => {
    const isDeselecting =
      inspectedTurn?.blockId === segId && inspectedTurn?.imageId === (imageId ?? null);
    setInspectedTurn(
      isDeselecting
        ? null
        : {
            runId,
            blockId: segId,
            callId: call?.id ?? null,
            imageId: imageId ?? null,
            at: at ?? call?.at ?? data.updatedAt,
          },
    );
    if (!isDeselecting) openDock();
  };

  const inspectedRunData =
    inspectedTurn && inspectedTurn.runId !== data.run
      ? (loadedOlderRuns.find(r => r.runId === inspectedTurn.runId)?.data ?? data)
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
  const statusAnchorMs = activeHostOverride
    ? hostStatusOverride!.appliedAtMs
    : Date.parse(data.updatedAt);
  const updatedDeltaSec =
    isLiveRun && isAuto && refresh && Number.isFinite(statusAnchorMs)
      ? Math.max(0, Math.min(15, Math.floor((nowMs - statusAnchorMs) / 1000)))
      : 0;
  const baseCycleElapsed =
    isAuto && activeMaxSeconds != null && typeof live?.remainingSeconds === "number"
      ? Math.max(0, activeMaxSeconds - live.remainingSeconds)
      : isAuto && latestCycle?.startedAt && Number.isFinite(Date.parse(latestCycle.startedAt))
        ? Math.max(0, Math.floor((statusAnchorMs - Date.parse(latestCycle.startedAt)) / 1000))
        : (latestCycleDurationSeconds ?? elapsedSeconds);
  const cycleElapsedSeconds =
    activeMaxSeconds != null
      ? Math.min(activeMaxSeconds, baseCycleElapsed + updatedDeltaSec)
      : baseCycleElapsed + updatedDeltaSec;
  const liveRemainingSeconds =
    isAuto && typeof live?.remainingSeconds === "number"
      ? Math.max(0, Math.round(live.remainingSeconds) - updatedDeltaSec)
      : isAuto && activeMaxSeconds != null
        ? Math.max(0, Math.round(activeMaxSeconds - cycleElapsedSeconds))
        : null;
  const displayPhaseElapsedMs =
    phaseElapsedMs != null ? phaseElapsedMs + updatedDeltaSec * 1000 : null;
  const budgetRatio =
    activeMaxSeconds != null && activeMaxSeconds > 0
      ? Math.min(100, Math.round((cycleElapsedSeconds / activeMaxSeconds) * 100))
      : 0;

  const applyLiveStopTimer = async (seconds: number | null) => {
    if (!project || !workspace) return;
    const res = await sendRuntimeControl(project, workspace, {
      action: "auto_budget",
      seconds,
      runId: data.run,
      expectedEpoch: live?.epoch ?? undefined,
    });
    const record = asRecord(res);
    const status = asRecord(record?.status) ?? (typeof record?.mode === "string" ? record : null);
    if (status) {
      setHostStatusOverride({
        project,
        run: data.run,
        baseUpdatedAt: data.updatedAt,
        appliedAtMs: Date.now(),
        status,
      });
    }
    onUpdated();
  };

  const extendLiveStopTimer = async (deltaSeconds: number) => {
    if (!project || !workspace) return;
    let baseRemaining = liveRemainingSeconds ?? 0;
    try {
      const fresh = await sendRuntimeControl(project, workspace, { action: "status" });
      const freshRec = asRecord(fresh);
      const freshStatus =
        asRecord(freshRec?.status) ?? (typeof freshRec?.mode === "string" ? freshRec : null);
      if (typeof freshStatus?.remainingSeconds === "number") {
        baseRemaining = Math.max(0, freshStatus.remainingSeconds);
      }
    } catch {
      // Fall back to local remaining estimate if status read fails transiently
    }
    await applyLiveStopTimer(Math.max(60, Math.round(baseRemaining + deltaSeconds)));
  };

  const stateTitle = !isLiveRun
    ? t("stateSnapshot")
    : !hostOnline
      ? t("stateStandby")
      : consolidating
        ? t("stateConsolidating")
        : isAuto
          ? thinking
            ? t("stateAutoThinking")
            : t("stateAutoIdle")
          : t("stateManual");

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
              title={stateTitle}
            >
              <PixelMark
                size={14}
                className="codex-status-mark"
                state={!isLiveRun ? "idle" : !hostOnline ? "waiting" : consolidating || (isAuto && thinking) ? "reasoning" : "idle"}
                filled={hostOnline && !isAuto}
              />
              <span className="codex-status-text">{stateTitle}</span>
            </span>
            {phaseLabel && (
              <span
                className="codex-phase-inline codex-live-phase"
                title={`${phaseLabel}${displayPhaseElapsedMs != null ? ` ${Math.max(0, Math.round(displayPhaseElapsedMs / 1000))}s` : ""}`}
              >
                {phaseLabel}
                {displayPhaseElapsedMs != null ? ` ${Math.max(0, Math.round(displayPhaseElapsedMs / 1000))}s` : ""}
              </span>
            )}
            {isLiveRun && pendingOutboundCount > 0 && (
              <button
                type="button"
                className="codex-pool-header-pill"
                data-tone="outbound"
                onClick={() => {
                  const firstPending = (poolSnapshot?.events ?? []).find(
                    item => item.direction === "outbound" && item.status === "pending",
                  );
                  if (firstPending) {
                    setReplyTarget(firstPending);
                    setReplyAutoResumeDefault(Boolean(firstPending.pauseRequested));
                  }
                  scrollToBottom();
                }}
              >
                <span>🆘</span>
                <span>{t("poolOutboundBadge").replace("{count}", String(pendingOutboundCount))}</span>
              </button>
            )}
            {isLiveRun && pendingInboundCount > 0 && (
              <span className="codex-pool-header-pill" data-tone="inbound">
                <span>📥</span>
                <span>{t("poolInboundBadge").replace("{count}", String(pendingInboundCount))}</span>
              </span>
            )}
          </div>

          <div className="codex-thread-actions">
            {runPicker && <div className="codex-thread-run-picker">{runPicker}</div>}
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

        {/* Scrollable Chat Stream + Safely Anchored Scroll-to-Bottom Button */}
        <div className="codex-chat-scroll-stage">
          {jumpTarget && lastJumpedSeqRef.current !== jumpTarget.seq && jumpTarget.value && loadingOlderRun && (
            <div className="codex-jump-toast" role="status">
              <span className="codex-thinking-dot" />
              <span>{t("locatingSegmentBanner")}</span>
            </div>
          )}
          <div ref={streamRef} className="codex-chat-scroll" onScroll={handleScroll}>
          <div className="codex-chat-column">
            {(feed.loadingOlder || loadingOlderRun || olderRunError) ? (
              <div className="codex-load-older">
                {olderRunError && !feed.loadingOlder && !loadingOlderRun ? (
                  <button
                    type="button"
                    className="codex-step-group-toggle"
                    onClick={() => {
                      setOlderRunError(null);
                      loadNextUpwardHistory();
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
              (loadedOlderRuns.length > 0 || segments.length > 6) && (
                <div className="codex-history-origin">
                  <span>{t("sessionBeginningReached")}</span>
                </div>
              )
            )}

            {segments.length === 0 ? (
              <div className="codex-empty-thread">
                <Bot className="size-8 text-muted-foreground/60" aria-hidden="true" />
                <h3>{t("emptyThreadTitle")}</h3>
                <p>{t("emptyThreadDesc")}</p>
                <div className="codex-starter-chips">
                  <button
                    type="button"
                    className="codex-starter-chip"
                    onClick={() => setWorkflowCommand({ mode: "start", prompt: t("presetExploreStartPrompt") })}
                  >
                    {t("presetExploreStart")}
                  </button>
                  <button
                    type="button"
                    className="codex-starter-chip"
                    onClick={() => setWorkflowCommand({ mode: "steer", prompt: t("presetEvalPrompt") })}
                  >
                    {t("presetEval")}
                  </button>
                  <button
                    type="button"
                    className="codex-starter-chip"
                    onClick={() => setWorkflowCommand({ mode: "steer", prompt: t("presetAdaptPrompt") })}
                  >
                    {t("presetAdapt")}
                  </button>
                </div>
              </div>
            ) : (
              segments.map((seg, segIdx) => {
                if (seg.kind === "session_divider") {
                  return (
                    <CodexSessionDivider
                      key={seg.id}
                      segment={seg}
                      highlighted={highlightedSegmentId === seg.id}
                    />
                  );
                }

                if (seg.kind === "user") {
                  const livePoolItem = seg.poolEvent ? (poolEventsById.get(seg.poolEvent.id) ?? seg.poolEvent) : undefined;
                  const isReply = livePoolItem?.kind === "reply";
                  const isRead = livePoolItem?.status === "handled";
                  return (
                    <article key={seg.id} id={seg.block.id} className="codex-turn-user">
                      <div className="codex-user-bubble" data-mode={seg.mode}>
                        {seg.mode !== "start" && (
                          <span className="codex-user-mode-tag">
                            {seg.mode === "steer"
                              ? "⚡ Steer"
                              : isReply
                                ? `↩ ${t("poolReplyBtn")}`
                                : `📥 ${t("deliveryEventPool")}`}
                          </span>
                        )}
                        {livePoolItem?.title && (
                          <strong className="codex-user-event-title">{livePoolItem.title}</strong>
                        )}
                        <p>{seg.text}</p>
                        {livePoolItem && (
                          <div className="codex-user-event-footer">
                            <span
                              className="codex-user-event-status"
                              data-read={isRead ? "true" : undefined}
                            >
                              {isRead ? `✓ ${t("poolStatusRead")}` : `⏳ ${t("poolStatusPending")}`}
                            </span>
                            <time dateTime={livePoolItem.createdAt}>{clockTime(livePoolItem.createdAt)}</time>
                          </div>
                        )}
                      </div>
                    </article>
                  );
                }

                if (seg.kind === "outbound_event") {
                  const liveEvent = poolEventsById.get(seg.event.id) ?? seg.event;
                  const isHelp = liveEvent.kind === "help_request";
                  const isPending = liveEvent.status === "pending";
                  return (
                    <article
                      key={seg.id}
                      id={seg.block.id}
                      className="codex-outbound-card"
                      data-kind={liveEvent.kind}
                      data-handled={!isPending ? "true" : undefined}
                      data-pool-stream-card={liveEvent.id}
                    >
                      <header className="codex-outbound-header">
                        <div className="codex-outbound-badges">
                          <span className="codex-outbound-badge">
                            {isHelp ? "🆘" : "📌"}{" "}
                            {isHelp ? t("poolHelpRequestBadge") : t("poolNoticeBadge")}
                          </span>
                          {liveEvent.pauseRequested && (
                            <span className="codex-outbound-paused">{t("poolPausedTag")}</span>
                          )}
                        </div>
                        <div className="codex-outbound-meta">
                          <span
                            className="codex-outbound-status"
                            data-pending={isPending ? "true" : undefined}
                          >
                            {isPending ? `● ${t("poolStatusAwaitingHuman")}` : `✓ ${t("poolStatusHandled")}`}
                          </span>
                          <time dateTime={liveEvent.createdAt}>{clockTime(liveEvent.createdAt)}</time>
                        </div>
                      </header>
                      {liveEvent.title && <h4 className="codex-outbound-title">{liveEvent.title}</h4>}
                      <p className="codex-outbound-body">{liveEvent.text}</p>
                      {isLiveRun && isPending && (
                        <div className="codex-outbound-actions">
                          <button
                            type="button"
                            className="codex-pool-btn"
                            data-variant={hostOnline && !isAuto && !consolidating ? undefined : "primary"}
                            onClick={() => {
                              setReplyTarget(liveEvent);
                              setReplyAutoResumeDefault(false);
                            }}
                          >
                            <CornerUpLeft className="size-3" aria-hidden="true" />
                            <span>{t("poolReplyBtn")}</span>
                          </button>
                          {hostOnline && !isAuto && !consolidating && (
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
                              onClick={() => {
                                void mutateEventPool(project, workspace, {
                                  action: "ack",
                                  ids: [liveEvent.id],
                                })
                                  .then(res => {
                                    setPoolSnapshot(res.snapshot);
                                    if (res.hostStatus) {
                                      setHostStatusOverride({
                                        project,
                                        run: data.run,
                                        baseUpdatedAt: data.updatedAt,
                                        appliedAtMs: Date.now(),
                                        status: res.hostStatus,
                                      });
                                    }
                                    if (replyTarget?.id === liveEvent.id) {
                                      setReplyTarget(null);
                                    }
                                    onUpdated();
                                  })
                                  .catch(() => {});
                              }}
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
                      project={project}
                      run={segRunId}
                      call={seg.call}
                      observations={seg.observations}
                      bgBlock={seg.bgBlock}
                      at={seg.at}
                      isSelected={isInputSelected}
                      onSelect={imageId => handleInspectInput(segRunId, seg.id, seg.call, imageId, seg.at)}
                      onOpenReplayAt={onOpenReplayAt}
                    />
                  );
                }

                const paragraphs = seg.responseText
                  ? seg.responseText.split(/\n{2,}/).filter(Boolean)
                  : [];
                const isLastSegment = segIdx === segments.length - 1;

                return (
                  <article key={seg.id} id={seg.responseBlock?.id} className="codex-turn-assistant">
                    <CodexStepGroup
                      steps={seg.steps}
                      forceExpanded={showAllSteps}
                      defaultOpen={paragraphs.length === 0 && isLastSegment}
                      selectedBlock={activeBlockId}
                      onSelect={step => handleInspectBlock(seg.runId || data.run, step, seg.steps)}
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

          {/* Floating Scroll-to-Bottom Button (safely anchored inside scroll stage above composer) */}
          {(!atBottom || feed.historical) && (
            <button
              type="button"
              className="codex-scroll-bottom-btn"
              aria-label={t("scrollToBottomAria")}
              onClick={scrollToBottom}
            >
              <ArrowDown className="size-4" aria-hidden="true" />
            </button>
          )}
        </div>

        {/* Bottom Floating Pill Composer */}
        <ShioriComposer
          project={project}
          workspace={workspace}
          data={data}
          isLiveRun={isLiveRun}
          hostStatusOverride={activeHostOverride}
          onHostStatusChange={status =>
            setHostStatusOverride({
              project,
              run: data.run,
              baseUpdatedAt: data.updatedAt,
              appliedAtMs: Date.now(),
              status,
            })
          }
          activeModelOverride={activeModelOverride}
          onModelChange={nextModel =>
            setModelOverride({
              project,
              baseServerModel: serverModel,
              model: nextModel,
            })
          }
          liveRemainingSeconds={liveRemainingSeconds}
          onApplyLiveTimer={applyLiveStopTimer}
          onExtendLiveTimer={extendLiveStopTimer}
          poolSnapshot={poolSnapshot}
          replyTarget={replyTarget}
          replyAutoResumeDefault={replyAutoResumeDefault}
          onSelectReplyTarget={(event, autoResume) => {
            setReplyTarget(event);
            setReplyAutoResumeDefault(autoResume);
          }}
          onPoolMutated={(snapshot, hostStatus) => {
            setPoolSnapshot(snapshot);
            if (hostStatus) {
              setHostStatusOverride({
                project,
                run: data.run,
                baseUpdatedAt: data.updatedAt,
                appliedAtMs: Date.now(),
                status: hostStatus,
              });
            }
          }}
          externalMode={workflowCommand?.mode ?? null}
          externalDraft={workflowCommand?.prompt ?? null}
          onExternalConsumed={() => setWorkflowCommand(null)}
          onReturnLatest={onReturnLatest}
          onUpdated={onUpdated}
        />
      </section>

      {/* ── RIGHT WORKBENCH DOCK: LIVE VIEWPORT + COMPACT HOST OPS + TELEMETRY ── */}
      {dockOpen && isOverlayDock && (
        <div
          className="codex-dock-backdrop"
          data-dock-backdrop
          aria-hidden="true"
          onClick={closeDock}
        />
      )}
      {dockOpen && (
        <aside
          className="codex-right-dock"
          data-overlay={isOverlayDock ? "true" : undefined}
          aria-label={t("stageColumnAria")}
        >
          <header className="codex-dock-header">
            <span className="codex-dock-header-title">{t("dockHeaderTitle")}</span>
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
          <div className="codex-dock-body">
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
                          onApplyTimer={applyLiveStopTimer}
                          onExtendTimer={extendLiveStopTimer}
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

                {isAuto && activeMaxSeconds != null && liveRemainingSeconds != null && (
                  <div
                    className="shiori-budget-bar"
                    role="progressbar"
                    aria-valuenow={budgetRatio}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    {Array.from({ length: BUDGET_BLOCKS }, (_, index) => {
                      const lit = Math.round((budgetRatio / 100) * BUDGET_BLOCKS);
                      return <i key={index} data-on={index < lit || undefined} data-head={(index === lit - 1 && lit < BUDGET_BLOCKS) || undefined} />;
                    })}
                  </div>
                )}

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
                      <dd className="font-mono">{data.run}</dd>
                    </div>
                    <div className="codex-provenance-row">
                      <dt>{t("provEpoch")}</dt>
                      <dd className="font-mono">{data.selectedEpoch ?? "—"}</dd>
                    </div>
                  </dl>
                </details>
              </div>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}
