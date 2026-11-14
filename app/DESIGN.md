# `@ludens/app` Design & Engineering Contract

Internal engineering contract for the `@ludens/app` web console, Electron desktop host, and Desktop Pet companion. For end-user installation and usage guides, see [Tutorials](../docs/en/tutorials/index.md).

## 1. Architecture & Runtime Modes

Ludens adopts a 4-layer concurrent architecture (`Desktop UI` / `App Daemon` / `Core` / `Baseware`) following **1 Workspace = 1 Core** isolation. The Console (**Desktop UI**) uses React 19, the Next.js static export pipeline (`output: "export"` → `app/out`), Tailwind CSS 4, and shadcn/ui (Radix / New York). Both browser tabs and the Electron desktop app share the exact same static UI bundle backed by `@ludens/core`'s unified multi-workspace **App Daemon** (`ludens app-server`), with zero Next.js server runtime in production:

- **Desktop App (`app/bin/ludens-app` / `app/bin/ludens-app.cmd` / packaged installer)**: Spawns and supervises `ludens app-server --port 0 --parent-watchdog --static-dir <out>` automatically on startup (unless `--dashboard <url>` or `--server <url>` attaches to an external server). Closing the main window (`×`) hides to the system tray and optional **Desktop Pet** while keeping running Cores alive; **Quit** (`⌘Q` / tray **Quit**) or unexpected parent exit cleanly terminates `app-server` and **only** App-launched Cores (`launchedBy === "app"`), leaving headless `CLI`-launched Cores (`launchedBy === "cli"`) untouched.
- **Web Dev Mode (`npm run dev`)**: Runs `scripts/dev.mjs`, which spawns an ephemeral `ludens app-server` (`--port 0 --parent-watchdog --trusted-origin`) and proxies `/api/*` from `next dev` with HMR.
- **Static Production Server (`npm run build && npm start`)**: Exports static SPA artifacts into `app/out` (fingerprinted in `app/out/.ludens-build.json`) and serves both `/api/*` and the static bundle via `ludens app-server`. Before bringing up services, `ludens up` runs `npm run build:check` if no shared `app-server` is listening on `:3015`.

## 2. Script Naming Conventions

Component `package.json` scripts follow one naming scheme:

- Generic package commands: `dev`, `build`, `start`, `test` (must include integration coverage; never name a suite `unit`), and `typecheck`.
- Special-purpose commands: `<object>:<action>[:<variant>]` in lowercase kebab-case (e.g. `desktop:build`, `desktop:dist`, `desktop:pack`, `pet:preview`, `pet:smoke`, `build:check`, `omp:test:transport`). Never add bare `preview`, `smoke`, or `check` aliases.
- `build:check` verifies existing artifacts against the source fingerprint and must never run a build.
- Running `pet:preview` or `pet:smoke` invokes `desktop:build` first.

## 3. Component Ownership & Styling

- `app/components/ui/` holds shadcn components (`components.json`) alongside shared flat-settings primitives (`settings-primitives.tsx` and `settings-layout.css`: `SettingsWorkspaceLayout`, `SettingsSection`, `SettingsRow`, `SettingsSaveBar`, `InlineCopyButton`, `SingleLineTruncate`, `AdvancedDiagnosticsDisclosure`).
- Feature components live under `app/features/` and `app/shell/`; never import workspace/runtime calls into `app/components/ui/`.
- Add new shadcn primitives from `app/`: `npx shadcn@4.23.0 add <component>`. Review diffs and preserve local customizations (`NativeSelect.wrapperClassName`, Slider passing accessible name/description to the focusable Thumb, compact card defaults).
- `app/app/globals.css` maps the Ludens warm charcoal palette to semantic tokens under `@theme inline` (`dark` pinned at root):

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

