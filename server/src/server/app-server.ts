import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server as NetServer, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { ludensHome } from "@ludens/protocol/ludens";
import { clearStaleLocalSocket, isWindowsNamedPipe } from "@ludens/protocol/local-socket";
import { closeArchiveBuilds } from "../query/cold-build.ts";
import { DashboardWorker } from "../query/dashboard-worker.ts";
import { closeLogIndexes } from "../query/log-index.ts";
import { getActiveWorkspaceSupervisor, setActiveWorkspaceSupervisor } from "../query/workspaces.ts";
import {
  appServerRuntimeFilePath,
  resolveAppServerSocketPath,
  type AppServerRuntimeInfo,
} from "../daemon/app-server-paths.ts";
import { WorkspaceSupervisor } from "../daemon/supervisor.ts";
import { EventHub } from "./event-hub.ts";
import { handleHttpRequest } from "./http-routes.ts";
import { localRequest, normalizeOrigin } from "./local-request.ts";
import { generateMediaTicketSecret } from "./media-ticket.ts";
import { RpcRouter, type RpcSession, type RpcWorkerClient } from "./rpc-router.ts";
import { authorizeViewportUpgrade, ViewportWsBridge } from "./viewport-ws.ts";

export interface WsListenOptions {
  host: string;
  port: number;
}

export interface AppServerAuthOptions {
  mode: "none" | "token";
  token?: string;
}

export interface StartAppServerOptions {
  home?: string;
  repo?: string;
  /** Override UDS path or pass `false` to disable UDS listener. Default resolves via `<home>/run/app-server.sock`. */
  unixSocketPath?: string | false;
  /** Optional HTTP + WebSocket listener (`GET /health`, `GET /rpc`, `GET|HEAD /media`, static files). Omit for UDS-only (0 TCP ports). */
  wsListen?: WsListenOptions | null;
  auth?: AppServerAuthOptions;
  /** Enable local loopback `web-dev` runtime profile on WS sessions (`127.0.0.1` / `localhost` / `::1` only). */
  devMode?: boolean;
  staticDir?: string;
  trustedOrigins?: string[];
  parentWatchdog?: boolean;
  watchdogStream?: NodeJS.ReadableStream;
  onWatchdogTrigger?: () => void;
  supervisor?: WorkspaceSupervisor;
  worker?: RpcWorkerClient & { close?: () => Promise<void> };
  serverVersion?: string;
}

export interface AppServerHandle {
  pid: number;
  home: string;
  socketPath: string | null;
  wsUrl: string | null;
  url: string | null;
  host: string | null;
  port: number | null;
  authMode: "none" | "token";
  devMode?: boolean;
  runtimeFilePath: string;
  startedAt: string;
  staticDir?: string;
  supervisor: WorkspaceSupervisor;
  eventHub: EventHub;
  router: RpcRouter;
  worker: RpcWorkerClient;
  closed: Promise<void>;
  waitForExit(): Promise<void>;
  close(options?: { emergency?: boolean; stopCores?: boolean }): Promise<void>;
}

type WebSocketSessionData =
  | {
      kind: "rpc";
      session: RpcSession | null;
    }
  | {
      kind: "viewport";
      project: string;
      machineId?: string;
      bridge: ViewportWsBridge<WebSocketSessionData> | null;
    };

