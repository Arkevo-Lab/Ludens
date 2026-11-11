"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  ArrowDown,
  Bot,
  ChevronDown,
  ChevronRight,
  Clock,
  CornerDownLeft,
  Eye,
  EyeOff,
  FileText,
  Infinity as InfinityIcon,
  PanelRight,
  Play,
  Plus,
  RotateCcw,
  Square,
  X,
  Zap,
} from "lucide-react";
import { useTranslations } from "@/lib/locale";
import type { ActivityBlock } from "@/features/live/activity-feed-model";
import { activityContentView, printable } from "@/features/live/activity-feed-model";
import type { ActivityFeedData } from "@/features/live/use-activity-feed";
import { clockTime } from "@/features/live/run-visuals";
import { readArchiveJson } from "@/lib/archive-client";
import { runWindowSummary } from "@/lib/run-identity";
import type { Call, Observation, RunData, RunInfo } from "@/lib/types";
import { requestActivity } from "@ludens/protocol/activity";
import "@/features/live/activity-feed.css";

export type RuntimeControlAction =
  | { action: "status" }
  | { action: "auto_on"; message?: string; seconds?: number | null; runId?: string; expectedEpoch?: string | null }
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
  if (clamped >= 3600) {
    const h = Math.floor(clamped / 3600);
    const m = Math.floor((clamped % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const m = Math.floor(clamped / 60);
  const s = clamped % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function cleanErrorMessage(raw: string): string {
  return raw.replace(/(?:LudensError:\s*|Error:\s*)+/gi, "").trim() || raw;
}

function cleanInlinePreview(raw: string | undefined | null): string {
  if (!raw) return "";
  const firstLine =
    raw
      .split("\n")
      .map(line => line.trim())
      .find(
        line =>
          Boolean(line) &&
          line !== "{" &&
          line !== "[" &&
          line !== "参数：" &&
          line !== "Arguments:" &&
          line !== "结果：" &&
          line !== "Result:" &&
          !line.startsWith('{"') &&
          !line.startsWith("{ "),
      ) ?? "";
  if (!firstLine) return "";
  return cleanErrorMessage(
    firstLine
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/^\*\*+|\*\*+$/g, "")
      .replace(/`([^`]+)`/g, "$1")
      .trim(),
  ).slice(0, 96);
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
  const previewText = cleanInlinePreview(block.text);
  const intent = cleanInlinePreview(block.tool?.intent);

  if (block.kind === "tool") {
    if (titleLower === "bash" || titleLower.endsWith(":bash")) {
      const cmd = typeof args?.command === "string" ? args.command.trim().split("\n")[0]?.slice(0, 96) : "";
      return {
        badge: "$ bash",
        detail: cmd || intent || previewText || (block.status === "running" ? "Running command…" : "bash"),
      };
    }
    if (titleLower === "observe" || titleLower.includes("observe")) {
      return { badge: "👁 observe", detail: intent || previewText || "Capture frame" };
    }
    if (titleLower.includes("capability") || typeof args?.capability === "string") {
      return {
        badge: "⚡ capability",
        detail: (typeof args?.capability === "string" ? args.capability : intent || previewText) || block.title,
      };
    }
    const patchText =
      typeof args?.input === "string"
        ? args.input
        : typeof args?.patch === "string"
          ? args.patch
          : typeof args?.patchText === "string"
            ? args.patchText
            : "";
    const patchedFile = patchText.includes("*** Begin Patch")
      ? patchText.match(/^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s*(.+)$/m)?.[1]?.trim()
      : undefined;
    const targetArg = [
      patchedFile,
      args?.path,
      args?.file_path,
      args?.file,
      args?.pattern,
      args?.query,
      args?.url,
      args?.action,
      args?.name,
    ].find((v): v is string => typeof v === "string" && v.trim().length > 0);
    const compactArgs = !targetArg && args
      ? Object.entries(args)
          .filter(
            ([k, v]) =>
              k !== "intent" &&
              (typeof v === "string" || typeof v === "number" || typeof v === "boolean") &&
              !String(v).startsWith("*** Begin Patch"),
          )
          .slice(0, 2)
          .map(([k, v]) => `${k}=${String(v).slice(0, 36)}`)
          .join(" ")
      : "";
    return {
      badge: `⚙ ${block.title}`,
      detail: intent || targetArg || compactArgs || previewText || block.title,
    };
  }

  if (block.kind === "thinking") {
    return { badge: "🧠 thinking", detail: previewText || "Reasoning…" };
  }

  if (block.kind === "system") {
    const rec = asRecord(block.data);
    const sysDetail = [
      rec?.summary,
      rec?.message,
      rec?.error,
      rec?.reason,
      rec?.state,
      rec?.status,
      rec?.outcome,
      rec?.capability,
    ]
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .map(v => cleanErrorMessage(v.trim()))
      .join(" · ");
    const tokenSummary =
      typeof rec?.tokensBefore === "number" && typeof rec?.tokensAfter === "number"
        ? `${rec.tokensBefore.toLocaleString()} → ${rec.tokensAfter.toLocaleString()} tokens`
        : "";
    return {
      badge: `● ${block.title}`,
      detail: sysDetail || tokenSummary || previewText || block.title,
    };
  }

  return { badge: block.source?.component ?? "step", detail: previewText || block.title };
}

function isBackgroundResultBlock(block: ActivityBlock): boolean {
  return block.kind === "system" && block.title === "background_result";
}

function callHasExternalInput(call: Call): boolean {
  return (
    call.inputObservations.length > 0 ||
    Boolean(call.inputText && call.inputText.trim()) ||
    Boolean(call.perception)
  );
}

function isControlBlock(block: ActivityBlock): boolean {
  return block.kind === "system" && block.title === "control";
}

type StreamSegment =
  | {
      kind: "session_divider";
      id: string;
      runId: string;
      epoch: string | null;
      cycleIndex: number;
      startedAt: string;
      endedAt: string | null;
      durationSeconds: number | null;
      maxSeconds: number | null;
      stopReason: string | null;
      gapSeconds: number | null;
      isActive: boolean;
    }
  | { kind: "user"; id: string; block: ActivityBlock; text: string; mode: string }
  | {
      kind: "input";
      id: string;
      runId?: string;
      call?: Call;
      observations: Observation[];
      bgBlock?: ActivityBlock;
      at: string;
    }
  | {
      kind: "turn";
      id: string;
      runId?: string;
      steps: ActivityBlock[];
      responseBlock: ActivityBlock | null;
      responseText: string | null;
    };

interface BuildSegmentsOptions {
  runId?: string;
  cycles?: RunData["cycles"];
  prevEndedAt?: string | null;
  isLatestRun?: boolean;
  isAuto?: boolean;
}

/**
 * Groups raw ActivityBlocks and external Call inputs into Codex-style conversational segments:
 * - Explicit Session Segment & Time-Gap Dividers (`session_divider`) across control cycles (`epoch`) and runs
 * - User bubbles (`user_message`)
 * - External Agent Loop Input blocks (`CodexInputCard` from `call.inputObservations` / `call.inputText` / `call.perception` / `background_result`)
 * - Collapsed intermediate step groups (`上 N 条消息 / 执行步骤 >`) paired with Shiori's readable prose response
 */
function buildCodexSegments(
  rawBlocks: ActivityBlock[],
  calls: Call[] = [],
  observations: Observation[] = [],
  options: BuildSegmentsOptions = {},
): StreamSegment[] {
  const blocks = rawBlocks.filter(block => block.kind !== "diagnostic");
  const callsById = new Map(calls.map(c => [c.id, c]));
  const obsById = new Map(observations.map(o => [o.id, o]));
  const cyclesByEpoch = new Map((options.cycles ?? []).map((c, idx) => [c.epoch, { ...c, index: idx + 1 }]));
  const emittedCallInputIds = new Set<string>();
  const emittedDividerEpochs = new Set<string>();
  const segments: StreamSegment[] = [];
  let pendingSteps: ActivityBlock[] = [];
  let currentEpoch: string | null = null;
  let lastSegmentEndedAt: string | null = options.prevEndedAt ?? null;
  let lastPostBlockMs = 0;
  let autoCycleCounter = 0;

  // Pre-scan control(manual) blocks so we know end times and stop reasons even before cycle index updates
  const manualEndByEpoch = new Map<string, { endedAt: string; reason: string | null; elapsedMs: number | null }>();
  for (const block of blocks) {
    if (!isControlBlock(block)) continue;
    const rec = asRecord(block.data);
    if (rec?.mode === "manual") {
      const ep = block.trace?.epoch ?? (typeof rec?.epoch === "string" ? rec.epoch : "");
      if (ep) {
        manualEndByEpoch.set(ep, {
          endedAt: block.at,
          reason: typeof rec?.reason === "string" ? rec.reason : null,
          elapsedMs: typeof rec?.elapsedMs === "number" ? rec.elapsedMs : null,
        });
      }
    }
  }

  const emitDividerForEpoch = (epoch: string | null, fallbackStartAt: string, autoBlockData?: Record<string, unknown> | null) => {
    const key = `${options.runId ?? ""}:${epoch ?? "default"}`;
    if (emittedDividerEpochs.has(key)) return;

    const indexed = epoch ? cyclesByEpoch.get(epoch) : undefined;
    if (indexed && indexed.index > 1 && options.cycles) {
      for (let i = 0; i < indexed.index - 1; i++) {
        const earlier = options.cycles[i];
        if (earlier) {
          emitDividerForEpoch(earlier.epoch, earlier.startedAt);
        }
      }
    }

    emittedDividerEpochs.add(key);
    const manualEnd = epoch ? manualEndByEpoch.get(epoch) : undefined;
    const cycleIndex = indexed?.index ?? ++autoCycleCounter;
    const startedAt = indexed?.startedAt ?? fallbackStartAt;
    const isLatestCycleInRun = Boolean(
      options.isLatestRun &&
        epoch &&
        (options.cycles?.length ? options.cycles.at(-1)?.epoch === epoch : true),
    );
    const isActive = Boolean(isLatestCycleInRun && options.isAuto && !manualEnd && !indexed?.endedAt);
    const endedAt = isActive ? null : (indexed?.endedAt ?? manualEnd?.endedAt ?? null);
    const stopReason = isActive ? null : (indexed?.reason ?? manualEnd?.reason ?? null);
    const maxSeconds =
      indexed && "maxSeconds" in indexed
        ? (indexed.maxSeconds ?? null)
        : typeof autoBlockData?.maxSeconds === "number"
          ? autoBlockData.maxSeconds
          : null;

    const startMs = Date.parse(startedAt);
    const endMs = endedAt ? Date.parse(endedAt) : NaN;
    const prevCycleEndedAt =
      indexed && indexed.index > 1 ? (options.cycles?.[indexed.index - 2]?.endedAt ?? null) : null;
    const effectivePrevEndedAt = prevCycleEndedAt ?? lastSegmentEndedAt;
    const prevEndMs = effectivePrevEndedAt ? Date.parse(effectivePrevEndedAt) : NaN;
    const gapSeconds =
      Number.isFinite(startMs) && Number.isFinite(prevEndMs) && startMs > prevEndMs
        ? Math.max(0, Math.round((startMs - prevEndMs) / 1000))
        : null;
    const durationSeconds =
      manualEnd?.elapsedMs != null
        ? Math.max(0, Math.round(manualEnd.elapsedMs / 1000))
        : Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs
          ? Math.max(0, Math.round((endMs - startMs) / 1000))
          : null;

    segments.push({
      kind: "session_divider",
      id: `divider:${options.runId ?? "run"}:${epoch ?? cycleIndex}`,
      runId: options.runId ?? "",
      epoch,
      cycleIndex,
      startedAt,
      endedAt,
      durationSeconds,
      maxSeconds,
      stopReason,
      gapSeconds,
      isActive,
    });

    if (endedAt) {
      lastSegmentEndedAt = endedAt;
    }
  };

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
    const anchorId = pendingSteps[0]?.id ?? explicitResponse?.id ?? "turn";
    const stableId = `turn:${options.runId ?? ""}:${anchorId}`;
    if (explicitResponse) {
      segments.push({
        kind: "turn",
        id: stableId,
        runId: options.runId,
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
        id: stableId,
        runId: options.runId,
        steps: otherSteps,
        responseBlock: synthesized.block,
        responseText: synthesized.text,
      });
    } else {
      segments.push({
        kind: "turn",
        id: stableId,
        runId: options.runId,
        steps: pendingSteps,
        responseBlock: null,
        responseText: null,
      });
    }
    pendingSteps = [];
  };

  const referencedCallIds = new Set(
    blocks.map(b => b.trace?.modelCallId).filter((id): id is string => Boolean(id)),
  );
  const windowStartMs = blocks.length > 0 ? (Date.parse(blocks[0].at) || 0) - 5_000 : 0;
  const orphanInputCalls = calls
    .filter(
      call =>
        callHasExternalInput(call) &&
        !referencedCallIds.has(call.id) &&
        (blocks.length === 0 || (call.atMs || Date.parse(call.at) || 0) >= windowStartMs),
    )
    .sort((a, b) => (a.atMs || Date.parse(a.at) || 0) - (b.atMs || Date.parse(b.at) || 0));
  let orphanIdx = 0;

  const emitCallInputCard = (call: Call) => {
    if (emittedCallInputIds.has(call.id)) return;
    flushTurn();
    emittedCallInputIds.add(call.id);
    const resolvedObs = call.inputObservations
      .map(obsId => obsById.get(obsId))
      .filter((item): item is Observation => Boolean(item));
    segments.push({
      kind: "input",
      id: `input-call:${call.id}`,
      runId: options.runId,
      call,
      observations: resolvedObs,
      at: call.perception?.snapshot?.recordedAt ?? resolvedObs[0]?.at ?? call.at,
    });
  };

  for (const block of blocks) {
    const blockMs = Date.parse(block.at) || 0;
    while (
      orphanIdx < orphanInputCalls.length &&
      (orphanInputCalls[orphanIdx].atMs || Date.parse(orphanInputCalls[orphanIdx].at) || 0) <= blockMs
    ) {
      if (segments.length === 0 && options.runId) {
        emitDividerForEpoch(options.cycles?.[0]?.epoch ?? null, orphanInputCalls[orphanIdx].at);
      }
      emitCallInputCard(orphanInputCalls[orphanIdx]);
      orphanIdx++;
    }

    if (isControlBlock(block)) {
      flushTurn();
      const rec = asRecord(block.data);
      const ep = block.trace?.epoch ?? (typeof rec?.epoch === "string" ? rec.epoch : null);
      if (rec?.mode === "auto") {
        currentEpoch = ep;
        lastPostBlockMs = 0;
        emitDividerForEpoch(ep, block.at, rec);
      } else if (rec?.mode === "manual") {
        if (ep || currentEpoch) {
          lastSegmentEndedAt = block.at;
        }
        currentEpoch = null;
        lastPostBlockMs = 0;
      }
      continue;
    }

    const blockEpoch = block.trace?.epoch ?? null;
    if (blockEpoch && blockEpoch !== currentEpoch) {
      flushTurn();
      currentEpoch = blockEpoch;
      lastPostBlockMs = 0;
      emitDividerForEpoch(blockEpoch, block.at);
    } else if (!blockEpoch && currentEpoch) {
      const closedEnd =
        cyclesByEpoch.get(currentEpoch)?.endedAt ?? manualEndByEpoch.get(currentEpoch)?.endedAt ?? null;
      const closedMs = closedEnd ? Date.parse(closedEnd) : NaN;
      if (Number.isFinite(closedMs) && blockMs > closedMs + 30_000) {
        flushTurn();
        lastSegmentEndedAt = closedEnd;
        currentEpoch = null;
        lastPostBlockMs = blockMs;
        emitDividerForEpoch(`post:${block.id}`, block.at);
      }
    } else if (!blockEpoch && !currentEpoch && segments.length > 0 && blockMs > 0) {
      if (lastPostBlockMs === 0) {
        const prevEndMs = lastSegmentEndedAt ? Date.parse(lastSegmentEndedAt) : NaN;
        if (Number.isFinite(prevEndMs) && blockMs > prevEndMs + 30_000) {
          flushTurn();
          lastPostBlockMs = blockMs;
          emitDividerForEpoch(`post:${block.id}`, block.at);
        }
      } else if (blockMs - lastPostBlockMs > 5 * 60_000) {
        flushTurn();
        lastSegmentEndedAt = new Date(lastPostBlockMs).toISOString();
        lastPostBlockMs = blockMs;
        emitDividerForEpoch(`post:${block.id}`, block.at);
      } else {
        lastPostBlockMs = Math.max(lastPostBlockMs, blockMs);
      }
    } else if (!blockEpoch && segments.length === 0 && pendingSteps.length === 0 && options.runId) {
      const fallbackCycle = options.cycles?.[0];
      const fallbackClosedEnd = fallbackCycle?.endedAt ?? (fallbackCycle ? manualEndByEpoch.get(fallbackCycle.epoch)?.endedAt : null) ?? null;
      const fallbackClosedMs = fallbackClosedEnd ? Date.parse(fallbackClosedEnd) : NaN;
      if (fallbackCycle && Number.isFinite(fallbackClosedMs) && blockMs > fallbackClosedMs + 30_000) {
        emitDividerForEpoch(fallbackCycle.epoch, fallbackCycle.startedAt);
        lastPostBlockMs = blockMs;
        emitDividerForEpoch(`post:${block.id}`, block.at);
      } else {
        emitDividerForEpoch(fallbackCycle?.epoch ?? null, block.at);
      }
    }

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

    if (isBackgroundResultBlock(block)) {
      flushTurn();
      segments.push({
        kind: "input",
        id: `input-bg:${block.id}`,
        runId: options.runId,
        observations: [],
        bgBlock: block,
        at: block.at,
      });
      continue;
    }

    const callId = block.trace?.modelCallId;
    if (callId && !emittedCallInputIds.has(callId)) {
      const call = callsById.get(callId);
      if (call && callHasExternalInput(call)) {
        emitCallInputCard(call);
      }
    }

    if (isAssistantTextBlock(block)) {
      flushTurn(block);
      continue;
    }

    pendingSteps.push(block);
    // Fallback turn split only when calls don't carry turn-boundary input headers
    if (
      callsById.size === 0 &&
      pendingSteps.length >= 6 &&
      block.kind === "tool" &&
      (pendingSteps.some(item => item.kind === "thinking") || Boolean(block.tool?.intent))
    ) {
      flushTurn();
    }
  }

  flushTurn();
  while (orphanIdx < orphanInputCalls.length) {
    if (segments.length === 0 && options.runId) {
      emitDividerForEpoch(options.cycles?.[0]?.epoch ?? null, orphanInputCalls[orphanIdx].at);
    }
    emitCallInputCard(orphanInputCalls[orphanIdx]);
    orphanIdx++;
  }
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

function formatStopReason(reason: string | null, t: (key: string) => string): string | null {
  if (!reason || reason === "enabled") return null;
  if (reason === "manual") return t("stopReasonManual");
  if (reason.toLowerCase().includes("budget exhausted")) return t("stopReasonBudget");
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
  const composerDockRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [draft, setDraft] = useState("");
  const [selectedTab, setSelectedTab] = useState<"start" | "steer" | "follow_up" | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [durationMenuOpen, setDurationMenuOpen] = useState(false);

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
  const [localPerceptionInject, setLocalPerceptionInject] = useState<boolean | null>(null);
  const [localHostOverride, setLocalHostOverride] = useState<{
    project: string;
    run: string;
    baseUpdatedAt: string;
    status: Record<string, unknown>;
  } | null>(null);

  useEffect(() => {
    setLocalPerceptionInject(null);
    setLocalHostOverride(null);
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

  useEffect(() => {
    if (externalDraft == null && externalMode == null) return;
    if (externalDraft != null) setDraft(externalDraft);
    if (externalMode != null) setSelectedTab(externalMode);
    onExternalConsumed?.();
    const timer = setTimeout(() => textareaRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [externalDraft, externalMode, onExternalConsumed]);

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
      setLocalHostOverride({ project, run: data.run, baseUpdatedAt: data.updatedAt, status });
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
    setDurationMenuOpen(false);
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

  const presets = [
    { label: t("presetExploreStart"), prompt: t("presetExploreStartPrompt"), tab: "start" as const },
    { label: t("presetEval"), prompt: t("presetEvalPrompt"), tab: isAuto ? ("steer" as const) : ("start" as const) },
    { label: t("presetAdapt"), prompt: t("presetAdaptPrompt"), tab: "steer" as const },
    { label: t("presetMemory"), prompt: t("presetMemoryPrompt"), tab: "follow_up" as const },
  ];

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

  const modelShort = (data.manifest.model ?? t("deviceOnly")).replace(/^[^/]+\//, "");

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
              onClick={() => {
                setDurationMenuOpen(false);
                setMenuOpen(prev => !prev);
              }}
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

            {/* Optional Takeover Duration Pill */}
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
  runs = [],
  jumpTarget = null,
  onClearJumpTarget,
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
}: {
  project: string;
  workspace: string | null;
  workspaceTitle?: string;
  runs?: RunInfo[];
  jumpTarget?: { value: string; seq: number } | null;
  onClearJumpTarget?: () => void;
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
}) {
  const t = useTranslations("shioriCockpit");
  const streamRef = useRef<HTMLDivElement | null>(null);
  const prependScrollAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const cachedSegmentsRef = useRef<{ run: string; segments: StreamSegment[] }>({
    run: "",
    segments: [],
  });
  const [showAllSteps, setShowAllSteps] = useState(false);
  const [dockOpen, setDockOpen] = useState(true);
  const [atBottom, setAtBottom] = useState(true);
  const [perceptionOverride, setPerceptionOverride] = useState<boolean | null>(null);
  const [hostStatusOverride, setHostStatusOverride] = useState<{
    project: string;
    run: string;
    baseUpdatedAt: string;
    status: Record<string, unknown>;
  } | null>(null);
  const [loadedOlderRuns, setLoadedOlderRuns] = useState<
    Array<{ runId: string; data: RunData; blocks: ActivityBlock[] }>
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
    mode: "start" | "steer" | "follow_up";
    prompt: string;
  } | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    setLoadedOlderRuns([]);
    setOlderRunError(null);
    setHighlightedSegmentId(null);
    setInspectedTurn(null);
    setPerceptionOverride(null);
    setHostStatusOverride(null);
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
    setDockOpen(true);
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
  const perceptionInject =
    live?.connected && typeof live?.context?.perceptionInjection === "boolean" && !activeHostOverride
      ? live.context.perceptionInjection
      : (perceptionOverride ?? serverPerceptionInject);
  const isAuto = mode === "auto";

  useEffect(() => {
    if (!isLiveRun || !isAuto || !refresh) return;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isLiveRun, isAuto, refresh]);

  const earliestLoadedRunId = loadedOlderRuns[0]?.runId ?? data.run;
  const earliestIdxInCatalog = runs.findIndex(r => r.id === earliestLoadedRunId);
  const nextOlderRun =
    earliestIdxInCatalog >= 0 && earliestIdxInCatalog + 1 < runs.length
      ? runs[earliestIdxInCatalog + 1]
      : null;

  const olderRunAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => olderRunAbortRef.current?.abort();
  }, [project, data.run]);

  const fetchHistoricalRun = async (targetRunId: string, signal: AbortSignal) => {
    const runParams = new URLSearchParams({ project, run: targetRunId, epoch: "all" });
    const actParams = new URLSearchParams({
      project,
      run: targetRunId,
      epoch: "all",
      mode: "history",
      kind: "all",
      limit: "150",
    });
    const [runPayload, actPayload] = await Promise.all([
      readArchiveJson<RunData>(`/api/run?${runParams}`, signal),
      requestActivity(actParams, signal),
    ]);
    return {
      runId: targetRunId,
      data: runPayload,
      blocks: Array.isArray(actPayload.blocks) ? actPayload.blocks : [],
    };
  };

  const capturePrependAnchor = () => {
    const el = streamRef.current;
    if (el && !atBottom) {
      prependScrollAnchorRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
    }
  };

  const loadOlderRunSegment = async (upToRunId?: string) => {
    if (loadingOlderRun || !project) return;
    olderRunAbortRef.current?.abort();
    const controller = new AbortController();
    olderRunAbortRef.current = controller;
    setLoadingOlderRun(true);
    setOlderRunError(null);
    capturePrependAnchor();
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
      const fetched = await Promise.all(toFetch.map(id => fetchHistoricalRun(id, controller.signal)));
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

  const allCalls = useMemo(
    () => [...loadedOlderRuns.flatMap(r => r.data.calls), ...data.calls],
    [loadedOlderRuns, data.calls],
  );

  const computedSegments = useMemo(() => {
    const allSegments: StreamSegment[] = [];
    // Determine the run immediately preceding the earliest loaded run in `runs` (if any) so we can show inter-run gap
    let prevEndedAt: string | null = nextOlderRun?.endedAt ?? nextOlderRun?.startedAt ?? null;

    for (const older of loadedOlderRuns) {
      const olderInfo = runs.find(r => r.id === older.runId);
      const segs = buildCodexSegments(older.blocks, older.data.calls, older.data.observations, {
        runId: older.runId,
        cycles: older.data.cycles,
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

    const currentSegs = buildCodexSegments(feed.blocks, data.calls, data.observations, {
      runId: data.run,
      cycles: data.cycles,
      prevEndedAt,
      isLatestRun: isLiveRun,
      isAuto,
    });
    allSegments.push(...currentSegs);
    return allSegments;
  }, [loadedOlderRuns, runs, nextOlderRun, feed.blocks, data.calls, data.observations, data.run, data.cycles, isLiveRun, isAuto]);

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
    onClearJumpTarget?.();
    const el = streamRef.current;
    if (!el) return;
    programmaticScrollUntilRef.current = Date.now() + 600;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setAtBottom(true);
  };

  // Handle Quick-Jump Segment selection from top-right RunPicker without page reload
  useEffect(() => {
    if (!jumpTarget || lastJumpedSeqRef.current === jumpTarget.seq) return;
    if (!jumpTarget.value) {
      lastJumpedSeqRef.current = jumpTarget.seq;
      scrollToBottom();
      return;
    }
    const [targetRunId, targetEpoch] = jumpTarget.value.split("#");
    const container = streamRef.current;
    const selector = targetEpoch
      ? `[data-segment-anchor="${CSS.escape(`${targetRunId}#${targetEpoch}`)}"]`
      : `[data-run-id="${CSS.escape(targetRunId)}"]`;
    const targetEl = container?.querySelector<HTMLElement>(selector);
    if (targetEl && container) {
      lastJumpedSeqRef.current = jumpTarget.seq;
      programmaticScrollUntilRef.current = Date.now() + 1000;
      setAtBottom(false);
      const relativeTop =
        container.scrollTop +
        (targetEl.getBoundingClientRect().top - container.getBoundingClientRect().top) -
        12;
      container.scrollTo({
        top: Math.max(0, relativeTop),
        behavior: "smooth",
      });
      setHighlightedSegmentId(targetEl.id);
      setTimeout(() => {
        setHighlightedSegmentId(prev => (prev === targetEl.id ? null : prev));
      }, 2200);
      return;
    }
    if (
      targetRunId &&
      targetRunId !== data.run &&
      !loadedOlderRuns.some(r => r.runId === targetRunId) &&
      !loadingOlderRun
    ) {
      void loadOlderRunSegment(targetRunId);
    }
  }, [jumpTarget?.seq, jumpTarget?.value, segments.length, data.run, loadedOlderRuns, loadingOlderRun]);

  // Keep scrolled to bottom when new blocks arrive while following
  useEffect(() => {
    const el = streamRef.current;
    if (!el || !atBottom || feed.historical) return;
    el.scrollTop = el.scrollHeight;
  }, [segments.length, feed.blocks.length, atBottom, feed.historical]);

  const handleScroll = () => {
    const el = streamRef.current;
    if (!el) return;
    if (Date.now() < programmaticScrollUntilRef.current) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAtBottom(distance < 48);
  };

  const handleInspectBlock = (runId: string, block: ActivityBlock, siblingSteps: ActivityBlock[] = []) => {
    const ownerCalls =
      runId === data.run
        ? data.calls
        : (loadedOlderRuns.find(r => r.runId === runId)?.data.calls ?? allCalls);
    const matchedCall = resolveCallForTurn(block, siblingSteps, ownerCalls);
    setInspectedTurn(prev =>
      prev?.blockId === block.id
        ? null
        : {
            runId,
            blockId: block.id,
            callId: matchedCall?.id ?? null,
            imageId: null,
            at: block.at,
          },
    );
    setDockOpen(true);
    onSelectBlock?.(block);
  };

  const handleInspectInput = (runId: string, segId: string, call?: Call, imageId?: string, at?: string) => {
    setInspectedTurn(prev =>
      prev?.blockId === segId && prev?.imageId === (imageId ?? null)
        ? null
        : {
            runId,
            blockId: segId,
            callId: call?.id ?? null,
            imageId: imageId ?? null,
            at: at ?? call?.at ?? data.updatedAt,
          },
    );
    setDockOpen(true);
  };

  const inspectedRunData =
    inspectedTurn && inspectedTurn.runId !== data.run
      ? (loadedOlderRuns.find(r => r.runId === inspectedTurn.runId)?.data ?? data)
      : data;
  const inspectedCall = inspectedTurn?.callId
    ? inspectedRunData.calls.find(c => c.id === inspectedTurn.callId) ??
      allCalls.find(c => c.id === inspectedTurn.callId)
    : undefined;
  const activeBlockId = inspectedTurn?.blockId ?? selectedBlock;

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
  const updatedDeltaSec =
    isLiveRun && isAuto && refresh && Number.isFinite(Date.parse(data.updatedAt))
      ? Math.max(0, Math.min(10, Math.floor((nowMs - Date.parse(data.updatedAt)) / 1000)))
      : 0;
  const baseCycleElapsed =
    isAuto && activeMaxSeconds != null && typeof live?.remainingSeconds === "number"
      ? Math.max(0, activeMaxSeconds - live.remainingSeconds)
      : isAuto && latestCycle?.startedAt && Number.isFinite(Date.parse(latestCycle.startedAt))
        ? Math.max(0, Math.floor((Date.parse(data.updatedAt) - Date.parse(latestCycle.startedAt)) / 1000))
        : (latestCycleDurationSeconds ?? elapsedSeconds);
  const cycleElapsedSeconds =
    activeMaxSeconds != null
      ? Math.min(activeMaxSeconds, baseCycleElapsed + updatedDeltaSec)
      : baseCycleElapsed + updatedDeltaSec;
  const displayPhaseElapsedMs =
    phaseElapsedMs != null ? phaseElapsedMs + updatedDeltaSec * 1000 : null;
  const budgetRatio =
    activeMaxSeconds != null && activeMaxSeconds > 0
      ? Math.min(100, Math.round((cycleElapsedSeconds / activeMaxSeconds) * 100))
      : 100;

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
                {displayPhaseElapsedMs != null ? ` ${Math.max(0, Math.round(displayPhaseElapsedMs / 1000))}s` : ""}
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
            {(feed.hasMore || nextOlderRun || olderRunError) && (
              <div className="codex-load-older">
                <button
                  type="button"
                  className="codex-step-group-toggle"
                  disabled={feed.loadingOlder || loadingOlderRun}
                  onClick={() => {
                    if (feed.hasMore) {
                      capturePrependAnchor();
                      void feed.earlier();
                    } else if (nextOlderRun) {
                      void loadOlderRunSegment();
                    }
                  }}
                >
                  <span>
                    {feed.loadingOlder || loadingOlderRun
                      ? t("loadingOlder")
                      : olderRunError
                        ? `${t("olderRunLoadFailed")}: ${olderRunError} · ${t("retryOlderRun")}`
                        : feed.hasMore
                          ? t("loadOlderMessages")
                          : t("loadPreviousRunSegment")}
                  </span>
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
                  <article key={seg.id} className="codex-turn-assistant">
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

        {/* Floating Scroll-to-Bottom Button (just like ChatGPT/Codex) */}
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

        {/* Bottom Floating Pill Composer */}
        <ShioriComposer
          project={project}
          workspace={workspace}
          data={data}
          isLiveRun={isLiveRun}
          hostStatusOverride={activeHostOverride}
          onHostStatusChange={status =>
            setHostStatusOverride({ project, run: data.run, baseUpdatedAt: data.updatedAt, status })
          }
          perceptionInjectOverride={perceptionInject}
          onPerceptionChange={setPerceptionOverride}
          externalMode={workflowCommand?.mode ?? null}
          externalDraft={workflowCommand?.prompt ?? null}
          onExternalConsumed={() => setWorkflowCommand(null)}
          onReturnLatest={onReturnLatest}
          onUpdated={onUpdated}
        />
      </section>

      {/* ── RIGHT WORKBENCH DOCK: LIVE VIEWPORT + COMPACT HOST OPS + TELEMETRY ── */}
      {dockOpen && (
        <aside className="codex-right-dock" aria-label={t("stageColumnAria")}>
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

            {/* 2. Compact Loop Budget & Session Telemetry */}
            {summary && (
              <div className="codex-dock-section">
                <div className="flex items-center justify-between">
                  <h3 className="codex-dock-heading">{t("telemetryCardTitle")}</h3>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {activeMaxSeconds != null
                      ? `${formatDurationCompact(cycleElapsedSeconds)} / ${formatDurationCompact(activeMaxSeconds)}`
                      : `${formatDurationCompact(elapsedSeconds)} · ∞ ${t("durationUnbounded")}`}
                  </span>
                </div>

                <div
                  className="shiori-budget-bar"
                  data-unbounded={activeMaxSeconds == null || undefined}
                  role="progressbar"
                  aria-valuenow={budgetRatio}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div className="shiori-budget-bar-fill" style={{ width: `${budgetRatio}%` }} />
                </div>

                <div className="codex-stat-cards">
                  <div className="codex-stat-card">
                    <div className="codex-stat-card-top">
                      <span>{t("tileTurns")}</span>
                      <strong>{summary.completed}</strong>
                    </div>
                    <small>{t("tileTotalCalls").replace("{total}", String(data.paging.totalCalls))}</small>
                  </div>
                  <div className="codex-stat-card">
                    <div className="codex-stat-card-top">
                      <span>{t("tileActions")}</span>
                      <strong>{summary.actions}</strong>
                    </div>
                    <small>{t("tileObserves").replace("{count}", String(summary.explicitObserves))}</small>
                  </div>
                  <div className="codex-stat-card">
                    <div className="codex-stat-card-top">
                      <span>{t("tileLatency")}</span>
                      <strong>{summary.medianMs != null ? `${(summary.medianMs / 1000).toFixed(1)}s` : "—"}</strong>
                    </div>
                    <small>P95 {summary.p95Ms != null ? `${(summary.p95Ms / 1000).toFixed(1)}s` : "—"}</small>
                  </div>
                  <div className="codex-stat-card">
                    <div className="codex-stat-card-top">
                      <span>{t("tileCache")}</span>
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
                      {(data.manifest.model ?? t("deviceOnly")).replace(/^[^/]+\//, "")}
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
                      <dd>{data.manifest.model ?? t("deviceOnly")}</dd>
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
