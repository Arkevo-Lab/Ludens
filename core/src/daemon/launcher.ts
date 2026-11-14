import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultSocket } from "@ludens/baseware/address";
import {
  isOmpEffort,
  isOmpServiceTier,
  ludensHome,
  validateConnectionConfig,
  type ModelConnectionConfig,
  type OmpEffort,
  type OmpServiceTier,
} from "@ludens/protocol/ludens";
import {
  validateWorkspaceMachinesBinding,
  type BasewareMachineSpec,
  type MachineTransportKind,
  type WorkspaceMachinesBinding,
} from "@ludens/protocol/machines";
import type { ServiceLaunchOrigin } from "../core/query/types.ts";
import { NodeUdsRpcClient, WsAppRpcClient } from "../cli/app-rpc-client.ts";
import { probeAppDaemon, readAppDaemonRuntime } from "./app-daemon.ts";
import { resolveAppServerSocketPath } from "./app-server-paths.ts";
import { jobStateFilePath, jobTargetLabel } from "./background-jobs.ts";
import {
  probeBackgroundJob,
  startBackgroundJob,
  stopBackgroundJob,
  type BackgroundJobProbe,
  type StartBackgroundJobOptions,
} from "./process-manager.ts";

export interface DriverManifest {
  id: string;
  version?: string;
  transport?: MachineTransportKind;
  defaultPort?: number;
  needsGame?: boolean;
  launchHint?: string;
  /** Backend executable argv (without the game path); game path is appended by the launcher. */
  launchCommand?: string[];
  launchEnv?: Record<string, string>;
}

export interface LaunchConfig {
  driver: string;
  driverPackage?: string;
  game?: string;
  port?: number;
  cuaCommand?: string;
  model: string;
  serviceTier?: OmpServiceTier;
  effort?: OmpEffort;
  seconds: number;
  requests: number;
  /** OMP native compaction trigger override; undefined follows the selected model's native OMP default. */
  compactionThreshold?: number;
  connection?: ModelConnectionConfig;
  machines?: WorkspaceMachinesBinding;
  dashboard: boolean;
  pet: boolean;
  logging: { diagnostics: "normal" | "full" };
}

export function parseConfig(value: unknown, manifest?: DriverManifest): LaunchConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ludens.json must be an object");
  const config = value as Record<string, unknown>;
  const allowed = ["driver", "driverPackage", "game", "port", "cuaCommand", "model", "serviceTier", "effort", "seconds", "requests", "compactionThreshold", "connection", "machines", "dashboard", "pet", "logging"];
  for (const key of Object.keys(config)) if (!allowed.includes(key)) throw new Error(`Unknown ludens.json field: ${key}`);
  if (typeof config.driver !== "string" || !config.driver.trim()) throw new Error("ludens.json driver must be a non-empty driver id");
  if (config.driverPackage !== undefined && (typeof config.driverPackage !== "string" || !config.driverPackage.trim())) {
    throw new Error("driverPackage must be a non-empty package spec");
  }
  if (config.game !== undefined && (typeof config.game !== "string" || !config.game.trim())) throw new Error("game must be a non-empty path");
  const bridge = manifest ? manifest.transport !== "stdio" : true;
  if (manifest && manifest.id !== config.driver) throw new Error(`Driver manifest id ${JSON.stringify(manifest.id)} does not match ludens.json driver ${JSON.stringify(config.driver)}`);
  if (!bridge && (config.game !== undefined || config.port !== undefined)) throw new Error(`${config.driver} does not use game or a bridge port`);
  if (manifest && config.game !== undefined && !manifest.launchCommand?.length) throw new Error(`${config.driver} does not support launching a game; omit game and prepare the device separately`);
  if (config.cuaCommand !== undefined && (bridge || typeof config.cuaCommand !== "string" || !config.cuaCommand.trim())) {
    throw new Error("cuaCommand must be a non-empty executable path for a stdio driver");
  }
  const result = { ...(bridge && manifest?.defaultPort !== undefined ? { port: manifest.defaultPort } : {}),
    model: "openai-codex/gpt-6.1-sol",
    seconds: 1800, requests: 1000, dashboard: true, pet: false, logging: { diagnostics: "normal" }, ...config } as LaunchConfig;
  if (!result.logging || typeof result.logging !== "object" || Array.isArray(result.logging)
    || Object.keys(result.logging).some(key => key !== "diagnostics")
    || !["normal", "full"].includes(result.logging.diagnostics)) throw new Error("logging must contain diagnostics: normal|full");
  for (const key of ["seconds", "requests"] as const) {
    if (!Number.isInteger(result[key]) || result[key] <= 0) throw new Error(`${key} must be a positive integer`);
  }
  if (result.compactionThreshold !== undefined && (!Number.isInteger(result.compactionThreshold) || result.compactionThreshold <= 0)) {
    throw new Error("compactionThreshold must be a positive integer");
  }
  if (config.connection !== undefined) {
    const validated = validateConnectionConfig(config.connection, "connection");
    if (Object.keys(validated).length > 0) result.connection = validated;
    else delete result.connection;
  }
  if (config.machines !== undefined) {
    result.machines = validateWorkspaceMachinesBinding(config.machines, "machines");
  } else {
    delete result.machines;
  }
  if (bridge && result.port === undefined) throw new Error(`${config.driver} requires a bridge port; set port in ludens.json or defaultPort in its driver manifest`);
  if (result.port !== undefined && (!Number.isInteger(result.port) || result.port <= 0 || result.port > 65535)) throw new Error("port must be an integer from 1 to 65535");
  if (typeof result.model !== "string" || !result.model.trim()) throw new Error("model must be a non-empty string");
  if (result.serviceTier !== undefined && !isOmpServiceTier(result.serviceTier)) throw new Error("serviceTier must be priority or ultrafast");
  if (result.effort !== undefined && !isOmpEffort(result.effort)) throw new Error("effort must be minimal, low, medium, high, xhigh, or max");
  for (const key of ["dashboard", "pet"] as const) if (typeof result[key] !== "boolean") throw new Error(`${key} must be boolean`);
  return result;
}

