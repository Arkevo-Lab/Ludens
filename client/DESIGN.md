# `@ludens/client` & `@ludens/desktop` Design & Engineering Contract

Internal engineering contract for the `@ludens/client` Vite Static SPA console, pure-RPC `ludens` operator CLI, and `@ludens/desktop` Electron All-in-One desktop shell + Desktop Pet companion. For end-user installation and usage guides, see [Tutorials](../docs/en/tutorials/index.md).

## 1. Architecture & Runtime Surfaces

Ludens adopts a 6-package, 4-layer concurrent architecture (`Client` / `Server` / `Core` / `Baseware`, sharing zero-dependency `@ludens/protocol`) following **1 Workspace = 1 Core** isolation. `@ludens/client` depends **exclusively** on `@ludens/protocol` (zero `@ludens/core`, `@ludens/server`, `@ludens/baseware`, or `electron` dependencies) and shares a single React 19, Vite static build (`client/dist`), Tailwind CSS 4, and shadcn/ui (Radix / New York) bundle backed by `@ludens/server`'s unified JSON-RPC 2.0 `ludens-server`, exposed across three explicit `LudensRuntimeProfile` surfaces:

1. **Desktop App (`runtimeProfile: "desktop"` — `desktop/bin/ludens-app` / `desktop/bin/ludens-app.cmd` / packaged installer)**:
   - Primary local All-in-One entry point (`@ludens/desktop`). Ensures a zero-TCP-port singleton `ludens-server` over Unix Domain Socket (`~/.ludens/run/app-server.sock` with 96-byte BSD `sun_path` fallback) via `ensureLocalAppDaemon` (unless `--server <url>` or `LUDENS_DESKTOP_DEV_URL` attaches the renderer to an explicit local Vite dev server), serving `client/dist` (or packaged `Resources/client`) over `ludens-app://console/` and media over `ludens-media://local/media?...`.
   - Grants full `HostSessionCapabilities` (`localFsPaths: true`, `localFileDrivers: true`, `hostProcessOverrides: true`, `hostStorageConfig: true`). Hides the sidebar connection pill while healthy on `electron-local` UDS (reachable anytime via `Cmd/Ctrl + K` Quick Switcher or Settings).
   - Closing the main window (`×`) hides to the system tray and optional **Desktop Pet** while keeping running Cores alive; **Quit** (`⌘Q` / tray **Quit**) runs `ActiveCoreQuitGuard`, exiting cleanly when 0 Cores are active or prompting to keep running in background, stop all Cores & quit, or cancel.
2. **Hosted Cloud / Remote Node & Mobile (`runtimeProfile: "remote"` — `ludens-server serve --listen ws://... --auth token --token-env ...`)**:
   - Serves `client/dist` (optional `--static-dir`), WebSocket `/rpc`, HMAC capability-ticket `/media`, and `/health`. Requires `--auth token` (`--token` or `--token-env`) whenever binding `ws://` without `--dev`.
   - Enforces `managed-sandbox` capabilities (`localFsPaths: false`, `localFileDrivers: false`, `hostProcessOverrides: false`, `hostStorageConfig: false`): `RpcRouter` rejects host-escaping paths/overrides with `403 CAPABILITY_RESTRICTED`, and `useRuntimeCapabilities()` hides local filesystem pickers, custom target directories, `file:` driver specs, `cuaCommand`, and `directory` storage backends across Console forms.
