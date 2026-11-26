import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ActivityBlock } from "../features/live/activity-feed-model";
import {
  buildCodexSegments,
  formatModelInputPayload,
  summarizeStepBlock,
} from "../features/live/shiori-segments";
import { LocaleProvider } from "../lib/locale";
import type { ActivityFeedData } from "../features/live/use-activity-feed";
import type { Call, RunData, SpanStats } from "@ludens/protocol/types";

const nodeRequire = createRequire(import.meta.url);
const cjsModule = nodeRequire("node:module") as {
  _extensions: Record<string, (mod: unknown, filename: string) => void>;
};
cjsModule._extensions[".css"] ??= () => {};

function block(
  overrides: Pick<ActivityBlock, "id" | "kind" | "at" | "title"> & Partial<ActivityBlock>,
): ActivityBlock {
  return {
    text: "",
    status: "complete",
    createdRevision: 1,
    revision: 1,
    ...overrides,
  };
}

const RUN_ID = "20260101T000000Z-demo";

test("brief pre-cycle Host startup blocks open with the #1 cycle divider instead of a post:pre divider", () => {
  const cycleStart = "2026-01-01T00:00:40.000Z";
  const blocks = [
    block({
      id: "boot",
      kind: "system",
      at: "2026-01-01T00:00:00.000Z",
      title: "host_start",
      data: { summary: "Host socket online" },
    }),
    block({
      id: "ctl-auto",
      kind: "system",
      at: cycleStart,
      title: "control",
      data: { mode: "auto" },
      trace: { epoch: "epoch-1" },
    }),
  ];

  const segments = buildCodexSegments(blocks, [], [], {
    runId: RUN_ID,
    isLatestRun: true,
    isAuto: true,
    cycles: [{ epoch: "epoch-1", startedAt: cycleStart }],
  });

  assert.equal(segments[0]?.kind, "session_divider");
  const firstDivider = segments[0];
  if (firstDivider?.kind !== "session_divider") throw new Error("expected leading session divider");
  assert.equal(firstDivider.cycleIndex, 1);
  assert.equal(firstDivider.epoch, "epoch-1");
  assert.equal(
    segments.filter(item => item.kind === "session_divider" && item.epoch?.startsWith("post:pre:")).length,
    0,
    "brief boot steps must not emit an out-of-order post:pre divider before #1",
  );
  assert.ok(
    segments.some(item => item.kind === "turn" && item.steps.some(step => step.id === "boot")),
    "boot steps remain inside the first turn after the divider",
  );
});

test("longer or non-system pre-cycle blocks emit post:pre before #1 in ascending chronological order", () => {
  const cases = [
    { name: "system block older than 60s", kind: "system" as const, at: "2025-12-31T23:59:50.000Z" },
    { name: "non-system block inside 60s", kind: "tool" as const, at: "2026-01-01T00:00:45.000Z" },
  ];
  const cycleStart = "2026-01-01T00:01:00.000Z";

  for (const scenario of cases) {
    const blocks = [
      block({
        id: `pre-${scenario.kind}`,
        kind: scenario.kind,
        at: scenario.at,
        title: scenario.kind === "system" ? "host_start" : "bash",
        data: { summary: "boot" },
        ...(scenario.kind === "tool" ? { tool: { args: { command: "echo boot" } } } : {}),
      }),
      block({
        id: "ctl-auto",
        kind: "system",
        at: cycleStart,
        title: "control",
        data: { mode: "auto" },
        trace: { epoch: "epoch-1" },
      }),
    ];

    const segments = buildCodexSegments(blocks, [], [], {
      runId: RUN_ID,
      isLatestRun: true,
      isAuto: true,
      cycles: [{ epoch: "epoch-1", startedAt: cycleStart }],
    });

    const dividers = segments.filter(item => item.kind === "session_divider");
    assert.equal(dividers.length, 2, scenario.name);
    const [pre, cycle] = dividers;
    if (pre?.kind !== "session_divider" || cycle?.kind !== "session_divider") {
      throw new Error("expected two dividers");
    }
    assert.equal(pre.epoch, `post:pre:${RUN_ID}`, scenario.name);
    assert.equal(pre.startedAt, scenario.at, scenario.name);
    assert.equal(cycle.epoch, "epoch-1", scenario.name);
    assert.ok(
      Date.parse(pre.startedAt) < Date.parse(cycle.startedAt),
      `${scenario.name}: post:pre must precede the #1 cycle divider`,
    );
    assert.ok(
      segments.indexOf(pre) < segments.indexOf(cycle),
      `${scenario.name}: post:pre must be emitted before #1`,
    );
  }
});