- Static assets: `app/public/brand/ludens-mark-dark.svg`, `ludens-mark-light.svg`, `ludens-app-icon.{svg,png}`, tray icons `ludens-tray-{dark,light}[@2x].png` (integer-grid multi-representation `NativeImage`, updated on `nativeTheme` changes), and browser icons `app/app/{icon.svg,apple-icon.png}`.
- Animated mark: `PixelMark` (`app/components/ui/pixel-mark.tsx`) + `app/app/pixel-motion.css` using `--step` (`60ms`) and `steps()` easing on `transform` / `opacity` only, disabled under `prefers-reduced-motion`:
  - `state`: `idle`, `reasoning` (pulse), `recording` (blink), `passed` (green), `failed` (red shake), `waiting` (grey slow blink).
  - `loading`: three-pixel tail orbiting the ring (used for non-refresh loaders; refresh buttons retain rotating arrows).
  - `filled`: hollow L fills cell-by-cell in blue while a human holds control (`manual` standby with Core online).
  - `assemble`: once-per-session mount animation (`ludens:brand-assembled`).
- Sidebar active indicator uses the orange `.nav-cursor` stepping in 4 jumps on desktop (`> 680px`) and tracked via `ResizeObserver`; the sidebar **Active Cores** list (`useActiveCores`, `consoleSidebar.activeCores*`) tracks all concurrent running workspace Cores (`launchedBy: "app" | "cli"`, mode, `pendingOutbound` badges, and inline `■` stop); budget bars on Live render 24 discrete blocks while preserving `role="progressbar"`.

## 5. Shell, Navigation & View Contracts

- **100dvh Workbench Shell**: `Sidebar | Primary Stage | Collapsible/Drawer Inspector Dock` reserving `--shell-topbar-height` (`38px` in Electron or `?desktopPreview=darwin|win32`, `0px` in plain browser). Desktop window state persists display-clamped bounds in `window-state.json`, with shortcuts `Cmd/Ctrl+B` (sidebar), `Cmd/Ctrl+K` (quick switcher), and `Cmd/Ctrl+[` / `]` (history).
- **Responsive Breakpoints**:
  - `<= 680px`: sidebar collapses into a slide-over drawer; focus transfers only if a focused sidebar control becomes hidden.
  - `<= 900px` / `<= 1300px` in Docs: `.docs-layout` collapses document library into **Docs menu** at `<= 900px` and page headings into **On this page** at `<= 1300px`, transferring focus across breakpoint hides while preserving search drafts and language.
  - `< 1100px` in Live / Replay: inline right inspector docks convert into overlay drawers dismissible via backdrop or `Escape`; in Settings (`< 860px`), the `208px` category rail becomes a horizontally scrollable bar.
- **Workspaces & Choosers**: Bounded dialogs (`WorkspacePicker`, compact `RunPicker`) expose full IDs/paths before selection and restore focus to the opener on close. Asia/Shanghai timestamps with year and seconds render only for valid canonical run prefixes. Removing a workspace clears any matching pet follow target first (failing closed if target cleanup fails) and supports undo using the committed receipt.
- **Live (`?view=live`)**: 0-run workspaces enter Live with zero barrier via `synthesizeEmptyRunData`, pre-populating defaults and keeping the **Shiori Composer** unlocked (defaulting to `"start"` / **Launch Auto Loop**) so sending a goal or clicking `▶` spawns **Core + Baseware** on demand (`POST /api/workspaces/service`). If another workspace holds the same physical device in `Auto Run`, App Daemon returns `409 DEVICE_BUSY` (`DeviceContentionConflict`) and `DeviceContentionDialog` (`<dialog closedby="any">`) offers cancel, switch, or `preempt`. `ShioriWorkbench` aggregates all control cycles (`epoch="all"`) into one continuous session stream driven by `useLiveSession` + `useLiveAutoScroll`. Auto-follow pauses on explicit upward scroll, segment jump, or header toggle and resumes on reaching bottom, clicking **Jump to latest**, or submitting in the composer. Composer switching (`ModelPickerDialog` + speed/effort drawers) is allowed only in **Warm Standby** (`manual` standby with Core online, or when Core is offline).
- **Replay (`?view=replay`)**: Loads bounded 30s frame windows (server cap 60s) and 15m event windows via `useReplaySession` with LRU window retention; missing samples remain visible rather than interpolating later frames. **Jump to time** preserves milliseconds on unfinished edits; full-archive event search tracks `(scan.complete, coverage.complete)` before declaring exhaustive results.
- **Perf (`?view=perf`)**, **Capabilities (`?view=caps`)**, **Config (`?view=perception`)**, **Devices / Baseware (`?view=baseware`)**, and **Developer / Loop Simulator (`?view=dev`)**: Follow the same strict read/write separation, scoped identity checks, and `AdvancedDiagnosticsDisclosure` folding for CLI/socket diagnostics.

