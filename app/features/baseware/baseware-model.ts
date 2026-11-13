import {
  BUILTIN_LOCAL_DESKTOP_MACHINE,
  validMachineId,
  type BasewareMachineSpec,
  type MachineTransportConfig,
  type MachineTransportKind,
  type WorkspaceMachinesBinding,
} from "@ludens/protocol/machines";
import { BUILTIN_CUA_DRIVER_SPEC } from "@ludens/protocol/drivers";
import type {
  BasewareDriverOverviewItem,
  BasewareMachineRuntimeStatus,
  WorkspaceBasewareSnapshot,
} from "@/lib/workspaces";
import type { CapabilityEntry } from "@/lib/capabilities";

export type MachineRegistrationStatus = "builtin" | "registered" | "unregistered";
export type WorkspaceAdditionStatus = "primary" | "added" | "not-added";
export type MachineBindMode = "primary" | "allowed" | "none";

export type MountedMachineStatus = NonNullable<
  NonNullable<WorkspaceBasewareSnapshot["daemon"]["status"]>["mountedMachines"]
>[number];

export interface DisplayMachineItem extends BasewareMachineSpec {
  registrationStatus: MachineRegistrationStatus;
  workspaceAdditionStatus: WorkspaceAdditionStatus;
  usedByWorkspaceIds: string[];
  mountedInfo: MountedMachineStatus | null;
  isMounted: boolean;
  isImplicit: boolean;
}

export interface MachineDraft {
  id: string;
  name: string;
  driver: string;
  driverPackage: string;
  transportKind: MachineTransportKind;
  stdioCommand: string;
  stdioArgs: string;
  bridgeHost: string;
  bridgePort: string;
  bridgeGame: string;
  bridgeManaged: boolean;
  sshHost: string;
  sshUser: string;
  sshPort: string;
  sshIdentityFile: string;
  sshCommand: string;
  httpUrl: string;
  bindMode: MachineBindMode;
}

export type MachineDraftErrorField =
  | "id"
  | "name"
  | "driver"
  | "driverPackage"
  | "stdioCommand"
  | "bridgeHost"
  | "bridgePort"
  | "sshHost"
  | "sshPort"
  | "httpUrl";

export type MachineDraftErrorCode =
  | "required"
  | "invalidId"
  | "reservedId"
  | "invalidPort"
  | "invalidUrl"
  | "invalidSpec";

export type MachineDraftErrors = Partial<Record<MachineDraftErrorField, MachineDraftErrorCode>>;

export interface DriverSpecValidation {
  valid: boolean;
  error?: "required" | "invalidFormat";
}

export interface NormalizedDaemonState {
  activeMachineId: string | null;
  mountedById: Map<string, MountedMachineStatus>;
}

export interface BasewareSummaryMetrics {
  totalDrivers: number;
  registeredDrivers: number;
  unregisteredDrivers: number;
  activeTarget: DisplayMachineItem | null;
  addedMachinesCount: number;
  mountedMachinesCount: number;
  globalMachinesCount: number;
}

export function isValidDriverSpecString(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed === BUILTIN_CUA_DRIVER_SPEC) return false;
  if (trimmed.startsWith("file:")) {
    return trimmed.slice(5).trim().length > 0;
  }
  if (/\s/.test(trimmed)) return false;
  if (trimmed.startsWith("github:") || trimmed.startsWith("npm:")) {
    return trimmed.length > trimmed.indexOf(":") + 1;
  }
  if (/^https?:\/\/github\.com\/[^/\s]+\/[^/\s#]+(#\S+)?$/i.test(trimmed)) {
    return true;
  }
  if (/^git@github\.com:[^/\s:]+\/[^/\s#]+(#\S+)?$/i.test(trimmed)) {
    return true;
  }
  // Plain npm package name or scoped npm package (@scope/name or name)
  if (/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[^\s]+)?$/i.test(trimmed)) {
    return true;
  }
  return false;
}