3. **Frontend & AI Harness Dev Preview (`runtimeProfile: "web-dev"` — `bun run dev` / `--dev`)**:
   - Root orchestration `scripts/dev.mjs` coordinates multi-package dev lifecycles while keeping each subpackage strictly single-package:
     - `bun run dev` / `bun run dev:web`: spawns an ephemeral loopback `ludens-server serve --dev --listen ws://127.0.0.1:0 --parent-watchdog` alongside Vite HMR (`127.0.0.1:3015`).
     - `bun run dev:desktop`: compiles `desktop/dist/electron`, starts pure Vite HMR, and launches Electron with `LUDENS_DESKTOP_DEV_URL` so Electron natively manages its UDS `ludens-server` without spawning a redundant TCP server.
     - `bun run dev:client`: starts pure cross-origin Vite HMR (`client/`) with zero local backend.
     - `bun run dev:server`: runs foreground `ludens-server serve --dev --listen ws://127.0.0.1:38080`.
   - Defaults `LUDENS_HOME` across all dev modes to isolated `~/.ludens-dev` (override precedence: `--home <dir>` > `--real-home` / `:real` > `env.LUDENS_HOME` > `~/.ludens-dev`) so development never collides with or stops a running `~/.ludens` Desktop App server.
   - `--dev` is restricted to loopback hosts (`127.0.0.1`, `localhost`, `::1`), grants full host capabilities for local browser/harness testing, renders a **`DEV PREVIEW`** badge in the sidebar, and unlocks a Dev UI Simulation toggle inside `<ConnectionTargetDialog>`. `bun run start:selfhost` (`scripts/selfhost.mjs`) verifies/builds `client/dist/.ludens-build.json` and launches `ludens-server serve --static-dir client/dist` with `--dev` on tokenless loopback or `--auth token --token-env LUDENS_APP_TOKEN` when `LUDENS_APP_TOKEN` is set.

## 2. Script Naming Conventions

Root and subpackage `package.json` scripts follow strict separation between root orchestration and single-package lifecycle:

- Subpackages (`protocol`, `baseware`, `core`, `server`, `client`, `desktop`) expose only single-package atomic commands (`dev`, `build`, `build:check`, `start`, `pack`, `dist`, `typecheck`, `test`, `pet:preview`, `pet:smoke`) outputting to their own `dist/` directory.
- Root `package.json` orchestrates cross-package development (`dev`, `dev:web`, `dev:web:real`, `dev:desktop`, `dev:desktop:real`, `dev:client`, `dev:server`, `dev:server:real`), production pipelines (`build`, `build:client`, `build:server`, `build:sandbox`, `build:desktop`, `pack:desktop`, `dist:desktop`, `start:selfhost`), and repository QA (`typecheck`, `test`).
- `build:check` verifies existing `client/dist` artifacts against the source fingerprint and must never run a build.

## 3. Component Ownership & Styling

- `client/components/ui/` holds shadcn components (`components.json`) alongside shared flat-settings primitives (`settings-primitives.tsx` and `settings-layout.css`: `SettingsWorkspaceLayout`, `SettingsSection`, `SettingsRow`, `SettingsSaveBar`, `InlineCopyButton`, `SingleLineTruncate`, `AdvancedDiagnosticsDisclosure`).
- Feature components live under `client/features/` and `client/shell/`; never import workspace/runtime calls into `client/components/ui/`.
- Add new shadcn primitives from `client/`: `npx shadcn@4.23.0 add <component>`. Review diffs and preserve local customizations (`NativeSelect.wrapperClassName`, Slider passing accessible name/description to the focusable Thumb, compact card defaults).
- `client/app/globals.css` maps the Ludens warm charcoal palette to semantic tokens under `@theme inline` (`dark` pinned at root):

| Purpose | Token / Class |
| --- | --- |
| Page surface & primary text | `bg-background text-foreground` |
| Cards & overlays | `bg-card` / `bg-popover` |
| Primary action | Default `Button` variant (`--gold` orange accent) |
| Secondary actions & weak fill | `secondary` / `outline` / `ghost`; `bg-muted` |
| Secondary text & semantic status | `text-muted-foreground` / `text-success` / `text-destructive` |
| Borders & keyboard focus rings | `border-border` / `ring-ring` |

Domain CSS belongs in `@layer components` so Tailwind utilities can override it; do not add unlayered global `button`, `input`, or `select` rules. Keep both `en` and `zh` labels wrappable and verify narrow as well as wide viewports.

## 4. Brand Mark & Pixel Motion

The Ludens mark is a `5 × 5` pixel ring around a hollow L with one loose pixel (`#ff4f1f`) at the top right. Pixels remain sharp squares with no rounding, blur, shadow, outline, or rotation.

