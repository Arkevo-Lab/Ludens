import { describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { APP_RPC_ERROR_CODES, type LudensServerEvent } from "@ludens/protocol/app-rpc";
import { ensureWorkspaceIdentity, registerWorkspace } from "@ludens/protocol/ludens";
import { JsonArchive } from "@ludens/protocol/log-archive";
import { adaptWorkspaceCapabilityEval } from "../src/query/capabilities.ts";
import { clearLogEventHorizons, DEFAULT_LOG_EVENTS_LIMIT, queryRunLogEvents } from "../src/query/logs.ts";
import { resolveRepoRoot } from "../src/query/repo.ts";
import { PRESERVED_ENV_KEYS, startBackgroundJob, stopBackgroundJob } from "../src/daemon/process-manager.ts";
import { WorkspaceSupervisor } from "../src/daemon/supervisor.ts";
import { AppRpcClientError, NodeUdsRpcClient, WsAppRpcClient } from "../src/daemon/app-rpc-client.ts";
import { startAppServer } from "../src/server/app-server.ts";

async function waitForEvent(
  events: LudensServerEvent[],
  predicate: (event: LudensServerEvent) => boolean,
  timeoutMs = 3000,
): Promise<LudensServerEvent> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = events.find(predicate);
    if (found) return found;
    await Bun.sleep(20);
  }
  throw new Error("Timed out waiting for expected EventHub notification");
}

