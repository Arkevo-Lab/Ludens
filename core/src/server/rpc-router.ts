import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { realpath } from "node:fs/promises";
import {
  APP_RPC_ERROR_CODES,
  APP_RPC_EVENT_NOTIFICATION,
  type AppRpcMethod,
  type BasewareMutateParams,
  type EventsSubscribeParams,
  type EventsUnsubscribeParams,
  type InitializeParams,
  type InitializeResult,
  type JsonRpcError,
  type JsonRpcId,
  type JsonRpcNotification,
  type JsonRpcSuccess,
  type LudensServerEvent,
  type MediaResolveParams,
  type MediaResolveResult,
  type WorkspacesMutateParams,
  type WorkspacesServiceControlParams,
} from "@ludens/protocol/app-rpc";
import {
  isOmpEffort,
  isOmpServiceTier,
  readWorkspaceIdentity,
} from "@ludens/protocol/ludens";
import type { DashboardMethod, DashboardMethods } from "../core/query/dashboard-protocol.ts";
import { workspaceForProject } from "../core/query/data.ts";
import type { DiagnosticQuery } from "../core/query/diagnostic-events.ts";
import type { DocLanguage } from "../core/query/docs.ts";
import type { EventPoolMutationCommand, EventPoolQueryFilter } from "../core/query/event-pool.ts";
import type { ReplayQuery } from "../core/query/replay.ts";
import type { RuntimeControlCommand } from "../core/query/runtime-control.ts";
import {
  controlWorkspaceService,
  type WorkspaceSupervisorLike,
} from "../core/query/workspaces.ts";
import type { EventHub } from "./event-hub.ts";
import { DEFAULT_MEDIA_TICKET_TTL_MS, mintMediaTicket } from "./media-ticket.ts";

export interface RpcWorkerClient {
  call<M extends DashboardMethod>(
    method: M,
    args: DashboardMethods[M]["args"],
    signal?: AbortSignal,
  ): Promise<DashboardMethods[M]["result"]>;
}

export interface RpcSupervisorHandle extends WorkspaceSupervisorLike {
  managedWorkspaceIds(): string[];
  activeCoreWorkspaceIds(): string[];
  stopAllManaged(): Promise<string[]>;
  shutdownAll(options?: { emergency?: boolean }): Promise<void>;
}

export interface RpcRouterContext {
  home: string;
  serverVersion: string;
  pid: number;
  authMode: "none" | "token";
  token?: string;
  mediaSecret: Buffer;
  eventHub: EventHub;
  worker: RpcWorkerClient;
  supervisor: RpcSupervisorHandle;
  getConnectionInfo: () => { socketPath: string; wsUrl: string | null; startedAt: string };
  scheduleShutdown: (options: { stopCores: boolean }) => void;
}

export class RpcError extends Error {
  readonly code: number;
  readonly data?: Record<string, unknown>;

  constructor(code: number, message: string, data?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export type RpcTransportKind = "uds" | "ws";

export interface RpcSessionOptions {
  transport: RpcTransportKind;
  sendMessage: (message: JsonRpcSuccess | JsonRpcError | JsonRpcNotification) => void;
}

function invalidParams(message: string, data?: Record<string, unknown>): RpcError {
  return new RpcError(APP_RPC_ERROR_CODES.INVALID_PARAMS, message, data);
}

function unauthorized(message = "Unauthorized"): RpcError {
  return new RpcError(APP_RPC_ERROR_CODES.UNAUTHORIZED, message);
}

function notFound(message: string, data?: Record<string, unknown>): RpcError {
  return new RpcError(APP_RPC_ERROR_CODES.NOT_FOUND, message, data);
}

function constantTimeTokenMatches(expected: string | undefined, provided: unknown): boolean {
  if (typeof expected !== "string" || expected.length === 0 || typeof provided !== "string") {
    return false;
  }
  const digestExpected = createHash("sha256").update(expected, "utf8").digest();
  const digestProvided = createHash("sha256").update(provided, "utf8").digest();
  return timingSafeEqual(digestExpected, digestProvided) && expected.length === provided.length;
}

function stripStaleControlScope<T extends object>(command: T): T {
  if (!("runId" in command) && !("expectedEpoch" in command)) return command;
  const { runId: _runId, expectedEpoch: _expectedEpoch, ...rest } = command as Record<string, unknown>;
  return rest as T;
}

function asObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidParams(message);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw invalidParams(`Missing or invalid string parameter: ${field}`);
  }
  return value.trim();
}

