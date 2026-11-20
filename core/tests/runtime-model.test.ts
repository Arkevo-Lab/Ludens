import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import { ensureWorkspaceIdentity } from "@ludens/protocol/ludens";
import { dispatch } from "../src/daemon/transport.ts";
import { listAvailableOmpModels, resolveOmpImageModel } from "../src/core/agent-omp/models.ts";
import { createOmpAgent } from "../src/core/agent-omp/session.ts";
import { Runtime, type AgentRunner } from "../src/core/shiori/runtime.ts";
import { EventLog } from "../src/core/storage/events.ts";
import { resolveWorkspaceState } from "../src/core/storage/workspace-state.ts";
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

  expect(resolveOmpImageModel(probeRegistry, nextModelId).imageCountBudget).toBe(Infinity);
  if (textOnlyCandidate) {
    expect(() => resolveOmpImageModel(probeRegistry, `${textOnlyCandidate.provider}/${textOnlyCandidate.id}`))
      .toThrow("An image-capable model is required");
  }

  const state = await resolveWorkspaceState(workspace, home);
  const log = new EventLog(runDir, { id: "run-1", now: () => performance.now() }, workspace);
  const { devices } = createTestDeviceSession({ controllers: [] }, () => {});
  const runtime = new Runtime(devices, log.record, "run-1");

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
      model: "openai-codex/gpt-6.2-sol",
      authStorage: auth,
    });
    runtime.attach({ agent });

    expect(runtime.status()).toMatchObject({
      mode: "manual",
      agent: true,
      model: "openai-codex/gpt-6.2-sol",
    });

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
    expect(runtime.status().model).toBe("openai-codex/gpt-6.2-sol");

    await runtime.setModel("openai/gpt-6.2-sol", "ultrafast", "xhigh");
    expect(runtime.status().serviceTier).toBe("ultrafast");
    expect(runtime.status().effort).toBe("xhigh");

    const switched = await runtime.setModel(nextModelId, undefined, null);
    expect(switched).toMatchObject({
      mode: "manual",
      model: nextModelId,
      serviceTier: null,
      effort: null,
    });
    expect(runtime.status().model).toBe(nextModelId);

    await log.flush();
    const rawEvents = (await readFile(join(runDir, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(line => JSON.parse(line) as { type: string; source?: { component?: string }; data?: { model?: string } });
    const sessionEvents = rawEvents.filter(event => event.type === "session" && event.source?.component === "shiori");
    expect(sessionEvents.map(event => event.data?.model)).toEqual([
      "openai-codex/gpt-6.2-sol",
      "openai/gpt-6.2-sol",
      nextModelId,
    ]);
    expect(network).not.toHaveBeenCalled();

    await writeFile(join(workspace, "ludens.json"), JSON.stringify({ model: "openai/gpt-6.2-sol" }));
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
      model: "openai/gpt-6.2-sol",
      authStorage: auth,
    });
    runtime.attach({ agent: resumedAgent });
    expect(runtime.status().serviceTier).toBeNull();
    expect(runtime.status().effort).toBeNull();
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
  let currentModel = "openai-codex/gpt-6.2-sol";
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
    await runtime.start();
    expect(runtime.status()).toMatchObject({ mode: "auto", model: "openai-codex/gpt-6.2-sol" });
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
    expect(currentModel).toBe("openai-codex/gpt-6.2-sol");

    await runtime.stop("human");
    await runtime.runSettled;

    await runtime.consolidate(60);
    expect(runtime.status()).toMatchObject({ mode: "manual", consolidating: true });
    await expect(runtime.setModel("anthropic/claude-sonnet-4-5"))
      .rejects.toThrow("Cannot switch model while Shiori is running; pause auto loop first");
    expect(currentModel).toBe("openai-codex/gpt-6.2-sol");

    consolidateGate.resolve();
    await runtime.runSettled;

    const updated = await dispatch(runtime, {
      kind: "model",
      argv: ["anthropic/claude-sonnet-4-5"],
      runId: runtime.status().runId,
      expectedEpoch: null,
    });
    expect(updated).toMatchObject({ mode: "manual", model: "anthropic/claude-sonnet-4-5" });
    expect(await dispatch(runtime, { kind: "model", argv: [] })).toEqual({
      model: "anthropic/claude-sonnet-4-5",
      serviceTier: null,
      effort: null,
    });
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

    expect(catalog.models.find(item => item.fullId === "custom-vision/v1-text-only")).toBeUndefined();
    for (const item of catalog.models) {
      const raw = resolveOmpImageModel(registry, item.fullId);
      expect(raw?.input.includes("image")).toBe(true);
    }

    const customVision = catalog.models.find(item => item.fullId === "custom-vision/v1-vision");
    expect(customVision).toMatchObject({
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
    expect(Array.isArray(customVision?.supportedEfforts)).toBe(true);

    const codexSol = catalog.models.find(item => item.fullId === "openai-codex/gpt-6.2-sol");
    expect(codexSol?.authenticated).toBe(true);
    expect(codexSol?.supportedEfforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(codexSol?.defaultEffort).toBe("high");
    const openaiSol = catalog.models.find(item => item.fullId === "openai/gpt-6.2-sol");
    expect(openaiSol?.supportedServiceTiers).toEqual(["priority", "ultrafast"]);
    const googleModels = catalog.models.filter(item => item.provider === "google");
    expect(googleModels.length).toBeGreaterThan(0);
    expect(googleModels.every(item => item.supportedServiceTiers.length === 0)).toBe(true);
    const tieredCatalog = await listAvailableOmpModels({
      workspace,
      home,
      modelRegistry: registry,
      currentModel: "openai/gpt-6.2-sol",
      currentServiceTier: "ultrafast",
      currentEffort: "xhigh",
    });
    expect(tieredCatalog.currentServiceTier).toBe("ultrafast");
    expect(tieredCatalog.currentEffort).toBe("xhigh");

    const unauthedVision = catalog.models.find(item => item.fullId === "unauthed-vision/u-vision");
    expect(unauthedVision?.authenticated).toBe(false);

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
  } finally {
    auth.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
