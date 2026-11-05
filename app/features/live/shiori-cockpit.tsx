"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  Activity,
  ArrowDown,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  CornerDownLeft,
  Eye,
  EyeOff,
  FileText,
  Film,
  FlaskConical,
  Gauge,
  PanelRight,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Square,
  Terminal,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { useTranslations } from "@/lib/locale";
import type { ActivityBlock } from "@/features/live/activity-feed-model";
import { activityContentView, printable } from "@/features/live/activity-feed-model";
import type { ActivityFeedData } from "@/features/live/use-activity-feed";
import { clockTime } from "@/features/live/run-visuals";
import type { Call, RunData } from "@/lib/types";
import "@/features/live/activity-feed.css";

export type RuntimeControlAction =
  | { action: "status" }
  | { action: "auto_on"; message?: string; runId?: string; expectedEpoch?: string | null }
  | { action: "auto_off"; runId?: string; expectedEpoch?: string | null }
  | { action: "steer"; message: string; delivery?: "steer" | "follow_up"; runId?: string; expectedEpoch?: string | null }
  | { action: "consolidate"; seconds?: number; runId?: string; expectedEpoch?: string | null }
  | { action: "perception_inject"; enabled: boolean; runId?: string }
  | { action: "perception_reload"; runId?: string };

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

function formatDurationCompact(secondsTotal: number | null | undefined): string {
  if (secondsTotal == null || !Number.isFinite(secondsTotal)) return "—";
  const clamped = Math.max(0, Math.round(secondsTotal));
  const m = Math.floor(clamped / 60);
  const s = clamped % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isUserMessageBlock(block: ActivityBlock): boolean {
  const record = asRecord(block.data);
  if (block.kind === "text" && record?.role === "user") return true;
  if (block.kind === "system" && block.title === "user_message") return true;
  return false;
}

function isAssistantTextBlock(block: ActivityBlock): boolean {
  const record = asRecord(block.data);
  return block.kind === "text" && block.source?.component === "shiori" && record?.role !== "user";
}

function extractReadableText(block: ActivityBlock): string {
  const record = asRecord(block.data);
  if (typeof record?.text === "string" && record.text.trim()) {
    return record.text.trim();
  }
  if (typeof block.text === "string" && block.text.trim()) {
    return block.text.trim();
  }
  return block.title;
}

function summarizeStepBlock(block: ActivityBlock): { badge: string; detail: string } {
  const args = asRecord(block.tool?.args) ?? asRecord(block.data);
  const titleLower = block.title.toLowerCase();
  const fallbackText = block.text?.trim().split("\n")[0]?.slice(0, 96) || block.title;
  if (block.kind === "tool") {
    if (titleLower === "bash" || titleLower.endsWith(":bash")) {
      const cmd = typeof args?.command === "string" ? args.command.trim() : fallbackText;
      return { badge: "$ bash", detail: cmd || "bash" };
    }
    if (titleLower === "observe" || titleLower.includes("observe")) {
      return { badge: "👁 observe", detail: block.tool?.intent || fallbackText || "Capture frame" };
    }
    if (titleLower.includes("capability") || typeof args?.capability === "string") {
      return {
        badge: "⚡ capability",
        detail: (typeof args?.capability === "string" ? args.capability : fallbackText) || block.title,
      };
    }
    return { badge: `⚙ ${block.title}`, detail: block.tool?.intent || fallbackText };
  }
  if (block.kind === "thinking") {
    return { badge: "🧠 thinking", detail: fallbackText };
  }
  if (block.kind === "system") {
    return { badge: "● system", detail: fallbackText };
  }
  return { badge: block.source?.component ?? "step", detail: fallbackText };
}

type StreamSegment =
  | { kind: "user"; id: string; block: ActivityBlock; text: string; mode: string }
  | {
      kind: "turn";
      id: string;
      steps: ActivityBlock[];
      responseBlock: ActivityBlock | null;
      responseText: string | null;
    };

/**
 * Groups raw ActivityBlocks into Codex-style conversational segments:
 * - User bubbles (`user_message`)
 * - Collapsed intermediate step groups (`上 N 条消息 / 执行步骤 >`) paired with Shiori's readable prose response
 */
function buildCodexSegments(rawBlocks: ActivityBlock[]): StreamSegment[] {
  const blocks = rawBlocks.filter(block => block.kind !== "diagnostic");
  const segments: StreamSegment[] = [];
  let pendingSteps: ActivityBlock[] = [];

  const synthesizeAutonomousNarrative = (steps: ActivityBlock[]): { block: ActivityBlock; text: string } | null => {
    // 1. Prefer a substantial thinking block (>= 60 chars beyond a short **heading**)
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i].kind === "thinking") {
        const text = extractReadableText(steps[i]);
        const stripped = text.replace(/^\*\*[^*\n]+\*\*\s*/, "").trim();
        if (stripped.length >= 40 || text.length >= 90) {
          return { block: steps[i], text };
        }
      }
    }

    // 2. Otherwise combine the latest **Thinking Heading** with recent tool.intent descriptions
    const latestThinking = [...steps].reverse().find(s => s.kind === "thinking");
    const intents = steps
      .filter(s => s.kind === "tool" && typeof s.tool?.intent === "string" && s.tool.intent.trim())
      .map(s => s.tool!.intent!.trim());
    const uniqueIntents = [...new Set(intents)].slice(-3);

    if (latestThinking && uniqueIntents.length > 0) {
      const heading = extractReadableText(latestThinking);
      return {
        block: latestThinking,
        text: `${heading} — ${uniqueIntents.join("；")}.`,
      };
    }
    if (uniqueIntents.length > 0) {
      const lastTool = [...steps].reverse().find(s => s.kind === "tool") ?? steps[steps.length - 1];
      return {
        block: lastTool,
        text: uniqueIntents.join("；") + ".",
      };
    }
    if (latestThinking) {
      return {
        block: latestThinking,
        text: extractReadableText(latestThinking),
      };
    }
    return null;
  };

  const flushTurn = (explicitResponse?: ActivityBlock) => {
    if (explicitResponse) {
      segments.push({
        kind: "turn",
        id: explicitResponse.id,
        steps: pendingSteps,
        responseBlock: explicitResponse,
        responseText: extractReadableText(explicitResponse),
      });
      pendingSteps = [];
      return;
    }
    if (pendingSteps.length === 0) return;

    const synthesized = synthesizeAutonomousNarrative(pendingSteps);
    if (synthesized) {
      const otherSteps = pendingSteps.filter(item => item.id !== synthesized.block.id);
      segments.push({
        kind: "turn",
        id: synthesized.block.id,
        steps: otherSteps,
        responseBlock: synthesized.block,
        responseText: synthesized.text,
      });
    } else {
      segments.push({
        kind: "turn",
        id: pendingSteps[pendingSteps.length - 1].id,
        steps: pendingSteps,
        responseBlock: null,
        responseText: null,
      });
    }
    pendingSteps = [];
  };

  for (const block of blocks) {
    if (isUserMessageBlock(block)) {
      flushTurn();
      const record = asRecord(block.data);
      segments.push({
        kind: "user",
        id: block.id,
        block,
        text: extractReadableText(block),
        mode: typeof record?.mode === "string" ? record.mode : "start",
      });
      continue;
    }

    if (isAssistantTextBlock(block)) {
      flushTurn(block);
      continue;
    }

    pendingSteps.push(block);
    // Group autonomous loop steps into readable ~6-step conversational turns
    if (
      pendingSteps.length >= 6 &&
      block.kind === "tool" &&
      (pendingSteps.some(item => item.kind === "thinking") || Boolean(block.tool?.intent))
    ) {
      flushTurn();
    }
  }

  flushTurn();
  return segments;
}

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

