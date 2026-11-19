# Console Operations & Debugging

Ludens provides a unified **Console** (built as one `@ludens/client` Vite SPA in `client/out` over `@ludens/protocol/app-rpc` JSON-RPC 2.0 — accessible inside the zero-port `@ludens/desktop` Desktop App via `app-server.sock`, on hosted Web/Remote `ludens-server serve --listen ws://...`, via Vite dev proxy `cd client && npm run dev` on `http://127.0.0.1:3015`, or on standalone Web and mobile browsers via `<ConnectionTargetDialog>`) backed by structured event logs, 30 Hz fMP4 archives, and CLI diagnostic commands. This guide covers operating every Console view, investigating failed capability checks and stalled Control Cycles, verifying daemon and socket health, and running targeted verification checks before reporting issues.

## 1. Console View Reference

### Workspace Views

| Sidebar Item | Query | Primary Operations |
| --- | --- | --- |
| **Live** | `?view=live` | Enter any workspace (even 0-run) with zero barrier and spawn Core + Baseware on demand when clicking **Start Auto Run**, manage all concurrent runs via the sidebar **Active Cores** list (`App`/`CLI` origin badges, `🆘` count, `■` stop), resolve **Device Contention** modals (`CONFLICT -32009 DEVICE_BUSY` -> Switch / Preempt), click **Reclaim Control**, switch mounted device viewports (`[machineId]`), send async notes via **Event Pool**, triage outbound notices/requests (**Reply**, **Reply & Resume**, **Mark Handled**), interrupt mid-turn with **Steer Now**, run **Consolidate skills/ & memory/ notes**, and inspect **Stage & Telemetry** alongside live event-driven activity pushes (`events/subscribe`) |
| **Replay** | `?view=replay` | Scrub the bounded 30-second fMP4 frame window (60s cap) and 15-minute event window, **Jump to time** at millisecond precision, search across **All tracks** in the **Event Stream**, and inspect **Node details** (delivered screenshots, tool calls, and `observation_context` receipts) |
| **Performance** | `?view=perf` | Monitor **Performance overview** (`Completed turns`, `P95`, `Median turn`, `Prompt cache hit`, `Decode speed`, `Duty cycle`, `Sampler rate`, `Autonomy ratio`) and inspect per-request latency and compaction history in **Request & Trace History** |
| **Capabilities** | `?view=caps` | Inspect the **Capability – Eval – Env** triad, filter by status (`verified`, `adapting`, `stale`, `failed`, `unverified`, `missing`), review **Workspace sources** (`baseware.json` vs static Python `@capability`), check **Core connection check** and **Community driver verification**, and click **Run All Evals** or individual eval runs |
| **Config** | `?view=perception` | Manage workspace setup across 6 tabs: **Model & Budget**, **Target Device**, **Connection & Transport**, **Perception Recording** (`hotSeconds`, `videoSegmentSeconds`, `videoIdleSeconds`), **Services & Session** (**Start Workspace** / **Reload Core** / **Stop**, `emulator`/`baseware`/`core`/`app-daemon`/`pet` background job rows, **Workspace Long-Term Memory (`MEMORY.md`)**, and Shiori thread summary), and **Loop Simulator** |

### Global & Utility Views

| Sidebar Item | Query | Primary Operations |
| --- | --- | --- |
| **Workspaces** | `?view=workspaces` | Browse registered workspaces, create or import workspaces, and switch active context (also reachable via `Cmd/Ctrl+K`; toggle sidebar with `Cmd/Ctrl+B`; navigate back/forward with `Cmd/Ctrl+[` and `Cmd/Ctrl+]`) |
| **Devices** | `?view=baseware` | **Devices & Nodes · Baseware**: Manage **Controlled Devices** (`~/.ludens/machines.json` and `workspace-default`) and **Driver Packages** (`~/.ludens/drivers.json`), probe **Node & Controllers**, and inspect or revoke leases in **Daemon & Lease** |
| **Docs** | `?view=docs` | Read synchronized English and Chinese documentation offline inside Console |
| **Settings** | `?view=settings` | Configure machine-wide **General**, **Workspace Defaults**, **Model & Transport**, and optional **Desktop Pet** display and `!auto` multi-Core auto-follow preferences (plus switching connection targets between `electron-local`, `same-origin`, and `remote` via `<ConnectionTargetDialog>`) |
| **Developer** | `?view=dev` | **Loop Lab**: Simulate context-window growth, delivered frame tokens, and compaction thresholds across scenario presets |

## 2. Inspecting Evidence in Replay (`?view=replay`)

When an agent turn misses a fast visual change or fires an unexpected action, start in **Replay** (`?view=replay`) before changing code:

1. **Locate the incident timestamp**: Switch **Event Stream** tracks or filter by **All tracks**, then click **Jump to time** with the exact timestamp from `logs/<run-id>/events.jsonl` or Live activity.
2. **Correlate video frames and capability ticks**: Scrub the synchronized 30 Hz fMP4 window to confirm whether `Perception.sample()` saw the frame before or after the event boundary.
3. **Verify true model inputs**: Open **Node details** on a model request node to inspect the exact delivered observations (`observation_context` receipts), prompt text, and tool responses — never guess what the model saw from side-effect timestamps alone.

