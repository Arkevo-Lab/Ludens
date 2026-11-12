"use client";

import type { EventPoolSnapshot, PoolEvent } from "@ludens/protocol/event-pool";
import {
  ActivityChangesClient,
  requestActivity as defaultRequestActivity,
  type ActivityChangesPage,
  type ActivityResponse,
} from "@ludens/protocol/activity";
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
import { ReadPoller } from "@/lib/read-poller";
import type { Call, Observation, RunData, RunInfo } from "@/lib/types";

export type RuntimeControlCommand =
  | { action: "status" }
  | { action: "auto_on"; message?: string; seconds?: number | null; runId?: string; expectedEpoch?: string | null }
  | { action: "auto_off"; runId?: string; expectedEpoch?: string | null }
  | { action: "auto_budget"; seconds: number | null; runId?: string; expectedEpoch?: string | null }
  | { action: "steer"; message: string; runId?: string; expectedEpoch?: string | null }
  | { action: "consolidate"; seconds?: number; runId?: string; expectedEpoch?: string | null }
  | {
      action: "set_model";
      model: string;
      serviceTier?: ModelServiceTier | null;
      effort?: ModelEffort | null;
      runId?: string;
      expectedEpoch?: string | null;
    }
  | { action: "perception_inject"; enabled: boolean; runId?: string }
  | { action: "perception_reload"; runId?: string };

export type EventPoolCommand =
  | { action: "send"; text: string; title?: string }
  | { action: "reply"; replyTo: string; text: string; resumeAuto?: boolean; seconds?: number | null }
  | { action: "ack"; ids: string[] };

export interface EventPoolReadPayload {
  snapshot: EventPoolSnapshot;
  hostOnline: boolean;
  hostStatus?: Record<string, unknown>;
}

export interface EventPoolMutatePayload extends EventPoolReadPayload {
  createdEvent?: PoolEvent;
  resolvedOutbound?: PoolEvent;
  updatedEvents?: PoolEvent[];
}

export interface ActivityChangesClientOptions {
  project: string;
  run?: string;
  epoch?: string;
  limit?: number;
  baseUrl?: string;
}

export interface ChangesReaderLike {
  read(signal: AbortSignal): Promise<ActivityChangesPage>;
}

export interface LiveSessionTransport {
  createChangesClient: (options: ActivityChangesClientOptions) => ChangesReaderLike;
  requestActivity: (params: URLSearchParams, signal: AbortSignal) => Promise<ActivityResponse>;
  readRun: (url: string, signal?: AbortSignal) => Promise<RunData>;
  fetchEventPool: (project: string, workspace: string, signal?: AbortSignal) => Promise<EventPoolReadPayload>;
  mutateEventPool: (project: string, workspace: string, command: EventPoolCommand) => Promise<EventPoolMutatePayload>;
  sendRuntimeControl: (project: string, workspace: string, command: RuntimeControlCommand) => Promise<unknown>;
  updateWorkspaceShioriModel: (
    project: string,
    model: string,
    serviceTier: ModelServiceTier | null,
    effort: ModelEffort | null,
  ) => Promise<unknown>;
}

async function defaultFetchEventPool(
  project: string,
  workspace: string,
  signal?: AbortSignal,
): Promise<EventPoolReadPayload> {
  const params = new URLSearchParams({ project, workspace });
  const response = await fetch(`/api/event-pool?${params}`, { signal, cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      typeof payload?.error === "string" ? payload.error : `Event Pool read failed (${response.status})`,
    );
  }
  return payload as EventPoolReadPayload;
}

async function defaultMutateEventPool(
  project: string,
  workspace: string,
  command: EventPoolCommand,
): Promise<EventPoolMutatePayload> {
  const response = await fetch("/api/event-pool", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project, workspace, command }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      typeof payload?.error === "string" ? payload.error : `Event Pool request failed (${response.status})`,
    );
  }
  return payload as EventPoolMutatePayload;
}

