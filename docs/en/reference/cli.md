# CLI Reference (`ludens` / `baseware` / `ludens-app`)

This reference documents every user-facing command, flag, default value, and environment variable exposed by the three Ludens repository binaries:

- `ludens` ([`core/bin/ludens`](../../../core/bin/ludens)): unified operator & runtime CLI — manages global config, workspace registry, singleton App-Server daemon (`ludens daemon`), workspace lifecycle (`init`/`up`/`services`/`down`), Shiori runtime control (`status`/`auto`/`steer`/`consolidate`/`stop`/`model` over local UDS or `--remote ws(s)://...`), perception/evaluation tooling, log archives, and `ludens app-server`.
- `baseware` ([`baseware/bin/baseware`](../../../baseware/bin/baseware)): standalone **Baseware** Cross-device Integration Layer daemon, driver/package discovery, multi-machine routing, direct controller invocation, and MCP bridge mode.
- `ludens-app` ([`app/bin/ludens-app`](../../../app/bin/ludens-app), Windows [`app/bin/ludens-app.cmd`](../../../app/bin/ludens-app.cmd)): the zero-port Electron desktop shell (`ludens-app://console/` + `ludens-media://local/media?...`) communicating with `app-server.sock` via IPC UDS RPC and hosting the optional Desktop Pet.

> **Global operator flags**: `ludens` subcommands accept `--workspace <path>` (before or inline with operator commands, overriding `LUDENS_WORKSPACE` and the current working directory), plus `--remote <ws(s)://...>` and `--token <secret>` (overriding `LUDENS_REMOTE_URL` and `LUDENS_REMOTE_TOKEN`) to target a remote App-Server over WebSocket JSON-RPC instead of local `app-server.sock`.

---

## Global Configuration & Workspace Registry

Implemented in [`core/src/cli/global.ts`](../../../core/src/cli/global.ts) and [`protocol/src/ludens.ts`](../../../protocol/src/ludens.ts). Global state lives under `$LUDENS_HOME` (default `~/.ludens`).

### `ludens config`

Inspect or update global defaults shared across newly initialized and launched workspaces (supports `--remote` and `--token`).

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
| `defaults.dashboard` | `true` \| `false` — whether `ludens up` starts the Console server |
| `defaults.pet` | `true` \| `false` — whether `ludens up` starts the optional Desktop Pet |
| `defaults.connection.openaiWebsockets` | Boolean / WebSocket transport toggle |
| `defaults.connection.cacheRetention` | Prompt cache retention policy |
| `defaults.connection.appendOnlyContext` | Append-only context policy |
| `defaults.connection.imageUrls.enabled` | Boolean toggle for multimodal image URL delivery |
| `defaults.connection.imageUrls.backends` | Backend list for image URL delivery |

### `ludens workspace`

Manage registered workspaces in the global registry (`list`, `open`, and `forget` support `--remote`; `import` and `--new-id` operate on the local host filesystem).

```bash
ludens workspace list [--remote <url>] [--token <secret>]
ludens workspace open <directory> [--new-id] [--remote <url>] [--token <secret>]
ludens workspace forget <id> [--remote <url>] [--token <secret>]
ludens workspace import <directory> [--legacy-state <directory>] [--previous-workspace <directory>]
```

---

## Workspace Lifecycle & App Server

Implemented in [`core/src/cli/workspace.ts`](../../../core/src/cli/workspace.ts), [`core/src/cli/daemon-cli.ts`](../../../core/src/cli/daemon-cli.ts), [`core/src/cli/main.ts`](../../../core/src/cli/main.ts), [`core/src/cli/app-server-cli.ts`](../../../core/src/cli/app-server-cli.ts), and [`core/src/daemon/launcher.ts`](../../../core/src/daemon/launcher.ts).

### `ludens daemon`

Inspect, start, stop, or restart the per-`LUDENS_HOME` singleton `ludens app-server` daemon (`<home>/run/app-server.sock` by default, or `/tmp/ludens-app-<uid>-<sha256_12>.sock` if path length approaches `APP_SERVER_SUN_PATH_LIMIT = 96`).

```bash
ludens daemon status
ludens daemon start [--listen <unix://PATH|ws://HOST:PORT>] [--auth <none|token>] \
  [--token <secret> | --token-env <var>] [--static-dir <path>] [--trusted-origin <origin>]
ludens daemon stop [--keep-cores | --stop-cores]
ludens daemon restart [--listen <unix://PATH|ws://HOST:PORT>] [--auth <none|token>] \
  [--token <secret> | --token-env <var>] [--static-dir <path>] [--trusted-origin <origin>]
```

