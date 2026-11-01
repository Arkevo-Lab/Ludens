import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readEvents } from "../src/perf/evidence.ts";
import { verifyWsRecovery } from "./fixtures/ws-recovery.ts";

const measureModule = resolve(import.meta.dir, "fixtures/ws-recovery.ts");
const runContextModule = resolve(import.meta.dir, "../src/perf/run-context.ts");
const eventLogModule = resolve(import.meta.dir, "../src/core/storage/events.ts");
const workspaceOf = (directory: string) => join(directory, "workspace");

const measureSource = (directory: string, signal = false) => `
const { createPerfContext } = await import(${JSON.stringify(runContextModule)});
const { measureWsRecovery } = await import(${JSON.stringify(measureModule)});
${signal ? `const control = new AbortController();
const beforeFetch = globalThis.fetch, beforeSocket = globalThis.WebSocket;` : ""}
const ctx = await createPerfContext(${JSON.stringify(directory)}${signal ? ", { signal: control.signal }" : ""});
${signal ? `const record = ctx.log.record; let fired = false;
Object.defineProperty(ctx.log, "record", { value: (type, data, trace, metadata) => {
  record(type, data, trace, metadata);
  if (type === "benchmark_transport_step" && !fired) { fired = true; queueMicrotask(() => control.abort(new Error("benchmark cancelled"))); }
} });` : ""}
let outcome = {}, caught = "";
try { outcome = await measureWsRecovery(ctx); } catch (error) { caught = String(error); }
await Bun.write(${JSON.stringify(join(directory, "outcome.json"))}, JSON.stringify({ outcome, caught${signal ? ", fired, restored: globalThis.fetch === beforeFetch && globalThis.WebSocket === beforeSocket" : ""}}));`;

async function withDirectory(qualifier: string, run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), `ludens-ws-recovery-${qualifier}-`));
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

test("ws recovery keeps transport semantics on production events without network or devices", async () => {
  await withDirectory("test", async directory => {
    const { outcome } = await spawnMeasure(directory);
    const result = verifyWsRecovery(outcome);
    expect(result.failures).toEqual([]);
    expect(Object.keys(result.rewards).length).toBeGreaterThanOrEqual(6);
    expect(Object.values(result.rewards).every(value => typeof value === "number" && Number.isFinite(value))).toBe(true);
    for (const condition of outcome.conditions) {
      const [, fallback] = condition.steps;
      expect(fallback.retryWebsocketAt).toBe(fallback.virtualNow + 60_000);
      expect(condition.noReplayHttpBefore).toBe(condition.noReplayHttpAfter);
    }
    const runDir = join(directory, "logs", (await readdir(join(directory, "logs")))[0]!);
    const events = await readEvents(runDir);
    for (const type of ["model_start", "model_ws_dispatch", "model_http_start", "model_end"]) {
      expect(events.some(event => event.type === type)).toBe(true);
    }
  });
}, 30_000);

test("ws recovery cancellation cleans up transport globals before returning", async () => {
  await withDirectory("abort", async directory => {
    const { caught, fired, restored } = await spawnMeasure(directory, true);
    expect({ fired, caught, restored }).toEqual({ fired: true, caught: "Error: benchmark cancelled", restored: true });
  });
}, 30_000);