test("control_timer blocks render a timer badge and stay inside step groups without extra dividers", () => {
  const timerBlock = block({
    id: "timer-1",
    kind: "system",
    at: "2026-01-01T00:00:10.000Z",
    title: "control_timer",
    data: { requestedSeconds: 900, timerSeconds: 900, remainingSeconds: 900 },
    trace: { epoch: "epoch-1" },
  });
  assert.deepEqual(summarizeStepBlock(timerBlock), {
    badge: "⏱ timer",
    detail: "Stop in 15m (900s)",
  });
  assert.deepEqual(
    summarizeStepBlock(block({
      id: "timer-2",
      kind: "system",
      at: "2026-01-01T00:00:11.000Z",
      title: "control_timer",
      data: { requestedSeconds: null },
    })),
    { badge: "⏱ timer", detail: "∞ Continuous (timer cleared)" },
  );

  const segments = buildCodexSegments([
    block({
      id: "ctl-auto",
      kind: "system",
      at: "2026-01-01T00:00:00.000Z",
      title: "control",
      data: { mode: "auto" },
      trace: { epoch: "epoch-1" },
    }),
    timerBlock,
    block({
      id: "tool-1",
      kind: "tool",
      at: "2026-01-01T00:00:20.000Z",
      title: "bash",
      tool: { args: { command: "ls" } },
      trace: { epoch: "epoch-1" },
    }),
    block({
      id: "reply-1",
      kind: "text",
      at: "2026-01-01T00:00:30.000Z",
      title: "Shiori",
      text: "Working on it.",
      data: { role: "assistant", text: "Working on it." },
      source: { component: "shiori" },
      trace: { epoch: "epoch-1" },
    }),
  ], [], [], {
    runId: RUN_ID,
    isLatestRun: true,
    isAuto: true,
    cycles: [{ epoch: "epoch-1", startedAt: "2026-01-01T00:00:00.000Z" }],
  });

  assert.equal(segments.filter(item => item.kind === "session_divider").length, 1);
  const turn = segments.find(item => item.kind === "turn");
  if (turn?.kind !== "turn") throw new Error("expected a turn segment");
  assert.ok(turn.steps.some(step => step.id === "timer-1"), "control_timer stays in the step group");
  assert.equal(turn.responseBlock?.id, "reply-1");
});

test("empty runs anchor prior runIds with a fallback divider while an empty latest run stays empty", () => {
  const fallbackStartedAt = "2026-01-01T00:00:00.000Z";
  const historical = buildCodexSegments([], [], [], {
    runId: RUN_ID,
    isLatestRun: false,
    fallbackStartedAt,
  });
  assert.equal(historical.length, 1);
  const divider = historical[0];
  if (divider?.kind !== "session_divider") throw new Error("expected a fallback session divider");
  assert.equal(divider.runId, RUN_ID);
  assert.equal(divider.epoch, `post:standby:${RUN_ID}`);
  assert.equal(divider.startedAt, fallbackStartedAt);
  assert.equal(divider.isActive, false);

  const latest = buildCodexSegments([], [], [], {
    runId: RUN_ID,
    isLatestRun: true,
    fallbackStartedAt,
  });
  assert.deepEqual(latest, []);
});

function emptySpanStats(): SpanStats {
  return {
    started: 0,
    outcomes: { success: 0, error: 0, cancelled: 0, pending: 0, unknown: 0 },
    durationMs: { median: null, p95: null },
  };
}

function sampleWorkbenchRunData(): RunData {
  const stats = emptySpanStats();
  return {
    project: "demo-ws",
    run: RUN_ID,
    manifest: {
      shiori: { implementation: "omp", implementationVersion: "1.0.0" },
      runId: RUN_ID,
      workspace: "/tmp/demo-ws",
      workspaceId: "demo-ws",
      socket: "/tmp/demo-ws/.ludens/host.sock",
      drivers: [{ id: "cua", version: "1.0.0" }],
      model: "anthropic/claude-opus-4-6",
      compactionThreshold: 120_000,
    },
    cycles: [{ epoch: "epoch-1", startedAt: "2026-01-01T00:00:00.000Z", timerSeconds: null }],
    selectedEpoch: "epoch-1",
    calls: [],
    paging: { totalCalls: 2, beforeCall: null, hasMore: false, firstIndex: 1, lastIndex: 2 },
    observations: [],
    perception: null,
    notices: [],
    skills: [],
    telemetry: {
      sources: [],
      spans: [],
      shiori: { stats, nativeLoops: [] },
      capabilities: { stats, python: stats, localPython: stats, discovery: stats },
      devices: stats,
      perception: stats,
    },
    lastControl: null,
    activeCompaction: null,
    live: {
      runId: RUN_ID,
      mode: "auto",
      epoch: "epoch-1",
      connected: true,
      reason: "running",
      agent: true,
      thinking: true,
      timerSeconds: null,
      remainingSeconds: null,
    },
    livePhase: null,
    controlAllowed: true,
    controlReason: "",
    updatedAt: "2026-01-01T00:05:00.000Z",
    summary: {
      completed: 2,
      actions: 5,
      explicitObserves: 1,
      errors: 0,
      compactions: 0,
      medianMs: 1200,
      p95Ms: 2100,
      medianHeadersMs: null,
      medianHttpHeadersMs: null,
      medianWsWaitMs: null,
      cacheHit: 0.85,
      warmCacheHit: 0.9,
      elapsedSeconds: 300,
    },
  };
}

function sampleWorkbenchFeed(historical = true): ActivityFeedData {
  return {
    resetRevision: 0,
    loadedRevision: 0,
    scope: { project: "demo-ws", runId: RUN_ID, epoch: null },
    generation: "gen-1",
    snapshot: 1,
    blocks: [],
    selected: undefined,
    selectionReady: true,
    before: null,
    historyFloorAt: null,
    hasMore: false,
    total: 0,
    historical,
    loading: false,
    loadingOlder: false,
    error: "",
    filter: "all",
    query: "",
    setFilter() {},
    setQuery() {},
    async earlier() {},
    latest() {},
  };
}

