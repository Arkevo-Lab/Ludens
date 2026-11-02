import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pythonExecutable } from "@ludens/protocol/python";
import { ensureWorkspaceIdentity, registerWorkspace } from "@ludens/protocol/ludens";
import { PythonCapabilities } from "../src/core/subsystems/python-capabilities.ts";
import { historyCapabilityEvals, listCapabilityEvals, readLatestEvals, runCapabilityEvals } from "../src/core/subsystems/capability-evals.ts";
import { WorkspaceController } from "../src/core/subsystems/controller.ts";
import type { DeviceSession } from "../src/core/shiori/runtime.ts";
import { evalCommand } from "../src/cli/eval-cli.ts";
import { capabilities } from "../src/core/query/capabilities.ts";

async function workspace() { return realpath(await mkdtemp(join(tmpdir(), "ludens-eval-"))); }

const CAPABILITY_SOURCE = `from ludens_tools import capability, eval_capability, Client

@capability
def score(value: float) -> float:
    """Score a value into the unit interval."""
    return min(1, max(0, value))

@eval_capability(score)
def eval_score() -> dict[str, float]:
    """Evaluate score against committed timeline records, offline."""
    import os
    observed = Client().observe({"capability": "*", "limit": 8, "after": 0})
    records = observed["records"]
    assert "BASEWARE_EPOCH" not in os.environ and "LUDENS_EPOCH" not in os.environ
    assert observed["queryId"].startswith("offline-")
    ticks = [record["data"]["tick"] for record in records]
    return {"samples": float(len(ticks)), "coverage": 1.0 if ticks else 0.0, "sum": float(sum(ticks))}
`;

