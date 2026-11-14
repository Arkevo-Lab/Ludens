import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  ActivityChangesPage,
  ActivityCurrent,
  ActivityProjection,
  ActivityResponse,
} from "@ludens/protocol/activity";
import type { EventPoolSnapshot, PoolEvent } from "@ludens/protocol/event-pool";
import { mergeMonotonicBlocks, type ActivityBlock, type ActivityScope } from "../features/live/activity-feed-model";
import { LiveMediaCache } from "../features/live/live-media-cache";
import {
  LiveSessionEngine,
  samePoolSnapshot,
  stabilizeRunData,
  type ChangesReaderLike,
  type EventPoolCommand,
  type RuntimeControlCommand,
} from "../features/live/live-session-store";
import { buildCodexSegments, reconcileSegments } from "../features/live/shiori-segments";
import { ReadPoller } from "../lib/read-poller";
import type { Call, Observation, RunData, RunInfo, SpanStats } from "../lib/types";

const SCOPE_RUN_2: ActivityScope = { project: "diablo3", runId: "run-2", epoch: null };
const SCOPE_RUN_1: ActivityScope = { project: "diablo3", runId: "run-1", epoch: null };

function makeProjection(generation: string, revision: number): ActivityProjection {
  return {
    source: { component: "shiori" },
    throughSeq: revision,
    latestEventAt: "2026-11-12T10:05:00.000Z",
    latestSourceAt: "2026-11-12T10:05:00.000Z",
    generatedAt: "2026-11-12T10:05:00.000Z",
    durationMs: 2,
    blockCount: revision,
    revision,
    generation,
  };
}

function makeCurrent(runId: string): ActivityCurrent {
  return {
    workspace: "/ws/diablo3",
    runId,
    epoch: "ep-1",
    activity: "running",
    phase: "stream",
    intent: null,
    observationId: null,
    updatedAt: "2026-11-12T10:05:00.000Z",
    error: null,
  };
}

function makeBlock(
  id: string,
  atSec: number,
  options: {
    kind?: ActivityBlock["kind"];
    text?: string;
    revision?: number;
    modelCallId?: string;
  } = {},
): ActivityBlock {
  const iso = new Date(Date.UTC(2026, 10, 12, 10, 0, atSec)).toISOString();
  return {
    id,
    kind: options.kind ?? "text",
    status: "complete",
    title: options.kind === "diagnostic" ? "event_diagnostic" : "assistant",
    text: options.text ?? `block-${id}`,
    at: iso,
    updatedAt: iso,
    revision: options.revision ?? atSec,
    createdRevision: atSec,
    trace: { epoch: "ep-1", modelCallId: options.modelCallId ?? `call-${atSec}` },
  };
}

function makeObservation(id: string, atSec: number): Observation {
  const iso = new Date(Date.UTC(2026, 10, 12, 10, 0, atSec)).toISOString();
  return {
    id,
    at: iso,
    controller: "switch2",
    origin: "perception",
    mediaType: "image/jpeg",
    mediaStorage: "run",
  };
}

function makeCall(id: string, atSec: number): Call {
  const atMs = Date.UTC(2026, 10, 12, 10, 0, atSec);
  const iso = new Date(atMs).toISOString();
  const obsId = `obs-${id}`;
  return {
    id,
    index: atSec,
    at: iso,
    atMs,
    durationMs: 400,
    headersMs: 80,
    firstStreamMs: 120,
    wireBytes: 2048,
    transport: "websocket",
    transportDetails: null,
    frameBytes: 4096,
    incremental: true,
    wsFrames: 6,
    inputTokens: 100,
    cachedTokens: 80,
    cacheHit: 0.8,
    attempts: 1,
    status: "complete",
    tools: [],
    observations: [obsId],
    inputObservations: [obsId],
    inputText: `Context for ${id}`,
    actions: 1,
    phases: {},
    outputTokens: 20,
    outputTokensPerSecond: 50,
    toolCallCount: 0,
  };
}

const EMPTY_SPAN_STATS: SpanStats = {
  started: 0,
  outcomes: { success: 0, error: 0, cancelled: 0, pending: 0, unknown: 0 },
  durationMs: { median: null, p95: null },
};

function makeRunData(run: string, calls: Call[], updatedAt = "2026-11-12T10:05:00.000Z"): RunData {
  const observations: Observation[] = calls.map(call => makeObservation(`obs-${call.id}`, call.index));
  return {
    project: "diablo3",
    run,
    manifest: {
      runId: run,
      workspace: "/ws/diablo3",
      socket: "/ws/diablo3/.ludens/host.sock",
      drivers: [],
      model: "gpt-5.4",
      seconds: 1800,
      maxRequests: 500,
      compactionThreshold: 120_000,
    },
    cycles: [{ epoch: "ep-1", startedAt: "2026-11-12T10:00:00.000Z", maxSeconds: 1800 }],
    selectedEpoch: null,
    calls,
    selectedCall: calls.at(-1),
    paging: {
      totalCalls: calls.length,
      beforeCall: null,
      hasMore: false,
      firstIndex: 1,
      lastIndex: calls.length,
    },
    observations,
    perception: null,
    notices: [],
    skills: [],
    telemetry: {
      sources: [],
      spans: [],
      shiori: { stats: EMPTY_SPAN_STATS, nativeLoops: [] },
      capabilities: {
        stats: EMPTY_SPAN_STATS,
        python: EMPTY_SPAN_STATS,
        localPython: EMPTY_SPAN_STATS,
        discovery: EMPTY_SPAN_STATS,
      },
      devices: EMPTY_SPAN_STATS,
      perception: EMPTY_SPAN_STATS,
    },
    lastControl: null,
    activeCompaction: null,
    live: {
      runId: run,
      mode: "auto",
      epoch: "ep-1",
      connected: true,
      reason: "running",
      agent: true,
      model: "gpt-5.4",
      thinking: true,
      maxSeconds: 1800,
      remainingSeconds: 900,
    },
    livePhase: null,
    controlAllowed: true,
    controlReason: "",
    updatedAt,
    summary: {
      completed: calls.length,
      actions: calls.length,
      explicitObserves: 0,
      errors: 0,
      compactions: 0,
      medianMs: 400,
      p95Ms: 500,
      medianHeadersMs: 80,
      medianHttpHeadersMs: null,
      medianWsWaitMs: null,
      cacheHit: 0.8,
      warmCacheHit: 0.85,
      elapsedSeconds: 300,
    },
  };
}