test("ShioriWorkbench renders single-line 46px thread header, keeps floating scroll-bottom pill above composer, and aligns right dock header", async () => {
  const { ShioriWorkbench } = await import("../features/live/shiori-cockpit");

  const html = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(ShioriWorkbench, {
        project: "demo-ws",
        workspace: "/tmp/demo-ws",
        workspaceTitle: "Demo Workspace",
        data: sampleWorkbenchRunData(),
        feed: sampleWorkbenchFeed(true),
        isLiveRun: true,
        phaseLabel: "接收模型流",
        phaseElapsedMs: 2000,
        onUpdated() {},
        onOpenPerf() {},
        onOpenCaps() {},
        onReturnLatest() {},
        observationSlot: createElement("div", { "data-test-viewport": "true" }, "viewport"),
        runPicker: createElement("div", { "data-test-run-picker": "true" }, "run-picker"),
      }),
    ),
  );

  // Clean zero-topbar single-line cockpit header in left pane
  assert.match(html, /codex-cockpit-header/);
  assert.match(html, /class="codex-thread-heading"[^>]*>Demo Workspace<\/strong>/);
  assert.doesNotMatch(html, /codex-thread-brand/);
  assert.doesNotMatch(html, /codex-follow-toggle-btn/);
  assert.match(html, /data-test-run-picker="true"/);
  assert.match(html, /codex-pool-trigger-btn/);
  assert.match(html, /codex-dock-close-btn/);

  const scrollStagePos = html.indexOf("codex-chat-scroll-stage");
  const scrollBtnPos = html.indexOf("codex-scroll-bottom-btn");
  const composerPos = html.indexOf("codex-composer-wrap");
  assert.ok(
    scrollStagePos > -1 && scrollBtnPos > scrollStagePos && composerPos > scrollBtnPos,
    "scroll-to-bottom button is anchored inside .codex-chat-scroll-stage strictly above .codex-composer-wrap",
  );

  assert.match(html, /class="codex-dock-header"/);
  assert.match(html, /class="codex-dock-header-title"/);

  const dockHeader = html.slice(html.indexOf('class="codex-dock-header"'), html.indexOf("codex-dock-close-btn"));
  assert.match(dockHeader, /class="codex-dock-seg" role="tablist"/);
  assert.equal((dockHeader.match(/role="tab"/g) ?? []).length, 2, "dock header renders 画面与遥测 | 事件池 tabs");
  assert.match(dockHeader, /aria-selected="true"[^>]*><span class="codex-dock-header-title">/, "stage tab is the default");
  assert.match(dockHeader, /data-dock-tab-pool/);
  assert.match(html, /data-dock-tab="stage"/);
});

test("ShioriWorkbench renders Event Pool Message 1 at createdAt with #seq + status and Message 2 receipt card at T_read", async () => {
  const { ShioriWorkbench } = await import("../features/live/shiori-cockpit");
  const sentEvent = {
    id: "ev-12",
    seq: 12,
    direction: "inbound" as const,
    kind: "message" as const,
    status: "pending" as const,
    text: "wifi dropped, check the Switch connection",
    createdAt: "2026-01-01T00:00:05.000Z",
  };
  const withdrawnEvent = { ...sentEvent, id: "ev-13", seq: 13, createdAt: "2026-01-01T00:00:06.000Z" };
  const receipt = (id: string, at: string, actor: "shiori" | "human", event: typeof sentEvent) =>
    block({
      id,
      kind: "system",
      title: "pool_receipt",
      at,
      data: {
        role: "pool_receipt",
        action: "handled",
        actor,
        ids: [event.id],
        events: [{ ...event, status: "handled", handledAt: at, handledBy: actor }],
      },
      trace: { epoch: "epoch-1" },
    });
  const feed = {
    ...sampleWorkbenchFeed(false),
    blocks: [
      block({
        id: "ctrl",
        kind: "system",
        title: "control",
        at: "2026-01-01T00:00:00.000Z",
        data: { mode: "auto", epoch: "epoch-1" },
        trace: { epoch: "epoch-1" },
      }),
      block({
        id: "sent-12",
        kind: "text",
        title: "Event",
        at: sentEvent.createdAt,
        data: { role: "user", mode: "event", text: sentEvent.text, event: sentEvent },
        trace: { epoch: "epoch-1" },
      }),
      block({
        id: "sent-13",
        kind: "text",
        title: "Event",
        at: withdrawnEvent.createdAt,
        data: { role: "user", mode: "event", text: withdrawnEvent.text, event: withdrawnEvent },
        trace: { epoch: "epoch-1" },
      }),
      receipt("withdraw-13", "2026-01-01T00:00:09.000Z", "human", withdrawnEvent),
      receipt("read-12", "2026-01-01T00:00:13.000Z", "shiori", sentEvent),
    ],
  };
  const html = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(ShioriWorkbench, {
        project: "demo-ws",
        workspace: "/tmp/demo-ws",
        workspaceTitle: "Demo Workspace",
        data: sampleWorkbenchRunData(),
        feed,
        isLiveRun: true,
        onUpdated() {},
        onOpenPerf() {},
        onOpenCaps() {},
        onReturnLatest() {},
        observationSlot: createElement("div", null, "viewport"),
      }),
    ),
  );

  const message1Pos = html.indexOf('data-pool-event-id="ev-12"');
  const receiptPos = html.indexOf('data-pool-receipt="ev-12"');
  assert.ok(message1Pos > -1, "Message 1 carries data-pool-event-id");
  assert.match(html, /data-pool-event-id="ev-12" data-pool-seq="12"/);
  assert.match(html, /codex-pool-seq-link[^>]*>[^<]*· #12/);
  assert.ok(receiptPos > message1Pos, "Message 2 receipt renders after Message 1");
  assert.match(html, /class="codex-pool-receipt" data-actor="shiori"/);
  assert.match(html, /codex-pool-receipt-latency/, "receipt shows turnaround latency");
  assert.match(html, /codex-pool-receipt-jump/);
  assert.doesNotMatch(html, /data-pool-receipt="ev-13"/, "human withdrawal emits no receipt card");
  assert.match(html, /data-pool-event-id="ev-13"[\s\S]*?data-withdrawn="true"/, "withdrawn bubble is marked in place");
});

