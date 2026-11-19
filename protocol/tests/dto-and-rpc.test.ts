import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { activitySearchText, blockLabels, printable } from "../src/activity-view.ts";
import {
  APP_RPC_ERROR_CODES,
  APP_RPC_PROTOCOL_VERSION,
  type AppRpcMethod,
  type AppRpcParams,
  type AppRpcResult,
} from "../src/app-rpc.ts";
import { APP_SERVER_SUN_PATH_LIMIT, resolveAppServerSocketPath } from "../src/app-server-paths.ts";
import { isStillAdapting, resolveCapabilityEval } from "../src/capabilities.ts";
import { initialSelection, latestGameRun } from "../src/initial-selection.ts";
import { parsePerceptionPatch } from "../src/perception-config.ts";
import { PET_AUTO_TARGET, petStatus, petStatusKey, workspaceLabel } from "../src/pet.ts";
import { runIdentity, runWindowSummary } from "../src/run-identity.ts";
import { medianRequestWaits, requestWait, sseFallbackReason } from "../src/transport.ts";
import type { Call, Project } from "../src/types.ts";
import { isOmpEffort, isOmpServiceTier, validWorkspaceId } from "../src/workspaces.ts";

const BROWSER_SAFE_MODULES = [
  "activity.ts",
  "activity-view.ts",
  "app-rpc.ts",
  "capabilities.ts",
  "connection.ts",
  "docs.ts",
  "drivers.ts",
  "event-pool.ts",
  "initial-selection.ts",
  "machines.ts",
  "perception-config.ts",
  "pet.ts",
  "replay.ts",
  "replay-types.ts",
  "run-identity.ts",
  "timeline-record.ts",
  "timeline-types.ts",
  "transport.ts",
  "types.ts",
  "workspaces.ts",
];

