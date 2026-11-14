import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildWorkspaceServiceRequestBody,
  createWorkspaceServiceStore,
  formatWorkspaceServiceFailure,
  requestWorkspaceServiceControl,
  type WorkspaceServiceOperation,
} from "../lib/use-workspace-service";
import { LocaleProvider } from "../lib/locale";
import { WorkspaceRunEmpty } from "../features/workspaces/workspace-run-empty";
import type { ActivityFeedData } from "../features/live/use-activity-feed";
import type { RunData, SpanStats } from "../lib/types";
import type { WorkspaceStudioSnapshot } from "../lib/workspaces";

function makeStudioSnapshot(id = "ws-demo"): WorkspaceStudioSnapshot {
  return {
    id,
    name: "Demo Workspace",
    workspace: `/tmp/${id}`,
    config: {
      driver: "cua",
      model: "openai-codex/gpt-6.1-sol",
      seconds: 1800,
      requests: 1000,
      dashboard: true,
      pet: false,
      diagnostics: "normal",
    },
    defaults: {},
    services: {
      hostSocket: `/tmp/${id}/host.sock`,
      hostSocketExists: false,
      jobs: [],
    },
    shiori: {
      currentSessionFile: null,
      sessions: [],
      memory: {
        path: `/tmp/${id}/MEMORY.md`,
        exists: false,
        content: "",
        updatedAt: null,
      },
    },
  };
}

function collectLeafKeys(obj: unknown, prefix = ""): string[] {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return [prefix];
  }
  const out: string[] = [];
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const next = prefix ? `${prefix}.${key}` : key;
    out.push(...collectLeafKeys(value, next));
  }
  return out.sort();
}

test("buildWorkspaceServiceRequestBody trims workspaceId and formats workspaceServiceControl payload", () => {
  assert.deepEqual(buildWorkspaceServiceRequestBody("  ws-alpha  ", "up"), {
    action: "workspaceServiceControl",
    id: "ws-alpha",
    service: { operation: "up" },
  });
});

test("formatWorkspaceServiceFailure prefers stderr, falls back to stdout, and returns null on exit 0", () => {
  assert.equal(
    formatWorkspaceServiceFailure({
      ok: true,
      operation: "up",
      exitCode: 0,
      stdout: "started",
      stderr: "",
    }),
    null,
  );
  assert.equal(
    formatWorkspaceServiceFailure({
      ok: false,
      operation: "up",
      exitCode: 1,
      stdout: "partial stdout",
      stderr: "  bridge connection refused on 127.0.0.1:47653  ",
    }),
    "bridge connection refused on 127.0.0.1:47653",
  );
  assert.equal(
    formatWorkspaceServiceFailure({
      ok: false,
      operation: "reload",
      exitCode: 2,
      stdout: "  host socket busy  ",
      stderr: "   ",
    }),
    "host socket busy",
  );
  assert.equal(
    formatWorkspaceServiceFailure(
      {
        ok: false,
        operation: "down",
        exitCode: 3,
        stdout: "",
        stderr: "",
      },
      "Custom fallback",
    ),
    "Custom fallback",
  );
});

