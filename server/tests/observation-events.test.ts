import { registerFixture } from "./fixtures/registry";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregate } from "../src/query/aggregate";
import { mediaFile as readMediaFile } from "../src/query/data";
import { awaitArchive } from "./fixtures/await-archive";
const mediaFile = (...args: Parameters<typeof readMediaFile>) => awaitArchive(() => readMediaFile(...args));
import { eventObservations, perceptionStatus } from "../src/query/observation-events";
import { projectTelemetry } from "../src/query/telemetry";
import type { Event, PerceptionSnapshot } from "../src/query/types";

const hook = { id: "python/vision.py:observe", path: "vision.py", codeSHA: "source-hash" };
const makeEvents = () => {
  let seq = 0;
  return (type: string, data: Record<string, unknown>, trace = {}): Event => ({
    seq: ++seq, at: new Date(seq * 1000).toISOString(), atMs: seq * 1000,
    type, data, trace: { epoch: "current", ...trace },
  });
};
const completedHook = (id: string, stdout: string, observations: unknown[]) => ({
  hook, outcome: "success",
  result: { id, stdout, observations, status: "completed", exitCode: 0 },
});

test("model input follows hook execution IDs, including text-only outputs; raw captures remain separate", () => {
  const event = makeEvents();
  const fused = { id: "fused", controllerId: hook.id, mediaType: "image/png" };
  const result = aggregate([
    event("observation", { id: "raw", controllerId: "bottom", mediaType: "image/png" }),
    event("observe_hook_end", completedHook("fusion", "Two screens, fused.", [fused])),
    event("observation", fused),
    event("context", { observations: ["fused"], executions: ["fusion"] }),
    event("model_start", { observations: ["fused"] }, { modelCallId: "first" }),
    event("observe_hook_end", completedHook("text-only", "Only a text observation.", [])),
    event("context", { observations: [], executions: ["text-only"] }),
    event("model_start", { observations: [] }, { modelCallId: "second" }),
    event("observe_hook_end", { ...completedHook("failed", "Should not reach input", [{ ...fused, id: "failed-frame" }]), outcome: "error" }),
    event("context", { observations: [], executions: ["failed"] }),
    event("model_start", { observations: [] }, { modelCallId: "third" }),
    event("model_start", { observations: ["raw"] }, { modelCallId: "other", epoch: "other" }),
  ]);
  assert.deepEqual(result.observations.map((observation) => observation.id), ["raw", "fused"]);
  assert.equal(result.observations[1].origin, "observe_hook");
  assert.equal(result.observations[1].text, "Two screens, fused.");
  assert.deepEqual(result.observations[1].hook, hook);
  assert.deepEqual(result.calls.map((call) => call.inputObservations), [["fused"], [], [], ["raw"]]);
  assert.deepEqual(result.calls.map((call) => call.inputText), ["Two screens, fused.", "Only a text observation.", undefined, undefined]);
});

