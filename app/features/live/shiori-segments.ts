import type { PoolEvent } from "@ludens/protocol/event-pool";
import type { ActivityBlock } from "@/features/live/activity-feed-model";
import type { Call, Observation, PerceptionSnapshot, RunData } from "@/lib/types";

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

export function isInterTurnPythonCallBlock(block: ActivityBlock): boolean {
  const topRecord = asRecord(block);
  const hasModelCallId = Boolean(
    block.trace?.modelCallId ||
      (typeof topRecord?.modelCallId === "string" && topRecord.modelCallId),
  );
  if (hasModelCallId) return false;
  const recordingPurpose =
    typeof topRecord?.recordingPurpose === "string"
      ? topRecord.recordingPurpose
      : block.trace?.recordingPurpose;
  if (recordingPurpose !== "loop") return false;
  const data = asRecord(block.data);
  if (data?.role === "loop_capability") return true;
  const kindStr = String(block.kind);
  const titleLower = block.title.toLowerCase();
  if (kindStr === "python-call" || titleLower === "python-call" || titleLower === "python_call") {
    return true;
  }
  if (block.id.startsWith("python:") || block.title.startsWith("Python 调用")) {
    return true;
  }
  if (
    block.kind === "tool" &&
    (titleLower.startsWith("python/") ||
      titleLower.includes("capability") ||
      typeof asRecord(block.tool?.args)?.capability === "string" ||
      typeof data?.capability === "string")
  ) {
    return true;
  }
  if (block.kind === "system" && block.title === "capability_end" && Boolean(block.trace?.epoch)) {
    return true;
  }
  return false;
}

export function isLoopOrchestrationBlock(block: ActivityBlock): boolean {
  const data = asRecord(block.data);
  const role = data?.role;
  if (
    role === "loop_step" ||
    role === "loop_fault" ||
    role === "loop_status" ||
    role === "loop_capability"
  ) {
    return true;
  }
  if (
    block.title === "loop_step" ||
    block.title === "loop_fault" ||
    block.title === "loop_status"
  ) {
    return true;
  }
  return isInterTurnPythonCallBlock(block);
}

export function summarizeLoopActions(steps: ActivityBlock[]): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  const add = (label: string) => {
    if (!label || seen.has(label)) return;
    seen.add(label);
    labels.push(label);
  };
  for (const step of steps) {
    const rec = asRecord(step.data);
    const role = rec?.role;
    if (step.title === "loop_fault" || role === "loop_fault") {
      add("fault");
      continue;
    }
    if (step.title === "loop_step" || role === "loop_step") {
      const action = typeof rec?.action === "string" ? rec.action : "";
      if (action) add(action);
      continue;
    }
    if (isInterTurnPythonCallBlock(step)) {
      add("capability");
      continue;
    }
    if (step.status === "error") {
      add("fault");
    } else if ((step.title === "loop_status" || role === "loop_status") && steps.length === 1) {
      const state = typeof rec?.state === "string" ? rec.state : "";
      if (state) add(state);
    }
  }
  return labels;
}

function formatLeanRecordFallback(snap: PerceptionSnapshot, text?: string): Record<string, unknown> {
  return {
    id: snap.id,
    sequence: snap.sequence,
    recordedAt: snap.recordedAt,
    ...(snap.capability && snap.capability !== "python/perception.py:Perception.sample"
      ? { capability: snap.capability }
      : {}),
    ...(text ? { text } : {}),
    ...(snap.data !== undefined ? { data: snap.data } : {}),
    ...(snap.space !== undefined ? { space: snap.space } : {}),
    ...(snap.effect !== undefined ? { effect: snap.effect } : {}),
    ...(snap.transition !== undefined ? { transition: snap.transition } : {}),
  };
}

/**
 * Formats the 1:1 model input inspector string for `CodexInputCard`:
 * - When `perception.deliveredPayload !== undefined`, renders strings directly or `JSON.stringify(deliveredPayload, null, 2)`.
 * - For older historical runs without `deliveredPayload`, builds a clean lean fallback envelope without `at`, `queryId`, or duplicate `snapshot`.
 */
