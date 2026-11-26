/** Pure, browser-safe workspace & OMP configuration DTOs and validators. */

import type { ModelConnectionConfig } from "./connection.ts";
import type { BasewareMachineSpec, MachineTransportKind, WorkspaceMachinesBinding } from "./machines.ts";
import type { WorkspaceStorageOverride } from "./storage.ts";
import type { DeviceStageKind } from "./viewport.ts";

export const OMP_SERVICE_TIERS = ["priority", "ultrafast"] as const;
export type OmpServiceTier = (typeof OMP_SERVICE_TIERS)[number];

export function isOmpServiceTier(value: unknown): value is OmpServiceTier {
  return typeof value === "string" && (OMP_SERVICE_TIERS as readonly string[]).includes(value);
}

export const OMP_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type OmpEffort = (typeof OMP_EFFORTS)[number];

export function isOmpEffort(value: unknown): value is OmpEffort {
  return typeof value === "string" && (OMP_EFFORTS as readonly string[]).includes(value);
}

export function validWorkspaceId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id);
}

export interface WorkspaceDefaults {
  model?: string;
  serviceTier?: OmpServiceTier;
  effort?: OmpEffort;
  compactionThreshold?: number;
  pet?: boolean;
  connection?: ModelConnectionConfig;
}

export interface LudensConfig {
  version: 1;
  workspaceRoot: string;
  defaults: WorkspaceDefaults;
}

export interface WorkspaceIdentity {
  version: 1;
  id: string;
  historyIds?: string[];
}

export interface WorkspaceRegistration {
  id: string;
  workspace: string;
  name: string;
  updatedAt: string;
}

export interface RegisteredWorkspace extends WorkspaceRegistration {
  available: boolean;
}

export interface CreateWorkspaceInput {
  name: string;
  workspace?: string;
  driver: string;
  driverPackage?: string;
  machineId?: string;
  game?: string;
  url?: string;
  port?: number;
  cuaCommand?: string;
  model?: string;
  serviceTier?: OmpServiceTier | null;
  effort?: OmpEffort | null;
  pet?: boolean;
  registerDriver?: boolean;
  storage?: WorkspaceStorageOverride;
}

export interface WorkspaceConfigSummary {
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
  diagnostics: "normal" | "full";
}

export interface WorkspaceServiceJobSnapshot {
  name: "emulator" | "baseware" | "host" | "pet";
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

export type DriverRegistrationStatus = "builtin" | "registered" | "unregistered";
export type DriverSourceKind = "builtin" | "file" | "github" | "npm" | "cache" | "unknown";

export interface BasewareDriverOverviewItem {
  key: string;
  id: string;
  spec: string;
  sourceKind: DriverSourceKind;
  registrationStatus: DriverRegistrationStatus;
  available: boolean;
  runtimeInjected?: boolean;
  stageKind?: DeviceStageKind;
  localPath?: string;
  cacheKey?: string;
  packageName?: string;
  name?: string;
  version?: string;
  description?: string;
  transport?: MachineTransportKind;
  defaultPort?: number;
  needsGame?: boolean;
  launchHint?: string;
  usedByMachineIds: string[];
  usedByWorkspaceIds: string[];
  usedByCurrentWorkspace: boolean;
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
  drivers: BasewareDriverOverviewItem[];
  browserHost?: {
    available: boolean;
    hostId?: string;
    socketPath?: string;
  };
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

export interface WorkspaceStudioConfigPatch {
  model?: string;
  serviceTier?: OmpServiceTier | null;
  effort?: OmpEffort | null;
  compactionThreshold?: number | null;
  diagnostics?: "normal" | "full";
  pet?: boolean;
  dashboard?: boolean;
  port?: number | null;
  game?: string | null;
  url?: string | null;
  cuaCommand?: string | null;
  connection?: ModelConnectionConfig | null;
  machines?: WorkspaceMachinesBinding | null;
  storage?: WorkspaceStorageOverride | null;
}

export type WorkspaceShioriMutationInput =
  | { kind: "newSession" }
  | { kind: "selectSession"; sessionFile: string }
  | { kind: "saveMemory"; content: string }
  | {
      kind?: "setModel";
      model: string;
      serviceTier?: OmpServiceTier | null;
      effort?: OmpEffort | null;
    };

export interface WorkspaceSettings {
  home: string;
  config: LudensConfig;
  workspaces: RegisteredWorkspace[];
  summaries: Record<string, WorkspaceConfigSummary | null>;
}

export interface WorkspaceRootResult {
  config: LudensConfig;
}

export interface GlobalConnectionResult {
  config: LudensConfig;
}

export interface GlobalDefaultsResult {
  config: LudensConfig;
}

export interface WorkspaceConnectionSnapshot {
  id: string;
  workspace: string;
  model: string | null;
  connection: ModelConnectionConfig;
  defaults: ModelConnectionConfig;
}

export interface WorkspaceServiceControlResult {
  ok: boolean;
  operation: "up" | "down" | "reload";
  exitCode: number;
  stdout: string;
  stderr: string;
  studio: WorkspaceStudioSnapshot;
}

export interface WorkspaceRemovalResult {
  removed: WorkspaceRegistration | null;
}

export interface LegacyWorkspaceImportReceipt {
  version: 1;
  workspaceId: string;
  source: string;
  previousWorkspace: string;
  sessions: number;
  copiedFiles: number;
  importedAt: string;
  limitations: string[];
}
