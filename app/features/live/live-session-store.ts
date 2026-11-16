"use client";

import type { EventPoolSnapshot, PoolEvent } from "@ludens/protocol/event-pool";
import {
  ActivityChangesClient,
  type ActivityChangesPage,
  type ActivityResponse,
} from "@ludens/protocol/activity";
import type {
  ActivityRpcQuery,
  AppRpcParams,
  EventPoolMutateCommandDto,
  RuntimeControlCommandDto,
} from "@ludens/protocol/app-rpc";
import {
  isModelEffort,
  type ModelEffort,
  type ModelServiceTier,
} from "@/components/model-picker-dialog";
import {
  ACTIVITY_PAGE_SIZE,
  CONTINUOUS_STREAM_MAX_BLOCKS,
  acceptsScope,
  activityScopeParams,
  mergeMonotonicBlocks,
  newerBlock,
  sameScope,
  type ActivityBlock,
  type ActivityScope,
} from "@/features/live/activity-feed-model";
import { asRecord, cleanErrorMessage } from "@/features/live/shiori-segments";
import { readArchiveJson } from "@/lib/archive-client";
import type { LudensRpcCaller } from "@/lib/ludens-rpc";
import type { Call, DeviceContentionConflict, Observation, RunData, RunInfo } from "@/lib/types";

export type RuntimeControlCommand =
  | { action: "status" }
  | {
      action: "auto_on";
      message?: string;
      seconds?: number | null;
      runId?: string;
      expectedEpoch?: string | null;
      preempt?: boolean;
    }
  | { action: "auto_off"; runId?: string; expectedEpoch?: string | null; preempt?: boolean }
  | { action: "auto_budget"; seconds: number | null; runId?: string; expectedEpoch?: string | null; preempt?: boolean }
  | { action: "steer"; message: string; runId?: string; expectedEpoch?: string | null; preempt?: boolean }
  | { action: "consolidate"; seconds?: number; runId?: string; expectedEpoch?: string | null; preempt?: boolean }
  | {
      action: "set_model";
      model: string;
      serviceTier?: ModelServiceTier | null;
      effort?: ModelEffort | null;
      runId?: string;
      expectedEpoch?: string | null;
      preempt?: boolean;
    }
  | { action: "perception_inject"; enabled: boolean; runId?: string; preempt?: boolean }
  | { action: "perception_reload"; runId?: string; preempt?: boolean };

export type EventPoolCommand =
  | { action: "send"; text: string; title?: string; preempt?: boolean }
  | {
      action: "reply";
      replyTo: string;
      text: string;
      resumeAuto?: boolean;
      seconds?: number | null;
      preempt?: boolean;
    }
  | { action: "ack"; ids: string[]; preempt?: boolean };

export interface EventPoolReadPayload {
  ok?: boolean;
  snapshot: EventPoolSnapshot;
  hostOnline: boolean;
  coreOffline?: boolean;
  hostStatus?: Record<string, unknown>;
}

export interface EventPoolMutatePayload extends EventPoolReadPayload {
  createdEvent?: PoolEvent;
  resolvedOutbound?: PoolEvent;
  updatedEvents?: PoolEvent[];
  runId?: string;
  spawned?: boolean;
}

export interface ActivityChangesClientOptions {
  project: string;
  run?: string;
  epoch?: string;
  limit?: number;
}

export interface ChangesReaderLike {
  read(signal: AbortSignal): Promise<ActivityChangesPage>;
}

export interface LiveSessionTransport {
  createChangesClient: (options: ActivityChangesClientOptions) => ChangesReaderLike;
  requestActivity: (params: URLSearchParams, signal: AbortSignal) => Promise<ActivityResponse>;
  readRun: (params: AppRpcParams<"run/get">, signal?: AbortSignal) => Promise<RunData>;
  fetchEventPool: (project: string, workspace: string, signal?: AbortSignal) => Promise<EventPoolReadPayload>;
  mutateEventPool: (
    project: string,
    workspace: string,
    command: EventPoolCommand,
    options?: { spawnIfOffline?: boolean },
  ) => Promise<EventPoolMutatePayload>;
  sendRuntimeControl: (project: string, workspace: string, command: RuntimeControlCommand) => Promise<unknown>;
  updateWorkspaceShioriModel: (
    project: string,
    model: string,
    serviceTier: ModelServiceTier | null,
    effort: ModelEffort | null,
  ) => Promise<unknown>;
}

/** Structured error thrown by `runtime/control` and `eventPool/mutate` RPC calls. */
export class RuntimeControlError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly conflict?: DeviceContentionConflict;

  constructor(
    message: string,
    options?: { status?: number; code?: string; conflict?: DeviceContentionConflict },
  ) {
    super(message);
    this.name = "RuntimeControlError";
    this.status = options?.status ?? 500;
    this.code = options?.code;
    this.conflict = options?.conflict;
  }
}

function parseDeviceContentionConflict(raw: unknown): DeviceContentionConflict | undefined {
  const rec = asRecord(raw);
  if (!rec) return undefined;
  if (typeof rec.holderProjectId !== "string" || typeof rec.deviceKey !== "string" || typeof rec.holderMode !== "string") {
    return undefined;
  }
  const conflict: DeviceContentionConflict = {
    holderProjectId: rec.holderProjectId,
    deviceKey: rec.deviceKey,
    holderMode: rec.holderMode,
  };
  if (typeof rec.holderWorkspaceName === "string") conflict.holderWorkspaceName = rec.holderWorkspaceName;
  if (typeof rec.deviceLabel === "string") conflict.deviceLabel = rec.deviceLabel;
  if (rec.holderOrigin === "app" || rec.holderOrigin === "cli") conflict.holderOrigin = rec.holderOrigin;
  return conflict;
}

export function extractDeviceContention(cause: unknown): DeviceContentionConflict | null {
  if (!cause || typeof cause !== "object") return null;
  const rec = cause as { status?: unknown; code?: unknown; conflict?: unknown };
  if (rec.status !== 409 || rec.code !== "DEVICE_BUSY") return null;
  return parseDeviceContentionConflict(rec.conflict) ?? null;
}

export function isDeviceBusyError(cause: unknown): boolean {
  if (!cause || typeof cause !== "object") return false;
  const rec = cause as { status?: unknown; code?: unknown };
  return rec.status === 409 && rec.code === "DEVICE_BUSY";
}

export function isCoreOfflineError(cause: unknown): boolean {
  if ((cause instanceof RuntimeControlError || (cause && typeof cause === "object")) &&
    (cause as { code?: unknown }).code === "CORE_OFFLINE") {
    return true;
  }
  const msg = cause instanceof Error ? cause.message : String(cause);
  return (
    msg.includes("CORE_OFFLINE") ||
    msg.includes("未在线") ||
    msg.includes("HOST_OFFLINE") ||
    msg.includes("ENOENT") ||
    msg.includes("ECONNREFUSED")
  );
}

export function activityRpcParamsFromSearchParams(
  params: URLSearchParams,
): AppRpcParams<"activity/get"> {
  const project = params.get("project") ?? "";
  const run = params.get("run") || undefined;
  const epoch = params.get("epoch") || undefined;
  const query: ActivityRpcQuery = {};
  const mode = params.get("mode");
  if (mode === "changes" || mode === "history" || mode === "block") {
    query.mode = mode;
  }
  const cursor = params.get("cursor");
  if (cursor) query.cursor = cursor;
  const before = params.get("before");
  if (before) query.before = before;
  const kind = params.get("kind");
  if (kind) query.kind = kind;
  const q = params.get("q");
  if (q !== null && q !== "") query.q = q;
  const limitRaw = params.get("limit");
  if (limitRaw !== null && limitRaw !== "") {
    const limit = Number(limitRaw);
    if (Number.isFinite(limit)) query.limit = limit;
  }
  const id = params.get("id");
  if (id) query.id = id;
  return {
    project,
    ...(run ? { run } : {}),
    ...(epoch ? { epoch } : {}),
    ...(Object.keys(query).length > 0 ? { query } : {}),
  };
}

