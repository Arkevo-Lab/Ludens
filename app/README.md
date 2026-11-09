# @ludens/app

Browser-first Next.js 16 observability and control console for Ludens workspaces, plus the optional Electron **Ludens Pet** desktop companion. Both the web console (`http://127.0.0.1:3015`) and the desktop app share the same React 19, Tailwind CSS 4, and shadcn/ui component primitives; Electron is not required for UI development or daily console use.

## Console Views

- **Live (`?view=live`)**: Real-time **Shiori Loop Cockpit** (`auto on`, `steer`, `follow_up`, `auto off`, `consolidate`), multi-machine observation stream switcher (`[machineId]`), and live activity trace.
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
cd app && bun test           # Run console test suite
```

## Documentation

- [Dashboard UI and Interaction Contract](../docs/en/reference/dashboard-ui.md)
- [Console Debugging and Verification](../docs/en/tutorials/debugging-and-verification.md)
- [Install and Workspace Lifecycle](../docs/en/tutorials/quickstart.md)
