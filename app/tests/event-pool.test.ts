import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkspaceEventPool } from "@ludens/core/core/storage/event-pool";
import { DashboardWorker } from "@ludens/core/core/query/dashboard-worker";
import {
  buildCodexSegments,
  mergePoolSnapshotSegments,
  segmentTimestampMs,
  type StreamSegment,
} from "../features/live/shiori-segments";
import type { PoolEvent } from "@ludens/protocol/event-pool";
import type { ActivityBlock } from "../features/live/activity-feed-model";
import { registerFixture } from "./fixtures/registry";

const appDir = fileURLToPath(new URL("../", import.meta.url));

test("dashboard worker reads and mutates workspace Event Pool in standby mode with scope validation", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ludens-app-event-pool-")));
  const workspace = join(root, "workspace");
  await registerFixture(root, "demo", workspace);
  const pool = new WorkspaceEventPool(join(workspace, ".ludens"));
  const outbound = await pool.emitOutbound({
    kind: "help_request",
    title: "Boss gate",
    text: "Need passcode for vault door",
    pauseRequested: true,
    runId: "run-1",
    epoch: "epoch-1",
  });

  const worker = new DashboardWorker({ env: { ...process.env, LUDENS_HOME: root } });
  try {
    const initial = await worker.call("eventPoolRead", ["demo", workspace]);
    assert.equal(initial.hostOnline, false);
    assert.deepEqual(initial.snapshot.summary, {
      pendingInbound: 0,
      pendingOutbound: 1,
      latestSeq: 1,
    });
    assert.equal(initial.snapshot.events[0]?.id, outbound.event.id);

    await assert.rejects(
      worker.call("eventPoolRead", ["demo", join(root, "wrong-path")]),
      /工作区登记目录已变化/,
    );

    const sent = await worker.call("eventPoolMutate", [
      "demo",
      workspace,
      { action: "send", title: "Tip", text: "Check inventory keycard first" },
    ]);
    assert.equal(sent.hostOnline, false);
    assert.equal(sent.createdEvent?.kind, "message");
    assert.deepEqual(sent.snapshot.summary, {
      pendingInbound: 1,
      pendingOutbound: 1,
      latestSeq: 2,
    });

    await assert.rejects(
      worker.call("eventPoolMutate", [
        "demo",
        workspace,
        { action: "reply", replyTo: outbound.event.id, text: "Code is 0451", resumeAuto: true },
      ]),
      /宿主未在线/,
    );

    const replied = await worker.call("eventPoolMutate", [
      "demo",
      workspace,
      { action: "reply", replyTo: outbound.event.id, text: "Code is 0451" },
    ]);
    assert.equal(replied.createdEvent?.kind, "reply");
    assert.equal(replied.createdEvent?.replyTo, outbound.event.id);
    assert.equal(replied.resolvedOutbound?.status, "handled");
    assert.equal(replied.resolvedOutbound?.handledBy, "human");
    assert.deepEqual(replied.snapshot.summary, {
      pendingInbound: 2,
      pendingOutbound: 0,
      latestSeq: 3,
    });

    const notice = await pool.emitOutbound({
      kind: "notice",
      text: "Checkpoint saved",
    });
    const acked = await worker.call("eventPoolMutate", [
      "demo",
      workspace,
      { action: "ack", ids: [notice.event.id] },
    ]);
    assert.equal(acked.updatedEvents?.length, 1);
    assert.equal(acked.snapshot.summary.pendingOutbound, 0);
  } finally {
    await worker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("buildCodexSegments projects inbound Event Pool bubbles and outbound Shiori cards cleanly", () => {
  const blocks: ActivityBlock[] = [
    {
      id: "ctrl-1",
      kind: "system",
      title: "control",
      text: "",
      at: "2026-11-11T06:00:00.000Z",
      status: "complete",
      data: { mode: "auto", epoch: "ep-1", maxSeconds: null },
      trace: { epoch: "ep-1" },
      createdRevision: 1,
      revision: 1,
    },
    {
      id: "pool-in-1",
      kind: "text",
      title: "Event",
      text: "Try talking to the merchant",
      at: "2026-11-11T06:00:05.000Z",
      status: "complete",
      data: {
        role: "user",
        mode: "event",
        text: "Try talking to the merchant",
        event: {
          id: "ev-1-aaaa1111",
          seq: 1,
          direction: "inbound",
          kind: "message",
          status: "pending",
          title: "Hint",
          text: "Try talking to the merchant",
          createdAt: "2026-11-11T06:00:05.000Z",
        },
      },
      trace: { epoch: "ep-1" },
      createdRevision: 2,
      revision: 2,
    },
    {
      id: "pool-out-2",
      kind: "text",
      title: "Help Request",
      text: "CAPTCHA / 2FA prompt appeared on login screen",
      at: "2026-11-11T06:00:12.000Z",
      status: "complete",
      source: { component: "shiori" },
      data: {
        role: "shiori_event",
        mode: "help_request",
        text: "CAPTCHA / 2FA prompt appeared on login screen",
        event: {
          id: "ev-2-bbbb2222",
          seq: 2,
          direction: "outbound",
          kind: "help_request",
          status: "pending",
          pauseRequested: true,
          text: "CAPTCHA / 2FA prompt appeared on login screen",
          createdAt: "2026-11-11T06:00:12.000Z",
        },
      },
      trace: { epoch: "ep-1" },
      createdRevision: 3,
      revision: 3,
    },
    {
      id: "ctrl-2",
      kind: "system",
      title: "control",
      text: "",
      at: "2026-11-11T06:00:13.000Z",
      status: "complete",
      data: { mode: "manual", epoch: null, reason: "awaiting human", elapsedMs: 13000 },
      trace: { epoch: "ep-1" },
      createdRevision: 4,
      revision: 4,
    },
  ];

  const segments = buildCodexSegments(blocks, [], [], {
    runId: "run-1",
    cycles: [],
    isLatestRun: true,
    isAuto: false,
  });

  assert.deepEqual(
    segments.map(item => item.kind),
    ["session_divider", "user", "outbound_event"],
  );
  const divider = segments[0];
  assert.equal(divider?.kind, "session_divider");
  if (divider?.kind === "session_divider") {
    assert.equal(divider.stopReason, "awaiting human");
  }
  const userSeg = segments[1];
  assert.equal(userSeg?.kind, "user");
  if (userSeg?.kind === "user") {
    assert.equal(userSeg.mode, "event");
    assert.equal(userSeg.poolEvent?.id, "ev-1-aaaa1111");
  }
  const outSeg = segments[2];
  assert.equal(outSeg?.kind, "outbound_event");
  if (outSeg?.kind === "outbound_event") {
    assert.equal(outSeg.event.id, "ev-2-bbbb2222");
    assert.equal(outSeg.event.pauseRequested, true);
  }
});

test("en and zh shioriCockpit locale keys stay in exact parity with Event Pool translations", async () => {
  const [enRaw, zhRaw] = await Promise.all([
    readFile(join(appDir, "messages/en.json"), "utf8"),
    readFile(join(appDir, "messages/zh.json"), "utf8"),
  ]);
  const en = JSON.parse(enRaw) as { shioriCockpit: Record<string, string> };
  const zh = JSON.parse(zhRaw) as { shioriCockpit: Record<string, string> };
  const enKeys = Object.keys(en.shioriCockpit).sort();
  const zhKeys = Object.keys(zh.shioriCockpit).sort();
  assert.deepEqual(enKeys, zhKeys);
  assert.equal(enKeys.some(key => key.toLowerCase().includes("followup")), false);
  assert.equal(enKeys.includes("deliveryEventPool"), true);
  assert.equal(enKeys.includes("poolHelpRequestBadge"), true);
  assert.equal(enKeys.includes("poolReplyResumeBtn"), true);
});

// ── Chronological split: sent bubble @ createdAt + causal receipt @ handledAt ──

const STREAM_RUN = "20261112T051955Z-diablo3";

function poolStreamBlock(
  overrides: Pick<ActivityBlock, "id" | "kind" | "at" | "title"> & Partial<ActivityBlock>,
): ActivityBlock {
  return { text: "", status: "complete", createdRevision: 1, revision: 1, ...overrides };
}

function poolEventFixture(overrides: Partial<PoolEvent> & Pick<PoolEvent, "id" | "seq" | "createdAt">): PoolEvent {
  return {
    direction: "inbound",
    kind: "message",
    status: "pending",
    text: `event ${overrides.seq}`,
    ...overrides,
  };
}

function autoControl(at: string): ActivityBlock {
  return poolStreamBlock({
    id: `ctrl-${at}`,
    kind: "system",
    title: "control",
    at,
    data: { mode: "auto", epoch: "ep-today", maxSeconds: null },
    trace: { epoch: "ep-today" },
  });
}

function assistantText(id: string, at: string, text: string): ActivityBlock {
  return poolStreamBlock({
    id,
    kind: "text",
    title: "assistant",
    at,
    text,
    source: { component: "shiori" },
    trace: { epoch: "ep-today" },
  });
}

function inboundEventBlock(event: PoolEvent): ActivityBlock {
  return poolStreamBlock({
    id: `pool-created-${event.id}`,
    kind: "text",
    title: "Event",
    at: event.createdAt,
    text: event.text,
    data: { role: "user", mode: "event", text: event.text, event },
    trace: { epoch: "ep-today" },
  });
}

function receiptBlock(id: string, at: string, actor: "shiori" | "human", events: PoolEvent[]): ActivityBlock {
  return poolStreamBlock({
    id,
    kind: "system",
    title: "pool_receipt",
    at,
    text: `${actor} handled ${events.map(item => `#${item.seq}`).join(", ")}`,
    data: {
      role: "pool_receipt",
      action: "handled",
      actor,
      ids: events.map(item => item.id),
      events: events.map(item => ({ ...item, status: "handled", handledAt: at, handledBy: actor })),
    },
    trace: { epoch: "ep-today" },
  });
}

function segmentTimes(segments: StreamSegment[]): number[] {
  return segments.map(segmentTimestampMs).filter(Number.isFinite);
}

test("mergePoolSnapshotSegments never pins yesterday's handled 21:40:10 bubble below today's 13:20:30 stream and inserts in-window events chronologically", () => {
  const segments = buildCodexSegments(
    [
      autoControl("2026-11-12T13:20:00.000Z"),
      assistantText("a-1", "2026-11-12T13:20:21.000Z", "Opening the inventory."),
      assistantText("a-2", "2026-11-12T13:20:30.000Z", "Equipping the new gem."),
    ],
    [],
    [],
    { runId: STREAM_RUN, cycles: [], isLatestRun: true, isAuto: true },
  );
  const yesterdayHandled = poolEventFixture({
    id: "ev-yesterday",
    seq: 7,
    runId: null,
    status: "handled",
    handledBy: "shiori",
    createdAt: "2026-11-11T21:40:02.000Z",
    handledAt: "2026-11-11T21:40:10.000Z",
  });
  const yesterdayPendingOffline = poolEventFixture({
    id: "ev-yesterday-pending",
    seq: 8,
    runId: null,
    createdAt: "2026-11-11T21:41:00.000Z",
  });
  const inWindow = poolEventFixture({ id: "ev-now", seq: 12, runId: null, createdAt: "2026-11-12T13:20:25.000Z" });
  const earliestLoadedMs = Date.parse("2026-11-12T13:20:00.000Z");

  const merged = mergePoolSnapshotSegments(segments, [yesterdayHandled, yesterdayPendingOffline, inWindow], {
    earliestLoadedMs,
    hasMoreUpwardHistory: true,
  });

  const poolIds = merged.flatMap(seg => (seg.kind === "user" && seg.poolEvent ? [seg.poolEvent.id] : []));
  assert.deepEqual(poolIds, ["ev-now"], "events older than the loaded window stay out of today's stream");
  const insertedIdx = merged.findIndex(seg => seg.kind === "user" && seg.poolEvent?.id === "ev-now");
  const idx2021 = merged.findIndex(seg => seg.kind === "turn" && seg.responseBlock?.id === "a-1");
  const idx2030 = merged.findIndex(seg => seg.kind === "turn" && seg.responseBlock?.id === "a-2");
  assert.ok(idx2021 < insertedIdx && insertedIdx < idx2030, "in-window event lands between 13:20:21 and 13:20:30");
  assert.notEqual(insertedIdx, merged.length - 1, "never appended to the tail");
  const times = segmentTimes(merged);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));

  // Already-projected events are not duplicated; full history loaded => older items sit at their true position (top).
  const fullHistory = mergePoolSnapshotSegments(merged, [yesterdayHandled, inWindow], {
    earliestLoadedMs: 0,
    hasMoreUpwardHistory: false,
  });
  assert.equal(fullHistory.filter(seg => seg.kind === "user" && seg.poolEvent?.id === "ev-now").length, 1);
  assert.equal(fullHistory[0]?.kind, "user");
  assert.equal(fullHistory[0]?.kind === "user" ? fullHistory[0].poolEvent?.id : null, "ev-yesterday");
});

