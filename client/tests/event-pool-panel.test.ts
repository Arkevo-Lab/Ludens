import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EventPoolSnapshot, PoolEvent } from "@ludens/protocol/event-pool";
import {
  EventPoolOverviewPanel,
  fillTemplate,
  formatPoolElapsed,
  formatPoolTimestamp,
  matchesPoolQuery,
  poolCardState,
  type EventPoolOverviewPanelProps,
} from "../features/live/event-pool-panel";
import { LocaleProvider } from "../lib/locale";

const en = JSON.parse(readFileSync(join(import.meta.dirname, "../messages/en.json"), "utf8")) as {
  shioriCockpit: Record<string, string>;
};

/** Mirrors LocaleProvider's SSR lookup (en, falling back to the raw key while i18n lands separately). */
function tx(key: string): string {
  return en.shioriCockpit[key] ?? `shioriCockpit.${key}`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function todayAt(h: number, m: number, s: number): string {
  const at = new Date();
  at.setHours(h, m, s, 0);
  return at.toISOString();
}

function yesterdayAt(h: number, m: number, s: number): string {
  const at = new Date();
  at.setDate(at.getDate() - 1);
  at.setHours(h, m, s, 0);
  return at.toISOString();
}

function ev(overrides: Pick<PoolEvent, "id" | "seq" | "direction" | "kind" | "status" | "createdAt"> & Partial<PoolEvent>): PoolEvent {
  return { text: "", ...overrides };
}

const EVENTS: PoolEvent[] = [
  ev({ id: "ev-read", seq: 10, direction: "inbound", kind: "message", status: "handled", handledBy: "shiori",
    text: "刚才 wifi 断了，你看看现在能不能连到 Switch", createdAt: todayAt(13, 20, 34), handledAt: todayAt(13, 20, 42) }),
  ev({ id: "ev-withdrawn", seq: 9, direction: "inbound", kind: "message", status: "handled", handledBy: "human",
    text: "昨晚的旧消息", createdAt: yesterdayAt(21, 40, 2), handledAt: yesterdayAt(21, 40, 15) }),
  ev({ id: "ev-help", seq: 11, direction: "outbound", kind: "help_request", status: "pending", pauseRequested: true,
    title: "需要登录", text: "Switch 弹出了账号登录框", createdAt: todayAt(13, 18, 10) }),
  ev({ id: "ev-notice", seq: 8, direction: "outbound", kind: "notice", status: "handled", handledBy: "human",
    text: "已完成第一章", createdAt: todayAt(13, 18, 10), handledAt: todayAt(13, 19, 5) }),
  ev({ id: "ev-reply", seq: 12, direction: "inbound", kind: "reply", status: "pending", replyTo: "ev-help",
    text: "密码已经输入好了", createdAt: todayAt(13, 25, 1) }),
  ev({ id: "ev-orphan", seq: 13, direction: "inbound", kind: "reply", status: "pending", replyTo: "ev-gone",
    text: "x".repeat(320), createdAt: todayAt(13, 26, 0) }),
];

function snapshot(events: PoolEvent[]): EventPoolSnapshot {
  return {
    summary: {
      pendingInbound: events.filter(e => e.direction === "inbound" && e.status === "pending").length,
      pendingOutbound: events.filter(e => e.direction === "outbound" && e.status === "pending").length,
      latestSeq: Math.max(0, ...events.map(e => e.seq)),
    },
    events,
  };
}

function render(overrides: Partial<EventPoolOverviewPanelProps> = {}): string {
  const props: EventPoolOverviewPanelProps = {
    snapshot: snapshot(EVENTS),
    pendingInboundCount: 2,
    pendingOutboundCount: 1,
    canMutate: true,
    canResumeAuto: true,
    onComposeNewEvent() {},
    onReply() {},
    onAck() {},
    onWithdraw() {},
    onLocateInStream() {},
    ...overrides,
  };
  return renderToStaticMarkup(createElement(LocaleProvider, null, createElement(EventPoolOverviewPanel, props)));
}

function cardHtml(html: string, id: string): string {
  const start = html.indexOf(`data-pool-overview-id="${id}"`);
  assert.ok(start > -1, `card ${id} rendered`);
  const end = html.indexOf("</article>", start);
  return html.slice(start, end);
}

test("formatPoolTimestamp uses HH:MM:SS today and MM-DD HH:MM:SS for earlier days", () => {
  const now = new Date(2026, 10, 12, 13, 30, 0).getTime();
  assert.equal(formatPoolTimestamp(new Date(2026, 10, 12, 13, 20, 34).toISOString(), now), "13:20:34");
  assert.equal(formatPoolTimestamp(new Date(2026, 10, 11, 21, 40, 10).toISOString(), now), "11-11 21:40:10");
  assert.equal(formatPoolTimestamp(new Date(2025, 11, 31, 23, 59, 59).toISOString(), now), "2025-12-31 23:59:59");
  assert.equal(formatPoolTimestamp(undefined, now), "—");
  assert.equal(formatPoolTimestamp("garbage", now), "—");
});

test("formatPoolElapsed and poolCardState cover every lifecycle", () => {
  assert.equal(formatPoolElapsed("2026-11-12T05:20:34Z", "2026-11-12T05:20:42Z"), "8s");
  assert.equal(formatPoolElapsed("2026-11-12T05:18:10Z", "2026-11-12T05:19:05Z"), "55s");
  assert.equal(formatPoolElapsed("2026-11-12T05:00:00Z", "2026-11-12T07:05:00Z"), "2h 5m");
  assert.equal(formatPoolElapsed("2026-11-12T05:00:10Z", "2026-11-12T05:00:00Z"), null);
  assert.deepEqual(EVENTS.map(poolCardState), ["read", "withdrawn", "awaiting", "resolved", "queued", "queued"]);
});

test("matchesPoolQuery filters by #seq, bare seq, title, text, and id", () => {
  const [read, , help] = EVENTS;
  assert.ok(matchesPoolQuery(read, "#10"));
  assert.ok(matchesPoolQuery(read, "10"));
  assert.ok(!matchesPoolQuery(read, "#1"));
  assert.ok(matchesPoolQuery(read, "WIFI"));
  assert.ok(matchesPoolQuery(help, "登录"));
  assert.ok(matchesPoolQuery(help, "ev-help"));
  assert.ok(matchesPoolQuery(help, "   "));
  assert.ok(!matchesPoolQuery(help, "nonexistent"));
});

test("empty snapshot renders the clear-pool empty state with compose CTA", () => {
  const html = render({ snapshot: null, pendingInboundCount: 0, pendingOutboundCount: 0 });
  assert.match(html, new RegExp(`aria-label="${escapeRe(escapeHtml(tx("poolPanelAria")))}"`));
  assert.ok(html.includes(escapeHtml(tx("poolEmptyAllTitle"))));
  assert.ok(html.includes(escapeHtml(tx("poolEmptyAllDesc"))));
  assert.equal(html.split(escapeHtml(tx("poolComposeBtn"))).length - 1, 1, "single header compose button");
  assert.ok(!html.includes("<article"));
});

test("read-only panel hides compose and mutation actions but keeps locate", () => {
  const html = render({ canMutate: false });
  assert.ok(!html.includes(escapeHtml(tx("poolComposeBtn"))));
  assert.ok(!html.includes('data-action="reply"'));
  assert.ok(!html.includes('data-action="withdraw"'));
  assert.ok(!html.includes('data-action="ack"'));
  assert.equal(html.split('data-action="locate"').length - 1, EVENTS.length);
});

test("summary strip, filter counts, and newest-first ordering", () => {
  const html = render();
  assert.match(html, /class="pool-stat" data-tone="inbound" data-active="true"/);
  assert.match(html, /class="pool-stat" data-tone="outbound" data-active="true"/);
  assert.match(html, /data-tone="total"><span class="pool-stat-label">[^<]*<\/span><span class="pool-stat-value">6<\/span>/);
  for (const [filter, count] of [["all", 6], ["pending", 3], ["inbound", 4], ["outbound", 2]] as const) {
    assert.match(html, new RegExp(`data-filter="${filter}"[^>]*><span>[^<]*</span><span class="pool-filter-count">${count}</span>`));
  }
  assert.match(html, /data-filter="all" aria-selected="true"/);
  const order = [...html.matchAll(/data-pool-seq="(\d+)"/g)].map(m => Number(m[1]));
  assert.deepEqual(order, [13, 12, 11, 10, 9, 8]);
});

test("cards render kind and status badges for every lifecycle", () => {
  const html = render();
  const read = cardHtml(html, "ev-read");
  assert.ok(read.includes("#<!-- -->10") || read.includes("#10"));
  assert.ok(read.includes(tx("poolKindInboundMessage")));
  assert.ok(read.includes(tx("poolStatusRead")));
  assert.match(read, /data-state="read"/);

  const withdrawn = cardHtml(html, "ev-withdrawn");
  assert.ok(withdrawn.includes(tx("poolStatusWithdrawn")));
  assert.ok(withdrawn.includes("⊘"));

  const help = cardHtml(html, "ev-help");
  assert.ok(help.includes("🆘") && help.includes(tx("poolHelpRequestBadge")));
  assert.ok(help.includes(tx("poolPausedTag")));
  assert.ok(help.includes(tx("poolStatusAwaitingHuman")));
  assert.ok(help.includes('class="pool-card-title">需要登录</h4>'));

  const notice = cardHtml(html, "ev-notice");
  assert.ok(notice.includes("📌") && notice.includes(tx("poolNoticeBadge")));
  assert.ok(notice.includes(tx("poolStatusHandled")));

  const reply = cardHtml(html, "ev-reply");
  assert.ok(reply.includes("↩") && reply.includes(tx("poolKindInboundReply")));
  assert.ok(reply.includes(tx("poolStatusPendingShort")));
});

function lifeText(card: string): string {
  const start = card.indexOf(">", card.indexOf('class="pool-life"')) + 1;
  const end = card.lastIndexOf("<div", card.indexOf('class="pool-card-actions"'));
  return card.slice(start, end).replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function tpl(key: string, time: string): string {
  return fillTemplate(tx(key), "time", time);
}

function elapsed(duration: string): string {
  return `· ${fillTemplate(tx("poolLifecycleElapsed"), "duration", duration)}`;
}

test("dual-timestamp lifecycle bar distinguishes Shiori read, human withdrawal, pending, and resolution", () => {
  const html = render();
  const sep = " → ";
  assert.match(lifeText(cardHtml(html, "ev-read")), new RegExp(
    `${escapeRe(tpl("poolLifecycleSent", "13:20:34"))}${sep}${escapeRe(tpl("poolLifecycleRead", "13:20:42"))} ${escapeRe(elapsed("8s"))}$`));

  const withdrawn = lifeText(cardHtml(html, "ev-withdrawn"));
  const day = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d; })();
  const prefix = `${day.getFullYear() === new Date().getFullYear() ? "" : `${day.getFullYear()}-`}${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
  assert.match(withdrawn, new RegExp(
    `^${escapeRe(tpl("poolLifecycleSent", `${prefix} 21:40:02`))}${sep}${escapeRe(tpl("poolLifecycleWithdrawn", `${prefix} 21:40:15`))} ${escapeRe(elapsed("13s"))}$`));
  assert.ok(!withdrawn.includes(tpl("poolLifecycleRead", "").trim()) || tx("poolLifecycleRead") === tx("poolLifecycleWithdrawn"));

  assert.equal(lifeText(cardHtml(html, "ev-reply")), `${tpl("poolLifecycleSent", "13:25:01")}${sep}${tx("poolLifecycleAwaitingShiori")}`);
  assert.equal(lifeText(cardHtml(html, "ev-help")), `${tpl("poolLifecycleEmitted", "13:18:10")}${sep}${tx("poolLifecycleAwaitingHuman")}`);
  assert.match(lifeText(cardHtml(html, "ev-notice")), new RegExp(
    `^${escapeRe(tpl("poolLifecycleEmitted", "13:18:10"))}${sep}${escapeRe(tpl("poolLifecycleResolved", "13:19:05"))} ${escapeRe(elapsed("55s"))}$`));
});

test("replyTo resolves the parent #seq as a clickable chip, unresolved parents degrade gracefully", () => {
  const html = render();
  const reply = cardHtml(html, "ev-reply");
  assert.match(reply, new RegExp(`<button type="button" class="pool-reply-chip">.*?${escapeRe(fillTemplate(tx("poolReplyingToSeq"), "seq", "11"))}</button>`));
  const orphan = cardHtml(html, "ev-orphan");
  assert.match(orphan, /<span class="pool-reply-chip" data-orphan="true">/);
});

test("very long bodies clamp with an expand toggle; short bodies do not", () => {
  const html = render();
  const orphan = cardHtml(html, "ev-orphan");
  assert.match(orphan, /class="pool-card-body" data-clamped="true"/);
  assert.match(orphan, new RegExp(`aria-expanded="false"[^>]*>${escapeRe(tx("poolBodyExpand"))}</button>`));
  const read = cardHtml(html, "ev-read");
  assert.ok(!read.includes("data-clamped"));
  assert.ok(!read.includes("pool-body-toggle"));
});

test("action footer: reply/resume/ack on pending outbound, withdraw on pending inbound, locate everywhere", () => {
  const html = render();
  const help = cardHtml(html, "ev-help");
  assert.ok(help.includes(`data-action="reply"`) && help.includes(`>${escapeHtml(tx("poolReplyBtn"))}</button>`));
  assert.ok(help.includes(`data-action="reply-resume"`) && help.includes(`>${escapeHtml(tx("poolReplyResumeBtn"))}</button>`));
  assert.ok(help.includes(`data-action="ack"`) && help.includes(`>${escapeHtml(tx("poolDismissBtn"))}</button>`));
  assert.ok(!help.includes(`data-action="withdraw"`));

  const reply = cardHtml(html, "ev-reply");
  assert.ok(reply.includes(`data-action="withdraw"`) && reply.includes(`>${escapeHtml(tx("poolWithdrawBtn"))}</button>`));
  assert.ok(reply.includes(`title="${escapeHtml(tx("poolWithdrawHint"))}"`));
  assert.ok(!reply.includes(`data-action="reply"`));

  for (const id of ["ev-read", "ev-withdrawn", "ev-notice"]) {
    const card = cardHtml(html, id);
    assert.ok(!/data-action="(reply|reply-resume|ack|withdraw)"/.test(card), `${id} has no mutation actions`);
  }
  for (const event of EVENTS) {
    assert.ok(cardHtml(html, event.id).includes(`data-action="locate">${escapeHtml(tx("poolLocateInStreamBtn"))}</button>`));
  }

  const noResume = cardHtml(render({ canResumeAuto: false }), "ev-help");
  assert.ok(!noResume.includes(`data-action="reply-resume"`));
  const busy = cardHtml(render({ submitting: true }), "ev-help");
  assert.match(busy, /data-action="reply" disabled=""/);
});

test("focusedEventId highlights the matching card", () => {
  const html = render({ focusedEventId: "ev-help" });
  assert.match(cardHtml(html, "ev-help"), /data-focused="true" aria-current="true"/);
  assert.ok(!cardHtml(html, "ev-read").includes("data-focused"));
});

test("layout imports the panel stylesheet and the component never imports CSS", () => {
  const layout = readFileSync(join(import.meta.dirname, "../app/layout.tsx"), "utf8");
  assert.ok(layout.includes('import "@/features/live/event-pool-panel.css";'));
  const source = readFileSync(join(import.meta.dirname, "../features/live/event-pool-panel.tsx"), "utf8");
  assert.ok(!/import\s+["'][^"']+\.css["']/.test(source));
});
