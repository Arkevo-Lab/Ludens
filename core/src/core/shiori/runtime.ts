import type { ExecutionResult, ToolArguments } from "@ludens/baseware/contracts";
import type { Catalog } from "@ludens/baseware/protocol";
import {
   buildInboundEventDigest,
  EMPTY_EVENT_POOL_SUMMARY,
  type EventDirection,
  type EventPoolDigest,
  type EventPoolSnapshot,
  type EventPoolSummary,
  type OutboundEventKind,
  type PoolEventActor,
  type PoolEventStatus,
} from "@ludens/protocol/event-pool";
import type { DiagnosticsMode, EventTrace, RecordEvent } from "../storage/events.ts";
import type { WorkspaceEventPool } from "../storage/event-pool.ts";
import type { PerceptionRuntime } from "../subsystems/perception.ts";
import type { WorkspaceController } from "../subsystems/controller.ts";
import { executeProgram, type Program } from "./program.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface AgentRunner {
  run(context: { epoch: string; signal: AbortSignal; message?: string }): Promise<void>;
  consolidate(context: { epoch: string; signal: AbortSignal }): Promise<void>;
  /** Live mid-run guidance; optional because not every agent supports it. */
  steer?(message: string): Promise<void>;
  queueState?(): { steering: number };
  abort(): Promise<void>;
  close(): Promise<void>;
}

export type ObservationOrigin = "cli" | "explicit" | "prompt_start" | "tool_batch";

export interface DeviceSession {
  readonly catalog: Catalog;
  readonly diagnostics?: DiagnosticsMode;
  /** Cancellation must revoke a pending acquisition as well as an active lease. */
  acquire(epoch: string, signal?: AbortSignal, seconds?: number | null): Promise<void>;
  /** Must also accept an epoch whose acquisition has not completed yet. */
  release(epoch: string): Promise<void>;
  setInputGeneration?(epoch: string, generation: string | null): Promise<void>;
  onReconnect?(handler: () => void): void;
  machines?(action: "list" | "use" | "connect" | "disconnect", payload?: { id?: string; ids?: string[] }): Promise<unknown>;
  execute(id: string, args: ToolArguments, epoch: string | undefined, signal: AbortSignal, trace: EventTrace, origin?: ObservationOrigin, machine?: string): Promise<ExecutionResult>;
}

/** An enclosing Shiori owns this deadline and signals its measurement boundary. */
export interface SharedBudget {
  deadlineMs: number;
  signal: AbortSignal;
}

export class Runtime {
  private epoch = "";
  private mode: "manual" | "acquiring" | "auto" | "releasing" = "manual";
  private control?: AbortController;
  private opening?: Promise<void>;
  private stopping?: Promise<void>;
  private running?: Promise<void>;
  private aborting?: Promise<void>;
  /** Resolves when the active agent run fully settles (including post-abort cleanup); undefined when idle. */
  get runSettled(): Promise<void> | undefined { return this.running; }
  private consolidating = false;
  private timer?: ReturnType<typeof setTimeout>;
  private activeMaxSeconds: number | null = 300;
  private takeoverDeadlineMs: number | null = null;
  private takeoverStartedAtMs: number | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private readonly budgetEnded = () => { void this.stop("time budget").catch(error => this.record("error", String(error))); };
  private reason = "startup";
  private connected = true;
  private perceptionInjection = true;
  private ownsDevice = false;
  private calls = new Set<Promise<unknown>>();
  private _agent?: AgentRunner;
  private _controller?: WorkspaceController;
  private _perception?: PerceptionRuntime;
  private _eventPool?: WorkspaceEventPool;
  private eventPoolSummary: EventPoolSummary = { ...EMPTY_EVENT_POOL_SUMMARY };
  /** Subsystems are injected through attach(); direct external assignment is not allowed. */
  get agent() { return this._agent; }
  get controller() { return this._controller; }
  get perception() { return this._perception; }
  get eventPool() { return this._eventPool; }

