# @ludens/app

Browser-first Next.js 16 observability and control console for Ludens workspaces, plus the optional Electron **Ludens Pet** desktop companion. Both the web console (`http://127.0.0.1:3015`) and the desktop app share the same React 19, Tailwind CSS 4, and shadcn/ui component primitives; Electron is not required for UI development or daily console use.

## Console Views

- **Live (`?view=live`)**: Real-time **Shiori Loop Cockpit** (`auto on`, urgent mid-turn `steer`, `auto off`, `consolidate`), a duplex **Event Pool** composer mode (`ludens event`) with an outbound Help Request / Notice tray (Reply, Reply & Resume, Mark Handled), header pending badges, and stream cards/bubbles, plus a multi-machine observation stream switcher (`[machineId]`) and live activity trace.
- **Replay (`?view=replay`)**: Bounded 30-second fMP4 frame window scrubber, millisecond timestamp jump, full-archive event search, and recorded model-input evidence inspector.
- **Performance (`?view=perf`)**: Per-request latency breakdown, token/cache telemetry, and compaction timeline analysis.
- **Capabilities (`?view=caps`)**: Visual **Capability – Eval – Env** triad topology, 3-way stale drift attribution, reward evolution charts, and 1-click **Run All Evals** / **Run Eval**.
- **Config & Studio (`?view=perception`)**: Unified 5-tab workspace workbench (**Model & Budget**, **Connection & Multimodal Transport**, **Services & Session** with 1-click `up` / `reload` / `down` and inline `MEMORY.md` editor, **Perception Recording**, and **Loop Simulator**).
- **Baseware (`?view=baseware`)**: Master-Detail **Controlled Node Hub** for managing `~/.ludens/machines.json`, 1-click workspace node mounting (`use` / `connect` / `disconnect`), connectivity probes, and Controller Interfaces catalog.
- **Workspaces (`?view=workspaces`)**, **Docs (`?view=docs`)**, and **Settings (`?view=settings`)**.

## Scripts

```sh
cd app && npm run dev        # Start local web console on http://127.0.0.1:3015
cd app && npm run typecheck  # Next.js route typegen + web & desktop tsc
cd app && npm test           # Run console & desktop test suites
```

## Desktop Chrome & Launch

- **Unified 38px Titlebar**: Frameless `#090a0d` desktop window across macOS (`titleBarStyle: "hiddenInset"`, centered traffic lights) and Windows 10/11 (`titleBarStyle: "hidden"` with native Window Controls Overlay and no legacy in-window menu bar).
- **Window State & Shortcuts**: Persists bounds/maximized/fullscreen state in `window-state.json` with multi-display clamping; supports `Cmd/Ctrl+B` (toggle sidebar), `Cmd/Ctrl+K` (quick switcher), and `Cmd/Ctrl+[` / `]` (back/forward).
- **Windows Launch**: Use `app/bin/ludens-app.cmd` on Windows (or `app/bin/ludens-app` on macOS/Linux).
- **Browser Preview**: Append `?desktopPreview=darwin` or `?desktopPreview=win32` to `http://127.0.0.1:3015` to preview desktop titlebar chrome in any browser.

## Documentation

- [Dashboard UI and Interaction Contract](../docs/en/reference/dashboard-ui.md)
- [Console Debugging and Verification](../docs/en/tutorials/debugging-and-verification.md)
- [Install and Workspace Lifecycle](../docs/en/tutorials/quickstart.md)
