import type { LiveStatus } from "./types";

/** The implicit run is a snapshot while paused; explicit navigation starts a new one. */
export interface PausedLiveSelection {
  location: string;
  project: string;
  run: string;
  requestedRun: string;
  epoch: string;
  archiveRevision: number;
}

export function resolveLiveSelection(options: {
  location: string;
  project: string;
  requestedRun: string;
  requestedEpoch: string;
  latestRun: string;
  refresh: boolean;
  archiveRevision: number;
  paused: PausedLiveSelection | null;
}) {
  const { paused } = options;
  const frozen = !options.refresh && paused?.location === options.location;
  return {
    project: frozen ? paused.project : options.project,
    requestedRun: frozen ? paused.requestedRun : options.requestedRun,
    epoch: frozen ? paused.epoch : options.requestedEpoch,
    run: frozen ? paused.run : options.requestedRun || options.latestRun,
    archiveRevision: frozen ? paused.archiveRevision : options.archiveRevision,
    frozen,
  };
}

/** Start from a clean URL so evidence and replay parameters cannot leak. */
export function latestLiveUrl(project: string) {
  return "/?" + new URLSearchParams({ view: "live", project });
}

export function hasSelectedEvidence(search: string) {
  const query = new URLSearchParams(search);
  return ["call", "beforeCall", "block", "image", "at"].some(key => query.has(key));
}

const WORKSPACE_SCOPED_VIEWS = new Set(["live", "replay", "perf", "caps", "perception", "baseware"]);
const RUN_SCOPED_VIEWS = new Set(["live", "replay", "perf"]);

/**
 * Scrub view-local URL parameters when switching console views so Replay timestamps/evidence
 * never leak into Live/Perf (or vice versa) and workspace context stays explicit.
 */
export function cleanViewSearchParams(
  search: string | URLSearchParams,
  targetView: string,
  options?: { project?: string; latestRunId?: string },
): URLSearchParams {
  const params = new URLSearchParams(search);
  params.set("view", targetView);

  if (WORKSPACE_SCOPED_VIEWS.has(targetView) && options?.project && !params.get("project")) {
    params.set("project", options.project);
  }

  if (!RUN_SCOPED_VIEWS.has(targetView)) {
    params.delete("run");
    params.delete("epoch");
  }

  if (targetView !== "replay") {
    params.delete("at");
    params.delete("replayItem");
    params.delete("replayRecord");
    params.delete("replaySequence");
    if (params.get("epoch") === "all") {
      params.delete("epoch");
    }
  }

  if (
    targetView === "live" &&
    options?.latestRunId &&
    params.get("run") === options.latestRunId &&
    !params.get("epoch")
  ) {
    params.delete("run");
  }

  if (targetView !== "live" && targetView !== "perf") {
    params.delete("call");
    params.delete("beforeCall");
    params.delete("block");
    params.delete("image");
  }

  if (targetView !== "perf") params.delete("perfTab");
  if (targetView !== "perception") params.delete("studioTab");
  if (targetView !== "workspaces") {
    params.delete("create");
    params.delete("driverPackage");
  }
  if (targetView !== "docs") {
    params.delete("doc");
    params.delete("docLang");
    params.delete("docAnchor");
  }

  return params;
}

export type LiveContextKind = "latest" | "run" | "epoch" | "evidence" | "log";
export type ObservedHost = "auto" | "manual" | "disconnected" | "unavailable" | "historical";

export function liveContext(options: {
  run: string;
  latestRun: string;
  selectedEpoch: string | null;
  latestEpoch: string | null;
  selectedEvidence: boolean;
  historicalLog: boolean;
  live: LiveStatus | null;
}) {
  const oldRun = !!options.latestRun && options.run !== options.latestRun;
  const oldEpoch = !!options.latestEpoch && options.selectedEpoch !== options.latestEpoch;
  const kind: LiveContextKind = oldRun ? "run" : oldEpoch ? "epoch"
    : options.selectedEvidence ? "evidence" : options.historicalLog ? "log" : "latest";
  const live = options.live;
  let host: ObservedHost = "unavailable";
  if (oldRun || oldEpoch) host = "historical";
  else if (live?.runId === options.run) {
    if (!live.connected) host = "disconnected";
    // A returned/manual host may no longer have an active epoch.
    else if (live.mode === "manual") host = "manual";
    else if (live.mode === "auto" && live.epoch === options.selectedEpoch) host = "auto";
  }
  return { kind, host };
}
