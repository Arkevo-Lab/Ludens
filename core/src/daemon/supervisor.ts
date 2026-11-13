import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultDriverCacheRoot, resolveDriver } from "@ludens/baseware/drivers/loader.ts";
import {
  ludensHome,
  readMachinesConfig,
  readWorkspaceIdentity,
  registerWorkspace,
  type BasewareMachineSpec,
} from "@ludens/protocol/ludens";
import type { ServiceLaunchOrigin } from "../core/query/types.ts";
import { jobStateFilePath, ludensSocketPath } from "./background-jobs.ts";
import {
  DeviceBusyError,
  findOnlineDeviceHolders,
  isHolderActive,
  resolveWorkspaceDeviceIdentity,
  toDeviceContentionConflict,
} from "./device-arbitration.ts";
import {
  createSystemLaunchIO,
  launchPlan,
  parseConfig,
  WorkspaceLauncher,
  type LaunchIO,
  type LaunchPlan,
} from "./launcher.ts";
import { probeBackgroundJob, readJobRecord, stopBackgroundJob } from "./process-manager.ts";
import { send, type Request as TransportRequest } from "./transport.ts";

export { DeviceBusyError };
export type ManagedServiceName = "emulator" | "baseware" | "host";

export interface SupervisorUpOptions {
  workspace?: string;
  workspaceId?: string;
  services?: readonly ManagedServiceName[];
  launchedBy?: ServiceLaunchOrigin;
  preempt?: boolean;
}

interface OwnedWorkspaceRecord {
  workspace: string;
  workspaceId: string;
  backgroundDir: string;
  hostSocket: string;
  ownedServices: Map<ManagedServiceName, number | null>;
}

export interface WorkspaceSupervisorOptions {
  home?: string;
  repo?: string;
  ioFactory?: (plan: LaunchPlan, note: (message: string) => void) => LaunchIO;
}

export interface SupervisedActionResult {
  status: Awaited<ReturnType<WorkspaceLauncher["status"]>>;
  notes: string[];
}

const MANAGED_SERVICES: readonly ManagedServiceName[] = ["emulator", "baseware", "host"];
const GRACEFUL_CLEANUP_TIMEOUT_MS = 4000;

const sleep = (ms: number) => new Promise<void>(resolveSleep => setTimeout(resolveSleep, ms));

async function sendWithTimeout<T>(socketPath: string, request: TransportRequest, timeoutMs: number): Promise<T | null> {
  try {
    return (await Promise.race([
      send(socketPath, request) as Promise<T>,
      new Promise<null>(resolveTimeout => setTimeout(() => resolveTimeout(null), timeoutMs)),
    ])) as T | null;
  } catch {
    return null;
  }
}

export class WorkspaceSupervisor {
  readonly home: string;
  readonly repo: string;
  readonly instanceId = randomUUID();
  private readonly owned = new Map<string, OwnedWorkspaceRecord>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly deviceLocks = new Map<string, Promise<void>>();
  private readonly ioFactory?: (plan: LaunchPlan, note: (message: string) => void) => LaunchIO;
  private closing = false;

  constructor(options: WorkspaceSupervisorOptions = {}) {
    this.home = resolve(options.home ?? ludensHome());
    this.repo = options.repo ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    this.ioFactory = options.ioFactory;
  }

  managedWorkspaceIds(): string[] {
    const ids: string[] = [];
    for (const record of this.owned.values()) {
      if (record.ownedServices.size > 0) ids.push(record.workspaceId);
    }
    return ids;
  }

  managedWorkspacePaths(): string[] {
    const paths: string[] = [];
    for (const record of this.owned.values()) {
      if (record.ownedServices.size > 0) paths.push(record.workspace);
    }
    return paths;
  }

  ownedServicesFor(workspacePath: string): ReadonlySet<ManagedServiceName> {
    const entry = this.owned.get(resolve(workspacePath));
    return entry ? new Set(entry.ownedServices.keys()) : new Set();
  }

