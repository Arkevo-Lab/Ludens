"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  ACTIVITY_LIVE_SIZE,
  ACTIVITY_PAGE_SIZE,
  ACTIVITY_WINDOW_SIZE,
  acceptsScope,
  activityScopeParams,
  mergeActivity,
  newerBlock,
  sameScope,
  type ActivityBlock,
  type ActivityFilter,
  type ActivityScope,
} from "@/features/live/activity-feed-model";
import {
  activityRpcParamsFromSearchParams,
  getLiveSessionEngine,
} from "@/features/live/live-session-store";
import { ActivityChangesClient } from "@ludens/protocol/activity";
import { useLudensEvent, useOptionalLudensRpc } from "@/lib/ludens-rpc";
import { useTranslations } from "@/lib/locale";

interface FeedState {
  resetRevision: number;
  loadedRevision: number | null;
  scope: ActivityScope | null;
  generation: string | null;
  snapshot: number;
  blocks: ActivityBlock[];
  selected?: ActivityBlock;
  selectionReady: boolean;
  before: string | null;
  /** `at` of the oldest block delivered by server history paging: the true floor of the loaded window,
   *  unlike `blocks[0]`, which may be an older block re-delivered by a late live update. */
  historyFloorAt: string | null;
  hasMore: boolean;
  total: number;
  historical: boolean;
  loading: boolean;
  loadingOlder: boolean;
  error: string;
}

const emptyState = (resetRevision = 0): FeedState => ({
  resetRevision,
  loadedRevision: null,
  scope: null,
  generation: null,
  snapshot: 0,
  blocks: [],
  selectionReady: false,
  before: null,
  historyFloorAt: null,
  hasMore: false,
  total: 0,
  historical: false,
  loading: true,
  loadingOlder: false,
  error: "",
});

const scopeParams = activityScopeParams;