export function formatModelInputPayload(call?: Call, bgBlock?: ActivityBlock): string {
  if (call?.perception) {
    const p = call.perception;
    if (p.deliveredPayload !== undefined) {
      return typeof p.deliveredPayload === "string"
        ? p.deliveredPayload
        : (JSON.stringify(p.deliveredPayload, null, 2) ?? "null");
    }
    if (p.ok === false) {
      return JSON.stringify(
        {
          ok: false,
          ...(p.error ? { error: p.error } : {}),
          ...(p.availability ? { availability: p.availability } : {}),
          ...(p.deliveryError ? { deliveryError: p.deliveryError } : {}),
        },
        null,
        2,
      );
    }
    const leanRecords = p.records
      ? p.records.map(rec => formatLeanRecordFallback(rec.snapshot, rec.text || undefined))
      : p.snapshot
        ? [formatLeanRecordFallback(p.snapshot, call.inputText || undefined)]
        : [];
    const q = p.query ?? {};
    const isHistoricalOrFiltered = Boolean(
      q.id ||
        q.at ||
        q.start ||
        q.end ||
        q.after !== undefined ||
        q.limit !== undefined ||
        q.capability !== undefined,
    );
    return JSON.stringify(
      {
        ok: p.ok ?? true,
        ...(isHistoricalOrFiltered && p.query ? { query: p.query } : {}),
        records: leanRecords,
        ...(isHistoricalOrFiltered ? { hasMore: Boolean(p.hasMore) } : {}),
        ...(isHistoricalOrFiltered && p.nextAfter !== undefined ? { nextAfter: p.nextAfter } : {}),
        ...(isHistoricalOrFiltered && p.availability ? { availability: p.availability } : {}),
        ...(p.deliveryError ? { deliveryError: p.deliveryError } : {}),
      },
      null,
      2,
    );
  }
  if (call) {
    if (call.inputText) return call.inputText;
    return JSON.stringify(
      call.inputObservations.length > 0 ? { observations: call.inputObservations } : {},
      null,
      2,
    );
  }
  const raw = bgBlock?.data ?? bgBlock;
  return typeof raw === "string" ? raw : (JSON.stringify(raw, null, 2) ?? "");
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
    if (block.title === "loop_step" || rec?.role === "loop_step") {
      return {
        badge: "↻ loop",
        detail: previewText || (typeof rec?.action === "string" ? rec.action : "loop_step"),
      };
    }
    if (block.title === "loop_fault" || rec?.role === "loop_fault") {
      return {
        badge: "⚠ loop_fault",
        detail: cleanErrorMessage(previewText || String(rec?.error ?? "loop.py fault")),
      };
    }
    if (block.title === "loop_status" || rec?.role === "loop_status") {
      return {
        badge: "● loop_status",
        detail: previewText || String(rec?.state ?? "loop_status"),
      };
    }
    if (rec?.role === "loop_capability") {
      return {
        badge: "⚡ capability",
        detail: previewText || String(rec?.capability ?? block.title),
      };
    }
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

  if (isInterTurnPythonCallBlock(block)) {
    const rec = asRecord(block.data);
    return {
      badge: "⚡ capability",
      detail:
        previewText ||
        (typeof rec?.capability === "string" ? rec.capability : "") ||
        block.title.replace(/^Python 调用 · /, ""),
    };
  }

  return { badge: block.source?.component ?? "step", detail: previewText || block.title };
}

export type SystemStepCategory = "device" | "perception" | "timer" | "compaction" | "host";

