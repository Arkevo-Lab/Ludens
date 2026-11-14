# Workspaces, Capabilities & Self-Verification

A Ludens workspace pairs an isolated code directory with live Baseware devices, persistent perception archives, and offline **Capability – Eval – Env** verification. Instead of leaving behaviors buried in ad-hoc scripts, you and **Shiori** (Ludens's Agent Thread Core) encode reusable actions as typed Python capabilities and verify every change offline before running on live targets.

For design motivation behind this triad, see [Code-First Perception & Self-Verification](../concepts/self-verification.md).

## 1. Workspace Layout

Each workspace follows **1 Workspace = 1 Core** isolation with its own Core runtime and state; workspaces on distinct devices or ports run concurrently under App Daemon, and **Reclaim Control** leaves the Core in **Warm Standby** (**Manual Standby**, `manual`). A newly initialized workspace (via `ludens init`) uses the following directory structure:

| Path | Purpose |
| --- | --- |
| `ludens.json` | Workspace configuration (driver, model, cycle budgets, allowed machines, multimodal connection flags, `dashboard` / `pet` toggles, diagnostics mode) |
| `AGENTS.md` | Engineering and verification conventions followed by Shiori inside this workspace |
| `MEMORY.md` | Long-term workspace memory documenting durable environment invariants and proven strategies (editable directly or in Console **Config**) |
| `memory/` | Working session notes (such as `memory/current.md`, updated during `ludens consolidate`) |
| `skills/` | Reusable skill instructions (`skills/<name>/SKILL.md`) and capability/eval Python modules (for example `skills/visual_guard.py`) |
| `perception.py` | Resident `Perception` state machine (`start`, `sample`, `close`) running continuously up to 30 Hz during **Auto Run** |
| `baseware.json` | Exported Baseware controller schema snapshot (`ludens controller list` / `baseware export`) |
| `logs/<run-id>/` | Structured run event streams (`events.jsonl`), `manifest.json`, and `diagnostics.jsonl` (plus `logs/baseware/` device logs) |
| `.ludens/timeline/` | Single-writer workspace timeline storing `@record` observations, deduplicated assets, and 30 Hz fMP4 video under `video/` |
| `.ludens/evals/` | Offline verification history and `latest.json` status snapshot |
| `.ludens/settings.json` | Workspace overrides for `hotSeconds`, `videoSegmentSeconds`, and `videoIdleSeconds` |

## 2. Unified Capability Catalog

Ludens unifies hardware/software device tools and workspace Python functions under one CLI and RPC surface (`ludens controller`):

- **Baseware device tools**: Exposed as `controller/<tool>` (or `controller/<machineId>/<tool>` when routing to a specific node in a multi-machine pool). See [Devices & Baseware](devices.md).
- **Workspace Python capabilities**: Discovered statically via AST inspection across all `.py` files in the workspace (excluding `logs/`, `.ludens/`, `.git/`, `node_modules/`, `.venv/`, `venv/`, and `__pycache__/`), and addressed as `python/<relpath>:<name>` (for example `python/skills/visual_guard.py:act_on_alert`).

### Writing a Valid `@capability`

Every top-level `@capability` exposed to CLI or Shiori must obey four static-discovery rules:

1. **Synchronous function**: Use `def`, never `async def`.
2. **Non-empty docstring**: Describes what the capability does and when to invoke it; surfaced in `ludens controller list` and `--help`.
3. **Supported type annotations**: All parameters must use `str`, `int`, `float`, `bool`, `list[T]`, `dict[str, T]`, or `Optional[T]` / `T | None`, with JSON literal defaults where optional. Positional-only parameters, `*args`, and `**kwargs` are not allowed.
4. **No external decorator stacking**: Inside `@capability` modules, only combine `@capability` with Ludens's own `@record` and `@observe` decorators.

Inspect and call discovered capabilities at any time from the terminal:

```sh
ludens controller list
ludens controller python/skills/visual_guard.py:act_on_alert --help
ludens controller python/skills/visual_guard.py:act_on_alert --args '{"channel":1}'
```

During **Manual Standby** or inside offline tests, capabilities inherit no device control lease (`BASEWARE_EPOCH`); during **Auto Run**, device-mutating calls carry the active Control Cycle `epoch`.

## 3. Capability – Eval – Env Triad

Rather than testing every loop edit against physical hardware or live desktop UIs, wrap your closed-loop logic in three linked declarations:

- **`@capability`**: Executes sensing (`Client().observe()`) and device calls (`Client().call(...)`).
- **`@eval_env`**: Decorates a top-level class or factory (with a docstring) that mocks `observe(query=None)` and `call(id, args)` in virtual time or over sliced 30 Hz timeline recordings.
- **`@eval_capability(target, env=EnvClass)`**: Decorates a top-level synchronous function (with a docstring and no required parameters) that mounts `@eval_env`, runs the capability, and returns metrics (`{"passed": bool, "rewards": {...}, ...}`).

Save the example below as `skills/visual_guard.py`:

```python
from ludens_tools import Client, capability, eval_capability, eval_env

@capability
def act_on_alert(channel: int = 1, threshold: int = 2) -> dict:
    """Confirm consecutive anomaly frames in the 30 Hz stream before triggering an alert output."""
    client = Client()
    streak = 0
    for _ in range(12):
        records = client.observe({"limit": 1})["records"]
        state = records[-1]["data"].get("event") if records else None
        streak = streak + 1 if state == "anomaly" else 0
        if streak >= threshold:
            client.call("controller/relay.trigger", {"channel": channel})
            return {"triggered": True, "streak": streak}
    return {"triggered": False, "streak": streak}

@eval_env
class WatchdogEnv:
    """Surrogate stream: rejects single-frame noise flicker and fires only after sustained anomalies."""

    def __init__(self) -> None:
        self.stream = ["nominal", "anomaly", "nominal", "anomaly", "anomaly", "nominal"]
        self.cursor = 0
        self.calls: list[tuple[int, str, dict]] = []

    def observe(self, query: dict | None = None) -> list[dict]:
        item = self.stream[min(self.cursor, len(self.stream) - 1)]
        self.cursor += 1
        return [{"data": {"event": item}}]

    def call(self, id: str, args: dict) -> dict:
        self.calls.append((self.cursor, id, args))
        return {"ok": True}

@eval_capability(act_on_alert, env=WatchdogEnv)
def eval_act_on_alert() -> dict:
    """Verify two-frame debouncing blocks single-frame noise and fires on tick 5."""
    with WatchdogEnv() as env:
        outcome = act_on_alert(channel=2, threshold=2)
    passed = outcome["triggered"] and env.calls == [(5, "controller/relay.trigger", {"channel": 2})]
    return {"passed": passed, "rewards": {"accuracy": 1.0 if passed else 0.0}}
```

## 4. Running `ludens eval` and Closing the Failure Loop

Run offline evaluations from the workspace root or via Console:

```sh
ludens eval list
ludens eval run --all
ludens eval run python/skills/visual_guard.py:eval_act_on_alert
ludens eval history python/skills/visual_guard.py:eval_act_on_alert --limit 10
```

When `ludens eval run` executes, Ludens strips `LUDENS_SOCKET`, `BASEWARE_SOCKET`, `LUDENS_EPOCH`, and `BASEWARE_EPOCH` from the subprocess environment so evaluations can never accidentally touch hardware or active control leases.

### Six Verification Statuses

Every `@capability` tracks an exact `codeSHA` across the capability function, its bound `@eval_capability`, and its bound `@eval_env`:

| Status | Meaning |
| --- | --- |
| `verified` | Latest eval passed against the exact current source hashes |
| `stale` | Capability, eval, or `@eval_env` source changed since the last pass |
| `adapting` | Marked with a live failure record via `ludens eval adapt`; blocked until fixed and re-verified |
| `failed` | Latest eval raised an exception, returned empty rewards, or reported `passed: false` |
| `unverified` | Eval exists, but has not been executed yet |
| `missing` | Capability has no bound `@eval_capability` |

### Turning Live Failures Into Regression Tests (`adapt` & `record_window`)

Only `.ludens/timeline/`'s single writer (`perception.py` or a running Core) appends permanent `@record` frames to avoid timeline lock contention. Inside live scripts or probes, wrap execution with `record_window()` (or mark helper capabilities with `@record @capability` running through Core) to capture the real time span:

```python
from ludens_tools import Client, record_window

client = Client()
with record_window() as win:
    res = client.call("python/skills/visual_guard.py:act_on_alert", {"channel": 1})

# Retrieve real frames and annotations recorded during that window
frames = client.replay(win)
```

Whenever a `verified` capability misbehaves against a real device or stream, log the counterexample record ID immediately with `ludens eval adapt`:

```sh
ludens eval adapt python/skills/visual_guard.py:act_on_alert \
  --reason "False trigger during camera auto-exposure shift" \
  --record <record-id>
```

Inspect the exact sequence around `<record-id>` using `client.replay(around=record_id, before_seconds=2.0, after_seconds=2.0)` (or inspect the video and events in Console **Replay**), extend `WatchdogEnv` so the current capability fails (`passed: false`), then refine `act_on_alert` until `ludens eval run --all` reports `verified` again.

## 5. Capabilities, Config & Consolidation in Console

- **Capabilities (`?view=caps`)**: Visualize the **Capability – Eval – Env** triad, filter by verification status (`verified`, `adapting`, `stale`, `failed`, `unverified`, `missing`), inspect **Workspace sources** (`baseware.json` vs static Python `@capability`), verify **Core connection check** and **Community driver verification**, and trigger **Run All Evals** with one click.
- **Config (`?view=perception`)**: Open **Services & Session** to edit **Workspace Long-Term Memory (`MEMORY.md`)**, inspect the Shiori thread summary, or trigger **Start Workspace** / **Reload Core** / **Stop**.
- **Consolidation (`ludens consolidate` or Live UI)**: Runs a file-only turn (with device actuation disabled) that promotes `verified` capabilities into `skills/` SKILL cards, drops `unverified`/`stale`/`adapting`/`failed` entries from `skills/`, and refreshes `memory/current.md`.

Continue to [Perception, Action & Performance Tuning](perception-and-action.md) to build your resident `perception.py` state machine and configure 30 Hz multimodal transport.
