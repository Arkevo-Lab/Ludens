import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { CreateWorkspaceInputDto } from "@ludens/protocol/app-rpc";
import {
  BUILTIN_BROWSER_DRIVER,
  BUILTIN_BROWSER_DRIVER_SPEC,
  BUILTIN_CUA_DRIVER,
  BUILTIN_CUA_DRIVER_SPEC,
  BUILTIN_LOCAL_BROWSER_MACHINE,
  ensureWorkspaceIdentity,
  isOmpEffort,
  isOmpServiceTier,
  readGlobalConfig,
  readMachinesConfig,
  registeredWorkspace,
  registerWorkspace,
  upsertDriverConfig,
  validateConnectionConfig,
  validateWorkspaceMachinesBinding,
  type BasewareMachineSpec,
  type MachineTransportKind,
  type ModelConnectionConfig,
  type OmpEffort,
  type OmpServiceTier,
  type RegisteredDriverSpec,
  type WorkspaceMachinesBinding,
  type WorkspaceRegistration,
} from "@ludens/protocol/ludens";
import {
  validateWorkspaceStorageOverride,
  type WorkspaceStorageOverride,
} from "@ludens/protocol/storage";
import { discoverDriver } from "./drivers";
import { repoRoot } from "./repo";

export interface DriverManifest {
  id: string;
  version?: string;
  transport?: MachineTransportKind;
  defaultPort?: number;
  needsGame?: boolean;
  launchHint?: string;
  launchCommand?: string[];
  launchEnv?: Record<string, string>;
}

export interface LaunchConfig {
  driver: string;
  driverPackage?: string;
  game?: string;
  url?: string;
  port?: number;
  cuaCommand?: string;
  model: string;
  serviceTier?: OmpServiceTier;
  effort?: OmpEffort;
  compactionThreshold?: number;
  connection?: ModelConnectionConfig;
  machines?: WorkspaceMachinesBinding;
  storage?: WorkspaceStorageOverride;
  pet: boolean;
  logging: { diagnostics: "normal" | "full" };
}

export function normalizeWorkspaceBrowserUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed === "ludens-browser://start" || trimmed.toLowerCase() === "about:blank") {
    return trimmed.toLowerCase() === "about:blank" ? "about:blank" : trimmed;
  }
  if (
    /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed)
    || /^(javascript|data|blob|vbscript|file|about|mailto|chrome|devtools):/i.test(trimmed)
    || /\s/.test(trimmed)
  ) {
    return trimmed;
  }
  const authority = trimmed.split(/[/?#]/, 1)[0] ?? "";
  const hostOnly = authority.startsWith("[")
    ? authority.slice(0, authority.indexOf("]") + 1)
    : (authority.split(":")[0] ?? "");
  const isLocal =
    hostOnly === "localhost"
    || hostOnly === "127.0.0.1"
    || hostOnly === "[::1]"
    || hostOnly === "::1"
    || hostOnly === "0.0.0.0"
    || /^\d+\.\d+\.\d+\.\d+$/.test(hostOnly);
  try {
    return new URL(`${isLocal ? "http" : "https"}://${trimmed}`).href;
  } catch {
    return trimmed;
  }
}

export function parseWorkspaceLaunchConfig(value: unknown, manifest?: DriverManifest): LaunchConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ludens.json must be an object");
  const config = value as Record<string, unknown>;
  const allowed = [
    "driver",
    "driverPackage",
    "game",
    "url",
    "port",
    "cuaCommand",
    "model",
    "serviceTier",
    "effort",
    "compactionThreshold",
    "connection",
    "machines",
    "storage",
    "dashboard",
    "pet",
    "logging",
  ];
  for (const key of Object.keys(config)) {
    if (!allowed.includes(key)) throw new Error(`Unknown ludens.json field: ${key}`);
  }
  if (typeof config.driver !== "string" || !config.driver.trim()) {
    throw new Error("ludens.json driver must be a non-empty driver id");
  }
  if (config.driverPackage !== undefined && (typeof config.driverPackage !== "string" || !config.driverPackage.trim())) {
    throw new Error("driverPackage must be a non-empty package spec");
  }
  if (config.game !== undefined && (typeof config.game !== "string" || !config.game.trim())) {
    throw new Error("game must be a non-empty path");
  }
  if (config.url !== undefined && (typeof config.url !== "string" || !config.url.trim())) {
    throw new Error("url must be a non-empty URL string");
  }
  const bridge = manifest ? manifest.transport !== "stdio" : config.driver !== "browser";
  if (manifest && manifest.id !== config.driver) {
    throw new Error(`Driver manifest id ${JSON.stringify(manifest.id)} does not match ludens.json driver ${JSON.stringify(config.driver)}`);
  }
  if (!bridge && (config.game !== undefined || config.port !== undefined)) {
    throw new Error(`${config.driver} does not use game or a bridge port`);
  }
  if (manifest && config.game !== undefined && !manifest.launchCommand?.length) {
    throw new Error(`${config.driver} does not support launching a game; omit game and prepare the device separately`);
  }
  if (config.cuaCommand !== undefined && (bridge || typeof config.cuaCommand !== "string" || !config.cuaCommand.trim())) {
    throw new Error("cuaCommand must be a non-empty executable path for a stdio driver");
  }
  const { dashboard: _legacyDashboard, ...cleanConfig } = config;
  const result = {
    ...(bridge && manifest?.defaultPort !== undefined ? { port: manifest.defaultPort } : {}),
    model: "openai-codex/gpt-6.2-sol",
    pet: false,
    logging: { diagnostics: "normal" },
    ...cleanConfig,
  } as LaunchConfig;
  if (typeof config.url === "string") {
    result.url = normalizeWorkspaceBrowserUrl(config.url);
  }
  if (
    !result.logging
    || typeof result.logging !== "object"
    || Array.isArray(result.logging)
    || Object.keys(result.logging).some(key => key !== "diagnostics")
    || !["normal", "full"].includes(result.logging.diagnostics)
  ) {
    throw new Error("logging must contain diagnostics: normal|full");
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
  if (config.storage !== undefined) {
    result.storage = validateWorkspaceStorageOverride(config.storage, "storage");
  } else {
    delete result.storage;
  }
  if (bridge && result.port === undefined) {
    throw new Error(`${config.driver} requires a bridge port; set port in ludens.json or defaultPort in its driver manifest`);
  }
  if (result.port !== undefined && (!Number.isInteger(result.port) || result.port <= 0 || result.port > 65535)) {
    throw new Error("port must be an integer from 1 to 65535");
  }
  if (typeof result.model !== "string" || !result.model.trim()) throw new Error("model must be a non-empty string");
  if (result.serviceTier !== undefined && !isOmpServiceTier(result.serviceTier)) {
    throw new Error("serviceTier must be priority or ultrafast");
  }
  if (result.effort !== undefined && !isOmpEffort(result.effort)) {
    throw new Error("effort must be minimal, low, medium, high, xhigh, or max");
  }
  if (typeof result.pet !== "boolean") throw new Error("pet must be boolean");
  return result;
}

export interface InitializeWorkspaceOptions {
  /** Explicit target directory (used by CLI `--workspace <path>` or explicit positional workspace). */
  explicitDirectory?: string;
  /** Allow empty `name` when `explicitDirectory` is supplied from CLI `ludens init`. */
  allowUnnamedDirectory?: boolean;
  /** Optional custom manifest resolver (e.g. direct Baseware loader in CLI). */
  resolveDriverManifest?: (driver: string, resolvedPackage: string | undefined) => Promise<DriverManifest>;
  /** Require `workspace` path (if provided) to be an absolute path. Defaults to true for RPC safety. */
  requireAbsoluteWorkspace?: boolean;
  signal?: AbortSignal;
  home: string;
}

export interface InitializeWorkspaceResult {
  entry: WorkspaceRegistration;
  workspace: string;
  configPath: string;
  config: LaunchConfig;
  registeredDriver?: RegisteredDriverSpec;
}

const ALLOWED_CREATE_KEYS = new Set([
  "name",
  "workspace",
  "driver",
  "driverPackage",
  "machineId",
  "game",
  "url",
  "port",
  "cuaCommand",
  "model",
  "serviceTier",
  "effort",
  "pet",
  "storage",
  "registerDriver",
]);

const STRING_KEYS = new Set([
  "name",
  "workspace",
  "driver",
  "driverPackage",
  "machineId",
  "game",
  "url",
  "cuaCommand",
  "model",
]);

const BROWSER_STARTER_PERCEPTION_PY = `"""Built-in Browser starter perception. Customize freely, then run ludens-core perception reload."""

from ludens_tools import Client, capability, observe, record


class Perception:
    def start(self, context):
        """Initialize client once; discover device controllers in baseware.json."""
        self.context = context
        self.client = Client()

    @observe
    @record
    @capability
    def sample(self):
        """Capture the live Built-in Browser viewport frame and page metadata at 30Hz."""
        captured = self.client.call("controller/screen.capture", {})
        outcome = captured.get("result") if isinstance(captured, dict) else None
        content = outcome.get("content") if isinstance(outcome, dict) else None
        structured = outcome.get("structuredContent") if isinstance(outcome, dict) else None

        media = []
        if isinstance(content, list):
            for block in content:
                if not isinstance(block, dict) or block.get("type") != "image":
                    continue
                mime = block.get("mimeType") or "image/jpeg"
                if block.get("path"):
                    media.append({"path": block["path"], "mediaType": mime})
                elif block.get("data"):
                    media.append({"data": block["data"], "mediaType": mime})
                break

        data = structured if isinstance(structured, dict) else {}
        url = data.get("url") or ""
        title = data.get("title") or ""
        text = f"{title} ({url})" if title and url else (url or title or "Browser frame")
        return {
            "text": text,
            "data": data,
            "media": media,
        }

    def close(self):
        """Release local resources."""
        pass
`;

let cachedTemplatesPromise: Promise<{ agentsMd: string; perceptionPy: string }> | null = null;

function loadWorkspaceTemplates(): Promise<{ agentsMd: string; perceptionPy: string }> {
  if (!cachedTemplatesPromise) {
    cachedTemplatesPromise = Promise.all([
      readFile(join(repoRoot, "core", "templates", "AGENTS.md"), "utf8"),
      readFile(join(repoRoot, "core", "templates", "perception.py"), "utf8"),
    ]).then(([agentsMd, perceptionPy]) => ({ agentsMd, perceptionPy }));
  }
  return cachedTemplatesPromise;
}

async function readLocalPackageMetadata(spec: string): Promise<{ name?: string; description?: string }> {
  if (!spec.startsWith("file:")) return {};
  const rawPath = spec.slice(5).trim();
  if (!rawPath) return {};
  try {
    const resolvedPath = await realpath(rawPath).catch(() => resolve(rawPath));
    const info = await stat(resolvedPath);
    const pkgDir = info.isDirectory() ? resolvedPath : resolve(resolvedPath, "..");
    const pkg = JSON.parse(await readFile(join(pkgDir, "package.json"), "utf8")) as Record<string, unknown>;
    if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) return {};
    return {
      ...(typeof pkg.name === "string" && pkg.name.trim() ? { name: pkg.name.trim() } : {}),
      ...(typeof pkg.description === "string" && pkg.description.trim()
        ? { description: pkg.description.trim() }
        : {}),
    };
  } catch {
    return {};
  }
}

