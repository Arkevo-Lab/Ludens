import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ActivityBlock } from "../features/live/activity-feed-model";
import { buildCodexSegments, summarizeStepBlock } from "../features/live/shiori-segments";
import { LocaleProvider } from "../lib/locale";
import type { ActivityFeedData } from "../features/live/use-activity-feed";
import type { RunData, SpanStats } from "../lib/types";

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

test("control_budget blocks render a timer badge and stay inside step groups without extra dividers", () => {
  const budget = block({
    id: "budget-1",
    kind: "system",
    at: "2026-01-01T00:00:10.000Z",
    title: "control_budget",
    data: { requestedSeconds: 900, maxSeconds: 900, remainingSeconds: 900 },
    trace: { epoch: "epoch-1" },
  });
  assert.deepEqual(summarizeStepBlock(budget), {
    badge: "⏱ timer",
    detail: "Stop in 15m (900s)",
  });
  assert.deepEqual(
    summarizeStepBlock(block({
      id: "budget-2",
      kind: "system",
      at: "2026-01-01T00:00:11.000Z",
      title: "control_budget",
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
    budget,
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
  assert.ok(turn.steps.some(step => step.id === "budget-1"), "control_budget stays in the step group");
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
      seconds: 1800,
      maxRequests: 500,
      compactionThreshold: 120_000,
    },
    cycles: [{ epoch: "epoch-1", startedAt: "2026-01-01T00:00:00.000Z", maxSeconds: 1800 }],
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
      maxSeconds: null,
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

test("ShioriWorkbench renders 46px header slots, scroll-stage anchor above composer, and aligned Right Dock header", async () => {
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
        mobileNavSlot: createElement("button", { type: "button", "data-test-mobile-nav": "true" }, "nav"),
        runPicker: createElement("div", { "data-test-run-picker": "true" }, "run-picker"),
      }),
    ),
  );

  const mobileNavPos = html.indexOf("data-test-mobile-nav");
  const brandPos = html.indexOf("codex-thread-brand");
  assert.ok(mobileNavPos > -1 && brandPos > mobileNavPos, "mobileNavSlot renders at the start of .codex-thread-header");
  assert.match(html, /class="codex-thread-brand">Shiori<\/span>/);
  assert.match(html, /class="codex-thread-workspace"> · Demo Workspace<\/span>/);

  const runPickerPos = html.indexOf("data-test-run-picker");
  const expandBtnPos = html.indexOf("codex-expand-all-btn");
  const dockTogglePos = html.indexOf("codex-dock-toggle-btn");
  assert.ok(
    runPickerPos > -1 && expandBtnPos > runPickerPos && dockTogglePos > expandBtnPos,
    "runPicker renders inside .codex-thread-actions before expand-steps and right-dock toggle",
  );

  const scrollStagePos = html.indexOf("codex-chat-scroll-stage");
  const scrollBtnPos = html.indexOf("codex-scroll-bottom-btn");
  const composerPos = html.indexOf("codex-composer-wrap");
  assert.ok(
    scrollStagePos > -1 && scrollBtnPos > scrollStagePos && composerPos > scrollBtnPos,
    "scroll-to-bottom button is anchored inside .codex-chat-scroll-stage strictly above .codex-composer-wrap",
  );

  assert.match(html, /class="codex-dock-header"/);
  assert.match(html, /class="codex-dock-header-title"/);
  assert.match(html, /codex-dock-close-btn/);
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
  assert.match(activityCss, /@media\s*\(max-width:\s*1439px\)[\s\S]*?clamp\(330px,\s*26\.5vw,\s*350px\)/);
  assert.match(activityCss, /@media\s*\(max-width:\s*1279px\)[\s\S]*?\.codex-thread-workspace\s*\{\s*display:\s*none;/);
  assert.match(
    activityCss,
    /@media\s*\(max-width:\s*1099px\)[\s\S]*?\.codex-right-dock\s*\{[^}]*position:\s*absolute;[^}]*width:\s*min\(370px,\s*calc\(100vw\s*-\s*48px\)\);/,
  );
  assert.match(activityCss, /\.codex-runtime-header,\s*\.shiori-budget-header\s*\{[^}]*flex-wrap:\s*nowrap;/);
  assert.match(activityCss, /\.codex-scroll-bottom-btn\s*\{[^}]*bottom:\s*8px;/);

  assert.match(
    observationCss,
    /\.observation-priority\s+\.surface-heading\s*>\s*span\s*\{[^}]*max-width:\s*none;[^}]*white-space:\s*nowrap;/,
  );
});
