import {
  APP_RPC_ERROR_CODES,
  APP_RPC_EVENT_NOTIFICATION,
  APP_RPC_PROTOCOL_VERSION,
  JSON_RPC_VERSION,
  LUDENS_EVENT_TOPICS,
  type AppRpcMethod,
  type AppRpcParams,
  type AppRpcResult,
  type EventsSubscribeResult,
  type InitializeResult,
  type JsonRpcErrorData,
  type JsonRpcMessage,
  type LudensEventTopic,
  type LudensServerEvent,
} from "@ludens/protocol/app-rpc";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  clearStoredConnectionTarget,
  resolveConnectionEndpoints,
  resolveInitialConnectionTarget,
  saveConnectionTarget,
  type ConnectionEnv,
  type ConnectionTarget,
  type ResolvedConnectionEndpoints,
} from "./connection-target";
import type { DesktopRpcBridge, DesktopRpcStatus } from "./desktop";
import { createMediaResolver, resolveMediaUrl, type MediaRef, type MediaResolver } from "./media-resolver";

export type RpcConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "auth-required"
  | "unconfigured"
  | "disconnected";

export interface RpcCallOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface RpcWebSocketLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { readonly code?: number; readonly reason?: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface LudensRpcCaller {
  call<M extends AppRpcMethod>(
    method: M,
    params: AppRpcParams<M>,
    options?: RpcCallOptions,
  ): Promise<AppRpcResult<M>>;
}

export interface LudensRpcSnapshot {
  readonly status: RpcConnectionStatus;
  readonly error?: string;
  readonly needsAuth: boolean;
  readonly isReady: boolean;
  readonly target: ConnectionTarget;
  readonly resolved: ResolvedConnectionEndpoints;
  readonly serverInfo?: InitializeResult;
  readonly serverSeq: number | null;
  readonly mediaTicket?: string;
  readonly mediaTicketExpiresAt?: number;
  readonly reconnectGeneration: number;
}

export type LudensEventListener = (event: LudensServerEvent) => void;
export type LudensSnapshotListener = (snapshot: LudensRpcSnapshot) => void;

export interface LudensRpcClientOptions {
  readonly target: ConnectionTarget;
  readonly env?: ConnectionEnv;
  readonly createWebSocket?: (url: string) => RpcWebSocketLike;
  readonly desktopBridge?: DesktopRpcBridge;
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly autoConnect?: boolean;
  readonly defaultTimeoutMs?: number;
  readonly now?: () => number;
}

interface PendingRpcRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly timerId: ReturnType<typeof setTimeout> | null;
  readonly abortCleanup?: () => void;
}

const DEFAULT_RPC_TIMEOUT_MS = 60_000;
const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 10_000] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mapRpcCodeToHttpStatus(rpcCode: number): number {
  switch (rpcCode) {
    case APP_RPC_ERROR_CODES.UNAUTHORIZED:
      return 401;
    case APP_RPC_ERROR_CODES.NOT_FOUND:
      return 404;
    case APP_RPC_ERROR_CODES.CONFLICT:
      return 409;
    case APP_RPC_ERROR_CODES.INVALID_REQUEST:
    case APP_RPC_ERROR_CODES.INVALID_PARAMS:
      return 400;
    default:
      return 500;
  }
}

export class LudensRpcError extends Error {
  readonly rpcCode: number;
  readonly code?: string;
  readonly status: number;
  readonly data?: JsonRpcErrorData;
  readonly conflict?: Record<string, unknown>;
  readonly progress?: Record<string, unknown>;

  constructor(rpcCode: number, message: string, data?: JsonRpcErrorData) {
    super(message);
    this.name = "LudensRpcError";
    this.rpcCode = rpcCode;
    this.data = data;
    this.code =
      typeof data?.code === "string"
        ? data.code
        : rpcCode === APP_RPC_ERROR_CODES.UNAUTHORIZED
          ? "UNAUTHORIZED"
          : undefined;
    this.status =
      typeof data?.status === "number" ? data.status : mapRpcCodeToHttpStatus(rpcCode);
    this.conflict = isRecord(data?.conflict) ? data.conflict : undefined;
    this.progress = isRecord(data?.progress) ? data.progress : undefined;
  }
}

export function isLudensRpcError(value: unknown): value is LudensRpcError {
  return value instanceof LudensRpcError;
}

function defaultCreateWebSocket(url: string): RpcWebSocketLike {
  if (typeof WebSocket === "undefined") {
    throw new Error("WebSocket is not available in this runtime");
  }
  return new WebSocket(url) as unknown as RpcWebSocketLike;
}

function computeTicketRefreshDelayMs(expiresAt: number, nowMs: number): number {
  const remaining = expiresAt - nowMs;
  if (!Number.isFinite(remaining) || remaining <= 0) {
    return 1_000;
  }
  const leadMs = Math.min(60_000, Math.floor(remaining * 0.4));
  return Math.max(1_000, remaining - leadMs);
}

/**
 * Browser-pure JSON-RPC 2.0 client managing dual transport (Desktop IPC / WebSocket),
 * `initialize` handshake, `events/subscribe` `sinceSeq` catch-up, and media ticket refresh.
 */
export class LudensRpcClient implements LudensRpcCaller {
  private target: ConnectionTarget;
  private readonly env?: ConnectionEnv;
  private readonly createWebSocket: (url: string) => RpcWebSocketLike;
  private readonly desktopBridgeOverride?: DesktopRpcBridge;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly defaultTimeoutMs: number;
  private readonly now: () => number;

