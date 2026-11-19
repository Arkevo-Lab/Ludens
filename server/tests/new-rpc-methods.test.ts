import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_RPC_ERROR_CODES, type LudensServerEvent } from "@ludens/protocol/app-rpc";
import { ensureWorkspaceIdentity, registerWorkspace } from "@ludens/protocol/ludens";
import { JsonArchive } from "@ludens/protocol/log-archive";
import { adaptWorkspaceCapabilityEval } from "../src/query/capabilities.ts";
import { DEFAULT_LOG_EVENTS_LIMIT, queryRunLogEvents } from "../src/query/logs.ts";
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
    } finally {
      await remote.close().catch(() => {});
      await uds.close().catch(() => {});
      await server.close({ emergency: true });
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});
