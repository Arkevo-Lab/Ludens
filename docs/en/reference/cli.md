# CLI Reference (`ludens` / `ludens-server` / `ludens-core` / `baseware` / `ludens-app`)

This reference documents every user-facing and sandbox-internal subcommand, flag, default value, and environment variable exposed across the **4 orthogonal CLIs + desktop launcher** in the six-package Ludens architecture:

- **`ludens`** (`@ludens/client`, [`client/bin/ludens`](../../../client/bin/ludens)): **human-facing pure-RPC operator client CLI** (strictly depending only on `@ludens/protocol`, with zero `@ludens/core` / `@ludens/server` code dependencies) — manages global config (`ludens config`), full workspace lifecycle and remote evaluation (`ludens workspace <init|list|open|forget|import|up|down|services|eval>`), and top-level live remote control and log inspection (`ludens <status|auto|steer|consolidate|stop|model|logs>`). Uniformly supports local Unix Domain Socket (auto-waking `ludens-server start` from `PATH` on demand when offline) and `--remote ws(s)://... [--token ...]`.
- **`ludens-server`** (`@ludens/server`, [`server/bin/ludens-server`](../../../server/bin/ludens-server)): **control-plane server & daemon supervisor CLI** — provides `ludens-server <serve|start|stop|restart|status>`, hosting multi-workspace JSON-RPC 2.0 (`/rpc` and `app-server.sock`), real-time `EventHub` push, HMAC `/media`, the query engine, and `WorkspaceSupervisor`.
- **`ludens-core`** (`@ludens/core`, [`core/bin/ludens-core`](../../../core/bin/ludens-core)): **per-workspace execution kernel & sandbox-internal tool CLI** — provides the single-workspace sandbox entry point `ludens-core run` and sandbox-internal Shiori / developer tools `ludens-core <controller|perception|event|machine|eval>` (the legacy duplicate top-level `observe` alias is removed, unified under `ludens-core perception observe`).
- **`baseware`** (`@ludens/baseware`, [`baseware/bin/baseware`](../../../baseware/bin/baseware)): **standalone Cross-Device Integration Layer CLI** — daemon server, driver/package discovery, multi-machine routing, direct controller invocation, and MCP bridge mode.
- **`ludens-app`** (`@ludens/desktop`, [`desktop/bin/ludens-app`](../../../desktop/bin/ludens-app), Windows [`desktop/bin/ludens-app.cmd`](../../../desktop/bin/ludens-app.cmd)): **All-in-One zero-port Electron desktop shell** (`ludens-app://console/` + `ludens-media://local/media?...`), bundling `client/out` + local `ludens-server` + `ludens-core` + `baseware` with one-click switching to any remote `ludens-server`.

> **Global flags, remote connections & on-demand auto-wake**: All `ludens` subcommands accept `--workspace <path>` (overriding `LUDENS_WORKSPACE` and the current working directory), plus `--remote <ws(s)://...>` and `--token <secret>` (overriding `LUDENS_REMOTE_URL` and `LUDENS_REMOTE_TOKEN`).
> - When `--remote` is passed: `ludens` connects directly to the remote `ludens-server` over WebSocket JSON-RPC;
> - When `--remote` is omitted: `ludens` connects to local `$LUDENS_HOME/run/app-server.sock` (falling back to `/tmp/ludens-app-<uid>-<sha256_12>.sock` near the 96-byte path limit); if the local socket is not ready, it automatically runs `ludens-server start` from `PATH` (or repo-relative `../server/bin/ludens-server`) on demand and reconnects; if `ludens-server` is not installed locally, it prints a clear actionable message prompting you to install/start `ludens-server` or pass `--remote <url>`.

---

## 1. `ludens` — Pure-RPC Operator Client CLI (`@ludens/client`)

