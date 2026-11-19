import { connect, type Socket } from "node:net";
import {
  APP_RPC_ERROR_CODES,
  APP_RPC_EVENT_NOTIFICATION,
  APP_RPC_PROTOCOL_VERSION,
  type AppRpcMethod,
  type AppRpcParams,
  type AppRpcResult,
  type InitializeParams,
  type InitializeResult,
  type JsonRpcError,
  type JsonRpcNotification,
  type JsonRpcSuccess,
  type LudensServerEvent,
} from "@ludens/protocol/app-rpc";

export class AppRpcClientError extends Error {
  readonly code: number;
  readonly data?: Record<string, unknown>;

  constructor(code: number, message: string, data?: Record<string, unknown>) {
    super(message);
    this.name = "AppRpcClientError";
    this.code = code;
    this.data = data;
  }
}

export interface RpcCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface AppRpcClient {
  initialize(params?: Partial<InitializeParams>): Promise<InitializeResult>;
  call<M extends AppRpcMethod>(
    method: M,
    params?: AppRpcParams<M>,
    options?: RpcCallOptions,
  ): Promise<AppRpcResult<M>>;
  onEvent(listener: (event: LudensServerEvent) => void): () => void;
  close(): Promise<void>;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  cleanup: () => void;
}

export function normalizeRemoteWsUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl.trim());
  if (parsed.protocol === "http:") {
    parsed.protocol = "ws:";
  } else if (parsed.protocol === "https:") {
    parsed.protocol = "wss:";
  } else if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error(`Unsupported remote URL scheme: ${parsed.protocol}`);
  }
  if (!parsed.pathname || parsed.pathname === "/") {
    parsed.pathname = "/rpc";
  }
  return parsed.toString();
}

