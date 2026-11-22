# Process Crash & Hang Prevention Plan

Target base: `origin/main` (`1fe28bd`) on branch `ludens_process_crash_hang`.

## Workstreams

1. **Main-process stdio (`EIO`/`EPIPE`) & global error safety + bounded `<userData>/logs/main.log`**
   - Protect Electron main-process `process.stdout` / `process.stderr` writes against broken pipe / detached TTY errors (`EIO`, `EPIPE`, `ERR_STREAM_DESTROYED`) so backgrounded or parentless desktop runs cannot crash on console logging.
   - Install `uncaughtException` and `unhandledRejection` guards in `desktop/src/main.ts` that safely log diagnostics without crashing on benign stdio failures and cleanly fail/teardown on fatal errors.
   - Add bounded rotating/size-capped file logging to `<userData>/logs/main.log`.

2. **`--parent-watchdog` in `ludens-app`, dev launcher injection, and `~/.ludens-dev` isolation**
   - Add `--parent-watchdog` support in `desktop/src/main.ts` (`ludens-app`) so an Electron instance launched by a dev runner exits cleanly when its parent process disappears (preventing orphaned Electron + `app-server` processes and stale `SingletonLock` / `app-server.sock`).
   - Update dev launcher scripts to pass `--parent-watchdog` to `ludens-app` (note: upstream PR #89 moved `client/scripts/dev.mjs` to `scripts/dev.mjs` and replaced `desktop:dev` with `desktop/scripts/dev-electron.mjs` + root `dev:desktop`).
   - Verify `~/.ludens-dev` dev home isolation across `scripts/dev.mjs` and `desktop/scripts/dev-electron.mjs` (already defaulted in `1fe28bd`, verify no remaining `--real-home` default leaks into dev entrypoints).

3. **Pet/Activity `consumerRecorder` `ENOENT` safety & teardown cleanup**
   - Harden `desktop/src/ludens-source.ts`, `desktop/src/ludens-activity-controller.ts`, `desktop/src/companion-activity.ts`, `desktop/src/pet-session.ts`, and `desktop/src/rpc-bridge.ts` against `ENOENT` and transient FS/RPC failures in `consumerRecorder` / activity polling.
   - Ensure timers, listeners, watchers, and pending async subscriptions are cleanly stopped/disposed on stop and quit teardown so no post-teardown callbacks throw or keep the event loop alive.

4. **`ActiveCoreQuitGuard` & `onConfirmQuit` fault-tolerant non-blocking exit + tray cleanup**
   - Ensure `ActiveCoreQuitGuard` (`desktop/src/quit-guard.ts`) and `onConfirmQuit` (`desktop/src/main.ts`) handle timeouts/errors fault-tolerantly so quitting cannot hang indefinitely.
   - Preserve upstream PR #91 semantics (`{ keepDaemonAlive }` passed to `onConfirmQuit` and `appServerHost.stop({ stopOwnedDaemon: !keepDaemonAlive })`) while bounding cleanup and ensuring `tray?.destroy()` and resource disposal always complete promptly.

5. **`WorkspaceSupervisor` live PID reconciliation on `daemon/status` + bounded `stopAllManaged` + `NodeUdsRpcClient` & `scanCatalog` resilience**
   - Reconcile tracked managed PIDs against live OS process state during `daemon/status` in `server/src/daemon/supervisor.ts` so dead/orphaned workspace processes do not remain falsely reported as active Cores.
   - Bound `stopAllManaged` with timeouts and forceful escalation so shutdown/quit cannot hang on unresponsive children.
   - Harden `NodeUdsRpcClient` and `scanCatalog` against transient socket/FS errors, stale sockets, and malformed entries.
