"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CornerDownRight, Search, X } from "lucide-react";
import type { EventPoolSnapshot, PoolEvent } from "@ludens/protocol/event-pool";
import { useTranslations } from "@/lib/locale";

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

export type PoolOverviewFilter = "all" | "pending" | "inbound" | "outbound";

/** Card lifecycle state: one value per visual status treatment. */
export type PoolCardState = "queued" | "read" | "withdrawn" | "awaiting" | "resolved";

const BODY_CLAMP_CHARS = 280;
const FILTERS: readonly PoolOverviewFilter[] = ["all", "pending", "inbound", "outbound"];
const FILTER_KEYS: Record<PoolOverviewFilter, string> = {
  all: "poolFilterAll",
  pending: "poolFilterPending",
  inbound: "poolFilterInbound",
  outbound: "poolFilterOutbound",
};

/** Substitute `{token}`; when a template lacks the token (e.g. key not yet translated), append the value. */
export function fillTemplate(template: string, token: string, value: string): string {
  const placeholder = `{${token}}`;
  return template.includes(placeholder) ? template.replace(placeholder, value) : `${template} ${value}`;
}

const pad2 = (value: number) => String(value).padStart(2, "0");

/** `HH:MM:SS` on the same local calendar day as `nowMs`, `MM-DD HH:MM:SS` for earlier days, `YYYY-MM-DD HH:MM:SS` across years. */
export function formatPoolTimestamp(iso: string | undefined, nowMs: number = Date.now()): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const at = new Date(ms);
  const now = new Date(nowMs);
  const clock = `${pad2(at.getHours())}:${pad2(at.getMinutes())}:${pad2(at.getSeconds())}`;
  const sameYear = at.getFullYear() === now.getFullYear();
  if (sameYear && at.getMonth() === now.getMonth() && at.getDate() === now.getDate()) return clock;
  const day = `${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`;
  return sameYear ? `${day} ${clock}` : `${at.getFullYear()}-${day} ${clock}`;
}

