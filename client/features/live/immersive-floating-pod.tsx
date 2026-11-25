"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Columns2,
  CornerUpLeft,
  GripHorizontal,
  Inbox,
  Minus,
  Play,
  Plus,
} from "lucide-react";
import type { EventPoolSnapshot, PoolEvent } from "@ludens/protocol/event-pool";
import { useTranslations } from "@/lib/locale";
import {
  asRecord,
  summarizeStepBlock,
  type StreamSegment,
} from "@/features/live/shiori-segments";

export const IMMERSIVE_POD_ANCHOR_STORAGE_KEY = "ludens:immersive-pod-anchor";

export const IMMERSIVE_POD_ANCHORS = [
  "bottom-right",
  "bottom-center",
  "bottom-left",
  "top-right",
  "top-left",
] as const;

export type ImmersivePodAnchor = (typeof IMMERSIVE_POD_ANCHORS)[number];
export type ImmersivePodTier = "pill" | "compact" | "stream";

export function isImmersivePodAnchor(value: unknown): value is ImmersivePodAnchor {
  return (
    typeof value === "string" &&
    (IMMERSIVE_POD_ANCHORS as readonly string[]).includes(value)
  );
}

export function resolveNearestPodAnchor(input: {
  centerX: number;
  centerY: number;
  containerWidth: number;
  containerHeight: number;
  podWidth: number;
  podHeight: number;
  padX?: number;
  padY?: number;
}): ImmersivePodAnchor {
  const {
    centerX,
    centerY,
    containerWidth,
    containerHeight,
    podWidth,
    podHeight,
    padX = 18,
    padY = 16,
  } = input;

  const safeW = Math.max(1, containerWidth);
  const safeH = Math.max(1, containerHeight);
  const halfW = Math.min(podWidth / 2, safeW / 2);
  const halfH = Math.min(podHeight / 2, safeH / 2);

  const candidates: Record<ImmersivePodAnchor, { x: number; y: number }> = {
    "bottom-right": {
      x: Math.max(halfW, safeW - padX - halfW),
      y: Math.max(halfH, safeH - padY - halfH),
    },
    "bottom-center": {
      x: safeW / 2,
      y: Math.max(halfH, safeH - padY - halfH),
    },
    "bottom-left": {
      x: Math.min(safeW - halfW, padX + halfW),
      y: Math.max(halfH, safeH - padY - halfH),
    },
    "top-right": {
      x: Math.max(halfW, safeW - padX - halfW),
      y: Math.min(safeH - halfH, padY + halfH),
    },
    "top-left": {
      x: Math.min(safeW - halfW, padX + halfW),
      y: Math.min(safeH - halfH, padY + halfH),
    },
  };

  let best: ImmersivePodAnchor = "bottom-right";
  let bestDistSq = Number.POSITIVE_INFINITY;
  for (const anchor of IMMERSIVE_POD_ANCHORS) {
    const pt = candidates[anchor];
    const dx = centerX - pt.x;
    const dy = centerY - pt.y;
    const distSq = dx * dx + dy * dy;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      best = anchor;
    }
  }
  return best;
}

export function selectMiniStreamSegments(
  segments: readonly StreamSegment[],
  limit = 12,
): StreamSegment[] {
  const meaningful: StreamSegment[] = [];
  for (const seg of segments) {
    if (seg.kind === "user" || seg.kind === "outbound_event") {
      meaningful.push(seg);
      continue;
    }
    if (seg.kind === "turn") {
      const hasProse = Boolean(seg.responseText?.trim());
      const hasActionableStep = seg.steps.some(step => {
        if (step.kind !== "system") return true;
        const role = asRecord(step.data)?.role;
        return (
          step.title === "loop_step" ||
          step.title === "loop_fault" ||
          role === "loop_step" ||
          role === "loop_fault"
        );
      });
      if (hasProse || hasActionableStep) {
        meaningful.push(seg);
      }
    }
  }
  return meaningful.slice(-Math.max(1, limit));
}

