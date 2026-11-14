import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EventPoolSnapshot, PoolEvent } from "@ludens/protocol/event-pool";
import { DeviceContentionDialog } from "../components/device-contention-dialog";
import {
  LiveSessionEngine,
  RuntimeControlError,
  isCoreOfflineError,
  isDeviceBusyError,
  type EventPoolCommand,
  type LiveSessionTransport,
  type RuntimeControlCommand,
} from "../features/live/live-session-store";
import { ShioriComposer, ShioriWorkbench } from "../features/live/shiori-cockpit";
import type { ActivityFeedData } from "../features/live/use-activity-feed";
import { LocaleProvider } from "../lib/locale";
import type { DeviceContentionConflict, Project, RunData, SpanStats } from "../lib/types";
import { synthesizeEmptyRunData } from "../features/live/empty-run-data";

function emptySpanStats(): SpanStats {
  return {
    started: 0,
    outcomes: { success: 0, error: 0, cancelled: 0, pending: 0, unknown: 0 },
    durationMs: { median: null, p95: null },
  };
}

function makePoolSnapshot(events: PoolEvent[] = []): EventPoolSnapshot {
  return {
    summary: {
      pendingInbound: events.filter(e => e.direction === "inbound" && e.status === "pending").length,
      pendingOutbound: events.filter(e => e.direction === "outbound" && e.status === "pending").length,
      latestSeq: events.reduce((max, e) => Math.max(max, e.seq), 0),
    },
    events,
  };
}

function makeOfflineRunData(overrides: Partial<RunData> = {}): RunData {
  return {
    project: "zero-ws",
    run: "",
    manifest: {
      runId: "",
      workspace: "/tmp/zero-ws",
      workspaceId: "zero-ws",
      socket: "",
      drivers: [],
      model: "openai-codex/gpt-6.1-sol",
      seconds: 1800,
      maxRequests: 0,
      compactionThreshold: null,
    },
    cycles: [],
    selectedEpoch: null,
    calls: [],
    paging: { totalCalls: 0, beforeCall: null, hasMore: false, firstIndex: 0, lastIndex: 0 },
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
    lastControl: { mode: "manual", consolidating: false, thinking: false, model: "openai-codex/gpt-6.1-sol" },
    activeCompaction: null,
    live: {
      runId: "",
      mode: "manual",
      epoch: null,
      connected: false,
      reason: "Core offline",
      agent: false,
      model: "openai-codex/gpt-6.1-sol",
      thinking: false,
      coreOffline: true,
    },
    livePhase: null,
    controlAllowed: false,
    controlReason: "Core offline",
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
    ...overrides,
  };
}

function makeFeed(): ActivityFeedData {
  return {
    resetRevision: 0,
    loadedRevision: 0,
    scope: null,
    generation: null,
    snapshot: 0,
    blocks: [],
    selected: undefined,
    selectionReady: true,
    before: null,
    historyFloorAt: null,
    hasMore: false,
    total: 0,
    historical: false,
    loading: false,
    loadingOlder: false,
    error: "",
    filter: "all",
    query: "",
    setFilter() {},
    setQuery() {},
    async earlier() {},
    latest() {},
  };
}

function createStubTransport(overrides: Partial<LiveSessionTransport> = {}): Partial<LiveSessionTransport> {
  return {
    readRun: async () => makeOfflineRunData(),
    fetchEventPool: async () => ({ snapshot: makePoolSnapshot(), hostOnline: false, coreOffline: true }),
    mutateEventPool: async () => ({ snapshot: makePoolSnapshot(), hostOnline: true }),
    sendRuntimeControl: async () => ({}),
    updateWorkspaceShioriModel: async () => ({}),
    ...overrides,
  };
}