Implemented in [`client/cli/`](../../../client/cli/) and [`protocol/src/app-rpc.ts`](../../../protocol/src/app-rpc.ts). Global state lives on the server under `$LUDENS_HOME` (default `~/.ludens`).

### `ludens config`

Inspect or update global defaults shared across newly initialized and launched workspaces over RPC (supports `--remote` and `--token`).

```bash
ludens config [show] [--remote <url>] [--token <secret>]
ludens config set workspaceRoot <directory> [--remote <url>] [--token <secret>]
ludens config set defaults.<field> <value> [--remote <url>] [--token <secret>]
```

Allowed `defaults.<field>` keys:

| Key | Accepted values / notes |
| --- | --- |
| `defaults.model` | Default `<provider/model>` identifier |
| `defaults.serviceTier` | `priority`, `ultrafast`, or `none` (clears setting) |
| `defaults.effort` | `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `none` (clears setting) |
| `defaults.seconds` | Positive integer Auto Run cycle duration (seconds) |
| `defaults.requests` | Positive integer request budget per cycle |
| `defaults.compactionThreshold` | Positive integer token threshold for Shiori compaction |
| `defaults.pet` | `true` \| `false` — whether newly created workspaces enable the optional Desktop Pet by default |
| `defaults.connection.openaiWebsockets` | OpenAI WebSocket transport toggle (`auto` \| `on` \| `off`) |
| `defaults.connection.cacheRetention` | Prompt cache retention policy (`auto` \| `short` \| `long` \| `none`) |
| `defaults.connection.appendOnlyContext` | Append-only context policy (`auto` \| `on` \| `off`) |
| `defaults.connection.imageUrls.enabled` | Boolean toggle for multimodal image URL delivery |
| `defaults.connection.imageUrls.backends` | Backend list for image URL delivery |

### `ludens workspace <init|list|open|forget|import>`

Create workspaces, manage global registry entries, and import/migrate legacy workspaces (100% over JSON-RPC, uniformly supporting `--workspace`, `--remote`, and `--token`):

```bash
# Initialize a workspace directory and write ludens.json (via workspaces/mutate action: "create" RPC)
ludens workspace init --driver <id> \
  [--name <name>] \
  [--workspace <path>] \
  [--machine <id>] \
  [--driver-package <spec>] \
  [--game <path>] \
  [--port <n>] \
  [--cua-command <path>] \
  [--model <id>] \
  [--effort <level>] \
  [--service-tier <tier>] \
  [--seconds <n>] \
  [--requests <n>] \
  [--register-driver] \
  [--pet | --no-pet] \
  [--remote <url>] [--token <secret>]

# List, open/register, forget, and import workspaces (import uses the workspaces/import RPC)
ludens workspace list [--remote <url>] [--token <secret>]
ludens workspace open <directory> [--new-id] [--remote <url>] [--token <secret>]
ludens workspace forget <id> [--remote <url>] [--token <secret>]
ludens workspace import <directory> [--legacy-state <directory>] [--previous-workspace <directory>] \
  [--remote <url>] [--token <secret>]
```

Launcher defaults written/resolved when omitted in `ludens.json`: `model` = `openai-codex/gpt-6.2-sol`, `seconds` = `1800`, `requests` = `1000`, `dashboard` = `true`, `pet` = `false`, `logging.diagnostics` = `"normal"`.

### `ludens workspace <up|services|down>`

Manage supervised workspace processes (**Baseware**, per-workspace **Core** `ludens-core run` hosting **Shiori**, and optional target/simulator launch command) locally via `app-server.sock` or remotely via `--remote`, following **1 Workspace = 1 Core** isolation:

```bash
ludens workspace up [--workspace <path>] [--preempt] \
  [--services <emulator,baseware,core>] [--remote <url>] [--token <secret>]
ludens workspace services [--workspace <path>] [--remote <url>] [--token <secret>]
ludens workspace down [--workspace <path>] [--services <emulator,baseware,core>] \
  [--keep-emulator] [--remote <url>] [--token <secret>]
