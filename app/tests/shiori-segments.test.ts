import { test } from "node:test";
import assert from "node:assert/strict";
import type { ActivityBlock } from "../features/live/activity-feed-model";
import { buildCodexSegments, summarizeStepBlock } from "../features/live/shiori-segments";

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
