# @ludens/core

Core harness runtime and unified `app-server` for Ludens: hosts **Shiori** (Agent Thread Core powered by **OMP `18.18.8`**), connects **Baseware** cross-device node pools with agent-evolved coding workspaces, runs the resident Python perception/action worker (`perception.py`), routes calls across mounted devices (`controller/<machineId>/<tool>`), and drives offline **Capability – Eval – Env** verification (`ludens eval`).

## Key Subsystems

- **Host Daemon & Transport (`src/daemon/`)**: Manages the workspace unix socket (`ludens.sock`), Auto Run loop control (`auto on` / urgent mid-turn `steer` / in-place `auto timer <seconds|off>` / `auto off` to reclaim control), paused-only model inspection and switching (`ludens model [<provider/id>] [--service-tier none|priority|ultrafast] [--effort none|minimal|low|medium|high|xhigh|max]`), the duplex workspace **Event Pool** (`event_pool` tool and `ludens event list | send | reply | ack`), and dynamic multi-node mounts (`ludens machine list | use | connect | disconnect`).
- **Shiori Agent Thread Core (`src/core/agent-omp/`)**: Integrates `@oh-my-pi/pi-coding-agent@18.18.8` with image-capable model catalog discovery and paused-only session switching (`setModel` applies model plus optional `priority`/`ultrafast` service tier and `minimal`..`max` reasoning effort while preserving `imageCountBudget: Infinity`), single-channel per-turn perception injection, background speculative compaction (`:spec:` session isolation + `parentSessionId` cache affinity), and stateful WebSocket delta recovery.
- **Resident Python SDK (`python/ludens_tools/`)**: Provides `ludens_tools.Client`, multi-node `call(..., machine=...)`, `@capability` / `@eval_capability` / `@eval_env` decorators, and high-frequency fMP4/H.264 timeline media recording.
- **Console Query & App-Server (`src/core/query/`, `src/server/`)**: Serves workspace catalogs, image-capable model discovery (`availableModels` with per-model `supportedServiceTiers`, `supportedEfforts`, and `defaultEffort`) and paused-only `set_model` runtime control, live/replay projections, capability telemetry, 1-click service lifecycle RPCs (`controlWorkspaceService`), and capability eval runs (`runWorkspaceCapabilityEval`).

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
