import { resolve } from "node:path";
import { ludensHome } from "@ludens/protocol/ludens";
import { closeArchiveBuilds } from "../core/query/cold-build";
import { DashboardWorker } from "../core/query/dashboard-worker";
import { closeLogIndexes } from "../core/query/log-index";
import { getActiveWorkspaceSupervisor, setActiveWorkspaceSupervisor } from "../core/query/workspaces";
import { WorkspaceSupervisor } from "../daemon/supervisor";
import { handleApiRequest } from "./http-routes";
import { errorResponse, localRequest, normalizeOrigin } from "./local-request";
import { serveStaticFile } from "./static-files";

export interface StartAppServerOptions {
  host?: string;
  port?: number;
  staticDir?: string;
  trustedOrigins?: string[];
  parentWatchdog?: boolean;
  watchdogStream?: NodeJS.ReadableStream;
  onWatchdogTrigger?: () => void;
  home?: string;
  supervisor?: WorkspaceSupervisor;
  worker?: DashboardWorker;
}

export interface RunningAppServer {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly home: string;
  readonly staticDir?: string;
  readonly supervisor: WorkspaceSupervisor;
  readonly worker: DashboardWorker;
  readonly closed: Promise<void>;
  close(options?: { emergency?: boolean }): Promise<void>;
}

function normalizeLoopbackBindHost(rawHost: string): { bindHost: string; urlHost: string; displayHost: string } {
  const trimmed = rawHost.trim().toLowerCase();
  if (trimmed === "127.0.0.1") {
    return { bindHost: "127.0.0.1", urlHost: "127.0.0.1", displayHost: "127.0.0.1" };
  }
  if (trimmed === "localhost") {
    return { bindHost: "localhost", urlHost: "localhost", displayHost: "localhost" };
  }
  if (trimmed === "::1" || trimmed === "[::1]") {
    return { bindHost: "::1", urlHost: "[::1]", displayHost: "::1" };
  }
  throw new Error(`Refusing to bind app-server to non-loopback host: ${rawHost}`);
}

export async function startAppServer(options: StartAppServerOptions = {}): Promise<RunningAppServer> {
  const { bindHost, urlHost, displayHost } = normalizeLoopbackBindHost(options.host ?? "127.0.0.1");
  const requestedPort = options.port ?? 3015;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    throw new Error(`Invalid port: ${String(options.port)}`);
  }

  const home = resolve(options.home ?? ludensHome());
  const staticDir = options.staticDir ? resolve(options.staticDir) : undefined;
  const trustedOrigins = new Set<string>(
    (options.trustedOrigins ?? []).map(item => normalizeOrigin(item)).filter(Boolean),
  );

  const supervisor = options.supervisor ?? new WorkspaceSupervisor({ home });
  const ownsWorker = !options.worker;
  const worker =
    options.worker ??
    new DashboardWorker({
      env: { ...process.env, LUDENS_HOME: home },
    });

  setActiveWorkspaceSupervisor(supervisor);

  const closedDeferred = Promise.withResolvers<void>();
  let closingPromise: Promise<void> | undefined;

  let detachWatchdog: (() => void) | undefined;

  const close = (closeOptions: { emergency?: boolean } = {}): Promise<void> => {
    if (closingPromise) return closingPromise;
    const emergency = Boolean(closeOptions.emergency);
    closingPromise = (async () => {
      detachWatchdog?.();
      detachWatchdog = undefined;
      if (getActiveWorkspaceSupervisor() === supervisor) {
        setActiveWorkspaceSupervisor(null);
      }
      try {
        server.stop(emergency);
      } catch {}
      await Promise.allSettled([
        supervisor.shutdownAll({ emergency }),
        ownsWorker ? worker.close() : Promise.resolve(),
      ]);
      await Promise.allSettled([closeArchiveBuilds(), closeLogIndexes()]);
      try {
        server.stop(true);
      } catch {}
      closedDeferred.resolve();
    })();
    return closingPromise;
  };

  const requestShutdown = () => {
    setTimeout(() => {
      void close({ emergency: false });
    }, 15);
  };

  const server = Bun.serve({
    hostname: bindHost,
    port: requestedPort,
    idleTimeout: 120,
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        return handleApiRequest(request, url, {
          home,
          worker,
          supervisor,
          trustedOrigins,
          requestShutdown,
        });
      }
      try {
        localRequest(request, { mutation: false, trustedOrigins });
      } catch (error) {
        return errorResponse(error, 403);
      }
      if (staticDir) {
        return serveStaticFile(request, staticDir);
      }
      return Response.json({ error: "Not Found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
    },
  });

  if (options.parentWatchdog) {
    const stream = options.watchdogStream ?? process.stdin;
    let triggered = false;
    const onWatchdogEof = () => {
      if (triggered) return;
      triggered = true;
      options.onWatchdogTrigger?.();
      void close({ emergency: false });
    };
    stream.on("end", onWatchdogEof);
    stream.on("close", onWatchdogEof);
    stream.resume();
    detachWatchdog = () => {
      stream.off("end", onWatchdogEof);
      stream.off("close", onWatchdogEof);
    };
  }

  const boundPort = server.port;
  if (typeof boundPort !== "number") {
    await close({ emergency: true });
    throw new Error("app-server failed to bind a TCP port");
  }
  const url = `http://${urlHost}:${boundPort}`;

  return {
    url,
    host: displayHost,
    port: boundPort,
    home,
    ...(staticDir ? { staticDir } : {}),
    supervisor,
    worker,
    closed: closedDeferred.promise,
    close,
  };
}
