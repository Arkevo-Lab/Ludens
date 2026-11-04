# Workspace and Capability Programming

A Workspace is an ordinary coding workspace evolved jointly by the agent and developers: perception and control code can be written in it, skills and memory accumulated, datasets collected and models trained, without modifying the Harness or Driver sources in the repo.

All CLI commands below run in the **target workspace directory** (assuming the repo's `core/bin` and `baseware/bin` are on `PATH`). For environment setup and service lifecycle see [Installation and Workspace Lifecycle](quickstart.md); the resident `perception.py` and `action.py` implementations are covered in [Resident Perception and Action Loops](perception-and-action.md).

## Files and Sessions

### 1. Workspace Directory Layout

Global state and workspaces form two layers. `LUDENS_HOME` defaults to `~/.ludens` and does not move with a source checkout. It holds application configuration, rebuildable indexes, shared caches, and pet state:

```text
~/.ludens/                  # Override with LUDENS_HOME
├── config.json             # {version: 1, workspaceRoot: absolute, defaults: {...}}
├── registry/<id>.json      # {id, workspace, name, updatedAt}, a pointer to the workspace
├── cache/drivers/          # External driver installation cache
├── logs/baseware/          # Standalone Baseware logs without --data-dir
├── pet/
│   ├── target.json         # Stable workspace ID followed by the pet
│   ├── consumer.json       # Pet consumer heartbeat
│   ├── profile/            # Electron preferences and local cache
│   └── background/         # Shared pet background logs
└── workspaces/             # Initial workspaceRoot; configurable to any absolute path
```

Each workspace owns its runtime state. Preserve the whole directory when moving or backing it up:

```text
workspace/
├── ludens.json                 # Local service startup config (driver, ports, model, budget)
├── AGENTS.md                # Optional workspace-specific conventions (loaded via OMP native contextFiles)
├── baseware.json            # Device capability and parameter schema snapshot auto-exported after connecting a device
├── perception.py            # Resident workspace perception entry point (Perception class)
├── action.py                # Resident workspace action entry point (Action class)
├── skills/<name>/SKILL.md   # Reusable skill docs and helper scripts
├── memory/current.md        # Current goals, status, and next steps
├── .ludens/
│   ├── workspace.json       # {version: 1, id: "ws-UUID"}, persistent identity
│   ├── settings.json        # Optional workspace perception hot-window and video segment parameter overrides
│   ├── skill-versions/      # Historical skill and memory content snapshots
│   ├── timeline/            # Cross-run shared @record capability records, MP4 video segments, and deduped media originals
│   ├── archive/             # Content-addressed JSON archive of model and tool logs (media references timeline)
│   └── shiori/
│       ├── sessions/        # OMP session JSONL files and their same-named resource directories
│       └── current-session.json # Default session-resume pointer
└── logs/
    ├── <run-id>/            # Event, stream, and scoring records for a single Host run or Benchmark trial
    └── background/          # launchd background service logs and status
```

### 2. Templates and Session Lifecycle

- **Init templates**: `ludens init --name <name> --driver <id>` creates a workspace below the global default parent; pass `--workspace <path>` for an explicit directory. It creates missing [AGENTS.md](../../../core/templates/AGENTS.md), [perception.py](../../../core/templates/perception.py), and [action.py](../../../core/templates/action.py) templates. Global `defaults` are copied into the new `ludens.json`; later global changes do not affect it. `AGENTS.md` may be freely edited or deleted and is never force-restored on later starts; restart the Host after editing it for changes to take effect.
- **Workspace identity**: the ID in `.ludens/workspace.json` is persistent and is not derived from the directory name or path. After moving a workspace, run `ludens workspace open <new-path>` to update the global index. Use `open <copy-path> --new-id` for an independent copy, assigning a new identity and clearing the current session selection. Past sessions, skill versions, recordings, and logs remain in the workspace. Rebuild a lost registry with `open`; `forget <id>` removes only its index entry. Old directories need explicit [import](quickstart.md#registering-and-migrating-existing-workspaces).
- **Session resume**: restarting the Host resumes the previous OMP session via `.ludens/shiori/current-session.json` by default; `ludens run --new-session` starts a new session while keeping all workspace code and files, and `--resume <session.jsonl>` resumes a specified historical session under the same workspace.
- **Skills and memory**: `skills/<name>/SKILL.md` uses YAML frontmatter with `name` and `description`. The agent reads and writes skills and memory on demand through the OMP-native `read` / `write` / `edit` tools; Ludens does not re-push a full file index on every model request.

## Discovering and Calling Capabilities

### 1. Unified Capability Catalog (`ludens controller`)

Device-native controllers (from Baseware) and workspace-declared Python capabilities (via `@capability`) share one catalog entry point:

```sh
# List all current device capabilities and workspace Python capabilities
ludens controller list

# Show a single capability's input/output JSON Schema and control-ownership requirements
ludens controller controller/pad.play --help
ludens controller python/perception.py:Perception.sample --help

# Pass a full JSON argument object via --args or --file to invoke a call
ludens controller controller/screen.top.capture --args '{}'
ludens controller python/scripts/nav.py:move_to --file ./move-args.json
```

- `controller/<name>`: provided by the currently connected Baseware Driver. The Host writes the latest catalog snapshot to the workspace `baseware.json` at startup (run `baseware export` at any time to refresh it).
- `python/<relative-path.py>:<function or Class.method>`: provided by the `@capability` decorator in workspace Python code, discovered via static AST scanning — signatures and descriptions are queryable without starting any process.

### 2. Declaring Python Capabilities and the Four Call Styles

Declare and call capabilities in workspace Python code with `ludens_tools`:

```python
from ludens_tools import Client, capability

@capability
def capture_top(exposure: int = 1) -> dict:
    """Capture the top screen with documented typed parameters."""
    return Client().call("controller/screen.top.capture", {})
```

`@capability` works on both top-level sync functions and methods (e.g. `Perception.sample`, `Action.step`). Static discovery scans workspace code (skipping `logs/`, `.ludens/`, `.git/`, and virtual environments) and requires marked functions to have a **docstring** and **explicit parameter type annotations** (scalars, `list`, `dict[str, ...]`, and `Optional` are supported); top-level sync functions plus `Perception.sample` / `Action.step` are included in the `ludens controller list` catalog. Implementation details: [_capabilities.py](../../../core/python/ludens_tools/_capabilities.py).

`@observe` selects the workspace's main observation capability. It must be paired with `@capability` on the same function (and may also be paired with `@record`), and at most one `@observe` capability may be declared across the entire workspace. Discovery reports duplicate declarations as diagnostics instead of selecting an ambiguous main channel.

How the call entry points differ in execution location and data boundary:

| Call style | Executing process | Arguments and return values | When to use |
| --- | --- | --- | --- |
| Plain Python `import` call | Current Python process | Native Python objects (PyTorch models, NumPy arrays, etc.) | High-performance composition inside the workspace, sharing in-process models and caches |
| `Client().call("python/...", {...})` | Current Python process | Arguments validated against the capability schema, imported and called in the current process | Dispatching local Python capabilities dynamically by catalog ID without the Host spawning a new subprocess |
| `ludens controller python/... --args '{...}'` | One-shot Python subprocess started by the Host | Cross-process JSON serialization; the subprocess exits after the call and keeps no in-memory state | Agent triggering a single Python capability from the command line via the native `bash` tool |
| `Client().call("controller/...", {...})` or `ludens controller controller/...` | Forwarded to Baseware via Ludens | JSON argument object, returning an `ExecutionResult` with the native `result` and media bytes | Driving device inputs or collecting sensor/screen data |

### 3. Evaluating Capabilities with @eval_capability and ludens eval

Use the **Fast Loop (`@capability`) + Offline Evaluation (`@eval_capability`)** pattern for latency-sensitive or repetitive interactions. Turn-by-turn LLM observation has multi-second latency: it cannot react to sub-second game windows such as fishing bites, timed combos, or moving targets, and it wastes turns on repetitive dialogue loops. Encapsulate those interactions as local Python `@capability` functions that poll and act at high frequency in-process, then evaluate their detection and control logic offline.

When an atomic workspace capability can be evaluated offline, you can optionally pair it with a synchronous, zero-required-argument eval function in the same Python module. Evaluation strips inherited Host/device sockets and control epochs, so it cannot drive the live device. Choose the evaluation style that matches the capability:

1. **Replay labeled `.ludens/timeline/` records or 30 Hz trajectory slices** for perception, parsing, or sequence-detection functions. `Client().observe()` reads single pages from the persisted timeline, while `Client().replay(...)` (and `with record_window() as win:`) slices and automatically paginates multi-second 30 Hz trajectories by time window (`window=win` or `start=...`, `end=...`) or around an anchor record (`around=record_id, before_seconds=2.0, after_seconds=2.0`).
   Replay includes all capability streams unless `capability=...` is specified and returns at most `max_records=256`; increase this limit for longer trajectories.
2. **Mount a local surrogate environment and co-evolve Actor + Critic** for closed-loop action/reaction capabilities such as fishing reels, bug catching, or grid/menu navigation. Declare reusable environments with `@eval_env` on a docstringed top-level class (or synchronous factory function) and mount an instance with `with MyEnv(...) as env:` (ad-hoc stubs still work through `with eval_env(env):`). The environment (**Critic** / world model) intercepts `Client().observe(query)` through `env.observe(query)` and `Client().call("controller/...", args)` through `env.call(id, args)`, advances latent ground-truth state in virtual time, and scores the capability (**Actor** / policy) directly against that state across randomized trials.

In nontrivial game interactions, neither the Actor (`@capability`) nor the Critic (`eval_env`) can be built to perfection in a single shot before touching the real environment. Treat them as a **co-evolving pair** powered by 30 Hz `.ludens/timeline/` replays:

1. **Bootstrap a minimal `v0` Actor + Critic and run a live probe**: build a minimal closed-loop capability and `eval_env`, then run a live attempt wrapped in `with record_window() as win:` (or a `@record @capability` probe) while 30 Hz `Perception.sample` captures the full trajectory.
2. **Slice the 30 Hz replay to upgrade the Critic (`eval_env`) first**: inspect the captured trajectory with `Client().replay(win)` or `Client().replay(around=record_id, before_seconds=3.0, after_seconds=2.0)`. Measure real multi-frame dynamics (e.g., how many 33ms frames a nibble vs. a bite splash lasts, or how background ripples fluctuate) and feed those real timeline slices or calibrated dynamics into `env.observe()` (which can call `Client().observe()` or `Client().replay()` without recursion) until the upgraded Critic reproduces the failure mode and causes the naive `v0` Actor to fail (`passed=False`).
3. **Iterate the Actor offline against the upgraded Critic**: refine the `@capability` and run `ludens eval run <id>` offline until it passes (`verified`), then validate in live play.

```python
import random
from ludens_tools import Client, capability, eval_capability, eval_env, record_window

@capability
def reel_on_bite() -> dict:
    """Poll for a real bite and reel inside its reaction window."""
    client = Client()
    reeled = False
    with record_window() as window:
        for _ in range(20):
            observation = client.observe()
            if observation["event"] == "bite":
                client.call("controller/pad.play", {"button": "a"})
                reeled = True
                break
    return {"reeled": reeled, "window": window.to_dict()}

@eval_env
class BiteEnv:
    """Surrogate fishing pond with randomized nibbles preceding the bite."""
    def __init__(self, seed: int):
        self.tick = 0
        self.bite_at = random.Random(seed).randrange(3, 10)
        self.reeled = False

    def observe(self, query=None):
        self.tick += 1  # Advance virtual time; randomized nibbles precede the bite.
        # Client().replay(...) or Client().observe() may supply real 30 Hz timeline slices here.
        return {"event": "bite" if self.tick == self.bite_at else "nibble"}

    def call(self, id, args):
        if id == "controller/pad.play" and self.tick == self.bite_at:
            self.reeled = True
        return {"ok": True}

@eval_capability(reel_on_bite, env=BiteEnv)
def eval_reel_on_bite() -> dict:
    """Grade closed-loop reeling from surrogate ground truth."""
    failed_seeds = []
    for seed in range(20):
        with BiteEnv(seed) as env:  # @eval_env classes mount directly as context managers.
            reel_on_bite()
        if not env.reeled:
            failed_seeds.append(seed)
    pass_rate = (20 - len(failed_seeds)) / 20
    return {"passed": not failed_seeds, "rewards": {"pass_rate": pass_rate}, "details": {"failed_seeds": failed_seeds}}
```

The eval must have a docstring and return either a non-empty flat `dict[str, int | float]` of finite rewards or an envelope `{"rewards": {...}, "details"?: {...}, "passed"?: bool}`. When `passed` is `False`, the run records `failed` while preserving `rewards` and `details` for iteration. This forms the **Capability – Eval – Env** triad: the optional `env` argument on `@eval_capability(fn, env=...)` accepts a same-file `@eval_env` symbol or a `"python/path.py:EnvName"` ID string for an env declared in another module, and `ludens eval list` reports the discovered `envs` catalog (id, description, origin, `codeSHA`). Discovery is static; evaluation executes only when requested:

```sh
# List bindings, current statuses, rewards, and discovery diagnostics
ludens eval list

# Run one bound eval, or every capability with a bound eval
ludens eval run python/perception.py:parse_hp_bar
ludens eval run --all

# Flag a capability as adapting when live usage fails despite passing its old test set
ludens eval adapt python/perception.py:parse_hp_bar --reason "False positive on dark transition" --record <record-id>

# Read immutable historical runs, newest first
ludens eval history python/perception.py:parse_hp_bar
ludens eval history
```

When live execution exposes an unmodeled dynamic or visual edge case, `ludens eval adapt <id> --reason "<why>" --record <record-id>` marks the capability `adapting` and links the counterexample. Refine the surrogate environment or replay test set so the eval reproduces that live failure, then iterate on the capability until `ludens eval run <id>` passes again. This closes the Sim-to-Real loop: live failure → recorded counterexample → offline reproduction → verified fix.

Records are stored in `.ludens/evals/latest.json` and `.ludens/evals/runs/<run-id>.json`. The catalog exposes six statuses:

| Status | Meaning |
| --- | --- |
| `missing` | No `@eval_capability` is bound to the capability. |
| `unverified` | An eval is bound, but no latest run exists. |
| `stale` | The capability, eval, or bound env source `codeSHA`, the bound eval ID, or the bound env ID changed after the latest run. |
| `adapting` | Explicitly marked for eval revision; reruns stay failed/adapting while the eval module's whole-file `evalCodeSHA` and the bound env module's `envCodeSHA` are unchanged. |
| `failed` | The latest matching run failed or produced no valid non-empty rewards. |
| `verified` | The latest matching run passed with valid rewards for the current capability and eval code. |

All three `codeSHA` values (`capabilityCodeSHA`, `evalCodeSHA`, and the bound env's `envCodeSHA`) hash whole source files, not function AST nodes. This includes module-level `CASES` constants. Any edit to the eval module or its bound `@eval_env` module, including a comment or a capability-only edit in the same file, releases the adaptation gate and makes the previous result `stale`; only a subsequent passing run becomes `verified`. This is a source-change guard, not proof that counterexamples were added: add the failing records to the test set/verifier before trusting the capability again. Changes to external fixtures or imported helpers are not included in these hashes; update the eval module when revising those cases.

`ludens consolidate` supplies a fresh static evaluation catalog to its file-only prompt: capabilities with a bound `@eval_capability` may be retained or promoted into `skills/` only when `verified` (while `unverified`, `stale`, `adapting`, or `failed` entries are pruned), whereas capabilities without a bound eval (`missing`, such as live device-action macros) may still be retained when proven useful in live runs. It does not execute evals or edit capability/eval source during consolidation; needed changes or eval commands are recorded in memory for a later execution turn.

## Capability Archiving and the Workspace Timeline

### 1. The `@record` Decorator and the Record Envelope

A function marked only with `@capability` returns a plain Python result and writes no permanent archive to disk. When a perception or action result should be persisted to the workspace timeline, stack the `@record` decorator on top (`@record` and `@capability` may appear in either order, but `@record` must be used together with `@capability`):

```python
from ludens_tools import capability, record

@record
@capability
def detect_scene() -> dict:
    """Extract structured scene state and retain the frame on the timeline."""
    return {
        "text": "Title screen ready",
        "data": {"menu": "start", "cursor": 0},
        "media": [{"mediaType": "image/png", "path": "latest.png"}],
        "space": {"frame": "top_screen", "width": 400, "height": 240},
    }
```

An `@record` function's return value must be a dict envelope containing only the following known fields (all optional; unknown fields raise an error):

| Field | Type | Meaning |
| --- | --- | --- |
| `text` | `str` | Short text description for the model and the console. |
| `data` | Any JSON-serializable value | Structured state data (used when expanding record details or reading from code). |
| `media` | `list[dict]` | Media list, each item either `{"mediaType": "...", "path": "..."}` (workspace-relative path supported) or `{"mediaType": "...", "data": "<base64>"}` (the `data` returned by a device screenshot can be passed through directly). |
| `sampledAt` | `str` (ISO timestamp) | Known source sampling time (omit to keep only the record-completion time `recordedAt`). |
| `sources` | `list` | Source references derived from other observations or nested records. |
| `space` | `dict` | Coordinate-system description defined by the device or algorithm. |
| `effect` | `dict` or `list[dict]` | Optional in-process actuation request(s), each containing a capability/controller `id` and optional `arguments` (or `args`) object. |
| `transition` | `str` or `dict` | Optional next state for the continuous state machine: a target capability name, or `{"to": "...", "arguments": {...}}` (`args` is also accepted). |

During `ludens eval run`, `@record` still validates this envelope, but appends only a synthetic `timeline: {recordId, sequence}` in memory; it does not persist records or archive media. Inside `eval_env(env)`, appended envelopes are also collected in `env.recorded` (initialize it as a list on environments that cannot accept new attributes). These records are not added to `Client().observe()` history. Optional `env.list()` and `env.help(id)` callbacks provide simulated catalog information. Driver calls preserve the normal argument contract: omitted arguments become `{}`, and non-dict arguments are rejected.

### 2. Single Writer and Media Archiving

Whether an `@record` function is called in the resident process, via a plain `import`, or from the CLI, computation runs in the caller's own Python process; the result is then handed over the Ludens socket to the resident perception worker — the **single timeline writer** — for persisting, and the returned envelope carries `timeline: {recordId, sequence}` plus media `asset` references (if the perception writer is not running or the write fails, the call raises explicitly instead of silently swallowing the error or auto-retrying the action):

- **Images flow into fMP4 video segments**: images are written to fragmented MP4 segments under `.ludens/timeline/video/` (5 minutes per segment by default, finalized after 10 idle seconds), addressed precisely via `{pts, timeBase, width, height}` in `timeline.video`; the hot window keeps in-memory originals for realtime delivery, and cold history queries decode from video segments on demand.
- **Content-addressed non-video media**: audio, binaries, and other media are deduplicated by SHA-256 hash under `.ludens/timeline/objects/<sha256>.bin`.

For continuous sampling via the resident `perception.py`, querying the timeline with `ludens observe`, configuring `.ludens/settings.json`, and writing the resident `action.py`, continue with [Resident Perception and Action Loops](perception-and-action.md).

## Background Programs and Human Handoff

- **OMP-native background tasks**: long-running training, data analysis, or helper scripts can use the OMP-native `bash` tool's async tasks (`async`) or named services (`name`) directly; inspect status with `read proc://`, terminate with `write proc://<id>/kill`, or wait with `wait`.
- **Control-lease isolation**: on every `ludens auto on`, the Ludens plugin injects the latest `BASEWARE_EPOCH` into the native shell environment. A background program only holds the `epoch` from when it started; once a human handoff or control period ends, the old `epoch` is invalidated immediately — even if the background process is still doing local computation, it can no longer send any input commands to the device, nor request a new `epoch` on its own.
