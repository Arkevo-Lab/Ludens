import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createLudensExtension, type Cycle } from "../src/core/agent-omp/extension.ts";
import { createOmpLoopDriver, type OmpLoopSessionSurface } from "../src/core/agent-omp/session.ts";
import { LoopRuntime } from "../src/core/subsystems/loop.ts";
import { PerceptionRuntime, type PerceptionRead, type PerceptionStatus } from "../src/core/subsystems/perception.ts";
import { WorkspaceController } from "../src/core/subsystems/controller.ts";
import { Workspace } from "../src/core/storage/workspace.ts";
import type { AgentRunner } from "../src/core/shiori/runtime.ts";
import { listen } from "../src/daemon/transport.ts";
import { captureResult, createTestDeviceSession } from "./runtime-fixture.ts";
import { Runtime } from "../src/core/shiori/runtime.ts";
import { testSocketPath } from "./socket-path.ts";

const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==";

const injectedEnvKeys = [
  "LUDENS_PYTHON",
  "PATH",
  "PYTHONPATH",
  "LUDENS_SOCKET",
  "LUDENS_WORKSPACE",
  "LUDENS_RUN_ID",
  "LUDENS_LOG_DIAGNOSTICS",
  "LUDENS_ARTIFACT_ROOT",
  "BASEWARE_SOCKET",
  "BASEWARE_EPOCH",
  "BASEWARE_TRACE",
  "LUDENS_EPOCH",
  "LUDENS_TRACE",
];
const savedEnv = Object.fromEntries(injectedEnvKeys.map(key => [key, process.env[key]]));
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
});

interface CapturedPromptTurn {
  prompt: string;
  tools: string[];
  injectedMessage: { customType: string; content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> } | undefined;
}

