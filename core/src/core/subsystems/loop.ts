import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { basename, delimiter, join, resolve } from "node:path";
import type { Clock } from "@ludens/baseware/contracts";
import { childTrace, type DiagnosticsMode, type EventMetadata, type EventTrace, type RecordEvent } from "../storage/events.ts";
import { pythonModulePaths } from "./python-capabilities.ts";
import { pythonExecutable } from "@ludens/protocol/python";
import { PythonWorker } from "./python-worker.ts";

export interface LoopStatus {
  state: "unimplemented" | "loading" | "ready" | "stopped" | "error";
  generation: string | null;
  pid?: number;
  codeSHA?: string;
  error?: string;
}

export interface LoopFault {
  phase: "load" | "step" | "inject";
  error: string;
  codeSHA?: string;
  fallback: "default_loop";
}

export type LoopInjectionMode = "structured" | "custom_json" | "custom_text" | "none";

export interface LoopNormalizedInjection {
  mode: LoopInjectionMode;
  payload: unknown;
  attachImages: boolean;
}

export type LoopAction =
  | { kind: "prompt"; prompt: string | null; injection: LoopNormalizedInjection }
  | { kind: "consolidate"; prompt: string | null }
  | { kind: "wait"; seconds: number; reason: string | null }
  | { kind: "stop"; reason: string };

export interface LoopTurnContextWire {
  turn: number;
  llmTurns: number;
  initialMessage: string | null;
  defaultPrompt: string;
  steered: boolean;
  perception: Record<string, unknown>;
  perceptionState: Record<string, unknown> | null;
  eventPool: Record<string, unknown> | null;
  lastTurn: Record<string, unknown> | null;
  remainingSeconds: number | null;
  fault?: LoopFault | null;
}

export function buildDefaultStructuredPayload(
  ctx: Pick<LoopTurnContextWire, "perception" | "perceptionState" | "eventPool"> & { fault?: LoopFault | Record<string, unknown> | null },
): Record<string, unknown> {
  const perception = ctx.perception ?? { ok: true, records: [] };
  const ok = perception.ok !== false;
  const payload: Record<string, unknown> = ok
    ? { ok: true, records: Array.isArray(perception.records) ? [...perception.records] : [] }
    : {
        ok: false,
        ...(perception.error !== undefined && perception.error !== null ? { error: perception.error } : {}),
        ...(perception.availability !== undefined && perception.availability !== null ? { availability: perception.availability } : {}),
      };
  if (ctx.perceptionState !== null && ctx.perceptionState !== undefined) {
    payload.perceptionState = ctx.perceptionState;
  }
  if (ctx.eventPool !== null && ctx.eventPool !== undefined) {
    payload.eventPool = ctx.eventPool;
  }
  if (ctx.fault !== null && ctx.fault !== undefined) {
    payload.loopFault = ctx.fault;
  }
  return payload;
}

export function buildDefaultStructuredInjection(
  ctx: Pick<LoopTurnContextWire, "perception" | "perceptionState" | "eventPool"> & { fault?: LoopFault | Record<string, unknown> | null },
  attachImages = true,
): LoopNormalizedInjection {
  return {
    mode: "structured",
    payload: buildDefaultStructuredPayload(ctx),
    attachImages,
  };
}

function formatWorkerError(error: unknown): string {
  if (typeof error === "string" && error.length > 0) return error;
  if (error && typeof error === "object") {
    const typed = error as { type?: unknown; message?: unknown };
    if (typeof typed.message === "string" && typed.message.length > 0) {
      return typeof typed.type === "string" && typed.type.length > 0
        ? `${typed.type}: ${typed.message}`
        : typed.message;
    }
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function unwrapReply(reply: unknown): Record<string, any> {
  if (!reply || typeof reply !== "object") return {};
  const record = reply as Record<string, any>;
  if (record.result && typeof record.result === "object" && !Array.isArray(record.result)) {
    return { ...record, ...(record.result as Record<string, any>) };
  }
  return record;
}

function isValidInjection(value: unknown): value is LoopNormalizedInjection {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.mode === "structured" ||
      candidate.mode === "custom_json" ||
      candidate.mode === "custom_text" ||
      candidate.mode === "none") &&
    typeof candidate.attachImages === "boolean"
  );
}

