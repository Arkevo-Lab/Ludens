import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "../src/bench/shiori-benchmark.ts";
import { history } from "../src/bench/store.ts";
import { createLocalTask } from "./fixtures/local-task.ts";
test("offline local task uses Shiori and one event writer; repeat isolates fixtures without online model", async () => {
  const root = await mkdtemp(join(tmpdir(), "shiori-native-"));
  const workspace = join(root, "workspace");
  const options = { workspace, globalHome: join(root, "index"), seconds: 20 };
  await createLocalTask(workspace);
  try {
    const first = await runTask("ludens/smoke", options), second = await runTask("ludens/smoke", options);
    expect(first.trial.status).toBe("completed"); expect(first.verification?.status).toBe("completed"); expect(second.verification?.status).toBe("completed");
    expect(first.verifier_result.rewards).toEqual({ graded: 1 });
    expect(first.trial.project).toBe(second.trial.project); expect(first.trial.id).not.toBe(second.trial.id);
    const path = join(workspace, "logs", first.trial.id), manifest = JSON.parse(await readFile(join(path, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ kind: "benchmark", benchmark: { name: "ludens/smoke" }, model: null });
    const events = (await readFile(join(path, "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(events.filter(event => event.type === "benchmark_start")).toHaveLength(1); expect(events.filter(event => event.type === "benchmark_end")).toHaveLength(1);
    expect(events.filter(event => event.type === "benchmark_verification")).toHaveLength(1);
    expect(events.map(event => event.seq)).toEqual(events.map((_, index) => index + 1));
    expect(new Set(events.map(event => event.origin.eventId)).size).toBe(events.length);
    expect((await history(workspace)).trials).toHaveLength(2);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 40_000);
