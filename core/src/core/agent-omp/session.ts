import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createAgentSession, discoverAuthStorage, SessionManager, Settings, type AgentSession, type AuthStorage } from "@oh-my-pi/pi-coding-agent";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import {
  isOmpEffort,
  isOmpServiceTier,
  mergeConnectionConfig,
  readGlobalConfig,
  validateConnectionConfig,
  type ModelConnectionConfig,
  type OmpEffort,
  type OmpServiceTier,
} from "@ludens/protocol/ludens";
import type { AgentRunOutcome, AgentRunner } from "../shiori/runtime.ts";
import { Workspace } from "../storage/workspace.ts";
import type { WorkspaceState } from "../storage/workspace-state.ts";
import { openWorkspaceSession, selectWorkspaceSession } from "./workspace-session.ts";
import { createLudensExtension, type Cycle, type ExtensionHost, type PreparedTurnContext } from "./extension.ts";
import type { EventLog } from "../storage/events.ts";
import { installCompactionHttpTrace, ModelTrace } from "./trace.ts";
import { SHIORI_SOURCE } from "./shiori.ts";
import {
  createOmpModelRegistry,
  listAvailableOmpModels,
  ompSettingsOverrides,
  resolveOmpImageModel,
  effectiveOmpServiceTier,
  effectiveOmpEffort,
  resolvedOmpSessionEffort,
  type AvailableModelItem,
  type AvailableModelsCatalog,
} from "./models.ts";
import { listCapabilityEvals } from "../subsystems/capability-evals.ts";
import { perceptionInput, type PerceptionRead } from "../subsystems/perception.ts";
import { buildDefaultStructuredInjection, LoopRuntime, type LoopTurnContextWire } from "../subsystems/loop.ts";
import continuation from "../../../prompts/continue.md" with { type: "text" };
import consolidation from "../../../prompts/consolidate.md" with { type: "text" };

export { listAvailableOmpModels, ompSettingsOverrides, resolveOmpImageModel, type AvailableModelItem, type AvailableModelsCatalog };

/** Run one maintenance turn inside the existing session, then restore its tools. */
export async function consolidateOmpSession(
  session: {
    getActiveToolNames(): string[];
    setActiveToolsByName(names: string[]): Promise<void>;
    prompt(text: string): Promise<unknown>;
    getLastAssistantMessage(): AssistantMessage | undefined;
  },
  signal: AbortSignal,
  workspace: string,
  customPrompt?: string | null,
) {
  const tools = session.getActiveToolNames();
  signal.throwIfAborted();
  try {
    await session.setActiveToolsByName(["read", "write", "edit"]);
    signal.throwIfAborted();
    const evaluations = await listCapabilityEvals(workspace, { signal });
    const promptHeader = customPrompt?.trim() ? customPrompt.trim() : consolidation;
    await session.prompt(`${promptHeader}\n\nCurrent capability evaluations (static discovery; no workspace code executed):\n${JSON.stringify(evaluations)}`);
    signal.throwIfAborted();
    const last = session.getLastAssistantMessage();
    if (last?.stopReason === "error") throw new Error(last.errorMessage ?? "Model request failed");
    if (last?.stopReason === "aborted") throw new Error("Consolidation aborted");
  } finally {
    await session.setActiveToolsByName(tools);
  }
}

export interface OmpLoopSessionSurface {
  prompt(text: string): Promise<unknown>;
  getLastAssistantMessage(): AssistantMessage | undefined;
  getActiveToolNames(): string[];
  setActiveToolsByName(names: string[]): Promise<void>;
  joinActiveTurn?(text: string, images?: undefined, options?: { queue?: "steering" | "followUp" }): Promise<boolean>;
  steer?(text: string): Promise<void>;
  getQueuedMessages?(): { steering: readonly unknown[]; liveSteered: number };
  abort(): Promise<void>;
}

