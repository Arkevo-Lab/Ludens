import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppRpcMethod, AppRpcParams, AppRpcResult } from "@ludens/protocol/app-rpc";
import { NodeUdsRpcClient, type AppRpcClient } from "../cli/app-rpc-client.ts";
import { runCli } from "../cli/main.ts";
import {
  extractRemoteArgs,
  resolveLocalLudensServerCommand,
  withOperatorRpc,
} from "../cli/operator-rpc.ts";

interface RecordedCall {
  method: AppRpcMethod;
  params: unknown;
}

function createMockRpcClient(
  handler: (method: AppRpcMethod, params: unknown) => unknown,
): { client: AppRpcClient & { connect: () => Promise<void> }; calls: RecordedCall[]; closed: () => boolean } {
  const calls: RecordedCall[] = [];
  let isClosed = false;
  const client: AppRpcClient & { connect: () => Promise<void> } = {
    async connect() {},
    async initialize() {
      return {} as AppRpcResult<"initialize">;
    },
    async call<M extends AppRpcMethod>(method: M, params?: AppRpcParams<M>) {
      calls.push({ method, params });
      return handler(method, params) as AppRpcResult<M>;
    },
    onEvent() {
      return () => {};
    },
    async close() {
      isClosed = true;
    },
  };
  return { client, calls, closed: () => isClosed };
}

const DEFAULT_SETTINGS = {
  home: "/tmp/ludens-test",
  config: {
    workspaceRoot: "/tmp/workspaces",
    defaults: {
      model: "openai-codex/gpt-6.2-sol",
      seconds: 300,
      requests: 50,
      dashboard: true,
      pet: false,
      connection: { openaiWebsockets: "auto" },
    },
  },
  workspaces: [
    {
      id: "ws-alpha",
      name: "alpha",
      workspace: "/tmp/workspaces/alpha",
      createdAt: "2026-11-19T00:00:00.000Z",
    },
  ],
};

test("ludens config show and set route 100% through workspaces RPC", async () => {
  const { client, calls } = createMockRpcClient(method => {
    if (method === "workspaces/getSettings") return DEFAULT_SETTINGS;
    if (method === "workspaces/mutate") return { ok: true };
    throw new Error(`Unexpected RPC: ${method}`);
  });

  const outputs: string[] = [];
  const code1 = await runCli(["config", "show"], {
    env: { LUDENS_HOME: "/tmp/ludens-test" },
    rpcOptions: { createUdsClient: () => client },
    out: line => outputs.push(line),
  });
  assert.equal(code1, 0);
  assert.equal(JSON.parse(outputs[0]!).workspaceRoot, "/tmp/workspaces");

  const code2 = await runCli(["config", "set", "defaults.seconds", "600"], {
    env: { LUDENS_HOME: "/tmp/ludens-test" },
    rpcOptions: { createUdsClient: () => client },
    out: () => {},
  });
  assert.equal(code2, 0);
  assert.deepEqual(calls.at(-1), {
    method: "workspaces/mutate",
    params: { action: "updateGlobalDefaults", defaults: { seconds: 600 } },
  });

  const code3 = await runCli(["config", "set", "defaults.connection.imageUrls.enabled", "true"], {
    env: { LUDENS_HOME: "/tmp/ludens-test" },
    rpcOptions: { createUdsClient: () => client },
    out: () => {},
  });
  assert.equal(code3, 0);
  assert.deepEqual(calls.at(-1), {
    method: "workspaces/mutate",
    params: {
      action: "updateGlobalConnection",
      connection: { openaiWebsockets: "auto", imageUrls: { enabled: true } },
    },
  });
});