export function useActivityFeed(options: {
  project: string;
  run: string;
  epoch?: string;
  enabled: boolean;
  refresh: boolean;
  selectedBlock?: string;
  archiveRevision?: number;
  /** A global return-to-current action clears every log filter and obtains a fresh snapshot. */
  resetRevision?: number;
  /** Keep live tail active while prepending older history in a unified continuous session stream. */
  continuousStream?: boolean;
}) {
  const {
    project,
    run,
    epoch,
    enabled,
    refresh,
    selectedBlock,
    archiveRevision,
    resetRevision = 0,
    continuousStream = false,
  } = options;
  const t = useTranslations("activityFeed");
  const scopeChangedError = useRef(t("scopeChangedError"));
  scopeChangedError.current = t("scopeChangedError");

  const [filters, setFilters] = useState({ revision: resetRevision, filter: "all" as ActivityFilter, query: "" });
  const activeFilters =
    filters.revision === resetRevision ? filters : { revision: resetRevision, filter: "all" as ActivityFilter, query: "" };
  const { filter, query } = activeFilters;
  const [debounced, setDebounced] = useState({ revision: resetRevision, query: "" });
  const search = debounced.revision === resetRevision ? debounced.query : "";

  const setFilter = useCallback(
    (value: ActivityFilter) =>
      setFilters(previous => ({
        ...(previous.revision === resetRevision
          ? previous
          : { revision: resetRevision, filter: "all" as ActivityFilter, query: "" }),
        filter: value,
      })),
    [resetRevision],
  );
  const setQuery = useCallback(
    (value: string) =>
      setFilters(previous => ({
        ...(previous.revision === resetRevision
          ? previous
          : { revision: resetRevision, filter: "all" as ActivityFilter, query: "" }),
        query: value,
      })),
    [resetRevision],
  );

  useEffect(() => {
    const timer = setTimeout(() => setDebounced({ revision: resetRevision, query: query.trim() }), 200);
    return () => clearTimeout(timer);
  }, [query, resetRevision]);

  // Archive completion is automatic; defer it while viewing a paused snapshot.
  const followedArchive = useRef(archiveRevision);
  if (refresh) followedArchive.current = archiveRevision;
  const activeArchiveRevision = followedArchive.current ?? 0;

  // ── 1. Primary Unfiltered Continuous Live Session Store (Monotonic + Warm across View Switches) ──
  const rpcCtx = useOptionalLudensRpc();
  const isFilteredMode = filter !== "all" || search !== "";
  const useSessionEngine = continuousStream && !isFilteredMode;
  const engine = useMemo(() => getLiveSessionEngine(project, rpcCtx), [project, rpcCtx]);
  engine.setScopeChangedMessage(scopeChangedError.current);

  useEffect(() => {
    engine.setRpc(rpcCtx);
  }, [engine, rpcCtx]);

  useLudensEvent(
    ["run", "observation", "core", "eventPool"],
    () => {
      engine.nudgeChanges();
    },
    {
      enabled: Boolean(continuousStream && !isFilteredMode && enabled && refresh && run),
      workspaceId: project,
      runId: run,
    },
  );

  const reconnectGen = rpcCtx?.snapshot.reconnectGeneration ?? 0;
  useEffect(() => {
    if (reconnectGen > 0 && continuousStream && !isFilteredMode && enabled && run) {
      engine.nudgeChanges();
    }
  }, [continuousStream, enabled, engine, isFilteredMode, reconnectGen, run]);

  const engineSnap = useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getSnapshot);

  useEffect(() => {
    if (!continuousStream) return;
    // Keep the monotonic session engine synced (pausing pollers cleanly when `enabled` is false or filtered mode is active,
    // NEVER wiping cached blocks on view switch or search).
    engine.syncStream({
      run,
      epoch,
      enabled: enabled && !isFilteredMode,
      refresh: refresh && !isFilteredMode,
      archiveRevision: activeArchiveRevision,
      resetRevision,
      selectedBlock: !isFilteredMode ? selectedBlock : undefined,
    });
    return () => {
      engine.syncStream({
        run,
        epoch,
        enabled: false,
        refresh: false,
        archiveRevision: activeArchiveRevision,
        resetRevision,
        selectedBlock: undefined,
      });
    };
  }, [
    engine,
    continuousStream,
    run,
    epoch,
    enabled,
    refresh,
    isFilteredMode,
    activeArchiveRevision,
    resetRevision,
    selectedBlock,
  ]);

  // ── 2. Isolated Bounded Server Search / Non-Continuous Stream State (never mutates `engine` cache) ──
  const boundedEnabled = enabled && (!continuousStream || isFilteredMode);
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<FeedState>(() => emptyState(resetRevision));
  const current = useRef(state);
  const selection = useRef(selectedBlock);
  selection.current = selectedBlock;
  const criteria = useRef({ filter, query: search });
  criteria.current = { filter, query: search };
  const historyRequest = useRef<AbortController | null>(null);
  const selectionRequest = useRef<AbortController | null>(null);
  const historyLoading = useRef(false);
  const boundedNudgeRef = useRef<(() => void) | null>(null);
  const rpcRef = useRef(rpcCtx);
  rpcRef.current = rpcCtx;
  const automatic = useRef(refresh);
  automatic.current = refresh;

  const update = useCallback((change: (previous: FeedState) => FeedState) => {
    current.current = change(current.current);
    setState(current.current);
  }, []);

  useEffect(() => {
    if (!boundedEnabled || !project || !run) {
      boundedNudgeRef.current = null;
      update(() => emptyState(resetRevision));
      return;
    }
    update(() => emptyState(resetRevision));
    if (!rpcCtx) {
      update(value => ({ ...value, loading: false, error: "RPC client is unavailable" }));
      return;
    }

    const reader = new ActivityChangesClient({
      project,
      run,
      epoch,
      limit: ACTIVITY_PAGE_SIZE,
      reader: (req, signal) =>
        rpcCtx.call(
          "activity/get",
          {
            project: req.project,
            ...(req.run ? { run: req.run } : {}),
            ...(req.epoch ? { epoch: req.epoch } : {}),
            query: {
              mode: "changes",
              ...(req.limit !== undefined ? { limit: req.limit } : {}),
              ...(req.cursor !== undefined ? { cursor: req.cursor } : {}),
            },
          },
          { signal },
        ),
    });

    let disposed = false;
    let inFlight = false;
    let pending = false;
    let activeController: AbortController | null = null;

    const drainChanges = async () => {
      if (disposed) return;
      if (inFlight) {
        pending = true;
        return;
      }
      inFlight = true;
      try {
        while (!disposed) {
          pending = false;
          const controller = new AbortController();
          activeController = controller;
          let more = false;
          try {
            const result = await reader.read(controller.signal);
            if (controller.signal.aborted || disposed) break;
            more = result.hasMore;
            const previous = current.current;
            const reset =
              result.mode === "snapshot" ||
              !sameScope(previous.scope, result.scope) ||
              previous.generation !== result.projection.generation;
            const merged = mergeActivity(reset ? [] : previous.blocks, result.blocks, {
              ...criteria.current,
              append: reset || !previous.historical,
              keep: previous.historical && !reset ? "oldest" : "latest",
              limit: ACTIVITY_WINDOW_SIZE,
            });
            update(value => ({
              ...(reset ? emptyState(resetRevision) : value),
              scope: reset ? result.scope : value.scope,
              generation: result.projection.generation,
              snapshot: value.snapshot + (reset ? 1 : 0),
              blocks: merged,
              error: "",
              ...(selection.current
                ? {
                    selected: result.blocks
                      .filter(block => block.id === selection.current)
                      .reduce<ActivityBlock | undefined>(
                        (block, next) => newerBlock(block, next),
                        reset ? undefined : value.selected,
                      ),
                  }
                : {}),
            }));
            result.acknowledge();
            if (!reset && !previous.historical && merged.length > ACTIVITY_LIVE_SIZE && !historyLoading.current) {
              setReload(value => value + 1);
            }
          } catch (error) {
            if (!controller.signal.aborted && !disposed) {
              update(value => ({ ...value, loading: false, error: String(error) }));
            }
            break;
          }
          if (!more && !pending) break;
        }
      } finally {
        inFlight = false;
        activeController = null;
      }
    };

    boundedNudgeRef.current = () => {
      void drainChanges();
    };
    void drainChanges();

    return () => {
      disposed = true;
      if (boundedNudgeRef.current) boundedNudgeRef.current = null;
      activeController?.abort();
      historyRequest.current?.abort();
      selectionRequest.current?.abort();
      historyLoading.current = false;
    };
  }, [project, run, epoch, boundedEnabled, activeArchiveRevision, resetRevision, rpcCtx, update]);

  useLudensEvent(
    ["run", "observation", "core"],
    () => {
      if (boundedEnabled && refresh) {
        boundedNudgeRef.current?.();
      }
    },
    {
      enabled: Boolean(boundedEnabled && refresh && project && run),
      workspaceId: project,
      runId: run,
    },
  );

  useEffect(() => {
    if (boundedEnabled && reconnectGen > 0) {
      boundedNudgeRef.current?.();
    }
  }, [boundedEnabled, reconnectGen]);

  const scope = state.scope;
  const generation = state.generation;

  useEffect(() => {
    if (
      !boundedEnabled ||
      !scope ||
      !acceptsScope(scope, project, run, epoch) ||
      !sameScope(scope, current.current.scope) ||
      generation !== current.current.generation
    ) {
      return;
    }
    const controller = new AbortController();
    historyRequest.current?.abort();
    historyRequest.current = controller;
    historyLoading.current = true;
    const isCurrentRequest = () =>
      !controller.signal.aborted &&
      historyRequest.current === controller &&
      sameScope(scope, current.current.scope) &&
      generation === current.current.generation;
    update(value => ({ ...value, loading: true, loadingOlder: false, error: "" }));
    const params = scopeParams(scope);
    params.set("mode", "history");
    params.set("kind", filter);
    params.set("q", search);
    params.set("limit", String(ACTIVITY_PAGE_SIZE));
    const rpc = rpcRef.current;
    if (!rpc) {
      update(value => ({ ...value, loading: false, error: "RPC client is unavailable" }));
      return;
    }
    void rpc
      .call("activity/get", activityRpcParamsFromSearchParams(params), { signal: controller.signal })
      .then(result => {
        if (!isCurrentRequest()) return;
        if (!sameScope(result.scope, scope) || result.projection.generation !== generation) {
          update(value => ({ ...value, loading: false, error: scopeChangedError.current }));
          return;
        }
        update(value => ({
          ...value,
          blocks: mergeActivity(
            result.blocks,
            value.blocks.filter(
              block => block.revision > result.projection.revision || block.status === "running",
            ),
            {
              filter,
              query: search,
              append: true,
              keep: "latest",
              limit: ACTIVITY_WINDOW_SIZE,
            },
          ),
          before: result.before ?? null,
          historyFloorAt: result.blocks[0]?.at ?? null,
          hasMore: result.hasMore,
          total: result.total ?? 0,
          historical: false,
          loading: false,
          loadedRevision: value.resetRevision,
          error: "",
        }));
      })
      .catch(error => {
        if (isCurrentRequest()) update(value => ({ ...value, loading: false, error: String(error) }));
      })
      .finally(() => {
        if (historyRequest.current === controller) historyLoading.current = false;
      });
    return () => controller.abort();
  }, [boundedEnabled, project, run, epoch, scope, generation, state.snapshot, filter, search, reload, update]);

  useEffect(() => {
    if (!boundedEnabled) return;
    update(value => ({ ...value, selected: undefined, selectionReady: false }));
    if (
      !scope ||
      !selectedBlock ||
      !acceptsScope(scope, project, run, epoch) ||
      !sameScope(scope, current.current.scope) ||
      generation !== current.current.generation
    ) {
      return;
    }
    const controller = new AbortController();
    selectionRequest.current = controller;
    const isCurrentRequest = () =>
      !controller.signal.aborted &&
      selectionRequest.current === controller &&
      sameScope(scope, current.current.scope) &&
      generation === current.current.generation;
    const params = scopeParams(scope);
    params.set("mode", "block");
    params.set("id", selectedBlock);
    const rpc = rpcRef.current;
    if (!rpc) {
      update(value => ({ ...value, selectionReady: true, error: "RPC client is unavailable" }));
      return;
    }
    void rpc
      .call("activity/get", activityRpcParamsFromSearchParams(params), { signal: controller.signal })
      .then(result => {
        if (!isCurrentRequest()) return;
        if (!sameScope(result.scope, scope) || result.projection.generation !== generation) {
          update(value => ({ ...value, selectionReady: true, error: scopeChangedError.current }));
          return;
        }
        update(value => ({
          ...value,
          selected: result.blocks[0]
            ? newerBlock(
                value.blocks.find(block => block.id === selectedBlock) ??
                  (value.selected?.id === selectedBlock ? value.selected : undefined),
                result.blocks[0],
              )
            : undefined,
          selectionReady: true,
        }));
      })
      .catch(error => {
        if (isCurrentRequest()) update(value => ({ ...value, selectionReady: true, error: String(error) }));
      });
    return () => {
      controller.abort();
      if (selectionRequest.current === controller) selectionRequest.current = null;
    };
  }, [boundedEnabled, project, run, epoch, scope, generation, selectedBlock, update]);

  const boundedEarlier = useCallback(async () => {
    const previous = current.current;
    if (!previous.scope || !previous.before || historyLoading.current) return;
    const controller = new AbortController();
    historyRequest.current?.abort();
    historyRequest.current = controller;
    historyLoading.current = true;
    const isCurrentRequest = () =>
      !controller.signal.aborted &&
      historyRequest.current === controller &&
      sameScope(previous.scope, current.current.scope) &&
      previous.generation === current.current.generation;
    update(value => ({ ...value, loadingOlder: true, error: "" }));
    const params = scopeParams(previous.scope);
    params.set("mode", "history");
    params.set("kind", filter);
    params.set("q", search);
    params.set("before", previous.before);
    params.set("limit", String(ACTIVITY_PAGE_SIZE));
    try {
      const rpc = rpcRef.current;
      if (!rpc) {
        throw new Error("RPC client is unavailable");
      }
      const result = await rpc.call(
        "activity/get",
        activityRpcParamsFromSearchParams(params),
        { signal: controller.signal },
      );
      if (!isCurrentRequest()) return;
      if (!sameScope(result.scope, previous.scope) || result.projection.generation !== previous.generation) {
        update(value => ({ ...value, loadingOlder: false, error: scopeChangedError.current }));
        return;
      }
      update(value => ({
        ...value,
        blocks: mergeActivity(value.blocks, result.blocks, {
          filter,
          query: search,
          append: true,
          keep: "oldest",
          limit: ACTIVITY_WINDOW_SIZE,
        }),
        before: result.before ?? null,
        historyFloorAt: result.blocks[0]?.at ?? value.historyFloorAt,
        hasMore: result.hasMore,
        total: result.total ?? value.total,
        historical: true,
        loadingOlder: false,
      }));
    } catch (error) {
      if (isCurrentRequest()) update(value => ({ ...value, loadingOlder: false, error: String(error) }));
    } finally {
      if (historyRequest.current === controller) historyLoading.current = false;
    }
  }, [filter, search, update]);

  const sessionLatest = useCallback(() => {
    engine.reconcileNow();
  }, [engine]);

  if (useSessionEngine) {
    const targetMatches =
      engineSnap.targetRun === run && (engineSnap.targetEpoch ?? "") === (epoch ?? "");
    const currentRevision = engineSnap.resetRevision === resetRevision;
    const valid =
      targetMatches &&
      currentRevision &&
      Boolean(engineSnap.scope && acceptsScope(engineSnap.scope, project, run, epoch));
    return {
      resetRevision: engineSnap.resetRevision,
      loadedRevision: targetMatches ? engineSnap.loadedRevision : null,
      scope: targetMatches ? engineSnap.scope : null,
      generation: targetMatches ? engineSnap.generation : null,
      snapshot: engineSnap.snapshotCount,
      blocks: valid ? engineSnap.blocks : [],
      selected: valid ? engineSnap.selected : undefined,
      selectionReady: valid ? engineSnap.selectionReady : false,
      before: valid ? engineSnap.before : null,
      historyFloorAt: valid ? engineSnap.historyFloorAt : null,
      hasMore: valid ? engineSnap.hasMore : false,
      total: valid ? engineSnap.total : 0,
      historical: false,
      loading: !run ? false : !targetMatches || !currentRevision || engineSnap.loading || (!valid && !engineSnap.error),
      loadingOlder: targetMatches ? engineSnap.loadingOlder : false,
      error: targetMatches && currentRevision ? engineSnap.error : "",
      filter,
      query,
      setFilter,
      setQuery,
      earlier: engine.loadEarlierCurrentRun,
      latest: sessionLatest,
    };
  }

  const currentRevision = state.resetRevision === resetRevision;
  const valid = currentRevision && scope && acceptsScope(scope, project, run, epoch);
  return {
    ...state,
    loading: !currentRevision || state.loading || (!valid && !state.error),
    error: currentRevision ? state.error : "",
    blocks: valid ? state.blocks : [],
    selected: valid ? state.selected : undefined,
    filter,
    query,
    setFilter,
    setQuery,
    earlier: boundedEarlier,
    resetRevision,
    latest: () => setReload(value => value + 1),
  };
}

export type ActivityFeedData = ReturnType<typeof useActivityFeed>;
