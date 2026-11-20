# What Is Ludens & System Architecture

**Ludens** is a multimodal, cross-device Agent Harness for solving complex end-to-end tasks across robotics control, security and vision monitoring, desktop and software automation, and real-time games. **Ludens** names both the overall Harness and its personified mascot.

## Why a Code-First Harness Instead of a Static Wrapper

Most agent frameworks wrap a vision-language model in a fixed loop: send a screenshot, wait several seconds for a prediction, emit one low-level click or keystroke, and repeat. That pattern breaks down on real-world targets for three reasons:

- **Latency mismatch**: Every LLM round-trip takes seconds, whereas robotic visual servoing, camera anomaly gating, modal software popups, and real-time game cues unfold in tens of milliseconds.
- **Amnesia across runs**: Prompt-only wrappers have nowhere to store calibrated detectors, coordinate transforms, reusable multi-step procedures, or regression test suites.
- **Unsafe hardware boundaries**: Without an explicit control lease, background scripts or delayed tool calls can still actuate hardware after a human operator intervenes.

Ludens replaces static action wrapping with a **code-first multimodal closed loop**. Instead of guessing every single frame from scratch, the agent works inside a persistent coding workspace: it writes resident perception detectors, composes typed Python capabilities, verifies them against offline surrogate environments, and runs high-frequency closed loops locally while reserving model inference for strategy, adaptation, and recovery.

## The Four System Layers and Six-Package Architecture

Ludens separates device plumbing, workspace code and execution sandboxes, the multi-workspace control-plane server, and client observability surfaces into **4 Layer Roles × 6 Physical Packages**:

```mermaid
flowchart LR
    U["Operator (Desktop / Web / Mobile / CLI --remote)"] --> Con["L1 @ludens/client (Vite SPA client/dist & ludens CLI) + @ludens/desktop (ludens-app)"]
    Con -->|"UDS app-server.sock / WS /rpc"| Srv["L2 @ludens/server (ludens-server: JSON-RPC 2.0 + EventHub + HMAC /media)"]
    Srv -->|"ludens-core run"| Sh["L3 @ludens/core (Shiori Agent Thread Core)"]
    Sh --> Ws["Workspace & Resident Perception (30 Hz Timeline / Skills)"]
    Ws --> Cat["Unified Catalog (ludens-core controller)"]
    Sh --> Cat
    Cat --> Bw["L4 @ludens/baseware (Cross-Device Integration & Epoch Leases)"]
    Bw --> Nodes["Controlled Nodes (stdio / bridge / ssh / http / sse)"]
    Nodes --> Targets["Robotics / Cameras / Desktops / Simulators"]
```

### 1. Baseware — Cross-Device Integration Layer (L4, `@ludens/baseware`)

**Baseware** (`@ludens/baseware`, bin `baseware`) is the standalone cross-device integration and compatibility layer that isolates hardware and software protocols from agent code:

- **Faithful native semantics**: Every connected driver exposes its capabilities as JSON-Schema **Controller** tools (including sensors that capture frames or telemetry and actuators that execute inputs). A desktop CUA target keeps native mouse/keyboard actions, a camera or relay node keeps its sensor and trigger endpoints, a robotic rig exposes its joint or bridge commands, and a simulator exposes its native inputs — nothing is coerced into a lowest-common-denominator fake device.
- **Multi-node transport pool**: Baseware mounts local and remote controlled nodes over five transports (`stdio`, `bridge`, `ssh`, `http`, and `sse`). One workspace can connect multiple nodes concurrently and route actions explicitly by node ID (`controller/<machineId>/<tool>`).
- **Control lease (`epoch`) arbitration**: Baseware enforces a monotonic `epoch` lease on every side-effecting call (`requiresControl`). When a Control Cycle ends or the operator triggers **Reclaim Control**, Baseware revokes the `epoch`, aborts in-flight actions, and resets active inputs immediately.
- **Independent device fact logs**: Baseware records hardware commands, control transitions, and sampling diagnostics directly under `logs/baseware/`.

### 2. Workspace & Resident Perception

A **Workspace** (`~/.ludens/workspaces/<name>` or any registered directory) is an ordinary coding project evolved jointly by the agent and the operator:

- **Workspace artifacts**: `ludens.json` holds workspace launch and model configuration; `baseware.json` caches the exported device schema snapshot; `perception.py` defines the resident `Perception` worker; optional `loop.py` defines a programmable outer `Loop` scheduler and turn-start injector; `skills/<name>/SKILL.md` stores reusable procedures; `MEMORY.md` holds durable environment knowledge; and `memory/current.md` tracks active goals and next steps.
- **30 Hz resident perception and lean input contract**: Under an active control lease, `perception.py:Perception.sample()` executes continuously up to `30 Hz` (configurable ceiling, backpressuring slow samples without overlap). Recorded results and segmented fMP4 video flow into `.ludens/timeline/`, the single source of truth for observation queries (`ludens-core perception observe` and `Client().replay()`). Routine model reads deliver a lean perception envelope (`{ ok, records: [{ id, sequence, recordedAt, text?, data?, space?, effect?, transition? }] }`) stripped of internal telemetry noise, retaining pagination and availability metadata only on historical or filtered queries.
- **Hot-reload and in-process closed loops**: Editing `perception.py`, `loop.py`, or imported `.py` modules automatically reloads the corresponding resident worker; `perception.py` reloads increment `inputGeneration` and release stale device inputs, while `loop.py` reloads take effect between turns and fall back safely to the default loop on `loop_fault`, keeping the active `epoch` and session intact. When **Manual Standby** is active, the resident worker remains warm to serve read-only timeline queries without sampling.
- **Unified capability catalog**: Top-level Python functions decorated with `@capability` merge with Baseware's device tools under `ludens-core controller`, allowing both shell commands and Python callers (`ludens_tools.Client`) to discover and invoke capabilities uniformly.

### 3. Shiori & Per-Workspace Execution Sandbox (L3, `@ludens/core`)

**Shiori** is strictly Ludens's **Agent Thread Core** — the execution and scheduling kernel inside `@ludens/core` (`ludens-core`, `1 Workspace = 1 Core`, zero Server/Client dependencies), not a conversational chatbot persona:

- **Control Cycle governance and programmable outer loop**: Shiori drives transitions between **Manual Standby** and **Auto Run**, acquires and holds each cycle's `epoch` against Baseware, enforces optional per-cycle wall-clock timers, and guarantees clean device release before returning to **Manual Standby**. When `loop.py` is absent, Shiori runs the built-in default loop; when `loop.py` is present, `Loop.inject` and `Loop.step` (`Prompt` / `Consolidate` / `Wait` / `Stop`) orchestrate deterministic zero-token `@capability` transitions and custom turn-start injections under the active `epoch` lease, while urgent human `steer` immediately wakes `Wait` and preempts deterministic steps.
- **Persistent workspace thread**: For model-driven runs, Shiori mounts its underlying agent-loop runtime (OMP `18.22.2`) in a single resumable session per workspace under `.ludens/shiori/`. It provides native workspace tools (`read`, `write`, `edit`, `bash`, `wait`, with `core/bin` prepended to `PATH` so `bash` invokes `ludens-core <controller|perception|event|machine|eval>` directly) alongside `observe` and `event_pool`, keeping device schemas out of the initial tool list so context stays lean and cache-friendly.
- **Paused-only model switching and consolidation**: Model, serving tier, and reasoning effort switches are allowed only in **Manual Standby** so every request inside a Control Cycle has clean provenance. File-only `consolidate` turns let Shiori maintain `skills/` and `memory/current.md` without device access.

### 4. Control-Plane Server (L2, `@ludens/server`) & Client Console (L1, `@ludens/client` + `@ludens/desktop`)

The **Control-Plane Server** (`@ludens/server`, bin `ludens-server`) provides unified JSON-RPC 2.0 (`@ludens/protocol/app-rpc`), real-time `EventHub` push (with `sinceSeq` catch-up), HMAC `/media`, query/cold-index Workers, and multi-workspace `WorkspaceSupervisor`. Atop it, the **Client Console** (`@ludens/client` Vite static SPA `client/dist` + pure-RPC CLI `ludens`, strictly depending only on `@ludens/protocol`) and **All-in-One Desktop Distribution** (`@ludens/desktop` `ludens-app`) span four surfaces:

- **Zero-port Desktop App (`ludens-app`)**: connects to local `ludens-server` over Unix Domain Socket (`app-server.sock`, **0 listening TCP ports**) using `ludens-app://console/`, `ludens-media://local/media?...`, `window.ludens.rpc`, and `ActiveCoreQuitGuard`.
- **Hosted Web / Self-Hosted Remote Server**: `bun run start:selfhost` or `ludens-server serve` / `ludens-server start` (`--listen ws://HOST:PORT --auth token`) serves `client/dist`, WS `/rpc`, and HMAC-signed `/media` (`#token=` scrubbed via `history.replaceState`).
- **Pure-RPC Operator CLI (`ludens`)**: human-facing `ludens` commands (`config`, `workspace <init|list|open|forget|import|up|down|services|eval>`, `status|auto|steer|consolidate|stop|model|logs`) switch transparently between local `app-server.sock` (auto-waking `ludens-server start` from `PATH` when offline) and `--remote ws(s)://...`.
- **Standalone Web / Mobile & Multi-Target Browser SPA**: `@ludens/client` deploys independently online and switches cleanly between `electron-local`, `same-origin`, and cross-origin `remote` targets via `<ConnectionTargetDialog>`.

