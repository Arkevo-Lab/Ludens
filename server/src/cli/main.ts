#!/usr/bin/env bun
import { ludensHome } from "@ludens/protocol/ludens";
import { runBackgroundJobCli } from "../daemon/process-manager.ts";
import { DAEMON_HELP, daemonCommand } from "./daemon-cli.ts";
import { SERVE_HELP, serveCommand } from "./serve-cli.ts";

const HELP = `ludens-server — Ludens Control Plane Server

${SERVE_HELP}

${DAEMON_HELP}`;

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === "--help" || args[0] === "-h") {
    console.log(HELP);
    return;
  }

  if (args[0] === "__supervise-job") {
    process.exitCode = await runBackgroundJobCli(["--supervise", ...args.slice(1)]);
    return;
  }

  const home = ludensHome();
  if (args[0] === "serve") {
    await serveCommand(args.slice(1), home);
    return;
  }
  if (["start", "stop", "restart", "status"].includes(args[0]!)) {
    await daemonCommand(args, home);
    return;
  }

  throw new Error(`Unknown command '${args[0]}'; see ludens-server --help`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