test("Live workbench CSS enforces full-width stretch, 46px header parity, <1100px overlay drawer, and anti-wrap telemetry badges", () => {
  const activityCss = readFileSync(
    join(import.meta.dirname, "../features/live/activity-feed.css"),
    "utf8",
  );
  const observationCss = readFileSync(
    join(import.meta.dirname, "../features/live/observation-panel.css"),
    "utf8",
  );

  assert.match(
    activityCss,
    /\.console-main:has\(\.live-page\)\s+\.page-content\.live-page[\s\S]*?\{[^}]*width:\s*100%;[^}]*margin:\s*0;[^}]*max-width:\s*none;/,
  );
  assert.match(activityCss, /\.codex-thread-header,\s*\.codex-cockpit-header\s*\{[^}]*height:\s*46px;/);
  assert.match(activityCss, /\.codex-dock-header\s*\{[^}]*height:\s*46px;/);
  assert.match(activityCss, /\.codex-live-phase\s*\{[^}]*display:\s*block;[^}]*min-width:\s*68px;/);
  assert.match(activityCss, /\.codex-workbench\[data-dock-open\]\s*\{[^}]*clamp\(380px,\s*26vw,\s*410px\)/);
  assert.match(
    activityCss,
    /@media\s*\(max-width:\s*1439px\)[\s\S]*?\.codex-workbench\[data-dock-open\]:not\(\[data-immersive="true"\]\)[\s\S]*?clamp\(330px,\s*26\.5vw,\s*350px\)/,
  );
  assert.match(activityCss, /\.codex-header-icon-btn\s*\{[^}]*min-width:\s*28px;/);
  assert.match(
    activityCss,
    /@media\s*\(max-width:\s*1099px\)[\s\S]*?\.codex-right-dock:not\(\[data-immersive="true"\]\)\s*\{[^}]*grid-area:\s*auto;[^}]*position:\s*absolute;[^}]*width:\s*min\(380px,\s*calc\(100%\s*-\s*24px\)\);/,
  );
  assert.match(
    activityCss,
    /\.codex-workbench\[data-immersive="true"\]\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\);[^}]*grid-template-areas:\s*"dock";/,
  );
  assert.match(activityCss, /\.codex-runtime-header,\s*\.shiori-timer-header\s*\{[^}]*flex-wrap:\s*nowrap;/);
  assert.match(activityCss, /\.shiori-timer-bar\s*\{[^}]*repeat\(24,/);
  assert.match(activityCss, /\.codex-follow-pill\s*\{[^}]*position:\s*absolute;[^}]*bottom:\s*10px;/);

  assert.match(
    observationCss,
    /\.observation-priority\s+\.surface-heading\s*>\s*span\s*\{[^}]*max-width:\s*none;[^}]*white-space:\s*nowrap;/,
  );
});

