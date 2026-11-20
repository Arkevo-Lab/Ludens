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
import { resolveRepoRoot } from "../query/repo.ts";
import type { ServiceLaunchOrigin } from "../query/types.ts";
import { NodeUdsRpcClient, WsAppRpcClient } from "./app-rpc-client.ts";
import { send } from "@ludens/core/daemon/transport";
import { readAppDaemonRuntime } from "./app-daemon.ts";
import { resolveAppServerSocketPath } from "./app-server-paths.ts";
import { cliCommand, jobStateFilePath, jobTargetLabel, ludensSocketPath } from "./background-jobs.ts";
import {
  probeBackgroundJob,
  startBackgroundJob,
  stopBackgroundJob,
  type BackgroundJobProbe,
  type StartBackgroundJobOptions,
} from "./process-manager.ts";

import {
  parseWorkspaceLaunchConfig,
  type DriverManifest,
  type LaunchConfig,
} from "../query/workspace-init.ts";
export { type DriverManifest, type LaunchConfig };

export function parseConfig(value: unknown, manifest?: DriverManifest): LaunchConfig {
  return parseWorkspaceLaunchConfig(value, manifest);
}

export type ServiceName = "emulator" | "baseware" | "host" | "pet";
export interface LaunchPlan {
  workspace: string;
  config: LaunchConfig;
  manifest?: DriverManifest;
  activeMachine?: BasewareMachineSpec;
  background: string;
  sharedPet: { cwd: string; background: string };
  launcher: string;
  ludens: string;
  coreSocket: string;
  baseware: string;
  basewareSocket: string;
  commands: Partial<Record<ServiceName, string[]>>;
}

export async function launchPlan(
  config: LaunchConfig,
  workspace: string,
  repo = resolveRepoRoot(),
  socket?: string,
  manifest?: DriverManifest,
  activeMachine?: BasewareMachineSpec,
): Promise<LaunchPlan> {
  const ludens = join(repo, "core/bin/ludens-core");
  const baseware = join(repo, "baseware/bin/baseware");
  const workspaceHash = createHash("sha256").update(workspace).digest("hex").slice(0, 16);
  const coreSocket = ludensSocketPath("core", workspaceHash);
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
    workspace, config, manifest, ...(activeMachine ? { activeMachine } : {}), background, sharedPet,
    launcher: join(repo, "server/src/daemon/process-manager.ts"), ludens, coreSocket, baseware, basewareSocket,
    commands: {
      ...(emulatorCmd ? { emulator: emulatorCmd } : {}),
      baseware: [...cliCommand(baseware), "serve", "--driver", effectiveDriver,
        ...(activeMachine ? ["--machine-id", activeMachine.id] : []),
        ...(resolvedPackage ? ["--driver-package", resolvedPackage] : []),
        ...transportArgs, "--socket", basewareSocket,
        "--data-dir", join(workspace, "logs/baseware"), "--diagnostics", config.logging.diagnostics],
      host: [...cliCommand(ludens), "run", "--baseware-socket", basewareSocket, "--model", config.model,
        ...(config.compactionThreshold !== undefined
          ? ["--compaction-threshold", String(config.compactionThreshold)] : []),
        "--diagnostics", config.logging.diagnostics,
      ],
      ...(config.pet ? { pet: petLaunchCommand(repo, workspace) } : {}),
    },
  };
}

export function petLaunchCommand(repo: string, workspace: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32") {
    return [
      join(repo, "desktop/node_modules/electron/dist/electron.exe"),
      join(repo, "desktop/dist/electron/main.js"),
      "--workspace",
      workspace,
      "--show-window",
    ];
  }
  return [join(repo, "desktop/bin/ludens-app"), "--workspace", workspace, "--show-window"];
}

type CommandResult = { code: number; stdout: string; stderr: string };
type HostStatus = { runId: string; epoch?: string | null; mode: string; connected: boolean; thinking: boolean; consolidating: boolean; timerSeconds: number | null };
type BasewareStatus = { serviceId: string; mode: string; connected: boolean; epoch: string | null };
type Job = { target: string; registered: boolean; pid: number | null; state: string | null; lastExitCode: number | null };