test("resident perception reuses snapshots but keeps each read's time, state and model input separate", () => {
  const event = makeEvents();
  const status = { state: "ready", generation: "g1", pid: 123, codeSHA: "v1" };
  const snapshot: PerceptionSnapshot = { id: "snapshot", sequence: 4, generation: "g1",
    recordedAt: new Date(0).toISOString(), sampling: { clock: "sampler", startedAtMs: 0, finishedAtMs: 20 },
    sampledAt: new Date(-1000).toISOString(), sources: [{ controller: "screen" }] };
  const output = (id: string) => ({ id, status: "completed", exitCode: 0, stdout: `read ${id}`,
    observations: [{ id: "image", mediaType: "image/png" }] });
  const records = [{ snapshot, text: "A sampled frame.", observations: output("first").observations }];
  const trace = { traceId: "trace", spanId: "read" };
  const events = [
    event("perception_status", { state: "unimplemented", generation: null }),
    event("perception_status", status),
    event("perception_observe_start", {}, trace),
    event("perception_observe_end", { status, snapshot, records, reused: false, durationMs: 20, result: output("first") }, trace),
    event("context", { observations: ["image"], executions: ["first"] }),
    event("model_start", { observations: ["image"] }, { modelCallId: "one" }),
    event("perception_observe_end", { status, snapshot, records, reused: true, durationMs: 3, result: output("second") }),
    event("context", { observations: ["image"], executions: ["second"] }),
    event("model_start", { observations: ["image"] }, { modelCallId: "two" }),
    event("perception_observe_end", { status: { state: "error", generation: "g2", error: "broken module" },
      error: "broken module", result: { id: "failure", stdout: "Perception failed", status: "failed", exitCode: 1, observations: [] } }),
    event("context", { observations: [], executions: ["failure"] }),
    event("model_start", { observations: [] }, { modelCallId: "three" }),
    event("perception_status", { state: "loading", generation: "g3" }, { epoch: "later" }),
  ];
  const result = aggregate(events);
  assert.deepEqual(result.observations.map(item => item.id), ["image"]);
  assert.equal(result.observations[0].origin, "perception");
  const [first, second, failure] = result.calls;
  assert.equal(first.inputText, "read first");
  assert.equal(first.perception?.legacyRepeated, false);
  assert.equal(second.perception?.legacyRepeated, true);
  assert.equal(failure.perception?.status?.state, "error");
  assert.equal(failure.inputText, "Perception failed");
  assert.equal(perceptionStatus(events)?.state, "loading");
  const telemetry = projectTelemetry(events);
  assert.equal(telemetry.perception.started, 1);
  assert.equal(telemetry.perception.durationMs.median, 20);
  assert.equal(telemetry.spans[0].outcome, "success");
  assert.equal(eventObservations(events[11]).length, 0);
});

test("media conversion failures replace the input result and epoch history retains its own lifecycle", () => {
  const event = makeEvents();
  const ready = { state: "ready", generation: "first", codeSHA: "one" };
  const result = { id: "read", status: "completed", exitCode: 0, stdout: "image ready",
    observations: [{ id: "bad-image", mediaType: "image/png" }] };
  const events = [
    event("perception_status", ready, { epoch: undefined }),
    event("control", { mode: "auto" }),
    event("perception_observe_end", { status: ready, result }),
    event("perception_input_error", { status: { ...ready, state: "error" }, error: "cannot encode",
      result: { ...result, status: "failed", exitCode: 1, stdout: "cannot encode", observations: [] } }),
    event("context", { observations: [], executions: ["read"] }),
    event("model_start", { observations: [] }, { modelCallId: "model" }),
    event("control", { mode: "auto" }, { epoch: "next" }),
    event("perception_status", { state: "ready", generation: "second", codeSHA: "two" }, { epoch: undefined }),
  ];
  const data = aggregate(events), call = data.calls[0];
  assert.equal(call.inputText, "cannot encode");
  assert.equal(call.perception?.status?.state, "error");
  assert.equal(perceptionStatus(events, "current")?.generation, "first");
  assert.equal(perceptionStatus(events, "next")?.generation, "second");
});

