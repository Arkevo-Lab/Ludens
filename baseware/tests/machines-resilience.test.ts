import { afterEach, expect, test } from "bun:test";
import { BasewareCore, type MountedMachineEntry } from "../src/core.ts";
import type { Capabilities, ToolExecutionResult } from "../src/contracts.ts";
import type { DeviceEvent } from "../src/protocol.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

interface MachineHarness {
  acquired: number;
  released: number;
  calls: string[];
}

function machineHarness(machine: string): { harness: MachineHarness; entry: MountedMachineEntry } {
  const harness: MachineHarness = { acquired: 0, released: 0, calls: [] };
  const capabilities: Capabilities = { controllers: [{
    tool: { name: "pad.play", inputSchema: { type: "object", additionalProperties: false } }, requiresControl: true,
    async acquire() { harness.acquired++; },
    async release() { harness.released++; },
    async execute(): Promise<ToolExecutionResult> {
      harness.calls.push(machine);
      return { result: { content: [{ type: "text", text: machine }] }, id: crypto.randomUUID(), status: "completed",
        exitCode: 0, stdout: machine, stderr: "", timing: { clock: "device", requestedAtMs: 0, receivedAtMs: 1 } };
    } }] };
  return { harness, entry: { id: machine, label: machine, driver: "fake", transport: "bridge",
    connected: true, reason: "connected", isPrimary: false, capabilities,
    drivers: [{ id: `fake-${machine}`, version: "1" }] } };
}

interface Fixture {
  core: BasewareCore;
  events: DeviceEvent[];
  m1: MachineHarness;
  m2: MachineHarness;
  epoch: string;
}

async function twoMachines(): Promise<Fixture> {
  const events: DeviceEvent[] = [];
  const primary = machineHarness("m1");
  primary.entry.isPrimary = true;
  const secondary = machineHarness("m2");
  const core: BasewareCore = new BasewareCore({ capabilities: primary.entry.capabilities, activeMachineId: "m1",
    drivers: primary.entry.drivers, diagnostics: "full",
    onReconnect: async (): Promise<boolean> => { core.reconnected(); return true; },
    onMachines: async (action, { id }): Promise<unknown> => {
      if (action === "use" && id) core.setPrimaryMachine(id);
      return { activeMachineId: core.status().activeMachineId ?? null, machines: core.getMountedMachines() };
    },
    record: (type, data, trace = {}, metadata) => events.push({ type, data, trace, ...metadata, source: metadata!.source!, origin: metadata!.origin! }) });
  core.mountMachine(primary.entry);
  core.mountMachine(secondary.entry);
  cleanup.push(() => core.close());
  return { core, events, m1: primary.harness, m2: secondary.harness, epoch: crypto.randomUUID() };
}

const client = { id: "test" };

test("mounted machines expose prefixed controllers, route execution and acquire each device once", async () => {
  const f = await twoMachines();
  const names = f.core.list().controllers.map(c => c.name);
  expect(names).toContain("pad.play");
  expect(names).toContain("m1/pad.play");
  expect(names).toContain("m2/pad.play");
  expect(f.core.list().controllers.find(c => c.name === "m2/pad.play")).toMatchObject({ machineId: "m2" });
  await f.core.acquire(f.epoch, 30, client);
  // The primary is registered twice (unprefixed plus m1/ alias) but owns one physical pad.
  expect(f.m1.acquired).toBe(1);
  expect(f.m2.acquired).toBe(1);
  expect(f.core.list().activeMachineId).toBe("m1");
  expect(f.core.status().machines.map(m => m.id)).toEqual(["m1", "m2"]);
  const prefixed = await f.core.execute("m2/pad.play", {}, f.epoch, new AbortController().signal);
  expect(prefixed.stdout).toBe("m2");
  const routed = await f.core.execute("pad.play", {}, f.epoch, new AbortController().signal, {}, crypto.randomUUID(), "cli", { machine: "m2" });
  expect(routed.stdout).toBe("m2");
  const primary = await f.core.execute("pad.play", {}, f.epoch, new AbortController().signal);
  expect(primary.stdout).toBe("m1");
  await f.core.release(f.epoch);
  expect(f.m1.released).toBe(1);
  expect(f.m2.released).toBe(1);
});

test("switching the primary machine reroutes unprefixed controllers", async () => {
  const f = await twoMachines();
  f.core.setPrimaryMachine("m2");
  await f.core.acquire(f.epoch, 30, client);
  expect(await f.core.execute("pad.play", {}, f.epoch, new AbortController().signal)).toMatchObject({ stdout: "m2" });
  expect(f.core.list().controllers.map(c => c.name)).toContain("m2/pad.play");
  expect(f.core.list().controllers.map(c => c.name)).toContain("m1/pad.play");
  expect(f.core.status().activeMachineId).toBe("m2");
  await f.core.release(f.epoch);
  const viaRpc = await f.core.handle({ kind: "machines", action: "use", id: "m1" }, client);
  expect(viaRpc).toMatchObject({ activeMachineId: "m1" });
  expect(f.core.status().activeMachineId).toBe("m1");
  await f.core.acquire(f.epoch, 30, client);
  expect(await f.core.execute("pad.play", {}, f.epoch, new AbortController().signal)).toMatchObject({ stdout: "m1" });
  await f.core.release(f.epoch);
});

test("disconnect marks the service down and reconnect restores it with an event", async () => {
  const f = await twoMachines();
  await f.core.disconnected(new Error("bridge lost"));
  expect(f.core.status().connected).toBe(false);
  expect(f.core.status().machines.find(m => m.id === "m1")).toMatchObject({ connected: false, reason: "bridge lost" });
  const reconnected = await f.core.handle({ kind: "reconnect" }, client, new AbortController().signal) as ReturnType<BasewareCore["status"]>;
  expect(reconnected.connected).toBe(true);
  expect(reconnected.reason).toBe("reconnected");
  expect(f.events.some(event => event.type === "baseware_reconnected")).toBe(true);
  expect(f.events.some(event => event.type === "baseware_disconnected")).toBe(true);
  expect(f.core.status().machines.find(m => m.id === "m1")?.connected).toBe(true);
});
