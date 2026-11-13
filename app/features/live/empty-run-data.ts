import type { Project, RunData, SpanStats } from "@/lib/types";

function emptySpanStats(): SpanStats {
  return {
    started: 0,
    outcomes: { success: 0, error: 0, cancelled: 0, pending: 0, unknown: 0 },
    durationMs: { median: null, p95: null },
  };
}

/**
 * Synthesize a deterministic placeholder `RunData` for a 0-run workspace using
 * its `project.defaults` so Live Cockpit can render immediately and cold-start on send.
 */
export function synthesizeEmptyRunData(project: Project, locale?: string): RunData {
  const model = project.defaults?.model ?? project.core?.model ?? null;
  const serviceTier = project.defaults?.serviceTier ?? null;
  const effort = project.defaults?.effort ?? null;
  const maxSeconds = project.defaults?.maxSeconds ?? null;
  const mode = project.core?.mode ?? "manual";
  const coreOnline = Boolean(project.core?.online);
  const reason = locale === "zh" ? "Core 未启动（发送消息后按需拉起）" : "Core offline (spawns on demand)";

  return {
    project: project.id,
    run: "",
    manifest: {
      runId: "",
      workspace: project.workspace ?? "",
      workspaceId: project.id,
      socket: "",
      drivers: [],
      model,
      seconds: maxSeconds ?? 0,
      maxRequests: 0,
      compactionThreshold: null,
    },
    cycles: [],
    selectedEpoch: null,
    calls: [],
    paging: {
      totalCalls: 0,
      beforeCall: null,
      hasMore: false,
      firstIndex: 0,
      lastIndex: 0,
    },
    observations: [],
    perception: null,
    notices: [],
    skills: [],
    telemetry: {
      sources: [],
      spans: [],
      shiori: { stats: emptySpanStats(), nativeLoops: [] },
      capabilities: {
        stats: emptySpanStats(),
        python: emptySpanStats(),
        localPython: emptySpanStats(),
        discovery: emptySpanStats(),
      },
      devices: emptySpanStats(),
      perception: emptySpanStats(),
    },
    lastControl: {
      mode,
      consolidating: Boolean(project.core?.consolidating),
      thinking: false,
      model,
      serviceTier,
      effort,
    },
    activeCompaction: null,
    live: {
      runId: "",
      mode,
      epoch: null,
      connected: false,
      reason,
      agent: false,
      model,
      serviceTier,
      effort,
      thinking: false,
      maxSeconds,
      remainingSeconds: null,
      launchedBy: project.core?.launchedBy,
      coreOffline: !coreOnline,
    },
    livePhase: null,
    controlAllowed: false,
    controlReason: reason,
    updatedAt: "1970-01-01T00:00:00.000Z",
    summary: {
      completed: 0,
      actions: 0,
      explicitObserves: 0,
      errors: 0,
      compactions: 0,
      medianMs: null,
      p95Ms: null,
      medianHeadersMs: null,
      medianHttpHeadersMs: null,
      medianWsWaitMs: null,
      cacheHit: null,
      warmCacheHit: null,
      elapsedSeconds: 0,
    },
  };
}