  /** Attach workspace subsystems. Later calls replace only the given parts; an explicit undefined clears one. */
  attach(subsystems: {
    agent?: AgentRunner;
    controller?: WorkspaceController;
    perception?: PerceptionRuntime;
    eventPool?: WorkspaceEventPool;
    eventPoolSummary?: EventPoolSummary;
  }) {
    if ("agent" in subsystems) this._agent = subsystems.agent;
    if ("controller" in subsystems) this._controller = subsystems.controller;
    if ("perception" in subsystems) this._perception = subsystems.perception;
    if ("eventPool" in subsystems) {
      this._eventPool = subsystems.eventPool;
      if (!subsystems.eventPool) this.eventPoolSummary = { ...EMPTY_EVENT_POOL_SUMMARY };
    }
    if (subsystems.eventPoolSummary) this.eventPoolSummary = { ...subsystems.eventPoolSummary };
  }

  constructor(private devices: DeviceSession | undefined, readonly record: RecordEvent, private maxSeconds: number | null = 300, private runId: string = crypto.randomUUID(), readonly diagnostics: DiagnosticsMode = "normal", private budget?: SharedBudget, private controlTimeoutMs = 30_000, private readonly runtimeStatsIntervalMs = 0) {
    if (maxSeconds !== null && (!Number.isFinite(maxSeconds) || maxSeconds <= 0 || maxSeconds * 1000 > 2_147_483_647)) throw new Error("Invalid Shiori time budget");
    if (budget && !Number.isFinite(budget.deadlineMs)) throw new Error("Invalid shared Shiori deadline");
    this.activeMaxSeconds = this.maxSeconds;
    devices?.onReconnect?.(() => { void this.reconnected(); });
  }

  status() {
    // The host can outlive many takeovers; its log clock is not this cycle's budget.
    const remainingSeconds = this.mode === "auto" && this.takeoverDeadlineMs !== null ? Math.max(0, Math.ceil((this.takeoverDeadlineMs - performance.now()) / 1000)) : null;
    return {
      runId: this.runId,
      maxSeconds: this.mode === "auto" ? this.activeMaxSeconds : this.maxSeconds,
      remainingSeconds,
      mode: this.mode,
      epoch: this.mode === "auto" ? this.epoch : null,
      connected: this.connected,
      reason: this.reason,
      agent: !!this._agent,
      thinking: !!this.running,
      consolidating: this.consolidating,
      queue: this._agent?.queueState?.() ?? { steering: 0 },
      eventPool: { ...this.eventPoolSummary },
      perception: this._perception?.status(),
      context: { perceptionInjection: this.perceptionInjection },
      logging: { diagnostics: this.diagnostics, basewareDiagnostics: this.devices?.diagnostics ?? "normal" },
    };
  }

  perceptionInjectionEnabled(): boolean { return this.perceptionInjection; }

  setPerceptionInjection(enabled: boolean, trace?: EventTrace) {
    if (this.perceptionInjection !== enabled) {
      this.perceptionInjection = enabled;
      this.record("context_policy", { perceptionInjection: enabled }, trace);
    }
    return { perceptionInjection: this.perceptionInjection };
  }

  list() { if (!this.devices) throw new Error("This Shiori execution has no device"); return this.devices.catalog; }

  checkInputGeneration(epoch: string | undefined, trace: EventTrace = {}) {
    if (trace.inputGeneration !== undefined && !this._perception?.accepts(epoch, trace.inputGeneration))
      throw new Error("STALE_INPUT_GENERATION: reload perception under the current control epoch");
  }