export function summarizeSystemCategories(steps: ActivityBlock[]): SystemStepCategory[] {
  const seen = new Set<SystemStepCategory>();
  for (const step of steps) {
    if (step.kind !== "system") continue;
    const title = step.title.toLowerCase();
    const text = (step.text || "").toLowerCase();
    if (
      title.includes("device") ||
      title.includes("baseware") ||
      text.includes("econnreset") ||
      text.includes("device disconnected")
    ) {
      seen.add("device");
    } else if (title.includes("perception")) {
      seen.add("perception");
    } else if (title === "control_budget") {
      seen.add("timer");
    } else if (title.includes("compaction")) {
      seen.add("compaction");
    } else {
      seen.add("host");
    }
  }
  const order: SystemStepCategory[] = ["device", "perception", "timer", "compaction", "host"];
  return order.filter(cat => seen.has(cat));
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
      standby?: boolean;
      stepGroupVariant?: "loop";
      loopFault?: boolean;
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
  /** True while the run's initial activity blocks are still in flight, suppressing premature orphan call cards. */
  blocksLoading?: boolean;
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
  const closedEpochs = new Set<string>();
  const segments: StreamSegment[] = [];
  let pendingSteps: ActivityBlock[] = [];
  let pendingLoopSteps: ActivityBlock[] = [];
  let currentEpoch: string | null = null;
  let lastSegmentEndedAt: string | null = options.prevEndedAt ?? null;
  let emittedPostAfterCycle = false;
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

  const flushLoopSteps = () => {
    if (pendingLoopSteps.length === 0) return;
    const anchorId = pendingLoopSteps[0]!.id;
    const hasFault = pendingLoopSteps.some(
      item =>
        item.status === "error" ||
        item.title === "loop_fault" ||
        asRecord(item.data)?.role === "loop_fault" ||
        (item.title === "loop_status" && asRecord(item.data)?.state === "error"),
    );
    segments.push({
      kind: "turn",
      id: `loop-steps:${options.runId ?? ""}:${anchorId}`,
      runId: options.runId,
      steps: pendingLoopSteps,
      responseBlock: null,
      responseText: null,
      stepGroupVariant: "loop",
      ...(hasFault ? { loopFault: true } : {}),
    });
    pendingLoopSteps = [];
  };

  const flushTurn = (explicitResponse?: ActivityBlock) => {
    flushLoopSteps();
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
        ...(currentEpoch === null ? { standby: true } : {}),
      });
    }
    pendingSteps = [];
  };

  const referencedCallIds = new Set(
    blocks.map(b => b.trace?.modelCallId).filter((id): id is string => Boolean(id)),
  );
  const windowStartMs = blocks.length > 0 ? (Date.parse(blocks[0].at) || 0) - 5_000 : 0;
  const orphanInputCalls =
    options.blocksLoading && blocks.length === 0
      ? []
      : calls
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
    const recordRecordedAt =
      call.perception?.records?.at(-1)?.snapshot?.recordedAt ??
      call.perception?.records?.[0]?.snapshot?.recordedAt ??
      call.perception?.snapshot?.recordedAt;
    segments.push({
      kind: "input",
      id: `input-call:${call.id}`,
      runId: options.runId,
      call,
      observations: resolvedObs,
      at: recordRecordedAt ?? resolvedObs[0]?.at ?? call.at,
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
        const firstBootAt = (pendingSteps[0] ?? pendingLoopSteps[0])?.at;
        const onlyBootSystemSteps =
          segments.length === 0 &&
          (pendingSteps.length > 0 || pendingLoopSteps.length > 0) &&
          pendingSteps.every(step => step.kind === "system") &&
          pendingLoopSteps.every(step => step.kind === "system") &&
          blockMs > 0 &&
          blockMs - (Date.parse(firstBootAt ?? "") || blockMs) <= 60_000;
        if (!onlyBootSystemSteps) {
          flushTurn();
        }
        if (ep) closedEpochs.delete(ep);
        currentEpoch = ep;
        emittedPostAfterCycle = false;
        emitDividerForEpoch(ep, block.at, rec);
      } else if (rec?.mode === "manual") {
        // Only flush and record a cycle boundary when transitioning out of an active cycle.
        // Redundant `control(manual)` snapshots emitted during standby (e.g. device reconnects)
        // must not split ongoing passive standby system events into separate step groups.
        if (ep || currentEpoch) {
          flushTurn();
          if (ep) closedEpochs.add(ep);
          if (currentEpoch) closedEpochs.add(currentEpoch);
          lastSegmentEndedAt = block.at;
          currentEpoch = null;
          emittedPostAfterCycle = false;
        }
      } else {
        flushTurn();
      }
      continue;
    }

    const passiveStandby =
      block.kind === "system" &&
      !isUserMessageBlock(block) &&
      !isBackgroundResultBlock(block) &&
      !isPoolReceiptBlock(block);
    const rawBlockEpoch = block.trace?.epoch ?? null;
    const blockEpoch = rawBlockEpoch && !(passiveStandby && closedEpochs.has(rawBlockEpoch)) ? rawBlockEpoch : null;
    const hasDedicatedCard =
      isUserMessageBlock(block) ||
      isOutboundPoolEventBlock(block) ||
      isPoolReceiptBlock(block);

    if (blockEpoch && blockEpoch !== currentEpoch) {
      flushTurn();
      currentEpoch = blockEpoch;
      emittedPostAfterCycle = false;
      emitDividerForEpoch(blockEpoch, block.at);
    } else if (!blockEpoch && currentEpoch) {
      const closedEnd =
        cyclesByEpoch.get(currentEpoch)?.endedAt ?? manualEndByEpoch.get(currentEpoch)?.endedAt ?? null;
      const closedMs = closedEnd ? Date.parse(closedEnd) : NaN;
      if (Number.isFinite(closedMs) && blockMs > closedMs + 30_000) {
        flushTurn();
        closedEpochs.add(currentEpoch);
        lastSegmentEndedAt = closedEnd;
        currentEpoch = null;
        emittedPostAfterCycle = false;
        if (!passiveStandby && !hasDedicatedCard) {
          emittedPostAfterCycle = true;
          emitDividerForEpoch(`post:${block.id}`, block.at);
        }
      }
    } else if (!blockEpoch && !currentEpoch && segments.length > 0 && blockMs > 0) {
      // Passive standby system events (device reconnects, perception status/faults) stay coalesced
      // in a single standby disclosure without emitting repeated session dividers.
      if (!passiveStandby && !hasDedicatedCard && !emittedPostAfterCycle) {
        const prevEndMs = lastSegmentEndedAt ? Date.parse(lastSegmentEndedAt) : NaN;
        if (Number.isFinite(prevEndMs) && blockMs > prevEndMs + 30_000) {
          flushTurn();
          emittedPostAfterCycle = true;
          emitDividerForEpoch(`post:${block.id}`, block.at);
        }
      }
    } else if (!blockEpoch && segments.length === 0 && pendingSteps.length === 0 && pendingLoopSteps.length === 0 && options.runId) {
      const fallbackCycle = options.cycles?.[0];
      const fallbackStartMs = fallbackCycle ? Date.parse(fallbackCycle.startedAt) : NaN;
      const fallbackClosedEnd = fallbackCycle?.endedAt ?? (fallbackCycle ? manualEndByEpoch.get(fallbackCycle.epoch)?.endedAt : null) ?? null;
      const fallbackClosedMs = fallbackClosedEnd ? Date.parse(fallbackClosedEnd) : NaN;
      if (fallbackCycle && Number.isFinite(fallbackStartMs) && blockMs > 0 && blockMs < fallbackStartMs - 250) {
        // Pre-cycle block arrived before cycles[0] started: never emit cycles[0] prematurely out of chronological order.
        if (fallbackStartMs - blockMs > 60_000 || block.kind !== "system") {
          emitDividerForEpoch(`post:pre:${options.runId}`, block.at);
        }
      } else if (fallbackCycle && Number.isFinite(fallbackClosedMs) && blockMs > fallbackClosedMs + 30_000) {
        emitDividerForEpoch(fallbackCycle.epoch, fallbackCycle.startedAt);
        closedEpochs.add(fallbackCycle.epoch);
        lastSegmentEndedAt = fallbackClosedEnd;
        if (!passiveStandby && !hasDedicatedCard) {
          emittedPostAfterCycle = true;
          emitDividerForEpoch(`post:${block.id}`, block.at);
        }
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

    if (isLoopOrchestrationBlock(block)) {
      if (pendingSteps.length > 0) {
        flushTurn();
      }
      pendingLoopSteps.push(block);
      continue;
    }

    if (pendingLoopSteps.length > 0) {
      flushLoopSteps();
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

function sameBlockRefOrRev(left: ActivityBlock | null | undefined, right: ActivityBlock | null | undefined): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.id === right.id && left.revision === right.revision && left.status === right.status && left.text === right.text;
}

function sameStepsArray(left: ActivityBlock[], right: ActivityBlock[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (!sameBlockRefOrRev(left[i], right[i])) return false;
  }
  return true;
}

function samePoolEventValue(left: PoolEvent | undefined, right: PoolEvent | undefined): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.id === right.id &&
    left.seq === right.seq &&
    left.status === right.status &&
    left.handledAt === right.handledAt &&
    left.handledBy === right.handledBy &&
    left.text === right.text &&
    left.title === right.title &&
    left.pauseRequested === right.pauseRequested
  );
}

