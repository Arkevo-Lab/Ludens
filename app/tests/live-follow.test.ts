import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanViewSearchParams, hasSelectedEvidence, latestLiveUrl, liveContext, resolveLiveSelection } from "../lib/live-follow";
import { ConsoleSidebar } from "../shell/console-sidebar";
import { WorkspacePicker } from "../features/workspaces/workspace-picker";
import { RunPicker } from "../features/workspaces/run-picker";
import type { LiveStatus } from "../lib/types";

const nodeRequire = createRequire(import.meta.url);
const cjsModule = nodeRequire("node:module") as {
  _extensions: Record<string, (mod: unknown, filename: string) => void>;
};
cjsModule._extensions[".css"] ??= () => {};

const paused = { location: "?view=live&project=a", project: "a", run: "run-1", requestedRun: "", epoch: "", archiveRevision: 1 };
const selection = {
  location: paused.location, project: "a", requestedRun: "", requestedEpoch: "", latestRun: "run-2",
  refresh: false, archiveRevision: 2, paused,
};
const live: LiveStatus = {
  runId: "run-2", epoch: "epoch-2", mode: "auto", connected: true, reason: "", agent: true, thinking: true,
};
const context = {
  run: "run-2", latestRun: "run-2", selectedEpoch: "epoch-2", latestEpoch: "epoch-2",
  selectedEvidence: false, historicalLog: false, live,
};

test("paused implicit selection keeps its run and defers archive invalidation", () => {
  assert.deepEqual(resolveLiveSelection(selection), { project: "a", requestedRun: "", epoch: "", run: "run-1", archiveRevision: 1, frozen: true });
  // An empty workspace must not spontaneously jump into its first run while paused.
  assert.equal(resolveLiveSelection({ ...selection, paused: { ...paused, run: "" } }).run, "");
});

test("explicit navigation while paused starts a new snapshot", () => {
  assert.deepEqual(resolveLiveSelection({ ...selection, location: "?view=live&project=a&run=older", requestedRun: "older" }),
    { project: "a", requestedRun: "older", epoch: "", run: "older", archiveRevision: 2, frozen: false });
  assert.equal(resolveLiveSelection({ ...selection, location: "?view=live&project=b", project: "b" }).run, "run-2");
});

test("resume follows the latest default but preserves an explicitly selected historical run", () => {
  assert.deepEqual(resolveLiveSelection({ ...selection, refresh: true }), { project: "a", requestedRun: "", epoch: "", run: "run-2", archiveRevision: 2, frozen: false });
  assert.equal(resolveLiveSelection({ ...selection, refresh: true, requestedRun: "older" }).run, "older");
});

test("catalog reordering cannot switch an implicit workspace while paused", () => {
  const value = resolveLiveSelection({ ...selection, location: "?view=live", project: "new-default",
    paused: { ...paused, location: "?view=live" } });
  assert.equal(value.project, "a");
  assert.equal(value.run, "run-1");
  assert.equal(value.frozen, true);
});

test("a removed catalog entry does not erase a paused explicit epoch", () => {
  const value = resolveLiveSelection({ ...selection, project: "fallback", requestedRun: "", requestedEpoch: "",
    paused: { ...paused, requestedRun: "run-1", epoch: "epoch-1" } });
  assert.equal(value.project, "a");
  assert.equal(value.requestedRun, "run-1");
  assert.equal(value.epoch, "epoch-1");
});

test("return to latest creates a clean URL for the same workspace", () => {
  const url = new URL(latestLiveUrl("workspace / 中文"), "http://localhost");
  assert.deepEqual([...url.searchParams], [["view", "live"], ["project", "workspace / 中文"]]);
  assert.equal(url.pathname, "/");
});

test("every evidence locator is recognized independently, including a block without a request", () => {
  for (const key of ["call", "beforeCall", "block", "image", "at"]) assert.equal(hasSelectedEvidence(`?${key}=one`), true);
  assert.equal(hasSelectedEvidence("?view=live&project=a&run=run-2&epoch=epoch-2"), false);
});

test("explicit newest run/epoch is still current; selected evidence and older log are distinct", () => {
  assert.deepEqual(liveContext(context), { kind: "latest", host: "auto" });
  assert.deepEqual(liveContext({ ...context, selectedEvidence: true }), { kind: "evidence", host: "auto" });
  assert.deepEqual(liveContext({ ...context, historicalLog: true }), { kind: "log", host: "auto" });
  assert.equal(liveContext({ ...context, selectedEvidence: true, historicalLog: true }).kind, "evidence");
});

test("old run and epoch take precedence over evidence and never claim an active host", () => {
  assert.deepEqual(liveContext({ ...context, run: "run-1", selectedEvidence: true }), { kind: "run", host: "historical" });
  assert.deepEqual(liveContext({ ...context, selectedEpoch: "epoch-1", selectedEvidence: true }), { kind: "epoch", host: "historical" });
});

test("manual hosts without an epoch are current, while missing or disconnected hosts are not called historical", () => {
  assert.deepEqual(liveContext({ ...context, live: { ...live, mode: "manual", epoch: null } }), { kind: "latest", host: "manual" });
  assert.deepEqual(liveContext({ ...context, live: null }), { kind: "latest", host: "unavailable" });
  assert.deepEqual(liveContext({ ...context, live: { ...live, connected: false } }), { kind: "latest", host: "disconnected" });
  assert.equal(liveContext({ ...context, live: { ...live, epoch: "other" } }).host, "unavailable");
});

