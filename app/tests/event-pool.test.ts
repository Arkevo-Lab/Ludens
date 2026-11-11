import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkspaceEventPool } from "@ludens/core/core/storage/event-pool";
import { DashboardWorker } from "../lib/dashboard-worker";
import { buildCodexSegments } from "../features/live/shiori-segments";
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
