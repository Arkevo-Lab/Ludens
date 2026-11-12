import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import { ensureWorkspaceIdentity, readGlobalConfig } from "@ludens/protocol/ludens";
import { cli, HELP } from "../src/cli/control-cli.ts";
import { dispatch, listen } from "../src/daemon/transport.ts";
import { listAvailableOmpModels, resolveOmpImageModel } from "../src/core/agent-omp/models.ts";
import { createOmpAgent } from "../src/core/agent-omp/session.ts";
import { refreshActivity } from "../src/core/query/activity.ts";
import { availableModels, listAvailableModelsViaBun } from "../src/core/query/available-models.ts";
import { getLogIndex } from "../src/core/query/log-index.ts";
import { refreshRunProjection, readRunProjection } from "../src/core/query/run-index.ts";
import { controlWorkspaceRuntime } from "../src/core/query/runtime-control.ts";
import { updateGlobalDefaults, updateWorkspaceShiori, updateWorkspaceStudioConfig } from "../src/core/query/workspaces.ts";
import { Runtime, type AgentRunner } from "../src/core/shiori/runtime.ts";
import { EventLog } from "../src/core/storage/events.ts";
import { resolveWorkspaceAddress, resolveWorkspaceState } from "../src/core/storage/workspace-state.ts";
import { createTestDeviceSession } from "./runtime-fixture.ts";