```

- `--preempt` preempts a conflicting workspace Core holding the same physical device.
- `--services` scopes `up` / `down` to specific managed components (`emulator`, `baseware`, `core`).
- `--keep-emulator` keeps target simulator/runtime processes alive while stopping Ludens daemons.

### `ludens workspace eval`

List, run, inspect evaluation history, and mark live failure counterexamples remotely or locally via the `capabilities/get`, `capabilities/eval`, `capabilities/evalHistory`, and `capabilities/evalAdapt` RPCs (see [Self-Verification](../concepts/self-verification.md)):

```bash
ludens workspace eval list [--workspace <path>] [--remote <url>] [--token <secret>]
ludens workspace eval run [<capability-id>] [--all] [--workspace <path>] [--remote <url>] [--token <secret>]
ludens workspace eval <python/capability-id> [--workspace <path>] [--remote <url>] [--token <secret>]
ludens workspace eval history [<capability-id>] [--limit <n>] [--workspace <path>] [--remote <url>] [--token <secret>]
ludens workspace eval adapt <capability-id> --reason <text> [--record <record-id> ...] \
  [--workspace <path>] [--remote <url>] [--token <secret>]
```

### Top-Level Live Controls & Logs: `ludens <status|auto|steer|consolidate|stop|model|logs>`

High-frequency live runtime control and log inspection commands remain top-level `ludens` subcommands, routed 100% over JSON-RPC to `ludens-server`:

```bash
ludens status [--workspace <path>] [--remote <url>] [--token <secret>]
ludens auto on [--message <text>] [--seconds <n>] [--preempt] [--workspace <path>] [--remote <url>] [--token <secret>]
ludens auto timer <seconds|off> [--workspace <path>] [--remote <url>] [--token <secret>]
ludens auto off [--workspace <path>] [--remote <url>] [--token <secret>]
ludens steer [--message <text> | <text>] [--workspace <path>] [--remote <url>] [--token <secret>]
ludens consolidate [--seconds <n>] [--workspace <path>] [--remote <url>] [--token <secret>]
ludens stop [--workspace <path>] [--remote <url>] [--token <secret>]
ludens model [<provider/id>] [--service-tier none|priority|ultrafast] \
  [--effort none|minimal|low|medium|high|xhigh|max] [--workspace <path>] [--remote <url>] [--token <secret>]

# Pure-RPC archived log inspection (via logs/events and logs/read RPCs without direct local filesystem reads)
ludens logs events --run <run-directory-or-id> [--diagnostics] [--cursor <n>] [--limit <n>] [--workspace <path>] [--remote <url>] [--token <secret>]
ludens logs read --run <run-directory-or-id> \
  (--ref '<JSON reference>' | --file <reference.json> | --event <seq> --field <name>) \
  [--full] [--workspace <path>] [--remote <url>] [--token <secret>]
