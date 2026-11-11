import { expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime, type AgentRunner } from "../src/core/shiori/runtime.ts";
import { createTestDeviceSession } from "./runtime-fixture.ts";
import { dispatch } from "../src/daemon/transport.ts";
import { EventLog } from "../src/core/storage/events.ts";
import { getLogIndex } from "../src/core/query/log-index";
import { refreshRunProjection } from "../src/core/query/run-index.ts";

function budgetFixture() {
  const recorded: Array<{ type: string; data: unknown; trace?: unknown }> = [];
  const gate = Promise.withResolvers<void>();
  // The run ends on either the human gate or the control signal's abort, whichever first.
  const agent: AgentRunner = {
    async run({ signal }) {
      const aborted = Promise.withResolvers<void>();
      signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      await Promise.race([gate.promise, aborted.promise]);
    },
    async consolidate() {}, abort: async () => {}, close: async () => {},
  };
  const { devices, core } = createTestDeviceSession({ controllers: [] }, () => {});
  const runtime = new Runtime(devices, (type, data, trace) => recorded.push({ type, data, trace }), 300);
  runtime.attach({ agent });
  return { runtime, recorded, core, gate };
}

test("setBudget converts an unbounded run into a timed expiry", async () => {
  const { runtime, gate, core } = budgetFixture();
  try {
    await runtime.start(undefined, undefined, null);
    expect(runtime.status()).toMatchObject({ mode: "auto", maxSeconds: null, remainingSeconds: null });
    const updated = await runtime.setBudget(0.05);
    expect(updated).toMatchObject({ mode: "auto", maxSeconds: 1, remainingSeconds: 1 });
    await runtime.runSettled;
    expect(runtime.status()).toMatchObject({ mode: "manual", reason: "time budget" });
    expect(core.status()).toMatchObject({ mode: "manual" });
  } finally { gate.resolve(); await runtime.close(); }
});

test("setBudget clears a timed run back to unbounded before expiry", async () => {
  const { runtime, gate, recorded } = budgetFixture();
  try {
    await runtime.start(undefined, undefined, 0.2);
    const cleared = await runtime.setBudget(null);
    expect(cleared).toMatchObject({ mode: "auto", maxSeconds: null, remainingSeconds: null });
    gate.resolve();
    await runtime.runSettled;
    // The original 0.2s timer was disarmed; the human gate, not the budget, ends the cycle.
    expect(runtime.status()).toMatchObject({ mode: "manual", reason: "agent ended" });
    expect(recorded.filter(event => event.type === "control_budget")).toHaveLength(1);
  } finally { gate.resolve(); await runtime.close(); }
});

test("ludens auto timer dispatch updates the budget and rejects inactive loops", async () => {
  const { runtime, gate } = budgetFixture();
  try {
    await runtime.start(undefined, undefined, null);
    const runId = runtime.status().runId;
    await dispatch(runtime, { kind: "auto", argv: ["timer", "5"], runId });
    expect(runtime.status()).toMatchObject({ mode: "auto", remainingSeconds: 5 });
    await dispatch(runtime, { kind: "auto", argv: ["timer", "off"], runId });
    expect(runtime.status()).toMatchObject({ mode: "auto", remainingSeconds: null });
    await expect(dispatch(runtime, { kind: "auto", argv: ["timer", "0"], runId })).rejects.toThrow("must be positive");
    await expect(dispatch(runtime, { kind: "auto", argv: ["timer"], runId })).rejects.toThrow("Usage");
    await expect(dispatch(runtime, { kind: "auto", argv: ["timer", "5"], runId, expectedEpoch: null })).rejects.toThrow("STALE_EPOCH");
  } finally { gate.resolve(); await runtime.close(); }
});

test("control_budget preserves the cycle start and updates maxSeconds in the run index", async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "ludens-runtime-budget-")));
  try {
    const directory = join(workspace, "logs", "run");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "manifest.json"), JSON.stringify({ workspace }));
    const log = new EventLog(directory, { id: "budget", now: () => performance.now() }, workspace);
    log.record("control", { mode: "auto", epoch: "one", maxSeconds: null, remainingSeconds: null }, { epoch: "one" });
    log.record("control_budget", { maxSeconds: 61, remainingSeconds: 61, requestedSeconds: 60 }, { epoch: "one" });
    log.record("control", { mode: "manual", reason: "human" }, { epoch: "one" });
    await log.flush();
    const index = getLogIndex(directory);
    const release = index.retain();
    try {
      await index.refreshEvents();
      await refreshRunProjection(index);
      const cycle = await index.store("run-cycles").get<{ startedAt: string; maxSeconds: number | null; endedAt: string; reason: string }>("one");
      expect(cycle).toMatchObject({ maxSeconds: 61, endedAt: expect.any(String), reason: "human" });
      // The live update never reopened the cycle: its start record is untouched.
      const rows = await index.queryEvents({ limit: 10 });
      const start = rows.find(row => row.event.type === "control");
      expect(cycle!.startedAt).toBe(start!.event.at);
    } finally { release(); }
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