test("synthesizeEmptyRunData builds valid 0-run RunData from project.defaults for en and zh", () => {
  const project: Project = {
    id: "elden-ring",
    name: "Elden Ring",
    workspace: "/tmp/elden-ring",
    runs: [],
    core: {
      online: false,
      mode: "manual",
      launchedBy: "app",
    },
    defaults: {
      model: "anthropic/claude-opus-4-6",
      serviceTier: "priority",
      effort: "high",
      maxSeconds: 2400,
    },
  };

  const enRun = synthesizeEmptyRunData(project, "en");
  assert.equal(enRun.project, "elden-ring");
  assert.equal(enRun.run, "");
  assert.equal(enRun.manifest.model, "anthropic/claude-opus-4-6");
  assert.equal(enRun.manifest.seconds, 2400);
  assert.equal(enRun.lastControl?.model, "anthropic/claude-opus-4-6");
  assert.equal(enRun.lastControl?.serviceTier, "priority");
  assert.equal(enRun.lastControl?.effort, "high");
  assert.equal(enRun.live?.coreOffline, true);
  assert.equal(enRun.live?.maxSeconds, 2400);
  assert.equal(enRun.live?.launchedBy, "app");
  assert.equal(enRun.controlAllowed, false);
  assert.match(enRun.live?.reason ?? "", /Core offline/);
  assert.equal(enRun.updatedAt, "1970-01-01T00:00:00.000Z");

  const zhRun = synthesizeEmptyRunData(project, "zh");
  assert.match(zhRun.live?.reason ?? "", /Core 未启动/);
  assert.equal(zhRun.updatedAt, enRun.updatedAt);
});

test("offline startAuto and sendPoolEvent track spawningCore and capture spawned runId", async () => {
  const seenCommands: RuntimeControlCommand[] = [];
  const seenPool: EventPoolCommand[] = [];
  let releaseControl!: () => void;
  let updatedCount = 0;

  const engine = new LiveSessionEngine({
    project: "zero-ws",
    transport: createStubTransport({
      sendRuntimeControl: async (_project, _workspace, command) => {
        seenCommands.push(command);
        await new Promise<void>(resolve => {
          releaseControl = resolve;
        });
        return {
          ok: true,
          spawned: true,
          runId: "20261113T120000Z-cold",
          status: { mode: "auto", connected: true, agent: true, thinking: true },
        };
      },
      mutateEventPool: async (_project, _workspace, command) => {
        seenPool.push(command);
        return {
          ok: true,
          spawned: true,
          runId: "20261113T120500Z-pool",
          hostOnline: true,
          hostStatus: { mode: "auto", connected: true, agent: true, thinking: true },
          snapshot: makePoolSnapshot(),
        };
      },
    }),
  });

  const startPromise = engine.runRuntimeCommand({
    workspace: "/tmp/zero-ws",
    run: "",
    baseUpdatedAt: "1970-01-01T00:00:00.000Z",
    mightSpawnCore: true,
    command: { action: "auto_on", message: "Boot and explore", seconds: 900 },
    onUpdated: () => {
      updatedCount += 1;
    },
  });

  assert.equal(engine.getSnapshot().spawningCore, true);
  releaseControl();
  await startPromise;

  let snap = engine.getSnapshot();
  assert.equal(snap.spawningCore, false);
  assert.equal(snap.lastSpawnedRun?.runId, "20261113T120000Z-cold");
  assert.equal(snap.lastSpawnedRun?.seq, 1);
  assert.equal(snap.optimisticHost?.run, "20261113T120000Z-cold");
  assert.equal(seenCommands[0]?.action, "auto_on");
  assert.equal(updatedCount, 1);

  await engine.mutatePool({
    workspace: "/tmp/zero-ws",
    run: "",
    baseUpdatedAt: "1970-01-01T00:00:00.000Z",
    mightSpawnCore: true,
    command: { action: "send", text: "Help check" },
    onUpdated: () => {
      updatedCount += 1;
    },
  });
  snap = engine.getSnapshot();
  assert.equal(snap.spawningCore, false);
  assert.equal(snap.lastSpawnedRun?.runId, "20261113T120500Z-pool");
  assert.equal(snap.lastSpawnedRun?.seq, 2);
  assert.equal(seenPool[0]?.action, "send");
  assert.equal(updatedCount, 2);

  engine.dispose();
});