- `ludens daemon stop` cleanly shuts down managed workspace Cores before stopping App-Server unless `--keep-cores` is passed (`--stop-cores` is the default).
- When `--listen ws://HOST:PORT` binds a non-loopback address, `--auth token` is mandatory.

### `ludens init`

Create a workspace directory and write `ludens.json` (also supports `--remote` when creating workspaces on a remote App-Server).

```bash
ludens init --driver <id> \
  [--name <name>] \
  [--workspace <path>] \
  [--driver-package <spec>] \
  [--game <path>] \
  [--cua-command <path>] \
  [--model <id>] \
  [--seconds <n>] \
  [--requests <n>] \
  [--pet | --no-pet]
```

Launcher defaults written/resolved when omitted in `ludens.json`: `model` = `openai-codex/gpt-6.1-sol`, `seconds` = `1800`, `requests` = `1000`, `dashboard` = `true`, `pet` = `false`, `logging.diagnostics` = `"normal"`.

### `ludens up` / `ludens services` / `ludens down`

Manage supervised workspace processes (**Baseware**, per-workspace **Core** hosting **Shiori** with `launchedBy: "cli"`, optional target/simulator launch command, singleton **App Daemon**, and optional **Desktop Pet**) locally via `app-server.sock` or remotely via `--remote`, following **1 Workspace = 1 Core** isolation.

```bash
ludens up [--dry-run] [--preempt] [--services <emulator,baseware,core>] \
  [--dashboard | --no-dashboard] [--pet | --no-pet] [--remote <url>] [--token <secret>]
ludens services [--remote <url>] [--token <secret>]
ludens down [--services <emulator,baseware,core>] [--keep-emulator] \
  [--dashboard] [--pet] [--remote <url>] [--token <secret>]
```

- `--preempt` preempts a conflicting workspace Core holding the same physical device.
- `--services` scopes `up` / `down` to specific managed components (`emulator`, `baseware`, `core`).
- `--dashboard` / `--no-dashboard` controls ensuring the local `ludens app-server` daemon.
- `--pet` / `--no-pet` toggles the optional Desktop Pet widget during `up` / `down`.
- `--keep-emulator` keeps target simulator/runtime processes alive while stopping Ludens daemons.

### `ludens app-server` / `ludens serve`

Start the unified multi-workspace **App Daemon** serving JSON-RPC 2.0 (`@ludens/protocol/app-rpc`) over UDS NDJSON and WebSocket `/rpc`, real-time `EventHub` subscriptions, HMAC capability-ticket `/media` (`mt=`, `206 Range`), `/health`, and static Vite SPA assets (`app/out`, returning `404` for `/api/*`).

```bash
ludens app-server [--listen <unix://PATH | ws://HOST:PORT>] \
  [--auth <none|token>] [--token <secret> | --token-env <var>] \
  [--static-dir <path>] [--trusted-origin <origin>] [--parent-watchdog] [-h | --help]
ludens serve ...   # Alias of app-server
```

- With no `--listen` argument, `app-server` binds **UDS-only (`app-server.sock`, 0 listening TCP ports)** and `--auth none`.
- Non-loopback `ws://` listeners refuse to start without `--auth token` (`--token` or `--token-env`).
- `--trusted-origin <origin>` may be repeated to allowlist browser `Origin` headers. `--parent-watchdog` binds server lifetime to parent stdin/exit, and startup emits a single-line JSON readiness handshake on stdout.

### `ludens run`

Run the workspace **Core** (hosting the **Shiori** Agent Thread Core) directly in the foreground (without `ludens up` supervisor orchestration).

```bash
ludens [--workspace <path>] run \
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

Defaults in [`core/src/cli/main.ts`](../../../core/src/cli/main.ts): `--seconds 300`, `--requests 50`, `--diagnostics normal`, and `--launched-by` (with `LUDENS_LAUNCHED_BY` env fallback) defaults to `cli` (`app` is used by **App Daemon** for App-owned teardown boundaries); `--model` falls back to `ludens.json` or `openai-codex/gpt-6.1-sol`.

---

## Live Control, Event Pool, Perception, Controllers & Machines

Operator control commands (`status`, `auto`, `steer`, `consolidate`, `stop`, `model`) communicate through local `app-server.sock` or `--remote ws(s)://... [--token ...]`, falling back to direct workspace Core socket (`core.sock`) when inside a runtime or directly targeting `LUDENS_SOCKET`. Runtime-internal commands (`event`, `perception`, `observe`, `controller`, `machine`) communicate directly with the workspace Core daemon (`core.sock`) (see [`core/src/cli/control-cli.ts`](../../../core/src/cli/control-cli.ts), [`core/src/cli/operator-rpc.ts`](../../../core/src/cli/operator-rpc.ts), [`core/src/cli/event-cli.ts`](../../../core/src/cli/event-cli.ts), and [`core/src/daemon/transport.ts`](../../../core/src/daemon/transport.ts)).

