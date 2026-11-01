/** Perf entrypoint: subsystem latency, throughput and memory budgets (not Harbor evaluation). */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createPerfContext } from "./run-context.ts";
import { measureControlHandoff, verifyControlHandoff } from "./control-handoff.ts";
import { measurePerceptionLifecycle, verifyPerceptionLifecycle } from "./perception-lifecycle.ts";

interface PerfResult { checks: Record<string, boolean>; budgets?: Record<string, number>; failures: string[]; output?: string }

const suites: Record<string, (root: string) => Promise<PerfResult>> = {
  "control-handoff": async (root: string) => {
    const ctx = await createPerfContext(root);
    const measurements = await measureControlHandoff(ctx);
    return verifyControlHandoff(measurements);
  },
  "perception-lifecycle": async (root: string) => {
    const ctx = await createPerfContext(root);
    const measurements = await measurePerceptionLifecycle(ctx);
    return verifyPerceptionLifecycle(measurements);
  },
  "video-storage": async (root: string) => {
    const core = resolve(import.meta.dir, "../..");
    const result = spawnSync("uv", ["run", "--project", "python", "--frozen", "python", "src/perf/video-storage.py",
      "--records", "240", "--rate", "24", "--output", join(root, "video-storage")],
      { cwd: core, encoding: "utf8", env: process.env });
    if (result.status !== 0) {
      return { checks: { "video-storage-exit": false }, failures: ["video-storage-exit"],
        output: `${result.stdout}\n${result.stderr}` } satisfies PerfResult;
    }
    const summary = JSON.parse(result.stdout);
    const failures = Object.entries(summary.budgetChecks as Record<string, boolean>).filter(([, passed]) => !passed).map(([name]) => name);
    return { checks: summary.budgetChecks as Record<string, boolean>, failures,
      budgets: { realtimeFactor: summary.realtimeFactor, coldFrameMs: summary.coldFrameMs,
        maximumMeanPixelError: summary.maximumMeanPixelError, rssPeakMiB: summary.rssPeakBytes / 1024 / 1024 } };
  },
} as const;

const selected = process.argv[2] && process.argv[2] !== "all" ? [process.argv[2]] as (keyof typeof suites)[] : Object.keys(suites) as (keyof typeof suites)[];
for (const name of selected) if (!(name in suites)) { console.error(`Unknown perf suite: ${name}; available: ${Object.keys(suites).join(", ")}`); process.exit(2); }

interface Row extends PerfResult { suite: string; error?: string }
const rows: Row[] = [];
for (const name of selected) {
  const directory = await mkdtemp(join(tmpdir(), `ludens-perf-${name}-`));
  const started = performance.now();
  try {
    const result = await suites[name](directory);
    rows.push({ suite: name, ...result });
    console.error(`${name}: ${result.failures.length ? "FAIL" : "ok"} (${Math.round(performance.now() - started)} ms)`);
    if (result.output) console.error(result.output.trim());
  } catch (error) {
    rows.push({ suite: name, checks: {}, failures: [String(error)], error: String(error) });
    console.error(`${name}: ERROR (${Math.round(performance.now() - started)} ms)\n${error}`);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

console.log(`\nPerf summary`);
for (const row of rows) {
  console.log(`  ${row.suite.padEnd(22)} ${row.failures.length ? "FAIL" : "PASS"}${row.budgets ? "  " + Object.entries(row.budgets).map(([key, value]) => `${key}=${typeof value === "number" ? value.toFixed(1) : String(value)}`).join(" ") : ""}`);
  for (const [check, passed] of Object.entries(row.checks)) console.log(`    ${passed ? "ok " : "FAIL"} ${check}`);
  if (row.error) console.log(`    error: ${row.error}`);
}
console.log(JSON.stringify({ suites: rows.map(row => ({ suite: row.suite, passed: row.failures.length === 0, failures: row.failures, budgets: row.budgets ?? {} })) }));
if (rows.some(row => row.failures.length)) process.exit(1);
