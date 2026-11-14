import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { LudensServerEvent } from "@ludens/protocol/app-rpc";
import { ensureWorkspaceIdentity, registerWorkspace } from "@ludens/protocol/ludens";
import { NodeUdsRpcClient, WsAppRpcClient } from "../src/cli/app-rpc-client.ts";
import {
  appServerRuntimeFilePath,
  ensureLocalAppDaemon,
  probeAppDaemon,
  resolveAppServerSocketPath,
  stopLocalAppDaemon,
} from "../src/daemon/app-daemon.ts";
import { startBackgroundJob, stopBackgroundJob } from "../src/daemon/process-manager.ts";
import { startAppServer } from "../src/server/app-server.ts";
import { EVENT_HUB_RING_CAPACITY, EventHub } from "../src/server/event-hub.ts";
import {
  generateMediaTicketSecret,
  mintMediaTicket,
  verifyMediaTicket,
} from "../src/server/media-ticket.ts";

async function waitForCondition(check: () => boolean | Promise<boolean>, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(30);
  }
  throw new Error(`Condition did not become true within ${timeoutMs}ms`);
}

test("media-ticket mints, verifies in constant time, and rejects expired or tampered tickets", () => {
  const secret = generateMediaTicketSecret();
  const otherSecret = generateMediaTicketSecret();
  const now = 1_700_000_000_000;
  const { ticket, expiresAt } = mintMediaTicket(secret, 60_000, now);

  expect(expiresAt).toBe(now + 60_000);
  expect(verifyMediaTicket(secret, ticket, now)).toBe(true);
  expect(verifyMediaTicket(secret, ticket, now + 59_999)).toBe(true);
  expect(verifyMediaTicket(secret, ticket, expiresAt)).toBe(false);
  expect(verifyMediaTicket(otherSecret, ticket, now)).toBe(false);
  expect(verifyMediaTicket(secret, null, now)).toBe(false);
  expect(verifyMediaTicket(secret, "", now)).toBe(false);
  expect(verifyMediaTicket(secret, "bad.ticket", now)).toBe(false);

  const [exp, nonce, sig] = ticket.split(".");
  const tamperedSig = `${sig!.slice(0, -1)}${sig!.endsWith("A") ? "B" : "A"}`;
  expect(verifyMediaTicket(secret, `${exp}.${nonce}.${tamperedSig}`, now)).toBe(false);
  expect(verifyMediaTicket(secret, `${Number(exp) + 1}.${nonce}.${sig}`, now)).toBe(false);
});

