import type { PoolEvent } from "@ludens/protocol/event-pool";
import type { ActivityBlock } from "@/features/live/activity-feed-model";
import type { Call, Observation, RunData } from "@/lib/types";

export function cleanErrorMessage(raw: string): string {
  return raw.replace(/(?:LudensError:\s*|Error:\s*)+/gi, "").trim() || raw;
}

export function cleanInlinePreview(raw: string | undefined | null): string {
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

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function isUserMessageBlock(block: ActivityBlock): boolean {
  const record = asRecord(block.data);
  if (block.kind === "text" && record?.role === "user") return true;
  if (block.kind === "system" && block.title === "user_message") return true;
  return false;
}

export function isOutboundPoolEventBlock(block: ActivityBlock): boolean {
  const record = asRecord(block.data);
  return block.kind === "text" && record?.role === "shiori_event" && Boolean(asRecord(record.event));
}

export function isAssistantTextBlock(block: ActivityBlock): boolean {
  const record = asRecord(block.data);
  return (
    block.kind === "text" &&
    block.source?.component === "shiori" &&
    record?.role !== "user" &&
    record?.role !== "shiori_event"
  );
}

export function extractReadableText(block: ActivityBlock): string {
  const record = asRecord(block.data);
  if (typeof record?.text === "string" && record.text.trim()) {
    return record.text.trim();
  }
  if (typeof block.text === "string" && block.text.trim()) {
    return block.text.trim();
  }
  return block.title;
}

export function summarizeStepBlock(block: ActivityBlock): { badge: string; detail: string } {
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
    if (titleLower === "event_pool" || titleLower.endsWith(":event_pool")) {
      const act = typeof args?.action === "string" ? args.action : "pool";
      const sub =
        typeof args?.title === "string" && args.title.trim()
          ? args.title.trim()
          : typeof args?.text === "string" && args.text.trim()
            ? args.text.trim().replace(/\s+/g, " ").slice(0, 64)
            : "";
      return { badge: "📬 event_pool", detail: sub ? `${act} · ${sub}` : act };
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
    if (block.title === "control_budget") {
      const reqSec = rec?.requestedSeconds;
      const detail =
        reqSec == null
          ? "∞ Continuous (timer cleared)"
          : typeof reqSec === "number"
            ? `Stop in ${Math.round(reqSec / 60) || 1}m (${reqSec}s)`
            : cleanInlinePreview(block.text) || "Timer updated";
      return { badge: "⏱ timer", detail };
    }
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

export function isBackgroundResultBlock(block: ActivityBlock): boolean {
  return block.kind === "system" && block.title === "background_result";
}

export function callHasExternalInput(call: Call): boolean {
  return (
    call.inputObservations.length > 0 ||
    Boolean(call.inputText && call.inputText.trim()) ||
    Boolean(call.perception)
  );
}

export function isControlBlock(block: ActivityBlock): boolean {
  return block.kind === "system" && block.title === "control";
}

export type StreamSegment =
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
  | {
      kind: "user";
      id: string;
      block: ActivityBlock;
      text: string;
      mode: string;
      poolEvent?: PoolEvent;
    }
  | {
      kind: "outbound_event";
      id: string;
      block: ActivityBlock;
      event: PoolEvent;
    }
  | {
      kind: "pool_receipt";
      id: string;
      runId?: string;
      block: ActivityBlock;
      actor: "shiori" | "human";
      ids: string[];
      events: PoolEvent[];
      at: string;
    }
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

export function isPoolReceiptBlock(block: ActivityBlock): boolean {
  return (
    block.kind === "system" &&
    (block.title === "pool_receipt" || asRecord(block.data)?.role === "pool_receipt")
  );
}

function asPoolEvent(value: unknown): PoolEvent | null {
  const record = asRecord(value);
  return record && typeof record.id === "string" ? (record as unknown as PoolEvent) : null;
}

/** Inbound Event Pool payload carried by a `user` creation block (if any). */
export function extractPoolEventFromBlock(block: ActivityBlock): PoolEvent | null {
  return isUserMessageBlock(block) ? asPoolEvent(asRecord(block.data)?.event) : null;
}

/** Outbound Shiori Event Pool payload carried by a `shiori_event` creation block (if any). */
export function extractOutboundPoolEvent(block: ActivityBlock): PoolEvent | null {
  return isOutboundPoolEventBlock(block) ? asPoolEvent(asRecord(block.data)?.event) : null;
}

export interface PoolReceiptInfo {
  actor: "shiori" | "human";
  ids: string[];
  events: PoolEvent[];
}

/** Parses `pool_event(handled)` receipt blocks: `{ role: "pool_receipt", action: "handled", actor, ids, events }`. */
export function parsePoolReceiptBlock(block: ActivityBlock): PoolReceiptInfo | null {
  if (!isPoolReceiptBlock(block)) return null;
  const record = asRecord(block.data);
  const actor = record?.actor === "human" ? "human" : "shiori";
  const events = Array.isArray(record?.events)
    ? record.events.map(asPoolEvent).filter((item): item is PoolEvent => Boolean(item))
    : [];
  const ids = [
    ...new Set([
      ...(Array.isArray(record?.ids) ? record.ids.filter((id): id is string => typeof id === "string") : []),
      ...events.map(item => item.id),
    ]),
  ];
  return { actor, ids, events };
}

/** Chronological anchor (ms) of a stream segment; `NaN` when unknown. */
export function segmentTimestampMs(seg: StreamSegment): number {
  switch (seg.kind) {
    case "session_divider":
      return Date.parse(seg.startedAt);
    case "user":
      return Date.parse(seg.poolEvent?.createdAt ?? seg.block.at);
    case "outbound_event":
      return Date.parse(seg.event.createdAt ?? seg.block.at);
    case "pool_receipt":
      return Date.parse(seg.at);
    case "input":
      return Date.parse(seg.at);
    case "turn":
      return Date.parse(seg.steps[0]?.at ?? seg.responseBlock?.at ?? "");
  }
}

export interface MergePoolSnapshotOptions {
  /** Floor (ms) of the loaded stream window; ignored when `hasMoreUpwardHistory` is false. */
  earliestLoadedMs: number;
  /** Whether older history can still be paged in above the loaded window. */
  hasMoreUpwardHistory: boolean;
}

/**
 * Synthesizes workspace Event Pool items that are not yet projected in the loaded stream
 * (e.g. standby/offline submissions) and inserts each one at its true `createdAt` position.
 * Items older than the loaded window stay out while upward history remains unloaded.
 */
export function mergePoolSnapshotSegments(
  segments: StreamSegment[],
  poolEvents: PoolEvent[],
  options: MergePoolSnapshotOptions,
): StreamSegment[] {
  const seen = new Set<string>();
  for (const seg of segments) {
    if (seg.kind === "user" && seg.poolEvent?.id) seen.add(seg.poolEvent.id);
    if (seg.kind === "outbound_event") seen.add(seg.event.id);
  }
  const enforceFloor = options.hasMoreUpwardHistory && Number.isFinite(options.earliestLoadedMs);
  const missing = poolEvents
    .filter(item => {
      if (seen.has(item.id)) return false;
      const createdMs = Date.parse(item.createdAt);
      if (!Number.isFinite(createdMs)) return false;
      if (enforceFloor && createdMs < options.earliestLoadedMs) return false;
      return true;
    })
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.seq - b.seq);
  if (missing.length === 0) return segments;

  const result = [...segments];
  for (const item of missing) {
    seen.add(item.id);
    const createdMs = Date.parse(item.createdAt);
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
    const synthetic: StreamSegment =
      item.direction === "inbound"
        ? { kind: "user", id: syntheticBlock.id, block: syntheticBlock, text: item.text, mode: "event", poolEvent: item }
        : { kind: "outbound_event", id: syntheticBlock.id, block: syntheticBlock, event: item };
    let insertAt = 0;
    for (let idx = result.length - 1; idx >= 0; idx--) {
      const ts = segmentTimestampMs(result[idx]);
      if (Number.isFinite(ts) && ts <= createdMs) {
        insertAt = idx + 1;
        break;
      }
    }
    result.splice(insertAt, 0, synthetic);
  }
  return result;
}

export interface BuildSegmentsOptions {
  runId?: string;
  cycles?: RunData["cycles"];
  fallbackStartedAt?: string;
  prevEndedAt?: string | null;
  isLatestRun?: boolean;
  isAuto?: boolean;
}

/**
 * Groups raw ActivityBlocks and external Call inputs into Codex-style conversational segments:
 * - Explicit Session Segment & Time-Gap Dividers (`session_divider`) across control cycles (`epoch`) and runs
 * - User bubbles (`user_message`)
 * - Outbound Shiori Event Pool cards (`outbound_event`)
 * - External Agent Loop Input blocks (`CodexInputCard` from `call.inputObservations` / `call.inputText` / `call.perception` / `background_result`)
 * - Collapsed intermediate step groups (`上 N 条消息 / 执行步骤 >`) paired with Shiori's readable prose response
 */
export function buildCodexSegments(
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

  // Pre-scan Event Pool creation + `pool_receipt` blocks so historical bubbles reflect their handled state
  // and receipts can resolve event payloads even outside the snapshot retention window.
  const createdEventsById = new Map<string, PoolEvent>();
  const handledEventsById = new Map<string, PoolEvent>();
  for (const block of blocks) {
    const created = extractPoolEventFromBlock(block) ?? extractOutboundPoolEvent(block);
    if (created) createdEventsById.set(created.id, created);
  }
  for (const block of blocks) {
    const receipt = parsePoolReceiptBlock(block);
    if (!receipt) continue;
    for (const id of receipt.ids) {
      const fromReceipt = receipt.events.find(item => item.id === id);
      const base = fromReceipt ?? createdEventsById.get(id);
      handledEventsById.set(id, {
        ...(base ?? ({ id } as PoolEvent)),
        status: "handled",
        handledAt: fromReceipt?.handledAt ?? block.at,
        handledBy: fromReceipt?.handledBy ?? receipt.actor,
      });
    }
  }
  const enrichPoolEvent = (event: PoolEvent): PoolEvent => {
    if (event.status !== "pending") return event;
    const handled = handledEventsById.get(event.id);
    return handled
      ? { ...event, status: "handled", handledAt: handled.handledAt, handledBy: handled.handledBy }
      : event;
  };
  const segPrefix = options.runId ? `${options.runId}:` : "";

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
      const rec = asRecord(block.data);
      const ep = block.trace?.epoch ?? (typeof rec?.epoch === "string" ? rec.epoch : null);
      if (rec?.mode === "auto") {
        // If only brief startup system steps (< 60s) preceded the first cycle in this run,
        // emit the cycle header first so the run opens cleanly with its divider.
        const onlyBootSystemSteps =
          segments.length === 0 &&
          pendingSteps.length > 0 &&
          pendingSteps.every(step => step.kind === "system") &&
          blockMs > 0 &&
          blockMs - (Date.parse(pendingSteps[0].at) || blockMs) <= 60_000;
        if (!onlyBootSystemSteps) {
          flushTurn();
        }
        currentEpoch = ep;
        lastPostBlockMs = 0;
        emitDividerForEpoch(ep, block.at, rec);
      } else if (rec?.mode === "manual") {
        flushTurn();
        if (ep || currentEpoch) {
          lastSegmentEndedAt = block.at;
        }
        currentEpoch = null;
        lastPostBlockMs = 0;
      } else {
        flushTurn();
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
      const fallbackStartMs = fallbackCycle ? Date.parse(fallbackCycle.startedAt) : NaN;
      const fallbackClosedEnd = fallbackCycle?.endedAt ?? (fallbackCycle ? manualEndByEpoch.get(fallbackCycle.epoch)?.endedAt : null) ?? null;
      const fallbackClosedMs = fallbackClosedEnd ? Date.parse(fallbackClosedEnd) : NaN;
      if (fallbackCycle && Number.isFinite(fallbackStartMs) && blockMs > 0 && blockMs < fallbackStartMs - 250) {
        // Pre-cycle block arrived before cycles[0] started: never emit cycles[0] prematurely out of chronological order.
        if (fallbackStartMs - blockMs > 60_000 || block.kind !== "system") {
          lastPostBlockMs = blockMs;
          emitDividerForEpoch(`post:pre:${options.runId}`, block.at);
        }
      } else if (fallbackCycle && Number.isFinite(fallbackClosedMs) && blockMs > fallbackClosedMs + 30_000) {
        emitDividerForEpoch(fallbackCycle.epoch, fallbackCycle.startedAt);
        lastPostBlockMs = blockMs;
        emitDividerForEpoch(`post:${block.id}`, block.at);
      } else {
        emitDividerForEpoch(fallbackCycle?.epoch ?? `post:standby:${options.runId}`, block.at);
      }
    }

    if (isUserMessageBlock(block)) {
      flushTurn();
      const record = asRecord(block.data);
      const poolEvent = extractPoolEventFromBlock(block);
      segments.push({
        kind: "user",
        id: block.id,
        block,
        text: extractReadableText(block),
        mode: typeof record?.mode === "string" ? record.mode : "start",
        ...(poolEvent ? { poolEvent: enrichPoolEvent(poolEvent) } : {}),
      });
      continue;
    }

    if (isOutboundPoolEventBlock(block)) {
      flushTurn();
      const outbound = extractOutboundPoolEvent(block);
      if (outbound) {
        segments.push({
          kind: "outbound_event",
          id: block.id,
          block,
          event: enrichPoolEvent(outbound),
        });
      }
      continue;
    }

    const receipt = parsePoolReceiptBlock(block);
    if (receipt) {
      const events = receipt.ids
        .map(id => {
          const fromReceipt = receipt.events.find(item => item.id === id);
          const created = createdEventsById.get(id);
          if (!fromReceipt && !created) return null;
          return {
            ...created,
            ...fromReceipt,
            status: "handled",
            handledAt: fromReceipt?.handledAt ?? block.at,
            handledBy: fromReceipt?.handledBy ?? receipt.actor,
          } as PoolEvent;
        })
        .filter((item): item is PoolEvent => Boolean(item));
      const resolvesOutbound = events.some(item => item.direction === "outbound");
      // Human self-withdrawal of unread inbound messages updates the sent bubble in place: no receipt card.
      if (receipt.actor === "shiori" || resolvesOutbound) {
        flushTurn();
        segments.push({
          kind: "pool_receipt",
          id: `${segPrefix}pool-receipt:${block.id}`,
          runId: options.runId,
          block,
          actor: receipt.actor,
          ids: receipt.ids,
          events,
          at: block.at,
        });
      }
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
  if (segments.length === 0 && options.runId && ((options.cycles?.length ?? 0) > 0 || !options.isLatestRun)) {
    const firstCycle = options.cycles?.[0];
    emitDividerForEpoch(
      firstCycle?.epoch ?? `post:standby:${options.runId}`,
      firstCycle?.startedAt ?? options.fallbackStartedAt ?? new Date(0).toISOString(),
    );
  }
  return segments;
}
