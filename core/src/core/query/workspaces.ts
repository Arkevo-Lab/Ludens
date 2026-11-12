import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { repoRoot } from "./repo";
import { jobStateFilePath, jobTargetLabel, ludensSocketPath, readBackgroundJobState } from "../../daemon/background-jobs";
import {
  readGlobalConfig,
  updateGlobalConfig,
  listRegisteredWorkspaces,
  registerWorkspace,
  forgetWorkspace,
  registeredWorkspace,
  readWorkspaceIdentity,
  readMachinesConfig,
  upsertMachineConfig,
  removeMachineConfig,
  validateWorkspaceMachinesBinding,
  validateMachineSpec,
  BUILTIN_LOCAL_DESKTOP_MACHINE,
  validateConnectionConfig,
  isOmpServiceTier,
  withWorkspaceRegistrationLock,
  type BasewareMachineSpec,
  type WorkspaceMachinesBinding,
  type MachineTransportConfig,
  type LudensConfig,
  type ModelConnectionConfig,
  type OmpServiceTier,
  type WorkspaceDefaults,
  type WorkspaceRegistration,
} from "@ludens/protocol/ludens";
import { globalHome, clearCatalogCache } from "./data";
import { BasewareClient } from "@ludens/baseware/client";
import { defaultSocket } from "@ludens/baseware/address";

export interface CreateWorkspaceInput {
  name: string;
  workspace?: string;
  driver: string;
  driverPackage?: string;
  game?: string;
  cuaCommand?: string;
}

export interface WorkspaceConfigSummary {
  driver: string;
  driverPackage?: string;
  game?: string;
  port?: number;
  cuaCommand?: string;
  model: string;
  serviceTier?: OmpServiceTier;
  seconds: number;
  requests: number;
  compactionThreshold?: number;
  connection?: ModelConnectionConfig;
  machines?: WorkspaceMachinesBinding;
  dashboard: boolean;
  pet: boolean;
  diagnostics: "normal" | "full";
}

export interface WorkspaceServiceJobSnapshot {
  name: "emulator" | "baseware" | "host" | "dashboard" | "pet";
  scope: "workspace" | "shared";
  target: string;
  registered: boolean;
  pid: number | null;
  state: string | null;
  lastExitCode: number | null;
  logPath: string;
  logTail: string[];
}

export interface WorkspaceServicesSnapshot {
  hostSocket: string;
  hostSocketExists: boolean;
  jobs: WorkspaceServiceJobSnapshot[];
}

export interface CachedDriverEntry {
  driverId: string;
  cacheKey: string;
  spec: string;
  path: string;
  updatedAt: string;
}

export interface BasewareMachineRuntimeStatus extends BasewareMachineSpec {
  usedByWorkspaceIds: string[];
  implicitForWorkspaceId?: string;
}

export interface WorkspaceBasewareSnapshot {
  workspaceId: string | null;
  workspaceName: string | null;
  workspacePath: string | null;
  binding: WorkspaceMachinesBinding;
  implicitMachine: BasewareMachineSpec | null;
  activeMachine: BasewareMachineSpec | null;
  daemon: {
    hostSocket: string | null;
    basewareSocket: string | null;
    basewareSocketExists: boolean;
    status: {
      serviceId: string;
      mode: string;
      connected: boolean;
      epoch: string | null;
      activeMachineId?: string | null;
      mountedMachines?: Array<{
        id: string;
        label: string;
        driver: string;
        transport: string;
        connected: boolean;
        reason: string;
        isPrimary: boolean;
        controllers: string[];
      }>;
    } | null;
    emulatorJob: WorkspaceServiceJobSnapshot | null;
    basewareJob: WorkspaceServiceJobSnapshot | null;
  };
  machines: BasewareMachineRuntimeStatus[];
  cachedDrivers: CachedDriverEntry[];
}

export interface WorkspaceSessionEntry {
  file: string;
  relativePath: string;
  sizeBytes: number;
  updatedAt: string;
  isCurrent: boolean;
}

export interface WorkspaceShioriSnapshot {
  model?: string | null;
  currentSessionFile: string | null;
  sessions: WorkspaceSessionEntry[];
  memory: {
    exists: boolean;
    path: string;
    content: string;
    updatedAt: string | null;
  };
}

export interface WorkspaceStudioSnapshot {
  id: string;
  name: string;
  workspace: string;
  config: WorkspaceConfigSummary | null;
  defaults: WorkspaceDefaults;
  services: WorkspaceServicesSnapshot;
  shiori: WorkspaceShioriSnapshot;
}

async function readWorkspaceConfigSummary(workspacePath: string): Promise<WorkspaceConfigSummary | null> {
  try {
    const raw = JSON.parse(await readFile(join(workspacePath, "ludens.json"), "utf8")) as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const logging = raw.logging && typeof raw.logging === "object" && !Array.isArray(raw.logging)
      ? (raw.logging as Record<string, unknown>)
      : {};
    const diagnostics = logging.diagnostics === "full" ? "full" : "normal";
    let connection: ModelConnectionConfig | undefined;
    if (raw.connection !== undefined) {
      try {
        const parsed = validateConnectionConfig(raw.connection, "connection");
        if (Object.keys(parsed).length > 0) connection = parsed;
      } catch {
        // Ignore malformed connection in summary read; studio editor surfaces raw defaults.
      }
    }
    let machines: WorkspaceMachinesBinding | undefined;
    if (raw.machines !== undefined) {
      try {
        machines = validateWorkspaceMachinesBinding(raw.machines, "machines");
      } catch {
        // Ignore malformed machine bindings in summary reads; the editor can repair them.
      }
    }
    return {
      driver: typeof raw.driver === "string" && raw.driver.trim() ? raw.driver.trim() : "cua",
      ...(typeof raw.driverPackage === "string" && raw.driverPackage.trim() ? { driverPackage: raw.driverPackage.trim() } : {}),
      ...(typeof raw.game === "string" && raw.game.trim() ? { game: raw.game.trim() } : {}),
      ...(typeof raw.port === "number" && Number.isInteger(raw.port) ? { port: raw.port } : {}),
      ...(typeof raw.cuaCommand === "string" && raw.cuaCommand.trim() ? { cuaCommand: raw.cuaCommand.trim() } : {}),
      model: typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : "openai-codex/gpt-6.1-sol",
      ...(isOmpServiceTier(raw.serviceTier) ? { serviceTier: raw.serviceTier } : {}),
      seconds: typeof raw.seconds === "number" && Number.isInteger(raw.seconds) && raw.seconds > 0 ? raw.seconds : 1800,
      requests: typeof raw.requests === "number" && Number.isInteger(raw.requests) && raw.requests > 0 ? raw.requests : 1000,
      ...(typeof raw.compactionThreshold === "number" && Number.isInteger(raw.compactionThreshold) && raw.compactionThreshold > 0
        ? { compactionThreshold: raw.compactionThreshold }
        : {}),
      ...(connection ? { connection } : {}),
      ...(machines ? { machines } : {}),
      dashboard: typeof raw.dashboard === "boolean" ? raw.dashboard : true,
      pet: typeof raw.pet === "boolean" ? raw.pet : false,
      diagnostics,
    };
  } catch {
    return null;
  }
}