export function validateDriverSpecInput(spec: string): DriverSpecValidation {
  const trimmed = spec.trim();
  if (!trimmed) return { valid: false, error: "required" };
  if (!isValidDriverSpecString(trimmed)) return { valid: false, error: "invalidFormat" };
  return { valid: true };
}

/**
 * When an inline workspace runs via `ludens up` without `machines` config,
 * `baseware/src/main.ts` reports the mounted machine ID as `"primary"`.
 * Map that live `"primary"` runtime mount onto `implicitMachine` (`"workspace-default"`)
 * when no explicit global machine named `"primary"` exists.
 */
export function normalizeDaemonForSnapshot(snapshot: WorkspaceBasewareSnapshot | null | undefined): NormalizedDaemonState {
  const mountedById = new Map<string, MountedMachineStatus>();
  const status = snapshot?.daemon?.status;
  if (!snapshot || !status) {
    return { activeMachineId: null, mountedById };
  }

  const hasExplicitPrimary =
    snapshot.machines.some(machine => machine.id === "primary")
    && (snapshot.binding.active === "primary" || snapshot.binding.allowed.includes("primary"));
  const hasImplicit = Boolean(snapshot.implicitMachine);

  for (const item of status.mountedMachines ?? []) {
    mountedById.set(item.id, item);
    if (item.id === "primary" && !hasExplicitPrimary && hasImplicit && snapshot.implicitMachine) {
      mountedById.set(snapshot.implicitMachine.id, {
        ...item,
        id: snapshot.implicitMachine.id,
      });
    }
  }

  let activeMachineId: string | null = status.activeMachineId ?? null;
  if (activeMachineId === "primary" && !hasExplicitPrimary && hasImplicit && snapshot.implicitMachine) {
    activeMachineId = snapshot.implicitMachine.id;
  }
  return { activeMachineId, mountedById };
}

function registrationRank(status: MachineRegistrationStatus): number {
  switch (status) {
    case "unregistered":
      return 0;
    case "registered":
      return 1;
    case "builtin":
      return 2;
  }
}

export function buildDisplayMachines(snapshot: WorkspaceBasewareSnapshot | null | undefined): DisplayMachineItem[] {
  if (!snapshot) return [];
  const binding: WorkspaceMachinesBinding = snapshot.binding ?? {
    active: null,
    allowed: [],
  };
  const { activeMachineId: daemonActiveId, mountedById } = normalizeDaemonForSnapshot(snapshot);
  const effectiveActiveId = daemonActiveId ?? binding.active;
  const allowedSet = new Set(binding.allowed);

  const rawItems: Array<{ spec: BasewareMachineSpec | BasewareMachineRuntimeStatus; implicit: boolean }> = [];
  if (snapshot.implicitMachine) {
    rawItems.push({ spec: snapshot.implicitMachine, implicit: true });
  }
  for (const machine of snapshot.machines) {
    rawItems.push({ spec: machine, implicit: false });
  }

  const items: DisplayMachineItem[] = rawItems.map(({ spec, implicit }) => {
    const registrationStatus: MachineRegistrationStatus = implicit
      ? "unregistered"
      : spec.id === BUILTIN_LOCAL_DESKTOP_MACHINE.id
        ? "builtin"
        : "registered";
    const mountedInfo = mountedById.get(spec.id) ?? null;
    const isMounted = Boolean(mountedInfo?.connected);
    const workspaceAdditionStatus: WorkspaceAdditionStatus =
      effectiveActiveId === spec.id
        ? "primary"
        : allowedSet.has(spec.id) || implicit
          ? "added"
          : "not-added";
    const usedByWorkspaceIds = "usedByWorkspaceIds" in spec && Array.isArray(spec.usedByWorkspaceIds)
      ? spec.usedByWorkspaceIds
      : snapshot.workspaceId && implicit
        ? [snapshot.workspaceId]
        : [];
    return {
      ...spec,
      registrationStatus,
      workspaceAdditionStatus,
      usedByWorkspaceIds,
      mountedInfo,
      isMounted,
      isImplicit: implicit,
    };
  });

  const additionRank = (status: WorkspaceAdditionStatus) =>
    status === "primary" ? 0 : status === "added" ? 1 : 2;

  return items.sort((a, b) =>
    additionRank(a.workspaceAdditionStatus) - additionRank(b.workspaceAdditionStatus)
    || Number(b.isMounted) - Number(a.isMounted)
    || registrationRank(a.registrationStatus) - registrationRank(b.registrationStatus)
    || a.id.localeCompare(b.id),
  );
}

