import { expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime, type AgentRunner } from "../src/core/shiori/runtime.ts";
import { createTestDeviceSession } from "./runtime-fixture.ts";
import { dispatch, listen, send } from "../src/daemon/transport.ts";
import { activityBlocks } from "../src/core/query/activity.ts";
import { controlWorkspaceRuntime, type HostControlStatus, type RuntimeControlCommand } from "../src/core/query/runtime-control.ts";
import { ensureWorkspaceIdentity } from "@ludens/protocol/ludens";
import type { Event } from "../src/core/query/types.ts";
import { resolveWorkspaceAddress } from "../src/core/storage/workspace-state.ts";

function steerFixture() {
  const recorded: Array<{ type: string; data: unknown; trace?: unknown }> = [];
  const steered: string[] = [], followedUp: string[] = [];
  const gate = Promise.withResolvers<void>();
  const agent: AgentRunner = {
    async run() { await gate.promise; },
    async consolidate() {},
    async steer(message) { steered.push(message); },
    async followUp(message) { followedUp.push(message); },
    queueState: () => ({ steering: steered.length, followUp: followedUp.length }),
    abort: async () => { gate.resolve(); },
    close: async () => {},
  };
  const { devices } = createTestDeviceSession({ controllers: [] }, () => {});
  const runtime = new Runtime(devices, (type, data, trace) => recorded.push({ type, data, trace }));
  runtime.attach({ agent });
  return { runtime, recorded, steered, followedUp, gate };
}

const userEvent = (seq: number, text: string, mode?: string): Event => ({
  seq, at: new Date(2026, 0, 1, 0, 0, seq).toISOString(), atMs: seq, type: "user_message",
  trace: {}, data: mode === undefined ? { text } : { text, mode },
});

test("Runtime.steer queues guidance only inside an active auto cycle", async () => {
  const { runtime, recorded, steered, followedUp, gate } = steerFixture();
  try {
    await expect(runtime.steer("  ")).rejects.toThrow("Message cannot be empty");
    await expect(runtime.steer("turn left")).rejects.toThrow("Auto loop is not active");
    await runtime.start("initial goal");
    await runtime.steer("turn left");
    const status = await runtime.steer("then stop", "follow_up");
    expect(steered).toEqual(["turn left"]);
    expect(followedUp).toEqual(["then stop"]);
    expect(status).toMatchObject({ mode: "auto", queue: { steering: 1, followUp: 1 } });
    expect(recorded.filter(event => event.type === "user_message")).toEqual([
      { type: "user_message", data: { text: "initial goal", mode: "start" }, trace: { epoch: expect.any(String) } },
      { type: "user_message", data: { text: "turn left", mode: "steer" }, trace: { epoch: expect.any(String) } },
      { type: "user_message", data: { text: "then stop", mode: "follow_up" }, trace: { epoch: expect.any(String) } },
    ]);
  } finally { gate.resolve(); await runtime.close(); }
});

test("Runtime.steer rejects agents without live steering support", async () => {
  const gate = Promise.withResolvers<void>();
  const agent: AgentRunner = { async run() { await gate.promise; }, async consolidate() {}, abort: async () => {}, close: async () => {} };
  const { devices } = createTestDeviceSession({ controllers: [] }, () => {});
  const runtime = new Runtime(devices, () => {});
  runtime.attach({ agent });
  try {
    await runtime.start();
    await expect(runtime.steer("hello")).rejects.toThrow("Agent does not support live steering");
    const status = runtime.status();
    expect(status.queue).toEqual({ steering: 0, followUp: 0 });
  } finally { gate.resolve(); await runtime.close(); }
});

