# @ludens/app

First-class **Ludens Desktop App** (Electron) and shared responsive **Vite Static SPA Console** for Ludens workspaces. Desktop, hosted cloud/remote, mobile, and local dev-preview clients share the same React 19, Vite, Tailwind CSS 4, and shadcn/ui codebase communicating over `@ludens/protocol/app-rpc` JSON-RPC 2.0 (`events/subscribe` + `sinceSeq` catch-up and dual-plane `MediaResolver`) backed by `@ludens/core`'s unified `ludens app-server` — with zero Next.js runtime anywhere.

## Three Runtime Surfaces

1. **Desktop App (`app/bin/ludens-app` / packaged installer — `runtimeProfile: "desktop"`, Primary Local Surface)**:
   - Uses Pure-Node `ensureLocalAppDaemon` per `LUDENS_HOME` (default `~/.ludens`) to start or reuse a singleton `ludens app-server` over a Unix Domain Socket (`app-server.sock`) with **0 listening TCP ports** and full `HostSessionCapabilities` (`localFsPaths`, `localFileDrivers`, `hostProcessOverrides`, `hostStorageConfig`).
   - Registers `ludens-app://console/` for packaged static SPA assets and `ludens-media://local/media?...` for local media over UDS `media/resolve` (with HTTP `206 Partial Content` `Range` support). Bridges renderer, native file/directory pickers, and `PetSessionCoordinator` via `window.ludens.rpc` and `window.ludens.dialog.pickPath`.
   - Keeps native desktop chrome clean by hiding the healthy local connection pill on `electron-local` (while `Cmd/Ctrl + K` Quick Switcher can open `<ConnectionTargetDialog>` anytime to connect to a remote server), minimizes to tray on close (`×`), and applies `ActiveCoreQuitGuard` on Quit (`⌘Q` / tray Quit).
2. **Hosted Cloud / Remote Node & Mobile (`ludens serve --listen ws://... --auth token --token-env ...` — `runtimeProfile: "remote"`)**:
   - Serves the static SPA (`app/out/`) alongside WebSocket JSON-RPC `/rpc`, HMAC capability-ticket `/media` (`mt=`, `206 Range`), and `/health`. Mandatory `--auth token` (`--token` or `--token-env`) is enforced whenever `ws://` binds without `--dev`.
   - Enforces `managed-sandbox` capabilities (`localFsPaths: false`, `localFileDrivers: false`, `hostProcessOverrides: false`, `hostStorageConfig: false`): blocks host filesystem escapes on the server (`403 CAPABILITY_RESTRICTED`) and hides host-only path controls across Console forms for a clean cloud SaaS and mobile `<ConnectionTargetDialog>` UX. URL hash bootstraps (`http(s)://host:port/#token=...`) capture credentials and immediately scrub `#token=` via `history.replaceState`.
3. **Frontend & AI Harness Dev Preview (`npm run dev` / `--dev` — `runtimeProfile: "web-dev"`)**:
   - `scripts/dev.mjs` spawns `ludens app-server --dev --listen ws://127.0.0.1:0 --parent-watchdog` and Vite HMR (`127.0.0.1:3015`), isolating `LUDENS_HOME` to `~/.ludens-dev` by default so browser/harness dev previews never collide with or stop your running `~/.ludens` Desktop App daemon.
   - Displays a semantic **`DEV PREVIEW`** pill in the sidebar and provides a Dev UI Simulation switcher inside `<ConnectionTargetDialog>` to preview full host vs `managed-sandbox` cloud/mobile layouts. Use `npm run dev:real` or `npm run desktop:dev` when explicitly testing against `~/.ludens`.

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
cd app && npm run dev            # Isolated web-dev (~/.ludens-dev): ludens app-server --dev + Vite HMR (127.0.0.1:3015)
cd app && npm run dev:real       # Run Vite web-dev against your real ~/.ludens registry
cd app && npm run desktop:dev    # Build Electron shell + run Vite HMR + launch ludens-app --server against ~/.ludens
cd app && npm run build          # Static Vite SPA build (app/out/) + Electron bundle (app/dist/electron/)
cd app && npm run build:check    # Verify app/out/index.html & app/out/.ludens-build.json match sources
cd app && npm start              # Serve app/out/ (--dev on loopback, or --auth token when LUDENS_APP_TOKEN is set)
cd app && npm run desktop:start  # Launch Ludens Desktop App directly
cd app && npm run desktop:pack   # Build unpacked desktop bundle via electron-builder (--dir)
cd app && npm run desktop:dist   # Build macOS (.dmg/.zip) or Windows (NSIS .exe) installer in app/release/
cd app && npm run typecheck      # Web & desktop TypeScript check
cd app && npm test               # Run console & desktop test suites
```

## Desktop CLI Flags & Chrome

- **CLI Flags**: `--workspace <path>` (initial workspace), `--server <url>` (override `ludens-app://console/` to load an external local Vite dev server URL), `--profile <path>` (override `~/.ludens/desktop/profile`), `--background` (launch hidden in tray), `--show-window`, and `--help`.
- **Unified 38px Titlebar**: Frameless `#090a0d` desktop window across macOS (`titleBarStyle: "hiddenInset"`, centered traffic lights) and Windows 10/11 (`titleBarStyle: "hidden"` with native Window Controls Overlay and no legacy in-window menu bar).
- **Window State & Shortcuts**: Persists bounds/maximized/fullscreen state in `window-state.json` with multi-display clamping; supports `Cmd/Ctrl+B` (toggle sidebar), `Cmd/Ctrl+K` (quick switcher + connection target switch), and `Cmd/Ctrl+[` / `]` (back/forward).
- **Platform Launchers**: Use `app/bin/ludens-app` on macOS/Linux or `app/bin/ludens-app.cmd` on Windows.
- **Browser Preview**: Append `?desktopPreview=darwin` or `?desktopPreview=win32` to preview desktop titlebar chrome in any browser.

## Documentation

- [Console & Debugging Tutorial](../docs/en/tutorials/console-and-debugging.md)
- [Quick Start and Workspace Lifecycle](../docs/en/tutorials/quickstart.md)
- [Internal UI & Desktop Engineering Contract](DESIGN.md)
