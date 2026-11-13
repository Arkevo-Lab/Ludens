import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync } from "node:fs";
import { mkdir, open, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PRESERVED_ENV_KEYS = [
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "SYSTEMROOT",
  "COMSPEC",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PATHEXT",
  "XDG_STATE_HOME",
  "LUDENS_PYTHON",
  "LUDENS_HOME",
  "SSH_AUTH_SOCK",
  "LUDENS_PERCEPTION_HOT_SECONDS",
  "LUDENS_PERCEPTION_PERSIST",
  "LUDENS_PERCEPTION_SEGMENT_SECONDS",
  "LUDENS_PERCEPTION_HOT_BYTES",
  "LUDENS_PERCEPTION_SEGMENT_BYTES",
] as const;

export interface BackgroundJobRecord {
  version: 1;
  label: string;
  name: string;
  workspace: string;
  command: string[];
  env: Record<string, string>;
  log: string;
  pid: number | null;
  supervisorPid: number;
  state: "running" | "exited";
  lastExitCode: number | null;
  startedAt: string;
  exitedAt?: string;
}

export interface BackgroundJobSpec {
  label: string;
  name: string;
  workspace: string;
  command: string[];
  env: Record<string, string>;
  log: string;
  stateFile: string;
}

export interface BackgroundJobProbe {
  registered: boolean;
  pid: number | null;
  state: string | null;
  lastExitCode: number | null;
}

export interface StartBackgroundJobOptions {
  name: string;
  command: string[];
  cwd?: string;
  label?: string;
  logDir?: string;
  env?: NodeJS.ProcessEnv;
}

export interface StartedBackgroundJob {
  target: string;
  pid: number;
  workspace: string;
  log: string;
  stateFile: string;
}

const sleep = (ms: number) => new Promise<void>(resolveSleep => setTimeout(resolveSleep, ms));

const utcIsoSeconds = (date = new Date()) => date.toISOString().replace(/\.\d{3}Z$/, "Z");

export function isPidAlive(pid: unknown): pid is number {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === "win32") {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
    }
    const probe = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 2000,
    });
    if (probe.error) return true;
    return probe.status === 0 && typeof probe.stdout === "string" && probe.stdout.includes(`,"${pid}",`);
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isPosixProcessGroupAlive(pgid: number): boolean {
  if (process.platform === "win32" || !Number.isInteger(pgid) || pgid <= 0) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sendPosixTreeSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "ESRCH") {
      try {
        process.kill(pid, signal);
      } catch (inner) {
        if ((inner as NodeJS.ErrnoException).code !== "ESRCH") throw inner;
      }
      return;
    }
    throw error;
  }
}

export async function terminateProcessTree(
  pid: number,
  options: { graceMs?: number; immediate?: boolean } = {},
): Promise<void> {
  const treeAlive = () => isPidAlive(pid) || isPosixProcessGroupAlive(pid);
  if (!treeAlive()) return;
  if (process.platform === "win32") {
    await new Promise<void>(resolveKill => {
      const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {}
        resolveKill();
      }, 5000);
      child.once("error", () => {
        clearTimeout(timer);
        resolveKill();
      });
      child.once("close", () => {
        clearTimeout(timer);
        resolveKill();
      });
    });
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && isPidAlive(pid)) {
      await sleep(30);
    }
    return;
  }

  const graceMs = options.immediate ? 0 : (options.graceMs ?? 5000);
  if (graceMs > 0) {
    sendPosixTreeSignal(pid, "SIGTERM");
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      if (!treeAlive()) return;
      await sleep(40);
    }
  }
  if (treeAlive()) {
    sendPosixTreeSignal(pid, "SIGKILL");
    const killDeadline = Date.now() + 1000;
    while (Date.now() < killDeadline && treeAlive()) {
      await sleep(25);
    }
  }
}

