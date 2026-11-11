import type { getActivity, ActivityQuery } from "./activity";
import type { availableModels, AvailableModelItem, AvailableModelsCatalog } from "./available-models";
import type { HostControlStatus, RuntimeControlCommand } from "./runtime-control";

export type { AvailableModelItem, AvailableModelsCatalog };
import type {
  EventPoolMutationCommand,
  EventPoolQueryFilter,
  mutateWorkspaceEventPool,
  readWorkspaceEventPool,
} from "./event-pool";
import type { petState, recordPetConsumer, setPetTarget } from "./pet-state";
import type { discoverDriver } from "./drivers";
import type { capabilities, capabilityRuntime, runWorkspaceCapabilityEval } from "./capabilities";
import type { archiveBuild, catalog, getRun, mediaFile, stopRun, timelineRecord } from "./data";
import type { docGroups, readDoc } from "./docs";
import type { getReplay, ReplayQuery } from "./replay";
import type { RunPage } from "./run-index";
import type { diagnosticEvents, DiagnosticQuery } from "./diagnostic-events";
import type { indexCacheStats } from "./log-index";
import type { PerceptionSettings, PerceptionSettingsPatch, PerceptionRuntimeSnapshot } from "./perception-config";
import type {
  workspaceSettings,
  updateWorkspaceRoot,
  updateGlobalConnection,
  updateGlobalDefaults,
  workspaceConnection,
  updateWorkspaceConnection,
  workspaceStudio,
  updateWorkspaceStudioConfig,
  updateWorkspaceShiori,
  openWorkspace,
  removeWorkspace,
  createWorkspace,
  basewareOverview,
  upsertBasewareMachine,
  removeBasewareMachine,
  updateWorkspaceMachines,
  controlWorkspaceService,
  probeBasewareMachine,
  WorkspaceBasewareSnapshot,
} from "./workspaces";