  private status: RpcConnectionStatus = "disconnected";
  private errorMessage: string | undefined;
  private serverInfo: InitializeResult | undefined;
  private lastSeenSeq: number | null = null;
  private mediaTicket: string | undefined;
  private mediaTicketExpiresAt: number | undefined;
  private reconnectGeneration = 0;
  private hadConnectedOnce = false;
  private retryAttempt = 0;
  private nextRequestId = 1;
  private connectionGeneration = 0;
  private disposed = false;

  private socket: RpcWebSocketLike | null = null;
  private ipcUnsubscribeMessage: (() => void) | null = null;
  private ipcUnsubscribeStatus: (() => void) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private ticketRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly pending = new Map<number, PendingRpcRequest>();
  private readonly readyWaiters = new Set<{
    readonly resolve: () => void;
    readonly reject: (err: Error) => void;
    readonly cleanup?: () => void;
  }>();
  private readonly eventListeners = new Map<LudensEventTopic | "*", Set<LudensEventListener>>();
  private readonly snapshotListeners = new Set<LudensSnapshotListener>();

  constructor(options: LudensRpcClientOptions) {
    this.target = options.target;
    this.env = options.env;
    this.createWebSocket = options.createWebSocket ?? defaultCreateWebSocket;
    this.desktopBridgeOverride = options.desktopBridge;
    this.clientName = options.clientName ?? "ludens-app";
    this.clientVersion = options.clientVersion ?? "0.1.0";
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());