async function defaultSendRuntimeControl(
  project: string,
  workspace: string,
  command: RuntimeControlCommand,
): Promise<unknown> {
  const response = await fetch("/api/runtime/control", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project, workspace, command }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      typeof payload?.error === "string" ? payload.error : `Control request failed (${response.status})`,
    );
  }
  return payload;
}

async function defaultUpdateWorkspaceShioriModel(
  project: string,
  model: string,
  serviceTier: ModelServiceTier | null,
  effort: ModelEffort | null,
): Promise<unknown> {
  const response = await fetch("/api/workspaces", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "workspaceShiori",
      id: project,
      shiori: { model, serviceTier, effort },
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      typeof payload?.error === "string"
        ? payload.error
        : `Workspace model update failed (${response.status})`,
    );
  }
  return payload;
}

export const defaultLiveSessionTransport: LiveSessionTransport = {
  createChangesClient: options => new ActivityChangesClient(options),
  requestActivity: (params, signal) => defaultRequestActivity(params, signal),
  readRun: (url, signal) => readArchiveJson<RunData>(url, signal),
  fetchEventPool: defaultFetchEventPool,
  mutateEventPool: defaultMutateEventPool,
  sendRuntimeControl: defaultSendRuntimeControl,
  updateWorkspaceShioriModel: defaultUpdateWorkspaceShioriModel,
};

function isHostOfflineError(cause: unknown): boolean {
  const msg = cause instanceof Error ? cause.message : String(cause);
  return (
    msg.includes("未在线") ||
    msg.includes("HOST_OFFLINE") ||
    msg.includes("ENOENT") ||
    msg.includes("ECONNREFUSED")
  );
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
 * Stabilizes `/api/run` polling snapshots against volatile `updatedAt` timestamps:
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
  };
}

export class LiveSessionEngine {
  readonly project: string;
  private readonly transport: LiveSessionTransport;
  private state: LiveSessionSnapshot;
  private readonly listeners = new Set<() => void>();

  private streamKey = "";
  private streamToken = 0;
  private streamEnabled = false;
  private streamRefresh = false;
  private selectedBlockId: string | undefined;
  private scopeChangedMessage = "Activity scope changed";

  private changesPoller: ReadPoller | null = null;
  private bootstrapController: AbortController | null = null;
  private earlierController: AbortController | null = null;
  private selectionController: AbortController | null = null;
  private olderRunController: AbortController | null = null;

  private readonly completedBeforeCursors = new Set<string>();
  private inFlightBeforeCursor: string | null = null;
  private readonly completedOlderBeforeCursors = new Set<string>();
  private inFlightOlderCursorKey: string | null = null;

  private workspacePath: string | null = null;
  private poolPoller: ReadPoller | null = null;
  private poolKey = "";
  private poolEnabled = false;
  private disposed = false;

