import type { DiscoveredDriver } from "@ludens/protocol/drivers";
import type {
  BasewareDriverOverviewItem,
  BasewareMachineRuntimeStatus,
  CreateWorkspaceInput,
} from "@ludens/protocol/workspaces";
import type { OmpEffort, OmpServiceTier, WorkspaceRegistration } from "@ludens/protocol/workspaces";
import {
  BUILTIN_BROWSER_DRIVER_SPEC,
  BUILTIN_CUA_DRIVER_SPEC,
} from "@ludens/protocol/drivers";
import {
  BUILTIN_LOCAL_BROWSER_MACHINE,
  BUILTIN_LOCAL_DESKTOP_MACHINE,
} from "@ludens/protocol/machines";
import { VIDEO_QUALITY_SPECS, type VideoQualityPreset } from "@/lib/storage";

function normalizeWorkspaceBrowserUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed === "ludens-browser://start") return trimmed;
  if (trimmed.toLowerCase() === "about:blank") return "about:blank";
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

export type WorkspaceEnvironment = "desktop" | "community";
export type WorkspaceTargetMode = "machine" | "driver" | "package";
export type FirstClassEnvironmentKind = "browser" | "computer" | "external";

export interface WorkspaceDraft {
  name: string;
  targetDirectory: string;
  environment: WorkspaceEnvironment;
  targetMode?: WorkspaceTargetMode;
  machineId?: string;
  driverId?: string;
  driverPackage: string;
  game: string;
  url?: string;
  port?: string;
  cuaCommand: string;
  model?: string;
  serviceTier?: OmpServiceTier | null;
  effort?: OmpEffort | null;
  videoQuality?: VideoQualityPreset;
  registerDriver?: boolean;
}

export const emptyWorkspaceDraft: WorkspaceDraft = {
  name: "",
  targetDirectory: "",
  environment: "desktop",
  driverPackage: "",
  game: "",
  url: "",
  cuaCommand: "",
};

export type WorkspaceCreationIntent = {
  driverPackage: string;
  driver?: DiscoveredDriver;
  machineId?: string;
};

/** URL prefill is only an address; verification can come only from the in-memory discovery result. */
export function initialWorkspaceSetup(intent?: WorkspaceCreationIntent | null) {
  const spec = intent?.driverPackage.trim() ?? "";
  const machineId = intent?.machineId?.trim() ?? "";
  if (machineId) {
    return {
      draft: {
        ...emptyWorkspaceDraft,
        targetMode: "machine" as const,
        machineId,
      },
      driver: null,
    };
  }
  return {
    draft: {
      ...emptyWorkspaceDraft,
      ...(spec
        ? {
            environment: "community" as const,
            targetMode: "package" as const,
            driverPackage: spec,
            registerDriver: true,
          }
        : {}),
    },
    driver: spec && intent?.driver?.spec === spec ? intent.driver : null,
  };
}

/** Match the local host's POSIX path normalization without importing Node in the form. */
export function normalizedWorkspacePath(value: string): string | null {
  const path = value.trim();
  if (!path.startsWith("/") || path.includes("\0")) return null;
  const segments: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") segments.pop();
    else if (part && part !== ".") segments.push(part);
  }
  return "/" + segments.join("/");
}

export function workspaceLocation(defaultRoot: string, draft: Pick<WorkspaceDraft, "name" | "targetDirectory">) {
  const custom = draft.targetDirectory.trim().length > 0;
  const path = normalizedWorkspacePath(custom ? draft.targetDirectory : `${defaultRoot}/${draft.name.trim()}`);
  const name = custom ? path?.split("/").at(-1) ?? "" : draft.name.trim();
  return { path, name, custom };
}

export function findExistingWorkspaceConflict(
  workspaces: readonly (WorkspaceRegistration & { available?: boolean })[] | undefined,
  defaultRoot: string,
  draft: Pick<WorkspaceDraft, "name" | "targetDirectory">,
): (WorkspaceRegistration & { available?: boolean }) | null {
  if (!workspaces || workspaces.length === 0) return null;
  const loc = workspaceLocation(defaultRoot, draft);
  if (!loc.name && !loc.custom) return null;
  const targetNormalized = loc.path ? normalizedWorkspacePath(loc.path) : null;
  for (const item of workspaces) {
    const existingNormalized = normalizedWorkspacePath(item.workspace);
    if (targetNormalized && existingNormalized && targetNormalized === existingNormalized) {
      return item;
    }
  }
  return null;
}

export function effectiveTargetMode(draft: WorkspaceDraft): WorkspaceTargetMode {
  if (draft.targetMode) return draft.targetMode;
  return draft.environment === "community" ? "package" : "driver";
}

