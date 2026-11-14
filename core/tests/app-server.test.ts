import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensureWorkspaceIdentity, registerWorkspace } from "@ludens/protocol/ludens";
import { NodeUdsRpcClient, WsAppRpcClient } from "../src/cli/app-rpc-client.ts";
import {
  isPidAlive,
  probeBackgroundJob,
  startBackgroundJob,
  stopBackgroundJob,
} from "../src/daemon/process-manager.ts";
import { WorkspaceSupervisor } from "../src/daemon/supervisor.ts";
import { startAppServer } from "../src/server/app-server.ts";
import { byteRange, fileResponse } from "../src/server/file-response.ts";
import { localRequest } from "../src/server/local-request.ts";
import { serveStaticFile } from "../src/server/static-files.ts";

async function allocateEphemeralPort(): Promise<number> {
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
    await Bun.sleep(40);
  }
  throw new Error(`Condition did not become true within ${timeoutMs}ms`);
}

test("startAppServer enforces non-loopback WS token guard and localRequest enforces Host + trustedOrigins CSRF rules", async () => {
  await expect(
    startAppServer({ unixSocketPath: false, wsListen: { host: "0.0.0.0", port: 0 } }),
  ).rejects.toThrow("non-loopback host");
  await expect(
    startAppServer({ unixSocketPath: false, wsListen: { host: "192.168.1.50", port: 0 }, auth: { mode: "none" } }),
  ).rejects.toThrow("non-loopback host");

  expect(() =>
    localRequest(new Request("http://evil.example/health", { headers: { host: "evil.example" } })),
  ).toThrow("只允许本地访问");

  expect(() =>
    localRequest(
      new Request("http://127.0.0.1:41234/rpc", {
        method: "POST",
        headers: { host: "127.0.0.1:41234", origin: "http://evil.example" },
      }),
      { mutation: true, trustedOrigins: ["http://127.0.0.1:3099"] },
    ),
  ).toThrow("只允许同源控制请求");

  expect(() =>
    localRequest(
      new Request("http://127.0.0.1:41234/rpc", {
        method: "POST",
        headers: { host: "127.0.0.1:41234", origin: "http://127.0.0.1:3099/" },
      }),
      { mutation: true, trustedOrigins: ["http://127.0.0.1:3099"] },
    ),
  ).not.toThrow();

  expect(() =>
    localRequest(
      new Request("http://[::1]:41234/rpc", {
        method: "POST",
        headers: { host: "[::1]:41234", origin: "http://[::1]:41234" },
      }),
      true,
    ),
  ).not.toThrow();
});

