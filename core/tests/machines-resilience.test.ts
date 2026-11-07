import { expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Catalog, DeviceEvent, Request } from "@ludens/baseware/protocol";
import { connectBaseware } from "../src/core/subsystems/baseware.ts";
import { Runtime } from "../src/core/shiori/runtime.ts";
import { WorkspaceController } from "../src/core/subsystems/controller.ts";
import type { RecordEvent } from "../src/core/storage/events.ts";

async function until(check: () => boolean) {
  // This integration fixture exercises the configured real reconnect delay over a live socket.
  const deadline = performance.now() + 3000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("Condition did not become true");
    await Bun.sleep(5);
  }
}

async function fixture(reconnectAttempts: number, reconnectSucceedsOn = 0) {
  const directory = await mkdtemp(join(tmpdir(), "ludens-machines-resilience-"));
  const socketPath = join(directory, "baseware.sock");
  const events: { type: string; data: unknown }[] = [];
  const record: RecordEvent = (type, data) => events.push({ type, data });
  const machineCalls: { action?: string; id?: string; ids?: string[] }[] = [];
  const controllerCalls: { id?: string; machine?: string }[] = [];
  const catalog: Catalog = {
    drivers: [],
    controllers: [{ name: "pad.play", description: "play", inputSchema: { type: "object" }, requiresControl: true }],
    machines: [], activeMachineId: "gba-mgba",
  };
  let connected = true;
  let mode = "manual";
  let epoch: string | null = null;
  let reconnects = 0;
  let sequence = 0;
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const envelope = JSON.parse(buffer.slice(0, end)) as { id: string; request: Request };
        buffer = buffer.slice(end + 1);
        const { id, request } = envelope;
        let value: unknown = null;
        switch (request.kind) {
          case "list": value = JSON.parse(JSON.stringify(catalog)); break;
          case "status": value = { mode, epoch, connected, remainingSeconds: mode === "auto" ? 60 : null }; break;
          case "acquire": mode = "auto"; epoch = request.epoch!; value = { mode, epoch, connected, remainingSeconds: 60 }; break;
          case "release": mode = "manual"; epoch = null; value = { mode, epoch, connected, remainingSeconds: null }; break;
          case "reconnect":
            reconnects++;
            if (reconnectSucceedsOn === reconnects) connected = true;
            value = { connected };
            break;
          case "machines":
            machineCalls.push({ action: request.action, id: request.id, ids: request.ids });
            if (request.action === "use") catalog.activeMachineId = request.id;
            if (request.action === "connect") {
              catalog.controllers = request.ids!.map(machineId => ({
                name: `${machineId}/pad.play`, description: "play", inputSchema: { type: "object" }, requiresControl: true, machineId,
              }));
              catalog.machines = request.ids!.map(id => ({ id, label: id, driver: "fake", transport: "fake", connected: true,
                reason: "connected", isPrimary: id === request.ids![0], controllers: [`${id}/pad.play`] }));
            }
            value = { action: request.action, connected: request.ids ?? (request.id ? [request.id] : []) };
            break;
          case "controller":
            controllerCalls.push({ id: request.id, machine: request.machine });
            value = { id: crypto.randomUUID(), status: "completed", exitCode: 0, stdout: "", stderr: "",
              result: { content: [{ type: "text", text: request.id }] },
              timing: { clock: "fake", requestedAtMs: 1, receivedAtMs: 2 } };
            break;
          default: break;
        }
        socket.write(JSON.stringify({ id, ok: true, value }) + "\n");
      }
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(socketPath, listening.resolve);
  await listening.promise;
  const devices = await connectBaseware({ socket: socketPath, seconds: 60, runDir: join(directory, "run"), record,
    reconnectAttempts, reconnectDelayMs: 10 });
  const runtime = new Runtime(devices, record, 60);
  runtime.attach({ controller: new WorkspaceController({ workspace: directory, devices, env: {}, record }) });
  devices.onDisconnect(error => { void runtime.disconnected(error); });
  const emit = (type: string, data: unknown) => {
    const event: DeviceEvent = { type, data, trace: {}, source: { component: "baseware" },
      origin: { eventId: crypto.randomUUID(), clockId: "fake", seq: ++sequence, at: new Date().toISOString(), atMs: Date.now() } };
    for (const socket of sockets) socket.write(JSON.stringify({ event }) + "\n");
  };
  return {
    events, machineCalls, controllerCalls, devices, runtime,
    disconnect(message: string) { connected = false; emit("baseware_disconnected", message); },
    reconnect() { connected = true; emit("baseware_reconnected", {}); },
    async close() {
      await runtime.close();
      devices.close();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("device disconnect retries three times then pauses autonomous control", async () => {
  const f = await fixture(3);
  try {
    await f.runtime.start();
    f.disconnect("device lost");
    await until(() => !f.runtime.status().connected && f.runtime.status().mode === "manual");
    expect(f.events.filter(event => event.type === "device_disconnected")).toEqual([
      { type: "device_disconnected", data: { reason: "device lost" } },
    ]);
    expect(f.events.filter(event => event.type === "device_reconnect_attempt").map(event => event.data)).toEqual([
      { attempt: 1, maxAttempts: 3 }, { attempt: 2, maxAttempts: 3 }, { attempt: 3, maxAttempts: 3 },
    ]);
    expect(f.events.find(event => event.type === "device_reconnect_failed")?.data).toEqual({ attempts: 3, error: "device lost" });
    expect(f.events.find(event => event.type === "device_paused")?.data).toMatchObject({ previousMode: "auto" });
    expect(f.runtime.status()).toMatchObject({ mode: "manual", connected: false });
  } finally { await f.close(); }
});

test("successful second reconnect attempt preserves autonomous control", async () => {
  const f = await fixture(3, 2);
  try {
    await f.runtime.start();
    f.disconnect("temporary loss");
    await until(() => f.events.some(event => event.type === "device_reconnected"));
    expect(f.events.find(event => event.type === "device_reconnected")?.data).toEqual({ attempt: 2, source: "reconnect_loop" });
    expect(f.events.filter(event => event.type === "device_reconnect_attempt")).toHaveLength(2);
    expect(f.events.some(event => event.type === "device_paused")).toBe(false);
    expect(f.runtime.status()).toMatchObject({ mode: "auto", connected: true });
  } finally { await f.close(); }
});

test("baseware_reconnected restores a paused runtime", async () => {
  const f = await fixture(1);
  try {
    await f.runtime.start();
    f.disconnect("restart required");
    await until(() => !f.runtime.status().connected && f.runtime.status().mode === "manual");
    f.reconnect();
    await until(() => f.runtime.status().connected);
    expect(f.events.find(event => event.type === "device_reconnected")?.data).toEqual({ source: "baseware_event" });
    expect(f.runtime.status()).toMatchObject({ mode: "manual", connected: true, reason: "reconnected" });
  } finally { await f.close(); }
});

test("machine selection and multi-connection refresh catalog and route both controllers", async () => {
  const f = await fixture(0);
  try {
    const { epoch } = await f.runtime.start();
    await f.runtime.manageMachines("use", { id: "gba-mgba-2" });
    expect(f.devices.catalog.activeMachineId).toBe("gba-mgba-2");
    await f.runtime.manageMachines("connect", { ids: ["gba-mgba", "gba-mgba-2"] });
    expect(f.machineCalls).toEqual([
      { action: "use", id: "gba-mgba-2", ids: undefined },
      { action: "connect", id: undefined, ids: ["gba-mgba", "gba-mgba-2"] },
    ]);
    expect(f.devices.catalog.controllers.map(controller => controller.name)).toEqual(["gba-mgba/pad.play", "gba-mgba-2/pad.play"]);
    await f.runtime.callController("controller/gba-mgba/pad.play", {}, epoch!, new AbortController().signal);
    await f.runtime.callController("controller/gba-mgba-2/pad.play", {}, epoch!, new AbortController().signal);
    expect(f.controllerCalls).toEqual([
      { id: "gba-mgba/pad.play", machine: "gba-mgba" },
      { id: "gba-mgba-2/pad.play", machine: "gba-mgba-2" },
    ]);
  } finally { await f.close(); }
});