If a subtle issue only reproduces infrequently, record the exact timeline slice as a counterexample with `ludens workspace eval adapt` (or in-sandbox `ludens-core eval adapt`) so offline tests lock in the failure condition.

## 3. Debugging Stalled Control Cycles & Failed Capability Checks

### Scenario A: Control Cycle Appears Stalled or Actuation Must Stop Now

1. **Halt execution immediately**: Click **Reclaim Control** in Console **Live** (`?view=live`) or run `ludens auto off`. If Baseware itself still holds a target lock, run `baseware revoke` (or click revoke in **Devices** -> **Daemon & Lease**).
2. **Inspect server, Core, and daemon state**: Run the status commands in the workspace directory:

```sh
ludens-server status
ludens status
ludens workspace services
ludens-core perception status
ludens-core perception state
baseware status
```

3. **Check for a blocked perception worker**: If `perception.state` shows `error` or stays in `loading`, read the latest stderr under `logs/<run-id>/perception/<gen>/` (or Console **Config**), fix any import/runtime bug in `perception.py`, and run `ludens-core perception reload` (or click **Reload Core** in **Config** -> **Services & Session**).
4. **Recover a dropped device node**: Check **Devices** (`?view=baseware`) -> **Daemon & Lease** or run `ludens-core machine list` and `baseware reconnect [--machine <id>]`.
5. **Clean restart preserving external target windows**:

```sh
ludens workspace down --keep-emulator
ludens workspace up
```

### Scenario B: Capability Discovery or `ludens workspace eval` Fails

- **Static discovery error in `ludens-core controller list` or Capabilities (`?view=caps`)**: Verify every `@capability` is a synchronous `def` with a non-empty docstring, supported annotations (`str`, `int`, `float`, `bool`, `list[T]`, `dict[str, T]`, `Optional[T]` / `T | None`), JSON literal defaults, and no `*args` / `**kwargs` / unsupported external decorators.
- **Capability shows `stale` or `adapting`**: Run `ludens workspace eval list` and `ludens workspace eval run <eval-id>` (or in-sandbox `ludens-core eval ...`) to view the exact failure trace and `codeSHA` mismatch. If marked `adapting` from `adapt`, reproduce the failure in `@eval_env` first so the old capability fails, then fix the capability and re-run `ludens workspace eval run <eval-id>` until status returns to `verified`.

## 4. Deep Logging, CLI Inspection & Foreground Isolation

For issues that vanish under normal summary sampling, raise diagnostics to `full` so nested Python calls and Baseware read-only queries are recorded in `logs/<run-id>/diagnostics.jsonl` and `logs/baseware/`:

```sh
ludens-core run --device-only --diagnostics full
```

Notice the `--device-only` flag on `ludens-core run`: it brings up device links and resident `perception.py` sampling without issuing any LLM requests, making it ideal for verifying camera streams, `epoch` leases, and `perception.py` startup cleanly.

To test a driver transport independently before launching a full workspace:

```sh
baseware serve --driver cua --machine-id local-desktop --diagnostics full
```

To inspect archived logs directly from the command line over RPC:

```sh
ludens logs events --run logs/<run-id> --diagnostics
ludens logs read --run logs/<run-id> --event <seq> --field <name> --full
```

See [Logging Reference](../reference/logging.md) and [CLI Reference](../reference/cli.md) for event schema details and all `ludens logs` flags.

## 5. Running Targeted Verification Checks

Before reporting a bug or validating local workspace toolchain changes across the monorepo, run the relevant checks across the 6 packages (typecheck and tests for the layer you touched):

```sh
# 1. Protocol schemas, DTOs, and contracts
(cd protocol && bun run typecheck && bun test)

# 2. Baseware drivers, transports, and leases
(cd baseware && bun run typecheck && bun test)

# 3. Core execution sandbox, Python SDK, and model transport
(cd core && bun run typecheck && bun run typescript:test && bun run python:test)

# 4. Server control plane, query engine, and RPC router
(cd server && bun run typecheck && bun test)

# 5. Client Console static build, UI unit tests, and pure-RPC ludens CLI tests
(cd client && npm run build && npm run typecheck && npm test)

# 6. Desktop Electron shell build and spec tests
(cd desktop && npm run desktop:typecheck && npm run desktop:build && npm run desktop:test)
```

Optional targeted checks when diagnosing specialized subsystems:

- `(cd core && bun run python:typecheck)` and `(cd core && bun run omp:test:transport)`: Python typing and model transport suites
- `(cd server && bun run perf)` (or archive memory baseline runner): Console multi-megabyte archive query and memory baseline check

When reporting an issue, always record the exact failing command output, `logs/<run-id>/manifest.json`, and any relevant **Replay** timestamp or `record-id`.
