/** Rebuild disposable directories and query real archives, without touching sources.
 * npm run perf                                      (synthetic run, asserts budgets + call/operation coverage)
 * node --expose-gc --import tsx perf/index-memory.ts \
 *   --run /absolute/run --cache-root /absolute/isolated --output /absolute/report.json [--epoch UUID]
 */
import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { mkdirSync, statSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
const args = process.argv.slice(2);
const option = (name: string) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };

/** Perf budgets for the synthetic `npm run perf` mode; violations exit non-zero. */
const budgets = { peakRssMiB: 2048, peakHeapUsedMiB: 1024, retainedAfterReleaseMiB: 256, coldBuildMs: 180_000, pagedQueryMs: 2_000 };
/** Synthetic workload: paired model/tool identities with capability/shiori spans per call. */
const SYNTHETIC_EPOCH = "cycle", SYNTHETIC_CALLS = 3000, SYNTHETIC_STEP_MS = 50;
const SYNTHETIC_BASE_MS = Date.UTC(2026, 9, 24);
const generated = !option("--run") && !process.env.LUDENS_BENCH_ARTIFACTS ? realpathSync(mkdtempSync(join(tmpdir(), "ludens-perf-index-"))) : undefined;
if (generated) {
  const directory = join(generated, "logs", "synthetic-run");
  mkdirSync(directory, { recursive: true });
  const rows: string[] = [];
  const stamp = (i: number) => { const atMs = SYNTHETIC_BASE_MS + i * SYNTHETIC_STEP_MS; return { at: new Date(atMs).toISOString(), atMs }; };
  let i = 0;
  const push = (type: string, trace: Record<string, string>, data: Record<string, any>) => {
    const { at, atMs } = stamp(i);
    rows.push(JSON.stringify({ schemaVersion: 2, runId: "synthetic-run", seq: i + 1, at, atMs,
      source: { component: "ludens" }, origin: { eventId: `synthetic-${i}`, clockId: "synthetic", seq: i + 1, at, atMs },
      type, trace, data: { ...data, note: `synthetic frame ${i} ` + "x".repeat(160) } }));
    i++;
  };
  // One auto period brackets the whole run; every call below carries paired identities on one shared span,
  // with the native shiori span opening before ModelTrace assigns the modelCallId (late-relation path).
  push("control", { epoch: SYNTHETIC_EPOCH }, { mode: "auto", epoch: SYNTHETIC_EPOCH });
  for (let c = 0; c < SYNTHETIC_CALLS; c++) {
    const traceId = `trace-${c}`, spanId = `span-${c}`, modelCallId = `model-${c}`, toolCallId = `tool-${c}`;
    const span = { epoch: SYNTHETIC_EPOCH, traceId, spanId };
    push("shiori_span_start", { ...span }, { operation: "invoke_agent", name: `agent-${c}` });
    push("model_start", { ...span, modelCallId }, {});
    push("capability_start", { ...span, modelCallId }, { action: "call", id: "python/macros.py:step" });
    push("tool_start", { ...span, modelCallId, toolCallId },
      { toolName: "read", args: { path: `skills/demo-${c}/SKILL.md` }, intent: `Review demo ${c}` });
    push("tool_end", { ...span, modelCallId, toolCallId }, { toolName: "read", isError: false });
    push("capability_end", { ...span, modelCallId }, { outcome: "success", durationMs: 12 });
    push("model_end", { ...span, modelCallId }, { durationMs: 120, stopReason: "stop", usage: { input: 100, cacheRead: 10 } });
    push("shiori_span_end", { ...span, modelCallId }, { outcome: "success", durationMs: 200 });
  }
  push("control", { epoch: SYNTHETIC_EPOCH }, { mode: "manual" });
  writeFileSync(join(directory, "events.jsonl"), rows.join("\n") + "\n");
  writeFileSync(join(directory, "manifest.json"), JSON.stringify({ kind: "benchmark", runId: "synthetic-run",
    workspace: generated, benchmark: { name: "ludens/index-memory", digest: `sha256:${"0".repeat(64)}` } }) + "\n");
  args.push("--run", directory);
}
const artifacts = process.env.LUDENS_BENCH_ARTIFACTS;
const cachePath = option("--cache-root") ?? (artifacts ? join(artifacts, "index-cache") : undefined) ?? (generated ? join(generated, "index-cache") : undefined);
const outputPath = option("--output") ?? (artifacts ? join(artifacts, "measurements.json") : undefined) ?? (generated ? join(generated, "measurements.json") : undefined);
assert.ok(cachePath && outputPath, "--cache-root and --output are required outside a Shiori trial");
const run = resolve(option("--run")!), cacheRoot = resolve(cachePath), output = resolve(outputPath);
assert.ok(!cacheRoot.startsWith(run + "/"), "Use an isolated disposable directory");
process.env.LUDENS_APP_INDEX_ROOT = cacheRoot;
process.env.LUDENS_APP_INDEX_IDLE_MS = "1";
if (option("--cache-bytes")) process.env.LUDENS_APP_INDEX_CACHE_BYTES = option("--cache-bytes");
if (option("--build-bytes")) process.env.LUDENS_APP_BUILD_BYTES = option("--build-bytes");
mkdirSync(dirname(output), { recursive: true });
const memory = () => process.memoryUsage();
const sourceBefore = statSync(join(run, "events.jsonl"));
const report: Record<string, any> = { run, startedAt: new Date().toISOString(), sourceBytes: sourceBefore.size,
  before: memory(), phases: [], samples: [], limitations: ["Offline worker-equivalent reader; separate HTTP validation covers Next dev and production."] };