export async function atomicWriteJobJson(filePath: string, payload: BackgroundJobRecord): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tempPath = join(dir, `.${basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

export async function readJobRecord(stateFile: string): Promise<BackgroundJobRecord | null> {
  try {
    return JSON.parse(await readFile(stateFile, "utf8")) as BackgroundJobRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

export async function probeBackgroundJob(stateFile: string): Promise<BackgroundJobProbe> {
  let data = await readJobRecord(stateFile);
  if (!data) {
    return { registered: false, pid: null, state: null, lastExitCode: null };
  }
  if (isPidAlive(data.pid)) {
    return { registered: true, pid: data.pid, state: "running", lastExitCode: null };
  }
  if (data.state === "running" && isPidAlive(data.supervisorPid)) {
    const deadline = Date.now() + 500;
    while (Date.now() < deadline) {
      await sleep(15);
      const refreshed = await readJobRecord(stateFile);
      if (!refreshed) {
        return { registered: false, pid: null, state: null, lastExitCode: null };
      }
      data = refreshed;
      if (data.state === "exited" || !isPidAlive(data.supervisorPid)) break;
    }
  }
  const recordedPid = data.pid;
  const lastExitCode =
    typeof data.lastExitCode === "number"
      ? data.lastExitCode
      : typeof recordedPid === "number" && recordedPid > 0
        ? -1
        : null;
  return { registered: true, pid: null, state: "exited", lastExitCode };
}

export async function stopBackgroundJob(
  stateFile: string,
  options: { graceMs?: number; immediate?: boolean } = {},
): Promise<void> {
  const resolvedState = resolve(stateFile);
  const data = await readJobRecord(resolvedState);
  if (!data) return;
  if (typeof data.pid === "number" && data.pid > 0) {
    await terminateProcessTree(data.pid, options);
    const pidDeadline = Date.now() + (options.immediate ? 500 : 2000);
    while (Date.now() < pidDeadline && isPidAlive(data.pid)) {
      await sleep(30);
    }
  }
  if (
    typeof data.supervisorPid === "number" &&
    data.supervisorPid > 0 &&
    data.supervisorPid !== process.pid
  ) {
    const supDeadline = Date.now() + (options.immediate ? 400 : 2000);
    while (Date.now() < supDeadline && isPidAlive(data.supervisorPid)) {
      await sleep(20);
    }
  }
  await unlink(resolvedState).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
}

export function resolveCommandAndEnv(rawCommand: readonly string[]): {
  command: string[];
  extraEnv: Record<string, string>;
} {
  const extraEnv: Record<string, string> = {};
  let command = [...rawCommand];
  if (command[0] === "env") {
    let idx = 1;
    while (idx < command.length && command[idx]!.includes("=") && !command[idx]!.startsWith("=")) {
      const eq = command[idx]!.indexOf("=");
      extraEnv[command[idx]!.slice(0, eq)] = command[idx]!.slice(eq + 1);
      idx++;
    }
    command = command.slice(idx);
  }
  return { command, extraEnv };
}

async function resolveExecutable(
  executable: string,
  searchPath: string,
  cwd: string,
): Promise<string | null> {
  const bunRuntime = (
    globalThis as {
      Bun?: { which?: (bin: string, opts?: { PATH?: string; cwd?: string }) => string | null };
    }
  ).Bun;
  if (typeof bunRuntime?.which === "function") {
    const found = bunRuntime.which(executable, { PATH: searchPath, cwd });
    return found ? await realpath(found).catch(() => resolve(found)) : null;
  }
  const hasSep = isAbsolute(executable) || executable.includes("/") || executable.includes("\\");
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  const candidates = hasSep
    ? [resolve(cwd, executable)]
    : searchPath
        .split(delimiter)
        .filter(Boolean)
        .map(dir => join(dir, executable));
  for (const base of candidates) {
    for (const ext of ["", ...exts]) {
      const full = ext && !base.toLowerCase().endsWith(ext.toLowerCase()) ? `${base}${ext}` : base;
      try {
        accessSync(full, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        const info = await stat(full);
        if (info.isFile()) return await realpath(full).catch(() => resolve(full));
      } catch {}
    }
  }
  return null;
}

async function supervisorSpawnCommand(searchPath: string, cwd: string): Promise<string[]> {
  const selfPath = fileURLToPath(import.meta.url);
  const hasSelfFile = !selfPath.startsWith("/$bunfs/") && !selfPath.includes("\\$bunfs\\") && existsSync(selfPath);
  if (process.versions.bun) {
    if (hasSelfFile) return [process.execPath, selfPath, "--supervise"];
    return [process.execPath, "__supervise-job"];
  }
  const bunExe = await resolveExecutable("bun", searchPath, cwd);
  if (bunExe && hasSelfFile) return [bunExe, selfPath, "--supervise"];
  if (process.platform !== "win32") {
    const ludensBin = resolve(dirname(selfPath), "../../bin/ludens");
    if (existsSync(ludensBin)) return [ludensBin, "__supervise-job"];
  }
  return [process.execPath, selfPath, "--supervise"];
}

async function acquireStartLock(lockFile: string, label: string): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lockFile, "wx", 0o600);
      try {
        await handle.writeFile(`${process.pid}\n`, "utf8");
      } finally {
        await handle.close().catch(() => {});
      }
      return async () => {
        await unlink(lockFile).catch(() => {});
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (attempt === 0) {
        let stale = false;
        try {
          const rawPid = Number((await readFile(lockFile, "utf8")).trim());
          if (Number.isInteger(rawPid) && rawPid > 0 && !isPidAlive(rawPid)) {
            stale = true;
          } else if (!Number.isInteger(rawPid) || rawPid <= 0) {
            const info = await stat(lockFile);
            if (Date.now() - info.mtimeMs > 30_000) stale = true;
          }
        } catch {
          stale = true;
        }
        if (stale) {
          await unlink(lockFile).catch(() => {});
          continue;
        }
      }
      throw new Error(`job already registered: ${label}; stop it before replacing it`);
    }
  }
  throw new Error(`job already registered: ${label}; stop it before replacing it`);
}

export async function startBackgroundJob(options: StartBackgroundJobOptions): Promise<StartedBackgroundJob> {
  const { command, extraEnv } = resolveCommandAndEnv(options.command);
  if (!options.name?.trim()) throw new Error("a job name is required");
  if (command.length === 0 || !command[0]) throw new Error("a command is required");

  const rawWorkspace = resolve(options.cwd ?? process.cwd());
  const workspace = await realpath(rawWorkspace).catch(() => rawWorkspace);
  const identity = createHash("sha256").update(workspace).digest("hex").slice(0, 16);
  const label = options.label || `dev.ludens.core.${identity}.${options.name}`;

  const rawLogs = options.logDir ? resolve(workspace, options.logDir) : join(workspace, "logs", "background");
  await mkdir(rawLogs, { recursive: true });
  const logs = await realpath(rawLogs).catch(() => rawLogs);
  const stateFile = join(logs, `${options.name}.job.json`);
  const lockFile = `${stateFile}.lock`;
  const log = join(logs, `${options.name}.log`);

  const releaseLock = await acquireStartLock(lockFile, label);
  try {
    if (existsSync(stateFile)) {
      throw new Error(`job already registered: ${label}; stop it before replacing it`);
    }

    const baseEnv = options.env ?? process.env;
    const defaultPath = process.platform === "win32" ? (process.env.PATH ?? "") : "/usr/bin:/bin:/usr/sbin:/sbin";
    const searchPath = extraEnv.PATH || baseEnv.PATH || defaultPath;
    const executable = await resolveExecutable(command[0], searchPath, workspace);
    if (!executable) {
      throw new Error(`command not found: ${command[0]}`);
    }

    const jobEnv: Record<string, string> = { PATH: searchPath };
    for (const key of PRESERVED_ENV_KEYS) {
      const val = baseEnv[key];
      if (typeof val === "string") jobEnv[key] = val;
    }
    Object.assign(jobEnv, extraEnv);
    for (const key of Object.keys(jobEnv)) {
      if (key.startsWith("BASEWARE_") || key === "LUDENS_WORKSPACE" || key === "LUDENS_SOCKET") {
        delete jobEnv[key];
      }
    }

    const spec: BackgroundJobSpec = {
      label,
      name: options.name,
      workspace,
      command: [executable, ...command.slice(1)],
      env: jobEnv,
      log,
      stateFile,
    };

    const supervisorCmd = await supervisorSpawnCommand(searchPath, workspace);
    const handshake = await new Promise<{ ok: boolean; pid?: number; error?: string }>((resolveHandshake, rejectHandshake) => {
      const sup = spawn(supervisorCmd[0]!, supervisorCmd.slice(1), {
        cwd: workspace,
        detached: true,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdoutBuf = "";
      let stderrBuf = "";
      let settled = false;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sup.stdout?.destroy();
        sup.stderr?.destroy();
        sup.unref();
        fn();
      };

      const timer = setTimeout(() => {
        if (typeof sup.pid === "number" && sup.pid > 0) {
          if (process.platform === "win32") {
            const killer = spawn("taskkill", ["/PID", String(sup.pid), "/T", "/F"], {
              stdio: "ignore",
              windowsHide: true,
            });
            killer.unref();
          } else {
            try {
              sendPosixTreeSignal(sup.pid, "SIGKILL");
            } catch {}
          }
        } else {
          try {
            sup.kill("SIGKILL");
          } catch {}
        }
        void stopBackgroundJob(stateFile, { immediate: true }).catch(() => {});
        finish(() => rejectHandshake(new Error("background supervisor timed out during initialization")));
      }, 10_000);

      sup.once("error", error => {
        finish(() => rejectHandshake(error));
      });

      sup.stderr?.setEncoding("utf8");
      sup.stderr?.on("data", chunk => {
        stderrBuf += chunk;
      });

      sup.stdout?.setEncoding("utf8");
      sup.stdout?.on("data", chunk => {
        stdoutBuf += chunk;
        const newline = stdoutBuf.indexOf("\n");
        if (newline < 0) return;
        const line = stdoutBuf.slice(0, newline).trim();
        finish(() => {
          try {
            resolveHandshake(JSON.parse(line) as { ok: boolean; pid?: number; error?: string });
          } catch (error) {
            rejectHandshake(new Error(`invalid supervisor handshake: ${line || String(error)}`));
          }
        });
      });

      sup.once("close", () => {
        finish(() => {
          const line = stdoutBuf.trim();
          if (line) {
            try {
              resolveHandshake(JSON.parse(line) as { ok: boolean; pid?: number; error?: string });
              return;
            } catch {}
          }
          rejectHandshake(new Error(stderrBuf.trim() || "background supervisor failed to initialize"));
        });
      });

      sup.stdin?.end(JSON.stringify(spec));
    });

    if (!handshake.ok || typeof handshake.pid !== "number") {
      throw new Error(handshake.error || "background job failed to start");
    }

    return {
      target: label,
      pid: handshake.pid,
      workspace,
      log,
      stateFile,
    };
  } finally {
    await releaseLock();
  }
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function runJobSupervisorFromStdin(): Promise<number> {
  if (process.platform !== "win32") {
    process.on("SIGHUP", () => {});
  }
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});

  const raw = await readAllStdin();
  const spec = JSON.parse(raw) as BackgroundJobSpec;
  mkdirSync(dirname(spec.log), { recursive: true });
  mkdirSync(dirname(spec.stateFile), { recursive: true });

  let logFd: number | undefined;
  let child: ReturnType<typeof spawn>;
  try {
    logFd = openSync(spec.log, "a");
    child = spawn(spec.command[0]!, spec.command.slice(1), {
      cwd: spec.workspace,
      env: spec.env as unknown as NodeJS.ProcessEnv,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logFd, logFd],
    });
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once("spawn", () => resolveSpawn());
      child.once("error", rejectSpawn);
    });
  } catch (error) {
    await new Promise<void>(res =>
      process.stdout.write(`${JSON.stringify({ ok: false, error: String(error) })}\n`, () => res()),
    );
    return 1;
  } finally {
    if (logFd !== undefined) {
      try {
        closeSync(logFd);
      } catch {}
    }
  }

  const exitPromise = new Promise<number>(resolveExit => {
    child.once("exit", (code, signal) => {
      if (typeof code === "number") resolveExit(code);
      else if (signal) resolveExit(-1);
      else resolveExit(0);
    });
  });

  const childPid = child.pid!;
  const record: BackgroundJobRecord = {
    version: 1,
    label: spec.label,
    name: spec.name,
    workspace: spec.workspace,
    command: spec.command,
    env: spec.env,
    log: spec.log,
    pid: childPid,
    supervisorPid: process.pid,
    state: "running",
    lastExitCode: null,
    startedAt: utcIsoSeconds(),
  };
  try {
    await atomicWriteJobJson(spec.stateFile, record);
  } catch (error) {
    await terminateProcessTree(childPid, { immediate: true }).catch(() => {});
    await new Promise<void>(res =>
      process.stdout.write(`${JSON.stringify({ ok: false, error: String(error) })}\n`, () => res()),
    );
    return 1;
  }
  await new Promise<void>(res =>
    process.stdout.write(`${JSON.stringify({ ok: true, pid: childPid })}\n`, () => res()),
  );

  const exitCode = await exitPromise;
  const current = await readJobRecord(spec.stateFile);
  if (current && current.pid === childPid && existsSync(spec.stateFile)) {
    current.pid = null;
    current.state = "exited";
    current.lastExitCode = exitCode;
    current.exitedAt = utcIsoSeconds();
    if (existsSync(spec.stateFile)) {
      try {
        await atomicWriteJobJson(spec.stateFile, current);
      } catch {}
    }
  }
  return 0;
}

export async function runBackgroundJobCli(args: string[], cwd = process.cwd()): Promise<number> {
  if (args.length === 1 && args[0] === "--supervise") {
    return runJobSupervisorFromStdin();
  }
  if (args.length === 2 && args[0] === "--status") {
    const probe = await probeBackgroundJob(resolve(cwd, args[1]!));
    process.stdout.write(`${JSON.stringify(probe)}\n`);
    return 0;
  }
  if (args.length === 2 && args[0] === "--stop") {
    await stopBackgroundJob(resolve(cwd, args[1]!));
    return 0;
  }

  let label: string | undefined;
  let logDir: string | undefined;
  let idx = 0;
  while (idx < args.length) {
    const arg = args[idx]!;
    if (arg === "--label") {
      if (!args[idx + 1]) throw new Error("--label requires a value");
      label = args[idx + 1];
      idx += 2;
    } else if (arg === "--log-dir") {
      if (!args[idx + 1]) throw new Error("--log-dir requires a path");
      logDir = args[idx + 1];
      idx += 2;
    } else {
      break;
    }
  }

  const name = args[idx];
  const command = args.slice(idx + 1);
  if (!name || command.length === 0) {
    throw new Error("Usage: [--label <label>] [--log-dir <dir>] <name> <command...>");
  }

  const started = await startBackgroundJob({
    name,
    command,
    cwd,
    ...(label ? { label } : {}),
    ...(logDir ? { logDir } : {}),
  });
  process.stdout.write(`${JSON.stringify(started)}\n`);
  return 0;
}

const isMainModule =
  Boolean((import.meta as { main?: boolean }).main) ||
  Boolean(process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url));

if (isMainModule) {
  runBackgroundJobCli(process.argv.slice(2))
    .then(code => process.exit(code))
    .catch(error => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