function isValidAction(value: unknown): value is LoopAction {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  switch (candidate.kind) {
    case "prompt":
      return (
        (candidate.prompt === null || candidate.prompt === undefined || typeof candidate.prompt === "string") &&
        isValidInjection(candidate.injection)
      );
    case "consolidate":
      return candidate.prompt === null || candidate.prompt === undefined || typeof candidate.prompt === "string";
    case "wait":
      return (
        typeof candidate.seconds === "number" &&
        Number.isFinite(candidate.seconds) &&
        candidate.seconds >= 0 &&
        (candidate.reason === null || candidate.reason === undefined || typeof candidate.reason === "string")
      );
    case "stop":
      return typeof candidate.reason === "string";
    default:
      return false;
  }
}

/** Resident workspace `loop.py` runner with source-hash hot-reload and default-loop fault isolation. */
export class LoopRuntime {
  private current: LoopStatus = { state: "unimplemented", generation: null };
  private worker?: PythonWorker;
  private transition: Promise<unknown> = Promise.resolve();
  private readonly workspace: string;
  private readonly clock: Clock;
  private readonly socketPath: string;
  private active = false;
  private lifecycle = 0;
  private loadedSources = new Map<string, string | null>();
  private watcher?: FSWatcher;
  private watcherTimer?: NodeJS.Timeout;
  private watcherDirty = false;
  private lastFault: LoopFault | null = null;
  private initialized = false;

  constructor(private readonly options: {
    workspace: string;
    runDir: string;
    socketPath?: string;
    env?: NodeJS.ProcessEnv;
    record: RecordEvent;
    clock?: Clock;
    diagnostics?: DiagnosticsMode;
    loadTimeoutMs?: number;
    stepTimeoutMs?: number;
    stopGraceMs?: number;
  }) {
    this.workspace = resolve(options.workspace);
    this.clock = options.clock ?? { id: basename(options.runDir), now: () => performance.now() };
    this.socketPath = options.socketPath ?? options.env?.LUDENS_SOCKET ?? "";
  }

  status(): LoopStatus {
    if (this.current.state === "ready" && (!this.worker || this.worker.expectedExit)) {
      return { ...this.current, state: "stopped", pid: undefined };
    }
    return { ...this.current };
  }

  pendingFault(): LoopFault | null {
    return this.lastFault ? { ...this.lastFault } : null;
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.transition.then(work);
    this.transition = operation.catch(() => {});
    return operation;
  }

  reload(trace: EventTrace = {}, signal?: AbortSignal): Promise<LoopStatus> {
    this.active = true;
    const lifecycle = this.lifecycle;
    return this.enqueue(async () => {
      if (this.active && lifecycle === this.lifecycle) {
        await this.loadWorkspaceLoop(trace, signal);
      }
      return this.status();
    });
  }

  stop(): Promise<void> {
    this.active = false;
    this.initialized = false;
    ++this.lifecycle;
    this.closeWatcher();
    return this.enqueue(async () => {
      await this.closeWorker();
      if (this.current.state !== "unimplemented") {
        this.setStatus({ ...this.current, state: "stopped", pid: undefined, error: undefined });
      }
    });
  }

  async ensureFresh(trace: EventTrace = {}, signal?: AbortSignal): Promise<LoopStatus> {
    this.active = true;
    const lifecycle = this.lifecycle;
    return this.enqueue(async () => {
      signal?.throwIfAborted();
      if (!this.active || lifecycle !== this.lifecycle) return this.status();
      if (!this.initialized || await this.hasSourceChanges()) {
        await this.loadWorkspaceLoop(trace, signal);
      }
      return this.status();
    });
  }

