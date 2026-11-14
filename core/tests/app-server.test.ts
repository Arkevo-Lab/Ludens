import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensureWorkspaceIdentity, registerWorkspace } from "@ludens/protocol/ludens";
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

test("startAppServer rejects non-loopback hosts and localRequest enforces Host + trustedOrigins CSRF rules", async () => {
  await expect(startAppServer({ host: "0.0.0.0", port: 0 })).rejects.toThrow("non-loopback host");
  await expect(startAppServer({ host: "192.168.1.50", port: 0 })).rejects.toThrow("non-loopback host");

  expect(() =>
    localRequest(new Request("http://evil.example/api/health", { headers: { host: "evil.example" } })),
  ).toThrow("只允许本地访问");

  expect(() =>
    localRequest(
      new Request("http://127.0.0.1:41234/api/pet", {
        method: "POST",
        headers: { host: "127.0.0.1:41234", origin: "http://evil.example" },
      }),
      { mutation: true, trustedOrigins: ["http://127.0.0.1:3099"] },
    ),
  ).toThrow("只允许同源控制请求");

  expect(() =>
    localRequest(
      new Request("http://127.0.0.1:41234/api/pet", {
        method: "POST",
        headers: { host: "127.0.0.1:41234", origin: "http://127.0.0.1:3099/" },
      }),
      { mutation: true, trustedOrigins: ["http://127.0.0.1:3099"] },
    ),
  ).not.toThrow();

  expect(() =>
    localRequest(
      new Request("http://[::1]:41234/api/pet", {
        method: "POST",
        headers: { host: "[::1]:41234", origin: "http://[::1]:41234" },
      }),
      true,
    ),
  ).not.toThrow();
});