function toJsonRpcErrorObject(error: unknown): JsonRpcError["error"] {
  if (error instanceof RpcError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.data ? { data: error.data } : {}),
    };
  }
  const err = (error ?? {}) as Error & {
    status?: number;
    code?: string;
    conflict?: unknown;
    progress?: unknown;
  };
  const data: Record<string, unknown> = {};
  if (typeof err.code === "string" && err.code) data.code = err.code;
  if (err.conflict !== undefined) data.conflict = err.conflict;
  if (err.progress !== undefined) data.progress = err.progress;
  if (typeof err.status === "number") data.status = err.status;

  let code: number = APP_RPC_ERROR_CODES.SERVER_ERROR;
  if (
    err.code === "DEVICE_BUSY" ||
    err.code === "CORE_OFFLINE" ||
    err.code === "ARCHIVE_PREPARING" ||
    err.code === "WORKSPACE_SCOPE_CHANGED" ||
    err.conflict !== undefined ||
    err.status === 409 ||
    err.status === 202
  ) {
    code = APP_RPC_ERROR_CODES.CONFLICT;
  } else if (err.status === 401 || err.status === 403) {
    code = APP_RPC_ERROR_CODES.UNAUTHORIZED;
  } else if (err.status === 404 || err.status === 410) {
    code = APP_RPC_ERROR_CODES.NOT_FOUND;
  } else if (err.status === 400) {
    code = APP_RPC_ERROR_CODES.INVALID_PARAMS;
  }

  return {
    code,
    message: err.message || String(error),
    ...(Object.keys(data).length > 0 ? { data } : {}),
  };
}

async function spawnWorkspaceCore(
  ctx: RpcRouterContext,
  project: string,
  expectedWorkspace: string,
  preempt: boolean,
): Promise<void> {
  const registered = await workspaceForProject(project, ctx.home);
  const canonicalExpected = await realpath(expectedWorkspace).catch(() => expectedWorkspace);
  if (registered !== canonicalExpected) {
    throw Object.assign(new Error("工作区登记目录已变化，请刷新工作区列表后重试"), {
      code: "WORKSPACE_SCOPE_CHANGED",
      status: 409,
    });
  }
  await ctx.supervisor.up({
    workspace: registered,
    workspaceId: project,
    launchedBy: "app",
    preempt,
  });
  await ctx.worker.call("clearCatalogCache", []).catch(() => null);
}

/** Per-connection JSON-RPC 2.0 session handling handshake auth, event delivery, and cleanup. */
export class RpcSession {
  readonly id = randomUUID();
  readonly transport: RpcTransportKind;
  private authenticated: boolean;
  private initialized = false;
  private closed = false;
  private readonly router: RpcRouter;
  private readonly sendMessage: (message: JsonRpcSuccess | JsonRpcError | JsonRpcNotification) => void;
  private readonly inFlight = new Set<AbortController>();

  constructor(router: RpcRouter, options: RpcSessionOptions) {
    this.router = router;
    this.transport = options.transport;
    this.sendMessage = options.sendMessage;
    // UDS peers are pre-authenticated by OS socket permissions (0600); WS requires `initialize`.
    this.authenticated = options.transport === "uds";
  }

  get isAuthenticated(): boolean {
    return this.authenticated;
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  markAuthenticated(): void {
    this.authenticated = true;
    this.initialized = true;
  }

  emitEvent(event: LudensServerEvent): void {
    if (this.closed) return;
    this.sendMessage({
      jsonrpc: "2.0",
      method: APP_RPC_EVENT_NOTIFICATION,
      params: event,
    });
  }

  async handleRawText(rawText: string): Promise<void> {
    if (this.closed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      this.sendMessage({
        jsonrpc: "2.0",
        id: null,
        error: { code: APP_RPC_ERROR_CODES.INVALID_REQUEST, message: "Malformed JSON payload" },
      });
      return;
    }
    await this.handleMessage(parsed);
  }

  async handleMessage(message: unknown): Promise<void> {
    if (this.closed) return;
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      this.sendMessage({
        jsonrpc: "2.0",
        id: null,
        error: { code: APP_RPC_ERROR_CODES.INVALID_REQUEST, message: "Invalid JSON-RPC request object" },
      });
      return;
    }

    const req = message as Record<string, unknown>;
    const rawId = req.id;
    const hasId = rawId !== undefined;
    const validId =
      typeof rawId === "string" || (typeof rawId === "number" && Number.isFinite(rawId));
    const replyId: JsonRpcId | null = validId ? (rawId as JsonRpcId) : null;

    if (req.jsonrpc !== "2.0" || typeof req.method !== "string" || !req.method) {
      if (hasId) {
        this.sendMessage({
          jsonrpc: "2.0",
          id: replyId,
          error: { code: APP_RPC_ERROR_CODES.INVALID_REQUEST, message: "Invalid JSON-RPC 2.0 envelope" },
        });
      }
      return;
    }

    if (!hasId) {
      // Ignore client notifications without id.
      return;
    }

    if (!validId) {
      this.sendMessage({
        jsonrpc: "2.0",
        id: null,
        error: { code: APP_RPC_ERROR_CODES.INVALID_REQUEST, message: "Invalid JSON-RPC request id" },
      });
      return;
    }

    const controller = new AbortController();
    this.inFlight.add(controller);
    try {
      const result = await this.router.dispatch(
        req.method,
        req.params,
        this,
        controller.signal,
      );
      if (!this.closed) {
        this.sendMessage({
          jsonrpc: "2.0",
          id: rawId as JsonRpcId,
          result,
        });
      }
    } catch (error) {
      if (!this.closed) {
        this.sendMessage({
          jsonrpc: "2.0",
          id: rawId as JsonRpcId,
          error: toJsonRpcErrorObject(error),
        });
      }
    } finally {
      this.inFlight.delete(controller);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.inFlight) {
      controller.abort();
    }
    this.inFlight.clear();
    this.router.cleanupSession(this.id);
  }
}