    if (options.autoConnect !== false) {
      this.connect();
    }
  }

  getSnapshot(): LudensRpcSnapshot {
    const resolved = resolveConnectionEndpoints(this.target, this.env);
    return {
      status: this.status,
      error: this.errorMessage,
      needsAuth: this.status === "auth-required",
      isReady: this.status === "connected",
      target: this.target,
      resolved,
      serverInfo: this.serverInfo,
      serverSeq: this.lastSeenSeq,
      mediaTicket: this.mediaTicket,
      mediaTicketExpiresAt: this.mediaTicketExpiresAt,
      reconnectGeneration: this.reconnectGeneration,
    };
  }

  subscribeSnapshot(listener: LudensSnapshotListener): () => void {
    this.snapshotListeners.add(listener);
    return () => {
      this.snapshotListeners.delete(listener);
    };
  }

  subscribeEvent(
    topics: LudensEventTopic | "*" | readonly LudensEventTopic[],
    listener: LudensEventListener,
  ): () => void {
    const topicList: readonly (LudensEventTopic | "*")[] = Array.isArray(topics)
      ? topics
      : [topics];
    for (const topic of topicList) {
      let set = this.eventListeners.get(topic);
      if (!set) {
        set = new Set();
        this.eventListeners.set(topic, set);
      }
      set.add(listener);
    }
    return () => {
      for (const topic of topicList) {
        const set = this.eventListeners.get(topic);
        if (!set) continue;
        set.delete(listener);
        if (set.size === 0) {
          this.eventListeners.delete(topic);
        }
      }
    };
  }

  setTarget(nextTarget: ConnectionTarget): void {
    if (this.disposed) return;
    const prevKey = JSON.stringify(this.target);
    const nextKey = JSON.stringify(nextTarget);
    this.target = nextTarget;
    if (prevKey !== nextKey) {
      this.lastSeenSeq = null;
      this.hadConnectedOnce = false;
      this.serverInfo = undefined;
      this.mediaTicket = undefined;
      this.mediaTicketExpiresAt = undefined;
    }
    this.retryAttempt = 0;
    this.reconnect();
  }

  reconnect(): void {
    if (this.disposed) return;
    this.clearReconnectTimer();
    this.teardownTransport("Reconnecting RPC transport");
    this.retryAttempt = 0;
    this.connect();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearReconnectTimer();
    this.clearTicketRefreshTimer();
    this.teardownTransport("RPC client disposed");
    this.rejectReadyWaiters(new Error("RPC client disposed"));
    this.status = "disconnected";
    this.emitSnapshot();
  }

  async call<M extends AppRpcMethod>(
    method: M,
    params: AppRpcParams<M>,
    options?: RpcCallOptions,
  ): Promise<AppRpcResult<M>> {
    if (this.disposed) {
      throw new LudensRpcError(APP_RPC_ERROR_CODES.SERVER_ERROR, "RPC client disposed");
    }

    if (options?.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new DOMException("Aborted", "AbortError");
    }

    if (method !== "initialize" && method !== "events/subscribe" && this.status !== "connected") {
      await this.waitUntilReady(options?.signal, options?.timeoutMs ?? this.defaultTimeoutMs);
    }

    return this.sendRpcRequest(method, params, options) as Promise<AppRpcResult<M>>;
  }

  private connect(): void {
    if (this.disposed) return;
    const generation = ++this.connectionGeneration;
    const resolved = resolveConnectionEndpoints(this.target, this.env);

    if (!resolved.ok) {
      this.status = resolved.error === "unconfigured" ? "unconfigured" : "disconnected";
      this.errorMessage =
        resolved.error === "unconfigured"
          ? undefined
          : `Invalid connection target (${resolved.error})`;
      this.emitSnapshot();
      this.rejectReadyWaiters(
        new LudensRpcError(
          APP_RPC_ERROR_CODES.INVALID_PARAMS,
          this.errorMessage ?? "Connection target is not configured",
        ),
      );
      return;
    }

    this.errorMessage = undefined;
    this.status = this.hadConnectedOnce ? "reconnecting" : "connecting";
    this.emitSnapshot();

    if (resolved.transport === "ipc") {
      this.openDesktopIpcTransport(generation);
      return;
    }

    if (!resolved.wsUrl) {
      this.status = "unconfigured";
      this.emitSnapshot();
      return;
    }

    this.openWebSocketTransport(generation, resolved.wsUrl, resolved.token);
  }

  private openDesktopIpcTransport(generation: number): void {
    const bridge =
      this.desktopBridgeOverride ?? (typeof window !== "undefined" ? window.ludens?.rpc : undefined);
    if (!bridge) {
      this.status = "disconnected";
      this.errorMessage = "Desktop RPC bridge unavailable";
      this.emitSnapshot();
      this.rejectReadyWaiters(
        new LudensRpcError(APP_RPC_ERROR_CODES.SERVER_ERROR, this.errorMessage),
      );
      return;
    }

    this.ipcUnsubscribeMessage = bridge.onMessage((frameJson) => {
      if (this.disposed || generation !== this.connectionGeneration) return;
      this.handleIncomingPayload(frameJson);
    });

    let initialStatus: DesktopRpcStatus["state"] | undefined;
    let handshakeStarted = false;
    if (bridge.onStatus) {
      this.ipcUnsubscribeStatus = bridge.onStatus((ipcStatus) => {
        if (this.disposed || generation !== this.connectionGeneration) return;
        initialStatus = ipcStatus.state;
        if (ipcStatus.state === "connected") {
          if (handshakeStarted && this.status === "connected") return;
          handshakeStarted = true;
          void this.performHandshake(generation, "electron", undefined);
        } else if (ipcStatus.state === "disconnected") {
          handshakeStarted = false;
          this.clearTicketRefreshTimer();
          this.rejectPendingRequests("Desktop RPC bridge disconnected");
          this.status = this.hadConnectedOnce ? "reconnecting" : "disconnected";
          this.errorMessage = ipcStatus.error;
          this.emitSnapshot();
        } else {
          this.status = this.hadConnectedOnce ? "reconnecting" : "connecting";
          this.errorMessage = ipcStatus.error;
          this.emitSnapshot();
        }
      });
    }

    // If bridge did not synchronously report connecting/disconnected/connected, start initialize immediately.
    if (!handshakeStarted && initialStatus !== "connecting" && initialStatus !== "disconnected") {
      handshakeStarted = true;
      void this.performHandshake(generation, "electron", undefined);
    } else if (bridge.reconnect && initialStatus === "disconnected") {
      void bridge.reconnect().catch(() => {
        // IPC bridge manages reconnect attempts or emits updated status.
      });
    }
  }

  private openWebSocketTransport(generation: number, wsUrl: string, token?: string): void {
    let ws: RpcWebSocketLike;
    try {
      ws = this.createWebSocket(wsUrl);
    } catch (error) {
      this.handleTransportFailure(
        generation,
        error instanceof Error ? error.message : String(error),
      );
      return;
    }

    this.socket = ws;

    ws.onopen = () => {
      if (this.disposed || generation !== this.connectionGeneration) return;
      void this.performHandshake(generation, "web", token);
    };

    ws.onmessage = (event) => {
      if (this.disposed || generation !== this.connectionGeneration) return;
      if (typeof event.data === "string") {
        this.handleIncomingPayload(event.data);
      }
    };

    ws.onerror = () => {
      if (this.disposed || generation !== this.connectionGeneration) return;
      // Close handler performs state transition and reconnect scheduling.
      if (!this.errorMessage) {
        this.errorMessage = "WebSocket connection failed";
      }
    };

    ws.onclose = (event) => {
      if (this.disposed || generation !== this.connectionGeneration) return;
      const reason =
        event?.reason ||
        (typeof event?.code === "number" && event.code !== 1000
          ? `WebSocket closed (${event.code})`
          : "WebSocket connection closed");
      this.socket = null;
      this.clearTicketRefreshTimer();
      this.rejectPendingRequests(reason);

      if (this.status === "auth-required") {
        this.emitSnapshot();
        return;
      }

      this.handleTransportFailure(generation, reason);
    };
  }

  private async performHandshake(
    generation: number,
    platform: "web" | "electron",
    token: string | undefined,
  ): Promise<void> {
    if (this.disposed || generation !== this.connectionGeneration) return;

    try {
      const initResult = (await this.sendRpcRequest(
        "initialize",
        {
          clientInfo: {
            name: this.clientName,
            version: this.clientVersion,
            platform,
          },
          protocolVersion: APP_RPC_PROTOCOL_VERSION,
          ...(token ? { token } : {}),
        },
        { timeoutMs: 15_000 },
      )) as InitializeResult;

      if (this.disposed || generation !== this.connectionGeneration) return;

      if (initResult.transport === "ws" && !initResult.authenticated) {
        throw new LudensRpcError(
          APP_RPC_ERROR_CODES.UNAUTHORIZED,
          "Authentication required",
          { code: "UNAUTHORIZED", status: 401 },
        );
      }

      const previousSeq = this.lastSeenSeq;
      const subResult = (await this.sendRpcRequest(
        "events/subscribe",
        {
          topics: [...LUDENS_EVENT_TOPICS],
          ...(previousSeq !== null ? { sinceSeq: previousSeq } : {}),
        },
        { timeoutMs: 15_000 },
      )) as EventsSubscribeResult;

      if (this.disposed || generation !== this.connectionGeneration) return;

      const wasReconnect = this.hadConnectedOnce;
      this.hadConnectedOnce = true;
      this.retryAttempt = 0;
      this.serverInfo = initResult;
      this.mediaTicket = initResult.media.ticket;
      this.mediaTicketExpiresAt = initResult.media.ticketExpiresAt;
      this.errorMessage = undefined;

      this.advanceSeq(initResult.serverSeq);
      this.advanceSeq(subResult.subscribedSeq);

      const orderedReplay = [...(subResult.events ?? [])].sort((a, b) => a.seq - b.seq);
      for (const evt of orderedReplay) {
        if (previousSeq !== null && evt.seq <= previousSeq) continue;
        this.advanceSeq(evt.seq);
        this.dispatchEvent(evt);
      }

      if (wasReconnect || subResult.replayTruncated) {
        this.reconnectGeneration += 1;
      }

      this.status = "connected";
      this.scheduleMediaTicketRefresh(generation);
      this.emitSnapshot();
      this.resolveReadyWaiters();
    } catch (error) {
      if (this.disposed || generation !== this.connectionGeneration) return;

      const isUnauthorized =
        (isLudensRpcError(error) &&
          (error.rpcCode === APP_RPC_ERROR_CODES.UNAUTHORIZED ||
            error.code === "UNAUTHORIZED" ||
            error.status === 401));

      if (isUnauthorized) {
        this.clearReconnectTimer();
        this.clearTicketRefreshTimer();
        this.status = "auth-required";
        this.errorMessage = error instanceof Error ? error.message : "Authentication required";
        this.teardownTransport(this.errorMessage);
        this.emitSnapshot();
        this.rejectReadyWaiters(error instanceof Error ? error : new Error(this.errorMessage));
        return;
      }

      const message = error instanceof Error ? error.message : "RPC handshake failed";
      this.teardownTransport(message);
      this.handleTransportFailure(generation, message);
    }
  }

  private scheduleMediaTicketRefresh(generation: number): void {
    this.clearTicketRefreshTimer();
    const expiresAt = this.mediaTicketExpiresAt;
    if (!expiresAt || this.target.kind === "electron-local") {
      return;
    }

    const delayMs = computeTicketRefreshDelayMs(expiresAt, this.now());
    this.ticketRefreshTimer = setTimeout(() => {
      if (this.disposed || generation !== this.connectionGeneration || this.status !== "connected") {
        return;
      }
      void this.refreshMediaTicket(generation);
    }, delayMs);
  }

  private async refreshMediaTicket(generation: number): Promise<void> {
    try {
      const refreshed = await this.call("media/refreshTicket", undefined, { timeoutMs: 10_000 });
      if (this.disposed || generation !== this.connectionGeneration) return;
      this.mediaTicket = refreshed.ticket;
      this.mediaTicketExpiresAt = refreshed.expiresAt;
      this.scheduleMediaTicketRefresh(generation);
      this.emitSnapshot();
    } catch {
      if (this.disposed || generation !== this.connectionGeneration || this.status !== "connected") {
        return;
      }
      // Retry renewal soon without tearing down active RPC session.
      this.clearTicketRefreshTimer();
      this.ticketRefreshTimer = setTimeout(() => {
        if (this.disposed || generation !== this.connectionGeneration || this.status !== "connected") {
          return;
        }
        void this.refreshMediaTicket(generation);
      }, 15_000);
    }
  }

  private handleTransportFailure(generation: number, message: string): void {
    if (this.disposed || generation !== this.connectionGeneration) return;
    if (this.status === "auth-required" || this.status === "unconfigured") {
      return;
    }

    const delay =
      RECONNECT_DELAYS_MS[Math.min(this.retryAttempt, RECONNECT_DELAYS_MS.length - 1)] ?? 10_000;
    this.retryAttempt += 1;
    this.status = this.hadConnectedOnce ? "reconnecting" : "disconnected";
    this.errorMessage = message;
    this.emitSnapshot();
    this.rejectReadyWaiters(new LudensRpcError(APP_RPC_ERROR_CODES.SERVER_ERROR, message));

    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      if (this.disposed || generation !== this.connectionGeneration) return;
      this.connect();
    }, delay);
  }

  private sendRpcRequest(
    method: AppRpcMethod,
    params: unknown,
    options?: RpcCallOptions,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextRequestId++;
      const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
      let settled = false;

      const finish = (cb: () => void) => {
        if (settled) return;
        settled = true;
        cb();
      };

      const signal = options?.signal;
      let abortCleanup: (() => void) | undefined;
      if (signal) {
        const onAbort = () => {
          const entry = this.pending.get(id);
          if (entry) {
            this.pending.delete(id);
            if (entry.timerId) clearTimeout(entry.timerId);
          }
          finish(() =>
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new DOMException("Aborted", "AbortError"),
            ),
          );
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        abortCleanup = () => signal.removeEventListener("abort", onAbort);
      }

      const timerId = setTimeout(() => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        entry.abortCleanup?.();
        finish(() =>
          reject(
            new LudensRpcError(
              APP_RPC_ERROR_CODES.SERVER_ERROR,
              `RPC timeout waiting for ${method}`,
            ),
          ),
        );
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => finish(() => resolve(value)),
        reject: (err) => finish(() => reject(err)),
        timerId,
        abortCleanup,
      });

      const payload = JSON.stringify({
        jsonrpc: JSON_RPC_VERSION,
        id,
        method,
        ...(params !== undefined ? { params } : {}),
      });

      try {
        if (this.target.kind === "electron-local") {
          const bridge =
            this.desktopBridgeOverride ??
            (typeof window !== "undefined" ? window.ludens?.rpc : undefined);
          if (!bridge) {
            throw new LudensRpcError(
              APP_RPC_ERROR_CODES.SERVER_ERROR,
              "Desktop RPC bridge unavailable",
            );
          }
          bridge.send(payload);
          return;
        }

        if (!this.socket || this.socket.readyState !== 1) {
          throw new LudensRpcError(
            APP_RPC_ERROR_CODES.SERVER_ERROR,
            "RPC WebSocket is not open",
          );
        }
        this.socket.send(payload);
      } catch (err) {
        const entry = this.pending.get(id);
        if (entry) {
          this.pending.delete(id);
          if (entry.timerId) clearTimeout(entry.timerId);
          entry.abortCleanup?.();
        }
        finish(() =>
          reject(
            err instanceof Error
              ? err
              : new LudensRpcError(APP_RPC_ERROR_CODES.SERVER_ERROR, String(err)),
          ),
        );
      }
    });
  }

  private waitUntilReady(signal: AbortSignal | undefined, timeoutMs: number): Promise<void> {
    if (this.status === "connected") {
      return Promise.resolve();
    }
    if (this.status === "auth-required" || this.status === "unconfigured") {
      return Promise.reject(
        new LudensRpcError(
          this.status === "auth-required"
            ? APP_RPC_ERROR_CODES.UNAUTHORIZED
            : APP_RPC_ERROR_CODES.INVALID_PARAMS,
          this.errorMessage ??
            (this.status === "auth-required"
              ? "Authentication required"
              : "Connection target is not configured"),
        ),
      );
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.readyWaiters.delete(waiter);
        waiter.cleanup?.();
        reject(new LudensRpcError(APP_RPC_ERROR_CODES.SERVER_ERROR, "Timed out waiting for RPC connection"));
      }, timeoutMs);

      const onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.readyWaiters.delete(waiter);
        reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new DOMException("Aborted", "AbortError"),
        );
      };

      const waiter = {
        resolve: () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (signal) signal.removeEventListener("abort", onAbort);
          resolve();
        },
        reject: (err: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (signal) signal.removeEventListener("abort", onAbort);
          reject(err);
        },
        cleanup: () => {
          clearTimeout(timer);
          if (signal) signal.removeEventListener("abort", onAbort);
        },
      };

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      this.readyWaiters.add(waiter);
    });
  }

  private handleIncomingPayload(rawPayload: string): void {
    const lines = rawPayload.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: JsonRpcMessage;
      try {
        parsed = JSON.parse(trimmed) as JsonRpcMessage;
      } catch {
        continue;
      }

      if (!parsed || typeof parsed !== "object") continue;

      if ("method" in parsed && typeof parsed.method === "string" && !("id" in parsed)) {
        if (parsed.method === APP_RPC_EVENT_NOTIFICATION && isRecord(parsed.params)) {
          const evt = parsed.params as unknown as LudensServerEvent;
          if (typeof evt.seq === "number" && typeof evt.topic === "string") {
            if (this.lastSeenSeq !== null && evt.seq <= this.lastSeenSeq) {
              continue;
            }
            this.advanceSeq(evt.seq);
            this.dispatchEvent(evt);
          }
        }
        continue;
      }

      if ("id" in parsed && typeof parsed.id === "number") {
        const entry = this.pending.get(parsed.id);
        if (!entry) continue;
        this.pending.delete(parsed.id);
        if (entry.timerId) clearTimeout(entry.timerId);
        entry.abortCleanup?.();

        if ("error" in parsed && parsed.error) {
          entry.reject(
            new LudensRpcError(parsed.error.code, parsed.error.message, parsed.error.data),
          );
        } else if ("result" in parsed) {
          entry.resolve(parsed.result);
        } else {
          entry.resolve(undefined);
        }
      }
    }
  }

  private advanceSeq(seq: number | undefined): void {
    if (typeof seq !== "number" || !Number.isFinite(seq)) return;
    if (this.lastSeenSeq === null || seq > this.lastSeenSeq) {
      this.lastSeenSeq = seq;
    }
  }

  private dispatchEvent(event: LudensServerEvent): void {
    const topicListeners = this.eventListeners.get(event.topic);
    if (topicListeners) {
      for (const listener of [...topicListeners]) {
        try {
          listener(event);
        } catch {
          // Keep dispatching remaining listeners cleanly.
        }
      }
    }
    const wildcardListeners = this.eventListeners.get("*");
    if (wildcardListeners) {
      for (const listener of [...wildcardListeners]) {
        try {
          listener(event);
        } catch {
          // Keep dispatching remaining listeners cleanly.
        }
      }
    }
  }

  private emitSnapshot(): void {
    const snapshot = this.getSnapshot();
    for (const listener of [...this.snapshotListeners]) {
      try {
        listener(snapshot);
      } catch {
        // Ignore downstream subscriber errors.
      }
    }
  }

  private resolveReadyWaiters(): void {
    for (const waiter of [...this.readyWaiters]) {
      this.readyWaiters.delete(waiter);
      waiter.resolve();
    }
  }

  private rejectReadyWaiters(err: Error): void {
    for (const waiter of [...this.readyWaiters]) {
      this.readyWaiters.delete(waiter);
      waiter.reject(err);
    }
  }

  private rejectPendingRequests(reason: string): void {
    for (const [id, entry] of this.pending.entries()) {
      this.pending.delete(id);
      if (entry.timerId) clearTimeout(entry.timerId);
      entry.abortCleanup?.();
      entry.reject(new LudensRpcError(APP_RPC_ERROR_CODES.SERVER_ERROR, reason));
    }
  }

  private teardownTransport(reason: string): void {
    if (this.ipcUnsubscribeMessage) {
      this.ipcUnsubscribeMessage();
      this.ipcUnsubscribeMessage = null;
    }
    if (this.ipcUnsubscribeStatus) {
      this.ipcUnsubscribeStatus();
      this.ipcUnsubscribeStatus = null;
    }
    if (this.socket) {
      const sock = this.socket;
      this.socket = null;
      sock.onopen = null;
      sock.onmessage = null;
      sock.onerror = null;
      sock.onclose = null;
      try {
        sock.close(1000, "Client switching transport");
      } catch {
        // Ignore close errors.
      }
    }
    this.rejectPendingRequests(reason);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearTicketRefreshTimer(): void {
    if (this.ticketRefreshTimer !== null) {
      clearTimeout(this.ticketRefreshTimer);
      this.ticketRefreshTimer = null;
    }
  }
}