test("app-server serves unified UDS/WS RPC, HTTP /media Range 206, zero /api/* routes, static SPA security headers, and traversal blocks", async () => {
  const rootDir = await realpath(await mkdtemp(join(tmpdir(), "ludens-app-server-test-")));
  const home = join(rootDir, "home");
  const wsDir = join(rootDir, "workspace-alpha");
  const staticDir = join(rootDir, "static-out");
  const outsideSecret = join(rootDir, "outside-secret.txt");

  await mkdir(wsDir, { recursive: true });
  await mkdir(join(staticDir, "assets"), { recursive: true });
  await mkdir(join(staticDir, "companion"), { recursive: true });
  await writeFile(outsideSecret, "TOP_SECRET_DATA", "utf8");
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>Ludens Console</title>", "utf8");
  await writeFile(join(staticDir, "companion", "index.html"), "<!doctype html><title>Companion</title>", "utf8");
  await writeFile(
    join(staticDir, "assets", "app-bundle.js"),
    "console.log('ludens-vite-chunk');",
    "utf8",
  );
  await symlink(outsideSecret, join(staticDir, "escape-link.txt"));

  await writeFile(
    join(wsDir, "ludens.json"),
    JSON.stringify({ driver: "cua", model: "openai-codex/gpt-6.1-sol" }, null, 2),
    "utf8",
  );
  const identity = await ensureWorkspaceIdentity(wsDir);
  await registerWorkspace(wsDir, home);

  // Seed a run with a timeline MP4 video to exercise replay + /media HTTP 206 Partial Content end-to-end.
  const runId = "2026-01-01T00-00-00.000Z";
  const runDir = join(wsDir, "logs", runId);
  const timelineVideoDir = join(wsDir, ".ludens", "timeline", "video");
  await mkdir(runDir, { recursive: true });
  await mkdir(timelineVideoDir, { recursive: true });
  await writeFile(join(timelineVideoDir, "clip.mp4"), "0123456789", "utf8");
  await writeFile(
    join(runDir, "manifest.json"),
    JSON.stringify(
      {
        runId,
        workspace: wsDir,
        workspaceId: identity.id,
        model: "openai-codex/gpt-6.1-sol",
        drivers: ["cua"],
        eventSchemaVersion: 1,
      },
      null,
      2,
    ),
    "utf8",
  );
  const events = [
    { seq: 1, type: "run_start", atMs: 1000, at: "2026-01-01T00:00:01.000Z", data: { workspace: wsDir, workspaceId: identity.id } },
    { seq: 2, type: "control", atMs: 2000, at: "2026-01-01T00:00:02.000Z", trace: { epoch: "ep-1" }, data: { mode: "auto", epoch: "ep-1" } },
    {
      seq: 3,
      type: "observation_media",
      atMs: 3000,
      at: "2026-01-01T00:00:03.000Z",
      trace: { epoch: "ep-1", observationId: "obs-1" },
      data: { observationId: "obs-1", modelMedia: { asset: "video/clip.mp4", mediaType: "video/mp4" } },
    },
    {
      seq: 4,
      type: "model_start",
      atMs: 3500,
      at: "2026-01-01T00:00:03.500Z",
      trace: { epoch: "ep-1", modelCallId: "mc-1" },
      data: { observations: ["obs-1"] },
    },
    { seq: 5, type: "control", atMs: 4000, at: "2026-01-01T00:00:04.000Z", trace: { epoch: "ep-1" }, data: { mode: "manual", epoch: "ep-1" } },
    { seq: 6, type: "run_end", atMs: 5000, at: "2026-01-01T00:00:05.000Z", data: { mode: "manual" } },
  ];
  await writeFile(join(runDir, "events.jsonl"), `${events.map(e => JSON.stringify(e)).join("\n")}\n`, "utf8");

  const trustedDevOrigin = "http://127.0.0.1:3099";
  const server = await startAppServer({
    home,
    wsListen: { host: "127.0.0.1", port: 0 },
    auth: { mode: "none" },
    staticDir,
    trustedOrigins: [trustedDevOrigin],
  });

  const udsClient = new NodeUdsRpcClient({ socketPath: server.socketPath! });
  const wsClient = new WsAppRpcClient({ url: server.wsUrl! });

  try {
    expect(server.port).toBeGreaterThan(0);
    expect(server.port).not.toBe(3015);
    expect(server.socketPath).toBeTruthy();

    // UDS socket mode is 0o600 on POSIX.
    if (process.platform !== "win32") {
      const sockStat = await stat(server.socketPath!);
      expect(sockStat.mode & 0o777).toBe(0o600);
    }

    // 1. /health HTTP endpoint
    const healthRes = await fetch(`${server.url}/health`);
    expect(healthRes.status).toBe(200);
    expect(healthRes.headers.get("cache-control")).toBe("no-store");
    expect(await healthRes.json()).toEqual({
      ok: true,
      pid: process.pid,
      authRequired: false,
    });

    // Legacy /api/* routes are deleted and must return 404 (never SPA index.html).
    for (const legacyPath of ["/api/health", "/api/catalog", "/api/pet", "/api/workspaces"]) {
      const legacyRes = await fetch(`${server.url}${legacyPath}`);
      expect(legacyRes.status).toBe(404);
    }

    // 2. UDS & WS RPC initialize + core queries
    await udsClient.connect();
    await wsClient.connect();
    const udsInit = await udsClient.initialize({ clientInfo: { name: "test-uds", version: "1.0.0" } });
    expect(udsInit.transport).toBe("uds");
    expect(udsInit.authenticated).toBe(true);
    expect(udsInit.home).toBe(home);
    expect(udsInit.media.basePath).toBe("/media");
    expect(udsInit.media.liveStreamCapabilities).toEqual(["none"]);

    const wsInit = await wsClient.initialize({ clientInfo: { name: "test-ws", version: "1.0.0" } });
    expect(wsInit.transport).toBe("ws");
    expect(wsInit.authenticated).toBe(true);

    // catalog/get via WS RPC
    const catalog = (await wsClient.call("catalog/get", { includeEmpty: true })) as Array<{
      id: string;
      runs: Array<{ id: string }>;
    }>;
    expect(catalog.map(p => p.id)).toContain(identity.id);
    expect(catalog.find(p => p.id === identity.id)?.runs.map(r => r.id)).toContain(runId);

    // workspaces/getSettings + workspaces/getStudio via WS RPC
    const wsSettings = (await wsClient.call("workspaces/getSettings")) as {
      home: string;
      workspaces: Array<{ id: string }>;
    };
    expect(wsSettings.home).toBe(home);
    expect(wsSettings.workspaces.map(w => w.id)).toContain(identity.id);

    const studio = (await wsClient.call("workspaces/getStudio", { workspaceId: identity.id })) as {
      id: string;
      config: { driver: string };
    };
    expect(studio.id).toBe(identity.id);
    expect(studio.config.driver).toBe("cua");

    // docs/groups + docs/read
    const docGroups = (await wsClient.call("docs/groups", { lang: "zh" })) as Array<{
      id: string;
      docs: Array<{ id: string }>;
    }>;
    expect(docGroups.length).toBeGreaterThan(0);
    const firstDocId = docGroups[0]?.docs[0]?.id;
    expect(firstDocId).toBeTruthy();
    const docDetail = (await wsClient.call("docs/read", { id: firstDocId!, lang: "en" })) as {
      id: string;
      html: string;
    };
    expect(docDetail.id).toBe(firstDocId);
    expect(docDetail.html.length).toBeGreaterThan(0);

    // 3. pet/setTarget + pet/recordConsumer + pet/getState over RPC
    const putReceipt = (await wsClient.call("pet/setTarget", { project: identity.id })) as {
      target: { project: string; revision: string };
    };
    expect(putReceipt.target.project).toBe(identity.id);

    await wsClient.call("pet/recordConsumer", {
      instanceId: "desktop-pet-test",
      pid: process.pid,
      revision: putReceipt.target.revision,
      workspace: wsDir,
      runId: null,
      phase: "idle",
      error: null,
    });
    const pet = await wsClient.call("pet/getState");
    expect(pet).toMatchObject({
      target: { project: identity.id },
      connected: true,
    });

    // 4. replay/get uses /media?... URLs + /media HTTP Range 206 Partial Content + 416 + HEAD + CORS/CORP
    const replayOverview = (await wsClient.call("replay/get", {
      project: identity.id,
      run: runId,
      query: { mode: "overview" },
    })) as { cycles: Array<{ epoch: string }> };
    expect(replayOverview.cycles.map(c => c.epoch)).toEqual(["ep-1"]);

    const replayFrames = (await wsClient.call("replay/get", {
      project: identity.id,
      run: runId,
      query: { mode: "frames", epoch: "ep-1", start: 0, end: 10_000 },
    })) as { items: unknown[] };
    expect(Array.isArray(replayFrames.items)).toBe(true);

    const replayEvents = (await wsClient.call("replay/get", {
      project: identity.id,
      run: runId,
      query: {
        mode: "events",
        epoch: "ep-1",
        start: Date.parse("2026-01-01T00:00:00.000Z"),
        end: Date.parse("2026-01-01T00:00:06.000Z"),
      },
    })) as { items: Array<{ id: string; track: string }> };
    const modelItem = replayEvents.items.find(item => item.track === "model");
    expect(modelItem).toBeTruthy();

    const replayDetail = (await wsClient.call("replay/get", {
      project: identity.id,
      run: runId,
      query: { mode: "detail", epoch: "ep-1", id: modelItem!.id },
    })) as { observations?: Array<{ url?: string }> };
    expect(replayDetail.observations?.[0]?.url).toContain("/media?kind=replay");
    expect(replayDetail.observations?.[0]?.url).not.toContain("/api/");

    const replayMediaUrl = `${server.url}/media?kind=replay&project=${encodeURIComponent(identity.id)}&run=${encodeURIComponent(runId)}&mode=media&id=model-media:3`;
    const rangeRes = await fetch(replayMediaUrl, {
      headers: { Range: "bytes=2-5", Origin: trustedDevOrigin },
    });
    expect(rangeRes.status).toBe(206);
    expect(rangeRes.headers.get("accept-ranges")).toBe("bytes");
    expect(rangeRes.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(rangeRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(rangeRes.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(rangeRes.headers.get("access-control-allow-origin")).toBe(trustedDevOrigin);
    expect(await rangeRes.text()).toBe("2345");

    const headRangeRes = await fetch(replayMediaUrl, { method: "HEAD", headers: { Range: "bytes=2-5" } });
    expect(headRangeRes.status).toBe(206);
    expect(headRangeRes.headers.get("content-length")).toBe("4");
    expect(await headRangeRes.text()).toBe("");

    const badRangeRes = await fetch(replayMediaUrl, { headers: { Range: "bytes=50-60" } });
    expect(badRangeRes.status).toBe(416);
    expect(badRangeRes.headers.get("content-range")).toBe("bytes */10");

    // media/resolve on UDS returns local file path, while WS rejects with -32001 UNAUTHORIZED.
    const resolvedUds = await udsClient.call("media/resolve", {
      kind: "replay",
      project: identity.id,
      run: runId,
      mode: "media",
      id: "model-media:3",
    });
    expect("file" in resolvedUds && resolvedUds.file).toBe(join(timelineVideoDir, "clip.mp4"));
    let mediaWsError: unknown;
    try {
      await wsClient.call("media/resolve", {
        kind: "replay",
        project: identity.id,
        run: runId,
        mode: "media",
        id: "model-media:3",
      });
    } catch (error) {
      mediaWsError = error;
    }
    expect(mediaWsError).toMatchObject({ code: -32001 });

    // Direct unit check on byteRange + fileResponse edge cases
    expect(() => byteRange("bytes=0-", 0)).toThrow();
    const directMediaResp = await fileResponse(
      new Request("http://127.0.0.1/video", { headers: { Range: "bytes=-3" } }),
      { file: join(timelineVideoDir, "clip.mp4"), mediaType: "video/mp4" },
    );
    expect(directMediaResp.status).toBe(206);
    expect(await directMediaResp.text()).toBe("789");

    // 5. Static SPA serving, immutable /assets/* caching, security headers, and traversal rejection
    const rootHtml = await fetch(`${server.url}/`);
    expect(rootHtml.status).toBe(200);
    expect(rootHtml.headers.get("content-type")).toContain("text/html");
    expect(rootHtml.headers.get("cache-control")).toBe("no-cache");
    expect(rootHtml.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(rootHtml.headers.get("x-frame-options")).toBe("DENY");
    expect(rootHtml.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(await rootHtml.text()).toContain("Ludens Console");

    const spaFallback = await fetch(`${server.url}/workspaces/some-client-route`);
    expect(spaFallback.status).toBe(200);
    expect(spaFallback.headers.get("cache-control")).toBe("no-cache");
    expect(await spaFallback.text()).toContain("Ludens Console");

    const companionHtml = await fetch(`${server.url}/companion`);
    expect(companionHtml.status).toBe(200);
    expect(await companionHtml.text()).toContain("Companion");

    const viteAsset = await fetch(`${server.url}/assets/app-bundle.js`);
    expect(viteAsset.status).toBe(200);
    expect(viteAsset.headers.get("content-type")).toContain("javascript");
    expect(viteAsset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await viteAsset.text()).toContain("ludens-vite-chunk");

    const missingJs = await fetch(`${server.url}/assets/missing.js`);
    expect(missingJs.status).toBe(404);

    // Encoded slash traversal, normalized fetch traversal, & symlink escape must never expose outside files
    const encodedSlashTraversal = await fetch(`${server.url}/..%2foutside-secret.txt`);
    expect(encodedSlashTraversal.status).toBe(403);
    expect(await encodedSlashTraversal.text()).not.toContain("TOP_SECRET_DATA");

    const normalizedDotTraversal = await fetch(`${server.url}/%2e%2e/outside-secret.txt`);
    expect([403, 404]).toContain(normalizedDotTraversal.status);
    expect(await normalizedDotTraversal.text()).not.toContain("TOP_SECRET_DATA");

    const symlinkEscape = await fetch(`${server.url}/escape-link.txt`);
    expect(symlinkEscape.status).toBe(403);
    expect(await symlinkEscape.text()).not.toContain("TOP_SECRET_DATA");

    const directRawTraversal = await serveStaticFile(
      new Request("http://127.0.0.1/placeholder"),
      staticDir,
      "/../../outside-secret.txt",
    );
    expect(directRawTraversal.status).toBe(403);

    // 6. RPC daemon/shutdown triggers async graceful close cleanly and removes runtime file
    const shutdownResult = await wsClient.call("daemon/shutdown", { stopCores: false });
    expect(shutdownResult).toEqual({ ok: true, stopped: [] });
    await server.closed;
    expect(await Bun.file(server.runtimeFilePath).exists()).toBe(false);
  } finally {
    await wsClient.close().catch(() => {});
    await udsClient.close().catch(() => {});
    await server.close({ emergency: true }).catch(() => {});
    await rm(rootDir, { recursive: true, force: true });
  }
}, 20_000);

test("WorkspaceSupervisor tracks only owned services and never kills external unmanaged jobs", async () => {
  const rootDir = await realpath(await mkdtemp(join(tmpdir(), "ludens-supervisor-test-")));
  const home = join(rootDir, "home");
  const ownedWs = join(rootDir, "owned-ws");
  const foreignWs = join(rootDir, "foreign-ws");
  await mkdir(ownedWs, { recursive: true });
  await mkdir(foreignWs, { recursive: true });

  await writeFile(join(ownedWs, "ludens.json"), JSON.stringify({ driver: "cua" }), "utf8");
  await writeFile(join(foreignWs, "ludens.json"), JSON.stringify({ driver: "cua" }), "utf8");
  const ownedIdentity = await ensureWorkspaceIdentity(ownedWs);
  await ensureWorkspaceIdentity(foreignWs);
  await registerWorkspace(ownedWs, home);
  await registerWorkspace(foreignWs, home);

  const supervisor = new WorkspaceSupervisor({ home });
  const ownedJob = await startBackgroundJob({
    name: "host",
    command: [process.execPath, "-e", "setInterval(() => {}, 1000);"],
    cwd: ownedWs,
    env: { ...process.env, LUDENS_HOME: home },
    launchedBy: "app",
    appInstanceId: supervisor.instanceId,
  });
  const foreignJob = await startBackgroundJob({
    name: "host",
    command: [process.execPath, "-e", "setInterval(() => {}, 1000);"],
    cwd: foreignWs,
    env: { ...process.env, LUDENS_HOME: home },
    launchedBy: "cli",
  });
  try {
    expect(isPidAlive(ownedJob.pid)).toBe(true);
    expect(isPidAlive(foreignJob.pid)).toBe(true);

    await supervisor.trackOwnedService(ownedWs, "host", ownedIdentity.id);
    expect(supervisor.managedWorkspaceIds()).toEqual([ownedIdentity.id]);

    await supervisor.shutdownAll({ emergency: true });
    expect(supervisor.managedWorkspaceIds()).toEqual([]);

    await waitForCondition(() => !isPidAlive(ownedJob.pid));
    expect((await probeBackgroundJob(ownedJob.stateFile)).registered).toBe(false);

    // Foreign workspace job is completely untouched!
    expect(isPidAlive(foreignJob.pid)).toBe(true);
    expect((await probeBackgroundJob(foreignJob.stateFile)).registered).toBe(true);

    // If a tracked service is externally replaced with a new PID, shutdownAll does not kill the replacement
    const supervisor2 = new WorkspaceSupervisor({ home });
    await supervisor2.trackOwnedService(foreignWs, "host", undefined, 999_999_999);
    await supervisor2.shutdownAll({ emergency: true });
    expect(isPidAlive(foreignJob.pid)).toBe(true);
    expect((await probeBackgroundJob(foreignJob.stateFile)).registered).toBe(true);
  } finally {
    await stopBackgroundJob(ownedJob.stateFile, { immediate: true }).catch(() => {});
    await stopBackgroundJob(foreignJob.stateFile, { immediate: true }).catch(() => {});
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("CLI ludens app-server --listen ws://127.0.0.1:0 --parent-watchdog emits JSON handshake and cleans up supervised child tree on stdin EOF", async () => {
  const rootDir = await realpath(await mkdtemp(join(tmpdir(), "ludens-watchdog-cli-")));
  const home = join(rootDir, "home");
  const wsDir = join(rootDir, "managed-ws");
  const foreignWs = join(rootDir, "foreign-ws");
  const driverDir = join(wsDir, "driver");
  const subchildPidFile = join(rootDir, "emulator-subchild.pid");

  await mkdir(driverDir, { recursive: true });
  await mkdir(foreignWs, { recursive: true });

  const bridgePort = await allocateEphemeralPort();
  const emulatorJs = join(wsDir, "dummy-emulator.mjs");
  const emulatorLauncher = join(wsDir, "dummy-emulator-bin");
  await writeFile(
    emulatorJs,
    [
      `import { spawn } from "node:child_process";`,
      `import { writeFileSync } from "node:fs";`,
      `import { createServer } from "node:net";`,
      `const sub = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });`,
      `writeFileSync(${JSON.stringify(subchildPidFile)}, String(sub.pid));`,
      `const server = createServer(socket => socket.destroy());`,
      `server.listen(Number(process.env.LUDENS_BRIDGE_PORT || ${bridgePort}), "127.0.0.1");`,
      `setInterval(() => {}, 1000);`,
    ].join("\n"),
    "utf8",
  );
  await writeFile(emulatorLauncher, `#!/bin/sh\nexec "${process.execPath}" "${emulatorJs}" "$@"\n`, "utf8");
  await chmod(emulatorLauncher, 0o755);

  await writeFile(
    join(driverDir, "package.json"),
    JSON.stringify({ name: "watchdog-fixture-driver", version: "1.0.0", type: "module", exports: "./index.js" }),
    "utf8",
  );
  await writeFile(
    join(driverDir, "index.js"),
    `export default {
      id: "watchdog-fixture",
      transport: "bridge",
      defaultPort: ${bridgePort},
      needsGame: true,
      launchCommand: [${JSON.stringify(emulatorLauncher)}],
      async load() { throw new Error("fail fast in baseware after emulator starts"); }
    };\n`,
    "utf8",
  );
  await writeFile(join(wsDir, "game.rom"), "rom", "utf8");
  await writeFile(
    join(wsDir, "ludens.json"),
    JSON.stringify(
      {
        driver: "watchdog-fixture",
        driverPackage: "file:./driver",
        game: "game.rom",
        port: bridgePort,
        dashboard: true,
        pet: true,
      },
      null,
      2,
    ),
    "utf8",
  );
  const wsIdentity = await ensureWorkspaceIdentity(wsDir);
  await registerWorkspace(wsDir, home);

  // Also spawn an external unmanaged background job to verify watchdog never kills unowned processes.
  const externalJob = await startBackgroundJob({
    name: "external-emulator",
    command: [process.execPath, "-e", "setInterval(() => {}, 1000);"],
    cwd: foreignWs,
    env: { ...process.env, LUDENS_HOME: home },
  });

  const mainCli = resolve(import.meta.dir, "../src/cli/main.ts");
  const child = spawn(
    process.execPath,
    [mainCli, "app-server", "--listen", "ws://127.0.0.1:0", "--parent-watchdog"],
    {
      cwd: rootDir,
      env: { ...process.env, LUDENS_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let emulatorPid = 0;
  let subchildPid = 0;
  let rpcClient: WsAppRpcClient | null = null;

  try {
    // 1. Read single-line JSON readiness handshake from stdout
    const handshakeLine = await new Promise<string>((resolveLine, rejectLine) => {
      let buf = "";
      let stderrBuf = "";
      const timer = setTimeout(() => rejectLine(new Error(`Timed out waiting for handshake. stderr=${stderrBuf}`)), 8000);
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", chunk => {
        stderrBuf += chunk;
      });
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", chunk => {
        buf += chunk;
        const nl = buf.indexOf("\n");
        if (nl >= 0) {
          clearTimeout(timer);
          resolveLine(buf.slice(0, nl).trim());
        }
      });
      child.once("exit", code => {
        clearTimeout(timer);
        rejectLine(new Error(`app-server exited prematurely (${code}): ${stderrBuf}`));
      });
    });

    const handshake = JSON.parse(handshakeLine) as {
      ready: boolean;
      socketPath: string | null;
      wsUrl: string;
      url: string;
      host: string;
      port: number;
      pid: number;
      home: string;
      authMode: string;
    };
    expect(handshake).toEqual({
      ready: true,
      socketPath: expect.any(String),
      wsUrl: `ws://127.0.0.1:${handshake.port}/rpc`,
      url: `http://127.0.0.1:${handshake.port}`,
      host: "127.0.0.1",
      port: expect.any(Number),
      pid: child.pid!,
      home,
      authMode: "none",
    });
    expect(handshake.port).toBeGreaterThan(0);
    expect(handshake.port).not.toBe(3015);

    // 2. Trigger workspace up via WS JSON-RPC workspaces/serviceControl.
    rpcClient = new WsAppRpcClient({ url: handshake.wsUrl });
    await rpcClient.connect();
    await rpcClient.initialize();
    const upResult = await rpcClient.call("workspaces/serviceControl", {
      workspaceId: wsIdentity.id,
      action: "up",
    });
    expect(upResult).toBeDefined();

    // Verify emulator + its grandchild process are alive and tracked by app-server's WorkspaceSupervisor
    const emulatorStateFile = join(wsDir, "logs", "background", "emulator.job.json");
    const probe = await probeBackgroundJob(emulatorStateFile);
    expect(probe.registered).toBe(true);
    expect(probe.pid).toBeGreaterThan(0);
    emulatorPid = probe.pid!;
    expect(isPidAlive(emulatorPid)).toBe(true);

    await waitForCondition(async () => Bun.file(subchildPidFile).exists());
    subchildPid = Number((await readFile(subchildPidFile, "utf8")).trim());
    expect(subchildPid).toBeGreaterThan(0);
    expect(isPidAlive(subchildPid)).toBe(true);

    const statusDuring = await rpcClient.call("daemon/status");
    expect(statusDuring.managedWorkspaces).toEqual([wsIdentity.id]);

    // 3. Close child stdin to simulate parent crash / SIGKILL EOF!
    const exitPromise = new Promise<number | null>(resolveExit => {
      child.once("exit", code => resolveExit(code));
    });
    child.stdin?.end();

    const exitCode = await exitPromise;
    expect(exitCode).toBe(0);

    // 4. Verify app-server, its managed emulator, and the emulator's subchild are ALL terminated with .job.json cleaned up!
    await waitForCondition(() => !isPidAlive(emulatorPid) && !isPidAlive(subchildPid));
    expect(isPidAlive(child.pid!)).toBe(false);
    expect(isPidAlive(emulatorPid)).toBe(false);
    expect(isPidAlive(subchildPid)).toBe(false);
    expect(await Bun.file(emulatorStateFile).exists()).toBe(false);

    // External unmanaged job must remain alive!
    expect(isPidAlive(externalJob.pid)).toBe(true);
  } finally {
    await rpcClient?.close().catch(() => {});
    if (child.pid && isPidAlive(child.pid)) {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
    if (emulatorPid && isPidAlive(emulatorPid)) {
      try {
        process.kill(emulatorPid, "SIGKILL");
      } catch {}
    }
    if (subchildPid && isPidAlive(subchildPid)) {
      try {
        process.kill(subchildPid, "SIGKILL");
      } catch {}
    }
    await stopBackgroundJob(externalJob.stateFile, { immediate: true }).catch(() => {});
    await rm(rootDir, { recursive: true, force: true });
  }
}, 25_000);