abstract class BaseJsonRpcClient implements AppRpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private readonly eventListeners = new Set<(event: LudensServerEvent) => void>();
  protected closed = false;

  protected abstract ensureOpen(): Promise<void>;
  protected abstract sendFrame(payload: string): void;
  protected abstract closeTransport(): Promise<void>;

  onEvent(listener: (event: LudensServerEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  async initialize(params: Partial<InitializeParams> = {}): Promise<InitializeResult> {
    const fullParams: InitializeParams = {
      clientInfo: params.clientInfo ?? {
        name: "ludens-cli",
        version: "0.1.0",
        platform: process.platform,
      },
      protocolVersion: params.protocolVersion ?? APP_RPC_PROTOCOL_VERSION,
      ...(params.token !== undefined ? { token: params.token } : {}),
    };
    return this.call("initialize", fullParams);
  }

  async call<M extends AppRpcMethod>(
    method: M,
    params?: AppRpcParams<M>,
    options: RpcCallOptions = {},
  ): Promise<AppRpcResult<M>> {
    if (this.closed) {
      throw new Error("RPC client is closed");
    }
    options.signal?.throwIfAborted();
    await this.ensureOpen();
    options.signal?.throwIfAborted();

    const id = this.nextId++;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    });

    return new Promise<AppRpcResult<M>>((resolveCall, rejectCall) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        this.pending.delete(id);
        cleanup();
        rejectCall(options.signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
      };

      if (options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          cleanup();
          rejectCall(new Error(`RPC call '${method}' timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs);
        timer.unref?.();
      }

      if (options.signal) {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }

      this.pending.set(id, {
        resolve: result => resolveCall(result as AppRpcResult<M>),
        reject: rejectCall,
        cleanup,
      });

      try {
        this.sendFrame(payload);
      } catch (error) {
        this.pending.delete(id);
        cleanup();
        rejectCall(error);
      }
    });
  }

  protected handleIncomingText(rawText: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;

    const msg = parsed as Partial<JsonRpcSuccess & JsonRpcError & JsonRpcNotification>;
    if (msg.method === APP_RPC_EVENT_NOTIFICATION && msg.params) {
      const event = msg.params as LudensServerEvent;
      for (const listener of this.eventListeners) {
        try {
          listener(event);
        } catch {}
      }
      return;
    }

    if (typeof msg.id !== "number") return;
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    entry.cleanup();

    if (msg.error) {
      entry.reject(
        new AppRpcClientError(
          msg.error.code ?? APP_RPC_ERROR_CODES.SERVER_ERROR,
          msg.error.message ?? "RPC Error",
          msg.error.data,
        ),
      );
      return;
    }

    entry.resolve(msg.result);
  }

  protected rejectAllPending(reason: Error): void {
    for (const [id, entry] of this.pending.entries()) {
      this.pending.delete(id);
      entry.cleanup();
      entry.reject(reason);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.rejectAllPending(new Error("RPC client closed"));
    this.eventListeners.clear();
    await this.closeTransport();
  }
}

export interface NodeUdsRpcClientOptions {
  socketPath: string;
  connectTimeoutMs?: number;
}

/** Pure Node.js NDJSON JSON-RPC 2.0 client over Unix Domain Socket (Electron & CLI safe). */
export class NodeUdsRpcClient extends BaseJsonRpcClient {
  private readonly socketPath: string;
  private readonly connectTimeoutMs: number;
  private socket: Socket | null = null;
  private connectPromise: Promise<void> | null = null;
  private readBuffer = "";

  constructor(options: string | NodeUdsRpcClientOptions) {
    super();
    if (typeof options === "string") {
      this.socketPath = options;
      this.connectTimeoutMs = 5000;
    } else {
      this.socketPath = options.socketPath;
      this.connectTimeoutMs = options.connectTimeoutMs ?? 5000;
    }
  }

  async connect(): Promise<void> {
    await this.ensureOpen();
  }

  protected async ensureOpen(): Promise<void> {
    if (this.closed) throw new Error("UDS RPC client is closed");
    if (this.socket && !this.socket.destroyed) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise<void>((resolveConnect, rejectConnect) => {
      const sock = connect(this.socketPath);
      sock.setEncoding("utf8");
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        sock.destroy();
        this.connectPromise = null;
        rejectConnect(new Error(`Timed out connecting to UDS socket: ${this.socketPath}`));
      }, this.connectTimeoutMs);
      timer.unref?.();

      sock.once("connect", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.socket = sock;
        this.connectPromise = null;
        resolveConnect();
      });

      sock.on("data", chunk => {
        this.readBuffer += chunk;
        let idx = this.readBuffer.indexOf("\n");
        while (idx !== -1) {
          const line = this.readBuffer.slice(0, idx).trim();
          this.readBuffer = this.readBuffer.slice(idx + 1);
          if (line) this.handleIncomingText(line);
          idx = this.readBuffer.indexOf("\n");
        }
      });

      sock.once("error", err => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          this.connectPromise = null;
          rejectConnect(err);
          return;
        }
        this.socket = null;
        this.rejectAllPending(err);
      });

      sock.once("close", () => {
        clearTimeout(timer);
        this.socket = null;
        this.connectPromise = null;
        this.rejectAllPending(new Error("UDS RPC connection closed"));
      });
    });

    await this.connectPromise;
  }

  protected sendFrame(payload: string): void {
    if (!this.socket || this.socket.destroyed || !this.socket.writable) {
      throw new Error("UDS RPC socket is not connected");
    }
    this.socket.write(`${payload}\n`);
  }

  protected async closeTransport(): Promise<void> {
    const sock = this.socket;
    this.socket = null;
    if (!sock || sock.destroyed) return;
    await new Promise<void>(resolveClose => {
      sock.once("close", () => resolveClose());
      sock.end();
      setTimeout(() => {
        if (!sock.destroyed) sock.destroy();
        resolveClose();
      }, 200).unref?.();
    });
  }
}

export interface WsAppRpcClientOptions {
  url: string;
  token?: string;
  clientInfo?: InitializeParams["clientInfo"];
  connectTimeoutMs?: number;
  autoInitialize?: boolean;
}

/** Pure Node/Browser-compatible WebSocket JSON-RPC 2.0 client (`/rpc`). */
export class WsAppRpcClient extends BaseJsonRpcClient {
  private readonly wsUrl: string;
  private readonly token?: string;
  private readonly clientInfo?: InitializeParams["clientInfo"];
  private readonly connectTimeoutMs: number;
  private readonly autoInitialize: boolean;
  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private initResult: InitializeResult | null = null;

  constructor(options: WsAppRpcClientOptions) {
    super();
    this.wsUrl = normalizeRemoteWsUrl(options.url);
    this.token = options.token;
    this.clientInfo = options.clientInfo;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5000;
    this.autoInitialize = options.autoInitialize ?? true;
  }

  get serverInfo(): InitializeResult | null {
    return this.initResult;
  }

  async connect(): Promise<InitializeResult | null> {
    await this.ensureOpen();
    if (this.autoInitialize && !this.initResult) {
      this.initResult = await this.initialize({
        clientInfo: this.clientInfo,
        ...(this.token !== undefined ? { token: this.token } : {}),
      });
    }
    return this.initResult;
  }

  protected async ensureOpen(): Promise<void> {
    if (this.closed) throw new Error("WS RPC client is closed");
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;

    const WebSocketCtor = globalThis.WebSocket;
    if (typeof WebSocketCtor !== "function") {
      throw new Error("Global WebSocket constructor is not available in this runtime");
    }

    this.connectPromise = new Promise<void>((resolveConnect, rejectConnect) => {
      const ws = new WebSocketCtor(this.wsUrl);
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {}
        this.connectPromise = null;
        rejectConnect(new Error(`Timed out connecting to WebSocket RPC: ${this.wsUrl}`));
      }, this.connectTimeoutMs);
      timer.unref?.();

      ws.addEventListener("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.ws = ws;
        this.connectPromise = null;
        resolveConnect();
      });

      ws.addEventListener("message", event => {
        if (typeof event.data === "string") {
          this.handleIncomingText(event.data);
          return;
        }
        if (event.data instanceof ArrayBuffer) {
          this.handleIncomingText(Buffer.from(event.data).toString("utf8"));
        }
      });

      ws.addEventListener("error", () => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          this.connectPromise = null;
          rejectConnect(new Error(`WebSocket connection failed: ${this.wsUrl}`));
        }
      });

      ws.addEventListener("close", () => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          this.connectPromise = null;
          rejectConnect(new Error(`WebSocket closed before open: ${this.wsUrl}`));
        }
        this.ws = null;
        this.rejectAllPending(new Error("WebSocket RPC connection closed"));
      });
    });

    await this.connectPromise;
  }

  protected sendFrame(payload: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket RPC connection is not open");
    }
    this.ws.send(payload);
  }

  protected async closeTransport(): Promise<void> {
    const ws = this.ws;
    this.ws = null;
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>(resolveClose => {
      const done = () => resolveClose();
      ws.addEventListener("close", done, { once: true });
      try {
        ws.close();
      } catch {
        resolveClose();
      }
      setTimeout(resolveClose, 250).unref?.();
    });
  }
}
