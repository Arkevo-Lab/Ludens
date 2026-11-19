# Quickstart

This guide gets your environment built, launches Ludens across its three runtime surfaces — **Desktop App (`desktop`, zero TCP ports)**, **Hosted Cloud / Remote Node & Mobile (`remote`, managed sandbox)**, and **Frontend & AI Harness Dev Preview (`web-dev`, isolated by default)** — alongside the unified `ludens` CLI (local UDS and `--remote`), starts an **Auto Run** loop, demonstrates async **Event Pool** collaboration and **Steer Now**, and shows how to **Reclaim Control** cleanly.

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

## 3. Three Runtime Surfaces & Unified CLI

All surfaces share one **Vite Static SPA (`app/out`)**, one `@ludens/protocol/app-rpc` **JSON-RPC 2.0** contract, and one **App Daemon** (`ludens app-server`, alias `ludens serve`, managed via `ludens daemon`, supervising per-workspace **Cores** following **1 Workspace = 1 Core**), negotiating an explicit `runtimeProfile` and `HostSessionCapabilities` during session initialization.

### 1. Desktop App (`ludens-app` — Primary Daily Local Entry Point, `desktop`)

Build the desktop shell once, then open the native window:

```sh
(cd app && npm run desktop:build)
ludens-app --show-window
```

Common flags for `ludens-app`:

- `--workspace <path>`: Open directly into a specific workspace directory
- `--server <url>`: Override `ludens-app://console/` to load an explicit local Vite dev server URL
- `--profile <path>`: Override the Electron user-data profile directory (default `~/.ludens/desktop/profile`)
- `--background`: Launch in tray mode without opening the main window immediately
- `--show-window`: Bring the Console window to focus on startup

`ludens-app` is the primary daily local entry point. It uses Pure-Node `ensureLocalAppDaemon` per `LUDENS_HOME` (default `~/.ludens`) to start or reuse a singleton `ludens app-server` over Unix Domain Socket (`app-server.sock`) with **0 listening TCP ports** and full host capabilities (local filesystem pickers, `file:` driver specs, `cuaCommand` overrides, and local storage directories). It loads the packaged SPA from `ludens-app://console/`, serves media over `ludens-media://local/media?...` (via UDS `media/resolve` with `206` `Range`), and bridges renderer, native directory/ROM dialog pickers, and Desktop Pet RPC via `window.ludens.rpc` and `window.ludens.dialog.pickPath`. While connected cleanly over local `electron-local` UDS, the sidebar hides the connection pill for distraction-free native chrome, while `⌘K / Ctrl+K` Quick Switcher lets you open **Switch Connection Target / Remote Server** anytime.

Trigger the **New Workspace** wizard from the sidebar Workspace Switcher footer, `⌘K / Ctrl+K` Quick Switcher, or **Workspaces** (`?view=workspaces&create=1`): bind a registered **Device Node** from `~/.ludens/machines.json` in one click, choose an **Installed Driver** with inline ROM & port fields, or verify & save a **New Driver Package**, pick your model inline, and click **Create & launch into Live** to initialize, boot services, and enter **Live** (`?view=live`) directly (even on a 0-run workspace): typing a goal prompt or clicking **Start Auto Run** spawns that workspace's **Core + Baseware** on demand (`launchedBy: "app"`) without running `ludens up` first (you can also explicitly click **Start Workspace / Reload Core / Stop** from **Config**, `?view=perception`). The sidebar **Active Cores** list shows all running Cores with `App` / `CLI` origin badges and inline stop (`■`) buttons. Closing the window (`×`) hides it to the system tray (keeping active Cores running; the optional **Desktop Pet** defaults to `!auto` multi-Core auto-follow, prioritizing pending `🆘` `pendingOutbound > 0`, then the focused window's Core, then a background **Auto Run** Core, and can be toggled in **Settings** or suppressed with `LUDENS_DISABLE_COMPANION=1`); quitting (`⌘Q` / `before-quit` / tray **Quit**) runs `ActiveCoreQuitGuard`: if 0 Cores are running, the app exits immediately leaving the background daemon intact; if active Cores exist, it asks whether to **Keep Running in Background**, **Stop All Cores & Quit**, or **Cancel**. For distributable `.dmg` / `.exe` packages, run `npm --prefix app run desktop:dist`.

### 2. Hosted Cloud / Remote Node & Mobile (`ludens serve` — Managed Sandbox, `remote`)