### Status, Auto Run & Steer

```bash
ludens status [--remote <url>] [--token <secret>]
ludens auto on [--message <text>] [--seconds <n>] [--remote <url>] [--token <secret>]
ludens auto timer <seconds|off|unbounded|none> [--remote <url>] [--token <secret>]
ludens auto off [--remote <url>] [--token <secret>]
ludens steer [--message <text> | <text>] [--remote <url>] [--token <secret>]
ludens consolidate [--seconds <n>] [--remote <url>] [--token <secret>]
ludens stop [--remote <url>] [--token <secret>]
ludens model [<provider/id>] [--service-tier none|priority|ultrafast] \
  [--effort none|minimal|low|medium|high|xhigh|max] [--remote <url>] [--token <secret>]
```

- `ludens auto on` starts an **Auto Run** control cycle (`--seconds` sets the timed control cycle duration).
- `ludens auto timer` updates the remaining cycle timer (`off`, `unbounded`, or `none` removes the time cap).
- `ludens auto off` executes **Reclaim Control**, returning Shiori to **Manual Standby** (`manual`) and revoking device control at Baseware.
- `ludens steer` interrupts or queues a steering instruction for Shiori.
- `ludens consolidate` runs memory consolidation (`--seconds` defaults to `600`).
- `ludens stop` stops the workspace Core daemon cleanly.
- `ludens model` switches the active model, service tier, or thinking effort while in Manual Standby.

### `ludens event` (Event Pool)

Inspect and respond to the asynchronous workspace Event Pool (user triggers, notifications, and Shiori outbound requests).

```bash
ludens event list [--direction <inbound|outbound>] [--status <pending|handled>] [--limit <n>]
ludens event send [--title <text>] [--message <text> | <text>]
ludens event reply <event-id> [--message <text> | <text>]
ludens event ack <event-id> [<event-id2> ...]
```

### `ludens perception` & `ludens observe`

Manage multimodal perception pipelines and query recorded observation windows.

```bash
ludens perception status
ludens perception state
ludens perception reload
ludens perception stop
ludens perception transition <target> [--args '<JSON object>' | --file <arguments.json>]
ludens perception inject [on|off]
ludens perception observe [--capability <id|*>] [--id <record-id> | --at <ISO> | --start <ISO> --end <ISO>] \
  [--limit <n>] [--after <sequence>] [--images]
ludens observe [--capability <id|*>] [--id <record-id> | --at <ISO> | --start <ISO> --end <ISO>] \
  [--limit <n>] [--after <sequence>] [--images]
```

`observe` defaults to `--limit 8` (maximum `64`); pass `--images` to include inline frame outputs.

### `ludens controller` & `ludens machine`

Inspect and directly execute native driver controllers (`controller/<name>`) or Python-wrapped workspace controllers (`python/<path.py>:<function>`), and manage Baseware machines.

```bash
ludens controller list
ludens controller <id> --help
ludens controller controller/<native name> [--machine <machineId>] [--args '<JSON object>' | --file <arguments.json>]
ludens controller python/<path.py>:<function> [--args '<JSON object>' | --file <arguments.json>]

ludens machine list
ludens machine use <id>
ludens machine connect <id> [<id2> ...]
ludens machine disconnect <id>
```

---

## Evals & Log Archives

Implemented in [`core/src/cli/eval-cli.ts`](../../../core/src/cli/eval-cli.ts) and [`core/src/cli/log-archive.ts`](../../../core/src/cli/log-archive.ts).

### `ludens eval`

Run, inspect, and adapt capability self-verification harnesses (see [Self-Verification](../concepts/self-verification.md)).

```bash
ludens eval list
ludens eval run [<capability-id>] [--all] [--limit <n>]
ludens eval <python/capability-id>          # Shorthand when capability ID starts with python/
ludens eval history [<capability-id>] [--limit <n>]
ludens eval adapt <capability-id> --reason <text> [--record <record-id> ...]
```