function makePoolEvent(id: string, seq: number, status: PoolEvent["status"] = "pending"): PoolEvent {
  return {
    id,
    seq,
    createdAt: new Date(Date.UTC(2026, 10, 12, 10, 0, seq)).toISOString(),
    direction: "inbound",
    kind: "message",
    text: `msg-${seq}`,
    status,
  };
}

function makePoolSnapshot(events: PoolEvent[]): EventPoolSnapshot {
  return {
    events,
    summary: {
      pendingInbound: events.filter(e => e.direction === "inbound" && e.status === "pending").length,
      pendingOutbound: events.filter(e => e.direction === "outbound" && e.status === "pending").length,
      latestSeq: events.reduce((max, ev) => Math.max(max, ev.seq), 0),
    },
  };
}

function flushMicrotasks(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 15));
}

test("parallel bootstrap fires changes + history concurrently and suppresses cold-load orphan screenshot flash", async () => {
  const callOrder: string[] = [];
  let resolveChanges!: (page: ActivityChangesPage) => void;
  let resolveHistory!: (page: ActivityResponse) => void;

  const reader: ChangesReaderLike = {
    read: () => {
      callOrder.push("changes");
      return new Promise<ActivityChangesPage>(resolve => {
        resolveChanges = resolve;
      });
    },
  };

  const engine = new LiveSessionEngine({
    project: "diablo3",
    transport: {
      createChangesClient: () => reader,
      requestActivity: params => {
        callOrder.push(`activity:${params.get("mode")}`);
        return new Promise<ActivityResponse>(resolve => {
          resolveHistory = resolve;
        });
      },
    },
  });

  engine.syncStream({ run: "run-2", epoch: "all", enabled: true, refresh: true });

  // Both requests must be in flight at t=0 without waiting serially on changes first!
  assert.deepEqual([...callOrder].sort(), ["activity:history", "changes"]);
  assert.equal(engine.getSnapshot().loading, true);

  // While blocks are still loading on cold start, buildCodexSegments must NOT flash 100 orphan input cards.
  const calls = [makeCall("call-1", 1), makeCall("call-2", 2), makeCall("call-3", 3)];
  const observations = calls.map(c => makeObservation(`obs-${c.id}`, c.index));
  const coldSegments = buildCodexSegments([], calls, observations, {
    runId: "run-2",
    isLatestRun: true,
    isAuto: true,
    blocksLoading: engine.getSnapshot().loading,
  });
  assert.equal(coldSegments.length, 0, "orphan input screenshot cards must be suppressed while blocks are loading");

  resolveHistory({
    mode: "history",
    scope: SCOPE_RUN_2,
    projection: makeProjection("gen-1", 3),
    current: makeCurrent("run-2"),
    blocks: [
      makeBlock("b-2", 2, { modelCallId: "call-2" }),
      makeBlock("b-3", 3, { modelCallId: "call-3" }),
    ],
    before: "cursor-before-2",
    hasMore: true,
    total: 3,
  });
  await flushMicrotasks();

  assert.equal(engine.getSnapshot().loading, false);
  assert.deepEqual(
    engine.getSnapshot().blocks.map(b => b.id),
    ["b-2", "b-3"],
  );

  resolveChanges({
    mode: "snapshot",
    scope: SCOPE_RUN_2,
    projection: makeProjection("gen-1", 3),
    current: makeCurrent("run-2"),
    cursor: "cur-3",
    hasMore: false,
    blocks: [makeBlock("b-3", 3, { modelCallId: "call-3" })],
    acknowledge: () => {},
  });
  await flushMicrotasks();

  assert.deepEqual(
    engine.getSnapshot().blocks.map(b => b.id),
    ["b-2", "b-3"],
  );
  engine.dispose();
});

