import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { resolve } from "node:path";
import type { DeviceEvent, Envelope as BasewareEnvelope, Message as BasewareMessage, Request as BasewareRequest } from "@ludens/baseware/protocol";
import {
  browserHostRuntimeFilePath,
  resolveBrowserHostSocketPath,
  type BrowserHostRuntimeInfo,
} from "@ludens/protocol/browser-host-paths";
import type {
  BrowserHostEnvelope,
  BrowserHostEvent,
  BrowserHostPingResult,
  BrowserHostRequest,
  BrowserHostWireMessage,
  ViewportControlAction,
  ViewportHumanInput,
  ViewportState,
} from "@ludens/protocol/viewport";

export const DEFAULT_BROWSER_HOST_PROBE_TIMEOUT_MS = 400;
export const DEFAULT_BROWSER_HOST_CACHE_TTL_MS = 1500;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export interface BrowserHostProbeResult {
  available: boolean;
  hostId: string | null;
  socketPath: string;
  pid?: number;
  version?: string;
  sessions?: string[];
  checkedAt: number;
}

export interface ProbeBrowserHostOptions {
  force?: boolean;
  timeoutMs?: number;
  socketPathOverride?: string;
}

export interface BrowserHostClientOptions {
  timeoutMs?: number;
  onEvent?: (event: BrowserHostEvent) => void;
  onDisconnect?: (error: Error) => void;
}

export interface EnsureBrowserSessionParams {
  sessionId: string;
  initialUrl?: string;
  width?: number;
  height?: number;
  partition?: string;
}

export interface SubscribeFramesOptions {
  maxFps?: number;
  quality?: number;
}