export function isBrowserTargetDraft(
  draft: WorkspaceDraft,
  context?: Pick<WorkspaceCreateResolutionContext, "machines" | "catalogDriver">,
): boolean {
  const mode = effectiveTargetMode(draft);
  if (mode === "machine") {
    const machineId = draft.machineId?.trim();
    if (machineId === BUILTIN_LOCAL_BROWSER_MACHINE.id) return true;
    const matched = context?.machines?.find(item => item.id === machineId);
    if (matched) return matched.driver === "browser";
    return draft.driverId === "browser";
  }
  if (mode === "driver") {
    if (context?.catalogDriver) {
      return (
        context.catalogDriver.id === "browser" ||
        context.catalogDriver.spec === BUILTIN_BROWSER_DRIVER_SPEC
      );
    }
    return draft.driverId === "browser";
  }
  return false;
}

export function resolveFirstClassEnvironment(
  draft: WorkspaceDraft,
  context?: Pick<WorkspaceCreateResolutionContext, "machines" | "catalogDriver">,
): FirstClassEnvironmentKind {
  if (isBrowserTargetDraft(draft, context)) return "browser";
  const mode = effectiveTargetMode(draft);
  if (mode === "machine") {
    const machineId = draft.machineId?.trim();
    const matched = context?.machines?.find(item => item.id === machineId);
    if (
      machineId === BUILTIN_LOCAL_DESKTOP_MACHINE.id ||
      matched?.driver === "cua" ||
      (!matched && draft.driverId === "cua")
    ) {
      return "computer";
    }
    return "external";
  }
  if (mode === "driver") {
    if (
      context?.catalogDriver?.spec === BUILTIN_CUA_DRIVER_SPEC ||
      (!context?.catalogDriver && (!draft.driverId || draft.driverId === "cua"))
    ) {
      return "computer";
    }
    return "external";
  }
  return "external";
}

export function selectFirstClassEnvironment(
  draft: WorkspaceDraft,
  env: FirstClassEnvironmentKind,
  options?: {
    externalMachine?: BasewareMachineRuntimeStatus | null;
    externalDriver?: BasewareDriverOverviewItem | null;
  },
): WorkspaceDraft {
  if (env === "browser") {
    return {
      ...draft,
      targetMode: "machine",
      environment: "desktop",
      machineId: BUILTIN_LOCAL_BROWSER_MACHINE.id,
      driverId: "browser",
      driverPackage: "",
      game: "",
      port: undefined,
      cuaCommand: "",
    };
  }
  if (env === "computer") {
    return {
      ...draft,
      targetMode: "machine",
      environment: "desktop",
      machineId: BUILTIN_LOCAL_DESKTOP_MACHINE.id,
      driverId: "cua",
      driverPackage: "",
      game: "",
      url: "",
      port: undefined,
      cuaCommand: "",
    };
  }
  if (options?.externalMachine) {
    return {
      ...draft,
      targetMode: "machine",
      environment: options.externalMachine.transport.kind === "stdio" ? "desktop" : "community",
      machineId: options.externalMachine.id,
      driverId: options.externalMachine.driver,
      driverPackage: options.externalMachine.driverPackage ?? "",
      game: "",
      url: "",
      port: undefined,
      cuaCommand: "",
    };
  }
  if (options?.externalDriver) {
    return {
      ...draft,
      targetMode: "driver",
      environment: "community",
      machineId: undefined,
      driverId: options.externalDriver.id,
      driverPackage: options.externalDriver.spec,
      game: "",
      url: "",
      port: undefined,
      cuaCommand: "",
    };
  }
  return {
    ...draft,
    targetMode: "package",
    environment: "community",
    machineId: undefined,
    driverId: undefined,
    driverPackage: draft.environment === "community" ? draft.driverPackage : "",
    registerDriver: draft.registerDriver ?? true,
    game: "",
    url: "",
    port: undefined,
    cuaCommand: "",
  };
}

export function switchWorkspaceEnvironment(draft: WorkspaceDraft, environment: WorkspaceEnvironment): WorkspaceDraft {
  return {
    ...draft,
    environment,
    targetMode: environment === "community" ? "package" : "driver",
    machineId: undefined,
    driverId: environment === "desktop" ? "cua" : undefined,
    game: "",
    port: undefined,
    cuaCommand: "",
  };
}