test("post-cycle standby system events coalesce into one closed <details> disclosure without repeated post dividers", async () => {
  const { ShioriWorkbench } = await import("../features/live/shiori-cockpit");

  const blocks = [
    block({
      id: "ctl-auto-1",
      kind: "system",
      title: "control",
      at: "2026-11-07T13:06:03.000Z",
      data: { mode: "auto", epoch: "epoch-1" },
      trace: { epoch: "epoch-1" },
    }),
    block({
      id: "reply-done",
      kind: "text",
      title: "Assistant",
      at: "2026-11-07T13:09:39.000Z",
      text: "已完成双设备单次按键及帧号验证。保持停止，未追加输入。",
      data: { role: "assistant", text: "已完成双设备单次按键及帧号验证。保持停止，未追加输入。" },
      source: { component: "shiori" },
      trace: { epoch: "epoch-1" },
    }),
    block({
      id: "ctl-manual-end",
      kind: "system",
      title: "control",
      at: "2026-11-07T13:09:42.000Z",
      data: {
        mode: "manual",
        epoch: "epoch-1",
        reason: "Device disconnected after 3 reconnect attempts: read ECONNRESET",
      },
      trace: { epoch: "epoch-1" },
    }),
    // 1m 16s later: reconnect + redundant manual control snapshot + perception fault
    block({
      id: "sys-reconn-1",
      kind: "system",
      title: "device_reconnected",
      at: "2026-11-07T13:10:58.000Z",
      data: { source: "baseware_event" },
    }),
    block({
      id: "ctl-manual-standby",
      kind: "system",
      title: "control",
      at: "2026-11-07T13:10:58.500Z",
      data: { mode: "manual", epoch: null, reason: "reconnected" },
    }),
    // 29m later
    block({
      id: "sys-fault-1",
      kind: "system",
      title: "perception_fault",
      at: "2026-11-07T13:40:01.000Z",
      text: "LudensError: read ECONNRESET",
    }),
    // 8m 25s later
    block({
      id: "sys-fault-end-1",
      kind: "system",
      title: "perception_fault_end",
      at: "2026-11-07T13:48:26.000Z",
      data: { reason: "recovered" },
    }),
  ];

  const cycles = [
    {
      epoch: "epoch-1",
      startedAt: "2026-11-07T13:06:03.000Z",
      endedAt: "2026-11-07T13:09:42.000Z",
      timerSeconds: 1800,
      reason: "Device disconnected after 3 reconnect attempts: read ECONNRESET",
    },
  ];

  const segments = buildCodexSegments(blocks, [], [], {
    runId: RUN_ID,
    isLatestRun: false,
    isAuto: false,
    cycles,
  });

  const dividers = segments.filter(item => item.kind === "session_divider");
  assert.equal(dividers.length, 1, "only the real #1 cycle divider is emitted; standby noise emits zero post: dividers");
  assert.equal(dividers[0]?.epoch, "epoch-1");

  const turns = segments.filter((item): item is Extract<(typeof segments)[number], { kind: "turn" }> => item.kind === "turn");
  assert.equal(turns.length, 2, "one completed reply turn + one coalesced standby system turn");
  assert.deepEqual(
    turns[1]?.steps.map(step => step.id),
    ["sys-reconn-1", "sys-fault-1", "sys-fault-end-1"],
    "all standby system events across 1m/29m/8m gaps stay coalesced in one group",
  );

  const runData = {
    ...sampleWorkbenchRunData(),
    cycles,
    live: null,
  };
  const feed = { ...sampleWorkbenchFeed(false), blocks };
  const html = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(ShioriWorkbench, {
        project: "demo-ws",
        workspace: "/tmp/demo-ws",
        workspaceTitle: "Demo Workspace",
        data: runData,
        feed,
        isLiveRun: false,
        onUpdated() {},
        onOpenPerf() {},
        onOpenCaps() {},
        onReturnLatest() {},
        observationSlot: createElement("div", null, "viewport"),
      }),
    ),
  );

  assert.doesNotMatch(html, /codex-session-gap/, "stacked floating gap pill is eliminated");
  assert.match(
    html,
    /<details class="codex-step-group" data-variant="system"><summary class="codex-step-group-toggle" data-step-group-toggle="">/,
    "standby system log renders as a closed native <details> with <summary>",
  );
  assert.match(html, /Standby system events · 3/, "summary clearly labels standby system count");
  assert.match(html, /device link \/ perception/, "summary surfaces categorized system causes");
  assert.match(html, /id="sys-fault-1"/, "collapsed step rows remain in DOM inside <details> for Find-in-Page");
  assert.match(html, /Device disconnected/, "raw ECONNRESET stop reason is humanized on the #1 cycle divider");
});

test("multi-cycle transition renders inline idle metadata inside the single cycle divider pill", async () => {
  const { ShioriWorkbench } = await import("../features/live/shiori-cockpit");

  const cycles = [
    {
      epoch: "epoch-1",
      startedAt: "2026-11-07T13:00:00.000Z",
      endedAt: "2026-11-07T13:05:00.000Z",
      timerSeconds: 1800,
      reason: "manual",
    },
    {
      epoch: "epoch-2",
      startedAt: "2026-11-07T13:35:20.000Z",
      timerSeconds: 1800,
    },
  ];

  const blocks = [
    block({
      id: "ctl-1",
      kind: "system",
      title: "control",
      at: "2026-11-07T13:00:00.000Z",
      data: { mode: "auto", epoch: "epoch-1" },
      trace: { epoch: "epoch-1" },
    }),
    block({
      id: "ctl-1-end",
      kind: "system",
      title: "control",
      at: "2026-11-07T13:05:00.000Z",
      data: { mode: "manual", epoch: "epoch-1", reason: "manual" },
      trace: { epoch: "epoch-1" },
    }),
    block({
      id: "ctl-2",
      kind: "system",
      title: "control",
      at: "2026-11-07T13:35:20.000Z",
      data: { mode: "auto", epoch: "epoch-2" },
      trace: { epoch: "epoch-2" },
    }),
  ];

  const html = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(ShioriWorkbench, {
        project: "demo-ws",
        workspace: "/tmp/demo-ws",
        workspaceTitle: "Demo Workspace",
        data: { ...sampleWorkbenchRunData(), cycles },
        feed: { ...sampleWorkbenchFeed(false), blocks },
        isLiveRun: true,
        onUpdated() {},
        onOpenPerf() {},
        onOpenCaps() {},
        onReturnLatest() {},
        observationSlot: createElement("div", null, "viewport"),
      }),
    ),
  );

  assert.doesNotMatch(html, /class="codex-session-gap"/, "no separate stacked gap pill");
  assert.match(html, /class="codex-session-divider-idle" data-session-gap=""/, "idle metadata sits inline inside #2 pill");
  assert.match(html, /after 30m idle/, "30m 20s idle gap rounds away sub-minute noise cleanly");
});

function makeCall(overrides: Partial<Call> & Pick<Call, "id" | "index" | "at" | "atMs">): Call {
  return {
    durationMs: 100,
    headersMs: null,
    firstStreamMs: null,
    wireBytes: null,
    transport: "websocket",
    transportDetails: null,
    frameBytes: null,
    incremental: true,
    wsFrames: 1,
    inputTokens: 100,
    cachedTokens: 80,
    cacheHit: 0.8,
    attempts: 1,
    status: "stop",
    tools: [],
    observations: [],
    inputObservations: [],
    actions: 0,
    phases: {},
    ...overrides,
  };
}