export type ServiceName = "emulator" | "baseware" | "host" | "dashboard" | "pet";
export interface LaunchPlan {
  workspace: string;
  config: LaunchConfig;
  manifest?: DriverManifest;
  activeMachine?: BasewareMachineSpec;
  dashboardUrl: string;
  dashboardCheck: string[];
  background: string;
  sharedPet: { cwd: string; background: string };
  launcher: string;
  ludens: string;
  baseware: string;
  basewareSocket: string;
  commands: Partial<Record<ServiceName, string[]>>;
}

export async function launchPlan(
  config: LaunchConfig,
  workspace: string,
  repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
  socket?: string,
  manifest?: DriverManifest,
  activeMachine?: BasewareMachineSpec,
): Promise<LaunchPlan> {
  const ludens = join(repo, "core/bin/ludens");
  const baseware = join(repo, "baseware/bin/baseware");
  const basewareSocket = socket ?? await defaultSocket(workspace);
  const background = join(workspace, "logs/background");
  const sharedPet = { cwd: repo, background: join(ludensHome(), "pet/background") };

  const effectiveDriver = activeMachine ? activeMachine.driver : config.driver;
  const effectivePackage = activeMachine ? activeMachine.driverPackage : config.driverPackage;
  const resolvedPackage = effectivePackage
    ? effectivePackage.startsWith("file:")
      ? `file:${resolve(workspace, effectivePackage.slice(5))}`
      : effectivePackage
    : undefined;

  let emulatorCmd: string[] | undefined;
  let transportArgs: string[] = [];

  if (activeMachine) {
    const t = activeMachine.transport;
    switch (t.kind) {
      case "bridge": {
        const host = t.host ?? "127.0.0.1";
        transportArgs = ["--transport", "bridge", ...(host !== "127.0.0.1" ? ["--host", host] : []), "--port", String(t.port)];
        if (t.managed && t.game && manifest?.launchCommand) {
          emulatorCmd = [
            "env",
            ...Object.entries(manifest.launchEnv ?? {}).map(([key, value]) => `${key}=${value}`),
            `LUDENS_BRIDGE_PORT=${t.port}`,
            ...manifest.launchCommand,
            resolve(workspace, t.game),
          ];
        }
        break;
      }
      case "stdio":
        transportArgs = [
          "--transport",
          "stdio",
          ...(t.command ? ["--cua-command", t.command] : []),
        ];
        break;
      case "ssh":
        transportArgs = [
          "--transport",
          "ssh",
          "--ssh-host",
          t.host,
          ...(t.user ? ["--ssh-user", t.user] : []),
          ...(t.port !== undefined ? ["--ssh-port", String(t.port)] : []),
          ...(t.identityFile ? ["--ssh-identity", t.identityFile] : []),
          ...(t.command ? ["--ssh-command", t.command] : []),
        ];
        break;
      case "http":
      case "sse":
        transportArgs = ["--transport", t.kind, "--url", t.url];
        break;
    }
  } else {
    const bridge = manifest ? manifest.transport !== "stdio" : true;
    if (config.game && bridge && manifest?.launchCommand) {
      emulatorCmd = [
        "env",
        ...Object.entries(manifest.launchEnv ?? {}).map(([key, value]) => `${key}=${value}`),
        `LUDENS_BRIDGE_PORT=${config.port}`,
        ...manifest.launchCommand,
        resolve(workspace, config.game),
      ];
    }
    transportArgs = [
      ...(bridge && config.port !== undefined ? ["--port", String(config.port)] : []),
      ...(config.cuaCommand ? ["--cua-command", config.cuaCommand] : []),
    ];
  }

  return {
    workspace, config, manifest, ...(activeMachine ? { activeMachine } : {}), dashboardUrl: resolveAppServerSocketPath(ludensHome()), background, sharedPet,
    dashboardCheck: ["npm", "--prefix", join(repo, "app"), "run", "build:check"],
    launcher: join(repo, "core/src/daemon/process-manager.ts"), ludens, baseware, basewareSocket,
    commands: {
      ...(emulatorCmd ? { emulator: emulatorCmd } : {}),
      baseware: [baseware, "serve", "--driver", effectiveDriver,
        ...(activeMachine ? ["--machine-id", activeMachine.id] : []),
        ...(resolvedPackage ? ["--driver-package", resolvedPackage] : []),
        ...transportArgs, "--socket", basewareSocket,
        "--data-dir", join(workspace, "logs/baseware"), "--diagnostics", config.logging.diagnostics],
      host: [ludens, "run", "--baseware-socket", basewareSocket, "--model", config.model,
        "--seconds", String(config.seconds), "--requests", String(config.requests),
        ...(config.compactionThreshold !== undefined
          ? ["--compaction-threshold", String(config.compactionThreshold)] : []),
        "--diagnostics", config.logging.diagnostics,
      ],
      ...(config.dashboard ? { dashboard: [ludens, "app-server", "--static-dir", join(repo, "app/out")] } : {}),
      ...(config.pet ? { pet: petLaunchCommand(repo, workspace) } : {}),
    },
  };
}