/** Programmable outer loop + urgent human Steer preemption shared by OmpAgentSession and tests. */
export function createOmpLoopDriver(options: {
  runtime: ExtensionHost;
  workspace: string;
  loop?: LoopRuntime;
  session: OmpLoopSessionSurface;
  prepareTurn(next?: PreparedTurnContext): void;
  setCycle(next?: Cycle): void;
}) {
  const { runtime, workspace, session, prepareTurn, setCycle } = options;
  const pendingSteers: string[] = [];
  let steerWakeController: AbortController | undefined;
  let inPromptTurn = false;

  const getLoopRuntime = () => options.loop ?? runtime.loop;

  async function captureTurnInputs(context: { epoch: string; signal: AbortSignal }) {
    const hostStatus = runtime.status();
    const remainingSeconds = hostStatus.remainingSeconds ?? null;
    const injectionEnabled = runtime.perceptionInjectionEnabled();
    let read: PerceptionRead | null = null;
    let perceptionPayload: Record<string, unknown> = { ok: true, records: [] };
    let perceptionState: Record<string, unknown> | null = null;

    if (injectionEnabled) {
      const pStatus = hostStatus.perception;
      if (pStatus?.state === "ready" && runtime.perception) {
        read = await runtime.perception.observe(context.signal, { epoch: context.epoch });
        perceptionPayload = perceptionInput(read) as Record<string, unknown>;
        try {
          const sm = await runtime.perception.stateMachine(context.signal);
          if (sm.state !== "python/perception.py:Perception.sample" || Object.keys(sm.arguments ?? {}).length > 0) {
            perceptionState = {
              state: sm.state,
              ...(Object.keys(sm.arguments ?? {}).length > 0 ? { arguments: sm.arguments } : {}),
            };
          }
        } catch {
          // Optional on stubbed PerceptionRuntime fixtures.
        }
      } else if (pStatus && pStatus.state !== "ready" && pStatus.state !== "unimplemented") {
        perceptionState = {
          state: pStatus.state,
          ...(pStatus.error ? { error: pStatus.error } : {}),
        };
        if (pStatus.state === "error") {
          perceptionPayload = {
            ok: false,
            ...(pStatus.error ? { error: { code: "UNAVAILABLE", message: pStatus.error } } : {}),
          };
        }
      }
    }

    let eventPoolPayload: Record<string, unknown> | null = null;
    if (runtime.eventPoolDigest) {
      const digest = await runtime.eventPoolDigest();
      if (digest.pendingInbound > 0) {
        eventPoolPayload = {
          ...digest,
          hint: "Use event_pool({ action: 'read' }) to read full text and acknowledge when ready, or defer if busy.",
        };
      }
    }

    return { read, perceptionPayload, perceptionState, eventPoolPayload, remainingSeconds };
  }

  function summarizeAssistantTurn(last: AssistantMessage | undefined, steered: boolean): Record<string, unknown> {
    const text = last?.content
      .filter((part): part is Extract<AssistantMessage["content"][number], { type: "text" }> => part.type === "text")
      .map(part => part.text)
      .join("\n")
      .trim();
    const toolCalls = last?.content.filter(part => part.type === "toolCall").length ?? 0;
    return {
      action: "prompt",
      steered,
      stopReason: last?.stopReason ?? "stop",
      toolCalls,
      ...(text ? { text: text.slice(0, 500) } : {}),
    };
  }

  async function sleepInterruptible(seconds: number, cycleSignal: AbortSignal): Promise<void> {
    if (seconds <= 0 || pendingSteers.length > 0 || cycleSignal.aborted) return;
    const wake = new AbortController();
    steerWakeController = wake;
    const combined = AbortSignal.any([cycleSignal, wake.signal]);
    try {
      await new Promise<void>(resolve => {
        if (combined.aborted) {
          resolve();
          return;
        }
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          combined.removeEventListener("abort", onAbort);
          resolve();
        }, seconds * 1000);
        combined.addEventListener("abort", onAbort, { once: true });
      });
    } finally {
      if (steerWakeController === wake) steerWakeController = undefined;
    }
  }

  return {
    async run(context: { epoch: string; signal: AbortSignal; message?: string }): Promise<void | AgentRunOutcome> {
      setCycle(context);
      let turn = 0;
      let llmTurns = 0;
      let lastTurn: Record<string, unknown> | null = null;
      const initialMessage = context.message?.trim() || null;

      try {
        while (!context.signal.aborted) {
          turn++;
          const loopRuntime = getLoopRuntime();

          if (pendingSteers.length > 0) {
            const consumed = pendingSteers.splice(0, pendingSteers.length);
            const steerPrompt = consumed.join("\n\n");
            const inputs = await captureTurnInputs(context);
            if (context.signal.aborted) break;

            const wireCtx: LoopTurnContextWire = {
              turn,
              llmTurns,
              initialMessage,
              defaultPrompt: steerPrompt,
              steered: true,
              perception: inputs.perceptionPayload,
              perceptionState: inputs.perceptionState,
              eventPool: inputs.eventPoolPayload,
              lastTurn,
              remainingSeconds: inputs.remainingSeconds,
              fault: loopRuntime?.pendingFault() ?? null,
            };

            const injected = loopRuntime
              ? await loopRuntime.inject({ epoch: context.epoch, context: wireCtx, signal: context.signal })
              : { implemented: false, faulted: false, injection: buildDefaultStructuredInjection(wireCtx) };
            if (context.signal.aborted) break;

            prepareTurn({
              epoch: context.epoch,
              read: inputs.read,
              injection: injected.injection,
              loopImplemented: injected.implemented,
              loopFault: loopRuntime?.pendingFault() ?? null,
            });
            setCycle(context);
            inPromptTurn = true;
            try {
              await session.prompt(steerPrompt);
            } finally {
              inPromptTurn = false;
              prepareTurn(undefined);
            }
            llmTurns++;
            const last = session.getLastAssistantMessage();
            if (last?.stopReason === "error") throw new Error(last.errorMessage ?? "Model request failed");
            if (last?.stopReason === "aborted" && context.signal.aborted) break;
            lastTurn = summarizeAssistantTurn(last, true);
            continue;
          }

          const inputs = await captureTurnInputs(context);
          if (context.signal.aborted) break;
          // If an urgent steer arrived while capturing perception, preempt immediately.
          if (pendingSteers.length > 0) {
            turn--;
            continue;
          }

          const defaultPrompt = llmTurns === 0 && initialMessage ? `${initialMessage}\n\n${continuation}` : continuation;
          const wireCtx: LoopTurnContextWire = {
            turn,
            llmTurns,
            initialMessage,
            defaultPrompt,
            steered: false,
            perception: inputs.perceptionPayload,
            perceptionState: inputs.perceptionState,
            eventPool: inputs.eventPoolPayload,
            lastTurn,
            remainingSeconds: inputs.remainingSeconds,
            fault: loopRuntime?.pendingFault() ?? null,
          };

          const stepOutcome = loopRuntime
            ? await loopRuntime.step({ epoch: context.epoch, context: wireCtx, signal: context.signal })
            : {
                implemented: false,
                faulted: false,
                action: {
                  kind: "prompt" as const,
                  prompt: null,
                  injection: buildDefaultStructuredInjection(wireCtx),
                },
              };
          if (context.signal.aborted) break;

          const { action } = stepOutcome;
          // Human steer preempts deterministic non-prompt actions (Wait / Stop / Consolidate).
          if (pendingSteers.length > 0 && action.kind !== "prompt") {
            continue;
          }

          if (action.kind === "prompt") {
            const promptText = action.prompt !== null && action.prompt.length > 0 ? action.prompt : defaultPrompt;
            prepareTurn({
              epoch: context.epoch,
              read: inputs.read,
              injection: action.injection,
              loopImplemented: stepOutcome.implemented,
              loopFault: loopRuntime?.pendingFault() ?? null,
            });
            setCycle(context);
            inPromptTurn = true;
            try {
              await session.prompt(promptText);
            } finally {
              inPromptTurn = false;
              prepareTurn(undefined);
            }
            llmTurns++;
            const last = session.getLastAssistantMessage();
            if (last?.stopReason === "error") throw new Error(last.errorMessage ?? "Model request failed");
            if (last?.stopReason === "aborted") break;
            lastTurn = summarizeAssistantTurn(last, false);
            continue;
          }

          if (action.kind === "consolidate") {
            prepareTurn(undefined);
            setCycle({ ...context, purpose: "consolidate" });
            inPromptTurn = true;
            try {
              await consolidateOmpSession(session, context.signal, workspace, action.prompt);
            } catch (error) {
              if (context.signal.aborted) break;
              throw error;
            } finally {
              inPromptTurn = false;
              setCycle(context);
            }
            lastTurn = { action: "consolidate", stopReason: "stop" };
            continue;
          }

          if (action.kind === "wait") {
            await sleepInterruptible(action.seconds, context.signal);
            lastTurn = {
              action: "wait",
              seconds: action.seconds,
              ...(action.reason ? { reason: action.reason } : {}),
            };
            continue;
          }

          if (action.kind === "stop") {
            const trimmed = action.reason.trim();
            return { stopReason: trimmed ? `loop: ${trimmed}` : "loop: completed" };
          }
        }
      } finally {
        inPromptTurn = false;
        steerWakeController = undefined;
        pendingSteers.length = 0;
        prepareTurn(undefined);
        setCycle(undefined);
      }
    },

    async steer(message: string): Promise<void> {
      if (inPromptTurn) {
        if (typeof session.joinActiveTurn === "function") {
          const joined = await session.joinActiveTurn(message, undefined, { queue: "steering" });
          if (joined) return;
        } else if (typeof session.steer === "function") {
          await session.steer(message);
          return;
        }
      }
      pendingSteers.push(message);
      steerWakeController?.abort();
    },

    queueState(): { steering: number } {
      const nativeQueued = session.getQueuedMessages?.();
      const nativeCount = nativeQueued ? nativeQueued.steering.length + nativeQueued.liveSteered : 0;
      return { steering: pendingSteers.length + nativeCount };
    },
  };
}

