# @ludens/core

Single-workspace execution kernel (`1 Workspace = 1 Core`) for Ludens: hosts **Shiori** (Agent Thread Core powered by **OMP `18.22.2`**), connects **Baseware** cross-device node pools with agent-evolved coding workspaces, runs the resident Python perception/action worker (`perception.py`) and optional programmable outer loop (`loop.py`), routes calls across mounted devices (`controller/<machineId>/<tool>`), and drives offline **Capability – Eval – Env** verification (`ludens-core eval`).

`@ludens/core` has zero dependency on `@ludens/server`, `@ludens/client`, or `@ludens/desktop`.

## Key Subsystems

- **Core CLI & Sandbox Tools (`bin/ludens-core`, `src/cli/`, `src/daemon/transport.ts`)**: Exposes `ludens-core run` (per-workspace Core process listening on `core.sock` via `LUDENS_SOCKET`) and in-sandbox Shiori tools (`ludens-core controller`, `ludens-core perception <status|state|reload|stop|transition|inject|observe>`, `ludens-core event`, `ludens-core machine`, `ludens-core eval`).
- **Shiori Agent Thread Core (`src/core/agent-omp/`, `src/core/shiori/`)**: Integrates `@oh-my-pi/pi-coding-agent@18.22.2` with image-capable model catalog discovery and paused-only session switching (`setModel` applies model plus optional `priority`/`ultrafast` service tier and `minimal`..`max` reasoning effort while preserving `imageCountBudget: Infinity` and session-level model stickiness locks `disableModelFallback`, `disableServerSideFallback`, and `suppressAutoPrewalk`), single-channel per-turn perception injection, background speculative compaction (`:spec:` session isolation + `parentSessionId` cache affinity), and stateful WebSocket delta recovery.
- **Resident Python SDK (`python/ludens_tools/`)**: Provides `ludens_tools.Client`, multi-node `call(..., machine=...)`, `@capability` / `@eval_capability` / `@eval_env` decorators, `Loop`, and high-frequency fMP4/H.264 timeline media recording.
- **Storage & Log Archive Library (`src/core/storage/`, `src/cli/log-archive.ts`)**: Per-workspace identity, session pointers, EventLog, duplex Event Pool, and offline log/artifact archive readers consumed by `@ludens/server`.

## Scripts

```sh
cd core && bun run build          # Build self-contained core/dist/ (main.js + bin/ludens-core + prompts/templates/python)
cd core && bun run typecheck
cd core && bun run test
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