export function petLaunchCommand(repo: string, workspace: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32") {
    return [
      join(repo, "app/node_modules/electron/dist/electron.exe"),
      join(repo, "app/dist/electron/main.js"),
      "--workspace",
      workspace,
      "--show-window",
    ];
  }
  return [join(repo, "app/bin/ludens-app"), "--workspace", workspace, "--show-window"];
}

type CommandResult = { code: number; stdout: string; stderr: string };
type HostStatus = { runId: string; mode: string; connected: boolean; thinking: boolean; consolidating: boolean; maxSeconds: number };
type BasewareStatus = { serviceId: string; mode: string; connected: boolean; epoch: string | null };
type Job = { target: string; registered: boolean; pid: number | null; state: string | null; lastExitCode: number | null };

export interface LaunchIO {
  run(argv: string[], cwd: string): Promise<CommandResult>;
  dashboardReady(url: string): Promise<boolean>;
  petReady(url: string): Promise<boolean>;
  sleep(): Promise<void>;
  now(): number;
  note(message: string): void;
  jobStatus?(stateFile: string): Promise<BackgroundJobProbe>;
  stopJob?(stateFile: string): Promise<void>;
  startJob?(options: StartBackgroundJobOptions): Promise<void>;
}

export function createSystemLaunchIO(options: { env?: NodeJS.ProcessEnv; note?: (message: string) => void } = {}): LaunchIO {
  const baseEnv = options.env ?? process.env;
  const effectiveHome = baseEnv.LUDENS_HOME ? resolve(baseEnv.LUDENS_HOME) : ludensHome();
  return {
    async run(argv, cwd) {
      const env = { ...baseEnv };
      // Workspace selection must not inherit a previous agent shell's address or lease.
      for (const key of Object.keys(env)) {
        if (key.startsWith("BASEWARE_") || ["LUDENS_SOCKET", "LUDENS_WORKSPACE"].includes(key)) delete env[key];
      }
      let command = [...argv];
      if (command[0] === "env") {
        let idx = 1;
        while (idx < command.length && command[idx]!.includes("=") && !command[idx]!.startsWith("=")) {
          const eq = command[idx]!.indexOf("=");
          env[command[idx]!.slice(0, eq)] = command[idx]!.slice(eq + 1);
          idx++;
        }
        command = command.slice(idx);
      }
      let child: ReturnType<typeof Bun.spawn>;
      try {
        child = Bun.spawn(command, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      } catch (error) {
        return { code: 127, stdout: "", stderr: String(error) };
      }
      const timer = setTimeout(() => child.kill(), 10_000);
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout as ReadableStream).text(),
          new Response(child.stderr as ReadableStream).text(),
        ]);
        return { code, stdout, stderr };
      } finally { clearTimeout(timer); }
    },
    async dashboardReady(target) {
      if (target && /^(https?|wss?):\/\//i.test(target)) {
        const client = new WsAppRpcClient({ url: target, connectTimeoutMs: 2000 });
        try {
          await client.connect();
          const status = await client.call("daemon/status", undefined, { timeoutMs: 2000 });
          return resolve(status.home) === effectiveHome;
        } catch {
          return false;
        } finally {
          await client.close().catch(() => {});
        }
      }
      const status = await probeAppDaemon(effectiveHome, {
        timeoutMs: 2000,
        ...(target ? { socketPath: target } : {}),
      });
      return status !== null && resolve(status.home) === effectiveHome;
    },
    async petReady(target) {
      if (target && /^(https?|wss?):\/\//i.test(target)) {
        const client = new WsAppRpcClient({ url: target, connectTimeoutMs: 5000 });
        try {
          await client.connect();
          const state = await client.call("pet/getState", undefined, { timeoutMs: 5000 });
          return (state as { connected?: unknown }).connected === true;
        } catch {
          return false;
        } finally {
          await client.close().catch(() => {});
        }
      }
      const runtime = await readAppDaemonRuntime(effectiveHome);
      const socketPath = target || runtime?.socketPath || resolveAppServerSocketPath(effectiveHome);
      const client = new NodeUdsRpcClient({ socketPath, connectTimeoutMs: 5000 });
      try {
        await client.connect();
        const state = await client.call("pet/getState", undefined, { timeoutMs: 5000 });
        return (state as { connected?: unknown }).connected === true;
      } catch {
        return false;
      } finally {
        await client.close().catch(() => {});
      }
    },
    sleep: () => Bun.sleep(500),
    now: Date.now,
    note: options.note ?? (message => console.error(message)),
    jobStatus: stateFile => probeBackgroundJob(stateFile),
    stopJob: stateFile => stopBackgroundJob(stateFile),
    async startJob(jobOptions) {
      await startBackgroundJob({ ...jobOptions, env: jobOptions.env ?? baseEnv });
    },
  };
}

