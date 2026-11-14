import type { ActivityResponse } from "./activity.ts";
import type { ModelConnectionConfig } from "./connection.ts";
import type { RegisteredDriverSpec } from "./drivers.ts";
import type {
  EventDirection,
  EventPoolSnapshot,
  PoolEvent,
  PoolEventStatus,
} from "./event-pool.ts";
import type { OmpEffort, OmpServiceTier, WorkspaceDefaults } from "./ludens.ts";
import type {
  BasewareMachineSpec,
  WorkspaceMachinesBinding,
} from "./machines.ts";

/** JSON-RPC 2.0 protocol identifier. */
export const JSON_RPC_VERSION = "2.0" as const;

/** Current Ludens App-Server JSON-RPC wire protocol version. */
export const APP_RPC_PROTOCOL_VERSION = "1.0" as const;

/** Server-to-client JSON-RPC notification method for subscribed server events. */
export const APP_RPC_EVENT_NOTIFICATION = "events/event" as const;

/** Standard + Ludens application JSON-RPC error codes. */
export const APP_RPC_ERROR_CODES = {
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  SERVER_ERROR: -32000,
  UNAUTHORIZED: -32001,
  NOT_FOUND: -32004,
  CONFLICT: -32009,
} as const;

export type AppRpcErrorCode =
  (typeof APP_RPC_ERROR_CODES)[keyof typeof APP_RPC_ERROR_CODES];

export type JsonRpcId = string | number;

export interface JsonRpcErrorData {
  code?: string;
  status?: number;
  conflict?: unknown;
  progress?: unknown;
  [key: string]: unknown;
}

export interface JsonRpcRequest<M extends string = string, P = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: M;
  params?: P;
}

export interface JsonRpcSuccess<R = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: R;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: JsonRpcErrorData;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: JsonRpcErrorObject;
}

