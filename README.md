# Ludens

**A multimodal agent harness for complex tasks through self-adaptation and self-improvement.**

Ludens connects agents to arbitrary PC desktops and console environments, giving them a persistent coding workspace to adapt to unfamiliar interfaces and continuously improve how they act. Instead of relying on static prompts or fixed action spaces, a Ludens agent writes and refines its own resident perception-and-action state machine (`perception.py`) and reusable skills (`skills/`) directly in Python.

**Games** are the first flagship class of complex, real-time multimodal tasks we tackle—spanning local PC applications and console emulators—backed by a unified device control plane, a live observability console, and workspace-native capability evaluation.

[Quick start](#quick-start) · [Supported environments](#supported-environments) · [Architecture](#architecture) · [Documentation](#documentation)

## Why Ludens

- **Plug into any PC or console environment.** Discover device controls and workspace Python capabilities through a unified `ludens controller` interface, with parameters inspected on demand.
- **Self-adaptation in a real workspace.** The resident `perception.py` process keeps models, state, and high-frequency sampling in memory across turns without modifying the agent runtime. Editing it or a loaded workspace Python module automatically reloads the process.
- **Continuous self-improvement.** Agents turn repeated interaction patterns into callable `@capability` functions, compose tools via `ludens_tools.Client`, and persist experience in `skills/` and `memory/`.
- **Full-trace observability.** Inspect model inputs, tool calls, timing, and linked device actions in the web Dashboard or optional Ludens Pet desktop companion.
- **Measurable progress.** Evaluate adaptation and skill reuse with workspace-native `@capability` / `@eval_capability` / `@eval_env` contracts, Shiori execution budgets, and `ludens eval`.

## Supported environments

| Driver | Environment | Setup |
| --- | --- | --- |
| **Cua** | Local PC desktop & applications | Built-in adapter. Install the upstream Cua Driver and grant OS permissions ([Cua setup](docs/en/tutorials/devices.md#cua)). |
| **External Drivers** | Game emulators & custom runtimes | Plug in any external driver package (`--driver-package`) or implement the [Driver Bridge Protocol](docs/en/reference/driver-bridge-protocol.md). |

Drivers only expose raw device capabilities (screen capture, input events, control leases); perception, coordinate mapping, and task logic live in the workspace.

## Quick start

### 1. Prerequisites & installation

Requires **macOS** (for `launchd` service management), **Bun 1.4**, **Python 3.12+**, **Node.js 22.13+ / 24+**, **uv**, and configured local **OMP model credentials** (default model: `openai-codex/gpt-6.1-sol`).

```sh
bun install --frozen-lockfile
uv sync --project core/python --frozen
(cd app && npm run build)

export PATH="$PWD/baseware/bin:$PWD/core/bin:$PATH"
```

### 2. Initialize and launch a workspace

Create a workspace for your local PC desktop (`--driver cua`, or attach an external driver package via `--driver-package`):

```sh
ludens init --name my-task --driver cua
cd "$HOME/.ludens/workspaces/my-task"
ludens up
ludens controller list
ludens auto on
```

Open [http://127.0.0.1:3015](http://127.0.0.1:3015) for the web console. `ludens auto on` grants the agent a device control lease and starts autonomous execution. On a fresh workspace, the agent initializes `perception.py` and loads it via `ludens perception reload`.

To pause or shut down:

```sh
ludens auto off  # Return device control; keep services running
ludens down      # Stop workspace-managed services
```

For workspace management, multi-driver options, and the optional **Ludens Pet** desktop companion (`app`), see the [Quickstart guide](docs/en/tutorials/quickstart.md).

## Architecture

Ludens separates device access, the agent harness, and the workspace code evolved by the agent:

| Component | Responsibility |
| --- | --- |
| [Baseware](baseware/README.md) | Device drivers, screen/audio observation, control leases, and CLI / API / MCP access. |
| [Protocol](protocol/README.md) | Zero-dependency contract layer (`@ludens/protocol`): RPC schemas, run-event types, Timeline / Archive formats, and Dashboard DTOs shared by all packages. |
| [Core](core/README.md) | Agent harness (`@ludens/core`) powered by **Shiori** and **OMP 18.14.0**: session lifecycle, resident perception/action, capability evaluation, and logging. |
| [App](app/README.md) | Unified graphical layer (`@ludens/app`): the local web console for live runs, timeline replay, and trace analysis, plus the optional Electron desktop companion with native pet, tray controls, and audio. |

Each workspace is a standalone code directory outside the repository (`~/.ludens/workspaces/<name>` by default):

```text
my-task/
├── ludens.json          # Workspace & driver launch configuration
├── baseware.json     # Generated device capability reference
├── perception.py     # Resident, agent-authored perception-and-action state machine
├── skills/           # Reusable @capability functions and scripts
├── memory/           # Task goals, state, and learned knowledge
└── .ludens/ & logs/     # Session identity, timeline archives, and run logs
```

## Boundaries and safety

- **Trusted local execution:** The agent executes shell commands and Python directly on the host (and shares the desktop when using Cua). Use separate OS sessions or VMs if you require isolation.
- **Explicit control leases:** Device input requires an active lease (`ludens auto on`). Revoking control (`ludens auto off`) immediately invalidates device input permissions.
- **Privacy:** Local logs and model requests may include screenshots and desktop state; review before sharing.

## Documentation

Documentation is maintained in English ([`docs/en/`](docs/en/)) and Chinese ([`docs/zh/`](docs/zh/)):

- **[Tutorials](docs/en/tutorials/index.md)** — [Quickstart](docs/en/tutorials/quickstart.md) · [Devices & Drivers](docs/en/tutorials/devices.md) · [Workspace & Capabilities](docs/en/tutorials/workspace.md) · [Perception & Action](docs/en/tutorials/perception-and-action.md) · [Debugging & Verification](docs/en/tutorials/debugging-and-verification.md)
- **[Reference](docs/en/reference/index.md)** — [Architecture](docs/en/reference/architecture.md) · [Baseware](docs/en/reference/baseware.md) · [Driver Bridge Protocol](docs/en/reference/driver-bridge-protocol.md) · [Logging](docs/en/reference/logging.md) · [Dashboard UI](docs/en/reference/dashboard-ui.md)
- **[Insights](docs/en/insights/index.md)** — Engineering rationales and postmortems ([OMP Compaction](docs/en/insights/omp-compaction.md) · [WS Recovery](docs/en/insights/ws-recovery.md) · [OMP Injection](docs/en/insights/omp-injection.md))
- **[Development Conventions](AGENTS.md)** — Repository workflow and verification rules.

## License

Licensed under the [MIT License](LICENSE).
