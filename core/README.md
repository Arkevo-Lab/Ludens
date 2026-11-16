# @ludens/core

Core harness runtime and unified `app-server` for Ludens: hosts **Shiori** (Agent Thread Core powered by **OMP `18.18.8`**), connects **Baseware** cross-device node pools with agent-evolved coding workspaces, runs the resident Python perception/action worker (`perception.py`), routes calls across mounted devices (`controller/<machineId>/<tool>`), and drives offline **Capability – Eval – Env** verification (`ludens eval`).

## Key Subsystems

- **Host Daemon, App-Server Daemon & Unified CLI (`src/daemon/`, `src/cli/`)**: Manages per-workspace Core sockets (`core.sock` via `LUDENS_SOCKET`) and the per-`LUDENS_HOME` singleton App-Server (`app-server.sock` via `ensureLocalAppDaemon` and `ludens daemon status|start|stop|restart`). Operator commands (`up`, `down`, `services`, `workspace`, `config`, `status`, `auto`, `steer`, `consolidate`, `stop`, `model`) operate uniformly over local UDS `app-server.sock` or remotely via `--remote ws(s)://... [--token ...]`.
- **Shiori Agent Thread Core (`src/core/agent-omp/`)**: Integrates `@oh-my-pi/pi-coding-agent@18.18.8` with image-capable model catalog discovery and paused-only session switching (`setModel` applies model plus optional `priority`/`ultrafast` service tier and `minimal`..`max` reasoning effort while preserving `imageCountBudget: Infinity`), single-channel per-turn perception injection, background speculative compaction (`:spec:` session isolation + `parentSessionId` cache affinity), and stateful WebSocket delta recovery.
- **Resident Python SDK (`python/ludens_tools/`)**: Provides `ludens_tools.Client`, multi-node `call(..., machine=...)`, `@capability` / `@eval_capability` / `@eval_env` decorators, and high-frequency fMP4/H.264 timeline media recording.
- **Unified JSON-RPC 2.0 App-Server & Console Query (`src/core/query/`, `src/server/`)**: Serves `@ludens/protocol/app-rpc` over zero-port Unix Domain Socket (NDJSON) and WebSocket `/rpc` (fail-closed token auth on non-loopback `--listen ws://`), real-time `EventHub` push (`events/subscribe` + `sinceSeq` replay over a 1024-event ring, publishing `observation` events after disk write), dual-plane `media/resolve` + HMAC-signed `/media` (`mt=`, `206 Range`), static SPA serving (`--static-dir app/out`), workspace catalogs, live/replay archive projections, 1-click service lifecycle RPCs, and capability eval runs.

## Scripts

```sh
cd core && bun run typecheck
cd core && bun test
```

## Documentation

- [System Overview](../docs/en/concepts/overview.md)
- [Architecture and Boundaries](../docs/en/reference/architecture.md)
- [CLI Reference](../docs/en/reference/cli.md)
- [Quick Start and Workspace Lifecycle](../docs/en/tutorials/quickstart.md)
- [Devices, Drivers & Multi-Node Pool](../docs/en/tutorials/devices.md)
- [Workspaces and Capability Programming](../docs/en/tutorials/workspace.md)
- [Resident Perception-and-Action State Machine](../docs/en/tutorials/perception-and-action.md)
- [OMP Background Compaction Rework](../docs/en/insights/omp-compaction.md)
- [WS Recovery Test Rationale](../docs/en/insights/ws-recovery.md)
- [Single-Channel Turn Injection](../docs/en/insights/omp-injection.md)