test("ludens workspace lifecycle & import route through pure RPC", async () => {
  const { client, calls } = createMockRpcClient(method => {
    if (method === "workspaces/getSettings") return DEFAULT_SETTINGS;
    if (method === "workspaces/mutate") return { id: "ws-new", workspace: "/tmp/workspaces/demo" };
    if (method === "workspaces/import") {
      return {
        id: "ws-imported",
        workspace: "/tmp/old-ws",
        import: { copiedSessions: 2, importedSkills: 1 },
      };
    }
    if (method === "workspaces/getStudio") return { services: [] };
    if (method === "workspaces/serviceControl") {
      return { ok: true, exitCode: 0, stdout: "started", stderr: "", studio: {} };
    }
    throw new Error(`Unexpected RPC: ${method}`);
  });
  const rpcOptions = { createUdsClient: () => client };
  const env = { LUDENS_HOME: "/tmp/ludens-test" };

  // init
  await runCli(["workspace", "init", "--name", "demo", "--driver", "cua"], {
    env,
    rpcOptions,
    out: () => {},
  });
  assert.deepEqual(calls.at(-1), {
    method: "workspaces/mutate",
    params: { action: "create", input: { name: "demo", driver: "cua" } },
  });

  // open --new-id
  await runCli(["workspace", "open", "/tmp/workspaces/copy", "--new-id"], {
    env,
    rpcOptions,
    out: () => {},
  });
  assert.deepEqual(calls.at(-1), {
    method: "workspaces/mutate",
    params: { action: "open", workspace: "/tmp/workspaces/copy", newId: true },
  });

  // import
  await runCli(
    [
      "workspace",
      "import",
      "/tmp/old-ws",
      "--legacy-state",
      "/tmp/legacy",
      "--previous-workspace",
      "/tmp/prev-ws",
    ],
    { env, rpcOptions, out: () => {} },
  );
  assert.deepEqual(calls.at(-1), {
    method: "workspaces/import",
    params: {
      workspace: "/tmp/old-ws",
      legacyStateDir: "/tmp/legacy",
      previousWorkspace: "/tmp/prev-ws",
    },
  });

  // up / down / services
  await runCli(["workspace", "up", "--preempt", "--services", "baseware,core"], {
    env,
    rpcOptions,
    out: () => {},
  });
  assert.deepEqual(calls.at(-1), {
    method: "workspaces/serviceControl",
    params: {
      workspaceId: "ws-alpha",
      action: "up",
      services: ["baseware", "core"],
      preempt: true,
    },
  });

  await runCli(["workspace", "down", "--keep-emulator"], {
    env,
    rpcOptions,
    out: () => {},
  });
  assert.deepEqual(calls.at(-1), {
    method: "workspaces/serviceControl",
    params: {
      workspaceId: "ws-alpha",
      action: "down",
      keepEmulator: true,
    },
  });

  await runCli(["workspace", "services"], { env, rpcOptions, out: () => {} });
  assert.deepEqual(calls.at(-1), {
    method: "workspaces/getStudio",
    params: { workspaceId: "ws-alpha" },
  });
});

