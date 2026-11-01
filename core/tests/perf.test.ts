import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPerfContext } from "../src/perf/run-context.ts";
import { measureControlHandoff, verifyControlHandoff } from "../src/perf/control-handoff.ts";
import { measurePerceptionLifecycle, verifyPerceptionLifecycle } from "../src/perf/perception-lifecycle.ts";

const core = resolve(import.meta.dir, "..");
const runContextModule = resolve(import.meta.dir, "../src/perf/run-context.ts");

async function withDirectory(qualifier: string, run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), `ludens-perf-${qualifier}-`));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("control handoff perf measure meets its budgets", async () => {
  await withDirectory("handoff", async directory => {
    const ctx = await createPerfContext(directory);
    const measurements = await measureControlHandoff(ctx);
    const result = verifyControlHandoff(measurements);
    expect(result.failures).toEqual([]);
    expect(result.budgets.handoffMs).toBeLessThanOrEqual(500);
    expect(measurements.measurements).toHaveLength(2);
  });
}, 40_000);

test("perception lifecycle perf measure meets its budgets", async () => {
  await withDirectory("perception", async directory => {
    const ctx = await createPerfContext(directory);
    const measurements = await measurePerceptionLifecycle(ctx);
    const result = verifyPerceptionLifecycle(measurements);
    expect(result.failures).toEqual([]);
    expect(result.budgets.warmMs).toBeLessThan(result.budgets.coldMs);
  });
}, 40_000);

const cancelSource = (directory: string, suite: string) => `
const { createPerfContext } = await import(${JSON.stringify(runContextModule)});
const { measure${suite === "handoff" ? "ControlHandoff" : "PerceptionLifecycle"} } = await import(${JSON.stringify(join(core, `src/perf/${suite === "handoff" ? "control-handoff" : "perception-lifecycle"}.ts`))});
const control = new AbortController();
const ctx = await createPerfContext(${JSON.stringify(directory)}, { signal: control.signal });
const record = ctx.log.record; let fired = false;
const trigger = ${JSON.stringify(suite)} === "handoff"
  ? (type: string, data: any) => type === "benchmark_handoff_requested" && data.scenario === "nested-python"
  : (type: string, data: any) => type === "benchmark_perception_step" && data.stage === "first";
Object.defineProperty(ctx.log, "record", { value: (type: string, data: any, trace: any, metadata: any) => {
  record(type, data, trace, metadata);
  if (trigger(type, data) && !fired) { fired = true; queueMicrotask(() => control.abort(new Error("perf cancelled"))); }
} });
let caught = "";
try { await measure${suite === "handoff" ? "ControlHandoff" : "PerceptionLifecycle"}(ctx); } catch (error) { caught = String(error); }
let pythonGone = true;
const pidFile = Bun.file(${JSON.stringify(join(directory, "workspace/handoff-python.pid"))});
if (await pidFile.exists()) { const pid = Number(await pidFile.text()); try { process.kill(pid, 0); pythonGone = false; } catch {} }
await Bun.write(${JSON.stringify(join(directory, "cancel.json"))}, JSON.stringify({ fired, caught, pythonGone }));`;

for (const suite of ["handoff", "perception"] as const) {
  test(`${suite} perf cancellation cleans up child processes before returning`, async () => {
    await withDirectory(`abort-${suite}`, async directory => {
      const child = Bun.spawn([process.execPath, "-e", cancelSource(directory, suite)],
        { cwd: core, stdout: "pipe", stderr: "pipe" });
      const timeout = setTimeout(() => child.kill(), 25_000);
      try {
        const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
        expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
        expect(JSON.parse(await readFile(join(directory, "cancel.json"), "utf8"))).toEqual({
          fired: true, caught: "Error: perf cancelled", pythonGone: true,
        });
      } finally { clearTimeout(timeout); if (child.exitCode === null) child.kill(); }
    });
  }, 30_000);
}

test("video storage perf meets its budgets in the framework Python environment", async () => {
  await withDirectory("video", async directory => {
    const result = spawnSync("uv", ["run", "--project", "python", "--frozen", "python", "src/perf/video-storage.py",
      "--records", "120", "--rate", "24", "--output", join(directory, "video")],
      { cwd: core, encoding: "utf8", env: process.env });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const summary = JSON.parse(result.stdout);
    expect(Object.values(summary.budgetChecks as Record<string, boolean>).every(Boolean)).toBe(true);
    expect(summary.realtimeFactor).toBeGreaterThanOrEqual(0.98); // matches the suite budget incl. pacing/GC tolerance
  });
}, 60_000);