/** Only existing Dashboard operations cross the worker boundary, never arbitrary code or paths. */
export interface DashboardMethods {
  availableModels: { args: [workspaceId?: unknown]; result: AvailableModelsCatalog };
  workspaceSettings: { args: []; result: Awaited<ReturnType<typeof workspaceSettings>> };
  updateWorkspaceRoot: { args: [path: unknown]; result: Awaited<ReturnType<typeof updateWorkspaceRoot>> };
  updateGlobalConnection: { args: [connection: unknown]; result: Awaited<ReturnType<typeof updateGlobalConnection>> };
  updateGlobalDefaults: { args: [patch: unknown]; result: Awaited<ReturnType<typeof updateGlobalDefaults>> };
  workspaceConnection: { args: [id: unknown]; result: Awaited<ReturnType<typeof workspaceConnection>> };
  updateWorkspaceConnection: { args: [id: unknown, connection: unknown]; result: Awaited<ReturnType<typeof updateWorkspaceConnection>> };
  workspaceStudio: { args: [id: unknown]; result: Awaited<ReturnType<typeof workspaceStudio>> };
  updateWorkspaceStudioConfig: { args: [id: unknown, patch: unknown]; result: Awaited<ReturnType<typeof updateWorkspaceStudioConfig>> };
  updateWorkspaceShiori: { args: [id: unknown, input: unknown]; result: Awaited<ReturnType<typeof updateWorkspaceShiori>> };
  openWorkspace: { args: [path: unknown]; result: Awaited<ReturnType<typeof openWorkspace>> };
  removeWorkspace: { args: [id: unknown]; result: Awaited<ReturnType<typeof removeWorkspace>> };
  createWorkspace: { args: [input: unknown]; result: Awaited<ReturnType<typeof createWorkspace>> };
  basewareOverview: { args: [workspaceId?: unknown]; result: Awaited<ReturnType<typeof basewareOverview>> };
  upsertBasewareMachine: { args: [input: unknown]; result: Awaited<ReturnType<typeof upsertBasewareMachine>> };
  removeBasewareMachine: { args: [id: unknown]; result: Awaited<ReturnType<typeof removeBasewareMachine>> };
  updateWorkspaceMachines: { args: [id: unknown, input: unknown]; result: Awaited<ReturnType<typeof updateWorkspaceMachines>> };
  controlWorkspaceMachine: { args: [id: unknown, input: unknown]; result: WorkspaceBasewareSnapshot };
  probeBasewareMachine: { args: [input: unknown]; result: Awaited<ReturnType<typeof probeBasewareMachine>> };
  controlWorkspaceService: { args: [id: unknown, input: unknown]; result: Awaited<ReturnType<typeof controlWorkspaceService>> };
  archiveBuild: { args: [project: string, run: string, action?: "cancel" | "retry", buildId?: string]; result: Awaited<ReturnType<typeof archiveBuild>> };
  diagnosticEvents: { args: [project: string, run: string, query?: DiagnosticQuery]; result: Awaited<ReturnType<typeof diagnosticEvents>> };
  diagnostics: { args: []; result: { memory: NodeJS.MemoryUsage; index: ReturnType<typeof indexCacheStats>; activeRequests: number } };
  catalog: { args: [includeEmpty?: boolean]; result: Awaited<ReturnType<typeof catalog>> };
  run: { args: [project: string, run: string, epoch?: string, page?: RunPage]; result: Awaited<ReturnType<typeof getRun>> };
  activity: { args: [project: string, run?: string, epoch?: string, query?: ActivityQuery]; result: Awaited<ReturnType<typeof getActivity>> };
  replay: { args: [project: string, run: string, query: ReplayQuery]; result: Awaited<ReturnType<typeof getReplay>> };
  media: { args: [project: string, run: string, id: string]; result: Awaited<ReturnType<typeof mediaFile>> };
  timelineRecord: { args: [project: string, run: string, record: string, sequence: number, source: { call?: string; observation?: string }]; result: Awaited<ReturnType<typeof timelineRecord>> };
  capabilities: { args: [project: string, workspace: string]; result: Awaited<ReturnType<typeof capabilities>> };
  capabilityRuntime: { args: [project: string, workspace: string]; result: Awaited<ReturnType<typeof capabilityRuntime>> };
  runtimeControl: { args: [project: string, workspace: string, command: RuntimeControlCommand]; result: HostControlStatus };
  eventPoolRead: { args: [project: string, workspace: string, filter?: EventPoolQueryFilter]; result: Awaited<ReturnType<typeof readWorkspaceEventPool>> };
  eventPoolMutate: { args: [project: string, workspace: string, command: EventPoolMutationCommand]; result: Awaited<ReturnType<typeof mutateWorkspaceEventPool>> };
  runWorkspaceCapabilityEval: { args: [project: string, workspace: string, options?: { capabilityId?: string; all?: boolean }]; result: Awaited<ReturnType<typeof runWorkspaceCapabilityEval>> };
  discoverDriver: { args: [spec: string]; result: Awaited<ReturnType<typeof discoverDriver>> };
  docGroups: { args: [root?: string, lang?: "en" | "zh"]; result: Awaited<ReturnType<typeof docGroups>> };
  readDoc: { args: [id: string, root?: string, lang?: "en" | "zh"]; result: Awaited<ReturnType<typeof readDoc>> };
  stop: { args: [project: string, run: string, epoch: string | null]; result: Awaited<ReturnType<typeof stopRun>> };
  perceptionSettings: { args: [project: string, workspace: string]; result: Partial<PerceptionSettings> };
  updatePerceptionSettings: { args: [project: string, patch: PerceptionSettingsPatch, workspace: string]; result: Partial<PerceptionSettings> };
  perceptionRuntime: { args: [project: string, workspace: string]; result: PerceptionRuntimeSnapshot };
  petState: { args: []; result: Awaited<ReturnType<typeof petState>> };
  petTarget: { args: [project: unknown, ifUnset: boolean]; result: Awaited<ReturnType<typeof setPetTarget>> };
  petConsumer: { args: [input: unknown]; result: Awaited<ReturnType<typeof recordPetConsumer>> };
}
export type DashboardMethod = keyof DashboardMethods;
export type WorkerRequest = { type: "call"; id: number; method: DashboardMethod; args: unknown[] }
  | { type: "cancel"; id: number } | { type: "close" };
export interface WorkerFailure { name: string; message: string; status?: number; code?: string; progress?: unknown }
export type WorkerResponse = { type: "ready" } | { type: "result"; id: number; value: unknown }
  | { type: "error"; id: number; error: WorkerFailure };

export function workerFailure(error: unknown): WorkerFailure {
  const value = error as Partial<WorkerFailure> | null;
  return { name: value?.name ?? "Error", message: value?.message ?? String(error),
    ...(typeof value?.status === "number" ? { status: value.status } : {}),
    ...(typeof value?.code === "string" ? { code: value.code } : {}),
    ...(value?.progress === undefined ? {} : { progress: value.progress }) };
}