test("pool_receipt splits a 13:20:05 send and a 13:20:42 Shiori read into two chronological stream events", () => {
  const sent = poolEventFixture({
    id: "ev-12",
    seq: 12,
    text: "刚才 wifi 断了宝宝，你看看现在能不能连到 Switch",
    createdAt: "2026-11-12T13:20:05.000Z",
    runId: STREAM_RUN,
  });
  const segments = buildCodexSegments(
    [
      autoControl("2026-11-12T13:20:00.000Z"),
      inboundEventBlock(sent),
      assistantText("a-1", "2026-11-12T13:20:20.000Z", "Clearing the dungeon floor."),
      poolStreamBlock({
        id: "tool-1",
        kind: "tool",
        title: "event_pool",
        at: "2026-11-12T13:20:41.000Z",
        tool: { args: { action: "read" } },
        trace: { epoch: "ep-today" },
      }),
      receiptBlock("receipt-1", "2026-11-12T13:20:42.000Z", "shiori", [sent]),
      assistantText("a-2", "2026-11-12T13:20:50.000Z", "Reconnecting to the Switch."),
    ],
    [],
    [],
    { runId: STREAM_RUN, cycles: [], isLatestRun: true, isAuto: true },
  );

  assert.deepEqual(
    segments.map(seg => seg.kind),
    ["session_divider", "user", "turn", "turn", "pool_receipt", "turn"],
  );
  const message1 = segments.find(seg => seg.kind === "user");
  assert.equal(message1?.kind === "user" ? message1.block.at : null, "2026-11-12T13:20:05.000Z");
  assert.equal(message1?.kind === "user" ? message1.poolEvent?.status : null, "handled");
  assert.equal(message1?.kind === "user" ? message1.poolEvent?.handledBy : null, "shiori");
  assert.equal(message1?.kind === "user" ? message1.poolEvent?.handledAt : null, "2026-11-12T13:20:42.000Z");

  const message2 = segments.find(seg => seg.kind === "pool_receipt");
  assert.ok(message2?.kind === "pool_receipt");
  if (message2?.kind === "pool_receipt") {
    assert.equal(message2.at, "2026-11-12T13:20:42.000Z");
    assert.equal(message2.actor, "shiori");
    assert.deepEqual(message2.ids, ["ev-12"]);
    assert.equal(message2.events[0]?.seq, 12);
    assert.equal(message2.id, `${STREAM_RUN}:pool-receipt:receipt-1`);
  }
  const times = segmentTimes(segments);
  assert.deepEqual(times, [...times].sort((a, b) => a - b), "turns between send and read keep exact timestamp order");
});