test("CodexInputCard renders 1:1 deliveredPayload (structured, custom_json, custom_text, none) and clean lean historical fallback without duplicate snapshot", async () => {
  const { ShioriWorkbench } = await import("../features/live/shiori-cockpit");

  const structuredPayload = {
    ok: true,
    records: [
      {
        id: "rec-42",
        sequence: 42,
        recordedAt: "2026-11-07T13:00:01.000Z",
        data: { bossHp: 55 },
        space: { zone: "arena" },
      },
    ],
    extra: ["focus_dodge"],
  };

  const calls: Call[] = [
    makeCall({
      id: "call-structured",
      index: 1,
      at: "2026-11-07T13:00:02.000Z",
      atMs: Date.parse("2026-11-07T13:00:02.000Z"),
      perception: {
        at: "2026-11-07T13:00:01.500Z",
        queryId: "internal-query-id-should-not-leak",
        ok: true,
        records: [
          {
            snapshot: {
              id: "rec-42",
              sequence: 42,
              recordedAt: "2026-11-07T13:00:01.000Z",
              data: { bossHp: 55 },
              space: { zone: "arena" },
            },
            text: "",
            observations: [],
          },
        ],
        deliveredPayload: structuredPayload,
        injectionMode: "structured",
        attachImages: false,
      },
    }),
    makeCall({
      id: "call-custom-text",
      index: 2,
      at: "2026-11-07T13:00:05.000Z",
      atMs: Date.parse("2026-11-07T13:00:05.000Z"),
      perception: {
        at: "2026-11-07T13:00:05.000Z",
        deliveredPayload: "Custom plain-text prompt context from loop.py",
        injectionMode: "custom_text",
        attachImages: false,
      },
    }),
    makeCall({
      id: "call-none",
      index: 3,
      at: "2026-11-07T13:00:08.000Z",
      atMs: Date.parse("2026-11-07T13:00:08.000Z"),
      perception: {
        at: "2026-11-07T13:00:08.000Z",
        deliveredPayload: null,
        injectionMode: "none",
        attachImages: false,
      },
    }),
    makeCall({
      id: "call-legacy-fallback",
      index: 4,
      at: "2026-11-07T13:00:12.000Z",
      atMs: Date.parse("2026-11-07T13:00:12.000Z"),
      perception: {
        at: "2026-11-07T13:00:11.000Z",
        queryId: "legacy-q-1",
        ok: true,
        snapshot: {
          id: "legacy-rec-7",
          sequence: 7,
          generation: "old-gen",
          recordedAt: "2026-11-07T13:00:10.000Z",
          sampling: { clock: "c", startedAtMs: 10, finishedAtMs: 22.5 },
          data: { stage: 2 },
        },
        records: [
          {
            snapshot: {
              id: "legacy-rec-7",
              sequence: 7,
              generation: "old-gen",
              recordedAt: "2026-11-07T13:00:10.000Z",
              sampling: { clock: "c", startedAtMs: 10, finishedAtMs: 22.5 },
              data: { stage: 2 },
            },
            text: "Legacy frame",
            observations: [],
          },
        ],
      },
    }),
  ];

  assert.equal(formatModelInputPayload(calls[0]), JSON.stringify(structuredPayload, null, 2));
  assert.equal(formatModelInputPayload(calls[1]), "Custom plain-text prompt context from loop.py");
  assert.equal(formatModelInputPayload(calls[2]), "null");
  const fallbackParsed = JSON.parse(formatModelInputPayload(calls[3])) as Record<string, unknown>;
  assert.deepEqual(fallbackParsed, {
    ok: true,
    records: [
      {
        id: "legacy-rec-7",
        sequence: 7,
        recordedAt: "2026-11-07T13:00:10.000Z",
        text: "Legacy frame",
        data: { stage: 2 },
      },
    ],
  });

  const blocks = [
    block({
      id: "ctl-1",
      kind: "system",
      title: "control",
      at: "2026-11-07T13:00:00.000Z",
      data: { mode: "auto", epoch: "epoch-1" },
      trace: { epoch: "epoch-1" },
    }),
  ];

  const html = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(ShioriWorkbench, {
        project: "demo-ws",
        workspace: "/tmp/demo-ws",
        workspaceTitle: "Demo Workspace",
        data: {
          ...sampleWorkbenchRunData(),
          cycles: [{ epoch: "epoch-1", startedAt: "2026-11-07T13:00:00.000Z", timerSeconds: 1800 }],
          calls,
        },
        feed: { ...sampleWorkbenchFeed(false), blocks },
        isLiveRun: true,
        onUpdated() {},
        onOpenPerf() {},
        onOpenCaps() {},
        onReturnLatest() {},
        observationSlot: createElement("div", null, "viewport"),
      }),
    ),
  );

  assert.match(html, /View model input details/, "native <details> summary shows updated inspector label");
  assert.match(html, /Seq #42/, "lean record sequence renders in header chips without requiring sampling");
  // Call #1 has no sampling -> no Sampled ms chip on call #1; Call #4 has 12.5ms sampling -> renders Sampled 12.5ms
  assert.equal((html.match(/Sampled /g) ?? []).length, 1, "sampling chip only renders when sampling exists and > 0");
  assert.match(html, /Sampled 12\.5ms/);
  assert.match(html, /data-tone="loop">loop\.py custom<\/span>/, "custom_text shows loop.py custom badge");
  assert.match(html, /data-tone="muted">Context skipped by loop\.py<\/span>/, "none mode indicates skipped injection");
  assert.doesNotMatch(html, /internal-query-id-should-not-leak/, "internal queryId never leaks into 1:1 payload view");
  assert.doesNotMatch(html, /"callIndex":/, "legacy callIndex wrapper object is gone");
  assert.doesNotMatch(html, /"snapshot":/, "duplicate top-level snapshot JSON is never rendered");
});

