# `@ludens/desktop`

All-in-One Electron desktop shell (`ludens-app`) for Ludens.

- Serves the `@ludens/client` static bundle (`../client/dist`, or `process.resourcesPath/client` when packaged) over `ludens-app://console/` and streams media via `ludens-media://local/media`.
- Assembles prebuilt autonomous package bundles (`../client/dist`, `../server/dist`, `../core/dist`, `../baseware/dist`) into Electron `extraResources` without cross-compiling sibling packages inside `desktop/`.
- Ensures the local zero-port UDS `@ludens/server` daemon (`ludens-server`) for the active `LUDENS_HOME` and exposes a single-instance window, system tray, `ActiveCoreQuitGuard`, and Desktop Pet companion.
- Supports switching to any remote `ludens-server` directly from the Console connection dialog.

## Atomic Package Commands (`desktop/`)

```bash
bun --cwd=desktop run build       # Bundle Electron main/preload/companion-preview into dist/electron/
bun --cwd=desktop run dev         # Build Electron shell and launch with LUDENS_HOME=~/.ludens-dev (reads LUDENS_DESKTOP_DEV_URL or ../client/dist)
bun --cwd=desktop run start       # Launch compiled Electron shell (dist/electron/main.js)
bun --cwd=desktop run typecheck   # Type-check desktop/src
bun --cwd=desktop run test        # Run desktop Vitest specification suite
bun --cwd=desktop run pack        # Run electron-builder --dir (expects sibling dist/ bundles built)
bun --cwd=desktop run dist        # Run electron-builder installers (expects sibling dist/ bundles built)
bun --cwd=desktop run pet:preview # Interactive Desktop Pet companion preview
bun --cwd=desktop run pet:smoke   # Automated Desktop Pet smoke verification
```

## Full-Stack Root Orchestration

From the repository root, use unified `bun run` scripts:

```bash
bun run dev:desktop       # Vite HMR + Electron native UDS ludens-server (isolated ~/.ludens-dev)
bun run dev:desktop:real  # Vite HMR + Electron native UDS ludens-server (mounts ~/.ludens)
bun run pack:desktop      # Build all packages (dist/) and create unpacked Electron app
bun run dist:desktop      # Build all packages (dist/) and package installers
```
