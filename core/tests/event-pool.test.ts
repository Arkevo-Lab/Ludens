import { expect, test } from "bun:test";
import { access, constants, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime, type AgentRunner } from "../src/core/shiori/runtime.ts";
import { Workspace, } from "../src/core/storage/workspace.ts";
import { WorkspaceEventPool, openWorkspaceEventPool } from "../src/core/storage/event-pool.ts";
import { createTestDeviceSession } from "./runtime-fixture.ts";
import { dispatch, listen, send } from "../src/daemon/transport.ts";
import { eventCommand } from "../src/cli/event-cli.ts";
import { readWorkspaceEventPool, mutateWorkspaceEventPool } from "../src/core/query/event-pool.ts";
import { createLudensExtension } from "../src/core/agent-omp/extension.ts";
import { activityBlocks } from "../src/core/query/activity.ts";
import { ensureWorkspaceIdentity } from "@ludens/protocol/ludens";
import { resolveWorkspaceAddress } from "../src/core/storage/workspace-state.ts";
import type { Event } from "../src/core/query/types.ts";
import type { PoolEvent } from "@ludens/protocol/event-pool";

async function tempDir(prefix: string) {
  return mkdtemp(join(tmpdir(), prefix));
}

async function initializedWorkspace(prefix: string) {
  const directory = await tempDir(prefix);
  const workspace = join(directory, "workspace");
  await mkdir(workspace, { recursive: true });
  const identity = await ensureWorkspaceIdentity(workspace);
  const canonical = await realpath(workspace);
  return { directory, workspace: canonical, identity };
}

function poolFixture(workspace: string) {
  const recorded: Array<{ type: string; data: unknown; trace?: unknown }> = [];
  const gate = Promise.withResolvers<void>();
  const agent: AgentRunner = {
    async run() { await gate.promise; },
    async consolidate() {},
    abort: async () => { gate.resolve(); },
    close: async () => {},
  };
  const { devices } = createTestDeviceSession({ controllers: [] }, () => {});
  const runtime = new Runtime(devices, (type, data, trace) => recorded.push({ type, data, trace }));
  const pool = new WorkspaceEventPool(join(workspace, ".ludens"));
  runtime.attach({ agent, eventPool: pool, eventPoolSummary: { pendingInbound: 0, pendingOutbound: 0, latestSeq: 0 } });
  return { runtime, pool, recorded, gate };
}