function CodexStepGroup({
  steps,
  forceExpanded,
  selectedBlock,
  onSelect,
}: {
  steps: ActivityBlock[];
  forceExpanded: boolean;
  selectedBlock?: string;
  onSelect?: (block: ActivityBlock) => void;
}) {
  const t = useTranslations("shioriCockpit");
  const [open, setOpen] = useState(false);
  const [expandedStepId, setExpandedStepId] = useState<string | null>(null);
  const isExpanded = forceExpanded || open;

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

export function ShioriComposer({
  project,
  workspace,
  data,
  isLiveRun,
  hostStatusOverride,
  onHostStatusChange,
  perceptionInjectOverride,
  onPerceptionChange,
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
  perceptionInjectOverride?: boolean | null;
  onPerceptionChange?: (enabled: boolean) => void;
  externalMode?: "start" | "steer" | "follow_up" | null;
  externalDraft?: string | null;
  onExternalConsumed?(): void;
  onReturnLatest?(): void;
  onUpdated(): void;
}) {
  const t = useTranslations("shioriCockpit");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [draft, setDraft] = useState("");
  const [selectedTab, setSelectedTab] = useState<"start" | "steer" | "follow_up" | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSent, setLastSent] = useState<string | null>(null);
  const [localPerceptionInject, setLocalPerceptionInject] = useState<boolean | null>(null);
  const [localHostStatus, setLocalHostStatus] = useState<Record<string, unknown> | null>(null);

  const effectiveHost = (hostStatusOverride ?? localHostStatus ?? data.live) as (NonNullable<RunData["live"]> & {
    consolidating?: boolean;
    context?: { perceptionInjection?: boolean };
  }) | null;
  const control = data.lastControl;
  const runtimeMode =
    effectiveHost?.mode ?? (typeof control?.mode === "string" ? control.mode : "manual");
  const consolidating = Boolean(effectiveHost?.consolidating ?? control?.consolidating);
  const serverPerceptionInject =
    effectiveHost?.context?.perceptionInjection ?? control?.context?.perceptionInjection ?? true;
  const perceptionInject =
    perceptionInjectOverride ?? localPerceptionInject ?? serverPerceptionInject;
  const isAuto = runtimeMode === "auto";

  if (externalDraft != null || externalMode != null) {
    if (externalDraft != null && externalDraft !== draft) setDraft(externalDraft);
    if (externalMode != null && externalMode !== selectedTab) setSelectedTab(externalMode);
    onExternalConsumed?.();
    setTimeout(() => textareaRef.current?.focus(), 0);
  }

  const effectiveTab: "start" | "steer" | "follow_up" =
    selectedTab ?? (isAuto ? "steer" : "start");

  const cycleModeTab = () => {
    const order: Array<"start" | "steer" | "follow_up"> = ["start", "steer", "follow_up"];
    const next = order[(order.indexOf(effectiveTab) + 1) % order.length];
    setSelectedTab(next);
  };

  const applyReturnedStatus = (res: unknown) => {
    const status = asRecord(asRecord(res)?.status);
    if (status) {
      setLocalHostStatus(status);
      onHostStatusChange?.(status);
      const contextRec = asRecord(status.context);
      if (typeof contextRec?.perceptionInjection === "boolean") {
        setLocalPerceptionInject(contextRec.perceptionInjection);
        onPerceptionChange?.(contextRec.perceptionInjection);
      }
    }
  };

  const togglePerception = async () => {
    if (submitting || !project || !workspace) return;
    const next = !perceptionInject;
    setError(null);
    setLocalPerceptionInject(next);
    onPerceptionChange?.(next);
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(`ludens:perception-inject:${project}`, next ? "1" : "0");
      }
    } catch {
      // Ignore storage errors
    }
    try {
      const res = await sendRuntimeControl(project, workspace, {
        action: "perception_inject",
        enabled: next,
        runId: data.run,
      });
      applyReturnedStatus(res);
      onUpdated();
    } catch (cause) {
      if (!isHostOfflineError(cause)) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    }
  };

  const submitMessage = async (overrideText?: string) => {
    const text = (overrideText ?? draft).trim();
    if (submitting || !project || !workspace) return;
    if (effectiveTab !== "start" && !text) return;
    setSubmitting(true);
    setError(null);
    try {
      let res: unknown;
      if (effectiveTab === "steer" || effectiveTab === "follow_up") {
        try {
          res = await sendRuntimeControl(project, workspace, {
            action: "steer",
            message: text,
            delivery: effectiveTab,
            runId: data.run,
            expectedEpoch: effectiveHost?.epoch ?? undefined,
          });
        } catch (steerErr) {
          const msg = steerErr instanceof Error ? steerErr.message : String(steerErr);
          if (msg.includes("Auto loop is not active")) {
            res = await sendRuntimeControl(project, workspace, {
              action: "auto_on",
              ...(text ? { message: text } : {}),
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

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submitMessage();
    }
  };

  const presets = [
    { label: t("presetExploreStart"), prompt: t("presetExploreStartPrompt"), tab: "start" as const },
    { label: t("presetEval"), prompt: t("presetEvalPrompt"), tab: isAuto ? ("steer" as const) : ("start" as const) },
    { label: t("presetAdapt"), prompt: t("presetAdaptPrompt"), tab: "steer" as const },
    { label: t("presetMemory"), prompt: t("presetMemoryPrompt"), tab: "follow_up" as const },
  ];

  const modelShort = (data.manifest.model ?? t("deviceOnly")).replace(/^[^/]+\//, "");

  return (
    <div className="codex-composer-wrap" data-shiori-composer={effectiveTab}>
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

        <textarea
          ref={textareaRef}
          rows={2}
          className="codex-pill-textarea"
          placeholder={
            effectiveTab === "start"
              ? t("startPlaceholder")
              : effectiveTab === "steer"
                ? t("steerPlaceholder")
                : t("followUpPlaceholder")
          }
          value={draft}
          disabled={submitting || consolidating}
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
              onClick={() => setMenuOpen(prev => !prev)}
            >
              <Plus className="size-4" aria-hidden="true" />
            </button>

            {/* Codex-style Mode Pill (like "完全访问" in the ChatGPT/Codex desktop app) */}
            <button
              type="button"
              className="codex-access-pill"
              data-mode={effectiveTab}
              title={t("clickToSwitchMode")}
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
                  <CornerDownLeft className="size-3.5" aria-hidden="true" />
                  <span>{t("deliveryFollowUp")}</span>
                </>
              )}
              <ChevronDown className="size-3 opacity-70" aria-hidden="true" />
            </button>

            <button
              type="button"
              className="codex-subtle-pill"
              aria-pressed={perceptionInject}
              data-active={perceptionInject || undefined}
              title={t("perceptionInjectHint")}
              onClick={() => void togglePerception()}
            >
              {perceptionInject ? (
                <Eye className="size-3.5" aria-hidden="true" />
              ) : (
                <EyeOff className="size-3.5" aria-hidden="true" />
              )}
              <span>{perceptionInject ? t("injectOn") : t("injectOff")}</span>
            </button>
          </div>

          <div className="codex-pill-right">
            <span className="codex-model-label" title={data.manifest.model ?? undefined}>
              {modelShort}
            </span>

            <button
              type="button"
              className="codex-send-circle"
              disabled={submitting || consolidating || (effectiveTab !== "start" && !draft.trim())}
              title={
                effectiveTab === "steer"
                  ? t("sendSteer")
                  : effectiveTab === "follow_up"
                    ? t("sendFollowUp")
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
      {!error && lastSent && (
        <p className="codex-composer-feedback" role="status">
          ✓ {t("sentFeedback")}: <code>{lastSent.slice(0, 68)}</code>
        </p>
      )}
    </div>
  );
}

export function ShioriWorkbench({
  project,
  workspace,
  workspaceTitle,
  data,
  feed,
  isLiveRun,
  phaseLabel,
  phaseElapsedMs,
  selectedBlock,
  onSelectBlock,
  onUpdated,
  onOpenPerf,
  onOpenCaps,
  onOpenReplay,
  onReturnLatest,
  renderObservation,
  observationSlot,
}: {
  project: string;
  workspace: string | null;
  workspaceTitle?: string;
  data: RunData;
  feed: ActivityFeedData;
  isLiveRun: boolean;
  phaseLabel?: string | null;
  phaseElapsedMs?: number | null;
  selectedBlock?: string;
  onSelectBlock?: (block: ActivityBlock) => void;
  onUpdated(): void;
  onOpenPerf(): void;
  onOpenCaps(): void;
  onOpenReplay?(): void;
  onReturnLatest(): void;
  renderObservation?: (options: {
    call: Call | undefined;
    selectedImage: string | undefined;
    onSelectImage: (id: string) => void;
  }) => ReactNode;
  observationSlot: ReactNode;
}) {
  const t = useTranslations("shioriCockpit");
  const streamRef = useRef<HTMLDivElement | null>(null);
  const cachedSegmentsRef = useRef<{ run: string; segments: StreamSegment[] }>({
    run: "",
    segments: [],
  });
  const [showAllSteps, setShowAllSteps] = useState(false);
  const [dockOpen, setDockOpen] = useState(true);
  const [dockTab, setDockTab] = useState<"stage" | "tools" | "stats">("stage");
  const [atBottom, setAtBottom] = useState(true);
  const [busyTool, setBusyTool] = useState<string | null>(null);
  const [toolError, setToolError] = useState<string | null>(null);
  const [showStandbyHelper, setShowStandbyHelper] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [perceptionOverride, setPerceptionOverride] = useState<boolean | null>(null);
  const [hostStatusOverride, setHostStatusOverride] = useState<Record<string, unknown> | null>(null);
  const [inspectedTurn, setInspectedTurn] = useState<{
    blockId: string;
    callId: string | null;
    imageId: string | null;
    at: string;
  } | null>(null);
  const [workflowCommand, setWorkflowCommand] = useState<{
    mode: "start" | "steer" | "follow_up";
    prompt: string;
  } | null>(null);

  useEffect(() => {
    try {
      if (typeof window !== "undefined" && project) {
        const stored = window.localStorage.getItem(`ludens:perception-inject:${project}`);
        if (stored === "0") setPerceptionOverride(false);
        else if (stored === "1") setPerceptionOverride(true);
      }
    } catch {
      // Ignore storage errors
    }
  }, [project]);

  const live = (hostStatusOverride ?? data.live) as (NonNullable<RunData["live"]> & {
    remainingSeconds?: number | null;
    consolidating?: boolean;
    context?: { perceptionInjection?: boolean };
    queue?: { steering?: number; followUp?: number };
  }) | null;
  const control = data.lastControl;
  const hostOnline = Boolean(isLiveRun && (live || data.controlAllowed));
  const mode = live?.mode ?? (typeof control?.mode === "string" ? control.mode : "manual");
  const consolidating = Boolean(live?.consolidating ?? control?.consolidating);
  const thinking = Boolean(live?.thinking ?? control?.thinking);
  const serverPerceptionInject =
    live?.context?.perceptionInjection ?? control?.context?.perceptionInjection ?? true;
  const perceptionInject = perceptionOverride ?? serverPerceptionInject;
  const isAuto = mode === "auto";

  const computedSegments = useMemo(() => buildCodexSegments(feed.blocks), [feed.blocks]);
  if (computedSegments.length > 0) {
    cachedSegmentsRef.current = { run: data.run, segments: computedSegments };
  }
  const segments =
    computedSegments.length === 0 && feed.loading && cachedSegmentsRef.current.run === data.run
      ? cachedSegmentsRef.current.segments
      : computedSegments;

  // Keep scrolled to bottom when new blocks arrive while following
  useEffect(() => {
    const el = streamRef.current;
    if (!el || !atBottom) return;
    el.scrollTop = el.scrollHeight;
  }, [segments.length, feed.blocks.length, atBottom]);

  const handleScroll = () => {
    const el = streamRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAtBottom(distance < 48);
  };

  const scrollToBottom = () => {
    const el = streamRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setAtBottom(true);
  };

  const handleInspectBlock = (block: ActivityBlock, siblingSteps: ActivityBlock[] = []) => {
    const matchedCall = resolveCallForTurn(block, siblingSteps, data.calls);
    setInspectedTurn(prev =>
      prev?.blockId === block.id
        ? null
        : {
            blockId: block.id,
            callId: matchedCall?.id ?? null,
            imageId: null,
            at: block.at,
          },
    );
    setDockOpen(true);
    setDockTab("stage");
    onSelectBlock?.(block);
  };

  const toggleWorkbenchPerception = async () => {
    if (!project || !workspace) return;
    const next = !perceptionInject;
    setPerceptionOverride(next);
    setToolError(null);
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(`ludens:perception-inject:${project}`, next ? "1" : "0");
      }
    } catch {
      // Ignore storage errors
    }
    try {
      const res = await sendRuntimeControl(project, workspace, {
        action: "perception_inject",
        enabled: next,
        runId: data.run,
      });
      const confirmed = res?.status?.context?.perceptionInjection;
      if (typeof confirmed === "boolean") setPerceptionOverride(confirmed);
      onUpdated();
    } catch (cause) {
      if (!isHostOfflineError(cause)) {
        setToolError(cause instanceof Error ? cause.message : String(cause));
      }
    }
  };

  const runHostTool = async (key: string, command: RuntimeControlAction) => {
    if (!project || !workspace || busyTool) return;
    setBusyTool(key);
    setToolError(null);
    setShowStandbyHelper(false);
    try {
      const res = await sendRuntimeControl(project, workspace, command);
      const status = asRecord(asRecord(res)?.status);
      if (status) {
        setHostStatusOverride(status);
        const contextRec = asRecord(status.context);
        if (typeof contextRec?.perceptionInjection === "boolean") {
          setPerceptionOverride(contextRec.perceptionInjection);
        }
      }
      onUpdated();
    } catch (cause) {
      if (isHostOfflineError(cause)) {
        setShowStandbyHelper(true);
      } else {
        setToolError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      setBusyTool(null);
    }
  };

  const launchCmd = `ludens run --workspace ${workspace || "<workspace>"}`;
  const copyLaunchCommand = async () => {
    try {
      await navigator.clipboard.writeText(launchCmd);
      setCopiedCmd(true);
      setTimeout(() => setCopiedCmd(false), 2000);
    } catch {
      // Ignore clipboard failure
    }
  };

  const inspectedCall = inspectedTurn?.callId
    ? data.calls.find(c => c.id === inspectedTurn.callId)
    : undefined;
  const activeBlockId = inspectedTurn?.blockId ?? selectedBlock;

  const summary = data.summary;
  const budgetSeconds = Math.max(1, data.manifest.seconds || 1800);
  const elapsedSeconds = summary?.elapsedSeconds ?? 0;
  const budgetRatio = Math.min(100, Math.round((elapsedSeconds / budgetSeconds) * 100));

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
        <header className="codex-thread-header">
          <div className="codex-thread-title">
            <FileText className="size-4 text-muted-foreground shrink-0" aria-hidden="true" />
            <strong>Shiori · {workspaceTitle || project}</strong>
            <span className="codex-status-pill" data-tone={isAuto && hostOnline ? "auto" : hostOnline ? "manual" : "standby"}>
              <i className="codex-status-dot" />
              {stateTitle}
            </span>
            {phaseLabel && (
              <span className="codex-phase-inline">
                {phaseLabel}
                {phaseElapsedMs != null ? ` ${Math.max(0, Math.round(phaseElapsedMs / 1000))}s` : ""}
              </span>
            )}
          </div>

          <div className="codex-thread-actions">
            <button
              type="button"
              className="codex-header-btn"
              data-active={showAllSteps || undefined}
              onClick={() => setShowAllSteps(prev => !prev)}
            >
              {showAllSteps ? t("collapseStepsBtn") : t("expandAllStepsBtn")}
            </button>
            <button
              type="button"
              className="codex-header-btn"
              data-active={dockOpen || undefined}
              title={t("toggleDockHint")}
              onClick={() => setDockOpen(prev => !prev)}
            >
              <PanelRight className="size-4" aria-hidden="true" />
            </button>
          </div>
        </header>

        {/* Scrollable Chat Stream */}
        <div ref={streamRef} className="codex-chat-scroll" onScroll={handleScroll}>
          <div className="codex-chat-column">
            {feed.hasMore && (
              <div className="codex-load-older">
                <button
                  type="button"
                  className="codex-step-group-toggle"
                  disabled={feed.loadingOlder}
                  onClick={() => void feed.earlier()}
                >
                  <span>{feed.loadingOlder ? t("loadingOlder") : t("loadOlderMessages")}</span>
                  <ChevronRight className="size-3.5" aria-hidden="true" />
                </button>
              </div>
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
              segments.map(seg => {
                if (seg.kind === "user") {
                  return (
                    <article key={seg.id} className="codex-turn-user">
                      <div className="codex-user-bubble" data-mode={seg.mode}>
                        {seg.mode !== "start" && (
                          <span className="codex-user-mode-tag">
                            {seg.mode === "steer" ? "⚡ Steer" : "↳ Follow-up"}
                          </span>
                        )}
                        <p>{seg.text}</p>
                      </div>
                    </article>
                  );
                }

                const paragraphs = seg.responseText
                  ? seg.responseText.split(/\n{2,}/).filter(Boolean)
                  : [];
                const isTurnInspected = Boolean(
                  seg.responseBlock && activeBlockId === seg.responseBlock.id,
                );

                return (
                  <article key={seg.id} className="codex-turn-assistant">
                    <CodexStepGroup
                      steps={seg.steps}
                      forceExpanded={showAllSteps}
                      selectedBlock={activeBlockId}
                      onSelect={step => handleInspectBlock(step, seg.steps)}
                    />

                    {paragraphs.length > 0 && (
                      <div className="codex-assistant-prose">
                        {paragraphs.map((para, idx) => (
                          <p key={idx}>{renderInlineFormatting(para)}</p>
                        ))}
                        {seg.responseBlock && (
                          <div className="codex-prose-meta">
                            <button
                              type="button"
                              className="codex-trace-link"
                              data-active={isTurnInspected || undefined}
                              aria-pressed={isTurnInspected}
                              onClick={() => handleInspectBlock(seg.responseBlock!, seg.steps)}
                            >
                              {"{}"} {t("inspectTurnRecord")} · {clockTime(seg.responseBlock.at)}
                            </button>
                          </div>
                        )}
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

        {/* Floating Scroll-to-Bottom Button (just like ChatGPT/Codex) */}
        {!atBottom && (
          <button
            type="button"
            className="codex-scroll-bottom-btn"
            aria-label={t("scrollToBottomAria")}
            onClick={scrollToBottom}
          >
            <ArrowDown className="size-4" aria-hidden="true" />
          </button>
        )}

        {/* Bottom Floating Pill Composer */}
        <ShioriComposer
          project={project}
          workspace={workspace}
          data={data}
          isLiveRun={isLiveRun}
          hostStatusOverride={hostStatusOverride}
          onHostStatusChange={setHostStatusOverride}
          perceptionInjectOverride={perceptionInject}
          onPerceptionChange={setPerceptionOverride}
          externalMode={workflowCommand?.mode ?? null}
          externalDraft={workflowCommand?.prompt ?? null}
          onExternalConsumed={() => setWorkflowCommand(null)}
          onReturnLatest={onReturnLatest}
          onUpdated={onUpdated}
        />
      </section>

      {/* ── RIGHT WORKBENCH DOCK: LIVE VIEWPORT + TOOLS + SESSION STATS ── */}
      {dockOpen && (
        <aside className="codex-right-dock" aria-label={t("stageColumnAria")}>
          {/* Dock Top Browser-like Tab Bar */}
          <div className="codex-dock-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={dockTab === "stage"}
              className="codex-dock-tab"
              data-active={dockTab === "stage" || undefined}
              onClick={() => setDockTab("stage")}
            >
              <Eye className="size-3.5" aria-hidden="true" />
              <span>{t("dockTabStage")}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={dockTab === "tools"}
              className="codex-dock-tab"
              data-active={dockTab === "tools" || undefined}
              onClick={() => setDockTab("tools")}
            >
              <Wrench className="size-3.5" aria-hidden="true" />
              <span>{t("dockTabTools")}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={dockTab === "stats"}
              className="codex-dock-tab"
              data-active={dockTab === "stats" || undefined}
              onClick={() => setDockTab("stats")}
            >
              <Gauge className="size-3.5" aria-hidden="true" />
              <span>{t("dockTabStats")}</span>
            </button>
          </div>

          <div className="codex-dock-body">
            {/* Live Game / Device Viewport (Shown only in Stage tab so Tools/Stats tabs switch cleanly) */}
            {dockTab === "stage" && (
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
                      call: inspectedCall,
                      selectedImage: inspectedTurn?.imageId ?? undefined,
                      onSelectImage: id =>
                        setInspectedTurn(prev =>
                          prev
                            ? { ...prev, imageId: id }
                            : {
                                blockId: "manual-image",
                                callId: null,
                                imageId: id,
                                at: data.updatedAt,
                              },
                        ),
                    })
                  : observationSlot}
              </div>
            )}

            {/* Codex-style "工具 (Tools)" Action List */}
            {(dockTab === "stage" || dockTab === "tools") && (
              <div className="codex-dock-section">
                <h3 className="codex-dock-heading">{t("dockToolsTitle")}</h3>
                {toolError && (
                  <p className="codex-tool-err" role="alert">
                    {toolError}
                  </p>
                )}
                {showStandbyHelper && (
                  <div className="codex-standby-card" role="status">
                    <p>{t("hostStandbyHint")}</p>
                    <div className="codex-standby-cmd">
                      <Terminal className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <code>{launchCmd}</code>
                      <button
                        type="button"
                        className="codex-copy-btn"
                        onClick={() => void copyLaunchCommand()}
                      >
                        {copiedCmd ? (
                          <>
                            <Check className="size-3" aria-hidden="true" />
                            <span>{t("copiedLaunchCmd")}</span>
                          </>
                        ) : (
                          <>
                            <Copy className="size-3" aria-hidden="true" />
                            <span>{t("copyLaunchCmd")}</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                )}
                <div className="codex-tool-list">
                  <button
                    type="button"
                    className="codex-tool-row"
                    disabled={busyTool !== null}
                    onClick={() =>
                      void runHostTool(
                        isAuto ? "auto_off" : "auto_on",
                        isAuto
                          ? { action: "auto_off", runId: data.run, expectedEpoch: live?.epoch ?? undefined }
                          : { action: "auto_on", runId: data.run, expectedEpoch: live?.epoch ?? null },
                      )
                    }
                  >
                    <span className="codex-tool-row-left">
                      {isAuto ? (
                        <Square className="size-4 text-destructive" aria-hidden="true" />
                      ) : (
                        <Play className="size-4 text-primary" aria-hidden="true" />
                      )}
                      <span>{isAuto ? t("handbackStop") : t("startAutoLoop")}</span>
                    </span>
                    <kbd className="codex-tool-kbd">{isAuto ? "AUTO" : "IDLE"}</kbd>
                  </button>

                  <button
                    type="button"
                    className="codex-tool-row"
                    disabled={busyTool !== null || isAuto || consolidating}
                    onClick={() =>
                      void runHostTool("consolidate", {
                        action: "consolidate",
                        runId: data.run,
                        expectedEpoch: live?.epoch ?? null,
                      })
                    }
                  >
                    <span className="codex-tool-row-left">
                      <Sparkles className="size-4 text-primary" aria-hidden="true" />
                      <span>{t("consolidateBtn")}</span>
                    </span>
                    <kbd className="codex-tool-kbd">Memory</kbd>
                  </button>

                  <button
                    type="button"
                    className="codex-tool-row"
                    disabled={busyTool !== null}
                    onClick={() =>
                      void runHostTool("perception_reload", {
                        action: "perception_reload",
                        runId: data.run,
                      })
                    }
                  >
                    <span className="codex-tool-row-left">
                      <RefreshCw className={`size-4${busyTool === "perception_reload" ? " animate-spin" : ""}`} aria-hidden="true" />
                      <span>{t("reloadPerceptionHint")}</span>
                    </span>
                    <kbd className="codex-tool-kbd">perception.py</kbd>
                  </button>

                  <button type="button" className="codex-tool-row" onClick={onOpenCaps}>
                    <span className="codex-tool-row-left">
                      <FlaskConical className="size-4" aria-hidden="true" />
                      <span>{t("openCapsBtn")}</span>
                    </span>
                    <kbd className="codex-tool-kbd">Eval ↗</kbd>
                  </button>

                  {onOpenReplay && (
                    <button type="button" className="codex-tool-row" onClick={onOpenReplay}>
                      <span className="codex-tool-row-left">
                        <Film className="size-4" aria-hidden="true" />
                        <span>{t("openReplayBtn")}</span>
                      </span>
                      <kbd className="codex-tool-kbd">Timeline ↗</kbd>
                    </button>
                  )}

                  <button type="button" className="codex-tool-row" onClick={onOpenPerf}>
                    <span className="codex-tool-row-left">
                      <Activity className="size-4" aria-hidden="true" />
                      <span>{t("openPerfBtn")}</span>
                    </span>
                    <kbd className="codex-tool-kbd">Perf ↗</kbd>
                  </button>
                </div>
              </div>
            )}

            {/* Dedicated Perception Policy & Quick Prompt Templates when in Tools tab */}
            {dockTab === "tools" && (
              <>
                <div className="codex-dock-section">
                  <h3 className="codex-dock-heading">{t("perceptionPolicyTitle")}</h3>
                  <div className="codex-tool-list">
                    <button
                      type="button"
                      className="codex-tool-row"
                      aria-pressed={perceptionInject}
                      onClick={() => void toggleWorkbenchPerception()}
                    >
                      <span className="codex-tool-row-left">
                        {perceptionInject ? (
                          <Eye className="size-4 text-primary" aria-hidden="true" />
                        ) : (
                          <EyeOff className="size-4 text-muted-foreground" aria-hidden="true" />
                        )}
                        <span>{t("perceptionToggleRow")}</span>
                      </span>
                      <kbd className="codex-tool-kbd">
                        {perceptionInject ? t("injectOn") : t("injectOff")}
                      </kbd>
                    </button>
                  </div>
                </div>

                <div className="codex-dock-section">
                  <h3 className="codex-dock-heading">{t("quickPromptsTitle")}</h3>
                  <div className="codex-tool-list">
                    <button
                      type="button"
                      className="codex-tool-row"
                      onClick={() =>
                        setWorkflowCommand({ mode: "start", prompt: t("presetExploreStartPrompt") })
                      }
                    >
                      <span className="codex-tool-row-left">
                        <span>{t("presetExploreStart")}</span>
                      </span>
                      <kbd className="codex-tool-kbd">Start</kbd>
                    </button>
                    <button
                      type="button"
                      className="codex-tool-row"
                      onClick={() =>
                        setWorkflowCommand({ mode: "steer", prompt: t("presetEvalPrompt") })
                      }
                    >
                      <span className="codex-tool-row-left">
                        <span>{t("presetEval")}</span>
                      </span>
                      <kbd className="codex-tool-kbd">Steer</kbd>
                    </button>
                    <button
                      type="button"
                      className="codex-tool-row"
                      onClick={() =>
                        setWorkflowCommand({ mode: "steer", prompt: t("presetAdaptPrompt") })
                      }
                    >
                      <span className="codex-tool-row-left">
                        <span>{t("presetAdapt")}</span>
                      </span>
                      <kbd className="codex-tool-kbd">Steer</kbd>
                    </button>
                    <button
                      type="button"
                      className="codex-tool-row"
                      onClick={() =>
                        setWorkflowCommand({ mode: "follow_up", prompt: t("presetMemoryPrompt") })
                      }
                    >
                      <span className="codex-tool-row-left">
                        <span>{t("presetMemory")}</span>
                      </span>
                      <kbd className="codex-tool-kbd">Follow-up</kbd>
                    </button>
                  </div>
                </div>
              </>
            )}

            {/* Session Stats / Telemetry Section */}
            {(dockTab === "stage" || dockTab === "stats") && summary && (
              <div className="codex-dock-section">
                <div className="flex items-center justify-between">
                  <h3 className="codex-dock-heading">{t("telemetryCardTitle")}</h3>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {formatDurationCompact(elapsedSeconds)} / {formatDurationCompact(budgetSeconds)}
                  </span>
                </div>

                <div className="shiori-budget-bar" role="progressbar" aria-valuenow={budgetRatio} aria-valuemin={0} aria-valuemax={100}>
                  <div className="shiori-budget-bar-fill" style={{ width: `${budgetRatio}%` }} />
                </div>

                <div className="codex-stat-cards">
                  <div className="codex-stat-card">
                    <span>{t("tileTurns")}</span>
                    <strong>{summary.completed}</strong>
                    <small>{t("tileTotalCalls").replace("{total}", String(data.paging.totalCalls))}</small>
                  </div>
                  <div className="codex-stat-card">
                    <span>{t("tileActions")}</span>
                    <strong>{summary.actions}</strong>
                    <small>{t("tileObserves").replace("{count}", String(summary.explicitObserves))}</small>
                  </div>
                  <div className="codex-stat-card">
                    <span>{t("tileLatency")}</span>
                    <strong>{summary.medianMs != null ? `${(summary.medianMs / 1000).toFixed(1)}s` : "—"}</strong>
                    <small>P95 {summary.p95Ms != null ? `${(summary.p95Ms / 1000).toFixed(1)}s` : "—"}</small>
                  </div>
                  <div className="codex-stat-card">
                    <span>{t("tileCache")}</span>
                    <strong>{summary.cacheHit != null ? `${Math.round(summary.cacheHit * 100)}%` : "—"}</strong>
                    <small>
                      {t("tileWarmCache").replace(
                        "{pct}",
                        summary.warmCacheHit != null ? `${Math.round(summary.warmCacheHit * 100)}%` : "—",
                      )}
                    </small>
                  </div>
                </div>
              </div>
            )}

            {/* Session Provenance Details in Stats Tab */}
            {dockTab === "stats" && (
              <div className="codex-dock-section">
                <h3 className="codex-dock-heading">{t("provenanceTitle")}</h3>
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
                    <dd>{data.manifest.model ?? t("deviceOnly")}</dd>
                  </div>
                  <div className="codex-provenance-row">
                    <dt>{t("provCompaction")}</dt>
                    <dd>
                      {data.manifest.compactionThreshold?.toLocaleString() ?? "default"}
                    </dd>
                  </div>
                  <div className="codex-provenance-row">
                    <dt>{t("provRun")}</dt>
                    <dd className="font-mono">{data.run}</dd>
                  </div>
                  <div className="codex-provenance-row">
                    <dt>{t("provEpoch")}</dt>
                    <dd className="font-mono">{data.selectedEpoch ?? "—"}</dd>
                  </div>
                  <div className="codex-provenance-row">
                    <dt>{t("provWorkspace")}</dt>
                    <dd className="font-mono break-all">{workspace ?? data.manifest.workspace}</dd>
                  </div>
                </dl>
              </div>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}