- Static assets: `client/public/brand/ludens-mark-dark.svg`, `ludens-mark-light.svg`, `ludens-app-icon.{svg,png}`, tray icons `ludens-tray-{dark,light}[@2x].png` (integer-grid multi-representation `NativeImage`, updated on `nativeTheme` changes), and browser icons `client/app/{icon.svg,apple-icon.png}`.
- Animated mark: `PixelMark` (`client/components/ui/pixel-mark.tsx`) + `client/app/pixel-motion.css` using `--step` (`60ms`) and `steps()` easing on `transform` / `opacity` only, disabled under `prefers-reduced-motion`:
  - `state`: `idle`, `reasoning` (pulse), `recording` (blink), `passed` (green), `failed` (red shake), `waiting` (grey slow blink).
  - `loading`: three-pixel tail orbiting the ring (used for non-refresh loaders; refresh buttons retain rotating arrows).
  - `filled`: hollow L fills cell-by-cell in blue while a human holds control (`manual` standby with Core online).
  - `assemble`: once-per-session mount animation (`ludens:brand-assembled`).
- Sidebar active indicator uses the orange `.nav-cursor` stepping in 4 jumps on desktop (`> 680px`) and tracked via `ResizeObserver`; the sidebar **Active Cores** list (`useActiveCores`, `consoleSidebar.activeCores*`) tracks all concurrent running workspace Cores (`launchedBy: "app" | "cli"`, mode, `pendingOutbound` badges, and inline `■` stop); countdown timer bars (`.shiori-timer-bar`) on Live render 24 discrete blocks when an interactive stop-timer is active while preserving `role="progressbar"`.

## 5. Shell, Navigation & View Contracts

- **100dvh Workbench Shell**: `Sidebar | Primary Stage | Collapsible/Drawer Inspector Dock` reserving `--shell-topbar-height` (`38px` in Electron or `?desktopPreview=darwin|win32`, `0px` in plain browser). Desktop window state persists display-clamped bounds in `window-state.json`, with shortcuts `Cmd/Ctrl+B` (sidebar), `Cmd/Ctrl+K` (quick switcher), and `Cmd/Ctrl+[` / `]` (history).
- **Responsive Breakpoints**:
  - `<= 680px`: sidebar collapses into a slide-over drawer; focus transfers only if a focused sidebar control becomes hidden.
  - `<= 900px` / `<= 1300px` in Docs: `.docs-layout` collapses document library into **Docs menu** at `<= 900px` and page headings into **On this page** at `<= 1300px`, transferring focus across breakpoint hides while preserving search drafts and language.
  - `< 1100px` in Live / Replay: inline right inspector docks convert into overlay drawers dismissible via backdrop or `Escape`; in Settings (`< 860px`), the `208px` category rail becomes a horizontally scrollable bar.
- **Workspaces & Choosers**: Bounded dialogs (`WorkspacePicker`, compact `RunPicker`) expose full IDs/paths before selection and restore focus to the opener on close. Asia/Shanghai timestamps with year and seconds render only for valid canonical run prefixes. Removing a workspace clears any matching pet follow target first (failing closed if target cleanup fails) and supports undo using the committed receipt.
- **Live (`?view=live`)**: 0-run workspaces enter Live with zero barrier via `synthesizeEmptyRunData`, pre-populating defaults and keeping the **Shiori Composer** unlocked (defaulting to `"start"` / **Launch Auto Loop**) so sending a goal or clicking `▶` spawns **Core + Baseware** on demand (`workspaces/serviceControl`). Auto Run starts unbounded (`timerSeconds: null`) unless an optional countdown timer is selected (`auto_timer` / `ludens auto timer <seconds|off>`); when a timer is active, Live renders the countdown pill and 24-block `.shiori-timer-bar` with `+15m` extend and clear controls. If another workspace holds the same physical device in `Auto Run`, `ludens-server` returns `409 DEVICE_BUSY` (`DeviceContentionConflict`) and `DeviceContentionDialog` (`<dialog closedby="any">`) offers cancel, switch, or `preempt`; if a control command encounters `STALE_EPOCH`, `LiveSessionEngine` automatically refreshes live status/activity/pool state and surfaces a localized resync message instead of raw protocol text. `ShioriWorkbench` aggregates all control cycles (`epoch="all"`) into one continuous session stream driven by `useLiveSession` + `useLiveAutoScroll`. Auto-follow pauses on explicit upward scroll, segment jump, or header toggle and resumes on reaching bottom, clicking **Jump to latest**, or submitting in the composer. Composer switching (`ModelPickerDialog` + speed/effort drawers) is allowed only in **Warm Standby** (`manual` standby with Core online, or when Core is offline).
- **Replay (`?view=replay`)**: Loads bounded 30s frame windows (server cap 60s) and 15m event windows via `useReplaySession` with LRU window retention; missing samples remain visible rather than interpolating later frames. **Jump to time** preserves milliseconds on unfinished edits; full-archive event search tracks `(scan.complete, coverage.complete)` before declaring exhaustive results.
- **Perf (`?view=perf`)**, **Capabilities (`?view=caps`)**, **Config (`?view=perception`)**, **Devices / Baseware (`?view=baseware`)**, and **Developer / Loop Simulator (`?view=dev`)**: Follow the same strict read/write separation, scoped identity checks, `useRuntimeCapabilities()` host-boundary gating, and `AdvancedDiagnosticsDisclosure` folding for CLI/socket diagnostics.

