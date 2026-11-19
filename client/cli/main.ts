#!/usr/bin/env bun
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ludensHome } from "@ludens/protocol/ludens";
import { CONFIG_HELP, configCommand } from "./config.ts";
import { CONTROL_HELP, controlCommand } from "./control.ts";
import { LOG_HELP, logsCommand } from "./logs.ts";
import {
  extractRemoteArgs,
  type OperatorRpcOptions,
  type RemoteConnectionConfig,
} from "./operator-rpc.ts";
import { WORKSPACE_HELP, workspaceCommand } from "./workspace.ts";

export const CLI_HELP = `Ludens pure-RPC operator CLI:

${CONFIG_HELP}

${WORKSPACE_HELP}

${CONTROL_HELP}

${LOG_HELP}

Global flags:
  --workspace <id|path>  Target workspace (overrides LUDENS_WORKSPACE / cwd)
  --remote <ws(s)://...> Target remote ludens-server (overrides LUDENS_REMOTE_URL)
  --token <secret>       Bearer token for remote ludens-server (overrides LUDENS_REMOTE_TOKEN)

Notes:
  - Server lifecycle commands live in 'ludens-server <serve|start|stop|restart|status>'.
  - Core execution & in-sandbox tools live in 'ludens-core <run|controller|perception|event|machine|eval>'.`;

const CONTROL_COMMANDS = new Set(["status", "auto", "steer", "consolidate", "stop", "model"]);

export interface RunCliOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  rpcOptions?: Omit<OperatorRpcOptions, "home" | "remote">;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

export async function runCli(argv: readonly string[], options: RunCliOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const out = options.out ?? console.log;
  const err = options.err ?? console.error;
  const args = [...argv];

  let selectedWorkspace = env.LUDENS_WORKSPACE?.trim() || options.cwd || process.cwd();
  let explicitWorkspace = Boolean(env.LUDENS_WORKSPACE?.trim());
  let remoteUrl = env.LUDENS_REMOTE_URL?.trim() || undefined;
  let remoteToken = env.LUDENS_REMOTE_TOKEN?.trim() || undefined;

  while (args.length > 0 && args[0]!.startsWith("--") && args[0] !== "--help") {
    const flag = args[0]!;
    if (flag === "--workspace") {
      if (!args[1] || args[1].startsWith("--")) throw new Error("--workspace requires a path or ID");
      selectedWorkspace = args[1];
      explicitWorkspace = true;
      args.splice(0, 2);
      continue;
    }
    if (flag.startsWith("--workspace=")) {
      selectedWorkspace = flag.slice("--workspace=".length);
      if (!selectedWorkspace) throw new Error("--workspace requires a path or ID");
      explicitWorkspace = true;
      args.splice(0, 1);
      continue;
    }
    if (flag === "--remote") {
      if (!args[1] || args[1].startsWith("--")) throw new Error("--remote requires a URL");
      remoteUrl = args[1];
      args.splice(0, 2);
      continue;
    }
    if (flag.startsWith("--remote=")) {
      remoteUrl = flag.slice("--remote=".length);
      if (!remoteUrl) throw new Error("--remote requires a URL");
      args.splice(0, 1);
      continue;
    }
    if (flag === "--token") {
      if (args[1] === undefined || args[1].startsWith("--")) throw new Error("--token requires a secret");
      remoteToken = args[1];
      args.splice(0, 2);
      continue;
    }
    if (flag.startsWith("--token=")) {
      remoteToken = flag.slice("--token=".length);
      args.splice(0, 1);
      continue;
    }
    break;
  }

  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h") {
    out(CLI_HELP);
    return 0;
  }

  const remoteSeed: RemoteConnectionConfig | undefined = remoteUrl
    ? { url: remoteUrl, ...(remoteToken ? { token: remoteToken } : {}) }
    : undefined;

  const extractWorkspaceFlag = (input: string[]): string[] => {
    const cleaned: string[] = [];
    for (let i = 0; i < input.length; i++) {
      const arg = input[i]!;
      // Keep `--workspace` intact for `ludens workspace init --workspace <dir>`.
      if (command === "workspace" && input[0] === "init") {
        cleaned.push(arg);
        continue;
      }
      if (arg === "--workspace") {
        if (!input[i + 1] || input[i + 1]!.startsWith("--")) {
          throw new Error("--workspace requires a path or ID");
        }
        selectedWorkspace = input[++i]!;
        explicitWorkspace = true;
        continue;
      }
      if (arg.startsWith("--workspace=")) {
        const value = arg.slice("--workspace=".length);
        if (!value) throw new Error("--workspace requires a path or ID");
        selectedWorkspace = value;
        explicitWorkspace = true;
        continue;
      }
      cleaned.push(arg);
    }
    return cleaned;
  };

  const parsedRemote = extractRemoteArgs(rest, env);
  const remote = parsedRemote.remote ?? remoteSeed;
  const subArgs = extractWorkspaceFlag(parsedRemote.remaining);
  const home = ludensHome(env);
  const rpcOptions: OperatorRpcOptions = {
    ...options.rpcOptions,
    env,
    home,
    ...(remote ? { remote } : {}),
  };

  if (command === "config") {
    await configCommand(subArgs, rpcOptions, out);
    return 0;
  }

  if (command === "workspace") {
    return workspaceCommand(subArgs, selectedWorkspace, explicitWorkspace, rpcOptions, { out, err });
  }

  if (command === "logs") {
    await logsCommand(subArgs, selectedWorkspace, explicitWorkspace, rpcOptions, { out });
    return 0;
  }

  if (CONTROL_COMMANDS.has(command)) {
    await controlCommand([command, ...subArgs], selectedWorkspace, explicitWorkspace, rpcOptions, out);
    return 0;
  }

  throw new Error(
    `Unknown command '${command}'. Use 'ludens config', 'ludens workspace <subcommand>', 'ludens <status|auto|steer|consolidate|stop|model|logs>', or see 'ludens --help'.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2))
    .then(code => {
      if (code !== 0) process.exitCode = code;
    })
    .catch(error => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
