import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { ludensHome } from "@ludens/protocol/ludens";
import {
  ensureLocalAppDaemon,
  probeAppDaemon,
  readAppDaemonRuntime,
  resolveAppServerSocketPath,
  stopLocalAppDaemon,
} from "../daemon/app-daemon.ts";
import { parseListenSpecs, resolveAuthOptions } from "./app-server-cli.ts";

export const DAEMON_HELP = `Daemon control:
ludens daemon status
ludens daemon start [--listen <unix://PATH | ws://HOST:PORT>] [--auth <none|token>] [--token <secret> | --token-env <VAR>] [--static-dir <dir>] [--trusted-origin <origin>]
ludens daemon stop [--keep-cores | --stop-cores]
ludens daemon restart [--listen <unix://PATH | ws://HOST:PORT>] [--auth <none|token>] [--token <secret> | --token-env <VAR>] [--static-dir <dir>] [--trusted-origin <origin>] [--keep-cores]

Manages the shared local app-server UDS daemon for LUDENS_HOME (default ~/.ludens).`;

export async function daemonCommand(args: string[], defaultHome = ludensHome()): Promise<void> {
  if (!args.length || args.includes("--help") || args.includes("-h")) {
    console.log(DAEMON_HELP);
    return;
  }

  const [subcommand, ...rest] = args;
  const home = resolve(defaultHome);

  if (subcommand === "status") {
    const status = await probeAppDaemon(home);
    if (status) {
      console.log(JSON.stringify({ running: true, ...status }, null, 2));
      return;
    }
    const runtime = await readAppDaemonRuntime(home);
    console.log(
      JSON.stringify(
        {
          running: false,
          home,
          socketPath: resolveAppServerSocketPath(home),
          runtime,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (subcommand === "stop") {
    const { values } = parseArgs({
      args: rest,
      options: {
        "keep-cores": { type: "boolean", default: false },
        "stop-cores": { type: "boolean", default: false },
      },
      strict: true,
    });
    if (values["keep-cores"] && values["stop-cores"]) {
      throw new Error("Choose either --keep-cores or --stop-cores");
    }
    const stopCores = !values["keep-cores"];
    const result = await stopLocalAppDaemon(home, { stopCores });
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    return;
  }

  if (subcommand === "start" || subcommand === "restart") {
    const { values } = parseArgs({
      args: rest,
      options: {
        listen: { type: "string", multiple: true },
        auth: { type: "string" },
        token: { type: "string" },
        "token-env": { type: "string" },
        "static-dir": { type: "string" },
        "trusted-origin": { type: "string", multiple: true },
        "keep-cores": { type: "boolean", default: false },
      },
      strict: true,
    });

    const { unixSocketPath, wsListen } = parseListenSpecs(values.listen ?? []);
    if (unixSocketPath && unixSocketPath !== resolveAppServerSocketPath(home)) {
      throw new Error("daemon start uses the standard home UDS path; use app-server directly for custom unix:// paths");
    }
    const auth = resolveAuthOptions(values);

    if (subcommand === "restart") {
      await stopLocalAppDaemon(home, { stopCores: !values["keep-cores"] });
    }

    const ensured = await ensureLocalAppDaemon({
      home,
      ...(wsListen ? { wsListen } : {}),
      auth,
      ...(values["static-dir"] ? { staticDir: values["static-dir"] } : {}),
      ...(values["trusted-origin"]?.length ? { trustedOrigins: values["trusted-origin"] } : {}),
    });

    console.log(
      JSON.stringify(
        {
          ok: true,
          restarted: subcommand === "restart",
          started: ensured.started,
          ...ensured.status,
        },
        null,
        2,
      ),
    );
    return;
  }

  throw new Error(`Unknown daemon subcommand '${subcommand}'. Use status, start, stop, or restart.`);
}