/** Dispatches all App-Server JSON-RPC 2.0 methods over shared UDS and WebSocket sessions. */
export class RpcRouter {
  private readonly ctx: RpcRouterContext;

  constructor(ctx: RpcRouterContext) {
    this.ctx = ctx;
  }

  createSession(options: RpcSessionOptions): RpcSession {
    return new RpcSession(this, options);
  }

  cleanupSession(sessionId: string): void {
    this.ctx.eventHub.removeSubscriber(sessionId);
  }

  async dispatch(
    method: string,
    rawParams: unknown,
    session: RpcSession,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (method !== "initialize" && session.transport === "ws" && !session.isAuthenticated) {
      throw unauthorized("WebSocket session must authenticate via initialize first");
    }

    switch (method as AppRpcMethod) {
      case "initialize":
        return this.handleInitialize(rawParams, session);

      case "daemon/status": {
        const info = this.ctx.getConnectionInfo();
        const activeCores = this.ctx.supervisor.activeCoreWorkspaceIds();
        const managedWorkspaces = this.ctx.supervisor.managedWorkspaceIds();
        return {
          pid: this.ctx.pid,
          home: this.ctx.home,
          socketPath: info.socketPath,
          wsUrl: info.wsUrl,
          authMode: this.ctx.authMode,
          serverSeq: this.ctx.eventHub.currentSeq,
          activeCores,
          managedWorkspaces,
          startedAt: info.startedAt,
        };
      }

      case "daemon/shutdown": {
        const params = (rawParams && typeof rawParams === "object" ? rawParams : {}) as {
          stopCores?: unknown;
        };
        const stopCores = params.stopCores !== false;
        const stopped = stopCores ? await this.ctx.supervisor.stopAllManaged() : [];
        if (stopped.length > 0) {
          this.ctx.eventHub.publish({ topic: "core", payload: { action: "stopAll", stopped } });
        }
        this.ctx.scheduleShutdown({ stopCores });
        return { ok: true as const, stopped };
      }

      case "cores/stopAll": {
        const stopped = await this.ctx.supervisor.stopAllManaged();
        await this.ctx.worker.call("clearCatalogCache", []).catch(() => null);
        this.ctx.eventHub.publish({ topic: "core", payload: { action: "stopAll", stopped } });
        this.ctx.eventHub.publish({ topic: "catalog", payload: { reason: "coresStopAll" } });
        return { stopped };
      }

      case "media/refreshTicket": {
        const params = (rawParams && typeof rawParams === "object" ? rawParams : {}) as {
          ttlMs?: unknown;
        };
        const ttlMs =
          typeof params.ttlMs === "number" && Number.isFinite(params.ttlMs) && params.ttlMs > 0
            ? params.ttlMs
            : DEFAULT_MEDIA_TICKET_TTL_MS;
        return mintMediaTicket(this.ctx.mediaSecret, ttlMs);
      }

      case "media/resolve":
        return this.handleMediaResolve(rawParams, session, signal);

      case "events/subscribe": {
        const params = (rawParams && typeof rawParams === "object"
          ? rawParams
          : {}) as EventsSubscribeParams;
        return this.ctx.eventHub.subscribe(session.id, params, event => {
          session.emitEvent(event);
        });
      }

      case "events/unsubscribe": {
        const params = (rawParams && typeof rawParams === "object"
          ? rawParams
          : undefined) as EventsUnsubscribeParams | undefined;
        return this.ctx.eventHub.unsubscribe(session.id, params);
      }

      case "catalog/get": {
        const params = (rawParams && typeof rawParams === "object" ? rawParams : {}) as {
          includeEmpty?: unknown;
        };
        return this.ctx.worker.call("catalog", [Boolean(params.includeEmpty)], signal);
      }

      case "run/get": {
        const params = asObject(rawParams, "run/get requires { project, run }");
        const project = requireNonEmptyString(params.project, "project");
        const run = requireNonEmptyString(params.run, "run");
        const epoch = typeof params.epoch === "string" && params.epoch ? params.epoch : undefined;
        const page =
          params.page && typeof params.page === "object" && !Array.isArray(params.page)
            ? (params.page as DashboardMethods["run"]["args"][3])
            : undefined;
        return this.ctx.worker.call("run", [project, run, epoch, page], signal);
      }

      case "run/stop": {
        const params = asObject(rawParams, "run/stop requires { project, run }");
        const project = requireNonEmptyString(params.project, "project");
        const run = requireNonEmptyString(params.run, "run");
        const epoch = typeof params.epoch === "string" ? params.epoch : null;
        const result = await this.ctx.worker.call("stop", [project, run, epoch], signal);
        await this.ctx.worker.call("clearCatalogCache", []).catch(() => null);
        this.ctx.eventHub.publish({ topic: "core", workspaceId: project, runId: run, payload: { action: "stop" } });
        this.ctx.eventHub.publish({ topic: "run", workspaceId: project, runId: run, payload: { action: "stop" } });
        this.ctx.eventHub.publish({ topic: "catalog", workspaceId: project, runId: run });
        return result;
      }

      case "run/timelineRecord": {
        const params = asObject(rawParams, "run/timelineRecord requires { project, run, record, sequence, source }");
        const project = requireNonEmptyString(params.project, "project");
        const run = requireNonEmptyString(params.run, "run");
        const record = requireNonEmptyString(params.record, "record");
        const sequence = typeof params.sequence === "number" ? params.sequence : Number(params.sequence);
        if (!Number.isSafeInteger(sequence) || sequence < 1) {
          throw invalidParams("sequence must be a positive integer");
        }
        const source = asObject(params.source, "source must be an object") as {
          call?: string;
          observation?: string;
        };
        return this.ctx.worker.call("timelineRecord", [project, run, record, sequence, source], signal);
      }

      case "activity/get": {
        const params = asObject(rawParams, "activity/get requires { project }");
        const project = requireNonEmptyString(params.project, "project");
        const run = typeof params.run === "string" && params.run ? params.run : undefined;
        const epoch = typeof params.epoch === "string" && params.epoch ? params.epoch : undefined;
        const query =
          params.query && typeof params.query === "object" && !Array.isArray(params.query)
            ? (params.query as DashboardMethods["activity"]["args"][3])
            : undefined;
        return this.ctx.worker.call("activity", [project, run, epoch, query], signal);
      }

      case "replay/get": {
        const params = asObject(rawParams, "replay/get requires { project, run, query }");
        const project = requireNonEmptyString(params.project, "project");
        const run = requireNonEmptyString(params.run, "run");
        const query = asObject(params.query, "replay/get requires query object") as unknown as ReplayQuery;
        return this.ctx.worker.call("replay", [project, run, query], signal);
      }

      case "archive/build": {
        const params = asObject(rawParams, "archive/build requires { project, run }");
        const project = requireNonEmptyString(params.project, "project");
        const run = requireNonEmptyString(params.run, "run");
        const action =
          params.action === "cancel" || params.action === "retry" ? params.action : undefined;
        const buildId = typeof params.buildId === "string" ? params.buildId : undefined;
        return this.ctx.worker.call("archiveBuild", [project, run, action, buildId], signal);
      }

      case "diagnostics/get":
        return this.ctx.worker.call("diagnostics", [], signal);

      case "diagnostics/events": {
        const params = asObject(rawParams, "diagnostics/events requires { project, run }");
        const project = requireNonEmptyString(params.project, "project");
        const run = requireNonEmptyString(params.run, "run");
        const query =
          params.query && typeof params.query === "object" && !Array.isArray(params.query)
            ? (params.query as DiagnosticQuery)
            : undefined;
        return this.ctx.worker.call("diagnosticEvents", [project, run, query], signal);
      }

      case "runtime/control":
        return this.handleRuntimeControl(rawParams, signal);

      case "eventPool/read": {
        const params = asObject(rawParams, "eventPool/read requires { project, workspace }");
        const project = requireNonEmptyString(params.project, "project");
        const workspace = requireNonEmptyString(params.workspace, "workspace");
        const filter =
          params.filter && typeof params.filter === "object" && !Array.isArray(params.filter)
            ? (params.filter as EventPoolQueryFilter)
            : undefined;
        return this.ctx.worker.call("eventPoolRead", [project, workspace, filter], signal);
      }

      case "eventPool/mutate":
        return this.handleEventPoolMutate(rawParams, signal);

      case "workspaces/getSettings":
        return this.ctx.worker.call("workspaceSettings", [], signal);

      case "workspaces/getStudio": {
        const params = asObject(rawParams, "workspaces/getStudio requires { workspaceId }");
        const workspaceId = requireNonEmptyString(params.workspaceId, "workspaceId");
        return this.ctx.worker.call("workspaceStudio", [workspaceId], signal);
      }

      case "workspaces/getConnection": {
        const params = asObject(rawParams, "workspaces/getConnection requires { workspaceId }");
        const workspaceId = requireNonEmptyString(params.workspaceId, "workspaceId");
        return this.ctx.worker.call("workspaceConnection", [workspaceId], signal);
      }

      case "workspaces/mutate":
        return this.handleWorkspacesMutate(rawParams, signal);

      case "workspaces/serviceControl":
        return this.handleWorkspacesServiceControl(rawParams, signal);

      case "baseware/overview": {
        const params = (rawParams && typeof rawParams === "object" ? rawParams : {}) as {
          workspaceId?: unknown;
        };
        return this.ctx.worker.call(
          "basewareOverview",
          [typeof params.workspaceId === "string" && params.workspaceId ? params.workspaceId : undefined],
          signal,
        );
      }

      case "baseware/mutate":
        return this.handleBasewareMutate(rawParams, signal);

      case "drivers/discover": {
        const params = asObject(rawParams, "drivers/discover requires { spec }");
        const spec = requireNonEmptyString(params.spec, "spec");
        return this.ctx.worker.call("discoverDriver", [spec], signal);
      }

      case "capabilities/get": {
        const params = asObject(rawParams, "capabilities/get requires { project, workspace }");
        return this.ctx.worker.call(
          "capabilities",
          [requireNonEmptyString(params.project, "project"), requireNonEmptyString(params.workspace, "workspace")],
          signal,
        );
      }

      case "capabilities/runtime": {
        const params = asObject(rawParams, "capabilities/runtime requires { project, workspace }");
        return this.ctx.worker.call(
          "capabilityRuntime",
          [requireNonEmptyString(params.project, "project"), requireNonEmptyString(params.workspace, "workspace")],
          signal,
        );
      }

      case "capabilities/eval": {
        const params = asObject(rawParams, "capabilities/eval requires { project, workspace }");
        const project = requireNonEmptyString(params.project, "project");
        const workspace = requireNonEmptyString(params.workspace, "workspace");
        const options =
          params.options && typeof params.options === "object" && !Array.isArray(params.options)
            ? (params.options as { capabilityId?: string; all?: boolean })
            : undefined;
        return this.ctx.worker.call("runWorkspaceCapabilityEval", [project, workspace, options], signal);
      }

      case "perception/getSettings": {
        const params = asObject(rawParams, "perception/getSettings requires { project, workspace }");
        return this.ctx.worker.call(
          "perceptionSettings",
          [requireNonEmptyString(params.project, "project"), requireNonEmptyString(params.workspace, "workspace")],
          signal,
        );
      }

      case "perception/updateSettings": {
        const params = asObject(rawParams, "perception/updateSettings requires { project, workspace, patch }");
        const project = requireNonEmptyString(params.project, "project");
        const workspace = requireNonEmptyString(params.workspace, "workspace");
        const patch = asObject(params.patch, "patch must be an object");
        const res = await this.ctx.worker.call("updatePerceptionSettings", [project, patch, workspace], signal);
        this.ctx.eventHub.publish({ topic: "workspace", workspaceId: project, payload: { action: "perceptionUpdated" } });
        return res;
      }

      case "perception/runtime": {
        const params = asObject(rawParams, "perception/runtime requires { project, workspace }");
        return this.ctx.worker.call(
          "perceptionRuntime",
          [requireNonEmptyString(params.project, "project"), requireNonEmptyString(params.workspace, "workspace")],
          signal,
        );
      }

      case "models/list": {
        const params = (rawParams && typeof rawParams === "object" ? rawParams : {}) as {
          workspaceId?: unknown;
        };
        return this.ctx.worker.call(
          "availableModels",
          [typeof params.workspaceId === "string" && params.workspaceId ? params.workspaceId : undefined],
          signal,
        );
      }

      case "docs/groups": {
        const params = (rawParams && typeof rawParams === "object" ? rawParams : {}) as {
          lang?: unknown;
        };
        const lang: DocLanguage = params.lang === "zh" ? "zh" : "en";
        return this.ctx.worker.call("docGroups", [undefined, lang], signal);
      }

      case "docs/read": {
        const params = asObject(rawParams, "docs/read requires { id }");
        const id = requireNonEmptyString(params.id, "id");
        const lang: DocLanguage = params.lang === "zh" ? "zh" : "en";
        return this.ctx.worker.call("readDoc", [id, undefined, lang], signal);
      }

      case "pet/getState":
        return this.ctx.worker.call("petState", [], signal);

      case "pet/setTarget": {
        const params = asObject(rawParams, "pet/setTarget requires { project }");
        const project = params.project === null ? null : typeof params.project === "string" ? params.project : undefined;
        if (project === undefined) {
          throw invalidParams("project must be a string or null");
        }
        const res = await this.ctx.worker.call("petTarget", [project, Boolean(params.ifUnset)], signal);
        this.ctx.eventHub.publish({ topic: "pet", ...(project ? { workspaceId: project } : {}), payload: { action: "setTarget" } });
        return res;
      }

      case "pet/recordConsumer": {
        const params = asObject(rawParams, "pet/recordConsumer requires consumer payload");
        const res = await this.ctx.worker.call("petConsumer", [params], signal);
        this.ctx.eventHub.publish({ topic: "pet", payload: { action: "recordConsumer" } });
        return res;
      }

      default:
        throw new RpcError(
          APP_RPC_ERROR_CODES.METHOD_NOT_FOUND,
          `Method not found: ${method}`,
        );
    }
  }

