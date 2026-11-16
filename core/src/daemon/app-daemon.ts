import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DaemonStatusResult } from "@ludens/protocol/app-rpc";
import { NodeUdsRpcClient } from "../cli/app-rpc-client.ts";
import {
  appServerLockFilePath,
  appServerRunDir,
  appServerRuntimeFilePath,
  resolveAppServerSocketPath,
  type AppServerRuntimeInfo,
} from "./app-server-paths.ts";

export type { AppServerRuntimeInfo };
export {
  appServerLockFilePath,
  appServerRunDir,
  appServerRuntimeFilePath,
  resolveAppServerSocketPath,
};

export interface EnsureLocalAppDaemonOptions {
  home?: string;
  repo?: string;
  wsListen?: { host: string; port: number } | null;
  auth?: { mode: "none" | "token"; token?: string };
  staticDir?: string;
  trustedOrigins?: string[];
  spawnCommand?: { command: string; argsPrefix: string[] };
  timeoutMs?: number;
}

export interface EnsureLocalAppDaemonResult {
  runtime: AppServerRuntimeInfo;
  status: DaemonStatusResult;
  started: boolean;
}

const inProcessEnsureLocks = new Map<string, Promise<EnsureLocalAppDaemonResult>>();

function ludensHome(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.LUDENS_HOME && !isAbsolute(environment.LUDENS_HOME)) {
    throw new Error("LUDENS_HOME must be an absolute directory");
  }
  return resolve(environment.LUDENS_HOME || join(homedir(), ".ludens"));
}

export function isDaemonPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise(resolveSleep => {
    setTimeout(resolveSleep, ms);
  });
}

function runtimeFromStatus(status: DaemonStatusResult): AppServerRuntimeInfo {
  return {
    pid: status.pid,
    socketPath: status.socketPath || null,
    wsUrl: status.wsUrl,
    authMode: status.authMode,
    startedAt: status.startedAt ?? new Date().toISOString(),
    home: status.home,
  };
}

/** Read `<home>/run/app-server.json` runtime discovery file if present and valid. */
export async function readAppDaemonRuntime(
  home = ludensHome(),
): Promise<AppServerRuntimeInfo | null> {
  const filePath = appServerRuntimeFilePath(home);
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<AppServerRuntimeInfo>;
    if (
      typeof parsed.pid !== "number" ||
      !Number.isInteger(parsed.pid) ||
      typeof parsed.home !== "string"
    ) {
      return null;
    }
    return {
      pid: parsed.pid,
      socketPath: typeof parsed.socketPath === "string" ? parsed.socketPath : null,
      wsUrl: typeof parsed.wsUrl === "string" ? parsed.wsUrl : null,
      authMode: parsed.authMode === "token" ? "token" : "none",
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
      home: parsed.home,
    };
  } catch {
    return null;
  }
}

/** Probe a running app-server daemon over UDS using `daemon/status`. Returns `null` if offline. */
export async function probeAppDaemon(
  home = ludensHome(),
  options: { timeoutMs?: number; socketPath?: string } = {},
): Promise<DaemonStatusResult | null> {
  const resolvedHome = resolve(home);
  const runtime = await readAppDaemonRuntime(resolvedHome);
  if (runtime && !isDaemonPidAlive(runtime.pid)) {
    return null;
  }

  const candidateSocket =
    options.socketPath ?? runtime?.socketPath ?? resolveAppServerSocketPath(resolvedHome);
  if (!candidateSocket) return null;

  const client = new NodeUdsRpcClient({
    socketPath: candidateSocket,
    connectTimeoutMs: options.timeoutMs ?? 800,
  });
  try {
    await client.connect();
    const status = await client.call("daemon/status", undefined, {
      timeoutMs: options.timeoutMs ?? 1200,
    });
    if (resolve(status.home) !== resolvedHome) {
      return null;
    }
    return status;
  } catch {
    return null;
  } finally {
    await client.close().catch(() => {});
  }
}