  async step(params: {
    epoch: string;
    trace?: EventTrace;
    context: LoopTurnContextWire;
    signal?: AbortSignal;
  }): Promise<{ implemented: boolean; faulted: boolean; action: LoopAction }> {
    const { epoch, signal } = params;
    const stepTrace = childTrace({ epoch, ...params.trace, recordingPurpose: "loop" });
    await this.ensureFresh(stepTrace, signal);
    signal?.throwIfAborted();

    if (this.current.state === "unimplemented") {
      return {
        implemented: false,
        faulted: false,
        action: {
          kind: "prompt",
          prompt: null,
          injection: buildDefaultStructuredInjection({ ...params.context, fault: null }),
        },
      };
    }

    if (this.current.state === "error" || !this.worker || this.worker.expectedExit) {
      const fault = this.lastFault ?? {
        phase: "load" as const,
        error: this.current.error ?? "Loop worker is unavailable",
        ...(this.current.codeSHA ? { codeSHA: this.current.codeSHA } : {}),
        fallback: "default_loop" as const,
      };
      return {
        implemented: true,
        faulted: true,
        action: {
          kind: "prompt",
          prompt: null,
          injection: buildDefaultStructuredInjection({ ...params.context, fault }),
        },
      };
    }

    const started = this.clock.now();
    const wireContext: LoopTurnContextWire = {
      ...params.context,
      fault: null,
    };
    try {
      const rawReply = await this.worker.request(
        {
          type: "step",
          action: "step",
          workspace: this.workspace,
          socketPath: this.socketPath,
          runDir: this.options.runDir,
          scope: { epoch, trace: stepTrace },
          context: wireContext,
        },
        this.options.stepTimeoutMs ?? 30_000,
        signal,
      );
      signal?.throwIfAborted();
      const reply = unwrapReply(rawReply);
      const codeSHA = typeof reply.codeSHA === "string" ? reply.codeSHA : this.current.codeSHA;
      const generation = reply.generation !== undefined ? (reply.generation as string | null) : this.current.generation;

      if (reply.implemented === false && reply.ok !== false) {
        this.lastFault = null;
        this.loadedSources = new Map([["loop.py", null]]);
        this.setStatus({ state: "unimplemented", generation: null }, stepTrace);
        return {
          implemented: false,
          faulted: false,
          action: {
            kind: "prompt",
            prompt: null,
            injection: buildDefaultStructuredInjection({ ...params.context, fault: null }),
          },
        };
      }

      if (!reply.ok || !isValidAction(reply.action)) {
        const errorMsg = !reply.ok
          ? formatWorkerError(reply.error ?? "Loop.step failed")
          : `Invalid Loop.step action payload: ${JSON.stringify(reply.action)}`;
        const fault = this.recordFault("step", errorMsg, codeSHA, stepTrace);
        await this.snapshotSources(codeSHA ?? (await this.digestSource("loop.py")), generation ?? null);
        return {
          implemented: true,
          faulted: true,
          action: {
            kind: "prompt",
            prompt: null,
            injection: buildDefaultStructuredInjection({ ...params.context, fault }),
          },
        };
      }

      this.lastFault = null;
      if (generation !== this.current.generation || codeSHA !== this.current.codeSHA || this.current.state !== "ready") {
        this.setStatus({
          state: "ready",
          generation: generation ?? null,
          pid: this.worker?.process.pid,
          ...(codeSHA ? { codeSHA } : {}),
        }, stepTrace);
        await this.snapshotSources(codeSHA ?? (await this.digestSource("loop.py")), generation ?? null);
      }

      const action: LoopAction = reply.action.kind === "prompt"
        ? {
            kind: "prompt",
            prompt: reply.action.prompt ?? null,
            injection: this.attachFaultIfMissing(reply.action.injection, this.lastFault),
          }
        : reply.action.kind === "consolidate"
          ? { kind: "consolidate", prompt: reply.action.prompt ?? null }
          : reply.action.kind === "wait"
            ? { kind: "wait", seconds: reply.action.seconds, reason: reply.action.reason ?? null }
            : { kind: "stop", reason: reply.action.reason };

      const durationMs = typeof reply.durationMs === "number" && Number.isFinite(reply.durationMs)
        ? reply.durationMs
        : Math.max(0, this.clock.now() - started);

      this.record(
        "loop_step",
        {
          turn: params.context.turn,
          action: action.kind,
          durationMs,
          ...(codeSHA ? { codeSHA } : {}),
          generation: generation ?? null,
          ...(action.kind === "wait" ? { seconds: action.seconds, ...(action.reason !== null ? { reason: action.reason } : {}) } : {}),
          ...(action.kind === "stop" ? { reason: action.reason } : {}),
          ...(action.kind === "prompt" ? { customPrompt: action.prompt !== null, injectionMode: action.injection.mode } : {}),
          ...(action.kind === "consolidate" ? { customPrompt: action.prompt !== null } : {}),
        },
        stepTrace,
      );

      return { implemented: true, faulted: false, action };
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      const errorMsg = formatWorkerError(error);
      const codeSHA = this.current.codeSHA ?? (await this.digestSource("loop.py")) ?? undefined;
      await this.enqueueCloseBrokenWorker();
      const fault = this.recordFault("step", errorMsg, codeSHA, stepTrace);
      return {
        implemented: true,
        faulted: true,
        action: {
          kind: "prompt",
          prompt: null,
          injection: buildDefaultStructuredInjection({ ...params.context, fault }),
        },
      };
    }
  }