test("upward pagination prepends monotonically, retains tail across live deltas, and issues 0 duplicate scroll requests", async () => {
  const historyRequests: string[] = [];
  const queuedChanges: Array<Omit<ActivityChangesPage, "acknowledge">> = [
    {
      mode: "snapshot",
      scope: SCOPE_RUN_2,
      projection: makeProjection("gen-1", 20),
      current: makeCurrent("run-2"),
      cursor: "cur-20",
      hasMore: false,
      blocks: [makeBlock("b-19", 19), makeBlock("b-20", 20)],
    },
  ];

  const engine = new LiveSessionEngine({
    project: "diablo3",
    transport: {
      createChangesClient: () => ({
        read: async () => {
          const next = queuedChanges.shift() ?? {
            mode: "delta" as const,
            scope: SCOPE_RUN_2,
            projection: makeProjection("gen-1", 20),
            current: makeCurrent("run-2"),
            cursor: "cur-20",
            hasMore: false,
            blocks: [],
          };
          return { ...next, acknowledge: () => {} };
        },
      }),
      requestActivity: async params => {
        const key = `${params.get("run")}:${params.get("mode")}:${params.get("before") ?? "initial"}`;
        historyRequests.push(key);
        const run = params.get("run");
        const before = params.get("before");
        if (run === "run-2" && !before) {
          return {
            mode: "history",
            scope: SCOPE_RUN_2,
            projection: makeProjection("gen-1", 20),
            current: makeCurrent("run-2"),
            blocks: [makeBlock("b-18", 18), makeBlock("b-19", 19), makeBlock("b-20", 20)],
            before: "cur-before-18",
            hasMore: true,
            total: 5,
          };
        }
        if (run === "run-2" && before === "cur-before-18") {
          return {
            mode: "history",
            scope: SCOPE_RUN_2,
            projection: makeProjection("gen-1", 20),
            current: makeCurrent("run-2"),
            blocks: [makeBlock("b-16", 16), makeBlock("b-17", 17)],
            before: null,
            hasMore: false,
            total: 5,
          };
        }
        if (run === "run-1" && !before) {
          return {
            mode: "history",
            scope: SCOPE_RUN_1,
            projection: makeProjection("gen-r1", 10),
            current: makeCurrent("run-1"),
            blocks: [makeBlock("r1-3", 3), makeBlock("r1-4", 4)],
            before: "r1-before-3",
            hasMore: true,
            total: 4,
          };
        }
        if (run === "run-1" && before === "r1-before-3") {
          return {
            mode: "history",
            scope: SCOPE_RUN_1,
            projection: makeProjection("gen-r1", 10),
            current: makeCurrent("run-1"),
            blocks: [makeBlock("r1-1", 1), makeBlock("r1-2", 2)],
            before: null,
            hasMore: false,
            total: 4,
          };
        }
        throw new Error(`Unexpected request ${key}`);
      },
      readRun: async () => makeRunData("run-1", [makeCall("r1-call", 4)]),
    },
  });

  engine.syncStream({ run: "run-2", epoch: "all", enabled: true, refresh: false });
  await flushMicrotasks();

  const tailRefBefore = engine.getSnapshot().blocks.find(b => b.id === "b-20");
  assert.ok(tailRefBefore);

  // Fire 4 concurrent/repeated upward scroll triggers at the same cursor: only 1 network request allowed!
  await Promise.all([
    engine.loadEarlierCurrentRun(),
    engine.loadEarlierCurrentRun(),
    engine.loadEarlierCurrentRun(),
    engine.loadEarlierCurrentRun(),
  ]);

  assert.deepEqual(historyRequests, ["run-2:history:initial", "run-2:history:cur-before-18"]);
  assert.deepEqual(
    engine.getSnapshot().blocks.map(b => b.id),
    ["b-16", "b-17", "b-18", "b-19", "b-20"],
    "upward pagination must prepend older blocks and retain all tail blocks",
  );
  assert.strictEqual(
    engine.getSnapshot().blocks.find(b => b.id === "b-20"),
    tailRefBefore,
    "unchanged tail block object reference must be preserved",
  );

  // Diagnostic-only delta must emit 0 subscriber notifications and keep exact array reference.
  let notifications = 0;
  const unsub = engine.subscribe(() => {
    notifications += 1;
  });
  const blocksArrayBeforeDiag = engine.getSnapshot().blocks;
  queuedChanges.push({
    mode: "delta",
    scope: SCOPE_RUN_2,
    projection: makeProjection("gen-1", 21),
    current: makeCurrent("run-2"),
    cursor: "cur-21",
    hasMore: false,
    blocks: [makeBlock("diag-21", 21, { kind: "diagnostic" })],
  });
  engine.syncStream({ run: "run-2", epoch: "all", enabled: true, refresh: true });
  engine.reconcileNow();
  await flushMicrotasks();

  assert.equal(notifications, 0, "diagnostic-only delta must not notify React subscribers");
  assert.strictEqual(engine.getSnapshot().blocks, blocksArrayBeforeDiag);

  // Real tail delta appends b-22 without dropping b-16..b-20!
  queuedChanges.push({
    mode: "delta",
    scope: SCOPE_RUN_2,
    projection: makeProjection("gen-1", 22),
    current: makeCurrent("run-2"),
    cursor: "cur-22",
    hasMore: false,
    blocks: [makeBlock("b-22", 22, { text: "live tail block" })],
  });
  engine.reconcileNow();
  await flushMicrotasks();

  assert.deepEqual(
    engine.getSnapshot().blocks.map(b => b.id),
    ["b-16", "b-17", "b-18", "b-19", "b-20", "b-22"],
    "live tail delta must append smoothly without truncating upward-paged history",
  );

  // Load older run-1 and paginate older run-1 twice with the same cursor -> 0 duplicate requests!
  const runs: RunInfo[] = [
    { id: "run-2", model: "gpt-5.4", seconds: 1800, drivers: [], startedAt: "2026-11-12T10:00:00.000Z" },
    { id: "run-1", model: "gpt-5.4", seconds: 1800, drivers: [], startedAt: "2026-11-12T09:00:00.000Z" },
  ];
  const loadedRun1 = await engine.loadOlderRuns({ currentRunId: "run-2", runs });
  assert.equal(loadedRun1, true);
  assert.equal(engine.getSnapshot().olderRuns.length, 1);
  assert.equal(engine.getSnapshot().olderRuns[0]!.before, "r1-before-3");

  await Promise.all([
    engine.loadEarlierBlocksOfOlderRun("run-1", "r1-before-3"),
    engine.loadEarlierBlocksOfOlderRun("run-1", "r1-before-3"),
  ]);
  await engine.loadEarlierBlocksOfOlderRun("run-1", "r1-before-3");

  assert.deepEqual(
    engine.getSnapshot().olderRuns[0]!.blocks.map(b => b.id),
    ["r1-1", "r1-2", "r1-3", "r1-4"],
  );
  assert.equal(
    historyRequests.filter(k => k === "run-1:history:r1-before-3").length,
    1,
    "older run cursor pagination must deduplicate repeated scroll triggers",
  );

  unsub();
  engine.dispose();
});