test("transport steer stays a human-only, stale-checked command", async () => {
  const { runtime, steered, gate } = steerFixture();
  try {
    const request = { kind: "steer" as const, argv: ["--message", "turn left"] };
    await expect(dispatch(runtime, { ...request, epoch: "agent-cycle" })).rejects.toThrow("human");
    await expect(dispatch(runtime, { ...request, runId: "stale" })).rejects.toThrow("STALE_RUN");
    await expect(dispatch(runtime, { ...request, expectedEpoch: "old" })).rejects.toThrow("STALE_EPOCH");
    await expect(dispatch(runtime, { kind: "steer", argv: [] })).rejects.toThrow("Usage: ludens steer");
    await expect(dispatch(runtime, request)).rejects.toThrow("Auto loop is not active");
    await runtime.start();
    const status = await dispatch(runtime, { kind: "steer", argv: ["--follow-up", "--message", "then stop"], runId: runtime.status().runId, expectedEpoch: runtime.status().epoch }) as HostControlStatus;
    expect(steered).toEqual([]);
    expect(status.queue).toEqual({ steering: 0, followUp: 1 });
    await dispatch(runtime, { kind: "steer", argv: ["turn left"] });
    expect(steered).toEqual(["turn left"]);
  } finally { gate.resolve(); await runtime.close(); }
});

test("user_message events project as readable user text blocks", async () => {
  const blocks = await activityBlocks("runs/test-run/events.jsonl", [
    userEvent(1, "initial goal"),
    userEvent(2, "turn left", "steer"),
    userEvent(3, "later", "follow_up"),
  ]);
  expect(blocks.map(block => [block.kind, block.title, block.text, block.data])).toEqual([
    ["text", "User", "initial goal", { role: "user", mode: "start", text: "initial goal" }],
    ["text", "Steer", "turn left", { role: "user", mode: "steer", text: "turn left" }],
    ["text", "Follow-up", "later", { role: "user", mode: "follow_up", text: "later" }],
  ]);
});

test("controlWorkspaceRuntime validates scope and steers the live host", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ludens-runtime-control-"));
  const home = join(directory, "home");
  const workspace = join(directory, "workspace");
  const { runtime, steered, gate } = steerFixture();
  try {
    await mkdir(join(home, "registry"), { recursive: true });
    await mkdir(workspace, { recursive: true });
    const identity = await ensureWorkspaceIdentity(workspace);
    const canonical = await realpath(workspace);
    await writeFile(join(home, "registry", `${identity.id}.json`),
      JSON.stringify({ id: identity.id, workspace: canonical, name: "test", updatedAt: new Date().toISOString() }));
    const { socket } = await resolveWorkspaceAddress(workspace);
    const stop = await listen(socket, runtime);
    const idle = await controlWorkspaceRuntime(identity.id, canonical, { action: "status" }, home);
    expect(idle).toMatchObject({ runId: runtime.status().runId, mode: "manual" });
    await expect(controlWorkspaceRuntime(identity.id, join(directory, "elsewhere"), { action: "status" }, home)).rejects.toThrow("工作区登记目录已变化");

    await send(socket, { kind: "auto", argv: ["on"], runId: runtime.status().runId, expectedEpoch: null });
    const command: RuntimeControlCommand = { action: "steer", message: "turn left", delivery: "follow_up" };
    const status = await controlWorkspaceRuntime(identity.id, canonical, command, home);
    expect(steered).toEqual([]);
    expect(status).toMatchObject({ mode: "auto", queue: { steering: 0, followUp: 1 } });
    const off = await controlWorkspaceRuntime(identity.id, canonical, { action: "auto_off" }, home);
    expect(off).toMatchObject({ mode: "manual" });
    const injectOff = await controlWorkspaceRuntime(identity.id, canonical, { action: "perception_inject", enabled: false }, home);
    expect(injectOff).toMatchObject({ context: { perceptionInjection: false } });
    const injectOn = await controlWorkspaceRuntime(identity.id, canonical, { action: "perception_inject", enabled: true }, home);
    expect(injectOn).toMatchObject({ context: { perceptionInjection: true } });
    await stop();
    await expect(controlWorkspaceRuntime(identity.id, canonical, { action: "status" }, home)).rejects.toThrow("当前工作区宿主未在线");
  } finally { gate.resolve(); await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});