test("startAppServer UDS-only default binds 0 TCP ports, uses macOS sun_path fallback, cleans up runtime file, and protects live sockets", async () => {
  const rootDir = await realpath(await mkdtemp(join(tmpdir(), "ludens-uds-default-")));
  const longHome = join(
    rootDir,
    "very-long-workspace-home-segment-alpha",
    "very-long-workspace-home-segment-beta",
    "very-long-workspace-home-segment-gamma",
  );
  const expectedSocket = resolveAppServerSocketPath(longHome);
  expect(expectedSocket.startsWith("/tmp/ludens-app-")).toBe(true);
  expect(Buffer.byteLength(expectedSocket, "utf8")).toBeLessThanOrEqual(96);

  const server = await startAppServer({ home: longHome });
  try {
    expect(server.socketPath).toBe(expectedSocket);
    expect(server.wsUrl).toBeNull();
    expect(server.url).toBeNull();
    expect(server.port).toBeNull();

    if (process.platform !== "win32") {
      expect((await stat(server.socketPath!)).mode & 0o777).toBe(0o600);
      expect((await stat(server.runtimeFilePath)).mode & 0o777).toBe(0o600);
    }

    const runtimeJson = JSON.parse(await Bun.file(server.runtimeFilePath).text()) as {
      pid: number;
      socketPath: string | null;
      wsUrl: string | null;
      home: string;
    };
    expect(runtimeJson).toMatchObject({
      pid: process.pid,
      socketPath: expectedSocket,
      wsUrl: null,
      home: longHome,
    });

    // Live socket cannot be stolen by starting another server on the same home.
    await expect(startAppServer({ home: longHome })).rejects.toThrow("already running");

    // Stale socket file without active listener is safely replaced.
    const staleHome = join(rootDir, "stale-home");
    const staleSocket = resolveAppServerSocketPath(staleHome);
    await mkdir(join(staleHome, "run"), { recursive: true });
    await new Promise<void>((resolveListen, rejectListen) => {
      const dummy = createServer();
      dummy.once("error", rejectListen);
      dummy.listen(staleSocket, () => {
        dummy.close(() => resolveListen());
      });
    });
    // Ensure a dead socket path exists (if OS didn't keep it, bind raw/skip only unlink check).
    await writeFile(staleSocket, "", "utf8").catch(() => {});
    const recoveredServer = await startAppServer({ home: staleHome });
    expect(recoveredServer.socketPath).toBe(staleSocket);
    await recoveredServer.close({ emergency: true });
    expect(await Bun.file(recoveredServer.runtimeFilePath).exists()).toBe(false);
  } finally {
    await unlink(expectedSocket).catch(() => {});
    await server.close({ emergency: true }).catch(() => {});
    await rm(rootDir, { recursive: true, force: true });
  }
}, 15_000);