test("ludens workspace eval supports list, run, shorthand <id>, history, and adapt over RPC", async () => {
  let evalOutcome: "passed" | "failed" = "passed";
  const { client, calls } = createMockRpcClient(method => {
    if (method === "workspaces/getSettings") return DEFAULT_SETTINGS;
    if (method === "capabilities/get") return { capabilities: [], evals: [] };
    if (method === "capabilities/eval") {
      return { run: { outcome: evalOutcome, results: [] }, catalog: { capabilities: [] } };
    }
    if (method === "capabilities/evalHistory") return { runs: [{ runId: "eval-1" }] };
    if (method === "capabilities/evalAdapt") {
      return { capabilityId: "python/nav.py:walk", evalStatus: "adapting" };
    }
    throw new Error(`Unexpected RPC: ${method}`);
  });
  const rpcOptions = { createUdsClient: () => client };
  const env = { LUDENS_HOME: "/tmp/ludens-test" };

  assert.equal(
    await runCli(["workspace", "eval", "list"], { env, rpcOptions, out: () => {} }),
    0,
  );
  assert.deepEqual(calls.at(-1), {
    method: "capabilities/get",
    params: { project: "ws-alpha", workspace: "/tmp/workspaces/alpha" },
  });

  assert.equal(
    await runCli(["workspace", "eval", "run", "--all"], { env, rpcOptions, out: () => {} }),
    0,
  );
  assert.deepEqual(calls.at(-1), {
    method: "capabilities/eval",
    params: {
      project: "ws-alpha",
      workspace: "/tmp/workspaces/alpha",
      options: { all: true },
    },
  });

  evalOutcome = "failed";
  assert.equal(
    await runCli(["workspace", "eval", "python/nav.py:walk"], { env, rpcOptions, out: () => {} }),
    1,
  );
  assert.deepEqual(calls.at(-1), {
    method: "capabilities/eval",
    params: {
      project: "ws-alpha",
      workspace: "/tmp/workspaces/alpha",
      options: { capabilityId: "python/nav.py:walk" },
    },
  });

  assert.equal(
    await runCli(["workspace", "eval", "history", "python/nav.py:walk", "--limit", "5"], {
      env,
      rpcOptions,
      out: () => {},
    }),
    0,
  );
  assert.deepEqual(calls.at(-1), {
    method: "capabilities/evalHistory",
    params: {
      project: "ws-alpha",
      workspace: "/tmp/workspaces/alpha",
      capabilityId: "python/nav.py:walk",
      limit: 5,
    },
  });

  assert.equal(
    await runCli(
      [
        "workspace",
        "eval",
        "adapt",
        "python/nav.py:walk",
        "--reason",
        "contract updated",
        "--record",
        "rec-1",
        "--record",
        "rec-2",
      ],
      { env, rpcOptions, out: () => {} },
    ),
    0,
  );
  assert.deepEqual(calls.at(-1), {
    method: "capabilities/evalAdapt",
    params: {
      project: "ws-alpha",
      workspace: "/tmp/workspaces/alpha",
      capabilityId: "python/nav.py:walk",
      reason: "contract updated",
      records: ["rec-1", "rec-2"],
    },
  });
});

test("ludens top-level remote control shortcuts route over runtime/control and run/stop RPC", async () => {
  const { client, calls } = createMockRpcClient(method => {
    if (method === "workspaces/getSettings") return DEFAULT_SETTINGS;
    if (method === "runtime/control") return { mode: "auto", model: "openai-codex/gpt-6.2-sol" };
    if (method === "catalog/get") {
      return [{ id: "ws-alpha", runs: [{ id: "run-9", epoch: "ep-1" }] }];
    }
    if (method === "run/stop") return { ok: true };
    throw new Error(`Unexpected RPC: ${method}`);
  });
  const rpcOptions = { createUdsClient: () => client };
  const env = { LUDENS_HOME: "/tmp/ludens-test" };

  await runCli(["status"], { env, rpcOptions, out: () => {} });
  assert.deepEqual(calls.at(-1), {
    method: "runtime/control",
    params: { project: "ws-alpha", workspace: "/tmp/workspaces/alpha", command: { action: "status" } },
  });

  await runCli(["auto", "on", "--message", "explore", "--seconds", "120", "--preempt"], {
    env,
    rpcOptions,
    out: () => {},
  });
  assert.deepEqual(calls.at(-1), {
    method: "runtime/control",
    params: {
      project: "ws-alpha",
      workspace: "/tmp/workspaces/alpha",
      command: { action: "auto_on", message: "explore", seconds: 120 },
      preempt: true,
    },
  });

  await runCli(["steer", "check", "inventory"], { env, rpcOptions, out: () => {} });
  assert.deepEqual(calls.at(-1), {
    method: "runtime/control",
    params: {
      project: "ws-alpha",
      workspace: "/tmp/workspaces/alpha",
      command: { action: "steer", message: "check inventory" },
    },
  });

  await runCli(["consolidate", "--seconds", "45"], { env, rpcOptions, out: () => {} });
  assert.deepEqual(calls.at(-1), {
    method: "runtime/control",
    params: {
      project: "ws-alpha",
      workspace: "/tmp/workspaces/alpha",
      command: { action: "consolidate", seconds: 45 },
    },
  });

  await runCli(["model", "openai-codex/gpt-6.2-sol", "--effort", "high", "--service-tier", "none"], {
    env,
    rpcOptions,
    out: () => {},
  });
  assert.deepEqual(calls.at(-1), {
    method: "runtime/control",
    params: {
      project: "ws-alpha",
      workspace: "/tmp/workspaces/alpha",
      command: {
        action: "set_model",
        model: "openai-codex/gpt-6.2-sol",
        serviceTier: null,
        effort: "high",
      },
    },
  });

  await runCli(["stop"], { env, rpcOptions, out: () => {} });
  assert.deepEqual(calls.at(-1), {
    method: "run/stop",
    params: { project: "ws-alpha", run: "run-9", epoch: "ep-1" },
  });
});