test("media serving accepts archived perception output and preserves type and run-directory boundaries", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ludens-hook-media-")));
  try {
    const workspace = join(root, "workspace"), runDir = join(workspace, "logs/run");
    const mediaDir = join(runDir, "observations");
    await mkdir(mediaDir, { recursive: true });
    await registerFixture(root, "project", workspace);
    const image = join(mediaDir, "fused.png"), outside = join(root, "outside.png");
    await writeFile(image, "archived pixels");
    await writeFile(outside, "outside run");
    await symlink(outside, join(mediaDir, "escaped.png"));
    const event = makeEvents();
    const events = [
      event("observation", { id: "raw", mediaType: "image/png", path: image }),
      event("perception_observe_end", { status: { state: "ready", generation: "one" }, result: {
        id: "fusion", status: "completed", exitCode: 0, stdout: "input", observations: [
        { id: "fused", mediaType: "image/png", path: image },
        { id: "json", mediaType: "application/json", path: image },
        { id: "html-source", mediaType: "text/html", path: image },
        { id: "unsupported", mediaType: "application/octet-stream", path: image },
        { id: "escaped", mediaType: "image/png", path: join(mediaDir, "escaped.png") },
      ] } }),
      event("observation", { id: "outside", mediaType: "image/png", path: outside }),
      event("perception_observe_end", { status: { state: "error", generation: "two" },
        result: { id: "failed", status: "failed", exitCode: 1, observations: [{ id: "failed", mediaType: "image/png", path: image }] } }),
    ];
    await writeFile(join(runDir, "manifest.json"), "{}");
    await writeFile(join(runDir, "events.jsonl"), events.map((item) => JSON.stringify(item)).join("\n") + "\n");
    for (const id of ["raw", "fused"]) {
      const media = await mediaFile("project", "run", id, root);
      assert.equal(media.bytes.toString(), "archived pixels");
      assert.equal(media.mediaType, "image/png");
    }
    for (const id of ["json", "html-source"]) {
      const media = await mediaFile("project", "run", id, root);
      assert.equal(media.bytes.toString(), "archived pixels");
      assert.equal(media.mediaType, "text/plain; charset=utf-8");
    }
    for (const id of ["unsupported", "failed"])
      await assert.rejects(mediaFile("project", "run", id, root), /未找到可展示/);
    for (const id of ["outside", "escaped"])
      await assert.rejects(mediaFile("project", "run", id, root), /必须位于当前运行目录/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("timeline media is shared across runs and resolved only within the registered workspace", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ludens-timeline-media-")));
  try {
    const workspace = join(root, "workspace"), timeline = join(workspace, ".ludens/timeline");
    const other = join(root, "other-workspace");
    await mkdir(join(timeline, "objects"), { recursive: true });
    await mkdir(join(timeline, "window"), { recursive: true });
    await mkdir(other);
    await registerFixture(root, "project", workspace);
    await writeFile(join(timeline, "objects/shared.png"), "one immutable original");
    await writeFile(join(timeline, "window/recent.png"), "temporary frame");
    await writeFile(join(other, "secret.png"), "other workspace");
    await symlink(join(other, "secret.png"), join(timeline, "objects/escape.png"));
    const observation = (id: string, asset: string) => ({ id, mediaType: "image/png",
      path: join(other, "secret.png"), timeline: { recordId: "record-one", sequence: 1, asset } });
    const event = makeEvents();
    const events = [
      event("observation", observation("shared", "objects/shared.png")),
      event("observation", observation("recent", "window/recent.png")),
      event("observation", observation("expired", "window/expired.png")),
      event("observation", observation("escape", "objects/escape.png")),
      event("observation", observation("traversal", "../../../other-workspace/secret.png")),
      event("observation", observation("absolute", join(other, "secret.png"))),
      event("observation", { id: "asset-only", mediaType: "image/png", timeline: { asset: "objects/shared.png" } }),
      event("observation", { id: "asset-only-traversal", mediaType: "image/png", timeline: { asset: "../outside.png" } }),
      event("observation", { id: "invalid-sequence", mediaType: "image/png", timeline: { asset: "objects/shared.png", sequence: 0 } }),
      event("observation", { id: "invalid-record", mediaType: "image/png", timeline: { asset: "objects/shared.png", recordId: "" } }),
      event("observation", { id: "unrecorded", mediaType: "image/png" }),
    ];
    for (const run of ["first", "second"]) {
      const runDir = join(workspace, "logs", run);
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, "manifest.json"), JSON.stringify({ workspace: other, workspaceId: "project" }));
      await writeFile(join(runDir, "events.jsonl"), events.map(item => JSON.stringify(item)).join("\n") + "\n");
      const media = await mediaFile("project", run, "shared", root);
      assert.equal(media.bytes.toString(), "one immutable original");
      assert.match(media.cacheControl, /immutable/);
    }
    assert.equal((await mediaFile("project", "first", "recent", root)).cacheControl, "no-store");
    assert.equal((await mediaFile("project", "first", "asset-only", root)).bytes.toString(), "one immutable original");
    await rm(join(timeline, "window/recent.png"));
    for (const id of ["recent", "expired"])
      await assert.rejects(mediaFile("project", "first", id, root), { code: "OBSERVATION_EXPIRED", status: 410 });
    await assert.rejects(mediaFile("project", "first", "unrecorded", root), { code: "OBSERVATION_UNRECORDED" });
    await assert.rejects(mediaFile("project", "first", "escape", root), /必须位于当前工作区时空轴内/);
    for (const id of ["traversal", "absolute", "asset-only-traversal", "invalid-sequence", "invalid-record"])
      await assert.rejects(mediaFile("project", "first", id, root), /无效的时空轴媒体引用/);
    await rm(timeline, { recursive: true });
    await symlink(other, timeline);
    await assert.rejects(mediaFile("project", "first", "shared", root), /必须位于当前工作区时空轴内/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("metadata-only deliveries project as unrecorded and canonical queries attach to explicit deliveries", () => {
  const e = makeEvents();
  const record = (id: string, sequence: number, media: unknown[] = []) => ({ id, sequence,
    timeline: { recordId: id, sequence }, generation: "worker", recordedAt: new Date(sequence * 1000).toISOString(),
    sampling: { clock: "sensor", startedAtMs: 0, finishedAtMs: 1 }, text: `read ${id}`, media });
  const frame = { id: "image", mediaType: "image/png", timeline: { recordId: "old", sequence: 1, asset: "objects/image.bin" } };
  const values = [
    e("perception_status", { state: "error", generation: "worker", error: "camera offline" }),
    e("perception_observe_end", { queryId: "history", ok: true, query: { id: "old" }, hasMore: false,
      records: [record("old", 1, [frame])], outcome: "success", durationMs: 7 }),
    e("perception_observe_end", { queryId: "sensor", ok: true, query: {}, hasMore: false,
      records: [record("sensor", 2)], outcome: "success" }),
    e("observation_context", { id: "delivery", origin: "explicit", observations: ["image"], queries: ["history", "sensor"] }),
    e("perception_observe_end", { queryId: "other", ok: true, query: {}, hasMore: false, records: [record("unselected", 3)] }),
    e("context", { observations: ["image"], executions: ["other"] }),
    e("model_start", { deliveryIds: ["delivery"], observations: ["wrong-image"] }, { modelCallId: "model" }),
    e("model_start", { deliveryIds: [], observations: ["wrong-image"] }, { modelCallId: "no-input" }),
    e("model_start", { deliveryIds: ["missing"], observations: ["wrong-image"] }, { modelCallId: "missing" }),
    e("perception_observe_end", { queryId: "failure", ok: false, query: {}, records: [], hasMore: false,
      error: { code: "EXPIRED", message: "history expired" }, outcome: "error" }),
  ];
  const result = aggregate(values);
  assert.deepEqual(result.calls.map(call => call.inputObservations), [["image"], [], []]);
  assert.deepEqual(result.calls.map(call => call.inputText), ["read old\n\nread sensor", undefined, undefined]);
  assert.deepEqual(result.calls[0].perceptionReads?.map(read => read.queryId), ["history", "sensor"]);
  assert.equal(result.calls[0].perceptionReads?.[0].status, undefined);
  assert.equal(result.perception?.state, "error");
  assert.equal(result.notices.filter(notice => notice.failed).length, 1);
  assert.equal(result.notices.find(notice => notice.failed)?.text, "history expired");
});
