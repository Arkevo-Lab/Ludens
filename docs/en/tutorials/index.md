# Tutorials

Ludens is a multimodal, cross-device Harness for complex end-to-end tasks—including robotics control, security and surveillance, desktop and software workflows, and real-time games. These five hands-on guides take you from installation and first launch to multi-machine device integration, capability verification, resident perception loops, and Console debugging.

If you want to understand the core design—including **Shiori** (Ludens's Agent Thread Core), **Baseware** (the cross-device integration layer), and the perception-action loop—before running commands, read [Concepts Overview](../concepts/overview.md) first.

## Recommended Reading Order

| Step | Guide | What You Will Accomplish |
| --- | --- | --- |
| 1 | [Quickstart](quickstart.md) | Install dependencies, launch Ludens via the zero-port Desktop App, hosted Web/Remote SPA, unified CLI (`ludens daemon` / `--remote`), or mobile multi-target Console, start **Auto Run**, steer via the Event Pool, and **Reclaim Control** |
| 2 | [Devices & Baseware](devices.md) | Configure built-in CUA desktop automation and external driver packages across `stdio`, `bridge`, `ssh`, `http`, and `sse`, and route tools across multiple machines |
| 3 | [Workspace, Capabilities & Self-Verification](workspace.md) | Organize `ludens.json`, `MEMORY.md`, `skills/`, and `perception.py`; build `@capability`, `@eval_env`, and `@eval_capability` loops; run `ludens eval` and inspect results in **Capabilities** |
| 4 | [Perception, Action & Performance Tuning](perception-and-action.md) | Write and hot-reload resident `perception.py` state machines, query 30 Hz fMP4 archives with `Client.observe()`, configure multimodal transport and image URL offloading, and tune latency |
| 5 | [Console Operations & Debugging](console-and-debugging.md) | Operate every **Console** view, inspect timeline evidence in **Replay**, diagnose stalled control cycles and capability failures, check daemon/socket health, and run verification suites |

## Related Documentation

- **Concepts**: [Overview](../concepts/overview.md), [Loop and Control](../concepts/loop-and-control.md), and [Self-Verification](../concepts/self-verification.md)
- **Reference**: [CLI Reference](../reference/cli.md), [Architecture](../reference/architecture.md), [Baseware](../reference/baseware.md), [Driver Bridge Protocol](../reference/driver-bridge-protocol.md), and [Logging](../reference/logging.md)
- **Insights**: [Technical Insights](../insights/index.md)