const save = () => writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
let peakHeap = 0, peakRss = 0, peakCombinedRss = 0;
const childPids = new Set<number>();
const timer = setInterval(() => { const m = memory(); peakHeap = Math.max(peakHeap, m.heapUsed); peakRss = Math.max(peakRss, m.rss); }, 50).unref();
const bytes = (path: string): number => readdirSync(path, { withFileTypes: true }).reduce((n, entry) => n +
  (entry.isDirectory() ? bytes(join(path, entry.name)) : statSync(join(path, entry.name)).size), 0);
async function main() {
  const { getLogIndex, closeLogIndexes, indexCacheStats, pruneLogIndexes, storageMetrics } = await import("../lib/log-index");
  const { readRunProjection } = await import("../lib/run-index");
  const { queryActivity } = await import("../lib/activity");
  const { queryOperationRefs } = await import("../lib/operation-index");
  const { ensureArchiveBuild, controlArchiveBuild, closeArchiveBuilds } = await import("../lib/cold-build");
  const { archiveBudget } = await import("../lib/archive-budget");
  report.budget = archiveBudget();
  let index = getLogIndex(run);
  try { index.archiveWorkspace = JSON.parse(readFileSync(join(run, "manifest.json"), "utf8")).workspace; } catch { /* Offline fixtures may omit manifests. */ }
  const phase = async (name: string, step: () => Promise<void>) => {
    const started = performance.now(); await step(); global.gc?.();
    const value = { name, ms: performance.now() - started, memory: memory(), cache: indexCacheStats(), bytes: bytes(index.directory) };
    report.phases.push(value); save(); process.stderr.write(JSON.stringify(value) + "\n");
  };
  await phase("cold-build", async () => {
    ensureArchiveBuild(index);
    const started = Date.now();
    for (;;) {
      const state = await controlArchiveBuild(index, {});
      assert.ok(state, "Build state missing");
      report.build = state;
      if (state.pid) {
        childPids.add(state.pid);
        try {
          const rssKiB = execFileSync("ps", ["-o", "rss=", "-p", `${process.pid},${state.pid}`], { encoding: "utf8" })
            .trim().split(/\s+/).reduce((sum, value) => sum + Number(value), 0);
          peakCombinedRss = Math.max(peakCombinedRss, rssKiB * 1024);
        } catch { /* Child may exit between progress and process sampling. */ }
      }
      if (state.state === "ready") break;
      assert.ok(state.state === "queued" || state.state === "building", state.error ?? state.state);
      assert.ok(Date.now() - started < 15 * 60_000, "Archive build exceeded benchmark timeout");
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    index = getLogIndex(run); report.events = index.eventRevision;
  });
  const release = index.retain();
  const epoch = option("--epoch") ?? null;
  await phase("history-and-repeat", async () => {
    const scope = { project: "offline", runId: run.split("/").at(-1)!, epoch };
    const samples = [1, Math.floor(index.eventRevision / 2), index.eventRevision];
    for (const position of samples) {
      const event = await index.readEvent(position); assert.ok(event);
      report.samples.push({ position, seq: event.seq, type: event.type,
        sha256: createHash("sha256").update(JSON.stringify(event)).digest("hex") });
    }
    const stream = createReadStream(join(run, "events.jsonl"), { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let position = 0;
    const expected = new Map(report.samples.map((sample: any) => [sample.position, sample.sha256]));
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        position++;
        if (expected.has(position)) assert.equal(createHash("sha256").update(JSON.stringify(JSON.parse(line))).digest("hex"), expected.get(position));
      }
    } finally { lines.close(); stream.destroy(); }
    assert.equal(position, index.eventRevision);
    report.sourceSamplesVerified = true;
    const queryStarted = performance.now();
    for (let i = 0; i < 5; i++) {
      const history = await queryActivity(index, scope, { mode: "history", limit: 20 });
      assert.ok(history.blocks.length);
      const block = await queryActivity(index, scope, { mode: "block", id: history.blocks[0].id });
      assert.equal(block.blocks[0].id, history.blocks[0].id);
      const page = await readRunProjection(index, epoch, {}, epoch === null);
      report.calls = page.paging.totalCalls; report.summary = page.summary;
      report.history = { total: history.total, firstVisible: history.blocks[0].id, lastVisible: history.blocks.at(-1)?.id };
      if (generated) {
        // The synthetic workload must exercise the real projections: every call paired,
        // every call completed, and every call covered by a model operation window.
        assert.equal(page.paging.totalCalls, SYNTHETIC_CALLS, "synthetic model calls missing");
        assert.equal(page.summary.completed, SYNTHETIC_CALLS, "synthetic model completions missing");
        assert.equal(page.telemetry.capabilities.stats.started, SYNTHETIC_CALLS, "synthetic capability spans missing");
        assert.equal(page.telemetry.shiori.stats.started, SYNTHETIC_CALLS, "synthetic shiori spans missing");
        const at = Date.parse(page.calls.at(-1)!.at);
        const operations = await queryOperationRefs(index, { epoch: SYNTHETIC_EPOCH,
          start: at, end: at + 5 * SYNTHETIC_STEP_MS, limit: 20 });
        assert.deepEqual(operations.map(({ track, status }) => ({ track, status })), [
          { track: "model", status: "completed" }, { track: "tool", status: "completed" },
        ], "synthetic model/tool operation pairing missing");
        report.overlappingOperations = operations.length;
      } else if (page.calls[0]) {
        const at = Date.parse(page.calls[0].at);
        report.overlappingOperations = (await queryOperationRefs(index, { epoch, start: at, end: at + 10_000, limit: 20 })).length;
      }
    }
    report.pagedQueryMs = performance.now() - queryStarted;
  });
  report.queryMetrics = { ...storageMetrics };
  if (option("--compare")) {
    const expected = JSON.parse(readFileSync(option("--compare")!, "utf8"));
    for (const field of ["events", "calls", "summary", "history", "samples"]) assert.deepEqual(report[field], expected[field], `Mismatch: ${field}`);
    report.baselineMatches = true;
  }
  report.directories = Object.fromEntries(readdirSync(index.directory, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => [e.name, bytes(join(index.directory, e.name))]));
  release(); await closeArchiveBuilds(); pruneLogIndexes(Date.now() + 10_000); await closeLogIndexes(); global.gc?.();
  report.afterClose = memory(); report.afterCloseCache = indexCacheStats();
  assert.equal(statSync(join(run, "events.jsonl")).size, sourceBefore.size);
  assert.equal(statSync(join(run, "events.jsonl")).mtimeMs, sourceBefore.mtimeMs);
  report.peakHeapSampled = peakHeap; report.peakRssSampled = peakRss;
  report.peakCombinedRssSampled = peakCombinedRss;
  report.builderPids = [...childPids];
  report.buildersExited = [...childPids].every(pid => { try { process.kill(pid, 0); return false; } catch { return true; } });
  assert.ok(report.buildersExited, "Builder process did not exit");
  report.completedAt = new Date().toISOString(); save(); clearInterval(timer);
  if (generated) {
    const mib = (value: number) => value / 1024 / 1024;
    const checks = {
      "peak-rss-mib": mib(report.peakRssSampled) <= budgets.peakRssMiB,
      "peak-heap-used-mib": mib(report.peakHeapSampled) <= budgets.peakHeapUsedMiB,
      "retained-after-release-mib": mib(report.afterClose.rss - report.before.rss) <= budgets.retainedAfterReleaseMiB,
      "cold-build-ms": report.phases.find((phase: any) => phase.name === "cold-build")!.ms <= budgets.coldBuildMs,
      "paged-query-ms": report.pagedQueryMs <= budgets.pagedQueryMs,
    };
    report.budgetChecks = checks;
    process.stderr.write(JSON.stringify({ budgets, checks, measurements: {
      peakRssMiB: mib(report.peakRssSampled), peakHeapUsedMiB: mib(report.peakHeapSampled),
      retainedAfterReleaseMiB: mib(report.afterClose.rss - report.before.rss),
      coldBuildMs: report.phases.find((phase: any) => phase.name === "cold-build")!.ms, pagedQueryMs: report.pagedQueryMs } }) + "\n");
    rmSync(generated, { recursive: true, force: true });
    if (Object.values(checks).some(passed => !passed)) {
      process.stderr.write(`index-memory budget violations: ${Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name).join(", ")}\n`);
      process.exitCode = 1;
    }
  }
  if (artifacts && process.env.LUDENS_BENCH_TRIAL_ID) writeFileSync(join(artifacts, "context.json"), JSON.stringify({
    trialId: process.env.LUDENS_BENCH_TRIAL_ID, workspace: process.env.LUDENS_WORKSPACE,
    conditions: { sourceRun: run, sourceBytes: sourceBefore.size, budget: report.budget },
    subjects: [], artifacts: [], limitations: report.limitations,
  }) + "\n");
}
main().catch(async error => {
  report.error = String(error.stack ?? error); save(); process.stderr.write(report.error + "\n"); process.exitCode = 1;
  const { closeArchiveBuilds } = await import("../lib/cold-build");
  const { closeLogIndexes } = await import("../lib/log-index");
  await closeArchiveBuilds(); await closeLogIndexes(); clearInterval(timer);
});