export type WorkspaceSettings = Awaited<ReturnType<typeof workspaceSettings>>;
export async function workspaceSettings(home = globalHome) {
  const [config, workspaces] = await Promise.all([readGlobalConfig(home), listRegisteredWorkspaces(home)]);
  const summaries: Record<string, WorkspaceConfigSummary | null> = {};
  await Promise.all(
    workspaces.map(async entry => {
      summaries[entry.id] = entry.available ? await readWorkspaceConfigSummary(entry.workspace) : null;
    }),
  );
  return { home: resolve(home), config, workspaces, summaries };
}

function absolutePath(input: unknown, label: string) {
  if (typeof input !== "string" || !input.trim() || !isAbsolute(input.trim())) throw new Error(`${label}必须是完整的绝对路径`);
  return resolve(input.trim());
}

export interface WorkspaceRootResult { config: LudensConfig }
export async function updateWorkspaceRoot(input: unknown, home = globalHome): Promise<WorkspaceRootResult> {
  const workspaceRoot = absolutePath(input, "默认工作区目录");
  // The committed value is authoritative. A later registry refresh is a
  // separate read and must never turn a successful save into a failed write.
  const config = await updateGlobalConfig(config => ({ ...config, workspaceRoot }), home);
  return { config };
}

export interface GlobalConnectionResult { config: LudensConfig }
export async function updateGlobalConnection(input: unknown, home = globalHome): Promise<GlobalConnectionResult> {
  const connection = input === null || input === undefined ? {} : validateConnectionConfig(input, "defaults.connection");
  const config = await updateGlobalConfig(current => {
    const defaults = { ...current.defaults };
    if (Object.keys(connection).length > 0) defaults.connection = connection;
    else delete defaults.connection;
    return { ...current, defaults };
  }, home);
  return { config };
}

export interface GlobalDefaultsResult { config: LudensConfig }
export async function updateGlobalDefaults(input: unknown, home = globalHome): Promise<GlobalDefaultsResult> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("全局默认配置必须是对象");
  }
  const patch = input as Record<string, unknown>;
  const allowed = ["model", "serviceTier", "seconds", "requests", "compactionThreshold", "dashboard", "pet", "connection"];
  for (const key of Object.keys(patch)) {
    if (!allowed.includes(key)) throw new Error(`未知的全局默认配置字段：${key}`);
  }
  const config = await updateGlobalConfig(current => {
    const defaults: WorkspaceDefaults = { ...current.defaults };
    if ("model" in patch) {
      if (patch.model === null || patch.model === "") delete defaults.model;
      else if (typeof patch.model === "string" && patch.model.trim()) defaults.model = patch.model.trim();
      else throw new Error("defaults.model 必须是非空字符串或 null");
    }
    if ("serviceTier" in patch) {
      if (patch.serviceTier === null || patch.serviceTier === undefined || patch.serviceTier === "") delete defaults.serviceTier;
      else if (isOmpServiceTier(patch.serviceTier)) defaults.serviceTier = patch.serviceTier;
      else throw new Error("defaults.serviceTier 必须是 priority、ultrafast 或 null");
    }
    for (const key of ["seconds", "requests", "compactionThreshold"] as const) {
      if (key in patch) {
        if (patch[key] === null || patch[key] === undefined || patch[key] === "") {
          delete defaults[key];
        } else if (typeof patch[key] === "number" && Number.isInteger(patch[key]) && (patch[key] as number) > 0) {
          defaults[key] = patch[key] as number;
        } else {
          throw new Error(`defaults.${key} 必须是正整数或 null`);
        }
      }
    }
    for (const key of ["dashboard", "pet"] as const) {
      if (key in patch) {
        if (patch[key] === null || patch[key] === undefined) delete defaults[key];
        else if (typeof patch[key] === "boolean") defaults[key] = patch[key] as boolean;
        else throw new Error(`defaults.${key} 必须是布尔值或 null`);
      }
    }
    if ("connection" in patch) {
      if (patch.connection === null || patch.connection === undefined) {
        delete defaults.connection;
      } else {
        const validated = validateConnectionConfig(patch.connection, "defaults.connection");
        if (Object.keys(validated).length > 0) defaults.connection = validated;
        else delete defaults.connection;
      }
    }
    return { ...current, defaults };
  }, home);
  return { config };
}

