import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ModelConnectionConfig } from "@ludens/protocol/connection";
import type { LudensConfig } from "@ludens/protocol/workspaces";
import type { AppRpcClient } from "./app-rpc-client.ts";
import { withOperatorRpc, type OperatorRpcOptions } from "./operator-rpc.ts";

export const CONFIG_HELP = `Ludens configuration (RPC):
ludens config [show] [--remote <url> --token <secret>]
ludens config set workspaceRoot <directory> [--remote <url> --token <secret>]
ludens config set defaults.<model|serviceTier|effort|seconds|requests|compactionThreshold|dashboard|pet> <value> [--remote <url> --token <secret>]
ludens config set defaults.connection.<openaiWebsockets|cacheRetention|appendOnlyContext|imageUrls.enabled|imageUrls.backends> <value> [--remote <url> --token <secret>]

LUDENS_HOME selects the local daemon directory (default ~/.ludens).
LUDENS_REMOTE_URL / LUDENS_REMOTE_TOKEN target a remote ludens-server.`;

function expandDirectory(value: string): string {
  if (!value.trim()) throw new Error("Directory must not be empty");
  return resolve(
    value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value,
  );
}

export function buildConfigUpdate(
  config: LudensConfig,
  field: string,
  value: string,
): {
  mode: "root" | "connection" | "defaults";
  workspaceRoot?: string;
  connection?: Partial<ModelConnectionConfig>;
  defaults?: Record<string, unknown>;
} {
  if (field === "workspaceRoot") {
    return {
      mode: "root",
      workspaceRoot: expandDirectory(value),
    };
  }
  if (field.startsWith("defaults.connection.")) {
    const subkey = field.slice("defaults.connection.".length);
    const current: Partial<ModelConnectionConfig> = { ...(config.defaults.connection ?? {}) };
    if (
      subkey === "openaiWebsockets" ||
      subkey === "cacheRetention" ||
      subkey === "appendOnlyContext"
    ) {
      (current as Record<string, unknown>)[subkey] = value;
    } else if (subkey === "imageUrls.enabled") {
      current.imageUrls = {
        ...current.imageUrls,
        enabled:
          value === "true" ? true : value === "false" ? false : (value as unknown as boolean),
      };
    } else if (subkey === "imageUrls.backends") {
      const parsed = value.trim().startsWith("[")
        ? JSON.parse(value)
        : value
            .split(",")
            .map(s => s.trim())
            .filter(Boolean);
      current.imageUrls = { ...current.imageUrls, backends: parsed };
    } else {
      throw new Error(`Unknown global connection setting: ${field}`);
    }
    return {
      mode: "connection",
      connection: current,
    };
  }
  if (field.startsWith("defaults.")) {
    const key = field.slice("defaults.".length);
    if ((key === "serviceTier" || key === "effort") && value === "none") {
      return {
        mode: "defaults",
        defaults: { [key]: null },
      };
    }
    const setting = ["model", "serviceTier", "effort"].includes(key)
      ? value
      : ["pet", "dashboard"].includes(key)
        ? value === "true"
          ? true
          : value === "false"
            ? false
            : value
        : Number(value);
    return {
      mode: "defaults",
      defaults: { [key]: setting },
    };
  }
  throw new Error(`Unknown global setting: ${field}`);
}

export async function runConfigWithClient(
  client: AppRpcClient,
  args: string[],
  out: (line: string) => void = console.log,
): Promise<void> {
  if (args.includes("--help")) {
    out(CONFIG_HELP);
    return;
  }
  const [action = "show", field, value, ...extra] = args;
  const settings = (await client.call("workspaces/getSettings")) as {
    home: string;
    config: LudensConfig;
  };
  if (action === "show" && !field) {
    out(JSON.stringify({ home: settings.home, ...settings.config }, null, 2));
    return;
  }
  if (action !== "set" || !field || value === undefined || extra.length) {
    throw new Error("Use ludens config [show | set <field> <value>]");
  }
  const update = buildConfigUpdate(settings.config, field, value);
  const result =
    update.mode === "root"
      ? await client.call("workspaces/mutate", {
          action: "updateRoot",
          workspaceRoot: update.workspaceRoot!,
        })
      : update.mode === "connection"
        ? await client.call("workspaces/mutate", {
            action: "updateGlobalConnection",
            connection: update.connection!,
          })
        : await client.call("workspaces/mutate", {
            action: "updateGlobalDefaults",
            defaults: update.defaults!,
          });
  out(JSON.stringify(result, null, 2));
}

export async function configCommand(
  args: string[],
  rpcOptions: OperatorRpcOptions,
  out: (line: string) => void = console.log,
): Promise<void> {
  if (args.includes("--help")) {
    out(CONFIG_HELP);
    return;
  }
  await withOperatorRpc(rpcOptions, client => runConfigWithClient(client, args, out));
}