test("ludens logs events paginates over logs/events RPC and logs read supports --file and --event over logs/read RPC", async () => {
  let pageCalls = 0;
  const { client, calls } = createMockRpcClient((method, params) => {
    if (method === "workspaces/getSettings") return DEFAULT_SETTINGS;
    if (method === "logs/events") {
      pageCalls++;
      if (pageCalls === 1) {
        return { events: [{ seq: 1, type: "run_start" }], nextCursor: 1, hasMore: true };
      }
      return { events: [{ seq: 2, type: "run_end" }], nextCursor: null, hasMore: false };
    }
    if (method === "logs/read") {
      return { value: { restored: true, params } };
    }
    throw new Error(`Unexpected RPC: ${method}`);
  });
  const rpcOptions = { createUdsClient: () => client };
  const env = { LUDENS_HOME: "/tmp/ludens-test" };

  const lines: string[] = [];
  await runCli(["logs", "events", "--run", "2026-11-19T00-00-00", "--diagnostics"], {
    env,
    rpcOptions,
    out: line => lines.push(line),
  });
  assert.deepEqual(
    lines.map(l => JSON.parse(l)),
    [
      { seq: 1, type: "run_start" },
      { seq: 2, type: "run_end" },
    ],
  );
  assert.equal(pageCalls, 2);

  const dir = await mkdtemp(join(tmpdir(), "ludens-cli-logs-"));
  try {
    const refFile = join(dir, "ref.json");
    await writeFile(refFile, JSON.stringify({ sha256: "abc123", path: "artifacts/1.json" }));
    const outFile: string[] = [];
    await runCli(["logs", "read", "--run", "2026-11-19T00-00-00", "--file", refFile, "--full"], {
      env,
      rpcOptions,
      out: line => outFile.push(line),
    });
    assert.deepEqual(calls.at(-1), {
      method: "logs/read",
      params: {
        project: "ws-alpha",
        workspace: "/tmp/workspaces/alpha",
        run: "2026-11-19T00-00-00",
        reference: { sha256: "abc123", path: "artifacts/1.json" },
        media: "full",
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  await runCli(
    ["logs", "read", "--run", "2026-11-19T00-00-00", "--event", "7", "--field", "payload"],
    { env, rpcOptions, out: () => {} },
  );
  assert.deepEqual(calls.at(-1), {
    method: "logs/read",
    params: {
      project: "ws-alpha",
      workspace: "/tmp/workspaces/alpha",
      run: "2026-11-19T00-00-00",
      eventSeq: 7,
      field: "payload",
      media: "reference",
    },
  });
});

test("legacy top-level commands (daemon, app-server, serve, run, init, up, down, eval) are rejected", async () => {
  for (const legacy of ["daemon", "app-server", "serve", "run", "init", "up", "down", "eval"]) {
    await assert.rejects(
      () => runCli([legacy], { env: { LUDENS_HOME: "/tmp/ludens-test" } }),
      /Unknown command/,
      `Expected legacy command '${legacy}' to be rejected`,
    );
  }
});

test("withOperatorRpc wakes up local ludens-server on demand when socket is unavailable, and fails clearly if not installed", async () => {
  let connectAttempts = 0;
  let startedSpec: { command: string; argsPrefix: string[] } | null = null;
  const { client } = createMockRpcClient(() => ({ ok: true }));

  const result = await withOperatorRpc(
    {
      home: "/tmp/ludens-wakeup-test",
      env: { PATH: "/opt/ludens/bin" },
      platform: "darwin",
      exists: p => p === "/opt/ludens/bin/ludens-server",
      createUdsClient: () => {
        connectAttempts++;
        if (connectAttempts === 1) {
          return {
            ...client,
            async connect() {
              const err = new Error("connect ENOENT") as NodeJS.ErrnoException;
              err.code = "ENOENT";
              throw err;
            },
          };
        }
        return client;
      },
      startLocalServer: async (_home, spec) => {
        startedSpec = spec;
      },
    },
    async (_rpc, mode) => mode,
  );

  assert.equal(result, "uds");
  assert.equal(connectAttempts, 2);
  assert.deepEqual(startedSpec, { command: "/opt/ludens/bin/ludens-server", argsPrefix: [] });

  // When ludens-server is not installed anywhere, throw a clear error directing user to install/start or pass --remote.
  await assert.rejects(
    () =>
      withOperatorRpc(
        {
          home: "/tmp/ludens-missing-server-test",
          env: { PATH: "/usr/bin" },
          platform: "darwin",
          exists: () => false,
          createUdsClient: () => ({
            ...client,
            async connect() {
              const err = new Error("connect ENOENT") as NodeJS.ErrnoException;
              err.code = "ENOENT";
              throw err;
            },
          }),
        },
        async () => "never",
      ),
    /ludens-server.*not found|--remote/s,
  );
});

test("withOperatorRpc uses WS directly when --remote is set and resolves monorepo ludens-server fallback", async () => {
  const parsed = extractRemoteArgs(
    ["status", "--remote", "wss://cloud.example.com", "--token", "tok-1"],
    {},
  );
  assert.deepEqual(parsed, {
    remaining: ["status"],
    remote: { url: "wss://cloud.example.com", token: "tok-1" },
  });

  let wsConnectedUrl: string | undefined;
  const { client } = createMockRpcClient(() => ({ ok: true }));
  const mode = await withOperatorRpc(
    {
      remote: parsed.remote,
      createWsClient: remote => {
        wsConnectedUrl = remote.url;
        return client;
      },
    },
    async (_rpc, connectedMode) => connectedMode,
  );
  assert.equal(mode, "remote");
  assert.equal(wsConnectedUrl, "wss://cloud.example.com");

  const repoFallback = resolveLocalLudensServerCommand({
    env: { PATH: "" },
    platform: "darwin",
    clientRoot: "/repo/client",
    exists: p => p === "/repo/server/bin/ludens-server",
  });
  assert.deepEqual(repoFallback, {
    command: "/repo/server/bin/ludens-server",
    argsPrefix: [],
  });
});

test("NodeUdsRpcClient roundtrips NDJSON JSON-RPC over a real Unix Domain Socket", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ludens-uds-rpc-"));
  const socketPath = join(dir, "app.sock");
  const server = createServer(socket => {
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      buf += chunk;
      let idx = buf.indexOf("\n");
      while (idx !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) {
          const req = JSON.parse(line);
          socket.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: req.id,
              result: { home: "/tmp/mock", config: DEFAULT_SETTINGS.config, workspaces: [] },
            }) + "\n",
          );
        }
        idx = buf.indexOf("\n");
      }
    });
  });

  await new Promise<void>(resolveListen => server.listen(socketPath, resolveListen));
  const rpc = new NodeUdsRpcClient({ socketPath });
  try {
    const settings = await rpc.call("workspaces/getSettings");
    assert.equal(settings.home, "/tmp/mock");
  } finally {
    await rpc.close();
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    await rm(dir, { recursive: true, force: true });
  }
});