describe("new pure-RPC control plane methods", () => {
  test("capabilities/eval, evalHistory, evalAdapt publish workspace events and persist records", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ludens-rpc-eval-")));
    const home = join(root, "home");
    const workspace = join(root, "ws");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "ludens.json"), JSON.stringify({ driver: "cua" }), "utf8");
    const identity = await ensureWorkspaceIdentity(workspace);
    await registerWorkspace(workspace, home);

    await writeFile(
      join(workspace, "skills_cap.py"),
      `from ludens_tools import capability, eval_capability

@capability
def score(x: int = 1):
    """Compute a test score."""
    return {"data": {"value": x + 1}}

@eval_capability(score)
def eval_score():
    """Verify score returns x + 1."""
    res = score(2)
    return {"pass_rate": 1.0 if res["data"]["value"] == 3 else 0.0}
`,
      "utf8",
    );

    const server = await startAppServer({ home });
    const client = new NodeUdsRpcClient({ socketPath: server.socketPath! });
    const received: LudensServerEvent[] = [];
    client.onEvent(event => received.push(event));

    try {
      await client.connect();
      await client.call("events/subscribe", { topics: ["workspace"], workspaceId: identity.id });

      const evalRes = await client.call("capabilities/eval", {
        project: identity.id,
        workspace,
        options: { capabilityId: "python/skills_cap.py:score" },
      });
      expect(evalRes.run.outcome).toBe("passed");
      await waitForEvent(received, ev => ev.topic === "workspace" && ev.workspaceId === identity.id && ev.payload?.action === "capabilityEval");

      const hist1 = await client.call("capabilities/evalHistory", {
        project: identity.id,
        workspace,
        capabilityId: "python/skills_cap.py:score",
        limit: 5,
      });
      expect(hist1.runs.length).toBeGreaterThanOrEqual(1);
      expect(hist1.runs[0]?.outcome).toBe("passed");

      const adapted = await client.call("capabilities/evalAdapt", {
        project: identity.id,
        workspace,
        capabilityId: "python/skills_cap.py:score",
        reason: "Need real counterexample coverage",
        records: ["rec-101"],
      });
      expect(adapted.evalStatus).toBe("adapting");
      expect(adapted.adaptation?.reason).toBe("Need real counterexample coverage");
      expect(adapted.adaptation?.records).toEqual(["rec-101"]);
      await waitForEvent(received, ev => ev.topic === "workspace" && ev.workspaceId === identity.id && ev.payload?.action === "capabilityEvalAdapt");

      const hist2 = await client.call("capabilities/evalHistory", {
        project: identity.id,
        workspace,
        limit: 10,
      });
      expect(hist2.runs.length).toBeGreaterThanOrEqual(2);

      // limit > 500 must be rejected with INVALID_PARAMS (-32602)
      let limitErr: unknown;
      try {
        await client.call("capabilities/evalHistory", {
          project: identity.id,
          workspace,
          limit: 501,
        });
      } catch (err) {
        limitErr = err;
      }
      expect(limitErr).toBeInstanceOf(AppRpcClientError);
      expect((limitErr as AppRpcClientError).code).toBe(APP_RPC_ERROR_CODES.INVALID_PARAMS);

      // Aborted signal prevents adaptWorkspaceCapabilityEval from writing any record
      const abortController = new AbortController();
      abortController.abort(new Error("cancelled"));
      await expect(
        adaptWorkspaceCapabilityEval(
          identity.id,
          workspace,
          { capabilityId: "python/skills_cap.py:score", reason: "Should not persist" },
          home,
          abortController.signal,
        ),
      ).rejects.toThrow("cancelled");
      const histAfterAbort = await client.call("capabilities/evalHistory", {
        project: identity.id,
        workspace,
        limit: 10,
      });
      expect(histAfterAbort.runs.length).toBe(hist2.runs.length);
    } finally {
      await client.close().catch(() => {});
      await server.close({ emergency: true });
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("workspaces/import, workspaces/mutate open.newId, and logs/{events,read} enforce remote capability boundaries", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ludens-rpc-import-logs-")));
    const home = join(root, "home");
    const wsImport = join(root, "ws-import");
    const wsLogs = join(root, "ws-logs");
    const runDir = join(wsLogs, "logs", "run-alpha");
    await mkdir(wsImport, { recursive: true });
    await mkdir(runDir, { recursive: true });

    await writeFile(join(wsImport, "ludens.json"), JSON.stringify({ driver: "cua" }), "utf8");
    await writeFile(join(wsLogs, "ludens.json"), JSON.stringify({ driver: "cua" }), "utf8");
    const logsIdentity = await ensureWorkspaceIdentity(wsLogs);
    await registerWorkspace(wsLogs, home);

    const archive = new JsonArchive(wsLogs);
    const ref = archive.write({ message: "hello archived artifact", answer: 42 });
    await writeFile(
      join(runDir, "manifest.json"),
      JSON.stringify({ runId: "run-alpha", workspace: wsLogs, workspaceId: logsIdentity.id }),
      "utf8",
    );
    await writeFile(
      join(runDir, "events.jsonl"),
      [
        JSON.stringify({ seq: 1, at: "2026-11-19T00:00:00Z", atMs: 1000, type: "run_start", data: { workspace: wsLogs } }),
        JSON.stringify({ seq: 2, at: "2026-11-19T00:00:01Z", atMs: 2000, type: "model_request", data: { payload: ref } }),
        JSON.stringify({ seq: 3, at: "2026-11-19T00:00:02Z", atMs: 3000, type: "run_end", data: { mode: "manual" } }),
      ].join("\n") + "\n",
      "utf8",
    );

    const token = "rpc-test-token";
    const server = await startAppServer({
      home,
      wsListen: { host: "127.0.0.1", port: 0 },
      auth: { mode: "token", token },
    });
    const uds = new NodeUdsRpcClient({ socketPath: server.socketPath! });
    const remote = new WsAppRpcClient({ url: server.wsUrl!, token });

    try {
      await uds.connect();
      await remote.connect();

      // 1. workspaces/import succeeds over local UDS, blocked over remote WS
      await expect(remote.call("workspaces/import", { workspace: wsImport })).rejects.toThrow(AppRpcClientError);
      const imported = await uds.call("workspaces/import", { workspace: wsImport });
      expect(imported.workspace).toBe(wsImport);
      expect(imported.id).toBeTruthy();

      // 2. workspaces/mutate open with newId renews workspace identity over UDS
      const oldId = imported.id;
      const renewed = (await uds.call("workspaces/mutate", {
        action: "open",
        workspace: wsImport,
        newId: true,
      })) as { id: string; workspace: string };
      expect(renewed.workspace).toBe(wsImport);
      expect(renewed.id).not.toBe(oldId);

      // 3. logs/events with pagination works over remote WS when scoped to project + runId
      const page1 = await remote.call("logs/events", {
        project: logsIdentity.id,
        run: "run-alpha",
        limit: 2,
      });
      expect(page1.events).toHaveLength(2);
      expect(page1.hasMore).toBe(true);
      expect(page1.nextCursor).toBe(2);

      const page2 = await remote.call("logs/events", {
        project: logsIdentity.id,
        run: "run-alpha",
        cursor: page1.nextCursor!,
        limit: 2,
      });
      expect(page2.events).toHaveLength(1);
      expect(page2.hasMore).toBe(false);
      expect(page2.nextCursor).toBeNull();

      // 4. logs/read works by eventSeq+field and by reference over remote WS when scoped to project + runId
      const byEvent = await remote.call("logs/read", {
        project: logsIdentity.id,
        run: "run-alpha",
        eventSeq: 2,
        field: "payload",
      });
      expect(byEvent.value).toEqual({ message: "hello archived artifact", answer: 42 });

      const byRef = await remote.call("logs/read", {
        project: logsIdentity.id,
        run: "run-alpha",
        reference: ref,
      });
      expect(byRef.value).toEqual({ message: "hello archived artifact", answer: 42 });

      // 5. Remote WS is blocked from reading arbitrary host run paths without project scoping
      await expect(remote.call("logs/events", { run: runDir })).rejects.toThrow(AppRpcClientError);
      await expect(remote.call("logs/read", { run: runDir, reference: ref })).rejects.toThrow(AppRpcClientError);

      // 6. Local UDS (localFsPaths: true) CAN read by direct runDir path
      const localEvents = await uds.call("logs/events", { run: runDir });
      expect(localEvents.events).toHaveLength(3);
      const localRead = await uds.call("logs/read", { run: runDir, reference: ref });
      expect(localRead.value).toEqual({ message: "hello archived artifact", answer: 42 });
      expect(await readFile(join(runDir, "manifest.json"), "utf8")).toContain("run-alpha");

      // 7. logs/events enforces hard limit ceiling (1000) via INVALID_PARAMS (-32602)
      let logsLimitErr: unknown;
      try {
        await remote.call("logs/events", {
          project: logsIdentity.id,
          run: "run-alpha",
          limit: 1001,
        });
      } catch (err) {
        logsLimitErr = err;
      }
      expect(logsLimitErr).toBeInstanceOf(AppRpcClientError);
      expect((logsLimitErr as AppRpcClientError).code).toBe(APP_RPC_ERROR_CODES.INVALID_PARAMS);

      // 8. logs/events defaults to DEFAULT_LOG_EVENTS_LIMIT (200) and honors AbortSignal
      const bigRunDir = join(wsLogs, "logs", "run-big");
      await mkdir(bigRunDir, { recursive: true });
      await writeFile(
        join(bigRunDir, "manifest.json"),
        JSON.stringify({ runId: "run-big", workspace: wsLogs, workspaceId: logsIdentity.id }),
        "utf8",
      );
      const manyLines = Array.from({ length: DEFAULT_LOG_EVENTS_LIMIT + 5 }, (_, idx) =>
        JSON.stringify({ seq: idx + 1, at: "2026-11-19T00:00:00Z", atMs: 1000 + idx, type: "tick", data: { idx } }),
      );
      await writeFile(join(bigRunDir, "events.jsonl"), manyLines.join("\n") + "\n", "utf8");
      const defaultPage = await queryRunLogEvents({ run: bigRunDir }, { allowHostPath: true, root: home });
      expect(defaultPage.events).toHaveLength(DEFAULT_LOG_EVENTS_LIMIT);
      expect(defaultPage.hasMore).toBe(true);
      expect(defaultPage.nextCursor).toBe(DEFAULT_LOG_EVENTS_LIMIT);

      const abortedLogs = new AbortController();
      abortedLogs.abort(new Error("aborted log read"));
      await expect(
        queryRunLogEvents({ run: bigRunDir }, { allowHostPath: true, root: home, signal: abortedLogs.signal }),
      ).rejects.toThrow("aborted log read");

      // 9. run/stop rejects non-string epoch with INVALID_PARAMS (-32602)
      let badEpochErr: unknown;
      try {
        await uds.call("run/stop", {
          project: logsIdentity.id,
          run: "run-alpha",
          epoch: 123 as unknown as string,
        });
      } catch (err) {
        badEpochErr = err;
      }
      expect(badEpochErr).toBeInstanceOf(AppRpcClientError);
      expect((badEpochErr as AppRpcClientError).code).toBe(APP_RPC_ERROR_CODES.INVALID_PARAMS);
      expect((badEpochErr as AppRpcClientError).message).toContain("run/stop requires optional string epoch");
    } finally {
      await remote.close().catch(() => {});
      await uds.close().catch(() => {});
      await server.close({ emergency: true });
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("logs/events pins a stable file horizon across pages despite interleaved appends", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ludens-logs-horizon-")));
    const runDir = join(root, "run");
    const sourceRoot = join(root, "baseware-src");
    const sourceEventsDir = join(sourceRoot, "events");
    await mkdir(runDir, { recursive: true });
    await mkdir(sourceEventsDir, { recursive: true });
    try {
      clearLogEventHorizons();
      await writeFile(
        join(sourceRoot, "source.json"),
        JSON.stringify({ sourceId: "dev-1", format: "baseware-events-v1" }),
        "utf8",
      );
      const sourceFile = join(sourceEventsDir, "0001.jsonl");
      await writeFile(
        sourceFile,
        JSON.stringify({
          serviceId: "dev-1",
          seq: 1,
          at: "2026-11-19T00:00:01.500Z",
          trace: { recordingId: "rec-1" },
          type: "device_frame",
          data: { tag: "dev-1" },
        }) + "\n",
        "utf8",
      );
      await writeFile(
        join(runDir, "manifest.json"),
        JSON.stringify({
          runId: "run",
          eventSources: [
            {
              sourceId: "dev-1",
              root: sourceRoot,
              format: "baseware-events-v1",
              recordingId: "rec-1",
              windows: [{ afterSeq: 0 }],
            },
          ],
        }),
        "utf8",
      );
      const localEvents = join(runDir, "events.jsonl");
      await writeFile(
        localEvents,
        [
          JSON.stringify({ seq: 1, at: "2026-11-19T00:00:01.000Z", type: "local", data: { tag: "l1" } }),
          JSON.stringify({ seq: 2, at: "2026-11-19T00:00:02.000Z", type: "local", data: { tag: "l2" } }),
          JSON.stringify({ seq: 3, at: "2026-11-19T00:00:03.000Z", type: "local", data: { tag: "l3" } }),
        ].join("\n") + "\n",
        "utf8",
      );

      // Page 1 captures the file-size horizon: [l1 (1.0s), dev-1 (1.5s)]
      const p1 = await queryRunLogEvents({ run: runDir, cursor: 0, limit: 2 }, { allowHostPath: true });
      expect(p1.events.map(e => (e.data as { tag: string }).tag)).toEqual(["l1", "dev-1"]);
      expect(p1.hasMore).toBe(true);
      expect(p1.nextCursor).toBe(2);

      // Between pages, append an earlier-timestamp device event AND a new tail local event.
      await appendFile(
        sourceFile,
        JSON.stringify({
          serviceId: "dev-1",
          seq: 2,
          at: "2026-11-19T00:00:01.200Z",
          trace: { recordingId: "rec-1" },
          type: "device_frame",
          data: { tag: "dev-late" },
        }) + "\n",
        "utf8",
      );
      await appendFile(
        localEvents,
        JSON.stringify({ seq: 4, at: "2026-11-19T00:00:04.000Z", type: "local", data: { tag: "l4" } }) + "\n",
        "utf8",
      );

      // Concurrent Reader B starts at cursor=0 and finishes (!hasMore) while Reader A is mid-pagination:
      // it shares Reader A's active horizon and never clobbers or deletes it.
      const concurrentB = await queryRunLogEvents({ run: runDir, cursor: 0, limit: 10 }, { allowHostPath: true });
      expect(concurrentB.events.map(e => (e.data as { tag: string }).tag)).toEqual(["l1", "dev-1", "l2", "l3"]);
      expect(concurrentB.hasMore).toBe(false);

      // Page 2 stays pinned to the Page 1 horizon: returns [l2, l3] without shifting or duplicating dev-1.
      const p2 = await queryRunLogEvents({ run: runDir, cursor: p1.nextCursor!, limit: 2 }, { allowHostPath: true });
      expect(p2.events.map(e => (e.data as { tag: string }).tag)).toEqual(["l2", "l3"]);
      expect(p2.hasMore).toBe(false);
      expect(p2.nextCursor).toBeNull();

      // Retrying Page 2 after !hasMore still sees the intact cached horizon.
      const p2Retry = await queryRunLogEvents({ run: runDir, cursor: p1.nextCursor!, limit: 2 }, { allowHostPath: true });
      expect(p2Retry.events.map(e => (e.data as { tag: string }).tag)).toEqual(["l2", "l3"]);

      // A fresh cursor=0 read after active readers finish captures the updated horizon and sees all 6 events.
      const fresh = await queryRunLogEvents({ run: runDir, cursor: 0, limit: 10 }, { allowHostPath: true });
      expect(fresh.events.map(e => (e.data as { tag: string }).tag)).toEqual([
        "l1",
        "dev-1",
        "dev-late",
        "l2",
        "l3",
        "l4",
      ]);
      expect(fresh.hasMore).toBe(false);
    } finally {
      clearLogEventHorizons();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("resolveRepoRoot and WorkspaceSupervisor locate packaged Resources/server/main.js and honor LUDENS_REPO_ROOT", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ludens-packaged-repo-")));
    const resources = join(root, "Resources");
    await mkdir(join(resources, "core"), { recursive: true });
    await mkdir(join(resources, "server"), { recursive: true });
    await writeFile(join(resources, "core", "package.json"), JSON.stringify({ name: "@ludens/core" }), "utf8");
    await writeFile(join(resources, "server", "package.json"), JSON.stringify({ name: "@ludens/server" }), "utf8");
    const prevEnv = process.env.LUDENS_REPO_ROOT;
    try {
      const bundledUrl = new URL(`file://${join(resources, "server", "main.js")}`).href;
      expect(resolveRepoRoot(bundledUrl, {}, root)).toBe(resources);

      process.env.LUDENS_REPO_ROOT = resources;
      expect(resolveRepoRoot(import.meta.url, process.env, root)).toBe(resources);
      const supervisor = new WorkspaceSupervisor({ home: join(root, "home") });
      expect(supervisor.repo).toBe(resources);
    } finally {
      if (prevEnv === undefined) delete process.env.LUDENS_REPO_ROOT;
      else process.env.LUDENS_REPO_ROOT = prevEnv;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("LUDENS_BUN is preserved in background jobs and respected by Windows .cmd launchers", async () => {
    expect(PRESERVED_ENV_KEYS).toContain("LUDENS_BUN");
    const repoRoot = resolve(import.meta.dir, "../..");
    for (const rel of ["baseware/bin/baseware.cmd", "core/bin/ludens-core.cmd", "server/bin/ludens-server.cmd"]) {
      const content = await readFile(join(repoRoot, rel), "utf8");
      expect(content).toContain("if defined LUDENS_BUN");
      expect(content).toContain('"%LUDENS_BUN%"');
      expect(content.trim().endsWith("exit /b %ERRORLEVEL%")).toBe(true);
    }

    if (process.platform !== "win32") {
      const root = await realpath(await mkdtemp(join(tmpdir(), "ludens-bun-env-")));
      const prevLudensBun = process.env.LUDENS_BUN;
      const customBun = "/custom/non-path/bin/bun";
      process.env.LUDENS_BUN = customBun;
      let stateFile: string | undefined;
      try {
        const started = await startBackgroundJob({
          name: "env-check",
          cwd: root,
          command: ["/bin/sh", "-c", 'printf "LUDENS_BUN=%s\\n" "$LUDENS_BUN"; sleep 5'],
        });
        stateFile = started.stateFile;
        const deadline = Date.now() + 3000;
        let logText = "";
        while (Date.now() < deadline) {
          logText = await readFile(started.log, "utf8").catch(() => "");
          if (logText.includes("LUDENS_BUN=")) break;
          await Bun.sleep(25);
        }
        expect(logText).toContain(`LUDENS_BUN=${customBun}`);
      } finally {
        if (stateFile) await stopBackgroundJob(stateFile, { immediate: true }).catch(() => {});
        if (prevLudensBun === undefined) delete process.env.LUDENS_BUN;
        else process.env.LUDENS_BUN = prevLudensBun;
        await rm(root, { recursive: true, force: true });
      }
    }
  });
});