/** Commit persistent timeline records with a short-lived writer, then release it. */
async function commitTimeline(directory: string, ticks: number[]) {
  const script = `
import sys
from ludens_tools._observation_history import ObservationHistory
history = ObservationHistory(sys.argv[1])
for index in range(int(sys.argv[2])):
    history.append({"data": {"tick": index + 1}, "text": "tick"},
        "generation-one", {"clock": "test", "startedAtMs": index, "finishedAtMs": index + 1},
        "2026-11-02T0%d:00:00Z" % index, identity={"id": "python/actions.py:score"}, run_id="run-one")
history.close()`;
  const child = Bun.spawn([pythonExecutable(), "-B", "-c", script, directory, String(ticks.length)], {
    cwd: directory, env: { ...process.env, PYTHONPATH: join(import.meta.dir, "../python"), LUDENS_SOCKET: "" },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exitCode !== 0) throw new Error(`timeline commit failed: ${stderr || stdout}`);
}

test("static discovery reports eval bindings and violations without importing workspace code", async () => {
  const directory = await workspace();
  try {
    await writeFile(join(directory, "actions.py"), `from ludens_tools import capability, eval_capability
from ludens_tools import eval as ev
from pathlib import Path
Path("imported").touch()
@capability
def score(value: float) -> float:
    """Score a value."""
    return value
@capability
def other(value: int) -> int:
    """Another capability."""
    return value
@eval_capability(score)
def eval_score() -> dict[str, float]:
    """Evaluate score."""
    return {"samples": 1}
@ev("python/actions.py:other")
def eval_other():
    """Evaluate other by ID string."""
    return {"ok": 1}
@eval_capability("python/gone.py:missing")
def eval_missing():
    """Unknown target."""
    return {}
@eval_capability(score)
def eval_duplicate():
    """Duplicate binding."""
    return {}
@eval_capability(score)
def required(scale: float):
    """Required parameter."""
    return {}
@eval_capability(score)
async def slow():
    """Async eval."""
    return {}
@capability
@eval_capability(score)
def combined():
    """Combined decorators."""
    return {}
`);
    const found = await new PythonCapabilities(directory).discover();
    const byFunction = new Map(found.capabilities.map(item => [item.origin.function, item]));
    expect(found.capabilities).toHaveLength(2);
    expect(byFunction.get("score")!.eval).toMatchObject({ id: "python/actions.py:eval_score",
      origin: { path: "actions.py", function: "eval_score" }, description: "Evaluate score." });
    expect(byFunction.get("other")!.eval).toMatchObject({ id: "python/actions.py:eval_other" });
    expect(byFunction.get("score")!.eval!.codeSHA).toBe(byFunction.get("score")!.codeSHA);
    const messages = found.diagnostics.map(item => `${item.function}: ${item.message}`).sort();
    expect(messages.some(item => item.startsWith("eval_missing: Eval target python/gone.py:missing"))).toBe(true);
    expect(messages.some(item => item.startsWith("eval_duplicate: Capability python/actions.py:score already has eval"))).toBe(true);
    expect(messages.some(item => item.startsWith("required: Eval functions take no required parameters"))).toBe(true);
    expect(messages.some(item => item.startsWith("slow: Async eval functions"))).toBe(true);
    expect(messages.some(item => item.startsWith("combined: eval_capability cannot be combined"))).toBe(true);
    expect(await Bun.file(join(directory, "imported")).exists()).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("run executes bound evals offline against committed timeline records", async () => {
  const directory = await workspace();
  try {
    delete process.env.LUDENS_SOCKET;
    await writeFile(join(directory, "actions.py"), CAPABILITY_SOURCE);
    await commitTimeline(directory, [1, 2, 3]);
    const before = await listCapabilityEvals(directory);
    expect(before.capabilities[0]).toMatchObject({ id: "python/actions.py:score", evalStatus: "unverified", evalId: "python/actions.py:eval_score" });
    expect(before.summary).toEqual({ missing: 0, unverified: 1, stale: 0, failed: 0, verified: 0 });

    const run = await runCapabilityEvals(directory, { capabilityId: "python/actions.py:score" });
    expect(run.outcome).toBe("passed");
    expect(run.results[0]).toMatchObject({ outcome: "passed", evalStatus: "verified",
      rewards: { samples: 3, coverage: 1, sum: 6 } });
    const latest = await readLatestEvals(directory);
    expect(latest["python/actions.py:score"]).toMatchObject({ evalId: "python/actions.py:eval_score", outcome: "passed" });
    const runs = await historyCapabilityEvals(directory, { capabilityId: "python/actions.py:score" });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ rewards: { samples: 3, sum: 6 } });
    const listed = await listCapabilityEvals(directory);
    expect(listed.capabilities[0]).toMatchObject({ evalStatus: "verified", evalRewards: { samples: 3, coverage: 1, sum: 6 } });
    expect(listed.summary.verified).toBe(1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("eval status moves missing to unverified, verified, stale, and failed", async () => {
  const directory = await workspace();
  try {
    delete process.env.LUDENS_SOCKET;
    await writeFile(join(directory, "actions.py"), `from ludens_tools import capability

@capability
def plain(value: float) -> float:
    """A capability without an eval."""
    return value

@capability
def score(value: float) -> float:
    """Score a value."""
    return value

@capability
def broken(value: float) -> float:
    """A capability whose eval fails."""
    return value
`);
    let listed = await listCapabilityEvals(directory);
    expect(listed.capabilities.map(item => [item.id, item.evalStatus])).toEqual([
      ["python/actions.py:plain", "missing"], ["python/actions.py:score", "missing"], ["python/actions.py:broken", "missing"]]);

    const missingRun = await runCapabilityEvals(directory, { capabilityId: "python/actions.py:plain" });
    expect(missingRun.outcome).toBe("failed");
    expect(missingRun.results[0]).toMatchObject({ outcome: "failed", evalStatus: "missing",
      error: { type: "MissingEval", message: "Capability python/actions.py:plain has no @eval_capability bound" } });
    expect(await readLatestEvals(directory)).toEqual({});

    const bound = `from ludens_tools import capability, eval_capability

@capability
def score(value: float) -> float:
    """Score a value."""
    return value

@capability
def broken(value: float) -> float:
    """A capability whose eval fails."""
    return value

@eval_capability(score)
def eval_score():
    """Evaluate score."""
    return {"samples": 2}

@eval_capability(broken)
def eval_broken():
    """Raise during evaluation."""
    raise RuntimeError("timeline fixture unavailable")
`;
    await writeFile(join(directory, "actions.py"), bound);
    listed = await listCapabilityEvals(directory);
    expect(listed.capabilities.find(item => item.id === "python/actions.py:score")!.evalStatus).toBe("unverified");

    const scored = await runCapabilityEvals(directory, { capabilityId: "python/actions.py:score" });
    expect(scored.outcome).toBe("passed");
    listed = await listCapabilityEvals(directory);
    expect(listed.capabilities.find(item => item.id === "python/actions.py:score")!.evalStatus).toBe("verified");

    // Editing the capability source invalidates the recorded capabilityCodeSHA.
    await writeFile(join(directory, "actions.py"), bound + "\n# source changed after evaluation\n");
    listed = await listCapabilityEvals(directory);
    const stale = listed.capabilities.find(item => item.id === "python/actions.py:score")!;
    expect(stale.evalStatus).toBe("stale");
    expect(stale.evalRewards).toEqual({ samples: 2 });

    await writeFile(join(directory, "actions.py"), bound);
    const failed = await runCapabilityEvals(directory, { all: true });
    expect(failed.outcome).toBe("failed");
    expect(failed.results.find(item => item.capabilityId === "python/actions.py:broken")).toMatchObject({ outcome: "failed" });
    listed = await listCapabilityEvals(directory);
    const broken = listed.capabilities.find(item => item.id === "python/actions.py:broken")!;
    expect(broken.evalStatus).toBe("failed");
    expect(broken.evalError).toContain("RuntimeError: timeline fixture unavailable");
    expect(listed.capabilities.find(item => item.id === "python/actions.py:score")!.evalStatus).toBe("verified");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("ludens eval CLI runs shorthands, sets exit codes, and prints history", async () => {
  const directory = await workspace();
  const priorExit = process.exitCode;
  const command = async (args: string[]) => {
    const log = console.log, written: string[] = [];
    console.log = value => { written.push(String(value)); };
    try { await evalCommand(args, directory); }
    finally { console.log = log; }
    const code = process.exitCode;
    process.exitCode = priorExit;
    return { code, output: written.join("\n") };
  };
  try {
    delete process.env.LUDENS_SOCKET;
    await writeFile(join(directory, "actions.py"), CAPABILITY_SOURCE);
    await commitTimeline(directory, [1, 2]);

    const listed = await command(["list"]);
    expect(listed.code).toBeUndefined();
    expect(JSON.parse(listed.output).summary).toEqual({ missing: 0, unverified: 1, stale: 0, failed: 0, verified: 0 });

    const shorthand = await command(["python/actions.py:score"]);
    expect(shorthand.code).toBe(0);
    expect(JSON.parse(shorthand.output).outcome).toBe("passed");

    const history = await command(["history", "python/actions.py:score", "--limit", "5"]);
    expect(JSON.parse(history.output).runs).toHaveLength(1);

    await expect(command(["run", "python/actions.py:nope"])).rejects.toThrow("Unknown Python capability");

    const all = await command(["run", "--all"]);
    expect(all.code).toBe(0);
    const second = await command(["history"]);
    expect(JSON.parse(second.output).runs).toHaveLength(2);
  } finally { process.exitCode = priorExit; await rm(directory, { recursive: true, force: true }); }
});

test("controller list and capabilities query expose evaluation enrichment", async () => {
  const directory = await workspace(), home = await realpath(await mkdtemp(join(tmpdir(), "ludens-eval-home-")));
  try {
    delete process.env.LUDENS_SOCKET;
    await writeFile(join(directory, "actions.py"), CAPABILITY_SOURCE);
    await commitTimeline(directory, [1, 2, 3, 4]);
    const run = await runCapabilityEvals(directory, { capabilityId: "python/actions.py:score" });
    expect(run.outcome).toBe("passed");

    const devices = { catalog: { controllers: [] } } as unknown as DeviceSession;
    const controller = new WorkspaceController({ workspace: directory, devices, env: { ...process.env }, record: () => {} });
    const listed = await controller.list(new AbortController().signal);
    expect(listed.capabilities).toHaveLength(1);
    expect(listed.capabilities[0]).toMatchObject({ id: "python/actions.py:score", recorded: false,
      evalStatus: "verified", evalId: "python/actions.py:eval_score", evalRewards: { samples: 4, coverage: 1, sum: 10 } });
    const helped = JSON.parse(await controller.help("python/actions.py:score", new AbortController().signal));
    expect(helped).toMatchObject({ id: "python/actions.py:score", evalStatus: "verified" });

    await writeFile(join(directory, "baseware.json"), JSON.stringify({ schemaVersion: 2, generatedAt: "2026-11-02T00:00:00.000Z",
      drivers: [], controllers: [] }));
    const identity = await ensureWorkspaceIdentity(directory);
    await registerWorkspace(directory, home);
    const page = await capabilities(identity.id, directory, home);
    expect(page.issues).toEqual([]);
    expect(page.sources.workspace.status).toBe("available");
    expect(page.groups[1].items).toEqual([{ id: "python/actions.py:score", kind: "workspace",
      description: "Score a value into the unit interval.",
      requiresControl: null, readOnly: null, evalStatus: "verified", evalId: "python/actions.py:eval_score",
      evalRewards: { samples: 4, coverage: 1, sum: 10 }, evalEvaluatedAt: run.results[0]!.evaluatedAt, evalError: null }]);
  } finally { await rm(directory, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); }
});