test("Loop orchestration blocks and inter-turn python-call items group into collapsible Loop steps (auto-expanded on fault) and formatCycleReason humanizes loop: reasons", async () => {
  const { ShioriWorkbench, formatCycleReason } = await import("../features/live/shiori-cockpit");
  const zhMessages = JSON.parse(
    readFileSync(join(import.meta.dirname, "../messages/zh.json"), "utf8"),
  ) as { shioriCockpit: Record<string, string> };
  const enMessages = JSON.parse(
    readFileSync(join(import.meta.dirname, "../messages/en.json"), "utf8"),
  ) as { shioriCockpit: Record<string, string> };

  const tEn = (k: string) => enMessages.shioriCockpit[k] ?? k;
  const tZh = (k: string) => zhMessages.shioriCockpit[k] ?? k;

  assert.equal(formatCycleReason("loop: goal_met", tEn), "Loop stopped: goal_met");
  assert.equal(formatCycleReason("loop: goal_met", tZh), "Loop 结束：goal_met");
  assert.equal(formatCycleReason("loop: completed", tEn), "Loop completed");
  assert.equal(formatCycleReason("loop: completed", tZh), "Loop 正常结束");
  assert.equal(formatCycleReason("loop:", tEn), "Loop completed");
  assert.equal(formatCycleReason("timer expired", tEn), "Timer expired");
  assert.equal(formatCycleReason("timer expired", tZh), "达到定时时长");

  const blocks: ActivityBlock[] = [
    block({
      id: "ctl-1",
      kind: "system",
      title: "control",
      at: "2026-11-07T13:00:00.000Z",
      data: { mode: "auto", epoch: "epoch-1" },
      trace: { epoch: "epoch-1" },
    }),
    // Healthy inter-turn loop orchestration group (loop_status + loop_step + inter-turn python-call without modelCallId)
    block({
      id: "loop-st-1",
      kind: "system",
      title: "loop_status",
      at: "2026-11-07T13:00:01.000Z",
      text: "loop.py ready",
      data: { role: "loop_status", state: "ready" },
      trace: { epoch: "epoch-1" },
    }),
    block({
      id: "loop-step-1",
      kind: "system",
      title: "loop_step",
      at: "2026-11-07T13:00:02.000Z",
      text: "Turn #1 · wait 2s",
      data: { role: "loop_step", turn: 1, action: "wait", seconds: 2 },
      trace: { epoch: "epoch-1" },
    }),
    block({
      id: "py-inter-turn-1",
      kind: "tool",
      title: "python-call",
      at: "2026-11-07T13:00:03.000Z",
      text: "python/macros.py:advance_dialog (35ms)",
      data: { capability: "python/macros.py:advance_dialog" },
      trace: { epoch: "epoch-1", recordingPurpose: "loop" },
    }),
    block({
      id: "loop-step-2",
      kind: "system",
      title: "loop_step",
      at: "2026-11-07T13:00:04.000Z",
      text: "Turn #2 · prompt",
      data: { role: "loop_step", turn: 2, action: "prompt" },
      trace: { epoch: "epoch-1" },
    }),
    // Model turn with modelCallId — plus an ordinary !modelCallId python-call from a bash subprocess (no recordingPurpose="loop") that MUST NOT split the LLM turn!
    block({
      id: "m1-think",
      kind: "thinking",
      title: "Thinking",
      at: "2026-11-07T13:00:05.000Z",
      text: "Checking current battle state.",
      trace: { epoch: "epoch-1", modelCallId: "call-1" },
    }),
    block({
      id: "m1-bash-subproc-py",
      kind: "tool",
      title: "python-call",
      at: "2026-11-07T13:00:05.500Z",
      text: "python/macros.py:probe_from_bash (18ms)",
      data: { capability: "python/macros.py:probe_from_bash" },
      trace: { epoch: "epoch-1" },
    }),
    block({
      id: "m1-cap-tool",
      kind: "tool",
      title: "python/macros.py:attack",
      at: "2026-11-07T13:00:06.000Z",
      tool: { intent: "Attack target", args: { capability: "python/macros.py:attack" } },
      trace: { epoch: "epoch-1", modelCallId: "call-1" },
    }),
    block({
      id: "m1-reply",
      kind: "text",
      title: "Assistant",
      at: "2026-11-07T13:00:07.000Z",
      text: "Executed attack macro.",
      source: { component: "shiori" },
      trace: { epoch: "epoch-1", modelCallId: "call-1" },
    }),
    // Subsequent loop orchestration group WITH a fault
    block({
      id: "loop-fault-1",
      kind: "system",
      title: "loop_fault",
      status: "error",
      at: "2026-11-07T13:00:08.000Z",
      text: "loop.py step fault: KeyError: 'hp'",
      data: { role: "loop_fault", phase: "step", error: "KeyError: 'hp'", fallback: "default_loop" },
      trace: { epoch: "epoch-1" },
    }),
    block({
      id: "loop-step-3",
      kind: "system",
      title: "loop_step",
      at: "2026-11-07T13:00:09.000Z",
      text: "Turn #3 · stop (goal_met)",
      data: { role: "loop_step", turn: 3, action: "stop", reason: "goal_met" },
      trace: { epoch: "epoch-1" },
    }),
    block({
      id: "ctl-end",
      kind: "system",
      title: "control",
      at: "2026-11-07T13:00:10.000Z",
      data: { mode: "manual", epoch: "epoch-1", reason: "loop: goal_met" },
      trace: { epoch: "epoch-1" },
    }),
  ];

  const cycles = [
    {
      epoch: "epoch-1",
      startedAt: "2026-11-07T13:00:00.000Z",
      endedAt: "2026-11-07T13:00:10.000Z",
      timerSeconds: 1800,
      reason: "loop: goal_met",
    },
  ];

  const segments = buildCodexSegments(blocks, [], [], {
    runId: RUN_ID,
    isLatestRun: false,
    isAuto: false,
    cycles,
  });

  const turns = segments.filter(
    (seg): seg is Extract<(typeof segments)[number], { kind: "turn" }> => seg.kind === "turn",
  );
  assert.equal(turns.length, 3, "healthy loop group + model turn + fault loop group stay cleanly separated");
  assert.equal(turns[0]?.stepGroupVariant, "loop");
  assert.equal(turns[0]?.loopFault, undefined);
  assert.deepEqual(
    turns[0]?.steps.map(s => s.id),
    ["loop-st-1", "loop-step-1", "py-inter-turn-1", "loop-step-2"],
  );

  assert.equal(turns[1]?.stepGroupVariant, undefined);
  assert.deepEqual(
    turns[1]?.steps.map(s => s.id),
    ["m1-think", "m1-bash-subproc-py", "m1-cap-tool"],
    "!modelCallId python-call without recordingPurpose='loop' stays inside the LLM turn without splitting it",
  );
  assert.equal(turns[1]?.responseBlock?.id, "m1-reply");

  assert.equal(turns[2]?.stepGroupVariant, "loop");
  assert.equal(turns[2]?.loopFault, true);
  assert.deepEqual(
    turns[2]?.steps.map(s => s.id),
    ["loop-fault-1", "loop-step-3"],
  );

  const html = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(ShioriWorkbench, {
        project: "demo-ws",
        workspace: "/tmp/demo-ws",
        workspaceTitle: "Demo Workspace",
        data: { ...sampleWorkbenchRunData(), cycles, live: null },
        feed: { ...sampleWorkbenchFeed(false), blocks },
        isLiveRun: false,
        onUpdated() {},
        onOpenPerf() {},
        onOpenCaps() {},
        onReturnLatest() {},
        observationSlot: createElement("div", null, "viewport"),
      }),
    ),
  );

  assert.match(
    html,
    /<details class="codex-step-group" data-variant="loop"><summary/,
    "healthy loop group renders as a closed native <details data-variant=\"loop\">",
  );
  assert.match(html, /Loop steps · 4 · wait \/ capability \/ prompt/);
  assert.match(
    html,
    /<details class="codex-step-group" data-variant="loop" data-fault="true" open=""><summary/,
    "faulty loop group renders with data-fault=\"true\" and auto-expanded open attribute",
  );
  assert.match(html, /Loop fault · 2 steps · fault \/ stop/);
  assert.match(html, /Loop stopped: goal_met/, "session divider humanizes loop: goal_met stop reason");
});

