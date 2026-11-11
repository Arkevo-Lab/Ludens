"use client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useLocale, useTranslations } from "@/lib/locale";
import type { Project, RunData } from "@/lib/types";
import type { ReplayOverviewResult } from "@/lib/replay-types";
import { initialSelection, latestGameRun } from "@/lib/initial-selection";
import { workspaceRunEntry } from "@/lib/workspace-run-entry";
import { cleanViewSearchParams, hasSelectedEvidence, latestLiveUrl, liveContext, resolveLiveSelection, type PausedLiveSelection } from "@/lib/live-follow";
import { ReadPoller } from "@/lib/read-poller";
import { analysisRequest, runAnalysisSnapshot, type RunReadSnapshot } from "@/lib/run-analysis-selection";
import { useActivityFeed } from "@/features/live/use-activity-feed";
import { useRetryFocus } from "@/components/use-retry-focus";
import { usePetFollow } from "@/features/pet/pet-follow";
import { consoleViewIds as viewIds, type ConsoleView as View } from "@/shell/console-sidebar";
import type { DiscoveredDriver } from "@/lib/drivers";
import { driverCreationHref } from "@/lib/driver-onboarding";

import { readArchiveJson as json, type ArchiveProgress } from "@/lib/archive-client";

const subscribeLocation = (listener: () => void) => {
  window.addEventListener("popstate", listener);
  return () => window.removeEventListener("popstate", listener);
};
const getLocation = () => window.location.search;
const serverLocation = () => "";

