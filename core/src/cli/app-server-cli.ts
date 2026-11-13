import { parseArgs } from "node:util";
import { startAppServer } from "../server/app-server.ts";

export const APP_SERVER_HELP = `App server:
ludens app-server [--host 127.0.0.1] [--port <0|1..65535>] [--static-dir <path>] [--trusted-origin <origin>] [--parent-watchdog]
ludens serve [--host 127.0.0.1] [--port <0|1..65535>] [--static-dir <path>] [--trusted-origin <origin>] [--parent-watchdog]

Starts the unified @ludens/core HTTP API and optional static frontend server.
Prints a single-line JSON readiness handshake to stdout once listening.
--port 0 binds an ephemeral loopback port.
--static-dir serves exported static UI assets (e.g. app/out) with SPA fallback.
--trusted-origin allows mutations from an explicit dev proxy origin (repeatable).
--parent-watchdog shuts down all supervised workspace jobs and exits 0 on stdin EOF.`;

export async function appServerCommand(args: string[], defaultHome?: string): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(APP_SERVER_HELP);
    return;
  }

  const { values } = parseArgs({
    args,
    options: {
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", short: "p", default: "3015" },
      "static-dir": { type: "string" },
      "trusted-origin": { type: "string", multiple: true },
      "parent-watchdog": { type: "boolean", default: false },
    },
    strict: true,
  });

  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("--port must be an integer between 0 and 65535");
  }

  let shuttingDown = false;
  const server = await startAppServer({
    host: values.host,
    port,
    ...(values["static-dir"] ? { staticDir: values["static-dir"] } : {}),
    ...(values["trusted-origin"]?.length ? { trustedOrigins: values["trusted-origin"] } : {}),
    ...(defaultHome ? { home: defaultHome } : {}),
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
      .close({ emergency: false })
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
    url: server.url,
    host: server.host,
    port: server.port,
    pid: process.pid,
    home: server.home,
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