test("409 DEVICE_BUSY captures pendingContention and confirmPreempt retries with preempt: true across runtime & pool mutations", async () => {
  const conflict: DeviceContentionConflict = {
    holderProjectId: "ws-alpha",
    holderWorkspaceName: "Alpha Workspace",
    deviceKey: "adb:emulator-5554",
    deviceLabel: "Pixel 8 (emulator-5554)",
    holderMode: "auto",
    holderOrigin: "app",
  };

  const controlCalls: RuntimeControlCommand[] = [];
  const poolCalls: EventPoolCommand[] = [];
  let failPreemptOnce = false;

  const engine = new LiveSessionEngine({
    project: "ws-beta",
    transport: createStubTransport({
      sendRuntimeControl: async (_project, _workspace, command) => {
        controlCalls.push(command);
        if (!("preempt" in command) || !command.preempt) {
          throw new RuntimeControlError("Device is held by ws-alpha", {
            status: 409,
            code: "DEVICE_BUSY",
            conflict,
          });
        }
        return {
          ok: true,
          spawned: true,
          runId: "20261113T130000Z-preempted",
          status: { mode: "auto", connected: true, agent: true, thinking: true },
        };
      },
      mutateEventPool: async (_project, _workspace, command) => {
        poolCalls.push(command);
        if (!command.preempt) {
          throw new RuntimeControlError("Device is held by ws-alpha", {
            status: 409,
            code: "DEVICE_BUSY",
            conflict,
          });
        }
        if (failPreemptOnce) {
          failPreemptOnce = false;
          throw new Error("Timed out stopping Alpha Workspace");
        }
        return {
          ok: true,
          spawned: true,
          runId: "20261113T130500Z-pool-preempt",
          hostOnline: true,
          hostStatus: { mode: "auto", connected: true, agent: true, thinking: true },
          snapshot: makePoolSnapshot(),
        };
      },
    }),
  });

  // 1. Runtime auto_on fails with 409 DEVICE_BUSY
  const firstErr = engine.runRuntimeCommand({
    workspace: "/tmp/ws-beta",
    run: "",
    baseUpdatedAt: "1970-01-01T00:00:00.000Z",
    mightSpawnCore: true,
    command: { action: "auto_on", message: "Take over quest", seconds: 1800 },
  });
  await assert.rejects(firstErr, err => isDeviceBusyError(err) && !isCoreOfflineError(err));

  let snap = engine.getSnapshot();
  assert.deepEqual(snap.pendingContention, conflict);
  assert.equal(snap.preemptError, null);
  assert.equal(snap.preemptSuccessSeq, 0);

  // Confirm preempt resends auto_on with preempt: true
  const ok = await engine.confirmPreempt();
  assert.equal(ok, true);
  snap = engine.getSnapshot();
  assert.equal(snap.pendingContention, null);
  assert.equal(snap.preemptSuccessSeq, 1);
  assert.equal(snap.lastSpawnedRun?.runId, "20261113T130000Z-preempted");
  assert.equal(controlCalls.length, 2);
  assert.equal((controlCalls[1] as Extract<RuntimeControlCommand, { action: "auto_on" }>).preempt, true);
  assert.equal((controlCalls[1] as Extract<RuntimeControlCommand, { action: "auto_on" }>).message, "Take over quest");

  // 2. Pool reply+resume fails with 409 DEVICE_BUSY, then preempt fails once and recovers on retry
  failPreemptOnce = true;
  await assert.rejects(
    engine.mutatePool({
      workspace: "/tmp/ws-beta",
      run: "20261113T130000Z-preempted",
      baseUpdatedAt: "1970-01-01T00:00:00.000Z",
      mightSpawnCore: true,
      command: { action: "reply", replyTo: "out-1", text: "Continue boss fight", resumeAuto: true, seconds: 600 },
    }),
    err => isDeviceBusyError(err),
  );

  const failedPreempt = await engine.confirmPreempt();
  assert.equal(failedPreempt, false);
  snap = engine.getSnapshot();
  assert.deepEqual(snap.pendingContention, conflict, "conflict stays open for user retry after preempt error");
  assert.match(snap.preemptError ?? "", /Timed out stopping Alpha Workspace/);

  const retriedPreempt = await engine.confirmPreempt();
  assert.equal(retriedPreempt, true);
  snap = engine.getSnapshot();
  assert.equal(snap.pendingContention, null);
  assert.equal(snap.preemptError, null);
  assert.equal(snap.preemptSuccessSeq, 2);
  assert.equal(poolCalls.at(-1)?.preempt, true);

  // 3. dismissContention clears pending state cleanly
  await assert.rejects(
    engine.runRuntimeCommand({
      workspace: "/tmp/ws-beta",
      run: "",
      baseUpdatedAt: "1970-01-01T00:00:00.000Z",
      mightSpawnCore: true,
      command: { action: "auto_on", message: "Keep in draft", seconds: null },
    }),
  );
  assert.ok(engine.getSnapshot().pendingContention);
  engine.dismissContention();
  assert.equal(engine.getSnapshot().pendingContention, null);
  assert.equal(engine.getSnapshot().preemptError, null);

  engine.dispose();
});

