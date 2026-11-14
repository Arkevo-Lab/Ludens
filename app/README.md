# @ludens/app

First-class **Ludens Desktop App** (Electron) and shared static SPA observability & control **Console** for Ludens workspaces. Both the desktop app and browser mode share the same React 19, Tailwind CSS 4, and shadcn/ui primitives backed by `@ludens/core`'s unified `ludens app-server` — with zero Next.js server runtime in production.

## Architecture & Host Modes

- **Ludens Desktop App (`app/bin/ludens-app` / packaged installer)**: Automatically spawns and supervises `ludens app-server --port 0 --parent-watchdog --static-dir <out>` on launch, opens the main Console window alongside the tray icon (plus optional **Desktop Pet** widget), minimizes to tray on close (`×`), and tears down `app-server` plus any UI-managed workspace processes cleanly on Quit (`⌘Q`, tray Quit, or `stdin` watchdog exit).
- **Web Dev Mode (`npm run dev`)**: Runs `scripts/dev.mjs`, spawning an ephemeral `ludens app-server` (`--port 0 --parent-watchdog --trusted-origin`) and proxying `/api/*` from `next dev` for instant HMR in any browser.
- **Static Production Server (`npm run build && npm start`)**: Exports pure static SPA assets into `app/out/` (stamped at `app/out/.ludens-build.json`) and serves them directly from `ludens app-server`.

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
cd app && npm run dev            # Auto-spawn ludens app-server + Next dev proxy (default :3015, or -- --port 3099)
cd app && npm run build          # Static SPA export (app/out/) + Electron bundle (app/dist/electron/)
cd app && npm run build:check    # Verify app/out/index.html & app/out/.ludens-build.json match sources
cd app && npm start              # Serve app/out/ via ludens app-server on 127.0.0.1:3015
cd app && npm run desktop:start  # Launch Ludens Desktop App directly
cd app && npm run desktop:pack   # Build unpacked desktop bundle via electron-builder (--dir)
cd app && npm run desktop:dist   # Build macOS (.dmg/.zip) or Windows (NSIS .exe) installer in app/release/
cd app && npm run typecheck      # Web & desktop TypeScript check
cd app && npm test               # Run console & desktop test suites
```

## Desktop CLI Flags & Chrome

- **CLI Flags**: `--workspace <path>` (initial workspace), `--server <url>` / `--dashboard <url>` (attach to an external local dev server instead of spawning `app-server`), `--profile <path>` (override `~/.ludens/desktop/profile`), `--background` (launch hidden in tray), `--show-window`, and `--help`.
- **Unified 38px Titlebar**: Frameless `#090a0d` desktop window across macOS (`titleBarStyle: "hiddenInset"`, centered traffic lights) and Windows 10/11 (`titleBarStyle: "hidden"` with native Window Controls Overlay and no legacy in-window menu bar).
- **Window State & Shortcuts**: Persists bounds/maximized/fullscreen state in `window-state.json` with multi-display clamping; supports `Cmd/Ctrl+B` (toggle sidebar), `Cmd/Ctrl+K` (quick switcher), and `Cmd/Ctrl+[` / `]` (back/forward).
- **Platform Launchers**: Use `app/bin/ludens-app` on macOS/Linux or `app/bin/ludens-app.cmd` on Windows.
- **Browser Preview**: Append `?desktopPreview=darwin` or `?desktopPreview=win32` to preview desktop titlebar chrome in any browser.

## Documentation

- [Console & Debugging Tutorial](../docs/en/tutorials/console-and-debugging.md)
- [Quick Start and Workspace Lifecycle](../docs/en/tutorials/quickstart.md)
- [Internal UI & Desktop Engineering Contract](DESIGN.md)