/* ─────────────────────────── React Context & Hooks ─────────────────────────── */

export interface ConnectionTargetController {
  readonly target: ConnectionTarget;
  readonly resolved: ResolvedConnectionEndpoints;
  readonly isDesktop: boolean;
  readonly hashBootstrapped: boolean;
  setTarget(nextTarget: ConnectionTarget): void;
  setRemoteTarget(url: string, token?: string): void;
  setSameOriginTarget(token?: string): void;
  switchToElectronLocal(): void;
  updateToken(token: string | undefined): void;
  disconnect(): void;
}

export interface LudensRpcContextValue {
  readonly client: LudensRpcClient;
  readonly snapshot: LudensRpcSnapshot;
  readonly reconnectGeneration: number;
  readonly hashBootstrapped: boolean;
  readonly isDesktop: boolean;
  readonly setTarget: (nextTarget: ConnectionTarget) => void;
  readonly call: <M extends AppRpcMethod>(
    method: M,
    params: AppRpcParams<M>,
    options?: RpcCallOptions,
  ) => Promise<AppRpcResult<M>>;
  readonly reconnect: () => void;
}

const LudensRpcContext = createContext<LudensRpcContextValue | null>(null);

export interface LudensRpcProviderProps {
  readonly children: ReactNode;
  readonly initialTarget?: ConnectionTarget;
  readonly client?: LudensRpcClient;
  readonly env?: ConnectionEnv;
}

