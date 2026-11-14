# Multi-Surface RPC Architecture Plan

> Status: In Progress  
> Branch: `feat/multi-surface-rpc-architecture`

## Overview

Refactor Ludens into a multi-surface RPC architecture with a singleton App Daemon over Unix Domain Socket (UDS), authenticated WebSocket remote access (`--listen ws://` + token auth + HMAC media tickets), a Vite SPA frontend (`app/` -> `app/out`), and a zero-port Electron desktop surface (`ludens-app://` & `ludens-media://`).

## Execution Waves

### Wave 0 — Repository Setup (`ms-git`)
- Merge PR #75 into `main` and sync `origin/main`.
- Cut branch `feat/multi-surface-rpc-architecture` from `origin/main`.
- Register `plans/multi-surface-rpc-architecture.md` in `PLANS.md`.

### Wave 1 — Core Daemon/RPC & Vite SPA Migration (Parallel)
- **`ms-core`**:
  - Define shared RPC contract in `protocol/src/app-rpc.ts`.
  - Refactor `core/src/server/*`, `core/src/daemon/app-daemon.ts`, and `core/src/cli/*` to run a singleton UDS daemon with optional `--listen ws://`, token authentication, and HMAC-signed media tickets.
  - Remove all legacy 21 `/api/*` REST routes.
- **`ms-vite`**:
  - Migrate `app/` from Next.js to a Vite SPA while preserving the `app/out` build output path and UI behavior.

### Wave 2 — UI RPC Client & Electron Zero-Port Surface (Parallel)
- **`ms-ui`**:
  - Implement browser-pure `LudensRpcClient`, `ConnectionTarget`, `MediaResolver`, and `<ConnectionTargetDialog>` using native `<dialog>` and `modern-web-guidance` dialog/security best practices.
  - Migrate all UI callers off `fetch('/api/*')` and delete `read-poller.ts`.
- **`ms-electron`**:
  - Implement zero-port custom schemes `ludens-app://` and `ludens-media://`.
  - Expose `window.ludens.rpc` in `preload.ts`.
  - Wire UDS `PetSessionCoordinator` and `Cmd+Q` 3-choice confirmation dialog when active Cores > 0.

### Wave 3 — Documentation, Verification & Live Acceptance
- Synchronize bilingual documentation (`README.md`, `README.zh.md`, `docs/zh/**`, `docs/en/**`).
- Run full typecheck, unit/integration tests, production build, and docs checks.
- Perform live acceptance:
  - Web WS + Token in browser (including mobile viewport).
  - Electron zero-port desktop flow + CLI `--remote` acceptance.

### Wave 4 — Plan Closeout & PR Submission
- Remove `plans/multi-surface-rpc-architecture.md` and remove `- [[plans/multi-surface-rpc-architecture]]` from `PLANS.md`.
- Verify clean diff, push branch, and open PR targeting `main`.
