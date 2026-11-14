"use client";

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { EventPoolSnapshot, PoolEvent } from "@ludens/protocol/event-pool";
import {
  isModelEffort,
  type ModelEffort,
  type ModelServiceTier,
} from "@/components/model-picker-dialog";
import {
  getLiveSessionEngine,
  stabilizeRunData,
  type EventPoolCommand,
  type EventPoolMutatePayload,
  type LiveSessionEngine,
  type OlderRunSlice,
  type RuntimeControlCommand,
} from "@/features/live/live-session-store";
import {
  buildCodexSegments,
  mergePoolSnapshotSegments,
  reconcileSegments,
  type StreamSegment,
} from "@/features/live/shiori-segments";
import type { ActivityFeedData } from "@/features/live/use-activity-feed";
import type { DeviceContentionConflict, RunData, RunInfo, ServiceLaunchOrigin } from "@/lib/types";

export function canSwitchShioriModel(state: {
  isLiveRun: boolean;
  hostOnline: boolean;
  mode: string;
  consolidating?: boolean;
  thinking?: boolean;
}): boolean {
  if (!state.isLiveRun) return false;
  if (state.mode === "auto" || state.mode === "acquiring") return false;
  if (state.consolidating) return false;
  if (state.hostOnline && (state.thinking || state.mode !== "manual")) return false;
  return true;
}