test("view-switch keeps session warm with 0 blank flash, and run switch cancels stale in-flight requests", async () => {
  const abortedRuns: string[] = [];
  let resolveStaleRun2History!: (res: ActivityResponse) => void;

  const engine = new LiveSessionEngine({
    project: "diablo3",
    transport: {
      createChangesClient: opts => ({
        read: async () => {
          const runId = opts.run ?? "run-2";
          return {
            mode: "snapshot",
            scope: { project: opts.project, runId, epoch: opts.epoch && opts.epoch !== "all" ? opts.epoch : null },
            projection: makeProjection(`gen-${runId}`, 5),
            current: makeCurrent(runId),
            cursor: "cur-5",
            hasMore: false,
            blocks: [makeBlock(`${runId}-live`, 5)],
            acknowledge: () => {},
          };
        },
      }),
      requestActivity: (params, signal) => {
        const run = params.get("run")!;
        signal.addEventListener("abort", () => {
          abortedRuns.push(run);
        });
        if (run === "run-2") {
          return new Promise<ActivityResponse>(resolve => {
            resolveStaleRun2History = resolve;
          });
        }
        return Promise.resolve({
          mode: "history",
          scope: SCOPE_RUN_1,
          projection: makeProjection("gen-run-1", 9),
          current: makeCurrent("run-1"),
          blocks: [makeBlock("run-1-h1", 1), makeBlock("run-1-h2", 2)],
          before: null,
          hasMore: false,
          total: 2,
        });
      },
    },
  });

  // Start run-2 (its history request hangs in-flight)
  engine.syncStream({ run: "run-2", epoch: "all", enabled: true, refresh: true });
  await flushMicrotasks();

  // Immediately switch to run-1 before run-2 history resolves
  engine.syncStream({ run: "run-1", epoch: "all", enabled: true, refresh: false });
  await flushMicrotasks();

  assert.deepEqual(abortedRuns, ["run-2"], "switching run must abort superseded history request");

  // Resolve stale run-2 response late: must be completely ignored!
  resolveStaleRun2History({
    mode: "history",
    scope: SCOPE_RUN_2,
    projection: makeProjection("gen-run-2", 5),
    current: makeCurrent("run-2"),
    blocks: [makeBlock("stale-run-2-block", 99)],
    before: null,
    hasMore: false,
    total: 1,
  });
  await flushMicrotasks();

  assert.equal(engine.getSnapshot().targetRun, "run-1");
  assert.equal(
    engine.getSnapshot().blocks.some(b => b.id === "stale-run-2-block"),
    false,
    "late response from superseded run must never corrupt active run blocks",
  );

  // Toggle view away (enabled: false) and back (enabled: true): cached blocks stay warm!
  const warmBlocks = engine.getSnapshot().blocks;
  assert.ok(warmBlocks.length >= 2);
  engine.syncStream({ run: "run-1", epoch: "all", enabled: false, refresh: false });
  assert.strictEqual(engine.getSnapshot().blocks, warmBlocks, "pausing view must retain warm blocks");
  assert.equal(engine.getSnapshot().loading, false);

  engine.syncStream({ run: "run-1", epoch: "all", enabled: true, refresh: false });
  assert.strictEqual(engine.getSnapshot().blocks, warmBlocks, "resuming view must render warm blocks immediately");

  engine.dispose();
});

test("stabilizeRunData, samePoolSnapshot, syncEventPool, and reconcileSegments eliminate redundant re-renders", async () => {
  const calls1 = [makeCall("c-1", 1), makeCall("c-2", 2)];
  const runA = makeRunData("run-2", calls1, "2026-11-12T10:05:00.000Z");
  const runBVolatileOnly = makeRunData("run-2", [makeCall("c-1", 1), makeCall("c-2", 2)], "2026-11-12T10:05:02.500Z");

  // Volatile updatedAt change with identical calls/observations/cycles returns exact previous RunData reference!
  const stabilizedSame = stabilizeRunData(runA, runBVolatileOnly);
  assert.strictEqual(stabilizedSame, runA);

  // Live status change preserves unchanged calls/observations/cycles array references!
  const runCLiveChanged: RunData = {
    ...runBVolatileOnly,
    live: {
      ...runA.live!,
      thinking: false,
      reason: "idle",
    },
  };
  const stabilizedPhase = stabilizeRunData(runA, runCLiveChanged);
  assert.notStrictEqual(stabilizedPhase, runA);
  assert.strictEqual(stabilizedPhase.calls, runA.calls);
  assert.strictEqual(stabilizedPhase.observations, runA.observations);
  assert.strictEqual(stabilizedPhase.cycles, runA.cycles);

  // reconcileSegments preserves exact object identity for historical turns when a new turn appends at tail!
  const blocks1 = [
    makeBlock("b-1", 1, { modelCallId: "c-1", text: "Turn 1 answer" }),
    makeBlock("b-2", 2, { modelCallId: "c-2", text: "Turn 2 answer" }),
  ];
  const obs1 = calls1.map(c => makeObservation(`obs-${c.id}`, c.index));
  const segs1 = buildCodexSegments(blocks1, calls1, obs1, {
    runId: "run-2",
    isLatestRun: true,
    isAuto: true,
  });

  const calls2 = [...calls1, makeCall("c-3", 3)];
  const obs2 = calls2.map(c => makeObservation(`obs-${c.id}`, c.index));
  const blocks2 = [...blocks1, makeBlock("b-3", 3, { modelCallId: "c-3", text: "Turn 3 answer" })];
  const segs2Raw = buildCodexSegments(blocks2, calls2, obs2, {
    runId: "run-2",
    isLatestRun: true,
    isAuto: true,
  });
  const segs2 = reconcileSegments(segs1, segs2Raw);

  assert.equal(segs2.length, segs1.length + 2); // +1 input_call, +1 turn
  // Every historical segment except the previous trailing active turn (which transitioned isActiveTurn: true -> false)
  // keeps its exact object reference!
  assert.strictEqual(segs2[0], segs1[0], "historical input_call segment[0] must keep exact reference");
  assert.strictEqual(segs2[1], segs1[1], "historical turn segment[1] must keep exact reference");
  assert.strictEqual(segs2[2], segs1[2], "historical input_call segment[2] must keep exact reference");

  // Re-polling with identical segments keeps 100% of segment references AND outer array reference!
  const segs3 = reconcileSegments(segs2, buildCodexSegments(blocks2, calls2, obs2, {
    runId: "run-2",
    isLatestRun: true,
    isAuto: true,
  }));
  assert.strictEqual(segs3, segs2, "unchanged poll must return exact previous StreamSegment[] reference");

  // syncEventPool suppresses duplicate snapshots and nudges immediately when liveLatestSeq advances
  let poolFetches = 0;
  let currentSeq = 1;
  const engine = new LiveSessionEngine({
    project: "diablo3",
    transport: {
      fetchEventPool: async () => {
        poolFetches += 1;
        return {
          hostOnline: true,
          snapshot: makePoolSnapshot([makePoolEvent(`ev-${currentSeq}`, currentSeq)]),
        };
      },
    },
  });

  let stateChanges = 0;
  engine.subscribe(() => {
    stateChanges += 1;
  });

  engine.syncEventPool({
    workspace: "/ws/diablo3",
    isLiveRun: true,
    enabled: true,
    refresh: false,
    liveLatestSeq: 1,
  });
  await flushMicrotasks();
  assert.equal(poolFetches, 1);
  assert.equal(stateChanges, 1);
  assert.equal(samePoolSnapshot(engine.getSnapshot().poolSnapshot, makePoolSnapshot([makePoolEvent("ev-1", 1)])), true);

  // Calling syncEventPool with same liveLatestSeq = 1 triggers 0 extra fetches
  engine.syncEventPool({
    workspace: "/ws/diablo3",
    isLiveRun: true,
    enabled: true,
    refresh: false,
    liveLatestSeq: 1,
  });
  await flushMicrotasks();
  assert.equal(poolFetches, 1);

  // Advancing liveLatestSeq = 2 nudges an immediate Event Pool refresh!
  currentSeq = 2;
  engine.syncEventPool({
    workspace: "/ws/diablo3",
    isLiveRun: true,
    enabled: true,
    refresh: false,
    liveLatestSeq: 2,
  });
  await flushMicrotasks();
  assert.equal(poolFetches, 2);
  assert.equal(engine.getSnapshot().poolSnapshot?.summary.latestSeq, 2);

  engine.dispose();
});