  private handleInitialize(rawParams: unknown, session: RpcSession): InitializeResult {
    const params = asObject(rawParams, "initialize requires { clientInfo, protocolVersion }") as unknown as InitializeParams;
    if (!params.clientInfo || typeof params.clientInfo !== "object" || typeof params.clientInfo.name !== "string") {
      throw invalidParams("initialize requires clientInfo.name");
    }
    if (typeof params.protocolVersion !== "string" || !params.protocolVersion) {
      throw invalidParams("initialize requires protocolVersion");
    }

    if (session.transport === "ws" && this.ctx.authMode === "token") {
      if (!constantTimeTokenMatches(this.ctx.token, params.token)) {
        throw unauthorized("Invalid or missing authentication token");
      }
    }

    session.markAuthenticated();
    const { ticket, expiresAt } = mintMediaTicket(this.ctx.mediaSecret, DEFAULT_MEDIA_TICKET_TTL_MS);
    const activeCores = this.ctx.supervisor.activeCoreWorkspaceIds();
    const managedWorkspaces = this.ctx.supervisor.managedWorkspaceIds();

    return {
      serverVersion: this.ctx.serverVersion,
      pid: this.ctx.pid,
      home: this.ctx.home,
      transport: session.transport,
      authenticated: session.isAuthenticated,
      serverSeq: this.ctx.eventHub.currentSeq,
      activeCoreCount: activeCores.length,
      managedWorkspaces,
      media: {
        basePath: "/media",
        ticket,
        ticketExpiresAt: expiresAt,
        liveStreamCapabilities: ["none"],
      },
    };
  }

