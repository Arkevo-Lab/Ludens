import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readEvents } from "../src/perf/evidence.ts";
import { verifyBackgroundCompaction } from "./fixtures/background-compaction.ts";

const measureModule = resolve(import.meta.dir, "fixtures/background-compaction.ts");
const runContextModule = resolve(import.meta.dir, "../src/perf/run-context.ts");

const measureSource = (directory: string, signal = false) => `
const { createPerfContext } = await import(${JSON.stringify(runContextModule)});
const { measureBackgroundCompaction } = await import(${JSON.stringify(measureModule)});
${signal ? `const control = new AbortController();` : ""}
const ctx = await createPerfContext(${JSON.stringify(directory)}${signal ? ", { signal: control.signal }" : ""});
${signal ? `const record = ctx.log.record; let fired = false;
Object.defineProperty(ctx.log, "record", { value: (type, data, trace, metadata) => {
  record(type, data, trace, metadata);
  if (type === "compaction_http_end" && !fired) { fired = true; queueMicrotask(() => control.abort(new Error("benchmark cancelled"))); }
} });` : ""}
let outcome = {}, caught = "";
try { outcome = await measureBackgroundCompaction(ctx); } catch (error) { caught = String(error); }
await Bun.write(${JSON.stringify(join(directory, "outcome.json"))}, JSON.stringify({ outcome, caught${signal ? ", fired" : ""}}));`;

async function withDirectory(qualifier: string, run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), `ludens-compaction-${qualifier}-`));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

async function spawnMeasure(directory: string, signal = false) {
  const child = Bun.spawn([process.execPath, "-e", measureSource(directory, signal)],
    { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => child.kill(), 25_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
    return JSON.parse(await readFile(join(directory, "outcome.json"), "utf8"));
  } finally { clearTimeout(timeout); if (child.exitCode === null) child.kill(); }
}

test("background compaction reuses summaries and cancels without committing on production events", async () => {
  await withDirectory("test", async directory => {
    const { outcome } = await spawnMeasure(directory);
    const result = verifyBackgroundCompaction(outcome);
    expect(result.failures).toEqual([]);
    expect(outcome.requests).toBe(1);
    expect(outcome.commits).toBe(1);
    expect(outcome.orphanParents).toEqual([]);
    const runDir = join(directory, "logs", (await readdir(join(directory, "logs")))[0]!);
    const events = await readEvents(runDir);
    for (const type of ["compaction_speculation", "compaction_http_start", "compaction_http_end", "auto_compaction_end"]) {
      expect(events.some(event => event.type === type)).toBe(true);
    }
  });
}, 30_000);

test("background compaction cancellation cleans up speculation before returning", async () => {
  await withDirectory("abort", async directory => {
    const { caught, fired } = await spawnMeasure(directory, true);
    expect({ fired, caught }).toEqual({ fired: true, caught: "Error: benchmark cancelled" });
  });
}, 30_000);