export function switchWorkspaceTargetMode(
  draft: WorkspaceDraft,
  mode: WorkspaceTargetMode,
  options?: {
    defaultMachine?: BasewareMachineRuntimeStatus | null;
    defaultDriver?: BasewareDriverOverviewItem | null;
  },
): WorkspaceDraft {
  if (mode === "machine") {
    const machine = options?.defaultMachine ?? null;
    return {
      ...draft,
      targetMode: "machine",
      environment: "desktop",
      machineId: draft.machineId || machine?.id || "local-desktop",
      driverId: machine?.driver || "cua",
      driverPackage: machine?.driverPackage ?? "",
      game: "",
      port: undefined,
      cuaCommand: "",
    };
  }
  if (mode === "driver") {
    const drv = options?.defaultDriver ?? null;
    const isBuiltin =
      !drv ||
      drv.id === "cua" ||
      drv.id === "browser" ||
      drv.spec === BUILTIN_CUA_DRIVER_SPEC ||
      drv.spec === BUILTIN_BROWSER_DRIVER_SPEC;
    return {
      ...draft,
      targetMode: "driver",
      environment: isBuiltin ? "desktop" : "community",
      machineId: undefined,
      driverId: drv?.id ?? "cua",
      driverPackage: isBuiltin ? "" : drv.spec,
      game: "",
      port: undefined,
      cuaCommand: "",
    };
  }
  return {
    ...draft,
    targetMode: "package",
    environment: "community",
    machineId: undefined,
    driverId: undefined,
    driverPackage: draft.environment === "community" ? draft.driverPackage : "",
    registerDriver: draft.registerDriver ?? true,
    game: "",
    port: undefined,
    cuaCommand: "",
  };
}

export function workspaceDriverCapabilities(
  environment: WorkspaceEnvironment,
  driver: DiscoveredDriver | null,
  catalogDriver?: BasewareDriverOverviewItem | null,
) {
  const transport = driver?.transport ?? catalogDriver?.transport;
  const stdio = environment === "desktop" || transport === "stdio";
  const defaultPort = driver?.defaultPort ?? catalogDriver?.defaultPort;
  const supportsGame =
    environment === "community"
    && !stdio
    && (driver ? Boolean(driver.launchCommand?.length) : Boolean(catalogDriver?.needsGame));
  const missingPort =
    environment === "community"
    && !stdio
    && Boolean(driver || catalogDriver)
    && defaultPort === undefined;
  return {
    stdio,
    supportsGame,
    defaultPort,
    missingPort,
  };
}

export type WorkspaceSetupIssue = {
  field: "name" | "targetDirectory" | "driverPackage" | "port" | "machineId";
  message:
    | "invalidName"
    | "invalidDirectory"
    | "packageRequired"
    | "verifyFirst"
    | "unsupportedBridge"
    | "invalidPort"
    | "machineRequired";
};

export interface WorkspaceCreateResolutionContext {
  machines?: readonly BasewareMachineRuntimeStatus[];
  catalogDriver?: BasewareDriverOverviewItem | null;
  globalVideoQuality?: VideoQualityPreset;
}