test("WorkspaceEventPool round-trips inbound, replies, acks and pruning", async () => {
  const directory = await tempDir("ludens-pool-store-");
  await mkdir(join(directory, "state"), { recursive: true });
  const pool = new WorkspaceEventPool(join(directory, "state"));
  try {
    const empty = await pool.snapshot();
    expect(empty).toEqual({ summary: { pendingInbound: 0, pendingOutbound: 0, latestSeq: 0 }, events: [] });

    const posted = await pool.postInbound({ text: "  hello there  ", title: "  Greeting  ", runId: null, epoch: null });
    expect(posted.event).toMatchObject({ direction: "inbound", kind: "message", status: "pending", text: "hello there", title: "Greeting", seq: 1 });
    expect(posted.summary).toEqual({ pendingInbound: 1, pendingOutbound: 0, latestSeq: 1 });

    // readInbound without ack leaves the event pending.
    const peeked = await pool.readInbound({ ack: false });
    expect(peeked.acknowledged).toEqual([]);
    expect(peeked.events.map(event => event.id)).toEqual([posted.event.id]);
    expect(peeked.summary.pendingInbound).toBe(1);

    // Default read acknowledges by shiori.
    const read = await pool.readInbound();
    expect(read.acknowledged).toHaveLength(1);
    expect(read.acknowledged[0]).toMatchObject({ status: "handled", handledBy: "shiori" });
    expect(read.summary.pendingInbound).toBe(0);

    // A human reply resolves a pending outbound event.
    const outbound = await pool.emitOutbound({ kind: "help_request", text: "need input", runId: null, epoch: null });
    expect(outbound.event).toMatchObject({ direction: "outbound", kind: "help_request", status: "pending", seq: 2 });
    expect(outbound.summary).toEqual({ pendingInbound: 0, pendingOutbound: 1, latestSeq: 2 });
    const reply = await pool.postInbound({ text: "here you go", replyTo: outbound.event.id, runId: null, epoch: null });
    expect(reply.event).toMatchObject({ kind: "reply", replyTo: outbound.event.id, status: "pending" });
    expect(reply.resolvedOutbound).toMatchObject({ id: outbound.event.id, status: "handled", handledBy: "human" });
    expect(reply.summary).toEqual({ pendingInbound: 1, pendingOutbound: 0, latestSeq: 3 });

    // ack marks pending inbound events handled by the given actor.
    const acked = await pool.ack([reply.event.id], "human", "inbound");
    expect(acked.updated).toHaveLength(1);
    expect(acked.updated[0]).toMatchObject({ status: "handled", handledBy: "human" });
    expect(acked.summary.pendingInbound).toBe(0);

    // Pruning retains every pending event while capping handled events at 200.
    const total = 260;
    for (let index = 0; index < total; index++) {
      await pool.postInbound({ text: `message ${index}`, runId: null, epoch: null });
    }
    const drained = await pool.readInbound();
    expect(drained.acknowledged).toHaveLength(total);
    const pending = await pool.postInbound({ text: "keep me", runId: null, epoch: null });
    const snapshot = await pool.snapshot();
    expect(snapshot.events).toHaveLength(201);
    expect(snapshot.summary).toEqual({ pendingInbound: 1, pendingOutbound: 0, latestSeq: total + 4 });
    const kept = snapshot.events.filter(event => event.status === "handled").map(event => event.seq);
    expect(kept).toHaveLength(200);
    expect(kept[0]).toBe(64); // 263 handled events, only the newest 200 survive the cap
    expect(snapshot.events.some(event => event.id === pending.event.id)).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("openWorkspaceEventPool rejects an uninitialized directory without creating .ludens", async () => {
  const directory = await tempDir("ludens-pool-uninit-");
  try {
    await expect(openWorkspaceEventPool(directory)).rejects.toThrow();
    await expect(access(join(directory, ".ludens"), constants.F_OK)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Runtime event pool operations track mode, pause and status summary", async () => {
  const { directory, workspace } = await initializedWorkspace("ludens-pool-runtime-");
  const { runtime, recorded, gate } = poolFixture(workspace);
  try {
    // manual mode: epoch is recorded as null on the stored event.
    const manual = await runtime.postInboundEvent({ text: "offline message" });
    expect(manual.event).toMatchObject({ direction: "inbound", status: "pending", epoch: null });
    expect(manual.status.eventPool).toEqual({ pendingInbound: 1, pendingOutbound: 0, latestSeq: 1 });
    const manualCreated = recorded.find(event => event.type === "pool_event");
    expect(manualCreated?.data).toMatchObject({ action: "created" });
    expect(manualCreated?.trace).toEqual({});

    await runtime.start();
    // auto mode: the event carries the active epoch.
    const auto = await dispatch(runtime, { kind: "event", argv: ["send", "--message", "live message"] }) as { event: PoolEvent };
    expect(auto.event).toMatchObject({ status: "pending", epoch: runtime.status().epoch });
    expect(runtime.status().eventPool).toEqual({ pendingInbound: 2, pendingOutbound: 0, latestSeq: 2 });

    // Default outbound emission stays asynchronous.
    const asyncEmit = await runtime.emitOutboundEvent({ kind: "notice", text: "progress note" });
    expect(asyncEmit.paused).toBe(false);
    expect(asyncEmit.status.mode).toBe("auto");
    expect(runtime.status().eventPool).toEqual({ pendingInbound: 2, pendingOutbound: 1, latestSeq: 3 });

    // A pausing help request releases the device and lands in manual mode.
    const pausedEmit = await runtime.emitOutboundEvent({ kind: "help_request", text: "blocked", pause: true });
    expect(pausedEmit.paused).toBe(true);
    expect(pausedEmit.status).toMatchObject({ mode: "manual", reason: "awaiting human" });
    expect(pausedEmit.status.eventPool).toEqual({ pendingInbound: 2, pendingOutbound: 2, latestSeq: 4 });

    // dispatch rejects agent-epoch Event Pool mutations but allows list.
    await expect(dispatch(runtime, { kind: "event", argv: ["send", "nope"], epoch: "agent-cycle" })).rejects.toThrow("belong to the human");
    await expect(dispatch(runtime, { kind: "event", argv: ["reply", "ev-1-x", "nope"], epoch: "agent-cycle" })).rejects.toThrow("belong to the human");
    await expect(dispatch(runtime, { kind: "event", argv: ["ack", "ev-1-x"], epoch: "agent-cycle" })).rejects.toThrow("belong to the human");
    const listed = await dispatch(runtime, { kind: "event", argv: ["list", "--status", "pending"], epoch: "agent-cycle" }) as { summary: { pendingInbound: number } };
    expect(listed.summary.pendingInbound).toBe(2);
  } finally {
    gate.resolve();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("createLudensExtension injects the Event Pool digest and exposes the event_pool tool", async () => {
  const { directory, workspace } = await initializedWorkspace("ludens-pool-extension-");
  const { runtime, recorded, gate } = poolFixture(workspace);
  try {
    runtime.setPerceptionInjection(false);
    const signal = new AbortController().signal;
    let epoch = "ext-test";
    const extension = createLudensExtension({
      runtime,
      workspace: new Workspace(workspace, join(workspace, "versions")),
      basewareSocket: "/tmp/unused.sock",
      binDir: "/tmp",
      maxRequests: 5,
      cycle: () => ({ epoch, signal }),
    });

    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    extension.factory({ on: (name: string, callback: (...args: unknown[]) => unknown) => handlers.set(name, callback) } as never);
    const beforeAgentStart = handlers.get("before_agent_start")!;
    const tool = extension.tools[1] as unknown as {
      execute(id: string, params: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
    };

    // Nothing pending: no injected message, no bogus observation_context.
    expect(await beforeAgentStart()).toBeUndefined();
    expect(recorded.filter(event => event.type === "observation_context")).toEqual([]);

    // Pending inbound: a compact digest with a truncated preview, still no observation_context.
    const longText = `Please reconsider the whole plan. ${"detail ".repeat(30)}`;
    await runtime.postInboundEvent({ text: longText, title: "Long request" });
    const injected = await beforeAgentStart() as { message: { content: Array<{ type: string; text: string }> } };
    expect(injected.message.content).toHaveLength(1);
    const digest = JSON.parse(injected.message.content[0].text).eventPool;
    expect(digest.pendingInbound).toBe(1);
    expect(digest.items[0]).toMatchObject({ kind: "message", title: "Long request", truncated: true });
    expect(digest.items[0].preview.length).toBeLessThanOrEqual(72);
    expect(digest.items[0].preview.endsWith("…")).toBe(true);
    expect(digest.hint).toContain("event_pool");
    expect(recorded.filter(event => event.type === "observation_context")).toEqual([]);

    // The event_pool tool: read acknowledges by default.
    const readResult = await tool.execute("call-read", { action: "read" });
    const readPayload = JSON.parse((readResult.content as Array<{ text: string }>)[0].text);
    expect(readPayload).toMatchObject({ ok: true, action: "read" });
    expect(readPayload.events).toHaveLength(1);
    expect(readPayload.acknowledgedIds).toEqual(readPayload.events.map((event: PoolEvent) => event.id));
    expect(readPayload.summary.pendingInbound).toBe(0);

    // ack marks explicit inbound ids handled by shiori; missing ids fail cleanly.
    const toAck = await runtime.postInboundEvent({ text: "ack me" });
    const ackResult = await tool.execute("call-ack", { action: "ack", ids: [toAck.event.id] });
    const ackPayload = JSON.parse((ackResult.content as Array<{ text: string }>)[0].text);
    expect(ackPayload).toMatchObject({ ok: true, action: "ack", updatedIds: [toAck.event.id] });
    expect(ackPayload.summary.pendingInbound).toBe(0);
    const ackMissing = await tool.execute("call-ack-bad", { action: "ack", ids: [] });
    expect(JSON.parse((ackMissing.content as Array<{ text: string }>)[0].text)).toMatchObject({ ok: false });

    // emit with pause hands control back from an active cycle.
    epoch = "ext-pause";
    await runtime.start();
    const emitResult = await tool.execute("call-emit", { action: "emit", kind: "help_request", text: "stuck", pause: true });
    const emitPayload = JSON.parse((emitResult.content as Array<{ text: string }>)[0].text);
    expect(emitPayload).toMatchObject({ ok: true, action: "emit", paused: true });
    expect(emitPayload.event).toMatchObject({ direction: "outbound", kind: "help_request", status: "pending" });
    expect(runtime.status()).toMatchObject({ mode: "manual", reason: "awaiting human" });
  } finally {
    gate.resolve();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});


test("eventCommand serves the live host socket and falls back to the file store", async () => {
  const { directory, workspace } = await initializedWorkspace("ludens-pool-cli-");
  const { runtime, gate } = poolFixture(workspace);
  const { socket } = await resolveWorkspaceAddress(workspace);
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => { logs.push(line); };
  try {
    delete process.env.BASEWARE_EPOCH;
    const stop = await listen(socket, runtime);
    await eventCommand(["send", "--title", "Hello", "--message", "from the CLI"], workspace, socket);
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({ hostOnline: true, event: { title: "Hello", text: "from the CLI", status: "pending" } });
    await stop();

    // Socket offline: mutations persist into .ludens/event-pool.json.
    await eventCommand(["send", "offline message"], workspace, socket);
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({ hostOnline: false, event: { text: "offline message", status: "pending" } });
    await eventCommand(["list", "--status", "pending"], workspace, socket);
    const listed = JSON.parse(logs.at(-1)!);
    expect(listed).toMatchObject({ hostOnline: false });
    expect(listed.summary.pendingInbound).toBe(2);
    expect(listed.events.map((event: PoolEvent) => event.text)).toEqual(["from the CLI", "offline message"]);
    expect(await stat(join(workspace, ".ludens", "event-pool.json")).then(file => file.isFile()).catch(() => false)).toBe(true);
  } finally {
    console.log = originalLog;
    gate.resolve();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("readWorkspaceEventPool and mutateWorkspaceEventPool bridge online and offline hosts", async () => {
  const { directory, workspace, identity } = await initializedWorkspace("ludens-pool-query-");
  const home = join(directory, "home");
  const { runtime, pool, gate } = poolFixture(workspace);
  try {
    await mkdir(join(home, "registry"), { recursive: true });
    await writeFile(join(home, "registry", `${identity.id}.json`),
      JSON.stringify({ id: identity.id, workspace, name: "test", updatedAt: new Date().toISOString() }));
    const { socket } = await resolveWorkspaceAddress(workspace);

    // Offline read falls back to the persisted pool.
    const offlineRead = await readWorkspaceEventPool(identity.id, workspace, undefined, home);
    expect(offlineRead).toMatchObject({ hostOnline: false });
    expect(offlineRead.snapshot).toEqual({ summary: { pendingInbound: 0, pendingOutbound: 0, latestSeq: 0 }, events: [] });

    // Offline mutations persist without a host.
    const offlineSend = await mutateWorkspaceEventPool(identity.id, workspace, { action: "send", text: "offline send" }, home);
    expect(offlineSend).toMatchObject({ hostOnline: false });
    expect(offlineSend.createdEvent).toMatchObject({ text: "offline send", status: "pending" });
    const outbound = await pool.emitOutbound({ kind: "help_request", text: "stuck offline" });

    // resumeAuto cannot be honored while the host is offline.
    await expect(mutateWorkspaceEventPool(identity.id, workspace, { action: "reply", replyTo: outbound.event.id, text: "resume", resumeAuto: true }, home))
      .rejects.toMatchObject({ code: "HOST_OFFLINE" });

    // Online host: reads and mutations go through the socket.
    const stop = await listen(socket, runtime);
    const onlineRead = await readWorkspaceEventPool(identity.id, workspace, undefined, home);
    expect(onlineRead).toMatchObject({ hostOnline: true });
    expect(onlineRead.snapshot.summary).toEqual({ pendingInbound: 1, pendingOutbound: 1, latestSeq: 2 });
    expect(onlineRead.hostStatus).toMatchObject({ mode: "manual" });

    const onlineSend = await mutateWorkspaceEventPool(identity.id, workspace, { action: "send", text: "online send", title: "Live" }, home);
    expect(onlineSend).toMatchObject({ hostOnline: true });
    expect(onlineSend.createdEvent).toMatchObject({ text: "online send", status: "pending" });

    // reply with resumeAuto restarts the auto loop on the online host.
    const reply = await mutateWorkspaceEventPool(identity.id, workspace, { action: "reply", replyTo: outbound.event.id, text: "here you go", resumeAuto: true }, home);
    expect(reply).toMatchObject({ hostOnline: true });
    expect(reply.createdEvent).toMatchObject({ kind: "reply", status: "pending" });
    expect(reply.resolvedOutbound).toMatchObject({ id: outbound.event.id, status: "handled", handledBy: "human" });
    expect(reply.hostStatus).toMatchObject({ mode: "auto" });
    expect(reply.snapshot.summary.pendingOutbound).toBe(0);

    // ack works online too.
    const acked = await mutateWorkspaceEventPool(identity.id, workspace, { action: "ack", ids: [onlineSend.createdEvent!.id] }, home);
    expect(acked).toMatchObject({ hostOnline: true });
    expect(acked.updatedEvents).toHaveLength(1);
    expect(acked.updatedEvents![0]).toMatchObject({ status: "handled", handledBy: "human" });
    await stop();

    // After the host leaves, reads fall back to the persisted file again.
    const afterOffline = await readWorkspaceEventPool(identity.id, workspace, undefined, home);
    expect(afterOffline).toMatchObject({ hostOnline: false });
    expect(afterOffline.snapshot.summary.pendingOutbound).toBe(0);
  } finally {
    gate.resolve();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("pool_event activity projection renders inbound, outbound and handled blocks", async () => {
  const poolEvent = (seq: number, data: Record<string, unknown>): Event => ({
    seq, at: new Date(2026, 0, 2, 0, 0, seq).toISOString(), atMs: seq, type: "pool_event",
    trace: {}, data,
  });
  const inboundEvent = { id: "ev-1-a", seq: 1, direction: "inbound", kind: "message", status: "pending", text: "please continue" };
  const outboundEvent = { id: "ev-2-b", seq: 2, direction: "outbound", kind: "help_request", status: "pending", text: "need a decision" };
  const blocks = await activityBlocks("runs/test-run/events.jsonl", [
    poolEvent(1, { action: "created", event: inboundEvent }),
    poolEvent(2, { action: "created", event: outboundEvent }),
    poolEvent(3, { action: "handled", actor: "human", ids: ["ev-2-b"], events: [outboundEvent] }),
  ]);
  expect(blocks.map(block => [block.kind, block.title, block.text])).toEqual([
    ["text", "Event", "please continue"],
    ["text", "Help Request", "need a decision"],
    ["system", "pool_receipt", "Human handled #2"],
  ]);
  expect(blocks[0].data).toMatchObject({ role: "user", mode: "event", text: "please continue" });
  expect(blocks[1].data).toMatchObject({ role: "shiori_event", mode: "help_request", text: "need a decision" });
  expect(blocks[2].data).toMatchObject({ role: "pool_receipt", action: "handled", actor: "human", ids: ["ev-2-b"] });
});

test("pool receipts project shiori read and human withdrawal alongside send blocks", async () => {
  const poolEvent = (seq: number, data: Record<string, unknown>): Event => ({
    seq, at: new Date(2026, 0, 2, 0, 0, seq).toISOString(), atMs: seq, type: "pool_event", trace: {}, data,
  });
  const inbound = { id: "ev-12-a", seq: 12, direction: "inbound", kind: "message", status: "handled", text: "check the shop", title: "Shop" };
  const withdrawn = { id: "ev-13-b", seq: 13, direction: "inbound", kind: "message", status: "handled", handledBy: "human", text: "never mind" };
  const blocks = await activityBlocks("runs/test-run/events.jsonl", [
    poolEvent(1, { action: "created", event: inbound }),
    poolEvent(2, { action: "created", event: withdrawn }),
    poolEvent(3, { action: "handled", actor: "shiori", ids: [inbound.id], events: [inbound] }),
    poolEvent(4, { action: "handled", actor: "human", ids: [withdrawn.id], events: [withdrawn] }),
  ]);
  const receipts = blocks.filter(block => block.title === "pool_receipt");
  expect(receipts.map(block => [block.kind, block.status, block.text])).toEqual([
    ["system", "complete", "Shiori read #12: Shop"],
    ["system", "complete", "Human withdrew #13"],
  ]);
  expect(receipts[0].data).toMatchObject({ role: "pool_receipt", action: "handled", actor: "shiori", ids: ["ev-12-a"] });
  expect(receipts[1].data).toMatchObject({ role: "pool_receipt", actor: "human", events: [withdrawn] });
  expect(blocks.map(block => block.at)).toEqual([...blocks.map(block => block.at)].sort());
});

test("human withdrawal of an unread pending inbound event marks it handled by human", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ludens-pool-withdraw-"));
  try {
    const pool = new WorkspaceEventPool(directory);
    const { event } = await pool.postInbound({ text: "oops", runId: null, epoch: null });
    const acked = await pool.ack([event.id], "human", "inbound", "2026-01-02T00:00:00.000Z");
    expect(acked.updated[0]).toMatchObject({ id: event.id, status: "handled", handledBy: "human", handledAt: "2026-01-02T00:00:00.000Z" });
    const snapshot = await pool.snapshot();
    expect(snapshot.summary.pendingInbound).toBe(0);
    expect(snapshot.events.find(item => item.id === event.id)).toMatchObject({ status: "handled", handledBy: "human" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
