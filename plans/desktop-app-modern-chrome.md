# Desktop App Modern Chrome & Cross-Platform macOS / Windows UIUX

## Background & Goals

Upgrade `@ludens/app` (Electron Desktop App + shared Next.js Console Shell) from a default OS-framed window into a modern, Antigravity-inspired native desktop workbench across both **macOS (`darwin`)** and **Windows (`win32`)**:

1. **Modern Antigravity-Style Unified 38px Titlebar (`DesktopTitlebar`)**:
   - **macOS (`darwin`)**: `titleBarStyle: "hiddenInset"` with centered traffic lights (`{ x: 14, y: 12 }`), seamless `220px` sidebar-aligned header cell (`#0c0e12`) containing `[◧ Toggle Sidebar (⌘B)]`, `[← Back]`, `[→ Forward]`, `[🔍 Quick Switcher (⌘K)]`, and draggable `#090a0d` main pane header cell with quiet context breadcrumb (`Ludens / <workspace> · <view>`), double-click zoom/minimize (`AppleActionOnDoubleClick`), fullscreen traffic-light collapse (`0px` inset when `fullScreen`), and right-side Companion Pet quick toggle + reload control.
   - **Windows (`win32`)**: `app.setAppUserModelId("dev.ludens.app")`, `titleBarStyle: "hidden"` + native Windows 11 Window Controls Overlay (`titleBarOverlay: { color: "#090a0d", symbolColor: "#cfd5e2", height: 38 }`) preserving native DWM rounded corners, Aero Snap, and Windows 11 Snap Layouts flyout on maximize hover; remove legacy Win32 in-window menu bar (`autoHideMenuBar: true`, `Menu.setApplicationMenu(null)` on non-`darwin`); left header cell renders crisp Ludens `PixelMark` + `[◧ (Ctrl+B)] [←] [→] [🔍 (Ctrl+K)]`; right side reserves exact WCO inset (`env(titlebar-area-*)` / `138px`) in native overlay mode or renders pixel-accurate Windows 11 Fluent Caption Controls (`Minimize`, `Maximize/Restore`, `#c42b1c` `Close`) in `custom` / `?desktopPreview=win32` mode.
2. **Unified Hook Encapsulation (`app/shell/use-desktop-window.ts`)**:
   - Encapsulate all renderer ↔ Electron window state, SPA + `webContents` history back/forward, companion visibility toggle, keyboard shortcuts (`⌘/Ctrl+B`, `⌘/Ctrl+K`, `⌘/Ctrl+[` & `]`), persisted sidebar collapse (`ludens:sidebar-collapsed`), and browser visual preview (`?desktopPreview=darwin` / `?desktopPreview=win32`) in a single hook (`useDesktopWindow`).
3. **Viewport Budget & Collapsible Sidebar**:
   - Introduce `--shell-topbar-height` (`38px` when desktop chrome is active, `0px` in plain browser) across `.console-shell`, `.sidebar`, `.codex-workbench`, `.replay-studio`, `.run-analysis-workbench`, and `.docs-nav`/`.docs-toc` so zero double scrollbars or clipped bottom controls ever occur.
   - Support desktop sidebar collapse/expand smoothly in both Desktop App and Web modes.
4. **Windows Launch & Runtime Parity**:
   - Add `app/bin/ludens-app.cmd` and update `core/src/daemon/launcher.ts` on `win32` to spawn `electron.exe` directly (`shell=False` safe, avoiding `WinError 193` on POSIX `#!/bin/sh` script).
   - Persist and display-clamp window bounds/maximized/fullscreen state (`app/desktop/window-state.ts`).
   - Upgrade offline waiting page in `app/desktop/main.ts` to `#090a0d` dark theme with draggable 38px titlebar and EN/ZH copy.
   - Sync bilingual docs (`docs/en/...` and `docs/zh/...`).

## Workstream Split (Non-Overlapping Files)

### Foundation (Coordinator)
- `PLANS.md`, `plans/desktop-app-modern-chrome.md`
- `app/lib/desktop.ts` (shared `DesktopWindowState`, `DesktopWindowCommand`, `DesktopWindowBridge` contract)

### Worker 1: `desktop-runtime` (`app/desktop/**`, `app/bin/**`, `core/src/daemon/launcher.ts`, `docs/**`)
- `app/desktop/window-chrome.ts` + `app/desktop/window-chrome.spec.ts`
- `app/desktop/window-state.ts` + `app/desktop/window-state.spec.ts`
- `app/desktop/main.ts` + `app/desktop/preload.ts`
- `app/desktop/tray-icon.ts` + `app/desktop/tray-icon.spec.ts` (Windows DPI representations)
- `app/bin/ludens-app.cmd`
- `core/src/daemon/launcher.ts` + `core/tests/workspace-launch.test.ts`
- `docs/en/reference/dashboard-ui.md`, `docs/zh/reference/dashboard-ui.md`, `docs/en/tutorials/debugging-and-verification.md`, `docs/zh/tutorials/debugging-and-verification.md`, `app/README.md`

### Worker 2: `desktop-ui` (`app/shell/**`, `app/app/globals.css`, `app/features/**`, `app/messages/**`, `app/tests/**`)
- `app/shell/use-desktop-window.ts`
- `app/shell/desktop-titlebar.tsx`
- `app/shell/desktop-quick-switcher.tsx`
- `app/shell/desktop-chrome.css`
- `app/shell/console-shell.tsx`, `app/shell/console-sidebar.tsx`
- `app/app/globals.css`, `app/features/live/activity-feed.css`, `app/features/live/run-analysis.tsx`, `app/features/replay/timeline-player.css`
- `app/messages/en.json`, `app/messages/zh.json`
- `app/tests/desktop-window.test.ts`

## Verification Checklist
- `cd app && npm run typecheck && npm test && npm run desktop:build && npm run pet:smoke`
- `bun test core/tests/workspace-launch.test.ts`
- `omp --model=openai-codex/gpt-6-astra` read-only audit
- Live Browser visual verification across Web mode, `?desktopPreview=darwin` (Antigravity macOS style), `?desktopPreview=win32` (Windows 11 style), collapsed/expanded sidebar, Quick Switcher (`⌘K`/`Ctrl+K`), Live & Replay `100dvh - 38px` viewport fit, and mobile drawer (`<=680px`).
- Delete `plans/desktop-app-modern-chrome.md` and clear `PLANS.md` index before opening PR.