function createRpcLiveSessionTransport(getRpc: () => LudensRpcCaller | null): LiveSessionTransport {
  const requireRpc = (): LudensRpcCaller => {
    const rpc = getRpc();
    if (!rpc) {
      throw new RuntimeControlError("RPC client is unavailable", { status: 503 });
    }
    return rpc;
  };

  return {
    createChangesClient: options =>
      new ActivityChangesClient({
        project: options.project,
        run: options.run,
        epoch: options.epoch,
        limit: options.limit,
        reader: (request, signal) =>
          requireRpc().call(
            "activity/get",
            {
              project: request.project,
              ...(request.run ? { run: request.run } : {}),
              ...(request.epoch ? { epoch: request.epoch } : {}),
              query: {
                mode: "changes",
                ...(request.limit !== undefined ? { limit: request.limit } : {}),
                ...(request.cursor !== undefined ? { cursor: request.cursor } : {}),
              },
            },
            { signal },
          ),
      }),
    requestActivity: (params, signal) =>
      requireRpc().call("activity/get", activityRpcParamsFromSearchParams(params), { signal }),
    readRun: (params, signal) =>
      readArchiveJson<RunData>(
        s => requireRpc().call("run/get", params, { signal: s }) as unknown as Promise<RunData>,
        signal,
      ),
    fetchEventPool: (project, workspace, signal) =>
      requireRpc().call("eventPool/read", { project, workspace }, { signal }) as unknown as Promise<EventPoolReadPayload>,
    mutateEventPool: (project, workspace, command, options) =>
      requireRpc().call(
        "eventPool/mutate",
        {
          project,
          workspace,
          command: command as EventPoolMutateCommandDto,
          ...(options?.spawnIfOffline ? { spawnIfOffline: true } : {}),
          ...(command.preempt ? { preempt: true } : {}),
        },
      ) as unknown as Promise<EventPoolMutatePayload>,
    sendRuntimeControl: (project, workspace, command) =>
      requireRpc().call("runtime/control", {
        project,
        workspace,
        command: command as RuntimeControlCommandDto,
        ...("preempt" in command && command.preempt ? { preempt: true } : {}),
      }),
    updateWorkspaceShioriModel: (project, model, serviceTier, effort) =>
      requireRpc().call("workspaces/mutate", {
        action: "updateShiori",
        workspaceId: project,
        input: { model, serviceTier, effort },
      }),
  };
}

export interface OlderRunSlice {
  runId: string;
  data: RunData;
  blocks: ActivityBlock[];
  before: string | null;
  hasMore: boolean;
}

export interface OptimisticHostOverride {
  run: string;
  baseUpdatedAt: string;
  appliedAtMs: number;
  status: Record<string, unknown>;
}

export interface OptimisticModelOverride {
  baseServerModel: string | null;
  model: string;
  serviceTier: ModelServiceTier | null;
  effort: ModelEffort | null;
}

export interface LiveSessionSnapshot {
  project: string;
  targetRun: string;
  targetEpoch: string | undefined;
  resetRevision: number;
  loadedRevision: number | null;
  scope: ActivityScope | null;
  generation: string | null;
  snapshotCount: number;
  blocks: ActivityBlock[];
  before: string | null;
  historyFloorAt: string | null;
  hasMore: boolean;
  total: number;
  loading: boolean;
  loadingOlder: boolean;
  error: string;
  selected?: ActivityBlock;
  selectionReady: boolean;
  olderRuns: OlderRunSlice[];
  loadingOlderRun: boolean;
  olderRunError: string | null;
  poolSnapshot: EventPoolSnapshot | null;
  optimisticHost: OptimisticHostOverride | null;
  optimisticModel: OptimisticModelOverride | null;
  submitting: boolean;
  poolSubmitting: boolean;
  spawningCore: boolean;
  pendingContention: DeviceContentionConflict | null;
  preemptError: string | null;
  preemptSuccessSeq: number;
  lastSpawnedRun: { runId: string; seq: number } | null;
}

export function samePoolSnapshot(left: EventPoolSnapshot | null, right: EventPoolSnapshot | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (
    left.summary.pendingInbound !== right.summary.pendingInbound ||
    left.summary.pendingOutbound !== right.summary.pendingOutbound ||
    left.summary.latestSeq !== right.summary.latestSeq ||
    left.events.length !== right.events.length
  ) {
    return false;
  }
  for (let i = 0; i < left.events.length; i++) {
    const a = left.events[i]!;
    const b = right.events[i]!;
    if (
      a.id !== b.id ||
      a.seq !== b.seq ||
      a.status !== b.status ||
      a.handledAt !== b.handledAt ||
      a.handledBy !== b.handledBy ||
      a.text !== b.text ||
      a.title !== b.title ||
      a.pauseRequested !== b.pauseRequested
    ) {
      return false;
    }
  }
  return true;
}