function sameCallSummary(left: Call | undefined, right: Call | undefined): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.id === right.id &&
    left.index === right.index &&
    left.at === right.at &&
    left.inputText === right.inputText &&
    left.perception?.injectionMode === right.perception?.injectionMode &&
    left.perception?.deliveredPayload === right.perception?.deliveredPayload &&
    left.inputObservations.length === right.inputObservations.length &&
    left.inputObservations.every((id, idx) => id === right.inputObservations[idx])
  );
}

function sameObservationsList(left: Observation[], right: Observation[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i].id !== right[i].id || left[i].at !== right[i].at || left[i].mediaStorage !== right[i].mediaStorage) {
      return false;
    }
  }
  return true;
}

/**
 * Reconciles a freshly built `StreamSegment[]` against the previous array so that
 * unchanged historical segments (and `turn.steps` arrays) preserve exact object identity
 * across 2.5s live polls, allowing `React.memo` segment rows to skip re-rendering.
 */
export function reconcileSegments(previous: StreamSegment[], next: StreamSegment[]): StreamSegment[] {
  if (previous.length === 0 || next.length === 0) return next;
  const prevById = new Map<string, StreamSegment>();
  for (const seg of previous) prevById.set(seg.id, seg);

  let allIdentical = previous.length === next.length;
  const reconciled = next.map((seg, index) => {
    const prior = prevById.get(seg.id);
    if (!prior || prior.kind !== seg.kind) {
      allIdentical = false;
      return seg;
    }

    let keepPrior = false;
    switch (seg.kind) {
      case "session_divider": {
        const p = prior as Extract<StreamSegment, { kind: "session_divider" }>;
        keepPrior =
          p.runId === seg.runId &&
          p.epoch === seg.epoch &&
          p.cycleIndex === seg.cycleIndex &&
          p.startedAt === seg.startedAt &&
          p.endedAt === seg.endedAt &&
          p.durationSeconds === seg.durationSeconds &&
          p.maxSeconds === seg.maxSeconds &&
          p.stopReason === seg.stopReason &&
          p.gapSeconds === seg.gapSeconds &&
          p.isActive === seg.isActive;
        break;
      }
      case "user": {
        const p = prior as Extract<StreamSegment, { kind: "user" }>;
        keepPrior =
          sameBlockRefOrRev(p.block, seg.block) &&
          p.text === seg.text &&
          p.mode === seg.mode &&
          samePoolEventValue(p.poolEvent, seg.poolEvent);
        break;
      }
      case "outbound_event": {
        const p = prior as Extract<StreamSegment, { kind: "outbound_event" }>;
        keepPrior = sameBlockRefOrRev(p.block, seg.block) && samePoolEventValue(p.event, seg.event);
        break;
      }
      case "pool_receipt": {
        const p = prior as Extract<StreamSegment, { kind: "pool_receipt" }>;
        keepPrior =
          sameBlockRefOrRev(p.block, seg.block) &&
          p.actor === seg.actor &&
          p.at === seg.at &&
          p.ids.length === seg.ids.length &&
          p.ids.every((id, i) => id === seg.ids[i]) &&
          p.events.length === seg.events.length &&
          p.events.every((ev, i) => samePoolEventValue(ev, seg.events[i]));
        break;
      }
      case "input": {
        const p = prior as Extract<StreamSegment, { kind: "input" }>;
        keepPrior =
          p.runId === seg.runId &&
          p.at === seg.at &&
          sameCallSummary(p.call, seg.call) &&
          sameObservationsList(p.observations, seg.observations) &&
          sameBlockRefOrRev(p.bgBlock, seg.bgBlock);
        break;
      }
      case "turn": {
        const p = prior as Extract<StreamSegment, { kind: "turn" }>;
        const stepsUnchanged = sameStepsArray(p.steps, seg.steps);
        const respUnchanged =
          sameBlockRefOrRev(p.responseBlock, seg.responseBlock) &&
          p.responseText === seg.responseText &&
          p.standby === seg.standby &&
          p.stepGroupVariant === seg.stepGroupVariant &&
          p.loopFault === seg.loopFault;
        if (p.runId === seg.runId && stepsUnchanged && respUnchanged) {
          keepPrior = true;
        } else if (stepsUnchanged && p.steps !== seg.steps) {
          allIdentical = false;
          return { ...seg, steps: p.steps };
        }
        break;
      }
    }

    if (keepPrior) {
      if (prior !== previous[index]) allIdentical = false;
      return prior;
    }
    allIdentical = false;
    return seg;
  });

  return allIdentical ? previous : reconciled;
}