## 6. Interaction, Concurrency & State Isolation

- Pair every control with an explicit `Label` and help text via `aria-describedby`; give all `<button>` elements an explicit `type` (`submit` only for native form submit).
- Dialogs must have a title and description, move focus to the first actionable input, restore focus on cancel, and keep creation progress visible.
- Range sliders writing to backend persist on `onValueCommit`, never mid-drag.
- Retrying a failed read never replays a mutation; write confirmations apply committed API receipts directly and isolate drafts by `(workspaceId, workspacePath)`.
- All workspace control (`up`, `reload`, `down`) flows through `useWorkspaceService` (`app/lib/use-workspace-service.ts`).

## 7. Desktop Pet Lifecycle, Locking & Assets

- **Locking & Persistence Consistency**: Workspace registry writes, relocations, removals, and pet target selection share per-workspace locks (`registry` lock always acquired before `pet-target` lock). By default, **Desktop Pet** uses **`!auto` (`PET_AUTO_TARGET`) multi-Core auto-follow mode** (`targetConfigured === false`, `autoFollowing: true`), resolving active Cores in priority `SOS (pendingOutbound > 0) > focused > auto > online` and idling cleanly as `autoWaiting` when none run; selecting **Stop following** writes explicit `null`. `PUT /api/pet` (`target`) and `POST /api/pet` (`consumer`) return committed receipts independently; `targetRevision` tracks attempted target changes while `revision` tracks the loaded source so stale errors never misattribute across switches. See [Architecture](../docs/en/reference/architecture.md) for store boundaries.
- **Window & Quit Semantics**: `--profile <path>` defaults to the Electron `appData` desktop profile, `--workspace <path>` (`LUDENS_WORKSPACE`) sets initial focus, and `LUDENS_DISABLE_COMPANION=1` disables the optional Desktop Pet widget. Language changes in Console Settings sync bidirectionally via the desktop bridge to native menus, `companion.json`, and pet dialogue.
- **Assets & I18n**: Pet poses use static transparent WebP frames registered in `app/public/companion/ludens/manifest.json` (synced with `catalog.js`: 24 poses, 8 overlay effects, 3 avatars, and dedicated tray icons under `app/public/companion/ludens/icons/`). Shared pet localization lives in `app/public/companion/companion-i18n.cjs` (update `zh` and `en` together).
- **Scale & Priority**: Poses bottom-align and scale via `display_scale` relative to the default standing head size while bubbles keep constant geometry. Priority order: pointer interaction (click / pick up / drop) > live log state (`thinking`, `acting`, `smug`, `sheepish`) > interactive Catch-the-Stars round > manual menu pose > idle timers (`30s` sit → `90s` drowsy → `120s` sleep).
- **Smoke Test**: `(cd app && npm run pet:smoke)` verifies window bounds, click-through, scaling, audio alerts, and 5 log bubble classes under an isolated profile; `npm run pet:preview` opens an interactive preview window.

## 8. Acceptance & Packaging

Run component checks from repo root before opening a PR (see [Console and Debugging](../docs/en/tutorials/console-and-debugging.md)):

```sh
(cd protocol && bun run typecheck && bun test)
(cd baseware && bun run typecheck && bun test)
(cd core && bun run typecheck && bun test)
(cd app && npm run typecheck && npm test && npm run build && npm run build:check)
```

For Electron desktop binaries and installers:

```sh
(cd app && npm run desktop:typecheck && npm run desktop:test)
(cd app && npm run desktop:build && npm run desktop:pack)
# Optionally build distributable .dmg/.zip or NSIS .exe:
(cd app && npm run desktop:dist)
```

Note on UI memory baseline (`app/perf/index-memory.ts`): run `(cd app && npm run perf)` under `--max-old-space-size=1024 --expose-gc` to verify RSS, heap retention, and paged query latency budgets on a synthetic multi-megabyte archive.