  /** Explicitly bind a spawned workspace service job to this supervisor's lifecycle. */
  async trackOwnedService(
    workspacePath: string,
    service: ManagedServiceName,
    workspaceId?: string,
    expectedPid?: number | null,
  ): Promise<void> {
    const workspace = await realpath(workspacePath).catch(() => resolve(workspacePath));
    const resolvedId =
      workspaceId ??
      (await readWorkspaceIdentity(workspace)
        .then(id => id.id)
        .catch(() => workspace));
    const record = this.ensureRecord(workspace, resolvedId);
    const resolvedPid =
      expectedPid !== undefined
        ? expectedPid
        : (await probeBackgroundJob(jobStateFilePath(record.backgroundDir, service))).pid;
    record.ownedServices.set(service, resolvedPid);
  }

  private ensureRecord(workspace: string, workspaceId: string): OwnedWorkspaceRecord {
    let record = this.owned.get(workspace);
    if (!record) {
      const hash = createHash("sha256").update(workspace).digest("hex").slice(0, 16);
      record = {
        workspace,
        workspaceId,
        backgroundDir: join(workspace, "logs/background"),
        hostSocket: ludensSocketPath("core", hash),
        ownedServices: new Map(),
      };
      this.owned.set(workspace, record);
    } else if (workspaceId && record.workspaceId !== workspaceId) {
      record.workspaceId = workspaceId;
    }
    return record;
  }

  private withDeviceLock<T>(deviceKey: string | null, action: () => Promise<T>): Promise<T> {
    if (!deviceKey) return action();
    const prev = this.deviceLocks.get(deviceKey) ?? Promise.resolve();
    const run = prev.then(action);
    const tail = run.then(
      () => {},
      () => {},
    );
    this.deviceLocks.set(deviceKey, tail);
    void tail.then(() => {
      if (this.deviceLocks.get(deviceKey) === tail) this.deviceLocks.delete(deviceKey);
    });
    return run;
  }

  private withWorkspaceLock<T>(workspace: string, action: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(workspace) ?? Promise.resolve();
    const run = prev.then(action);
    const tail = run.then(
      () => {},
      () => {},
    );
    this.locks.set(workspace, tail);
    void tail.then(() => {
      if (this.locks.get(workspace) === tail) this.locks.delete(workspace);
    });
    return run;
  }

  private makeLauncher(
    plan: LaunchPlan,
    notes: string[],
    onManagedStart?: (service: ManagedServiceName, pid: number | null) => void,
  ): WorkspaceLauncher {
    const note = (msg: string) => {
      notes.push(msg);
    };
    const baseIo = this.ioFactory
      ? this.ioFactory(plan, note)
      : createSystemLaunchIO({
          env: { ...process.env, LUDENS_HOME: this.home },
          note,
        });
    const io: LaunchIO =
      onManagedStart && baseIo.startJob
        ? {
            ...baseIo,
            startJob: async jobOptions => {
              if (this.closing) {
                throw new Error("Workspace supervisor is shutting down");
              }
              await baseIo.startJob!(jobOptions);
              if (MANAGED_SERVICES.includes(jobOptions.name as ManagedServiceName)) {
                const service = jobOptions.name as ManagedServiceName;
                const stateFile = jobStateFilePath(plan.background, service);
                const probe = baseIo.jobStatus
                  ? await baseIo.jobStatus(stateFile)
                  : await probeBackgroundJob(stateFile);
                onManagedStart(service, probe.pid);
                if (this.closing) {
                  await (baseIo.stopJob
                    ? baseIo.stopJob(stateFile)
                    : stopBackgroundJob(stateFile, { immediate: true })
                  ).catch(() => {});
                  throw new Error("Workspace supervisor is shutting down");
                }
              }
            },
          }
        : baseIo;
    return new WorkspaceLauncher(plan, io);
  }

