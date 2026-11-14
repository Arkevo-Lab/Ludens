# Reference · Components and Contracts

This directory specifies the Ludens system architecture, CLI commands, process responsibility boundaries, cross-device control protocols, and run-log archive formats. The repository source implementation is the sole authority for all contracts.

## Architecture Layers and Reference Map

| Layer | Core Concerns | Spec Document | Authoritative Source |
| --- | --- | --- | --- |
| **System topology and control loop** | Five-component boundaries, the Shiori Agent Thread Core, OMP session assembly, control cycle `epoch`, Event Pool, and cross-process store ownership | [Architecture and Boundaries](architecture.md) | `core/src/core/shiori/runtime.ts` · `core/src/core/agent-omp/session.ts` |
| **CLI and environment variables** | Complete `ludens`, `baseware`, and `ludens-app` commands, flags, defaults, and host/perception environment variables | [CLI Reference](cli.md) | `core/src/cli/main.ts` · `baseware/src/cli.ts` · `app/desktop/main.ts` |
| **Cross-device integration and capability catalog** | CUA-native tool structure, the `ExecutionResult` envelope, `requiresControl` arbitration, external driver package discovery, and multi-node pooling | [Baseware Philosophy and Capability Contracts](baseware.md) | `baseware/src/contracts.ts` · `baseware/src/catalog.ts` |
| **Bridge wire communication** | TCP single-client line protocol, the `HELLO / OWN / APPLY / CAPTURE / TOUCH` instruction set, and error codes | [Driver Bridge Protocol](driver-bridge-protocol.md) | `baseware/src/drivers/bridge.ts` · external driver Providers |
| **Observability and Console consumption** | `normal / full` recording modes, `.ludens/timeline/` and `.ludens/archive/` storage, Trace pairing, Console hot/cold indexes, and replay | [Logging and Call Chains](logging.md) | `core/src/core/storage/events.ts` · `protocol/src/log-archive.ts` · `core/src/core/query/` |

## Related Guides

- **Understanding the system model and four-layer design**: start with [System Overview](../concepts/overview.md), [Control Cycles & Collaboration](../concepts/loop-and-control.md), and [Perception & Self-Verification](../concepts/self-verification.md).
- **Adding a new hardware, simulator, or software driver**: read [Driver packages and launch description](baseware.md#driver-packages-and-launch-description) in Baseware Philosophy and Capability Contracts first, then implement the target-side TCP bridge and TypeScript Provider against the [Driver Bridge Protocol](driver-bridge-protocol.md).
- **Understanding how the Agent perceives the environment and issues actions**: read [Session and Loop](architecture.md#session-and-loop), [Workspaces and Capabilities](../tutorials/workspace.md), and [Resident Perception-and-Action State Machine](../tutorials/perception-and-action.md).
- **Operating the Console, debugging runs, or verifying performance budgets**: read [Console & Debugging](../tutorials/console-and-debugging.md) (covering Console views, `core/src/perf/` and `app/perf/` baselines, and verification workflows) alongside [Logging and Call Chains](logging.md).
