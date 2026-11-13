# Install & workspace lifecycle

This guide covers installing the Ludens components, configuring the Python runtime, launching the **Ludens Desktop App** or unified `ludens app-server`, and managing the day-to-day workspace lifecycle from the UI or with `ludens init / up / auto / down`. For emulator and desktop driver setup, see [Devices & driver setup](devices.md); for single-component foreground debugging, package script conventions, and tests, see [Console debugging & verification](debugging-and-verification.md).

Unless a `cd` into the target workspace is shown explicitly, run all commands from the repository root. The global application directory defaults to `~/.ludens`; set `LUDENS_HOME` to an absolute path to override it. Workspaces can live anywhere and keep their configuration, sessions, recordings, and history together. The source repository holds no runtime state; keep ROMs, firmware, keys, and game saves outside it too.

## Install

### 1. Environment prerequisites & credentials

- **OS**: macOS, Linux, or Windows (desktop control via the built-in `cua` driver follows upstream Cua Driver platform permissions).
- **Toolchain**: **Bun 1.4+**, **Python 3.12+**, **Node.js 22.x (22.13+) or 24+**, and **uv**. The optional pet shares the same JavaScript workspace install (Electron is a `app` devDependency).
- **Model credentials**: complete **OMP model login** on the machine before starting an agent. Ludens pins **OMP 18.18.8** and reuses its credential store directly; the default model is `openai-codex/gpt-6.1-sol`.

### 2. Install core components

Install the JavaScript workspaces once from the repository root using the root `bun.lock`, then build the static web console export (`app/out`). Bun automatically applies the OMP dependency patches under [core/patches/](../../../core/patches/) per the root `package.json`. The Ludens Python runtime keeps its separate `uv.lock`; the desktop app and pet share the `app` workspace install. Do not run `npm ci` in `app`: npm selects the root workspace, which uses Bun rather than an npm lockfile.

```sh
bun install --frozen-lockfile
uv sync --project core/python --frozen
(cd app && npm run build)

export PATH="$PWD/baseware/bin:$PWD/core/bin:$PWD/app/bin:$PATH"
```

`export PATH` only affects the current terminal; configure your shell profile in new terminals or use the absolute `baseware/bin/baseware`, `core/bin/ludens`, and `app/bin/ludens-app` paths. In production, `@ludens/core`'s `ludens app-server` (alias `ludens serve`) serves both `/api/*` and `app/out` directly with zero Next.js server runtime.

### 3. Python runtime resolution

[core/python/pyproject.toml](../../../core/python/pyproject.toml) and `uv.lock` manage the official `ludens-tools` package (import name `ludens_tools`) plus media and validation dependencies such as PyAV, Pillow, and jsonschema. `ludens_tools` only provides capability declarations, the client, and experiment-registration helpers; the execution lifecycle and scoring are managed centrally by Shiori.

The framework picks a Python interpreter with this priority:

1. Explicit `LUDENS_PYTHON` environment variable;
2. In-repo virtualenv `core/python/.venv/bin/python`;
3. System `python3` on `PATH`.

The OMP native shell injects `LUDENS_PYTHON` automatically. To reuse `ludens_tools` and the framework dependencies in workspace scripts, call `"$LUDENS_PYTHON" script.py`; running a bare `python3` follows the user's login shell and is not equivalent to the framework virtualenv. If you point `LUDENS_PYTHON` at an external training environment (e.g. a conda/venv with PyTorch), pre-install the `core/python` package and its dependencies there.

