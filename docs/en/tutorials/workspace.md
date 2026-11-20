# Workspaces, Capabilities & Self-Verification

A Ludens workspace pairs an isolated code directory with live Baseware devices, persistent perception archives, and offline **Capability – Eval – Env** verification. Instead of leaving behaviors buried in ad-hoc scripts, you and **Shiori** (Ludens's Agent Thread Core) encode reusable actions as typed Python capabilities and verify every change offline before running on live targets.

For design motivation behind this triad, see [Code-First Perception & Self-Verification](../concepts/self-verification.md).

## 1. Workspace Layout

Each workspace follows **1 Workspace = 1 Core** isolation with its own Core runtime and state; workspaces on distinct devices or ports run concurrently under `ludens-server`, and **Reclaim Control** leaves the Core in **Warm Standby** (**Manual Standby**, `manual`). A newly initialized workspace (via `ludens workspace init`) uses the following directory structure:

| Path | Purpose |
| --- | --- |
| `ludens.json` | Workspace configuration (driver, model, allowed machines, multimodal connection flags, `storage` timeline media policy override, `dashboard` / `pet` toggles, diagnostics mode) |
| `AGENTS.md` | Engineering and verification conventions followed by Shiori inside this workspace |
| `MEMORY.md` | Long-term workspace memory documenting durable environment invariants and proven strategies (editable directly or in Console **Config**) |
| `memory/` | Working session notes (such as `memory/current.md`, updated during `ludens consolidate`) |
| `skills/` | Reusable skill instructions (`skills/<name>/SKILL.md`) and capability/eval Python modules (for example `skills/visual_guard.py`) |
| `perception.py` | Resident `Perception` state machine (`start`, `sample`, `close`) running continuously up to 30 Hz during **Auto Run** |
| `loop.py` (optional) | Programmable outer control loop and turn-start context injector (`Loop.step` / `Loop.inject`) with inter-turn hot-reload, zero-token `@capability` dispatch, and safe fault fallback |
| `baseware.json` | Exported Baseware controller schema snapshot (`ludens-core controller list` / `baseware export`) |
| `logs/<run-id>/` | Structured run event streams (`events.jsonl`), `manifest.json`, and `diagnostics.jsonl` (plus `logs/baseware/` device logs) |
| `.ludens/timeline/` | Single-writer workspace timeline keeping local indices, hot write spool, `cache/` LRU media cache, and `pins.json`, while retaining or archiving `video/` 30 Hz fMP4 segments and deduplicated objects |
| `.ludens/evals/` | Offline verification history and `latest.json` status snapshot |
| `.ludens/settings.json` | Workspace overrides for `hotSeconds`, `videoSegmentSeconds`, and `videoIdleSeconds` |

## 2. Unified Capability Catalog

Ludens unifies hardware/software device tools and workspace Python functions under one CLI and RPC surface (`ludens-core controller`):

- **Baseware device tools**: Exposed as `controller/<tool>` (or `controller/<machineId>/<tool>` when routing to a specific node in a multi-machine pool). See [Devices & Baseware](devices.md).
- **Workspace Python capabilities**: Discovered statically via AST inspection across all `.py` files in the workspace (excluding `logs/`, `.ludens/`, `.git/`, `node_modules/`, `.venv/`, `venv/`, and `__pycache__/`), and addressed as `python/<relpath>:<name>` (for example `python/skills/visual_guard.py:act_on_alert`).

### Writing a Valid `@capability`

Every top-level `@capability` exposed to CLI or Shiori must obey four static-discovery rules:

1. **Synchronous function**: Use `def`, never `async def`.
2. **Non-empty docstring**: Describes what the capability does and when to invoke it; surfaced in `ludens-core controller list` and `--help`.
3. **Supported type annotations**: All parameters must use `str`, `int`, `float`, `bool`, `list[T]`, `dict[str, T]`, or `Optional[T]` / `T | None`, with JSON literal defaults where optional. Positional-only parameters, `*args`, and `**kwargs` are not allowed.
4. **No external decorator stacking**: Inside `@capability` modules, only combine `@capability` with Ludens's own `@record` and `@observe` decorators.

Inspect and call discovered capabilities at any time from the terminal:

```sh
ludens-core controller list
ludens-core controller python/skills/visual_guard.py:act_on_alert --help
ludens-core controller python/skills/visual_guard.py:act_on_alert --args '{"channel":1}'
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

## 4. Running `ludens workspace eval` / `ludens-core eval` and Closing the Failure Loop

Run offline evaluations from the terminal via the pure-RPC `ludens workspace eval` command (supports `--remote`) or inside the sandbox via `ludens-core eval`:

```sh
ludens workspace eval list
ludens workspace eval run --all
ludens workspace eval run python/skills/visual_guard.py:eval_act_on_alert
ludens workspace eval history python/skills/visual_guard.py:eval_act_on_alert --limit 10
```

(Inside Shiori's sandbox `bash` tool, invoke `ludens-core eval <list|run|history|adapt>` directly.) When offline evaluations execute, Ludens strips `LUDENS_SOCKET`, `BASEWARE_SOCKET`, `LUDENS_EPOCH`, and `BASEWARE_EPOCH` from the subprocess environment so evaluations can never accidentally touch hardware or active control leases.

### Six Verification Statuses

Every `@capability` tracks an exact `codeSHA` across the capability function, its bound `@eval_capability`, and its bound `@eval_env`:

| Status | Meaning |
| --- | --- |
| `verified` | Latest eval passed against the exact current source hashes |
| `stale` | Capability, eval, or `@eval_env` source changed since the last pass |
| `adapting` | Marked with a live failure record via `ludens workspace eval adapt` (or `ludens-core eval adapt`); blocked until fixed and re-verified |
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

Whenever a `verified` capability misbehaves against a real device or stream, log the counterexample record ID immediately with `ludens workspace eval adapt`:

```sh
ludens workspace eval adapt python/skills/visual_guard.py:act_on_alert \
  --reason "False trigger during camera auto-exposure shift" \
  --record <record-id>
```

Inspect the exact sequence around `<record-id>` using `client.replay(around=record_id, before_seconds=2.0, after_seconds=2.0)` (or inspect the video and events in Console **Replay**), extend `WatchdogEnv` so the current capability fails (`passed: false`), then refine `act_on_alert` until `ludens workspace eval run --all` reports `verified` again.

## 5. Programmable Outer Loop (`loop.py`) & Lean Perception Input

By default (when `loop.py` is absent), Ludens runs the built-in outer loop: reading the latest lean perception envelope plus vision frames and starting an LLM turn. Routine latest reads use a dehydrated payload contract:

`{ ok: true, records: [{ id, sequence, recordedAt, capability?, text?, data?, space?, effect?, transition? }] }`

Default primary-channel reads omit the redundant `capability` string and strip internal runtime noise (`queryId`, `generation`, `codeSHA`, `sampling`, `sources`, `media[*].id`), while explicit historical or filtered `observe` queries (`id`, `at`, `start`, `end`, `after`, `limit`, or `capability`) retain `{ query, hasMore, nextAfter?, availability? }` pagination and availability bounds.

Whenever routine inter-turn polling, deterministic `@capability` dispatch, or periodic consolidation does not require spending LLM tokens on every tick, you or Shiori can create `loop.py` in the workspace root:

```python
from ludens_tools import (
    Client,
    Consolidate,
    Loop,
    Prompt,
    Stop,
    TurnContext,
    TurnInjection,
    Wait,
)


class Loop(Loop):
    """Run nominal patrol ticks deterministically in Python; wake the LLM only on plans or alerts."""

    def inject(self, ctx: TurnContext) -> TurnInjection:
        inj = ctx.default_inject()
        records = inj.records
        latest = records[-1].get("data", {}) if records else {}
        if latest.get("event") == "nominal":
            inj.attach_images = False
        inj.extra.append({"turn": ctx.turn, "llm_turns": ctx.llm_turns})
        return inj

    def step(self, ctx: TurnContext) -> Prompt | Consolidate | Wait | Stop:
        records = ctx.perception.get("records") or []
        latest = records[-1].get("data", {}) if records else {}
        if latest.get("goal_met"):
            return Stop(reason="goal_met")
        if latest.get("event") == "anomaly":
            outcome = Client().call(
                "python/skills/visual_guard.py:act_on_alert",
                {"channel": 1, "threshold": 2},
            )
            if outcome.get("triggered"):
                return Prompt(prompt="Alert relay triggered; inspect recent timeline and log follow-up.")
        if ctx.turn > 0 and ctx.turn % 20 == 0:
            return Consolidate()
        if ctx.turn == 0:
            return Prompt()
        return Wait(seconds=1.0, reason="nominal_patrol")
```

Key runtime guarantees when authoring `loop.py`:

- **Dual-layer customization**: `inject(ctx)` can mutate `ctx.default_inject()` (`TurnInjection`, such as setting `inj.attach_images = False` or appending to `inj.extra`) or return a custom `dict`, `str`, or `None` (skipping turn-start observation injection and vision frames for that turn); `step(ctx)` executes under the active `epoch` lease scope so `Client().call(...)` can invoke `@capability` functions directly before returning `Prompt`, `Consolidate`, `Wait`, or `Stop`.
- **Hot-reload and `loop_fault` fallback**: Edits to `loop.py` or imported workspace `.py` modules hot-reload automatically between turns. Syntax or runtime errors emit `loop_fault`, fall back seamlessly to the built-in default loop, and attach `loopFault` in the next model turn so `loop.py` can be fixed live without dropping the Control Cycle.
- **Urgent human `Steer` preemption**: Sending `ludens steer` (or **Steer Now** in Console) immediately wakes any in-flight `Wait(seconds)` and bypasses `Loop.step()`, forcing an immediate `Prompt` turn carrying the operator's message (`ctx.steered = True`).

## 6. Pluggable Timeline Media Storage & Retention

Continuous 30 Hz perception recording can produce substantial fMP4 video over multi-hour runs. Ludens decouples **locally resident lightweight indices** from **pluggable media backends** so workspace disks stay bounded and 30 Hz encoding never stalls on external disk spin-up or network jitter:

| Backend (`kind`) | Purpose & Behavior |
| --- | --- |
| `ephemeral` | Pure in-memory hot window (`window-<pid>-*`) with zero persistent video segments retained after exit (also forced when `LUDENS_PERCEPTION_PERSIST=0`). |
| `local` | **Default profile (`local-default`)**. Rolling byte-capped ring buffer inside `.ludens/timeline/` (`maxBytes` defaults to `20 GiB`, optional `maxAgeHours`). |
| `directory` | External SSD, SMB, or NFS mount (`<directory.path>/<workspaceId>/video/<uuid>.mp4` & `objects/<sha256>.bin`) with direct zero-copy HTTP `206 Range` streaming. |
| `s3` | Zero-dependency AWS Signature V4 (`HMAC-SHA256`) object storage (AWS S3, Cloudflare R2, MinIO, OSS, COS); proxied with `206 Range` support in both Web Console and Electron Desktop (`ludens-media://local/media`) with zero bucket CORS setup. |

### Global Secret Store (`~/.ludens/storage.json`) vs Per-Workspace Override (`ludens.json`)

- **Global `~/.ludens/storage.json` (`mode 0600`)**: Stores named `profiles` (including S3 credentials and mount paths), `defaultProfileId`, `videoQuality` (3-tier Recording Quality & Storage presets below, defaulting to `balanced`), and `protectReferenced` (`true`).
- **Workspace `<workspace>/ludens.json` (never credentials)**: Optionally sets `storage` (`mode: "inherit" | "ephemeral" | "local" | "profile"`, `profileId?`, `maxBytes?`, `maxAgeHours?`, `localCacheBytes?`, `videoQuality?`):

| Preset (`videoQuality`) | Label | H.264 `CRF` | Max Long Edge | Recommended Local Quota | Best For |
| --- | --- | --- | --- | --- | --- |
| `compact` | Space Saver | `28` | `720p` | `5 GiB` | Mac mini / long-running sessions |
| `balanced` (default) | Balanced | `23` | `1080p` | `20 GiB` | General daily runs |
| `high` | High Quality | `18` | Native (no scaling) | `50 GiB` | High-fidelity visual inspection |

> Recording scaling only affects persisted timeline video; live model perception frames remain untouched.

```json
{
  "storage": {
    "mode": "profile",
    "profileId": "cloudflare-r2-archive",
    "maxBytes": 107374182400,
    "videoQuality": "balanced"
  }
}
```

### Local Hot Spool, Async Cold Archival & Eviction Protection

1. **Local hot spool + bounded LRU cache**: `segments/` indices, `.mp4.json` metadata, and active `status: "pending"` segments always stay on local SSD. Once sealed (`status: "ready"`), a background archiver uploads blobs to `directory` or `s3` and trims local copies + `.ludens/timeline/cache/` to `localCacheBytes` (default `4 GiB`); `Client().replay()` and `@eval_env` hydrate cached segments transparently on demand.
2. **Pinning & model-input protection**: Assets listed in `.ludens/timeline/pins.json` (`{"version": 1, "assets": ["video/<uuid>.mp4"]}`) are **never** auto-evicted; when `protectReferenced` is enabled, frames delivered to LLM turns (`.ludens/archive/media/*.json`) are evicted last, only after unreferenced segments are reclaimed. Evicted segments update `<uuid>.mp4.json` to `status: "evicted"` and surface HTTP `410 Gone` on playback.

## 7. Capabilities, Storage, Config & Consolidation in Console

- **Live (`?view=live`)**: Expand **View model input details** on any model turn card to inspect the post-`Loop.inject` `deliveredPayload` 1:1, and open **Loop steps** to review inter-turn `loop_step` / `loop_fault` events and model-free `@capability` calls (auto-expanded on fault).
- **Capabilities (`?view=caps`)**: Visualize the **Capability – Eval – Env** triad, filter by verification status (`verified`, `adapting`, `stale`, `failed`, `unverified`, `missing`), inspect **Workspace sources** (`baseware.json` vs static Python `@capability`), verify **Core connection check** and **Community driver verification**, and trigger **Run All Evals** with one click.
- **Config (`?view=perception`)**: In **Workspace Studio** (**Model** tab), configure per-workspace **Timeline Storage Policy (`ludens.json · storage`)** and pick a 3-tier Recording Quality & Storage preset (updating both quality and quota in local mode, or quality-only in remote S3/directory profile mode); open **Services & Session** to edit **Workspace Long-Term Memory (`MEMORY.md`)**, inspect the Shiori thread summary, or trigger **Start Workspace** / **Reload Core** / **Stop**.
- **Global Settings → Recording & Storage (`?view=settings`)**: Select the global 3-tier Recording Quality & Storage preset (syncing the `local-default` quota; the **Create Workspace** dialog also defaults to this global tier), inspect aggregate and per-workspace video, cache, index, and log footprints, run **Prune All Workspaces**, **Sync Archive**, or per-workspace **Prune / Sync / Clear Cache**, and manage global storage profiles with live directory / S3 connectivity probes.
- **Consolidation (`ludens consolidate` or Live UI)**: Runs a file-only turn (with device actuation disabled) that promotes `verified` capabilities into `skills/` SKILL cards, drops `unverified`/`stale`/`adapting`/`failed` entries from `skills/`, and refreshes `memory/current.md`.

Continue to [Perception, Action & Performance Tuning](perception-and-action.md) to build your resident `perception.py` state machine and configure 30 Hz multimodal transport.