  async callController(id: string, args: unknown, epoch: string | undefined, signal: AbortSignal, trace: EventTrace = {}) {
    if (!this._controller) throw new Error("Workspace controller is unavailable");
    this.checkInputGeneration(epoch, trace);
    if ((epoch !== undefined || await this._controller.requiresControl(id, signal, trace)) && (this.mode !== "auto" || !epoch || epoch !== this.epoch)) {
      throw new Error("STALE_EPOCH: use the current control epoch");
    }
    const combined = epoch ? AbortSignal.any([signal, this.control!.signal]) : signal;
    combined.throwIfAborted();
    this.checkInputGeneration(epoch, trace);
    const call = this._controller.call(id, args, { epoch, signal: combined, trace: { ...trace, epoch } });
    // Background perception reads have no lease and outlive control cycles.
    // Only calls owned by this epoch need draining before another takeover.
    if (epoch !== undefined) this.calls.add(call);
    try { return await call; }
    finally { this.calls.delete(call); }
  }

  async manageMachines(action: "list" | "use" | "connect" | "disconnect", payload: { id?: string; ids?: string[] } = {}, workspaceDir?: string) {
    if (!this.devices?.machines) throw new Error("Current Baseware session does not support multi-machine management");
    if ((action === "use" || action === "connect") && workspaceDir) {
      let allowed: unknown;
      try {
        const config = JSON.parse(await readFile(join(workspaceDir, "ludens.json"), "utf8")) as { machines?: { allowed?: unknown } };
        allowed = config.machines?.allowed;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (Array.isArray(allowed) && allowed.length) {
        const requested = [...(payload.id ? [payload.id] : []), ...(payload.ids ?? [])];
        for (const id of requested) {
          if (!allowed.includes(id)) throw new Error(`Machine "${id}" is not in workspace machines.allowed`);
        }
      }
    }
    const result = await this.devices.machines(action, payload);
    this.record("machines_changed", { action, ...payload, result }, this.epoch ? { epoch: this.epoch } : {});
    return result;
  }

  async start(message?: string, program?: (context: { epoch: string; signal: AbortSignal }) => Promise<void>, seconds?: number | null) {
    if (this.mode !== "manual" || this.running || this.calls.size) throw new Error("Previous control cycle has not finished");
    if (!this.connected) throw new Error("Baseware disconnected; restart the application");
    this.budget?.signal.throwIfAborted();
    // An explicit duration overrides the configured budget; null runs unbounded.
    const cycleSeconds = seconds !== undefined ? seconds : this.maxSeconds;
    if (cycleSeconds !== null && (!Number.isFinite(cycleSeconds) || cycleSeconds <= 0 || cycleSeconds * 1000 > 2_147_483_647)) throw new Error("Invalid Shiori time budget");
    const epoch = this.epoch = crypto.randomUUID();
    const control = this.control = new AbortController();
    this.ownsDevice = !program;
    if (this.ownsDevice && !this.devices) throw new Error("Agent control requires a device session");
    this.mode = "acquiring";
    this.opening = this.ownsDevice ? this.withControlTimeout(
      this.devices!.acquire(epoch, control.signal, cycleSeconds).then(async () => {
        // A non-cooperative session may complete after stop or its timeout.
        // Compensate using the captured epoch; never revive a stopped cycle.
        if (control.signal.aborted) {
          try { await this.withControlTimeout(this.devices!.release(epoch), "Late control release"); }
          catch (error) {
            this.connected = false;
            this.record("error", String(error), { epoch });
            throw error;
          }
        }
      }), "Control acquisition") : Promise.resolve();
    if (this.budget) {
      this.budget.signal.addEventListener("abort", this.budgetEnded, { once: true });
      if (this.budget.signal.aborted) this.budgetEnded();
    }
    try { await this.opening; }
    catch (error) { if (this.control === control) await this.stop(String(error)); throw error; }
    if (control.signal.aborted || this.control !== control) return this.status();
    this.activeMaxSeconds = this.budget ? Math.max(1, Math.ceil((this.budget.deadlineMs - Date.now()) / 1000)) : cycleSeconds;
    this.takeoverDeadlineMs = this.budget ? performance.now() + (this.budget.deadlineMs - Date.now()) : cycleSeconds !== null ? performance.now() + cycleSeconds * 1000 : null;
    this.mode = "auto";
    this.reason = "enabled";
    this.takeoverStartedAtMs = Date.now();
    this.startStatsTimer();
    this.record("control", this.status(), { epoch });
    if (message) this.record("user_message", { text: message, mode: "start" }, { epoch });
    if (!this.budget && cycleSeconds !== null) this.timer = setTimeout(this.budgetEnded, cycleSeconds * 1000);
    if (control.signal.aborted) return this.status();
    try {
      if (this.ownsDevice) {
        if (!control.signal.aborted) await this._perception?.setLease(epoch, null, control.signal);
      }
    }
    catch (error) { await this.stop(String(error)); throw error; }
    if (control.signal.aborted) return this.status();
    const work = program ?? (this._agent ? (context: { epoch: string; signal: AbortSignal }) => this._agent!.run({ ...context, message }) : undefined);
    if (work) {
      this.running = Promise.resolve().then(() => work({ epoch, signal: control.signal }))
        .catch((error) => { if (!control.signal.aborted) this.record("error", String(error)); })
        .finally(async () => {
          await this.stop("agent ended");
          await this.aborting;
          this.running = undefined;
        });
    }
    return this.status();
  }

  /** Ordinary programs use Shiori's same budget, cancellation and drain path, without OMP or a device lease. */
  async runProgram(program: Program, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    let failure: unknown;
    const cancel = () => { void this.stop("cancelled"); };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      await this.start(undefined, async ({ signal: controlSignal }) => {
        const deadlineMs = this.takeoverDeadlineMs !== null ? Date.now() + this.takeoverDeadlineMs - performance.now() : Infinity;
        try { await executeProgram(program, controlSignal, this.record, deadlineMs, signal); }
        catch (error) { failure = error; throw error; }
      });
      if (signal?.aborted) cancel();
      await this.running;
      if (failure) throw failure;
      signal?.throwIfAborted();
    } finally { signal?.removeEventListener("abort", cancel); }
  }

