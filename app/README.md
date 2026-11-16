# @ludens/app

First-class **Ludens Desktop App** (Electron) and shared responsive **Vite Static SPA Console** for Ludens workspaces. Desktop, hosted web, remote, and mobile clients share the same React 19, Vite, Tailwind CSS 4, and shadcn/ui codebase communicating over `@ludens/protocol/app-rpc` JSON-RPC 2.0 (`events/subscribe` + `sinceSeq` catch-up and dual-plane `MediaResolver`) backed by `@ludens/core`'s unified `ludens app-server` — with zero Next.js runtime anywhere.

## Architecture & Host Modes

- **Ludens Desktop App (`app/bin/ludens-app` / packaged installer, Zero Listening TCP Ports)**: Uses Pure-Node `ensureLocalAppDaemon` per `LUDENS_HOME` to start or reuse a singleton `ludens app-server` over a Unix Domain Socket (`app-server.sock`) with **0 listening TCP ports**. Registers `ludens-app://console/` for packaged static SPA assets and `ludens-media://local/media?...` for local media over UDS `media/resolve` (with HTTP `206 Partial Content` `Range` support). Bridges renderer and `PetSessionCoordinator` calls through `window.ludens.rpc`, minimizes to tray on close (`×`), and applies `ActiveCoreQuitGuard` on Quit (`⌘Q` / tray Quit): exits immediately while keeping the background daemon alive when 0 Cores are running, or offers a 3-choice dialog (**Keep Running in Background**, **Stop All Cores & Quit**, or **Cancel**) when active Cores exist.
- **Hosted Web / Remote Mode (`ludens app-server` / `ludens daemon start`)**: Builds the static SPA into `app/out/` and serves it alongside WebSocket JSON-RPC `/rpc`, HMAC capability-ticket `/media` (`mt=`, `206 Range`), and `/health`. URL hash bootstraps (`http(s)://host:port/#token=...`) capture credentials and immediately scrub `#token=` from the URL via `history.replaceState`.
- **Web Dev Mode (`npm run dev`)**: Runs `scripts/dev.mjs`, starting a local `ludens app-server` and Vite dev server (default `127.0.0.1:3015`) proxying `/rpc` (WS), `/media`, and `/health` for instant HMR in any browser.
- **Mobile & Multi-Target Console (`<ConnectionTargetDialog>`)**: The responsive SPA switches cleanly between `electron-local` (Desktop IPC), `same-origin` (hosted WebSocket `/rpc`), and `remote` (`ws://` / `wss://` + token) targets, keeping the transport ready for future Outbound Relay extensions.

## Console Views

- **Live (`?view=live`)**: Real-time Auto Run controls (**Start Auto Run**, urgent mid-turn `steer`, **Reclaim Control**, `consolidate`), a duplex **Event Pool** composer (`ludens event`) with outbound Help Request / Notice triage (Reply, Reply & Resume, Mark Handled), header pending badges, multi-node viewport switching (`[machineId]`), and live activity trace.
- **Replay (`?view=replay`)**: Bounded 30-second fMP4 frame window scrubber, millisecond timestamp jump, full-archive event search, and recorded model-input evidence inspector.
- **Performance (`?view=perf`)**: Per-request latency breakdown, token/cache telemetry, and compaction timeline analysis.
- **Capabilities (`?view=caps`)**: Visual **Capability – Eval – Env** triad topology, 3-way stale drift attribution, reward evolution charts, and 1-click **Run All Evals** / **Run Eval**.
- **Config (`?view=perception`)**: Unified 6-tab workspace configuration panel (**Model & Budget**, **Target Device**, **Connection & Transport**, **Services & Session** with 1-click `up` / `reload` / `down` and inline `MEMORY.md` editor, **Perception Recording**, and **Loop Simulator**).
- **Devices (`?view=baseware`)**: **Baseware** driver library (`~/.ludens/drivers.json` + workspace discovery) and Master-Detail **Controlled Nodes** hub (`~/.ludens/machines.json` + inline `workspace-default` endpoints) separating registration, workspace assignment, and live mounting with connectivity probes and Controller Interfaces inspection.
- **Workspaces (`?view=workspaces`)**, **Docs (`?view=docs`)**, **Settings (`?view=settings`)**, and **Developer (`?view=dev`)**.

## Scripts

```sh
cd app && npm run dev            # Auto-spawn ludens app-server + Vite dev proxy (default 127.0.0.1:3015, or -- --port 3099)
cd app && npm run build          # Static Vite SPA build (app/out/) + Electron bundle (app/dist/electron/)
cd app && npm run build:check    # Verify app/out/index.html & app/out/.ludens-build.json match sources
cd app && npm start              # Serve app/out/ via ludens app-server --listen ws://127.0.0.1:3015 --static-dir app/out
cd app && npm run desktop:start  # Launch Ludens Desktop App directly
cd app && npm run desktop:pack   # Build unpacked desktop bundle via electron-builder (--dir)
cd app && npm run desktop:dist   # Build macOS (.dmg/.zip) or Windows (NSIS .exe) installer in app/release/
cd app && npm run typecheck      # Web & desktop TypeScript check
cd app && npm test               # Run console & desktop test suites
```

## Desktop CLI Flags & Chrome

- **CLI Flags**: `--workspace <path>` (initial workspace), `--server <url>` / `--dashboard <url>` (override `ludens-app://console/` to load an external Vite dev or hosted origin), `--profile <path>` (override `~/.ludens/desktop/profile`), `--background` (launch hidden in tray), `--show-window`, and `--help`.
- **Unified 38px Titlebar**: Frameless `#090a0d` desktop window across macOS (`titleBarStyle: "hiddenInset"`, centered traffic lights) and Windows 10/11 (`titleBarStyle: "hidden"` with native Window Controls Overlay and no legacy in-window menu bar).
- **Window State & Shortcuts**: Persists bounds/maximized/fullscreen state in `window-state.json` with multi-display clamping; supports `Cmd/Ctrl+B` (toggle sidebar), `Cmd/Ctrl+K` (quick switcher), and `Cmd/Ctrl+[` / `]` (back/forward).
- **Platform Launchers**: Use `app/bin/ludens-app` on macOS/Linux or `app/bin/ludens-app.cmd` on Windows.
- **Browser Preview**: Append `?desktopPreview=darwin` or `?desktopPreview=win32` to preview desktop titlebar chrome in any browser.

## Documentation

- [Console & Debugging Tutorial](../docs/en/tutorials/console-and-debugging.md)
- [Quick Start and Workspace Lifecycle](../docs/en/tutorials/quickstart.md)
- [Internal UI & Desktop Engineering Contract](DESIGN.md)