export interface WorkspaceConnectionSnapshot {
  id: string;
  workspace: string;
  model: string | null;
  connection: ModelConnectionConfig;
  defaults: ModelConnectionConfig;
}
export async function workspaceConnection(id: unknown, home = globalHome): Promise<WorkspaceConnectionSnapshot> {
  if (typeof id !== "string" || !id.trim()) throw new Error("请选择工作区");
  const [entry, globalConfig] = await Promise.all([registeredWorkspace(id, home), readGlobalConfig(home)]);
  const raw = JSON.parse(await readFile(join(entry.workspace, "ludens.json"), "utf8")) as Record<string, unknown>;
  const connection = raw.connection === undefined ? {} : validateConnectionConfig(raw.connection, "connection");
  return {
    id: entry.id,
    workspace: entry.workspace,
    model: typeof raw.model === "string" ? raw.model : null,
    connection,
    defaults: globalConfig.defaults.connection ?? {},
  };
}
export async function updateWorkspaceConnection(
  id: unknown,
  input: unknown,
  home = globalHome,
): Promise<WorkspaceConnectionSnapshot> {
  if (typeof id !== "string" || !id.trim()) throw new Error("请选择工作区");
  const connection = input === null || input === undefined ? {} : validateConnectionConfig(input, "connection");
  return withWorkspaceRegistrationLock(home, id, async () => {
    const [entry, globalConfig] = await Promise.all([registeredWorkspace(id, home), readGlobalConfig(home)]);
    const configPath = join(entry.workspace, "ludens.json");
    const raw = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("ludens.json 必须是 JSON 对象");
    const next = { ...raw };
    if (Object.keys(connection).length > 0) next.connection = connection;
    else delete next.connection;
    const temporary = `${configPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, configPath);
    } finally {
      await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
    }
    clearCatalogCache();
    return {
      id: entry.id,
      workspace: entry.workspace,
      model: typeof next.model === "string" ? next.model : null,
      connection,
      defaults: globalConfig.defaults.connection ?? {},
    };
  });
}

async function runCommandShort(
  argv: string[],
  timeoutMs = 2500,
  extraEnv?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolvePromise => {
    const child = spawn(argv[0]!, argv.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
      ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
    }, timeoutMs);
    child.stdout.on("data", chunk => out.push(chunk));
    child.stderr.on("data", chunk => err.push(chunk));
    child.once("error", () => {
      clearTimeout(timer);
      resolvePromise({ code: 1, stdout: "", stderr: "" });
    });
    child.once("close", code => {
      clearTimeout(timer);
      resolvePromise({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
  });
}

async function readLogTail(logPath: string, maxLines = 24): Promise<string[]> {
  try {
    const text = await readFile(logPath, "utf8");
    const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

async function inspectWorkspaceServices(workspacePath: string, home: string): Promise<WorkspaceServicesSnapshot> {
  const canonical = await realpath(workspacePath).catch(() => resolve(workspacePath));
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  const hostSocket = ludensSocketPath("core", hash);
  const hostSocketExists = await stat(hostSocket).then(() => true).catch(() => false);
  const names = ["emulator", "baseware", "host", "dashboard", "pet"] as const;
  const jobs = await Promise.all(
    names.map(async (name): Promise<WorkspaceServiceJobSnapshot> => {
      const target = jobTargetLabel(hash, name);
      const logDir = name === "pet" ? join(home, "pet/background") : join(canonical, "logs/background");
      const logPath = join(logDir, `${name}.log`);
      const stateFile = jobStateFilePath(logDir, name);
      const [jobState, logTail] = await Promise.all([
        readBackgroundJobState(stateFile, target),
        readLogTail(logPath, 20),
      ]);
      return {
        name,
        scope: name === "pet" ? "shared" : "workspace",
        target,
        registered: jobState.registered,
        pid: jobState.pid,
        state: jobState.state,
        lastExitCode: jobState.lastExitCode,
        logPath,
        logTail,
      };
    }),
  );
  return { hostSocket, hostSocketExists, jobs };
}

async function listCachedDrivers(home: string): Promise<CachedDriverEntry[]> {
  const root = join(home, "cache", "drivers");
  const drivers = await readdir(root, { withFileTypes: true }).catch(() => []);
  const cached = await Promise.all(drivers.filter(entry => entry.isDirectory()).map(async driver => {
    const caches = await readdir(join(root, driver.name), { withFileTypes: true }).catch(() => []);
    const entries = await Promise.all(caches.filter(entry => entry.isDirectory()).map(async (cache): Promise<CachedDriverEntry | null> => {
      const path = join(root, driver.name, cache.name);
      const complete = join(path, ".complete");
      try {
        const [spec, info] = await Promise.all([readFile(complete, "utf8"), stat(complete)]);
        return { driverId: driver.name, cacheKey: cache.name, spec: spec.trim(), path, updatedAt: info.mtime.toISOString() };
      } catch {
        return null;
      }
    }));
    return entries.filter((entry): entry is CachedDriverEntry => entry !== null);
  }));
  return cached.flat().sort((a, b) => a.driverId.localeCompare(b.driverId) || a.cacheKey.localeCompare(b.cacheKey));
}

function resolveEffectiveBinding(
  cfg: WorkspaceConfigSummary | null | undefined,
  registryMachines: BasewareMachineSpec[],
): WorkspaceMachinesBinding {
  const validIds = new Set(registryMachines.map(machine => machine.id));
  const matchedId = cfg?.driver === "cua"
    ? BUILTIN_LOCAL_DESKTOP_MACHINE.id
    : registryMachines.find(machine => machine.driver === cfg?.driver
        && cfg?.port !== undefined
        && machine.transport.kind === "bridge"
        && machine.transport.port === cfg.port)?.id
      ?? registryMachines.find(machine => machine.driver === cfg?.driver)?.id
      ?? BUILTIN_LOCAL_DESKTOP_MACHINE.id;
  const allowed = Array.from(new Set((cfg?.machines?.allowed ?? [])
    .map(id => id === "workspace-default" ? matchedId : id)
    .filter(id => validIds.has(id))));
  if (allowed.length === 0) {
    allowed.push(...Array.from(new Set([matchedId, BUILTIN_LOCAL_DESKTOP_MACHINE.id])));
  }
  const configuredActive = cfg?.machines?.active;
  const active = configuredActive && configuredActive !== "workspace-default" && allowed.includes(configuredActive)
    ? configuredActive
    : configuredActive === "workspace-default" && allowed.includes(matchedId)
      ? matchedId
      : allowed[0] ?? BUILTIN_LOCAL_DESKTOP_MACHINE.id;
  return { active, allowed };
}

export async function basewareOverview(workspaceId?: unknown, home = globalHome): Promise<WorkspaceBasewareSnapshot> {
  const [registry, workspaces, cachedDrivers] = await Promise.all([
    readMachinesConfig(home),
    listRegisteredWorkspaces(home),
    listCachedDrivers(home),
  ]);
  const configs = new Map<string, WorkspaceConfigSummary | null>();
  await Promise.all(workspaces.map(async entry => {
    configs.set(entry.id, entry.available ? await readWorkspaceConfigSummary(entry.workspace) : null);
  }));
  const selectedId = typeof workspaceId === "string" ? workspaceId : null;
  const candidate = selectedId ? workspaces.find(item => item.id === selectedId) : undefined;
  const entry = candidate?.available ? candidate : undefined;
  const cfg = entry ? configs.get(entry.id) : null;
  const implicitMachine: BasewareMachineSpec | null = null;
  const binding = resolveEffectiveBinding(cfg, registry.machines);
  const activeMachine = binding.active
    ? registry.machines.find(machine => machine.id === binding.active) ?? null
    : null;
  const usedBy = (machineId: string) => workspaces.filter(workspace =>
    resolveEffectiveBinding(configs.get(workspace.id), registry.machines).allowed.includes(machineId),
  ).map(workspace => workspace.id);
  const machines: BasewareMachineRuntimeStatus[] = registry.machines.map(machine => ({
    ...machine,
    usedByWorkspaceIds: usedBy(machine.id),
  }));

  let daemon: WorkspaceBasewareSnapshot["daemon"] = {
    hostSocket: null,
    basewareSocket: null,
    basewareSocketExists: false,
    status: null,
    emulatorJob: null,
    basewareJob: null,
  };
  if (entry) {
    const canonical = await realpath(entry.workspace).catch(() => resolve(entry.workspace));
    const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
    const basewareSocket = ludensSocketPath("baseware", hash);
    const [services, basewareSocketExists] = await Promise.all([
      inspectWorkspaceServices(entry.workspace, resolve(home)),
      stat(basewareSocket).then(() => true).catch(() => false),
    ]);
    let status: WorkspaceBasewareSnapshot["daemon"]["status"] = null;
    if (basewareSocketExists) {
      const result = await runCommandShort([join(repoRoot, "baseware/bin/baseware"), "status"], 1500, {
        BASEWARE_SOCKET: basewareSocket,
      });
      if (result.code === 0) {
        try {
          const value = JSON.parse(result.stdout) as Record<string, unknown>;
          if (typeof value.serviceId === "string" && typeof value.mode === "string" && typeof value.connected === "boolean") {
            status = {
              serviceId: value.serviceId,
              mode: value.mode,
              connected: value.connected,
              epoch: typeof value.epoch === "string" ? value.epoch : null,
              ...(typeof value.activeMachineId === "string" ? { activeMachineId: value.activeMachineId } : {}),
              ...(Array.isArray(value.machines) ? { mountedMachines: value.machines as Array<{ id: string; label: string; driver: string; transport: string; connected: boolean; reason: string; isPrimary: boolean; controllers: string[] }> } : {}),
            };
          }
        } catch {
          // A stale or incompatible daemon does not prevent listing machine configuration.
        }
      }
    }
    daemon = {
      hostSocket: services.hostSocket,
      basewareSocket,
      basewareSocketExists,
      status,
      emulatorJob: services.jobs.find(job => job.name === "emulator") ?? null,
      basewareJob: services.jobs.find(job => job.name === "baseware") ?? null,
    };
  }
  return {
    workspaceId: entry?.id ?? null,
    workspaceName: entry?.name ?? null,
    workspacePath: entry?.workspace ?? null,
    binding,
    implicitMachine,
    activeMachine,
    daemon,
    machines,
    cachedDrivers,
  };
}

export async function upsertBasewareMachine(input: unknown, home = globalHome): Promise<{ machine: BasewareMachineSpec; machines: BasewareMachineSpec[] }> {
  const registry = await upsertMachineConfig(input, home);
  const spec = validateMachineSpec(input);
  return { machine: registry.machines.find(machine => machine.id === spec.id)!, machines: registry.machines };
}

export async function removeBasewareMachine(id: unknown, home = globalHome): Promise<{ removed: BasewareMachineSpec | null; machines: BasewareMachineSpec[] }> {
  const res = await removeMachineConfig(id, home);
  return { removed: res.removed, machines: res.registry.machines };
}

export async function probeBasewareSocket(workspace: string): Promise<string | null> {
  const socketPath = await defaultSocket(workspace);
  const { promise, resolve: resolveProbe } = Promise.withResolvers<string | null>();
  const socket = createConnection(socketPath);
  const timer = setTimeout(() => { socket.destroy(); resolveProbe(null); }, 500);
  socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolveProbe(socketPath); });
  socket.once("error", () => { clearTimeout(timer); resolveProbe(null); });
  return promise;
}

export async function updateWorkspaceMachines(id: unknown, input: unknown, home = globalHome): Promise<WorkspaceBasewareSnapshot> {
  if (typeof id !== "string" || !id.trim()) throw new Error("请选择工作区");
  const binding = validateWorkspaceMachinesBinding(input, "machines");
  let workspace: string | undefined;
  await withWorkspaceRegistrationLock(home, id, async () => {
    const entry = await registeredWorkspace(id, home);
    workspace = entry.workspace;
    const configPath = join(entry.workspace, "ludens.json");
    const raw = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("ludens.json 必须是 JSON 对象");
    const next = { ...raw, machines: binding };
    const temporary = `${configPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, configPath);
    } finally {
      await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
    }
  });
  clearCatalogCache();
  if (binding.active && workspace) {
    try {
      const socket = await probeBasewareSocket(workspace);
      if (socket) {
        const client = await BasewareClient.connect(socket);
        try { await client.request({ kind: "machines", action: "use", id: binding.active }); }
        finally { client.close(); }
      }
    } catch {
      // Configuration persistence succeeds even when Baseware is not running.
    }
  }
  return basewareOverview(id, home);
}