  async consolidate(seconds = 600) {
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds * 1000 > 2_147_483_647) throw new Error("--seconds must be positive and within the timer range");
    if (this.mode !== "manual" || this.running) throw new Error("Previous control cycle has not finished");
    if (!this._agent) throw new Error("Consolidation requires an agent");
    const epoch = this.epoch = crypto.randomUUID();
    const control = this.control = new AbortController();
    this.consolidating = true;
    this.reason = "consolidating";
    this.record("consolidation_start", { seconds }, { epoch });
    this.timer = setTimeout(() => void this.stop("consolidation time budget"), seconds * 1000);
    let outcome = "completed";
    this.running = this._agent.consolidate({ epoch, signal: control.signal })
      .catch((error) => {
        outcome = "failed";
        if (!control.signal.aborted) this.record("error", String(error), { epoch });
      })
      .finally(async () => {
        clearTimeout(this.timer);
        await this.aborting;
        if (control.signal.aborted) outcome = "aborted";
        this.consolidating = false;
        this.running = undefined;
        if (!control.signal.aborted) this.reason = `consolidation ${outcome}`;
        this.record("consolidation_end", { outcome, reason: this.reason }, { epoch });
      });
    return { ...this.status(), consolidationId: epoch };
  }

  /** Urgent mid-run interruption from the human. Queued by the agent, not a new cycle. */
  async steer(message: string) {
    const text = message.trim();
    if (!text) throw new Error("Message cannot be empty");
    if (this.mode !== "auto" || !this.running || !this._agent) throw new Error("Auto loop is not active");
    this.record("user_message", { text, mode: "steer" }, { epoch: this.epoch });
    if (this._agent.steer) await this._agent.steer(text);
    else throw new Error("Agent does not support live steering");
    return this.status();
  }

  private requireEventPool(): WorkspaceEventPool {
    if (!this._eventPool) throw new Error("Workspace Event Pool is unavailable");
    return this._eventPool;
  }

  private currentCycleTrace(trace?: EventTrace): EventTrace {
    const activeEpoch = (this.mode === "auto" || this.consolidating) && this.epoch ? { epoch: this.epoch } : {};
    return { ...activeEpoch, ...trace };
  }

  async refreshEventPool(): Promise<EventPoolSummary> {
    if (!this._eventPool) return { ...EMPTY_EVENT_POOL_SUMMARY };
    this.eventPoolSummary = await this._eventPool.summary();
    return { ...this.eventPoolSummary };
  }

  async eventPoolDigest(): Promise<EventPoolDigest> {
    if (!this._eventPool) return { pendingInbound: 0, items: [] };
    const snap = await this._eventPool.snapshot();
    this.eventPoolSummary = snap.summary;
    return buildInboundEventDigest(snap.events);
  }

  async eventPoolSnapshot(filter?: {
    direction?: EventDirection;
    status?: PoolEventStatus;
    ids?: string[];
    limit?: number;
  }): Promise<EventPoolSnapshot> {
    const snap = await this.requireEventPool().snapshot(filter);
    this.eventPoolSummary = snap.summary;
    return snap;
  }

  async postInboundEvent(input: { text: string; title?: string; replyTo?: string }) {
    const result = await this.requireEventPool().postInbound({
      text: input.text,
      title: input.title,
      replyTo: input.replyTo,
      runId: this.runId,
      epoch: this.mode === "auto" ? this.epoch : null,
    });
    this.eventPoolSummary = result.summary;
    this.record(
      "pool_event",
      {
        action: "created",
        event: result.event,
        ...(result.resolvedOutbound ? { resolvedOutbound: result.resolvedOutbound } : {}),
      },
      this.currentCycleTrace(),
    );
    return { ...result, status: this.status() };
  }

  async emitOutboundEvent(
    input: { kind?: OutboundEventKind; text: string; title?: string; pause?: boolean },
    trace?: EventTrace,
  ) {
    const pauseRequested = Boolean(input.pause);
    const result = await this.requireEventPool().emitOutbound({
      kind: input.kind,
      text: input.text,
      title: input.title,
      pauseRequested,
      runId: this.runId,
      epoch: this.mode === "auto" ? this.epoch : null,
    });
    this.eventPoolSummary = result.summary;
    this.record("pool_event", { action: "created", event: result.event }, this.currentCycleTrace(trace));
    const shouldPause = pauseRequested && (this.mode === "auto" || this.mode === "acquiring");
    if (shouldPause) await this.stop("awaiting human");
    return { event: result.event, paused: shouldPause, summary: result.summary, status: this.status() };
  }

  async readInboundEvents(
    options?: { ids?: string[]; includeHandled?: boolean; ack?: boolean },
    trace?: EventTrace,
  ) {
    const result = await this.requireEventPool().readInbound(options);
    this.eventPoolSummary = result.summary;
    if (result.acknowledged.length > 0) {
      this.record(
        "pool_event",
        {
          action: "handled",
          actor: "shiori",
          ids: result.acknowledged.map(item => item.id),
          events: result.acknowledged,
        },
        this.currentCycleTrace(trace),
      );
    }
    return result;
  }

  async ackPoolEvents(
    ids: readonly string[],
    actor: PoolEventActor,
    direction?: EventDirection,
    trace?: EventTrace,
  ) {
    const result = await this.requireEventPool().ack(ids, actor, direction);
    this.eventPoolSummary = result.summary;
    if (result.updated.length > 0) {
      this.record(
        "pool_event",
        {
          action: "handled",
          actor,
          ids: result.updated.map(item => item.id),
          events: result.updated,
        },
        this.currentCycleTrace(trace),
      );
    }
    return { ...result, status: this.status() };
  }

  private abortAgent() {
    this.aborting = this._agent?.abort().catch((e) => this.record("error", String(e)));
  }

  private withControlTimeout<T>(pending: Promise<T>, operation: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`${operation} timed out; device state is uncertain`);
        this.connected = false;
        this.record("error", String(error));
        reject(error);
      }, this.controlTimeoutMs);
      pending.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
  }

  async stop(reason = "human") {
    if (this.stopping) return this.stopping;
    if (this.mode === "manual") {
      if (this.consolidating && !this.control?.signal.aborted) {
        this.reason = reason;
        this.control?.abort(new DOMException(reason, "AbortError"));
        clearTimeout(this.timer);
        this.abortAgent();
      }
      return;
    }
    const wasAuto = this.mode === "auto";
    const elapsedMs = this.takeoverStartedAtMs !== null ? Math.max(0, Date.now() - this.takeoverStartedAtMs) : undefined;
    this.takeoverStartedAtMs = null;
    this.mode = "releasing";
    this.reason = reason;
    this.control?.abort(reason === "time budget" ? new DOMException(reason, "AbortError") : undefined);
    if (this.statsTimer) { clearInterval(this.statsTimer); this.statsTimer = null; }
    if (this.runtimeStatsIntervalMs > 0 && wasAuto) this.emitRuntimeStats("stopped");
    clearTimeout(this.timer);
    // Revoking the device never waits for model cancellation.
    this.abortAgent();
    // Perception revocation joins the handback barrier: its sampler stops,
    // final perception_stats flush, and segments seal strictly before the
    // cycle's control(manual) event.
    const perceptionRevoked = this._perception?.setLease(null)
      ?.catch(error => this.record("error", String(error), { epoch: this.epoch }));
    this.stopping = (async () => {
      // Release also covers a pending acquisition. Send it immediately after
      // cancellation instead of waiting for the acquisition RPC to return.
      const release = (async () => {
        try { if (this.ownsDevice) await this.withControlTimeout(this.devices!.release(this.epoch), "Control release"); }
        catch (error) {
          this.connected = false;
          this.record("error", String(error));
        }
      })();
      await Promise.all([this.opening?.catch(() => {}), release, perceptionRevoked]);
      // Handback is confirmed or the connection has failed closed. Drain
      // cancelled workspace calls before another epoch can start.
      await Promise.allSettled(this.calls);
      this.mode = "manual";
      this.record("control", { ...this.status(), ...(elapsedMs !== undefined ? { elapsedMs } : {}) }, { epoch: this.epoch });
    })().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }

  async disconnected(error: Error) {
    this.connected = false;
    this.record("device_paused", { reason: error.message, previousMode: this.mode }, this.epoch ? { epoch: this.epoch } : {});
    await this.stop(error.message);
    this.record("disconnected", error.message);
  }

  async reconnected() {
    this.connected = true;
    this.reason = "reconnected";
    this.record("control", this.status());
    if (this._perception) await this._perception.reload().catch(error => this.record("error", String(error)));
  }

  async close() {
    try {
      await this.stop("shutdown");
      await this.running;
      await this._agent?.close();
    } finally {
      await this._perception?.stop();
    }
  }

  private startStatsTimer() {
    if (this.runtimeStatsIntervalMs <= 0) return;
    this.statsTimer = setInterval(() => { if (this.mode === "auto") this.emitRuntimeStats("periodic"); }, this.runtimeStatsIntervalMs);
    this.statsTimer.unref?.();
  }

  private emitRuntimeStats(reason: "periodic" | "stopped") {
    const memory = process.memoryUsage();
    this.record("runtime_stats", { reason, mode: this.mode, epoch: this.epoch,
      elapsedMs: this.takeoverStartedAtMs !== null ? Math.max(0, Date.now() - this.takeoverStartedAtMs) : 0,
      remainingSeconds: this.mode === "auto" && this.takeoverDeadlineMs !== null ? Math.max(0, Math.ceil((this.takeoverDeadlineMs - performance.now()) / 1000)) : null,
      queue: this._agent?.queueState?.() ?? { steering: 0 },
      eventPool: { ...this.eventPoolSummary },
      memory: { rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal, external: memory.external },
    }, this.epoch ? { epoch: this.epoch } : {});
  }
}