  private async handleMediaResolve(
    rawParams: unknown,
    session: RpcSession,
    signal: AbortSignal,
  ): Promise<MediaResolveResult> {
    if (session.transport !== "uds") {
      throw unauthorized("media/resolve is restricted to local UDS connections");
    }
    const params = asObject(rawParams, "media/resolve requires parameters") as unknown as MediaResolveParams;
    if (params.kind === "asset") {
      const project = requireNonEmptyString(params.project, "project");
      const run = requireNonEmptyString(params.run, "run");
      const id = requireNonEmptyString(params.id, "id");
      const res = await this.ctx.worker.call("media", [project, run, id], signal);
      if (res && typeof res === "object" && "file" in res && typeof (res as { file?: unknown }).file === "string") {
        const fm = res as { file: string; size?: number; mediaType: string; cacheControl?: string };
        return {
          file: fm.file,
          ...(fm.size !== undefined ? { size: fm.size } : {}),
          mediaType: fm.mediaType,
          ...(fm.cacheControl ? { cacheControl: fm.cacheControl } : {}),
        };
      }
      return {
        bytes: Buffer.from(res.bytes as Uint8Array).toString("base64"),
        mediaType: res.mediaType,
        ...(res.cacheControl ? { cacheControl: res.cacheControl } : {}),
      };
    }

    if (params.kind === "replay") {
      const project = requireNonEmptyString(params.project, "project");
      const run = requireNonEmptyString(params.run, "run");
      if (params.mode !== "media" && params.mode !== "segment") {
        throw invalidParams("replay media/resolve mode must be 'media' or 'segment'");
      }
      const query: ReplayQuery = {
        mode: params.mode,
        ...(typeof params.epoch === "string" && params.epoch ? { epoch: params.epoch } : {}),
        ...(typeof params.record === "string" && params.record ? { record: params.record } : {}),
        ...(typeof params.sequence === "number" ? { sequence: params.sequence } : {}),
        ...(params.media !== undefined && params.media !== "" ? { media: Number(params.media) } : {}),
        ...(typeof params.asset === "string" && params.asset ? { asset: params.asset } : {}),
        ...(params.bytes !== undefined && params.bytes !== "" ? { bytes: Number(params.bytes) } : {}),
        ...(typeof params.id === "string" && params.id ? { id: params.id } : {}),
      };
      const res = await this.ctx.worker.call("replay", [project, run, query], signal);
      if (res && typeof res === "object" && "file" in res && typeof (res as { file?: unknown }).file === "string") {
        const fm = res as { file: string; size?: number; mediaType: string; cacheControl?: string };
        return {
          file: fm.file,
          ...(fm.size !== undefined ? { size: fm.size } : {}),
          mediaType: fm.mediaType,
          ...(fm.cacheControl ? { cacheControl: fm.cacheControl } : {}),
        };
      }
      if (res && typeof res === "object" && "bytes" in res && (res as { bytes?: unknown }).bytes !== undefined) {
        const bm = res as { bytes: Uint8Array; mediaType?: string; cacheControl?: string };
        return {
          bytes: Buffer.from(bm.bytes).toString("base64"),
          mediaType: bm.mediaType ?? "application/octet-stream",
          ...(bm.cacheControl ? { cacheControl: bm.cacheControl } : {}),
        };
      }
      throw notFound("Replay media artifact not found");
    }

    throw invalidParams("media/resolve kind must be 'asset' or 'replay'");
  }

