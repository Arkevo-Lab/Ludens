# `@ludens/desktop`

All-in-One Electron desktop shell (`ludens-app`) for Ludens.

- Serves the `@ludens/client` static bundle (`../client/out`, or `process.resourcesPath/out` when packaged) over `ludens-app://console/` and streams media via `ludens-media://local/media`.
- Ensures the local zero-port UDS `@ludens/server` daemon (`ludens-server`) for the active `LUDENS_HOME` and exposes a single-instance window, system tray, `ActiveCoreQuitGuard`, and Desktop Pet companion.
- Supports switching to any remote `ludens-server` directly from the Console connection dialog.

## Commands

```bash
bun run build       # Bundle Electron main/preload/companion-preview into dist/electron/
bun run dev         # Build desktop shell and start Vite dev server + Electron window
bun run typecheck   # Type-check desktop/src
bun run test        # Run desktop Vitest specification suite
bun run pack        # Build client + desktop and create unpacked Electron app
bun run dist        # Build client + desktop and package installers
```