## 6. Interaction, Concurrency & State Isolation

- Pair every control with an explicit `Label` and help text via `aria-describedby`; give all `<button>` elements an explicit `type` (`submit` only for native form submit).
- Dialogs must have a title and description, move focus to the first actionable input, restore focus on cancel, and keep creation progress visible.
- Range sliders writing to backend persist on `onValueCommit`, never mid-drag.
- Retrying a failed read never replays a mutation; write confirmations apply committed API receipts directly and isolate drafts by `(workspaceId, workspacePath)`.
- All workspace control (`up`, `reload`, `down`) flows through `useWorkspaceService` (`client/lib/use-workspace-service.ts`).

## 7. Desktop Pet Lifecycle, Locking & Assets

- **Locking & Persistence Consistency**: Workspace registry writes, relocations, removals, and pet target selection share per-workspace locks (`registry` lock always acquired before `pet-target` lock). By default, **Desktop Pet** uses **`!auto` (`PET_AUTO_TARGET`) multi-Core auto-follow mode** (`targetConfigured === false`, `autoFollowing: true`), resolving active Cores in priority `SOS (pendingOutbound > 0) > focused > auto > online` and idling cleanly as `autoWaiting` when none run; selecting **Stop following** writes explicit `null`. `pet/setTarget` returns committed receipts independently; `targetRevision` tracks attempted target changes while `revision` tracks the loaded source so stale errors never misattribute across switches. See [Architecture](../docs/en/reference/architecture.md) for store boundaries.
- **Window & Quit Semantics**: `--profile <path>` defaults to the Electron `appData` desktop profile, `--workspace <path>` (`LUDENS_WORKSPACE`) sets initial focus, and `LUDENS_DISABLE_COMPANION=1` disables the optional Desktop Pet widget. Language changes in Console Settings sync bidirectionally via the desktop bridge to native menus, `companion.json`, and pet dialogue.
- **Assets & I18n**: Pet poses use static transparent WebP frames registered in `client/public/companion/ludens/manifest.json` (synced with `catalog.js`: 24 poses, 8 overlay effects, 3 avatars, and dedicated tray icons under `client/public/companion/ludens/icons/`). Shared pet localization lives in `client/public/companion/companion-i18n.cjs` (update `zh` and `en` together).
- **Scale & Priority**: Poses bottom-align and scale via `display_scale` relative to the default standing head size while bubbles keep constant geometry. Priority order: pointer interaction (click / pick up / drop) > live log state (`thinking`, `acting`, `smug`, `sheepish`) > interactive Catch-the-Stars round > manual menu pose > idle timers (`30s` sit → `90s` drowsy → `120s` sleep).
- **Smoke Test**: `bun --cwd=desktop run pet:smoke` verifies window bounds, click-through, scaling, audio alerts, and 5 log bubble classes under an isolated profile; `bun --cwd=desktop run pet:preview` opens an interactive preview window.

## 8. Acceptance & Packaging

Run repository-wide checks and builds from the repo root before opening a PR (see [Console and Debugging](../docs/en/tutorials/console-and-debugging.md)):

```sh
bun run typecheck
bun run test
bun run build
bun --cwd=client run build:check
```

For Electron desktop binaries and installers:

```sh
bun run pack:desktop
# Optionally build distributable .dmg/.zip or NSIS .exe:
bun run dist:desktop
```