export function LudensRpcProvider({
  children,
  initialTarget,
  client: injectedClient,
  env,
}: LudensRpcProviderProps) {
  const [bootstrap] = useState(() =>
    initialTarget
      ? { target: initialTarget, hashBootstrapped: false }
      : resolveInitialConnectionTarget(env),
  );
  const clientRef = useRef<LudensRpcClient | null>(injectedClient ?? null);
  if (!clientRef.current) {
    clientRef.current = new LudensRpcClient({
      target: bootstrap.target,
      env,
    });
  }
  const client = clientRef.current;

  const [snapshot, setSnapshot] = useState<LudensRpcSnapshot>(() => client.getSnapshot());

  useEffect(() => {
    setSnapshot(client.getSnapshot());
    const unsubscribe = client.subscribeSnapshot(setSnapshot);
    return () => {
      unsubscribe();
    };
  }, [client]);

  useEffect(() => {
    if (injectedClient) return;
    return () => {
      client.dispose();
      if (clientRef.current === client) {
        clientRef.current = null;
      }
    };
  }, [client, injectedClient]);

  const setTarget = useCallback(
    (nextTarget: ConnectionTarget) => {
      saveConnectionTarget(nextTarget, env);
      client.setTarget(nextTarget);
    },
    [client, env],
  );

  const call = useCallback(
    <M extends AppRpcMethod>(
      method: M,
      params: AppRpcParams<M>,
      options?: RpcCallOptions,
    ): Promise<AppRpcResult<M>> => client.call(method, params, options),
    [client],
  );

  const reconnect = useCallback(() => {
    client.reconnect();
  }, [client]);

  const isDesktop =
    env?.hasDesktopRpc ??
    (typeof window !== "undefined" && Boolean(window.ludens?.rpc));

  const value = useMemo<LudensRpcContextValue>(
    () => ({
      client,
      snapshot,
      reconnectGeneration: snapshot.reconnectGeneration,
      hashBootstrapped: bootstrap.hashBootstrapped,
      isDesktop,
      setTarget,
      call,
      reconnect,
    }),
    [bootstrap.hashBootstrapped, call, client, isDesktop, reconnect, setTarget, snapshot],
  );

  return <LudensRpcContext.Provider value={value}>{children}</LudensRpcContext.Provider>;
}