  private async buildUpPlan(workspace: string): Promise<LaunchPlan> {
    const raw = JSON.parse(await readFile(join(workspace, "ludens.json"), "utf8")) as Record<string, unknown>;
    if (typeof raw.driverPackage === "string" && raw.driverPackage.startsWith("file:")) {
      raw.driverPackage = `file:${resolve(workspace, raw.driverPackage.slice(5))}`;
    }
    const cacheRoot = join(this.home, "cache", "drivers");
    let manifest = await resolveDriver(String(raw.driver ?? ""), raw.driverPackage as string | undefined, cacheRoot || defaultDriverCacheRoot());
    const config = parseConfig(raw, manifest);
    config.dashboard = false;
    config.pet = false;

    let activeMachine: BasewareMachineSpec | undefined;
    if (config.machines?.active && config.machines.active !== "workspace-default") {
      const registry = await readMachinesConfig(this.home);
      const found = registry.machines.find(item => item.id === config.machines!.active);
      if (!found) throw new Error(`Unknown Baseware machine in machines.active: ${config.machines.active}`);
      activeMachine = found;
      const pkg = found.driverPackage?.startsWith("file:")
        ? `file:${resolve(workspace, found.driverPackage.slice(5))}`
        : found.driverPackage;
      manifest = await resolveDriver(found.driver, pkg, cacheRoot || defaultDriverCacheRoot());
    }

    const managedGame = activeMachine
      ? activeMachine.transport.kind === "bridge" && activeMachine.transport.managed
        ? activeMachine.transport.game
        : undefined
      : config.game;

    if (managedGame && manifest.launchCommand) {
      const gamePath = resolve(workspace, managedGame);
      const exists = await stat(gamePath)
        .then(() => true)
        .catch(() => false);
      if (!exists) {
        throw new Error(`Missing ${gamePath}. Install/build the components as described in README.md.`);
      }
      const executable = manifest.launchCommand[0];
      const bunWhich = (globalThis as { Bun?: { which?: (bin: string, opts?: { cwd?: string }) => string | null } }).Bun?.which;
      if (executable && typeof bunWhich === "function" && !bunWhich(executable, { cwd: workspace })) {
        throw new Error(`Missing executable ${executable}. Install/build the components as described in README.md.`);
      }
    }

    return launchPlan(config, workspace, this.repo, undefined, manifest, activeMachine);
  }

  private async buildDownPlan(workspace: string): Promise<LaunchPlan> {
    const manifest = await resolveDriver("cua", undefined, join(this.home, "cache", "drivers"));
    const config = parseConfig({ driver: "cua", dashboard: false, pet: false }, manifest);
    return launchPlan(config, workspace, this.repo, undefined, manifest);
  }

  async up(
    workspaceOrOptions: string | (SupervisorUpOptions & { workspace: string }),
    maybeOptions?: SupervisorUpOptions,
  ): Promise<SupervisedActionResult> {
    if (this.closing) throw new Error("Workspace supervisor is shutting down");
    const workspacePath =
      typeof workspaceOrOptions === "string" ? workspaceOrOptions : workspaceOrOptions.workspace;
    const options: SupervisorUpOptions =
      typeof workspaceOrOptions === "string" ? (maybeOptions ?? {}) : workspaceOrOptions;
    const workspace = await realpath(workspacePath);
    const deviceIdentity = await resolveWorkspaceDeviceIdentity(workspace, this.home);
    return this.withDeviceLock(deviceIdentity.deviceKey, () =>
      this.withWorkspaceLock(workspace, () => this.upLocked(workspace, options, deviceIdentity)),
    );
  }