export function resolveControllersForMachine(
  rawDeviceItems: CapabilityEntry[],
  selectedMachine: DisplayMachineItem | null,
  snapshot: WorkspaceBasewareSnapshot | null | undefined,
): CapabilityEntry[] {
  if (!selectedMachine || rawDeviceItems.length === 0) return [];
  const { mountedById } = normalizeDaemonForSnapshot(snapshot);

  const prefixes = [`controller/${selectedMachine.id}/`];
  if (selectedMachine.isImplicit && !snapshot?.machines.some(m => m.id === "primary")) {
    prefixes.push("controller/primary/");
  }

  for (const prefix of prefixes) {
    const prefixed = rawDeviceItems.filter(item => item.id.startsWith(prefix));
    if (prefixed.length > 0) {
      return prefixed.map(item => ({
        ...item,
        id: `controller/${item.id.slice(prefix.length)}`,
      }));
    }
  }

  if (selectedMachine.workspaceAdditionStatus === "primary" && (mountedById.size === 0 || selectedMachine.isMounted)) {
    return rawDeviceItems.filter(item => !item.id.slice("controller/".length).includes("/"));
  }
  return [];
}

export function computeBasewareSummary(snapshot: WorkspaceBasewareSnapshot | null | undefined): BasewareSummaryMetrics {
  const displayMachines = buildDisplayMachines(snapshot);
  const drivers = snapshot?.drivers ?? [];
  const registeredDrivers = drivers.filter(d => d.registrationStatus !== "unregistered").length;
  const unregisteredDrivers = drivers.filter(d => d.registrationStatus === "unregistered").length;
  const activeTarget = displayMachines.find(m => m.workspaceAdditionStatus === "primary") ?? null;
  const addedMachinesCount = displayMachines.filter(m => m.workspaceAdditionStatus !== "not-added").length;
  const mountedMachinesCount = displayMachines.filter(m => m.isMounted).length;
  return {
    totalDrivers: drivers.length,
    registeredDrivers,
    unregisteredDrivers,
    activeTarget,
    addedMachinesCount,
    mountedMachinesCount,
    globalMachinesCount: snapshot?.machines.length ?? 0,
  };
}

function suggestMachineId(rawSeed: string, existingIds: Iterable<string>): string {
  const taken = new Set(existingIds);
  taken.add("workspace-default");
  taken.add(BUILTIN_LOCAL_DESKTOP_MACHINE.id);

  let base = rawSeed
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|[-_.]+$/g, "");
  if (!base || !validMachineId(base)) {
    base = "device";
  }
  if (!taken.has(base) && validMachineId(base)) return base;
  for (let i = 1; i < 1000; i += 1) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate) && validMachineId(candidate)) return candidate;
  }
  return `device-${Date.now()}`;
}

export function createEmptyMachineDraft(bindMode: MachineBindMode = "primary"): MachineDraft {
  return {
    id: "",
    name: "",
    driver: "cua",
    driverPackage: "",
    transportKind: "bridge",
    stdioCommand: "",
    stdioArgs: "",
    bridgeHost: "127.0.0.1",
    bridgePort: "47663",
    bridgeGame: "",
    bridgeManaged: false,
    sshHost: "",
    sshUser: "",
    sshPort: "22",
    sshIdentityFile: "",
    sshCommand: "cua-driver",
    httpUrl: "",
    bindMode,
  };
}