// OMP clamps each request to the deployment's image-count budget (catalog
// `image-count-budget`, unknown providers fall back to 5). The 2026-10-13
// wire trace exposed prefix rewrites despite stable session history, taking
// DeepSeek cache hits from 71.9% to 19.9% in one turn. Harness policy for
// every selected provider, including future ones: set the model's
// `imageCountBudget` to Infinity (applied where the model is selected below)
// and retain images until compaction. Token/body budgets and server limits
// remain; no dependency patch.
const kImageRefreshGuarded = Symbol("ludens.imageRefreshGuarded");

function assertImageCapableModel(candidate: Model | undefined, fallbackLabel = "unknown"): Model {
  if (!candidate || !Array.isArray(candidate.input) || !candidate.input.includes("image")) {
    const label = candidate ? `${candidate.provider}/${candidate.id}` : fallbackLabel;
    throw new Error(`An image-capable model is required: ${label}`);
  }
  return candidate.imageCountBudget === Infinity
    ? candidate
    : { ...candidate, imageCountBudget: Infinity };
}

function guardModelRegistryRefresh(
  registry: { refreshSelectedModelMetadata?: (model: Model) => Promise<Model> } | undefined,
): void {
  const current = registry?.refreshSelectedModelMetadata as
    | (((model: Model) => Promise<Model>) & { [kImageRefreshGuarded]?: boolean })
    | undefined;
  if (!registry || typeof current !== "function" || current[kImageRefreshGuarded]) return;
  const rawRefresh = current.bind(registry);
  const guarded = Object.assign(
    async (candidate: Model) => {
      const refreshed = await rawRefresh(candidate);
      return assertImageCapableModel(refreshed, `${candidate.provider}/${candidate.id}`);
    },
    { [kImageRefreshGuarded]: true as const },
  );
  registry.refreshSelectedModelMetadata = guarded;
}

