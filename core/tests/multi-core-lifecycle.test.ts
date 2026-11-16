import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonRpcError, JsonRpcSuccess } from "@ludens/protocol/app-rpc";
import { ensureWorkspaceIdentity, registerWorkspace } from "@ludens/protocol/ludens";
import { openWorkspaceEventPool } from "../src/core/storage/event-pool.ts";
import { clearCatalogCache } from "../src/core/query/data.ts";
import { DashboardWorker } from "../src/core/query/dashboard-worker.ts";
import { PET_AUTO_TARGET, petStatusKey } from "../src/core/query/pet.ts";
import { petState, recordPetConsumer, setPetTarget } from "../src/core/query/pet-state.ts";
import { ludensSocketPath, readBackgroundJobState } from "../src/daemon/background-jobs.ts";
import { resolveWorkspaceDeviceIdentity } from "../src/daemon/device-arbitration.ts";
import type { LaunchIO, LaunchPlan } from "../src/daemon/launcher.ts";
import {
  isPidAlive,
  probeBackgroundJob,
  readJobRecord,
  startBackgroundJob,
  stopBackgroundJob,
} from "../src/daemon/process-manager.ts";
import { DeviceBusyError, WorkspaceSupervisor } from "../src/daemon/supervisor.ts";
import { EventHub } from "../src/server/event-hub.ts";
import { generateMediaTicketSecret } from "../src/server/media-ticket.ts";
import { RpcRouter, type RpcSession } from "../src/server/rpc-router.ts";

const tempRoots: string[] = [];

afterAll(async () => {
  await Promise.all(tempRoots.map(dir => rm(dir, { recursive: true, force: true }).catch(() => {})));
});

async function allocatePort(): Promise<number> {
  return new Promise<number>((resolvePort, rejectPort) => {
    const srv = createServer();
    srv.once("error", rejectPort);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(err => (err ? rejectPort(err) : resolvePort(port)));
    });
  });
}

async function waitForCondition(check: () => boolean | Promise<boolean>, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(30);
  }
  throw new Error(`Condition did not become true within ${timeoutMs}ms`);
}

function tinyBridgeDriverSource() {
  return `
    export default {
      id: "stub-bridge",
      version: "0.0.1",
      transport: "bridge",
      defaultPort: 19999,
      async load() { return {}; }
    };
  `;
}

type RpcReply<T> = { ok: true; result: T } | { ok: false; error: JsonRpcError["error"] };

async function callRpc<T = unknown>(
  session: RpcSession,
  inbox: Map<number, JsonRpcSuccess | JsonRpcError>,
  nextId: { current: number },
  method: string,
  params?: unknown,
): Promise<RpcReply<T>> {
  const id = ++nextId.current;
  await session.handleMessage({ jsonrpc: "2.0", id, method, params });
  const msg = inbox.get(id);
  inbox.delete(id);
  if (!msg) throw new Error(`Missing RPC response for ${method}`);
  if ("error" in msg) {
    return { ok: false, error: msg.error };
  }
  return { ok: true, result: msg.result as T };
}

async function createBridgeWorkspace(
  rootDir: string,
  home: string,
  name: string,
  ludensConfig: Record<string, unknown>,
) {
  const rawWs = join(rootDir, name);
  const driverDir = join(rawWs, "driver");
  await mkdir(driverDir, { recursive: true });
  await writeFile(
    join(driverDir, "package.json"),
    JSON.stringify({ name: "stub-bridge-driver", version: "0.0.1", main: "./driver.js" }),
  );
  await writeFile(join(driverDir, "driver.js"), tinyBridgeDriverSource());
  await writeFile(
    join(driverDir, "driver.json"),
    JSON.stringify({ id: "stub-bridge", version: "0.0.1", transport: "bridge", defaultPort: 19999 }),
  );
  await writeFile(
    join(rawWs, "ludens.json"),
    JSON.stringify({ driver: "stub-bridge", driverPackage: "file:./driver", ...ludensConfig }, null, 2),
  );
  await ensureWorkspaceIdentity(rawWs);
  const workspace = await realpath(rawWs);
  const registration = await registerWorkspace(workspace, home);
  return { workspace, id: registration.id, name: registration.name };
}

