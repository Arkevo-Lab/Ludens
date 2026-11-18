import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as piAi from "@oh-my-pi/pi-ai";
import type { AssistantMessage, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import * as codingAgent from "@oh-my-pi/pi-coding-agent";
import { AuthStorage, ModelRegistry, SessionManager, Settings } from "@oh-my-pi/pi-coding-agent";
import { resolveOmpImageModel } from "../src/core/agent-omp/models.ts";
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