test("DeviceContentionDialog adheres strictly to modern-web-guidance native modal dialog rules", () => {
  const conflict: DeviceContentionConflict = {
    holderProjectId: "ws-alpha",
    holderWorkspaceName: "Alpha Workspace",
    deviceKey: "adb:emulator-5554",
    deviceLabel: "Pixel 8",
    holderMode: "auto",
    holderOrigin: "cli",
  };

  const html = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(DeviceContentionDialog, {
        conflict,
        busy: false,
        error: null,
        onConfirmPreempt() {},
        onDismiss() {},
        onSwitchToHolder() {},
      }),
    ),
  );

  assert.match(html, /^<dialog\b/);
  assert.match(html, /closedby="any"/);
  assert.doesNotMatch(html, /role="dialog"/);
  assert.doesNotMatch(html, /aria-modal=/);
  assert.match(html, /<form method="dialog">/);
  assert.match(html, /value="cancel"/);
  assert.match(html, /value="switch"/);
  assert.match(html, /value="preempt"/);
  assert.match(html, /autofocus=""/i);
  assert.match(html, /Alpha Workspace/);
  assert.match(html, /Pixel 8/);
  assert.match(html, /CLI/);

  const css = readFileSync(join(import.meta.dirname, "../components/device-contention-dialog.css"), "utf8");
  assert.doesNotMatch(css, /dialog\.device-contention-dialog\s*\{[^}]*\bdisplay\s*:/);
  assert.match(css, /dialog\.device-contention-dialog\[open\]\s*\{[^}]*display:\s*flex/);
  assert.match(css, /dialog\.device-contention-dialog:modal\s*\{[^}]*overscroll-behavior:\s*contain/);
  assert.match(
    css,
    /dialog\.device-contention-dialog::backdrop\s*\{[^}]*overflow:\s*hidden[^}]*overscroll-behavior:\s*contain/,
  );

  const globalsCss = readFileSync(join(import.meta.dirname, "../app/globals.css"), "utf8");
  assert.match(globalsCss, /device-contention-dialog\.css/);
});

test("Offline ShioriWorkbench & ShioriComposer default to start mode, omit offline bar, and allow outbound reply & resume", () => {
  const outboundHelp: PoolEvent = {
    id: "out-help-1",
    seq: 7,
    direction: "outbound",
    kind: "help_request",
    status: "pending",
    title: "Confirm boss strategy",
    text: "Should I spend potions before entering?",
    pauseRequested: true,
    createdAt: "2026-11-13T10:00:00.000Z",
  };

  const composerHtml = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(ShioriComposer, {
        project: "zero-ws",
        workspace: "/tmp/zero-ws",
        data: makeOfflineRunData(),
        isLiveRun: true,
        poolSnapshot: makePoolSnapshot([outboundHelp]),
        onUpdated() {},
      }),
    ),
  );

  assert.match(composerHtml, /data-shiori-composer="start"/);
  assert.match(composerHtml, /data-mode="start"/);
  assert.match(composerHtml, /Reply &amp; Resume/);

  const workbenchHtml = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(ShioriWorkbench, {
        project: "zero-ws",
        workspace: "/tmp/zero-ws",
        workspaceTitle: "Zero Workspace",
        data: makeOfflineRunData(),
        feed: makeFeed(),
        isLiveRun: true,
        onUpdated() {},
        onOpenPerf() {},
        onOpenCaps() {},
        onReturnLatest() {},
        observationSlot: createElement("div", null, "viewport"),
      }),
    ),
  );

  assert.doesNotMatch(workbenchHtml, /class="codex-host-offline-bar"/);
  assert.doesNotMatch(workbenchHtml, /class="codex-host-offline-row"/);
  assert.match(workbenchHtml, /data-shiori-composer="start"/);
  assert.match(workbenchHtml, /Core Offline \(Spawns on demand\)/);
  assert.match(workbenchHtml, /<dialog class="device-contention-dialog"/);
});