export interface LaunchIO {
  run(argv: string[], cwd: string): Promise<CommandResult>;
  hostStatus?(socket: string): Promise<HostStatus | null>;
  hostAutoOff?(socket: string, host: HostStatus): Promise<void>;
  petReady(url?: string): Promise<boolean>;
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
    async hostStatus(socket) {
      try {
        return (await Promise.race([
          send(socket, { kind: "status", argv: [] }) as Promise<HostStatus>,
          new Promise<null>(done => setTimeout(() => done(null), 5000)),
        ])) as HostStatus | null;
      } catch {
        return null;
      }
    },
    async hostAutoOff(socket, host) {
      await send(socket, {
        kind: "auto",
        argv: ["off"],
        runId: host.runId,
        ...(host.epoch !== undefined ? { expectedEpoch: host.epoch } : {}),
      });
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
  const rows = stdout.split(/\r?\n/).map(line => line.trim().split(/\s+/))
    .filter(cols => cols.length >= 5 && cols[0]?.toUpperCase() === "TCP" && cols[3]?.toUpperCase() === state);
  const suffix = `:${port}`;
  // netstat lists both endpoints of a local connection. Match the reversed
  // endpoint pair so an outbound connection to the same port elsewhere is ignored.
  const bridgePeers = state === "ESTABLISHED"
    ? new Set(rows.filter(cols => cols[1]!.endsWith(suffix)).map(cols => `${cols[2]} ${cols[1]}`))
    : undefined;
  const pids = new Set<number>();
  for (const cols of rows) {
    if (bridgePeers ? !bridgePeers.has(`${cols[1]} ${cols[2]}`) : !cols[1]!.endsWith(suffix)) continue;
    const pid = Number(cols[4]);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

export interface UpOptions {
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
    if (this.io.hostStatus) {
      return this.io.hostStatus(this.plan.coreSocket);
    }
    const result = await this.run([...cliCommand(this.plan.ludens), "status"]);
    return result.code === 0 ? JSON.parse(result.stdout) : null;
  }
  async baseware(): Promise<BasewareStatus | null> {
    const result = await this.run(["env", `BASEWARE_SOCKET=${this.plan.basewareSocket}`, ...cliCommand(this.plan.baseware), "status"]);
    return result.code === 0 ? JSON.parse(result.stdout) : null;
  }
  async status() {
    const [host, baseware, pet, ...jobs] = await Promise.all([this.host(), this.baseware(), this.io.petReady(),
      ...(["emulator", "baseware", "host", "pet"] as const).map(async name => ({
        name, scope: name === "pet" ? "shared" : "workspace", ...await this.job(name), log: this.log(name),
      }))]);
    return { workspace: this.plan.workspace, host, baseware, pet: { connected: pet }, jobs };
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
    if (process.platform === "win32") {
      const netstat = await this.run(["netstat", "-ano", "-p", "tcp"]);
      const listeners = parseNetstatPids(netstat.stdout, port, "LISTENING");
      return parseNetstatPids(netstat.stdout, port, "ESTABLISHED").filter(pid => !listeners.includes(pid));
    }
    const listeners = await this.listeningPids(port);
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

    if (wantPet) {
      if (await this.io.petReady()) this.io.note("Reusing connected Desktop Pet instance.");
      else {
        await this.ensure("pet", provenance);
        await this.waitFor(`Desktop Pet activity connection (${this.log("pet")})`, async () => {
          if (await this.io.petReady()) return true;
          const job = await this.job("pet");
          // Electron's single-instance lock can exit successfully while an existing app connects.
          if (!job.registered || (!job.pid && job.lastExitCode !== null && job.lastExitCode !== 0))
            throw new Error(`pet exited; see ${this.log("pet")}`);
          return false;
        });
      }
    }
    if (host) {
      this.io.note(host.mode === "auto" ? "Existing Auto Run is still active." : "Ready in manual standby. Run ludens auto on to start Auto Run.");
    }
    return this.status();
  }
  async down(keepEmulator = false, includePet = false) {
    const managedHost = await this.job("host");
    if (managedHost.pid) {
      const host = await this.host();
      if (host?.mode === "auto") {
        if (this.io.hostAutoOff) {
          await this.io.hostAutoOff(this.plan.coreSocket, host);
        } else {
          await this.checked([...cliCommand(this.plan.ludens), "auto", "off"]);
        }
      }
      if (host) await this.waitFor("model cleanup", async () => {
        const status = await this.host();
        return !status || (!status.thinking && !status.consolidating);
      });
    }
    for (const name of ["host", "baseware", ...(!keepEmulator ? ["emulator"] : []), ...(includePet ? ["pet"] : [])] as ServiceName[]) {
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
