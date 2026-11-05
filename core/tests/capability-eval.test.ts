import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
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

test("eval ignores an inherited live Host socket and reads committed history", async () => {
  const directory = await workspace();
  const socket = join(directory, "host.sock");
  let requests = 0;
  const server = createServer(connection => {
    connection.on("data", () => {
      requests++;
      connection.end(JSON.stringify({ ok: true, value: { queryId: "live", records: [] } }) + "\n");
    });
  });
  try {
    const listening = Promise.withResolvers<void>();
    server.once("error", listening.reject);
    server.listen(socket, listening.resolve);
    await listening.promise;
    await writeFile(join(directory, "actions.py"), CAPABILITY_SOURCE);
    await commitTimeline(directory, [1, 2]);
    const python = new PythonCapabilities(directory);
    const { capabilities } = await python.discover();
    const result = await python.evaluate(capabilities[0]!.id, { env: { LUDENS_SOCKET: socket } });
    expect(result.isError).toBe(false);
    expect(result.details.rewards).toEqual({ samples: 2, coverage: 1, sum: 3 });
    expect(requests).toBe(0);
  } finally {
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
    await rm(directory, { recursive: true, force: true });
  }
});

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
    expect(before.summary).toEqual({ missing: 0, unverified: 1, stale: 0, adapting: 0, failed: 0, verified: 0 });

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
    expect(JSON.parse(listed.output).summary).toEqual({ missing: 0, unverified: 1, stale: 0, adapting: 0, failed: 0, verified: 0 });

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

