# Quickstart

This guide gets your environment built, launches Ludens via Desktop App, local browser Console, or Headless CLI, starts an **Auto Run** loop, demonstrates async **Event Pool** collaboration and **Steer Now**, and shows how to **Reclaim Control** cleanly.

## 1. Prerequisites

Ensure the following tools and credentials are available before installing:

- **Bun** `1.4+`
- **Node.js** `22.13+` (or `24+`)
- **Python** `3.12+` with **uv**
- **Configured model / OMP credentials** for your target LLM provider

## 2. Clone, Install, and Build

Run the repository bootstrap commands from the project root and expose the workspace CLIs on `PATH`:

```sh
git clone https://github.com/Arkevo-Lab/Ludens.git && cd Ludens
bun install --frozen-lockfile
uv sync --project core/python --frozen
(cd app && npm run build)
export PATH="$PWD/baseware/bin:$PWD/core/bin:$PWD/app/bin:$PATH"
```

After `export PATH`, `baseware`, `ludens`, and `ludens-app` are available in your shell. To persist `PATH`, add that export line (with the repository path expanded) to your shell profile (`~/.zshrc` or `~/.bashrc`).

## 3. Three Ways to Launch Ludens

All three workflows run on top of the `@ludens/core` `app-server` process supervisor and share the same `~/.ludens/` registry.

### Option A: Desktop App

Build the desktop shell once, then open the native window:

```sh
(cd app && npm run desktop:build)
ludens-app --show-window
```

Common flags for `ludens-app`:

- `--workspace <path>`: Open directly into a specific workspace directory
- `--server <url>` (alias `--dashboard <url>`): Connect the desktop shell to an already running `app-server`
- `--profile <path>`: Override the Electron user-data profile directory
- `--background`: Launch in tray mode without opening the main window immediately
- `--show-window`: Bring the Console window to focus on startup

Inside the desktop window, open **Workspaces** (`?view=workspaces`) to create or switch a workspace, then click **Start Workspace** in **Config** (`?view=perception`) without leaving the UI. Closing the window hides it to the system tray (where the optional **Desktop Pet** widget can be toggled via **Settings** or suppressed with `LUDENS_DISABLE_COMPANION=1`); quitting (`⌘Q` on macOS or tray **Quit**) shuts down managed background processes. For distributable `.dmg` / `.exe` packages, run `npm --prefix app run desktop:dist`.

### Option B: Browser Console (`ludens app-server` / `npm run dev`)

Start the unified `app-server` (alias `ludens serve`) to serve `/api/*` and the static Console build (`app/out`):

```sh
ludens app-server
```