function renderMiniInlineFormatting(text: string): ReactNode[] {
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

export interface ImmersiveFloatingPodProps {
  previewText: string;
  statusTone: "busy" | "auto" | "idle";
  segments: readonly StreamSegment[];
  poolSnapshot?: EventPoolSnapshot | null;
  resolveLivePoolEvent?: (event: PoolEvent) => PoolEvent;
  pendingPoolCount: number;
  pendingOutboundCount: number;
  isLiveRun: boolean;
  hostOnline: boolean;
  thinking: boolean;
  consolidating: boolean;
  canResumeAuto: boolean;
  poolSubmitting?: boolean;
  showExitImmersiveButton?: boolean;
  initialTier?: ImmersivePodTier;
  initialAnchor?: ImmersivePodAnchor;
  onTierChange?: (tier: ImmersivePodTier) => void;
  onOpenPoolOverview: () => void;
  onExitImmersive?: () => void;
  onReplyPoolEvent: (event: PoolEvent, resumeAuto: boolean) => void;
  onDismissPoolEvent: (eventId: string) => void | Promise<void>;
  children?: ReactNode;
}

export function ImmersiveFloatingPod({
  previewText,
  statusTone,
  segments,
  poolSnapshot,
  resolveLivePoolEvent,
  pendingPoolCount,
  pendingOutboundCount,
  isLiveRun,
  hostOnline,
  thinking,
  consolidating,
  canResumeAuto,
  poolSubmitting = false,
  showExitImmersiveButton = false,
  initialTier = "compact",
  initialAnchor,
  onTierChange,
  onOpenPoolOverview,
  onExitImmersive,
  onReplyPoolEvent,
  onDismissPoolEvent,
  children,
}: ImmersiveFloatingPodProps) {
  const t = useTranslations("shioriCockpit");
  const podRef = useRef<HTMLDivElement | null>(null);
  const streamScrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedToBottomRef = useRef(true);
  const suppressNextClickRef = useRef(false);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  const [tier, setTierState] = useState<ImmersivePodTier>(initialTier);
  const [anchor, setAnchor] = useState<ImmersivePodAnchor>(initialAnchor ?? "bottom-right");
  const [dragPosition, setDragPosition] = useState<{ left: number; top: number } | null>(null);

  const setTier = useCallback(
    (next: ImmersivePodTier | ((prev: ImmersivePodTier) => ImmersivePodTier)) => {
      setTierState(prev => {
        const resolved = typeof next === "function" ? next(prev) : next;
        if (resolved !== prev) {
          onTierChange?.(resolved);
        }
        return resolved;
      });
    },
    [onTierChange],
  );

  // Hydrate persisted anchor preference on mount unless overridden explicitly
  useEffect(() => {
    if (initialAnchor) return;
    try {
      const raw = window.localStorage.getItem(IMMERSIVE_POD_ANCHOR_STORAGE_KEY);
      if (isImmersivePodAnchor(raw)) {
        setAnchor(raw);
      }
    } catch {
      // Ignore storage errors
    }
  }, [initialAnchor]);

  useEffect(
    () => () => {
      dragCleanupRef.current?.();
    },
    [],
  );

  const miniSegments = useMemo(() => selectMiniStreamSegments(segments, 12), [segments]);

  const extraPendingOutbound = useMemo(() => {
    const inStreamIds = new Set<string>();
    for (const seg of miniSegments) {
      if (seg.kind === "outbound_event") {
        inStreamIds.add(seg.event.id);
      }
    }
    return (poolSnapshot?.events ?? []).filter(
      ev => ev.direction === "outbound" && ev.status === "pending" && !inStreamIds.has(ev.id),
    );
  }, [miniSegments, poolSnapshot?.events]);

  // Keep mini stream scrolled to bottom as new turns arrive
  useEffect(() => {
    if (tier !== "stream") return;
    const el = streamScrollRef.current;
    if (!el || !pinnedToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [tier, miniSegments, extraPendingOutbound.length, thinking, consolidating]);

  useEffect(() => {
    if (tier === "stream") {
      pinnedToBottomRef.current = true;
      const el = streamScrollRef.current;
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
    }
  }, [tier]);

  const handleStreamScroll = useCallback(() => {
    const el = streamScrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedToBottomRef.current = distanceFromBottom <= 48;
  }, []);

  const handleDragPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("[data-no-pod-drag]")) return;

    const podEl = podRef.current;
    if (!podEl) return;
    const containerEl =
      podEl.closest<HTMLElement>(".codex-workbench") ??
      (podEl.offsetParent as HTMLElement | null);
    if (!containerEl) return;

    dragCleanupRef.current?.();
    const startClientX = event.clientX;
    const startClientY = event.clientY;
    const initialPodRect = podEl.getBoundingClientRect();
    const initialContainerRect = containerEl.getBoundingClientRect();
    const baseLeft = initialPodRect.left - initialContainerRect.left;
    const baseTop = initialPodRect.top - initialContainerRect.top;
    const podWidth = initialPodRect.width;
    const podHeight = initialPodRect.height;

    let dragging = false;
    let latestLeft = baseLeft;
    let latestTop = baseTop;

    const onPointerMove = (moveEvent: globalThis.PointerEvent) => {
      const dx = moveEvent.clientX - startClientX;
      const dy = moveEvent.clientY - startClientY;
      if (!dragging) {
        if (Math.hypot(dx, dy) <= 5) return;
        dragging = true;
        suppressNextClickRef.current = true;
      }
      moveEvent.preventDefault();
      const containerRect = containerEl.getBoundingClientRect();
      const maxLeft = Math.max(8, containerRect.width - podWidth - 8);
      const maxTop = Math.max(8, containerRect.height - podHeight - 8);
      latestLeft = Math.round(Math.max(8, Math.min(maxLeft, baseLeft + dx)));
      latestTop = Math.round(Math.max(8, Math.min(maxTop, baseTop + dy)));
      setDragPosition({ left: latestLeft, top: latestTop });
    };

    const finishDrag = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", finishDrag);
      window.removeEventListener("pointercancel", finishDrag);
      dragCleanupRef.current = null;

      if (!dragging) return;
      const containerRect = containerEl.getBoundingClientRect();
      const nextAnchor = resolveNearestPodAnchor({
        centerX: latestLeft + podWidth / 2,
        centerY: latestTop + podHeight / 2,
        containerWidth: containerRect.width,
        containerHeight: containerRect.height,
        podWidth,
        podHeight,
      });
      setAnchor(nextAnchor);
      setDragPosition(null);
      try {
        window.localStorage.setItem(IMMERSIVE_POD_ANCHOR_STORAGE_KEY, nextAnchor);
      } catch {
        // Ignore storage write errors
      }
      setTimeout(() => {
        suppressNextClickRef.current = false;
      }, 60);
    };

    dragCleanupRef.current = finishDrag;
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", finishDrag);
    window.addEventListener("pointercancel", finishDrag);
  }, []);

  const consumeSuppressedClick = (): boolean => {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return true;
    }
    return false;
  };

  const dragStyle: CSSProperties | undefined = dragPosition
    ? {
        left: `${dragPosition.left}px`,
        top: `${dragPosition.top}px`,
        right: "auto",
        bottom: "auto",
        transform: "none",
      }
    : undefined;

  const renderOutboundMiniCard = (rawEvent: PoolEvent, key: string) => {
    const liveEvent = resolveLivePoolEvent ? resolveLivePoolEvent(rawEvent) : rawEvent;
    const isHelp = liveEvent.kind === "help_request";
    const isPending = liveEvent.status === "pending";
    return (
      <div
        key={key}
        className="immersive-stream-outbound"
        data-kind={liveEvent.kind}
        data-pending={isPending ? "true" : undefined}
        data-immersive-outbound={liveEvent.id}
      >
        <div className="immersive-stream-outbound-head">
          <span className="immersive-stream-outbound-badge">
            {isHelp ? "🆘" : "📌"}{" "}
            {isHelp ? t("poolHelpRequestBadge") : t("poolNoticeBadge")} · #{liveEvent.seq}
          </span>
          {liveEvent.pauseRequested && (
            <span className="codex-outbound-paused">{t("poolPausedTag")}</span>
          )}
        </div>
        {liveEvent.title && (
          <strong className="immersive-stream-outbound-title">{liveEvent.title}</strong>
        )}
        <p className="immersive-stream-outbound-body">{liveEvent.text}</p>
        {isLiveRun && isPending && (
          <div className="immersive-stream-outbound-actions">
            <button
              type="button"
              className="codex-pool-btn"
              data-variant={canResumeAuto ? undefined : "primary"}
              disabled={poolSubmitting}
              onClick={() => onReplyPoolEvent(liveEvent, false)}
            >
              <CornerUpLeft className="size-3" aria-hidden="true" />
              <span>{t("poolReplyBtn")}</span>
            </button>
            {canResumeAuto && (
              <button
                type="button"
                className="codex-pool-btn"
                data-variant="primary"
                disabled={poolSubmitting}
                onClick={() => onReplyPoolEvent(liveEvent, true)}
              >
                <Play className="size-3 fill-current" aria-hidden="true" />
                <span>{t("poolReplyResumeBtn")}</span>
              </button>
            )}
            <button
              type="button"
              className="codex-pool-btn"
              data-variant="ghost"
              disabled={poolSubmitting}
              onClick={() => void onDismissPoolEvent(liveEvent.id)}
            >
              <Check className="size-3" aria-hidden="true" />
              <span>{t("poolDismissBtn")}</span>
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <aside
      ref={podRef}
      className="immersive-floating-pod"
      data-viewport-floating-overlay=""
      data-immersive-pod=""
      data-pod-tier={tier}
      data-pod-anchor={anchor}
      data-dragging={dragPosition ? "true" : undefined}
      style={dragStyle}
      aria-label={t("immersivePodAria")}
    >
      {tier === "pill" ? (
        <div
          className="immersive-pod-pill"
          data-immersive-pod-drag-handle=""
          onPointerDown={handleDragPointerDown}
        >
          <button
            type="button"
            className="immersive-pod-pill-btn"
            data-immersive-composer-expand=""
            title={t("immersivePodExpandCard")}
            aria-label={t("immersivePodExpandCard")}
            onClick={() => {
              if (consumeSuppressedClick()) return;
              setTier("compact");
            }}
          >
            <span
              className="immersive-pod-status-dot"
              data-tone={statusTone}
              aria-hidden="true"
            />
            <span className="immersive-pod-pill-label">{previewText}</span>
            {pendingPoolCount > 0 && (
              <span
                className="immersive-pod-pill-badge"
                data-tone={pendingOutboundCount > 0 ? "warn" : undefined}
              >
                {pendingOutboundCount > 0 ? "🆘" : "📥"} {pendingPoolCount}
              </span>
            )}
            <Plus className="size-3.5 shrink-0 opacity-75" aria-hidden="true" />
          </button>
        </div>
      ) : (
        <div className="immersive-pod-card">
          <div
            className="immersive-pod-topbar"
            data-immersive-pod-drag-handle=""
            onPointerDown={handleDragPointerDown}
          >
            <button
              type="button"
              className="immersive-pod-preview-btn"
              title={t("immersivePodDragHint")}
              aria-expanded={tier === "stream"}
              onClick={() => {
                if (consumeSuppressedClick()) return;
                setTier(prev => (prev === "stream" ? "compact" : "stream"));
              }}
            >
              <GripHorizontal className="immersive-pod-grip size-3 shrink-0" aria-hidden="true" />
              <span
                className="immersive-pod-status-dot"
                data-tone={statusTone}
                aria-hidden="true"
              />
              <span className="immersive-pod-preview-text">{previewText}</span>
            </button>

            <div className="immersive-pod-actions" data-no-pod-drag="">
              {pendingPoolCount > 0 && (
                <button
                  type="button"
                  className="immersive-pod-chip-btn"
                  data-immersive-pod-pool-badge=""
                  data-tone={pendingOutboundCount > 0 ? "warn" : undefined}
                  title={t("poolHeaderTriggerHint")}
                  onClick={() => {
                    if (pendingOutboundCount > 0) {
                      setTier("stream");
                    } else {
                      onOpenPoolOverview();
                    }
                  }}
                >
                  {pendingOutboundCount > 0 ? (
                    <span aria-hidden="true">🆘</span>
                  ) : (
                    <Inbox className="size-3 shrink-0" aria-hidden="true" />
                  )}
                  <span>{pendingPoolCount}</span>
                </button>
              )}

              {showExitImmersiveButton && onExitImmersive && (
                <button
                  type="button"
                  className="immersive-pod-icon-btn"
                  data-immersive-split-btn=""
                  title={t("exitImmersiveHint")}
                  aria-label={t("exitImmersiveHint")}
                  onClick={onExitImmersive}
                >
                  <Columns2 className="size-3.5 shrink-0" aria-hidden="true" />
                </button>
              )}

              <button
                type="button"
                className="immersive-pod-icon-btn"
                data-immersive-pod-stream-toggle=""
                aria-expanded={tier === "stream"}
                title={t(
                  tier === "stream" ? "immersivePodCollapseStream" : "immersivePodExpandStream",
                )}
                aria-label={t(
                  tier === "stream" ? "immersivePodCollapseStream" : "immersivePodExpandStream",
                )}
                onClick={() => setTier(prev => (prev === "stream" ? "compact" : "stream"))}
              >
                {tier === "stream" ? (
                  <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
                ) : (
                  <ChevronUp className="size-3.5 shrink-0" aria-hidden="true" />
                )}
              </button>

              <button
                type="button"
                className="immersive-pod-icon-btn"
                data-immersive-composer-collapse=""
                title={t("immersivePodMinimizePill")}
                aria-label={t("immersivePodMinimizePill")}
                onClick={() => setTier("pill")}
              >
                <Minus className="size-3.5 shrink-0" aria-hidden="true" />
              </button>
            </div>
          </div>

          {tier === "stream" && (
            <div
              ref={streamScrollRef}
              className="immersive-pod-stream"
              data-immersive-pod-stream=""
              onScroll={handleStreamScroll}
            >
              {miniSegments.length === 0 && extraPendingOutbound.length === 0 ? (
                <div className="immersive-stream-empty">{t("immersiveStreamEmpty")}</div>
              ) : (
                miniSegments.map(seg => {
                  if (seg.kind === "user") {
                    const livePool = seg.poolEvent && resolveLivePoolEvent
                      ? resolveLivePoolEvent(seg.poolEvent)
                      : seg.poolEvent;
                    return (
                      <div key={seg.id} className="immersive-stream-user-row">
                        <div className="immersive-stream-user-bubble" data-mode={seg.mode}>
                          {seg.mode !== "start" && (
                            <span className="immersive-stream-user-tag">
                              {seg.mode === "steer"
                                ? "⚡ Steer"
                                : livePool
                                  ? `📥 #${livePool.seq}`
                                  : `📥 ${t("deliveryEventPool")}`}
                            </span>
                          )}
                          <p>{seg.text}</p>
                        </div>
                      </div>
                    );
                  }

                  if (seg.kind === "outbound_event") {
                    return renderOutboundMiniCard(seg.event, seg.id);
                  }

                  if (seg.kind === "turn") {
                    const actionableSteps = seg.steps.filter(step => {
                      if (step.kind !== "system") return true;
                      const role = asRecord(step.data)?.role;
                      return (
                        step.title === "loop_step" ||
                        step.title === "loop_fault" ||
                        role === "loop_step" ||
                        role === "loop_fault"
                      );
                    });
                    const latestStep = actionableSteps.at(-1);
                    const stepSummary = latestStep ? summarizeStepBlock(latestStep) : null;
                    const paragraphs = seg.responseText
                      ? seg.responseText.split(/\n{2,}/).filter(Boolean)
                      : [];

                    return (
                      <div key={seg.id} className="immersive-stream-turn">
                        {stepSummary && (
                          <div
                            className="immersive-stream-step"
                            data-fault={seg.loopFault ? "true" : undefined}
                          >
                            <span className="immersive-stream-step-badge">{stepSummary.badge}</span>
                            <span className="immersive-stream-step-detail">{stepSummary.detail}</span>
                            {actionableSteps.length > 1 && (
                              <span className="immersive-stream-step-count">
                                +{actionableSteps.length - 1}
                              </span>
                            )}
                          </div>
                        )}
                        {paragraphs.length > 0 && (
                          <div className="immersive-stream-prose">
                            {paragraphs.map((para, idx) => (
                              <p key={idx}>{renderMiniInlineFormatting(para)}</p>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  }

                  return null;
                })
              )}

              {extraPendingOutbound.map(ev => renderOutboundMiniCard(ev, `extra-${ev.id}`))}

              {hostOnline && (thinking || consolidating) && (
                <div className="immersive-stream-thinking">
                  <span className="codex-thinking-dot" aria-hidden="true" />
                  <span>{consolidating ? t("stateConsolidating") : t("stateAutoThinking")}</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="immersive-pod-composer" hidden={tier === "pill"}>
        {children}
      </div>
    </aside>
  );
}
