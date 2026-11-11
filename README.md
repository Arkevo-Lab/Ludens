# Ludens

**English** · [简体中文](README.zh.md)

**Let coding agents perceive, control, and self-improve across real desktops, game consoles, and emulators—by writing their own code.**

Instead of locking an agent behind static prompts and fixed action spaces, Ludens gives it a persistent software workspace wired to live hardware. As it plays a game or operates an unfamiliar app, the agent writes and hot-reloads its own 30 Hz perception state machine (`perception.py`), distills reusable skills (`@capability`), and verifies them offline against surrogate environments (`@eval_env`) before acting live.

---

## Why Ludens

- **Any Screen, Any Controller** — Connect local desktops (`CUA`), real consoles over capture + HID bridges (e.g. Raspberry Pi via SSH), emulators, or MCP endpoints. Mount multiple machines into one workspace and route actions on the fly.
- **Code-First Perception** — A resident Python worker continuously records fMP4 video into a searchable 30 Hz timeline while executing and hot-reloading the agent's own detectors and closed-loop reflexes in `perception.py`.
- **Self-Verified Skills** — Agents turn trial-and-error into typed `@capability` functions paired with `@eval_env` surrogate environments and `@eval_capability` checks, iterating in milliseconds via `ludens eval`.
- **Live Cockpit & Frame-Exact Replay** — Watch live multi-device streams, collaborate asynchronously via the duplex **Event Pool** (`ludens event`), interrupt mid-turn (`steer`), revoke control instantly (`epoch` leases), and scrub 30 Hz replays alongside model traces in the Web Console—or follow along with the optional **Ludens Pet** desktop companion.

## How It Works

Inside a workspace (`~/.ludens/workspaces/<name>`), the agent evolves ordinary Python modules that run against live devices or offline surrogate environments:

```python
# skills/fishing.py
from ludens_tools import Client, capability, eval_capability, eval_env

@capability
def reel_on_bite() -> dict:
    """Watch the 30 Hz perception stream and press A the moment a bite appears."""
    client = Client()
    for _ in range(30):
        records = client.observe()["records"]
        if records and records[-1]["data"]["event"] == "bite":
            client.call("controller/pad.play", {"button": "A"})
            return {"reeled": True}
    return {"reeled": False}

@eval_env
class PondEnv:
    """Offline surrogate pond: nibbles first, then a single bite frame."""
    def __init__(self) -> None:
        self.tick, self.reeled = 0, False

    def observe(self, query=None) -> list[dict]:
        self.tick += 1
        return [{"data": {"event": "bite" if self.tick == 5 else "nibble"}}]

    def call(self, id: str, args: dict) -> dict:
        self.reeled = (id == "controller/pad.play" and self.tick == 5)
        return {"ok": True}

@eval_capability(reel_on_bite, env=PondEnv)
def eval_reel_on_bite() -> dict:
    """Verify closed-loop reaction timing without touching the live device."""
    with PondEnv() as env:
        reel_on_bite()
    return {"passed": env.reeled, "rewards": {"accuracy": 1.0 if env.reeled else 0.0}}
```

Verify every capability offline from the CLI or with one click in the Web Console (`?view=caps`):

```sh
ludens eval run --all
```

## Quick Start

Requires **Bun 1.4+**, **Node.js 22.13+**, **Python 3.12+** with **uv**, and configured **OMP** model credentials.

### 1. Install & Build

```sh
git clone https://github.com/Arkevo-Lab/Ludens.git && cd Ludens
bun install --frozen-lockfile
uv sync --project core/python --frozen
(cd app && npm run build)
export PATH="$PWD/baseware/bin:$PWD/core/bin:$PATH"
```

### 2. Initialize & Start a Workspace

Use the built-in `cua` desktop driver (see [Devices & Drivers](docs/en/tutorials/devices.md) to attach emulators via `--driver-package` or remote SSH / bridge nodes):

```sh
ludens init --name my-agent --driver cua
cd "$HOME/.ludens/workspaces/my-agent"
ludens up
```

### 3. Open the Console & Hand Over Control

Open [`http://127.0.0.1:3015`](http://127.0.0.1:3015) to manage devices, watch live streams, or scrub replays—or grant autonomous control from the terminal:

```sh
ludens auto on --message "Explore the environment and build reusable capabilities"
ludens event send "Check the inventory screen when the current fight ends"
ludens steer "Stop and dodge right now"
ludens auto off
```

## Architecture

| Package | Role |
| --- | --- |
| [`@ludens/protocol`](protocol/README.md) | Zero-dependency RPC schemas, event envelopes, and content-addressed archive contracts. |
| [`@ludens/baseware`](baseware/README.md) | Device control plane: driver loader, multi-machine node pool, and `epoch` lease arbitration. |
| [`@ludens/core`](core/README.md) | Agent harness: Shiori runtime, resident Python `perception.py` worker, background launcher, and `ludens eval`. |
| [`@ludens/app`](app/README.md) | Next.js Web Console (`:3015`) for Live, Replay, Capabilities, Studio & Baseware, plus the optional Electron **Pet**. |

## Documentation

Full guides are maintained in English ([`docs/en/`](docs/en/)) and Chinese ([`docs/zh/`](docs/zh/)), and are also available inside the Console at `?view=docs`:

- **[Tutorials](docs/en/tutorials/index.md)** — [Install & Lifecycle](docs/en/tutorials/quickstart.md) · [Devices & Node Pool](docs/en/tutorials/devices.md) · [Workspaces & Capabilities](docs/en/tutorials/workspace.md) · [Perception State Machine](docs/en/tutorials/perception-and-action.md) · [Debugging](docs/en/tutorials/debugging-and-verification.md)
- **[Reference](docs/en/reference/index.md)** — [Architecture](docs/en/reference/architecture.md) · [Baseware](docs/en/reference/baseware.md) · [Driver Bridge Protocol](docs/en/reference/driver-bridge-protocol.md) · [Logging](docs/en/reference/logging.md) · [Dashboard UI](docs/en/reference/dashboard-ui.md)
- **[Insights](docs/en/insights/index.md)** — [Speculative Compaction](docs/en/insights/omp-compaction.md) · [WebSocket Delta Recovery](docs/en/insights/ws-recovery.md) · [Single-Channel Turn Injection](docs/en/insights/omp-injection.md)

> **Safety Note:** Agents execute shell commands and Python directly on the host, and run logs retain screen recordings. Isolate untrusted workloads in VMs or containers; run `ludens auto off` anytime to revoke device input immediately.

## License

[MIT](LICENSE)