test("unified mutations apply optimistic state, fallback cleanly, and roll back on error", async () => {
  const runtimeCommands: RuntimeControlCommand[] = [];
  const offlineModelUpdates: Array<{ model: string; tier: string | null; effort: string | null }> = [];
  let failNextModelSwitch = false;
  let failNextPoolAck = false;

  const initialPool = makePoolSnapshot([makePoolEvent("ev-pending", 1, "pending")]);

  const engine = new LiveSessionEngine({
    project: "diablo3",
    transport: {
      fetchEventPool: async () => ({ hostOnline: true, snapshot: initialPool }),
      sendRuntimeControl: async (_project, _workspace, cmd) => {
        runtimeCommands.push(cmd);
        if (cmd.action === "steer") {
          throw new Error("Auto loop is not active");
        }
        if (cmd.action === "status") {
          return { status: { mode: "auto", remainingSeconds: 120 } };
        }
        if (cmd.action === "set_model") {
          if (failNextModelSwitch) {
            throw new Error("Invalid model quota");
          }
          if (cmd.model === "offline-model") {
            throw new Error("HOST_OFFLINE: daemon socket ENOENT");
          }
          return {
            status: {
              mode: "auto",
              model: cmd.model,
              serviceTier: cmd.serviceTier ?? null,
              effort: cmd.effort ?? null,
            },
          };
        }
        return { status: { mode: cmd.action === "auto_off" ? "manual" : "auto" } };
      },
      updateWorkspaceShioriModel: async (_project, model, tier, effort) => {
        offlineModelUpdates.push({ model, tier, effort });
        return { ok: true };
      },
      mutateEventPool: async (_project, _workspace, command: EventPoolCommand) => {
        if (command.action === "ack" && failNextPoolAck) {
          throw new Error("Disk write failed");
        }
        const acked = makePoolSnapshot([makePoolEvent("ev-pending", 1, "handled")]);
        return { hostOnline: true, snapshot: acked };
      },
    },
  });

  // Prime poolSnapshot
  engine.syncEventPool({ workspace: "/ws/diablo3", isLiveRun: true, enabled: true, refresh: false });
  await flushMicrotasks();
  assert.equal(engine.getSnapshot().poolSnapshot?.summary.pendingInbound, 1);

  // 1. steerOrStartAuto falls back to auto_on when steer reports "Auto loop is not active"
  const steerRes = await engine.steerOrStartAuto({
    workspace: "/ws/diablo3",
    run: "run-2",
    baseUpdatedAt: "2026-11-12T10:05:00.000Z",
    expectedEpoch: "ep-1",
    message: "Push greater rift",
    fallbackSeconds: 900,
  });
  assert.equal(steerRes.fellBackToAutoOn, true);
  assert.deepEqual(
    runtimeCommands.map(c => c.action),
    ["steer", "auto_on"],
  );
  assert.equal(engine.getSnapshot().optimisticHost?.status.mode, "auto");

  // 2. extendAutoStopTimer reads fresh status (120s) and sets budget to 120 + 300 = 420s
  await engine.extendAutoStopTimer({
    workspace: "/ws/diablo3",
    run: "run-2",
    baseUpdatedAt: "2026-11-12T10:05:00.000Z",
    expectedEpoch: "ep-1",
    deltaSeconds: 300,
    fallbackRemainingSeconds: 60,
  });
  const lastBudgetCmd = runtimeCommands.at(-1);
  assert.equal(lastBudgetCmd?.action, "auto_budget");
  if (lastBudgetCmd?.action === "auto_budget") {
    assert.equal(lastBudgetCmd.seconds, 420);
  }

  // 3. switchModel online + HOST_OFFLINE fallback + rollback on failure
  const onlineSwitch = await engine.switchModel({
    workspace: "/ws/diablo3",
    run: "run-2",
    baseUpdatedAt: "2026-11-12T10:05:00.000Z",
    baseServerModel: "gpt-5.4",
    hostOnline: true,
    model: "claude-opus-4-6",
    serviceTier: "priority",
    effort: "high",
  });
  assert.equal(onlineSwitch.persistedOffline, false);
  assert.equal(engine.getSnapshot().optimisticModel?.model, "claude-opus-4-6");

  const offlineSwitch = await engine.switchModel({
    workspace: "/ws/diablo3",
    run: "run-2",
    baseUpdatedAt: "2026-11-12T10:05:00.000Z",
    baseServerModel: "gpt-5.4",
    hostOnline: true,
    model: "offline-model",
    serviceTier: null,
    effort: "medium",
  });
  assert.equal(offlineSwitch.persistedOffline, true);
  assert.equal(offlineModelUpdates.length, 1);
  assert.equal(engine.getSnapshot().optimisticModel?.model, "offline-model");

  failNextModelSwitch = true;
  await assert.rejects(() =>
    engine.switchModel({
      workspace: "/ws/diablo3",
      run: "run-2",
      baseUpdatedAt: "2026-11-12T10:05:00.000Z",
      baseServerModel: "gpt-5.4",
      hostOnline: true,
      model: "broken-model",
      serviceTier: null,
      effort: null,
    }),
  );
  assert.equal(
    engine.getSnapshot().optimisticModel?.model,
    "offline-model",
    "failed switchModel must roll back optimisticModel to prior state",
  );

  // 4. mutatePool optimistic ack updates pending -> handled immediately, rolls back on error
  failNextPoolAck = true;
  let observedOptimisticHandled = false;
  const unsub = engine.subscribe(() => {
    if (engine.getSnapshot().poolSubmitting && engine.getSnapshot().poolSnapshot?.summary.pendingInbound === 0) {
      observedOptimisticHandled = true;
    }
  });

  await assert.rejects(() =>
    engine.mutatePool({
      workspace: "/ws/diablo3",
      run: "run-2",
      baseUpdatedAt: "2026-11-12T10:05:00.000Z",
      command: { action: "ack", ids: ["ev-pending"] },
    }),
  );
  assert.equal(observedOptimisticHandled, true, "ack must optimistically mark event handled while in flight");
  assert.equal(
    engine.getSnapshot().poolSnapshot?.summary.pendingInbound,
    1,
    "failed ack must roll back poolSnapshot to pending",
  );

  failNextPoolAck = false;
  await engine.mutatePool({
    workspace: "/ws/diablo3",
    run: "run-2",
    baseUpdatedAt: "2026-11-12T10:05:00.000Z",
    command: { action: "ack", ids: ["ev-pending"] },
  });
  assert.equal(engine.getSnapshot().poolSnapshot?.summary.pendingInbound, 0);

  unsub();
  engine.dispose();
});

