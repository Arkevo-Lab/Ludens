import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pythonExecutable } from "@ludens/protocol/python";
import { PythonWorker } from "../src/core/subsystems/python-worker.ts";

async function fixture(source: string, options: { stopGraceMs?: number } = {}) {
  const workspace = await mkdtemp(join(tmpdir(), "ludens-python-worker-"));
  await writeFile(join(workspace, "test_worker.py"), source);
  const events: string[] = [];
  const worker = new PythonWorker("worker-test", {
    executable: pythonExecutable(), module: "test_worker", workspace, env: process.env,
    stderrPath: join(workspace, "stderr.log"),
    onEvent: message => { events.push(message.event); },
    onExit: () => {}, ...options,
  });
  return { worker, events, cleanup: () => rm(workspace, { recursive: true, force: true }) };
}

test("closing the worker waits for its final event and shares concurrent shutdowns", async () => {
  const { worker, events, cleanup } = await fixture(`
import json, sys
for line in sys.stdin:
    message = json.loads(line)
    print(json.dumps({"id": message["id"], "ok": True}))
print(json.dumps({"event": "flushed"}))
`);
  try {
    expect((await worker.request({ action: "ping" }, 2_000)).ok).toBe(true);
    const stop = worker.stop();
    expect(worker.stop()).toBe(stop);
    await stop;
    expect(worker.process.exitCode).toBe(0);
    expect(events).toEqual(["flushed"]);
  } finally { await worker.stop(); await cleanup(); }
});

test("an unresponsive Python worker is terminated within the shutdown deadline", async () => {
  const { worker, cleanup } = await fixture(`
import json, sys, time
message = json.loads(sys.stdin.readline())
print(json.dumps({"id": message["id"], "ok": True}))
time.sleep(60)
`, { stopGraceMs: 400 });
  try {
    expect((await worker.request({ action: "ping" }, 2_000)).ok).toBe(true);
    await worker.stop();
    expect(worker.process.exitCode !== null || worker.process.signalCode !== null).toBe(true);
  } finally { await worker.stop(); await cleanup(); }
}, 15_000);