export function draftFromDriver(
  driver: Pick<BasewareDriverOverviewItem, "id" | "spec" | "name" | "transport" | "defaultPort">,
  existingIds: Iterable<string> = [],
): MachineDraft {
  const isBuiltinCua = driver.spec === BUILTIN_CUA_DRIVER_SPEC || driver.spec.startsWith("driver:");
  const transportKind: MachineTransportKind = driver.transport ?? (driver.id === "cua" ? "stdio" : "bridge");
  const defaultPort = driver.defaultPort ?? 47663;
  return {
    ...createEmptyMachineDraft("primary"),
    id: suggestMachineId(driver.id === "cua" ? "desktop-node" : driver.id, existingIds),
    name: driver.name ? `${driver.name}` : `${driver.id} Node`,
    driver: driver.id,
    driverPackage: isBuiltinCua ? "" : driver.spec,
    transportKind,
    stdioCommand: driver.id === "cua" ? "cua-driver" : driver.id,
    bridgePort: String(defaultPort),
  };
}

export function draftFromImplicitMachine(
  implicit: BasewareMachineSpec,
  workspaceId: string | null,
  existingIds: Iterable<string> = [],
): MachineDraft {
  const baseDraft = draftFromMachine(implicit, "primary");
  const seed = workspaceId || implicit.driver;
  return {
    ...baseDraft,
    id: suggestMachineId(seed, existingIds),
    name: implicit.name,
    bindMode: "primary",
  };
}

export function draftFromMachine(
  machine: BasewareMachineSpec,
  additionStatus: WorkspaceAdditionStatus = "primary",
): MachineDraft {
  const bindMode: MachineBindMode =
    additionStatus === "primary" ? "primary" : additionStatus === "added" ? "allowed" : "none";
  const base: MachineDraft = {
    ...createEmptyMachineDraft(bindMode),
    id: machine.id,
    name: machine.name,
    driver: machine.driver,
    driverPackage: machine.driverPackage ?? "",
    transportKind: machine.transport.kind,
  };
  switch (machine.transport.kind) {
    case "stdio":
      base.stdioCommand = machine.transport.command ?? "";
      base.stdioArgs = (machine.transport.args ?? []).join(" ");
      break;
    case "bridge":
      base.bridgeHost = machine.transport.host ?? "127.0.0.1";
      base.bridgePort = String(machine.transport.port);
      base.bridgeGame = machine.transport.game ?? "";
      base.bridgeManaged = Boolean(machine.transport.managed);
      break;
    case "ssh":
      base.sshHost = machine.transport.host;
      base.sshUser = machine.transport.user ?? "";
      base.sshPort = String(machine.transport.port ?? 22);
      base.sshIdentityFile = machine.transport.identityFile ?? "";
      base.sshCommand = machine.transport.command ?? "cua-driver";
      break;
    case "http":
    case "sse":
      base.httpUrl = machine.transport.url;
      break;
  }
  return base;
}

export function buildMachineSpecFromDraft(draft: MachineDraft): BasewareMachineSpec {
  let transport: MachineTransportConfig;
  switch (draft.transportKind) {
    case "stdio": {
      const args = draft.stdioArgs
        .split(/\s+/)
        .map(item => item.trim())
        .filter(Boolean);
      transport = {
        kind: "stdio",
        ...(draft.stdioCommand.trim() ? { command: draft.stdioCommand.trim() } : {}),
        ...(args.length > 0 ? { args } : {}),
      };
      break;
    }
    case "bridge": {
      const port = Number(draft.bridgePort.trim());
      transport = {
        kind: "bridge",
        host: draft.bridgeHost.trim() || "127.0.0.1",
        port: Number.isInteger(port) && port > 0 ? port : 47663,
        ...(draft.bridgeGame.trim() ? { game: draft.bridgeGame.trim() } : {}),
        managed: draft.bridgeManaged,
      };
      break;
    }
    case "ssh": {
      const port = Number(draft.sshPort.trim());
      transport = {
        kind: "ssh",
        host: draft.sshHost.trim(),
        ...(draft.sshUser.trim() ? { user: draft.sshUser.trim() } : {}),
        ...(Number.isInteger(port) && port > 0 ? { port } : {}),
        ...(draft.sshIdentityFile.trim() ? { identityFile: draft.sshIdentityFile.trim() } : {}),
        ...(draft.sshCommand.trim() ? { command: draft.sshCommand.trim() } : {}),
      };
      break;
    }
    case "http":
    case "sse": {
      transport = {
        kind: draft.transportKind,
        url: draft.httpUrl.trim(),
      };
      break;
    }
  }
  return {
    id: draft.id.trim(),
    name: draft.name.trim(),
    driver: draft.driver.trim(),
    ...(draft.driverPackage.trim() ? { driverPackage: draft.driverPackage.trim() } : {}),
    transport,
    updatedAt: new Date().toISOString(),
  };
}

