# @ludens/core

The Ludens recursive self-adaptation harness: connects **Shiori** (powered by **OMP `18.18.8`**), **Baseware** controlled node pools, and an agent-evolved coding workspace with autonomous control cycles, a resident Python perception/action worker (`perception.py`), multi-machine controller routing (`controller/<machineId>/<tool>`), and the workspace-native **Capability – Eval – Env** evaluation triad (`ludens eval`).

## Key Subsystems

- **Host Daemon & Transport (`src/daemon/`)**: Manages the workspace unix socket (`ludens.sock`), Shiori autonomous loop (`auto on` / urgent mid-turn `steer` / in-place `auto timer <seconds|off>` / `auto off`), paused-only OMP model inspection and switching (`ludens model [<provider/id>]`), the duplex workspace **Event Pool** (`event_pool` tool and `ludens event list | send | reply | ack`), and dynamic multi-machine mounts (`ludens machine list | use | connect | disconnect`).
- **Shiori Agent Runtime (`src/core/agent-omp/`)**: Integrates `@oh-my-pi/pi-coding-agent@18.18.8` with image-capable OMP model catalog discovery and paused-only session switching (`setModel` preserving `imageCountBudget: Infinity`), single-channel per-turn perception injection, background speculative compaction (`:spec:` session isolation + `parentSessionId` cache affinity), and stateful WebSocket delta recovery.
- **Resident Python SDK (`python/ludens_tools/`)**: Provides `ludens_tools.Client`, multi-machine `call(..., machine=...)`, `@capability` / `@eval_capability` / `@eval_env` decorators, and high-frequency fMP4/H.264 timeline media recording.
- **Dashboard Query Worker (`src/core/query/`)**: Serves workspace catalogs, image-capable OMP model discovery (`availableModels`) and paused-only `set_model` runtime control, live/replay projections, capability telemetry, 1-click service lifecycle RPCs (`controlWorkspaceService`), and capability eval runs (`runWorkspaceCapabilityEval`).

## Scripts

```sh
cd core && bun run typecheck
cd core && bun test
```

## Documentation

- [Architecture and Boundaries](../docs/en/reference/architecture.md)
- [Install and Workspace Lifecycle](../docs/en/tutorials/quickstart.md)
- [Devices, Drivers & Multi-Machine Pool](../docs/en/tutorials/devices.md)
- [Workspaces and Capability Programming](../docs/en/tutorials/workspace.md)
- [Resident Perception-and-Action State Machine](../docs/en/tutorials/perception-and-action.md)
- [OMP Background Compaction Rework](../docs/en/insights/omp-compaction.md)
- [WS Recovery Test Rationale](../docs/en/insights/ws-recovery.md)
- [Single-Channel Turn Injection](../docs/en/insights/omp-injection.md)