export function ompSessionOptions(
  options: Parameters<typeof createAgentSession>[0] & { model: Model },
): Parameters<typeof createAgentSession>[0] & {
  model: Model;
  disableModelFallback: boolean;
  disableServerSideFallback: boolean;
  suppressAutoPrewalk: boolean;
} {
  guardModelRegistryRefresh(options.modelRegistry);
  return {
    ...options,
    model: options.model.imageCountBudget === Infinity
      ? options.model
      : { ...options.model, imageCountBudget: Infinity },
    // Host invariant: the selected multimodal model must remain sticky across
    // turns. Lock out context promotion / retry / usage-aware fallback,
    // provider server-side fallback chains, and automatic prewalk handoffs.
    disableModelFallback: options.disableModelFallback ?? true,
    disableServerSideFallback: options.disableServerSideFallback ?? true,
    suppressAutoPrewalk: options.suppressAutoPrewalk ?? true,
  };
}

export async function createOmpSession(options: Parameters<typeof createAgentSession>[0] & { model: Model }) {
  const result = await createAgentSession(ompSessionOptions(options));
  try {
    guardModelRegistryRefresh(result.session.modelRegistry);
    const initialModel = assertImageCapableModel(
      result.session.model,
      `${options.model.provider}/${options.model.id}`,
    );
    const rawAgentSetModel = result.session.agent.setModel.bind(result.session.agent);
    result.session.agent.setModel = (nextModel: Model) => {
      const checked = assertImageCapableModel(nextModel);
      rawAgentSetModel(checked);
      if (result.session.agent.state.model && result.session.agent.state.model.imageCountBudget !== Infinity) {
        result.session.agent.state.model = {
          ...result.session.agent.state.model,
          imageCountBudget: Infinity,
        };
      }
    };
    const rawSessionSetModel = result.session.setModel.bind(result.session);
    result.session.setModel = async (nextModel, role, setModelOptions) => {
      const checked = assertImageCapableModel(nextModel);
      guardModelRegistryRefresh(result.session.modelRegistry);
      return rawSessionSetModel(checked, role, setModelOptions);
    };
    result.session.agent.setModel(initialModel);
    // The CustomTool adapter does not expose concurrency. Set it on the actual
    // AgentTools: an observation must wait for preceding environment actions.
    for (const tool of result.session.agent.state.tools) {
      if (tool.name === "observe" || tool.name === "event_pool") tool.concurrency = "exclusive";
    }
    return result;
  } catch (error) {
    await result.session.dispose();
    throw error;
  }
}