By default `ludens app-server` binds to `127.0.0.1:3015` (configurable via `--host`, `--port <0|1..65535>`, `--static-dir <path>`, `--trusted-origin <origin>`, and `--parent-watchdog`). Open [`http://127.0.0.1:3015`](http://127.0.0.1:3015) in your browser, select or create a workspace in **Workspaces** (`?view=workspaces`), and start it from **Config** (`?view=perception`). When iterating on frontend UI code with hot module reload, keep `ludens app-server` running and start `(cd app && npm run dev)` in another terminal.

### Option C: Headless CLI

Initialize and launch a workspace directly from the terminal. The example below attaches Ludens's built-in desktop automation driver (`cua`):

```sh
ludens init --name my-agent --driver cua
cd "$HOME/.ludens/workspaces/my-agent"
ludens up
```

To connect external hardware bridges, simulators, camera streams, or remote SSH machines instead of `cua`, pass `--driver <id> --driver-package <spec>` and see [Devices & Baseware](devices.md).

Useful flags for `ludens init` and `ludens up`:

- `ludens init --name <name> [--workspace <path>] --driver <id> [--driver-package <spec>] [--game <path>] [--cua-command <path>] [--model <id>] [--seconds <n>] [--requests <n>] [--pet | --no-pet]`
- `ludens up [--dry-run] [--dashboard | --no-dashboard] [--pet | --no-pet]` (use `--dry-run` to inspect the launch plan before spawning processes; `--no-dashboard` skips launching the local Console server; `--pet` / `--no-pet` toggles the optional Desktop Pet)

If you move or import an existing directory later, register it with `ludens workspace open <dir> [--new-id]` or migrate legacy state via `ludens workspace import <dir> [--legacy-state <dir>] [--previous-workspace <dir>]`.

## 4. Auto Run, Event Pool, and Reclaim Control

Ludens separates supervision from direct operation across two explicit control modes:

- **Manual Standby** (`manual`): You hold the active input lease. **Shiori** (Ludens's Agent Thread Core) stands by without dispatching actuation calls.
- **Auto Run** (`auto`): Shiori holds the active **Control Cycle** (`epoch`), executing turns against the Baseware driver and the resident `perception.py` loop within your time and request budget.

### Operating from Console (`Live`, `?view=live`)

1. Open **Live** (`?view=live`) in the Desktop App or browser Console.
2. Enter an objective in the composer (for example, watching a desktop workflow or inspecting sensor streams) and click **Start Auto Run**.
3. Queue non-blocking notes while the agent works using the **Event Pool** composer mode, or switch the composer to **Steer Now** to interrupt mid-turn with immediate guidance.
4. Click **Reclaim Control** at any moment to immediately end Auto Run, invalidate the agent's control lease, and switch back to **Manual Standby**.
5. After an active exploration batch, click **Consolidate skills/ & memory/ notes** to summarize durable workflows and findings into `skills/` and `memory/`.

### Operating from CLI

Every action in **Live** has a matching CLI command (run inside the workspace or pass `--workspace <path>`):

```sh
ludens status
ludens auto on --message "Explore the target environment and build verified capabilities" --seconds 600
ludens event send "Check the alert counter after completing the current sequence"
ludens steer "Pause actuation immediately and report current telemetry"
ludens auto off
ludens consolidate
```

Other handy lifecycle commands:

- `ludens auto timer <seconds|off>`: Adjust or clear the remaining Auto Run wall-clock timer while running
- `ludens event list | reply | ack`: Inspect or acknowledge items in the bidirectional Event Pool
- `ludens model [<provider/id>] [--service-tier none|priority|ultrafast] [--effort none|minimal|low|medium|high|xhigh|max]`: Switch model or reasoning effort on the running workspace
- `ludens services`: Check status of managed background services in the current workspace
- `ludens down [--keep-emulator] [--dashboard] [--pet]`: Stop the workspace (`--keep-emulator` preserves a launched target process; `--dashboard` / `--pet` also stop shared Console/Desktop Pet processes)

## 5. Workspace Config (`ludens.json`) & Global Defaults

`ludens init` writes `ludens.json` in the workspace root (inspect and edit any field from Console **Config**, `?view=perception`):

| Field | Default | Purpose |
| --- | --- | --- |
| `driver` / `driverPackage` | `cua` / unset | Driver identifier and optional external package or manifest path |
| `game` / `port` / `cuaCommand` | unset | Optional target binary path, controller port, or custom CUA server command |
| `model` | `openai-codex/gpt-6.1-sol` | Primary model identifier (`provider/model`) for Shiori |
| `serviceTier` / `effort` | unset | Optional inference tier (`none`, `priority`, `ultrafast`) and reasoning effort (`none`..`max`) |
| `seconds` / `requests` | `1800` / `1000` | Default per-run Auto Run duration budget (seconds) and request limit |
| `compactionThreshold` | unset | Optional token threshold triggering background context compaction |
| `connection` | inherited | Multimodal transport flags (`openaiWebsockets`, `cacheRetention`, `appendOnlyContext`, `imageUrls`) |
| `machines` | unset | Allowed and active node list (`{ active?, allowed }`) for multi-machine routing |
| `dashboard` | `true` | Whether `ludens up` starts/ensures the local Console `app-server` |
| `pet` | `false` | Optional Desktop Pet toggle for this workspace |
| `logging` | `{ "diagnostics": "normal" }` | Archive verbosity (`"normal"` or `"full"`) |

Use `ludens config` to set machine-wide defaults stored under `~/.ludens/` (override the home root with `LUDENS_HOME`):

```sh
ludens config show
ludens config set workspaceRoot "$HOME/ludens-workspaces"
ludens config set defaults.model "openai-codex/gpt-6.1-sol"
ludens config set defaults.seconds 1800
ludens config set defaults.requests 1000
ludens config set defaults.pet false
ludens config set defaults.connection.imageUrls.enabled true
```

## 6. Inspecting Run Logs & Next Steps

Every run persists structured event logs under `logs/<run-id>/` and records continuous observations and 30 Hz fMP4 video into `.ludens/timeline/`. You can replay runs visually in Console **Replay** (`?view=replay`) or inspect archived event payloads directly from the terminal with `ludens logs events --run <run-dir>` and `ludens logs read --run <run-dir> ...`.

Continue to the next tutorials:

- [Devices & Baseware](devices.md) — connect external hardware drivers, remote SSH/bridge hosts, and multi-node routing
- [Workspace, Capabilities & Self-Verification](workspace.md) — organize `MEMORY.md`, `skills/`, `@capability`, and `ludens eval`
- [Perception, Action & Performance Tuning](perception-and-action.md) — build hot-reloaded `perception.py` state machines and tune multimodal latency
- [Console Operations & Debugging](console-and-debugging.md) — operate all Console views and diagnose stalled cycles or failed checks
