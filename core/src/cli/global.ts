import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  forgetWorkspace,
  listRegisteredWorkspaces,
  ludensHome,
  readGlobalConfig,
  readWorkspaceIdentity,
  registerWorkspace,
  renewWorkspaceIdentity,
  updateGlobalConfig,
  type LudensConfig,
  type ModelConnectionConfig,
} from "@ludens/protocol/ludens";
import { ludensSocketPath } from "../daemon/background-jobs.ts";
import { withOperatorRpc, type RemoteConnectionConfig } from "./operator-rpc.ts";

export const GLOBAL_HELP = `Ludens settings and workspace registry:
ludens config [show] [--remote <url> --token <secret>]
ludens config set workspaceRoot <directory> [--remote <url> --token <secret>]
ludens config set defaults.<model|seconds|requests|compactionThreshold|dashboard|pet> <value> [--remote <url> --token <secret>]
ludens config set defaults.connection.<openaiWebsockets|cacheRetention|appendOnlyContext|imageUrls.enabled|imageUrls.backends> <value> [--remote <url> --token <secret>]
ludens workspace list [--remote <url> --token <secret>]
ludens workspace open <directory> [--new-id] [--remote <url> --token <secret>]
ludens workspace forget <id> [--remote <url> --token <secret>]
ludens workspace import <directory> [--legacy-state <directory>] [--previous-workspace <directory>]
ludens daemon <status|start|stop|restart>
ludens app-server [--listen <unix://PATH | ws://HOST:PORT>]... [--auth <none|token>] [--token <secret> | --token-env <VAR>] [--static-dir <dir>] [--trusted-origin <origin>] [--parent-watchdog]

LUDENS_HOME selects the global directory (default ~/.ludens).
LUDENS_REMOTE_URL / LUDENS_REMOTE_TOKEN target a remote app-server for operator CLI commands.
New workspaces use its configured workspaceRoot; existing workspace settings do not change.
open registers an existing workspace; forget clears its matching pet follow target and removes its registry entry.
forget keeps workspace files and services; if target cleanup fails, registration is retained.
--new-id makes a copied directory independent and starts a new session, retaining archived history.
import explicitly brings old workspace sessions and skill versions into the workspace.
Stop the workspace's host and Baseware before import or --new-id; the emulator can remain open.`;

function directory(value: string) {
  if (!value.trim()) throw new Error("Directory must not be empty");
  return resolve(value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value);
}