test("WS token auth enforces timingSafeEqual initialize handshake, CSWSH Origin checks, and /media capability tickets", async () => {
  const rootDir = await realpath(await mkdtemp(join(tmpdir(), "ludens-ws-auth-")));
  const home = join(rootDir, "home");
  const wsDir = join(rootDir, "ws");
  await mkdir(join(wsDir, ".ludens", "timeline", "video"), { recursive: true });
  await writeFile(join(wsDir, ".ludens", "timeline", "video", "clip.mp4"), "0123456789", "utf8");
  await writeFile(join(wsDir, "ludens.json"), JSON.stringify({ driver: "cua" }), "utf8");
  const identity = await ensureWorkspaceIdentity(wsDir);
  await registerWorkspace(wsDir, home);

  const runId = "2026-02-01T00-00-00.000Z";
  const runDir = join(wsDir, "logs", runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "manifest.json"), JSON.stringify({ runId, workspace: wsDir, workspaceId: identity.id, drivers: ["cua"], eventSchemaVersion: 1 }), "utf8");
  await writeFile(
    join(runDir, "events.jsonl"),
    [
      { seq: 1, type: "run_start", at: "2026-02-01T00:00:01.000Z", data: { workspace: wsDir } },
      { seq: 2, type: "control", at: "2026-02-01T00:00:02.000Z", trace: { epoch: "ep-1" }, data: { mode: "auto", epoch: "ep-1" } },
      { seq: 3, type: "observation_media", at: "2026-02-01T00:00:03.000Z", trace: { epoch: "ep-1" }, data: { observationId: "obs-1", modelMedia: { asset: "video/clip.mp4", mediaType: "video/mp4" } } },
    ]
      .map(e => JSON.stringify(e))
      .join("\n") + "\n",
    "utf8",
  );

  const secretToken = "super-secret-token-value";
  const server = await startAppServer({
    home,
    unixSocketPath: false,
    wsListen: { host: "127.0.0.1", port: 0 },
    auth: { mode: "token", token: secretToken },
  });

  const unauthClient = new WsAppRpcClient({ url: server.wsUrl!, autoInitialize: false });
  const authClient = new WsAppRpcClient({ url: server.wsUrl!, autoInitialize: false });

  try {
    await unauthClient.connect();

    // Non-initialize RPC before handshake is rejected with -32001
    let preAuthError: unknown;
    try {
      await unauthClient.call("daemon/status");
    } catch (error) {
      preAuthError = error;
    }
    expect(preAuthError).toMatchObject({ code: -32001 });

    // Wrong token of same length is rejected with -32001
    let badTokenError: unknown;
    try {
      await unauthClient.initialize({ token: "wrong-secret-token-valuX" });
    } catch (error) {
      badTokenError = error;
    }
    expect(badTokenError).toMatchObject({ code: -32001 });

    // Correct token succeeds and mints a media ticket
    await authClient.connect();
    const init = await authClient.initialize({ token: secretToken });
    expect(init.authenticated).toBe(true);
    expect(typeof init.media.ticket).toBe("string");
    expect(init.media.ticketExpiresAt).toBeGreaterThan(Date.now());

    const refreshed = await authClient.call("media/refreshTicket");
    expect(typeof refreshed.ticket).toBe("string");
    expect(refreshed.ticket).not.toBe(init.media.ticket);

    // /media enforces mt ticket when auth.mode === "token"
    const baseMediaUrl = `${server.url}/media?kind=replay&project=${encodeURIComponent(identity.id)}&run=${encodeURIComponent(runId)}&mode=media&id=model-media:3`;
    const missingTicketRes = await fetch(baseMediaUrl);
    expect(missingTicketRes.status).toBe(401);
    await missingTicketRes.body?.cancel();

    const badTicketRes = await fetch(`${baseMediaUrl}&mt=forged.ticket.value`);
    expect(badTicketRes.status).toBe(401);
    await badTicketRes.body?.cancel();

    const validTicketRes = await fetch(
      `${baseMediaUrl}&mt=${encodeURIComponent(refreshed.ticket)}`,
      { headers: { Origin: "https://remote.client.example", Range: "bytes=0-3" } },
    );
    expect(validTicketRes.status).toBe(206);
    expect(validTicketRes.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(validTicketRes.headers.get("access-control-allow-origin")).toBe("https://remote.client.example");
    expect(await validTicketRes.text()).toBe("0123");

    const preflightRes = await fetch(`${server.url}/media`, {
      method: "OPTIONS",
      headers: { Origin: "https://remote.client.example" },
    });
    expect(preflightRes.status).toBe(204);
    expect(preflightRes.headers.get("access-control-allow-headers")).toContain("Range");
    expect(preflightRes.headers.get("access-control-expose-headers")).toContain("Content-Range");
    await preflightRes.body?.cancel();
  } finally {
    await unauthClient.close().catch(() => {});
    await authClient.close().catch(() => {});
    await server.close({ emergency: true });
    await rm(rootDir, { recursive: true, force: true });
  }
}, 20_000);