export function workspaceCreateInput(
  defaultRoot: string,
  draft: WorkspaceDraft,
  driver: DiscoveredDriver | null,
  context?: WorkspaceCreateResolutionContext,
): { ok: true; input: CreateWorkspaceInput } | { ok: false; issue: WorkspaceSetupIssue } {
  const location = workspaceLocation(defaultRoot, draft);
  if (location.custom && (!location.path || location.path === "/" || draft.targetDirectory.length > 2000)) {
    return { ok: false, issue: { field: "targetDirectory", message: "invalidDirectory" } };
  }
  if (
    !location.name
    || location.name === "."
    || location.name === ".."
    || /[\\/\0]/.test(location.name)
    || location.name.length > 120
  ) {
    return { ok: false, issue: { field: location.custom ? "targetDirectory" : "name", message: "invalidName" } };
  }

  let parsedPort: number | undefined;
  if (draft.port !== undefined && draft.port.trim() !== "") {
    const num = Number(draft.port.trim());
    if (!Number.isInteger(num) || num < 1 || num > 65535) {
      return { ok: false, issue: { field: "port", message: "invalidPort" } };
    }
    parsedPort = num;
  }

  const modelFields: Partial<CreateWorkspaceInput> = {
    ...(draft.model?.trim() ? { model: draft.model.trim() } : {}),
    ...(draft.serviceTier !== undefined ? { serviceTier: draft.serviceTier } : {}),
    ...(draft.effort !== undefined ? { effort: draft.effort } : {}),
  };

  const effectiveGlobalQuality: VideoQualityPreset = context?.globalVideoQuality ?? "balanced";
  const storageFields: Partial<CreateWorkspaceInput> =
    draft.videoQuality && draft.videoQuality !== effectiveGlobalQuality
      ? {
          storage: {
            mode: "local",
            videoQuality: draft.videoQuality,
            maxBytes: VIDEO_QUALITY_SPECS[draft.videoQuality].recommendedMaxBytes,
          },
        }
      : {};

  const mode = effectiveTargetMode(draft);

  // Mode 1: Registered Baseware Machine node
  if (mode === "machine") {
    const machineId = draft.machineId?.trim() ?? "";
    if (!machineId) {
      return { ok: false, issue: { field: "machineId", message: "machineRequired" } };
    }
    const matched = context?.machines?.find(item => item.id === machineId);
    const resolvedDriver =
      matched?.driver ||
      (machineId === BUILTIN_LOCAL_BROWSER_MACHINE.id ? "browser" : undefined) ||
      draft.driverId?.trim() ||
      "cua";
    const resolvedPkg = matched?.driverPackage || (draft.driverPackage.trim() || undefined);
    const rawUrl = draft.url?.trim() || "";
    const trimmedUrl = rawUrl ? normalizeWorkspaceBrowserUrl(rawUrl) : "";
    const isBuiltinPkg =
      resolvedPkg === BUILTIN_CUA_DRIVER_SPEC || resolvedPkg === BUILTIN_BROWSER_DRIVER_SPEC;
    return {
      ok: true,
      input: {
        name: location.name,
        driver: resolvedDriver,
        machineId,
        ...(location.custom ? { workspace: location.path! } : {}),
        ...(resolvedPkg && !isBuiltinPkg ? { driverPackage: resolvedPkg } : {}),
        ...(resolvedDriver === "browser" && trimmedUrl ? { url: trimmedUrl } : {}),
        ...modelFields,
        ...storageFields,
      },
    };
  }

  // Mode 2: Built-in Browser driver from catalog
  if (
    mode === "driver" &&
    (context?.catalogDriver?.spec === BUILTIN_BROWSER_DRIVER_SPEC ||
      context?.catalogDriver?.id === "browser" ||
      (!context?.catalogDriver && draft.driverId === "browser"))
  ) {
    const rawUrl = draft.url?.trim() || "";
    const trimmedUrl = rawUrl ? normalizeWorkspaceBrowserUrl(rawUrl) : "";
    return {
      ok: true,
      input: {
        name: location.name,
        driver: "browser",
        ...(location.custom ? { workspace: location.path! } : {}),
        ...(trimmedUrl ? { url: trimmedUrl } : {}),
        ...modelFields,
        ...storageFields,
      },
    };
  }

  // Mode 2: Installed / Cached Driver from catalog (when a non-custom catalog driver is selected)
  if (
    mode === "driver" &&
    context?.catalogDriver &&
    context.catalogDriver.spec !== BUILTIN_CUA_DRIVER_SPEC &&
    context.catalogDriver.spec !== BUILTIN_BROWSER_DRIVER_SPEC
  ) {
    const catalogDriver = context.catalogDriver;
    const capabilities = workspaceDriverCapabilities("community", driver, catalogDriver);
    if (capabilities.missingPort && parsedPort === undefined) {
      return { ok: false, issue: { field: "port", message: "unsupportedBridge" } };
    }
    return {
      ok: true,
      input: {
        name: location.name,
        driver: catalogDriver.id,
        driverPackage: catalogDriver.spec,
        ...(location.custom ? { workspace: location.path! } : {}),
        ...(capabilities.supportsGame && draft.game.trim() ? { game: draft.game.trim() } : {}),
        ...(!capabilities.stdio && parsedPort !== undefined ? { port: parsedPort } : {}),
        ...(capabilities.stdio && draft.cuaCommand.trim() ? { cuaCommand: draft.cuaCommand.trim() } : {}),
        ...modelFields,
        ...storageFields,
      },
    };
  }

  // Mode 2 (built-in desktop CUA) or Mode 3 (community package)
  const spec = draft.driverPackage.trim();
  if (draft.environment === "community") {
    if (!spec) return { ok: false, issue: { field: "driverPackage", message: "packageRequired" } };
    if (!driver || driver.spec !== spec || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(driver.id)) {
      return { ok: false, issue: { field: "driverPackage", message: "verifyFirst" } };
    }
  }
  const capabilities = workspaceDriverCapabilities(draft.environment, driver);
  if (capabilities.missingPort && parsedPort === undefined) {
    return { ok: false, issue: { field: "driverPackage", message: "unsupportedBridge" } };
  }

  return {
    ok: true,
    input: {
      name: location.name,
      driver: draft.environment === "desktop" ? "cua" : driver!.id,
      ...(location.custom ? { workspace: location.path! } : {}),
      ...(draft.environment === "community" ? { driverPackage: spec } : {}),
      ...(capabilities.supportsGame && draft.game.trim() ? { game: draft.game.trim() } : {}),
      ...(!capabilities.stdio && parsedPort !== undefined ? { port: parsedPort } : {}),
      ...(capabilities.stdio && draft.cuaCommand.trim() ? { cuaCommand: draft.cuaCommand.trim() } : {}),
      ...(draft.environment === "community" && draft.registerDriver ? { registerDriver: true } : {}),
      ...modelFields,
      ...storageFields,
    },
  };
}

export function workspaceUpCommand(workspace: string) {
  return `ludens --workspace '${workspace.replace(/'/g, "'\\''")}' workspace up`;
}