export async function controlWorkspaceMachine(
  id: unknown,
  input: unknown,
  home = globalHome,
): Promise<WorkspaceBasewareSnapshot> {
  if (typeof id !== "string" || !id.trim()) throw new Error("请选择工作区");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("受控节点操作必须是对象");
  const { operation, machineId } = input as Record<string, unknown>;
  if (!["setPrimary", "toggleAllowed", "mount", "unmount", "reconnect"].includes(String(operation))) {
    throw new Error("不支持的受控节点操作");
  }
  if (typeof machineId !== "string" || !machineId.trim()) throw new Error("请选择受控节点");
  const registry = await readMachinesConfig(home);
  if (!registry.machines.some(machine => machine.id === machineId)) throw new Error(`Unknown machine: ${machineId}`);
  const entry = await registeredWorkspace(id, home);
  const workspace = entry.workspace;
  const current = resolveEffectiveBinding(await readWorkspaceConfigSummary(workspace), registry.machines);
  let active = current.active;
  const allowed = [...current.allowed];
  const persist = async () => {
    await withWorkspaceRegistrationLock(home, id, async () => {
      const configPath = join(workspace, "ludens.json");
      const raw = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("ludens.json 必须是 JSON 对象");
      const next = { ...raw, machines: { active, allowed } };
      const temporary = `${configPath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
        await rename(temporary, configPath);
      } finally {
        await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
      }
    });
  };

  switch (operation) {
    case "setPrimary": {
      if (!allowed.includes(machineId)) allowed.push(machineId);
      active = machineId;
      await persist();
      const socket = await probeBasewareSocket(workspace);
      if (socket) {
        const client = await BasewareClient.connect(socket);
        try { await client.request({ kind: "machines", action: "use", id: machineId }); }
        finally { client.close(); }
      }
      break;
    }
    case "toggleAllowed": {
      const removing = allowed.includes(machineId);
      const previousActive = active;
      if (removing) {
        if (allowed.length <= 1) throw new Error("工作区至少需要保留一个允许访问的受控节点");
        allowed.splice(allowed.indexOf(machineId), 1);
        if (active === machineId) active = allowed[0] ?? null;
      } else {
        allowed.push(machineId);
        if (!active) active = machineId;
      }
      await persist();
      if (removing) {
        const socket = await probeBasewareSocket(workspace);
        if (socket) {
          const client = await BasewareClient.connect(socket);
          try {
            if (active !== previousActive && active) {
              await client.request({ kind: "machines", action: "use", id: active });
            }
            try { await client.request({ kind: "machines", action: "disconnect", id: machineId }); }
            catch { /* The machine may not be mounted. */ }
          } finally { client.close(); }
        }
      }
      break;
    }
    case "mount": {
      if (!allowed.includes(machineId)) {
        allowed.push(machineId);
        await persist();
      }
      const socket = await probeBasewareSocket(workspace);
      if (!socket) throw new Error("当前工作区 Baseware 尚未启动，请先启动工作区服务");
      const client = await BasewareClient.connect(socket);
      try { await client.request({ kind: "machines", action: "connect", ids: [machineId] }); }
      finally { client.close(); }
      break;
    }
    case "unmount": {
      const socket = await probeBasewareSocket(workspace);
      if (!socket) throw new Error("当前工作区 Baseware 尚未启动");
      const client = await BasewareClient.connect(socket);
      try { await client.request({ kind: "machines", action: "disconnect", id: machineId }); }
      finally { client.close(); }
      break;
    }
    case "reconnect": {
      const socket = await probeBasewareSocket(workspace);
      if (!socket) throw new Error("当前工作区 Baseware 尚未启动");
      const client = await BasewareClient.connect(socket);
      try { await client.request({ kind: "reconnect", id: machineId }); }
      finally { client.close(); }
      break;
    }
  }
  clearCatalogCache();
  return await basewareOverview(id, home);
}

export interface WorkspaceServiceControlResult {
  ok: boolean;
  operation: "up" | "down" | "reload";
  exitCode: number;
  stdout: string;
  stderr: string;
  studio: WorkspaceStudioSnapshot;
}

/** Start, stop, or reload a workspace's background services through the ludens CLI. */
export async function controlWorkspaceService(
  id: unknown,
  input: unknown,
  home = globalHome,
): Promise<WorkspaceServiceControlResult> {
  if (typeof id !== "string" || !id.trim()) throw new Error("请选择工作区");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("后台服务操作必须是对象");
  const { operation } = input as Record<string, unknown>;
  if (operation !== "up" && operation !== "down" && operation !== "reload") throw new Error("不支持的后台服务操作");
  const entry = await registeredWorkspace(id, home);
  const ludensBin = join(repoRoot, "core/bin/ludens");
  const envHome = ["env", `LUDENS_HOME=${resolve(home)}`];
  let code: number;
  let stdout = "";
  let stderr = "";
  if (operation === "up") {
    const result = await runCommandShort([...envHome, ludensBin, "--workspace", entry.workspace, "up"], 25_000);
    code = result.code;
    stdout = result.stdout;
    stderr = result.stderr;
  } else if (operation === "down") {
    const result = await runCommandShort([...envHome, ludensBin, "--workspace", entry.workspace, "down"], 25_000);
    code = result.code;
    stdout = result.stdout;
    stderr = result.stderr;
  } else {
    const down = await runCommandShort(
      [...envHome, ludensBin, "--workspace", entry.workspace, "down", "--keep-emulator"], 25_000);
    const up = await runCommandShort([...envHome, ludensBin, "--workspace", entry.workspace, "up"], 25_000);
    code = down.code === 0 ? up.code : down.code;
    stdout = `${down.stdout}\n${up.stdout}`;
    stderr = `${down.stderr}\n${up.stderr}`;
  }
  clearCatalogCache();
  return {
    ok: code === 0,
    operation,
    exitCode: code,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    studio: await workspaceStudio(id, home),
  };
}

function probeBridge(transport: Extract<MachineTransportConfig, { kind: "bridge" }>): Promise<string> {
  const { promise, resolve: resolveProbe, reject: rejectProbe } = Promise.withResolvers<string>();
  const socket = createConnection({ host: transport.host ?? "127.0.0.1", port: transport.port });
  const timer = setTimeout(() => socket.destroy(new Error("TCP connection timed out")), 2000);
  socket.once("connect", () => {
    clearTimeout(timer);
    socket.end();
    resolveProbe(`Connected to ${transport.host ?? "127.0.0.1"}:${transport.port}`);
  });
  socket.once("error", error => {
    clearTimeout(timer);
    rejectProbe(error);
  });
  return promise;
}

export async function probeBasewareMachine(input: unknown, home = globalHome): Promise<{ ok: boolean; latencyMs: number; detail: string }> {
  const started = Date.now();
  let machine: BasewareMachineSpec;
  if (input && typeof input === "object" && !Array.isArray(input) && Object.keys(input).length === 1 && "id" in input) {
    const id = input.id;
    if (typeof id !== "string") throw new Error("Invalid machine ID");
    const registry = await readMachinesConfig(home);
    const found = registry.machines.find(item => item.id === id);
    if (!found) throw new Error(`Unknown machine: ${id}`);
    machine = found;
  } else {
    machine = validateMachineSpec(input);
  }
  try {
    const transport: MachineTransportConfig = machine.transport;
    let detail: string;
    switch (transport.kind) {
      case "bridge":
        detail = await probeBridge(transport);
        break;
      case "ssh": {
        const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=2"];
        if (transport.port !== undefined) args.push("-p", String(transport.port));
        if (transport.identityFile) args.push("-i", transport.identityFile);
        args.push(`${transport.user ? `${transport.user}@` : ""}${transport.host}`, "echo ok");
        const result = await runCommandShort(["ssh", ...args], 2500);
        if (result.code !== 0) throw new Error(result.stderr.trim() || "SSH probe failed");
        detail = result.stdout.trim() || "SSH connection succeeded";
        break;
      }
      case "http":
      case "sse": {
        const response = await fetch(transport.url, { method: "HEAD", headers: transport.headers, signal: AbortSignal.timeout(2000) });
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
        detail = `HTTP ${response.status}`;
        break;
      }
      case "stdio": {
        const command = transport.command || "cua-driver";
        if (isAbsolute(command)) {
          const info = await stat(command);
          if (!info.isFile()) throw new Error(`${command} is not a file`);
          detail = `Executable found at ${command}`;
        } else {
          const result = await runCommandShort(["which", command], 2000);
          if (result.code !== 0) throw new Error(`Executable not found: ${command}`);
          detail = `Executable found at ${result.stdout.trim()}`;
        }
        break;
      }
    }
    return { ok: true, latencyMs: Date.now() - started, detail };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function inspectWorkspaceShiori(workspacePath: string, workspaceId: string): Promise<WorkspaceShioriSnapshot> {
  const canonical = await realpath(workspacePath).catch(() => resolve(workspacePath));
  const shioriDir = join(canonical, ".ludens", "shiori");
  const sessionsDir = join(shioriDir, "sessions");
  let currentSessionFile: string | null = null;
  try {
    const pointer = JSON.parse(await readFile(join(shioriDir, "current-session.json"), "utf8")) as Record<string, unknown>;
    if (pointer.version === 1 && pointer.workspaceId === workspaceId && typeof pointer.sessionFile === "string") {
      currentSessionFile = pointer.sessionFile;
    }
  } catch {
    currentSessionFile = null;
  }

  const sessions: WorkspaceSessionEntry[] = [];
  try {
    const entries = await readdir(sessionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const fullPath = join(sessionsDir, entry.name);
      const relPath = relative(canonical, fullPath);
      const info = await stat(fullPath).catch(() => null);
      if (!info) continue;
      sessions.push({
        file: entry.name,
        relativePath: relPath,
        sizeBytes: info.size,
        updatedAt: info.mtime.toISOString(),
        isCurrent: currentSessionFile === relPath,
      });
    }
    sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    // sessionsDir may not exist yet
  }

  const memoryPath = join(canonical, "MEMORY.md");
  let memory = {
    exists: false,
    path: memoryPath,
    content: "",
    updatedAt: null as string | null,
  };
  try {
    const [info, content] = await Promise.all([stat(memoryPath), readFile(memoryPath, "utf8")]);
    memory = {
      exists: true,
      path: memoryPath,
      content: content.slice(0, 65536),
      updatedAt: info.mtime.toISOString(),
    };
  } catch {
    // MEMORY.md may not exist yet
  }

  let configuredModel: string | null = null;
  try {
    const raw = JSON.parse(await readFile(join(canonical, "ludens.json"), "utf8")) as Record<string, unknown>;
    if (typeof raw?.model === "string" && raw.model.trim()) configuredModel = raw.model.trim();
  } catch {
    configuredModel = null;
  }

  return { model: configuredModel, currentSessionFile, sessions, memory };
}

export async function workspaceStudio(id: unknown, home = globalHome): Promise<WorkspaceStudioSnapshot> {
  if (typeof id !== "string" || !id.trim()) throw new Error("请选择工作区");
  const [entry, globalConfig] = await Promise.all([registeredWorkspace(id, home), readGlobalConfig(home)]);
  const [config, services, shiori] = await Promise.all([
    readWorkspaceConfigSummary(entry.workspace),
    inspectWorkspaceServices(entry.workspace, resolve(home)),
    inspectWorkspaceShiori(entry.workspace, entry.id),
  ]);
  return {
    id: entry.id,
    name: entry.name,
    workspace: entry.workspace,
    config,
    defaults: globalConfig.defaults,
    services,
    shiori,
  };
}

export async function updateWorkspaceStudioConfig(
  id: unknown,
  input: unknown,
  home = globalHome,
): Promise<WorkspaceStudioSnapshot> {
  if (typeof id !== "string" || !id.trim()) throw new Error("请选择工作区");
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("工作区配置更新必须是对象");
  }
  const patch = input as Record<string, unknown>;
  const allowed = [
    "model",
    "serviceTier",
    "seconds",
    "requests",
    "compactionThreshold",
    "diagnostics",
    "pet",
    "dashboard",
    "port",
    "game",
    "cuaCommand",
    "connection",
    "machines",
  ];
  for (const key of Object.keys(patch)) {
    if (!allowed.includes(key)) throw new Error(`不支持的工作区配置字段：${key}`);
  }
  await withWorkspaceRegistrationLock(home, id, async () => {
    const entry = await registeredWorkspace(id, home);
    const configPath = join(entry.workspace, "ludens.json");
    const raw = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("ludens.json 必须是 JSON 对象");
    const next: Record<string, unknown> = { ...raw };

    if ("model" in patch) {
      const nextModel = typeof patch.model === "string" ? patch.model.trim() : "";
      const slash = nextModel.indexOf("/");
      if (slash <= 0 || slash === nextModel.length - 1) {
        throw new Error("model 必须是 provider/model 格式的非空字符串");
      }
      next.model = nextModel;
    }
    if ("serviceTier" in patch) {
      if (patch.serviceTier === null || patch.serviceTier === undefined || patch.serviceTier === "") delete next.serviceTier;
      else if (isOmpServiceTier(patch.serviceTier)) next.serviceTier = patch.serviceTier;
      else throw new Error("serviceTier 必须是 priority、ultrafast 或 null");
    }
    for (const key of ["seconds", "requests"] as const) {
      if (key in patch) {
        if (typeof patch[key] !== "number" || !Number.isInteger(patch[key]) || (patch[key] as number) <= 0) {
          throw new Error(`${key} 必须是正整数`);
        }
        next[key] = patch[key];
      }
    }
    if ("compactionThreshold" in patch) {
      if (patch.compactionThreshold === null || patch.compactionThreshold === undefined || patch.compactionThreshold === "") {
        delete next.compactionThreshold;
      } else if (
        typeof patch.compactionThreshold === "number" &&
        Number.isInteger(patch.compactionThreshold) &&
        patch.compactionThreshold > 0
      ) {
        next.compactionThreshold = patch.compactionThreshold;
      } else {
        throw new Error("compactionThreshold 必须是正整数或 null（跟随模型默认）");
      }
    }
    if ("diagnostics" in patch) {
      if (patch.diagnostics !== "normal" && patch.diagnostics !== "full") {
        throw new Error("diagnostics 必须是 normal 或 full");
      }
      next.logging = { diagnostics: patch.diagnostics };
    }
    for (const key of ["pet", "dashboard"] as const) {
      if (key in patch) {
        if (typeof patch[key] !== "boolean") throw new Error(`${key} 必须是布尔值`);
        next[key] = patch[key];
      }
    }
    if ("port" in patch) {
      if (patch.port === null || patch.port === undefined || patch.port === "") {
        delete next.port;
      } else if (typeof patch.port === "number" && Number.isInteger(patch.port) && patch.port > 0 && patch.port <= 65535) {
        next.port = patch.port;
      } else {
        throw new Error("port 必须是 1–65535 的整数或 null");
      }
    }
    if ("game" in patch) {
      if (patch.game === null || patch.game === undefined || patch.game === "") delete next.game;
      else if (typeof patch.game === "string" && patch.game.trim()) next.game = patch.game.trim();
      else throw new Error("game 必须是非空字符串或 null");
    }
    if ("cuaCommand" in patch) {
      if (patch.cuaCommand === null || patch.cuaCommand === undefined || patch.cuaCommand === "") delete next.cuaCommand;
      else if (typeof patch.cuaCommand === "string" && patch.cuaCommand.trim()) next.cuaCommand = patch.cuaCommand.trim();
      else throw new Error("cuaCommand 必须是非空字符串或 null");
    }
    if ("connection" in patch) {
      if (patch.connection === null || patch.connection === undefined) {
        delete next.connection;
      } else {
        const validated = validateConnectionConfig(patch.connection, "connection");
        if (Object.keys(validated).length > 0) next.connection = validated;
        else delete next.connection;
      }
    }
    if ("machines" in patch) {
      if (patch.machines === null || patch.machines === undefined) delete next.machines;
      else next.machines = validateWorkspaceMachinesBinding(patch.machines, "machines");
    }

    const temporary = `${configPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, configPath);
    } finally {
      await unlink(temporary).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
  });
  clearCatalogCache();
  return workspaceStudio(id, home);
}

export async function updateWorkspaceShiori(
  id: unknown,
  input: unknown,
  home = globalHome,
): Promise<WorkspaceShioriSnapshot> {
  if (typeof id !== "string" || !id.trim()) throw new Error("请选择工作区");
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("无效的 Shiori 操作参数");
  }
  const body = input as Record<string, unknown>;
  return withWorkspaceRegistrationLock(home, id, async () => {
    const entry = await registeredWorkspace(id, home);
    const canonical = await realpath(entry.workspace).catch(() => resolve(entry.workspace));
    const shioriDir = join(canonical, ".ludens", "shiori");
    const sessionsDir = join(shioriDir, "sessions");
    const pointerPath = join(shioriDir, "current-session.json");

    if (body.kind === "newSession") {
      await unlink(pointerPath).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    } else if (body.kind === "selectSession") {
      if (typeof body.sessionFile !== "string" || !body.sessionFile.trim()) {
        throw new Error("请选择要切换的会话文件");
      }
      const candidate = resolve(canonical, body.sessionFile.trim());
      const within = relative(sessionsDir, candidate);
      if (!within || isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`)) {
        throw new Error("只能选择当前工作区 .ludens/shiori/sessions 目录下的会话文件");
      }
      await stat(candidate);
      const rel = relative(canonical, candidate);
      const temporary = `${pointerPath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify({ version: 1, workspaceId: entry.id, sessionFile: rel }, null, 2)}\n`, { mode: 0o600 });
        await rename(temporary, pointerPath);
      } finally {
        await unlink(temporary).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
      }
    } else if (body.kind === "saveMemory") {
      if (typeof body.content !== "string" || body.content.length > 256 * 1024) {
        throw new Error("MEMORY.md 内容必须是字符串且不超过 256 KB");
      }
      const memoryPath = join(canonical, "MEMORY.md");
      const temporary = `${memoryPath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, body.content, "utf8");
        await rename(temporary, memoryPath);
      } finally {
        await unlink(temporary).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
      }
    } else if (body.kind === "setModel" || (!("kind" in body) && "model" in body)) {
      const nextModel = typeof body.model === "string" ? body.model.trim() : "";
      const slash = nextModel.indexOf("/");
      if (slash <= 0 || slash === nextModel.length - 1) {
        throw new Error("model 必须是 provider/model 格式的非空字符串");
      }
      const configPath = join(canonical, "ludens.json");
      let raw: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("ludens.json 必须是 JSON 对象");
        }
        raw = parsed;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const next: Record<string, unknown> = { ...raw, model: nextModel };
      if ("serviceTier" in body) {
        if (body.serviceTier === null || body.serviceTier === undefined || body.serviceTier === "") delete next.serviceTier;
        else if (isOmpServiceTier(body.serviceTier)) next.serviceTier = body.serviceTier;
        else throw new Error("serviceTier 必须是 priority、ultrafast 或 null");
      }
      const temporary = `${configPath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
        await rename(temporary, configPath);
      } finally {
        await unlink(temporary).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
      }
      clearCatalogCache();
    } else {
      throw new Error(`未知的 Shiori 操作：${String(body.kind)}`);
    }
    return inspectWorkspaceShiori(canonical, entry.id);
  });
}

export async function openWorkspace(input: unknown, home = globalHome) {
  const workspace = absolutePath(input, "工作区目录");
  let entry;
  try { entry = await registerWorkspace(workspace, home); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("目录不存在或缺少工作区身份；旧版目录请先运行 ludens workspace import <path>。");
    throw error;
  }
  clearCatalogCache();
  return entry;
}

export interface WorkspaceRemovalResult { removed: WorkspaceRegistration | null }
export async function removeWorkspace(input: unknown, home = globalHome): Promise<WorkspaceRemovalResult> {
  if (typeof input !== "string") throw new Error("请选择工作区");
  const removed = await forgetWorkspace(input, home);
  clearCatalogCache();
  return { removed };
}

export async function createWorkspace(input: unknown, signal?: AbortSignal, home = globalHome) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("工作区设置必须是对象");
  const value = input as Record<string, unknown>;
  const keys = ["name", "workspace", "driver", "driverPackage", "game", "cuaCommand"];
  for (const [key, field] of Object.entries(value)) {
    if (!keys.includes(key) || typeof field !== "string" || field.length > 2000 || field.includes("\0")) throw new Error(`无效的工作区字段：${key}`);
  }
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name || name === "." || name === ".." || /[\\/]/.test(name) || name.length > 120) throw new Error("请输入工作区名称，不含路径分隔符");
  const driver = typeof value.driver === "string" ? value.driver.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(driver)) throw new Error("请输入有效的驱动 ID");
  const config = await readGlobalConfig(home);
  const workspace = value.workspace ? absolutePath(value.workspace, "工作区目录") : join(config.workspaceRoot, name);
  const args = ["init", "--name", name, "--workspace", workspace, "--driver", driver];
  for (const [key, flag] of [["driverPackage", "--driver-package"], ["game", "--game"], ["cuaCommand", "--cua-command"]] as const) {
    const text = (value[key] as string | undefined)?.trim();
    if (text) args.push(flag, text);
  }
  signal?.throwIfAborted();
  const repository = repoRoot;
  const env: NodeJS.ProcessEnv = { ...process.env, LUDENS_HOME: home };
  for (const key of Object.keys(env)) {
    if (key === "LUDENS_WORKSPACE" || key === "LUDENS_SOCKET" || key.startsWith("BASEWARE_")) delete env[key];
  }
  const child = spawn(join(repository, "core/bin/ludens"), args, {
    cwd: repository, env, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const errors: Buffer[] = [];
  let bytes = 0, failure: unknown, terminating = false;
  let forced: ReturnType<typeof setTimeout> | undefined;
  const kill = (signal: NodeJS.Signals) => {
    if (child.pid) try { process.kill(-child.pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  const stop = (reason: unknown) => {
    if (terminating) return;
    terminating = true; failure = reason; kill("SIGTERM");
    forced = setTimeout(() => kill("SIGKILL"), 1000);
  };
  const aborted = () => stop(signal?.reason ?? new DOMException("Aborted", "AbortError"));
  const timeout = setTimeout(() => stop(Object.assign(new Error("创建工作区超时，请检查目录后重试"), { status: 504 })), 55_000);
  const collect = (chunk: Buffer, error = false) => {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) stop(new Error("创建工作区输出过大"));
    else if (error) errors.push(chunk);
  };
  child.stdout.on("data", chunk => collect(chunk));
  child.stderr.on("data", chunk => collect(chunk, true));
  child.once("exit", () => { clearTimeout(forced); kill("SIGKILL"); });
  signal?.addEventListener("abort", aborted, { once: true });
  if (signal?.aborted) aborted();
  try {
    const code = await new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("close", done); });
    if (failure) throw failure;
    if (code !== 0) throw new Error(Buffer.concat(errors).toString("utf8").trim() || `创建工作区失败 (${code})`);
  } finally {
    clearTimeout(timeout); clearTimeout(forced); signal?.removeEventListener("abort", aborted); kill("SIGKILL");
  }
  clearCatalogCache();
  return registeredWorkspace((await readWorkspaceIdentity(workspace)).id, home);
}
