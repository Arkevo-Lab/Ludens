# Concepts

Ludens is a multimodal, cross-device Agent Harness designed for complex end-to-end tasks across robotics control, security monitoring, desktop and software workflows, and real-time games. Rather than confining a model to static prompts and brittle turn-by-turn clicks, Ludens attaches live hardware and software targets to an ordinary coding workspace where perception detectors, closed-loop controllers, and offline evaluations co-evolve.

## Reading Map

| Topic | What You Will Learn | Document |
| --- | --- | --- |
| **System Overview** | Why a code-first Harness beats static action wrappers, and how **Baseware**, **Workspace**, **Shiori**, and **Console** divide responsibilities | [What Is Ludens & System Architecture](overview.md) |
| **Loop & Control** | The Observe → Reason → Act & Eval → Consolidate loop, **Auto Run** vs. **Manual Standby**, **Reclaim Control**, monotonic `epoch` leases, budgets, **Event Pool**, and `steer` | [Control Cycles, Perception Loop & Collaboration](loop-and-control.md) |
| **Self-Verification** | Code-first perception at 30 Hz, the **Capability – Eval – Env** triad, `ludens eval` regression gates, `adapt` failure-frame feedback, and skill/memory consolidation | [Code-First Perception & Self-Verification](self-verification.md) |

## Key Terms at a Glance

| Term | Role in Ludens |
| --- | --- |
| **Ludens** | Both the complete cross-device multimodal Harness and its personified mascot. |
| **Baseware** | The cross-device integration layer that standardizes drivers, multi-node transports (`stdio`, `bridge`, `ssh`, `http`, `sse`), and `epoch` control leases. |
| **Workspace** | The persistent coding directory (`perception.py`, `@capability` modules, `skills/`, `memory/`, `.ludens/timeline/`) shared by the agent and operator. |
| **Shiori** | Ludens's **Agent Thread Core**, orchestrating Control Cycles, time/request budgets, context delivery, and safe device release. |
| **Console** | The unified React 19 + Vite static SPA observability and control plane (zero-port Desktop App over `app-server.sock`, hosted Web / remote `wss://` over `/rpc`, and mobile multi-target switching) covering Live, Replay, Performance, Capabilities, Config, Devices, Workspaces, Docs, Settings, and Developer views. |

## Where to Go Next

- **Hands-on setup**: Follow [Tutorials](../tutorials/index.md) or jump straight to [Quick Start](../tutorials/quickstart.md) to install components, initialize a workspace, and run your first target.
- **Technical contracts**: Read [Architecture and Boundaries](../reference/architecture.md) and the [CLI Reference](../reference/cli.md) for exact module boundaries, commands, and file formats.
- **Design deep dives**: Explore [Insights](../insights/index.md) for engineering postmortems on context compaction, WebSocket recovery, turn injection, and perception parameterization.
