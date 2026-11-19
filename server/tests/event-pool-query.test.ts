import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceEventPool } from "@ludens/core/core/storage/event-pool";
import { DashboardWorker } from "../src/query/dashboard-worker";
import { registerFixture } from "./fixtures/registry";

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

    const replied = await worker.call("eventPoolMutate", [
      "demo",
      workspace,
      { action: "reply", replyTo: outbound.event.id, text: "Passcode is 4291" },
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
