import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { basename, delimiter, join, resolve } from "node:path";
import type { Clock, Observation } from "@ludens/baseware/contracts";
import { childTrace, type EventTrace, type RecordEvent, type RegisterMedia, type DiagnosticsMode, type EventMetadata } from "../storage/events.ts";
import { pythonModulePaths } from "./python-capabilities.ts";
import { pythonExecutable } from "@ludens/protocol/python";
import { PythonWorker, type WorkerReply } from "./python-worker.ts";
import type { VideoFrameReference } from "@ludens/protocol/timeline-types";

export interface PerceptionStatus {
  state: "unimplemented" | "loading" | "ready" | "stopped" | "error";
  generation: string | null;
  pid?: number;
  codeSHA?: string;
  error?: string;
  sampleHz?: number;
  history?: { persistent: boolean; hotSeconds: number; segmentSeconds: number; hotBytes: number; segmentBytes: number;
    videoSegmentSeconds: number; videoIdleSeconds: number; budgetEvictions: number };
  startupDurationMs?: number;
}
export interface PerceptionSnapshot {
  id: string;
  sequence: number;
  generation: string | null;
  capability?: string;
  identity?: TimelineAppend["identity"];
  trace?: EventTrace;
  runId?: string | null;
  timeline?: { recordId: string; sequence: number };
  recordedAt: string;
  sampling: { clock: string; startedAtMs: number; finishedAtMs: number };
  sampledAt?: string;
  sources?: unknown[];
}
export interface ObservationQuery {
  at?: string | null; start?: string | null; end?: string | null;
  limit?: number | null; after?: number | null;
  capability?: string | null; id?: string | null;
  ifNoneMatchSequence?: number | null;
}
export interface PerceptionRecord extends PerceptionSnapshot {
  text: string; media: Observation[];
  data?: unknown; space?: unknown;
  effect?: unknown; transition?: unknown;
}
export interface TimelineAppend {
  sample: unknown; identity: { id: string; codeSHA?: string; origin?: unknown };
  sampling: { clock: string; startedAtMs: number; finishedAtMs: number };
  generation?: string | null; runId?: string; trace?: EventTrace;
}
export interface TimelineDerive {
  source: { asset: string; recordId: string; sequence: number };
  data: string; mediaType: string; transform: string;
}
export interface TimelineMedia {
  sha256: string; asset: string; mediaType: string; bytes: number;
  recordId: string; sequence: number; sourceAsset: string; transform: string;
  video?: VideoFrameReference;
  approximate?: boolean;
}
export type DeriveMedia = (input: TimelineDerive, observationId?: string) => Promise<TimelineMedia>;
export interface PerceptionRead {
  queryId: string;
  ok: boolean;
  query: ObservationQuery;
  records: PerceptionRecord[];
  hasMore: boolean;
  unchanged?: boolean;
  sequence?: number;
  nextAfter?: number;
  error?: { code: string; message: string };
  availability?: { persistent: boolean; hotSeconds: number;
    earliest: { sequence: number; recordedAt: string } | null;
    latest: { sequence: number; recordedAt: string } | null; expired: boolean };
}
/** One workspace process owns the unified resident perception-and-action state machine. Source edits auto-reload it. */
export class PerceptionRuntime {
  private current: PerceptionStatus = { state: "unimplemented", generation: null };
  private worker?: PythonWorker;
  private transition: Promise<unknown> = Promise.resolve();
  private reading: Promise<unknown> = Promise.resolve();
  private readonly workspace: string;
  private readonly clock: Clock;
  // Only identities for explicitly delivered images, keyed by the CLI's record marker.
  private deliveredMedia = new Map<string, TimelineMedia>();
  private observeCapability = "python/perception.py:Perception.sample";
  private lease: { epoch: string | null; inputGeneration: string | null } = { epoch: null, inputGeneration: null };
  private active = false;
  private loadedSources = new Map<string, string | null>();
  private watcher?: FSWatcher;
  private watcherTimer?: NodeJS.Timeout;
  private lifecycle = 0;
  private leaseRevision = 0;
  private leaseSignal?: AbortSignal;
  private admittedGeneration: string | null = null;
  private generationLoadingStartedAtMs: number | null = null;
  private deviceLeaseEpoch: string | null = null;