  private async handleRuntimeControl(rawParams: unknown, signal: AbortSignal): Promise<unknown> {
    const params = asObject(rawParams, "runtime/control requires { project, workspace, command }");
    const project = requireNonEmptyString(params.project, "project");
    const workspace = requireNonEmptyString(params.workspace, "workspace");
    const command = asObject(params.command, "command must be an object") as RuntimeControlCommand;
    const action = typeof command.action === "string" ? command.action : "";
    if (!action) throw invalidParams("command.action is required");

    if (command.action === "set_model") {
      const model = typeof command.model === "string" ? command.model.trim() : "";
      const slash = model.indexOf("/");
      if (!model || slash <= 0 || slash === model.length - 1) {
        throw invalidParams("set_model requires a valid provider/id model identifier");
      }
      if (command.serviceTier !== undefined && command.serviceTier !== null && !isOmpServiceTier(command.serviceTier)) {
        throw invalidParams("serviceTier must be priority, ultrafast, or null");
      }
      if (command.effort !== undefined && command.effort !== null && !isOmpEffort(command.effort)) {
        throw invalidParams("effort must be minimal, low, medium, high, xhigh, max, or null");
      }
    }

    const preempt = Boolean(params.preempt);
    try {
      const res = await this.ctx.worker.call("runtimeControl", [project, workspace, command], signal);
      if (command.action !== "status") {
        this.ctx.eventHub.publish({ topic: "core", workspaceId: project, payload: { action: command.action } });
        this.ctx.eventHub.publish({ topic: "catalog", workspaceId: project });
      }
      return res;
    } catch (error) {
      const canSpawnOnOffline = command.action !== "status" && command.action !== "auto_off";
      if ((error as { code?: string } | null)?.code !== "CORE_OFFLINE" || !canSpawnOnOffline) {
        throw error;
      }
      await spawnWorkspaceCore(this.ctx, project, workspace, preempt);
      const retried = await this.ctx.worker.call(
        "runtimeControl",
        [project, workspace, stripStaleControlScope(command)],
        signal,
      );
      this.ctx.eventHub.publish({
        topic: "core",
        workspaceId: project,
        payload: { action: command.action, spawned: true },
      });
      this.ctx.eventHub.publish({ topic: "catalog", workspaceId: project });
      return { ...retried, spawned: true };
    }
  }

