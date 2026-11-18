import type { DiscoveredDriver } from "@/lib/drivers";
import type {
  BasewareDriverOverviewItem,
  BasewareMachineRuntimeStatus,
  CreateWorkspaceInput,
} from "@/lib/workspaces";
import type { OmpEffort, OmpServiceTier, WorkspaceRegistration } from "@ludens/protocol/ludens";
import { BUILTIN_CUA_DRIVER_SPEC } from "@ludens/protocol/drivers";

export type WorkspaceEnvironment = "desktop" | "community";
export type WorkspaceTargetMode = "machine" | "driver" | "package";

export interface WorkspaceDraft {
  name: string;
  targetDirectory: string;
  environment: WorkspaceEnvironment;
  targetMode?: WorkspaceTargetMode;
  machineId?: string;
  driverId?: string;
  driverPackage: string;
  game: string;
  port?: string;
  cuaCommand: string;
  model?: string;
  serviceTier?: OmpServiceTier | null;
  effort?: OmpEffort | null;
  registerDriver?: boolean;
}

export const emptyWorkspaceDraft: WorkspaceDraft = {
  name: "",
  targetDirectory: "",
  environment: "desktop",
  driverPackage: "",
  game: "",
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
    const isCua = !drv || drv.id === "cua" || drv.spec === BUILTIN_CUA_DRIVER_SPEC;
    return {
      ...draft,
      targetMode: "driver",
      environment: isCua ? "desktop" : "community",
      machineId: undefined,
      driverId: drv?.id ?? "cua",
      driverPackage: isCua ? "" : drv.spec,
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

  const mode = effectiveTargetMode(draft);

  // Mode 1: Registered Baseware Machine node
  if (mode === "machine") {
    const machineId = draft.machineId?.trim() ?? "";
    if (!machineId) {
      return { ok: false, issue: { field: "machineId", message: "machineRequired" } };
    }
    const matched = context?.machines?.find(item => item.id === machineId);
    const resolvedDriver = matched?.driver || draft.driverId?.trim() || "cua";
    const resolvedPkg = matched?.driverPackage || (draft.driverPackage.trim() || undefined);
    return {
      ok: true,
      input: {
        name: location.name,
        driver: resolvedDriver,
        machineId,
        ...(location.custom ? { workspace: location.path! } : {}),
        ...(resolvedPkg && resolvedPkg !== BUILTIN_CUA_DRIVER_SPEC ? { driverPackage: resolvedPkg } : {}),
        ...modelFields,
      },
    };
  }

  // Mode 2: Installed / Cached Driver from catalog (when a non-custom catalog driver is selected)
  if (mode === "driver" && context?.catalogDriver && context.catalogDriver.spec !== BUILTIN_CUA_DRIVER_SPEC) {
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
    },
  };
}

export function workspaceUpCommand(workspace: string) {
  return `ludens --workspace '${workspace.replace(/'/g, "'\\''")}' up`;
}