export function resolveShioriActiveModel(options: {
  localModelOverride?: string | null;
  liveModel?: string | null;
  controlModel?: string | null;
  manifestModel?: string | null;
}): string | null {
  const candidates = [
    options.localModelOverride,
    options.liveModel,
    options.controlModel,
    options.manifestModel,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

export type LiveHostStatus = NonNullable<RunData["live"]> & {
  maxSeconds?: number | null;
  remainingSeconds?: number | null;
  consolidating?: boolean;
  model?: string | null;
  serviceTier?: ModelServiceTier | null;
  effort?: ModelEffort | null;
  hostOffline?: boolean;
  coreOffline?: boolean;
  launchedBy?: ServiceLaunchOrigin;
  spawned?: boolean;
  queue?: { steering?: number };
  eventPool?: { pendingInbound?: number; pendingOutbound?: number; latestSeq?: number };
};

export interface LiveSessionActions {
  runRuntimeCommand: (command: RuntimeControlCommand) => Promise<{ payload: unknown; status: Record<string, unknown> | null }>;
  startAuto: (options?: { message?: string; seconds?: number | null }) => Promise<{ payload: unknown; status: Record<string, unknown> | null }>;
  stopAuto: () => Promise<{ payload: unknown; status: Record<string, unknown> | null }>;
  consolidate: (seconds?: number) => Promise<{ payload: unknown; status: Record<string, unknown> | null }>;
  steerOrStartAuto: (message: string, fallbackSeconds: number | null) => Promise<{ fellBackToAutoOn: boolean; status: Record<string, unknown> | null }>;
  setAutoStopTimer: (seconds: number | null) => Promise<void>;
  extendAutoStopTimer: (deltaSeconds: number, fallbackRemainingSeconds: number) => Promise<void>;
  switchModel: (
    model: string,
    serviceTier: ModelServiceTier | null,
    effort: ModelEffort | null,
  ) => Promise<{ persistedOffline: boolean }>;
  sendPoolEvent: (text: string, title?: string) => Promise<EventPoolMutatePayload>;
  replyPoolEvent: (options: {
    replyTo: string;
    text: string;
    resumeAuto?: boolean;
    seconds?: number | null;
  }) => Promise<EventPoolMutatePayload>;
  ackPoolEvent: (eventId: string, options?: { fromComposer?: boolean }) => Promise<EventPoolMutatePayload | null>;
  mutatePool: (command: EventPoolCommand, options?: { fromComposer?: boolean }) => Promise<EventPoolMutatePayload>;
}

export interface UseLiveSessionResult {
  engine: LiveSessionEngine;
  data: RunData;
  live: LiveHostStatus | null;
  statusAnchorMs: number;
  hostOnline: boolean;
  mode: string;
  isAuto: boolean;
  consolidating: boolean;
  thinking: boolean;
  canSwitchModel: boolean;
  serverModel: string | null;
  activeModel: string | null;
  activeServiceTier: ModelServiceTier | null;
  activeEffort: ModelEffort | null;
  submitting: boolean;
  poolSubmitting: boolean;
  spawningCore: boolean;
  pendingContention: DeviceContentionConflict | null;
  preemptError: string | null;
  preemptSuccessSeq: number;
  confirmPreempt: () => Promise<boolean>;
  dismissContention: () => void;
  poolSnapshot: EventPoolSnapshot | null;
  poolEventsById: Map<string, PoolEvent>;
  resolveLivePoolEvent: (event: PoolEvent) => PoolEvent;
  pendingInboundCount: number;
  pendingOutboundCount: number;
  pendingPoolCount: number;
  olderRuns: OlderRunSlice[];
  loadingOlderRun: boolean;
  olderRunError: string | null;
  nextOlderRun: RunInfo | null;
  hasMoreUpwardHistory: boolean;
  earliestLoadedMs: number;
  segments: StreamSegment[];
  allCalls: RunData["calls"];
  loadNextUpwardHistory: (onBeforePrepend?: () => void) => void;
  loadOlderRunSegment: (
    upToRunId?: string,
    options?: {
      onBeforePrepend?: () => void;
      evidence?: { targetRunId: string; call?: string; image?: string };
    },
  ) => Promise<boolean>;
  clearOlderRunError: () => void;
  actions: LiveSessionActions;
}

/**
 * Unified Live Session Hook (`useLiveSession`):
 * -Stabilizes `/api/run` snapshots against volatile `updatedAt` ticks
 * -Connects to per-project `LiveSessionEngine` for warm monotonic olderRuns + EventPool polling + optimistic mutations
 * -Memoizes `buildCodexSegments` per historical run and reconciles `StreamSegment` object references across 2.5s live polls
 */
export function useLiveSession(options: {
  project: string;
  workspace: string | null;
  runs: RunInfo[];
  data: RunData;
  feed: ActivityFeedData;
  isLiveRun: boolean;
  refresh: boolean;
  olderRunLoadFailedText?: string;
  onUpdated: () => void;
  onRunSpawned?: (runId: string) => void;
}): UseLiveSessionResult {
  const {
    project,
    workspace,
    runs,
    data: rawData,
    feed,
    isLiveRun,
    refresh,
    olderRunLoadFailedText = "Failed to load older run",
    onUpdated,
    onRunSpawned,
  } = options;

  // 1. Structural stabilization of `RunData` to ignore 2.5s `updatedAt` churn
  const stabilizedDataRef = useRef<RunData | null>(null);
  const data = stabilizeRunData(stabilizedDataRef.current, rawData);
  stabilizedDataRef.current = data;

  const engine = useMemo(() => getLiveSessionEngine(project), [project]);
  const snap = useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getSnapshot);

  // 2. Unified optimistic + server runtime / model state
  const rawUpdatedAtMs = Date.parse(rawData.updatedAt);
  const activeHostOverride =
    snap.optimisticHost &&
    snap.optimisticHost.run === data.run &&
    (rawData.updatedAt === snap.optimisticHost.baseUpdatedAt ||
      (Number.isFinite(rawUpdatedAtMs) && rawUpdatedAtMs < snap.optimisticHost.appliedAtMs))
      ? snap.optimisticHost.status
      : null;

  const live = (activeHostOverride ?? data.live) as LiveHostStatus | null;
  const control = data.lastControl as
    | (RunData["lastControl"] & {
        model?: string | null;
        serviceTier?: ModelServiceTier | null;
        effort?: ModelEffort | null;
      })
    | undefined;

  const isSyntheticOffline = Boolean(live?.coreOffline ?? live?.hostOffline);
  const hostOnline = Boolean(isLiveRun && ((!isSyntheticOffline && live) || data.controlAllowed));
  const mode = live?.mode ?? (typeof control?.mode === "string" ? control.mode : "manual");
  const consolidating = Boolean(live?.consolidating ?? control?.consolidating);
  const thinking = Boolean(live?.thinking ?? control?.thinking);
  const isAuto = mode === "auto";
  const canSwitchModel = canSwitchShioriModel({
    isLiveRun,
    hostOnline,
    mode,
    consolidating,
    thinking,
  });

  const serverModel = resolveShioriActiveModel({
    liveModel: typeof live?.model === "string" ? live.model : null,
    controlModel: typeof control?.model === "string" ? control.model : null,
    manifestModel: data.manifest.model ?? null,
  });

  const validOptimisticModel =
    snap.optimisticModel &&
    (serverModel === snap.optimisticModel.baseServerModel || serverModel === snap.optimisticModel.model)
      ? snap.optimisticModel
      : null;

  const activeModel = resolveShioriActiveModel({
    localModelOverride: validOptimisticModel?.model ?? null,
    liveModel: typeof live?.model === "string" ? live.model : null,
    controlModel: typeof control?.model === "string" ? control.model : null,
    manifestModel: data.manifest.model ?? null,
  });

  const activeServiceTier: ModelServiceTier | null =
    validOptimisticModel && activeModel === validOptimisticModel.model
      ? validOptimisticModel.serviceTier
      : live?.serviceTier ?? control?.serviceTier ?? null;

  const activeEffort: ModelEffort | null =
    validOptimisticModel && activeModel === validOptimisticModel.model
      ? validOptimisticModel.effort
      : isModelEffort(live?.effort)
        ? live.effort
        : isModelEffort(control?.effort)
          ? control.effort
          : null;

  const statusAnchorMs = activeHostOverride
    ? snap.optimisticHost!.appliedAtMs
    : Number.isFinite(rawUpdatedAtMs)
      ? rawUpdatedAtMs
      : Date.parse(data.updatedAt);

  // 3. Coordinated EventPool polling (completely decoupled from `data.updatedAt`!)
  const livePoolLatestSeq = live?.eventPool?.latestSeq;
  useEffect(() => {
    engine.syncEventPool({
      workspace,
      isLiveRun,
      enabled: true,
      refresh,
      liveLatestSeq: livePoolLatestSeq,
    });
    return () => {
      engine.syncEventPool({
        workspace,
        isLiveRun: false,
        enabled: false,
        refresh: false,
      });
    };
  }, [engine, workspace, isLiveRun, refresh, livePoolLatestSeq]);

  const olderRuns =
    snap.targetRun === "" || snap.targetRun === data.run ? snap.olderRuns : [];
  const loadingOlderRun = snap.loadingOlderRun;
  const olderRunError = snap.olderRunError;
  const poolSnapshot = snap.poolSnapshot;

  const earliestOlderRun = olderRuns[0] ?? null;
  const earliestLoadedRunId = earliestOlderRun?.runId ?? data.run;
  const earliestIdxInCatalog = runs.findIndex(r => r.id === earliestLoadedRunId);
  const nextOlderRun =
    earliestIdxInCatalog >= 0 && earliestIdxInCatalog + 1 < runs.length
      ? runs[earliestIdxInCatalog + 1]!
      : null;

  // Chronological upward frontier: once `olderRuns` are prepended above `data.run`,
  // upward scrolling at the top pages `earliestOlderRun` and `nextOlderRun` first (above viewport),
  // then falls back to any remaining unloaded `feed.hasMore` gap in `data.run` left by a Quick-Jump.
  const hasMoreUpwardHistory = Boolean(
    olderRuns.length === 0
      ? feed.hasMore || nextOlderRun
      : earliestOlderRun?.hasMore || nextOlderRun || feed.hasMore,
  );

  const loadOlderRunSegment = useCallback(
    async (
      upToRunId?: string,
      opts?: {
        onBeforePrepend?: () => void;
        evidence?: { targetRunId: string; call?: string; image?: string };
      },
    ) => {
      opts?.onBeforePrepend?.();
      return engine.loadOlderRuns({
        currentRunId: data.run,
        runs,
        upToRunId,
        evidence: opts?.evidence,
        fallbackErrorMessage: olderRunLoadFailedText,
      });
    },
    [engine, data.run, runs, olderRunLoadFailedText],
  );

  const loadNextUpwardHistory = useCallback(
    (onBeforePrepend?: () => void) => {
      if (feed.loading || feed.loadingOlder || loadingOlderRun) return;
      if (olderRuns.length === 0 && feed.hasMore) {
        onBeforePrepend?.();
        void feed.earlier();
        return;
      }
      if (earliestOlderRun?.hasMore && earliestOlderRun.before) {
        onBeforePrepend?.();
        void engine.loadEarlierBlocksOfOlderRun(
          earliestOlderRun.runId,
          earliestOlderRun.before,
          olderRunLoadFailedText,
        );
        return;
      }
      if (nextOlderRun) {
        void loadOlderRunSegment(undefined, { onBeforePrepend });
        return;
      }
      if (feed.hasMore) {
        void feed.earlier();
      }
    },
    [
      feed,
      loadingOlderRun,
      olderRuns.length,
      earliestOlderRun,
      nextOlderRun,
      engine,
      olderRunLoadFailedText,
      loadOlderRunSegment,
    ],
  );

  const allCalls = useMemo(
    () => (olderRuns.length === 0 ? data.calls : [...olderRuns.flatMap(r => r.data.calls), ...data.calls]),
    [olderRuns, data.calls],
  );

  const poolEventsById = useMemo(
    () => new Map((poolSnapshot?.events ?? []).map(item => [item.id, item])),
    [poolSnapshot],
  );

  const resolveLivePoolEvent = useCallback(
    (event: PoolEvent): PoolEvent => {
      const snapshotItem = poolEventsById.get(event.id);
      if (!snapshotItem) return event;
      return snapshotItem.status === "pending" && event.status === "handled"
        ? { ...snapshotItem, status: "handled", handledAt: event.handledAt, handledBy: event.handledBy }
        : snapshotItem;
    },
    [poolEventsById],
  );

  const pendingOutboundCount =
    poolSnapshot?.summary.pendingOutbound ?? live?.eventPool?.pendingOutbound ?? 0;
  const pendingInboundCount =
    poolSnapshot?.summary.pendingInbound ?? live?.eventPool?.pendingInbound ?? 0;
  const pendingPoolCount = pendingInboundCount + pendingOutboundCount;

  const earliestLoadedMs = useMemo(() => {
    if (!hasMoreUpwardHistory) return 0;
    const minFinite = (...values: Array<string | null | undefined>) => {
      const parsed = values.map(v => (v ? Date.parse(v) : NaN)).filter(Number.isFinite);
      return parsed.length > 0 ? Math.min(...parsed) : NaN;
    };
    const first = olderRuns[0];
    if (first) {
      return first.hasMore
        ? minFinite(first.blocks[0]?.at)
        : minFinite(
            first.blocks[0]?.at,
            first.data.cycles[0]?.startedAt,
            runs.find(r => r.id === first.runId)?.startedAt,
          );
    }
    return feed.hasMore
      ? minFinite(feed.historyFloorAt ?? feed.blocks[0]?.at)
      : minFinite(feed.blocks[0]?.at, data.cycles[0]?.startedAt, runs.find(r => r.id === data.run)?.startedAt);
  }, [
    hasMoreUpwardHistory,
    olderRuns,
    runs,
    feed.hasMore,
    feed.historyFloorAt,
    feed.blocks,
    data.cycles,
    data.run,
  ]);

  // 4. Incremental per-run segment memoization + reference reconciliation across 2.5s polls
  const olderRunSegmentCacheRef = useRef<
    Map<
      string,
      {
        blocks: OlderRunSlice["blocks"];
        calls: RunData["calls"];
        observations: RunData["observations"];
        cycles: RunData["cycles"];
        prevEndedAt: string | null;
        fallbackStartedAt: string;
        segments: StreamSegment[];
      }
    >
  >(new Map());

  const reconciledSegmentsRef = useRef<{ run: string; segments: StreamSegment[] }>({
    run: "",
    segments: [],
  });

  const liveMaxSeconds = isAuto && live && "maxSeconds" in live ? (live.maxSeconds ?? null) : undefined;
  const blocksLoading = feed.loading && feed.blocks.length === 0;

  const computedSegments = useMemo(() => {
    const allSegments: StreamSegment[] = [];
    let prevEndedAt: string | null = nextOlderRun?.endedAt ?? nextOlderRun?.startedAt ?? null;

    const olderCache = olderRunSegmentCacheRef.current;
    const activeOlderIds = new Set<string>();

    for (const older of olderRuns) {
      activeOlderIds.add(older.runId);
      const olderInfo = runs.find(r => r.id === older.runId);
      const fallbackStartedAt = olderInfo?.startedAt ?? older.data.updatedAt;
      const cached = olderCache.get(older.runId);
      let segs: StreamSegment[];
      if (
        cached &&
        cached.blocks === older.blocks &&
        cached.calls === older.data.calls &&
        cached.observations === older.data.observations &&
        cached.cycles === older.data.cycles &&
        cached.prevEndedAt === prevEndedAt &&
        cached.fallbackStartedAt === fallbackStartedAt
      ) {
        segs = cached.segments;
      } else {
        segs = buildCodexSegments(older.blocks, older.data.calls, older.data.observations, {
          runId: older.runId,
          cycles: older.data.cycles,
          fallbackStartedAt,
          prevEndedAt,
          isLatestRun: false,
          isAuto: false,
        });
        olderCache.set(older.runId, {
          blocks: older.blocks,
          calls: older.data.calls,
          observations: older.data.observations,
          cycles: older.data.cycles,
          prevEndedAt,
          fallbackStartedAt,
          segments: segs,
        });
      }
      allSegments.push(...segs);
      prevEndedAt =
        older.data.cycles.at(-1)?.endedAt ??
        olderInfo?.endedAt ??
        older.blocks.at(-1)?.at ??
        older.data.updatedAt ??
        prevEndedAt;
    }

    for (const key of olderCache.keys()) {
      if (!activeOlderIds.has(key)) olderCache.delete(key);
    }

    const liveSyncedCycles =
      isAuto && liveMaxSeconds !== undefined && data.cycles.length > 0
        ? data.cycles.map((cycle, idx) =>
            idx === data.cycles.length - 1 ? { ...cycle, maxSeconds: liveMaxSeconds } : cycle,
          )
        : data.cycles;

    const currentSegs = buildCodexSegments(feed.blocks, data.calls, data.observations, {
      runId: data.run,
      cycles: liveSyncedCycles,
      prevEndedAt,
      isLatestRun: isLiveRun,
      isAuto,
      blocksLoading,
    });
    allSegments.push(...currentSegs);

    const withPool =
      isLiveRun && !feed.historical && poolSnapshot?.events.length
        ? mergePoolSnapshotSegments(allSegments, poolSnapshot.events, {
            earliestLoadedMs,
            hasMoreUpwardHistory,
          })
        : allSegments;

    const prevReconciled =
      reconciledSegmentsRef.current.run === data.run ? reconciledSegmentsRef.current.segments : [];
    const reconciled = reconcileSegments(prevReconciled, withPool);
    if (reconciled.length > 0) {
      reconciledSegmentsRef.current = { run: data.run, segments: reconciled };
    }
    return reconciled;
  }, [
    olderRuns,
    runs,
    nextOlderRun,
    feed.blocks,
    feed.historical,
    data.calls,
    data.observations,
    data.run,
    data.cycles,
    isLiveRun,
    isAuto,
    liveMaxSeconds,
    blocksLoading,
    poolSnapshot,
    earliestLoadedMs,
    hasMoreUpwardHistory,
  ]);

  const segments =
    computedSegments.length === 0 && feed.loading && reconciledSegmentsRef.current.run === data.run
      ? reconciledSegmentsRef.current.segments
      : computedSegments;

  // 5. Unified Mutations (`actions`) & Spawn / Contention Notifications
  const onUpdatedRef = useRef(onUpdated);
  onUpdatedRef.current = onUpdated;
  const onRunSpawnedRef = useRef(onRunSpawned);
  onRunSpawnedRef.current = onRunSpawned;
  const handledSpawnSeqRef = useRef(0);
  useEffect(() => {
    if (snap.lastSpawnedRun && snap.lastSpawnedRun.seq > handledSpawnSeqRef.current) {
      handledSpawnSeqRef.current = snap.lastSpawnedRun.seq;
      onRunSpawnedRef.current?.(snap.lastSpawnedRun.runId);
    }
  }, [snap.lastSpawnedRun]);

  const confirmPreempt = useCallback(() => engine.confirmPreempt(), [engine]);
  const dismissContention = useCallback(() => engine.dismissContention(), [engine]);

  const latestContextRef = useRef({
    workspace,
    run: data.run,
    baseUpdatedAt: rawData.updatedAt,
    baseServerModel: serverModel,
    expectedEpoch: live?.epoch ?? null,
    hostOnline,
  });
  latestContextRef.current = {
    workspace,
    run: data.run,
    baseUpdatedAt: rawData.updatedAt,
    baseServerModel: serverModel,
    expectedEpoch: live?.epoch ?? null,
    hostOnline,
  };

  const actions = useMemo<LiveSessionActions>(
    () => ({
      runRuntimeCommand: async command => {
        const ctx = latestContextRef.current;
        if (!ctx.workspace) throw new Error("Workspace path unavailable");
        return engine.runRuntimeCommand({
          workspace: ctx.workspace,
          run: ctx.run,
          baseUpdatedAt: ctx.baseUpdatedAt,
          baseServerModel: ctx.baseServerModel,
          command,
          mightSpawnCore: !ctx.hostOnline && command.action !== "status" && command.action !== "auto_off",
          onUpdated: () => onUpdatedRef.current(),
        });
      },
      startAuto: async opts => {
        const ctx = latestContextRef.current;
        if (!ctx.workspace) throw new Error("Workspace path unavailable");
        return engine.runRuntimeCommand({
          workspace: ctx.workspace,
          run: ctx.run,
          baseUpdatedAt: ctx.baseUpdatedAt,
          baseServerModel: ctx.baseServerModel,
          mightSpawnCore: !ctx.hostOnline,
          command: {
            action: "auto_on",
            ...(opts?.message ? { message: opts.message } : {}),
            seconds: opts?.seconds ?? null,
            ...(ctx.run ? { runId: ctx.run } : {}),
            expectedEpoch: ctx.expectedEpoch,
          },
          onUpdated: () => onUpdatedRef.current(),
        });
      },
      stopAuto: async () => {
        const ctx = latestContextRef.current;
        if (!ctx.workspace) throw new Error("Workspace path unavailable");
        return engine.runRuntimeCommand({
          workspace: ctx.workspace,
          run: ctx.run,
          baseUpdatedAt: ctx.baseUpdatedAt,
          baseServerModel: ctx.baseServerModel,
          command: {
            action: "auto_off",
            ...(ctx.run ? { runId: ctx.run } : {}),
            expectedEpoch: ctx.expectedEpoch ?? undefined,
          },
          onUpdated: () => onUpdatedRef.current(),
        });
      },
      consolidate: async seconds => {
        const ctx = latestContextRef.current;
        if (!ctx.workspace) throw new Error("Workspace path unavailable");
        return engine.runRuntimeCommand({
          workspace: ctx.workspace,
          run: ctx.run,
          baseUpdatedAt: ctx.baseUpdatedAt,
          baseServerModel: ctx.baseServerModel,
          mightSpawnCore: !ctx.hostOnline,
          command: {
            action: "consolidate",
            ...(typeof seconds === "number" ? { seconds } : {}),
            ...(ctx.run ? { runId: ctx.run } : {}),
            expectedEpoch: ctx.expectedEpoch,
          },
          onUpdated: () => onUpdatedRef.current(),
        });
      },
      steerOrStartAuto: async (message, fallbackSeconds) => {
        const ctx = latestContextRef.current;
        if (!ctx.workspace) throw new Error("Workspace path unavailable");
        return engine.steerOrStartAuto({
          workspace: ctx.workspace,
          run: ctx.run,
          baseUpdatedAt: ctx.baseUpdatedAt,
          baseServerModel: ctx.baseServerModel,
          expectedEpoch: ctx.expectedEpoch,
          message,
          fallbackSeconds,
          mightSpawnCore: !ctx.hostOnline,
          onUpdated: () => onUpdatedRef.current(),
        });
      },
      setAutoStopTimer: async seconds => {
        const ctx = latestContextRef.current;
        if (!ctx.workspace) return;
        await engine.setAutoStopTimer({
          workspace: ctx.workspace,
          run: ctx.run,
          baseUpdatedAt: ctx.baseUpdatedAt,
          expectedEpoch: ctx.expectedEpoch,
          seconds,
          onUpdated: () => onUpdatedRef.current(),
        });
      },
      extendAutoStopTimer: async (deltaSeconds, fallbackRemainingSeconds) => {
        const ctx = latestContextRef.current;
        if (!ctx.workspace) return;
        await engine.extendAutoStopTimer({
          workspace: ctx.workspace,
          run: ctx.run,
          baseUpdatedAt: ctx.baseUpdatedAt,
          expectedEpoch: ctx.expectedEpoch,
          deltaSeconds,
          fallbackRemainingSeconds,
          onUpdated: () => onUpdatedRef.current(),
        });
      },
      switchModel: async (model, serviceTier, effort) => {
        const ctx = latestContextRef.current;
        return engine.switchModel({
          workspace: ctx.workspace,
          run: ctx.run,
          baseUpdatedAt: ctx.baseUpdatedAt,
          baseServerModel: ctx.baseServerModel,
          expectedEpoch: ctx.expectedEpoch,
          hostOnline: ctx.hostOnline,
          model,
          serviceTier,
          effort,
          onUpdated: () => onUpdatedRef.current(),
        });
      },
      sendPoolEvent: async (text, title) => {
        const ctx = latestContextRef.current;
        if (!ctx.workspace) throw new Error("Workspace path unavailable");
        return engine.mutatePool({
          workspace: ctx.workspace,
          run: ctx.run,
          baseUpdatedAt: ctx.baseUpdatedAt,
          baseServerModel: ctx.baseServerModel,
          command: { action: "send", text, ...(title ? { title } : {}) },
          fromComposer: true,
          mightSpawnCore: !ctx.hostOnline,
          onUpdated: () => onUpdatedRef.current(),
        });
      },
      replyPoolEvent: async ({ replyTo, text, resumeAuto, seconds }) => {
        const ctx = latestContextRef.current;
        if (!ctx.workspace) throw new Error("Workspace path unavailable");
        return engine.mutatePool({
          workspace: ctx.workspace,
          run: ctx.run,
          baseUpdatedAt: ctx.baseUpdatedAt,
          baseServerModel: ctx.baseServerModel,
          command: {
            action: "reply",
            replyTo,
            text,
            ...(resumeAuto ? { resumeAuto: true, seconds } : {}),
          },
          fromComposer: true,
          mightSpawnCore: !ctx.hostOnline && Boolean(resumeAuto),
          onUpdated: () => onUpdatedRef.current(),
        });
      },
      ackPoolEvent: async (eventId, opts) => {
        const ctx = latestContextRef.current;
        if (!ctx.workspace) return null;
        return engine.mutatePool({
          workspace: ctx.workspace,
          run: ctx.run,
          baseUpdatedAt: ctx.baseUpdatedAt,
          baseServerModel: ctx.baseServerModel,
          command: { action: "ack", ids: [eventId] },
          fromComposer: opts?.fromComposer,
          onUpdated: () => onUpdatedRef.current(),
        });
      },
      mutatePool: async (command, opts) => {
        const ctx = latestContextRef.current;
        if (!ctx.workspace) throw new Error("Workspace path unavailable");
        return engine.mutatePool({
          workspace: ctx.workspace,
          run: ctx.run,
          baseUpdatedAt: ctx.baseUpdatedAt,
          baseServerModel: ctx.baseServerModel,
          command,
          fromComposer: opts?.fromComposer,
          onUpdated: () => onUpdatedRef.current(),
        });
      },
    }),
    [engine],
  );

  return {
    engine,
    data,
    live,
    statusAnchorMs,
    hostOnline,
    mode,
    isAuto,
    consolidating,
    thinking,
    canSwitchModel,
    serverModel,
    activeModel,
    activeServiceTier,
    activeEffort,
    submitting: snap.submitting,
    poolSubmitting: snap.poolSubmitting,
    spawningCore: snap.spawningCore,
    pendingContention: snap.pendingContention,
    preemptError: snap.preemptError,
    preemptSuccessSeq: snap.preemptSuccessSeq,
    confirmPreempt,
    dismissContention,
    poolSnapshot,
    poolEventsById,
    resolveLivePoolEvent,
    pendingInboundCount,
    pendingOutboundCount,
    pendingPoolCount,
    olderRuns,
    loadingOlderRun,
    olderRunError,
    nextOlderRun,
    hasMoreUpwardHistory,
    earliestLoadedMs,
    segments,
    allCalls,
    loadNextUpwardHistory,
    loadOlderRunSegment,
    clearOlderRunError: engine.clearOlderRunError,
    actions,
  };
}
