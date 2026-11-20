import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, ModelRegistry, SessionManager, Settings } from "@oh-my-pi/pi-coding-agent";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { createLudensExtension, type Cycle } from "../src/core/agent-omp/extension.ts";
import { resolveOmpImageModel } from "../src/core/agent-omp/models.ts";
import { createOmpSession } from "../src/core/agent-omp/session.ts";
import { Workspace } from "../src/core/storage/workspace.ts";
import { createTestRuntime } from "./runtime-fixture.ts";

test.each(["timer expired", "human handback"] as const)("native OMP retries respect Ludens %s", async mode => {
  const directory = await mkdtemp(join(tmpdir(), "ludens-retry-budget-"));
  const workspace = join(directory, "workspace");
  await mkdir(join(workspace, "skills"), { recursive: true });
  const network = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request in offline retry test"));
  const contexts: { epoch?: string; request: number }[] = [];
  const runtime = createTestRuntime({ controllers: [] }, (type, data, trace) => {
    if (type === "context") contexts.push({ epoch: trace?.epoch, request: (data as { request: number }).request });
  });
  // Leave retry.enabled and its backoff settings unset, just like the host.
  const settings = Settings.isolated({ "retry.modelFallback": false, "title.refreshOnReplan": false });
  const auth = await AuthStorage.create(join(directory, "auth.db"));
  auth.keys.setRuntime("openai-codex", "offline-test-only");
  const registry = new ModelRegistry(auth, undefined, { settings });
  const model = resolveOmpImageModel(registry, "openai-codex/gpt-6.2-sol");
  let cycle: Cycle | undefined;
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  const extension = createLudensExtension({ runtime, workspace: new Workspace(workspace, join(directory, "versions")),
    basewareSocket: "/tmp/unused.sock", binDir: "/tmp",
    cycle: () => { if (!cycle) throw new Error("No active control cycle"); return cycle; },
  });
  try {
    const { session } = await createOmpSession({ cwd: workspace, agentDir: join(directory, "omp"), model,
      authStorage: auth, modelRegistry: registry, settings,
      sessionManager: SessionManager.create(workspace, join(directory, "session")),
      systemPrompt: "Exercise offline transient failures.", cacheWarming: false,
      skills: [], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [],
      enableMCP: false, enableLsp: false, enableIrc: false, skipPythonPreflight: true,
      disableExtensionDiscovery: true, restrictToolNames: true, allowRestrictedCustomTools: true,
      toolNames: ["observe"], customTools: extension.tools,
      preloadedPreparedExtensions: [{ path: "ludens-retry-test", resolvedPath: "ludens-retry-test", factory: extension.factory, error: null }],
    });
    const removeGate = session.agent.addBeforeModelCall(() =>
      cycle && !cycle.signal.aborted ? undefined : { stop: true, reason: "Ludens control cycle is inactive" });
    const retryAttempts: number[] = [];
    const unsubscribe = session.subscribe(event => {
      if (event.type !== "auto_retry_start") return;
      retryAttempts.push(event.attempt);
      // Let the native handler enter its backoff before reclaiming control.
      if (mode === "human handback") cancelTimer = setTimeout(() => { void runtime.stop("human"); }, 0);
      else cancelTimer = setTimeout(() => { void runtime.setTimer(0.01); }, 0);
    });
    let calls = 0;
    session.agent.streamFn = async () => {
      calls++;
      const error: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [], timestamp: Date.now(), stopReason: "error",
        errorMessage: "HTTP 500 synthetic server error", errorId: AIError.create(AIError.Flag.Transient),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = new AssistantMessageEventStream();
      stream.push({ type: "error", reason: "error", error });
      return stream;
    };
    runtime.attach({ agent: {
      async run(context) {
        cycle = context;
        try { await session.prompt("Retry transient failures until control ends."); }
        finally { cycle = undefined; }
      },
      async consolidate() {},
      abort: () => session.abort(),
      async close() { unsubscribe(); removeGate(); await session.dispose(); },
    } });
    const { epoch } = await runtime.start();
    if (!epoch) throw new Error("Runtime did not create a control epoch");
    const deadline = performance.now() + 5000;
    while (runtime.status().mode !== "manual" || runtime.status().thinking) {
      if (performance.now() > deadline) throw new Error("Native retry did not settle after Ludens control ended");
      await Bun.sleep(10);
    }
    expect(calls).toBe(1);
    expect(contexts).toEqual([{ epoch, request: 1 }]);
    expect(retryAttempts).toEqual([1]);
    expect(runtime.status()).toMatchObject({ mode: "manual", reason: mode === "timer expired" ? "timer expired" : "human" });
    expect(session.isRetrying).toBe(false);
    expect(network).not.toHaveBeenCalled();
  } finally {
    clearTimeout(cancelTimer);
    await runtime.close();
    auth.close();
    network.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);