function existingWorkspaceError(workspacePath: string): Error {
  return Object.assign(
    new Error(
      `目标目录已有 ludens.json 工作区配置（EEXIST: ${workspacePath}），请改用「添加已有工作区」或更换项目名称`,
    ),
    { code: "EEXIST", status: 409 },
  );
}

function normalizePositiveInt(value: unknown, fieldLabel: string, min = 1, max?: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || (max !== undefined && value > max)) {
    throw new Error(`无效的工作区字段：${fieldLabel}`);
  }
  return value;
}

function isDefaultInheritStorage(storage: WorkspaceStorageOverride): boolean {
  return (
    storage.mode === "inherit" &&
    storage.profileId === undefined &&
    storage.maxBytes === undefined &&
    storage.maxAgeHours === undefined &&
    storage.localCacheBytes === undefined &&
    storage.videoQuality === undefined
  );
}

export function validateCreateWorkspacePayload(
  input: unknown,
  options?: { allowUnnamedDirectory?: boolean },
): CreateWorkspaceInputDto {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("工作区设置必须是对象");
  }
  const value = input as Record<string, unknown>;
  for (const [key, field] of Object.entries(value)) {
    if (!ALLOWED_CREATE_KEYS.has(key)) {
      throw new Error(`无效的工作区字段：${key}`);
    }
    if (field === undefined) continue;
    if (STRING_KEYS.has(key)) {
      if (typeof field !== "string" || field.length > 2000 || field.includes("\0")) {
        throw new Error(`无效的工作区字段：${key}`);
      }
    }
  }

  const rawName = typeof value.name === "string" ? value.name.trim() : "";
  if (!options?.allowUnnamedDirectory || value.name !== undefined) {
    if (!rawName || rawName === "." || rawName === ".." || /[\\/]/.test(rawName) || rawName.length > 120) {
      throw new Error("请输入工作区名称，不含路径分隔符");
    }
  }

  const port = normalizePositiveInt(value.port, "port", 1, 65535);

  let serviceTier: OmpServiceTier | null | undefined;
  if (value.serviceTier !== undefined) {
    if (value.serviceTier === null) {
      serviceTier = null;
    } else if (isOmpServiceTier(value.serviceTier)) {
      serviceTier = value.serviceTier;
    } else {
      throw new Error("无效的工作区字段：serviceTier");
    }
  }

  let effort: OmpEffort | null | undefined;
  if (value.effort !== undefined) {
    if (value.effort === null) {
      effort = null;
    } else if (isOmpEffort(value.effort)) {
      effort = value.effort;
    } else {
      throw new Error("无效的工作区字段：effort");
    }
  }

  if (value.pet !== undefined && typeof value.pet !== "boolean") {
    throw new Error("无效的工作区字段：pet");
  }
  let storage: WorkspaceStorageOverride | undefined;
  if (value.storage !== undefined) {
    const validatedStorage = validateWorkspaceStorageOverride(value.storage, "storage");
    if (!isDefaultInheritStorage(validatedStorage)) {
      storage = validatedStorage;
    }
  }
  if (value.registerDriver !== undefined && typeof value.registerDriver !== "boolean") {
    throw new Error("无效的工作区字段：registerDriver");
  }

  const trimOpt = (raw: unknown): string | undefined => {
    if (typeof raw !== "string") return undefined;
    const trimmed = raw.trim();
    return trimmed ? trimmed : undefined;
  };

  return {
    name: rawName,
    ...(trimOpt(value.workspace) ? { workspace: trimOpt(value.workspace) } : {}),
    driver: typeof value.driver === "string" ? value.driver.trim() : "",
    ...(trimOpt(value.driverPackage) ? { driverPackage: trimOpt(value.driverPackage) } : {}),
    ...(trimOpt(value.machineId) ? { machineId: trimOpt(value.machineId) } : {}),
    ...(trimOpt(value.game) ? { game: trimOpt(value.game) } : {}),
    ...(trimOpt(value.url) ? { url: trimOpt(value.url) } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(trimOpt(value.cuaCommand) ? { cuaCommand: trimOpt(value.cuaCommand) } : {}),
    ...(trimOpt(value.model) ? { model: trimOpt(value.model) } : {}),
    ...(serviceTier !== undefined ? { serviceTier } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(value.pet !== undefined ? { pet: value.pet } : {}),
    ...(storage !== undefined ? { storage } : {}),
    ...(value.registerDriver !== undefined ? { registerDriver: value.registerDriver } : {}),
  };
}

async function defaultResolveDriverManifest(
  driver: string,
  resolvedPackage: string | undefined,
  signal?: AbortSignal,
): Promise<DriverManifest> {
  if (
    !resolvedPackage
    || resolvedPackage === BUILTIN_CUA_DRIVER_SPEC
    || resolvedPackage === BUILTIN_BROWSER_DRIVER_SPEC
  ) {
    if (driver === "cua" && resolvedPackage !== BUILTIN_BROWSER_DRIVER_SPEC) {
      return {
        id: "cua",
        version: "builtin",
        transport: "stdio",
        needsGame: false,
        launchHint: BUILTIN_CUA_DRIVER.launchHint,
      };
    }
    if (driver === "browser" && resolvedPackage !== BUILTIN_CUA_DRIVER_SPEC) {
      return {
        id: "browser",
        version: "builtin",
        transport: "stdio",
        needsGame: false,
        launchHint: BUILTIN_BROWSER_DRIVER.launchHint,
      };
    }
    throw new Error(
      `Driver ${JSON.stringify(driver)} is not built in. Select its package with --driver-package <spec>. Built-in drivers: cua, browser.`,
    );
  }
  const discovered = await discoverDriver(resolvedPackage, signal);
  const validTransports: readonly MachineTransportKind[] = ["stdio", "bridge", "ssh", "http", "sse"];
  return {
    id: discovered.id,
    ...(discovered.version ? { version: discovered.version } : {}),
    ...(discovered.transport && validTransports.includes(discovered.transport as MachineTransportKind)
      ? { transport: discovered.transport as MachineTransportKind }
      : {}),
    ...(discovered.defaultPort !== undefined ? { defaultPort: discovered.defaultPort } : {}),
    ...(discovered.needsGame !== undefined ? { needsGame: discovered.needsGame } : {}),
    ...(discovered.launchHint ? { launchHint: discovered.launchHint } : {}),
    ...(discovered.launchCommand ? { launchCommand: discovered.launchCommand } : {}),
    ...(discovered.launchEnv ? { launchEnv: discovered.launchEnv } : {}),
  };
}

export async function initializeWorkspace(
  rawInput: unknown,
  options: InitializeWorkspaceOptions,
): Promise<InitializeWorkspaceResult> {
  const { home, signal } = options;
  const requireAbsolute = options.requireAbsoluteWorkspace ?? true;
  const parsed = validateCreateWorkspacePayload(rawInput, {
    allowUnnamedDirectory: options.allowUnnamedDirectory,
  });
  signal?.throwIfAborted();

  let matchedMachine: BasewareMachineSpec | undefined;
  if (parsed.machineId) {
    if (parsed.machineId === BUILTIN_LOCAL_BROWSER_MACHINE.id) {
      matchedMachine = BUILTIN_LOCAL_BROWSER_MACHINE;
    } else {
      const machinesRegistry = await readMachinesConfig(home);
      matchedMachine = machinesRegistry.machines.find(item => item.id === parsed.machineId);
      if (!matchedMachine) {
        throw new Error(`未找到已注册的受控节点：${parsed.machineId}`);
      }
    }
  }

  const effectiveDriver = parsed.driver || matchedMachine?.driver || "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(effectiveDriver)) {
    throw new Error("请输入有效的驱动 ID");
  }

  const isBuiltinSpec = (spec: string | undefined): boolean =>
    spec === BUILTIN_CUA_DRIVER_SPEC || spec === BUILTIN_BROWSER_DRIVER_SPEC;

  const rawPackage = isBuiltinSpec(parsed.driverPackage)
    ? undefined
    : (parsed.driverPackage ?? matchedMachine?.driverPackage);
  const normalizedPackage = isBuiltinSpec(rawPackage) ? undefined : rawPackage;

  const global = await readGlobalConfig(home);
  let targetDirectory: string | undefined;
  if (parsed.workspace) {
    if (requireAbsolute && !isAbsolute(parsed.workspace)) {
      throw new Error("工作区目录必须是绝对路径");
    }
    targetDirectory = resolve(parsed.workspace);
  } else if (options.explicitDirectory) {
    targetDirectory = resolve(options.explicitDirectory);
  } else if (parsed.name) {
    targetDirectory = join(global.workspaceRoot, parsed.name);
  }

  if (!targetDirectory) {
    throw new Error("Use --name to create under the default workspaceRoot, or --workspace <path> to select a directory");
  }

  // Fail fast with an actionable message before touching driver resolution if ludens.json already exists.
  const preExistingConfig = await stat(join(targetDirectory, "ludens.json"))
    .then(() => true)
    .catch(() => false);
  if (preExistingConfig) {
    throw existingWorkspaceError(targetDirectory);
  }

  signal?.throwIfAborted();
  await mkdir(targetDirectory, { recursive: true });
  const workspace = await realpath(targetDirectory);

  const resolvedPackage = normalizedPackage?.startsWith("file:")
    ? `file:${resolve(workspace, normalizedPackage.slice(5).trim())}`
    : normalizedPackage;

  const manifest = options.resolveDriverManifest
    ? await options.resolveDriverManifest(effectiveDriver, resolvedPackage)
    : await defaultResolveDriverManifest(effectiveDriver, resolvedPackage, signal);

  if (manifest.id !== effectiveDriver) {
    throw new Error(
      `Driver manifest id ${JSON.stringify(manifest.id)} does not match ludens.json driver ${JSON.stringify(effectiveDriver)}`,
    );
  }

  const rawConfig: Record<string, unknown> = {
    ...global.defaults,
    driver: effectiveDriver,
    ...(normalizedPackage ? { driverPackage: normalizedPackage } : {}),
  };

  if (matchedMachine) {
    rawConfig.machines = {
      active: matchedMachine.id,
      allowed: [matchedMachine.id],
    };
    const isBridgeDriver = manifest.transport !== "stdio";
    if (
      isBridgeDriver
      && parsed.port === undefined
      && manifest.defaultPort === undefined
      && matchedMachine.transport.kind === "bridge"
    ) {
      rawConfig.port = matchedMachine.transport.port;
    }
  } else if (effectiveDriver === "browser") {
    rawConfig.machines = {
      active: BUILTIN_LOCAL_BROWSER_MACHINE.id,
      allowed: [BUILTIN_LOCAL_BROWSER_MACHINE.id],
    };
  }

  if (parsed.game !== undefined) rawConfig.game = parsed.game;
  if (parsed.url !== undefined) rawConfig.url = parsed.url;
  if (parsed.port !== undefined) rawConfig.port = parsed.port;
  if (parsed.cuaCommand !== undefined) rawConfig.cuaCommand = parsed.cuaCommand;
  if (parsed.model !== undefined) rawConfig.model = parsed.model;
  if (parsed.pet !== undefined) rawConfig.pet = parsed.pet;
  if (parsed.storage !== undefined) rawConfig.storage = parsed.storage;
  if (parsed.serviceTier === null) {
    delete rawConfig.serviceTier;
  } else if (parsed.serviceTier !== undefined) {
    rawConfig.serviceTier = parsed.serviceTier;
  }
  if (parsed.effort === null) {
    delete rawConfig.effort;
  } else if (parsed.effort !== undefined) {
    rawConfig.effort = parsed.effort;
  }

  const config = parseWorkspaceLaunchConfig(rawConfig, manifest);
  const templates = await loadWorkspaceTemplates();
  const configPath = join(workspace, "ludens.json");

  signal?.throwIfAborted();
  try {
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw existingWorkspaceError(workspace);
    }
    throw error;
  }

  await writeFile(join(workspace, "AGENTS.md"), templates.agentsMd, { flag: "wx" }).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  const starterPerception =
    effectiveDriver === "browser" ? BROWSER_STARTER_PERCEPTION_PY : templates.perceptionPy;
  await writeFile(join(workspace, "perception.py"), starterPerception, { flag: "wx" }).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });

  await ensureWorkspaceIdentity(workspace);
  const registered = await registerWorkspace(workspace, home);
  const entry = await registeredWorkspace(registered.id, home);

  let registeredDriver: RegisteredDriverSpec | undefined;
  if (
    parsed.registerDriver
    && resolvedPackage
    && resolvedPackage !== BUILTIN_CUA_DRIVER_SPEC
    && resolvedPackage !== BUILTIN_BROWSER_DRIVER_SPEC
  ) {
    const localMeta = await readLocalPackageMetadata(resolvedPackage);
    const driverSpec: RegisteredDriverSpec = {
      id: manifest.id,
      spec: resolvedPackage,
      ...(localMeta.name ? { name: localMeta.name } : {}),
      ...(manifest.version ? { version: manifest.version } : {}),
      ...(localMeta.description ? { description: localMeta.description } : {}),
      ...(manifest.transport ? { transport: manifest.transport } : {}),
      ...(manifest.defaultPort !== undefined ? { defaultPort: manifest.defaultPort } : {}),
      ...(manifest.needsGame !== undefined ? { needsGame: manifest.needsGame } : {}),
      ...(manifest.launchHint ? { launchHint: manifest.launchHint } : {}),
      updatedAt: new Date().toISOString(),
    };
    const savedRegistry = await upsertDriverConfig(driverSpec, home);
    registeredDriver = savedRegistry.drivers.find(
      item => item.id === driverSpec.id && item.spec === driverSpec.spec,
    );
  }

  return {
    entry,
    workspace,
    configPath,
    config,
    ...(registeredDriver ? { registeredDriver } : {}),
  };
}