async function createLoopHarness(options: {
  onPrompt?: (turnIndex: number, turn: CapturedPromptTurn) => Promise<void> | void;
  onControllerCall?: (args: Record<string, unknown>, epoch?: string) => void;
} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ludens-omp-loop-")));
  const workspace = join(root, "workspace");
  const runDir = join(root, "logs", "run-loop");
  await mkdir(join(workspace, "skills"), { recursive: true });
  await mkdir(runDir, { recursive: true });

  const events: Array<{ type: string; data: any; trace: any }> = [];
  const record = (type: string, data: unknown, trace?: unknown) => {
    events.push({ type, data, trace });
  };

  const controllerCalls: Array<{ args: Record<string, unknown>; epoch?: string }> = [];
  const { devices } = createTestDeviceSession(
    {
      controllers: [
        {
          tool: {
            name: "actuator",
            description: "Apply deterministic control thrust under lease",
            inputSchema: {
              type: "object",
              properties: { thrust: { type: "number" } },
              required: ["thrust"],
            },
          },
          requiresControl: true,
          async execute(args, ctx) {
            controllerCalls.push({ args: args as Record<string, unknown>, epoch: ctx.epoch });
            options.onControllerCall?.(args as Record<string, unknown>, ctx.epoch);
            return { ...captureResult([]), stdout: JSON.stringify({ applied: args }) };
          },
        },
      ],
    },
    record,
  );

  const socketPath = testSocketPath("loop");
  const runtime = new Runtime(devices, record, "run-loop");
  runtime.attach({
    controller: new WorkspaceController({
      workspace,
      devices,
      record,
      env: { LUDENS_SOCKET: socketPath, LUDENS_WORKSPACE: workspace, LUDENS_RUN_ID: "run-loop" },
    }),
  });

  // Stubbed fast PerceptionRuntime returning rich internal telemetry fields so lean dehydration is verified end-to-end.
  const perception = new PerceptionRuntime({ workspace, runDir, record });
  let perceptionStatus: PerceptionStatus = {
    state: "ready",
    generation: "perception-gen-1",
    codeSHA: "a".repeat(64),
  };
  let observeCalls = 0;
  let frameSeq = 0;
  perception.status = () => perceptionStatus;
  perception.setLease = async () => ({ epoch: runtime.status().epoch, inputGeneration: perceptionStatus.generation });
  perception.observe = async (signal): Promise<PerceptionRead> => {
    signal.throwIfAborted();
    observeCalls++;
    const seq = ++frameSeq;
    return {
      queryId: `query-${seq}`,
      ok: true,
      query: {},
      hasMore: false,
      availability: {
        persistent: true,
        hotSeconds: 60,
        earliest: { sequence: 1, recordedAt: "2026-11-17T00:00:01.000Z" },
        latest: { sequence: seq, recordedAt: `2026-11-17T00:00:0${Math.min(seq, 9)}.000Z` },
        expired: false,
      },
      records: [
        {
          id: `rec-${seq}`,
          sequence: seq,
          generation: perceptionStatus.generation,
          capability: "python/perception.py:Perception.sample",
          identity: { id: "python/perception.py:Perception.sample", codeSHA: "b".repeat(64), origin: { path: "perception.py" } },
          trace: { spanId: `span-${seq}` },
          runId: "run-loop",
          timeline: { recordId: `rec-${seq}`, sequence: seq },
          recordedAt: `2026-11-17T00:00:0${Math.min(seq, 9)}.000Z`,
          sampledAt: `2026-11-17T00:00:0${Math.min(seq, 9)}.000Z`,
          sampling: { clock: "sampler", startedAtMs: seq * 10, finishedAtMs: seq * 10 + 4 },
          sources: [{ id: "cam-0", timing: { requestedAtMs: 1, receivedAtMs: 2 } }],
          text: `frame-${seq}`,
          data: { altitude: 100 + seq },
          space: { frame: "world" },
          media: [
            {
              id: `obs-${seq}`,
              controllerId: "perception",
              mediaType: "image/png",
              data: TINY_PNG,
              timing: { clock: "sampler", requestedAtMs: seq * 10, receivedAtMs: seq * 10 + 4 },
            },
          ],
        },
      ],
    };
  };
  runtime.attach({ perception });

  const loop = new LoopRuntime({
    workspace,
    runDir,
    socketPath,
    record,
    env: {
      ...(process.env.PYTHONPATH ? { PYTHONPATH: process.env.PYTHONPATH } : {}),
      LUDENS_SOCKET: socketPath,
      LUDENS_WORKSPACE: workspace,
      LUDENS_RUN_ID: "run-loop",
    },
  });
  runtime.attach({ loop });

  const closeSocket = await listen(socketPath, runtime);

  let currentCycle: Cycle | undefined;
  const extension = createLudensExtension({
    runtime,
    workspace: new Workspace(workspace, join(root, "versions")),
    basewareSocket: "/tmp/unused-baseware.sock",
    ludensSocket: socketPath,
    binDir: "/tmp",
    runDir,
    cycle: () => {
      if (!currentCycle) throw new Error("No active control cycle");
      return currentCycle;
    },
  });

  const handlers: Record<string, (event: any) => any> = {};
  await extension.factory({
    on(name: string, handler: (event: any) => any) {
      handlers[name] = handler;
    },
  } as ExtensionAPI);

  let activeTools = ["read", "write", "edit", "observe", "event_pool", "bash", "wait"];
  let lastMessage: AssistantMessage | undefined;
  const turns: CapturedPromptTurn[] = [];
  let aborted = false;

  const session: OmpLoopSessionSurface = {
    getActiveToolNames: () => [...activeTools],
    async setActiveToolsByName(names) {
      activeTools = [...names];
    },
    async prompt(text: string) {
      const injected = await handlers.before_agent_start?.({});
      await handlers.context?.({ messages: [] });
      const captured: CapturedPromptTurn = {
        prompt: text,
        tools: [...activeTools],
        injectedMessage: injected?.message,
      };
      turns.push(captured);
      lastMessage = {
        role: "assistant",
        api: "openai-codex-responses",
        provider: "openai-codex",
        model: "gpt-6.2-sol",
        timestamp: Date.now(),
        content: [{ type: "text", text: `ack-${turns.length}` }],
        stopReason: aborted || currentCycle?.signal.aborted ? "aborted" : "stop",
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      await handlers.assistant_message?.({});
      await options.onPrompt?.(turns.length, captured);
    },
    getLastAssistantMessage: () => lastMessage,
    async abort() {
      aborted = true;
    },
  };

  const driver = createOmpLoopDriver({
    runtime,
    workspace,
    loop,
    session,
    prepareTurn: extension.prepareTurn,
    setCycle: next => {
      currentCycle = next;
    },
  });

  const agent: AgentRunner = {
    run: ctx => driver.run(ctx),
    async consolidate() {},
    steer: msg => driver.steer(msg),
    queueState: () => driver.queueState(),
    abort: () => session.abort(),
    async close() {},
  };
  runtime.attach({ agent });

  return {
    root,
    workspace,
    runDir,
    socketPath,
    runtime,
    loop,
    events,
    turns,
    controllerCalls,
    getObserveCalls: () => observeCalls,
    async close() {
      await handlers.session_shutdown?.({});
      await runtime.close();
      await closeSocket();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("default workspace without loop.py delivers lean payload with zero bloat fields and single perception read", async () => {
  const h = await createLoopHarness({
    onPrompt: async (turnIndex) => {
      if (turnIndex >= 1) await h.runtime.stop("human");
    },
  });
  try {
    await h.runtime.start("inspect scene");
    await h.runtime.runSettled;

    expect(h.turns).toHaveLength(1);
    expect(h.getObserveCalls()).toBe(1);
    expect(h.loop.status().state).toBe("unimplemented");
    expect(h.events.filter(e => e.type === "loop_step")).toHaveLength(0);
    expect(h.events.filter(e => e.type === "loop_fault")).toHaveLength(0);

    const content = h.turns[0]!.injectedMessage?.content ?? [];
    expect(content.filter(part => part.type === "image")).toHaveLength(1);
    const textPart = content.find(part => part.type === "text");
    expect(textPart).toBeDefined();
    const parsed = JSON.parse(textPart!.text!);
    expect(parsed).toEqual({
      ok: true,
      records: [
        {
          id: "rec-1",
          sequence: 1,
          recordedAt: "2026-11-17T00:00:01.000Z",
          text: "frame-1",
          data: { altitude: 101 },
          space: { frame: "world" },
        },
      ],
    });
    for (const bloat of ["queryId", "query", "hasMore", "availability"]) {
      expect(parsed).not.toHaveProperty(bloat);
    }
    for (const bloat of ["generation", "codeSHA", "sampling", "sampledAt", "sources", "media", "capability"]) {
      expect(parsed.records[0]).not.toHaveProperty(bloat);
    }

    const obsCtx = h.events.find(e => e.type === "observation_context");
    expect(obsCtx?.data).toMatchObject({
      origin: "prompt_start",
      observations: ["obs-1"],
      queries: ["query-1"],
      deliveredPayload: parsed,
      injectionMode: "structured",
      attachImages: true,
    });
    expect(obsCtx?.data).not.toHaveProperty("records");
    expect(obsCtx?.data).not.toHaveProperty("snapshot");
  } finally {
    await h.close();
  }
});

test("loop.py inject(ctx) mutates TurnInjection (attach_images=False, extra) and supports dict, str, and None modes", async () => {
  const h = await createLoopHarness();
  try {
    await writeFile(
      join(h.workspace, "loop.py"),
      `from ludens_tools import Loop, Prompt, Stop

class Loop(Loop):
    def inject(self, ctx):
        if ctx.llm_turns == 0:
            inj = ctx.default_inject()
            inj.attach_images = False
            inj.extra.append({"checklist": ["altitude", "attitude"]})
            return inj
        if ctx.llm_turns == 1:
            return {"customSummary": ctx.perception["records"][0]["text"]}
        if ctx.llm_turns == 2:
            return "RAW_TEXT_CONTEXT"
        return None

    def step(self, ctx):
        if ctx.llm_turns >= 4:
            return Stop("injection_modes_verified")
        return Prompt(prompt=f"turn-{ctx.llm_turns + 1}")
`,
    );

    await h.runtime.start();
    await h.runtime.runSettled;

    expect(h.turns).toHaveLength(4);
    expect(h.turns.map(t => t.prompt)).toEqual(["turn-1", "turn-2", "turn-3", "turn-4"]);

    // Turn 1: structured TurnInjection with attach_images=False and extra
    const turn1Content = h.turns[0]!.injectedMessage?.content ?? [];
    expect(turn1Content.filter(p => p.type === "image")).toHaveLength(0);
    const turn1Json = JSON.parse(turn1Content.find(p => p.type === "text")!.text!);
    expect(turn1Json).toMatchObject({
      ok: true,
      extra: [{ checklist: ["altitude", "attitude"] }],
    });

    // Turn 2: custom_json dict (attaches images by default)
    const turn2Content = h.turns[1]!.injectedMessage?.content ?? [];
    expect(turn2Content.filter(p => p.type === "image")).toHaveLength(1);
    expect(JSON.parse(turn2Content.find(p => p.type === "text")!.text!)).toEqual({
      customSummary: "frame-2",
    });

    // Turn 3: custom_text str (attaches images by default)
    const turn3Content = h.turns[2]!.injectedMessage?.content ?? [];
    expect(turn3Content.filter(p => p.type === "image")).toHaveLength(1);
    expect(turn3Content.find(p => p.type === "text")!.text).toBe("RAW_TEXT_CONTEXT");

    // Turn 4: None (omits observation message and attaches zero images)
    expect(h.turns[3]!.injectedMessage).toBeUndefined();

    const receipts = h.events.filter(e => e.type === "observation_context");
    expect(receipts).toHaveLength(4);
    expect(receipts[0]!.data).toMatchObject({
      observations: [],
      injectionMode: "structured",
      attachImages: false,
      deliveredPayload: turn1Json,
    });
    expect(receipts[1]!.data).toMatchObject({
      observations: ["obs-2"],
      injectionMode: "custom_json",
      attachImages: true,
      deliveredPayload: { customSummary: "frame-2" },
    });
    expect(receipts[2]!.data).toMatchObject({
      observations: ["obs-3"],
      injectionMode: "custom_text",
      attachImages: true,
      deliveredPayload: "RAW_TEXT_CONTEXT",
    });
    expect(receipts[3]!.data).toMatchObject({
      observations: [],
      injectionMode: "none",
      attachImages: false,
      deliveredPayload: null,
    });
  } finally {
    await h.close();
  }
}, 20_000);

test("loop.py step(ctx) invokes @capability via Client().call under epoch, runs Wait + Consolidate, and propagates Stop('goal_met')", async () => {
  const h = await createLoopHarness();
  try {
    await writeFile(
      join(h.workspace, "macros.py"),
      `from ludens_tools import Client, capability

@capability
def boost_once(power: int) -> dict:
    """Invoke a lease-gated controller capability from Python."""
    res = Client().call("controller/actuator", {"thrust": power})
    return {"ok": True, "power": power, "status": res.get("status")}
`,
    );

    await writeFile(
      join(h.workspace, "loop.py"),
      `from ludens_tools import Client, Consolidate, Loop, Prompt, Stop, Wait

class Loop(Loop):
    def step(self, ctx):
        if ctx.turn == 1:
            Client().call("python/macros.py:boost_once", {"power": 42})
            return Wait(0.03, reason="actuator_settle")
        if ctx.turn == 2:
            return Prompt(prompt="Check post-boost telemetry.")
        if ctx.turn == 3:
            return Consolidate(prompt="Record boost outcome in memory.")
        return Stop("goal_met")
`,
    );

    const started = await h.runtime.start("begin mission");
    const epoch = started.epoch!;
    await h.runtime.runSettled;

    // Lease-gated controller capability ran under the active cycle epoch during turn 1 with recordingPurpose: "loop"
    expect(h.controllerCalls).toEqual([{ args: { thrust: 42 }, epoch }]);
    expect(
      h.events.some(
        e =>
          e.type === "python_call_end" &&
          e.trace?.epoch === epoch &&
          !e.trace?.modelCallId &&
          e.trace?.recordingPurpose === "loop",
      ),
    ).toBe(true);
    expect(
      h.events.some(
        e =>
          e.type === "capability_end" &&
          e.data?.id === "controller/actuator" &&
          e.trace?.epoch === epoch &&
          !e.trace?.modelCallId &&
          e.trace?.recordingPurpose === "loop",
      ),
    ).toBe(true);
    expect(h.events.filter(e => e.type === "loop_step").every(e => e.trace?.recordingPurpose === "loop")).toBe(true);

    // Turn 2 ran normal Prompt with full toolset; Turn 3 ran in-cycle Consolidate with file tools only
    expect(h.turns).toHaveLength(2);
    expect(h.turns[0]!.prompt).toBe("Check post-boost telemetry.");
    expect(h.turns[0]!.tools).toContain("bash");
    expect(h.turns[1]!.prompt).toContain("Record boost outcome in memory.");
    expect(h.turns[1]!.tools.sort()).toEqual(["edit", "read", "write"]);
    expect(h.turns[1]!.injectedMessage).toBeUndefined();

    // loop_step sequence recorded cleanly
    const loopSteps = h.events.filter(e => e.type === "loop_step").map(e => ({
      turn: e.data.turn,
      action: e.data.action,
      reason: e.data.reason,
    }));
    expect(loopSteps).toEqual([
      { turn: 1, action: "wait", reason: "actuator_settle" },
      { turn: 2, action: "prompt", reason: undefined },
      { turn: 3, action: "consolidate", reason: undefined },
      { turn: 4, action: "stop", reason: "goal_met" },
    ]);

    // Stop("goal_met") propagated to Shiori Runtime status and closing control event
    expect(h.runtime.status()).toMatchObject({
      mode: "manual",
      reason: "loop: goal_met",
    });
    const finalControl = h.events.findLast(e => e.type === "control" && e.data.mode === "manual");
    expect(finalControl?.data.reason).toBe("loop: goal_met");
  } finally {
    await h.close();
  }
}, 20_000);

test("loop.py syntax and runtime errors emit loop_fault, fall back with loopFault in deliveredPayload, and hot-reload on repair", async () => {
  const h = await createLoopHarness({
    onPrompt: async (turnIndex) => {
      if (turnIndex === 1) {
        // Repair syntax error, but introduce a runtime error in step()
        await writeFile(
          join(h.workspace, "loop.py"),
          `from ludens_tools import Loop

class Loop(Loop):
    def step(self, ctx):
        raise RuntimeError("divider exploded")
`,
        );
      } else if (turnIndex === 2) {
        // Repair loop.py completely using an imported workspace helper module
        await writeFile(join(h.workspace, "policy_helper.py"), `REASON = "recovered_cleanly"\n`);
        await writeFile(
          join(h.workspace, "loop.py"),
          `from ludens_tools import Loop, Prompt, Stop
import policy_helper

class Loop(Loop):
    def inject(self, ctx):
        inj = ctx.default_inject()
        inj.extra.append({"status": policy_helper.REASON})
        return inj

    def step(self, ctx):
        if ctx.llm_turns >= 3:
            return Stop(policy_helper.REASON)
        return Prompt(prompt="verify clean reload")
`,
        );
      }
    },
  });

  try {
    // Start with syntactically broken loop.py
    await writeFile(join(h.workspace, "loop.py"), "def broken_syntax(:\n");

    await h.runtime.start();
    await h.runtime.runSettled;

    expect(h.turns).toHaveLength(3);

    // Faults recorded for both load (SyntaxError) and step (RuntimeError)
    const faults = h.events.filter(e => e.type === "loop_fault");
    expect(faults.length).toBeGreaterThanOrEqual(2);
    expect(faults[0]!.data).toMatchObject({
      phase: "load",
      fallback: "default_loop",
    });
    expect(faults[0]!.data.error).toContain("SyntaxError");
    expect(faults[1]!.data).toMatchObject({
      phase: "step",
      fallback: "default_loop",
    });
    expect(faults[1]!.data.error).toContain("divider exploded");

    const receipts = h.events.filter(e => e.type === "observation_context");
    expect(receipts).toHaveLength(3);

    // Turn 1 deliveredPayload surfaced load loopFault
    expect(receipts[0]!.data.deliveredPayload.loopFault).toMatchObject({
      phase: "load",
      fallback: "default_loop",
    });

    // Turn 2 deliveredPayload surfaced step loopFault
    expect(receipts[1]!.data.deliveredPayload.loopFault).toMatchObject({
      phase: "step",
      fallback: "default_loop",
    });

    // Turn 3 hot-reloaded cleanly: loopFault cleared, extra delivered, then Stop("recovered_cleanly")
    expect(receipts[2]!.data.deliveredPayload.loopFault).toBeUndefined();
    expect(receipts[2]!.data.deliveredPayload.extra).toEqual([{ status: "recovered_cleanly" }]);
    expect(h.turns[2]!.prompt).toBe("verify clean reload");
    expect(h.runtime.status().reason).toBe("loop: recovered_cleanly");
  } finally {
    await h.close();
  }
}, 20_000);

test("urgent human steer wakes an in-flight Wait(30) in <200ms and preempts into an immediate Prompt turn", async () => {
  let steerElapsedMs = Infinity;
  let steerTriggeredAt = 0;

  const h = await createLoopHarness({
    onPrompt: async (_turnIndex, turn) => {
      if (turn.prompt === "urgent override") {
        steerElapsedMs = performance.now() - steerTriggeredAt;
        await h.runtime.stop("human");
      }
    },
  });

  try {
    await writeFile(
      join(h.workspace, "loop.py"),
      `from ludens_tools import Loop, Stop, Wait

class Loop(Loop):
    def inject(self, ctx):
        inj = ctx.default_inject()
        inj.attach_images = False
        inj.extra.append({"steered": ctx.steered})
        return inj

    def step(self, ctx):
        if ctx.turn == 1:
            return Wait(30.0, reason="long_sleep")
        # Without steer preemption this deterministic loop would stop without prompting!
        return Stop("should_have_been_preempted")
`,
    );

    await h.runtime.start();

    // Wait until LoopRuntime has entered Wait(30.0)
    const waitDeadline = Date.now() + 5_000;
    while (
      !h.events.some(e => e.type === "loop_step" && e.data.action === "wait" && e.data.seconds === 30) &&
      Date.now() < waitDeadline
    ) {
      await Bun.sleep(10);
    }
    expect(h.events.some(e => e.type === "loop_step" && e.data.action === "wait")).toBe(true);

    steerTriggeredAt = performance.now();
    await h.runtime.steer("urgent override");
    await h.runtime.runSettled;

    expect(steerElapsedMs).toBeLessThan(200);
    expect(h.turns).toHaveLength(1);
    expect(h.turns[0]!.prompt).toBe("urgent override");

    const receipt = h.events.find(e => e.type === "observation_context");
    expect(receipt?.data.deliveredPayload.extra).toEqual([{ steered: true }]);
    expect(h.events.some(e => e.type === "loop_step" && e.data.action === "stop")).toBe(false);
  } finally {
    await h.close();
  }
}, 15_000);

test("transient step/inject runtime faults clear automatically on the next clean turn without editing loop.py", async () => {
  const h = await createLoopHarness();
  try {
    await writeFile(
      join(h.workspace, "loop.py"),
      `from ludens_tools import Loop, Prompt, Stop

class Loop(Loop):
    def step(self, ctx):
        if ctx.turn == 1:
            raise RuntimeError("transient glitch on turn 1")
        if ctx.turn == 2:
            return Prompt(prompt="clean turn 2 without reload")
        return Stop("transient_recovered")
`,
    );

    await h.runtime.start();
    await h.runtime.runSettled;

    expect(h.turns).toHaveLength(2);
    expect(h.turns[1]!.prompt).toBe("clean turn 2 without reload");
    expect(h.events.filter(e => e.type === "loop_fault")).toHaveLength(1);

    const receipts = h.events.filter(e => e.type === "observation_context");
    expect(receipts).toHaveLength(2);
    expect(receipts[0]!.data.deliveredPayload.loopFault).toMatchObject({
      phase: "step",
      fallback: "default_loop",
    });
    expect(receipts[1]!.data.deliveredPayload.loopFault).toBeUndefined();
    expect(h.loop.pendingFault()).toBeNull();
    expect(h.runtime.status().reason).toBe("loop: transient_recovered");
  } finally {
    await h.close();
  }
}, 15_000);