```

- `ludens auto on` starts an **Auto Run** control cycle (`--seconds` sets the timed control cycle duration; `--preempt` preempts a conflicting Core on the same device).
- `ludens auto timer` updates the remaining cycle timer (`off` removes the time cap).
- `ludens auto off` executes **Reclaim Control**, returning Shiori to **Manual Standby** (`manual`) and revoking device control at Baseware.
- `ludens steer` interrupts a `loop.py` wait or queues a high-priority steering instruction into the active turn.
- `ludens consolidate` runs memory consolidation (`--seconds` defaults to `600`).
- `ludens stop` stops the active Auto Run control cycle on the running workspace via the `run/stop` RPC and reclaims device control (use `ludens workspace down` to shut down the managed workspace Core / Baseware daemon processes).
- `ludens model` switches the active model, service tier, or thinking effort while in Manual Standby.
- `ludens logs` inspects archived run event timelines and reads full offloaded payloads over `logs/events` and `logs/read` RPCs (see [Logging and Call Chains](logging.md)).

---

## 2. `ludens-server` — Control-Plane Server CLI (`@ludens/server`)

Implemented in [`server/src/`](../../../server/src/). Manages the per-`LUDENS_HOME` multi-workspace control-plane server.

### `ludens-server serve`

Run the control-plane server in the foreground, serving JSON-RPC 2.0 (`@ludens/protocol/app-rpc`) over UDS NDJSON and WebSocket `/rpc`, real-time `EventHub` subscriptions, HMAC capability-ticket `/media` (`mt=`, `206 Range`), `/health`, and optional static Vite SPA assets (`client/out`, returning `404` for `/api/*`).

```bash
ludens-server serve [--listen <unix://PATH | ws://HOST:PORT>]... \
  [--auth <none|token>] [--token <secret> | --token-env <var>] \
  [--static-dir <path>] [--trusted-origin <origin>] [--parent-watchdog] [--dev] [-h | --help]
```

- With no `--listen` argument, `ludens-server serve` binds **UDS-only (`<home>/run/app-server.sock`, falling back to `/tmp/ludens-app-<uid>-<sha256_12>.sock` near the 96-byte limit, 0 listening TCP ports)** with `--auth none` (`desktop` profile).
- Non-`--dev` `ws://HOST:PORT` bindings run under the `remote` profile (enforcing `managed-sandbox` boundaries) and refuse to start without `--auth token` (`--token` or `--token-env`).
- `--dev` is restricted to loopback hosts (`127.0.0.1`, `localhost`, `::1`) and runs under the `web-dev` profile.
- `--trusted-origin <origin>` may be repeated to allowlist cross-origin `@ludens/client` browser `Origin` headers. `--parent-watchdog` binds server lifetime to parent stdin/exit, and startup emits a single-line JSON readiness handshake on stdout.

### `ludens-server <start|stop|restart|status>`

Inspect, start, stop, or restart the per-`LUDENS_HOME` singleton background `ludens-server` daemon:

```bash
ludens-server status
ludens-server start [--listen <unix://PATH|ws://HOST:PORT>]... [--auth <none|token>] \
  [--token <secret> | --token-env <var>] [--static-dir <path>] [--trusted-origin <origin>] [--dev]
ludens-server stop [--keep-cores | --stop-cores]
ludens-server restart [--listen <unix://PATH|ws://HOST:PORT>]... [--auth <none|token>] \
  [--token <secret> | --token-env <var>] [--static-dir <path>] [--trusted-origin <origin>] [--dev]
```

- `ludens-server stop` cleanly shuts down managed workspace Cores before stopping the server unless `--keep-cores` is passed (`--stop-cores` is the default).

---

## 3. `ludens-core` — Per-Workspace Execution Kernel & Sandbox Tool CLI (`@ludens/core`)

Implemented in [`core/src/`](../../../core/src/). `@ludens/core` automatically prepends `core/bin` to the `PATH` of Shiori's `bash` tool so both the in-sandbox Agent and local developers invoke `ludens-core` subcommands directly (over the workspace `core.sock` or offline).

### `ludens-core run`

Start the single-workspace **Core** execution sandbox (hosting the **Shiori** Agent Thread Core and resident `perception.py` / `loop.py`, spawned by `ludens-server`'s `WorkspaceSupervisor` or run directly in the foreground for isolated debugging):

```bash
ludens-core [--workspace <path>] run \
  [--baseware-socket <path>] \
  [--workspace <path>] \
  [--device-only] \
  [--model <provider/model>] \
  [--resume <session.jsonl> | --new-session] \
  [--seconds <n>] \
  [--requests <n>] \
  [--compaction-threshold <tokens>] \
  [--diagnostics normal|full] \
  [--launched-by app|cli]
```

Direct-invocation defaults: `--seconds 300`, `--requests 50`, `--diagnostics normal`, and `--launched-by` (with `LUDENS_LAUNCHED_BY` env fallback) defaults to `cli` (`app` is passed by `ludens-server` for on-demand spawns); `--model` falls back to `ludens.json` or `openai-codex/gpt-6.2-sol`.

### `ludens-core controller` & `ludens-core machine`

Inspect and directly execute native driver controllers (`controller/<name>`) or Python-wrapped workspace controllers (`python/<path.py>:<function>`), and manage Baseware machines:

```bash
ludens-core controller list
ludens-core controller <id> --help
ludens-core controller controller/<native name> [--machine <machineId>] [--args '<JSON object>' | --file <arguments.json>]
ludens-core controller python/<path.py>:<function> [--args '<JSON object>' | --file <arguments.json>]

ludens-core machine list
ludens-core machine use <id>
ludens-core machine connect <id> [<id2> ...]
ludens-core machine disconnect <id>
```

### `ludens-core perception` (including `perception observe`)

Manage multimodal perception pipelines and query recorded observation windows (note: the legacy duplicate top-level `observe` alias has been removed; always use `ludens-core perception observe`):

```bash
ludens-core perception status
ludens-core perception state
ludens-core perception reload
ludens-core perception stop
ludens-core perception transition <target> [--args '<JSON object>' | --file <arguments.json>]
ludens-core perception inject [on|off]
ludens-core perception observe [--capability <id|*>] \
  [--id <record-id> | --at <ISO> | --start <ISO> --end <ISO>] \
  [--limit <n>] [--after <sequence>] [--images]
```

`perception observe` defaults to `--limit 8` (maximum `64`); pass `--images` to include inline frame outputs.

### `ludens-core event` (Event Pool)

Inspect and mutate the asynchronous workspace Event Pool inside the sandbox or workspace directory (routes through `core.sock` while Core is online and otherwise writes `.ludens/event-pool.json` directly under lock; inside an agent cycle with `BASEWARE_EPOCH` present, human-only mutation subcommands are rejected and direct Shiori to the `event_pool` tool):

```bash
ludens-core event list [--direction <inbound|outbound>] [--status <pending|handled>] [--limit <n>]
ludens-core event send [--title <text>] [--message <text> | <text>]
ludens-core event reply <event-id> [--message <text> | <text>]
ludens-core event ack <event-id> [<event-id2> ...]
```

### `ludens-core eval`

Run, inspect history, and adapt capability self-verification harnesses offline inside the sandbox or workspace directory (automatically stripping `LUDENS_SOCKET`, `BASEWARE_SOCKET`, `LUDENS_EPOCH`, and `BASEWARE_EPOCH`):

```bash
ludens-core eval list
ludens-core eval run [<capability-id>] [--all]
ludens-core eval <python/capability-id>          # Shorthand when capability ID starts with python/
ludens-core eval history [<capability-id>] [--limit <n>]
ludens-core eval adapt <capability-id> --reason <text> [--record <record-id> ...]
```

---

## 4. `baseware` CLI (`@ludens/baseware`) & `ludens-app` Desktop (`@ludens/desktop`)

### `baseware` CLI

Implemented in [`baseware/src/cli.ts`](../../../baseware/src/cli.ts) and [`baseware/src/main.ts`](../../../baseware/src/main.ts). Default standalone daemon socket is `/tmp/ludens-baseware-${uid}-${id}.sock`.

```bash
# Start Baseware directly with a driver, transport, and socket binding
baseware serve --driver <id> \
  [--driver-package <npm|github:org/repo#rev|https://github.com/org/repo#rev|file:path>] \
  [--port <n>] [--host <host>] \
  [--transport stdio|bridge|ssh|http|sse] \
  [--ssh-host <host>] [--ssh-user <user>] [--ssh-port <n>] [--ssh-identity <path>] [--ssh-command <cmd>] \
  [--url <url>] [--cua-command <path>] \
  [--socket <path>] [--data-dir <path>] [--machine-id <id>] \
  [--diagnostics normal|full]

# Baseware Client, Driver, Machine & MCP Commands
baseware status
baseware list
baseware export [--output <path>]          # Default output path: baseware.json

baseware driver list
baseware driver discover --package <spec>

baseware controller list
baseware controller <id> --help
baseware controller <name> [--machine <id>] [--args '<JSON object>' | --file <arguments.json>]
baseware help <id>

baseware reconnect [--machine <id>]
baseware machine list
baseware machine use <id>
baseware machine connect <id> [<id2> ...]
baseware machine disconnect <id>

baseware revoke                            # Revoke active Auto Run lease / Epoch
baseware mcp                               # Expose Baseware controllers over stdio MCP
```

### `ludens-app` Desktop CLI

Implemented in [`desktop/src/main.ts`](../../../desktop/src/main.ts). Launches the zero-port Electron desktop app loading the bundled `@ludens/client` Vite SPA (`ludens-app://console/` from `client/out`) and local media (`ludens-media://local/media?...`) over UDS `app-server.sock` via `AppServerHost` (`ensureLocalAppDaemon`), with `ActiveCoreQuitGuard` and the optional Desktop Pet (`PetSessionCoordinator`).

```bash
ludens-app [--workspace <path>] [--server <url> | --dashboard <url>] \
  [--profile <path>] [--background] [--show-window] [--help]
```

| Flag | Purpose |
| --- | --- |
| `--workspace <path>` | Focus or attach to a workspace directory |
| `--server <url>` / `--dashboard <url>` | Override `ludens-app://console/` to load an external dev/Vite renderer URL (also via `LUDENS_APP_DEV_URL` / `LUDENS_DEV_URL`) |
| `--profile <path>` | Override the Electron user-data profile directory |
| `--background` | Start minimized / tray-resident without forcing the main window open |
| `--show-window` | Show and focus the Console window immediately on launch |
| `--help` | Print desktop launcher usage |

---

## Environment Variables

Verified across [`protocol/`](../../../protocol/src/), [`baseware/`](../../../baseware/src/), [`core/`](../../../core/src/), [`server/`](../../../server/src/), [`client/`](../../../client/), and [`desktop/`](../../../desktop/src/):

| Variable | Default | Purpose |
| --- | --- | --- |
| `LUDENS_HOME` | `~/.ludens` | Root directory for global config, driver cache, and state (`client` `npm run dev` defaults to isolated `~/.ludens-dev`) |
| `LUDENS_WORKSPACE` | Current working directory | Default workspace path when `--workspace` is omitted |
| `LUDENS_SOCKET` | `/tmp/ludens-core-${uid}-${workspaceHash}.sock` | Override Core daemon Unix domain socket path |
| `BASEWARE_SOCKET` | `/tmp/ludens-baseware-${uid}-${id}.sock` | Override Baseware Unix domain socket path |
| `BASEWARE_EPOCH` | — | Control lease epoch carried by `ludens-core run` / Baseware clients |
| `BASEWARE_TRACE` | — | Optional trace identifier propagated to Baseware calls |
| `LUDENS_MACHINE_ID` | — | Default machine identifier filter for Baseware routing |
| `LUDENS_PYTHON` | — | Python interpreter path used by workspace capabilities and evals |
| `LUDENS_RUN_ID` | — | Override active run identifier for logging |
| `LUDENS_LOG_DIAGNOSTICS` | `"normal"` | Log detail level (`normal` or `full`) |
| `LUDENS_BASEWARE_STREAM_PREFETCH` | — | Prefetch tuning for Baseware perception streams |
| `LUDENS_BRIDGE_PORT` | — | Port override for the driver bridge protocol |
| `LUDENS_PERCEPTION_SAMPLE_HZ` | `30` | Default perception ring sampling rate (Hz) |
| `LUDENS_PERCEPTION_PERSIST` | `1` | Enable/disable disk persistence for perception rings |
| `LUDENS_PERCEPTION_HOT_SECONDS` | `600` | In-memory hot perception buffer window (`10..3600` s) |
| `LUDENS_PERCEPTION_HOT_BYTES` | `1 GiB` | Memory cap for hot perception buffer |
| `LUDENS_PERCEPTION_SEGMENT_SECONDS` | `3600` | Duration per rotated perception disk segment |
| `LUDENS_PERCEPTION_SEGMENT_BYTES` | `256 MiB` | Size cap per rotated perception disk segment |
| `LUDENS_VIDEO_SEGMENT_SECONDS` | `300` | Video ring segment duration (`10..3600` s) |
| `LUDENS_VIDEO_IDLE_SECONDS` | `10` | Video stream idle flush timeout (`1..600` s) |
| `LUDENS_VIDEO_QUEUE_BYTES` | `32 MiB` | Max queued video bytes before backpressure |
| `LUDENS_VIDEO_QUEUE_FRAMES` | `64` | Max queued video frames |
| `LUDENS_VIDEO_STREAMS` | `16` | Maximum concurrent video perception streams |
| `LUDENS_VIDEO_QUERY_BYTES` | `32 MiB` | Maximum byte budget per video window query |
| `LUDENS_APP_INDEX_CACHE_BYTES` | `256 MiB` | Console index in-memory LRU budget |
| `LUDENS_APP_BUILD_BYTES` | `2 GiB` | Max bytes scanned when building `.dashboard-index/` |
| `LUDENS_APP_INDEX_MAX_RUNS` | `3` | Max run indexes retained simultaneously in memory |
| `LUDENS_APP_INDEX_IDLE_MS` | `300000` | Idle eviction delay for cached Console run indexes |
| `LUDENS_APP_INDEX_ROOT` | Workspace `.dashboard-index` | Override Console rebuildable index directory |
| `LUDENS_REMOTE_URL` | — | Default `--remote ws(s)://...` server URL for `ludens` pure-RPC CLI commands |
| `LUDENS_REMOTE_TOKEN` | — | Default bearer token paired with `LUDENS_REMOTE_URL` / `--remote` |
| `LUDENS_APP_TOKEN` | — | Bearer token environment variable forwarded/read when running authenticated `ludens-server` (`--token-env LUDENS_APP_TOKEN`) |
| `LUDENS_STATIC_DIR` | — | Static Vite SPA Console asset directory (`client/out`) served by `ludens-server` |
| `LUDENS_APP_SERVER_URL` | — | Upstream `ludens-server` target proxied by `client/scripts/dev.mjs` / `vite.config.ts` |
| `LUDENS_APP_DEV_URL` | — | Dev renderer URL loaded by `ludens-app` (`LUDENS_DEV_URL` alias) |
| `LUDENS_BUN` | — | Path override for the Bun executable |
| `LUDENS_APP_SERVER_BIN` | — | Binary path override when `ludens-app` or `ludens` spawns `ludens-server` |
| `LUDENS_DISABLE_COMPANION` | — | Disable launching the optional Desktop Pet from the Electron shell |

## Related Documentation

- [Workspace Tutorial](../tutorials/workspace.md) & [Devices Tutorial](../tutorials/devices.md): End-to-end setup examples with `ludens workspace init`, `ludens workspace up`, `ludens-core`, and `baseware`.
- [Console & Debugging Tutorial](../tutorials/console-and-debugging.md): Inspecting live runs, replays, and capabilities in the Console.
- [Architecture Specification](architecture.md): Four-layer six-package boundaries, daemon sockets, startup sequence, and storage boundaries.
- [Baseware Specification](baseware.md): Driver loading, lease epochs, and controller capability contracts.
- [Logging and Call Chains](logging.md): Run archive layout and `ludens logs` inspection fields.
