import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as piAi from "@oh-my-pi/pi-ai";
import type { AssistantMessage, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import * as codingAgent from "@oh-my-pi/pi-coding-agent";
import { AuthStorage, ModelRegistry, SessionManager, Settings, type ProviderDiscoveryState } from "@oh-my-pi/pi-coding-agent";
import {
  listAvailableOmpModels,
  resolveOmpImageModel,
  shouldSynthesizeOfflineCodexModels,
} from "../src/core/agent-omp/models.ts";
import { createOmpSession, ompSessionOptions } from "../src/core/agent-omp/session.ts";

test("ompSessionOptions locks out model fallback, server-side fallback, auto-prewalk, and finite image budgets by default", async () => {
  const auth = await AuthStorage.create(":memory:");
  try {
    const registry = new ModelRegistry(auth, undefined, { settings: Settings.isolated({}) });
    const rawModel = resolveOmpImageModel(registry, "openai-codex/gpt-6.2-sol");
    expect(rawModel).toBeDefined();

    const normalized = ompSessionOptions({
      model: { ...rawModel, imageCountBudget: 5 },
      disableModelFallback: undefined,
      disableServerSideFallback: undefined,
      suppressAutoPrewalk: undefined,
    });

    expect(normalized.disableModelFallback).toBe(true);
    expect(normalized.disableServerSideFallback).toBe(true);
    expect(normalized.suppressAutoPrewalk).toBe(true);
    expect(normalized.model.imageCountBudget).toBe(Infinity);
  } finally {
    auth.close();
  }
});

test("createOmpSession enforces sticky multimodal model invariants across stream options, retry chains, and prewalk.auto", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ludens-model-stickiness-"));
  const workspace = join(directory, "workspace");
  await mkdir(workspace, { recursive: true });
  const network = spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("Unexpected network request in offline stickiness test"),
  );

  // Deliberately enable OMP fallback/prewalk knobs in Settings to prove session-level
  // flags (`disableModelFallback`, `disableServerSideFallback`, `suppressAutoPrewalk`)
  // still hold the selected multimodal model sticky.
  const settings = Settings.isolated({
    "retry.enabled": true,
    "retry.maxRetries": 0,
    "retry.modelFallback": true,
    "retry.fallbackChains": {
      default: {
        primary: "openai-codex/gpt-6.2-sol",
        chain: ["openai/gpt-6.2-sol"],
      },
    },
    "prewalk.auto": "on",
    "title.refreshOnReplan": false,
  });

  const auth = await AuthStorage.create(join(directory, "auth.db"));
  auth.keys.setRuntime("openai-codex", "offline-codex-key");
  auth.keys.setRuntime("openai", "offline-openai-key");
  const registry = new ModelRegistry(auth, undefined, { settings });
  const rawCodexModel = resolveOmpImageModel(registry, "openai-codex/gpt-6.2-sol");
  expect(rawCodexModel).toBeDefined();

  const createSessionSpy = spyOn(codingAgent, "createAgentSession");
  const seenStreamCalls: Array<{ provider: string; id: string; options?: SimpleStreamOptions }> = [];
  let failTurn = false;

  const streamSpy = spyOn(piAi, "streamSimple").mockImplementation((model, _context, options) => {
    seenStreamCalls.push({ provider: model.provider, id: model.id, options });
    const stream = new AssistantMessageEventStream();
    if (failTurn) {
      const error: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [],
        timestamp: Date.now(),
        stopReason: "error",
        errorMessage: "HTTP 529 overloaded",
        errorId: AIError.create(AIError.Flag.Transient | AIError.Flag.UsageLimit),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      queueMicrotask(() => stream.push({ type: "error", reason: "error", error }));
      return stream;
    }
    const done: AssistantMessage = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [{ type: "text", text: "Sticky model response." }],
      timestamp: Date.now(),
      stopReason: "stop",
      usage: {
        input: 32,
        output: 8,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 40,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: done });
      stream.push({ type: "done", reason: "stop", message: done });
    });
    return stream;
  });

  try {
    const { session } = await createOmpSession({
      cwd: workspace,
      agentDir: join(directory, "omp"),
      model: { ...rawCodexModel, imageCountBudget: 5 },
      authStorage: auth,
      modelRegistry: registry,
      settings,
      sessionManager: SessionManager.create(workspace, join(directory, "session")),
      systemPrompt: "Offline stickiness verification.",
      cacheWarming: false,
      skills: [],
      rules: [],
      contextFiles: [],
      promptTemplates: [],
      slashCommands: [],
      enableMCP: false,
      enableLsp: false,
      enableIrc: false,
      skipPythonPreflight: true,
      disableExtensionDiscovery: true,
      restrictToolNames: true,
      toolNames: ["read", "write", "edit"],
    });

    try {
      expect(createSessionSpy).toHaveBeenCalledTimes(1);
      const forwardedOptions = createSessionSpy.mock.calls[0]?.[0];
      expect(forwardedOptions).toMatchObject({
        disableModelFallback: true,
        disableServerSideFallback: true,
        suppressAutoPrewalk: true,
      });
      expect(session.model?.imageCountBudget).toBe(Infinity);

      // 1) Normal turn with `prewalk.auto: "on"` must not run an auto-prewalk classifier
      //    or switch away from `openai-codex/gpt-6.2-sol`, and must pass `disableServerSideFallback: true`.
      await session.prompt("Implement a large multi-step architectural refactor across modules.");
      expect(seenStreamCalls).toHaveLength(1);
      expect(`${seenStreamCalls[0]!.provider}/${seenStreamCalls[0]!.id}`).toBe("openai-codex/gpt-6.2-sol");
      expect(seenStreamCalls[0]!.options?.disableServerSideFallback).toBe(true);
      expect(seenStreamCalls[0]!.options?.fallbacks).toBeUndefined();
      expect(`${session.model?.provider}/${session.model?.id}`).toBe("openai-codex/gpt-6.2-sol");

      // Even if a caller supplies `fallbacks` on streamOptions, session streamFn drops it.
      await session.agent.streamFn(
        session.model!,
        { systemPrompt: [], messages: [], tools: [] },
        { fallbacks: ["openai/gpt-6.2-sol"] } as unknown as SimpleStreamOptions,
      );
      expect(seenStreamCalls.at(-1)?.options?.disableServerSideFallback).toBe(true);
      expect(seenStreamCalls.at(-1)?.options?.fallbacks).toBeUndefined();

      // 2) Overloaded failure with a configured `retry.fallbackChains` target (`openai/gpt-6.2-sol`)
      //    must NOT fall back to `openai/gpt-6.2-sol` because `disableModelFallback: true` is active.
      failTurn = true;
      seenStreamCalls.length = 0;
      await session.prompt("Trigger overloaded failure.");
      expect(seenStreamCalls.map(call => `${call.provider}/${call.id}`)).toEqual(["openai-codex/gpt-6.2-sol"]);
      expect(`${session.model?.provider}/${session.model?.id}`).toBe("openai-codex/gpt-6.2-sol");
      expect(session.model?.imageCountBudget).toBe(Infinity);
      expect(network).not.toHaveBeenCalled();
    } finally {
      await session.dispose();
    }
  } finally {
    streamSpy.mockRestore();
    createSessionSpy.mockRestore();
    auth.close();
    network.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});