export function isLoopbackHost(rawHost: string): boolean {
  const normalized = rawHost.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function formatHostForUrl(rawHost: string): string {
  const trimmed = rawHost.trim().replace(/^\[|\]$/g, "");
  return trimmed.includes(":") ? `[${trimmed}]` : trimmed;
}

async function prepareUnixSocketPath(socketPath: string): Promise<void> {
  if (!isWindowsNamedPipe(socketPath)) {
    await mkdir(dirname(socketPath), { recursive: true });
  }
  await clearStaleLocalSocket(socketPath, () => Object.assign(
    new Error(`app-server is already running on UDS socket: ${socketPath}`), { code: "ALREADY_RUNNING" },
  ));
}

async function listenUnixServer(server: NetServer, socketPath: string): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      rejectListen(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
  if (process.platform !== "win32") {
    await chmod(socketPath, 0o600);
  }
}

async function writeRuntimeFileAtomic(
  runtimeFilePath: string,
  info: AppServerRuntimeInfo,
): Promise<void> {
  await mkdir(dirname(runtimeFilePath), { recursive: true });
  const tempPath = join(dirname(runtimeFilePath), `.app-server.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(tempPath, JSON.stringify(info, null, 2) + "\n", { mode: 0o600 });
  await rename(tempPath, runtimeFilePath);
  await chmod(runtimeFilePath, 0o600).catch(() => {});
}

/**
 * Starts the unified `@ludens/core` App Server.
 * Binds Unix Domain Socket (`<home>/run/app-server.sock` or `/tmp` fallback) by default with 0 TCP ports,
 * and optionally exposes HTTP (`/health`, `/media`, static SPA) + WebSocket (`/rpc`) when `wsListen` is configured.
 */
export async function startAppServer(
  options: StartAppServerOptions = {},
): Promise<AppServerHandle> {
  const home = resolve(options.home ?? ludensHome());
  const authMode: "none" | "token" = options.auth?.mode ?? "none";
  const token = options.auth?.token;
  const devMode = Boolean(options.devMode);

  if (authMode === "token" && (typeof token !== "string" || token.length === 0)) {
    throw new Error("App server auth mode 'token' requires a non-empty token");
  }

  const wsListen = options.wsListen ?? null;
  if (wsListen) {
    if (!Number.isInteger(wsListen.port) || wsListen.port < 0 || wsListen.port > 65535) {
      throw new Error(`Invalid wsListen port: ${wsListen.port}`);
    }
    if (devMode && !isLoopbackHost(wsListen.host)) {
      throw new Error(
        `Refusing to enable --dev mode on non-loopback host "${wsListen.host}" (loopback 127.0.0.1 / ::1 / localhost only)`,
      );
    }
    if (!isLoopbackHost(wsListen.host) && (authMode !== "token" || !token)) {
      throw new Error(
        `Refusing to bind app-server WS/HTTP to non-loopback host "${wsListen.host}" without auth.mode="token" and a non-empty token`,
      );
    }
  }

  const socketPath =
    options.unixSocketPath === false
      ? null
      : options.unixSocketPath
        ? (isWindowsNamedPipe(options.unixSocketPath) ? options.unixSocketPath : resolve(options.unixSocketPath))
        : resolveAppServerSocketPath(home);

  if (!socketPath && !wsListen) {
    throw new Error("app-server requires at least one listener (UDS or wsListen)");
  }

  const staticDir = options.staticDir ? resolve(options.staticDir) : undefined;
  const trustedOrigins = new Set<string>(
    (options.trustedOrigins ?? []).map(origin => normalizeOrigin(origin)).filter(Boolean),
  );

  const supervisor =
    options.supervisor ??
    new WorkspaceSupervisor({
      home,
      ...(options.repo ? { repo: options.repo } : {}),
    });

  const ownsWorker = !options.worker;
  const worker =
    options.worker ??
    new DashboardWorker({
      env: { ...process.env, LUDENS_HOME: home },
    });

  const eventHub = new EventHub({ home });
  const mediaSecret = generateMediaTicketSecret();
  const runtimeFilePath = appServerRuntimeFilePath(home);
  const startedAt = new Date().toISOString();

  setActiveWorkspaceSupervisor(supervisor);

  const closedDeferred = Promise.withResolvers<void>();
  let closingPromise: Promise<void> | undefined;
  let detachWatchdog: (() => void) | undefined;

  let udsServer: NetServer | null = null;
  const udsSockets = new Set<Socket>();
  const viewportBridges = new Set<ViewportWsBridge<WebSocketSessionData>>();
  let httpServer: ReturnType<typeof Bun.serve<WebSocketSessionData>> | null = null;
  let boundPort: number | null = null;
  let displayHost: string | null = null;
  let url: string | null = null;
  let wsUrl: string | null = null;
  let runtimeWritten = false;

  const router = new RpcRouter({
    home,
    serverVersion: options.serverVersion ?? "0.1.0",
    pid: process.pid,
    authMode,
    token,
    devMode,
    mediaSecret,
    eventHub,
    worker,
    supervisor,
    getConnectionInfo: () => ({
      socketPath: socketPath ?? "",
      wsUrl,
      startedAt,
    }),
    scheduleShutdown: ({ stopCores }) => {
      setTimeout(() => {
        void close({ emergency: false, stopCores });
      }, 15);
    },
  });

  const close = (
    closeOptions: { emergency?: boolean; stopCores?: boolean } = {},
  ): Promise<void> => {
    if (closingPromise) return closingPromise;
    const emergency = Boolean(closeOptions.emergency);
    const stopCores = closeOptions.stopCores !== false;
    closingPromise = (async () => {
      detachWatchdog?.();
      detachWatchdog = undefined;
      if (getActiveWorkspaceSupervisor() === supervisor) {
        setActiveWorkspaceSupervisor(null);
      }

      if (runtimeWritten) {
        await unlink(runtimeFilePath).catch(() => {});
      }

      for (const bridge of viewportBridges) {
        try {
          bridge.close();
        } catch {}
      }
      viewportBridges.clear();

      for (const sock of udsSockets) {
        try {
          sock.destroy();
        } catch {}
      }
      udsSockets.clear();

      if (udsServer) {
        const srv = udsServer;
        udsServer = null;
        await new Promise<void>(resolveClose => {
          try {
            srv.close(() => resolveClose());
          } catch {
            resolveClose();
          }
        });
        if (socketPath && !isWindowsNamedPipe(socketPath)) {
          await unlink(socketPath).catch(() => {});
        }
      }

      if (httpServer) {
        try {
          httpServer.stop(emergency);
        } catch {}
      }

      await Promise.allSettled([
        eventHub.close(),
        stopCores ? supervisor.shutdownAll({ emergency }) : Promise.resolve(),
        ownsWorker && worker.close ? worker.close() : Promise.resolve(),
      ]);
      await Promise.allSettled([closeArchiveBuilds(), closeLogIndexes()]);

      if (httpServer) {
        try {
          httpServer.stop(true);
        } catch {}
      }

      closedDeferred.resolve();
    })();
    return closingPromise;
  };

  try {
    await eventHub.start();

    if (socketPath) {
      await prepareUnixSocketPath(socketPath);
      udsServer = createServer(socket => {
        udsSockets.add(socket);
        let buffer = "";
        const session = router.createSession({
          transport: "uds",
          sendMessage: message => {
            if (socket.destroyed || !socket.writable) return;
            try {
              socket.write(`${JSON.stringify(message)}\n`);
            } catch {}
          },
        });

        socket.setEncoding("utf8");
        socket.on("data", chunk => {
          buffer += chunk;
          let newlineIndex = buffer.indexOf("\n");
          while (newlineIndex !== -1) {
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);
            if (line) {
              void session.handleRawText(line);
            }
            newlineIndex = buffer.indexOf("\n");
          }
        });

        const cleanup = () => {
          udsSockets.delete(socket);
          session.close();
        };
        socket.once("close", cleanup);
        socket.once("error", cleanup);
      });
      await listenUnixServer(udsServer, socketPath);
    }

    if (wsListen) {
      const bindHost = wsListen.host.trim().replace(/^\[|\]$/g, "");
      displayHost = formatHostForUrl(wsListen.host);
      httpServer = Bun.serve<WebSocketSessionData>({
        hostname: bindHost,
        port: wsListen.port,
        idleTimeout: 120,
        fetch(request: Request, server): Response | Promise<Response> | undefined {
          const reqUrl = new URL(request.url);
          if (reqUrl.pathname === "/rpc" && request.method.toUpperCase() === "GET") {
            if (authMode === "none") {
              try {
                localRequest(request, {
                  mutation: request.headers.has("origin"),
                  trustedOrigins,
                });
              } catch (error) {
                const status = (error as { status?: number } | null)?.status ?? 403;
                return Response.json(
                  { error: error instanceof Error ? error.message : String(error) },
                  { status, headers: { "Cache-Control": "no-store" } },
                );
              }
            }
            if (server.upgrade(request, { data: { kind: "rpc", session: null } })) {
              return undefined;
            }
            return Response.json(
              { error: "WebSocket upgrade required" },
              { status: 400, headers: { "Cache-Control": "no-store" } },
            );
          }

          if (reqUrl.pathname === "/viewport" && request.method.toUpperCase() === "GET") {
            const authError = authorizeViewportUpgrade(request, reqUrl, {
              authMode,
              mediaSecret,
              trustedOrigins,
            });
            if (authError) return authError;

            const project = reqUrl.searchParams.get("project")?.trim();
            if (!project) {
              return Response.json(
                { error: "Missing project parameter" },
                { status: 400, headers: { "Cache-Control": "no-store" } },
              );
            }
            const machineId = reqUrl.searchParams.get("machine")?.trim() || undefined;
            if (
              server.upgrade(request, {
                data: {
                  kind: "viewport",
                  project,
                  ...(machineId ? { machineId } : {}),
                  bridge: null,
                },
              })
            ) {
              return undefined;
            }
            return Response.json(
              { error: "WebSocket upgrade required" },
              { status: 400, headers: { "Cache-Control": "no-store" } },
            );
          }

          return handleHttpRequest(request, reqUrl, {
            pid: process.pid,
            authMode,
            mediaSecret,
            trustedOrigins,
            staticDir,
            worker,
          });
        },
        websocket: {
          open(ws) {
            if (ws.data.kind === "viewport") {
              const bridge = new ViewportWsBridge<WebSocketSessionData>(ws, {
                home,
                project: ws.data.project,
                ...(ws.data.machineId ? { machineId: ws.data.machineId } : {}),
                eventHub,
                onClose: () => {
                  viewportBridges.delete(bridge);
                },
              });
              ws.data.bridge = bridge;
              viewportBridges.add(bridge);
              bridge.start();
              return;
            }
            ws.data.session = router.createSession({
              transport: "ws",
              sendMessage: message => {
                try {
                  ws.send(JSON.stringify(message));
                } catch {}
              },
            });
          },
          message(ws, message) {
            if (ws.data.kind === "viewport") {
              void ws.data.bridge?.handleRawMessage(message);
              return;
            }
            const text =
              typeof message === "string"
                ? message
                : Buffer.from(message).toString("utf8");
            void ws.data.session?.handleRawText(text);
          },
          drain(ws) {
            if (ws.data.kind === "viewport") {
              ws.data.bridge?.onDrain();
            }
          },
          close(ws) {
            if (ws.data.kind === "viewport") {
              ws.data.bridge?.close();
              ws.data.bridge = null;
              return;
            }
            ws.data.session?.close();
            ws.data.session = null;
          },
        },
      });

      boundPort = httpServer.port ?? null;
      if (typeof boundPort !== "number") {
        throw new Error("app-server failed to bind WS/HTTP TCP port");
      }
      const scheme = "http";
      const wsScheme = "ws";
      url = `${scheme}://${displayHost}:${boundPort}`;
      wsUrl = `${wsScheme}://${displayHost}:${boundPort}/rpc`;
      trustedOrigins.add(url);
      if (bindHost === "127.0.0.1") {
        trustedOrigins.add(`http://localhost:${boundPort}`);
      } else if (bindHost === "localhost") {
        trustedOrigins.add(`http://127.0.0.1:${boundPort}`);
      }
    }

    if (options.parentWatchdog) {
      const stream = options.watchdogStream ?? process.stdin;
      let triggered = false;
      const onWatchdogEof = () => {
        if (triggered) return;
        triggered = true;
        options.onWatchdogTrigger?.();
        void close({ emergency: false, stopCores: true });
      };
      stream.on("end", onWatchdogEof);
      stream.on("close", onWatchdogEof);
      stream.resume();
      detachWatchdog = () => {
        stream.off("end", onWatchdogEof);
        stream.off("close", onWatchdogEof);
      };
    }

    await writeRuntimeFileAtomic(runtimeFilePath, {
      pid: process.pid,
      socketPath,
      wsUrl,
      authMode,
      startedAt,
      home,
    });
    runtimeWritten = true;
  } catch (error) {
    await close({ emergency: true, stopCores: true });
    throw error;
  }

  return {
    pid: process.pid,
    home,
    socketPath,
    wsUrl,
    url,
    host: displayHost,
    port: boundPort,
    authMode,
    devMode,
    runtimeFilePath,
    startedAt,
    ...(staticDir ? { staticDir } : {}),
    supervisor,
    eventHub,
    router,
    worker,
    closed: closedDeferred.promise,
    waitForExit: () => closedDeferred.promise,
    close,
  };
}
