"use client";

import { useState, type KeyboardEvent } from "react";
import {
  Activity,
  Bot,
  CornerDownLeft,
  Eye,
  EyeOff,
  Play,
  RefreshCw,
  Send,
  Sparkles,
  Square,
  Terminal,
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

export function ShioriLoopCockpit({
  project,
  workspace,
  data,
  isLiveRun,
  phaseLabel,
  phaseElapsedMs,
  onUpdated,
  onOpenPerf,
}: {
  project: string;
  workspace: string | null;
  data: RunData;
  isLiveRun: boolean;
  phaseLabel?: string | null;
  phaseElapsedMs?: number | null;
  onUpdated(): void;
  onOpenPerf(): void;
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
  const mode = live?.mode ?? (typeof control?.mode === "string" ? control.mode : "manual");
  const consolidating = Boolean(live?.consolidating ?? control?.consolidating);
  const thinking = Boolean(live?.thinking ?? control?.thinking);
  const connected = live ? live.connected !== false : control?.connected !== false;
  const remainingSeconds = live?.remainingSeconds ?? (typeof control?.remainingSeconds === "number" ? control.remainingSeconds : null);
  const activeEpoch = live?.epoch ?? data.selectedEpoch ?? null;
  const perceptionInject = live?.context?.perceptionInjection ?? control?.context?.perceptionInjection ?? true;
  const queue = live?.queue ?? (control?.queue as { steering?: number; followUp?: number } | undefined);
  const queuedCount = (queue?.steering ?? 0) + (queue?.followUp ?? 0);

  const canControl = Boolean(isLiveRun && project && workspace && (live || data.controlAllowed));

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

  const statusTone = !isLiveRun || (!live && !data.controlAllowed)
    ? "offline"
    : consolidating
      ? "consolidating"
      : mode === "auto" || mode === "acquiring"
        ? "auto"
        : "manual";

  const statusLabel = !isLiveRun || (!live && !data.controlAllowed)
    ? t("stateSnapshot")
    : consolidating
      ? t("stateConsolidating")
      : mode === "auto"
        ? thinking
          ? t("stateAutoThinking")
          : t("stateAutoLoop")
        : mode === "acquiring"
          ? t("stateAcquiring")
          : mode === "releasing"
            ? t("stateReleasing")
            : t("stateManual");

  const formatBudget = (sec: number | null) => {
    if (sec === null || !Number.isFinite(sec)) return null;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}m ${String(s).padStart(2, "0")}s`;
  };

  return (
    <section className="shiori-cockpit-bar" data-shiori-cockpit data-shiori-state={statusTone}>
      <div className="shiori-cockpit-main">
        <div className="shiori-cockpit-identity">
          <span className="shiori-pulse-dot" data-tone={statusTone} aria-hidden="true" />
          <strong className="shiori-state-title">{statusLabel}</strong>
          {phaseLabel && isLiveRun && (
            <Badge variant="secondary" className="shiori-phase-pill">
              {phaseLabel}
              {phaseElapsedMs != null && ` · ${(phaseElapsedMs / 1000).toFixed(1)}s`}
            </Badge>
          )}
          {remainingSeconds !== null && mode === "auto" && (
            <span className="shiori-budget-pill" title={t("remainingBudgetTitle")}>
              ⏱ {formatBudget(remainingSeconds)}
            </span>
          )}
          {activeEpoch && (
            <code className="shiori-epoch-chip" title={activeEpoch}>
              epoch #{activeEpoch.slice(0, 8)}
            </code>
          )}
          {queuedCount > 0 && (
            <Badge variant="outline" className="shiori-queue-pill">
              {t("queuedMessages").replace("{count}", String(queuedCount))}
            </Badge>
          )}
        </div>

        <div className="shiori-cockpit-meta">
          <span className="shiori-meta-chip">
            <Bot className="size-3.5 text-primary" aria-hidden="true" />
            <code>{data.manifest.model ?? t("deviceOnly")}</code>
          </span>
          {data.manifest.shiori && (
            <span className="shiori-meta-chip">
              <Terminal className="size-3.5 text-muted-foreground" aria-hidden="true" />
              <code>{data.manifest.shiori.implementation} {data.manifest.shiori.implementationVersion}</code>
            </span>
          )}
          {data.summary && (
            <button type="button" className="shiori-meta-chip shiori-meta-link" onClick={onOpenPerf}>
              <Activity className="size-3.5 text-primary" aria-hidden="true" />
              <span>{data.summary.completed} turns</span>
              {data.summary.cacheHit != null && (
                <span>· {Math.round(data.summary.cacheHit * 100)}% cache</span>
              )}
            </button>
          )}
        </div>
      </div>

      {canControl && (
        <div className="shiori-cockpit-actions" role="toolbar" aria-label={t("controlsAria")}>
          {mode === "manual" && !consolidating ? (
            <>
              <Button
                type="button"
                size="xs"
                variant="default"
                disabled={busyAction !== null || !connected}
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
                size="xs"
                variant="outline"
                disabled={busyAction !== null}
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
              size="xs"
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
            size="xs"
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
            size="xs"
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
        </div>
      )}

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
  onUpdated,
}: {
  project: string;
  workspace: string | null;
  data: RunData;
  isLiveRun: boolean;
  onUpdated(): void;
}) {
  const t = useTranslations("shioriCockpit");
  const [draft, setDraft] = useState("");
  const [delivery, setDelivery] = useState<"steer" | "follow_up">("steer");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSent, setLastSent] = useState<string | null>(null);

  const live = data.live as (NonNullable<RunData["live"]> & {
    consolidating?: boolean;
  }) | null;
  const control = data.lastControl;
  const mode = live?.mode ?? (typeof control?.mode === "string" ? control.mode : "manual");
  const consolidating = Boolean(live?.consolidating ?? control?.consolidating);
  const isAuto = mode === "auto";
  const canInteract = Boolean(isLiveRun && project && workspace && (live || data.controlAllowed));

  if (!canInteract) {
    return (
      <div className="shiori-composer shiori-composer-readonly" data-shiori-composer="readonly">
        <span className="text-xs text-muted-foreground">{t("readonlyHint")}</span>
      </div>
    );
  }

  const submitMessage = async (overrideText?: string) => {
    const text = (overrideText ?? draft).trim();
    if (submitting || !project || !workspace) return;
    if (isAuto && !text) return;
    setSubmitting(true);
    setError(null);
    try {
      if (isAuto) {
        await sendRuntimeControl(project, workspace, {
          action: "steer",
          message: text,
          delivery,
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

  const presets = isAuto
    ? [
        { label: t("presetEval"), prompt: t("presetEvalPrompt") },
        { label: t("presetAdapt"), prompt: t("presetAdaptPrompt") },
        { label: t("presetMemory"), prompt: t("presetMemoryPrompt") },
      ]
    : [
        { label: t("presetVerifyStart"), prompt: t("presetVerifyStartPrompt") },
        { label: t("presetExploreStart"), prompt: t("presetExploreStartPrompt") },
      ];

  return (
    <div className="shiori-composer" data-shiori-composer={isAuto ? "steer" : "start"}>
      <div className="shiori-composer-toolbar">
        <div className="shiori-composer-mode">
          {isAuto ? (
            <>
              <span className="shiori-mode-badge" data-mode="steer">
                <Zap className="size-3" aria-hidden="true" />
                {delivery === "steer" ? t("modeSteer") : t("modeFollowUp")}
              </span>
              <div className="shiori-delivery-switch" role="group" aria-label={t("deliveryModeAria")}>
                <button
                  type="button"
                  className="shiori-delivery-btn"
                  data-active={delivery === "steer" || undefined}
                  onClick={() => setDelivery("steer")}
                >
                  {t("deliverySteer")}
                </button>
                <button
                  type="button"
                  className="shiori-delivery-btn"
                  data-active={delivery === "follow_up" || undefined}
                  onClick={() => setDelivery("follow_up")}
                >
                  {t("deliveryFollowUp")}
                </button>
              </div>
            </>
          ) : (
            <span className="shiori-mode-badge" data-mode="start">
              <Play className="size-3" aria-hidden="true" />
              {t("modeLaunchLoop")}
            </span>
          )}
        </div>

        <div className="shiori-composer-presets">
          {presets.map(preset => (
            <button
              key={preset.label}
              type="button"
              className="shiori-preset-chip"
              disabled={submitting || consolidating}
              onClick={() => setDraft(preset.prompt)}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      <div className="shiori-composer-input-row">
        <textarea
          rows={2}
          className="shiori-composer-textarea"
          placeholder={isAuto ? t("steerPlaceholder") : t("startPlaceholder")}
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
          disabled={submitting || consolidating || (isAuto && !draft.trim())}
          onClick={() => void submitMessage()}
        >
          {submitting ? (
            <span>{t("sending")}</span>
          ) : isAuto ? (
            <>
              <Send className="size-3.5" aria-hidden="true" />
              <span>{delivery === "steer" ? t("sendSteer") : t("sendFollowUp")}</span>
            </>
          ) : (
            <>
              <CornerDownLeft className="size-3.5" aria-hidden="true" />
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