test("OFFLINE_CODEX_MODELS synthesis respects authoritative openai-codex discovery state", async () => {
  const auth = await AuthStorage.create(":memory:");
  auth.keys.setRuntime("openai-codex", "offline-codex-key");
  try {
    const registry = new ModelRegistry(auth, "/tmp/nonexistent-ludens-models.yml", {
      settings: Settings.isolated({}),
    });

    // Cold / idle / bundled / stale / unavailable / unauthenticated states allow offline 6.2 fallback.
    expect(shouldSynthesizeOfflineCodexModels(registry)).toBe(true);
    expect(resolveOmpImageModel(registry, "openai-codex/gpt-6.2-sol").id).toBe("gpt-6.2-sol");
    expect(resolveOmpImageModel(registry, "openai-codex/gpt-6.2-astra").id).toBe("gpt-6.2-astra");

    const discoverySpy = spyOn(registry, "getProviderDiscoveryState");
    for (const nonAuthoritative of [
      { provider: "openai-codex", status: "idle", optional: false, stale: false, models: [] },
      { provider: "openai-codex", status: "ok", optional: false, stale: false, source: "bundled", models: [] },
      { provider: "openai-codex", status: "cached", optional: false, stale: true, source: "cache", models: [] },
      { provider: "openai-codex", status: "unavailable", optional: false, stale: false, models: [] },
      { provider: "openai-codex", status: "unauthenticated", optional: false, stale: false, models: [] },
    ] satisfies ProviderDiscoveryState[]) {
      discoverySpy.mockReturnValue(nonAuthoritative);
      expect(shouldSynthesizeOfflineCodexModels(registry)).toBe(true);
      expect(resolveOmpImageModel(registry, "openai-codex/gpt-6.2-astra").id).toBe("gpt-6.2-astra");
    }

    // Authoritative fresh `ok` or `cached` discovery suppresses synthesizing unentitled rows.
    for (const authoritative of [
      { provider: "openai-codex", status: "ok", optional: false, stale: false, source: "provider", models: ["gpt-6-sol"] },
      { provider: "openai-codex", status: "cached", optional: false, stale: false, source: "cache", models: ["gpt-6-sol"] },
    ] satisfies ProviderDiscoveryState[]) {
      discoverySpy.mockReturnValue(authoritative);
      expect(shouldSynthesizeOfflineCodexModels(registry)).toBe(false);
      expect(() => resolveOmpImageModel(registry, "openai-codex/gpt-6.2-astra")).toThrow(
        "An image-capable model is required: openai-codex/gpt-6.2-astra",
      );
      const catalog = await listAvailableOmpModels({ modelRegistry: registry });
      expect(catalog.models.some(item => item.fullId === "openai-codex/gpt-6.2-astra")).toBe(false);
      expect(catalog.models.some(item => item.fullId === "openai-codex/gpt-6.2-sol")).toBe(false);
    }

    discoverySpy.mockRestore();
  } finally {
    auth.close();
  }
});