  constructor(private readonly options: {
    workspace: string; runDir: string; env?: NodeJS.ProcessEnv; record: RecordEvent; clock?: Clock;
    registerMedia?: RegisterMedia; diagnostics?: DiagnosticsMode;
    startTimeoutMs?: number; observeTimeoutMs?: number;
    setInputGeneration?: (epoch: string, generation: string | null) => Promise<void>;
    onCleanupError?: (error: Error) => void;
  }) {
    this.workspace = resolve(options.workspace);
    this.clock = options.clock ?? { id: basename(options.runDir), now: () => performance.now() };
  }

  status(): PerceptionStatus {
    // stop/reload can spend time flushing the old writer. Its last persisted
    // event may still say ready after shutdown began; that is no longer a
    // current sampler observation. Keep history as last-loaded evidence.
    if (this.current.state === "ready" && (!this.worker || !this.isCurrent(this.worker)))
      return { ...this.current, state: "stopped", pid: undefined };
    return { ...this.current };
  }

  accepts(epoch: string | undefined, inputGeneration: string): boolean {
    return !!epoch && this.lease.epoch === epoch && this.admittedGeneration === inputGeneration;
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.transition.then(work);
    this.transition = operation.catch(() => {});
    return operation;
  }

  reload(trace: EventTrace = {}): Promise<PerceptionStatus> {
    this.active = true;
    const lifecycle = this.lifecycle;
    return this.enqueue(async () => {
      if (this.active && lifecycle === this.lifecycle) await this.replace(trace);
      return this.status();
    });
  }

  stop(): Promise<void> {
    // Fence checks already reading files, queued reloads, and delayed grants.
    this.active = false;
    ++this.lifecycle;
    ++this.leaseRevision;
    this.admittedGeneration = null;
    this.lease.inputGeneration = null;
    this.closeWatcher();
    return this.enqueue(async () => {
      try { await this.clearDeviceGeneration(); }
      finally {
        await this.closeWorker();
        this.setStatus({ ...this.current, state: "stopped", pid: undefined, error: undefined });
      }
    });
  }

  observe(signal: AbortSignal, parent: EventTrace = {}, query: ObservationQuery = {}): Promise<PerceptionRead> {
    const result = this.reading.then(() => this.read(signal, parent, query));
    this.reading = result.catch(() => {});
    return result;
  }

  async stateMachine(signal?: AbortSignal): Promise<{ state: string; arguments: Record<string, unknown>; epoch: string | null }> {
    if (this.active) await this.ensureFresh({}, signal);
    const worker = this.worker;
    if (!worker || worker.expectedExit) throw new Error("Perception state machine is unavailable; run ludens perception reload.");
    const reply = await this.request(worker, { action: "state" }, 5000, signal);
    if (!reply.ok) throw new Error(`${reply.error?.type}: ${reply.error?.message}`);
    return reply.result as { state: string; arguments: Record<string, unknown>; epoch: string | null };
  }

