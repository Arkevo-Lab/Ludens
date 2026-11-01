# Install & workspace lifecycle

This guide covers installing the Ludens components, configuring the Python runtime, and managing the day-to-day workspace lifecycle with `ludens init / up / auto / down`. For emulator and desktop driver setup, see [Devices & driver setup](devices.md); for single-component foreground debugging, package script conventions, and tests, see [Console debugging & verification](debugging-and-verification.md).

Unless a `cd` into the target workspace is shown explicitly, run all commands from the repository root. The global application directory defaults to `~/.ludens`; set `LUDENS_HOME` to an absolute path to override it. Workspaces can live anywhere and keep their configuration, sessions, recordings, and history together. The source repository holds no runtime state; keep ROMs, firmware, keys, and game saves outside it too.

## Install

### 1. Environment prerequisites & credentials

- **OS**: full background-service orchestration (`ludens up` / `ludens down` / `ludens services`) requires **macOS launchd**.
- **Toolchain**: **Bun 1.4**, **Python 3.12+**, **Node.js 22.x (22.13+) or 24+**, and **uv**. The optional pet shares the same JavaScript workspace install (Electron is a `app` devDependency).
- **Model credentials**: complete **OMP model login** on the machine before starting an agent. Ludens pins **OMP 18.14.0** and reuses its credential store directly; the default model is `openai-codex/gpt-6.1-sol`.

### 2. Install core components

Install the JavaScript workspaces once from the repository root using the root `bun.lock`, then build the web Dashboard. Bun automatically applies the OMP dependency patches under [core/patches/](../../../core/patches/) per the root `package.json`. The Ludens Python runtime keeps its separate `uv.lock`; the optional pet shares the `app` workspace install. Do not run `npm ci` in `app`: npm selects the root workspace, which uses Bun rather than an npm lockfile.

```sh
bun install --frozen-lockfile
uv sync --project core/python --frozen
(cd app && npm run build)

export PATH="$PWD/baseware/bin:$PWD/core/bin:$PATH"
```

`export PATH` only affects the current terminal; configure your shell profile in new terminals or use the absolute `baseware/bin/baseware` and `core/bin/ludens` paths.

### 3. Python runtime resolution

[core/python/pyproject.toml](../../../core/python/pyproject.toml) and `uv.lock` manage the official `ludens-tools` package (import name `ludens_tools`) plus media and validation dependencies such as PyAV, Pillow, and jsonschema. `ludens_tools` only provides capability declarations, the client, and experiment-registration helpers; the execution lifecycle and scoring are managed centrally by Shiori.

The framework picks a Python interpreter with this priority:

1. Explicit `LUDENS_PYTHON` environment variable;
2. In-repo virtualenv `core/python/.venv/bin/python`;
3. System `python3` on `PATH`.

The OMP native shell injects `LUDENS_PYTHON` automatically. To reuse `ludens_tools` and the framework dependencies in workspace scripts, call `"$LUDENS_PYTHON" script.py`; running a bare `python3` follows the user's login shell and is not equivalent to the framework virtualenv. If you point `LUDENS_PYTHON` at an external training environment (e.g. a conda/venv with PyTorch), pre-install the `core/python` package and its dependencies there.