function sameCallsArray(left: Call[], right: Call[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  if (left.length === 0) return true;
  const aFirst = left[0]!;
  const bFirst = right[0]!;
  const aLast = left[left.length - 1]!;
  const bLast = right[right.length - 1]!;
  return (
    aFirst.id === bFirst.id &&
    aLast.id === bLast.id &&
    aLast.at === bLast.at &&
    aLast.durationMs === bLast.durationMs &&
    aLast.outputTokens === bLast.outputTokens &&
    aLast.inputObservations.length === bLast.inputObservations.length
  );
}

function sameObservationsArray(left: Observation[], right: Observation[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  if (left.length === 0) return true;
  const aFirst = left[0]!;
  const bFirst = right[0]!;
  const aLast = left[left.length - 1]!;
  const bLast = right[right.length - 1]!;
  return (
    aFirst.id === bFirst.id &&
    aLast.id === bLast.id &&
    aLast.at === bLast.at &&
    aLast.mediaStorage === bLast.mediaStorage
  );
}

function sameCyclesArray(left: RunData["cycles"], right: RunData["cycles"]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    const a = left[i]!;
    const b = right[i]!;
    if (
      a.epoch !== b.epoch ||
      a.startedAt !== b.startedAt ||
      a.endedAt !== b.endedAt ||
      a.reason !== b.reason ||
      a.maxSeconds !== b.maxSeconds
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Stabilizes `run/get` snapshots against volatile `updatedAt` timestamps:
 * - Preserves `calls`, `observations`, and `cycles` array references when unchanged
 * - Returns `previous` verbatim when no meaningful field changed
 */
export function stabilizeRunData(previous: RunData | null, next: RunData): RunData {
  if (!previous) return next;
  if (previous === next) return previous;
  if (previous.project !== next.project || previous.run !== next.run) return next;

  const calls = sameCallsArray(previous.calls, next.calls) ? previous.calls : next.calls;
  const observations = sameObservationsArray(previous.observations, next.observations)
    ? previous.observations
    : next.observations;
  const cycles = sameCyclesArray(previous.cycles, next.cycles) ? previous.cycles : next.cycles;

  const sameLive = JSON.stringify(previous.live ?? null) === JSON.stringify(next.live ?? null);
  const sameControl = JSON.stringify(previous.lastControl ?? null) === JSON.stringify(next.lastControl ?? null);
  const sameSummary = JSON.stringify(previous.summary ?? null) === JSON.stringify(next.summary ?? null);
  const sameSelectedCall = (previous.selectedCall?.id ?? null) === (next.selectedCall?.id ?? null);

  if (
    calls === previous.calls &&
    observations === previous.observations &&
    cycles === previous.cycles &&
    sameLive &&
    sameControl &&
    sameSummary &&
    sameSelectedCall &&
    previous.selectedEpoch === next.selectedEpoch &&
    previous.controlAllowed === next.controlAllowed &&
    previous.paging.totalCalls === next.paging.totalCalls
  ) {
    return previous;
  }

  if (calls === next.calls && observations === next.observations && cycles === next.cycles) {
    return next;
  }

  return {
    ...next,
    calls,
    observations,
    cycles,
  };
}

function emptySessionSnapshot(project: string, resetRevision = 0): LiveSessionSnapshot {
  return {
    project,
    targetRun: "",
    targetEpoch: undefined,
    resetRevision,
    loadedRevision: null,
    scope: null,
    generation: null,
    snapshotCount: 0,
    blocks: [],
    before: null,
    historyFloorAt: null,
    hasMore: false,
    total: 0,
    loading: true,
    loadingOlder: false,
    error: "",
    selected: undefined,
    selectionReady: false,
    olderRuns: [],
    loadingOlderRun: false,
    olderRunError: null,
    poolSnapshot: null,
    optimisticHost: null,
    optimisticModel: null,
    submitting: false,
    poolSubmitting: false,
    spawningCore: false,
    pendingContention: null,
    preemptError: null,
    preemptSuccessSeq: 0,
    lastSpawnedRun: null,
  };
}

export class LiveSessionEngine {
  readonly project: string;
  private readonly transport: LiveSessionTransport;
  private rpc: LudensRpcCaller | null = null;
  private state: LiveSessionSnapshot;
  private readonly listeners = new Set<() => void>();

  private streamKey = "";
  private streamToken = 0;
  private streamEnabled = false;
  private streamRefresh = false;
  private selectedBlockId: string | undefined;
  private scopeChangedMessage = "Activity scope changed";
  private spawnInFlightCount = 0;
  private spawnSeq = 0;
  private pendingContentionRetry: (() => Promise<void>) | null = null;

  private changesController: AbortController | null = null;
  private changesInFlight = false;
  private changesPending = false;
  private changesRunFn: ((signal: AbortSignal) => Promise<boolean>) | null = null;
  private bootstrapController: AbortController | null = null;
  private earlierController: AbortController | null = null;
  private selectionController: AbortController | null = null;
  private olderRunController: AbortController | null = null;

  private readonly completedBeforeCursors = new Set<string>();
  private inFlightBeforeCursor: string | null = null;
  private readonly completedOlderBeforeCursors = new Set<string>();
  private inFlightOlderCursorKey: string | null = null;

  private workspacePath: string | null = null;
  private poolController: AbortController | null = null;
  private poolInFlight = false;
  private poolPending = false;
  private poolFetchFn: ((signal: AbortSignal) => Promise<void>) | null = null;
  private poolKey = "";
  private poolEnabled = false;
  private disposed = false;

  constructor(options: {
    project: string;
    rpc?: LudensRpcCaller | null;
    transport?: Partial<LiveSessionTransport>;
  }) {
    this.project = options.project;
    this.rpc = options.rpc ?? null;
    const rpcTransport = createRpcLiveSessionTransport(() => this.rpc);
    this.transport = { ...rpcTransport, ...options.transport };
    this.state = emptySessionSnapshot(options.project);
  }

  setRpc(rpc: LudensRpcCaller | null | undefined): void {
    const next = rpc ?? null;
    if (this.rpc === next) return;
    const hadRpc = this.rpc !== null;
    this.rpc = next;
    if (!hadRpc && next) {
      if (this.streamEnabled && this.changesRunFn) {
        this.triggerChangesCycle();
      }
      if (this.poolEnabled && this.poolFetchFn) {
        this.triggerPoolCycle();
      }
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): LiveSessionSnapshot => this.state;

  private update(mutator: (prev: LiveSessionSnapshot) => LiveSessionSnapshot): void {
    if (this.disposed) return;
    const next = mutator(this.state);
    if (next === this.state) return;
    this.state = next;
    for (const listener of this.listeners) {
      listener();
    }
  }

  setScopeChangedMessage(message: string): void {
    this.scopeChangedMessage = message;
  }

  /**
   * Synchronizes the unfiltered continuous activity stream for `(run, epoch)`:
   * - View switches (`enabled: false`) ONLY pause polling without wiping cached blocks or older runs!
   * - Cold `(run, epoch)` transitions fire `mode=changes` and `mode=history` IN PARALLEL.
   */
  syncStream(options: {
    run: string;
    epoch?: string;
    enabled: boolean;
    refresh: boolean;
    archiveRevision?: number;
    resetRevision?: number;
    selectedBlock?: string;
  }): void {
    if (this.disposed) return;
    const {
      run,
      epoch,
      enabled,
      refresh,
      archiveRevision = 0,
      resetRevision = 0,
    } = options;

    if (!run) {
      this.teardownStreamRequests();
      this.streamKey = "";
      this.inFlightOlderCursorKey = null;
      if (this.state.targetRun !== "" || this.state.loading || this.state.loadingOlderRun) {
        this.update(prev => ({
          ...prev,
          targetRun: "",
          targetEpoch: epoch,
          resetRevision,
          blocks: [],
          loading: false,
          loadingOlder: false,
          loadingOlderRun: false,
          error: "",
        }));
      }
      return;
    }

    const nextKey = `${run}\0${epoch ?? ""}\0${archiveRevision}\0${resetRevision}`;
    const targetChanged = nextKey !== this.streamKey;
    const runChanged = this.state.targetRun !== "" && this.state.targetRun !== run;
    const wasEnabled = this.streamEnabled;
    this.streamEnabled = enabled;
    this.streamRefresh = refresh;

    if (!targetChanged) {
      if (!enabled) {
        this.changesController?.abort();
        this.changesController = null;
        this.changesPending = false;
      } else {
        if (!this.changesRunFn) {
          this.startStreamForCurrentTarget(run, epoch, refresh, resetRevision);
        } else if (!wasEnabled && refresh) {
          this.triggerChangesCycle();
        }
      }
      this.syncSelectedBlock(options.selectedBlock);
      return;
    }

    this.streamKey = nextKey;
    this.streamToken += 1;
    this.teardownStreamRequests();
    this.completedBeforeCursors.clear();
    this.inFlightBeforeCursor = null;
    this.inFlightOlderCursorKey = null;
    if (runChanged) {
      this.completedOlderBeforeCursors.clear();
    }

    this.update(prev => ({
      ...prev,
      targetRun: run,
      targetEpoch: epoch,
      resetRevision,
      loadedRevision: null,
      scope: null,
      generation: null,
      blocks: [],
      before: null,
      historyFloorAt: null,
      hasMore: false,
      total: 0,
      loading: true,
      loadingOlder: false,
      loadingOlderRun: false,
      error: "",
      selected: undefined,
      selectionReady: false,
      ...(runChanged
        ? {
            olderRuns: [],
            olderRunError: null,
            optimisticHost: null,
          }
        : {}),
    }));

    if (enabled) {
      this.startStreamForCurrentTarget(run, epoch, refresh, resetRevision);
    }
    this.syncSelectedBlock(options.selectedBlock);
  }

  private startStreamForCurrentTarget(
    run: string,
    epoch: string | undefined,
    refresh: boolean,
    resetRevision: number,
  ): void {
    const token = this.streamToken;
    const reader = this.transport.createChangesClient({
      project: this.project,
      run,
      epoch,
      limit: ACTIVITY_PAGE_SIZE,
    });

    let bootstrapResolved = false;

    const runBootstrapHistory = (expectedGeneration?: string) => {
      this.bootstrapController?.abort();
      const controller = new AbortController();
      this.bootstrapController = controller;

      const params = new URLSearchParams({
        project: this.project,
        run,
        epoch: epoch ?? "all",
        mode: "history",
        kind: "all",
        q: "",
        limit: String(ACTIVITY_PAGE_SIZE),
      });

      void this.transport
        .requestActivity(params, controller.signal)
        .then(result => {
          if (controller.signal.aborted || token !== this.streamToken) return;
          if (!acceptsScope(result.scope, this.project, run, epoch)) {
            this.update(prev => ({ ...prev, loading: false, error: this.scopeChangedMessage }));
            return;
          }
          if (expectedGeneration && result.projection.generation !== expectedGeneration) {
            return;
          }
          if (this.state.generation && this.state.generation !== result.projection.generation) {
            runBootstrapHistory(this.state.generation);
            return;
          }
          bootstrapResolved = true;
          this.update(prev => {
            const { blocks } = mergeMonotonicBlocks(result.blocks, prev.blocks, {
              maxBlocks: CONTINUOUS_STREAM_MAX_BLOCKS,
            });
            return {
              ...prev,
              scope: prev.scope ?? result.scope,
              generation: prev.generation ?? result.projection.generation,
              blocks,
              before: prev.before !== null && prev.blocks.length > blocks.length ? prev.before : (result.before ?? null),
              historyFloorAt: result.blocks[0]?.at ?? prev.historyFloorAt,
              hasMore: result.hasMore,
              total: result.total ?? prev.total,
              loading: false,
              loadedRevision: resetRevision,
              error: "",
            };
          });
          if (this.selectedBlockId) {
            this.fetchSelectedBlock(this.selectedBlockId);
          }
        })
        .catch(error => {
          if (controller.signal.aborted || token !== this.streamToken) return;
          bootstrapResolved = true;
          this.update(prev => ({ ...prev, loading: false, error: String(error) }));
        });
    };

    this.changesRunFn = async signal => {
      let more = false;
      try {
        const result = await reader.read(signal);
        if (signal.aborted || token !== this.streamToken) return false;
        more = result.hasMore;

        const prev = this.state;
        const generationChanged =
          prev.generation !== null && prev.generation !== result.projection.generation;
        const scopeChanged = prev.scope !== null && !sameScope(prev.scope, result.scope);
        const hardReset = generationChanged || scopeChanged;

        if (hardReset) {
          this.earlierController?.abort();
          this.earlierController = null;
          this.selectionController?.abort();
          this.selectionController = null;
          this.completedBeforeCursors.clear();
          this.inFlightBeforeCursor = null;
        }

        const baseBlocks = hardReset ? [] : prev.blocks;
        const merged = mergeMonotonicBlocks(baseBlocks, result.blocks, {
          maxBlocks: CONTINUOUS_STREAM_MAX_BLOCKS,
        });

        const nextSelected = this.selectedBlockId
          ? result.blocks
              .filter(block => block.id === this.selectedBlockId)
              .reduce<ActivityBlock | undefined>(
                (acc, next) => newerBlock(acc, next),
                hardReset ? undefined : prev.selected,
              )
          : prev.selected;

        const scopeInitial = prev.scope === null || prev.generation === null;
        if (hardReset || scopeInitial || merged.changed || nextSelected !== prev.selected || prev.error !== "") {
          this.update(current => ({
            ...current,
            scope: result.scope,
            generation: result.projection.generation,
            snapshotCount: current.snapshotCount + (hardReset || scopeInitial ? 1 : 0),
            blocks: merged.blocks,
            ...(hardReset
              ? {
                  before: null,
                  historyFloorAt: null,
                  hasMore: false,
                  loading: true,
                  loadingOlder: false,
                  selectionReady: false,
                }
              : {}),
            selected: nextSelected,
            error: "",
          }));
        }

        result.acknowledge();

        if (hardReset) {
          runBootstrapHistory(result.projection.generation);
        } else if (scopeInitial && this.selectedBlockId) {
          this.fetchSelectedBlock(this.selectedBlockId);
        }
      } catch (error) {
        if (!signal.aborted && token === this.streamToken) {
          this.update(prev => ({
            ...prev,
            loading: bootstrapResolved ? false : prev.loading && !bootstrapResolved ? false : prev.loading,
            error: String(error),
          }));
        }
        return false;
      }
      return more;
    };

    // Parallel bootstrap: launch live changes stream AND initial history page concurrently at t=0.
    runBootstrapHistory();
    this.triggerChangesCycle();
  }

  private triggerChangesCycle(): void {
    if (this.disposed || !this.streamEnabled || !this.changesRunFn) return;
    if (this.changesInFlight) {
      this.changesPending = true;
      return;
    }

    const activeToken = this.streamToken;
    this.changesInFlight = true;
    void (async () => {
      try {
        while (!this.disposed && this.streamEnabled && activeToken === this.streamToken && this.changesRunFn) {
          this.changesPending = false;
          const controller = new AbortController();
          this.changesController = controller;
          const hasMore = await this.changesRunFn(controller.signal);
          if (controller.signal.aborted || activeToken !== this.streamToken) break;
          if (!hasMore && !this.changesPending) break;
        }
      } finally {
        this.changesInFlight = false;
        this.changesController = null;
      }
    })();
  }

  private triggerPoolCycle(): void {
    if (this.disposed || !this.poolEnabled || !this.poolFetchFn) return;
    if (this.poolInFlight) {
      this.poolPending = true;
      return;
    }

    const activePoolKey = this.poolKey;
    this.poolInFlight = true;
    void (async () => {
      try {
        while (!this.disposed && this.poolEnabled && activePoolKey === this.poolKey && this.poolFetchFn) {
          this.poolPending = false;
          const controller = new AbortController();
          this.poolController = controller;
          await this.poolFetchFn(controller.signal);
          if (controller.signal.aborted || activePoolKey !== this.poolKey) break;
          if (!this.poolPending) break;
        }
      } finally {
        this.poolInFlight = false;
        this.poolController = null;
      }
    })();
  }

  nudgeChanges(): void {
    if (this.streamRefresh && this.streamEnabled) {
      this.triggerChangesCycle();
    }
  }

  nudgeEventPool(): void {
    if (this.poolEnabled) {
      this.triggerPoolCycle();
    }
  }

  private syncSelectedBlock(selectedBlock: string | undefined): void {
    if (selectedBlock === this.selectedBlockId) return;
    this.selectedBlockId = selectedBlock;
    this.selectionController?.abort();
    this.selectionController = null;
    if (!selectedBlock) {
      if (this.state.selected !== undefined || this.state.selectionReady) {
        this.update(prev => ({ ...prev, selected: undefined, selectionReady: false }));
      }
      return;
    }
    this.update(prev => ({ ...prev, selected: undefined, selectionReady: false }));
    if (this.streamEnabled && this.state.scope && this.state.generation) {
      this.fetchSelectedBlock(selectedBlock);
    }
  }

  private fetchSelectedBlock(blockId: string): void {
    const { scope, generation, targetRun, targetEpoch } = this.state;
    if (!scope || !generation || !acceptsScope(scope, this.project, targetRun, targetEpoch)) return;
    const token = this.streamToken;
    this.selectionController?.abort();
    const controller = new AbortController();
    this.selectionController = controller;
    const params = activityScopeParams(scope);
    params.set("mode", "block");
    params.set("id", blockId);

    void this.transport
      .requestActivity(params, controller.signal)
      .then(result => {
        if (
          controller.signal.aborted ||
          token !== this.streamToken ||
          this.selectedBlockId !== blockId ||
          !sameScope(this.state.scope, scope) ||
          this.state.generation !== generation
        ) {
          return;
        }
        if (!sameScope(result.scope, scope) || result.projection.generation !== generation) {
          this.update(prev => ({ ...prev, selectionReady: true, error: this.scopeChangedMessage }));
          return;
        }
        this.update(prev => ({
          ...prev,
          selected: result.blocks[0]
            ? newerBlock(
                prev.blocks.find(b => b.id === blockId) ??
                  (prev.selected?.id === blockId ? prev.selected : undefined),
                result.blocks[0],
              )
            : undefined,
          selectionReady: true,
        }));
      })
      .catch(error => {
        if (
          controller.signal.aborted ||
          token !== this.streamToken ||
          this.selectedBlockId !== blockId ||
          !sameScope(this.state.scope, scope) ||
          this.state.generation !== generation
        ) {
          return;
        }
        this.update(prev => ({ ...prev, selectionReady: true, error: String(error) }));
      });
  }

  /**
   * Monotonically prepends the next earlier page of the current run.
   * Deduplicates by `before` cursor so repeated scroll events NEVER issue duplicate network reads.
   */
  loadEarlierCurrentRun = async (): Promise<void> => {
    const snap = this.state;
    const cursor = snap.before;
    if (!snap.scope || !cursor || snap.loadingOlder) return;
    if (this.inFlightBeforeCursor === cursor || this.completedBeforeCursors.has(cursor)) return;
    if (snap.blocks.length >= CONTINUOUS_STREAM_MAX_BLOCKS) {
      this.update(prev => ({ ...prev, hasMore: false, before: null }));
      return;
    }

    const token = this.streamToken;
    const expectedScope = snap.scope;
    const expectedGeneration = snap.generation;
    this.inFlightBeforeCursor = cursor;
    this.earlierController?.abort();
    const controller = new AbortController();
    this.earlierController = controller;

    this.update(prev => ({ ...prev, loadingOlder: true, error: "" }));
    const params = activityScopeParams(expectedScope);
    params.set("mode", "history");
    params.set("kind", "all");
    params.set("q", "");
    params.set("before", cursor);
    params.set("limit", String(ACTIVITY_PAGE_SIZE));

    try {
      const result = await this.transport.requestActivity(params, controller.signal);
      if (
        controller.signal.aborted ||
        token !== this.streamToken ||
        !sameScope(this.state.scope, expectedScope) ||
        this.state.generation !== expectedGeneration
      ) {
        return;
      }
      if (!sameScope(result.scope, expectedScope) || result.projection.generation !== expectedGeneration) {
        this.update(prev => ({ ...prev, loadingOlder: false, error: this.scopeChangedMessage }));
        return;
      }
      this.completedBeforeCursors.add(cursor);
      this.update(prev => {
        const merged = mergeMonotonicBlocks(prev.blocks, result.blocks, {
          maxBlocks: CONTINUOUS_STREAM_MAX_BLOCKS,
        });
        const nextBefore = result.before ?? null;
        const nextHasMore = Boolean(result.hasMore && nextBefore && !this.completedBeforeCursors.has(nextBefore));
        return {
          ...prev,
          blocks: merged.blocks,
          before: nextHasMore ? nextBefore : null,
          historyFloorAt: result.blocks[0]?.at ?? prev.historyFloorAt,
          hasMore: nextHasMore,
          total: result.total ?? prev.total,
          loadingOlder: false,
        };
      });
    } catch (error) {
      if (
        controller.signal.aborted ||
        token !== this.streamToken ||
        !sameScope(this.state.scope, expectedScope) ||
        this.state.generation !== expectedGeneration
      ) {
        return;
      }
      this.update(prev => ({ ...prev, loadingOlder: false, error: String(error) }));
    } finally {
      if (this.inFlightBeforeCursor === cursor) {
        this.inFlightBeforeCursor = null;
      }
      if (this.earlierController === controller) {
        this.earlierController = null;
      }
    }
  };

  /**
   * Monotonically prepends earlier blocks of an already-loaded historical run (`olderRuns`).
   */
  loadEarlierBlocksOfOlderRun = async (
    targetRunId: string,
    beforeCursor: string,
    fallbackErrorMessage = "Failed to load older run",
  ): Promise<void> => {
    if (this.state.loadingOlderRun || !this.project || !beforeCursor) return;
    const cursorKey = `${targetRunId}\0${beforeCursor}`;
    if (this.inFlightOlderCursorKey === cursorKey || this.completedOlderBeforeCursors.has(cursorKey)) {
      return;
    }

    const token = this.streamToken;
    this.inFlightOlderCursorKey = cursorKey;
    this.olderRunController?.abort();
    const controller = new AbortController();
    this.olderRunController = controller;
    this.update(prev => ({ ...prev, loadingOlderRun: true, olderRunError: null }));

    try {
      const actParams = new URLSearchParams({
        project: this.project,
        run: targetRunId,
        epoch: "all",
        mode: "history",
        kind: "all",
        before: beforeCursor,
        limit: "250",
      });
      const actPayload = await this.transport.requestActivity(actParams, controller.signal);
      if (controller.signal.aborted || token !== this.streamToken) return;

      const earlierBlocks = Array.isArray(actPayload.blocks) ? actPayload.blocks : [];
      this.completedOlderBeforeCursors.add(cursorKey);
      this.update(prev => ({
        ...prev,
        loadingOlderRun: false,
        olderRuns: prev.olderRuns.map(entry => {
          if (entry.runId !== targetRunId) return entry;
          const merged = mergeMonotonicBlocks(entry.blocks, earlierBlocks, {
            maxBlocks: CONTINUOUS_STREAM_MAX_BLOCKS,
          });
          const nextBefore = typeof actPayload.before === "string" ? actPayload.before : null;
          const nextKey = nextBefore ? `${targetRunId}\0${nextBefore}` : "";
          const hasMore = Boolean(
            actPayload.hasMore &&
              nextBefore &&
              merged.changed &&
              !this.completedOlderBeforeCursors.has(nextKey),
          );
          return {
            ...entry,
            blocks: merged.blocks,
            before: hasMore ? nextBefore : null,
            hasMore,
          };
        }),
      }));
    } catch (cause) {
      if (controller.signal.aborted || token !== this.streamToken) return;
      this.update(prev => ({
        ...prev,
        loadingOlderRun: false,
        olderRunError: cause instanceof Error ? cleanErrorMessage(cause.message) : fallbackErrorMessage,
      }));
    } finally {
      if (this.inFlightOlderCursorKey === cursorKey) {
        this.inFlightOlderCursorKey = null;
      }
      if (this.olderRunController === controller) {
        this.olderRunController = null;
      }
    }
  };

  /**
   * Loads one or more preceding historical runs (prepend-only, chronological oldest-first).
   */
  loadOlderRuns = async (options: {
    currentRunId: string;
    runs: RunInfo[];
    upToRunId?: string;
    evidence?: { targetRunId: string; call?: string; image?: string };
    fallbackErrorMessage?: string;
  }): Promise<boolean> => {
    const { currentRunId, runs, upToRunId, evidence, fallbackErrorMessage = "Failed to load older run" } = options;
    if (this.state.loadingOlderRun || !this.project) return false;

    const existingIds = new Set([currentRunId, ...this.state.olderRuns.map(r => r.runId)]);
    const earliestLoadedRunId = this.state.olderRuns[0]?.runId ?? currentRunId;
    const earliestIdx = runs.findIndex(r => r.id === earliestLoadedRunId);
    const nextOlderRun =
      earliestIdx >= 0 && earliestIdx + 1 < runs.length ? runs[earliestIdx + 1] : null;

    const toFetch: string[] = [];
    if (upToRunId) {
      const endIdx = runs.findIndex(r => r.id === upToRunId);
      if (earliestIdx >= 0 && endIdx > earliestIdx) {
        for (let i = earliestIdx + 1; i <= endIdx; i++) {
          if (!existingIds.has(runs[i]!.id)) toFetch.push(runs[i]!.id);
        }
      } else if (!existingIds.has(upToRunId)) {
        toFetch.push(upToRunId);
      }
    } else if (nextOlderRun && !existingIds.has(nextOlderRun.id)) {
      toFetch.push(nextOlderRun.id);
    }

    if (toFetch.length === 0) return false;

    const token = this.streamToken;
    this.olderRunController?.abort();
    const controller = new AbortController();
    this.olderRunController = controller;
    this.update(prev => ({ ...prev, loadingOlderRun: true, olderRunError: null }));

    try {
      const fetched = await Promise.all(
        toFetch.map(async targetRunId => {
          const page =
            evidence && evidence.targetRunId === targetRunId
              ? {
                  ...(evidence.call ? { call: evidence.call } : {}),
                  ...(evidence.image ? { image: evidence.image } : {}),
                }
              : undefined;
          const actParams = new URLSearchParams({
            project: this.project,
            run: targetRunId,
            epoch: "all",
            mode: "history",
            kind: "all",
            limit: "300",
          });
          const [runPayload, actPayload] = await Promise.all([
            this.transport.readRun(
              {
                project: this.project,
                run: targetRunId,
                epoch: "all",
                ...(page && Object.keys(page).length > 0 ? { page } : {}),
              },
              controller.signal,
            ),
            this.transport.requestActivity(actParams, controller.signal),
          ]);
          const rawBlocks = Array.isArray(actPayload.blocks) ? actPayload.blocks : [];
          const { blocks } = mergeMonotonicBlocks([], rawBlocks, { maxBlocks: CONTINUOUS_STREAM_MAX_BLOCKS });
          const before = typeof actPayload.before === "string" ? actPayload.before : null;
          return {
            runId: targetRunId,
            data: runPayload,
            blocks,
            before,
            hasMore: Boolean(actPayload.hasMore && before),
          } satisfies OlderRunSlice;
        }),
      );

      if (controller.signal.aborted || token !== this.streamToken) return false;
      const chronologicalFetched = [...fetched].reverse();
      this.update(prev => {
        const merged = [...chronologicalFetched, ...prev.olderRuns];
        const seen = new Set<string>();
        const deduped = merged.filter(item => {
          if (seen.has(item.runId)) return false;
          seen.add(item.runId);
          return true;
        });
        return {
          ...prev,
          loadingOlderRun: false,
          olderRuns: deduped,
        };
      });
      return true;
    } catch (cause) {
      if (controller.signal.aborted || token !== this.streamToken) return false;
      this.update(prev => ({
        ...prev,
        loadingOlderRun: false,
        olderRunError: cause instanceof Error ? cleanErrorMessage(cause.message) : fallbackErrorMessage,
      }));
      return false;
    } finally {
      if (this.olderRunController === controller) {
        this.olderRunController = null;
      }
    }
  };

  clearOlderRunError = (): void => {
    if (this.state.olderRunError !== null) {
      this.update(prev => ({ ...prev, olderRunError: null }));
    }
  };

  /**
   * Coordinates Event Pool updates driven by RPC push notifications and explicit nudges,
   * decoupled from volatile `data.updatedAt`, with structural snapshot deduplication.
   */
  syncEventPool(options: {
    workspace: string | null;
    isLiveRun: boolean;
    enabled: boolean;
    refresh: boolean;
    liveLatestSeq?: number;
  }): void {
    if (this.disposed) return;
    const { workspace, isLiveRun, enabled, liveLatestSeq } = options;
    this.workspacePath = workspace;

    const active = Boolean(isLiveRun && enabled && this.project && workspace);
    const nextPoolKey = workspace ? `${this.project}\0${workspace}` : "";

    if (!active || !workspace) {
      this.poolEnabled = false;
      this.poolController?.abort();
      this.poolController = null;
      this.poolPending = false;
      return;
    }

    const keyChanged = nextPoolKey !== this.poolKey;
    const becameActive = !this.poolEnabled;
    this.poolEnabled = true;

    if (keyChanged || !this.poolFetchFn) {
      this.poolController?.abort();
      this.poolController = null;
      this.poolPending = false;
      this.poolKey = nextPoolKey;
      const targetWorkspace = workspace;
      this.poolFetchFn = async signal => {
        try {
          const payload = await this.transport.fetchEventPool(this.project, targetWorkspace, signal);
          if (!signal.aborted && this.poolKey === nextPoolKey) {
            this.update(prev =>
              samePoolSnapshot(prev.poolSnapshot, payload.snapshot)
                ? prev
                : { ...prev, poolSnapshot: payload.snapshot },
            );
          }
        } catch {
          // Non-fatal background refresh
        }
      };
      this.triggerPoolCycle();
      return;
    }

    if (becameActive) {
      this.triggerPoolCycle();
      return;
    }

    if (
      typeof liveLatestSeq === "number" &&
      liveLatestSeq > (this.state.poolSnapshot?.summary.latestSeq ?? -1)
    ) {
      this.triggerPoolCycle();
    }
  }

  /** Nudges immediate local reconciliation of activity deltas & event pool without resetting state. */
  reconcileNow(onUpdated?: () => void): void {
    this.triggerChangesCycle();
    onUpdated?.();
  }

  private recordOptimisticHost(
    run: string,
    baseUpdatedAt: string,
    status: Record<string, unknown> | null | undefined,
    baseServerModel?: string | null,
  ): Record<string, unknown> | null {
    if (!status) return null;
    const appliedAtMs = Date.now();
    this.update(prev => {
      let optimisticModel = prev.optimisticModel;
      if (typeof status.model === "string" && status.model.trim()) {
        optimisticModel = {
          baseServerModel: baseServerModel ?? prev.optimisticModel?.baseServerModel ?? null,
          model: status.model.trim(),
          serviceTier:
            status.serviceTier === "priority" || status.serviceTier === "ultrafast"
              ? status.serviceTier
              : null,
          effort: isModelEffort(status.effort) ? status.effort : null,
        };
      }
      return {
        ...prev,
        optimisticHost: { run, baseUpdatedAt, appliedAtMs, status },
        optimisticModel,
      };
    });
    return status;
  }

  private extractReturnedStatus(payload: unknown): Record<string, unknown> | null {
    const record = asRecord(payload);
    return asRecord(record?.status) ?? (typeof record?.mode === "string" ? record : null);
  }

  private beginSpawn(): void {
    this.spawnInFlightCount += 1;
    if (this.spawnInFlightCount === 1) {
      this.update(prev => (prev.spawningCore ? prev : { ...prev, spawningCore: true }));
    }
  }

  private endSpawn(): void {
    this.spawnInFlightCount = Math.max(0, this.spawnInFlightCount - 1);
    if (this.spawnInFlightCount === 0) {
      this.update(prev => (prev.spawningCore ? { ...prev, spawningCore: false } : prev));
    }
  }

  private recordSpawnedRun(payload: unknown): string | null {
    const rec = asRecord(payload);
    const statusRec = asRecord(rec?.status);
    const spawned = Boolean(rec?.spawned ?? statusRec?.spawned);
    const rawRunId =
      typeof rec?.runId === "string" && rec.runId.trim()
        ? rec.runId.trim()
        : typeof statusRec?.runId === "string" && statusRec.runId.trim()
          ? statusRec.runId.trim()
          : "";
    if (!spawned || !rawRunId) {
      return rawRunId || null;
    }
    this.spawnSeq += 1;
    const seq = this.spawnSeq;
    this.update(prev => ({
      ...prev,
      lastSpawnedRun: { runId: rawRunId, seq },
    }));
    return rawRunId;
  }

  private recordContention(cause: unknown, retry: () => Promise<void>): boolean {
    const conflict = extractDeviceContention(cause);
    if (!conflict) return false;
    this.pendingContentionRetry = retry;
    this.update(prev => ({
      ...prev,
      pendingContention: conflict,
      preemptError: null,
    }));
    return true;
  }

  async confirmPreempt(): Promise<boolean> {
    const retry = this.pendingContentionRetry;
    if (!retry) return false;
    this.beginSpawn();
    this.update(prev => ({ ...prev, preemptError: null }));
    try {
      await retry();
      this.pendingContentionRetry = null;
      this.update(prev => ({
        ...prev,
        pendingContention: null,
        preemptError: null,
        preemptSuccessSeq: prev.preemptSuccessSeq + 1,
      }));
      return true;
    } catch (cause) {
      if (this.recordContention(cause, retry)) {
        return false;
      }
      const msg = cause instanceof Error ? cause.message : String(cause);
      this.update(prev => ({ ...prev, preemptError: msg }));
      return false;
    } finally {
      this.endSpawn();
    }
  }

  dismissContention(): void {
    this.pendingContentionRetry = null;
    this.update(prev => ({
      ...prev,
      pendingContention: null,
      preemptError: null,
    }));
  }

  // ── Unified Mutations ──

  async runRuntimeCommand(options: {
    workspace: string;
    run: string;
    baseUpdatedAt: string;
    baseServerModel?: string | null;
    command: RuntimeControlCommand;
    mightSpawnCore?: boolean;
    onUpdated?: () => void;
  }): Promise<{ payload: unknown; status: Record<string, unknown> | null }> {
    const { workspace, run, baseUpdatedAt, baseServerModel, command, mightSpawnCore = false, onUpdated } = options;
    const tracksSpawn = mightSpawnCore || Boolean("preempt" in command && command.preempt);
    if (tracksSpawn) this.beginSpawn();
    this.update(prev => ({ ...prev, submitting: true }));
    try {
      const payload = await this.transport.sendRuntimeControl(this.project, workspace, command);
      const spawnedRunId = this.recordSpawnedRun(payload);
      const status = this.recordOptimisticHost(
        spawnedRunId || run,
        baseUpdatedAt,
        this.extractReturnedStatus(payload),
        baseServerModel,
      );
      this.reconcileNow(onUpdated);
      return { payload, status };
    } catch (cause) {
      if (command.action !== "status") {
        this.recordContention(cause, async () => {
          await this.runRuntimeCommand({
            ...options,
            mightSpawnCore: true,
            command: { ...command, preempt: true },
          });
        });
      }
      throw cause;
    } finally {
      this.update(prev => ({ ...prev, submitting: false }));
      if (tracksSpawn) this.endSpawn();
    }
  }

  async steerOrStartAuto(options: {
    workspace: string;
    run: string;
    baseUpdatedAt: string;
    baseServerModel?: string | null;
    expectedEpoch?: string | null;
    message: string;
    fallbackSeconds: number | null;
    mightSpawnCore?: boolean;
    preempt?: boolean;
    onUpdated?: () => void;
  }): Promise<{ fellBackToAutoOn: boolean; status: Record<string, unknown> | null }> {
    const {
      workspace,
      run,
      baseUpdatedAt,
      baseServerModel,
      expectedEpoch,
      message,
      fallbackSeconds,
      mightSpawnCore = false,
      preempt = false,
      onUpdated,
    } = options;
    const tracksSpawn = mightSpawnCore || preempt;
    if (tracksSpawn) this.beginSpawn();
    this.update(prev => ({ ...prev, submitting: true }));
    let fellBackToAutoOn = false;
    try {
      let payload: unknown;
      try {
        payload = await this.transport.sendRuntimeControl(this.project, workspace, {
          action: "steer",
          message,
          ...(run ? { runId: run } : {}),
          expectedEpoch: expectedEpoch ?? undefined,
          ...(preempt ? { preempt: true } : {}),
        });
      } catch (steerErr) {
        const msg = steerErr instanceof Error ? steerErr.message : String(steerErr);
        if (msg.includes("Auto loop is not active") || isCoreOfflineError(steerErr)) {
          fellBackToAutoOn = true;
          payload = await this.transport.sendRuntimeControl(this.project, workspace, {
            action: "auto_on",
            ...(message ? { message } : {}),
            seconds: fallbackSeconds,
            ...(run ? { runId: run } : {}),
            expectedEpoch: expectedEpoch ?? null,
            ...(preempt ? { preempt: true } : {}),
          });
        } else {
          throw steerErr;
        }
      }
      const spawnedRunId = this.recordSpawnedRun(payload);
      const status = this.recordOptimisticHost(
        spawnedRunId || run,
        baseUpdatedAt,
        this.extractReturnedStatus(payload),
        baseServerModel,
      );
      this.reconcileNow(onUpdated);
      return { fellBackToAutoOn, status };
    } catch (cause) {
      this.recordContention(cause, async () => {
        if (fellBackToAutoOn) {
          await this.runRuntimeCommand({
            workspace,
            run,
            baseUpdatedAt,
            baseServerModel,
            mightSpawnCore: true,
            onUpdated,
            command: {
              action: "auto_on",
              ...(message ? { message } : {}),
              seconds: fallbackSeconds,
              ...(run ? { runId: run } : {}),
              expectedEpoch: expectedEpoch ?? null,
              preempt: true,
            },
          });
        } else {
          await this.steerOrStartAuto({
            ...options,
            mightSpawnCore: true,
            preempt: true,
          });
        }
      });
      throw cause;
    } finally {
      this.update(prev => ({ ...prev, submitting: false }));
      if (tracksSpawn) this.endSpawn();
    }
  }

  async setAutoStopTimer(options: {
    workspace: string;
    run: string;
    baseUpdatedAt: string;
    expectedEpoch?: string | null;
    seconds: number | null;
    onUpdated?: () => void;
  }): Promise<void> {
    const { workspace, run, baseUpdatedAt, expectedEpoch, seconds, onUpdated } = options;
    const payload = await this.transport.sendRuntimeControl(this.project, workspace, {
      action: "auto_budget",
      seconds,
      runId: run,
      expectedEpoch: expectedEpoch ?? undefined,
    });
    this.recordOptimisticHost(run, baseUpdatedAt, this.extractReturnedStatus(payload));
    this.reconcileNow(onUpdated);
  }

  async extendAutoStopTimer(options: {
    workspace: string;
    run: string;
    baseUpdatedAt: string;
    expectedEpoch?: string | null;
    deltaSeconds: number;
    fallbackRemainingSeconds: number;
    onUpdated?: () => void;
  }): Promise<void> {
    const { workspace, run, baseUpdatedAt, expectedEpoch, deltaSeconds, fallbackRemainingSeconds, onUpdated } =
      options;
    let baseRemaining = fallbackRemainingSeconds;
    try {
      const fresh = await this.transport.sendRuntimeControl(this.project, workspace, { action: "status" });
      const freshStatus = this.extractReturnedStatus(fresh);
      if (typeof freshStatus?.remainingSeconds === "number") {
        baseRemaining = Math.max(0, freshStatus.remainingSeconds);
      }
    } catch {
      // Fall back to local remaining estimate if transient status read fails
    }
    await this.setAutoStopTimer({
      workspace,
      run,
      baseUpdatedAt,
      expectedEpoch,
      seconds: Math.max(60, Math.round(baseRemaining + deltaSeconds)),
      onUpdated,
    });
  }

  async switchModel(options: {
    workspace: string | null;
    run: string;
    baseUpdatedAt: string;
    baseServerModel: string | null;
    expectedEpoch?: string | null;
    hostOnline: boolean;
    model: string;
    serviceTier: ModelServiceTier | null;
    effort: ModelEffort | null;
    onUpdated?: () => void;
  }): Promise<{ persistedOffline: boolean }> {
    const {
      workspace,
      run,
      baseUpdatedAt,
      baseServerModel,
      expectedEpoch,
      hostOnline,
      model,
      serviceTier,
      effort,
      onUpdated,
    } = options;
    const trimmed = model.trim();
    let persistedOffline = !hostOnline;
    let appliedServiceTier = serviceTier;
    let appliedEffort = effort;

    // Optimistic immediate model badge update
    const priorModel = this.state.optimisticModel;
    this.update(prev => ({
      ...prev,
      optimisticModel: {
        baseServerModel,
        model: trimmed,
        serviceTier,
        effort,
      },
    }));

    try {
      if (workspace) {
        try {
          const payload = await this.transport.sendRuntimeControl(this.project, workspace, {
            action: "set_model",
            model: trimmed,
            serviceTier,
            effort,
            runId: run,
            expectedEpoch: expectedEpoch ?? null,
          });
          const status = this.recordOptimisticHost(
            run,
            baseUpdatedAt,
            this.extractReturnedStatus(payload),
            baseServerModel,
          );
          if (status && "serviceTier" in status) {
            appliedServiceTier =
              status.serviceTier === "priority" || status.serviceTier === "ultrafast"
                ? status.serviceTier
                : null;
          }
          if (status && "effort" in status) {
            appliedEffort = isModelEffort(status.effort) ? status.effort : null;
          }
          persistedOffline = Boolean(status?.coreOffline ?? status?.hostOffline) || !hostOnline;
        } catch (cause) {
          if (isCoreOfflineError(cause)) {
            await this.transport.updateWorkspaceShioriModel(this.project, trimmed, serviceTier, effort);
            persistedOffline = true;
          } else {
            throw cause;
          }
        }
      } else {
        await this.transport.updateWorkspaceShioriModel(this.project, trimmed, serviceTier, effort);
        persistedOffline = true;
      }

      this.update(prev => ({
        ...prev,
        optimisticModel: {
          baseServerModel,
          model: trimmed,
          serviceTier: appliedServiceTier,
          effort: appliedEffort,
        },
      }));
      this.reconcileNow(onUpdated);
      return { persistedOffline };
    } catch (error) {
      this.update(prev => ({ ...prev, optimisticModel: priorModel }));
      throw error;
    }
  }

  async mutatePool(options: {
    workspace: string;
    run: string;
    baseUpdatedAt: string;
    baseServerModel?: string | null;
    command: EventPoolCommand;
    fromComposer?: boolean;
    mightSpawnCore?: boolean;
    onUpdated?: () => void;
  }): Promise<EventPoolMutatePayload> {
    const {
      workspace,
      run,
      baseUpdatedAt,
      baseServerModel,
      command,
      fromComposer = false,
      mightSpawnCore = false,
      onUpdated,
    } = options;
    const tracksSpawn = mightSpawnCore || Boolean(command.preempt);
    if (tracksSpawn) this.beginSpawn();
    const previousPool = this.state.poolSnapshot;
    const optimisticAckIso = command.action === "ack" ? new Date().toISOString() : "";
    const optimisticPriorById = new Map<string, PoolEvent>();

    // Optimistic Event Pool update for instant UI feedback on ack/withdraw/reply
    if (previousPool && command.action === "ack") {
      const ackSet = new Set(command.ids);
      const nextEvents = previousPool.events.map(ev => {
        if (ackSet.has(ev.id) && ev.status === "pending") {
          optimisticPriorById.set(ev.id, ev);
          return { ...ev, status: "handled" as const, handledAt: optimisticAckIso, handledBy: "human" as const };
        }
        return ev;
      });
      this.update(prev => ({
        ...prev,
        poolSubmitting: true,
        ...(fromComposer ? { submitting: true } : {}),
        poolSnapshot: {
          ...previousPool,
          events: nextEvents,
          summary: {
            ...previousPool.summary,
            pendingInbound: nextEvents.filter(e => e.direction === "inbound" && e.status === "pending").length,
            pendingOutbound: nextEvents.filter(e => e.direction === "outbound" && e.status === "pending").length,
          },
        },
      }));
    } else {
      this.update(prev => ({
        ...prev,
        poolSubmitting: true,
        ...(fromComposer ? { submitting: true } : {}),
      }));
    }

    try {
      const spawnIfOffline =
        mightSpawnCore &&
        (command.action === "send" ||
          (command.action === "reply" && Boolean(command.resumeAuto)));
      const res = await this.transport.mutateEventPool(this.project, workspace, command, {
        spawnIfOffline,
      });
      const spawnedRunId = this.recordSpawnedRun(res);
      this.update(prev => ({
        ...prev,
        poolSnapshot: res.snapshot,
      }));
      if (res.hostStatus) {
        this.recordOptimisticHost(spawnedRunId || run, baseUpdatedAt, res.hostStatus, baseServerModel);
      }
      this.reconcileNow(onUpdated);
      return res;
    } catch (error) {
      if (optimisticPriorById.size > 0 && command.action === "ack") {
        this.update(prev => {
          const cur = prev.poolSnapshot;
          if (!cur) return prev;
          let revertedAny = false;
          const revertedEvents = cur.events.map(ev => {
            const prior = optimisticPriorById.get(ev.id);
            if (
              prior &&
              ev.status === "handled" &&
              ev.handledBy === "human" &&
              ev.handledAt === optimisticAckIso
            ) {
              revertedAny = true;
              return prior;
            }
            return ev;
          });
          if (!revertedAny) return prev;
          return {
            ...prev,
            poolSnapshot: {
              ...cur,
              events: revertedEvents,
              summary: {
                ...cur.summary,
                pendingInbound: revertedEvents.filter(e => e.direction === "inbound" && e.status === "pending").length,
                pendingOutbound: revertedEvents.filter(e => e.direction === "outbound" && e.status === "pending").length,
              },
            },
          };
        });
        this.triggerPoolCycle();
      }
      this.recordContention(error, async () => {
        await this.mutatePool({
          ...options,
          mightSpawnCore: true,
          command: { ...command, preempt: true },
        });
      });
      throw error;
    } finally {
      this.update(prev => ({
        ...prev,
        poolSubmitting: false,
        ...(fromComposer ? { submitting: false } : {}),
      }));
      if (tracksSpawn) this.endSpawn();
    }
  }

  private teardownStreamRequests(): void {
    this.changesController?.abort();
    this.changesController = null;
    this.changesRunFn = null;
    this.changesPending = false;
    this.bootstrapController?.abort();
    this.bootstrapController = null;
    this.earlierController?.abort();
    this.earlierController = null;
    this.selectionController?.abort();
    this.selectionController = null;
    this.olderRunController?.abort();
    this.olderRunController = null;
  }

  dispose(): void {
    this.disposed = true;
    this.teardownStreamRequests();
    this.poolController?.abort();
    this.poolController = null;
    this.poolFetchFn = null;
    this.poolPending = false;
    this.listeners.clear();
  }
}

const MAX_CACHED_PROJECT_SESSIONS = 6;
const projectEngines = new Map<string, LiveSessionEngine>();

export function getLiveSessionEngine(
  project: string,
  rpc?: LudensRpcCaller | null,
): LiveSessionEngine {
  const key = project || "__empty__";
  let engine = projectEngines.get(key);
  if (engine) {
    if (rpc !== undefined) {
      engine.setRpc(rpc);
    }
    projectEngines.delete(key);
    projectEngines.set(key, engine);
    return engine;
  }
  engine = new LiveSessionEngine({ project, rpc });
  projectEngines.set(key, engine);
  while (projectEngines.size > MAX_CACHED_PROJECT_SESSIONS) {
    const oldestKey = projectEngines.keys().next().value!;
    const oldest = projectEngines.get(oldestKey);
    projectEngines.delete(oldestKey);
    oldest?.dispose();
  }
  return engine;
}