test("view navigation strips cross-view params and redundant latest run pins", () => {
  const fromReplay = "?view=replay&project=switch2&run=run-2&epoch=all&at=159000&replayRecord=rec-1&replaySequence=12";
  const toLive = cleanViewSearchParams(fromReplay, "live", { project: "switch2", latestRunId: "run-2" });
  assert.deepEqual([...toLive], [["view", "live"], ["project", "switch2"]]);

  const fromOlderReplay = "?view=replay&project=switch2&run=run-1&epoch=all&at=45000";
  const toOlderLive = cleanViewSearchParams(fromOlderReplay, "live", { project: "switch2", latestRunId: "run-2" });
  assert.deepEqual([...toOlderLive], [["view", "live"], ["project", "switch2"], ["run", "run-1"]]);

  const fromPerf = "?view=perf&project=switch2&call=c-9&perfTab=requests&image=obs-4";
  const toReplay = cleanViewSearchParams(fromPerf, "replay", { project: "switch2", latestRunId: "run-2" });
  assert.deepEqual([...toReplay], [["view", "replay"], ["project", "switch2"]]);
});

test("parseViewParam normalizes capabilities and studio URL aliases alongside canonical view IDs", async () => {
  const { parseViewParam } = await import("../shell/use-dashboard-controller");
  assert.equal(parseViewParam("capabilities"), "caps");
  assert.equal(parseViewParam("studio"), "perception");
  assert.equal(parseViewParam("caps"), "caps");
  assert.equal(parseViewParam("perception"), "perception");
  assert.equal(parseViewParam("replay"), "replay");
  assert.equal(parseViewParam("perf"), "perf");
  assert.equal(parseViewParam("unknown-view"), "live");
  assert.equal(parseViewParam(null), "live");
  assert.equal(parseViewParam(""), "live");
});

test("natural live polling pauses on hidden tabs and skips completed historical runs", async () => {
  const { isLiveRunActive, shouldPollRunState } = await import("../shell/use-dashboard-controller");
  assert.equal(isLiveRunActive({ run: "run-2", live }), true);
  assert.equal(isLiveRunActive({ run: "run-1", live }), false);
  assert.equal(isLiveRunActive({ run: "run-2", live: { ...live, connected: false } }), false);
  assert.equal(isLiveRunActive({ run: "run-2", live: null }), false);

  // Hidden tab always pauses polling
  assert.equal(shouldPollRunState({ visible: false, requestedRun: "", data: { run: "run-2", live } }), false);
  // Implicit latest run always polls when visible (even if current run ended, to detect a newly started run)
  assert.equal(shouldPollRunState({ visible: true, requestedRun: "", data: { run: "run-1", live: null } }), true);
  // Explicit historical run polls until initial snapshot loads, then stops once confirmed inactive
  assert.equal(shouldPollRunState({ visible: true, requestedRun: "run-1", data: null }), true);
  assert.equal(shouldPollRunState({ visible: true, requestedRun: "run-1", data: { run: "run-2", live } }), true);
  assert.equal(shouldPollRunState({ visible: true, requestedRun: "run-1", data: { run: "run-1", live } }), false);
  assert.equal(shouldPollRunState({ visible: true, requestedRun: "run-1", data: { run: "run-1", live: null } }), false);
  // Explicit active live run continues polling while visible
  assert.equal(shouldPollRunState({ visible: true, requestedRun: "run-2", data: { run: "run-2", live } }), true);
});

test("sidebar WorkspacePicker and compact RunPicker render clean contextual triggers", () => {
  const projects = [
    { id: "ws-1", name: "switch2-diablo3", workspace: "/tmp/switch2-diablo3", available: true, runs: [] },
  ];
  const sidebarHtml = renderToStaticMarkup(
    createElement(ConsoleSidebar, {
      view: "settings",
      viewLink: id => `?view=${id}`,
      onNavigate() {},
      workspaceSlot: createElement(WorkspacePicker, {
        variant: "sidebar",
        muted: true,
        projects,
        value: "ws-1",
        onChange() {},
      }),
    }),
  );
  assert.match(sidebarHtml, /sidebar-workspace-slot/);
  assert.match(sidebarHtml, /context-picker-trigger-sidebar/);
  assert.match(sidebarHtml, /data-muted="true"/);
  assert.match(sidebarHtml, /switch2-diablo3/);

  const compactRunHtml = renderToStaticMarkup(
    createElement(RunPicker, {
      runs: [{ id: "run-2", model: "gpt-5", seconds: 0, drivers: [], startedAt: "2026-04-11T12:00:00Z" }],
      latest: { id: "run-2", model: "gpt-5", seconds: 0, drivers: [], startedAt: "2026-04-11T12:00:00Z" },
      value: "",
      onChange() {},
    }),
  );
  assert.match(compactRunHtml, /context-picker-trigger-compact/);
  assert.doesNotMatch(compactRunHtml, /context-picker-label/);
});