`ludens up` and UI service starts preserve the `LUDENS_PYTHON` from the host environment when creating new background services. If services are already running, changing the terminal environment does not update them; stop and restart the relevant services before the new interpreter takes effect. After completing the installation above (and the desktop app / pet build below, if needed), prepare the target emulator or desktop driver via [Devices & driver setup](devices.md), then return to [Starting and stopping workspaces](#starting-and-stopping-workspaces).

## Optional pet

The console runs in any browser via `ludens app-server` — no Electron install is needed for web-only workflows. To use the self-contained **Ludens Desktop App** (main console window + system tray + **Ludens Pet** desktop companion), build the Electron desktop shell from the repository root (and optionally package native macOS `.dmg` or Windows NSIS `.exe` installers via `desktop:dist`):

```sh
(cd app && npm run desktop:build)
app/bin/ludens-app --show-window

# Optional: build a redistributable native installer (.dmg / .exe)
(cd app && npm run desktop:dist)
```

When launched without an explicit `--dashboard <url>`, `ludens-app` acts as a first-class host: it automatically spawns and supervises `ludens app-server --port 0 --parent-watchdog` in the background, so you can create, configure, and **Start / Reload / Stop** workspaces directly from the app UI without opening a terminal or running `ludens up` first. Closing the main window (`×`) hides to the system tray and keeps **Ludens Pet** and running workspaces alive; choosing **Quit** (`⌘Q` or tray **Quit**) cleanly shuts down `ludens app-server` and tears down all supervised game AI child processes (`stdin` EOF `--parent-watchdog` ensures clean teardown even if the parent crashes).

When orchestrating from the headless CLI instead, append `--pet` to `ludens init --name <name> --driver ...` or set `"pet": true` in `ludens.json` so `ludens up` attaches a shared desktop companion to the local `app-server`. You can also pass `ludens up --pet` or `ludens up --no-pet` to override just the current start without writing back to `ludens.json` (the two flags are mutually exclusive; neither `pet: false` nor `--no-pet` shuts down an already-running desktop app — quit it from its tray menu). For standalone flags or pet smoke tests, see [Ludens Pet desktop companion](debugging-and-verification.md#3-ludens-pet-desktop-companion).

## Starting and stopping workspaces

### 1. Init and lifecycle commands

Prepare the target environment per [Devices & driver setup](devices.md) first. The example below initializes a workspace at an explicit path with the built-in desktop driver (`--driver cua`); external emulator or bridge drivers additionally pass `--driver <id> --driver-package '<spec>'` (see [external driver packages](devices.md#discovering-connecting-external-driver-packages)):

```sh
ludens init --name my-task --workspace /absolute/path/to/workspace --driver cua --seconds 1800
cd /absolute/path/to/workspace
ludens up --dry-run
ludens up
ludens services
ludens controller list
ludens auto on
```

Without `--workspace`, `ludens init --name my-task --driver ...` uses the global `workspaceRoot/my-task`; the initial parent is `$LUDENS_HOME/workspaces`. Explicit relative paths resolve from the current shell directory. To initialize the current directory, use `ludens init --workspace . --driver ...` or `ludens --workspace . init --driver ...`. Use `open` or `import` below for existing workspaces instead of initializing them again. When using a name without an explicit path, unset `LUDENS_WORKSPACE` if your shell inherited it from another workspace.

For an existing external-driver workspace, add `driverPackage` per the [external driver migration notes](devices.md#discovering-connecting-external-driver-packages).

Quick reference for common workspace and control commands:

| Command | Behavior & boundaries |
| --- | --- |
| `ludens init --name <name> [--workspace <path>] --driver <id>` | Creates configuration, a stable identity, missing templates, and a registry entry; a name is required without an explicit path. Global creation defaults are copied to `ludens.json`; changing them later does not change existing workspaces. Add `--pet` to enable the installed pet. |
| `ludens config [show]` · `ludens config set <workspaceRoot\|defaults.field> <value>` | Reads global configuration or sets the parent directory and defaults for future workspaces. |
| `ludens workspace open <path>` · `ludens workspace list` | Registers an existing workspace or lists registrations in the current global home. |
| `ludens workspace forget <id>` | Removes only the index entry; it does not delete files, sessions, or logs, or stop services. |
| `ludens app-server [--port <n>] [--host <addr>] [--static-dir <dir>] [--parent-watchdog]` | Starts the unified `@ludens/core` HTTP server (`ludens serve` alias, default `127.0.0.1:3015`) serving `/api/*`, `WorkspaceSupervisor`, and the static console bundle (`app/out`); pass `--port 0` for an ephemeral port and `--parent-watchdog` to exit and clean up supervised child processes when `stdin` closes. |
| `ludens up --dry-run` | Validates the config and prints the full process start plan without starting services; the static console build check only runs on a real `ludens up` when a new `app-server` is needed. |
| `ludens up [--pet / --no-pet]` | Starts or reuses the emulator, Baseware, Host, and `ludens app-server` on demand via the pure-TS `WorkspaceSupervisor`; enables the pet per the `pet` setting, or override just this start with the mutually exclusive `--pet` / `--no-pet` without writing back to the config. A newly started Host is in `manual` mode; reusing an already-`auto` Host continues its control cycle. Repeating `up` does not hot-reload an edited `ludens.json`, and reusing an existing `app-server` does not hot-update its static bundle. |
| `ludens services` | Shows the PID, status, and latest exit code of the managed background jobs bound to the current workspace. |
| `ludens auto on [--message 'text'] [--seconds <n>]` | Starts a new control cycle (new `epoch`, resetting request budgets) and issues inference to the model. When `--seconds <n>` is omitted, the cycle runs continuously without a time limit until manually stopped (`auto off`); passing `--seconds <n>` bounds the takeover to `<n>` seconds. `--message` is attached once on the first round of that takeover only, never re-injected in later rounds. |
| `ludens auto timer <seconds\|off>` | Sets, extends, or clears (`off`) the auto-stop countdown on the active control cycle in place, without minting a new `epoch` or releasing device controllers. |
| `ludens auto off` | Immediately revokes device operation rights and cancels in-flight Ludens-managed calls; the emulator keeps running. Wait for the current cycle to finish cleaning up before `auto on` again. |
| `ludens model [<provider/id> [--service-tier none\|priority\|ultrafast] [--effort none\|minimal\|low\|medium\|high\|xhigh\|max]]` | Without arguments, prints the workspace Host's active OMP `provider/id` model (or `none` in `--device-only` mode); `ludens status` reports the actual effective serving tier and reasoning effort; with `<provider/id>`, validates an authenticated image-capable OMP model and updates the live session in place **only while paused in `manual` mode** (rejected while `auto` or `consolidate` is active, or inside agent cycles carrying `BASEWARE_EPOCH`). Append `--service-tier none\|priority\|ultrafast` to select Standard (clears `serviceTier`), Fast (`priority`), or Ultra (`ultrafast`), and `--effort none\|minimal\|low\|medium\|high\|xhigh\|max` to override or reset (`none`) reasoning effort; unsupported tiers or efforts downgrade cleanly to Standard / the model's native default. Fast/Ultra are premium tiers and may increase usage charges. Update `ludens.json` (or switch via the Console `ModelPickerDialog`) to persist the choice across Host restarts. |
| `ludens down --keep-emulator` | Hands back control and stops Host and Baseware, keeping the emulator window and game state; suitable for re-running `ludens up` after editing `ludens.json` (e.g. budgets or transport settings). |
| `ludens down [--dashboard] [--pet]` | Stops this workspace's managed Host, Baseware, and emulator (**save in-game progress first**). The shared Dashboard and a running Ludens Pet are kept by default; append `--dashboard` (only from the workspace that started it) or `--pet` to shut down the corresponding shared service too. |

To operate on a workspace from another directory, prefix any command with `ludens --workspace /absolute/path/to/workspace <subcommand>` or set the `LUDENS_WORKSPACE` environment variable.

### Global settings and the default directory

`$LUDENS_HOME/config.json` has the shape `{ "version": 1, "workspaceRoot": "/absolute/path", "defaults": { ... } }`. `defaults` supports `model`, `serviceTier` (`priority` \| `ultrafast`, unset means Standard), `effort` (`minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max`, unset uses the model's native default), `seconds`, `requests`, `compactionThreshold`, `dashboard`, `pet`, and `connection` (`openaiWebsockets`, `cacheRetention`, `appendOnlyContext`, `imageUrls.enabled`, `imageUrls.backends`). Creation fields apply at workspace initialization, while `defaults.connection` also serves as the fallback model transport policy for workspaces that do not override a given `connection` field in `ludens.json`. Changing the parent affects future workspaces without moving registered directories:

```sh
ludens config show
ludens config set workspaceRoot "$HOME/Ludens Workspaces"
ludens config set defaults.seconds 1800
ludens config set defaults.pet false
ludens config set defaults.connection.openaiWebsockets auto
ludens config set defaults.connection.cacheRetention long
ludens config set defaults.connection.appendOnlyContext on
ludens config set defaults.connection.imageUrls.enabled true
ludens config set defaults.connection.imageUrls.backends uguu,tmpfiles
ludens init --name desktop-task --driver cua
ludens workspace list
```

The Dashboard Workspaces page supports creation with an optional directory, registration of existing directories, removal from the index, and editing the default parent directory; the Settings page configures both global and workspace-level model connection & multimodal transport options. The CLI, Dashboard, and pet should use the same `LUDENS_HOME`; restart the relevant processes after changing it.

### Registering and migrating existing workspaces

- **Register again**: run `ludens workspace open <path>` for a workspace with `.ludens/workspace.json`. The global registry holds only `{id, workspace, name, updatedAt}`; rebuild lost entries with `open` without affecting workspace history.
- **Move a directory**: stop its managed services, move the whole directory, then run `ludens workspace open /new/path` to update the index. The persistent ID stays the same; the original and a copy must not use the same ID simultaneously.
- **Copy as an independent experiment**: stop Host and Baseware for the copy, then run `ludens workspace open /path/to/copy --new-id` to assign a new ID and clear the current session selection while preserving past sessions and recordings. `historyIds` in the identity file retains readable past identities; historical records never connect to the original workspace's active Host. The original workspace stays unchanged.
- **Import the old layout**: explicitly run `import` below. `--legacy-state` points to the former `artifacts/rsa/ws-...` state directory; if the workspace moved, provide its former absolute path with `--previous-workspace`. Import brings old external state into the new layout; normal operation does not implicitly read old caches or registry directories.

```sh
ludens workspace import /absolute/path/to/workspace \
  --legacy-state /absolute/path/to/old-artifacts/rsa/ws-name-hash \
  --previous-workspace /previous/absolute/workspace
```

Stop related services and back up the workspace and old state before importing. Omit `--legacy-state` when there is no old external state and `--previous-workspace` when the directory has not moved. Updating source code alone neither migrates nor starts existing workspaces.

Import only brings in sessions, session selection, and skill version snapshots; it preserves the external originals. Old absolute paths in logs and video references are not rewritten, and external media are not copied automatically; these records may not replay after a move. Preserve the original directory and external dependencies when old replay is needed. Workspaces recorded in the new format support moving the whole directory and registering it again.

### 2. `ludens.json` reference

`ludens.json` is parsed and validated by [core/src/daemon/launcher.ts](../../../core/src/daemon/launcher.ts); unknown fields are hard errors:

| Field | Default | Description |
| --- | --- | --- |
| `driver` | required | Driver ID; only `cua` is built in, emulator IDs must match the `id` exported by the external package. |
| `driverPackage` | none | External driver package address (npm spec, `github:org/repo#rev`, or `file:path`); required for emulator drivers, omittable for `cua`. See [Devices & driver setup](devices.md#discovering-connecting-external-driver-packages) for how to connect. |
| `game` | none | Optional for bridge drivers that support auto-launch (`needsGame: true`, path relative to the workspace); omit to attach to an already manually started emulator. Drivers without auto-launch and stdio drivers reject this field. |
| `port` | per driver | An explicit port wins; otherwise the driver manifest's `defaultPort` applies; stdio drivers do not use it. |
| `cuaCommand` | `"cua-driver"` | Only valid for stdio drivers; specifies the backend executable path or command name. |
| `model` | `"openai-codex/gpt-6.1-sol"` | OMP `provider/model` identifier with image-input support; can also be browsed and switched while paused via the Console `ModelPickerDialog` or `ludens model [<provider/id>]`. |
| `serviceTier` | unset (Standard) | Optional OMP serving tier (`priority` for Fast, `ultrafast` for Ultra) applied with the selected `model`; offered only when the model catalog lists it in `supportedServiceTiers`, otherwise the runtime downgrades to Standard and reports the actual effective tier. Fast/Ultra are premium tiers and may increase usage charges. Also switchable while paused via the Console `ModelPickerDialog` or `ludens model [<provider/id>] [--service-tier ...]`. |
| `effort` | unset (model default) | Optional OMP reasoning effort (`minimal`, `low`, `medium`, `high`, `xhigh`, `max`) applied with the selected `model`; offered only for efforts listed in the model catalog's `supportedEfforts`, otherwise the runtime falls back to the model's native `defaultEffort`. Also switchable while paused via the Console `ModelPickerDialog` or `ludens model [<provider/id>] [--effort ...]`. |
| `seconds` | `1800` | Time budget (seconds) per `auto on` control cycle, reset on each takeover. |
| `requests` | `1000` | Model request cap per `auto on` control cycle; whichever of `seconds`/`requests` runs out first hands back control. |
| `compactionThreshold` | unset | OMP context-compaction trigger threshold (tokens); follows the selected model's native OMP threshold (`contextWindow - reserve`) when omitted. |
| `connection` | inherits `defaults.connection` | Optional model transport & multimodal caching overrides (`openaiWebsockets`: `"auto" \| "on" \| "off"`, `cacheRetention`: `"auto" \| "short" \| "long" \| "none"`, `appendOnlyContext`: `"auto" \| "on" \| "off"`, `imageUrls`: `{ enabled?: boolean, backends?: string[] }`); see [WS Recovery Test Rationale](../insights/ws-recovery.md#three-multimodal-transport-tiers-stateful-ws-vs-stateless-http-kv-cache-vs-image-url-offloading). |
| `dashboard` | `true` | Whether `ludens up` ensures the local Dashboard service is running. |
| `pet` | `false` | Whether `ludens up` starts the shared Ludens Pet; requires the optional component installed and an available Dashboard. `ludens init --pet` writes `true`, an existing explicit `true` is left alone; `ludens up --pet` / `--no-pet` override only the current start. |
| `logging.diagnostics` | `"normal"` | Log verbosity, `"normal"` or `"full"`; see [Recording modes](../reference/logging.md#recording-modes). |

### 3. Session resumption & background service directories

- **Session resumption**: workspace OMP sessions live in `.ludens/shiori/sessions/`, with the current resume pointer at `.ludens/shiori/current-session.json`. Restarting Host resumes the original session by default and opens a new `logs/<run-id>/` directory. Foreground `ludens run` accepts `--new-session` to start a fresh context (keeping workspace files), or `--resume /absolute/path/to/session.jsonl` to switch to a given historical session of the same workspace.
- **Background service logs**: the pure-TypeScript supervisor in [core/src/daemon/](../../../core/src/daemon/) writes stdio logs (`<name>.log`) and cross-platform job state (`<name>.job.json`, no Python launcher script required) for workspace-managed processes to `<workspace>/logs/background/`. Shared Ludens Pet logs live in `$LUDENS_HOME/pet/background/` (job label `dev.ludens.pet`) and preferences in `$LUDENS_HOME/pet/profile/`. Standalone Baseware without `--data-dir` uses `$LUDENS_HOME/logs/baseware/<socket-name>/`; workspace orchestration explicitly uses `<workspace>/logs/baseware/`. CLI-detached background services survive terminal close without boot-time autostart or crash-loop restarts, whereas services supervised by an owning `ludens-app` (`--parent-watchdog`) are torn down cleanly when the desktop app quits; check `ludens services` (or **Config & Studio → Services & Session**) and the corresponding logs first when troubleshooting.