const systemIO: LaunchIO = createSystemLaunchIO();

function parseSsPids(stdout: string, port: number, state: "LISTEN" | "ESTAB"): number[] {
  const pids = new Set<number>();
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cols = trimmed.split(/\s+/);
    if (cols[0] !== state) continue;
    const local = cols[3] ?? "";
    if (!local.endsWith(`:${port}`)) continue;
    for (const match of trimmed.matchAll(/pid=(\d+)/g)) pids.add(Number(match[1]));
  }
  return [...pids];
}

function parseNetstatPids(stdout: string, port: number, state: "LISTENING" | "ESTABLISHED"): number[] {
  const pids = new Set<number>();
  for (const line of stdout.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || cols[0]?.toUpperCase() !== "TCP") continue;
    if (cols[3]?.toUpperCase() !== state) continue;
    if (!(cols[1] ?? "").endsWith(`:${port}`)) continue;
    const pid = Number(cols[4]);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

export interface UpOptions {
  includeDashboard?: boolean;
  includePet?: boolean;
  launchedBy?: ServiceLaunchOrigin;
  appInstanceId?: string;
  services?: readonly ("emulator" | "baseware" | "host")[];
}

// Thin cross-platform orchestration over the CLI and pure-TS background process manager (no auto-restart loop).
export class WorkspaceLauncher {
  constructor(readonly plan: LaunchPlan, private io: LaunchIO = systemIO) {}

  private run(argv: string[], cwd = this.plan.workspace) { return this.io.run(argv, cwd); }
  private async checked(argv: string[], cwd = this.plan.workspace) {
    const result = await this.run(argv, cwd);
    if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `${argv[0]} exited ${result.code}`);
    return result;
  }
  private stateFile(name: ServiceName) {
    return jobStateFilePath(name === "pet" ? this.plan.sharedPet.background : this.plan.background, name);
  }
  async job(name: ServiceName): Promise<Job> {
    const hash = createHash("sha256").update(this.plan.workspace).digest("hex").slice(0, 16);
    const target = jobTargetLabel(hash, name);
    const parsed = this.io.jobStatus
      ? await this.io.jobStatus(this.stateFile(name))
      : JSON.parse((await this.checked([process.execPath, this.plan.launcher, "--status", this.stateFile(name)])).stdout) as BackgroundJobProbe;
    return {
      target,
      registered: Boolean(parsed.registered),
      pid: typeof parsed.pid === "number" && parsed.pid > 0 ? parsed.pid : null,
      state: parsed.state ?? null,
      lastExitCode: typeof parsed.lastExitCode === "number" ? parsed.lastExitCode : null,
    };
  }
  async host(): Promise<HostStatus | null> {
    const result = await this.run([this.plan.ludens, "status"]);
    return result.code === 0 ? JSON.parse(result.stdout) : null;
  }
  async baseware(): Promise<BasewareStatus | null> {
    const result = await this.run(["env", `BASEWARE_SOCKET=${this.plan.basewareSocket}`, this.plan.baseware, "status"]);
    return result.code === 0 ? JSON.parse(result.stdout) : null;
  }
  async status() {
    const [host, baseware, dashboard, pet, ...jobs] = await Promise.all([this.host(), this.baseware(), this.io.dashboardReady(this.plan.dashboardUrl), this.io.petReady(this.plan.dashboardUrl),
      ...(["emulator", "baseware", "host", "dashboard", "pet"] as const).map(async name => ({
        name, scope: name === "pet" ? "shared" : "workspace", ...await this.job(name), log: this.log(name),
      }))]);
    return { workspace: this.plan.workspace, host, baseware, dashboard: { url: this.plan.dashboardUrl, ready: dashboard }, pet: { connected: pet }, jobs };
  }
  private log(name: ServiceName) {
    return join(name === "pet" ? this.plan.sharedPet.background : this.plan.background, `${name}.log`);
  }
  private async waitFor<T>(description: string, probe: () => Promise<T | null | false>): Promise<T> {
    const deadline = this.io.now() + 120_000;
    do {
      const result = await probe();
      if (result) return result;
      await this.io.sleep();
    } while (this.io.now() < deadline);
    throw new Error(`Timed out waiting for ${description}. Check ${this.plan.background}; use ludens services to inspect remaining processes.`);
  }
  private async stopJob(name: ServiceName) {
    if (this.io.stopJob) {
      await this.io.stopJob(this.stateFile(name));
      return;
    }
    await this.checked([process.execPath, this.plan.launcher, "--stop", this.stateFile(name)]);
  }
  private async ensure(
    name: ServiceName,
    provenance?: { launchedBy?: ServiceLaunchOrigin; appInstanceId?: string },
  ) {
    const job = await this.job(name);
    if (job.pid) { this.io.note(`Reusing ${name} (PID ${job.pid}).`); return; }
    // Remove only this managed service's stopped registration before starting fresh.
    if (job.registered) await this.stopJob(name);
    this.io.note(`Starting ${name}; log: ${this.log(name)}`);
    const command = this.plan.commands[name]!;
    const cwd = name === "pet" ? this.plan.sharedPet.cwd : this.plan.workspace;
    if (this.io.startJob) {
      await this.io.startJob({
        name,
        command,
        cwd,
        ...(name === "pet" ? { label: "dev.ludens.pet", logDir: this.plan.sharedPet.background } : { logDir: this.plan.background }),
        ...(provenance?.launchedBy ? { launchedBy: provenance.launchedBy } : {}),
        ...(provenance?.appInstanceId ? { appInstanceId: provenance.appInstanceId } : {}),
      });
      return;
    }
    await this.checked([
      process.execPath,
      this.plan.launcher,
      ...(name === "pet" ? ["--label", "dev.ludens.pet", "--log-dir", this.plan.sharedPet.background] : []),
      ...(provenance?.launchedBy ? ["--launched-by", provenance.launchedBy] : []),
      ...(provenance?.appInstanceId ? ["--app-instance-id", provenance.appInstanceId] : []),
      name,
      ...command,
    ], cwd);
  }
  async isPortListening(port: number): Promise<boolean> {
    return (await this.listeningPids(port)).length > 0;
  }
  private async alive(name: ServiceName) {
    const job = await this.job(name);
    if (!job.registered || (!job.pid && job.lastExitCode !== null)) throw new Error(`${name} exited; see ${this.log(name)}`);
    return job.pid;
  }
  private async listeningPids(port: number) {
    if (process.platform === "win32") {
      const netstat = await this.run(["netstat", "-ano", "-p", "tcp"]);
      return parseNetstatPids(netstat.stdout, port, "LISTENING");
    }
    const result = await this.run(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
    if (result.code === 127 && process.platform === "linux") {
      const ss = await this.run(["ss", "-Htanp"]);
      return parseSsPids(ss.stdout, port, "LISTEN");
    }
    return result.stdout.trim().split(/\s+/).filter(Boolean).map(Number);
  }
  private async bridgeClients(port: number) {
    const listeners = await this.listeningPids(port);
    if (process.platform === "win32") {
      const netstat = await this.run(["netstat", "-ano", "-p", "tcp"]);
      return parseNetstatPids(netstat.stdout, port, "ESTABLISHED").filter(pid => !listeners.includes(pid));
    }
    const result = await this.run(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:ESTABLISHED", "-t"]);
    if (result.code === 127 && process.platform === "linux") {
      const ss = await this.run(["ss", "-Htanp"]);
      return parseSsPids(ss.stdout, port, "ESTAB").filter(pid => !listeners.includes(pid));
    }
    return result.stdout.trim().split(/\s+/).filter(Boolean).map(Number).filter(pid => !listeners.includes(pid));
  }
  private async listeningPortsForPid(pid: number): Promise<number[]> {
    if (process.platform === "win32") {
      const netstat = await this.run(["netstat", "-ano", "-p", "tcp"]);
      const ports: number[] = [];
      for (const line of netstat.stdout.split(/\r?\n/)) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 5 || cols[0]?.toUpperCase() !== "TCP" || cols[3]?.toUpperCase() !== "LISTENING") continue;
        if (Number(cols[4]) !== pid) continue;
        const portMatch = cols[1]?.match(/:(\d+)$/);
        if (portMatch) ports.push(Number(portMatch[1]));
      }
      return ports;
    }
    const listeners = await this.run(["lsof", "-a", "-p", String(pid), "-nP", "-iTCP", "-sTCP:LISTEN", "-F", "n"]);
    if (listeners.code === 127 && process.platform === "linux") {
      const ss = await this.run(["ss", "-Htanp"]);
      const ports: number[] = [];
      for (const line of ss.stdout.split(/\r?\n/)) {
        const cols = line.trim().split(/\s+/);
        if (cols[0] !== "LISTEN" || !line.includes(`pid=${pid},`)) continue;
        const portMatch = cols[3]?.match(/:(\d+)$/);
        if (portMatch) ports.push(Number(portMatch[1]));
      }
      return ports;
    }
    const ports: number[] = [];
    for (const match of listeners.stdout.matchAll(/^n.*:(\d+)$/gm)) ports.push(Number(match[1]));
    return ports;
  }
  async up(options?: UpOptions) {
    const wantDashboard = options?.includeDashboard ?? this.plan.config.dashboard;
    const wantPet = options?.includePet ?? this.plan.config.pet;
    const serviceSet = options?.services ? new Set(options.services) : null;
    const wantBaseware = !serviceSet || serviceSet.has("baseware") || serviceSet.has("host");
    const wantHost = !serviceSet || serviceSet.has("host");
    const wantEmulatorOnly = Boolean(serviceSet && serviceSet.has("emulator") && !wantBaseware);
    const provenance = (options?.launchedBy || options?.appInstanceId)
      ? {
          ...(options.launchedBy ? { launchedBy: options.launchedBy } : {}),
          ...(options.appInstanceId ? { appInstanceId: options.appInstanceId } : {}),
        }
      : undefined;
    // Fail before launching the device when the permanent Dashboard would run stale code.
    let dashboard = (wantDashboard || wantPet) ? await this.io.dashboardReady(this.plan.dashboardUrl) : false;
    if (wantDashboard && !dashboard) {
      const build = await this.run(this.plan.dashboardCheck);
      if (build.code !== 0) throw new Error(build.stderr || build.stdout || "Build the Dashboard before starting it.");
      if ((await this.job("dashboard")).pid) {
        throw new Error("A Dashboard daemon job is registered for a different Ludens home or unready service. Stop that Dashboard before switching global homes.");
      }
    }
    if (wantEmulatorOnly && this.plan.commands.emulator) {
      const emulator = await this.job("emulator");
      const port = this.plan.activeMachine?.transport.kind === "bridge"
        ? this.plan.activeMachine.transport.port
        : this.plan.config.port;
      if (!emulator.pid && port !== undefined && (await this.listeningPids(port)).length) {
        throw new Error(`Bridge port ${port} is already listening outside this workspace's emulator job. Omit game to connect to the prepared device, or use its workspace.`);
      }
      await this.ensure("emulator", provenance);
      if (port !== undefined) {
        await this.waitFor("this emulator's bridge listener", async () => {
          const pid = await this.alive("emulator");
          return !!pid && (await this.listeningPids(port)).includes(pid);
        });
      }
      return this.status();
    }
    if (wantBaseware) {
      let baseware = await this.baseware();
      if (!baseware) {
        const existing = await this.job("baseware");
        if (!existing.pid) {
          const manifest = this.plan.manifest;
          const activeMachine = this.plan.activeMachine;
          const isLocalBridge = activeMachine
            ? activeMachine.transport.kind === "bridge" &&
              ["127.0.0.1", "localhost", "::1"].includes(activeMachine.transport.host ?? "127.0.0.1")
            : manifest
              ? manifest.transport !== "stdio"
              : true;
          if (isLocalBridge) {
            const port = activeMachine && activeMachine.transport.kind === "bridge"
              ? activeMachine.transport.port
              : this.plan.config.port!;
            const effectiveDriver = activeMachine ? activeMachine.driver : this.plan.config.driver;
            if (this.plan.commands.emulator) {
              const emulator = await this.job("emulator");
              if (!emulator.pid) {
                if ((await this.listeningPids(port)).length) {
                  throw new Error(`Bridge port ${port} is already listening outside this workspace's emulator job. Omit game to connect to the prepared device, or use its workspace.`);
                }
              }
              await this.ensure("emulator", provenance);
              await this.waitFor("this emulator's bridge listener", async () => {
                const pid = await this.alive("emulator");
                return !!pid && (await this.listeningPids(port)).includes(pid);
              });
            } else if (!(await this.listeningPids(port)).length) {
              throw new Error(`No prepared bridge on port ${port}. ${manifest?.launchHint ?? `Prepare the ${effectiveDriver} backend, then retry.`}`);
            }
            // Only probe bridge ownership when there is no reusable Baseware service.
            const clients = await this.bridgeClients(port);
            if (clients.length) throw new Error(`Bridge port ${port} is already used by PID ${clients.join(", ")}. Use its Baseware service or stop it before switching workspaces.`);
          }
          await this.ensure("baseware", provenance);
        }
        baseware = await this.waitFor("Baseware service", async () => {
          const value = await this.baseware();
          if (value) return value;
          await this.alive("baseware");
          return false;
        });
      } else this.io.note(`Reusing Baseware ${baseware.serviceId}; running settings are unchanged.`);
      if (!baseware.connected) throw new Error("Baseware is alive but its device is disconnected. Inspect ludens services before stopping and starting it again.");
    }

    let host: HostStatus | null = null;
    if (wantHost) {
      host = await this.host();
      if (!host) {
        await this.ensure("host", provenance);
        host = await this.waitFor("Ludens host", async () => {
          const value = await this.host();
          if (value) return value;
          await this.alive("host");
          return false;
        });
      } else this.io.note(`Reusing host ${host.runId}; running settings are unchanged.`);
      if (!host.connected) throw new Error("Host is alive but its device is disconnected. Inspect ludens services before stopping and starting it again.");
    }

    if (wantDashboard || wantPet) {
      dashboard = await this.io.dashboardReady(this.plan.dashboardUrl);
    }
    if (wantDashboard && !dashboard) {
      await this.ensure("dashboard", provenance);
      dashboard = await this.waitFor("Dashboard API", async () => {
        if (await this.io.dashboardReady(this.plan.dashboardUrl)) return true;
        await this.alive("dashboard");
        return false;
      });
    }
    if (wantPet) {
      if (!dashboard) throw new Error("Pet needs the Dashboard. Enable dashboard in ludens.json or start it separately.");
      if (await this.io.petReady(this.plan.dashboardUrl)) this.io.note("Reusing Ludens Pet's connected desktop instance.");
      else {
        await this.ensure("pet", provenance);
        await this.waitFor(`Ludens Pet activity connection (${this.log("pet")})`, async () => {
          if (await this.io.petReady(this.plan.dashboardUrl)) return true;
          const job = await this.job("pet");
          // Electron's single-instance lock can exit successfully while an existing app connects.
          if (!job.registered || (!job.pid && job.lastExitCode !== null && job.lastExitCode !== 0))
            throw new Error(`pet exited; see ${this.log("pet")}`);
          return false;
        });
      }
    }
    if (host) {
      this.io.note(host.mode === "auto" ? "Existing takeover is still running." : "Ready in manual mode. Run ludens auto on to start acting.");
    }
    return this.status();
  }
  async down(includeDashboard: boolean, keepEmulator = false, includePet = false) {
    const managedHost = await this.job("host");
    if (managedHost.pid) {
      const host = await this.host();
      if (host?.mode === "auto") await this.checked([this.plan.ludens, "auto", "off"]);
      if (host) await this.waitFor("model cleanup", async () => {
        const status = await this.host();
        return !status || (!status.thinking && !status.consolidating);
      });
    }
    for (const name of ["host", "baseware", ...(!keepEmulator ? ["emulator"] : []), ...(includePet ? ["pet"] : []), ...(includeDashboard ? ["dashboard"] : [])] as ServiceName[]) {
      const job = await this.job(name);
      if (!job.registered) continue;
      // A manually launched host or another lease holder may still own the device.
      if ((name === "baseware" || name === "emulator") && await this.host()) throw new Error(`An unmanaged host still owns this workspace. Stop it before shutting down ${name}.`);
      if (name === "baseware") {
        const service = await this.baseware();
        if (service && service.mode !== "manual") throw new Error("Baseware still has an active owner. Release its control lease before shutting it down.");
      }
      if (name === "emulator" && job.pid) {
        // An external-device workspace may have attached to this emulator since our host stopped.
        for (const port of await this.listeningPortsForPid(job.pid)) {
          if ((await this.bridgeClients(port)).length) throw new Error("Emulator still has a bridge client from another Baseware service; stop that service before closing it.");
        }
      }
      await this.stopJob(name);
      if (job.pid) await this.waitFor(`${name} to exit`, async () => !(await this.job(name)).pid);
      this.io.note(`Stopped ${name}.`);
    }
    return this.status();
  }
}