/** Compact elapsed duration: `8s`, `2m 5s`, `3h 12m`, `2d 4h`. */
export function formatPoolElapsed(fromIso: string | undefined, toIso: string | undefined): string | null {
  if (!fromIso || !toIso) return null;
  const delta = Date.parse(toIso) - Date.parse(fromIso);
  if (!Number.isFinite(delta) || delta < 0) return null;
  const total = Math.round(delta / 1000);
  if (total >= 86_400) {
    const d = Math.floor(total / 86_400);
    const h = Math.floor((total % 86_400) / 3600);
    return h > 0 ? `${d}d ${h}h` : `${d}d`;
  }
  if (total >= 3600) {
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function poolCardState(event: PoolEvent): PoolCardState {
  if (event.direction === "inbound") {
    if (event.status === "pending") return "queued";
    return event.handledBy === "human" ? "withdrawn" : "read";
  }
  return event.status === "pending" ? "awaiting" : "resolved";
}

/** Matches `#12` / `12` against seq exactly, and any query against title, text, or id. */
export function matchesPoolQuery(event: PoolEvent, rawQuery: string): boolean {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return true;
  const seqMatch = /^#?(\d+)$/.exec(query);
  if (seqMatch && event.seq === Number(seqMatch[1])) return true;
  const needle = query.startsWith("#") && seqMatch ? null : query;
  if (!needle) return false;
  return [event.title ?? "", event.text, event.id].some(field => field.toLowerCase().includes(needle));
}

export function matchesPoolFilter(event: PoolEvent, filter: PoolOverviewFilter): boolean {
  switch (filter) {
    case "pending": return event.status === "pending";
    case "inbound": return event.direction === "inbound";
    case "outbound": return event.direction === "outbound";
    default: return true;
  }
}

function sortNewestFirst(events: readonly PoolEvent[]): PoolEvent[] {
  return [...events].sort((a, b) => b.seq - a.seq || Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function EventPoolOverviewPanel({
  snapshot,
  pendingInboundCount,
  pendingOutboundCount,
  canMutate,
  canResumeAuto,
  submitting = false,
  focusedEventId = null,
  onFocusEvent,
  onComposeNewEvent,
  onReply,
  onAck,
  onWithdraw,
  onLocateInStream,
}: EventPoolOverviewPanelProps) {
  const t = useTranslations("shioriCockpit");
  const [filter, setFilter] = useState<PoolOverviewFilter>("all");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const events = useMemo(() => sortNewestFirst(snapshot?.events ?? []), [snapshot]);
  const byId = useMemo(() => new Map(events.map(event => [event.id, event])), [events]);
  const counts = useMemo(() => {
    const result: Record<PoolOverviewFilter, number> = { all: events.length, pending: 0, inbound: 0, outbound: 0 };
    for (const event of events) {
      if (event.status === "pending") result.pending += 1;
      if (event.direction === "inbound") result.inbound += 1;
      else result.outbound += 1;
    }
    return result;
  }, [events]);
  const visible = useMemo(
    () => events.filter(event => matchesPoolFilter(event, filter) && matchesPoolQuery(event, query)),
    [events, filter, query],
  );

  // A new focus request (stream bubble, receipt, replyTo chip) must land on a visible card: reveal it once, then scroll.
  const revealedFocusRef = useRef<string | null>(null);
  useEffect(() => {
    if (!focusedEventId || !byId.has(focusedEventId)) {
      revealedFocusRef.current = null;
      return;
    }
    if (revealedFocusRef.current === focusedEventId) return;
    if (!visible.some(event => event.id === focusedEventId)) {
      setFilter("all");
      setQuery("");
      return;
    }
    revealedFocusRef.current = focusedEventId;
    const card = listRef.current?.querySelector<HTMLElement>(`[data-pool-overview-id="${CSS.escape(focusedEventId)}"]`);
    card?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focusedEventId, byId, visible]);

  const runMutation = useCallback(async (eventId: string, action: (id: string) => Promise<void> | void) => {
    setBusyId(eventId);
    try {
      await action(eventId);
    } finally {
      setBusyId(current => (current === eventId ? null : current));
    }
  }, []);

  const toggleExpanded = useCallback((eventId: string) => {
    setExpanded(current => {
      const next = new Set(current);
      if (next.has(eventId)) next.delete(eventId);
      else next.add(eventId);
      return next;
    });
  }, []);

  const nowMs = Date.now();
  const hasQuery = query.trim().length > 0;

  return (
    <section className="pool-panel" aria-label={t("poolPanelAria")}>
      <header className="pool-panel-head">
        <div className="pool-stats">
          <div className="pool-stat" data-tone="inbound" data-active={pendingInboundCount > 0 || undefined}>
            <span className="pool-stat-label">
              <i className="pool-stat-pip" aria-hidden="true" />
              {t("poolStatPendingInbound")}
            </span>
            <span className="pool-stat-value">{pendingInboundCount}</span>
          </div>
          <div className="pool-stat" data-tone="outbound" data-active={pendingOutboundCount > 0 || undefined}>
            <span className="pool-stat-label">
              <i className="pool-stat-pip" aria-hidden="true" />
              {t("poolStatPendingOutbound")}
            </span>
            <span className="pool-stat-value">{pendingOutboundCount}</span>
          </div>
          <div className="pool-stat" data-tone="total">
            <span className="pool-stat-label">{t("poolStatTotalRetained")}</span>
            <span className="pool-stat-value">{events.length}</span>
          </div>
        </div>
        {canMutate && (
          <button type="button" className="pool-compose-btn" onClick={onComposeNewEvent} disabled={submitting}>
            {t("poolComposeBtn")}
          </button>
        )}
      </header>

      <div className="pool-toolbar">
        <div className="pool-filters" role="tablist" aria-label={t("poolPanelAria")}>
          {FILTERS.map(key => (
            <button
              key={key}
              type="button"
              role="tab"
              className="pool-filter"
              data-filter={key}
              aria-selected={filter === key}
              data-active={filter === key || undefined}
              onClick={() => setFilter(key)}
            >
              <span>{t(FILTER_KEYS[key])}</span>
              <span className="pool-filter-count">{counts[key]}</span>
            </button>
          ))}
        </div>
        <label className="pool-search">
          <Search size={13} aria-hidden="true" className="pool-search-icon" />
          <input
            type="text"
            className="pool-search-input"
            value={query}
            placeholder={t("poolSearchPlaceholder")}
            aria-label={t("poolSearchPlaceholder")}
            spellCheck={false}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === "Escape" && query) {
                event.preventDefault();
                setQuery("");
              }
            }}
          />
          {hasQuery && (
            <button
              type="button"
              className="pool-search-clear"
              aria-label={t("poolSearchClear")}
              title={t("poolSearchClear")}
              onClick={() => setQuery("")}
            >
              <X size={12} aria-hidden="true" />
            </button>
          )}
        </label>
      </div>

      <div className="pool-list" ref={listRef}>
        {events.length === 0 ? (
          <div className="pool-empty" data-variant="all">
            <div className="pool-empty-glyph" aria-hidden="true">
              <i /><i /><i /><i />
            </div>
            <p className="pool-empty-title">{t("poolEmptyAllTitle")}</p>
            <p className="pool-empty-desc">{t("poolEmptyAllDesc")}</p>
          </div>
        ) : visible.length === 0 ? (
          <div className="pool-empty" data-variant="filtered">
            <p className="pool-empty-desc">{t("poolEmptyFiltered")}</p>
          </div>
        ) : (
          visible.map(event => (
            <PoolEventCard
              key={event.id}
              event={event}
              parent={event.replyTo ? byId.get(event.replyTo) ?? null : null}
              t={t}
              nowMs={nowMs}
              focused={event.id === focusedEventId}
              expanded={expanded.has(event.id)}
              busy={submitting || busyId === event.id}
              canMutate={canMutate}
              canResumeAuto={canResumeAuto}
              onToggleExpanded={toggleExpanded}
              onFocusEvent={onFocusEvent}
              onReply={onReply}
              onAck={id => runMutation(id, onAck)}
              onWithdraw={id => runMutation(id, onWithdraw)}
              onLocateInStream={onLocateInStream}
            />
          ))
        )}
      </div>
    </section>
  );
}

interface PoolEventCardProps {
  event: PoolEvent;
  parent: PoolEvent | null;
  t: (key: string) => string;
  nowMs: number;
  focused: boolean;
  expanded: boolean;
  busy: boolean;
  canMutate: boolean;
  canResumeAuto: boolean;
  onToggleExpanded: (eventId: string) => void;
  onFocusEvent?: (eventId: string | null) => void;
  onReply: (event: PoolEvent, resumeAuto: boolean) => void;
  onAck: (eventId: string) => void;
  onWithdraw: (eventId: string) => void;
  onLocateInStream: (event: PoolEvent) => void;
}

function kindBadge(event: PoolEvent, t: (key: string) => string): { glyph: string; label: string } {
  switch (event.kind) {
    case "reply": return { glyph: "↩", label: t("poolKindInboundReply") };
    case "help_request": return { glyph: "🆘", label: t("poolHelpRequestBadge") };
    case "notice": return { glyph: "📌", label: t("poolNoticeBadge") };
    default: return { glyph: "📥", label: t("poolKindInboundMessage") };
  }
}

function statusBadge(state: PoolCardState, t: (key: string) => string): { glyph: string; label: string } {
  switch (state) {
    case "queued": return { glyph: "⏳", label: t("poolStatusPendingShort") };
    case "read": return { glyph: "✓", label: t("poolStatusRead") };
    case "withdrawn": return { glyph: "⊘", label: t("poolStatusWithdrawn") };
    case "awaiting": return { glyph: "●", label: t("poolStatusAwaitingHuman") };
    default: return { glyph: "✓", label: t("poolStatusHandled") };
  }
}

function lifecycleEnd(state: PoolCardState): { key: string; done: boolean } {
  switch (state) {
    case "queued": return { key: "poolLifecycleAwaitingShiori", done: false };
    case "read": return { key: "poolLifecycleRead", done: true };
    case "withdrawn": return { key: "poolLifecycleWithdrawn", done: true };
    case "awaiting": return { key: "poolLifecycleAwaitingHuman", done: false };
    default: return { key: "poolLifecycleResolved", done: true };
  }
}

/** Split a `{time}` template so the timestamp renders as its own monospace span. */
function TemplatedTime({ template, time }: { template: string; time: string }) {
  const index = template.indexOf("{time}");
  if (index < 0) return <>{template} <time className="pool-life-time">{time}</time></>;
  const before = template.slice(0, index);
  const after = template.slice(index + "{time}".length);
  return (
    <>
      {before}
      <time className="pool-life-time">{time}</time>
      {after}
    </>
  );
}

function PoolEventCard({
  event,
  parent,
  t,
  nowMs,
  focused,
  expanded,
  busy,
  canMutate,
  canResumeAuto,
  onToggleExpanded,
  onFocusEvent,
  onReply,
  onAck,
  onWithdraw,
  onLocateInStream,
}: PoolEventCardProps) {
  const state = poolCardState(event);
  const kind = kindBadge(event, t);
  const status = statusBadge(state, t);
  const end = lifecycleEnd(state);
  const startKey = event.direction === "inbound" ? "poolLifecycleSent" : "poolLifecycleEmitted";
  const elapsed = end.done ? formatPoolElapsed(event.createdAt, event.handledAt) : null;
  const longBody = Array.from(event.text).length > BODY_CLAMP_CHARS;
  const pending = event.status === "pending";

  return (
    <article
      className="pool-card"
      data-pool-overview-id={event.id}
      data-pool-seq={event.seq}
      data-direction={event.direction}
      data-kind={event.kind}
      data-state={state}
      data-focused={focused || undefined}
      aria-current={focused ? "true" : undefined}
    >
      <div className="pool-card-meta">
        <button
          type="button"
          className="pool-seq"
          onClick={() => onFocusEvent?.(focused ? null : event.id)}
          aria-pressed={focused}
        >
          #{event.seq}
        </button>
        <span className="pool-kind" data-kind={event.kind}>
          <span aria-hidden="true">{kind.glyph}</span>
          {kind.label}
        </span>
        {event.pauseRequested && <span className="pool-paused">{t("poolPausedTag")}</span>}
        <span className="pool-status" data-state={state}>
          <span aria-hidden="true" className="pool-status-glyph">{status.glyph}</span>
          {status.label}
        </span>
      </div>

      {event.replyTo && (
        parent ? (
          <button type="button" className="pool-reply-chip" onClick={() => onFocusEvent?.(parent.id)}>
            <CornerDownRight size={11} aria-hidden="true" />
            {fillTemplate(t("poolReplyingToSeq"), "seq", String(parent.seq))}
          </button>
        ) : (
          <span className="pool-reply-chip" data-orphan="true">
            <CornerDownRight size={11} aria-hidden="true" />
            {t("poolReplyingToSeq").replace("#{seq}", "…").replace("{seq}", "…")}
          </span>
        )
      )}

      {event.title && <h4 className="pool-card-title">{event.title}</h4>}
      {event.text && (
        <p className="pool-card-body" data-clamped={longBody && !expanded ? "true" : undefined}>
          {event.text}
        </p>
      )}
      {longBody && (
        <button
          type="button"
          className="pool-body-toggle"
          aria-expanded={expanded}
          onClick={() => onToggleExpanded(event.id)}
        >
          {expanded ? t("poolBodyCollapse") : t("poolBodyExpand")}
        </button>
      )}

      <div className="pool-life" data-state={state}>
        <span className="pool-life-node" data-node="start">
          <i className="pool-life-dot" aria-hidden="true" />
          <TemplatedTime template={t(startKey)} time={formatPoolTimestamp(event.createdAt, nowMs)} />
        </span>
        <span className="pool-life-arrow" aria-hidden="true">→</span>
        <span className="pool-life-node" data-node="end" data-done={end.done || undefined}>
          <i className="pool-life-dot" aria-hidden="true" />
          {end.done
            ? <TemplatedTime template={t(end.key)} time={formatPoolTimestamp(event.handledAt, nowMs)} />
            : t(end.key)}
          {elapsed && (
            <span className="pool-life-elapsed">· {fillTemplate(t("poolLifecycleElapsed"), "duration", elapsed)}</span>
          )}
        </span>
      </div>

      <div className="pool-card-actions">
        <div className="pool-card-actions-main">
          {canMutate && pending && event.direction === "outbound" && (
            <>
              <button type="button" className="pool-btn" data-variant="accent" data-action="reply" disabled={busy} onClick={() => onReply(event, false)}>
                {t("poolReplyBtn")}
              </button>
              {canResumeAuto && (
                <button type="button" className="pool-btn" data-action="reply-resume" disabled={busy} onClick={() => onReply(event, true)}>
                  {t("poolReplyResumeBtn")}
                </button>
              )}
              <button type="button" className="pool-btn" data-variant="ghost" data-action="ack" disabled={busy} onClick={() => onAck(event.id)}>
                {t("poolDismissBtn")}
              </button>
            </>
          )}
          {canMutate && pending && event.direction === "inbound" && (
            <button
              type="button"
              className="pool-btn"
              data-variant="ghost"
              data-action="withdraw"
              disabled={busy}
              title={t("poolWithdrawHint")}
              onClick={() => onWithdraw(event.id)}
            >
              {t("poolWithdrawBtn")}
            </button>
          )}
        </div>
        <button type="button" className="pool-locate-btn" data-action="locate" onClick={() => onLocateInStream(event)}>
          {t("poolLocateInStreamBtn")}
        </button>
      </div>
    </article>
  );
}