function parseStrictPort(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const num = Number(trimmed);
  return Number.isInteger(num) && num >= 1 && num <= 65535 ? num : null;
}

export function validateMachineDraft(
  draft: MachineDraft,
  isEditingExisting = false,
): { valid: boolean; errors: MachineDraftErrors } {
  const errors: MachineDraftErrors = {};
  const id = draft.id.trim();

  if (!id) {
    errors.id = "required";
  } else if (!isEditingExisting && id === "workspace-default") {
    errors.id = "reservedId";
  } else if (!validMachineId(id)) {
    errors.id = "invalidId";
  }

  if (!draft.name.trim()) {
    errors.name = "required";
  }

  if (!draft.driver.trim()) {
    errors.driver = "required";
  }

  if (draft.driverPackage.trim() && !isValidDriverSpecString(draft.driverPackage)) {
    errors.driverPackage = "invalidSpec";
  }

  switch (draft.transportKind) {
    case "stdio":
      if (draft.driver.trim() !== "cua" && !draft.stdioCommand.trim()) {
        errors.stdioCommand = "required";
      }
      break;
    case "bridge":
      if (!draft.bridgeHost.trim()) {
        errors.bridgeHost = "required";
      }
      if (!draft.bridgePort.trim()) {
        errors.bridgePort = "required";
      } else if (parseStrictPort(draft.bridgePort) === null) {
        errors.bridgePort = "invalidPort";
      }
      break;
    case "ssh":
      if (!draft.sshHost.trim()) {
        errors.sshHost = "required";
      }
      if (draft.sshPort.trim() && parseStrictPort(draft.sshPort) === null) {
        errors.sshPort = "invalidPort";
      }
      break;
    case "http":
    case "sse": {
      const rawUrl = draft.httpUrl.trim();
      if (!rawUrl) {
        errors.httpUrl = "required";
      } else {
        try {
          const parsed = new URL(rawUrl);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            errors.httpUrl = "invalidUrl";
          }
        } catch {
          errors.httpUrl = "invalidUrl";
        }
      }
      break;
    }
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}

export function formatTransportSummary(transport: MachineTransportConfig): string {
  switch (transport.kind) {
    case "stdio":
      return [transport.command || "cua-driver", ...(transport.args ?? [])].join(" ");
    case "bridge":
      return `${transport.host ?? "127.0.0.1"}:${transport.port}${transport.game ? ` · ${transport.game.split("/").pop()}` : ""}`;
    case "ssh":
      return `${transport.user ? `${transport.user}@` : ""}${transport.host}${transport.port && transport.port !== 22 ? `:${transport.port}` : ""} · ${transport.command || "cua-driver"}`;
    case "http":
    case "sse":
      return transport.url;
  }
}

export function formatCliControllerExample(machine: Pick<DisplayMachineItem, "id" | "isImplicit">): string {
  return machine.isImplicit
    ? "ludens controller controller/screen.capture"
    : `ludens controller controller/${machine.id}/screen.capture`;
}