export function useOptionalLudensRpc(): LudensRpcContextValue | null {
  return useContext(LudensRpcContext);
}

export function useLudensRpc(): {
  readonly client: LudensRpcClient;
  readonly call: LudensRpcContextValue["call"];
  readonly status: RpcConnectionStatus;
  readonly error?: string;
  readonly needsAuth: boolean;
  readonly isReady: boolean;
  readonly serverInfo?: InitializeResult;
  readonly serverSeq: number | null;
  readonly mediaTicket?: string;
  readonly reconnectGeneration: number;
  readonly reconnect: () => void;
  readonly subscribeEvent: LudensRpcClient["subscribeEvent"];
} {
  const ctx = useContext(LudensRpcContext);
  if (!ctx) {
    throw new Error("useLudensRpc must be used within <LudensRpcProvider>");
  }

  const subscribeEvent = useCallback(
    (
      topics: LudensEventTopic | "*" | readonly LudensEventTopic[],
      listener: LudensEventListener,
    ) => ctx.client.subscribeEvent(topics, listener),
    [ctx.client],
  );

  return {
    client: ctx.client,
    call: ctx.call,
    status: ctx.snapshot.status,
    error: ctx.snapshot.error,
    needsAuth: ctx.snapshot.needsAuth,
    isReady: ctx.snapshot.isReady,
    serverInfo: ctx.snapshot.serverInfo,
    serverSeq: ctx.snapshot.serverSeq,
    mediaTicket: ctx.snapshot.mediaTicket,
    reconnectGeneration: ctx.snapshot.reconnectGeneration,
    reconnect: ctx.reconnect,
    subscribeEvent,
  };
}