test("LiveMediaCache coalesces concurrent reads, protects mounted refCount > 0 from LRU revoke, and never negative-caches errors", async () => {
  const fetchedUrls: string[] = [];
  const revokedUrls: string[] = [];
  let urlCounter = 0;
  let failUrlCOnce = true;
  const pendingResolvers = new Map<string, () => void>();

  const cache = new LiveMediaCache({
    maxEntries: 2,
    maxConcurrent: 2,
    createObjectUrl: () => `blob:mock-${++urlCounter}`,
    revokeObjectUrl: objUrl => {
      revokedUrls.push(objUrl);
    },
    fetchImpl: async (input, init) => {
      const url = String(input);
      fetchedUrls.push(url);
      if (url === "/media/c.jpg" && failUrlCOnce) {
        failUrlCOnce = false;
        return new Response("Service Unavailable", { status: 503 });
      }
      if (pendingResolvers.has(url)) {
        await new Promise<void>((resolve, reject) => {
          pendingResolvers.set(url, resolve);
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("Aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      }
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    },
  });

  // 1. Coalesce 2 waiters on /media/a.jpg; aborting waiter 1 MUST NOT abort underlying fetch for waiter 2!
  pendingResolvers.set("/media/a.jpg", () => {});
  const abort1 = new AbortController();
  const abort2 = new AbortController();
  const p1 = cache.acquire("/media/a.jpg", abort1.signal);
  const p2 = cache.acquire("/media/a.jpg", abort2.signal);

  abort1.abort();
  await assert.rejects(p1, { name: "AbortError" });
  pendingResolvers.get("/media/a.jpg")!();
  pendingResolvers.delete("/media/a.jpg");

  const leaseA = await p2;
  assert.equal(leaseA.objectUrl, "blob:mock-1");
  assert.equal(fetchedUrls.filter(u => u === "/media/a.jpg").length, 1);
  assert.equal(cache.refCountOf("/media/a.jpg"), 1);

  // Re-acquiring warm /media/a.jpg hits memory synchronously with 0 extra fetches!
  const leaseA2 = await cache.acquire("/media/a.jpg");
  assert.equal(leaseA2.objectUrl, "blob:mock-1");
  assert.equal(fetchedUrls.filter(u => u === "/media/a.jpg").length, 1);
  leaseA2.release();
  assert.equal(cache.refCountOf("/media/a.jpg"), 1);

  // 2. Failed request on /media/c.jpg is NEVER negative-cached -> immediate retry succeeds!
  await assert.rejects(cache.acquire("/media/c.jpg"), /Media read failed \(503\)/);
  const leaseC = await cache.acquire("/media/c.jpg");
  assert.equal(leaseC.objectUrl, "blob:mock-2");
  assert.equal(fetchedUrls.filter(u => u === "/media/c.jpg").length, 2);

  // 3. LRU eviction with maxEntries = 2:
  // Currently both /media/a.jpg (refCount=1) and /media/c.jpg (refCount=1) are mounted.
  // Acquiring /media/b.jpg brings entries to 3, but NEITHER mounted image may be revoked!
  const leaseB = await cache.acquire("/media/b.jpg");
  assert.equal(leaseB.objectUrl, "blob:mock-3");
  assert.deepEqual(revokedUrls, [], "mounted entries with refCount > 0 must NEVER be revoked by LRU eviction");
  assert.equal(cache.size, 3);

  // Releasing oldest mounted entry (/media/a.jpg) drops its refCount to 0 and immediately evicts + revokes it!
  leaseA.release();
  assert.deepEqual(revokedUrls, ["blob:mock-1"]);
  assert.equal(cache.size, 2);

  // 4. Queued request aborted before starting makes 0 network fetches!
  pendingResolvers.set("/media/slow1.jpg", () => {});
  pendingResolvers.set("/media/slow2.jpg", () => {});
  const s1 = new AbortController();
  const s2 = new AbortController();
  const sQueued = new AbortController();

  const ps1 = cache.acquire("/media/slow1.jpg", s1.signal);
  const ps2 = cache.acquire("/media/slow2.jpg", s2.signal);
  const psQueued = cache.acquire("/media/queued-never-started.jpg", sQueued.signal);

  // Abort queued item before slow1/slow2 finish
  sQueued.abort();
  await assert.rejects(psQueued, { name: "AbortError" });
  assert.equal(
    fetchedUrls.includes("/media/queued-never-started.jpg"),
    false,
    "queued request aborted while scrolled past must never touch fetch",
  );

  s1.abort();
  s2.abort();
  await assert.rejects(ps1);
  await assert.rejects(ps2);
  leaseB.release();
  leaseC.release();
  cache.clear(true);
});

test("ReadPoller supports immediate nudge() and hidden-document backoff", async () => {
  const originalDoc = (globalThis as { document?: unknown }).document;
  try {
    let ticks = 0;
    const poller = new ReadPoller(async () => {
      ticks += 1;
      return 60_000;
    }, true);
    void poller.readOnce();

    await flushMicrotasks();
    assert.equal(ticks, 1);

    // nudge() wakes a parked 60s timer immediately without disposing the poller
    poller.nudge();
    await flushMicrotasks();
    assert.equal(ticks, 2);
    poller.dispose();

    // Hidden document multiplies delay (>= 10,000ms floor), visible wakes immediately
    const listeners = new Map<string, () => void>();
    const fakeDoc = {
      visibilityState: "hidden",
      addEventListener: (event: string, cb: () => void) => {
        listeners.set(event, cb);
      },
      removeEventListener: (event: string) => {
        listeners.delete(event);
      },
    };
    (globalThis as { document?: unknown }).document = fakeDoc;

    let hiddenTicks = 0;
    const visPoller = new ReadPoller(async () => {
      hiddenTicks += 1;
      return 30;
    }, true);
    void visPoller.readOnce();

    await flushMicrotasks();
    assert.equal(hiddenTicks, 1);

    // After 80ms while hidden, the 30ms delay was backed off to 10,000ms so no second tick runs
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(hiddenTicks, 1, "hidden tab must back off short poll intervals to >= 10s");

    // Becoming visible wakes the poller immediately
    fakeDoc.visibilityState = "visible";
    listeners.get("visibilitychange")?.();
    await flushMicrotasks();
    assert.equal(hiddenTicks, 2, "tab becoming visible must wake ReadPoller immediately");

    visPoller.dispose();
  } finally {
    (globalThis as { document?: unknown }).document = originalDoc;
  }
});

test("mergeMonotonicBlocks keeps unfiltered monotonic cache pure and preserves unchanged block references", () => {
  const b1 = makeBlock("b-1", 1, { text: "one", revision: 1 });
  const b2 = makeBlock("b-2", 2, { text: "two", revision: 2 });
  const b3 = makeBlock("b-3", 3, { text: "three", revision: 3 });

  const initial = mergeMonotonicBlocks([], [b2, b3]);
  assert.equal(initial.changed, true);
  assert.deepEqual(initial.blocks.map(b => b.id), ["b-2", "b-3"]);

  // Prepending b1 preserves exact references to b2 and b3
  const prepended = mergeMonotonicBlocks(initial.blocks, [b1, b2]);
  assert.equal(prepended.changed, true);
  assert.deepEqual(prepended.blocks.map(b => b.id), ["b-1", "b-2", "b-3"]);
  assert.strictEqual(prepended.blocks[1], b2);
  assert.strictEqual(prepended.blocks[2], b3);

  // Re-merging identical blocks returns changed: false and exact array reference
  const duplicate = mergeMonotonicBlocks(prepended.blocks, [b2, b3]);
  assert.equal(duplicate.changed, false);
  assert.strictEqual(duplicate.blocks, prepended.blocks);
});

test("hardReset generation rotation aborts stale upward history requests, and same-run reset clears loadingOlderRun", async () => {
  let changesIdx = 0;
  let resolveG1Earlier!: (page: ActivityResponse) => void;
  let g1EarlierSignal!: AbortSignal;

  const reader: ChangesReaderLike = {
    read: async () => {
      changesIdx += 1;
      if (changesIdx === 1) {
        return {
          scope: SCOPE_RUN_2,
          mode: "snapshot",
          blocks: [makeBlock("g1-tail", 50, { revision: 5 })],
          cursor: "cur-g1",
          hasMore: false,
          projection: makeProjection("gen-1", 5),
          current: makeCurrent("run-2"),
          acknowledge: () => {},
        };
      }
      return {
        scope: SCOPE_RUN_2,
        mode: "snapshot",
        blocks: [makeBlock("g2-fresh", 60, { revision: 1 })],
        cursor: "cur-g2",
        hasMore: false,
        projection: makeProjection("gen-2", 1),
        current: makeCurrent("run-2"),
        acknowledge: () => {},
      };
    },
  };

  const engine = new LiveSessionEngine({
    project: "diablo3",
    transport: {
      createChangesClient: () => reader,
      requestActivity: (params, signal) => {
        if (params.get("before") === "cursor-g1-before") {
          g1EarlierSignal = signal;
          return new Promise<ActivityResponse>(resolve => {
            resolveG1Earlier = resolve;
          });
        }
        if (params.get("run") === "run-1") {
          return new Promise<ActivityResponse>(() => {});
        }
        const gen = changesIdx >= 2 ? "gen-2" : "gen-1";
        return Promise.resolve({
          scope: SCOPE_RUN_2,
          mode: "history",
          blocks:
            gen === "gen-1"
              ? [makeBlock("g1-tail", 50, { revision: 5 })]
              : [makeBlock("g2-fresh", 60, { revision: 1 })],
          before: gen === "gen-1" ? "cursor-g1-before" : null,
          hasMore: gen === "gen-1",
          total: 1,
          projection: makeProjection(gen, gen === "gen-1" ? 5 : 1),
          current: makeCurrent("run-2"),
        });
      },
      readRun: () => new Promise<RunData>(() => {}),
    },
  });

  engine.syncStream({ run: "run-2", epoch: "all", enabled: true, refresh: false });
  await flushMicrotasks();
  assert.equal(engine.getSnapshot().generation, "gen-1");

  // Start upward pagination in gen-1, then rotate to gen-2 before G1 earlier resolves
  const earlierPromise = engine.loadEarlierCurrentRun();
  assert.equal(engine.getSnapshot().loadingOlder, true);
  engine.reconcileNow();
  await flushMicrotasks();

  assert.equal(g1EarlierSignal.aborted, true, "hardReset must abort in-flight G1 earlier request");
  resolveG1Earlier({
    scope: SCOPE_RUN_2,
    mode: "history",
    blocks: [makeBlock("g1-stale-old", 10, { revision: 99 })],
    before: "cursor-g1-older",
    hasMore: true,
    total: 2,
    projection: makeProjection("gen-1", 99),
    current: makeCurrent("run-2"),
  });
  await earlierPromise;
  await flushMicrotasks();

  assert.equal(engine.getSnapshot().generation, "gen-2");
  assert.deepEqual(
    engine.getSnapshot().blocks.map(b => b.id),
    ["g2-fresh"],
    "stale G1 upward page must never leak into G2",
  );

  // Start olderRun load, then reset same run via resetRevision -> loadingOlderRun must reset to false!
  const runs: RunInfo[] = [
    { id: "run-2", startedAt: "2026-11-12T10:00:00.000Z", model: "gpt-5.4", seconds: 1800, drivers: [] },
    { id: "run-1", startedAt: "2026-11-12T09:00:00.000Z", model: "gpt-5.4", seconds: 1800, drivers: [] },
  ];
  void engine.loadOlderRuns({ currentRunId: "run-2", runs });
  assert.equal(engine.getSnapshot().loadingOlderRun, true);

  engine.syncStream({ run: "run-2", epoch: "all", enabled: true, refresh: false, resetRevision: 1 });
  assert.equal(
    engine.getSnapshot().loadingOlderRun,
    false,
    "same-run reset must clear loadingOlderRun after aborting olderRunController",
  );
  engine.dispose();
});

test("failed ACK rollback preserves concurrent Event Pool arrivals, and LiveMediaCache isolates re-queued flights", async () => {
  const ev1 = makePoolEvent("ev-1", 1, "pending");
  const ev2 = makePoolEvent("ev-2", 2, "pending");
  let rejectAck!: (err: Error) => void;
  let pollCount = 0;

  const engine = new LiveSessionEngine({
    project: "diablo3",
    transport: {
      fetchEventPool: async () => {
        pollCount += 1;
        return {
          snapshot: pollCount === 1 ? makePoolSnapshot([ev1]) : makePoolSnapshot([ev1, ev2]),
          hostOnline: true,
        };
      },
      mutateEventPool: () =>
        new Promise((_, reject) => {
          rejectAck = reject;
        }),
    },
  });

  engine.syncEventPool({ workspace: "/ws/diablo3", isLiveRun: true, enabled: true, refresh: false });
  await flushMicrotasks();
  assert.equal(engine.getSnapshot().poolSnapshot?.events.length, 1);

  const ackPromise = engine.mutatePool({
    workspace: "/ws/diablo3",
    run: "run-2",
    baseUpdatedAt: "2026-11-12T10:05:00.000Z",
    command: { action: "ack", ids: ["ev-1"] },
  });
  assert.equal(engine.getSnapshot().poolSnapshot?.events[0]?.status, "handled");

  // Simulate background poll arriving with new event `ev-2` while ACK is still in flight
  engine.syncEventPool({
    workspace: "/ws/diablo3",
    isLiveRun: true,
    enabled: true,
    refresh: false,
    liveLatestSeq: 2,
  });
  await flushMicrotasks();

  rejectAck(new Error("ACK failed"));
  await assert.rejects(ackPromise, /ACK failed/);

  const rolledBack = engine.getSnapshot().poolSnapshot!;
  assert.deepEqual(
    rolledBack.events.map(e => e.id),
    ["ev-1", "ev-2"],
    "failed ACK rollback must not clobber newer events delivered during flight",
  );
  engine.dispose();

  // LiveMediaCache: cancelled request A finishing async catch after request B starts must NOT delete B from inFlight
  let fetchCalls = 0;
  let rejectFirstFetch!: (err: Error) => void;
  let resolveSecondFetch!: (resp: Response) => void;
  const cache = new LiveMediaCache({
    fetchImpl: (() => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return new Promise<Response>((_, reject) => {
          rejectFirstFetch = reject;
        });
      }
      return new Promise<Response>(resolve => {
        resolveSecondFetch = resolve;
      });
    }) as typeof fetch,
    createObjectUrl: () => `blob:test-${fetchCalls}`,
    revokeObjectUrl: () => {},
  });

  const c1 = new AbortController();
  const p1 = cache.acquire("/api/media?img=1", c1.signal);
  c1.abort();
  await assert.rejects(p1);

  // Immediately start B and C for same URL before A's underlying fetch promise rejects
  const p2 = cache.acquire("/api/media?img=1");
  rejectFirstFetch(new Error("aborted A"));
  await flushMicrotasks();
  const p3 = cache.acquire("/api/media?img=1");

  assert.equal(fetchCalls, 2, "third subscriber must coalesce onto B instead of firing a duplicate fetch");
  resolveSecondFetch(new Response(new Blob(["ok"], { type: "image/png" }), { status: 200 }));
  const [l2, l3] = await Promise.all([p2, p3]);
  assert.equal(l2.objectUrl, l3.objectUrl);
  l2.release();
  l3.release();
  cache.invalidate("/api/media?img=1", l2.objectUrl);
  assert.equal(cache.size, 0);
});

test("switchModel persists offline when sendRuntimeControl rejects with CORE_OFFLINE and cold-start records lastSpawnedRun", async () => {
  const { RuntimeControlError } = await import("../features/live/live-session-store");
  let workspaceModelSaved: string | null = null;
  const engine = new LiveSessionEngine({
    project: "demo-core",
    transport: {
      sendRuntimeControl: async (_project, _workspace, command) => {
        if (command.action === "set_model") {
          throw new RuntimeControlError("Core offline", { status: 409, code: "CORE_OFFLINE" });
        }
        if (command.action === "auto_on") {
          return {
            spawned: true,
            runId: "20261113T120000Z-spawned",
            status: { mode: "auto", connected: true, agent: true, thinking: true },
          };
        }
        return {};
      },
      updateWorkspaceShioriModel: async (_project, model) => {
        workspaceModelSaved = model;
        return { ok: true };
      },
    },
  });

  const switched = await engine.switchModel({
    workspace: "/ws/demo-core",
    run: "",
    baseUpdatedAt: "1970-01-01T00:00:00.000Z",
    baseServerModel: null,
    hostOnline: true,
    model: "openai-codex/gpt-6.1-sol",
    serviceTier: null,
    effort: "medium",
  });
  assert.equal(switched.persistedOffline, true);
  assert.equal(workspaceModelSaved, "openai-codex/gpt-6.1-sol");

  await engine.runRuntimeCommand({
    workspace: "/ws/demo-core",
    run: "",
    baseUpdatedAt: "1970-01-01T00:00:00.000Z",
    mightSpawnCore: true,
    command: { action: "auto_on", message: "Start", seconds: null },
  });
  const snap = engine.getSnapshot();
  assert.equal(snap.spawningCore, false);
  assert.deepEqual(snap.lastSpawnedRun, { runId: "20261113T120000Z-spawned", seq: 1 });
  assert.equal(snap.optimisticHost?.run, "20261113T120000Z-spawned");
  engine.dispose();
});
