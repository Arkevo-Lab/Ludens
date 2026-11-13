# Multi-Core & Codex Lifecycle Architecture Plan

> Status: In Progress (Wave 1 Foundation)
> Target Branch: `feat/multi-core-codex-lifecycle`

## Goal

Refactor Ludens from single-host / terminal-bound supervision to a concurrent **App Daemon + Multi-Core** architecture with on-demand Codex/Core spawning, strict App-vs-CLI lifecycle ownership, physical device contention arbitration, unified 4-layer terminology, zero-barrier Live entry, and multi-Core Pet auto-following.

## 9 Core Specifications

1. **1 Workspace = 1 Core**
   - Every workspace runs its own isolated Core process (`ProjectCoreSummary` attached on `Project.core`), removing single-global-host assumptions.
   - Multiple non-conflicting workspaces can run concurrently (`online`, `pid`, `mode`, `consolidating`, `runId`, `model`, `pendingOutbound`).
2. **Codex 按需拉起 + Warm Standby**
   - Submitting a Live prompt (`mode: "start"` / `auto_on`) or control action when Core is offline spawns Core + Baseware on demand (`spawned: true` in `LiveStatus`) instead of blocking on manual `ludens up`.
   - Core supports Warm Standby (connected Baseware + ready Shiori session without active takeover) and records workspace defaults (`ProjectWorkspaceDefaults`: `model`, `serviceTier`, `effort`, `maxSeconds`).
3. **`launchedBy: "app" | "cli"` 退出清理边界**
   - Every running Core records `ServiceLaunchOrigin` (`"app" | "cli"`) and optional `appInstanceId`.
   - When the Electron App / App Daemon exits, it cleanly stops only Cores spawned by that App instance (`launchedBy === "app"` matching `appInstanceId`); CLI-launched Cores (`launchedBy === "cli"`) remain untouched.
4. **物理设备冲突仲裁 `409 DEVICE_BUSY` + `preempt`**
   - Starting or spawning a Core that requires a physical device/bridge already leased by another running Core returns HTTP `409` with `code: "DEVICE_BUSY"` and `DeviceContentionConflict` (`holderProjectId`, `holderWorkspaceName?`, `deviceKey`, `deviceLabel?`, `holderMode`, `holderOrigin?`).
   - UI presents a `deviceContention` modal allowing the user to cancel, switch to the holding workspace, or `preempt` (stop/release the holder's Core & device lease and start the requested workspace).
5. **左侧栏「活跃 Core」**
   - Console sidebar surfaces all active Cores across registered workspaces (`consoleSidebar.activeCores*`), displaying `App` / `CLI` origin badges, current mode (`Auto` / `Manual` / `Consolidating`), pending Event Pool outbound count, quick jump to Live, and inline Stop action.
6. **4 层术语统一**
   - Standardize all layers on the 4-layer model: **App Daemon** · **Core** · **Baseware** · **Shiori**.
   - Replace legacy `"宿主"` / `"Host"` UI copywriting referring to Core with `Core` / `App Daemon`, and align offline error/status semantics on `CORE_OFFLINE` / `coreOffline`.
7. **Live Composer 去离线横幅 + 默认 `"start"`**
   - Remove the obstructive offline banner above/inside the Live Composer.
   - When Core is offline/standby, default the Live Composer mode to `"start"` (launch loop / on-demand Core spawn) so users can type a goal and send immediately.
8. **0-run 工作区零门槛进 Live**
   - Selecting a workspace with 0 historical runs opens the Live cockpit directly (using `Project.defaults` for model/budget display) rather than trapping the user on an empty-run gate.
9. **桌宠 `!auto` 多 Core 自动跟随**
   - Export `PET_AUTO_TARGET = "!auto"` in `core/src/core/query/pet.ts` and extend `PetState` (`autoFollowing?: boolean`) + `petStatusKey` / `petStatus` (`autoWaiting` when waiting for an active Core).
   - Pet resolves `!auto` dynamically to the active running Core (preferring autonomous loops) and updates UI/Electron follow controls with `petFollow.autoFollowOption`, `autoFollowBadge`, and `autoFollowHint`.

## Execution Waves & Verification Gates

- **Wave 1 (`@mc-foundation`)**:
  - Sync `feat/multi-core-codex-lifecycle` from `origin/main`.
  - Write this plan and index it in `PLANS.md`.
  - Extend `core/src/core/query/types.ts` and `core/src/core/query/pet.ts`.
  - Clean up legacy "宿主/Host" copywriting and add Wave 2/3 i18n keys in `app/messages/zh.json` & `app/messages/en.json` with strict 1:1 key and placeholder parity.
  - Gate: `cd core && bun run typecheck`.
- **Wave 2 (Parallel Implementation)**:
  - **Core Backend**: Multi-core registry/tracking, `launchedBy` + `appInstanceId` cleanup boundary, `Project.core` + `Project.defaults`, on-demand Core/Codex spawn, `409 DEVICE_BUSY` + `preempt`, `CORE_OFFLINE` status semantics, and `!auto` pet target resolution.
  - **Frontend Live / Sidebar / Pet UI**: Remove offline banner, default Live composer to `"start"`, 0-run Live entry, `deviceContention` modal, sidebar Active Cores list, and Pet `!auto` selector/badges.
  - **Desktop / Electron App Daemon**: App-instance exit cleanup for `launchedBy: "app"` Cores and desktop pet `!auto` follow integration.
- **Wave 3 (Integration, Regression Tests, Bilingual Docs & Browser Verification)**:
  - Merge Wave 2 branches, add/update tests in `core/tests/` and `app/tests/`, sync `docs/zh/` and `docs/en/`.
  - Gate: `cd core && bun run typecheck && bun run test`, `cd app && npm run typecheck && npm test && npm run build`, plus live browser visual verification.
- **Wave 4 (Final Gate & PR)**:
  - Independent verification pass, remove `plans/multi-core-codex-lifecycle.md` and its `PLANS.md` index entry before PR submission.