export function useConnectionTarget(): ConnectionTargetController {
  const ctx = useContext(LudensRpcContext);
  if (!ctx) {
    throw new Error("useConnectionTarget must be used within <LudensRpcProvider>");
  }

  const { snapshot, setTarget, isDesktop, hashBootstrapped } = ctx;

  const setRemoteTarget = useCallback(
    (url: string, token?: string) => {
      const trimmedToken = token?.trim();
      setTarget(
        trimmedToken
          ? { kind: "remote", url: url.trim(), token: trimmedToken }
          : { kind: "remote", url: url.trim() },
      );
    },
    [setTarget],
  );

  const setSameOriginTarget = useCallback(
    (token?: string) => {
      const trimmedToken = token?.trim();
      setTarget(
        trimmedToken ? { kind: "same-origin", token: trimmedToken } : { kind: "same-origin" },
      );
    },
    [setTarget],
  );

  const switchToElectronLocal = useCallback(() => {
    setTarget({ kind: "electron-local" });
  }, [setTarget]);

  const updateToken = useCallback(
    (token: string | undefined) => {
      const trimmedToken = token?.trim();
      const current = snapshot.target;
      if (current.kind === "remote") {
        setTarget(
          trimmedToken
            ? { kind: "remote", url: current.url, token: trimmedToken }
            : { kind: "remote", url: current.url },
        );
        return;
      }
      if (current.kind === "same-origin") {
        setTarget(
          trimmedToken
            ? { kind: "same-origin", token: trimmedToken }
            : { kind: "same-origin" },
        );
      }
    },
    [setTarget, snapshot.target],
  );

  const disconnect = useCallback(() => {
    clearStoredConnectionTarget();
    setTarget({ kind: "remote", url: "" });
  }, [setTarget]);

  return {
    target: snapshot.target,
    resolved: snapshot.resolved,
    isDesktop,
    hashBootstrapped,
    setTarget,
    setRemoteTarget,
    setSameOriginTarget,
    switchToElectronLocal,
    updateToken,
    disconnect,
  };
}

export function useMediaResolver(): MediaResolver {
  const ctx = useContext(LudensRpcContext);
  const target = ctx?.snapshot.target ?? { kind: "same-origin" as const };
  const ticket = ctx?.snapshot.mediaTicket;
  return useMemo(() => createMediaResolver(target, ticket), [target, ticket]);
}

export function useMediaUrl(ref: MediaRef | null | undefined): string | undefined {
  const ctx = useContext(LudensRpcContext);
  const target = ctx?.snapshot.target ?? { kind: "same-origin" as const };
  const ticket = ctx?.snapshot.mediaTicket;
  return useMemo(() => resolveMediaUrl(ref, target, ticket), [ref, target, ticket]);
}

export interface UseLudensEventOptions {
  readonly enabled?: boolean;
  readonly workspaceId?: string;
  readonly runId?: string;
}

export function useLudensEvent(
  topics: LudensEventTopic | "*" | readonly LudensEventTopic[],
  handler: LudensEventListener,
  options?: UseLudensEventOptions,
): void {
  const ctx = useContext(LudensRpcContext);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const enabled = options?.enabled !== false;
  const workspaceId = options?.workspaceId;
  const runId = options?.runId;
  const topicsKey = Array.isArray(topics) ? topics.join(",") : String(topics);

  useEffect(() => {
    if (!ctx || !enabled) return;
    const topicArg: LudensEventTopic | "*" | readonly LudensEventTopic[] = topicsKey.includes(",")
      ? (topicsKey.split(",") as LudensEventTopic[])
      : (topicsKey as LudensEventTopic | "*");

    return ctx.client.subscribeEvent(topicArg, (event) => {
      if (workspaceId !== undefined && event.workspaceId !== undefined && event.workspaceId !== workspaceId) {
        return;
      }
      if (runId !== undefined && event.runId !== undefined && event.runId !== runId) {
        return;
      }
      handlerRef.current(event);
    });
  }, [ctx, enabled, runId, topicsKey, workspaceId]);
}

export interface UseLudensQueryOptions<R> {
  readonly enabled?: boolean;
  readonly initialData?: R;
  readonly refreshOnEvents?: readonly LudensEventTopic[];
  readonly workspaceId?: string;
  readonly runId?: string;
  readonly refreshOnReconnect?: boolean;
  readonly timeoutMs?: number;
}

export interface UseLudensQueryResult<R> {
  readonly data: R | undefined;
  readonly error: unknown;
  readonly isLoading: boolean;
  readonly isFetching: boolean;
  readonly isSuccess: boolean;
  readonly isError: boolean;
  readonly refetch: () => Promise<R | undefined>;
  readonly setData: (updater: R | undefined | ((prev: R | undefined) => R | undefined)) => void;
}