export function useDashboardController() {
  const { t } = useLocale();
  const dt = useTranslations("dashboard");
  const lt = useTranslations("liveContext");
  const search = useSyncExternalStore(
    subscribeLocation,
    getLocation,
    serverLocation,
  );
  const query = new URLSearchParams(search);
  const requestedView = query.get("view");
  const view: View = requestedView && (viewIds as readonly string[]).includes(requestedView) ? requestedView as View : "live";
  const runControls = view === "live" || view === "replay" || view === "perf";
  const [catalogRevision, setCatalogRevision] = useState(0);
  const refreshCatalog = useCallback(() => setCatalogRevision(value => value + 1), []);
  const [projects, setProjects] = useState<Project[]>([]);
  const [catalogReady, setCatalogReady] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState("");
  const catalogFocus = useRetryFocus<HTMLElement>(catalogLoading, catalogError, search);
  const catalogRetryPending = useRef(false);
  const retryCatalog = (control: HTMLButtonElement) => {
    if (catalogLoading || catalogRetryPending.current) return;
    catalogRetryPending.current = true;
    catalogFocus.remember(control);
    refreshCatalog();
  };
  const [verifiedCreationDriver, setVerifiedCreationDriver] = useState<DiscoveredDriver | null>(null);
  useEffect(() => {
    if (view !== "workspaces") setVerifiedCreationDriver(null);
  }, [view]);
  const [loaded, setLoaded] = useState<(RunReadSnapshot & { revision: number }) | null>(
    null,
  );
  const [replayCycles, setReplayCycles] = useState<{ key: string; cycles: RunData["cycles"] } | null>(null);
  const onReplayOverview = useCallback((value: ReplayOverviewResult) => {
    setReplayCycles({ key: JSON.stringify([value.project, value.run]), cycles: value.cycles });
  }, []);
  const [runFailure, setRunFailure] = useState<{ key: string; message: string } | null>(null);
  const [preparing, setPreparing] = useState<{ key: string; progress: ArchiveProgress } | null>(null);
  const [archiveRevision, setArchiveRevision] = useState(0);
  const archiveReady = useCallback(() => setArchiveRevision(value => value + 1), []);
  const [refresh, setRefresh] = useState(true);
  const [pausedSelection, setPausedSelection] = useState<PausedLiveSelection | null>(null);
  const [snapshotRevision, setSnapshotRevision] = useState(0);
  const [latestRequest, setLatestRequest] = useState<{ revision: number; location: string } | null>(null);
  const returnButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const runPoller = useRef<{ reader: ReadPoller; key: string } | null>(null);
  const [runReading, setRunReading] = useState<{ reader: ReadPoller; key: string } | null>(null);
  const runRetryFocus = useRef<{ control: HTMLButtonElement; key: string } | null>(null);
  const runContent = useRef<HTMLElement>(null);
  const automatic = useRef(refresh);
  automatic.current = refresh;
  const pet = usePetFollow();
  const [stopping, setStopping] = useState(false);
  const [panel, setPanel] = useState("trace");
  const [liveJumpTarget, setLiveJumpTarget] = useState<{
    value: string;
    call?: string;
    block?: string;
    image?: string;
    seq: number;
  } | null>(null);
  const [activeLiveSegment, setActiveLiveSegment] = useState("");
  const requested = initialSelection(search, projects);
  const requestedLatest = latestGameRun(projects.find(p => p.id === requested.project));
  const followed = resolveLiveSelection({
    location: search,
    project: requested.project,
    requestedRun: view === "live" ? "" : requested.run,
    requestedEpoch: view === "live" ? "" : requested.epoch,
    latestRun: requestedLatest?.id ?? "",
    refresh,
    archiveRevision,
    paused: view === "live" ? null : pausedSelection,
  });
  const selection = { project: followed.project, run: followed.requestedRun, epoch: followed.epoch };
  const project = projects.find((p) => p.id === selection.project);
  const latest = latestGameRun(project);
  const run = followed.run;
  const effectiveEpoch = view === "live" && !selection.epoch ? "all" : selection.epoch;
  useEffect(() => {
    setLiveJumpTarget(null);
    setActiveLiveSegment("");
  }, [selection.project]);
  // A URL change is intentional navigation even while paused. Latch its new default
  // before the next catalog poll can replace it; an empty workspace stays empty too.
  if (view !== "live" && !refresh && catalogReady && !followed.frozen) {
    setPausedSelection({ location: search, project: selection.project, run, requestedRun: selection.run, epoch: selection.epoch, archiveRevision });
  }
  const entry = workspaceRunEntry({ catalogReady, catalogError, project, run });
  const scopeKey = selection.project + "/" + run + "/" + effectiveEpoch;
  const beforeCall = query.get("beforeCall") ?? "";
  const requestedCall = query.get("call") ?? "";
  const selectedImage = query.get("image") ?? undefined;
  const readScope = { project: selection.project, workspace: project?.workspace ?? "", run, epoch: effectiveEpoch, beforeCall };
  const key = JSON.stringify([scopeKey, readScope.workspace, beforeCall, requestedCall, selectedImage]);
  const error = runFailure?.key === key ? runFailure.message : "";
  const analysis = runAnalysisSnapshot(loaded, key, readScope);
  const analysingRun = view === "perf";
  const data = analysingRun ? analysis.overview : loaded?.key === key ? loaded.data : null;
  const cycles = view === "replay"
    ? replayCycles?.key === JSON.stringify([selection.project, run]) ? replayCycles.cycles : []
    : data?.cycles ?? [];
  const activity = useActivityFeed({ project: selection.project, run, epoch: effectiveEpoch || undefined,
    enabled: view === "live", refresh, archiveRevision, resetRevision: snapshotRevision, selectedBlock: query.get("block") ?? undefined,
    continuousStream: view === "live" });
  const call = analysingRun ? analysisRequest(analysis.detail, requestedCall)
    : data?.selectedCall ?? data?.calls.find((c) => c.id === requestedCall) ?? data?.calls.at(-1);
  const navigateUrl = useCallback((target: string, options?: { replace?: boolean }) => {
    const url = new URL(target, window.location.href);
    if (url.origin !== window.location.origin) return;
    const next = url.pathname + url.search;
    if (next === window.location.pathname + window.location.search) return;
    if (options?.replace) {
      window.history.replaceState(null, "", next);
    } else {
      window.history.pushState(null, "", next);
    }
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, []);
  const navigate = (patch: Record<string, string | null>, options?: { replace?: boolean }) => {
    const rawParams = new URLSearchParams(window.location.search);
    const nextView = patch.view ?? rawParams.get("view") ?? "live";
    const params =
      patch.view && patch.view !== view
        ? cleanViewSearchParams(rawParams, nextView, { project: selection.project, latestRunId: latest?.id })
        : rawParams;
    for (const [name, value] of Object.entries(patch))
      value ? params.set(name, value) : params.delete(name);
    navigateUrl("/?" + params.toString(), options);
  };
  const createWithDriver = (driver: DiscoveredDriver) => {
    setVerifiedCreationDriver(driver);
    navigateUrl(driverCreationHref(driver.spec));
  };
  const closeCreateIntent = () => {
    setVerifiedCreationDriver(null);
    const params = new URLSearchParams(window.location.search);
    params.delete("create"); params.delete("driverPackage");
    window.history.replaceState(null, "", "/?" + params.toString());
    window.dispatchEvent(new PopStateEvent("popstate"));
  };
  const toggleRefresh = () => {
    if (refresh) setPausedSelection({ location: search, project: selection.project, run, requestedRun: selection.run, epoch: selection.epoch, archiveRevision });
    setRefresh(value => !value);
  };
  const returnToLatest = () => {
    const target = latestLiveUrl(selection.project);
    const revision = snapshotRevision + 1;
    // The explicit revision matters when the URL is already clean and polling is off.
    setSnapshotRevision(revision);
    setLiveJumpTarget(null);
    returnFocus.current = document.activeElement === returnButton.current;
    setLatestRequest({ revision, location: target.slice(1) });
    setRunFailure(null);
    if (!refresh) setPausedSelection({ location: target.slice(1), project: selection.project, run: latest?.id ?? "", requestedRun: "", epoch: "", archiveRevision });
    navigateUrl(target);
  };
  const viewLink = (id: View) => {
    const params = cleanViewSearchParams(query, id, {
      project: selection.project,
      latestRunId: latest?.id,
    });
    return "?" + params.toString();
  };
  const pinned = {
    project: selection.project,
    run,
    epoch: data?.selectedEpoch ?? selection.epoch,
  };
  const selectCall = (id: string) =>
    navigate({ ...pinned, call: id, image: null, block: null });
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      setCatalogLoading(true);
      try {
        const value = await json<Project[]>("/api/catalog?includeEmpty=1", controller.signal);
        if (controller.signal.aborted) return;
        setProjects(value);
        setCatalogError("");
      } catch (e) {
        if (!controller.signal.aborted) setCatalogError(String(e));
      } finally {
        if (!controller.signal.aborted) {
          catalogRetryPending.current = false;
          setCatalogReady(true);
          setCatalogLoading(false);
          timer = setTimeout(load, 10000);
        }
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [catalogRevision]);
  useEffect(() => {
    if (view === "workspaces" || view === "baseware" || view === "settings" || view === "dev" || view === "replay" || view === "docs" || view === "caps" || view === "perception" || !selection.project || !run) return;
    const params = new URLSearchParams({
      project: selection.project,
      run,
      ...(effectiveEpoch ? { epoch: effectiveEpoch } : {}),
      ...(beforeCall ? { beforeCall } : {}),
      ...(requestedCall ? { call: requestedCall } : {}),
      ...(selectedImage ? { image: selectedImage } : {}),
    });
    const reader = new ReadPoller(async signal => {
      setRunReading({ reader, key });
      try {
        const next = await json<RunData>(
          "/api/run?" + params,
          signal,
          progress => setPreparing({ key, progress }),
        );
        if (signal.aborted) return 2500;
        setLoaded({ key, scope: readScope, revision: snapshotRevision, data: next });
        setPreparing(null);
        setRunFailure(null);
      } catch (e) {
        if (!signal.aborted) setRunFailure({ key, message: String(e) });
      } finally {
        if (!signal.aborted && runPoller.current?.reader === reader) setRunReading(null);
      }
      return 2500;
    }, automatic.current);
    runPoller.current = { reader, key };
    void reader.readOnce();
    return () => {
      reader.dispose();
      if (runPoller.current?.reader === reader) runPoller.current = null;
    };
  }, [
    selection.project,
    run,
    effectiveEpoch,
    beforeCall,
    requestedCall,
    selectedImage,
    key,
    view,
    followed.archiveRevision,
    snapshotRevision,
  ]);
  useEffect(() => { runPoller.current?.reader.setEnabled(refresh); }, [refresh]);
  const retryingRun = runReading?.key === key && runReading.reader === runPoller.current?.reader;
  const refreshRun = useCallback(() => {
    void runPoller.current?.reader.readOnce();
  }, []);
  const retryRun = (control: HTMLButtonElement) => {
    const pending = runPoller.current;
    if (!pending || pending.key !== key || retryingRun) return;
    runRetryFocus.current = (view === "live" || (analysingRun && !data)) && document.activeElement === control ? { control, key } : null;
    void pending.reader.readOnce();
  };
  useEffect(() => {
    const release = (event: Event) => {
      if (!(event.target instanceof Node) || !runRetryFocus.current?.control.contains(event.target)) runRetryFocus.current = null;
    };
    document.addEventListener("focusin", release);
    document.addEventListener("pointerdown", release);
    return () => { document.removeEventListener("focusin", release); document.removeEventListener("pointerdown", release); };
  }, []);
  useEffect(() => {
    const pending = runRetryFocus.current;
    if (!pending) return;
    if ((view !== "live" && !analysingRun) || pending.key !== key) { runRetryFocus.current = null; return; }
    if (retryingRun) return;
    runRetryFocus.current = null;
    if (!error && !pending.control.isConnected && document.activeElement === document.body)
      runContent.current?.focus({ preventScroll: true });
  }, [view, analysingRun, key, error, retryingRun]);
  const live = data?.live;
  const isCurrent =
    !!data && live?.runId === data.run && data.selectedEpoch === live?.epoch;
  const auto = isCurrent && live?.connected && live.mode === "auto";
  const returned =
    !!data &&
    live?.runId === data.run &&
    live.connected &&
    live.mode === "manual" &&
    data.selectedEpoch === data.cycles.at(-1)?.epoch;
  const phase = auto ? data?.livePhase : null;
  const status =
    phase?.label ??
    (auto
      ? dt("statusTakingOver")
      : data
        ? returned || (isCurrent && live?.connected)
          ? dt("statusReturned")
          : dt("statusReplay")
        : dt("statusWaiting"));
  const context = data ? liveContext({
    run: data.run,
    latestRun: latest?.id ?? "",
    selectedEpoch: data.selectedEpoch,
    latestEpoch: data.cycles.at(-1)?.epoch ?? null,
    selectedEvidence: hasSelectedEvidence(search),
    historicalLog: activity.historical,
    live: data.live,
  }) : null;
  const latestReadsDone = loaded?.key === key && loaded.revision === snapshotRevision
    && activity.loadedRevision === snapshotRevision && !activity.loading;
  const latestScopeMatches = activity.scope?.project === selection.project && activity.scope?.runId === run
    && (effectiveEpoch === "all" ? activity.scope?.epoch === null : activity.scope?.epoch === data?.selectedEpoch);
  const latestReady = latestReadsDone && latestScopeMatches;
  const clearLiveJumpTarget = useCallback(() => {
    setLiveJumpTarget(null);
    setActiveLiveSegment("");
  }, []);
  const jumpToLiveSegment = useCallback((value: string) => {
    setActiveLiveSegment(value);
    setLiveJumpTarget({ value, seq: Date.now() });
    if (selection.run || selection.epoch || hasSelectedEvidence(search)) {
      navigate({
        run: null,
        epoch: null,
        beforeCall: null,
        call: null,
        block: null,
        image: null,
        at: null,
        replayItem: null,
        replayRecord: null,
        replaySequence: null,
      }, { replace: true });
    }
  }, [selection.run, selection.epoch, search]);
  // Convert any explicit ?run= / ?epoch= deep-link on Live view into an in-stream smooth jump
  // so Live view always remains a single continuous workspace session stream.
  useEffect(() => {
    if (view !== "live" || !catalogReady || !latest) return;
    const rawRun = query.get("run") ?? "";
    const rawEpoch = query.get("epoch") ?? "";
    if (!rawRun && (!rawEpoch || rawEpoch === "all")) return;
    const targetRun = rawRun || latest.id;
    const jumpValue =
      rawEpoch && rawEpoch !== "all"
        ? `${targetRun}#${rawEpoch}`
        : targetRun !== latest.id
          ? targetRun
          : "";
    setActiveLiveSegment(jumpValue);
    setLiveJumpTarget({
      value: jumpValue,
      call: requestedCall || undefined,
      block: query.get("block") || undefined,
      image: selectedImage,
      seq: Date.now(),
    });
    navigate({ run: null, epoch: null, call: null, block: null, image: null }, { replace: true });
  }, [view, catalogReady, latest?.id, search]);
  const latestRequested = latestRequest?.revision === snapshotRevision && latestRequest.location === search;
  const latestScopeChanged = latestRequested && latestReadsDone && !latestScopeMatches
    && !error && !activity.error;
  const latestFailed = latestRequested && !!(error || activity.error || latestScopeChanged);
  const returningLatest = latestRequested && !latestFailed
    && !latestReady;
  useEffect(() => {
    if (latestRequest && !latestRequested) {
      returnFocus.current = false;
      setLatestRequest(null);
    } else if (latestRequested && (latestReady || latestFailed)) {
      if (returnFocus.current && (document.activeElement === document.body || document.activeElement === returnButton.current))
        returnButton.current?.focus({ preventScroll: true });
      returnFocus.current = false;
      if (!latestFailed) setLatestRequest(null);
    }
  }, [latestRequest, latestRequested, latestReady, latestFailed]);
  useEffect(() => {
    if (!latestRequested) return;
    const preserveUserFocus = (event: Event) => {
      if (event.target !== returnButton.current && event.target !== document.body)
        returnFocus.current = false;
    };
    document.addEventListener("focusin", preserveUserFocus);
    document.addEventListener("pointerdown", preserveUserFocus);
    return () => {
      document.removeEventListener("focusin", preserveUserFocus);
      document.removeEventListener("pointerdown", preserveUserFocus);
    };
  }, [latestRequested]);
  const contextTitles = { latest: "titleLatest", run: "titleRun", epoch: "titleEpoch", evidence: "titleEvidence", log: "titleLog" };
  const hostLabels = { auto: "hostAuto", manual: "hostManual", disconnected: "hostDisconnected", unavailable: "hostUnavailable", historical: "hostHistorical" };
  const observedStatus = context ? lt(hostLabels[context.host]) : status;
  const staleStatus = !refresh || !!error || returningLatest || latestFailed;
  const stop = async () => {
    if (!data?.controlAllowed || !auto) return;
    setStopping(true);
    try {
      const response = await fetch("/api/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: data.project,
          run: data.run,
          epoch: data.selectedEpoch,
          action: "off",
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? dt("handoverFailed"));
      const next = await json<RunData>(
        "/api/run?" +
          new URLSearchParams({
            project: data.project,
            run: data.run,
            ...(data.selectedEpoch ? { epoch: data.selectedEpoch } : {}),
            ...(beforeCall ? { beforeCall } : {}),
            ...(requestedCall ? { call: requestedCall } : {}),
            ...(selectedImage ? { image: selectedImage } : {}),
          }),
      );
      setLoaded({ key, scope: readScope, revision: snapshotRevision, data: next });
      setRunFailure(null);
    } catch (e) {
      setRunFailure({ key, message: String(e) });
    } finally {
      setStopping(false);
    }
  };
  const s = data?.summary;
  const pageRange = data?.calls.length ? t("runAnalysis.pageRange")
    .replace("{first}", String(data.paging.firstIndex)).replace("{last}", String(data.paging.lastIndex))
    .replace("{total}", String(data.paging.totalCalls)) : dt("pageEmpty");
  const hasTelemetry = data?.telemetry.sources.some(
    (source) => source.component !== "unlabelled",
  );
  return {
    t,
    dt,
    lt,
    search,
    query,
    view,
    runControls,
    projects,
    catalogReady,
    catalogError,
    catalogLoading,
    project,
    latest,
    run,
    selection,
    entry,
    scopeKey,
    beforeCall,
    requestedCall,
    selectedImage,
    key,
    error,
    analysis,
    analysingRun,
    data,
    cycles,
    activity,
    call,
    pet,
    refresh,
    panel,
    setPanel,
    stopping,
    auto,
    status,
    observedStatus,
    staleStatus,
    phase,
    context,
    contextTitles,
    latestRequested,
    returningLatest,
    latestScopeChanged,
    latestFailed,
    archiveRevision,
    archiveReady,
    preparing,
    pageRange,
    hasTelemetry,
    setPausedSelection,
    setSnapshotRevision,
    refreshRun,
    refreshCatalog,
    s,
    verifiedCreationDriver,
    navigateUrl,
    navigate,
    createWithDriver,
    closeCreateIntent,
    toggleRefresh,
    returnToLatest,
    viewLink,
    pinned,
    selectCall,
    onReplayOverview,
    retryCatalog,
    retryingRun,
    retryRun,
    stop,
    runContent,
    catalogFocus,
    returnButton,
    liveJumpTarget,
    activeLiveSegment,
    setActiveLiveSegment,
    clearLiveJumpTarget,
    jumpToLiveSegment,
  };
}