  async inject(params: {
    epoch: string;
    trace?: EventTrace;
    context: LoopTurnContextWire;
    signal?: AbortSignal;
  }): Promise<{ implemented: boolean; faulted: boolean; injection: LoopNormalizedInjection }> {
    const { epoch, signal } = params;
    const injectTrace = childTrace({ epoch, ...params.trace, recordingPurpose: "loop" });
    await this.ensureFresh(injectTrace, signal);
    signal?.throwIfAborted();

    if (this.current.state === "unimplemented") {
      return {
        implemented: false,
        faulted: false,
        injection: buildDefaultStructuredInjection({ ...params.context, fault: null }),
      };
    }

    if (this.current.state === "error" || !this.worker || this.worker.expectedExit) {
      const fault = this.lastFault ?? {
        phase: "load" as const,
        error: this.current.error ?? "Loop worker is unavailable",
        ...(this.current.codeSHA ? { codeSHA: this.current.codeSHA } : {}),
        fallback: "default_loop" as const,
      };
      return {
        implemented: true,
        faulted: true,
        injection: buildDefaultStructuredInjection({ ...params.context, fault }),
      };
    }

    const wireContext: LoopTurnContextWire = {
      ...params.context,
      fault: null,
    };
    try {
      const rawReply = await this.worker.request(
        {
          type: "inject",
          action: "inject",
          workspace: this.workspace,
          socketPath: this.socketPath,
          runDir: this.options.runDir,
          scope: { epoch, trace: injectTrace },
          context: wireContext,
        },
        this.options.stepTimeoutMs ?? 30_000,
        signal,
      );
      signal?.throwIfAborted();
      const reply = unwrapReply(rawReply);
      const codeSHA = typeof reply.codeSHA === "string" ? reply.codeSHA : this.current.codeSHA;
      const generation = reply.generation !== undefined ? (reply.generation as string | null) : this.current.generation;

      if (reply.implemented === false && reply.ok !== false) {
        this.lastFault = null;
        this.loadedSources = new Map([["loop.py", null]]);
        this.setStatus({ state: "unimplemented", generation: null }, injectTrace);
        return {
          implemented: false,
          faulted: false,
          injection: buildDefaultStructuredInjection({ ...params.context, fault: null }),
        };
      }

      if (!reply.ok || !isValidInjection(reply.injection)) {
        const errorMsg = !reply.ok
          ? formatWorkerError(reply.error ?? "Loop.inject failed")
          : `Invalid Loop.inject payload: ${JSON.stringify(reply.injection)}`;
        const fault = this.recordFault("inject", errorMsg, codeSHA, injectTrace);
        await this.snapshotSources(codeSHA ?? (await this.digestSource("loop.py")), generation ?? null);
        return {
          implemented: true,
          faulted: true,
          injection: buildDefaultStructuredInjection({ ...params.context, fault }),
        };
      }

      this.lastFault = null;
      if (generation !== this.current.generation || codeSHA !== this.current.codeSHA || this.current.state !== "ready") {
        this.setStatus({
          state: "ready",
          generation: generation ?? null,
          pid: this.worker?.process.pid,
          ...(codeSHA ? { codeSHA } : {}),
        }, injectTrace);
        await this.snapshotSources(codeSHA ?? (await this.digestSource("loop.py")), generation ?? null);
      }

      return {
        implemented: true,
        faulted: false,
        injection: this.attachFaultIfMissing(reply.injection, this.lastFault),
      };
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      const errorMsg = formatWorkerError(error);
      const codeSHA = this.current.codeSHA ?? (await this.digestSource("loop.py")) ?? undefined;
      await this.enqueueCloseBrokenWorker();
      const fault = this.recordFault("inject", errorMsg, codeSHA, injectTrace);
      return {
        implemented: true,
        faulted: true,
        injection: buildDefaultStructuredInjection({ ...params.context, fault }),
      };
    }
  }

