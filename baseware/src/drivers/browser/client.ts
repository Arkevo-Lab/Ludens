import { connect, type Socket } from "node:net";
import type {
  BrowserHostEnvelope,
  BrowserHostEvent,
  BrowserHostRequest,
  BrowserHostWireMessage,
} from "@ludens/protocol/viewport";

export interface BrowserHostClientOptions {
  onEvent?(event: BrowserHostEvent): void;
  onDisconnect?(error: Error): void;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
}

/** NDJSON Unix Domain Socket / Named Pipe client for the local Electron BrowserHost. */
export class BrowserHostClient {
  private pending = new Map<string, PendingRequest>();
  private eventListeners = new Set<(event: BrowserHostEvent) => void>();
  private disconnectListeners = new Set<(error: Error) => void>();
  private failure?: Error;
  private closed = false;
  private buffer = "";

  private constructor(
    private readonly socket: Socket,
    options: BrowserHostClientOptions,
  ) {
    if (options.onEvent) this.eventListeners.add(options.onEvent);
    if (options.onDisconnect) this.disconnectListeners.add(options.onDisconnect);

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      let end: number;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end).trim();
        this.buffer = this.buffer.slice(end + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line) as BrowserHostWireMessage;
          if ("event" in message) {
            for (const listener of this.eventListeners) {
              try {
                listener(message.event);
              } catch {
                /* listener owns its transport */
              }
            }
            continue;
          }
          const task = this.pending.get(message.id);
          if (!task) continue;
          this.pending.delete(message.id);
          task.cleanup();
          if (message.ok) task.resolve(message.value);
          else task.reject(new Error(message.error));
        } catch (error) {
          this.fail(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
    });
    socket.on("error", error => this.fail(error));
    socket.on("close", () => this.fail(new Error("Built-in browser host disconnected")));
  }

  static async connect(socketPath: string, options: BrowserHostClientOptions = {}): Promise<BrowserHostClient> {
    const socket = connect(socketPath);
    await new Promise<void>((resolve, reject) => {
      const onConnect = () => {
        socket.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        socket.off("connect", onConnect);
        socket.destroy();
        reject(
          new Error(`Built-in browser host is offline (start Ludens Desktop App): ${error.message}`, {
            cause: error,
          }),
        );
      };
      socket.once("connect", onConnect);
      socket.once("error", onError);
    });
    return new BrowserHostClient(socket, options);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get isDisconnected(): boolean {
    return this.failure !== undefined;
  }

  addEventListener(listener: (event: BrowserHostEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  onDisconnect(handler: (error: Error) => void): () => void {
    this.disconnectListeners.add(handler);
    return () => {
      this.disconnectListeners.delete(handler);
    };
  }

  private writeEnvelope(envelope: BrowserHostEnvelope): void {
    if (this.closed || this.socket.destroyed) return;
    this.socket.write(JSON.stringify(envelope) + "\n");
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const task of this.pending.values()) {
      task.cleanup();
      task.reject(error);
    }
    this.pending.clear();
    if (!this.socket.destroyed) this.socket.destroy();
    if (!this.closed) {
      for (const listener of this.disconnectListeners) {
        try {
          listener(error);
        } catch {
          /* caller owns disconnect handling */
        }
      }
    }
  }

  request<T = unknown>(request: BrowserHostRequest, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new Error("BrowserHost client closed"));
    if (this.failure) return Promise.reject(this.failure);
    if (signal?.aborted) {
      return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "Request aborted")));
    }
    const id = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const cancel = () => {
        if (!this.pending.delete(id)) return;
        signal?.removeEventListener("abort", cancel);
        this.writeEnvelope({ id: crypto.randomUUID(), request: { kind: "cancel", operationId: id } });
        reject(signal?.reason instanceof Error ? signal.reason : new Error(String(signal?.reason ?? "Request aborted")));
      };
      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
        cleanup: () => signal?.removeEventListener("abort", cancel),
      });
      signal?.addEventListener("abort", cancel, { once: true });
      this.writeEnvelope({ id, request });
    });
  }

  /** Cleanly detach from BrowserHost without destroying the persistent browser session. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const error = new Error("BrowserHost client closed");
    if (!this.failure) this.failure = error;
    for (const task of this.pending.values()) {
      task.cleanup();
      task.reject(error);
    }
    this.pending.clear();
    this.eventListeners.clear();
    this.disconnectListeners.clear();
    if (!this.socket.destroyed) this.socket.destroy();
  }
}