  private async upLocked(
    workspace: string,
    options: SupervisorUpOptions,
    deviceIdentity?: Awaited<ReturnType<typeof resolveWorkspaceDeviceIdentity>>,
  ): Promise<SupervisedActionResult> {
    if (this.closing) throw new Error("Workspace supervisor is shutting down");
    let registration;
    try {
      registration = await registerWorkspace(workspace, this.home);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          "Workspace identity is missing. Use ludens init for a new workspace, or ludens workspace import <path> for an existing workspace.",
        );
      }
      throw error;
    }

    const identity = deviceIdentity ?? (await resolveWorkspaceDeviceIdentity(workspace, this.home));
    const holders = await findOnlineDeviceHolders(workspace, identity, this.home);
    for (const holder of holders) {
      if (isHolderActive(holder) && !options.preempt) {
        throw new DeviceBusyError(toDeviceContentionConflict(holder));
      }
    }

    const workspaceId = options.workspaceId ?? registration.id;
    const launchedBy: ServiceLaunchOrigin = options.launchedBy ?? "app";
    const appInstanceId = launchedBy === "app" ? this.instanceId : undefined;
    const plan = await this.buildUpPlan(workspace);
    const notes: string[] = [];
    const launcher = this.makeLauncher(
      plan,
      notes,
      launchedBy === "app"
        ? (service, pid) => {
            const record = this.ensureRecord(workspace, workspaceId);
            record.ownedServices.set(service, pid);
          }
        : undefined,
    );

    if (holders.length > 0) {
      for (const holder of holders) {
        notes.push(
          `Stopping ${isHolderActive(holder) ? "active" : "standby"} holder ${holder.workspaceName} (${holder.projectId}) on device ${holder.deviceKey}.`,
        );
        await this.down(holder.workspace, { keepEmulator: false });
      }
      if (identity.port !== undefined) {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && (await launcher.isPortListening(identity.port))) {
          await sleep(50);
        }
      }
    }

    const preExistingPids = new Map<ManagedServiceName, number | null>();
    for (const service of MANAGED_SERVICES) {
      const job = await launcher.job(service);
      preExistingPids.set(service, job.pid);
    }

    try {
      const status = await launcher.up({
        includeDashboard: false,
        includePet: false,
        launchedBy,
        ...(appInstanceId ? { appInstanceId } : {}),
        ...(options.services ? { services: options.services } : {}),
      });
      return { status, notes };
    } finally {
      if (launchedBy === "app") {
        const record = this.ensureRecord(workspace, workspaceId);
        for (const service of MANAGED_SERVICES) {
          const current = await launcher.job(service);
          const beforePid = preExistingPids.get(service) ?? null;
          if (
            !record.ownedServices.has(service) &&
            current.registered &&
            (beforePid === null || (current.pid !== null && current.pid !== beforePid))
          ) {
            record.ownedServices.set(service, current.pid);
          } else if (!current.registered && !current.pid) {
            record.ownedServices.delete(service);
          }
        }
        if (record.ownedServices.size === 0) {
          this.owned.delete(workspace);
        } else if (this.closing) {
          await this.shutdownRecord(record, true);
        }
      }
    }
  }

  async down(workspacePath: string, options: { keepEmulator?: boolean } = {}): Promise<SupervisedActionResult> {
    const workspace = await realpath(workspacePath).catch(() => resolve(workspacePath));
    return this.withWorkspaceLock(workspace, () => this.downLocked(workspace, options));
  }

  private async downLocked(
    workspace: string,
    options: { keepEmulator?: boolean },
  ): Promise<SupervisedActionResult> {
    const plan = await this.buildDownPlan(workspace);
    const notes: string[] = [];
    const launcher = this.makeLauncher(plan, notes);
    const status = await launcher.down(false, Boolean(options.keepEmulator), false);

    const record = this.owned.get(workspace);
    if (record) {
      record.ownedServices.delete("host");
      record.ownedServices.delete("baseware");
      if (!options.keepEmulator) {
        record.ownedServices.delete("emulator");
      }
      if (record.ownedServices.size === 0) {
        this.owned.delete(workspace);
      }
    }

    return { status, notes };
  }

  async reload(workspacePath: string, options?: SupervisorUpOptions): Promise<SupervisedActionResult> {
    if (this.closing) throw new Error("Workspace supervisor is shutting down");
    const workspace = await realpath(workspacePath);
    const deviceIdentity = await resolveWorkspaceDeviceIdentity(workspace, this.home);
    return this.withDeviceLock(deviceIdentity.deviceKey, () =>
      this.withWorkspaceLock(workspace, async () => {
        if (this.closing) throw new Error("Workspace supervisor is shutting down");
        const downRes = await this.downLocked(workspace, { keepEmulator: true });
        const upRes = await this.upLocked(workspace, options ?? {}, deviceIdentity);
        return {
          status: upRes.status,
          notes: [...downRes.notes, ...upRes.notes],
        };
      }),
    );
  }

  async shutdownAll(options: { emergency?: boolean } = {}): Promise<void> {
    this.closing = true;
    const emergency = Boolean(options.emergency);
    if (!emergency && this.locks.size > 0) {
      await Promise.race([
        Promise.allSettled([...this.locks.values()]),
        sleep(1500),
      ]);
    }
    const entries = [...this.owned.values()];
    await Promise.allSettled(entries.map(record => this.shutdownRecord(record, emergency)));
  }

  private async stopOwnedJobIfMatches(
    stateFile: string,
    expectedPid: number | null | undefined,
    stopOptions: { graceMs?: number; immediate?: boolean },
  ): Promise<void> {
    const [probe, jobRecord] = await Promise.all([probeBackgroundJob(stateFile), readJobRecord(stateFile)]);
    if (!probe.registered || !jobRecord) return;
    if (jobRecord.launchedBy !== "app" || jobRecord.appInstanceId !== this.instanceId) {
      return;
    }
    if (expectedPid !== null && expectedPid !== undefined && probe.pid !== null && probe.pid !== expectedPid) {
      return;
    }
    await stopBackgroundJob(stateFile, stopOptions).catch(() => {});
  }

  private async shutdownRecord(record: OwnedWorkspaceRecord, emergency: boolean): Promise<void> {
    if (record.ownedServices.size === 0) {
      this.owned.delete(record.workspace);
      return;
    }

    if (emergency) {
      for (const service of ["host", "baseware", "emulator"] as const) {
        if (!record.ownedServices.has(service)) continue;
        const expectedPid = record.ownedServices.get(service);
        const stateFile = jobStateFilePath(record.backgroundDir, service);
        await this.stopOwnedJobIfMatches(stateFile, expectedPid, { immediate: true });
        record.ownedServices.delete(service);
      }
      this.owned.delete(record.workspace);
      return;
    }

    if (record.ownedServices.has("host")) {
      const expectedHostPid = record.ownedServices.get("host");
      const hostStateFile = jobStateFilePath(record.backgroundDir, "host");
      const [hostProbe, hostRecord] = await Promise.all([
        probeBackgroundJob(hostStateFile),
        readJobRecord(hostStateFile),
      ]);
      const isOwnedHost =
        hostProbe.pid !== null &&
        hostRecord?.launchedBy === "app" &&
        hostRecord.appInstanceId === this.instanceId &&
        (expectedHostPid === null || expectedHostPid === undefined || hostProbe.pid === expectedHostPid);
      if (isOwnedHost) {
        type LiveHostStatus = {
          runId: string;
          epoch?: string | null;
          mode: string;
          thinking?: boolean;
          consolidating?: boolean;
        };
        const initial = await sendWithTimeout<LiveHostStatus>(
          record.hostSocket,
          { kind: "status", argv: [] },
          800,
        );
        if (initial) {
          const cleanupDeadline = Date.now() + GRACEFUL_CLEANUP_TIMEOUT_MS;
          if (initial.mode === "auto") {
            await sendWithTimeout(
              record.hostSocket,
              {
                kind: "auto",
                argv: ["off"],
                runId: initial.runId,
                ...(initial.epoch !== undefined ? { expectedEpoch: initial.epoch } : {}),
              },
              Math.max(200, cleanupDeadline - Date.now()),
            );
          }
          while (Date.now() < cleanupDeadline) {
            const current = await sendWithTimeout<LiveHostStatus>(
              record.hostSocket,
              { kind: "status", argv: [] },
              400,
            );
            if (!current || (!current.thinking && !current.consolidating)) break;
            await sleep(80);
          }
        }
      }
      await this.stopOwnedJobIfMatches(hostStateFile, expectedHostPid, { graceMs: 2500 });
      record.ownedServices.delete("host");
    }

    if (record.ownedServices.has("baseware")) {
      const expectedBasewarePid = record.ownedServices.get("baseware");
      const basewareStateFile = jobStateFilePath(record.backgroundDir, "baseware");
      await this.stopOwnedJobIfMatches(basewareStateFile, expectedBasewarePid, { graceMs: 2000 });
      record.ownedServices.delete("baseware");
    }

    if (record.ownedServices.has("emulator")) {
      const expectedEmulatorPid = record.ownedServices.get("emulator");
      const emulatorStateFile = jobStateFilePath(record.backgroundDir, "emulator");
      await this.stopOwnedJobIfMatches(emulatorStateFile, expectedEmulatorPid, { graceMs: 2000 });
      record.ownedServices.delete("emulator");
    }

    if (record.ownedServices.size === 0) {
      this.owned.delete(record.workspace);
    }
  }
}