/** Read-only probe; never take over or stop a running workspace. */
async function assertInactive(workspace: string) {
  const hash = createHash("sha256").update(workspace).digest("hex").slice(0, 16);
  for (const service of ["core", "baseware"] as const) {
    const path = ludensSocketPath(service, hash);
    await new Promise<void>((accept, reject) => {
      const socket = connect(path);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Cannot confirm workspace is stopped: ${path}`));
      }, 1000);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.destroy();
        reject(new Error(`Workspace is running (${service}); stop its host and Baseware first.`));
      });
      socket.once("error", error => {
        clearTimeout(timer);
        socket.destroy();
        if (["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) accept();
        else reject(error);
      });
    });
  }
}

function buildConfigUpdate(config: LudensConfig, field: string, value: string): {
  mode: "root" | "connection" | "defaults";
  workspaceRoot?: string;
  connection?: Partial<ModelConnectionConfig>;
  defaults?: Record<string, unknown>;
  nextConfig: LudensConfig;
} {
  if (field === "workspaceRoot") {
    const nextRoot = directory(value);
    return {
      mode: "root",
      workspaceRoot: nextRoot,
      nextConfig: { ...config, workspaceRoot: nextRoot },
    };
  }
  if (field.startsWith("defaults.connection.")) {
    const subkey = field.slice("defaults.connection.".length);
    const current: Partial<ModelConnectionConfig> = { ...(config.defaults.connection ?? {}) };
    if (subkey === "openaiWebsockets" || subkey === "cacheRetention" || subkey === "appendOnlyContext") {
      (current as Record<string, unknown>)[subkey] = value;
    } else if (subkey === "imageUrls.enabled") {
      current.imageUrls = {
        ...current.imageUrls,
        enabled: value === "true" ? true : value === "false" ? false : (value as unknown as boolean),
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
      nextConfig: { ...config, defaults: { ...config.defaults, connection: current as ModelConnectionConfig } },
    };
  }
  if (field.startsWith("defaults.")) {
    const key = field.slice("defaults.".length);
    const nextDefaults: Record<string, unknown> = { ...config.defaults };
    if ((key === "serviceTier" || key === "effort") && value === "none") {
      delete nextDefaults[key];
      return {
        mode: "defaults",
        defaults: { [key]: null },
        nextConfig: { ...config, defaults: nextDefaults as LudensConfig["defaults"] },
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
    nextDefaults[key] = setting;
    return {
      mode: "defaults",
      defaults: { [key]: setting },
      nextConfig: { ...config, defaults: nextDefaults as LudensConfig["defaults"] },
    };
  }
  throw new Error(`Unknown global setting: ${field}`);
}

export async function globalCommand(
  command: string,
  args: string[],
  home = ludensHome(),
  remote?: RemoteConnectionConfig,
): Promise<void> {
  if (args.includes("--help")) {
    console.log(GLOBAL_HELP);
    return;
  }

  if (remote?.url) {
    await withOperatorRpc({ home, remote }, async client => {
      if (command === "config") {
        const [action = "show", field, value, ...extra] = args;
        const settings = (await client.call("workspaces/getSettings")) as {
          home: string;
          config: LudensConfig;
        };
        if (action === "show" && !field) {
          console.log(JSON.stringify({ home: settings.home, ...settings.config }, null, 2));
          return;
        }
        if (action !== "set" || !field || value === undefined || extra.length) {
          throw new Error("Use ludens config set <field> <value>");
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
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      const [action, ...rest] = args;
      if (action === "list" && !rest.length) {
        const settings = (await client.call("workspaces/getSettings")) as {
          workspaces?: unknown[];
        };
        console.log(JSON.stringify(settings.workspaces ?? [], null, 2));
        return;
      }
      if (action === "forget" && rest.length === 1) {
        await client.call("workspaces/mutate", { action: "remove", id: rest[0]! });
        console.log(JSON.stringify({ forgotten: rest[0] }));
        return;
      }
      if (action === "open" && rest.length === 1) {
        const opened = await client.call("workspaces/mutate", {
          action: "open",
          workspace: rest[0]!,
        });
        console.log(JSON.stringify(opened, null, 2));
        return;
      }
      if (action === "import") {
        throw new Error("workspace import must be executed locally on the host filesystem");
      }
      throw new Error("Use ludens workspace list | open <directory> | forget <id>");
    });
    return;
  }

  if (command === "config") {
    const [action = "show", field, value, ...extra] = args;
    if (action === "show" && !field) {
      console.log(JSON.stringify({ home, ...(await readGlobalConfig(home)) }, null, 2));
      return;
    }
    if (action !== "set" || !field || value === undefined || extra.length) {
      throw new Error("Use ludens config set <field> <value>");
    }
    const config = await updateGlobalConfig(current => {
      if (field === "workspaceRoot") return buildConfigUpdate(current, field, value).nextConfig;
      return buildConfigUpdate(current, field, value).nextConfig;
    }, home);
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  const [action, ...rest] = args;
  if (action === "list" && !rest.length) {
    console.log(JSON.stringify(await listRegisteredWorkspaces(home), null, 2));
    return;
  }
  if (action === "forget" && rest.length === 1) {
    await forgetWorkspace(rest[0]!, home);
    console.log(JSON.stringify({ forgotten: rest[0] }));
    return;
  }
  if (action !== "open" && action !== "import") {
    throw new Error("Use ludens workspace list | open <directory> | forget <id> | import <directory>");
  }
  const { positionals, values } = parseArgs({
    args: rest,
    allowPositionals: true,
    options:
      action === "open"
        ? { "new-id": { type: "boolean" } }
        : { "legacy-state": { type: "string" }, "previous-workspace": { type: "string" } },
  });
  if (positionals.length !== 1) throw new Error(`workspace ${action} requires one directory`);
  const workspace = await realpath(directory(positionals[0]!));
  let imported: unknown;
  if (action === "import") {
    // Import creates identity, so require an explicit workspace configuration.
    const config = JSON.parse(await readFile(join(workspace, "ludens.json"), "utf8"));
    if (!config || typeof config.driver !== "string" || !config.driver.trim()) {
      throw new Error("Workspace import requires ludens.json with a driver");
    }
    await assertInactive(workspace);
    const previousPath =
      typeof values["previous-workspace"] === "string"
        ? directory(values["previous-workspace"])
        : undefined;
    const previousWorkspace = previousPath
      ? await realpath(previousPath).catch(error => {
          if (error.code !== "ENOENT") throw error;
          return previousPath;
        })
      : undefined;
    if (previousWorkspace && previousWorkspace !== workspace) await assertInactive(previousWorkspace);
    const { importLegacyWorkspaceState } = await import("../core/agent-omp/workspace-session.ts");
    imported = await importLegacyWorkspaceState(workspace, {
      globalHome: home,
      ...(typeof values["legacy-state"] === "string"
        ? { legacyStateDir: directory(values["legacy-state"]) }
        : {}),
      ...(previousWorkspace ? { previousWorkspace } : {}),
    });
  } else {
    await readWorkspaceIdentity(workspace).catch(error => {
      if (error.code === "ENOENT") {
        throw new Error(
          "Workspace has no Ludens identity; use ludens workspace import <directory> for an existing workspace",
        );
      }
      throw error;
    });
    if (values["new-id"]) {
      await assertInactive(workspace);
      await renewWorkspaceIdentity(workspace, home);
    }
  }
  console.log(
    JSON.stringify(
      { ...(await registerWorkspace(workspace, home)), ...(imported ? { import: imported } : {}) },
      null,
      2,
    ),
  );
}