### `ludens logs`

Inspect archived run event timelines and read full archived payloads offloaded to disk (see [Logging and Call Chains](logging.md)).

```bash
ludens logs events --run <run-directory> [--diagnostics]
ludens logs read --run <run-directory> \
  (--ref '<JSON reference>' | --file <reference.json> | --event <seq> --field <name>) \
  [--full]
```

---

## `baseware` CLI

Implemented in [`baseware/src/cli.ts`](../../../baseware/src/cli.ts) and [`baseware/src/main.ts`](../../../baseware/src/main.ts). Default standalone daemon socket is `/tmp/ludens-baseware-${uid}-${id}.sock`.

### `baseware serve`

Start Baseware directly with a driver, transport, and socket binding.

```bash
baseware serve --driver <id> \
  [--driver-package <npm|github:org/repo#rev|https://github.com/org/repo#rev|file:path>] \
  [--port <n>] [--host <host>] \
  [--transport stdio|bridge|ssh|http|sse] \
  [--ssh-host <host>] [--ssh-user <user>] [--ssh-port <n>] [--ssh-identity <path>] [--ssh-command <cmd>] \
  [--url <url>] [--cua-command <path>] \
  [--socket <path>] [--data-dir <path>] [--machine-id <id>] \
  [--diagnostics normal|full]
```

### Baseware Client, Driver, Machine & MCP Commands

```bash
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

---

## `ludens-app` Desktop CLI

Implemented in [`app/desktop/main.ts`](../../../app/desktop/main.ts). Launches the zero-port Electron desktop app loading the bundled Vite SPA (`ludens-app://console/`) and local media (`ludens-media://local/media?...`) over UDS `app-server.sock` via `AppServerHost` (`ensureLocalAppDaemon`), with `ActiveCoreQuitGuard` and the optional Desktop Pet (`PetSessionCoordinator`).

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

Verified across [`core/`](../../../core/src/), [`baseware/`](../../../baseware/src/), and [`app/`](../../../app/):

| Variable | Default | Purpose |
| --- | --- | --- |
| `LUDENS_HOME` | `~/.ludens` | Root directory for global config, driver cache, and state |
| `LUDENS_WORKSPACE` | Current working directory | Default workspace path when `--workspace` is omitted |
| `LUDENS_SOCKET` | `/tmp/ludens-core-${uid}-${workspaceHash}.sock` | Override Core daemon Unix domain socket path |
| `BASEWARE_SOCKET` | `/tmp/ludens-baseware-${uid}-${id}.sock` | Override Baseware Unix domain socket path |
| `BASEWARE_EPOCH` | — | Control lease epoch carried by `run` / Baseware clients |
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
| `LUDENS_REMOTE_URL` | — | Default `--remote ws(s)://...` App-Server URL for unified CLI operator commands |
| `LUDENS_REMOTE_TOKEN` | — | Default bearer token paired with `LUDENS_REMOTE_URL` / `--remote` |
| `LUDENS_APP_TOKEN` | — | Bearer token environment variable forwarded/read when running authenticated `app-server` or `ludens daemon start --token-env LUDENS_APP_TOKEN` |
| `LUDENS_STATIC_DIR` | — | Static Vite SPA Console asset directory (`app/out`) served by `app-server` |
| `LUDENS_APP_SERVER_URL` | — | Upstream `app-server` target proxied by `app/scripts/dev.mjs` / `vite.config.ts` |
| `LUDENS_APP_DEV_URL` | — | Dev renderer URL loaded by `ludens-app` (`LUDENS_DEV_URL` alias) |
| `LUDENS_BUN` | — | Path override for the Bun executable |
| `LUDENS_APP_SERVER_BIN` | — | Binary path override when `ludens-app` spawns `app-server` |
| `LUDENS_DISABLE_COMPANION` | — | Disable launching the optional Desktop Pet from the Electron shell |

## Related Documentation

- [Workspace Tutorial](../tutorials/workspace.md) & [Devices Tutorial](../tutorials/devices.md): End-to-end setup examples with `ludens init`, `ludens up`, and `baseware`.
- [Console & Debugging Tutorial](../tutorials/console-and-debugging.md): Inspecting live runs, replays, and capabilities in the Console.
- [Architecture Specification](architecture.md): Daemon sockets, startup sequence, and storage boundaries.
- [Baseware Specification](baseware.md): Driver loading, lease epochs, and controller capability contracts.
- [Logging and Call Chains](logging.md): Run archive layout and `ludens logs` inspection fields.