test("eval envelope passed=false fails while preserving rewards and details", async () => {
  const directory = await workspace();
  try {
    delete process.env.LUDENS_SOCKET;
    await writeFile(join(directory, "actions.py"), `from ludens_tools import capability, eval_capability

@capability
def score(value: float) -> float:
    """Score a value."""
    return value

@eval_capability(score)
def eval_score() -> dict:
    """Report passed=false with partial rewards."""
    return {"passed": False, "rewards": {"accuracy": 0.5}, "details": {"failed": ["rec-1"]}}
`);
    const run = await runCapabilityEvals(directory, { capabilityId: "python/actions.py:score" });
    expect(run.outcome).toBe("failed");
    expect(run.results[0]).toMatchObject({ outcome: "failed", evalStatus: "failed",
      rewards: { accuracy: 0.5 }, details: { failed: ["rec-1"] },
      error: { type: "EvalFailed", message: "Eval reported passed=false" } });
    const listed = await listCapabilityEvals(directory);
    const item = listed.capabilities.find(entry => entry.id === "python/actions.py:score")!;
    expect(item.evalStatus).toBe("failed");
    expect(item.evalError).toBe("EvalFailed: Eval reported passed=false");
    expect(item.evalRewards).toEqual({ accuracy: 0.5 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("ludens eval adapt gates on the whole eval module including capability code and CASES", async () => {
  const directory = await workspace();
  const base = `from ludens_tools import capability, eval_capability

CASES = [1, 2]

@capability
def score(value: float) -> float:
    """Score a value."""
    return value

@eval_capability(score)
def eval_score() -> dict[str, float]:
    """Evaluate score."""
    return {"samples": len(CASES)}
`;
  const revised = base.replace("return value", "return value + 1").replace("CASES = [1, 2]", "CASES = [1, 2, 3]");
  try {
    delete process.env.LUDENS_SOCKET;
    await writeFile(join(directory, "actions.py"), base);
    const verified = await runCapabilityEvals(directory, { capabilityId: "python/actions.py:score" });
    expect(verified.results[0]!.evalStatus).toBe("verified");

    const adaptLog = console.log, adaptOut: string[] = [];
    console.log = value => { adaptOut.push(String(value)); };
    try {
      await evalCommand(["adapt", "python/actions.py:score", "--reason", "False positive on plaza",
        "--record", "rec-1", "--record", "rec-2"], directory);
    } finally { console.log = adaptLog; }
    const adapted = JSON.parse(adaptOut.join("\n"));
    expect(adapted.evalStatus).toBe("adapting");

    let listed = await listCapabilityEvals(directory);
    const item = () => listed.capabilities.find(entry => entry.id === "python/actions.py:score")!;
    expect(item().evalStatus).toBe("adapting");
    expect(listed.summary.adapting).toBe(1);
    expect(item().evalRewards).toEqual({ samples: 2 });
    expect(item().evalError).toBe("EvalAdapting: False positive on plaza (records: rec-1, rec-2)");

    // Re-running the unchanged eval cannot clear adapting.
    const unchanged = await runCapabilityEvals(directory, { capabilityId: "python/actions.py:score" });
    expect(unchanged.outcome).toBe("failed");
    expect(unchanged.results[0]).toMatchObject({ outcome: "failed", evalStatus: "adapting" });
    listed = await listCapabilityEvals(directory);
    expect(item().evalStatus).toBe("adapting");

    // codeSHA hashes the whole module, so any source edit ends the adaptation
    // window; the status only returns to verified once the eval passes again.
    await writeFile(join(directory, "actions.py"), base.replace("return value", "return value + 1"));
    listed = await listCapabilityEvals(directory);
    expect(item().evalStatus).toBe("stale");
    const edited = await runCapabilityEvals(directory, { capabilityId: "python/actions.py:score" });
    expect(edited.results[0]!.evalStatus).toBe("verified");

    // Module-level test-set edits also release a fresh adaptation gate.
    const savedLog = console.log;
    console.log = () => {};
    try {
      await evalCommand(["adapt", "python/actions.py:score", "--reason", "Expand CASES"], directory);
    } finally { console.log = savedLog; }
    listed = await listCapabilityEvals(directory);
    expect(item().evalStatus).toBe("adapting");
    await writeFile(join(directory, "actions.py"), revised);
    const rerun = await runCapabilityEvals(directory, { capabilityId: "python/actions.py:score" });
    expect(rerun.outcome).toBe("passed");
    expect(rerun.results[0]).toMatchObject({ outcome: "passed", evalStatus: "verified", rewards: { samples: 3 } });
    listed = await listCapabilityEvals(directory);
    expect(item().evalStatus).toBe("verified");
    expect(listed.summary.adapting).toBe(0);
  } finally { await rm(directory, { recursive: true, force: true }); }
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
    expect(page.evalSummary?.verified).toBe(1);
    expect(page.envs).toEqual([]);
    expect(page.groups[1].items).toHaveLength(1);
    expect(page.groups[1].items[0]).toMatchObject({ id: "python/actions.py:score", kind: "workspace",
      description: "Score a value into the unit interval.",
      requiresControl: null, readOnly: null, observe: false,
      origin: { path: "actions.py", line: 4, function: "score" },
      eval: { id: "python/actions.py:eval_score", origin: { path: "actions.py", line: 9, function: "eval_score" }, env: null },
      staleReasons: [],
      evalStatus: "verified", evalId: "python/actions.py:eval_score", evalEnvId: null, evalEnv: null,
      evalRewards: { samples: 4, coverage: 1, sum: 10 }, evalEvaluatedAt: run.results[0]!.evaluatedAt, evalError: null,
      latestRecord: { runId: run.results[0]!.runId, outcome: "passed", rewards: { samples: 4, coverage: 1, sum: 10 } },
      history: [{ runId: run.results[0]!.runId, outcome: "passed" }] });
  } finally { await rm(directory, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); }
});

const CLOSED_LOOP_SOURCE = `from ludens_tools import capability, record, eval_capability, eval_env, Client, replay

class FakeEnv:
    def __init__(self):
        self.recorded = []
        self.calls = []
    def observe(self, query):
        # Surrogate composites over committed timeline frames read from disk;
        # Client().replay inside this callback must not recurse into env.observe.
        return Client().replay(start="2026-11-02T00:00:00Z", end="2026-11-03T00:00:00Z", capability="*")
    def call(self, capability_id, arguments):
        self.calls.append((capability_id, dict(arguments)))
        return {"ok": True, "id": capability_id, "echo": dict(arguments)}
    def list(self):
        return ["controller/pad.play"]
    def help(self, capability_id):
        return {"id": capability_id, "arguments": {}}

@record
@capability
def reel_on_bite(slot: int) -> dict:
    """Closed-loop: observe committed history, then act through the env."""
    observed = Client().observe({"capability": "*", "limit": 8, "after": 0})
    listing = Client().list()
    helped = Client().help("controller/pad.play")
    played = Client().call("controller/pad.play", {"slot": slot, "speed": 2})
    data = {"ticks": len(observed["records"]), "listed": len(listing), "helped": helped["id"], "played": played["echo"]["slot"]}
    return {"text": "reeled", "data": data}

@eval_capability(reel_on_bite)
def eval_reel() -> dict[str, float]:
    """Evaluate the closed-loop capability against a surrogate environment."""
    env = FakeEnv()
    with eval_env(env):
        outcome = reel_on_bite(slot=3)
        Client().call("controller/pad.release")
        try:
            Client().call("controller/pad.play", [])
        except TypeError:
            pass
        else:
            raise AssertionError("non-dict driver arguments accepted")
    assert outcome["timeline"]["recordId"].startswith("eval-record-")
    assert outcome["timeline"]["sequence"] == 1
    assert env.recorded and env.recorded[0]["timeline"] == outcome["timeline"]
    assert env.calls == [("controller/pad.play", {"slot": 3, "speed": 2}), ("controller/pad.release", {})]
    data = outcome["data"]
    replayed = replay(capability="*")
    assert len(replayed) == 2
    assert data["ticks"] == 2 and data["played"] == 3
    return {"ticks": float(len(replayed)), "acted": float(data["played"]), "listed": float(data["listed"])}
`;

test("closed-loop @record @capability evaluates offline through eval_env without a host socket", async () => {
  const directory = await workspace();
  try {
    await writeFile(join(directory, "actions.py"), CLOSED_LOOP_SOURCE);
    await commitTimeline(directory, [1, 2]);
    const python = new PythonCapabilities(directory);
    const { capabilities } = await python.discover();
    const result = await python.evaluate(capabilities[0]!.id);
    expect(result.isError).toBe(false);
    expect(result.details.rewards).toEqual({ ticks: 2, acted: 3, listed: 1 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("@record @capability succeeds during eval run without eval_env and attaches a synthetic timeline envelope", async () => {
  const directory = await workspace();
  try {
    await writeFile(join(directory, "actions.py"), `from ludens_tools import capability, record, eval_capability

@record
@capability
def move_cursor_to_slot(slot: int) -> dict:
    """Move the cursor; recorded offline by the eval bridge."""
    return {"text": "moved", "data": {"slot": slot, "target": slot * 2}}

@eval_capability(move_cursor_to_slot)
def eval_move() -> dict[str, float]:
    """Evaluate without any eval_env wrapper."""
    outcome = move_cursor_to_slot(slot=5)
    assert "timeline" in outcome, outcome
    assert outcome["timeline"]["recordId"].startswith("eval-record-")
    assert outcome["timeline"]["sequence"] == 1
    assert outcome["data"]["slot"] == 5
    return {"moved": float(outcome["data"]["slot"]), "sequence": float(outcome["timeline"]["sequence"])}
`);
    await commitTimeline(directory, []);
    const python = new PythonCapabilities(directory);
    const { capabilities } = await python.discover();
    const result = await python.evaluate(capabilities[0]!.id);
    expect(result.isError).toBe(false);
    expect(result.details.rewards).toEqual({ moved: 5, sequence: 1 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

const ENV_ACTIONS_SOURCE = `from ludens_tools import Client, capability, eval_capability

@capability
def poke(slot: int) -> dict:
    """Poke the controller through whatever env is mounted."""
    played = Client().call("controller/pad.play", {"slot": slot})
    return {"data": played}

@eval_capability(poke, env="python/envs.py:SharedEnv")
def eval_poke() -> dict[str, float]:
    """Evaluate poke against the shared cross-file env."""
    from envs import SharedEnv
    with SharedEnv(seed=3) as env:
        outcome = poke(slot=2)
    assert outcome["data"]["echo"]["slot"] == 2, outcome
    return {"acted": float(env.ticks)}
`;

const ENV_SHARED_SOURCE = `from ludens_tools import Client, eval_env

@eval_env
class SharedEnv:
    """Surrogate env shared across capability evals."""
    def __init__(self, seed: int = 0):
        self.seed = seed
        self.recorded = []
        self.ticks = 0
    def observe(self, query):
        self.ticks += 1
        return []
    def call(self, id, args):
        self.ticks += 1
        return {"ok": True, "echo": dict(args)}
`;

test("@eval_env static discovery catalogs envs and binds the capability-eval-env triad", async () => {
  const directory = await workspace();
  try {
    await writeFile(join(directory, "envs.py"), `from ludens_tools import eval_env

@eval_env
class SharedEnv:
    """Surrogate env shared across capability evals."""

@eval_env
def make_env(seed: int = 0):
    """Factory env for parameterized surrogates."""
    return None

@eval_env
async def async_env():
    """Async env."""

@eval_env
class NoDoc:
    pass

@eval_env(SharedEnv)
class WithArgs:
    """Env with decorator args."""

class Outer:
    @eval_env
    class Nested:
        """Nested env."""

`);
    await writeFile(join(directory, "actions.py"), `from ludens_tools import capability, eval_capability, eval_env
from envs import SharedEnv

@capability
def score(value: float) -> float:
    """Score."""
    return value

@capability
def plain(value: float) -> float:
    """No env binding."""
    return value

@capability
def cross(value: float) -> float:
    """Bound to a cross-file env by ID string."""
    return value

@eval_env
class LocalEnv:
    """Same-file env."""

@eval_capability(score, env=LocalEnv)
def eval_score():
    """Bind by local symbol."""
    return {}

@eval_capability(plain, "python/envs.py:SharedEnv")
def eval_plain():
    """Bind by second positional ID string."""
    return {}

@eval_capability(cross, env="python/envs.py:SharedEnv")
def eval_cross():
    """Bind by keyword ID string."""
    return {}
`);
    const found = await new PythonCapabilities(directory).discover();
    expect(found.envs!.map(item => item.id)).toEqual([
      "python/actions.py:LocalEnv", "python/envs.py:SharedEnv", "python/envs.py:make_env"]);
    expect(found.envs!.find(item => item.id === "python/envs.py:SharedEnv")).toMatchObject({
      name: "SharedEnv", description: "Surrogate env shared across capability evals.",
      origin: { path: "envs.py", function: "SharedEnv" } });
    const byFunction = new Map(found.capabilities.map(item => [item.origin.function, item]));
    expect(byFunction.get("score")!.eval!.env).toMatchObject({ id: "python/actions.py:LocalEnv" });
    expect(byFunction.get("plain")!.eval!.env).toMatchObject({ id: "python/envs.py:SharedEnv" });
    expect(byFunction.get("cross")!.eval!.env).toMatchObject({ id: "python/envs.py:SharedEnv",
      origin: { path: "envs.py", function: "SharedEnv" } });
    const messages = found.diagnostics.map(item => `${item.function}: ${item.message}`).sort();
    expect(messages.some(item => item.startsWith("async_env: @eval_env is only supported on top-level classes or synchronous functions"))).toBe(true);
    expect(messages.some(item => item.startsWith("NoDoc: @eval_env requires a docstring"))).toBe(true);
    expect(messages.some(item => item.startsWith("WithArgs: @eval_env does not take arguments"))).toBe(true);
    expect(messages.some(item => item.startsWith("Nested: @eval_env is only supported on top-level classes or synchronous functions"))).toBe(true);
    const listed = await listCapabilityEvals(directory);
    expect(listed.envs.map(item => item.id)).toEqual(found.envs!.map(item => item.id));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("@eval_capability env diagnostics reject missing or non-@eval_env targets", async () => {
  const directory = await workspace();
  try {
    await writeFile(join(directory, "actions.py"), `from ludens_tools import capability, eval_capability

class Undecorated:
    """An ordinary class, not an @eval_env."""

@capability
def score(value: float) -> float:
    """Score."""
    return value

@capability
def gone(value: float) -> float:
    """Bound to a missing env."""
    return value

@capability
def plain(value: float) -> float:
    """Bound without env."""
    return value

@eval_capability(score, env=Undecorated)
def eval_score():
    """Env target is not @eval_env."""
    return {}

@eval_capability(gone, env="python/envs.py:Missing")
def eval_gone():
    """Env target does not exist."""
    return {}

@eval_capability(plain, env=42)
def eval_plain():
    """Env argument is malformed."""
    return {}
`);
    const found = await new PythonCapabilities(directory).discover();
    const messages = found.diagnostics.map(item => `${item.function}: ${item.message}`);
    expect(messages.some(item => item.startsWith("eval_score: @eval_capability env python/actions.py:Undecorated does not match a discovered @eval_env"))).toBe(true);
    expect(messages.some(item => item.startsWith("eval_gone: @eval_capability env python/envs.py:Missing does not match a discovered @eval_env"))).toBe(true);
    expect(messages.some(item => item.startsWith("eval_plain: @eval_capability requires a capability function"))).toBe(true);
    expect(found.capabilities.every(item => item.eval?.env == null || item.eval === null)).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("with MyEnv(...) as env runs through a first-class @eval_env class", async () => {
  const directory = await workspace();
  try {
    await writeFile(join(directory, "envs.py"), `from ludens_tools import Client, capability, eval_capability, eval_env

@eval_env
class PokeEnv:
    """Surrogate env mounted directly as a context manager."""
    def __init__(self, seed: int = 0):
        self.seed = seed
        self.recorded = []
        self.ticks = 0
    def observe(self, query):
        self.ticks += 1
        return []
    def call(self, id, args):
        self.ticks += 1
        return {"ok": True, "echo": dict(args)}

@capability
def poke(slot: int) -> dict:
    """Poke through the mounted env."""
    played = Client().call("controller/pad.play", {"slot": slot})
    return {"data": played}

@eval_capability(poke, env=PokeEnv)
def eval_poke() -> dict[str, float]:
    """Evaluate poke with with-syntax and legacy eval_env mounting."""
    with PokeEnv(seed=1) as env:
        outcome = poke(slot=4)
        assert env is not None and outcome["data"]["echo"]["slot"] == 4, outcome
        ticks = env.ticks
    legacy = PokeEnv(seed=2)
    with eval_env(legacy):
        poke(slot=5)
    return {"acted": float(ticks), "legacy": float(legacy.ticks)}
`);
    const python = new PythonCapabilities(directory);
    const { capabilities } = await python.discover();
    const result = await python.evaluate(capabilities[0]!.id);
    expect(result.isError).toBe(false);
    expect(result.details.rewards).toEqual({ acted: 1, legacy: 1 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("cross-file @eval_env edits mark the bound capability stale in eval list and capabilities query", async () => {
  const directory = await workspace(), home = await realpath(await mkdtemp(join(tmpdir(), "ludens-eval-env-home-")));
  try {
    delete process.env.LUDENS_SOCKET;
    await writeFile(join(directory, "envs.py"), ENV_SHARED_SOURCE);
    await writeFile(join(directory, "actions.py"), ENV_ACTIONS_SOURCE);
    const run = await runCapabilityEvals(directory, { capabilityId: "python/actions.py:poke" });
    expect(run.results[0]).toMatchObject({ outcome: "passed", evalStatus: "verified",
      envId: "python/envs.py:SharedEnv" });
    expect(run.results[0]!.envCodeSHA).toBeTruthy();

    // Editing only the env module invalidates the recorded envCodeSHA.
    await writeFile(join(directory, "envs.py"), ENV_SHARED_SOURCE + "\n# env revision after verification\n");
    let listed = await listCapabilityEvals(directory);
    const item = listed.capabilities.find(entry => entry.id === "python/actions.py:poke")!;
    expect(item.evalStatus).toBe("stale");
    expect(item.evalEnvId).toBe("python/envs.py:SharedEnv");
    expect(listed.summary.stale).toBe(1);

    await writeFile(join(directory, "baseware.json"), JSON.stringify({ schemaVersion: 2, generatedAt: "2026-11-02T00:00:00.000Z",
      drivers: [], controllers: [] }));
    const identity = await ensureWorkspaceIdentity(directory);
    await registerWorkspace(directory, home);
    const page = await capabilities(identity.id, directory, home);
    expect(page.issues).toEqual([]);
    expect(page.groups[1].items.find(entry => entry.id === "python/actions.py:poke")!.evalStatus).toBe("stale");
  } finally { await rm(directory, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); }
});

test("editing a cross-file @eval_env releases the adapting gate", async () => {
  const directory = await workspace();
  try {
    delete process.env.LUDENS_SOCKET;
    await writeFile(join(directory, "envs.py"), ENV_SHARED_SOURCE);
    await writeFile(join(directory, "actions.py"), ENV_ACTIONS_SOURCE);
    const verified = await runCapabilityEvals(directory, { capabilityId: "python/actions.py:poke" });
    expect(verified.results[0]!.evalStatus).toBe("verified");

    const adaptLog = console.log;
    console.log = () => {};
    try {
      await evalCommand(["adapt", "python/actions.py:poke", "--reason", "Env misses late bites"], directory);
    } finally { console.log = adaptLog; }
    let listed = await listCapabilityEvals(directory);
    const item = () => listed.capabilities.find(entry => entry.id === "python/actions.py:poke")!;
    expect(item().evalStatus).toBe("adapting");

    // Re-running the unchanged eval and env stays adapting.
    const unchanged = await runCapabilityEvals(directory, { capabilityId: "python/actions.py:poke" });
    expect(unchanged.results[0]).toMatchObject({ outcome: "failed", evalStatus: "adapting" });
    listed = await listCapabilityEvals(directory);
    expect(item().evalStatus).toBe("adapting");

    // Revising only the bound @eval_env module changes envCodeSHA and releases the gate.
    await writeFile(join(directory, "envs.py"), ENV_SHARED_SOURCE.replace("self.ticks += 1\n        return []", "self.ticks += 2\n        return []"));
    listed = await listCapabilityEvals(directory);
    expect(item().evalStatus).toBe("stale");
    const rerun = await runCapabilityEvals(directory, { capabilityId: "python/actions.py:poke" });
    expect(rerun.outcome).toBe("passed");
    expect(rerun.results[0]).toMatchObject({ outcome: "passed", evalStatus: "verified" });
    listed = await listCapabilityEvals(directory);
    expect(item().evalStatus).toBe("verified");
    expect(listed.summary.adapting).toBe(0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
