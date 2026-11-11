import { expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acceptsScope } from "@ludens/protocol/activity";
import { EventLog } from "../src/core/storage/events.ts";
import { getLogIndex } from "../src/core/query/log-index";
import { queryActivity, refreshActivity } from "../src/core/query/activity.ts";
import { readRunProjection, refreshRunProjection, selectIndexedCycle } from "../src/core/query/run-index.ts";
import type { Manifest } from "../src/core/query/types.ts";

/** Two completed cycles (bounded and unbounded) plus per-epoch model calls. */
async function fixture() {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "ludens-run-epochs-")));
  const directory = join(workspace, "logs", "run");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "manifest.json"), JSON.stringify({ workspace }));
  const log = new EventLog(directory, { id: "epochs", now: () => performance.now() }, workspace);
  const cycles = [["one", 120, "human"], ["two", null, "time budget"]] as const;
  for (const [epoch, maxSeconds, reason] of cycles) {
    log.record("control", { mode: "auto", epoch, maxSeconds, remainingSeconds: maxSeconds }, { epoch });
    log.record("model_start", { request: "prompt" }, { epoch, modelCallId: `call-${epoch}` });
    log.record("model_end", { durationMs: 100, stopReason: "done", usage: { input: 10, output: 5 } }, { epoch, modelCallId: `call-${epoch}` });
    log.record("user_message", { text: `note ${epoch}` }, { epoch });
    log.record("control", { mode: "manual", reason }, { epoch });
  }
  await log.flush();
  const index = getLogIndex(directory);
  const release = index.retain();
  await index.refreshEvents();
  await refreshRunProjection(index);
  await refreshActivity(index);
  const manifest = { workspace } as Manifest;
  return { index, manifest, cycles, close: async () => { release(); await rm(workspace, { recursive: true, force: true }); } };
}

test("epoch=all spans every cycle with close metadata while the latest anchors state", async () => {
  const f = await fixture();
  try {
    const all = await selectIndexedCycle(f.index, f.manifest, "all");
    expect(all.wholeRun).toBe(true);
    expect(all.selectedEpoch).toBe("two");
    expect(all.cycles.map(cycle => cycle.epoch)).toEqual(["one", "two"]);
    expect(all.cycles[0]).toMatchObject({ startedAt: expect.any(String), endedAt: expect.any(String), reason: "human", maxSeconds: 120 });
    expect(all.cycles[1]).toMatchObject({ reason: "time budget", maxSeconds: null });
    // The whole-run projection carries calls from both epochs.
    const projection = await readRunProjection(f.index, all.selectedEpoch, {}, true);
    expect(projection.calls).toHaveLength(2);
    expect(projection.summary.completed).toBe(2);
    expect(projection.lastControl).toMatchObject({ mode: "manual", reason: "time budget" });
    // A single-epoch view stays scoped to that cycle only.
    const single = await selectIndexedCycle(f.index, f.manifest, "one");
    expect(single).toMatchObject({ selectedEpoch: "one", wholeRun: false });
    const oneProjection = await readRunProjection(f.index, "one");
    expect(oneProjection.calls).toHaveLength(1);
    await expect(selectIndexedCycle(f.index, f.manifest, "missing")).rejects.toThrow("所选周期不属于当前运行");
  } finally { await f.close(); }
});

test("activity blocks span every epoch for a null scope and accept the all selector", async () => {
  const f = await fixture();
  try {
    const whole = await queryActivity(f.index, { project: "p", runId: "run", epoch: null }, {});
    const scoped = await queryActivity(f.index, { project: "p", runId: "run", epoch: "one" }, {});
    expect(scoped.projection.blockCount).toBeGreaterThan(0);
    expect(whole.projection.blockCount).toBeGreaterThan(scoped.projection.blockCount);
    expect(whole.blocks.length).toBeGreaterThan(scoped.blocks.length);
    expect(acceptsScope({ project: "p", runId: "run", epoch: null }, "p", "run", "all")).toBe(true);
    expect(acceptsScope({ project: "p", runId: "run", epoch: null }, "p", "run", "one")).toBe(false);
    expect(acceptsScope({ project: "p", runId: "run", epoch: "one" }, "p", "run", "one")).toBe(true);
    expect(acceptsScope({ project: "p", runId: "run", epoch: "one" }, "p", "run", "all")).toBe(false);
  } finally { await f.close(); }
});
