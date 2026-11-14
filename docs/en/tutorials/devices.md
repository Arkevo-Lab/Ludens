# Devices & Baseware

**Baseware** is Ludens's **cross-device integration layer**. It wraps heterogeneous desktop automation backends, camera or sensor feeds, robotics/embedded hardware bridges, simulators, and remote MCP endpoints behind a unified controller schema (`baseware.json`), while enforcing single-lease `epoch` control arbitration so hardware or UI inputs never misfire after **Reclaim Control**.

For protocol-level contracts, read [Baseware Reference](../reference/baseware.md) and [Driver Bridge Protocol](../reference/driver-bridge-protocol.md).

## 1. Built-in Desktop Target (`cua`)

Ludens ships with the built-in `cua` (`builtin:cua`) desktop automation driver and a default `local-desktop` machine entry over `stdio` MCP transport. It works out of the box with zero external driver package:

```sh
ludens init --name desktop-monitor --driver cua
cd "$HOME/.ludens/workspaces/desktop-monitor"
ludens up
```

If you want `cua` to launch a custom server command, pass `--cua-command <path>` to `ludens init` or set `cuaCommand` in `ludens.json` (or `--cua-command <path>` when running `baseware serve --driver cua` directly).

To test the built-in desktop target from a terminal while running:

```sh
ludens controller list
ludens controller controller/screenshot --help
```

## 2. Five Transports & Driver Packages

Baseware separates driver manifests (`~/.ludens/drivers.json`) from controlled machine definitions (`~/.ludens/machines.json`), supporting five transport protocols across local and remote nodes:

| Transport | Typical Target | Key Parameters / CLI Flags |
| --- | --- | --- |
| `stdio` | Local MCP desktop driver (`cua`) or local subprocess driver | `--driver cua [--cua-command <path>]` or `--transport stdio` |
| `bridge` | Local or LAN TCP line-protocol device / simulator / hardware bridge | `--transport bridge --host <host> --port <n>` |
| `ssh` | Remote host exposed over SSH stdio tunnel (`ssh -o BatchMode=yes`) | `--transport ssh --ssh-host <host> --ssh-user <user> --ssh-port <n> --ssh-identity <path> --ssh-command <cmd>` |
| `http` | Streamable HTTP MCP device or service endpoint | `--transport http --url <url>` |
| `sse` | Server-Sent Events MCP endpoint | `--transport sse --url <url>` |

### Installing & Discovering External Driver Packages

External drivers are loaded via `--driver <id> --driver-package <spec>` (or stored in `~/.ludens/drivers.json` via Console **Devices**). `<spec>` supports three formats:

1. **npm package**: e.g. `@scope/driver-pkg@1.2.0` (cached under `~/.local/state/ludens/baseware/drivers/` or `$XDG_STATE_HOME/ludens/baseware/drivers/`)
2. **GitHub repository**: e.g. `github:org/repo#commit-sha`, HTTPS URL, or `git@github.com:org/repo.git#rev` (pin exact commit SHAs for reproducible runs)
3. **Local directory or entry module**: e.g. `file:/abs/path/to/driver` or `file:./drivers/my-driver`

Before wiring an external driver into a workspace, validate its exported `DriverRegistration` manifest without connecting to hardware:

```sh
baseware driver discover --package 'file:/path/to/my-driver'
```

`baseware driver discover` installs dependencies and imports the package entry to emit the validated `DriverManifest` JSON, without calling `load()`. Because package installation scripts and module top-level code still execute locally during discovery, only inspect and load driver packages from trusted sources.

## 3. Managing Drivers & Nodes in Console (`Devices`, `?view=baseware`)

Open **Devices** (`?view=baseware`, titled **Devices & Nodes · Baseware**) in the Console sidebar to configure drivers and machines visually without hand-editing JSON:

- **Driver Packages tab**: Lists installed and workspace-local driver packages alongside their resolved sources. Click **Add Driver** to register an external npm, GitHub, or `file:` driver into `~/.ludens/drivers.json`.
- **Controlled Devices tab**: Lists all nodes in `~/.ludens/machines.json` plus any synthesized `workspace-default` endpoint. Click **New Machine** to add a `stdio`, `bridge`, `ssh`, `http`, or `sse` node and save its host, port, URL, or SSH parameters.
- **Node & Controllers drawer tab**: Select any node to test connectivity, activate the primary node or mount multiple nodes concurrently in the active workspace, inspect live controller schemas, and run quick test calls.
- **Daemon & Lease drawer tab**: Inspect Baseware socket status, current `epoch` control lease state, reconnect history, or revoke active device control immediately.

You can also pin the active target device for a workspace in Console **Config** (`?view=perception`) under **Target Device**.

## 4. Multi-Machine Mounting & Tool Routing

A workspace can authorize a pool of controlled machines (`machines.allowed`) and designate one primary machine (`machines.active`) in `ludens.json`. For example:

```json
{
  "driver": "cua",
  "machines": {
    "active": "local-desktop",
    "allowed": ["local-desktop", "lab-bench-ssh", "edge-sensor-http"]
  }
}
```

### Runtime Switching & Mounting via CLI

Switch the primary machine or mount/unmount nodes live without restarting Baseware or your workspace:

```sh
ludens machine list
ludens machine connect local-desktop lab-bench-ssh
ludens machine use lab-bench-ssh
ludens machine disconnect edge-sensor-http
```

Equivalent direct `baseware` commands are `baseware machine list`, `baseware machine use <id>`, `baseware machine connect <id> [<id2> ...]`, and `baseware machine disconnect <id>`.

### Routing Controller Calls Across Machines

When multiple machines are mounted concurrently:

- **Primary route (unprefixed)**: `controller/<tool>` routes to the currently active primary machine.
- **Explicit node route (prefixed)**: `controller/<machineId>/<tool>` targets a specific mounted node regardless of which node is primary.

CLI examples:

```sh
ludens controller controller/screenshot
ludens controller controller/lab-bench-ssh/gpio.read --args '{"pin":4}'
ludens controller controller/gpio.read --machine lab-bench-ssh --args '{"pin":4}'
```

Python `ludens_tools` offers matching multi-machine helpers (`machines()`, `use_machine()`, `connect_machines()`, `disconnect_machines()`, and `call(..., machine=...)`):

```python
from ludens_tools import call, connect_machines, machines, use_machine

connect_machines("local-desktop", "lab-bench-ssh")
print(machines())

# Route explicitly to a secondary node while keeping local-desktop primary
telemetry = call("controller/gpio.read", {"pin": 4}, machine="lab-bench-ssh")
use_machine("lab-bench-ssh")
```

## 5. Standalone Baseware CLI & Resilience

When debugging a single hardware adapter outside a workspace, run `baseware` directly in the foreground:

```sh
baseware serve --driver cua --machine-id local-desktop --diagnostics full
```

Useful `baseware` diagnostic and recovery commands:

- `baseware status` / `baseware list`: Inspect connected drivers, mounted nodes, and exported controller count
- `baseware export [--output baseware.json]`: Export the live capability catalog snapshot
- `baseware reconnect [--machine <id>]`: Force a driver reconnect on a dropped node
- `baseware revoke`: Immediately revoke any active hardware control lease (`DISOWN` / `release()`)
- `baseware mcp`: Expose Baseware's controller pool as a standard MCP stdio server

During an active **Auto Run**, if the primary device drops cleanly or crashes, Baseware's background resync loop detects recovery and **Ludens** attempts automatic reconnection before pausing and returning to **Manual Standby** if all reconnect attempts fail. To inspect driver logs or troubleshoot socket disconnects, continue to [Console Operations & Debugging](console-and-debugging.md).