test("human withdrawal marks the inbound bubble withdrawn without a receipt card, while human outbound resolution keeps one", () => {
  const withdrawn = poolEventFixture({ id: "ev-20", seq: 20, createdAt: "2026-11-12T13:20:05.000Z" });
  const outbound = poolEventFixture({
    id: "ev-21",
    seq: 21,
    direction: "outbound",
    kind: "notice",
    createdAt: "2026-11-12T13:20:10.000Z",
  });
  const segments = buildCodexSegments(
    [
      autoControl("2026-11-12T13:20:00.000Z"),
      inboundEventBlock(withdrawn),
      poolStreamBlock({
        id: "out-21",
        kind: "text",
        title: "Notice",
        at: outbound.createdAt,
        source: { component: "shiori" },
        data: { role: "shiori_event", mode: "notice", text: outbound.text, event: outbound },
        trace: { epoch: "ep-today" },
      }),
      receiptBlock("receipt-withdraw", "2026-11-12T13:20:15.000Z", "human", [withdrawn]),
      receiptBlock("receipt-resolve", "2026-11-12T13:20:30.000Z", "human", [outbound]),
    ],
    [],
    [],
    { runId: STREAM_RUN, cycles: [], isLatestRun: true, isAuto: true },
  );

  assert.deepEqual(
    segments.map(seg => seg.kind),
    ["session_divider", "user", "outbound_event", "pool_receipt"],
  );
  const bubble = segments.find(seg => seg.kind === "user");
  assert.equal(bubble?.kind === "user" ? bubble.poolEvent?.status : null, "handled");
  assert.equal(bubble?.kind === "user" ? bubble.poolEvent?.handledBy : null, "human");
  const outboundSeg = segments.find(seg => seg.kind === "outbound_event");
  assert.equal(outboundSeg?.kind === "outbound_event" ? outboundSeg.event.status : null, "handled");
  const receipt = segments.find(seg => seg.kind === "pool_receipt");
  assert.equal(receipt?.kind === "pool_receipt" ? receipt.actor : null, "human");
  assert.deepEqual(receipt?.kind === "pool_receipt" ? receipt.ids : null, ["ev-21"]);
});

test("en and zh deviceContention locale keys stay in exact parity and RuntimeControlError classifies CORE_OFFLINE / DEVICE_BUSY", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const {
    RuntimeControlError,
    isCoreOfflineError,
    isDeviceBusyError,
  } = await import("../features/live/live-session-store");

  const en = JSON.parse(readFileSync(join(import.meta.dirname, "../messages/en.json"), "utf8"));
  const zh = JSON.parse(readFileSync(join(import.meta.dirname, "../messages/zh.json"), "utf8"));
  assert.deepEqual(Object.keys(en.deviceContention).sort(), Object.keys(zh.deviceContention).sort());

  const offlineErr = new RuntimeControlError("Core offline", { status: 409, code: "CORE_OFFLINE" });
  assert.equal(isCoreOfflineError(offlineErr), true);
  assert.equal(isDeviceBusyError(offlineErr), false);

  const busyErr = new RuntimeControlError("Busy", {
    status: 409,
    code: "DEVICE_BUSY",
    conflict: { holderProjectId: "other-ws", deviceKey: "adb:1", holderMode: "auto" },
  });
  assert.equal(isDeviceBusyError(busyErr), true);
  assert.equal(isCoreOfflineError(busyErr), false);
});