  async transitionState(to: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<{ state: string; arguments: Record<string, unknown>; epoch: string | null }> {
    if (this.active) await this.ensureFresh({}, signal);
    const worker = this.worker;
    if (!worker || worker.expectedExit) throw new Error("Perception state machine is unavailable; run ludens perception reload.");
    const reply = await this.request(worker, { action: "transition", to, arguments: args }, 5000, signal);
    if (!reply.ok) throw new Error(`${reply.error?.type}: ${reply.error?.message}`);
    return reply.result as { state: string; arguments: Record<string, unknown>; epoch: string | null };
  }

  setLease(epoch: string | null, inputGeneration: string | null = null, signal?: AbortSignal): Promise<unknown> {
    const effectiveGeneration = inputGeneration ?? this.current.generation;
    if (epoch && this.active && !signal?.aborted && this.lease.epoch === epoch
      && this.admittedGeneration !== null && this.admittedGeneration === effectiveGeneration) {
      this.leaseSignal = signal;
      return Promise.resolve({ ...this.lease });
    }
    const revision = ++this.leaseRevision;
    this.admittedGeneration = null;
    // Desired authority changes synchronously, even while Python is shutting down.
    this.lease = { epoch, inputGeneration: null };
    this.leaseSignal = signal;
    return this.enqueue(async () => {
      if (revision !== this.leaseRevision) return this.lease;
      const generation = epoch && this.active ? (inputGeneration ?? this.current.generation) : null;
      try {
        signal?.throwIfAborted();
        if (this.deviceLeaseEpoch && this.deviceLeaseEpoch !== epoch) await this.clearDeviceGeneration();
        if (epoch && generation) await this.grantGeneration(epoch, generation, revision);
        else await this.clearDeviceGeneration();
        signal?.throwIfAborted();
        if (revision !== this.leaseRevision) return this.lease;
        const worker = this.worker;
        if (!worker || worker.expectedExit) return this.lease;
        const reply = await this.request(worker, { action: "lease", ...this.lease }, 5000, signal);
        if (!reply.ok) throw new Error(`${reply.error?.type}: ${reply.error?.message}`);
        return reply.result;
      } catch (error) {
        this.admittedGeneration = null;
        if (revision === this.leaseRevision) this.lease = { epoch: null, inputGeneration: null };
        await this.clearDeviceGeneration();
        throw error;
      }
    });
  }

  private async grantGeneration(epoch: string, generation: string, revision: number): Promise<void> {
    this.leaseSignal?.throwIfAborted();
    // Track even a failed grant so cleanup can compensate an uncertain reply.
    this.deviceLeaseEpoch = epoch;
    await this.options.setInputGeneration?.(epoch, generation);
    if (this.active && revision === this.leaseRevision && this.lease.epoch === epoch && !this.leaseSignal?.aborted) {
      this.lease.inputGeneration = generation;
      this.admittedGeneration = generation;
    }
  }

  private async clearDeviceGeneration(): Promise<void> {
    this.admittedGeneration = null;
    const epoch = this.deviceLeaseEpoch;
    if (epoch === null) return;
    try {
      await this.options.setInputGeneration?.(epoch, null);
      this.deviceLeaseEpoch = null;
    } catch (error) {
      const failure = new Error(`Perception input cleanup failed: ${String(error)}`);
      this.options.onCleanupError?.(failure);
      throw failure;
    }
  }

  async append(input: TimelineAppend, signal: AbortSignal): Promise<unknown> {
    const worker = this.worker;
    if (!worker || worker.expectedExit) throw new Error("Timeline recorder is unavailable; run ludens perception reload.");
    const reply = await this.request(worker, { ...input, action: "append" }, 30_000, signal);
    if (!reply.ok) throw new Error(`${reply.error?.type}: ${reply.error?.message}`);
    return reply.result;
  }

  async deriveMedia(input: TimelineDerive, signal: AbortSignal, observationId?: string): Promise<TimelineMedia> {
    const worker = this.worker;
    if (!worker || worker.expectedExit) throw new Error("Timeline recorder is unavailable; run ludens perception reload.");
    const reply = await this.request(worker, { ...input, action: "derive" }, 30_000, signal);
    if (!reply.ok) throw new Error(`${reply.error?.type}: ${reply.error?.message}`);
    const media = reply.result as TimelineMedia;
    this.options.registerMedia?.(media);
    if (observationId) {
      const key = `${observationId}\0${media.sha256}`;
      this.deliveredMedia.delete(key);
      this.deliveredMedia.set(key, media);
      if (this.deliveredMedia.size > 4096) this.deliveredMedia.delete(this.deliveredMedia.keys().next().value!);
    }
    return media;
  }

  deliveredMediaReference(sha256: string, observationId?: string): TimelineMedia | undefined {
    return observationId ? this.deliveredMedia.get(`${observationId}\0${sha256}`) : undefined;
  }

  private async read(signal: AbortSignal, parent: EventTrace, query: ObservationQuery): Promise<PerceptionRead> {
    const trace = childTrace(parent), started = this.clock.now(), queryId = trace.spanId!;
    let worker: PythonWorker | undefined;
    const failure = (code: string, message: string, availability?: PerceptionRead["availability"]): PerceptionRead => ({
      queryId, ok: false, query, records: [], hasMore: false, error: { code, message },
      ...(availability ? { availability } : {}),
    });
    this.record("perception_observe_start", { queryId, query }, trace);
    try {
      signal.throwIfAborted();
      const latestQuery = [query.at, query.start, query.end, query.after, query.id]
        .every(value => value == null || (typeof value === "string" && !value.trim()));
      if (latestQuery && this.active) await this.ensureFresh(parent, signal);
      signal.throwIfAborted();
      worker = this.worker;
      if (!worker || worker.expectedExit) return this.finish(failure("UNAVAILABLE",
        this.current.error ?? `Perception is ${this.current.state}.`), started, trace);
      const reply = await this.request(worker, { action: "observe", query },
        this.options.observeTimeoutMs ?? 5000, signal);
      signal.throwIfAborted();
      if (!this.isCurrent(worker)) return this.finish(failure("UNAVAILABLE",
        "Perception generation stopped or was replaced during observation."), started, trace);
      // Query/decoding errors do not change the sampler's lifecycle status.
      if (!reply.ok) return this.finish(failure("QUERY_FAILED",
        `${reply.error?.type}: ${reply.error?.message}`), started, trace);
      const value = reply.result as { records: Array<PerceptionSnapshot & {
        text: string; data?: unknown; space?: unknown; effect?: unknown; transition?: unknown;
        media: { path?: string; mediaType: string; data?: string; timeline?: Observation["timeline"] }[];
      }>; query: ObservationQuery; hasMore: boolean; nextAfter?: number; unchanged?: boolean; sequence?: number; availability?: PerceptionRead["availability"] };
      const records: PerceptionRecord[] = value.records.map(({ media, ...record }) => ({
        ...record,
        media: media.map((item, index) => ({
          ...item, id: `${record.id}-${index}`, controllerId: "perception",
          timing: { clock: record.sampling.clock, requestedAtMs: record.sampling.startedAtMs,
            receivedAtMs: record.sampling.finishedAtMs },
        })),
      }));
      // Use the store's normalized query for mode selection and freshness.
      query = value.query;
      const latest = query.at === undefined && query.start === undefined && query.end === undefined
        && query.after === undefined && query.id === undefined;
      const mainLatest = latest && (!query.capability || query.capability === this.observeCapability
        || query.capability === "python/perception.py:Perception.sample");
      // Explicit history survives sampler failure/reload; current perception must
      // never present a previous generation's record as a fresh observation.
      const generation = worker.generation;
      const currentRecords = mainLatest ? records.filter(record => record.generation === generation) : records;
      if (mainLatest && this.current.state !== "ready") {
        return this.finish(failure(this.current.state === "loading" ? "NOT_READY" : "UNAVAILABLE",
          this.current.error ?? `Perception is ${this.current.state}.`,
          value.availability), started, trace);
      }
      if (value.unchanged === true && (!mainLatest || this.current.state === "ready")) {
        return this.finish({ queryId, ok: true, query, records: [], hasMore: false, unchanged: true,
          ...(value.sequence === undefined ? {} : { sequence: value.sequence }), availability: value.availability }, started, trace);
      }
      if (!currentRecords.length) {
        // Retention metadata cannot prove that an unknown ID/capability ever
        // existed. Only a time/range query can identify an expired interval.
        if (!latest && query.id === undefined && value.availability?.expired) return this.finish(failure("EXPIRED",
          "Requested observation has expired from the non-persistent history window. See availability for the retained range.",
          value.availability), started, trace);
        if (latest) return this.finish(failure("NOT_READY", "No sample available from the selected capability yet.",
          value.availability), started, trace);
        if (query.id !== undefined || query.at !== undefined) return this.finish(failure("NOT_FOUND",
          query.id !== undefined ? "No observation with the requested ID." : "No observation at or before the requested time.",
          value.availability), started, trace);
        // An ordinary empty range or exhausted cursor is a successful page.
      }
      return this.finish({ queryId, ok: true, query, records: currentRecords, hasMore: value.hasMore,
        availability: value.availability,
        ...(value.nextAfter === undefined ? {} : { nextAfter: value.nextAfter }) }, started, trace);
    } catch (error) {
      if (signal.aborted) {
        this.record("perception_observe_end", { queryId, query, outcome: "cancelled",
          durationMs: this.clock.now() - started }, trace);
        throw signal.reason ?? error;
      }
      const unavailable = worker && !this.isCurrent(worker);
      return this.finish(failure(unavailable ? "UNAVAILABLE" : "QUERY_FAILED", unavailable
        ? "Perception generation stopped or was replaced during observation."
        : error instanceof Error ? error.message : String(error)), started, trace);
    }
  }

  private async replace(trace: EventTrace): Promise<void> {
    const lifecycle = this.lifecycle;
    try {
      // Reject old calls and clear held input before waiting on user close().
      try { await this.clearDeviceGeneration(); }
      finally { await this.closeWorker(); }
      if (!this.active || lifecycle !== this.lifecycle) return;
      await this.startGeneration(trace);
    } catch (error) {
      try { await this.clearDeviceGeneration(); }
      finally {
        await this.closeWorker();
        this.setStatus({ ...this.current, state: "error", pid: undefined, error: String(error) }, trace);
      }
      throw error;
    }
  }

  private async startGeneration(trace: EventTrace): Promise<void> {
    const lifecycle = this.lifecycle;
    let source: Buffer | undefined;
    let sourceError: string | undefined;
    try { source = await readFile(join(this.workspace, "perception.py")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") sourceError = String(error);
    }
    const generation = crypto.randomUUID(), codeSHA = source ? createHash("sha256").update(source).digest("hex") : undefined;
    if (this.current.state !== "loading") this.generationLoadingStartedAtMs = Date.now();
    this.setStatus({ state: "loading", generation, codeSHA }, trace);
    const directory = join(this.options.runDir, "perception", generation);
    await mkdir(directory, { recursive: true });
    if (source) await writeFile(join(directory, "perception.py"), source);
    const backgroundTrace = childTrace({ recordingId: basename(this.options.runDir), recordingPurpose: "continuous-perception" });
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.options.env, LUDENS_WORKSPACE: this.workspace,
      LUDENS_RUN_ID: basename(this.options.runDir), LUDENS_LOG_DIAGNOSTICS: this.options.diagnostics ?? "normal",
      BASEWARE_TRACE: JSON.stringify(backgroundTrace) };
    for (const key of ["LUDENS_EPOCH", "LUDENS_TRACE", "BASEWARE_EPOCH"]) delete (env as NodeJS.ProcessEnv)[key];
    env.PYTHONPATH = [...pythonModulePaths(), ...(env.PYTHONPATH ? [env.PYTHONPATH] : [])].join(delimiter);
    if (!this.active || lifecycle !== this.lifecycle) return;
    if (this.lease.epoch !== null) await this.grantGeneration(this.lease.epoch, generation, this.leaseRevision);
    if (!this.active || lifecycle !== this.lifecycle) return;
    const worker = new PythonWorker(generation, {
      executable: pythonExecutable(env), module: "ludens_tools._perception", workspace: this.workspace, env,
      stderrPath: join(directory, "stderr.log"),
      onEvent: reply => {
        // Expected exits still flush statistics and media registrations.
        if (this.worker !== worker) return;
        for (const media of reply.mediaReferences ?? []) this.options.registerMedia?.(media);
        if (reply.history && this.isCurrent(worker))
          this.setStatus({ ...this.current, history: reply.history }, backgroundTrace, false);
        if (reply.event === "status" && this.isCurrent(worker)) this.setStatus({ ...this.current, state: reply.state,
          error: typeof reply.error === "string" ? reply.error : undefined }, backgroundTrace, !reply.transient);
        if (reply.event === "recording" && reply.type) this.record(reply.type, reply.data, reply.trace ?? backgroundTrace, reply.channel, reply.origin);
      },
      onExit: error => {
        if (this.worker !== worker) return;
        this.worker = undefined;
        if (!worker.expectedExit) {
          this.admittedGeneration = null;
          this.lease.inputGeneration = null;
          this.setStatus({ ...this.current, state: "error", pid: undefined, error: error.message });
          void this.enqueue(async () => {
            if (this.current.generation === worker.generation) await this.clearDeviceGeneration();
          }).catch(error => this.record("perception_reload_error", { error: String(error) }));
        }
      },
    });
    this.worker = worker;
    // Background reads are rooted at this generation, not at the model call
    // that happened to reload it. Its status event makes that root discoverable.
    this.setStatus({ ...this.current, pid: worker.process.pid }, backgroundTrace);
    try {
      const reply = await this.request(worker, { action: "start", workspace: this.workspace,
        runDir: this.options.runDir, generation, source: source?.toString("utf8"), sourceError, trace: backgroundTrace,
        diagnostics: this.options.diagnostics ?? "normal",
        epoch: this.admittedGeneration ? this.lease.epoch : null, inputGeneration: this.admittedGeneration },
      this.options.startTimeoutMs ?? 30_000);
      if (!reply.ok) throw new Error(`${reply.error?.type}: ${reply.error?.message}`);
      const result = reply.result as { sampleHz?: number; history: PerceptionStatus["history"]; state: PerceptionStatus["state"]; error?: string; observeCapability: string };
      this.observeCapability = result.observeCapability;
      this.setStatus({ ...this.current, sampleHz: result.sampleHz, history: this.current.history ?? result.history,
        ...(this.current.state === "loading" ? { state: result.state, error: result.error } : {}) }, trace);
    } catch (error) {
      try { await this.clearDeviceGeneration(); }
      finally { await this.closeWorker(); }
      this.setStatus({ ...this.current, state: "error", pid: undefined, error: String(error) }, trace);
    }
    await this.snapshotSources(codeSHA ?? null, generation);
    if (this.active && lifecycle === this.lifecycle) this.startWatcher();
  }

  private async snapshotSources(codeSHA: string | null, generation: string): Promise<void> {
    const next = new Map<string, string | null>();
    next.set("perception.py", codeSHA);
    try {
      const raw = await readFile(join(this.options.runDir, "perception", generation, "sources.json"), "utf8");
      const manifest = JSON.parse(raw) as Record<string, string>;
      for (const [relPath, sha] of Object.entries(manifest)) {
        if (relPath.endsWith(".py") && typeof sha === "string") next.set(relPath, sha);
      }
    } catch { /* worker may have failed before writing sources.json */ }
    // A deleted dependency cannot be imported into the new manifest. Retain
    // its missing-file baseline so restoring it can repair the failed load.
    for (const relPath of this.loadedSources.keys()) {
      if (!next.has(relPath) && await this.digestSource(relPath) === null) next.set(relPath, null);
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
    const generation = this.current.generation;
    if (generation) {
      try {
        const raw = await readFile(join(this.options.runDir, "perception", generation, "sources.json"), "utf8");
        const manifest = JSON.parse(raw) as Record<string, string>;
        for (const [relPath, sha] of Object.entries(manifest)) {
          if (relPath.endsWith(".py") && typeof sha === "string" && !this.loadedSources.has(relPath))
            this.loadedSources.set(relPath, sha);
        }
      } catch { /* sources.json not yet written */ }
    }
    for (const [relPath, expectedSha] of this.loadedSources) {
      const actualSha = await this.digestSource(relPath);
      if (actualSha !== expectedSha) return true;
    }
    return false;
  }
  private ensureFresh(trace: EventTrace = {}, signal?: AbortSignal): Promise<void> {
    const lifecycle = this.lifecycle;
    // Source reads and replacement share the lifecycle queue: concurrent callers
    // recheck the installed generation instead of enqueueing duplicate reloads.
    return this.enqueue(async () => {
      const deadline = Date.now() + (this.options.observeTimeoutMs ?? 5000);
      while (this.active && lifecycle === this.lifecycle) {
        signal?.throwIfAborted();
        if (await this.hasSourceChanges()) {
          if (!this.active || lifecycle !== this.lifecycle) return;
          await this.replace(trace);
        } else if (this.current.state !== "loading") return;
        if (Date.now() >= deadline) throw new Error("Perception freshness timed out while sources or the sampler were loading.");
        await new Promise<void>(resolve => setTimeout(resolve, 10));
      }
    });
  }

  private startWatcher(): void {
    if (this.watcher || !this.active) return;
    const lifecycle = this.lifecycle;
    try {
      const watcher = this.watcher = watch(this.workspace, { recursive: true }, (_event, filename) => {
        if (!this.active || lifecycle !== this.lifecycle) return;
        const name = String(filename ?? "").replaceAll("\\", "/");
        if (filename != null && !name.endsWith(".py")) return;
        if (name.split("/").some(part => [".ludens", "logs", ".git", "__pycache__", "node_modules"].includes(part))) return;
        clearTimeout(this.watcherTimer);
        this.watcherTimer = setTimeout(() => {
          this.watcherTimer = undefined;
          void this.ensureFresh().catch(error => this.record("perception_reload_error", { error: String(error) }));
        }, 25);
      });
      watcher.on("error", error => {
        if (this.watcher !== watcher) return;
        this.closeWatcher();
        this.record("perception_reload_error", { error: String(error) });
      });
    } catch (error) {
      this.watcher = undefined;
      this.record("perception_reload_error", { error: String(error) });
    }
  }

  private closeWatcher(): void {
    if (this.watcherTimer) { clearTimeout(this.watcherTimer); this.watcherTimer = undefined; }
    try { this.watcher?.close(); } catch { /* already closed */ }
    this.watcher = undefined;
  }

  private request(worker: PythonWorker, message: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<WorkerReply> {
    return worker.request(message, timeoutMs, signal).then(reply => {
      const history = (reply as WorkerReply & { history?: PerceptionStatus["history"] }).history;
      // A later sample event can arrive before this reply's promise resumes.
      if (history && this.isCurrent(worker) && history.budgetEvictions >= (this.current.history?.budgetEvictions ?? 0))
        this.setStatus({ ...this.current, history }, undefined, false);
      return reply;
    });
  }

  private async closeWorker() {
    const worker = this.worker;
    if (worker) await worker.stop();
  }

  private isCurrent(worker: PythonWorker) {
    return this.worker === worker && !worker.expectedExit && this.current.generation === worker.generation;
  }

  private finish(read: PerceptionRead, started: number, trace: EventTrace) {
    // Cold video decoding produces new image bytes. Register their identity
    // against the same frame before a CLI/tool result can reach log archival.
    const media = read.records.flatMap(record => record.media).flatMap(observation => {
      if (observation.data === undefined || !observation.timeline?.video) return [];
      const bytes = Buffer.from(observation.data, "base64");
      return [{ ...observation.timeline, sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length, mediaType: observation.mediaType, approximate: true }];
    });
    for (const reference of media) this.options.registerMedia?.(reference);
    this.record("perception_observe_end", { ...perceptionMetadata(read), outcome: read.ok ? "success" : "error",
      durationMs: this.clock.now() - started }, trace);
    return read;
  }

  private setStatus(status: PerceptionStatus, trace?: EventTrace, persist = true) {
    let next = status;
    if (next.state !== "loading" && this.generationLoadingStartedAtMs !== null) {
      const startupDurationMs = Math.max(0, Date.now() - this.generationLoadingStartedAtMs);
      this.generationLoadingStartedAtMs = null;
      next = { ...next, startupDurationMs };
    }
    if (JSON.stringify(next) === JSON.stringify(this.current)) return;
    this.current = next;
    if (persist) this.record("perception_status", next, trace);
  }

  private record(type: string, data: unknown, trace?: EventTrace, channel?: "diagnostic", origin?: EventMetadata["origin"]) {
    if (type.startsWith("perception_observe_") && trace?.recordingPurpose === "continuous-perception") channel = "diagnostic";
    if (channel === "diagnostic" && this.options.diagnostics !== "full") return;
    this.options.record(type, data, trace, { source: { component: "perception", implementation: "python" },
      ...(origin ? { origin } : {}), ...(channel ? { channel } : {}) });
  }
}

/** Events point at the axis; selected media bytes only live in delivery responses. */
export function observationMetadata({ data: _data, ...observation }: Observation): Observation { return observation; }

export function perceptionMetadata(read: PerceptionRead): PerceptionRead {
  return { ...read, records: read.records.map(({ data: _data, space: _space, ...record }) => ({ ...record,
    media: record.media.map(observationMetadata) })) };
}

/** One model/terminal view: workspace sources remain meaningful input; internal trace/storage links stay in query results and logs. */
export function perceptionInput(read: PerceptionRead) {
  return { queryId: read.queryId, ok: read.ok, query: read.query, records: read.records.map(record => ({
    id: record.id, sequence: record.sequence, generation: record.generation,
    ...(record.capability === undefined ? {} : { capability: record.capability }),
    ...(record.identity?.codeSHA === undefined ? {} : { codeSHA: record.identity.codeSHA }),
    ...(record.sources === undefined ? {} : { sources: record.sources }),
    recordedAt: record.recordedAt,
    ...(record.sampledAt === undefined ? {} : { sampledAt: record.sampledAt }),
    sampling: record.sampling, text: record.text,
    ...(record.data === undefined ? {} : { data: record.data }),
    ...(record.space === undefined ? {} : { space: record.space }),
    ...(record.effect === undefined ? {} : { effect: record.effect }),
    ...(record.transition === undefined ? {} : { transition: record.transition }),
    media: record.media.map(({ id, mediaType }) => ({ id, mediaType })),
  })), hasMore: read.hasMore,
    ...(read.unchanged === undefined ? {} : { unchanged: read.unchanged }),
    ...(read.sequence === undefined ? {} : { sequence: read.sequence }),
    ...(read.nextAfter === undefined ? {} : { nextAfter: read.nextAfter }),
    ...(read.availability === undefined ? {} : { availability: read.availability }),
    ...(read.error === undefined ? {} : { error: read.error }),
  };
}

export async function observationBytes(observation: Observation): Promise<Buffer> {
  if (observation.data !== undefined) return Buffer.from(observation.data, "base64");
  if (!observation.path) throw new Error(`Observation ${observation.id} has no retained media`);
  return readFile(observation.path);
}