function resolveDefaultSpawnCommand(repoOverride?: string): { command: string; argsPrefix: string[] } {
  const repoRoot =
    repoOverride ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const mainCli = join(repoRoot, "core", "src", "cli", "main.ts");
  const ludensBin = join(repoRoot, "core", "bin", "ludens");

  // Under Bun, reuse the exact active Bun executable directly with main.ts.
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
    return { command: process.execPath, argsPrefix: [mainCli] };
  }

  if (existsSync(ludensBin)) {
    return { command: ludensBin, argsPrefix: [] };
  }

  return { command: "bun", argsPrefix: [mainCli] };
}

function augmentedDaemonEnv(home: string, token?: string): { env: NodeJS.ProcessEnv; tokenEnvName?: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, LUDENS_HOME: home };
  // Preserve caller PATH under Bun (so tests isolating PATH behave deterministically);
  // only supplement standard Homebrew locations when running inside packaged GUI Node/Electron.
  if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") {
    const currentPath = env.PATH ?? "";
    const extraPaths = ["/opt/homebrew/bin", "/usr/local/bin"];
    const missing = extraPaths.filter(p => !currentPath.split(":").includes(p));
    if (missing.length > 0) {
      env.PATH = currentPath ? `${currentPath}:${missing.join(":")}` : missing.join(":");
    }
  }
  if (token !== undefined) {
    env.LUDENS_APP_TOKEN = token;
    return { env, tokenEnvName: "LUDENS_APP_TOKEN" };
  }
  return { env };
}

async function acquireStartupLock(lockPath: string, timeoutMs: number): Promise<() => Promise<void>> {
  const deadline = Date.now() + timeoutMs;
  await mkdir(dirname(lockPath), { recursive: true });

  for (;;) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, nonce: randomUUID(), at: Date.now() }) + "\n",
        "utf8",
      );
      await handle.close();
      return async () => {
        await unlink(lockPath).catch(() => {});
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      let stale = false;
      try {
        const raw = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown; at?: unknown };
        if (typeof raw.pid === "number" && !isDaemonPidAlive(raw.pid)) {
          stale = true;
        } else if (typeof raw.at === "number" && Date.now() - raw.at > Math.max(30_000, timeoutMs)) {
          stale = true;
        }
      } catch {
        stale = true;
      }

      if (stale) {
        await unlink(lockPath).catch(() => {});
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for app-daemon startup lock: ${lockPath}`);
      }
      await sleepMs(40);
    }
  }
}

/**
 * Ensures the singleton local `app-server` daemon is running for `home` cleanly under Node or Bun.
 * Uses both in-process deduplication and an `O_EXCL` file lock (`<home>/run/app-server.lock`),
 * defaulting to UDS-only (0 TCP ports) when `wsListen` is omitted.
 */
export async function ensureLocalAppDaemon(
  options: EnsureLocalAppDaemonOptions = {},
): Promise<EnsureLocalAppDaemonResult> {
  const home = resolve(options.home ?? ludensHome());
  const inFlight = inProcessEnsureLocks.get(home);
  if (inFlight) return inFlight;

  const work = (async (): Promise<EnsureLocalAppDaemonResult> => {
    const existing = await probeAppDaemon(home);
    if (existing) {
      return {
        runtime: runtimeFromStatus(existing),
        status: existing,
        started: false,
      };
    }

    const timeoutMs = options.timeoutMs ?? 15_000;
    const releaseLock = await acquireStartupLock(appServerLockFilePath(home), timeoutMs);
    try {
      const rechecked = await probeAppDaemon(home);
      if (rechecked) {
        return {
          runtime: runtimeFromStatus(rechecked),
          status: rechecked,
          started: false,
        };
      }

      const spawnCmd = options.spawnCommand ?? resolveDefaultSpawnCommand(options.repo);
      const args = [...spawnCmd.argsPrefix, "app-server"];
      if (options.wsListen) {
        args.push("--listen", `ws://${options.wsListen.host}:${options.wsListen.port}`);
      }
      if (options.auth?.mode === "token") {
        args.push("--auth", "token");
      } else if (options.auth?.mode === "none") {
        args.push("--auth", "none");
      }
      if (options.staticDir) {
        args.push("--static-dir", options.staticDir);
      }
      for (const origin of options.trustedOrigins ?? []) {
        args.push("--trusted-origin", origin);
      }

      const { env, tokenEnvName } = augmentedDaemonEnv(home, options.auth?.token);
      if (tokenEnvName) {
        args.push("--token-env", tokenEnvName);
      }

      const runDir = appServerRunDir(home);
      await mkdir(runDir, { recursive: true });
      const logFd = openSync(join(runDir, "app-server.log"), "a", 0o600);

      const earlyExitState: { value: { code: number | null; signal: NodeJS.Signals | null } | null } = {
        value: null,
      };
      const child = spawn(spawnCmd.command, args, {
        cwd: options.repo ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
        env,
        detached: true,
        stdio: ["ignore", logFd, logFd],
      });
      closeSync(logFd);

      child.once("exit", (code, signal) => {
        earlyExitState.value = { code, signal };
      });
      child.unref();

      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const status = await probeAppDaemon(home);
        if (status) {
          return {
            runtime: runtimeFromStatus(status),
            status,
            started: true,
          };
        }
        if (earlyExitState.value) {
          throw new Error(
            `app-server exited prematurely (code=${earlyExitState.value.code}, signal=${earlyExitState.value.signal}); see ${join(runDir, "app-server.log")}`,
          );
        }
        await sleepMs(45);
      }

      throw new Error(
        `Timed out waiting for local app-server UDS daemon readiness (${timeoutMs}ms); see ${join(runDir, "app-server.log")}`,
      );
    } finally {
      await releaseLock();
    }
  })();

  inProcessEnsureLocks.set(home, work);
  try {
    return await work;
  } finally {
    inProcessEnsureLocks.delete(home);
  }
}

