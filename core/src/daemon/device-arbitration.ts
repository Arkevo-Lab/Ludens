import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { defaultDriverCacheRoot, resolveDriver } from "@ludens/baseware/drivers/loader.ts";
import {
  listRegisteredWorkspaces,
  ludensHome,
  readMachinesConfig,
  type BasewareMachineSpec,
} from "@ludens/protocol/ludens";
import type { DeviceContentionConflict, ServiceLaunchOrigin } from "../core/query/types.ts";
import { jobStateFilePath, ludensSocketPath } from "./background-jobs.ts";
import { probeBackgroundJob, readJobRecord } from "./process-manager.ts";
import { send, type Request as TransportRequest } from "./transport.ts";

export interface WorkspaceDeviceIdentity {
  deviceKey: string | null;
  deviceLabel?: string;
  port?: number;
}

export interface OnlineDeviceHolder {
  projectId: string;
  workspace: string;
  workspaceName: string;
  deviceKey: string;
  deviceLabel?: string;
  port?: number;
  mode: string;
  consolidating: boolean;
  launchedBy?: ServiceLaunchOrigin;
}

export class DeviceBusyError extends Error {
  readonly status = 409;
  readonly code = "DEVICE_BUSY";
  readonly conflict: DeviceContentionConflict;

  constructor(conflict: DeviceContentionConflict, message?: string) {
    super(
      message ??
        `设备 ${conflict.deviceLabel ?? conflict.deviceKey} 正被工作区「${conflict.holderWorkspaceName ?? conflict.holderProjectId}」占用（${conflict.holderMode}）。`,
    );
    this.name = "DeviceBusyError";
    this.conflict = conflict;
  }
}

function normalizeBridgeHost(host?: string): string {
  const value = (host ?? "127.0.0.1").trim().toLowerCase();
  if (!value || value === "localhost" || value === "::1" || value === "0.0.0.0") {
    return "127.0.0.1";
  }
  return value;
}

function machineDeviceIdentity(machine: BasewareMachineSpec): WorkspaceDeviceIdentity {
  const label = machine.name || machine.id;
  const transport = machine.transport;
  if (transport.kind === "bridge") {
    const host = normalizeBridgeHost(transport.host);
    return {
      deviceKey: `bridge:${host}:${transport.port}`,
      deviceLabel: label,
      port: transport.port,
    };
  }
  if (transport.kind === "stdio") {
    const cmd = transport.command?.trim();
    if (
      machine.driver === "cua" &&
      (!cmd || cmd === "cua-driver" || machine.id === "local-desktop")
    ) {
      return { deviceKey: "stdio:local-desktop", deviceLabel: label };
    }
    return {
      deviceKey: `stdio:${machine.driver}:${cmd ?? "default"}`,
      deviceLabel: label,
    };
  }
  if (transport.kind === "ssh") {
    const user = transport.user ? `${transport.user}@` : "";
    const port = transport.port ?? 22;
    return {
      deviceKey: `ssh:${user}${transport.host}:${port}:${transport.command ?? ""}`,
      deviceLabel: label,
    };
  }
  return {
    deviceKey: `${transport.kind}:${transport.url}`,
    deviceLabel: label,
  };
}

/** Derive a physical device identity key for contention arbitration across workspaces. */
export async function resolveWorkspaceDeviceIdentity(
  workspacePath: string,
  home = ludensHome(),
): Promise<WorkspaceDeviceIdentity> {
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await readFile(join(workspacePath, "ludens.json"), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { deviceKey: null };
    }
    raw = parsed as Record<string, unknown>;
  } catch {
    return { deviceKey: null };
  }

  const machines =
    raw.machines && typeof raw.machines === "object" && !Array.isArray(raw.machines)
      ? (raw.machines as Record<string, unknown>)
      : null;
  const activeMachineId = typeof machines?.active === "string" ? machines.active.trim() : "";
  if (activeMachineId && activeMachineId !== "workspace-default") {
    try {
      const registry = await readMachinesConfig(home);
      const found = registry.machines.find(item => item.id === activeMachineId);
      if (found) return machineDeviceIdentity(found);
    } catch {
      // Fall back to inline workspace configuration when machines.json is unavailable.
    }
  }

  const driver = typeof raw.driver === "string" ? raw.driver.trim() : "";
  if (!driver) return { deviceKey: null };

  if (driver === "cua") {
    const cuaCommand = typeof raw.cuaCommand === "string" ? raw.cuaCommand.trim() : "";
    if (!cuaCommand || cuaCommand === "cua-driver") {
      return { deviceKey: "stdio:local-desktop", deviceLabel: "Local Desktop (CUA)" };
    }
    return { deviceKey: `stdio:cua:${cuaCommand}`, deviceLabel: `CUA (${cuaCommand})` };
  }

  if (typeof raw.port === "number" && Number.isInteger(raw.port) && raw.port > 0) {
    return {
      deviceKey: `bridge:127.0.0.1:${raw.port}`,
      deviceLabel: `${driver}:${raw.port}`,
      port: raw.port,
    };
  }

  try {
    const pkg =
      typeof raw.driverPackage === "string" && raw.driverPackage.startsWith("file:")
        ? `file:${resolve(workspacePath, raw.driverPackage.slice(5))}`
        : typeof raw.driverPackage === "string"
          ? raw.driverPackage
          : undefined;
    const cacheRoot = join(home, "cache", "drivers") || defaultDriverCacheRoot();
    const manifest = await resolveDriver(driver, pkg, cacheRoot);
    if (manifest.transport === "stdio") {
      return { deviceKey: `stdio:${driver}`, deviceLabel: driver };
    }
    if (typeof manifest.defaultPort === "number" && manifest.defaultPort > 0) {
      return {
        deviceKey: `bridge:127.0.0.1:${manifest.defaultPort}`,
        deviceLabel: `${driver}:${manifest.defaultPort}`,
        port: manifest.defaultPort,
      };
    }
  } catch {
    // Unresolved external driver packages cannot provide a reliable key without network.
  }

  return { deviceKey: null };
}