/**
 * Tiny real subprocess acting as a Core Unix-socket host (and optional bridge listener).
 * Supports status, auto on/off, event list/send/reply, and clean SIGTERM shutdown.
 */
function hostStubCommand(socketPath: string, runId: string, initialMode: "manual" | "auto", bridgePort?: number) {
  const script = `
    import { createServer } from "node:net";
    import { unlinkSync, mkdirSync } from "node:fs";
    import { dirname } from "node:path";
    const socketPath = ${JSON.stringify(socketPath)};
    const runId = ${JSON.stringify(runId)};
    let mode = ${JSON.stringify(initialMode)};
    const epoch = mode === "auto" ? "ep-1" : null;
    let currentEpoch = epoch;
    const launchedBy = process.env.LUDENS_LAUNCHED_BY === "app" ? "app" : "cli";
    const events = [];
    let seq = 0;
    mkdirSync(dirname(socketPath), { recursive: true });
    try { unlinkSync(socketPath); } catch {}

    let bridgeServer = null;
    ${
      bridgePort
        ? `
      bridgeServer = createServer(() => {});
      bridgeServer.listen(${bridgePort}, "127.0.0.1");
    `
        : ""
    }

    const server = createServer(conn => {
      let buf = "";
      conn.setEncoding("utf8");
      conn.on("data", chunk => {
        buf += chunk;
        const nl = buf.indexOf("\\n");
        if (nl < 0) return;
        const req = JSON.parse(buf.slice(0, nl));
        const status = () => ({
          runId,
          epoch: currentEpoch,
          mode,
          connected: true,
          thinking: false,
          consolidating: false,
          maxSeconds: 1800,
          model: "openai-codex/gpt-6.1-sol",
          launchedBy,
          queue: { steering: 0 },
          eventPool: { pendingInbound: 0, pendingOutbound: events.filter(e => e.direction === "outbound" && e.status === "pending").length, latestSeq: seq },
        });
        let value = status();
        if (req.kind === "auto") {
          if (req.argv?.[0] === "on") {
            mode = "auto";
            currentEpoch = "ep-2";
          } else if (req.argv?.[0] === "off") {
            mode = "manual";
            currentEpoch = null;
          }
          value = status();
        } else if (req.kind === "event") {
          const sub = req.argv?.[0];
          if (sub === "list") {
            value = { summary: status().eventPool, events };
          } else if (sub === "send") {
            seq += 1;
            const ev = { id: "ev-" + seq, seq, direction: "inbound", kind: "message", status: "pending", text: req.argv.at(-1) || "", createdAt: new Date().toISOString() };
            events.push(ev);
            value = { event: ev, status: status() };
          } else if (sub === "reply") {
            seq += 1;
            const ev = { id: "ev-" + seq, seq, direction: "inbound", kind: "reply", replyTo: req.argv?.[1], status: "pending", text: req.argv.at(-1) || "", createdAt: new Date().toISOString() };
            events.push(ev);
            value = { event: ev, status: status() };
          }
        }
        conn.end(JSON.stringify({ ok: true, value }) + "\\n");
      });
    });
    server.listen(socketPath);
    const shutdown = () => {
      try { unlinkSync(socketPath); } catch {}
      try { bridgeServer?.close(); } catch {}
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 150);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  `;
  return [process.execPath, "-e", script];
}