/** Stops the running local `app-server` daemon cleanly over UDS `daemon/shutdown`. */
export async function stopLocalAppDaemon(
  home = ludensHome(),
  options: { stopCores?: boolean; timeoutMs?: number } = {},
): Promise<{ stopped: boolean; pid: number | null; stoppedCores: string[] }> {
  const resolvedHome = resolve(home);
  const runtime = await readAppDaemonRuntime(resolvedHome);
  const status = await probeAppDaemon(resolvedHome);
  const targetPid = status?.pid ?? (runtime && isDaemonPidAlive(runtime.pid) ? runtime.pid : null);
  const socketPath = status?.socketPath || runtime?.socketPath || resolveAppServerSocketPath(resolvedHome);

  if (!status && targetPid === null) {
    return { stopped: false, pid: null, stoppedCores: [] };
  }

  let stoppedCores: string[] = [];
  if (socketPath) {
    const client = new NodeUdsRpcClient({ socketPath, connectTimeoutMs: 1200 });
    try {
      await client.connect();
      const res = await client.call(
        "daemon/shutdown",
        { ...(options.stopCores !== undefined ? { stopCores: options.stopCores } : {}) },
        { timeoutMs: options.timeoutMs ?? 8000 },
      );
      stoppedCores = res.stopped;
    } catch {
      // Fall back to SIGTERM below if UDS shutdown call failed while PID was still alive.
    } finally {
      await client.close().catch(() => {});
    }
  }

  if (targetPid !== null) {
    const deadline = Date.now() + (options.timeoutMs ?? 5000);
    while (Date.now() < deadline && isDaemonPidAlive(targetPid)) {
      await sleepMs(40);
    }
    if (isDaemonPidAlive(targetPid)) {
      try {
        process.kill(targetPid, "SIGTERM");
      } catch {}
      const termDeadline = Date.now() + 2000;
      while (Date.now() < termDeadline && isDaemonPidAlive(targetPid)) {
        await sleepMs(40);
      }
    }
  }

  return { stopped: true, pid: targetPid, stoppedCores };
}