export interface JsonRpcNotification<M extends string = string, P = unknown> {
  jsonrpc: "2.0";
  method: M;
  params?: P;
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcSuccess
  | JsonRpcError
  | JsonRpcNotification;

export type LiveStreamKind = "none" | "mjpeg" | "fmp4" | "webrtc";

/** Reserved descriptor for future continuous live stream capabilities. */
export interface LiveStreamDescriptor {
  kind: LiveStreamKind;
  url?: string;
  mimeType?: string;
}

export interface RpcClientInfo {
  name: string;
  version: string;
  platform?: string;
}

export interface InitializeParams {
  clientInfo: RpcClientInfo;
  token?: string;
  protocolVersion: string;
}

export interface InitializeResult {
  serverVersion: string;
  pid: number;
  home: string;
  transport: "uds" | "ws";
  authenticated: boolean;
  serverSeq: number;
  activeCoreCount: number;
  managedWorkspaces: string[];
  media: {
    basePath: "/media";
    ticket?: string;
    /** Unix epoch milliseconds when the capability ticket expires. */
    ticketExpiresAt?: number;
    liveStreamCapabilities: LiveStreamKind[];
  };
}

export interface DaemonStatusResult {
  pid: number;
  home: string;
  socketPath: string;
  wsUrl: string | null;
  authMode: "none" | "token";
  serverSeq: number;
  activeCores: string[];
  managedWorkspaces: string[];
  startedAt?: string;
}

export interface DaemonShutdownParams {
  stopCores?: boolean;
}

export interface DaemonShutdownResult {
  ok: true;
  stopped: string[];
}

export interface CoresStopAllResult {
  stopped: string[];
}

export interface MediaRefreshTicketParams {
  ttlMs?: number;
}

export interface MediaRefreshTicketResult {
  ticket: string;
  /** Unix epoch milliseconds when the ticket expires. */
  expiresAt: number;
}

export type MediaResolveParams =
  | {
      kind: "asset";
      project: string;
      run: string;
      id: string;
    }
  | {
      kind: "replay";
      project: string;
      run: string;
      epoch?: string;
      mode: "media" | "segment";
      record?: string;
      sequence?: number;
      media?: number | string;
      asset?: string;
      bytes?: number | string;
      id?: string;
    };

export type MediaResolveResult =
  | {
      file: string;
      size?: number;
      mediaType: string;
      cacheControl?: string;
    }
  | {
      /** Base64-encoded binary media payload when backed by an in-memory buffer. */
      bytes: string;
      mediaType: string;
      cacheControl?: string;
    };

export const LUDENS_EVENT_TOPICS = [
  "catalog",
  "workspace",
  "core",
  "run",
  "observation",
  "eventPool",
  "pet",
  "baseware",
] as const;

export type LudensEventTopic = (typeof LUDENS_EVENT_TOPICS)[number];

export interface LudensServerEvent<P = Record<string, unknown>> {
  seq: number;
  at: string;
  topic: LudensEventTopic;
  workspaceId?: string;
  runId?: string;
  payload?: P;
}

export interface EventsSubscribeParams {
  topics?: LudensEventTopic[];
  workspaceId?: string;
  runId?: string;
  sinceSeq?: number;
}

export interface EventsSubscribeResult {
  subscribedSeq: number;
  events: LudensServerEvent[];
  replayTruncated: boolean;
}

export interface EventsUnsubscribeParams {
  topics?: LudensEventTopic[];
  workspaceId?: string;
  runId?: string;
  all?: boolean;
}

export interface EventsUnsubscribeResult {
  ok: true;
  activeSubscriptions: number;
}

export interface RunPageParams {
  beforeCall?: number;
  call?: string;
  image?: string;
}

export interface ActivityRpcQuery {
  mode?: "changes" | "history" | "block";
  cursor?: string;
  before?: string;
  kind?: string;
  q?: string;
  limit?: number;
  id?: string;
}

export interface ReplayRpcQuery {
  mode: "overview" | "frames" | "events" | "search" | "detail" | "media" | "segment";
  epoch?: string;
  start?: number;
  end?: number;
  cursor?: string;
  id?: string;
  record?: string;
  sequence?: number;
  media?: number;
  asset?: string;
  bytes?: number;
  q?: string;
  track?: "action" | "model" | "tool" | "log" | "all";
}

export interface DiagnosticRpcQuery {
  afterPosition?: number;
  limit?: number;
  epoch?: string;
  fromAt?: string;
  toAt?: string;
  traceId?: string;
  spanId?: string;
  actionId?: string;
  observationId?: string;
}

export type RuntimeControlCommandDto =
  | { action: "status" }
  | {
      action: "auto_on";
      message?: string;
      seconds?: number | null;
      runId?: string;
      expectedEpoch?: string | null;
    }
  | {
      action: "auto_off";
      runId?: string;
      expectedEpoch?: string | null;
    }
  | {
      action: "auto_budget";
      seconds: number | null;
      runId?: string;
      expectedEpoch?: string | null;
    }
  | {
      action: "steer";
      message: string;
      runId?: string;
      expectedEpoch?: string | null;
    }
  | {
      action: "consolidate";
      seconds?: number;
      runId?: string;
      expectedEpoch?: string | null;
    }
  | {
      action: "set_model";
      model: string;
      serviceTier?: OmpServiceTier | null;
      effort?: OmpEffort | null;
      runId?: string;
      expectedEpoch?: string | null;
    }
  | { action: "perception_inject"; enabled: boolean }
  | { action: "perception_reload" };

export interface EventPoolFilterDto {
  direction?: EventDirection;
  status?: PoolEventStatus;
  limit?: number;
}

export type EventPoolMutateCommandDto =
  | { action: "send"; text: string; title?: string }
  | {
      action: "reply";
      replyTo: string;
      text: string;
      resumeAuto?: boolean;
      seconds?: number | null;
    }
  | { action: "ack"; ids: string[] };

export interface EventPoolReadResultDto {
  snapshot: EventPoolSnapshot;
  hostOnline: boolean;
  hostStatus?: Record<string, unknown>;
}

export interface EventPoolMutateResultDto {
  snapshot: EventPoolSnapshot;
  hostOnline: boolean;
  hostStatus?: Record<string, unknown>;
  createdEvent?: PoolEvent;
  resolvedOutbound?: PoolEvent;
  spawned?: boolean;
}

export interface CreateWorkspaceInputDto {
  name: string;
  workspace?: string;
  driver: string;
  driverPackage?: string;
  game?: string;
  cuaCommand?: string;
}

export type WorkspacesMutateParams =
  | { action: "open"; workspace: string }
  | { action: "create"; input: CreateWorkspaceInputDto }
  | { action: "remove"; id: string }
  | { action: "updateRoot"; workspaceRoot: string }
  | { action: "updateGlobalConnection"; connection: Partial<ModelConnectionConfig> }
  | { action: "updateGlobalDefaults"; defaults: Partial<WorkspaceDefaults> }
  | {
      action: "updateConnection";
      workspaceId: string;
      connection: Partial<ModelConnectionConfig>;
    }
  | {
      action: "updateStudioConfig";
      workspaceId: string;
      patch: Record<string, unknown>;
    }
  | {
      action: "updateShiori";
      workspaceId: string;
      input: Record<string, unknown>;
    };

export type ManagedServiceTarget = "emulator" | "baseware" | "core" | "host";

export interface WorkspacesServiceControlParams {
  workspaceId: string;
  action: "up" | "down" | "reload";
  services?: ManagedServiceTarget[];
  preempt?: boolean;
  keepEmulator?: boolean;
}

export type BasewareMutateParams =
  | {
      action: "upsertMachine";
      machine: BasewareMachineSpec | Record<string, unknown>;
      workspaceId?: string;
      bindMode?: string;
    }
  | { action: "removeMachine"; id: string }
  | {
      action: "registerDriver";
      spec: string | RegisteredDriverSpec;
      workspaceId?: string;
    }
  | {
      action: "unregisterDriver";
      id?: string;
      spec?: string;
      workspaceId?: string;
    }
  | {
      action: "probeMachine";
      machine?: BasewareMachineSpec | Record<string, unknown>;
      id?: string;
    }
  | {
      action: "controlWorkspaceMachine";
      workspaceId: string;
      operation: "setPrimary" | "toggleAllowed" | "mount" | "unmount" | "reconnect";
      machineId?: string;
    }
  | {
      action: "updateWorkspaceMachines";
      workspaceId: string;
      binding: WorkspaceMachinesBinding | Record<string, unknown>;
    };

export type DocLanguageDto = "en" | "zh";

export interface PetConsumerInputDto {
  instanceId: string;
  pid: number;
  revision: string | null;
  targetRevision?: string | null;
  workspace: string | null;
  runId: string | null;
  phase: "idle" | "switching" | "following" | "error";
  error: string | null;
  autoFollowing?: boolean;
}

/** Complete App-Server JSON-RPC 2.0 method registry shared across surfaces. */
export interface AppRpcMethods {
  initialize: {
    params: InitializeParams;
    result: InitializeResult;
  };
  "daemon/status": {
    params: Record<string, never> | undefined;
    result: DaemonStatusResult;
  };
  "daemon/shutdown": {
    params: DaemonShutdownParams | undefined;
    result: DaemonShutdownResult;
  };
  "cores/stopAll": {
    params: Record<string, never> | undefined;
    result: CoresStopAllResult;
  };
  "media/refreshTicket": {
    params: MediaRefreshTicketParams | undefined;
    result: MediaRefreshTicketResult;
  };
  "media/resolve": {
    params: MediaResolveParams;
    result: MediaResolveResult;
  };
  "events/subscribe": {
    params: EventsSubscribeParams | undefined;
    result: EventsSubscribeResult;
  };
  "events/unsubscribe": {
    params: EventsUnsubscribeParams | undefined;
    result: EventsUnsubscribeResult;
  };
  "catalog/get": {
    params: { includeEmpty?: boolean } | undefined;
    result: unknown[];
  };
  "run/get": {
    params: {
      project: string;
      run: string;
      epoch?: string;
      page?: RunPageParams;
    };
    result: Record<string, unknown>;
  };
  "run/stop": {
    params: { project: string; run: string; epoch?: string | null };
    result: Record<string, unknown>;
  };
  "run/timelineRecord": {
    params: {
      project: string;
      run: string;
      record: string;
      sequence: number;
      source: { call?: string; observation?: string };
    };
    result: Record<string, unknown>;
  };
  "activity/get": {
    params: {
      project: string;
      run?: string;
      epoch?: string;
      query?: ActivityRpcQuery;
    };
    result: ActivityResponse;
  };
  "replay/get": {
    params: {
      project: string;
      run: string;
      query: ReplayRpcQuery;
    };
    result: unknown;
  };
  "archive/build": {
    params: {
      project: string;
      run: string;
      action?: "cancel" | "retry";
      buildId?: string;
    };
    result: Record<string, unknown>;
  };
  "diagnostics/get": {
    params: Record<string, never> | undefined;
    result: Record<string, unknown>;
  };
  "diagnostics/events": {
    params: {
      project: string;
      run: string;
      query?: DiagnosticRpcQuery;
    };
    result: Record<string, unknown>;
  };
  "runtime/control": {
    params: {
      project: string;
      workspace: string;
      command: RuntimeControlCommandDto;
      preempt?: boolean;
    };
    result: Record<string, unknown>;
  };
  "eventPool/read": {
    params: {
      project: string;
      workspace: string;
      filter?: EventPoolFilterDto;
    };
    result: EventPoolReadResultDto;
  };
  "eventPool/mutate": {
    params: {
      project: string;
      workspace: string;
      command: EventPoolMutateCommandDto;
      spawnIfOffline?: boolean;
      preempt?: boolean;
    };
    result: EventPoolMutateResultDto;
  };
  "workspaces/getSettings": {
    params: Record<string, never> | undefined;
    result: Record<string, unknown>;
  };
  "workspaces/getStudio": {
    params: { workspaceId: string };
    result: Record<string, unknown>;
  };
  "workspaces/getConnection": {
    params: { workspaceId: string };
    result: Record<string, unknown>;
  };
  "workspaces/mutate": {
    params: WorkspacesMutateParams;
    result: unknown;
  };
  "workspaces/serviceControl": {
    params: WorkspacesServiceControlParams;
    result: Record<string, unknown>;
  };
  "baseware/overview": {
    params: { workspaceId?: string } | undefined;
    result: Record<string, unknown>;
  };
  "baseware/mutate": {
    params: BasewareMutateParams;
    result: unknown;
  };
  "drivers/discover": {
    params: { spec: string };
    result: Record<string, unknown>;
  };
  "capabilities/get": {
    params: { project: string; workspace: string };
    result: Record<string, unknown>;
  };
  "capabilities/runtime": {
    params: { project: string; workspace: string };
    result: Record<string, unknown>;
  };
  "capabilities/eval": {
    params: {
      project: string;
      workspace: string;
      options?: { capabilityId?: string; all?: boolean };
    };
    result: Record<string, unknown>;
  };
  "perception/getSettings": {
    params: { project: string; workspace: string };
    result: Record<string, unknown>;
  };
  "perception/updateSettings": {
    params: {
      project: string;
      workspace: string;
      patch: Record<string, unknown>;
    };
    result: Record<string, unknown>;
  };
  "perception/runtime": {
    params: { project: string; workspace: string };
    result: Record<string, unknown>;
  };
  "models/list": {
    params: { workspaceId?: string } | undefined;
    result: Record<string, unknown>;
  };
  "docs/groups": {
    params: { lang?: DocLanguageDto } | undefined;
    result: unknown[];
  };
  "docs/read": {
    params: { id: string; lang?: DocLanguageDto };
    result: Record<string, unknown>;
  };
  "pet/getState": {
    params: Record<string, never> | undefined;
    result: Record<string, unknown>;
  };
  "pet/setTarget": {
    params: { project: string | null; ifUnset?: boolean };
    result: Record<string, unknown>;
  };
  "pet/recordConsumer": {
    params: PetConsumerInputDto;
    result: Record<string, unknown>;
  };
}

export type AppRpcMethod = keyof AppRpcMethods;
export type AppRpcParams<M extends AppRpcMethod> = AppRpcMethods[M]["params"];
export type AppRpcResult<M extends AppRpcMethod> = AppRpcMethods[M]["result"];

export interface AppRpcNotifications {
  [APP_RPC_EVENT_NOTIFICATION]: LudensServerEvent;
}