`ludens up` preserves the `LUDENS_PYTHON` from the current environment when creating new background services. If services are already running, changing the terminal environment does not update them; stop and restart the relevant services before the new interpreter takes effect. After completing the installation above (and the optional pet below, if needed), prepare the target emulator or desktop driver via [Devices & driver setup](devices.md), then return to [Starting and stopping workspaces](#starting-and-stopping-workspaces).

## Optional pet

The Dashboard is served in a browser by default — no Electron install is needed to run games or view the console. For Ludens Pet, build the Electron desktop shell from the repository root:

```sh
(cd app && npm run desktop:build)
```

When creating a workspace, append `--pet` to the chosen `ludens init --name <name> --driver ...` command to explicitly enable the pet. For an existing workspace, set `"pet": true` in `ludens.json`; it starts on the next `ludens up`. An explicit `pet: true` already in the file stays enabled. Setting `"pet": false` keeps later starts on the web console only.

You can also use `ludens up --pet` or `ludens up --no-pet` to override just the current start without writing back to `ludens.json`; the two flags are mutually exclusive. Neither `pet: false` nor `--no-pet` shuts down an already-running shared pet — quit it from its tray menu.

The pet needs a working Dashboard and shares the same console and logs as the browser. By default `dashboard: true` starts the Dashboard on demand; with `false` you must start it yourself. For standalone startup or debugging, see [Ludens Pet desktop companion](debugging-and-verification.md).

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
| `ludens up --dry-run` | Validates the config and prints the full process start plan without starting services; the Dashboard build check only runs on a real `ludens up` when a new Dashboard is needed. |
| `ludens up [--pet / --no-pet]` | Starts or reuses the emulator, Baseware, Host, and Dashboard on demand; enables the pet per the `pet` setting, or override just this start with the mutually exclusive `--pet` / `--no-pet` without writing back to the config. A newly started Host is in `manual` mode; reusing an already-`auto` Host continues its control cycle. Repeating `up` does not hot-reload an edited `ludens.json`, and reusing an existing Dashboard does not hot-update its build. |
| `ludens services` | Shows the PID, status, and latest exit code of the launchd tasks bound to the current workspace. |
| `ludens auto on [--message 'text']` | Starts a new control cycle (new `epoch`, resetting time and request budgets) and issues inference to the model. `--message` is attached once on the first round of that takeover only, never re-injected in later rounds. |
| `ludens auto off` | Immediately revokes device operation rights and cancels in-flight Ludens-managed calls; the emulator keeps running. Wait for the current cycle to finish cleaning up before `auto on` again. |
| `ludens action status / reload / stop` | Manages the workspace `action.py` resident action process. Under `manual`, `reload` only marks readiness; under `auto`, `stop` or `reload` clears all current device inputs for this workspace (including concurrent CLI inputs). A successful release keeps the current `epoch`, OMP session, and remaining budget. See [Resident perception & action loop](perception-and-action.md#resident-actions). |
| `ludens down --keep-emulator` | Hands back control and stops Host and Baseware, keeping the emulator window and game state; suitable for re-running `ludens up` after editing `ludens.json` (e.g. budgets or model). |
| `ludens down [--dashboard] [--pet]` | Stops this workspace's managed Host, Baseware, and emulator (**save in-game progress first**). The shared Dashboard and a running Ludens Pet are kept by default; append `--dashboard` (only from the workspace that started it) or `--pet` to shut down the corresponding shared service too. |

To operate on a workspace from another directory, prefix any command with `ludens --workspace /absolute/path/to/workspace <subcommand>` or set the `LUDENS_WORKSPACE` environment variable.

### Global settings and the default directory

`$LUDENS_HOME/config.json` has the shape `{ "version": 1, "workspaceRoot": "/absolute/path", "defaults": { ... } }`. `defaults` supports `model`, `seconds`, `requests`, `compactionThreshold`, `dashboard`, and `pet`, and applies only at creation; explicit initialization arguments take precedence. Changing the parent affects future workspaces without moving registered directories:

```sh
ludens config show
ludens config set workspaceRoot "$HOME/Ludens Workspaces"
ludens config set defaults.seconds 1800
ludens config set defaults.pet false
ludens init --name desktop-task --driver cua
ludens workspace list
```

The Dashboard Workspaces page supports creation with an optional directory, registration of existing directories, removal from the index, and editing the default parent directory. The CLI, Dashboard, and pet should use the same `LUDENS_HOME`; restart the relevant processes after changing it.

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

Import only brings in sessions, session selection, and skill version snapshots; it preserves the external originals. Old absolute paths in logs, video references, and Benchmark records are not rewritten, and external media is not copied automatically; these records may not replay or rescore after a move. Preserve the original directory and external dependencies when old replay is needed. Workspaces recorded in the new format support moving the whole directory and registering it again.

### 2. `ludens.json` reference

`ludens.json` is parsed and validated by [core/src/daemon/launcher.ts](../../../core/src/daemon/launcher.ts); unknown fields are hard errors:

| Field | Default | Description |
| --- | --- | --- |
| `driver` | required | Driver ID; only `cua` is built in, emulator IDs must match the `id` exported by the external package. |
| `driverPackage` | none | External driver package address (npm spec, `github:org/repo#rev`, or `file:path`); required for emulator drivers, omittable for `cua`. See [Devices & driver setup](devices.md#discovering-connecting-external-driver-packages) for how to connect. |
| `game` | none | Optional for bridge drivers that support auto-launch (`needsGame: true`, path relative to the workspace); omit to attach to an already manually started emulator. Drivers without auto-launch and stdio drivers reject this field. |
| `port` | per driver | An explicit port wins; otherwise the driver manifest's `defaultPort` applies; stdio drivers do not use it. |
| `cuaCommand` | `"cua-driver"` | Only valid for stdio drivers; specifies the backend executable path or command name. |
| `model` | `"openai-codex/gpt-6.1-sol"` | OMP `provider/model` identifier with image-input support. |
| `seconds` | `1800` | Time budget (seconds) per `auto on` control cycle, reset on each takeover. |
| `requests` | `1000` | Model request cap per `auto on` control cycle; whichever of `seconds`/`requests` runs out first hands back control. |
| `compactionThreshold` | unset | OMP context-compaction trigger threshold (tokens); follows the selected model's native OMP threshold (`contextWindow - reserve`) when omitted. |
| `dashboard` | `true` | Whether `ludens up` ensures the local Dashboard service is running. |
| `pet` | `false` | Whether `ludens up` starts the shared Ludens Pet; requires the optional component installed and an available Dashboard. `ludens init --pet` writes `true`, an existing explicit `true` is left alone; `ludens up --pet` / `--no-pet` override only the current start. |
| `logging.diagnostics` | `"normal"` | Log verbosity, `"normal"` or `"full"`; see [Recording modes](../reference/logging.md#recording-modes). |

### 3. Session resumption & background service directories

- **Session resumption**: workspace OMP sessions live in `.ludens/shiori/sessions/`, with the current resume pointer at `.ludens/shiori/current-session.json`. Restarting Host resumes the original session by default and opens a new `logs/<run-id>/` directory. Foreground `ludens run` accepts `--new-session` to start a fresh context (keeping workspace files), or `--resume /absolute/path/to/session.jsonl` to switch to a given historical session of the same workspace.
- **Background service logs**: [launch-background.py](../../../core/scripts/launch-background.py) writes stdio and launchd state for workspace-managed processes to `<workspace>/logs/background/`. Shared Ludens Pet logs live in `$LUDENS_HOME/pet/background/` (launchd label `dev.ludens.pet`) and preferences in `$LUDENS_HOME/pet/profile/`. Standalone Baseware without `--data-dir` uses `$LUDENS_HOME/logs/baseware/<socket-name>/`; workspace orchestration explicitly uses `<workspace>/logs/baseware/`. Background services detach from the terminal without boot-time autostart or crash-loop restarts; check `ludens services` and the corresponding logs first when troubleshooting.
