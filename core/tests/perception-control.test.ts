import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BasewareCore } from "@ludens/baseware/core";
import { listen as listenDevice } from "@ludens/baseware/server";
import { connectBaseware } from "../src/core/subsystems/baseware.ts";
import { createHostRuntime } from "../src/core/shiori/host.ts";
import { EventLog } from "../src/core/storage/events.ts";
import { initializeWorkspaceState } from "../src/core/storage/workspace-state.ts";
import { listen, send } from "../src/daemon/transport.ts";

test("unified resident effects rotate real Baseware authority, reset inputs, and survive host control cycles", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ludens-perception-control-")));
  const state = await initializeWorkspaceState(join(root, "workspace"), join(root, "home"));
  const workspace = join(root, "workspace"), runDir = join(workspace, "logs", "control");
  const socket = `/tmp/ludens-perception-${crypto.randomUUID()}.sock`;
  const deviceSocket = `/tmp/ludens-device-${crypto.randomUUID()}.sock`;
  const log = new EventLog(runDir, { id: "control", now: () => performance.now() }, workspace);
  let held = false, calls = 0;
  const core = new BasewareCore({ drivers: [], record: () => {}, capabilities: { controllers: [{
    tool: { name: "hold", inputSchema: { type: "object" } }, requiresControl: true,
    async acquire() {}, async release() { held = false; },
    async execute() {
      held = true; calls++;
      return { id: crypto.randomUUID(), status: "completed", exitCode: 0, stdout: "", stderr: "",
        result: { content: [] }, timing: { clock: "test", requestedAtMs: 0, receivedAtMs: 1 } };
    },
  }] } });
  const closeDevice = await listenDevice(deviceSocket, core);
  const devices = await connectBaseware({ socket: deviceSocket, seconds: 30, runDir, record: log.record });
  const runtime = await createHostRuntime({ devices, workspace, runDir, state, log,
    ludensSocket: socket, basewareSocket: deviceSocket, seconds: 30, maxRequests: 1 });
  const closeHost = await listen(socket, runtime);
  const perception = runtime.perception!;
  const code = `from ludens_tools import capability, record
class Perception:
    def start(self, context): pass
    @record
    @capability
    def sample(self):
        return {"text": "live", "effect": {"id": "controller/hold"}}
    def close(self): pass
`;
  const until = async (check: () => boolean) => {
    const deadline = Date.now() + 4000;
    while (!check() && Date.now() < deadline) await Bun.sleep(10);
    expect(check()).toBe(true);
  };
  try {
    await writeFile(join(workspace, "perception.py"), code);
    await perception.reload();
    await until(() => perception.status().state === "ready");
    expect(calls).toBe(0);
    await runtime.start();
    await until(() => held);
    const epoch = runtime.status().epoch!, old = perception.status().generation!;
    expect(core.status().inputGeneration).toBe(old);
    await writeFile(join(workspace, "perception.py"), code + "\n# rotate\n");
    await perception.observe(new AbortController().signal);
    const fresh = perception.status().generation!;
    expect(fresh).not.toBe(old);
    await until(() => held);
    expect(core.status()).toMatchObject({ epoch, inputGeneration: fresh });
    await expect(send(socket, { kind: "controller", argv: [], action: "call", id: "controller/hold", epoch,
      trace: { inputGeneration: old } })).rejects.toThrow("STALE_INPUT_GENERATION");
    await perception.stop();
    expect(held).toBe(false);
    expect(core.status()).toMatchObject({ mode: "auto", epoch, inputGeneration: null });
    expect(runtime.status()).toMatchObject({ mode: "auto", epoch });
    await perception.reload();
    await until(() => held);
    await runtime.stop("human");
    expect(held).toBe(false);
    expect(core.status()).toMatchObject({ mode: "manual", inputGeneration: null });
    expect((await perception.stateMachine()).epoch).toBeNull();
    const before = calls;
    await Bun.sleep(100);
    expect(calls).toBe(before);
    await runtime.start();
    await until(() => held);
    expect(runtime.status().epoch).not.toBe(epoch);
    expect((await perception.stateMachine()).epoch).toBe(runtime.status().epoch);
  } finally {
    await runtime.close();
    devices.close();
    await closeHost();
    await closeDevice();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