export async function createOmpAgent(options: {
  runtime: ExtensionHost; workspace: string; runDir: string; basewareSocket: string; ludensSocket: string;
  state: WorkspaceState;
  binDir: string; model: string; maxRequests: number;
  resume?: string;
  compactionThreshold?: number;
  connection?: ModelConnectionConfig;
  authStorage?: AuthStorage;
  log: EventLog;
}): Promise<AgentRunner> {
  let cycle: Cycle | undefined;
  // Native background summaries can finish between control cycles.
  const trace = new ModelTrace(options.log, () => ({ epoch: cycle?.epoch, ...extension.context() }));
  const extension = createLudensExtension({ ...options, clock: options.log.clock, trace: trace.current, workspace: new Workspace(options.workspace, options.state.versionsDir),
    cycle: () => {
      if (!cycle) throw new Error("No active control cycle");
      return cycle;
    },
  });
  const globalConfig = await readGlobalConfig().catch(() => undefined);
  const workspaceConfig = await readFile(join(options.workspace, "ludens.json"), "utf8")
    .then(text => JSON.parse(text) as Record<string, unknown>)
    .catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
  const workspaceConnection = workspaceConfig?.connection === undefined
    ? undefined
    : validateConnectionConfig(workspaceConfig.connection, "ludens.json connection");
  const connection = mergeConnectionConfig(
    mergeConnectionConfig(globalConfig?.defaults.connection, workspaceConnection),
    options.connection,
  );
  let configuredServiceTier: OmpServiceTier | null = null;
  if (workspaceConfig?.serviceTier !== undefined) {
    if (!isOmpServiceTier(workspaceConfig.serviceTier)) throw new Error("ludens.json serviceTier must be priority or ultrafast");
    configuredServiceTier = workspaceConfig.serviceTier;
  }
  let configuredEffort: OmpEffort | null = null;
  if (workspaceConfig?.effort !== undefined) {
    if (!isOmpEffort(workspaceConfig.effort)) throw new Error("ludens.json effort must be minimal, low, medium, high, xhigh, or max");
    configuredEffort = workspaceConfig.effort;
  }
  // Superset shell: override only what this host owns. Keys whose value equals
  // the OMP default (memory.backend off, autolearn off, includeWorkspaceTree
  // off, providers.openaiWebsockets auto, async/launch enabled) stay unset.
  const settings = Settings.isolated(ompSettingsOverrides({
    compactionThreshold: options.compactionThreshold,
    connection,
    serviceTier: configuredServiceTier,
    effort: configuredEffort,
  }));
  const ownsAuthStorage = !options.authStorage;
  const authStorage = options.authStorage ?? await discoverAuthStorage(undefined, { settings, cwd: options.workspace });
  // OMP's remote/background compactor bypasses agent.streamFn. This host-local
  // observer leaves its native requests and response streams untouched.
  const untraceCompaction = installCompactionHttpTrace(options.log, trace.compactionParent);
  let manager: SessionManager | undefined;
  let initializedSession: AgentSession | undefined;
  try {
    const modelRegistry = await createOmpModelRegistry(authStorage, settings);
    const model = resolveOmpImageModel(modelRegistry, options.model);
    let activeModel = `${model.provider}/${model.id}`;
    let activeServiceTier = effectiveOmpServiceTier(model, configuredServiceTier);
    let activeEffort = effectiveOmpEffort(model, configuredEffort);
    const extensionPath = resolve(import.meta.dir, "extension.ts");
    const instructionsPath = join(options.workspace, "AGENTS.md");
    const instructions = await readFile(instructionsPath, "utf8").catch(error => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    manager = await openWorkspaceSession(options.state, options.resume);
    const { session } = await createOmpSession({
      cwd: options.workspace, agentDir: join(options.runDir, "omp"),
      model, authStorage, modelRegistry, settings, sessionManager: manager, telemetry: trace.shiori.config,
      // Cache warming schedules background provider requests outside control
      // cycles; every provider request must be attributable to a control cycle.
      cacheWarming: false,
      skills: [], rules: [], contextFiles: instructions === undefined ? [] : [{ path: instructionsPath, content: instructions }],
      promptTemplates: [], slashCommands: [],
      enableMCP: false, enableLsp: false, enableIrc: false, skipPythonPreflight: true,
      disableExtensionDiscovery: true, restrictToolNames: true, allowRestrictedCustomTools: true,
      toolNames: ["read", "write", "edit", "observe", "event_pool", "bash", "wait"], customTools: extension.tools,
      // Restricted sessions accept explicit prepared hooks and caller-supplied tools only.
      preloadedPreparedExtensions: [{ path: extensionPath, resolvedPath: extensionPath, factory: extension.factory, error: null }],
    });
    initializedSession = session;
    // Workspace configuration is authoritative across restarts. OMP otherwise
    // prefers a transcript's previous tier/thinking entry over launch Settings,
    // which could restore a paid tier or stale effort after an offline edit.
    session.setServiceTierFamily("openai", activeServiceTier ?? undefined);
    session.setThinkingLevel(resolvedOmpSessionEffort(model, activeEffort) as Parameters<typeof session.setThinkingLevel>[0], false);
    // Native background completions can wake an idle OMP session. Handback ends
    // permission to call the model as well as the device, without killing jobs.
    const removeControlGate = session.agent.addBeforeModelCall(() => {
      if (!cycle || cycle.signal.aborted) return { stop: true, reason: "Ludens control cycle is inactive" };
    });
    const sessionFile = await selectWorkspaceSession(options.state, manager);
    const recordSession = options.log.recorder(SHIORI_SOURCE);
    const unsubscribe = trace.attach(session);
    recordSession("session", { file: sessionFile, model: activeModel, serviceTier: activeServiceTier, effort: activeEffort, tools: session.getActiveToolNames() });
    const ownedLoop = options.runtime.loop
      ? undefined
      : new LoopRuntime({
          workspace: options.workspace,
          runDir: options.runDir,
          socketPath: options.ludensSocket,
          record: options.runtime.record,
          diagnostics: options.runtime.diagnostics,
          clock: options.log.clock,
        });
    const loopDriver = createOmpLoopDriver({
      runtime: options.runtime,
      workspace: options.workspace,
      loop: options.runtime.loop ?? ownedLoop,
      session,
      prepareTurn: extension.prepareTurn,
      setCycle: next => { cycle = next; },
    });
    return {
      run: context => loopDriver.run(context),
      async consolidate(context) {
        cycle = { ...context, purpose: "consolidate" };
        try { await consolidateOmpSession(session, context.signal, options.workspace); }
        finally { cycle = undefined; }
      },
      model: () => activeModel,
      serviceTier: () => activeServiceTier,
      effort: () => activeEffort,
      async setModel(nextSelector: string, nextServiceTier?: OmpServiceTier | null, nextEffort?: OmpEffort | null) {
        if (cycle) throw new Error("Cannot switch model while Shiori is running; pause auto loop first");
        const candidate = resolveOmpImageModel(modelRegistry, nextSelector);
        await session.setModel(candidate, "default", { persist: false });
        let selected = session.model ?? candidate;
        if (!selected.input.includes("image")) {
          throw new Error(`An image-capable model is required: ${nextSelector}`);
        }
        if (selected.imageCountBudget !== Infinity) {
          selected = { ...selected, imageCountBudget: Infinity };
          session.agent.setModel(selected);
          selected = session.model ?? selected;
        }
        activeServiceTier = effectiveOmpServiceTier(selected, nextServiceTier === undefined ? activeServiceTier : nextServiceTier);
        session.setServiceTierFamily("openai", activeServiceTier ?? undefined);
        activeEffort = effectiveOmpEffort(selected, nextEffort === undefined ? activeEffort : nextEffort);
        session.setThinkingLevel(resolvedOmpSessionEffort(selected, activeEffort) as Parameters<typeof session.setThinkingLevel>[0], false);
        activeModel = `${selected.provider}/${selected.id}`;
        recordSession("session", { file: sessionFile, model: activeModel, serviceTier: activeServiceTier, effort: activeEffort, tools: session.getActiveToolNames() });
        return activeModel;
      },
      steer: (message: string) => loopDriver.steer(message),
      queueState: () => loopDriver.queueState(),
      abort: () => session.abort(),
      async close() {
        try { await session.dispose(); }
        finally {
          await ownedLoop?.stop();
          removeControlGate(); unsubscribe(); untraceCompaction();
          await trace.shiori.close();
          if (ownsAuthStorage) authStorage.close();
        }
      },
    };
  } catch (error) {
    try {
      if (initializedSession) await initializedSession.dispose();
      else await manager?.close();
    } finally {
      untraceCompaction();
      await trace.shiori.close();
      if (ownsAuthStorage) authStorage.close();
    }
    throw error;
  }
}