  private async handleEventPoolMutate(rawParams: unknown, signal: AbortSignal): Promise<unknown> {
    const params = asObject(rawParams, "eventPool/mutate requires { project, workspace, command }");
    const project = requireNonEmptyString(params.project, "project");
    const workspace = requireNonEmptyString(params.workspace, "workspace");
    const command = asObject(params.command, "command must be an object") as EventPoolMutationCommand;
    const spawnIfOffline = Boolean(params.spawnIfOffline);
    const preempt = Boolean(params.preempt);

    try {
      const result = await this.ctx.worker.call("eventPoolMutate", [project, workspace, command], signal);
      if (spawnIfOffline && !(result as { hostOnline?: boolean }).hostOnline) {
        await spawnWorkspaceCore(this.ctx, project, workspace, preempt);
        const synced = await this.ctx.worker.call("eventPoolRead", [project, workspace], signal);
        this.ctx.eventHub.publish({ topic: "eventPool", workspaceId: project, payload: { action: command.action, spawned: true } });
        this.ctx.eventHub.publish({ topic: "core", workspaceId: project, payload: { spawned: true } });
        return { ...synced, spawned: true };
      }
      this.ctx.eventHub.publish({ topic: "eventPool", workspaceId: project, payload: { action: command.action } });
      return result;
    } catch (error) {
      if ((error as { code?: string } | null)?.code !== "CORE_OFFLINE") {
        throw error;
      }
      await spawnWorkspaceCore(this.ctx, project, workspace, preempt);
      const retried = await this.ctx.worker.call(
        "eventPoolMutate",
        [project, workspace, stripStaleControlScope(command)],
        signal,
      );
      this.ctx.eventHub.publish({ topic: "eventPool", workspaceId: project, payload: { action: command.action, spawned: true } });
      this.ctx.eventHub.publish({ topic: "core", workspaceId: project, payload: { spawned: true } });
      return { ...retried, spawned: true };
    }
  }

  private async handleWorkspacesMutate(rawParams: unknown, signal: AbortSignal): Promise<unknown> {
    const params = asObject(rawParams, "workspaces/mutate requires { action }") as WorkspacesMutateParams & Record<string, unknown>;
    const action = params.action;

    let result: unknown;
    let workspaceId: string | undefined;

    switch (action) {
      case "open": {
        const target = typeof params.workspace === "string"
          ? params.workspace
          : typeof params.path === "string"
            ? params.path
            : undefined;
        if (!target) throw invalidParams("open requires workspace path");
        result = await this.ctx.worker.call("openWorkspace", [target], signal);
        workspaceId = (result as { id?: string } | null)?.id;
        break;
      }
      case "create": {
        const input = params.input ?? params.workspace ?? params;
        result = await this.ctx.worker.call("createWorkspace", [input], signal);
        workspaceId = (result as { id?: string } | null)?.id;
        break;
      }
      case "remove": {
        const id = requireNonEmptyString(params.id, "id");
        result = await this.ctx.worker.call("removeWorkspace", [id], signal);
        workspaceId = id;
        break;
      }
      case "updateRoot": {
        const workspaceRoot = requireNonEmptyString(params.workspaceRoot, "workspaceRoot");
        result = await this.ctx.worker.call("updateWorkspaceRoot", [workspaceRoot], signal);
        break;
      }
      case "updateGlobalConnection": {
        result = await this.ctx.worker.call("updateGlobalConnection", [params.connection], signal);
        break;
      }
      case "updateGlobalDefaults": {
        result = await this.ctx.worker.call("updateGlobalDefaults", [params.defaults], signal);
        break;
      }
      case "updateConnection": {
        const id = requireNonEmptyString(params.workspaceId ?? params.id, "workspaceId");
        workspaceId = id;
        result = await this.ctx.worker.call("updateWorkspaceConnection", [id, params.connection], signal);
        break;
      }
      case "updateStudioConfig": {
        const id = requireNonEmptyString(params.workspaceId ?? params.id, "workspaceId");
        workspaceId = id;
        const patch = params.patch ?? params.config;
        result = await this.ctx.worker.call("updateWorkspaceStudioConfig", [id, patch], signal);
        break;
      }
      case "updateShiori": {
        const id = requireNonEmptyString(params.workspaceId ?? params.id, "workspaceId");
        workspaceId = id;
        const input = params.input ?? params.shiori;
        result = await this.ctx.worker.call("updateWorkspaceShiori", [id, input], signal);
        break;
      }
      default:
        throw invalidParams(`Unsupported workspaces/mutate action: ${String(action)}`);
    }

    this.ctx.eventHub.publish({ topic: "workspace", ...(workspaceId ? { workspaceId } : {}), payload: { action } });
    this.ctx.eventHub.publish({ topic: "catalog", ...(workspaceId ? { workspaceId } : {}), payload: { action } });
    void this.ctx.eventHub.sweepNow();
    return result;
  }