function makeStubSupervisorIO(
  home: string,
  options: {
    initialModeByWorkspace?: Record<string, "manual" | "auto">;
    bindPort?: boolean;
    preparedPorts?: Iterable<number>;
  } = {},
): (plan: LaunchPlan, note: (message: string) => void) => LaunchIO {
  const modeMap = options.initialModeByWorkspace ?? {};
  const preparedPorts = new Set(options.preparedPorts ?? []);
  return (plan, note) => {
    const hash = createHash("sha256").update(plan.workspace).digest("hex").slice(0, 16);
    const hostSocket = ludensSocketPath("core", hash);
    const port =
      plan.activeMachine?.transport.kind === "bridge"
        ? plan.activeMachine.transport.port
        : plan.config.port;
    const hostStatusFromSocket = async (): Promise<{ code: number; stdout: string; stderr: string }> => {
      const probe = await probeBackgroundJob(join(plan.background, "host.job.json"));
      if (!probe.pid) return { code: 1, stdout: "", stderr: "offline" };
      const { send } = await import("../src/daemon/transport.ts");
      try {
        const res = await send(hostSocket, { kind: "status", argv: [] });
        return { code: 0, stdout: JSON.stringify(res), stderr: "" };
      } catch {
        return { code: 1, stdout: "", stderr: "unreachable" };
      }
    };
    const runningPorts = new Set<number>();
    return {
      async run(argv) {
        if (argv[0] === plan.ludens && argv[1] === "status") {
          return hostStatusFromSocket();
        }
        if (argv[0] === plan.ludens && argv[1] === "auto" && argv[2] === "off") {
          const { send } = await import("../src/daemon/transport.ts");
          await send(hostSocket, { kind: "auto", argv: ["off"] }).catch(() => null);
          return { code: 0, stdout: "{}", stderr: "" };
        }
        if (argv[0] === "env" && argv[2] === plan.baseware && argv[3] === "status") {
          const bwProbe = await probeBackgroundJob(join(plan.background, "baseware.job.json"));
          if (!bwProbe.pid) return { code: 1, stdout: "", stderr: "offline" };
          return {
            code: 0,
            stdout: JSON.stringify({ serviceId: "bw-1", mode: "manual", connected: true, epoch: null }),
            stderr: "",
          };
        }
        if (argv[0] === "lsof" && argv[2]?.startsWith("-iTCP:")) {
          const targetPort = Number(argv[2].slice(6));
          if (runningPorts.has(targetPort) || preparedPorts.has(targetPort)) {
            return { code: 0, stdout: `${process.pid}\n`, stderr: "" };
          }
          // Check real listener via TCP probe when stub didn't track it.
          const isOpen = await new Promise<boolean>(resolveOpen => {
            const s = createServer();
            s.once("error", () => resolveOpen(true));
            s.listen(targetPort, "127.0.0.1", () => s.close(() => resolveOpen(false)));
          });
          return isOpen ? { code: 0, stdout: "999999\n", stderr: "" } : { code: 1, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      dashboardReady: async () => false,
      petReady: async () => false,
      sleep: () => Bun.sleep(25),
      now: () => Date.now(),
      note,
      jobStatus: stateFile => probeBackgroundJob(stateFile),
      stopJob: async stateFile => {
        if (port !== undefined) runningPorts.delete(port);
        await stopBackgroundJob(stateFile, { immediate: true });
      },
      startJob: async jobOpts => {
        if (jobOpts.name === "baseware") {
          if (port !== undefined) runningPorts.add(port);
          await startBackgroundJob({
            ...jobOpts,
            command: [process.execPath, "-e", "setInterval(() => {}, 1000);"],
            env: { ...process.env, LUDENS_HOME: home },
          });
          return;
        }
        if (jobOpts.name === "host") {
          const runId = `run-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
          const mode = modeMap[plan.workspace] ?? "manual";
          await startBackgroundJob({
            ...jobOpts,
            command: hostStubCommand(hostSocket, runId, mode, options.bindPort ? port : undefined),
            env: { ...process.env, LUDENS_HOME: home },
          });
          await waitForCondition(async () => {
            const st = await hostStatusFromSocket();
            return st.code === 0;
          }, 4000);
          return;
        }
        await startBackgroundJob({
          ...jobOpts,
          command: [process.execPath, "-e", "setInterval(() => {}, 1000);"],
          env: { ...process.env, LUDENS_HOME: home },
        });
      },
    };
  };
}

test("launchedBy and appInstanceId provenance keeps shutdownAll strictly scoped to this app instance", async () => {
  const rootDir = await realpath(await mkdtemp(join(tmpdir(), "ludens-provenance-")));
  tempRoots.push(rootDir);
  const home = join(rootDir, "home");

  const wsAppOwned = await createBridgeWorkspace(rootDir, home, "ws-app-owned", { port: await allocatePort() });
  const wsOtherApp = await createBridgeWorkspace(rootDir, home, "ws-other-app", { port: await allocatePort() });
  const wsCli = await createBridgeWorkspace(rootDir, home, "ws-cli", { port: await allocatePort() });

  const supervisor = new WorkspaceSupervisor({ home });

  const appOwnedJob = await startBackgroundJob({
    name: "host",
    command: [process.execPath, "-e", "setInterval(() => {}, 1000);"],
    cwd: wsAppOwned.workspace,
    env: { ...process.env, LUDENS_HOME: home },
    launchedBy: "app",
    appInstanceId: supervisor.instanceId,
  });
  const otherAppJob = await startBackgroundJob({
    name: "host",
    command: [process.execPath, "-e", "setInterval(() => {}, 1000);"],
    cwd: wsOtherApp.workspace,
    env: { ...process.env, LUDENS_HOME: home },
    launchedBy: "app",
    appInstanceId: "other-app-instance-id",
  });
  const cliJob = await startBackgroundJob({
    name: "host",
    command: [process.execPath, "-e", "setInterval(() => {}, 1000);"],
    cwd: wsCli.workspace,
    env: { ...process.env, LUDENS_HOME: home },
  });

  try {
    expect(await readJobRecord(appOwnedJob.stateFile)).toMatchObject({
      launchedBy: "app",
      appInstanceId: supervisor.instanceId,
    });
    expect(await readJobRecord(cliJob.stateFile)).toMatchObject({
      launchedBy: "cli",
    });
    const cliStatus = await readBackgroundJobState(cliJob.stateFile, "host");
    expect(cliStatus.launchedBy).toBe("cli");

    // Even if all three are registered with trackOwnedService, shutdownAll only stops its own appInstanceId.
    await supervisor.trackOwnedService(wsAppOwned.workspace, "host", wsAppOwned.id);
    await supervisor.trackOwnedService(wsOtherApp.workspace, "host", wsOtherApp.id);
    await supervisor.trackOwnedService(wsCli.workspace, "host", wsCli.id);

    await supervisor.shutdownAll({ emergency: true });
    await waitForCondition(() => !isPidAlive(appOwnedJob.pid));

    expect((await probeBackgroundJob(appOwnedJob.stateFile)).registered).toBe(false);
    expect(isPidAlive(otherAppJob.pid)).toBe(true);
    expect(isPidAlive(cliJob.pid)).toBe(true);
  } finally {
    await stopBackgroundJob(appOwnedJob.stateFile, { immediate: true }).catch(() => {});
    await stopBackgroundJob(otherAppJob.stateFile, { immediate: true }).catch(() => {});
    await stopBackgroundJob(cliJob.stateFile, { immediate: true }).catch(() => {});
  }
});

test("resolveWorkspaceDeviceIdentity distinguishes devices while normalizing shared local targets", async () => {
  const rootDir = await realpath(await mkdtemp(join(tmpdir(), "ludens-device-key-")));
  tempRoots.push(rootDir);
  const home = join(rootDir, "home");

  const wsBridge1 = await createBridgeWorkspace(rootDir, home, "bridge-1", { port: 19001 });
  const wsBridge2 = await createBridgeWorkspace(rootDir, home, "bridge-2", { port: 19002 });
  const wsCuaA = join(rootDir, "cua-a");
  const wsCuaB = join(rootDir, "cua-b");
  await mkdir(wsCuaA, { recursive: true });
  await mkdir(wsCuaB, { recursive: true });
  await writeFile(join(wsCuaA, "ludens.json"), JSON.stringify({ driver: "cua" }));
  await writeFile(join(wsCuaB, "ludens.json"), JSON.stringify({ driver: "cua", cuaCommand: "/usr/local/bin/custom-cua" }));

  const id1 = await resolveWorkspaceDeviceIdentity(wsBridge1.workspace, home);
  const id2 = await resolveWorkspaceDeviceIdentity(wsBridge2.workspace, home);
  const idCuaA = await resolveWorkspaceDeviceIdentity(wsCuaA, home);
  const idCuaB = await resolveWorkspaceDeviceIdentity(wsCuaB, home);

  expect(id1.deviceKey).toBe("bridge:127.0.0.1:19001");
  expect(id2.deviceKey).toBe("bridge:127.0.0.1:19002");
  expect(id1.deviceKey).not.toBe(id2.deviceKey);
  expect(idCuaA.deviceKey).toBe("stdio:local-desktop");
  expect(idCuaB.deviceKey).toBe("stdio:cua:/usr/local/bin/custom-cua");
  expect(idCuaA.deviceKey).not.toBe(idCuaB.deviceKey);
});

test("multi-device workspaces run concurrently while same-device Standby yields and Active enforces 409 DEVICE_BUSY unless preempted", async () => {
  const rootDir = await realpath(await mkdtemp(join(tmpdir(), "ludens-arbitration-")));
  tempRoots.push(rootDir);
  const home = join(rootDir, "home");

  const sharedPort = await allocatePort();
  const distinctPort = await allocatePort();

  const wsA = await createBridgeWorkspace(rootDir, home, "ws-a", { port: sharedPort });
  const wsB = await createBridgeWorkspace(rootDir, home, "ws-b", { port: sharedPort });
  const wsC = await createBridgeWorkspace(rootDir, home, "ws-c", { port: distinctPort });

  const initialModeByWorkspace: Record<string, "manual" | "auto"> = {
    [wsA.workspace]: "manual",
    [wsB.workspace]: "auto",
    [wsC.workspace]: "auto",
  };
  const supervisor = new WorkspaceSupervisor({
    home,
    ioFactory: makeStubSupervisorIO(home, {
      initialModeByWorkspace,
      preparedPorts: [sharedPort, distinctPort],
    }),
  });

  try {
    // 1. Start wsA (Warm Standby) and wsC (different device) — both stay alive concurrently.
    await supervisor.up({ workspace: wsA.workspace, workspaceId: wsA.id, launchedBy: "app" });
    await supervisor.up({ workspace: wsC.workspace, workspaceId: wsC.id, launchedBy: "app" });

    expect((await probeBackgroundJob(join(wsA.workspace, "logs/background/host.job.json"))).pid).not.toBeNull();
    expect((await probeBackgroundJob(join(wsC.workspace, "logs/background/host.job.json"))).pid).not.toBeNull();

    // 2. Starting wsB (shares sharedPort with Standby wsA) auto-yields wsA without preempt.
    const yieldRes = await supervisor.up({ workspace: wsB.workspace, workspaceId: wsB.id, launchedBy: "app" });
    expect(yieldRes.notes.some(n => n.includes("standby holder"))).toBe(true);
    expect((await probeBackgroundJob(join(wsA.workspace, "logs/background/host.job.json"))).registered).toBe(false);
    expect((await probeBackgroundJob(join(wsB.workspace, "logs/background/host.job.json"))).pid).not.toBeNull();
    expect((await probeBackgroundJob(join(wsC.workspace, "logs/background/host.job.json"))).pid).not.toBeNull();

    // 3. Starting wsA now that wsB is Active (mode=auto) throws 409 DEVICE_BUSY when preempt=false.
    let caught: unknown;
    try {
      await supervisor.up({ workspace: wsA.workspace, workspaceId: wsA.id, launchedBy: "app" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DeviceBusyError);
    expect((caught as DeviceBusyError).status).toBe(409);
    expect((caught as DeviceBusyError).code).toBe("DEVICE_BUSY");
    expect((caught as DeviceBusyError).conflict).toMatchObject({
      holderProjectId: wsB.id,
      holderWorkspaceName: wsB.name,
      deviceKey: `bridge:127.0.0.1:${sharedPort}`,
      holderMode: "auto",
      holderOrigin: "app",
    });

    // 4. preempt=true stops Active wsB and launches wsA cleanly.
    const preemptRes = await supervisor.up({
      workspace: wsA.workspace,
      workspaceId: wsA.id,
      launchedBy: "app",
      preempt: true,
    });
    expect(preemptRes.notes.some(n => n.includes("active holder"))).toBe(true);
    expect((await probeBackgroundJob(join(wsB.workspace, "logs/background/host.job.json"))).registered).toBe(false);
    expect((await probeBackgroundJob(join(wsA.workspace, "logs/background/host.job.json"))).pid).not.toBeNull();
  } finally {
    await supervisor.shutdownAll({ emergency: true });
  }
}, 20_000);

test("HTTP boundary handles 0-run cold spawn, DEVICE_BUSY preempt, service stop, catalog fields, and !auto pet target", async () => {
  const rootDir = await realpath(await mkdtemp(join(tmpdir(), "ludens-http-multicore-")));
  tempRoots.push(rootDir);
  const home = join(rootDir, "home");

  const sharedPort = await allocatePort();
  const wsCold = await createBridgeWorkspace(rootDir, home, "ws-cold", {
    port: sharedPort,
    model: "google/gemini-2.5-pro",
    serviceTier: "priority",
    effort: "high",
    seconds: 900,
  });
  const wsBusy = await createBridgeWorkspace(rootDir, home, "ws-busy", {
    port: sharedPort,
  });

  const worker = new DashboardWorker({ env: { ...process.env, LUDENS_HOME: home } });
  const supervisor = new WorkspaceSupervisor({
    home,
    ioFactory: makeStubSupervisorIO(home, {
      initialModeByWorkspace: {
        [wsCold.workspace]: "manual",
        [wsBusy.workspace]: "auto",
      },
      preparedPorts: [sharedPort],
    }),
  });
  const eventHub = new EventHub({ home });
  const router = new RpcRouter({
    home,
    serverVersion: "test",
    pid: process.pid,
    authMode: "none",
    mediaSecret: generateMediaTicketSecret(),
    eventHub,
    worker,
    supervisor,
    getConnectionInfo: () => ({ socketPath: "", wsUrl: null, startedAt: new Date().toISOString() }),
    scheduleShutdown: () => {},
  });
  const inbox = new Map<number, JsonRpcSuccess | JsonRpcError>();
  const nextId = { current: 0 };
  const session = router.createSession({
    transport: "uds",
    sendMessage: msg => {
      if ("id" in msg && typeof msg.id === "number") {
        inbox.set(msg.id, msg);
      }
    },
  });
  const rpc = <T = unknown>(method: string, params?: unknown) =>
    callRpc<T>(session, inbox, nextId, method, params);

  try {
    // 1. catalog/get (includeEmpty: true) exposes workspace defaults and offline core state for 0-run workspace.
    const catRes = await rpc<
      Array<{
        id: string;
        runs: unknown[];
        core?: { online: boolean; launchedBy?: string; mode?: string };
        defaults?: { model?: string; serviceTier?: string; effort?: string; maxSeconds?: number };
      }>
    >("catalog/get", { includeEmpty: true });
    expect(catRes.ok).toBe(true);
    if (!catRes.ok) throw new Error(catRes.error.message);
    const projects = catRes.result;
    const coldProj = projects.find(p => p.id === wsCold.id)!;
    expect(coldProj.runs).toEqual([]);
    expect(coldProj.core).toEqual({ online: false });
    expect(coldProj.defaults).toEqual({
      model: "google/gemini-2.5-pro",
      serviceTier: "priority",
      effort: "high",
      maxSeconds: 900,
    });

    // 2. runtime/control (auto_on) on offline 0-run workspace cold-spawns Core,
    //    strips stale runId/expectedEpoch, enters auto, and returns spawned: true.
    const spawnRes = await rpc<{ mode: string; spawned?: boolean; launchedBy?: string }>("runtime/control", {
      project: wsCold.id,
      workspace: wsCold.workspace,
      command: { action: "auto_on", message: "start play", runId: "stale-run", expectedEpoch: "stale-ep" },
    });
    expect(spawnRes.ok).toBe(true);
    if (!spawnRes.ok) throw new Error(spawnRes.error.message);
    expect(spawnRes.result).toMatchObject({ mode: "auto", spawned: true, launchedBy: "app" });

    // 3. Catalog now shows wsCold Core online even with 0 historical run directories.
    await worker.call("clearCatalogCache", []);
    const catOnlineRes = await rpc<typeof projects>("catalog/get", { includeEmpty: true });
    expect(catOnlineRes.ok).toBe(true);
    if (!catOnlineRes.ok) throw new Error(catOnlineRes.error.message);
    expect(catOnlineRes.result.find(p => p.id === wsCold.id)?.core).toMatchObject({
      online: true,
      mode: "auto",
      launchedBy: "app",
    });

    // 4. runtime/control on wsBusy without preempt returns -32009 CONFLICT (DEVICE_BUSY + conflict);
    //    retrying with preempt: true steals device and returns spawned: true.
    const conflictRes = await rpc("runtime/control", {
      project: wsBusy.id,
      workspace: wsBusy.workspace,
      command: { action: "auto_on" },
    });
    expect(conflictRes.ok).toBe(false);
    if (conflictRes.ok) throw new Error("Expected conflict");
    expect(conflictRes.error.code).toBe(-32009);
    const conflictData = conflictRes.error.data as { code: string; conflict: { holderProjectId: string } };
    expect(conflictData.code).toBe("DEVICE_BUSY");
    expect(conflictData.conflict.holderProjectId).toBe(wsCold.id);

    const preemptRes = await rpc<{ mode: string; spawned?: boolean }>("runtime/control", {
      project: wsBusy.id,
      workspace: wsBusy.workspace,
      command: { action: "auto_on" },
      preempt: true,
    });
    expect(preemptRes.ok).toBe(true);
    if (!preemptRes.ok) throw new Error(preemptRes.error.message);
    expect(preemptRes.result).toMatchObject({ mode: "auto", spawned: true });

    // 5. workspaces/serviceControl stops wsBusy, and eventPool/mutate with reply+resumeAuto cold-spawns it back.
    const stopRes = await rpc("workspaces/serviceControl", {
      workspaceId: wsBusy.id,
      services: ["host"],
      action: "down",
    });
    expect(stopRes.ok).toBe(true);
    if (!stopRes.ok) throw new Error(stopRes.error.message);
    expect(stopRes.result).toMatchObject({ ok: true, operation: "down" });

    const store = await openWorkspaceEventPool(wsBusy.workspace, home);
    const outbound = await store.emitOutbound({ kind: "help_request", text: "need input" });
    const poolSpawnRes = await rpc("eventPool/mutate", {
      project: wsBusy.id,
      workspace: wsBusy.workspace,
      command: { action: "reply", replyTo: outbound.event.id, text: "continue", resumeAuto: true },
    });
    expect(poolSpawnRes.ok).toBe(true);
    if (!poolSpawnRes.ok) throw new Error(poolSpawnRes.error.message);
    expect(poolSpawnRes.result).toMatchObject({ hostOnline: true, spawned: true });

    // 6. !auto pet target resets targetConfigured back to false and supports autoFollowing status.
    await setPetTarget(wsBusy.id, false, home);
    expect((await petState(home)).targetConfigured).toBe(true);
    const clearPetRes = await rpc("pet/setTarget", { project: PET_AUTO_TARGET });
    expect(clearPetRes.ok).toBe(true);
    await recordPetConsumer(
      {
        instanceId: "pet-1",
        pid: process.pid,
        revision: null,
        workspace: null,
        runId: null,
        phase: "idle",
        error: null,
        autoFollowing: true,
      },
      home,
    );
    const latestPet = await petState(home);
    expect(latestPet).toMatchObject({ target: null, targetConfigured: false, connected: true, autoFollowing: true });
    expect(petStatusKey(latestPet)).toBe("autoWaiting");
  } finally {
    session.close();
    eventHub.close();
    await supervisor.shutdownAll({ emergency: true });
    await worker.close();
  }
}, 20_000);