test("app-server serves core HTTP API routes, HTTP Range 206 replay streams, static SPA assets, traversal blocks, and trustedOrigins", async () => {
  const rootDir = await realpath(await mkdtemp(join(tmpdir(), "ludens-app-server-test-")));
  const home = join(rootDir, "home");
  const wsDir = join(rootDir, "workspace-alpha");
  const staticDir = join(rootDir, "static-out");
  const outsideSecret = join(rootDir, "outside-secret.txt");

  await mkdir(wsDir, { recursive: true });
  await mkdir(join(staticDir, "_next", "static", "chunks"), { recursive: true });
  await mkdir(join(staticDir, "companion"), { recursive: true });
  await writeFile(outsideSecret, "TOP_SECRET_DATA", "utf8");
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>Ludens Console</title>", "utf8");
  await writeFile(join(staticDir, "companion", "index.html"), "<!doctype html><title>Companion</title>", "utf8");
  await writeFile(
    join(staticDir, "_next", "static", "chunks", "app.js"),
    "console.log('ludens-chunk');",
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

  // Seed a run with a timeline MP4 video to exercise /api/replay HTTP 206 Partial Content end-to-end.
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
      data: { modelMedia: { asset: "video/clip.mp4", mediaType: "video/mp4" } },
    },
    { seq: 4, type: "control", atMs: 4000, at: "2026-01-01T00:00:04.000Z", trace: { epoch: "ep-1" }, data: { mode: "manual", epoch: "ep-1" } },
    { seq: 5, type: "run_end", atMs: 5000, at: "2026-01-01T00:00:05.000Z", data: { mode: "manual" } },
  ];
  await writeFile(join(runDir, "events.jsonl"), `${events.map(e => JSON.stringify(e)).join("\n")}\n`, "utf8");

  const trustedDevOrigin = "http://127.0.0.1:3099";
  const server = await startAppServer({
    host: "127.0.0.1",
    port: 0,
    home,
    staticDir,
    trustedOrigins: [trustedDevOrigin],
  });

  try {
    expect(server.port).toBeGreaterThan(0);
    expect(server.port).not.toBe(3015);

    // 1. /api/health
    const healthRes = await fetch(`${server.url}/api/health`);
    expect(healthRes.status).toBe(200);
    expect(healthRes.headers.get("cache-control")).toBe("no-store");
    expect(await healthRes.json()).toEqual({
      ok: true,
      pid: process.pid,
      home,
      managedWorkspaces: [],
    });

    // 2. /api/catalog
    const catalogRes = await fetch(`${server.url}/api/catalog?includeEmpty=1`);
    expect(catalogRes.status).toBe(200);
    const catalogJson = (await catalogRes.json()) as Array<{ id: string; runs: Array<{ id: string }> }>;
    expect(catalogJson.map(p => p.id)).toContain(identity.id);
    expect(catalogJson.find(p => p.id === identity.id)?.runs.map(r => r.id)).toContain(runId);

    // 3. /api/workspaces (GET settings + GET studio)
    const wsRes = await fetch(`${server.url}/api/workspaces`);
    expect(wsRes.status).toBe(200);
    const wsSettings = (await wsRes.json()) as { home: string; workspaces: Array<{ id: string }> };
    expect(wsSettings.home).toBe(home);
    expect(wsSettings.workspaces.map(w => w.id)).toContain(identity.id);

    const studioRes = await fetch(`${server.url}/api/workspaces?studio=${encodeURIComponent(identity.id)}`);
    expect(studioRes.status).toBe(200);
    const studioJson = (await studioRes.json()) as { id: string; config: { driver: string } };
    expect(studioJson.id).toBe(identity.id);
    expect(studioJson.config.driver).toBe("cua");

    // 4. /api/docs (docGroups + readDoc)
    const docsGroupRes = await fetch(`${server.url}/api/docs?lang=zh`);
    expect(docsGroupRes.status).toBe(200);
    const docGroups = (await docsGroupRes.json()) as Array<{ id: string; docs: Array<{ id: string }> }>;
    expect(docGroups.length).toBeGreaterThan(0);
    const firstDocId = docGroups[0]?.docs[0]?.id;
    expect(firstDocId).toBeTruthy();
    const docDetailRes = await fetch(`${server.url}/api/docs?doc=${encodeURIComponent(firstDocId!)}&lang=en`);
    expect(docDetailRes.status).toBe(200);
    const docDetail = (await docDetailRes.json()) as { id: string; html: string };
    expect(docDetail.id).toBe(firstDocId);
    expect(docDetail.html.length).toBeGreaterThan(0);

    // 5. CSRF enforcement, X-Forwarded-Host DNS-rebinding guard, & JSON validation
    const rebindProxiedGet = await fetch(`${server.url}/api/workspaces`, {
      headers: { "X-Forwarded-Host": "evil.attacker.example:3015" },
    });
    expect(rebindProxiedGet.status).toBe(403);

    const nullJsonPut = await fetch(`${server.url}/api/workspaces`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: server.url },
      body: "null",
    });
    expect(nullJsonPut.status).toBe(400);

    const malformedJsonPut = await fetch(`${server.url}/api/workspaces`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: server.url },
      body: "{bad-json",
    });
    expect(malformedJsonPut.status).toBe(400);

    const untrustedPut = await fetch(`${server.url}/api/pet`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: "http://evil.example" },
      body: JSON.stringify({ project: identity.id }),
    });
    expect(untrustedPut.status).toBe(403);
    expect((await untrustedPut.json()).error).toContain("只允许同源控制请求");

    // Mutation with trusted dev proxy Origin succeeds!
    const trustedPut = await fetch(`${server.url}/api/pet`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: trustedDevOrigin },
      body: JSON.stringify({ project: identity.id }),
    });
    expect(trustedPut.status).toBe(200);
    const putReceipt = (await trustedPut.json()) as { target: { project: string; revision: string } };
    expect(putReceipt.target.project).toBe(identity.id);

    // Mutation with same-origin succeeds!
    const petHeartbeat = await fetch(`${server.url}/api/pet`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: server.url },
      body: JSON.stringify({
        instanceId: "desktop-pet-test",
        pid: process.pid,
        revision: putReceipt.target.revision,
        workspace: wsDir,
        runId: null,
        phase: "idle",
        error: null,
      }),
    });
    expect(petHeartbeat.status).toBe(200);

    const petGet = await fetch(`${server.url}/api/pet`);
    expect(petGet.status).toBe(200);
    expect(await petGet.json()).toMatchObject({
      target: { project: identity.id },
      connected: true,
    });

    // 6. /api/replay overview + HTTP Range 206 Partial Content + 416 + HEAD
    const replayOverviewRes = await fetch(
      `${server.url}/api/replay?project=${encodeURIComponent(identity.id)}&run=${encodeURIComponent(runId)}&mode=overview`,
    );
    expect(replayOverviewRes.status).toBe(200);
    const overview = (await replayOverviewRes.json()) as { cycles: Array<{ epoch: string }> };
    expect(overview.cycles.map(c => c.epoch)).toEqual(["ep-1"]);

    const replayMediaUrl = `${server.url}/api/replay?project=${encodeURIComponent(identity.id)}&run=${encodeURIComponent(runId)}&mode=media&id=model-media:3`;
    const rangeRes = await fetch(replayMediaUrl, { headers: { Range: "bytes=2-5" } });
    expect(rangeRes.status).toBe(206);
    expect(rangeRes.headers.get("accept-ranges")).toBe("bytes");
    expect(rangeRes.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(rangeRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await rangeRes.text()).toBe("2345");

    const headRangeRes = await fetch(replayMediaUrl, { method: "HEAD", headers: { Range: "bytes=2-5" } });
    expect(headRangeRes.status).toBe(206);
    expect(headRangeRes.headers.get("content-length")).toBe("4");
    expect(await headRangeRes.text()).toBe("");

    const badRangeRes = await fetch(replayMediaUrl, { headers: { Range: "bytes=50-60" } });
    expect(badRangeRes.status).toBe(416);
    expect(badRangeRes.headers.get("content-range")).toBe("bytes */10");

    // Direct unit check on byteRange + fileResponse edge cases
    expect(() => byteRange("bytes=0-", 0)).toThrow();
    const directMediaResp = await fileResponse(
      new Request("http://127.0.0.1/video", { headers: { Range: "bytes=-3" } }),
      { file: join(timelineVideoDir, "clip.mp4"), mediaType: "video/mp4" },
    );
    expect(directMediaResp.status).toBe(206);
    expect(await directMediaResp.text()).toBe("789");

    // 7. Static SPA serving, immutable _next/static caching, companion subroute, and traversal rejection
    const rootHtml = await fetch(`${server.url}/`);
    expect(rootHtml.status).toBe(200);
    expect(rootHtml.headers.get("content-type")).toContain("text/html");
    expect(rootHtml.headers.get("cache-control")).toBe("no-cache");
    expect(await rootHtml.text()).toContain("Ludens Console");

    const spaFallback = await fetch(`${server.url}/workspaces/some-client-route`);
    expect(spaFallback.status).toBe(200);
    expect(spaFallback.headers.get("cache-control")).toBe("no-cache");
    expect(await spaFallback.text()).toContain("Ludens Console");

    const companionHtml = await fetch(`${server.url}/companion`);
    expect(companionHtml.status).toBe(200);
    expect(await companionHtml.text()).toContain("Companion");

    const nextAsset = await fetch(`${server.url}/_next/static/chunks/app.js`);
    expect(nextAsset.status).toBe(200);
    expect(nextAsset.headers.get("content-type")).toContain("javascript");
    expect(nextAsset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await nextAsset.text()).toContain("ludens-chunk");

    const missingJs = await fetch(`${server.url}/_next/static/chunks/missing.js`);
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

    // 8. POST /api/app-server/shutdown triggers async graceful close after returning { ok: true }
    const shutdownRes = await fetch(`${server.url}/api/app-server/shutdown`, {
      method: "POST",
      headers: { Origin: server.url },
    });
    expect(shutdownRes.status).toBe(200);
    expect(await shutdownRes.json()).toEqual({ ok: true });
    await server.closed;
  } finally {
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

test("CLI ludens app-server --port 0 --parent-watchdog emits JSON handshake and cleans up supervised child tree on stdin EOF", async () => {
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
  const child = spawn(process.execPath, [mainCli, "app-server", "--port", "0", "--parent-watchdog"], {
    cwd: rootDir,
    env: { ...process.env, LUDENS_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let emulatorPid = 0;
  let subchildPid = 0;

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
      url: string;
      host: string;
      port: number;
      pid: number;
      home: string;
    };
    expect(handshake).toEqual({
      ready: true,
      url: `http://127.0.0.1:${handshake.port}`,
      host: "127.0.0.1",
      port: expect.any(Number),
      pid: child.pid!,
      home,
    });
    expect(handshake.port).toBeGreaterThan(0);
    expect(handshake.port).not.toBe(3015);

    // 2. Trigger workspace up via HTTP PUT /api/workspaces (workspaceServiceControl).
    // Even though ludens.json has dashboard:true, pet:true, WorkspaceSupervisor forces dashboard:false, pet:false
    // and binds the spawned emulator job to this app-server's lifecycle!
    const upRes = await fetch(`${handshake.url}/api/workspaces`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: handshake.url },
      body: JSON.stringify({
        action: "workspaceServiceControl",
        id: wsIdentity.id,
        service: { operation: "up" },
      }),
    });
    expect(upRes.status).toBe(200);

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

    const healthDuring = await (await fetch(`${handshake.url}/api/health`)).json();
    expect(healthDuring.managedWorkspaces).toEqual([wsIdentity.id]);

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