  constructor(options: { project: string; transport?: Partial<LiveSessionTransport> }) {
    this.project = options.project;
    this.transport = { ...defaultLiveSessionTransport, ...options.transport };
    this.state = emptySessionSnapshot(options.project);
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
      if (this.state.targetRun !== "" || this.state.loading) {
        this.update(prev => ({
          ...prev,
          targetRun: "",
          targetEpoch: epoch,
          resetRevision,
          blocks: [],
          loading: false,
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
        this.changesPoller?.setEnabled(false);
      } else {
        if (!this.changesPoller) {
          this.startStreamForCurrentTarget(run, epoch, refresh, resetRevision);
        } else {
          this.changesPoller.setEnabled(refresh);
          if (!wasEnabled && refresh) {
            this.changesPoller.nudge();
          }
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
    if (runChanged) {
      this.completedOlderBeforeCursors.clear();
      this.inFlightOlderCursorKey = null;
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
      error: "",
      selected: undefined,
      selectionReady: false,
      ...(runChanged
        ? {
            olderRuns: [],
            loadingOlderRun: false,
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

    const poller = new ReadPoller(async signal => {
      let more = false;
      try {
        const result = await reader.read(signal);
        if (signal.aborted || token !== this.streamToken) return 2500;
        more = result.hasMore;

        const prev = this.state;
        const generationChanged =
          prev.generation !== null && prev.generation !== result.projection.generation;
        const scopeChanged = prev.scope !== null && !sameScope(prev.scope, result.scope);
        const hardReset = generationChanged || scopeChanged;

        if (hardReset) {
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
      }
      return more ? 0 : 2500;
    }, refresh);

    this.changesPoller = poller;
    // Parallel bootstrap: launch live changes stream AND initial history page concurrently at t=0.
    runBootstrapHistory();
    void poller.readOnce();
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
          this.selectedBlockId !== blockId
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
        if (controller.signal.aborted || token !== this.streamToken || this.selectedBlockId !== blockId) return;
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
      if (controller.signal.aborted || token !== this.streamToken) return;
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
      if (controller.signal.aborted || token !== this.streamToken) return;
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
          const runParams = new URLSearchParams({ project: this.project, run: targetRunId, epoch: "all" });
          if (evidence && evidence.targetRunId === targetRunId) {
            if (evidence.call) runParams.set("call", evidence.call);
            if (evidence.image) runParams.set("image", evidence.image);
          }
          const actParams = new URLSearchParams({
            project: this.project,
            run: targetRunId,
            epoch: "all",
            mode: "history",
            kind: "all",
            limit: "300",
          });
          const [runPayload, actPayload] = await Promise.all([
            this.transport.readRun(`/api/run?${runParams}`, controller.signal),
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
   * Coordinates `/api/event-pool` background polling via `ReadPoller` (3.5s, visibility-throttled),
   * completely decoupled from volatile `data.updatedAt`, with structural snapshot deduplication.
   */
  syncEventPool(options: {
    workspace: string | null;
    isLiveRun: boolean;
    enabled: boolean;
    refresh: boolean;
    liveLatestSeq?: number;
  }): void {
    if (this.disposed) return;
    const { workspace, isLiveRun, enabled, refresh, liveLatestSeq } = options;
    this.workspacePath = workspace;

    const active = Boolean(isLiveRun && enabled && this.project && workspace);
    const nextPoolKey = workspace ? `${this.project}\0${workspace}` : "";

    if (!active || !workspace) {
      this.poolEnabled = false;
      this.poolPoller?.setEnabled(false);
      return;
    }

    const shouldPoll = active && refresh;
    const keyChanged = nextPoolKey !== this.poolKey;
    const becameActive = !this.poolEnabled;
    this.poolEnabled = true;

    if (keyChanged || !this.poolPoller) {
      this.poolPoller?.dispose();
      this.poolKey = nextPoolKey;
      const targetWorkspace = workspace;
      const poller = new ReadPoller(async signal => {
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
        return 3500;
      }, shouldPoll);
      this.poolPoller = poller;
      void poller.readOnce();
      return;
    }

    this.poolPoller.setEnabled(shouldPoll);
    if (becameActive) {
      this.poolPoller.nudge();
      return;
    }

    if (
      typeof liveLatestSeq === "number" &&
      liveLatestSeq > (this.state.poolSnapshot?.summary.latestSeq ?? -1)
    ) {
      this.poolPoller.nudge();
    }
  }

  /** Nudges immediate local reconciliation of activity deltas & event pool without resetting state. */
  reconcileNow(onUpdated?: () => void): void {
    this.changesPoller?.nudge();
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

  // ── Unified Mutations ──

  async runRuntimeCommand(options: {
    workspace: string;
    run: string;
    baseUpdatedAt: string;
    baseServerModel?: string | null;
    command: RuntimeControlCommand;
    onUpdated?: () => void;
  }): Promise<{ payload: unknown; status: Record<string, unknown> | null }> {
    const { workspace, run, baseUpdatedAt, baseServerModel, command, onUpdated } = options;
    this.update(prev => ({ ...prev, submitting: true }));
    try {
      const payload = await this.transport.sendRuntimeControl(this.project, workspace, command);
      const status = this.recordOptimisticHost(
        run,
        baseUpdatedAt,
        this.extractReturnedStatus(payload),
        baseServerModel,
      );
      this.reconcileNow(onUpdated);
      return { payload, status };
    } finally {
      this.update(prev => ({ ...prev, submitting: false }));
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
      onUpdated,
    } = options;
    this.update(prev => ({ ...prev, submitting: true }));
    try {
      let payload: unknown;
      let fellBackToAutoOn = false;
      try {
        payload = await this.transport.sendRuntimeControl(this.project, workspace, {
          action: "steer",
          message,
          runId: run,
          expectedEpoch: expectedEpoch ?? undefined,
        });
      } catch (steerErr) {
        const msg = steerErr instanceof Error ? steerErr.message : String(steerErr);
        if (msg.includes("Auto loop is not active")) {
          fellBackToAutoOn = true;
          payload = await this.transport.sendRuntimeControl(this.project, workspace, {
            action: "auto_on",
            ...(message ? { message } : {}),
            seconds: fallbackSeconds,
            runId: run,
            expectedEpoch: expectedEpoch ?? null,
          });
        } else {
          throw steerErr;
        }
      }
      const status = this.recordOptimisticHost(
        run,
        baseUpdatedAt,
        this.extractReturnedStatus(payload),
        baseServerModel,
      );
      this.reconcileNow(onUpdated);
      return { fellBackToAutoOn, status };
    } finally {
      this.update(prev => ({ ...prev, submitting: false }));
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
          persistedOffline = Boolean(status?.hostOffline) || !hostOnline;
        } catch (cause) {
          if (isHostOfflineError(cause)) {
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
    onUpdated?: () => void;
  }): Promise<EventPoolMutatePayload> {
    const { workspace, run, baseUpdatedAt, baseServerModel, command, fromComposer = false, onUpdated } = options;
    const previousPool = this.state.poolSnapshot;

    // Optimistic Event Pool update for instant UI feedback on ack/withdraw/reply
    if (previousPool && command.action === "ack") {
      const ackSet = new Set(command.ids);
      const nowIso = new Date().toISOString();
      const nextEvents = previousPool.events.map(ev =>
        ackSet.has(ev.id) && ev.status === "pending"
          ? { ...ev, status: "handled" as const, handledAt: nowIso, handledBy: "human" as const }
          : ev,
      );
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
      const res = await this.transport.mutateEventPool(this.project, workspace, command);
      this.update(prev => ({
        ...prev,
        poolSnapshot: res.snapshot,
      }));
      if (res.hostStatus) {
        this.recordOptimisticHost(run, baseUpdatedAt, res.hostStatus, baseServerModel);
      }
      this.reconcileNow(onUpdated);
      return res;
    } catch (error) {
      if (previousPool && command.action === "ack") {
        this.update(prev => ({ ...prev, poolSnapshot: previousPool }));
      }
      throw error;
    } finally {
      this.update(prev => ({
        ...prev,
        poolSubmitting: false,
        ...(fromComposer ? { submitting: false } : {}),
      }));
    }
  }

  private teardownStreamRequests(): void {
    this.changesPoller?.dispose();
    this.changesPoller = null;
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
    this.poolPoller?.dispose();
    this.poolPoller = null;
    this.listeners.clear();
  }
}

const MAX_CACHED_PROJECT_SESSIONS = 6;
const projectEngines = new Map<string, LiveSessionEngine>();

export function getLiveSessionEngine(project: string): LiveSessionEngine {
  const key = project || "__empty__";
  let engine = projectEngines.get(key);
  if (engine) {
    projectEngines.delete(key);
    projectEngines.set(key, engine);
    return engine;
  }
  engine = new LiveSessionEngine({ project });
  projectEngines.set(key, engine);
  while (projectEngines.size > MAX_CACHED_PROJECT_SESSIONS) {
    const oldestKey = projectEngines.keys().next().value!;
    const oldest = projectEngines.get(oldestKey);
    projectEngines.delete(oldestKey);
    oldest?.dispose();
  }
  return engine;
}
