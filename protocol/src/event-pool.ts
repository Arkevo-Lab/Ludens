/** Shared Event Pool contract between Shiori, CLI, Query Worker, and Web Console. */

export const EVENT_DIRECTIONS = ["inbound", "outbound"] as const;
export type EventDirection = (typeof EVENT_DIRECTIONS)[number];

export const INBOUND_EVENT_KINDS = ["message", "reply"] as const;
export type InboundEventKind = (typeof INBOUND_EVENT_KINDS)[number];

export const OUTBOUND_EVENT_KINDS = ["help_request", "notice"] as const;
export type OutboundEventKind = (typeof OUTBOUND_EVENT_KINDS)[number];

export type PoolEventKind = InboundEventKind | OutboundEventKind;

export const POOL_EVENT_STATUSES = ["pending", "handled"] as const;
export type PoolEventStatus = (typeof POOL_EVENT_STATUSES)[number];

export const POOL_EVENT_ACTORS = ["shiori", "human"] as const;
export type PoolEventActor = (typeof POOL_EVENT_ACTORS)[number];

export const DEFAULT_DIGEST_PREVIEW_MAX_CHARS = 72;

export interface PoolEvent {
  id: string;
  seq: number;
  direction: EventDirection;
  kind: PoolEventKind;
  status: PoolEventStatus;
  title?: string;
  text: string;
  replyTo?: string;
  pauseRequested?: boolean;
  runId?: string | null;
  epoch?: string | null;
  createdAt: string;
  handledAt?: string;
  handledBy?: PoolEventActor;
}

export interface EventPoolSummary {
  pendingInbound: number;
  pendingOutbound: number;
  latestSeq: number;
}

export interface EventPoolDigestItem {
  id: string;
  seq: number;
  kind: InboundEventKind;
  title?: string;
  preview: string;
  truncated: boolean;
  replyTo?: string;
  createdAt: string;
}

export interface EventPoolDigest {
  pendingInbound: number;
  items: EventPoolDigestItem[];
}

export interface EventPoolSnapshot {
  summary: EventPoolSummary;
  events: PoolEvent[];
}

export const EMPTY_EVENT_POOL_SUMMARY: EventPoolSummary = {
  pendingInbound: 0,
  pendingOutbound: 0,
  latestSeq: 0,
};

/** Normalize multi-line event text into a single-line bounded digest preview. */
export function summarizePoolEventPreview(
  text: string,
  maxChars = DEFAULT_DIGEST_PREVIEW_MAX_CHARS,
): { preview: string; truncated: boolean } {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(collapsed);
  if (chars.length <= maxChars) {
    return { preview: collapsed, truncated: false };
  }
  return {
    preview: `${chars.slice(0, Math.max(1, maxChars - 1)).join("")}…`,
    truncated: true,
  };
}

export function computeEventPoolSummary(events: readonly PoolEvent[], latestSeq = 0): EventPoolSummary {
  let pendingInbound = 0;
  let pendingOutbound = 0;
  let maxSeq = latestSeq;
  for (const event of events) {
    if (event.seq > maxSeq) maxSeq = event.seq;
    if (event.status !== "pending") continue;
    if (event.direction === "inbound") pendingInbound += 1;
    else if (event.direction === "outbound") pendingOutbound += 1;
  }
  return { pendingInbound, pendingOutbound, latestSeq: maxSeq };
}

export function buildInboundEventDigest(
  events: readonly PoolEvent[],
  maxChars = DEFAULT_DIGEST_PREVIEW_MAX_CHARS,
): EventPoolDigest {
  const pending = events
    .filter((event): event is PoolEvent & { direction: "inbound"; kind: InboundEventKind } =>
      event.direction === "inbound" && event.status === "pending",
    )
    .sort((a, b) => a.seq - b.seq);
  return {
    pendingInbound: pending.length,
    items: pending.map(event => {
      const { preview, truncated } = summarizePoolEventPreview(event.text, maxChars);
      return {
        id: event.id,
        seq: event.seq,
        kind: event.kind,
        ...(event.title ? { title: event.title } : {}),
        preview,
        truncated,
        ...(event.replyTo ? { replyTo: event.replyTo } : {}),
        createdAt: event.createdAt,
      };
    }),
  };
}