test("ShioriWorkbench omits shiori-timer-bar when timerSeconds is null (unbounded) and renders 24-block bar when manual timer is active", async () => {
  const { ShioriWorkbench } = await import("../features/live/shiori-cockpit");

  const unboundedHtml = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(ShioriWorkbench, {
        project: "demo-unbounded",
        workspace: "/tmp/demo-unbounded",
        workspaceTitle: "Demo Unbounded",
        data: sampleWorkbenchRunData(),
        feed: sampleWorkbenchFeed(false),
        isLiveRun: true,
        onUpdated() {},
        onOpenPerf() {},
        onOpenCaps() {},
        onReturnLatest() {},
        observationSlot: createElement("div", null, "viewport"),
      }),
    ),
  );
  assert.match(unboundedHtml, /shiori-timer-header/);
  assert.match(unboundedHtml, /Ran 5m/);
  assert.doesNotMatch(unboundedHtml, /shiori-timer-bar/, "unbounded auto run must not render 24-block countdown bar");
  assert.doesNotMatch(unboundedHtml, /data-timed="true"/, "unbounded auto run shows continuous trigger instead of timed pill");

  const timedRun: RunData = {
    ...sampleWorkbenchRunData(),
    cycles: [{ epoch: "epoch-1", startedAt: "2026-01-01T00:00:00.000Z", timerSeconds: 900 }],
    live: {
      ...sampleWorkbenchRunData().live!,
      timerSeconds: 900,
      remainingSeconds: 600,
    },
  };
  const timedHtml = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(ShioriWorkbench, {
        project: "demo-timed",
        workspace: "/tmp/demo-timed",
        workspaceTitle: "Demo Timed",
        data: timedRun,
        feed: sampleWorkbenchFeed(false),
        isLiveRun: true,
        onUpdated() {},
        onOpenPerf() {},
        onOpenCaps() {},
        onReturnLatest() {},
        observationSlot: createElement("div", null, "viewport"),
      }),
    ),
  );
  assert.match(timedHtml, /shiori-timer-bar/);
  assert.match(timedHtml, /role="progressbar" aria-valuenow="33"/);
  assert.match(timedHtml, /data-timed="true"/);
  assert.match(timedHtml, /10m left/);
});