async function sendWithTimeout<T>(
  socketPath: string,
  request: TransportRequest,
  timeoutMs: number,
): Promise<T | null> {
  try {
    return (await Promise.race([
      send(socketPath, request) as Promise<T>,
      new Promise<null>(resolveTimeout => setTimeout(() => resolveTimeout(null), timeoutMs)),
    ])) as T | null;
  } catch {
    return null;
  }
}

export async function findOnlineDeviceHolders(
  targetWorkspace: string,
  identity: WorkspaceDeviceIdentity,
  home = ludensHome(),
): Promise<OnlineDeviceHolder[]> {
  if (!identity.deviceKey) return [];
  const canonicalTarget = await realpath(targetWorkspace).catch(() => resolve(targetWorkspace));
  const registered = await listRegisteredWorkspaces(home).catch(() => []);
  const holders: OnlineDeviceHolder[] = [];

  for (const entry of registered) {
    const candidateWorkspace = await realpath(entry.workspace).catch(() => resolve(entry.workspace));
    if (candidateWorkspace === canonicalTarget) continue;

    const bgDir = join(candidateWorkspace, "logs", "background");
    const hash = createHash("sha256").update(candidateWorkspace).digest("hex").slice(0, 16);
    const hostSocket = ludensSocketPath("core", hash);
    const [hostProbe, basewareProbe, emulatorProbe, hostStatus] = await Promise.all([
      probeBackgroundJob(jobStateFilePath(bgDir, "host")),
      probeBackgroundJob(jobStateFilePath(bgDir, "baseware")),
      probeBackgroundJob(jobStateFilePath(bgDir, "emulator")),
      sendWithTimeout<{ mode?: string; consolidating?: boolean }>(hostSocket, { kind: "status", argv: [] }, 350),
    ]);

    const anyAlive = Boolean(
      hostStatus || hostProbe.pid || basewareProbe.pid || emulatorProbe.pid,
    );
    if (!anyAlive) continue;

    const candidateIdentity = await resolveWorkspaceDeviceIdentity(candidateWorkspace, home);
    if (candidateIdentity.deviceKey !== identity.deviceKey) continue;

    const hostRecord = await readJobRecord(jobStateFilePath(bgDir, "host"));
    const mode = typeof hostStatus?.mode === "string" ? hostStatus.mode : "manual";
    const consolidating = Boolean(hostStatus?.consolidating);
    holders.push({
      projectId: entry.id,
      workspace: candidateWorkspace,
      workspaceName: entry.name,
      deviceKey: identity.deviceKey,
      ...(identity.deviceLabel ? { deviceLabel: identity.deviceLabel } : {}),
      ...(candidateIdentity.port !== undefined ? { port: candidateIdentity.port } : {}),
      mode,
      consolidating,
      ...(hostRecord?.launchedBy ? { launchedBy: hostRecord.launchedBy } : {}),
    });
  }

  return holders;
}

export function isHolderActive(holder: Pick<OnlineDeviceHolder, "mode" | "consolidating">): boolean {
  return holder.mode === "auto" || holder.consolidating;
}

export function toDeviceContentionConflict(holder: OnlineDeviceHolder): DeviceContentionConflict {
  return {
    holderProjectId: holder.projectId,
    holderWorkspaceName: holder.workspaceName,
    deviceKey: holder.deviceKey,
    ...(holder.deviceLabel ? { deviceLabel: holder.deviceLabel } : {}),
    holderMode: holder.mode === "auto" ? "auto" : holder.consolidating ? "consolidating" : holder.mode,
    ...(holder.launchedBy ? { holderOrigin: holder.launchedBy } : {}),
  };
}