interface PendingTask {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

const probeCache = new Map<string, BrowserHostProbeResult>();

function cacheKeyForHome(home: string): string {
  return resolve(home);
}

/** Clear cached BrowserHost probe state for one home directory (or all homes when omitted). */
export function invalidateBrowserHostCache(home?: string): void {
  if (home === undefined) {
    probeCache.clear();
    return;
  }
  probeCache.delete(cacheKeyForHome(home));
}

/** Immediately update cached BrowserHost availability (used by `browserHost/notify` RPC). */
export function updateBrowserHostCache(
  home: string,
  update: {
    available: boolean;
    hostId?: string | null;
    socketPath?: string;
    pid?: number;
    version?: string;
    sessions?: string[];
  },
): BrowserHostProbeResult {
  const key = cacheKeyForHome(home);
  const result: BrowserHostProbeResult = {
    available: update.available,
    hostId: update.available ? (update.hostId ?? null) : null,
    socketPath: update.socketPath?.trim() || resolveBrowserHostSocketPath(key),
    ...(update.available && update.pid !== undefined ? { pid: update.pid } : {}),
    ...(update.available && update.version ? { version: update.version } : {}),
    ...(update.available && update.sessions ? { sessions: update.sessions } : {}),
    checkedAt: Date.now(),
  };
  probeCache.set(key, result);
  return result;
}

async function readBrowserHostRuntimeInfo(home: string): Promise<BrowserHostRuntimeInfo | null> {
  try {
    const raw = JSON.parse(await readFile(browserHostRuntimeFilePath(home), "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const obj = raw as Record<string, unknown>;
    if (typeof obj.socketPath !== "string" || !obj.socketPath.trim()) return null;
    return {
      hostId: typeof obj.hostId === "string" ? obj.hostId : "",
      pid: typeof obj.pid === "number" ? obj.pid : 0,
      socketPath: obj.socketPath.trim(),
      startedAt: typeof obj.startedAt === "string" ? obj.startedAt : "",
      home: typeof obj.home === "string" ? obj.home : home,
      version: typeof obj.version === "string" ? obj.version : "",
    };
  } catch {
    return null;
  }
}

/**
 * Probe local Desktop BrowserHost via `<home>/run/browser-host.json` + UDS `ping`.
 * Uses a short ~400ms timeout and 1.5s TTL cache that `browserHost/notify` can immediately invalidate/update.
 */
export async function probeBrowserHost(
  home: string,
  options: ProbeBrowserHostOptions = {},
): Promise<BrowserHostProbeResult> {
  const key = cacheKeyForHome(home);
  const now = Date.now();
  if (!options.force) {
    const cached = probeCache.get(key);
    if (cached && now - cached.checkedAt < DEFAULT_BROWSER_HOST_CACHE_TTL_MS) {
      return cached;
    }
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_BROWSER_HOST_PROBE_TIMEOUT_MS;
  const runtimeInfo = await readBrowserHostRuntimeInfo(key);
  const socketPath =
    options.socketPathOverride?.trim()
    || runtimeInfo?.socketPath
    || resolveBrowserHostSocketPath(key);

  let client: BrowserHostClient | null = null;
  try {
    client = await BrowserHostClient.connect(socketPath, { timeoutMs });
    const ping = await client.ping(timeoutMs);
    const result: BrowserHostProbeResult = {
      available: true,
      hostId: (typeof ping.hostId === "string" && ping.hostId.trim())
        ? ping.hostId.trim()
        : (runtimeInfo?.hostId || null),
      socketPath,
      ...(typeof ping.pid === "number" && ping.pid > 0
        ? { pid: ping.pid }
        : runtimeInfo?.pid
          ? { pid: runtimeInfo.pid }
          : {}),
      ...(typeof ping.version === "string" && ping.version
        ? { version: ping.version }
        : runtimeInfo?.version
          ? { version: runtimeInfo.version }
          : {}),
      ...(Array.isArray(ping.sessions) ? { sessions: ping.sessions } : {}),
      checkedAt: Date.now(),
    };
    probeCache.set(key, result);
    return result;
  } catch {
    const result: BrowserHostProbeResult = {
      available: false,
      hostId: null,
      socketPath,
      checkedAt: Date.now(),
    };
    probeCache.set(key, result);
    return result;
  } finally {
    client?.close();
  }
}

function connectSocketWithTimeout(socketPath: string, timeoutMs: number): Promise<Socket> {
  return new Promise((resolveSocket, rejectSocket) => {
    const socket = connect(socketPath);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      rejectSocket(new Error(`Timed out connecting to socket ${socketPath}`));
    }, timeoutMs);
    timer.unref?.();

    const onConnect = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("error", onError);
      resolveSocket(socket);
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.destroy();
      rejectSocket(error);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

/** NDJSON UDS client for communicating directly with local Electron `BrowserHost`. */
export class BrowserHostClient {
  private readonly pending = new Map<string, PendingTask>();
  private failure?: Error;
  private buffer = "";
  private closed = false;

  private constructor(
    private readonly socket: Socket,
    private readonly options: BrowserHostClientOptions,
  ) {
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      this.buffer += chunk;
      let newlineIdx = this.buffer.indexOf("\n");
      while (newlineIdx >= 0) {
        const line = this.buffer.slice(0, newlineIdx).trim();
        this.buffer = this.buffer.slice(newlineIdx + 1);
        if (line) {
          this.handleLine(line);
        }
        newlineIdx = this.buffer.indexOf("\n");
      }
    });
    socket.on("error", error => {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    });
    socket.on("close", () => {
      this.fail(new Error("BrowserHost disconnected"));
    });
  }

  static async connect(
    socketPath: string,
    options: BrowserHostClientOptions = {},
  ): Promise<BrowserHostClient> {
    const socket = await connectSocketWithTimeout(socketPath, options.timeoutMs ?? 2000);
    return new BrowserHostClient(socket, options);
  }

  private handleLine(line: string): void {
    let message: BrowserHostWireMessage;
    try {
      message = JSON.parse(line) as BrowserHostWireMessage;
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if ("event" in message && message.event) {
      try {
        this.options.onEvent?.(message.event);
      } catch {
        // Never allow listener errors to break socket framing.
      }
      return;
    }
    if (!("id" in message)) return;
    const task = this.pending.get(message.id);
    if (!task) return;
    this.pending.delete(message.id);
    task.cleanup();
    if (message.ok) {
      task.resolve(message.value);
    } else {
      task.reject(new Error(message.error || "BrowserHost request failed"));
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const task of this.pending.values()) {
      task.cleanup();
      task.reject(error);
    }
    this.pending.clear();
    if (!this.socket.destroyed) {
      this.socket.destroy();
    }
    if (!this.closed) {
      this.options.onDisconnect?.(error);
    }
  }

  request<T = unknown>(
    request: BrowserHostRequest,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    if (options?.signal?.aborted) {
      return Promise.reject(options.signal.reason ?? new Error("Request aborted"));
    }
    const id = randomUUID();
    const timeoutMs = options?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const signal = options?.signal;

    return new Promise<T>((resolvePromise, rejectPromise) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        if (!this.pending.delete(id)) return;
        cleanup();
        this.writeEnvelope({ id: randomUUID(), request: { kind: "cancel", operationId: id } });
        rejectPromise(signal?.reason ?? new Error("Request aborted"));
      };

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (!this.pending.delete(id)) return;
          cleanup();
          rejectPromise(new Error(`BrowserHost request timed out (${request.kind})`));
        }, timeoutMs);
        timer.unref?.();
      }

      this.pending.set(id, {
        resolve: value => resolvePromise(value as T),
        reject: rejectPromise,
        cleanup,
      });
      signal?.addEventListener("abort", onAbort, { once: true });

      if (!this.writeEnvelope({ id, request })) {
        this.pending.delete(id);
        cleanup();
        rejectPromise(this.failure ?? new Error("BrowserHost socket is not writable"));
      }
    });
  }

  private writeEnvelope(envelope: BrowserHostEnvelope): boolean {
    if (this.socket.destroyed || !this.socket.writable) return false;
    try {
      this.socket.write(`${JSON.stringify(envelope)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  ping(timeoutMs = DEFAULT_BROWSER_HOST_PROBE_TIMEOUT_MS): Promise<BrowserHostPingResult> {
    return this.request<BrowserHostPingResult>({ kind: "ping" }, { timeoutMs });
  }

  ensureSession(
    params: EnsureBrowserSessionParams,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<ViewportState> {
    return this.request<ViewportState>(
      {
        kind: "session.ensure",
        sessionId: params.sessionId,
        ...(params.initialUrl ? { initialUrl: params.initialUrl } : {}),
        ...(params.width !== undefined ? { width: params.width } : {}),
        ...(params.height !== undefined ? { height: params.height } : {}),
        ...(params.partition ? { partition: params.partition } : {}),
      },
      options,
    );
  }

  describe(
    sessionId: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<ViewportState> {
    return this.request<ViewportState>({ kind: "session.describe", sessionId }, options);
  }

  performAction(
    sessionId: string,
    action: ViewportControlAction,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<ViewportState> {
    return this.request<ViewportState>({ kind: "session.action", sessionId, action }, options);
  }

  sendHumanInput(
    sessionId: string,
    input: ViewportHumanInput,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<{ ok: true; pointerLocked: boolean }> {
    return this.request<{ ok: true; pointerLocked: boolean }>(
      { kind: "session.input", sessionId, input },
      options,
    );
  }

  subscribeFrames(
    sessionId: string,
    subscribeOptions?: SubscribeFramesOptions,
    requestOptions?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<ViewportState | void> {
    return this.request<ViewportState | void>(
      {
        kind: "session.subscribe",
        sessionId,
        ...(subscribeOptions?.maxFps !== undefined ? { maxFps: subscribeOptions.maxFps } : {}),
        ...(subscribeOptions?.quality !== undefined ? { quality: subscribeOptions.quality } : {}),
      },
      requestOptions,
    );
  }

  unsubscribeFrames(
    sessionId: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<void> {
    return this.request<void>({ kind: "session.unsubscribe", sessionId }, options);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const err = new Error("BrowserHost client closed");
    for (const task of this.pending.values()) {
      task.cleanup();
      task.reject(err);
    }
    this.pending.clear();
    if (!this.socket.destroyed) {
      this.socket.destroy();
    }
  }
}

export interface BasewareViewportClientOptions {
  timeoutMs?: number;
  onEvent?: (event: BrowserHostEvent) => void;
  onDeviceEvent?: (event: DeviceEvent) => void;
  onDisconnect?: (error: Error) => void;
}

export interface BasewareViewportClient {
  describe(machine?: string, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<ViewportState>;
  performAction(
    action: ViewportControlAction,
    machine?: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<ViewportState>;
  sendHumanInput(
    input: ViewportHumanInput,
    machine?: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<{ ok: true; pointerLocked: boolean }>;
  subscribe(
    options?: { machine?: string; maxFps?: number; quality?: number },
    requestOptions?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<ViewportState | void>;
  close(): void;
}

function extractViewportEvent(deviceEvent: DeviceEvent): BrowserHostEvent | null {
  if (deviceEvent.type !== "viewport_frame" && deviceEvent.type !== "viewport_state") {
    return null;
  }
  const data = deviceEvent.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const candidate = data as Record<string, unknown>;
  if (candidate.event === "frame" || candidate.event === "state") {
    return candidate as unknown as BrowserHostEvent;
  }
  return null;
}

class UdsBasewareViewportClient implements BasewareViewportClient {
  private readonly pending = new Map<string, PendingTask>();
  private failure?: Error;
  private buffer = "";
  private closed = false;

  constructor(
    private readonly socket: Socket,
    private readonly options: BasewareViewportClientOptions,
  ) {
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      this.buffer += chunk;
      let newlineIdx = this.buffer.indexOf("\n");
      while (newlineIdx >= 0) {
        const line = this.buffer.slice(0, newlineIdx).trim();
        this.buffer = this.buffer.slice(newlineIdx + 1);
        if (line) {
          this.handleLine(line);
        }
        newlineIdx = this.buffer.indexOf("\n");
      }
    });
    socket.on("error", error => {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    });
    socket.on("close", () => {
      this.fail(new Error("Baseware viewport disconnected"));
    });
  }

  private handleLine(line: string): void {
    let message: BasewareMessage;
    try {
      message = JSON.parse(line) as BasewareMessage;
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if ("event" in message && message.event) {
      try {
        this.options.onDeviceEvent?.(message.event);
        const vpEvent = extractViewportEvent(message.event);
        if (vpEvent) {
          this.options.onEvent?.(vpEvent);
        }
      } catch {
        // Never allow listener errors to disrupt NDJSON framing.
      }
      return;
    }
    if (!("id" in message)) return;
    const task = this.pending.get(message.id);
    if (!task) return;
    this.pending.delete(message.id);
    task.cleanup();
    if (message.ok) {
      task.resolve(message.value);
    } else {
      task.reject(new Error(message.error || "Baseware viewport request failed"));
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const task of this.pending.values()) {
      task.cleanup();
      task.reject(error);
    }
    this.pending.clear();
    if (!this.socket.destroyed) {
      this.socket.destroy();
    }
    if (!this.closed) {
      this.options.onDisconnect?.(error);
    }
  }

  private writeEnvelope(envelope: BasewareEnvelope): boolean {
    if (this.socket.destroyed || !this.socket.writable) return false;
    try {
      this.socket.write(`${JSON.stringify(envelope)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  private request<T>(
    request: BasewareRequest,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    if (options?.signal?.aborted) {
      return Promise.reject(options.signal.reason ?? new Error("Request aborted"));
    }
    const id = randomUUID();
    const timeoutMs = options?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const signal = options?.signal;

    return new Promise<T>((resolvePromise, rejectPromise) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        if (!this.pending.delete(id)) return;
        cleanup();
        this.writeEnvelope({ id: randomUUID(), request: { kind: "cancel", operationId: id } });
        rejectPromise(signal?.reason ?? new Error("Request aborted"));
      };

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (!this.pending.delete(id)) return;
          cleanup();
          rejectPromise(new Error(`Baseware request timed out (${request.kind})`));
        }, timeoutMs);
        timer.unref?.();
      }

      this.pending.set(id, {
        resolve: value => resolvePromise(value as T),
        reject: rejectPromise,
        cleanup,
      });
      signal?.addEventListener("abort", onAbort, { once: true });

      if (!this.writeEnvelope({ id, request })) {
        this.pending.delete(id);
        cleanup();
        rejectPromise(this.failure ?? new Error("Baseware socket is not writable"));
      }
    });
  }

  describe(
    machine?: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<ViewportState> {
    return this.request<ViewportState>(
      { kind: "viewport.describe", ...(machine ? { machine } : {}) },
      options,
    );
  }

  performAction(
    action: ViewportControlAction,
    machine?: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<ViewportState> {
    return this.request<ViewportState>(
      { kind: "viewport.action", viewportAction: action, ...(machine ? { machine } : {}) },
      options,
    );
  }

  sendHumanInput(
    input: ViewportHumanInput,
    machine?: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<{ ok: true; pointerLocked: boolean }> {
    return this.request<{ ok: true; pointerLocked: boolean }>(
      { kind: "viewport.input", viewportInput: input, ...(machine ? { machine } : {}) },
      options,
    );
  }

  subscribe(
    subscribeOptions?: { machine?: string; maxFps?: number; quality?: number },
    requestOptions?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<ViewportState | void> {
    return this.request<ViewportState | void>(
      {
        kind: "viewport.subscribe",
        ...(subscribeOptions?.machine ? { machine: subscribeOptions.machine } : {}),
        ...(subscribeOptions?.maxFps !== undefined ? { maxFps: subscribeOptions.maxFps } : {}),
        ...(subscribeOptions?.quality !== undefined ? { quality: subscribeOptions.quality } : {}),
      },
      requestOptions,
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const err = new Error("Baseware viewport client closed");
    for (const task of this.pending.values()) {
      task.cleanup();
      task.reject(err);
    }
    this.pending.clear();
    if (!this.socket.destroyed) {
      this.socket.destroy();
    }
  }
}

/** Connect to a live Baseware UDS socket specifically for `viewport.*` RPCs and transient frame subscriptions. */
export async function connectBasewareViewport(
  basewareSocket: string,
  options: BasewareViewportClientOptions = {},
): Promise<BasewareViewportClient> {
  const socket = await connectSocketWithTimeout(basewareSocket, options.timeoutMs ?? 2000);
  return new UdsBasewareViewportClient(socket, options);
}