test("createOmpAgent + Runtime.setModel switches model in manual mode, preserves imageCountBudget, and records session event", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "ludens-runtime-model-")));
  const home = join(directory, "home");
  const workspace = join(directory, "workspace");
  const runDir = join(workspace, "logs", "run-1");
  const network = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request in offline model switch test"));
  await mkdir(home, { recursive: true });
  await mkdir(runDir, { recursive: true });
  await ensureWorkspaceIdentity(workspace);

  const settings = Settings.isolated({ "retry.modelFallback": false, "title.refreshOnReplan": false });
  const auth = await AuthStorage.create(join(directory, "auth.db"));
  auth.keys.setRuntime("openai-codex", "offline-codex-key");
  auth.keys.setRuntime("openai", "offline-openai-key");
  auth.keys.setRuntime("anthropic", "offline-anthropic-key");

  const probeRegistry = new ModelRegistry(auth, undefined, { settings });
  const targetAnthropic = probeRegistry.getAvailable()
    .find(model => model.provider === "anthropic" && model.input.includes("image"));
  expect(targetAnthropic).toBeDefined();
  const nextModelId = `${targetAnthropic!.provider}/${targetAnthropic!.id}`;
  const textOnlyCandidate = probeRegistry.getAll().find(model => !model.input.includes("image"));

  // Verify resolveOmpImageModel enforces image capability and Infinite imageCountBudget.
  expect(resolveOmpImageModel(probeRegistry, nextModelId).imageCountBudget).toBe(Infinity);
  if (textOnlyCandidate) {
    expect(() => resolveOmpImageModel(probeRegistry, `${textOnlyCandidate.provider}/${textOnlyCandidate.id}`))
      .toThrow("An image-capable model is required");
  }

  const state = await resolveWorkspaceState(workspace, home);
  const log = new EventLog(runDir, { id: "run-1", now: () => performance.now() }, workspace);
  const { devices } = createTestDeviceSession({ controllers: [] }, () => {});
  const runtime = new Runtime(devices, log.record, 300, "run-1");

  try {
    const agent = await createOmpAgent({
      runtime,
      workspace,
      runDir,
      state,
      log,
      binDir: "/tmp",
      ludensSocket: state.socket,
      basewareSocket: "/tmp/unused-baseware.sock",
      model: "openai-codex/gpt-6.1-sol",
      maxRequests: 10,
      authStorage: auth,
    });
    runtime.attach({ agent });

    expect(runtime.status()).toMatchObject({
      mode: "manual",
      agent: true,
      model: "openai-codex/gpt-6.1-sol",
    });

    // Reject non-image-capable and unauthenticated selectors without altering current model.
    if (textOnlyCandidate) {
      await expect(runtime.setModel(`${textOnlyCandidate.provider}/${textOnlyCandidate.id}`))
        .rejects.toThrow("An image-capable model is required");
    }
    const unauthedImage = probeRegistry.getAll()
      .find(model => model.input.includes("image") && !probeRegistry.hasConfiguredAuth(model));
    if (unauthedImage) {
      await expect(runtime.setModel(`${unauthedImage.provider}/${unauthedImage.id}`))
        .rejects.toThrow("No API key");
    }
    expect(runtime.status().model).toBe("openai-codex/gpt-6.1-sol");

    await runtime.setModel("openai/gpt-6.1-sol", "ultrafast");
    expect(runtime.status().serviceTier).toBe("ultrafast");

    // Switch in manual mode succeeds and updates status + session log + projections.
    const switched = await runtime.setModel(nextModelId);
    expect(switched).toMatchObject({
      mode: "manual",
      model: nextModelId,
      serviceTier: null,
    });
    expect(runtime.status().model).toBe(nextModelId);

    await writeFile(join(runDir, "manifest.json"), JSON.stringify({
      runId: "run-1",
      workspace,
      workspaceId: state.id,
      socket: state.socket,
      drivers: [],
      model: "openai-codex/gpt-6.1-sol",
      seconds: 300,
      maxRequests: 10,
      compactionThreshold: null,
    }));
    await log.flush();

    const rawEvents = (await readFile(join(runDir, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(line => JSON.parse(line) as { type: string; source?: { component?: string }; data?: { model?: string; file?: string } });
    const sessionEvents = rawEvents.filter(event => event.type === "session" && event.source?.component === "shiori");
    expect(sessionEvents.map(event => event.data?.model)).toEqual([
      "openai-codex/gpt-6.1-sol",
      "openai/gpt-6.1-sol",
      nextModelId,
    ]);

    const index = getLogIndex(runDir);
    const release = index.retain();
    try {
      await index.refreshEvents();
      await refreshRunProjection(index);
      const projected = await readRunProjection(index, null);
      expect(projected.sessionModel).toBe(nextModelId);

      await refreshActivity(index);
      expect(index.meta("activitySessionModel")).toBe(nextModelId);
    } finally {
      release();
    }
    expect(network).not.toHaveBeenCalled();

    // A resumed transcript may contain the earlier Ultrafast entry, but the
    // workspace's explicit Standard configuration must win on every restart.
    await writeFile(join(workspace, "ludens.json"), JSON.stringify({ model: "openai/gpt-6.1-sol" }));
    await agent.close();
    const resumedAgent = await createOmpAgent({
      runtime,
      workspace,
      runDir,
      state,
      log,
      binDir: "/tmp",
      ludensSocket: state.socket,
      basewareSocket: "/tmp/unused-baseware.sock",
      model: "openai/gpt-6.1-sol",
      maxRequests: 10,
      authStorage: auth,
    });
    runtime.attach({ agent: resumedAgent });
    expect(runtime.status().serviceTier).toBeNull();
  } finally {
    await runtime.close();
    auth.close();
    network.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Runtime.setModel strictly blocks hot-switching during auto runs and consolidation", async () => {
  const runGate = Promise.withResolvers<void>();
  const consolidateGate = Promise.withResolvers<void>();
  let currentModel = "openai-codex/gpt-6.1-sol";
  const agent: AgentRunner = {
    async run({ signal }) {
      const aborted = Promise.withResolvers<void>();
      signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      await Promise.race([runGate.promise, aborted.promise]);
    },
    async consolidate({ signal }) {
      const aborted = Promise.withResolvers<void>();
      signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      await Promise.race([consolidateGate.promise, aborted.promise]);
    },
    model: () => currentModel,
    async setModel(next) {
      currentModel = next;
      return currentModel;
    },
    abort: async () => {},
    close: async () => {},
  };
  const { devices } = createTestDeviceSession({ controllers: [] }, () => {});
  const runtime = new Runtime(devices, () => {});
  runtime.attach({ agent });

  try {
    // 1. Blocked while mode === "auto"
    await runtime.start();
    expect(runtime.status()).toMatchObject({ mode: "auto", model: "openai-codex/gpt-6.1-sol" });
    await expect(runtime.setModel("anthropic/claude-sonnet-4-5"))
      .rejects.toThrow("Cannot switch model while Shiori is running; pause auto loop first");
    await expect(dispatch(runtime, {
      kind: "model",
      argv: ["anthropic/claude-sonnet-4-5"],
      runId: runtime.status().runId,
      expectedEpoch: runtime.status().epoch,
    })).rejects.toThrow("Cannot switch model while Shiori is running; pause auto loop first");
    await expect(dispatch(runtime, {
      kind: "model",
      argv: ["anthropic/claude-sonnet-4-5"],
      epoch: runtime.status().epoch!,
    })).rejects.toThrow("Control management belongs to the human, not an agent cycle");
    expect(currentModel).toBe("openai-codex/gpt-6.1-sol");

    await runtime.stop("human");
    await runtime.runSettled;

    // 2. Blocked while consolidating (mode is "manual", consolidating is true)
    await runtime.consolidate(60);
    expect(runtime.status()).toMatchObject({ mode: "manual", consolidating: true });
    await expect(runtime.setModel("anthropic/claude-sonnet-4-5"))
      .rejects.toThrow("Cannot switch model while Shiori is running; pause auto loop first");
    expect(currentModel).toBe("openai-codex/gpt-6.1-sol");

    consolidateGate.resolve();
    await runtime.runSettled;

    // 3. Allowed once back in idle manual state
    const updated = await dispatch(runtime, {
      kind: "model",
      argv: ["anthropic/claude-sonnet-4-5"],
      runId: runtime.status().runId,
      expectedEpoch: null,
    });
    expect(updated).toMatchObject({ mode: "manual", model: "anthropic/claude-sonnet-4-5" });
    expect(await dispatch(runtime, { kind: "model", argv: [] })).toEqual({ model: "anthropic/claude-sonnet-4-5", serviceTier: null });
  } finally {
    runGate.resolve();
    consolidateGate.resolve();
    await runtime.close();
  }
});

test("listAvailableOmpModels filters to image-capable models and reports authentication accurately", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "ludens-available-models-")));
  const home = join(directory, "home");
  const workspace = join(directory, "workspace");
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "ludens.json"), JSON.stringify({
    driver: "cua",
    model: "custom-vision/v1-vision",
  }, null, 2));

  const modelsJsonPath = join(directory, "models.json");
  await writeFile(modelsJsonPath, JSON.stringify({
    providers: {
      "unauthed-vision": {
        baseUrl: "http://127.0.0.1:9/v2",
        auth: "oauth",
        api: "openai-completions",
        models: [
          {
            id: "u-vision",
            name: "Unauthenticated Vision Model",
            reasoning: false,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 32000,
            maxTokens: 4096,
          },
        ],
      },
    },
  }, null, 2));

  const settings = Settings.isolated({ "retry.modelFallback": false });
  const auth = await AuthStorage.create(join(directory, "auth.db"));
  auth.keys.setRuntime("openai-codex", "offline-codex-key");
  const registry = new ModelRegistry(auth, modelsJsonPath, { settings });
  registry.registerProvider("custom-vision", {
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "custom-key",
    api: "openai-completions",
    models: [
      {
        id: "v1-vision",
        name: "Custom Vision Model",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      },
      {
        id: "v1-text-only",
        name: "Custom Text Model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 64000,
        maxTokens: 4096,
      },
    ],
  });

  try {
    const catalog = await listAvailableOmpModels({
      workspace,
      home,
      modelRegistry: registry,
    });

    expect(catalog.currentModel).toBe("custom-vision/v1-vision");
    expect(catalog.models.length).toBeGreaterThan(0);

    // Text-only models must never appear in Shiori's picker catalog.
    expect(catalog.models.find(item => item.fullId === "custom-vision/v1-text-only")).toBeUndefined();
    for (const item of catalog.models) {
      const raw = registry.getAll().find(model => model.provider === item.provider && model.id === item.id);
      expect(raw?.input.includes("image")).toBe(true);
    }

    const customVision = catalog.models.find(item => item.fullId === "custom-vision/v1-vision");
    expect(customVision).toEqual({
      fullId: "custom-vision/v1-vision",
      provider: "custom-vision",
      id: "v1-vision",
      name: "Custom Vision Model",
      reasoning: true,
      contextWindow: 128000,
      maxTokens: 8192,
      authenticated: true,
      supportedServiceTiers: [],
    });

    const codexSol = catalog.models.find(item => item.fullId === "openai-codex/gpt-6.1-sol");
    expect(codexSol?.authenticated).toBe(true);
    const openaiSol = catalog.models.find(item => item.fullId === "openai/gpt-6.1-sol");
    expect(openaiSol?.supportedServiceTiers).toEqual(["priority", "ultrafast"]);
    const googleModels = catalog.models.filter(item => item.provider === "google");
    expect(googleModels.length).toBeGreaterThan(0);
    expect(googleModels.every(item => item.supportedServiceTiers.length === 0)).toBe(true);
    const tieredCatalog = await listAvailableOmpModels({
      workspace,
      home,
      modelRegistry: registry,
      currentModel: "openai/gpt-6.1-sol",
      currentServiceTier: "ultrafast",
    });
    expect(tieredCatalog.currentServiceTier).toBe("ultrafast");

    const unauthedVision = catalog.models.find(item => item.fullId === "unauthed-vision/u-vision");
    expect(unauthedVision?.authenticated).toBe(false);

    // Authenticated models sort strictly before unauthenticated models.
    const firstUnauthedIdx = catalog.models.findIndex(item => !item.authenticated);
    if (firstUnauthedIdx >= 0) {
      expect(catalog.models.slice(firstUnauthedIdx).every(item => !item.authenticated)).toBe(true);
    }

    expect(catalog.providers.find(p => p.id === "custom-vision")).toEqual({
      id: "custom-vision",
      count: 1,
      authenticated: true,
    });
    expect(catalog.providers.find(p => p.id === "unauthed-vision")).toEqual({
      id: "unauthed-vision",
      count: 1,
      authenticated: false,
    });

    // Global fallback without workspaceId works cleanly (in-process & Node Bun-subprocess bridge).
    await writeFile(join(home, "config.json"), JSON.stringify({
      version: 1,
      workspaceRoot: join(home, "workspaces"),
      defaults: { model: "openai-codex/gpt-6.1-sol", serviceTier: "ultrafast" },
    }));
    const globalCatalog = await availableModels(undefined, home);
    expect(globalCatalog.currentModel).toBe("openai-codex/gpt-6.1-sol");
    expect(globalCatalog.models.length).toBeGreaterThan(0);

    const bridgedCatalog = await listAvailableModelsViaBun({ workspace, home });
    expect(bridgedCatalog.currentModel).toBe("custom-vision/v1-vision");
    expect(bridgedCatalog.currentServiceTier).toBeNull();
    expect(bridgedCatalog.models.length).toBeGreaterThan(0);
  } finally {
    auth.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("controlWorkspaceRuntime set_model and CLI ludens model synchronize live host and ludens.json", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "ludens-control-model-")));
  const home = join(directory, "home");
  const workspace = join(directory, "workspace");
  const gate = Promise.withResolvers<void>();
  let activeModel = "openai-codex/gpt-6.1-sol";
  let activeServiceTier: "priority" | "ultrafast" | null = null;
  const agent: AgentRunner = {
    async run({ signal }) {
      const aborted = Promise.withResolvers<void>();
      signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      await Promise.race([gate.promise, aborted.promise]);
    },
    async consolidate() {},
    model: () => activeModel,
    serviceTier: () => activeServiceTier,
    async setModel(next, nextServiceTier) {
      activeModel = next;
      activeServiceTier = nextServiceTier ?? null;
      return activeModel;
    },
    abort: async () => {},
    close: async () => {},
  };
  const { devices } = createTestDeviceSession({ controllers: [] }, () => {});
  const runtime = new Runtime(devices, () => {});
  runtime.attach({ agent });

  expect(HELP).toContain("ludens model [<provider/id>]");

  try {
    await mkdir(join(home, "registry"), { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "ludens.json"), JSON.stringify({
      driver: "cua",
      model: "openai-codex/gpt-6.1-sol",
    }, null, 2));
    const identity = await ensureWorkspaceIdentity(workspace);
    await writeFile(
      join(home, "registry", `${identity.id}.json`),
      JSON.stringify({ id: identity.id, workspace, name: "model-test", updatedAt: new Date().toISOString() }),
    );
    const { socket } = await resolveWorkspaceAddress(workspace);
    const stop = await listen(socket, runtime);

    // Online paused switch updates both host status and ludens.json.
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
      { action: "set_model", model: "openai-codex/gpt-6.1-sol", serviceTier: "ultrafast" },
      home,
    );
    expect(tieredSwitch).toMatchObject({ model: "openai-codex/gpt-6.1-sol", serviceTier: "ultrafast" });
    expect(JSON.parse(await readFile(join(workspace, "ludens.json"), "utf8")).serviceTier).toBe("ultrafast");

    await controlWorkspaceRuntime(
      identity.id,
      workspace,
      { action: "set_model", model: "anthropic/claude-sonnet-4-5", serviceTier: null },
      home,
    );

    // Online CLI `ludens model` reads and switches model in manual mode.
    const printed: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(" "));
    });
    try {
      await cli(["model"], socket);
      expect(printed.at(-1)).toBe("anthropic/claude-sonnet-4-5");
      await cli(["model", "openai-codex/gpt-6.1-sol", "--service-tier", "ultrafast"], socket);
      expect(JSON.parse(printed.at(-1)!)).toMatchObject({ mode: "manual", model: "openai-codex/gpt-6.1-sol", serviceTier: "ultrafast" });
    } finally {
      logSpy.mockRestore();
    }

    // Online running auto loop rejects set_model and leaves ludens.json untouched.
    await writeFile(join(workspace, "ludens.json"), JSON.stringify({
      driver: "cua",
      model: "openai-codex/gpt-6.1-sol",
    }, null, 2));
    await runtime.start();
    await expect(
      controlWorkspaceRuntime(identity.id, workspace, { action: "set_model", model: "anthropic/claude-opus-4-6" }, home),
    ).rejects.toThrow("Cannot switch model while Shiori is running; pause auto loop first");
    expect(JSON.parse(await readFile(join(workspace, "ludens.json"), "utf8")).model).toBe("openai-codex/gpt-6.1-sol");
    await runtime.stop("human");
    await runtime.runSettled;

    // Offline host persists ludens.json and returns synthetic manual offline status.
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
      hostOffline: true,
      model: "google/gemini-2.5-pro",
    });
    expect(JSON.parse(await readFile(join(workspace, "ludens.json"), "utf8")).model).toBe("google/gemini-2.5-pro");

    const offlineTieredSwitch = await controlWorkspaceRuntime(
      identity.id,
      workspace,
      { action: "set_model", model: "openai-codex/gpt-6.1-sol", serviceTier: "priority" },
      home,
    );
    expect(offlineTieredSwitch).toMatchObject({ hostOffline: true, serviceTier: "priority" });
    expect(JSON.parse(await readFile(join(workspace, "ludens.json"), "utf8")).serviceTier).toBe("priority");

    const studioTiered = await updateWorkspaceStudioConfig(identity.id, {
      serviceTier: "ultrafast",
    }, home);
    expect(studioTiered.config?.serviceTier).toBe("ultrafast");
    const studioStandard = await updateWorkspaceStudioConfig(identity.id, {
      serviceTier: null,
    }, home);
    expect(studioStandard.config?.serviceTier).toBeUndefined();

    await updateGlobalDefaults({ serviceTier: "priority" }, home);
    expect((await readGlobalConfig(home)).defaults.serviceTier).toBe("priority");
    await updateGlobalDefaults({ serviceTier: null }, home);
    expect((await readGlobalConfig(home)).defaults.serviceTier).toBeUndefined();

    // Leading/trailing slash selectors are rejected consistently.
    for (const invalidSelector of ["/foo", "foo/", "/"]) {
      await expect(
        controlWorkspaceRuntime(identity.id, workspace, { action: "set_model", model: invalidSelector }, home),
      ).rejects.toThrow("provider/model");
      await expect(
        updateWorkspaceShiori(identity.id, { kind: "setModel", model: invalidSelector }, home),
      ).rejects.toThrow("provider/model");
    }
    expect(JSON.parse(await readFile(join(workspace, "ludens.json"), "utf8")).model).toBe("openai-codex/gpt-6.1-sol");
  } finally {
    gate.resolve();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