  private attachFaultIfMissing(injection: LoopNormalizedInjection, fault: LoopFault | null): LoopNormalizedInjection {
    if (!fault || injection.mode !== "structured" || !injection.payload || typeof injection.payload !== "object" || Array.isArray(injection.payload)) {
      return injection;
    }
    const payload = injection.payload as Record<string, unknown>;
    if ("loopFault" in payload && payload.loopFault !== undefined) return injection;
    return { ...injection, payload: { ...payload, loopFault: fault } };
  }

  private async enqueueCloseBrokenWorker(): Promise<void> {
    this.initialized = false;
    await this.enqueue(async () => {
      await this.closeWorker();
    });
  }

  private async loadWorkspaceLoop(trace: EventTrace, signal?: AbortSignal): Promise<void> {
    const lifecycle = this.lifecycle;
    const loopSha = await this.digestSource("loop.py");
    signal?.throwIfAborted();
    if (!this.active || lifecycle !== this.lifecycle) return;

    // Fast-path when loop.py is absent: avoid spawning Python when unused.
    if (loopSha === null && !this.worker) {
      this.initialized = true;
      this.lastFault = null;
      this.loadedSources = new Map([["loop.py", null]]);
      this.setStatus({ state: "unimplemented", generation: null }, trace);
      this.startWatcher();
      return;
    }

    // If loop.py was deleted after previously running, notify or close cleanly.
    if (loopSha === null && this.worker) {
      await this.closeWorker();
      this.initialized = true;
      this.lastFault = null;
      this.loadedSources = new Map([["loop.py", null]]);
      this.setStatus({ state: "unimplemented", generation: null }, trace);
      this.startWatcher();
      return;
    }

    this.setStatus({ state: "loading", generation: this.current.generation, ...(loopSha ? { codeSHA: loopSha } : {}) }, trace);

    try {
      const worker = await this.ensureWorker(trace);
      signal?.throwIfAborted();
      if (!this.active || lifecycle !== this.lifecycle) return;

      const rawReply = await worker.request(
        {
          type: "load",
          action: "load",
          workspace: this.workspace,
          socketPath: this.socketPath,
          runDir: this.options.runDir,
        },
        this.options.loadTimeoutMs ?? 15_000,
        signal,
      );
      signal?.throwIfAborted();
      const reply = unwrapReply(rawReply);
      const codeSHA = typeof reply.codeSHA === "string" ? reply.codeSHA : (loopSha ?? undefined);
      const generation = typeof reply.generation === "string" ? reply.generation : null;
      this.initialized = true;

      if (reply.implemented === false && reply.ok !== false) {
        this.lastFault = null;
        await this.snapshotSources(null, null);
        this.setStatus({ state: "unimplemented", generation: null, pid: worker.process.pid }, trace);
      } else if (!reply.ok) {
        const errorMsg = formatWorkerError(reply.error ?? "Failed to load loop.py");
        this.recordFault("load", errorMsg, codeSHA, trace);
        await this.snapshotSources(codeSHA ?? loopSha, generation);
        this.setStatus({
          state: "error",
          generation,
          pid: worker.process.pid,
          ...(codeSHA ? { codeSHA } : {}),
          error: errorMsg,
        }, trace);
      } else {
        this.lastFault = null;
        await this.snapshotSources(codeSHA ?? loopSha, generation);
        this.setStatus({
          state: "ready",
          generation,
          pid: worker.process.pid,
          ...(codeSHA ? { codeSHA } : {}),
        }, trace);
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      const errorMsg = formatWorkerError(error);
      await this.closeWorker();
      this.initialized = true;
      this.recordFault("load", errorMsg, loopSha ?? undefined, trace);
      await this.snapshotSources(loopSha, null);
      this.setStatus({
        state: "error",
        generation: null,
        ...(loopSha ? { codeSHA: loopSha } : {}),
        error: errorMsg,
      }, trace);
    }

    if (this.active && lifecycle === this.lifecycle) this.startWatcher();
  }

  private async ensureWorker(trace: EventTrace): Promise<PythonWorker> {
    if (this.worker && !this.worker.expectedExit) return this.worker;
    const workerInstanceId = crypto.randomUUID();
    const directory = join(this.options.runDir, "loop", workerInstanceId);
    await mkdir(directory, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.options.env,
      LUDENS_WORKSPACE: this.workspace,
      LUDENS_RUN_ID: basename(this.options.runDir),
      LUDENS_LOG_DIAGNOSTICS: this.options.diagnostics ?? "normal",
      ...(this.socketPath ? { LUDENS_SOCKET: this.socketPath } : {}),
    };
    for (const key of ["LUDENS_EPOCH", "LUDENS_TRACE", "BASEWARE_EPOCH"]) {
      delete (env as NodeJS.ProcessEnv)[key];
    }
    env.PYTHONPATH = [...(env.PYTHONPATH ? [env.PYTHONPATH] : []), ...pythonModulePaths()].join(delimiter);

    const worker = new PythonWorker(workerInstanceId, {
      executable: pythonExecutable(env),
      module: "ludens_tools._loop",
      workspace: this.workspace,
      env,
      stderrPath: join(directory, "stderr.log"),
      ...(this.options.stopGraceMs !== undefined ? { stopGraceMs: this.options.stopGraceMs } : {}),
      onEvent: reply => {
        if (this.worker !== worker) return;
        if (reply.event === "recording" && reply.type) {
          this.record(reply.type, reply.data, reply.trace ?? trace, reply.channel, reply.origin);
        }
      },
      onExit: error => {
        if (this.worker !== worker) return;
        this.worker = undefined;
        this.initialized = false;
        if (!worker.expectedExit && this.active) {
          this.setStatus({ ...this.current, state: "error", pid: undefined, error: error.message });
        }
      },
    });
    this.worker = worker;
    return worker;
  }

  private async readSourcesManifest(generation: string | null): Promise<Record<string, string> | null> {
    const candidates = [
      join(this.workspace, ".ludens", "runtime", "loop", "sources.json"),
      ...(generation ? [join(this.workspace, ".ludens", "runtime", "loop", generation, "sources.json")] : []),
      ...(generation ? [join(this.options.runDir, "loop", generation, "sources.json")] : []),
      join(this.options.runDir, "loop", "sources.json"),
    ];
    for (const candidate of candidates) {
      try {
        const raw = await readFile(candidate, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, string>;
        }
      } catch {
        // Ignore missing or in-flight manifest candidate.
      }
    }
    return null;
  }

  private async snapshotSources(codeSHA: string | null, generation: string | null): Promise<void> {
    this.watcherDirty = false;
    const next = new Map<string, string | null>();
    next.set("loop.py", codeSHA);
    const manifest = await this.readSourcesManifest(generation);
    if (manifest) {
      for (const [relPath, sha] of Object.entries(manifest)) {
        if (relPath.endsWith(".py") && (typeof sha === "string" || sha === null)) {
          next.set(relPath, sha);
        }
      }
    }
    for (const relPath of this.loadedSources.keys()) {
      if (!next.has(relPath) && (await this.digestSource(relPath)) === null) {
        next.set(relPath, null);
      }
    }
    this.loadedSources = next;
  }

  private async digestSource(relPath: string): Promise<string | null> {
    try {
      const raw = await readFile(join(this.workspace, relPath));
      return createHash("sha256").update(raw).digest("hex");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async hasSourceChanges(): Promise<boolean> {
    if (!this.active) return false;
    if (this.loadedSources.size === 0) return true;
    const manifest = await this.readSourcesManifest(this.current.generation);
    if (manifest) {
      for (const [relPath, sha] of Object.entries(manifest)) {
        if (relPath.endsWith(".py") && (typeof sha === "string" || sha === null) && !this.loadedSources.has(relPath)) {
          this.loadedSources.set(relPath, sha);
        }
      }
    } else if (this.watcherDirty && this.current.state !== "unimplemented") {
      return true;
    }
    for (const [relPath, expectedSha] of this.loadedSources) {
      const actualSha = await this.digestSource(relPath);
      if (actualSha !== expectedSha) return true;
    }
    return false;
  }

  private startWatcher(): void {
    if (this.watcher || !this.active) return;
    const lifecycle = this.lifecycle;
    try {
      const watcher = (this.watcher = watch(this.workspace, { recursive: true }, (_event, filename) => {
        if (!this.active || lifecycle !== this.lifecycle) return;
        const name = String(filename ?? "").replaceAll("\\", "/");
        if (filename != null && !name.endsWith(".py")) return;
        if (name.split("/").some(part => [".ludens", "logs", ".git", "__pycache__", "node_modules"].includes(part))) return;
        this.watcherDirty = true;
        clearTimeout(this.watcherTimer);
        this.watcherTimer = setTimeout(() => {
          this.watcherTimer = undefined;
          void this.ensureFresh().catch(error => this.record("loop_reload_error", { error: String(error) }, undefined, "diagnostic"));
        }, 25);
      }));
      watcher.on("error", error => {
        if (this.watcher !== watcher) return;
        this.closeWatcher();
        this.record("loop_reload_error", { error: String(error) }, undefined, "diagnostic");
      });
    } catch (error) {
      this.watcher = undefined;
      this.record("loop_reload_error", { error: String(error) }, undefined, "diagnostic");
    }
  }

  private closeWatcher(): void {
    if (this.watcherTimer) {
      clearTimeout(this.watcherTimer);
      this.watcherTimer = undefined;
    }
    try {
      this.watcher?.close();
    } catch {
      // Ignore already-closed watcher.
    }
    this.watcher = undefined;
  }

  private async closeWorker(): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    this.worker = undefined;
    try {
      if (!worker.expectedExit) {
        await worker.request({ type: "shutdown", action: "shutdown" }, 1_500).catch(() => {});
      }
    } finally {
      await worker.stop().catch(() => {});
    }
  }

  private recordFault(phase: LoopFault["phase"], error: string, codeSHA: string | undefined, trace?: EventTrace): LoopFault {
    const fault: LoopFault = {
      phase,
      error,
      ...(codeSHA ? { codeSHA } : {}),
      fallback: "default_loop",
    };
    this.lastFault = fault;
    this.record("loop_fault", fault, trace);
    return fault;
  }

  private setStatus(status: LoopStatus, trace?: EventTrace, persist = true): void {
    if (JSON.stringify(status) === JSON.stringify(this.current)) return;
    this.current = status;
    if (persist) this.record("loop_status", status, trace);
  }

  private record(type: string, data: unknown, trace?: EventTrace, channel?: "diagnostic", origin?: EventMetadata["origin"]): void {
    if (channel === "diagnostic" && this.options.diagnostics !== "full") return;
    this.options.record(type, data, trace, {
      source: { component: "loop", implementation: "python" },
      ...(origin ? { origin } : {}),
      ...(channel ? { channel } : {}),
    });
  }
}