describe("@ludens/protocol browser-safe DTOs, projections, and App-RPC contracts", () => {
  test("browser-safe modules contain zero runtime node:* or bun:* value imports", () => {
    const srcDir = join(import.meta.dir, "../src");
    for (const file of BROWSER_SAFE_MODULES) {
      const content = readFileSync(join(srcDir, file), "utf8");
      const runtimeNodeOrBunImport = /^\s*import\s+(?!type\b).*from\s+["'](?:node:|bun:)/m.test(content);
      expect(runtimeNodeOrBunImport).toBe(false);
    }
  });

  test("runIdentity and runWindowSummary format Asia/Shanghai timestamps cleanly", () => {
    const identity = runIdentity("2026-11-19T04-00-00.125Z");
    expect(identity).toEqual({
      id: "2026-11-19T04-00-00.125Z",
      summary: "2026/11/19 12:00:00.125",
    });
    expect(runIdentity("custom-run")).toEqual({ id: "custom-run", summary: null });

    const windowSummary = runWindowSummary({
      id: "2026-11-19T04-00-00.000Z",
      endedAt: "2026-11-19T04:05:00.000Z",
    });
    expect(windowSummary.summary).toBe("2026/11/19 12:00 – 12:05 · 5m");
  });

  test("initialSelection resolves URL project/run/epoch and clears orphaned epoch", () => {
    const projects: Project[] = [
      { id: "empty", runs: [] },
      {
        id: "alpha",
        workspace: "/ws/alpha",
        runs: [{ id: "r1", model: "openai-codex/gpt-6.2-sol", seconds: 300, drivers: [] }],
      },
    ];
    expect(latestGameRun(projects[1])?.id).toBe("r1");
    expect(initialSelection("", projects)).toEqual({ project: "alpha", run: "", epoch: "" });
    expect(initialSelection("?project=alpha&run=missing&epoch=e1", projects)).toEqual({
      project: "alpha",
      run: "",
      epoch: "",
    });
    expect(initialSelection("?workspace=%2Fws%2Falpha&run=r1&epoch=e1", projects)).toEqual({
      project: "alpha",
      run: "r1",
      epoch: "e1",
    });
  });

  test("activity-view, pet, transport, perception-config, capabilities, and workspaces pure helpers work", () => {
    expect(printable({ a: 1 })).toContain('"a": 1');
    expect(
      activitySearchText({
        id: "b1",
        kind: "tool",
        at: "2026-11-19T00:00:00Z",
        title: "Click Button",
        text: "ok",
        status: "complete",
      }),
    ).toContain(blockLabels.tool);

    expect(PET_AUTO_TARGET).toBe("!auto");
    expect(workspaceLabel({ id: "p1", workspace: "/tmp/my-game/workspace" })).toBe("my-game");
    expect(petStatusKey(null)).toBe("connecting");
    expect(
      petStatus({
        target: null,
        targetConfigured: false,
        consumer: {
          instanceId: "i1",
          pid: 1,
          revision: null,
          workspace: null,
          runId: null,
          phase: "idle",
          error: null,
          seenAt: "2026-11-19T00:00:00Z",
        },
        connected: true,
        autoFollowing: true,
      }),
    ).toBe("等待活跃 Core");

    const sampleCalls = [
      {
        transport: "websocket",
        headersMs: null,
        durationMs: 100,
        status: "ok",
        phases: { afterDispatchMs: 42 },
        transportDetails: null,
      },
      {
        transport: "sse",
        headersMs: 120,
        durationMs: 250,
        status: "ok",
        phases: {},
        transportDetails: { sizeBlockedUntilCompaction: true },
      },
    ] as unknown as Call[];
    expect(requestWait(sampleCalls[0]!)).toEqual({ label: "WS 首事件等待", ms: 42 });
    expect(medianRequestWaits(sampleCalls)).toHaveLength(2);
    expect(sseFallbackReason(sampleCalls[1]!, Date.now())).toContain("OMP");

    expect(parsePerceptionPatch({ hotSeconds: 60, videoIdleSeconds: null })).toEqual({
      hotSeconds: 60,
      videoIdleSeconds: null,
    });
    expect(() => parsePerceptionPatch({ hotSeconds: 3 })).toThrow();

    const cap = {
      codeSHA: "sha-cap",
      eval: {
        id: "python/eval.py:eval_fn",
        origin: { path: "eval.py", function: "eval_fn", line: 1 },
        codeSHA: "sha-eval",
        description: "desc",
      },
    };
    const adaptedRecord = {
      runId: "eval-1",
      capabilityId: "python/cap.py:fn",
      evalId: "python/eval.py:eval_fn",
      capabilityCodeSHA: "sha-cap",
      evalCodeSHA: "sha-eval",
      evaluatedAt: "2026-11-19T00:00:00Z",
      durationMs: 0,
      outcome: "failed" as const,
      rewards: null,
      adaptation: {
        reason: "counterexample",
        records: ["rec-1"],
        adaptedAt: "2026-11-19T00:00:00Z",
        evalCodeSHA: "sha-eval",
      },
    };
    expect(isStillAdapting(cap, adaptedRecord)).toBe(true);
    expect(resolveCapabilityEval(cap, adaptedRecord).evalStatus).toBe("adapting");

    expect(isOmpServiceTier("priority")).toBe(true);
    expect(isOmpEffort("xhigh")).toBe(true);
    expect(validWorkspaceId("demo-workspace_1")).toBe(true);
  });

  test("app-server-paths enforces 96-byte BSD sun_path fallback", () => {
    const shortPath = resolveAppServerSocketPath("/tmp/ludens-short");
    if (process.platform !== "win32") {
      expect(shortPath).toBe("/tmp/ludens-short/run/app-server.sock");
      const longHome = `/tmp/${"very-long-segment-".repeat(8)}home`;
      const fallbackPath = resolveAppServerSocketPath(longHome);
      expect(Buffer.byteLength(fallbackPath, "utf8")).toBeLessThanOrEqual(APP_SERVER_SUN_PATH_LIMIT);
      expect(fallbackPath).toMatch(/^\/tmp\/ludens-app-\d+-[0-9a-f]{12}\.sock$/);
    }
  });

  test("new pure-RPC CLI methods typecheck in AppRpcMethods", () => {
    expect(APP_RPC_PROTOCOL_VERSION).toBe("1.0");
    expect(APP_RPC_ERROR_CODES.NOT_FOUND).toBe(-32004);

    const methods: AppRpcMethod[] = [
      "capabilities/evalHistory",
      "capabilities/evalAdapt",
      "workspaces/import",
      "logs/events",
      "logs/read",
    ];
    expect(methods).toHaveLength(5);

    const historyParams: AppRpcParams<"capabilities/evalHistory"> = {
      project: "ws-1",
      workspace: "/ws/1",
      capabilityId: "python/cap.py:fn",
      limit: 10,
    };
    const adaptParams: AppRpcParams<"capabilities/evalAdapt"> = {
      project: "ws-1",
      workspace: "/ws/1",
      capabilityId: "python/cap.py:fn",
      reason: "false positive",
      records: ["rec-1"],
    };
    const importParams: AppRpcParams<"workspaces/import"> = {
      workspace: "/ws/1",
      legacyStateDir: "/legacy",
    };
    const logsEventsParams: AppRpcParams<"logs/events"> = {
      project: "ws-1",
      run: "run-1",
      channel: "diagnostics",
      limit: 100,
    };
    const logsReadParams: AppRpcParams<"logs/read"> = {
      project: "ws-1",
      run: "run-1",
      eventSeq: 9,
      field: "payload",
      media: "reference",
    };
    const logsReadRes: AppRpcResult<"logs/read"> = { value: { ok: true } };

    expect(historyParams.limit).toBe(10);
    expect(adaptParams.reason).toBe("false positive");
    expect(importParams.workspace).toBe("/ws/1");
    expect(logsEventsParams.channel).toBe("diagnostics");
    expect(logsReadParams.eventSeq).toBe(9);
    expect(logsReadRes.value).toEqual({ ok: true });
  });
});
