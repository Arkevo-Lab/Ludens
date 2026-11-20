import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureWorkspaceIdentity, readGlobalConfig } from "@ludens/protocol/ludens";
import { listen, send } from "@ludens/core/daemon/transport";
import { refreshActivity } from "../src/query/activity.ts";
import { availableModels, listAvailableModelsViaBun } from "../src/query/available-models.ts";
import { getLogIndex } from "../src/query/log-index.ts";
import { refreshRunProjection, readRunProjection } from "../src/query/run-index.ts";
import { controlWorkspaceRuntime } from "../src/query/runtime-control.ts";
import { updateGlobalDefaults, updateWorkspaceShiori, updateWorkspaceStudioConfig } from "../src/query/workspaces.ts";
import { Runtime, type AgentRunner } from "@ludens/core/core/shiori/runtime";
import { resolveWorkspaceAddress } from "@ludens/core/core/storage/workspace-state";
import { createTestDeviceSession } from "./runtime-fixture.ts";

test("session model events update run and activity index projections", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "ludens-server-model-index-")));
  const runDir = join(directory, "run-1");
  await mkdir(runDir, { recursive: true });
  try {
    await writeFile(join(runDir, "manifest.json"), JSON.stringify({
      runId: "run-1",
      workspace: directory,
      workspaceId: "ws-1",
      drivers: [],
      model: "openai-codex/gpt-6.2-sol",
      compactionThreshold: null,
    }));
    await writeFile(join(runDir, "events.jsonl"), [
      JSON.stringify({ seq: 1, at: "2026-01-01T00:00:00Z", atMs: 0, type: "session", source: { component: "shiori" }, trace: {}, data: { model: "openai-codex/gpt-6.2-sol" } }),
      JSON.stringify({ seq: 2, at: "2026-01-01T00:00:01Z", atMs: 1000, type: "session", source: { component: "shiori" }, trace: {}, data: { model: "anthropic/claude-sonnet-4-5" } }),
    ].join("\n") + "\n");

    const index = getLogIndex(runDir);
    const release = index.retain();
    try {
      await index.refreshEvents();
      await refreshRunProjection(index);
      const projected = await readRunProjection(index, null);
      expect(projected.sessionModel).toBe("anthropic/claude-sonnet-4-5");

      await refreshActivity(index);
      expect(index.meta("activitySessionModel")).toBe("anthropic/claude-sonnet-4-5");
    } finally {
      release();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("availableModels and listAvailableModelsViaBun resolve global and workspace catalogs", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "ludens-server-available-models-")));
  const home = join(directory, "home");
  const workspace = join(directory, "workspace");
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "ludens.json"), JSON.stringify({
    driver: "cua",
    model: "custom-vision/v1-vision",
  }, null, 2));
  await writeFile(join(home, "config.json"), JSON.stringify({
    version: 1,
    workspaceRoot: join(home, "workspaces"),
    defaults: { model: "openai-codex/gpt-6.2-sol", serviceTier: "ultrafast", effort: "xhigh" },
  }));

  try {
    const globalCatalog = await availableModels(undefined, home);
    expect(globalCatalog.currentModel).toBe("openai-codex/gpt-6.2-sol");
    expect(globalCatalog.currentEffort).toBe("xhigh");
    expect(globalCatalog.models.length).toBeGreaterThan(0);

    const bridgedCatalog = await listAvailableModelsViaBun({ workspace, home });
    expect(bridgedCatalog.currentModel).toBe("custom-vision/v1-vision");
    expect(bridgedCatalog.currentServiceTier).toBeNull();
    expect(bridgedCatalog.currentEffort).toBeNull();
    expect(bridgedCatalog.models.length).toBeGreaterThan(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test("controlWorkspaceRuntime set_model synchronizes live host and ludens.json", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "ludens-control-model-")));
  const home = join(directory, "home");
  const workspace = join(directory, "workspace");
  const gate = Promise.withResolvers<void>();
  let activeModel = "openai-codex/gpt-6.2-sol";
  let activeServiceTier: "priority" | "ultrafast" | null = null;
  let activeEffort: "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null = null;
  const agent: AgentRunner = {
    async run({ signal }) {
      const aborted = Promise.withResolvers<void>();
      signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      await Promise.race([gate.promise, aborted.promise]);
    },
    async consolidate() {},
    model: () => activeModel,
    serviceTier: () => activeServiceTier,
    effort: () => activeEffort,
    async setModel(next, nextServiceTier, nextEffort) {
      activeModel = next;
      if (nextServiceTier !== undefined) activeServiceTier = nextServiceTier;
      if (nextEffort !== undefined) activeEffort = nextEffort;
      return activeModel;
    },
    abort: async () => {},
    close: async () => {},
  };
  const { devices } = createTestDeviceSession({ controllers: [] }, () => {});
  const runtime = new Runtime(devices, () => {});
  runtime.attach({ agent });

  try {
    await mkdir(join(home, "registry"), { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "ludens.json"), JSON.stringify({
      driver: "cua",
      model: "openai-codex/gpt-6.2-sol",
    }, null, 2));
    const identity = await ensureWorkspaceIdentity(workspace);
    await writeFile(
      join(home, "registry", `${identity.id}.json`),
      JSON.stringify({ id: identity.id, workspace, name: "model-test", updatedAt: new Date().toISOString() }),
    );
    const { socket } = await resolveWorkspaceAddress(workspace);
    const stop = await listen(socket, runtime);

    const onlineSwitch = await controlWorkspaceRuntime(
      identity.id,
      workspace,
      { action: "set_model", model: "anthropic/claude-sonnet-4-5" },
      home,
    );
    expect(onlineSwitch).toMatchObject({ mode: "manual", model: "anthropic/claude-sonnet-4-5" });
    expect(JSON.parse(await readFile(join(workspace, "ludens.json"), "utf8")).model).toBe("anthropic/claude-sonnet-4-5");

    const tieredSwitch = await controlWorkspaceRuntime(
      identity.id,
      workspace,
      { action: "set_model", model: "openai-codex/gpt-6.2-sol", serviceTier: "ultrafast", effort: "xhigh" },
      home,
    );
    expect(tieredSwitch).toMatchObject({ model: "openai-codex/gpt-6.2-sol", serviceTier: "ultrafast", effort: "xhigh" });
    const tieredRaw = JSON.parse(await readFile(join(workspace, "ludens.json"), "utf8"));
    expect(tieredRaw.serviceTier).toBe("ultrafast");
    expect(tieredRaw.effort).toBe("xhigh");

    await controlWorkspaceRuntime(
      identity.id,
      workspace,
      { action: "set_model", model: "anthropic/claude-sonnet-4-5", serviceTier: null, effort: null },
      home,
    );

    const statusBefore = await send(socket, { kind: "status", argv: [] }) as { runId: string; epoch: string | null; model?: string | null };
    expect(statusBefore.model).toBe("anthropic/claude-sonnet-4-5");
    const ipcSwitched = await send(socket, {
      kind: "model",
      argv: ["openai-codex/gpt-6.2-sol", "--service-tier", "ultrafast", "--effort", "high"],
      runId: statusBefore.runId,
      expectedEpoch: statusBefore.epoch,
    });
    expect(ipcSwitched).toMatchObject({
      mode: "manual",
      model: "openai-codex/gpt-6.2-sol",
      serviceTier: "ultrafast",
      effort: "high",
    });

    await writeFile(join(workspace, "ludens.json"), JSON.stringify({
      driver: "cua",
      model: "openai-codex/gpt-6.2-sol",
    }, null, 2));
    await runtime.start();
    await expect(
      controlWorkspaceRuntime(identity.id, workspace, { action: "set_model", model: "anthropic/claude-opus-4-6" }, home),
    ).rejects.toThrow("Cannot switch model while Shiori is running; pause auto loop first");
    expect(JSON.parse(await readFile(join(workspace, "ludens.json"), "utf8")).model).toBe("openai-codex/gpt-6.2-sol");
    await runtime.stop("human");
    await runtime.runSettled;

    await stop();
    const offlineSwitch = await controlWorkspaceRuntime(
      identity.id,
      workspace,
      { action: "set_model", model: "google/gemini-2.5-pro" },
      home,
    );
    expect(offlineSwitch).toMatchObject({
      mode: "manual",
      connected: false,
      coreOffline: true,
      model: "google/gemini-2.5-pro",
    });
    expect(JSON.parse(await readFile(join(workspace, "ludens.json"), "utf8")).model).toBe("google/gemini-2.5-pro");

    const offlineTieredSwitch = await controlWorkspaceRuntime(
      identity.id,
      workspace,
      { action: "set_model", model: "openai-codex/gpt-6.2-sol", serviceTier: "priority" },
      home,
    );
    expect(offlineTieredSwitch).toMatchObject({ coreOffline: true, serviceTier: "priority" });
    expect(JSON.parse(await readFile(join(workspace, "ludens.json"), "utf8")).serviceTier).toBe("priority");

    const studioTiered = await updateWorkspaceStudioConfig(identity.id, {
      serviceTier: "ultrafast",
      effort: "xhigh",
    }, home);
    expect(studioTiered.config?.serviceTier).toBe("ultrafast");
    expect(studioTiered.config?.effort).toBe("xhigh");
    const studioStandard = await updateWorkspaceStudioConfig(identity.id, {
      serviceTier: null,
      effort: null,
    }, home);
    expect(studioStandard.config?.serviceTier).toBeUndefined();
    expect(studioStandard.config?.effort).toBeUndefined();

    await updateGlobalDefaults({ serviceTier: "priority", effort: "medium" }, home);
    expect((await readGlobalConfig(home)).defaults.serviceTier).toBe("priority");
    expect((await readGlobalConfig(home)).defaults.effort).toBe("medium");
    await updateGlobalDefaults({ serviceTier: null, effort: null }, home);
    expect((await readGlobalConfig(home)).defaults.serviceTier).toBeUndefined();
    expect((await readGlobalConfig(home)).defaults.effort).toBeUndefined();

    for (const invalidSelector of ["/foo", "foo/", "/"]) {
      await expect(
        controlWorkspaceRuntime(identity.id, workspace, { action: "set_model", model: invalidSelector }, home),
      ).rejects.toThrow("provider/model");
      await expect(
        updateWorkspaceShiori(identity.id, { kind: "setModel", model: invalidSelector }, home),
      ).rejects.toThrow("provider/model");
    }
    expect(JSON.parse(await readFile(join(workspace, "ludens.json"), "utf8")).model).toBe("openai-codex/gpt-6.2-sol");
  } finally {
    gate.resolve();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
