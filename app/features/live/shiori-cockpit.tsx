"use client";

import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  Activity,
  ArrowUpRight,
  Bot,
  CheckCircle2,
  CornerDownLeft,
  Cpu,
  Eye,
  EyeOff,
  FlaskConical,
  Layers,
  Play,
  RefreshCw,
  RotateCcw,
  Send,
  Sparkles,
  Square,
  Terminal,
  Wrench,
  Zap,
} from "lucide-react";
import { useTranslations } from "@/lib/locale";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { RunData } from "@/lib/types";

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

export function ShioriLoopCockpit({
  project,
  workspace,
  data,
  isLiveRun,
  phaseLabel,
  phaseElapsedMs,
  onUpdated,
  onOpenPerf,
  onOpenCaps,
  onSelectWorkflow,
}: {
  project: string;
  workspace: string | null;
  data: RunData;
  isLiveRun: boolean;
  phaseLabel?: string | null;
  phaseElapsedMs?: number | null;
  onUpdated(): void;
  onOpenPerf(): void;
  onOpenCaps?(): void;
  onSelectWorkflow?(mode: "start" | "steer" | "follow_up", prompt: string): void;
}) {
  const t = useTranslations("shioriCockpit");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const live = data.live as (NonNullable<RunData["live"]> & {
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
  const remainingSeconds = live?.remainingSeconds ?? (typeof control?.remainingSeconds === "number" ? control.remainingSeconds : null);
  const activeEpoch = live?.epoch ?? data.selectedEpoch ?? null;
  const perceptionInject = live?.context?.perceptionInjection ?? control?.context?.perceptionInjection ?? true;
  const queue = live?.queue ?? (control?.queue as { steering?: number; followUp?: number } | undefined);
  const queuedCount = (queue?.steering ?? 0) + (queue?.followUp ?? 0);

  const isAuto = mode === "auto";

  const runAction = async (key: string, command: RuntimeControlAction) => {
    if (!project || !workspace || busyAction) return;
    setBusyAction(key);
    setError(null);
    try {
      await sendRuntimeControl(project, workspace, command);
      onUpdated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyAction(null);
    }
  };

  const stateTone = !hostOnline
    ? "standby"
    : consolidating
      ? "consolidating"
      : isAuto
        ? thinking
          ? "thinking"
          : "auto"
        : "manual";

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

  const activeStage = consolidating
    ? 4
    : isAuto && thinking
      ? 2
      : isAuto
        ? 3
        : 1;

  const summary = data.summary;
  const shioriVersion = data.manifest.shiori?.implementation
    ? `${data.manifest.shiori.implementation}${data.manifest.shiori.implementationVersion ? ` ${data.manifest.shiori.implementationVersion}` : ""}`
    : "OMP AgentSession";

  const pipelineSteps = [
    {
      step: 1,
      id: "observe",
      icon: Eye,
      title: t("stageObserveTitle"),
      desc: t("stageObserveDesc"),
      metric: `${summary?.explicitObserves ?? 0} ${t("stageObserveUnit")}`,
      onClick: () => onSelectWorkflow?.("steer", t("presetAdaptPrompt")),
    },
    {
      step: 2,
      id: "reason",
      icon: Bot,
      title: t("stageReasonTitle"),
      desc: t("stageReasonDesc"),
      metric: `${summary?.completed ?? 0} ${t("stageReasonUnit")}`,
      onClick: () => onSelectWorkflow?.("steer", t("presetMemoryPrompt")),
    },
    {
      step: 3,
      id: "act",
      icon: Wrench,
      title: t("stageActTitle"),
      desc: t("stageActDesc"),
      metric: `${summary?.actions ?? 0} ${t("stageActUnit")}`,
      onClick: () => onSelectWorkflow?.("steer", t("presetEvalPrompt")),
    },
    {
      step: 4,
      id: "consolidate",
      icon: Sparkles,
      title: t("stageConsolidateTitle"),
      desc: t("stageConsolidateDesc"),
      metric: `${summary?.compactions ?? 0} ${t("stageConsolidateUnit")}`,
      onClick: () => {
        if (hostOnline && !isAuto) {
          void runAction("consolidate", {
            action: "consolidate",
            runId: data.run,
            expectedEpoch: live?.epoch ?? null,
          });
        } else {
          onSelectWorkflow?.("follow_up", t("presetMemoryPrompt"));
        }
      },
    },
  ];

  return (
    <section className="shiori-cockpit surface" data-shiori-cockpit={stateTone} aria-label={t("ariaLabel")}>
      <div className="shiori-cockpit-main">
        <div className="shiori-cockpit-identity">
          <div className="shiori-cockpit-orb" data-tone={stateTone}>
            <Bot className="size-4" aria-hidden="true" />
            <span className="shiori-cockpit-pulse" />
          </div>
          <div className="shiori-cockpit-titles">
            <div className="shiori-cockpit-headline">
              <span className="shiori-workbench-tag">SHIORI · CODEX LOOP</span>
              <strong>{stateTitle}</strong>
              <Badge variant={isAuto && hostOnline ? "default" : "outline"} className="font-mono text-[10px] uppercase">
                {!hostOnline ? "STANDBY" : consolidating ? "CONSOLIDATE" : isAuto ? "AUTO LOOP" : "MANUAL"}
              </Badge>
              {phaseLabel && (
                <span className="shiori-phase-chip">
                  <Activity className="size-3" aria-hidden="true" />
                  {phaseLabel}
                  {phaseElapsedMs != null ? ` · ${Math.max(0, Math.round(phaseElapsedMs / 1000))}s` : ""}
                </span>
              )}
              {remainingSeconds != null && isAuto && (
                <span className="shiori-budget-chip" title={t("remainingBudgetHint")}>
                  ⏱ {formatDurationCompact(remainingSeconds)}
                </span>
              )}
              {queuedCount > 0 && (
                <Badge variant="secondary" className="font-mono text-[10px]">
                  {t("queuedBadge").replace("{count}", String(queuedCount))}
                </Badge>
              )}
            </div>
            <div className="shiori-cockpit-subline">
              <span>
                <Terminal className="size-3" aria-hidden="true" />
                {data.manifest.model ?? t("deviceOnly")}
              </span>
              <i>·</i>
              <span>{shioriVersion}</span>
              {activeEpoch && (
                <>
                  <i>·</i>
                  <span className="font-mono" title={activeEpoch}>
                    epoch {activeEpoch.slice(0, 8)}
                  </span>
                </>
              )}
              {summary && (
                <>
                  <i>·</i>
                  <span>
                    {t("turnsCount")
                      .replace("{completed}", String(summary.completed))
                      .replace("{actions}", String(summary.actions))}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="shiori-cockpit-actions">
          {!isAuto ? (
            <>
              <Button
                type="button"
                size="sm"
                variant="default"
                className="shiori-btn-primary"
                disabled={busyAction !== null || consolidating}
                onClick={() =>
                  void runAction("auto_on", {
                    action: "auto_on",
                    runId: data.run,
                    expectedEpoch: live?.epoch ?? null,
                  })
                }
              >
                <Play className="size-3.5" aria-hidden="true" />
                {busyAction === "auto_on" ? t("startingLoop") : t("startAutoLoop")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busyAction !== null || consolidating}
                onClick={() =>
                  void runAction("consolidate", {
                    action: "consolidate",
                    runId: data.run,
                    expectedEpoch: live?.epoch ?? null,
                  })
                }
              >
                <Sparkles className="size-3.5 text-primary" aria-hidden="true" />
                {busyAction === "consolidate" ? t("consolidatingBtn") : t("consolidateBtn")}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={busyAction !== null}
              onClick={() =>
                void runAction("auto_off", {
                  action: "auto_off",
                  runId: data.run,
                  expectedEpoch: live?.epoch ?? undefined,
                })
              }
            >
              <Square className="size-3.5" aria-hidden="true" />
              {busyAction === "auto_off" ? t("stoppingLoop") : t("handbackStop")}
            </Button>
          )}

          <Button
            type="button"
            size="sm"
            variant="outline"
            title={t("perceptionInjectHint")}
            disabled={busyAction !== null}
            onClick={() =>
              void runAction("perception_inject", {
                action: "perception_inject",
                enabled: !perceptionInject,
                runId: data.run,
              })
            }
          >
            {perceptionInject ? (
              <Eye className="size-3.5 text-primary" aria-hidden="true" />
            ) : (
              <EyeOff className="size-3.5 text-muted-foreground" aria-hidden="true" />
            )}
            <span>{perceptionInject ? t("injectOn") : t("injectOff")}</span>
          </Button>

          <Button
            type="button"
            size="sm"
            variant="ghost"
            title={t("reloadPerceptionHint")}
            disabled={busyAction !== null}
            onClick={() =>
              void runAction("perception_reload", {
                action: "perception_reload",
                runId: data.run,
              })
            }
          >
            <RefreshCw className={`size-3.5${busyAction === "perception_reload" ? " animate-spin" : ""}`} aria-hidden="true" />
            <span className="sr-only">{t("reloadPerceptionHint")}</span>
          </Button>

          {onOpenCaps && (
            <Button type="button" size="sm" variant="ghost" className="text-xs text-muted-foreground" onClick={onOpenCaps}>
              <FlaskConical className="size-3.5" aria-hidden="true" />
              {t("openCapsBtn")}
            </Button>
          )}
          <Button type="button" size="sm" variant="ghost" className="text-xs text-muted-foreground" onClick={onOpenPerf}>
            {t("openPerfBtn")} <ArrowUpRight className="size-3" aria-hidden="true" />
          </Button>
        </div>
      </div>

      {/* 4-Stage Visual Auto-Loop Pipeline */}
      <div className="shiori-loop-pipeline" role="list" aria-label={t("pipelineAria")}>
        {pipelineSteps.map((item, idx) => {
          const Icon = item.icon;
          const isCurrent = activeStage === item.step && (isAuto || consolidating);
          return (
            <button
              key={item.id}
              type="button"
              role="listitem"
              className="shiori-pipeline-step"
              data-active={isCurrent || undefined}
              onClick={item.onClick}
            >
              <div className="shiori-pipeline-step-head">
                <span className="shiori-pipeline-step-num">0{item.step}</span>
                <Icon className="size-3.5 shiori-pipeline-step-icon" aria-hidden="true" />
                <strong>{item.title}</strong>
                <span className="shiori-pipeline-step-metric">{item.metric}</span>
              </div>
              <p className="shiori-pipeline-step-desc">{item.desc}</p>
              {idx < pipelineSteps.length - 1 && <span className="shiori-pipeline-arrow" aria-hidden="true">→</span>}
            </button>
          );
        })}
        <div className="shiori-pipeline-loopback" title={t("loopbackHint")}>
          <RotateCcw className={`size-3.5${isAuto && hostOnline ? " animate-spin" : ""}`} aria-hidden="true" />
          <span>{t("loopbackLabel")}</span>
        </div>
      </div>

      {error && (
        <Alert variant="destructive" className="mt-2 py-2">
          <AlertDescription className="flex items-center justify-between gap-2 text-xs">
            <span>{error}</span>
            <Button type="button" size="xs" variant="ghost" onClick={() => setError(null)}>
              ✕
            </Button>
          </AlertDescription>
        </Alert>
      )}
    </section>
  );
}

export function ShioriComposer({
  project,
  workspace,
  data,
  isLiveRun,
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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSent, setLastSent] = useState<string | null>(null);

  const live = data.live as (NonNullable<RunData["live"]> & {
    consolidating?: boolean;
  }) | null;
  const control = data.lastControl;
  const hostOnline = Boolean(isLiveRun && (live || data.controlAllowed));
  const runtimeMode = live?.mode ?? (typeof control?.mode === "string" ? control.mode : "manual");
  const consolidating = Boolean(live?.consolidating ?? control?.consolidating);
  const isAuto = runtimeMode === "auto";

  if (externalDraft != null || externalMode != null) {
    if (externalDraft != null && externalDraft !== draft) setDraft(externalDraft);
    if (externalMode != null && externalMode !== selectedTab) setSelectedTab(externalMode);
    onExternalConsumed?.();
    setTimeout(() => textareaRef.current?.focus(), 0);
  }

  const effectiveTab: "start" | "steer" | "follow_up" =
    selectedTab ?? (isAuto ? "steer" : "start");

  const submitMessage = async (overrideText?: string) => {
    const text = (overrideText ?? draft).trim();
    if (submitting || !project || !workspace) return;
    if (effectiveTab !== "start" && !text) return;
    setSubmitting(true);
    setError(null);
    try {
      if (effectiveTab === "steer" || effectiveTab === "follow_up") {
        await sendRuntimeControl(project, workspace, {
          action: "steer",
          message: text,
          delivery: effectiveTab,
          runId: data.run,
          expectedEpoch: live?.epoch ?? undefined,
        });
      } else {
        await sendRuntimeControl(project, workspace, {
          action: "auto_on",
          ...(text ? { message: text } : {}),
          runId: data.run,
          expectedEpoch: live?.epoch ?? null,
        });
      }
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

  return (
    <div className="shiori-composer" data-shiori-composer={effectiveTab}>
      {!isLiveRun && (
        <div className="shiori-composer-banner" data-tone="snapshot">
          <span>{t("readonlyHint")}</span>
          {onReturnLatest && (
            <Button type="button" size="xs" variant="outline" onClick={onReturnLatest}>
              {t("returnToLiveBtn")}
            </Button>
          )}
        </div>
      )}
      {isLiveRun && !hostOnline && (
        <div className="shiori-composer-banner" data-tone="standby">
          <span>{t("standbyComposerHint")}</span>
          <code className="shiori-composer-cli">ludens run</code>
        </div>
      )}

      <div className="shiori-composer-toolbar">
        <div className="shiori-composer-mode" role="tablist" aria-label={t("deliveryModeAria")}>
          <button
            type="button"
            role="tab"
            aria-selected={effectiveTab === "start"}
            className="shiori-mode-tab"
            data-active={effectiveTab === "start" || undefined}
            onClick={() => setSelectedTab("start")}
          >
            <Play className="size-3" aria-hidden="true" />
            {t("modeLaunchLoop")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={effectiveTab === "steer"}
            className="shiori-mode-tab"
            data-active={effectiveTab === "steer" || undefined}
            onClick={() => setSelectedTab("steer")}
          >
            <Zap className="size-3" aria-hidden="true" />
            {t("deliverySteer")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={effectiveTab === "follow_up"}
            className="shiori-mode-tab"
            data-active={effectiveTab === "follow_up" || undefined}
            onClick={() => setSelectedTab("follow_up")}
          >
            <CornerDownLeft className="size-3" aria-hidden="true" />
            {t("deliveryFollowUp")}
          </button>
        </div>

        <div className="shiori-composer-presets">
          {presets.map(preset => (
            <button
              key={preset.label}
              type="button"
              className="shiori-preset-chip"
              disabled={submitting || consolidating}
              onClick={() => {
                setSelectedTab(preset.tab);
                setDraft(preset.prompt);
                textareaRef.current?.focus();
              }}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      <div className="shiori-composer-input-row">
        <textarea
          ref={textareaRef}
          rows={2}
          className="shiori-composer-textarea"
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
        <Button
          type="button"
          size="sm"
          variant="default"
          className="shiori-composer-send"
          disabled={submitting || consolidating || (effectiveTab !== "start" && !draft.trim())}
          onClick={() => void submitMessage()}
        >
          {submitting ? (
            <span>{t("sending")}</span>
          ) : effectiveTab === "steer" ? (
            <>
              <Zap className="size-3.5" aria-hidden="true" />
              <span>{t("sendSteer")}</span>
            </>
          ) : effectiveTab === "follow_up" ? (
            <>
              <Send className="size-3.5" aria-hidden="true" />
              <span>{t("sendFollowUp")}</span>
            </>
          ) : (
            <>
              <Play className="size-3.5" aria-hidden="true" />
              <span>{draft.trim() ? t("sendStartWithPrompt") : t("sendResumeLoop")}</span>
            </>
          )}
        </Button>
      </div>

      {error && (
        <p className="shiori-composer-error" role="alert">
          {error}
        </p>
      )}
      {!error && lastSent && (
        <p className="shiori-composer-sent" role="status">
          ✓ {t("sentFeedback")}: <code>{lastSent.slice(0, 72)}</code>
        </p>
      )}
    </div>
  );
}

export function ShioriWorkbench({
  project,
  workspace,
  data,
  isLiveRun,
  phaseLabel,
  phaseElapsedMs,
  onUpdated,
  onOpenPerf,
  onOpenCaps,
  onReturnLatest,
  observationSlot,
  renderActivityFeed,
}: {
  project: string;
  workspace: string | null;
  data: RunData;
  isLiveRun: boolean;
  phaseLabel?: string | null;
  phaseElapsedMs?: number | null;
  onUpdated(): void;
  onOpenPerf(): void;
  onOpenCaps(): void;
  onReturnLatest(): void;
  observationSlot: ReactNode;
  renderActivityFeed(composer: ReactNode): ReactNode;
}) {
  const t = useTranslations("shioriCockpit");
  const [workflowCommand, setWorkflowCommand] = useState<{
    mode: "start" | "steer" | "follow_up";
    prompt: string;
  } | null>(null);

  const summary = data.summary;
  const budgetSeconds = Math.max(1, data.manifest.seconds || 1800);
  const elapsedSeconds = summary?.elapsedSeconds ?? 0;
  const budgetRatio = Math.min(100, Math.round((elapsedSeconds / budgetSeconds) * 100));

  const guideCards = [
    {
      id: "auto-loop",
      badge: "01 · AUTO LOOP",
      icon: Play,
      title: t("guideAutoTitle"),
      desc: t("guideAutoDesc"),
      cta: t("guideAutoCta"),
      onClick: () => setWorkflowCommand({ mode: "start", prompt: t("presetExploreStartPrompt") }),
    },
    {
      id: "live-steer",
      badge: "02 · LIVE STEER",
      icon: Zap,
      title: t("guideSteerTitle"),
      desc: t("guideSteerDesc"),
      cta: t("guideSteerCta"),
      onClick: () => setWorkflowCommand({ mode: "steer", prompt: t("presetAdaptPrompt") }),
    },
    {
      id: "cap-eval",
      badge: "03 · CAPABILITY & EVAL",
      icon: FlaskConical,
      title: t("guideEvalTitle"),
      desc: t("guideEvalDesc"),
      cta: t("guideEvalCta"),
      onClick: () => setWorkflowCommand({ mode: "steer", prompt: t("presetEvalPrompt") }),
    },
  ];

  const composerElement = (
    <ShioriComposer
      project={project}
      workspace={workspace}
      data={data}
      isLiveRun={isLiveRun}
      externalMode={workflowCommand?.mode ?? null}
      externalDraft={workflowCommand?.prompt ?? null}
      onExternalConsumed={() => setWorkflowCommand(null)}
      onReturnLatest={onReturnLatest}
      onUpdated={onUpdated}
    />
  );

  return (
    <div className="shiori-workbench" data-shiori-workbench="codex">
      <ShioriLoopCockpit
        project={project}
        workspace={workspace}
        data={data}
        isLiveRun={isLiveRun}
        phaseLabel={phaseLabel}
        phaseElapsedMs={phaseElapsedMs}
        onUpdated={onUpdated}
        onOpenPerf={onOpenPerf}
        onOpenCaps={onOpenCaps}
        onSelectWorkflow={(mode, prompt) => setWorkflowCommand({ mode, prompt })}
      />

      {/* Interactive 3-Card Design Guidance Strip */}
      <section className="shiori-guide-strip" aria-label={t("guideAria")}>
        {guideCards.map(card => {
          const Icon = card.icon;
          return (
            <button
              key={card.id}
              type="button"
              className="shiori-guide-card surface"
              onClick={card.onClick}
            >
              <div className="shiori-guide-card-top">
                <span className="shiori-guide-badge">{card.badge}</span>
                <span className="shiori-guide-cta">
                  {card.cta} <ArrowUpRight className="size-3" aria-hidden="true" />
                </span>
              </div>
              <div className="shiori-guide-card-title">
                <Icon className="size-4 text-primary shrink-0" aria-hidden="true" />
                <strong>{card.title}</strong>
              </div>
              <p className="shiori-guide-card-desc">{card.desc}</p>
            </button>
          );
        })}
      </section>

      {/* Codex 2-Pane Split: Left = Shiori Session Thread + Composer | Right = Sticky Environment Stage & Telemetry */}
      <div className="shiori-workbench-grid">
        <div className="shiori-thread-column">
          {renderActivityFeed(composerElement)}
        </div>

        <aside className="shiori-stage-column" aria-label={t("stageColumnAria")}>
          <div className="shiori-stage-viewport">
            {observationSlot}
          </div>

          {summary && (
            <section className="surface shiori-telemetry-card" aria-label={t("telemetryCardTitle")}>
              <div className="shiori-telemetry-head">
                <div className="flex items-center gap-2">
                  <Cpu className="size-4 text-primary" aria-hidden="true" />
                  <strong>{t("telemetryCardTitle")}</strong>
                </div>
                <span className="font-mono text-xs text-muted-foreground">
                  {formatDurationCompact(elapsedSeconds)} / {formatDurationCompact(budgetSeconds)} ({budgetRatio}%)
                </span>
              </div>

              <div className="shiori-budget-bar" role="progressbar" aria-valuenow={budgetRatio} aria-valuemin={0} aria-valuemax={100}>
                <div className="shiori-budget-bar-fill" style={{ width: `${budgetRatio}%` }} />
              </div>

              <div className="shiori-telemetry-grid">
                <div className="shiori-telemetry-tile">
                  <span className="shiori-telemetry-label">{t("tileTurns")}</span>
                  <strong className="shiori-telemetry-val">{summary.completed}</strong>
                  <small>{t("tileTotalCalls").replace("{total}", String(data.paging.totalCalls))}</small>
                </div>
                <div className="shiori-telemetry-tile">
                  <span className="shiori-telemetry-label">{t("tileActions")}</span>
                  <strong className="shiori-telemetry-val">{summary.actions}</strong>
                  <small>{t("tileObserves").replace("{count}", String(summary.explicitObserves))}</small>
                </div>
                <div className="shiori-telemetry-tile">
                  <span className="shiori-telemetry-label">{t("tileLatency")}</span>
                  <strong className="shiori-telemetry-val">
                    {summary.medianMs != null ? `${(summary.medianMs / 1000).toFixed(1)}s` : "—"}
                  </strong>
                  <small>P95 {summary.p95Ms != null ? `${(summary.p95Ms / 1000).toFixed(1)}s` : "—"}</small>
                </div>
                <div className="shiori-telemetry-tile">
                  <span className="shiori-telemetry-label">{t("tileCache")}</span>
                  <strong className="shiori-telemetry-val">
                    {summary.cacheHit != null ? `${Math.round(summary.cacheHit * 100)}%` : "—"}
                  </strong>
                  <small>
                    {t("tileWarmCache").replace(
                      "{pct}",
                      summary.warmCacheHit != null ? `${Math.round(summary.warmCacheHit * 100)}%` : "—",
                    )}
                  </small>
                </div>
              </div>

              <div className="shiori-telemetry-footer">
                <span className="text-xs text-muted-foreground">
                  Driver: <code className="font-mono">{data.manifest.drivers.map(d => d.id).join(" · ") || "—"}</code>
                </span>
                <div className="flex items-center gap-2">
                  <Button type="button" size="xs" variant="outline" onClick={onOpenCaps}>
                    <Layers className="size-3" aria-hidden="true" />
                    {t("openCapsBtn")}
                  </Button>
                  <Button type="button" size="xs" variant="ghost" onClick={onOpenPerf}>
                    {t("openPerfBtn")} ↗
                  </Button>
                </div>
              </div>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