For hosted cloud SaaS deployments, remote compute nodes, and mobile/tablet browsers, start a remote **App Daemon** (`ludens serve`, alias `ludens app-server`, or background `ludens daemon start`) serving the static SPA (`app/out`), WebSocket JSON-RPC `/rpc`, HMAC capability-ticket `/media`, and `/health`:

```sh
# Hosted cloud or remote node (mandatory --auth token whenever ws:// runs without --dev)
LUDENS_APP_TOKEN="your-secret-token" \
  ludens serve --listen ws://0.0.0.0:3015 --auth token --token-env LUDENS_APP_TOKEN --static-dir app/out

# Or launch as a background daemon
LUDENS_APP_TOKEN="your-secret-token" \
  ludens daemon start --listen ws://0.0.0.0:3015 --auth token --token-env LUDENS_APP_TOKEN --static-dir app/out
```

In `remote` mode, **token authentication** and **`managed-sandbox` capabilities** are enforced automatically (no host filesystem escapes, no arbitrary local path mounting, no `file:` local driver packages, no `cuaCommand` overrides, and no custom host `directory` storage — `RpcRouter` rejects restricted mutations with `403 CAPABILITY_RESTRICTED` and Console forms hide host-only controls cleanly). Running `ludens serve` with no `--listen` argument starts **UDS-only (`app-server.sock`, 0 listening TCP ports)**. When opening an authenticated URL with a hash bootstrap (`http(s)://host:port/#token=...`) on a phone, tablet, or desktop browser, the responsive Vite SPA immediately captures the token and strips `#token=` via `history.replaceState`, and `<ConnectionTargetDialog>` switches seamlessly between `electron-local`, `same-origin`, and `remote` (`ws://` / `wss://` + token) targets.

### 3. Frontend & AI Harness Dev Preview (`npm run dev` / `--dev` — Isolated by Default, `web-dev`)

When developing frontend UI components or running automated AI Harness browser checks, launch the isolated dev preview workflow:

```sh
# Isolated web-dev preview (defaults LUDENS_HOME to ~/.ludens-dev so ~/.ludens Desktop App is untouched)
(cd app && npm run dev)

# Explicitly point Vite web-dev at your real ~/.ludens registry
(cd app && npm run dev:real)

# Build Electron shell + run Vite HMR + attach ludens-app --server against ~/.ludens
(cd app && npm run desktop:dev)
```

`npm run dev` (`app/scripts/dev.mjs`) spawns a loopback `ludens app-server --dev --listen ws://127.0.0.1:0 --parent-watchdog` alongside the Vite dev server (default `127.0.0.1:3015`), isolating `LUDENS_HOME` to `~/.ludens-dev` by default (or a custom directory via `-- --home /custom/dir`) so starting or stopping `npm run dev` never collides with or kills your running `~/.ludens` Desktop App daemon. `--dev` is restricted to loopback hosts (`127.0.0.1`, `localhost`, `::1`), grants full capabilities for local harness/browser testing, displays a semantic **`DEV PREVIEW`** badge in the sidebar, and unlocks a **Dev UI Simulation** switcher inside `<ConnectionTargetDialog>` to preview both full-capability desktop forms and `managed-sandbox` cloud/mobile forms. To preview the static production bundle `app/out` locally, run `(cd app && npm start)` (passes `--dev` on tokenless loopback, or `--auth token --token-env LUDENS_APP_TOKEN` when `LUDENS_APP_TOKEN` is set).

### Unified CLI (`ludens` — Local UDS & `--remote`)

Manage the background singleton daemon with `ludens daemon status|start|stop|restart` (`stop` also stops managed Cores unless `--keep-cores` is passed), and initialize/orchestrate workspaces over local `app-server.sock`:

```sh
ludens init --name my-agent --driver cua
cd "$HOME/.ludens/workspaces/my-agent"
ludens up
```

All operator lifecycle and control commands (`config`, `workspace list|open|forget`, `init`, `up`, `services`, `down`, `status`, `auto`, `steer`, `consolidate`, `stop`, `model`) also accept `--remote ws(s)://... [--token ...]` (or `LUDENS_REMOTE_URL` / `LUDENS_REMOTE_TOKEN`) to target a remote `app-server` identically. To connect external hardware bridges, simulators, camera streams, or remote SSH machines instead of `cua`, pass `--driver <id> --driver-package <spec>` and see [Devices & Baseware](devices.md).

Useful flags for `ludens init` and `ludens up`:

- `ludens init --name <name> [--workspace <path>] [--machine <id>] [--driver <id>] [--driver-package <spec>] [--game <path>] [--port <n>] [--cua-command <path>] [--model <id>] [--effort <level>] [--service-tier <tier>] [--seconds <n>] [--requests <n>] [--register-driver] [--pet | --no-pet]`
- `ludens up [--dry-run] [--preempt] [--services <emulator,baseware,core>] [--pet | --no-pet]` (`--dry-run` prints the launch plan without spawning processes; `--preempt` preempts a conflicting active Core on the same device)

If you move or import an existing directory later, register it with `ludens workspace open <dir> [--new-id]` or migrate legacy state via `ludens workspace import <dir> [--legacy-state <dir>] [--previous-workspace <dir>]`.

## 4. Auto Run, Event Pool, and Reclaim Control

Ludens separates supervision from direct operation across two explicit control modes:

- **Manual Standby** (`manual`): You hold the active input lease. **Shiori** (Ludens's Agent Thread Core) stays warm and ready in **Warm Standby** without dispatching actuation calls.
- **Auto Run** (`auto`): Shiori holds the active **Control Cycle** (`epoch`), executing turns against the Baseware driver and the resident `perception.py` loop within your time and request budget.

### Operating from Console (`Live`, `?view=live`)

1. Open **Live** (`?view=live`) in the Desktop App or browser Console — 0-run workspaces enter Live directly without requiring a prior `ludens up`.
2. Enter an objective in the composer (for example, watching a desktop workflow or inspecting sensor streams) and click **Start Auto Run**. If the workspace Core is offline, App Daemon spawns **Core + Baseware** on demand first. If another workspace's active Auto Run Core already holds the target physical device, Console prompts (`CONFLICT -32009 DEVICE_BUSY`) to **Cancel**, **Switch to holder**, or **Preempt & Start Here** (Warm Standby `manual` holders yield automatically).
3. Queue non-blocking notes while the agent works using the **Event Pool** composer mode, or switch the composer to **Steer Now** to interrupt mid-turn with immediate guidance.
4. Click **Reclaim Control** at any moment to immediately end Auto Run, invalidate the agent's control lease, and keep the Core resident in **Warm Standby** (`manual` **Manual Standby**) ready for instant resumption or model switching.
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
- `ludens services [--remote <url>]`: Check status of managed background services in the current workspace
- `ludens stop [--remote <url>]`: Stop the workspace Core daemon cleanly
- `ludens down [--services <emulator,baseware,core>] [--keep-emulator] [--pet] [--remote <url>]`: Stop the workspace (`--keep-emulator` preserves a launched target process; `--pet` also stops an optional Desktop Pet process)
- `ludens daemon status | start | stop [--keep-cores|--stop-cores] | restart`: Manage the singleton `ludens app-server` daemon directly

## 5. Workspace Config (`ludens.json`) & Global Defaults

`ludens init` writes `ludens.json` in the workspace root (inspect and edit any field from Console **Config**, `?view=perception`):

| Field | Default | Purpose |
| --- | --- | --- |
| `driver` / `driverPackage` | `cua` / unset | Driver identifier and optional external package or manifest path |
| `game` / `port` / `cuaCommand` | unset | Optional target binary path, controller port, or custom CUA server command |
| `model` | `openai-codex/gpt-6.2-sol` | Primary model identifier (`provider/model`) for Shiori |
| `serviceTier` / `effort` | unset | Optional inference tier (`none`, `priority`, `ultrafast`) and reasoning effort (`none`..`max`) |
| `seconds` / `requests` | `1800` / `1000` | Default per-run Auto Run duration budget (seconds) and request limit |
| `compactionThreshold` | unset | Optional token threshold triggering background context compaction |
| `connection` | inherited | Multimodal transport flags (`openaiWebsockets`, `cacheRetention`, `appendOnlyContext`, `imageUrls`) |
| `machines` | unset | Allowed and active node list (`{ active?, allowed }`) for multi-machine routing |
| `pet` | `false` | Optional Desktop Pet toggle for this workspace |
| `logging` | `{ "diagnostics": "normal" }` | Archive verbosity (`"normal"` or `"full"`) |

Use `ludens config` to set machine-wide defaults stored under `~/.ludens/` (override the home root with `LUDENS_HOME`):

```sh
ludens config show
ludens config set workspaceRoot "$HOME/ludens-workspaces"
ludens config set defaults.model "openai-codex/gpt-6.2-sol"
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
