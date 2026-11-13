# Devices & driver setup

Each driver only exposes a device's native input and capture capabilities — no game strategy, cross-screen coordinate fusion, or automatic save/load logic. This page follows the [core installation](quickstart.md#install); once device and driver setup is done, continue with [Starting and stopping workspaces](quickstart.md#starting-and-stopping-workspaces) to create and launch a workspace.

Only the `cua` desktop adapter is built into the main repository. Emulator and custom hardware drivers are loaded on demand as external packages (`--driver-package`); the main repository does not bundle emulator binaries, native bridges, or build patches.

## Cua

The desktop environment uses the stock upstream [Cua Driver](https://github.com/trycua/cua/tree/main/libs/cua-driver):

1. Install Cua Driver, and in macOS **System Settings → Privacy & Security** grant `CuaDriver.app` **Accessibility** and **Screen Recording** permissions.
2. Baseware attaches the driver through a persistent `cua-driver mcp` child process (stdio transport); no `game` or bridge port is needed. If `cua-driver` is not on `PATH`, specify the absolute path via `ludens init --cua-command` or the `ludens.json` `cuaCommand` field.
3. All tools keep their upstream names and JSON parameter shapes (e.g. `ludens controller controller/get_desktop_state --args '{}'`); for contract boundaries see [Baseware design & capability contracts](../reference/baseware.md).

**Desktop environment boundaries**: multiple Cua workspaces share the same host's real desktop; use a separate OS session or VM for an isolated desktop. Handing control back to a human immediately rejects new inputs and requests cancellation, but a single native call already inside the OS may still finish; `ludens down` does not close the shared `CuaDriver.app` or the user's desktop apps.

## Discovering & connecting external driver packages

Enter the exact address in the labeled **Driver package address** field. On narrow screens the verification button sits below the full-width input. Editing the address cancels an outstanding verification and clears its result; a late response cannot validate a different address.

The Dashboard **Workspaces → New workspace → Community driver package** form validates a package only after you choose **Verify driver package**. A successful result means its registration declaration imported and passed validation; it does not connect to a device, build an emulator, or prove that a game runs. Creation is a separate explicit action and may download or import the package again. Set a name, review the directory and driver-specific options, then create; the completion card supplies a workspace-scoped `up` command to run in a terminal when ready.

For an existing workspace, follow the configuration instructions below rather than initializing it again. On the **Capabilities (`?view=caps`)** page, the **Workspace sources** section distinguishes the saved `baseware.json` device snapshot from static Python declarations. A missing snapshot calls for service setup; it is not proof of an empty live device. **Host connection check** reads the selected workspace's Host status on load and on demand. The reported control connection is the Host's last-known state, including uncertainty after control errors; it does not verify physical hardware, game output, or individual capability execution.

Non-built-in drivers must select an external package explicitly via `--driver-package`; only the `cua` desktop access is built in. Package addresses accept an npm spec, `github:org/repo#rev`, a GitHub HTTPS URL, `git@github.com:org/repo.git#rev`, or `file:path`. SSH addresses keep SSH transport, and the cache distinguishes transport, repository, and revision. Before initializing a workspace, validate the package's `DriverRegistration` declaration with `baseware driver discover` or the Dashboard Workspaces creation modal (`?view=workspaces&create=1`):

```sh
baseware driver discover --package 'github:org/repo#rev'
ludens init --name my-task --driver <id> --driver-package 'github:org/repo#rev'
```

- **Path resolution**: relative `file:` paths in `ludens init` and `ludens up` resolve against the target workspace directory and are normalized; relative `file:` in `baseware driver discover` resolves against the current shell directory; external-driver validation in the Dashboard web UI requires absolute `file:` paths.
- **Actual source**: the catalog's `drivers[].source`, Baseware `service_start.driverSource`, and Ludens `manifest.drivers[].source` record the source the loader actually resolved: GitHub `resolvedCommit`, npm `resolvedVersion`, or local entry `entrySha256`. The entry hash does not cover dependencies, and `provider.version` still denotes the device or protocol version; see [Package addresses & caching](../reference/baseware.md#1-package-addresses-and-caching) for the fields.
- **Trust boundary**: discovery does not call the driver's `load()`, but it downloads and installs dependencies and imports the package entry code; only run discovery and init against trusted sources. For the driver package spec see [Driver packages & launch descriptions](../reference/baseware.md#driver-packages-and-launch-description) and [Driver Bridge protocol](../reference/driver-bridge-protocol.md).

**Migrating an existing external-driver workspace**: run `ludens auto off`, then `ludens down --keep-emulator`; add or update the matching `driverPackage` in `ludens.json` (pinning the target revision or commit SHA), then run `ludens up --dry-run` / `ludens up`. Do not re-run `ludens init`; the original workspace files and saves are kept. Already-running services do not switch packages just because sources were updated. To attach to an already manually prepared emulator without auto-launching a game file, omit `game`.

## Machine pool & multi-device mounting

Rather than binding to a single static host, Ludens manages a persistent **controlled node pool** in `~/.ludens/machines.json` and allows a workspace to mount multiple devices simultaneously:

1. **Inspect & manage nodes from the CLI** (when running inside a launched workspace shell):
   ```bash
   ludens machine list
   ludens machine use gba-mgba
   ludens machine connect gba-mgba-2
   ludens machine disconnect gba-mgba-2
   ```
2. **Manage drivers & nodes in the Console (`?view=baseware`)**:
   - Open the **Baseware** view to inspect built-in drivers, globally registered entries in `~/.ludens/drivers.json`, and workspace/cache-discovered packages in the **Driver Library** (`data-baseware-section="driver-library"`), with **registration state** separated from **workspace usage state**. Use **Add Driver** (`data-baseware-add-driver`) or card actions (**Register Driver**, **+ Create Node**) to verify manifests and prefill machine creation.
   - In the left-hand **Controlled Nodes** list (`data-baseware-section="machine-pool"`), inspect both globally registered machines and workspace-inline endpoints (`workspace-default`, promotable via **Save to Global Pool…**), with orthogonal badges for **global registration**, **workspace addition** (`Primary`, `Added to Workspace`, `Not Added Here`), and **live mount status**.
   - Click **New Machine** (`data-baseware-add-machine`) to prefill from any driver template or configure custom transports, and inspect controller interfaces and live Baseware daemon leases in the sticky right-hand inspector (`data-baseware-section="controllers-catalog"`).
3. **Target specific devices from Python (`ludens_tools`)**:
   ```python
   import ludens_tools

   # Inspect mounted machines
   print(ludens_tools.machines())

   # Call the primary machine (or pass machine="<machineId>" for any mounted node)
   ludens_tools.call("controller/capture_frame", {}, machine="gba-mgba")
   ludens_tools.call("controller/tap_button", {"button": "A"}, machine="gba-mgba-2")
   ```

