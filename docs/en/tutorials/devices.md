# Devices & Baseware

**Baseware** is Ludens's **cross-device integration layer**. It wraps heterogeneous desktop automation backends, camera or sensor feeds, robotics/embedded hardware bridges, simulators, and remote MCP endpoints behind a unified controller schema (`baseware.json`), while enforcing single-lease `epoch` control arbitration so hardware or UI inputs never misfire after **Reclaim Control**.

For protocol-level contracts, read [Baseware Reference](../reference/baseware.md) and [Driver Bridge Protocol](../reference/driver-bridge-protocol.md).

## 1. First-Class Built-in Browser (`browser`) & Device Viewport

When running **Ludens Desktop (`ludens-app`)**, you can play Three.js / WebGL games and web targets immediately with zero simulator, CUA permission, or hardware-bridge setup:

- **Runtime Auto-Injection**: Ludens Desktop starts a local zero-TCP-port `BrowserHost` over Unix Domain Socket (`<LUDENS_HOME>/run/browser-host.sock`). `ludens-server` probes `BrowserHost` at runtime and automatically injects the **`builtin:browser`** driver and **`builtin-browser`** controlled node into the Console and workspace launcher. When the Desktop App is not running, `builtin-browser` is not spuriously injected; existing browser workspaces show an offline status and resume automatically once Desktop is started again.
- **Creating a Browser Workspace**:
  - **In Console**: Click **New Workspace**, select the first-class **Built-in Browser** target, and optionally enter an **Initial URL** (leaving it blank loads the built-in zero-dependency 3D WebGL interactive starter page `ludens-browser://start`).
  - **Via CLI**:

```sh
ludens workspace init --name webgl-play --driver browser --url https://example.com/game
cd "$HOME/.ludens/workspaces/webgl-play"
ludens workspace up
```

  `ludens workspace init --driver browser` generates a ready-to-run 30 Hz `screen.capture` `perception.py` template out of the box.
- **Per-Workspace Isolated Spaces**: Each browser workspace owns an isolated `WebContentsView` keyed by `sessionId = workspaceId` with dedicated persistent storage (`persist:ludens-browser-<sessionId>`), `backgroundThrottling: false`, and background keepalive—so multiple browser workspaces run concurrently without cross-talk, switching workspaces flips pages instantly, and 30 Hz capture continues even when a workspace is in the background. You can also browse and warm up the page in `Manual` mode before starting the workspace Core; the same `sessionId` is seamlessly handed over when Core starts.
- **`Manual` Play vs `Auto` Takeover & `Reclaim Control` Key-Release Guarantee**:
  - In **`Manual`** mode, you interact directly with the embedded browser (mouse, wheel, keyboard, Pointer Lock 3D camera, and address bar).
  - In **`Auto`** mode, Baseware's `epoch` control gate blocks human passthrough input while Shiori and `perception.py` drive the page via `screen.capture`, `page.*`, `keyboard.*`, `mouse.*` (including `mouse.moveRelative` for Pointer Lock), and `input.play`.
  - Clicking **Reclaim Control** (or running `ludens auto off`) immediately cancels any in-flight `input.play` sequence and triggers `release(epoch)` → `session.releaseAll`, releasing every held key and mouse button so no input ever stays stuck.
- **Unified `<DeviceViewport />` & Web Console `/viewport` Streaming**:
  - In **Ludens Desktop (`electron-local`)**, `<DeviceViewport />` attaches the native `WebContentsView` directly into the resizable right workbench (`0ms` WebGL rendering + native audio) and automatically falls back to the latest static frame whenever a modal dialog overlays the window.
  - In **Web Console, mobile browsers, or remote clients**, `<DeviceViewport />` connects to `ludens-server`'s HMAC-authenticated `/viewport` binary WebSocket stream (rendering frames via `createImageBitmap` with drop-oldest backpressure) and forwards `Manual` mouse, wheel, keyboard, and Pointer Lock input back to the host.

## 2. Built-in Desktop Target (`cua`)

Ludens also ships with the built-in `cua` (`builtin:cua`) desktop automation driver and a default `local-desktop` machine entry over `stdio` MCP transport. It works out of the box with zero external driver package:

```sh
ludens workspace init --name desktop-monitor --driver cua
cd "$HOME/.ludens/workspaces/desktop-monitor"
ludens workspace up
```

If you want `cua` to launch a custom server command, pass `--cua-command <path>` to `ludens workspace init` or set `cuaCommand` in `ludens.json` (or `--cua-command <path>` when running `baseware serve --driver cua` directly).

To test the built-in desktop target from a terminal while running:

```sh
ludens-core controller list
ludens-core controller controller/screenshot --help
```

## 3. Five Transports & Driver Packages

Baseware separates driver manifests (`~/.ludens/drivers.json`) from controlled machine definitions (`~/.ludens/machines.json`), supporting five transport protocols across local and remote nodes:

| Transport | Typical Target | Key Parameters / CLI Flags |
| --- | --- | --- |
| `stdio` | Built-in `browser` / `cua` desktop drivers or local subprocess driver | `--driver browser [--initial-url <url>]`, `--driver cua [--cua-command <path>]`, or `--transport stdio` |
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

## 4. Managing Drivers & Nodes in Console (`Devices`, `?view=baseware`)

Open **Devices** (`?view=baseware`, titled **Devices & Nodes · Baseware**) in the Console sidebar to configure drivers and machines visually without hand-editing JSON:

- **Driver Packages tab**: Lists installed and workspace-local driver packages alongside their resolved sources. Click **Add Driver** to register an external npm, GitHub, or `file:` driver into `~/.ludens/drivers.json`.
- **Controlled Devices tab**: Lists all nodes in `~/.ludens/machines.json` plus any synthesized `workspace-default` endpoint. Click **New Machine** to add a `stdio`, `bridge`, `ssh`, `http`, or `sse` node and save its host, port, URL, or SSH parameters.
- **Node & Controllers drawer tab**: Select any node to test connectivity, activate the primary node or mount multiple nodes concurrently in the active workspace, inspect live controller schemas, and run quick test calls.
- **Daemon & Lease drawer tab**: Inspect Baseware socket status, current `epoch` control lease state, reconnect history, or revoke active device control immediately.

You can also pin the active target device for a workspace in Console **Config** (`?view=perception`) under **Target Device**.

## 5. Multi-Machine Mounting & Tool Routing

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
ludens-core machine list
ludens-core machine connect local-desktop lab-bench-ssh
ludens-core machine use lab-bench-ssh
ludens-core machine disconnect edge-sensor-http
```

Equivalent direct `baseware` commands are `baseware machine list`, `baseware machine use <id>`, `baseware machine connect <id> [<id2> ...]`, and `baseware machine disconnect <id>`.

### Routing Controller Calls Across Machines

When multiple machines are mounted concurrently:

- **Primary route (unprefixed)**: `controller/<tool>` routes to the currently active primary machine.
- **Explicit node route (prefixed)**: `controller/<machineId>/<tool>` targets a specific mounted node regardless of which node is primary.

CLI examples:

```sh
ludens-core controller controller/screenshot
ludens-core controller controller/lab-bench-ssh/gpio.read --args '{"pin":4}'
ludens-core controller controller/gpio.read --machine lab-bench-ssh --args '{"pin":4}'
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

## 6. Standalone Baseware CLI & Resilience

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
