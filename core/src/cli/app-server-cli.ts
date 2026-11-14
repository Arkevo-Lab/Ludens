import { parseArgs } from "node:util";
import { ludensHome } from "@ludens/protocol/ludens";
import {
  startAppServer,
  type AppServerAuthOptions,
  type WsListenOptions,
} from "../server/app-server.ts";

export const APP_SERVER_HELP = `App server:
ludens app-server [--listen <unix://PATH | ws://HOST:PORT>]... [--auth <none|token>] [--token <secret> | --token-env <VAR>] [--static-dir <dir>] [--trusted-origin <origin>] [--parent-watchdog]
ludens serve [--listen <unix://PATH | ws://HOST:PORT>]... [--auth <none|token>] [--token <secret> | --token-env <VAR>] [--static-dir <dir>] [--trusted-origin <origin>] [--parent-watchdog]

Starts the unified @ludens/core JSON-RPC 2.0 App Server and optional static frontend server.
Default with no --listen binds Unix Domain Socket only (0 TCP ports).
Prints a single-line JSON readiness handshake to stdout once listening.
--listen unix://PATH overrides the UDS socket path; ws://HOST:PORT enables HTTP + WebSocket /rpc (repeatable).
--auth <none|token> selects WebSocket authentication mode (required when ws:// binds a non-loopback host).
--token / --token-env <VAR> supplies the authentication secret.
--static-dir serves exported static UI assets (e.g. app/out) with SPA fallback.
--trusted-origin allows browser Origin access in none auth mode (repeatable).
--parent-watchdog shuts down all supervised workspace jobs and exits 0 on stdin EOF.`;

export function parseListenSpecs(specs: readonly string[]): {
  unixSocketPath?: string;
  wsListen?: WsListenOptions | null;
} {
  let unixSocketPath: string | undefined;
  let wsListen: WsListenOptions | null | undefined;

  for (const raw of specs) {
    const spec = raw.trim();
    if (!spec) throw new Error("--listen value must not be empty");
    if (spec.startsWith("unix://")) {
      const path = spec.slice("unix://".length);
      if (!path) throw new Error(`Invalid unix:// --listen path: ${spec}`);
      if (unixSocketPath !== undefined) {
        throw new Error("Only one unix:// --listen listener may be specified");
      }
      unixSocketPath = path;
      continue;
    }
    if (spec.startsWith("ws://")) {
      let parsed: URL;
      try {
        parsed = new URL(spec);
      } catch {
        throw new Error(`Invalid ws:// --listen URL: ${spec}`);
      }
      if (!parsed.hostname) {
        throw new Error(`ws:// --listen requires a host: ${spec}`);
      }
      const portStr = parsed.port;
      if (portStr === "") {
        throw new Error(`ws:// --listen requires an explicit port (use :0 for ephemeral): ${spec}`);
      }
      const port = Number(portStr);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`Invalid port in --listen: ${spec}`);
      }
      if (wsListen) {
        throw new Error("Only one ws:// --listen listener may be specified");
      }
      wsListen = {
        host: parsed.hostname.replace(/^\[|\]$/g, ""),
        port,
      };
      continue;
    }
    throw new Error(`Unsupported --listen scheme '${spec}'; expected unix://PATH or ws://HOST:PORT`);
  }

  return {
    ...(unixSocketPath !== undefined ? { unixSocketPath } : {}),
    ...(wsListen !== undefined ? { wsListen } : {}),
  };
}

export function resolveAuthOptions(values: {
  auth?: string;
  token?: string;
  "token-env"?: string;
}): AppServerAuthOptions {
  if (values.token !== undefined && values["token-env"] !== undefined) {
    throw new Error("Choose either --token or --token-env, not both");
  }
  let token = values.token;
  if (values["token-env"] !== undefined) {
    const envVar = values["token-env"].trim();
    if (!envVar) throw new Error("--token-env requires an environment variable name");
    token = process.env[envVar];
    if (!token) {
      throw new Error(`Environment variable '${envVar}' specified by --token-env is unset or empty`);
    }
  }

  const rawAuth = values.auth;
  if (rawAuth !== undefined && rawAuth !== "none" && rawAuth !== "token") {
    throw new Error("--auth must be 'none' or 'token'");
  }
  const mode: "none" | "token" = rawAuth ?? (token !== undefined ? "token" : "none");
  if (mode === "none" && token !== undefined) {
    throw new Error("--token / --token-env cannot be combined with --auth none");
  }
  if (mode === "token" && (!token || token.length === 0)) {
    throw new Error("--auth token requires --token <secret> or --token-env <VAR>");
  }

  return token !== undefined ? { mode, token } : { mode };
}

export async function appServerCommand(args: string[], defaultHome = ludensHome()): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(APP_SERVER_HELP);
    return;
  }

  const { values } = parseArgs({
    args,
    options: {
      listen: { type: "string", multiple: true },
      auth: { type: "string" },
      token: { type: "string" },
      "token-env": { type: "string" },
      "static-dir": { type: "string" },
      "trusted-origin": { type: "string", multiple: true },
      "parent-watchdog": { type: "boolean", default: false },
    },
    strict: true,
  });

  const { unixSocketPath, wsListen } = parseListenSpecs(values.listen ?? []);
  const auth = resolveAuthOptions(values);

  let shuttingDown = false;
  const server = await startAppServer({
    home: defaultHome,
    ...(unixSocketPath !== undefined ? { unixSocketPath } : {}),
    ...(wsListen !== undefined ? { wsListen } : { wsListen: null }),
    auth,
    ...(values["static-dir"] ? { staticDir: values["static-dir"] } : {}),
    ...(values["trusted-origin"]?.length ? { trustedOrigins: values["trusted-origin"] } : {}),
    parentWatchdog: false,
  });

  const gracefulShutdownAndExit = (exitCode: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const hardTimer = setTimeout(() => {
      void server.supervisor
        .shutdownAll({ emergency: true })
        .finally(() => process.exit(exitCode));
    }, 4500);
    hardTimer.unref?.();
    void server
      .close({ emergency: false, stopCores: true })
      .finally(() => {
        clearTimeout(hardTimer);
        process.exit(exitCode);
      });
  };

  if (values["parent-watchdog"]) {
    const onStdinClosed = () => gracefulShutdownAndExit(0);
    process.stdin.once("end", onStdinClosed);
    process.stdin.once("close", onStdinClosed);
    process.stdin.on("error", onStdinClosed);
    process.stdin.resume();
  }

  const onSigInt = () => gracefulShutdownAndExit(0);
  const onSigTerm = () => gracefulShutdownAndExit(0);
  process.once("SIGINT", onSigInt);
  process.once("SIGTERM", onSigTerm);

  const handshake = JSON.stringify({
    ready: true,
    pid: server.pid,
    home: server.home,
    socketPath: server.socketPath,
    wsUrl: server.wsUrl,
    url: server.url,
    host: server.host,
    port: server.port,
    authMode: server.authMode,
  });
  await new Promise<void>(resolveWrite => {
    process.stdout.write(`${handshake}\n`, () => resolveWrite());
  });

  try {
    await server.closed;
  } finally {
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
  }
}
