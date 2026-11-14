<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="app/public/brand/ludens-mark-dark.svg">
    <img src="app/public/brand/ludens-mark-light.svg" alt="Ludens logo" width="88" height="88">
  </picture>
</p>

# Ludens

**English** · [简体中文](README.zh.md)

**A multimodal, cross-device Agent Harness for solving complex end-to-end tasks — across robotics, security monitoring, desktop automation, and real-time games.**

Instead of confining agents to static prompts and fixed action schemas, **Ludens** pairs a programmable coding workspace with live hardware and software targets:
- **Ludens** is both the overall harness and its own personified mascot.
- **Shiori** serves strictly as Ludens's **Agent Thread Core**, reasoning across turns inside an isolated coding workspace.
- **Baseware** is the **cross-device integration layer**, standardizing drivers, transports, and hardware leases across heterogeneous targets.

---

## Why Ludens

- **Any Screen, Any Device (`Baseware`)** — Connect local desktops (`cua`), camera/HID hardware bridges (such as embedded controllers over SSH or TCP JSON-line bridges), simulators, or MCP endpoints. Mount multiple target nodes into one workspace and route actions uniformly.
- **Code-First Perception (`perception.py`)** — A resident Python worker continuously records fMP4 video into a searchable 30 Hz timeline while running and hot-reloading detectors and closed-loop state machines written by the agent.
- **Self-Verified Capabilities (`@capability` & `ludens eval`)** — Turn trial-and-error behaviors into typed Python capabilities paired with offline `@eval_env` surrogates and `@eval_capability` checks, verifying regressions in milliseconds before running on physical devices.
- **Unified Console, Multi-Modal Loops & Replay** — Operate workspaces from the native **Ludens Desktop App** or local **Console** (`ludens app-server`): launch workspaces with one click, trigger **Auto Run**, send async guidance through the duplex **Event Pool**, interrupt mid-turn (`steer`), execute **Reclaim Control** at any instant, and inspect 30 Hz timeline replays alongside model traces. *(Includes an optional tray **Desktop Pet** widget.)*

## How It Works

Inside a workspace (`~/.ludens/workspaces/<name>`), the agent maintains ordinary Python modules runnable against live Baseware devices or offline surrogate environments:

```python
# skills/visual_guard.py
from ludens_tools import Client, capability, eval_capability, eval_env

@capability
def act_on_alert() -> dict:
    """Watch the 30 Hz perception stream and dispatch an actuation on an anomaly frame."""
    client = Client()
    for _ in range(30):
        records = client.observe()["records"]
        if records and records[-1]["data"].get("event") == "anomaly":
            client.call("controller/relay.trigger", {"channel": 1})
            return {"triggered": True}
    return {"triggered": False}

@eval_env
class WatchdogEnv:
    """Offline surrogate stream: nominal frames first, then a single anomaly on tick 5."""
    def __init__(self) -> None:
        self.tick, self.triggered = 0, False

    def observe(self, query=None) -> list[dict]:
        self.tick += 1
        return [{"data": {"event": "anomaly" if self.tick == 5 else "nominal"}}]

    def call(self, id: str, args: dict) -> dict:
        self.triggered = (id == "controller/relay.trigger" and self.tick == 5)
        return {"ok": True}

@eval_capability(act_on_alert, env=WatchdogEnv)
def eval_act_on_alert() -> dict:
    """Verify closed-loop response timing without touching a physical device."""
    with WatchdogEnv() as env:
        act_on_alert()
    return {"passed": env.triggered, "rewards": {"accuracy": 1.0 if env.triggered else 0.0}}
```

Run offline capability verification from the terminal or Console (**Capabilities**, `?view=caps`):

```sh
ludens eval run --all
```

## Quick Start

Requires **Bun 1.4+**, **Node.js 22.13+**, **Python 3.12+** with **uv**, and configured model credentials.

### 1. Install & Build

```sh
git clone https://github.com/Arkevo-Lab/Ludens.git && cd Ludens
bun install --frozen-lockfile
uv sync --project core/python --frozen
(cd app && npm run build)
export PATH="$PWD/baseware/bin:$PWD/core/bin:$PWD/app/bin:$PATH"
```

### 2. Launch Modes

Ludens runs over a single `@ludens/core` `app-server` (zero Next.js production runtime, pure-TypeScript process supervision) across three workflows:

- **Desktop App**: Build once with `(cd app && npm run desktop:build)` and launch `ludens-app --show-window` (or package native macOS `.dmg` / Windows `.exe` installers via `npm --prefix app run desktop:dist`). Spawns and supervises `ludens app-server`, lets you **Start / Reload / Stop** workspaces cleanly without a terminal, optionally hides to tray + Desktop Pet when closed (`×`), and shuts down managed processes on Quit (`⌘Q` / tray **Quit**).
- **Browser Console (`ludens app-server` / `npm run dev`)**: Start `ludens app-server` (alias `ludens serve`) to serve `/api/*` and the static Console (`app/out`) on [`http://127.0.0.1:3015`](http://127.0.0.1:3015), or run `(cd app && npm run dev)` for frontend HMR.
- **Headless CLI**: Initialize and orchestrate workspaces directly in a terminal (see [Devices & Drivers](docs/en/tutorials/devices.md) to attach external drivers via `--driver-package` or SSH/bridge targets):

```sh
ludens init --name my-agent --driver cua
cd "$HOME/.ludens/workspaces/my-agent"
ludens up
```

### 3. Auto Run, Reclaim Control & Async Collaboration

Open **Live** (`?view=live`) in the Desktop App or [`http://127.0.0.1:3015`](http://127.0.0.1:3015) to click **Start Auto Run**, or control the loop from CLI:

```sh
ludens auto on --message "Explore the target environment and build verified capabilities"
ludens event send "Inspect the status panel after completing the current sequence"
ludens steer "Pause actuation immediately"
ludens auto off
```

## Architecture

| Package | Role |
| --- | --- |
| [`@ludens/protocol`](protocol/README.md) | Zero-dependency RPC schemas, event envelopes, and content-addressed archive contracts. |
| [`@ludens/baseware`](baseware/README.md) | Cross-device integration layer: driver loader, multi-node pool (`stdio`/`bridge`/`ssh`/`http`/`sse`), and `epoch` control lease arbitration. |
| [`@ludens/core`](core/README.md) | Harness runtime & unified `app-server`: **Shiori** (Agent Thread Core), resident Python `perception.py` worker, `/api/*` + Console backend, pure-TS supervisor, and `ludens eval`. |
| [`@ludens/app`](app/README.md) | Static Web **Console** (`app/out` — Live, Replay, Performance, Capabilities, Config, Devices, Workspaces, Docs, Settings, Developer), Electron Desktop App, and optional Desktop Pet. |

## Documentation

Full guides live in English ([`docs/en/`](docs/en/)) and Chinese ([`docs/zh/`](docs/zh/)), and inside the Console at `?view=docs`:

- **[Concepts](docs/en/concepts/index.md)** — [System Overview](docs/en/concepts/overview.md) · [Control Cycles & Collaboration](docs/en/concepts/loop-and-control.md) · [Perception & Self-Verification](docs/en/concepts/self-verification.md)
- **[Tutorials](docs/en/tutorials/index.md)** — [Quick Start](docs/en/tutorials/quickstart.md) · [Devices & Drivers](docs/en/tutorials/devices.md) · [Workspaces & Capabilities](docs/en/tutorials/workspace.md) · [Perception State Machine](docs/en/tutorials/perception-and-action.md) · [Console & Debugging](docs/en/tutorials/console-and-debugging.md)
- **[Reference](docs/en/reference/index.md)** — [Architecture](docs/en/reference/architecture.md) · [CLI Reference](docs/en/reference/cli.md) · [Baseware Contract](docs/en/reference/baseware.md) · [Driver Bridge Protocol](docs/en/reference/driver-bridge-protocol.md) · [Logging](docs/en/reference/logging.md)
- **[Insights](docs/en/insights/index.md)** — [Speculative Compaction](docs/en/insights/omp-compaction.md) · [WebSocket Delta Recovery](docs/en/insights/ws-recovery.md) · [Single-Channel Turn Injection](docs/en/insights/omp-injection.md) · [Perception Parameters](docs/en/insights/perception-parameters.md)

> **Safety Note:** Agents run shell and Python code directly on the host, and run archives retain visual recordings. Isolate untrusted environments in VMs or containers; run `ludens auto off` (or click **Reclaim Control** in Console) at any moment to revoke hardware actuation immediately.

## License

[MIT](LICENSE)