test("store runOperation sends PUT /api/workspaces, updates state, and triggers onSuccess on exit 0", async () => {
  const calls: Array<{ url: string; method?: string; body: unknown }> = [];
  const studio = makeStudioSnapshot("ws-1");

  const mockFetch: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response(
      JSON.stringify({
        ok: true,
        operation: "up",
        exitCode: 0,
        stdout: "Host ready (PID 4242)",
        stderr: "",
        studio,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const store = createWorkspaceServiceStore(mockFetch);
  let successCount = 0;
  let studioCount = 0;

  const result = await store.runOperation("ws-1", "up", {
    onSuccess(res) {
      successCount += 1;
      assert.equal(res.operation, "up");
      assert.equal(res.exitCode, 0);
    },
    onStudioSnapshot(next) {
      studioCount += 1;
      assert.equal(next.id, "ws-1");
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/workspaces");
  assert.equal(calls[0].method, "PUT");
  assert.deepEqual(calls[0].body, {
    action: "workspaceServiceControl",
    id: "ws-1",
    service: { operation: "up" },
  });

  assert.ok(result);
  assert.equal(result.ok, true);
  assert.equal(successCount, 1);
  assert.equal(studioCount, 1);

  const snap = store.getSnapshot("ws-1");
  assert.equal(snap.busy, false);
  assert.equal(snap.pendingOperation, null);
  assert.equal(snap.error, null);
  assert.equal(snap.lastResult?.stdout, "Host ready (PID 4242)");
});

test("store surfaces non-zero exitCode errors without firing onSuccess and supports clearError + retry reset", async () => {
  let attempt = 0;
  const studio = makeStudioSnapshot("ws-err");
  const mockFetch: typeof fetch = async () => {
    attempt += 1;
    if (attempt === 1) {
      return new Response(
        JSON.stringify({
          ok: false,
          operation: "up",
          exitCode: 1,
          stdout: "checking driver...",
          stderr: "Error: TCP bridge 127.0.0.1:47111 unreachable",
          studio,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        ok: true,
        operation: "up",
        exitCode: 0,
        stdout: "started cleanly",
        stderr: "",
        studio,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const store = createWorkspaceServiceStore(mockFetch);
  let successCalled = 0;
  let studioCalled = 0;

  const first = await store.runOperation("ws-err", "up", {
    onSuccess: () => {
      successCalled += 1;
    },
    onStudioSnapshot: () => {
      studioCalled += 1;
    },
  });

  assert.ok(first);
  assert.equal(first.ok, false);
  assert.equal(first.exitCode, 1);
  assert.equal(successCalled, 0, "onSuccess must not fire on non-zero exitCode");
  assert.equal(studioCalled, 1, "onStudioSnapshot still updates studio diagnostics");
  assert.equal(
    store.getSnapshot("ws-err").error,
    "Error: TCP bridge 127.0.0.1:47111 unreachable",
  );

  // Explicit clearError resets error while retaining lastResult
  store.clearError("ws-err");
  assert.equal(store.getSnapshot("ws-err").error, null);
  assert.equal(store.getSnapshot("ws-err").lastResult?.exitCode, 1);

  // HTTP 500 error also populates error cleanly
  const failHttpStore = createWorkspaceServiceStore(async () =>
    new Response(JSON.stringify({ error: "App-server supervisor unavailable" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    }),
  );
  const httpRes = await failHttpStore.runOperation("ws-http", "reload");
  assert.equal(httpRes, null);
  assert.equal(
    failHttpStore.getSnapshot("ws-http").error,
    "App-server supervisor unavailable",
  );

  // Subsequent successful retry clears any prior error and fires onSuccess
  const second = await store.runOperation("ws-err", "up", {
    onSuccess: () => {
      successCalled += 1;
    },
  });
  assert.ok(second?.ok);
  assert.equal(successCalled, 1);
  assert.equal(store.getSnapshot("ws-err").error, null);
});

test("concurrency guard blocks duplicate in-flight operations per workspace while allowing other workspaces", async () => {
  const resolvers = new Map<string, () => void>();
  const startedOps: Array<{ id: string; op: WorkspaceServiceOperation }> = [];

  const mockFetch: typeof fetch = async (_input, init) => {
    const parsed = JSON.parse(String(init?.body)) as {
      id: string;
      service: { operation: WorkspaceServiceOperation };
    };
    startedOps.push({ id: parsed.id, op: parsed.service.operation });
    await new Promise<void>(resolve => {
      resolvers.set(parsed.id, resolve);
    });
    return new Response(
      JSON.stringify({
        ok: true,
        operation: parsed.service.operation,
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        studio: makeStudioSnapshot(parsed.id),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const store = createWorkspaceServiceStore(mockFetch);

  const p1 = store.runOperation("ws-a", "up");
  assert.equal(store.getSnapshot("ws-a").busy, true);
  assert.equal(store.getSnapshot("ws-a").pendingOperation, "up");

  // Duplicate concurrent mutation on ws-a is rejected immediately without calling fetch
  const duplicate = await store.runOperation("ws-a", "down");
  assert.equal(duplicate, null);
  assert.equal(startedOps.length, 1);

  // Concurrent mutation on ws-b proceeds independently
  const p2 = store.runOperation("ws-b", "reload");
  assert.equal(store.getSnapshot("ws-b").busy, true);
  assert.equal(store.getSnapshot("ws-b").pendingOperation, "reload");
  assert.equal(startedOps.length, 2);

  resolvers.get("ws-a")?.();
  resolvers.get("ws-b")?.();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1?.ok, true);
  assert.equal(r2?.ok, true);
  assert.equal(store.getSnapshot("ws-a").busy, false);
  assert.equal(store.getSnapshot("ws-b").busy, false);
});

test("requestWorkspaceServiceControl handles non-JSON HTTP errors gracefully", async () => {
  await assert.rejects(
    () =>
      requestWorkspaceServiceControl("ws-plain", "up", {
        fetchImpl: async () => new Response("Bad Gateway", { status: 502 }),
      }),
    /Bad Gateway/,
  );
});

test("Live ShioriWorkbench and WorkspaceRunEmpty render first-class Start Workspace CTAs when offline", async () => {
  const { ShioriWorkbench } = await import("../features/live/shiori-cockpit");

  const stats: SpanStats = {
    started: 0,
    outcomes: {
      success: 0,
      error: 0,
      cancelled: 0,
      pending: 0,
      unknown: 0,
    },
    durationMs: { median: null, p95: null },
  };
  const baseRunData: RunData = {
    project: "demo-ws",
    run: "20260101-000000",
    manifest: {
      runId: "20260101-000000",
      workspace: "/tmp/demo-ws",
      socket: "/tmp/demo-ws/host.sock",
      model: "openai-codex/gpt-6.1-sol",
      seconds: 1800,
      maxRequests: 1000,
      compactionThreshold: null,
      drivers: [{ id: "cua", version: "0.1.0" }],
    },
    cycles: [],
    selectedEpoch: null,
    calls: [],
    paging: {
      totalCalls: 0,
      beforeCall: null,
      hasMore: false,
      firstIndex: 0,
      lastIndex: 0,
    },
    observations: [],
    perception: null,
    notices: [],
    skills: [],
    telemetry: {
      sources: [],
      spans: [],
      shiori: { stats, nativeLoops: [] },
      capabilities: { stats, python: stats, localPython: stats, discovery: stats },
      devices: stats,
      perception: stats,
    },
    lastControl: null,
    activeCompaction: null,
    live: null,
    livePhase: null,
    controlAllowed: false,
    controlReason: "offline",
    updatedAt: "2026-01-01T00:00:00.000Z",
    summary: {
      completed: 0,
      actions: 0,
      explicitObserves: 0,
      errors: 0,
      compactions: 0,
      medianMs: null,
      p95Ms: null,
      medianHeadersMs: null,
      medianHttpHeadersMs: null,
      medianWsWaitMs: null,
      cacheHit: null,
      warmCacheHit: null,
      elapsedSeconds: 0,
    },
  };
  const feed: ActivityFeedData = {
    resetRevision: 0,
    loadedRevision: 0,
    scope: { project: "demo-ws", runId: "20260101-000000", epoch: null },
    generation: "gen-1",
    snapshot: 1,
    blocks: [],
    selected: undefined,
    selectionReady: true,
    before: null,
    historyFloorAt: null,
    hasMore: false,
    total: 0,
    historical: false,
    loading: false,
    loadingOlder: false,
    error: "",
    filter: "all",
    query: "",
    setFilter() {},
    setQuery() {},
    async earlier() {},
    latest() {},
  };

  const offlineHtml = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(ShioriWorkbench, {
        project: "demo-ws",
        workspace: "/tmp/demo-ws",
        workspaceTitle: "Demo Workspace",
        data: baseRunData,
        feed,
        isLiveRun: true,
        onUpdated() {},
        onOpenPerf() {},
        onOpenCaps() {},
        onReturnLatest() {},
        observationSlot: createElement("div", null, "stage"),
      }),
    ),
  );
  assert.doesNotMatch(offlineHtml, /class="codex-host-offline-bar"/);
  assert.match(offlineHtml, /data-shiori-composer="start"/);
  assert.match(offlineHtml, /Core Offline \(Spawns on demand\)/);
  assert.match(offlineHtml, /data-dock-service-op="up"/);

  const onlineHtml = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(ShioriWorkbench, {
        project: "demo-ws",
        workspace: "/tmp/demo-ws",
        workspaceTitle: "Demo Workspace",
        data: {
          ...baseRunData,
          live: {
            runId: "20260101-000000",
            mode: "manual",
            epoch: null,
            connected: true,
            reason: "ready",
            agent: false,
            thinking: false,
          },
        },
        feed,
        isLiveRun: true,
        onUpdated() {},
        onOpenPerf() {},
        onOpenCaps() {},
        onReturnLatest() {},
        observationSlot: createElement("div", null, "stage"),
      }),
    ),
  );
  assert.doesNotMatch(onlineHtml, /class="codex-host-offline-bar"/);
  assert.match(onlineHtml, /data-dock-service-op="reload"/);
  assert.match(onlineHtml, /data-dock-service-op="down"/);

  const emptyRunHtml = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(WorkspaceRunEmpty, {
        state: "no-run",
        project: "demo-ws",
        workspaceName: "Demo Workspace",
        workspacePath: "/tmp/demo-ws",
        error: "",
        retrying: false,
        onRetry() {},
        onNavigate() {},
      }),
    ),
  );
  assert.match(emptyRunHtml, /data-empty-start-workspace=""/);
  assert.match(emptyRunHtml, /ludens --workspace &#x27;\/tmp\/demo-ws&#x27; up/);
});

test("app/messages/en.json and app/messages/zh.json maintain 1:1 leaf key parity", () => {
  const en = JSON.parse(
    readFileSync(join(process.cwd(), "messages/en.json"), "utf8"),
  ) as unknown;
  const zh = JSON.parse(
    readFileSync(join(process.cwd(), "messages/zh.json"), "utf8"),
  ) as unknown;
  assert.deepEqual(collectLeafKeys(en), collectLeafKeys(zh));
});

test("dev.mjs enforces loopback-only hostnames and brackets IPv6 trusted origins", async () => {
  const devModule = (await import("../scripts/dev.mjs")) as {
    parseDevArgs: (argv: string[]) => { port: string; hostname: string; rest: string[] };
    buildLoopbackTrustedOrigins: (port: string, hostname: string) => string[];
  };
  assert.deepEqual(devModule.parseDevArgs(["--port", "3199", "--hostname", "::1"]), {
    port: "3199",
    hostname: "::1",
    rest: [],
  });
  assert.deepEqual(devModule.buildLoopbackTrustedOrigins("3199", "::1"), [
    "http://[::1]:3199",
    "http://127.0.0.1:3199",
    "http://localhost:3199",
  ]);
  assert.throws(() => devModule.parseDevArgs(["--hostname", "0.0.0.0"]), /Refusing non-loopback dev hostname/);
});