export function useLudensQuery<M extends AppRpcMethod>(
  method: M,
  params: AppRpcParams<M>,
  options?: UseLudensQueryOptions<AppRpcResult<M>>,
): UseLudensQueryResult<AppRpcResult<M>> {
  const ctx = useContext(LudensRpcContext);
  if (!ctx) {
    throw new Error("useLudensQuery must be used within <LudensRpcProvider>");
  }

  const enabled = options?.enabled !== false;
  const refreshOnReconnect = options?.refreshOnReconnect !== false;
  const timeoutMs = options?.timeoutMs;
  const serializedParams = useMemo(() => JSON.stringify(params ?? null), [params]);

  const [data, setDataState] = useState<AppRpcResult<M> | undefined>(options?.initialData);
  const [error, setError] = useState<unknown>(undefined);
  const [isLoading, setIsLoading] = useState<boolean>(enabled);
  const [isFetching, setIsFetching] = useState<boolean>(enabled);

  const abortRef = useRef<AbortController | null>(null);
  const dataRef = useRef(data);
  dataRef.current = data;

  const paramsRef = useRef(params);
  paramsRef.current = params;

  const fetchOnce = useCallback(async (): Promise<AppRpcResult<M> | undefined> => {
    if (!enabled) return undefined;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsFetching(true);
    if (dataRef.current === undefined) {
      setIsLoading(true);
    }

    try {
      const result = await ctx.call(method, paramsRef.current, {
        signal: controller.signal,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
      if (controller.signal.aborted) return undefined;
      setDataState(result);
      setError(undefined);
      setIsLoading(false);
      setIsFetching(false);
      return result;
    } catch (err) {
      if (controller.signal.aborted) return undefined;
      setError(err);
      setIsLoading(false);
      setIsFetching(false);
      return undefined;
    }
  }, [ctx, enabled, method, serializedParams, timeoutMs]);

  useEffect(() => {
    if (!enabled) {
      abortRef.current?.abort();
      setIsLoading(false);
      setIsFetching(false);
      return;
    }
    void fetchOnce();
    return () => {
      abortRef.current?.abort();
    };
  }, [enabled, fetchOnce]);

  const prevReconnectGen = useRef(ctx.snapshot.reconnectGeneration);
  useEffect(() => {
    if (!enabled || !refreshOnReconnect) {
      prevReconnectGen.current = ctx.snapshot.reconnectGeneration;
      return;
    }
    if (ctx.snapshot.reconnectGeneration !== prevReconnectGen.current) {
      prevReconnectGen.current = ctx.snapshot.reconnectGeneration;
      void fetchOnce();
    }
  }, [ctx.snapshot.reconnectGeneration, enabled, fetchOnce, refreshOnReconnect]);

  const eventTopicsKey = options?.refreshOnEvents?.join(",") ?? "";
  useEffect(() => {
    if (!enabled || !eventTopicsKey) return;
    const topics = eventTopicsKey.split(",") as LudensEventTopic[];
    let queued = false;
    return ctx.client.subscribeEvent(topics, (event) => {
      if (
        options?.workspaceId !== undefined &&
        event.workspaceId !== undefined &&
        event.workspaceId !== options.workspaceId
      ) {
        return;
      }
      if (
        options?.runId !== undefined &&
        event.runId !== undefined &&
        event.runId !== options.runId
      ) {
        return;
      }
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        void fetchOnce();
      });
    });
  }, [ctx.client, enabled, eventTopicsKey, fetchOnce, options?.runId, options?.workspaceId]);

  return {
    data,
    error,
    isLoading,
    isFetching,
    isSuccess: error === undefined && data !== undefined,
    isError: error !== undefined,
    refetch: fetchOnce,
    setData: setDataState,
  };
}

export interface UseLudensMutationOptions<M extends AppRpcMethod> {
  readonly timeoutMs?: number;
  readonly onSuccess?: (data: AppRpcResult<M>, params: AppRpcParams<M>) => void;
  readonly onError?: (error: unknown, params: AppRpcParams<M>) => void;
}

export interface UseLudensMutationResult<M extends AppRpcMethod> {
  readonly mutateAsync: (
    params: AppRpcParams<M>,
    options?: RpcCallOptions,
  ) => Promise<AppRpcResult<M>>;
  readonly mutate: (params: AppRpcParams<M>, options?: RpcCallOptions) => void;
  readonly data: AppRpcResult<M> | undefined;
  readonly error: unknown;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly isSuccess: boolean;
  readonly reset: () => void;
}

export function useLudensMutation<M extends AppRpcMethod>(
  method: M,
  options?: UseLudensMutationOptions<M>,
): UseLudensMutationResult<M> {
  const ctx = useContext(LudensRpcContext);
  if (!ctx) {
    throw new Error("useLudensMutation must be used within <LudensRpcProvider>");
  }

  const [data, setData] = useState<AppRpcResult<M> | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [isPending, setIsPending] = useState(false);

  const optionsRef = useRef(options);
  optionsRef.current = options;

  const mutateAsync = useCallback(
    async (params: AppRpcParams<M>, callOptions?: RpcCallOptions): Promise<AppRpcResult<M>> => {
      setIsPending(true);
      setError(undefined);
      try {
        const mergedOptions: RpcCallOptions | undefined =
          callOptions ??
          (optionsRef.current?.timeoutMs !== undefined
            ? { timeoutMs: optionsRef.current.timeoutMs }
            : undefined);
        const result = await ctx.call(method, params, mergedOptions);
        setData(result);
        setIsPending(false);
        optionsRef.current?.onSuccess?.(result, params);
        return result;
      } catch (err) {
        setError(err);
        setIsPending(false);
        optionsRef.current?.onError?.(err, params);
        throw err;
      }
    },
    [ctx, method],
  );

  const mutate = useCallback(
    (params: AppRpcParams<M>, callOptions?: RpcCallOptions) => {
      void mutateAsync(params, callOptions).catch(() => {
        // Error captured in hook state and onError callback.
      });
    },
    [mutateAsync],
  );

  const reset = useCallback(() => {
    setData(undefined);
    setError(undefined);
    setIsPending(false);
  }, []);

  return {
    mutateAsync,
    mutate,
    data,
    error,
    isPending,
    isError: error !== undefined,
    isSuccess: error === undefined && data !== undefined,
    reset,
  };
}