test("createOmpSession guards agent.setModel and session.setModel against non-image models and finite imageCountBudget resets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ludens-model-guard-"));
  const workspace = join(directory, "workspace");
  await mkdir(workspace, { recursive: true });
  const network = spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("Unexpected network request in offline model guard test"),
  );

  const settings = Settings.isolated({ "retry.modelFallback": false, "title.refreshOnReplan": false });
  const auth = await AuthStorage.create(join(directory, "auth.db"));
  auth.keys.setRuntime("openai-codex", "offline-codex-key");
  auth.keys.setRuntime("openai", "offline-openai-key");
  const registry = new ModelRegistry(auth, "/tmp/nonexistent-ludens-models.yml", { settings });
  const codexModel = resolveOmpImageModel(registry, "openai-codex/gpt-6.2-sol");
  const openaiModel = registry.find("openai", "gpt-6.2-sol")!;
  const textOnlyModel = { ...openaiModel, id: "gpt-text-only", input: ["text" as const] };

  try {
    // 1) Startup with a non-image model rejects and disposes cleanly.
    await expect(
      createOmpSession({
        cwd: workspace,
        agentDir: join(directory, "omp-bad"),
        model: textOnlyModel,
        authStorage: auth,
        modelRegistry: registry,
        settings,
        sessionManager: SessionManager.inMemory(),
        cacheWarming: false,
        skills: [],
        rules: [],
        contextFiles: [],
        promptTemplates: [],
        slashCommands: [],
        enableMCP: false,
        enableLsp: false,
        enableIrc: false,
        skipPythonPreflight: true,
        disableExtensionDiscovery: true,
        restrictToolNames: true,
        toolNames: ["read"],
      }),
    ).rejects.toThrow("An image-capable model is required: openai/gpt-text-only");

    // 2) Live session preserves `imageCountBudget: Infinity` across metadata refresh (`agent.setModel`)
    //    and `session.setModel`, while rejecting non-image models upfront without mutating state or transcript.
    const manager = SessionManager.create(workspace, join(directory, "session"));
    const { session } = await createOmpSession({
      cwd: workspace,
      agentDir: join(directory, "omp"),
      model: { ...codexModel, imageCountBudget: 5 },
      authStorage: auth,
      modelRegistry: registry,
      settings,
      sessionManager: manager,
      cacheWarming: false,
      skills: [],
      rules: [],
      contextFiles: [],
      promptTemplates: [],
      slashCommands: [],
      enableMCP: false,
      enableLsp: false,
      enableIrc: false,
      skipPythonPreflight: true,
      disableExtensionDiscovery: true,
      restrictToolNames: true,
      toolNames: ["read"],
    });

    try {
      expect(session.model?.imageCountBudget).toBe(Infinity);

      // Simulate `refreshSelectedModelMetadata` calling `agent.setModel` with a catalog row whose budget is finite.
      session.agent.setModel({ ...codexModel, imageCountBudget: 3 });
      expect(`${session.model?.provider}/${session.model?.id}`).toBe("openai-codex/gpt-6.2-sol");
      expect(session.model?.imageCountBudget).toBe(Infinity);

      // Simulate `session.setModel` with a catalog row whose budget is undefined/finite.
      await session.setModel({ ...openaiModel, imageCountBudget: 5 }, "default", { persist: false });
      expect(`${session.model?.provider}/${session.model?.id}`).toBe("openai/gpt-6.2-sol");
      expect(session.model?.imageCountBudget).toBe(Infinity);

      const entriesBeforeReject = manager.getEntries().length;

      // Direct `agent.setModel` with text-only model throws before mutating `session.model`.
      expect(() => session.agent.setModel(textOnlyModel)).toThrow(
        "An image-capable model is required: openai/gpt-text-only",
      );
      expect(`${session.model?.provider}/${session.model?.id}`).toBe("openai/gpt-6.2-sol");
      expect(session.model?.imageCountBudget).toBe(Infinity);

      // `session.setModel` with text-only model rejects upfront without appending a model_change entry.
      await expect(session.setModel(textOnlyModel, "default", { persist: false })).rejects.toThrow(
        "An image-capable model is required: openai/gpt-text-only",
      );
      expect(`${session.model?.provider}/${session.model?.id}`).toBe("openai/gpt-6.2-sol");
      expect(session.model?.imageCountBudget).toBe(Infinity);
      expect(manager.getEntries().length).toBe(entriesBeforeReject);

      // Even if a candidate enters `session.setModel` with `input: ["text", "image"]` and
      // `modelRegistry.refreshSelectedModelMetadata` later strips `"image"` to `["text"]`,
      // the refresh guard rejects at `model-controls.ts:329` BEFORE `:333` closes the active
      // provider session (`#closeProviderSessionsForModelSwitch`) or mutates `session.model`.
      let providerSessionClosed = 0;
      session.providerSessionState.set("openai-responses:openai", {
        close() {
          providerSessionClosed += 1;
        },
      });
      const refreshSpy = spyOn(registry, "refreshSelectedModelMetadata").mockResolvedValueOnce({
        ...codexModel,
        id: "gpt-runtime-text-only",
        input: ["text"],
      });
      try {
        await expect(
          session.setModel({ ...codexModel, id: "gpt-runtime-text-only", input: ["text", "image"] }, "default", {
            persist: false,
          }),
        ).rejects.toThrow("An image-capable model is required: openai-codex/gpt-runtime-text-only");
      } finally {
        refreshSpy.mockRestore();
      }
      expect(providerSessionClosed).toBe(0);
      expect(session.providerSessionState.has("openai-responses:openai")).toBe(true);
      expect(`${session.model?.provider}/${session.model?.id}`).toBe("openai/gpt-6.2-sol");
      expect(session.model?.imageCountBudget).toBe(Infinity);
      expect(manager.getEntries().length).toBe(entriesBeforeReject);
      expect(network).not.toHaveBeenCalled();
    } finally {
      await session.dispose();
    }
  } finally {
    auth.close();
    network.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});