test("WS CSWSH Origin check blocks untrusted browser Origin in auth=none mode", async () => {
  const rootDir = await realpath(await mkdtemp(join(tmpdir(), "ludens-ws-cswsh-")));
  const home = join(rootDir, "home");
  const server = await startAppServer({
    home,
    unixSocketPath: false,
    wsListen: { host: "127.0.0.1", port: 0 },
    auth: { mode: "none" },
    trustedOrigins: ["http://127.0.0.1:4173"],
  });

  try {
    const blocked = await fetch(`${server.url}/rpc`, {
      headers: {
        Origin: "http://evil.attacker.example",
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version": "13",
      },
    });
    expect(blocked.status).toBe(403);
    await blocked.body?.cancel();
  } finally {
    await server.close({ emergency: true });
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("EventHub maintains 1024-event ring buffer replay and gates observation emission until media files are ready", async () => {
  const rootDir = await realpath(await mkdtemp(join(tmpdir(), "ludens-event-hub-")));
  const home = join(rootDir, "home");
  const wsDir = join(rootDir, "ws");
  const runId = "2026-03-01T00-00-00.000Z";
  const runDir = join(wsDir, "logs", runId);
  await mkdir(join(wsDir, ".ludens", "timeline", "frames"), { recursive: true });
  await mkdir(runDir, { recursive: true });
  await writeFile(join(wsDir, "ludens.json"), JSON.stringify({ driver: "cua" }), "utf8");
  const identity = await ensureWorkspaceIdentity(wsDir);
  await registerWorkspace(wsDir, home);
  await writeFile(join(runDir, "manifest.json"), JSON.stringify({ runId, workspace: wsDir, workspaceId: identity.id }), "utf8");
  await writeFile(join(runDir, "events.jsonl"), "", "utf8");

  const hub = new EventHub({ home, sweepIntervalMs: 60_000 });
  try {
    await hub.start();

    // 1. Ring buffer catch-up & replayTruncated detection
    for (let i = 1; i <= EVENT_HUB_RING_CAPACITY + 50; i++) {
      hub.publish({ topic: "catalog", payload: { n: i } });
    }
    const received: LudensServerEvent[] = [];
    const recentSub = hub.subscribe("sub-recent", { sinceSeq: EVENT_HUB_RING_CAPACITY + 45 }, evt => {
      received.push(evt);
    });
    expect(recentSub.replayTruncated).toBe(false);
    expect(recentSub.events.map(e => e.seq)).toEqual([
      EVENT_HUB_RING_CAPACITY + 46,
      EVENT_HUB_RING_CAPACITY + 47,
      EVENT_HUB_RING_CAPACITY + 48,
      EVENT_HUB_RING_CAPACITY + 49,
      EVENT_HUB_RING_CAPACITY + 50,
    ]);

    const truncatedSub = hub.subscribe("sub-old", { sinceSeq: 1 }, () => {});
    expect(truncatedSub.replayTruncated).toBe(true);
    expect(truncatedSub.events.length).toBe(EVENT_HUB_RING_CAPACITY);

    // 2. Partial JSONL line does not emit until newline completes; observation waits for media artifact
    const eventsFile = join(runDir, "events.jsonl");
    const obsLine = JSON.stringify({
      seq: 1,
      type: "observation",
      at: "2026-03-01T00:00:01.000Z",
      data: {
        id: "obs-delayed",
        timeline: { asset: "frames/shot.png", mediaType: "image/png" },
      },
    });
    await writeFile(eventsFile, obsLine.slice(0, 20), "utf8");
    await hub.sweepNow();
    expect(received.filter(e => e.topic === "run")).toEqual([]);

    await writeFile(eventsFile, `${obsLine}\n`, "utf8");
    await hub.sweepNow();
    // `run` arrives immediately, while `observation` is held until `frames/shot.png` exists on disk.
    expect(received.some(e => e.topic === "run" && e.runId === runId)).toBe(true);
    expect(received.some(e => e.topic === "observation")).toBe(false);

    await writeFile(join(wsDir, ".ludens", "timeline", "frames", "shot.png"), "PNGDATA", "utf8");
    await hub.sweepNow();
    expect(received.some(e => e.topic === "observation" && e.payload?.observationId === "obs-delayed")).toBe(true);
  } finally {
    await hub.close();
    await rm(rootDir, { recursive: true, force: true });
  }
}, 15_000);

test("cores/stopAll and daemon/shutdown { stopCores } handle active core cleanup selectively", async () => {
  const rootDir = await realpath(await mkdtemp(join(tmpdir(), "ludens-cores-stop-")));
  const home = join(rootDir, "home");
  const wsDir = join(rootDir, "ws");
  await mkdir(wsDir, { recursive: true });
  await writeFile(join(wsDir, "ludens.json"), JSON.stringify({ driver: "cua" }), "utf8");
  const identity = await ensureWorkspaceIdentity(wsDir);
  await registerWorkspace(wsDir, home);

  const server = await startAppServer({ home, wsListen: { host: "127.0.0.1", port: 0 } });
  const client = new NodeUdsRpcClient({ socketPath: server.socketPath! });
  const fakeJob = await startBackgroundJob({
    name: "host",
    command: [process.execPath, "-e", "setInterval(() => {}, 1000);"],
    cwd: wsDir,
    env: { ...process.env, LUDENS_HOME: home },
    launchedBy: "app",
    appInstanceId: server.supervisor.instanceId,
  });

  try {
    await server.supervisor.trackOwnedService(wsDir, "host", identity.id, fakeJob.pid);
    await client.connect();
    await client.initialize();

    const stopCores = await client.call("cores/stopAll");
    expect(stopCores.stopped).toEqual([identity.id]);
    expect(server.supervisor.managedWorkspaceIds()).toEqual([]);

    const shutdownRes = await client.call("daemon/shutdown", { stopCores: false });
    expect(shutdownRes).toEqual({ ok: true, stopped: [] });
    await server.closed;
  } finally {
    await client.close().catch(() => {});
    await stopBackgroundJob(fakeJob.stateFile, { immediate: true }).catch(() => {});
    await server.close({ emergency: true }).catch(() => {});
    await rm(rootDir, { recursive: true, force: true });
  }
}, 15_000);

test("ensureLocalAppDaemon deduplicates concurrent starts, daemon CLI works end-to-end, remote CLI executes over WS, and Node.js imports pure-Node daemon/RPC clients cleanly", async () => {
  const rootDir = await realpath(await mkdtemp(join(tmpdir(), "ludens-daemon-e2e-")));
  const home = join(rootDir, "home");
  const wsDir = join(rootDir, "ws-remote");
  await mkdir(wsDir, { recursive: true });
  await writeFile(join(wsDir, "ludens.json"), JSON.stringify({ driver: "cua" }), "utf8");
  const identity = await ensureWorkspaceIdentity(wsDir);
  await registerWorkspace(wsDir, home);

  const mainCli = resolve(import.meta.dir, "../src/cli/main.ts");

  try {
    // 1. Concurrent ensureLocalAppDaemon calls converge on a single daemon PID
    const results = await Promise.all([
      ensureLocalAppDaemon({ home }),
      ensureLocalAppDaemon({ home }),
      ensureLocalAppDaemon({ home }),
    ]);
    const pids = new Set(results.map(r => r.status.pid));
    expect(pids.size).toBe(1);
    const daemonPid = results[0]!.status.pid;
    expect(daemonPid).toBeGreaterThan(0);

    // 2. CLI `ludens daemon status` / `restart --listen ws://127.0.0.1:0 --auth token --token ...`
    const statusOut = spawnSync(process.execPath, [mainCli, "daemon", "status"], {
      env: { ...process.env, LUDENS_HOME: home },
      encoding: "utf8",
    });
    expect(statusOut.status).toBe(0);
    expect(JSON.parse(statusOut.stdout)).toMatchObject({ running: true, pid: daemonPid, home });

    const remoteToken = "cli-remote-secret";
    const restartOut = spawnSync(
      process.execPath,
      [
        mainCli,
        "daemon",
        "restart",
        "--listen",
        "ws://127.0.0.1:0",
        "--auth",
        "token",
        "--token",
        remoteToken,
      ],
      {
        env: { ...process.env, LUDENS_HOME: home },
        encoding: "utf8",
      },
    );
    expect(restartOut.status).toBe(0);
    const restarted = JSON.parse(restartOut.stdout) as {
      ok: boolean;
      restarted: boolean;
      pid: number;
      wsUrl: string;
      authMode: string;
      socketPath: string;
    };
    expect(restarted.ok).toBe(true);
    expect(restarted.restarted).toBe(true);
    expect(restarted.wsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/rpc$/);
    expect(restarted.authMode).toBe("token");

    // 3. Operator CLI with `--remote` & `LUDENS_REMOTE_URL` / `LUDENS_REMOTE_TOKEN`
    const remoteWsList = spawnSync(
      process.execPath,
      [mainCli, "--remote", restarted.wsUrl, "--token", remoteToken, "workspace", "list"],
      {
        env: { ...process.env, LUDENS_HOME: join(rootDir, "empty-client-home") },
        encoding: "utf8",
      },
    );
    expect(remoteWsList.status).toBe(0);
    expect(remoteWsList.stdout).toContain(identity.id);

    const envRemoteConfig = spawnSync(process.execPath, [mainCli, "config", "show"], {
      env: {
        ...process.env,
        LUDENS_HOME: join(rootDir, "empty-client-home"),
        LUDENS_REMOTE_URL: restarted.wsUrl,
        LUDENS_REMOTE_TOKEN: remoteToken,
      },
      encoding: "utf8",
    });
    expect(envRemoteConfig.status).toBe(0);
    expect(envRemoteConfig.stdout).toContain(home);

    // 4. Verify pure-Node.js (`node --experimental-strip-types`) imports and runs probeAppDaemon + NodeUdsRpcClient + WsAppRpcClient
    const nodeAppDaemonPath = resolve(import.meta.dir, "../src/daemon/app-daemon.ts");
    const nodeClientPath = resolve(import.meta.dir, "../src/cli/app-rpc-client.ts");
    const nodeProtocolPath = resolve(import.meta.dir, "../../protocol/src/app-rpc.ts");
    const nodeCheck = spawnSync(
      "node",
      [
        "--experimental-strip-types",
        "-e",
        [
          `import { probeAppDaemon } from ${JSON.stringify(nodeAppDaemonPath)};`,
          `import { NodeUdsRpcClient, WsAppRpcClient } from ${JSON.stringify(nodeClientPath)};`,
          `import { APP_RPC_PROTOCOL_VERSION } from ${JSON.stringify(nodeProtocolPath)};`,
          `const status = await probeAppDaemon(${JSON.stringify(home)});`,
          `if (!status || status.home !== ${JSON.stringify(home)}) throw new Error("probe failed");`,
          `const uds = new NodeUdsRpcClient({ socketPath: status.socketPath });`,
          `await uds.connect();`,
          `const init = await uds.initialize({ protocolVersion: APP_RPC_PROTOCOL_VERSION });`,
          `const cat = await uds.call("catalog/get", { includeEmpty: true });`,
          `await uds.close();`,
          `const ws = new WsAppRpcClient({ url: status.wsUrl, autoInitialize: false });`,
          `await ws.connect();`,
          `await ws.initialize({ token: ${JSON.stringify(remoteToken)} });`,
          `const daemon = await ws.call("daemon/status");`,
          `await ws.close();`,
          `console.log(JSON.stringify({ nodeOk: true, transport: init.transport, pid: daemon.pid, catCount: cat.length }));`,
        ].join("\n"),
      ],
      {
        cwd: rootDir,
        encoding: "utf8",
      },
    );
    expect(nodeCheck.status).toBe(0);
    expect(JSON.parse(nodeCheck.stdout)).toMatchObject({
      nodeOk: true,
      transport: "uds",
      pid: restarted.pid,
    });

    // 5. CLI `ludens daemon stop` cleanly exits daemon and removes runtime file
    const stopOut = spawnSync(process.execPath, [mainCli, "daemon", "stop"], {
      env: { ...process.env, LUDENS_HOME: home },
      encoding: "utf8",
    });
    expect(stopOut.status).toBe(0);
    expect(JSON.parse(stopOut.stdout)).toMatchObject({ ok: true, stopped: true });
    await waitForCondition(async () => (await probeAppDaemon(home)) === null);
    expect(await Bun.file(appServerRuntimeFilePath(home)).exists()).toBe(false);
  } finally {
    await stopLocalAppDaemon(home, { stopCores: true }).catch(() => {});
    await rm(rootDir, { recursive: true, force: true });
  }
}, 25_000);