  private async handleWorkspacesServiceControl(
    rawParams: unknown,
    _signal: AbortSignal,
  ): Promise<unknown> {
    const params = asObject(rawParams, "workspaces/serviceControl requires parameters") as Partial<WorkspacesServiceControlParams> & Record<string, unknown>;
    let workspaceId =
      typeof params.workspaceId === "string" && params.workspaceId.trim()
        ? params.workspaceId.trim()
        : typeof params.id === "string" && params.id.trim()
          ? params.id.trim()
          : typeof params.project === "string" && params.project.trim()
            ? params.project.trim()
            : undefined;

    if (!workspaceId && typeof params.workspace === "string" && params.workspace.trim()) {
      const canonical = await realpath(params.workspace.trim()).catch(() => String(params.workspace).trim());
      const identity = await readWorkspaceIdentity(canonical);
      workspaceId = identity.id;
    }

    if (!workspaceId) {
      throw invalidParams("workspaces/serviceControl requires workspaceId or workspace path");
    }

    const action = params.action;
    if (action !== "up" && action !== "down" && action !== "reload") {
      throw invalidParams("workspaces/serviceControl action must be 'up', 'down', or 'reload'");
    }

    const rawServices = Array.isArray(params.services) ? params.services : undefined;
    const services = rawServices
      ? rawServices
          .map(s => (s === "core" ? "host" : s))
          .filter((s): s is "emulator" | "baseware" | "host" =>
            s === "emulator" || s === "baseware" || s === "host")
      : undefined;

    const serviceInput = {
      operation: action,
      ...(services && services.length > 0 ? { services } : {}),
      preempt: Boolean(params.preempt),
      ...(params.keepEmulator !== undefined ? { keepEmulator: Boolean(params.keepEmulator) } : {}),
    };

    const result = await controlWorkspaceService(
      workspaceId,
      serviceInput,
      this.ctx.home,
      this.ctx.supervisor,
    );
    await this.ctx.worker.call("clearCatalogCache", []).catch(() => null);
    this.ctx.eventHub.publish({ topic: "core", workspaceId, payload: { action, ok: result.ok } });
    this.ctx.eventHub.publish({ topic: "workspace", workspaceId, payload: { action, ok: result.ok } });
    this.ctx.eventHub.publish({ topic: "baseware", workspaceId, payload: { action } });
    this.ctx.eventHub.publish({ topic: "catalog", workspaceId, payload: { action } });
    return result;
  }

  private async handleBasewareMutate(rawParams: unknown, signal: AbortSignal): Promise<unknown> {
    const params = asObject(rawParams, "baseware/mutate requires { action }") as BasewareMutateParams & Record<string, unknown>;
    const action = params.action;
    let result: unknown;
    let workspaceId = typeof params.workspaceId === "string" ? params.workspaceId : undefined;

    switch (action) {
      case "upsertMachine":
        result = await this.ctx.worker.call(
          "upsertBasewareMachine",
          [params.machine, { workspaceId: params.workspaceId, bindMode: params.bindMode }],
          signal,
        );
        break;
      case "removeMachine":
        result = await this.ctx.worker.call("removeBasewareMachine", [params.id], signal);
        break;
      case "registerDriver":
        result = await this.ctx.worker.call(
          "registerBasewareDriver",
          [{ spec: params.spec, workspaceId: params.workspaceId }],
          signal,
        );
        break;
      case "unregisterDriver":
        result = await this.ctx.worker.call(
          "removeBasewareDriver",
          [{ id: params.id, spec: params.spec, workspaceId: params.workspaceId }],
          signal,
        );
        break;
      case "probeMachine":
        result = await this.ctx.worker.call(
          "probeBasewareMachine",
          [params.machine ?? { id: params.id }],
          signal,
        );
        break;
      case "controlWorkspaceMachine": {
        const wsId = requireNonEmptyString(params.workspaceId ?? params.id, "workspaceId");
        workspaceId = wsId;
        result = await this.ctx.worker.call(
          "controlWorkspaceMachine",
          [wsId, { operation: params.operation, machineId: params.machineId }],
          signal,
        );
        break;
      }
      case "updateWorkspaceMachines": {
        const wsId = requireNonEmptyString(params.workspaceId ?? params.id, "workspaceId");
        workspaceId = wsId;
        result = await this.ctx.worker.call(
          "updateWorkspaceMachines",
          [wsId, params.binding],
          signal,
        );
        break;
      }
      default:
        throw invalidParams(`Unsupported baseware/mutate action: ${String(action)}`);
    }

    this.ctx.eventHub.publish({ topic: "baseware", ...(workspaceId ? { workspaceId } : {}), payload: { action } });
    if (workspaceId) {
      this.ctx.eventHub.publish({ topic: "workspace", workspaceId, payload: { action } });
    }
    return result;
  }
}