Archive indexing runs in isolated background query workers inside `ludens-server` so the interface stays responsive even across long multi-hour recordings.

The Console organizes workspace operations across ten views:

| View | Query Param | Primary Purpose |
| --- | --- | --- |
| **Live** | `?view=live` | Trigger **Start Auto Run** or **Reclaim Control**, adjust timers, send **Event Pool** messages or mid-turn `steer`, switch node viewports, and inspect 1:1 model input payloads and collapsible **Loop steps** |
| **Replay** | `?view=replay` | Scrub synchronized 30 Hz fMP4 video frames, device actions, and model calls along one shared wall-clock timeline |
| **Performance** | `?view=perf` | Inspect per-request transport latency, prompt-cache hit rates, compaction events, and explicit observation chains |
| **Capabilities** | `?view=caps` | Browse the **Capability – Eval – Env** triad topology, inspect stale or adapting statuses, and trigger offline evaluation runs |
| **Config** | `?view=perception` | Manage model, target device, multimodal transport, one-click service lifecycle, `MEMORY.md`, perception storage, and loop estimation |
| **Devices** | `?view=baseware` | Manage Baseware driver packages, configure controlled nodes across transports, bind workspace machine pools, and inspect `Controller` schemas |
| **Workspaces** | `?view=workspaces` | Configure the workspace root, register or move local workspaces, and switch active projects |
| **Docs** | `?view=docs` | Read the live bilingual documentation rendered directly from `docs/` |
| **Settings** | `?view=settings` | Set Console language, new-workspace global defaults, default multimodal transport, and optional add-on preferences |
| **Developer** | `?view=dev` | Experiment with context-delivery simulations in Loop Lab without affecting live runs |

As a minor optional add-on, the Desktop App can also show a compact system-tray **Desktop Pet** widget that mirrors live workspace activity.

## How a Multi-Domain Task Flows End-to-End

Whether automating a multi-window desktop software suite, guarding a camera stream, calibrating a robotic arm bridge, or mastering a real-time game, every Ludens task follows the same lifecycle:

1. **Connect targets in Baseware**: Register a local desktop (`cua`), hardware/simulator bridge (`bridge` / `ssh`), or remote endpoint (`http` / `sse`) in **Devices** (`?view=baseware`) or `ludens workspace init`.
2. **Launch in Manual Standby**: Run `ludens workspace up` (or start the workspace from **Config**, `?view=perception`). The host exports `baseware.json` and starts the warm `perception.py` worker while keeping hardware under operator control.
3. **Start Auto Run**: Click **Start Auto Run** in **Live** (`?view=live`) or run `ludens auto on --message "..."`. Shiori acquires a fresh `epoch` lease, starts 30 Hz timeline capture, and begins the Observe → Reason → Act & Eval loop.
4. **Code, verify offline, and execute**: Instead of issuing fragile per-frame clicks, Shiori writes `@capability` functions paired with `@eval_env` surrogates and `@eval_capability` checks, validates them locally with `ludens-core eval run` (or `ludens workspace eval run` from the operator CLI), and deploys fast closed-loop logic or routine inter-turn transitions into `perception.py`, `skills/`, or `loop.py`.
5. **Collaborate or intervene at any instant**: Send asynchronous instructions via the **Event Pool** (`ludens-core event send`), redirect a running turn with `ludens steer`, or click **Reclaim Control** (`ludens auto off`) to halt actuation immediately and drop back to **Manual Standby**.
6. **Inspect and consolidate**: Review synchronized video and model traces in **Replay** (`?view=replay`) and run `ludens consolidate` to keep `skills/` and `memory/current.md` clean for the next run.

## Next Steps

- Continue to [Control Cycles, Perception Loop & Collaboration](loop-and-control.md) to see how `epoch` leases, cycle timers, **Event Pool**, and `steer` work together.
- Read [Code-First Perception & Self-Verification](self-verification.md) to understand the **Capability – Eval – Env** triad and failure-frame adaptation.
- Ready to build? Start with [Quick Start](../tutorials/quickstart.md) and [Devices & Drivers](../tutorials/devices.md), or inspect full component contracts in [Architecture and Boundaries](../reference/architecture.md) and [Baseware Capability Contracts](../reference/baseware.md).
