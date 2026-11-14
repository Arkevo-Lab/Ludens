import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { ManagedServiceTarget } from "@ludens/protocol/app-rpc";
import { defaultDriverCacheRoot, resolveDriver } from "@ludens/baseware/drivers/loader.ts";
import {
  ensureWorkspaceIdentity,
  ludensHome,
  readGlobalConfig,
  readMachinesConfig,
  readWorkspaceIdentity,
  registeredWorkspace,
  registerWorkspace,
  validateWorkspaceRegistration,
} from "@ludens/protocol/ludens";
import type { BasewareMachineSpec } from "@ludens/protocol/machines";
import workspaceGuide from "../../templates/AGENTS.md" with { type: "text" };
import perceptionTemplate from "../../templates/perception.py" with { type: "text" };
import { launchPlan, parseConfig, WorkspaceLauncher } from "../daemon/launcher.ts";
import {
  resolveWorkspaceTargetViaRpc,
  withOperatorRpc,
  type RemoteConnectionConfig,
} from "./operator-rpc.ts";

export const WORKSPACE_HELP = `Workspace startup:
ludens init --name <name> [--workspace <path>] --driver <id> [--driver-package <spec>] [--game <path>] [--cua-command <path>] [--model <id>] [--seconds <n>] [--requests <n>] [--pet | --no-pet]
ludens up [--dry-run] [--preempt] [--services <emulator,baseware,core>] [--dashboard | --no-dashboard] [--pet | --no-pet] [--remote <url> --token <secret>]
ludens services [--remote <url> --token <secret>]
ludens down [--keep-emulator] [--services <emulator,baseware,core>] [--dashboard] [--pet] [--remote <url> --token <secret>]

These commands use <workspace>/ludens.json locally or route through the shared app-server daemon.
init uses the configured workspaceRoot unless --workspace selects a directory.
An explicit directory does not require --name. Global defaults are copied at creation only.
New hosts start in manual standby; run ludens auto on to start Auto Run.
Desktop Pet is off by default. init --pet enables it in ludens.json.
up --pet or --no-pet overrides that setting for this launch without changing ludens.json.
--no-pet leaves any already running shared Desktop Pet open.
Repeated up reuses running services; down then up applies configuration changes.
down stops this workspace's managed host, Baseware and target emulator/process (persist unsaved target state first).
Use down --keep-emulator before changing host settings to keep the current target process running.
The shared Console stays up unless --dashboard is given by its owning workspace.
Desktop Pet is shared across workspaces; down --pet stops its managed background job.
A Desktop Pet opened separately is reused and stays open after down.
Choose which workspace Desktop Pet follows in the Console; up preserves that selection.
up / down / services connect over app-server.sock so CLI and Desktop share one WorkspaceSupervisor.
--remote <url> (or LUDENS_REMOTE_URL) and --token <secret> (or LUDENS_REMOTE_TOKEN) operate on a remote app-server.
The driver manifest decides the bridge port, backend startup and preparation hints; see baseware driver list.`;

function parseServicesOption(raw: string | undefined): ManagedServiceTarget[] | undefined {
  if (!raw) return undefined;
  const items = raw
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
  if (items.length === 0) return undefined;
  for (const item of items) {
    if (item !== "emulator" && item !== "baseware" && item !== "core" && item !== "host") {
      throw new Error(`Invalid service '${item}'; expected emulator, baseware, or core`);
    }
  }
  return items as ManagedServiceTarget[];
}

export async function workspaceCommand(
  command: string,
  args: string[],
  selectedWorkspace: string,
  explicitWorkspace = false,
  home = ludensHome(),
  remote?: RemoteConnectionConfig,
): Promise<void> {
  if (args.includes("--help")) {
    console.log(WORKSPACE_HELP);
    return;
  }

  const { values } = parseArgs({
    args,
    options:
      command === "init"
        ? {
            driver: { type: "string" },
            "driver-package": { type: "string" },
            game: { type: "string" },
            "cua-command": { type: "string" },
            seconds: { type: "string" },
            requests: { type: "string" },
            model: { type: "string" },
            name: { type: "string" },
            workspace: { type: "string" },
            pet: { type: "boolean" },
            "no-pet": { type: "boolean" },
          }
        : command === "up"
          ? {
              "dry-run": { type: "boolean" },
              preempt: { type: "boolean" },
              services: { type: "string" },
              dashboard: { type: "boolean" },
              "no-dashboard": { type: "boolean" },
              pet: { type: "boolean" },
              "no-pet": { type: "boolean" },
            }
          : command === "down"
            ? {
                dashboard: { type: "boolean" },
                pet: { type: "boolean" },
                "keep-emulator": { type: "boolean" },
                services: { type: "string" },
              }
            : {},
  });

  if (values.pet && values["no-pet"]) throw new Error("Choose either --pet or --no-pet");
  if (values.dashboard && values["no-dashboard"]) {
    throw new Error("Choose either --dashboard or --no-dashboard");
  }

  if (command === "init") {
    if (values.name !== undefined && (typeof values.name !== "string" || !values.name.trim() || /[\\/\x00]/.test(values.name) || [".", ".."].includes(values.name))) {
      throw new Error("--name must be a single non-empty directory name");
    }
    if (typeof values.workspace === "string" && explicitWorkspace && resolve(values.workspace) !== resolve(selectedWorkspace)) {
      throw new Error("Choose one --workspace directory");
    }
    if (typeof values.driver !== "string" || !values.driver.trim()) {
      throw new Error("init requires --driver <id>");
    }

    if (remote?.url) {
      if (typeof values.name !== "string" || !values.name.trim()) {
        throw new Error("Remote init requires --name <name>");
      }
      const remoteName = values.name.trim();
      const driverName = values.driver.trim();
      const created = await withOperatorRpc({ home, remote }, client =>
        client.call("workspaces/mutate", {
          action: "create",
          input: {
            name: remoteName,
            driver: driverName,
            ...(typeof values.workspace === "string" ? { workspace: values.workspace } : {}),
            ...(typeof values["driver-package"] === "string" ? { driverPackage: values["driver-package"] } : {}),
            ...(typeof values.game === "string" ? { game: values.game } : {}),
            ...(typeof values["cua-command"] === "string" ? { cuaCommand: values["cua-command"] } : {}),
          },
        }),
      );
      console.log(JSON.stringify(created, null, 2));
      return;
    }

    const global = await readGlobalConfig(home);
    const directory =
      typeof values.workspace === "string"
        ? resolve(values.workspace)
        : explicitWorkspace
          ? resolve(selectedWorkspace)
          : typeof values.name === "string"
            ? join(global.workspaceRoot, values.name)
            : undefined;
    if (!directory) {
      throw new Error("Use --name to create under the default workspaceRoot, or --workspace <path> to select a directory");
    }
    await mkdir(directory, { recursive: true });
    const workspace = await realpath(directory);
    const packageSpec = typeof values["driver-package"] === "string" ? values["driver-package"] : undefined;
    const raw = {
      ...global.defaults,
      driver: values.driver,
      ...(packageSpec ? { driverPackage: packageSpec } : {}),
      ...(values.game ? { game: values.game } : {}),
      ...(values["cua-command"] ? { cuaCommand: values["cua-command"] } : {}),
      ...(values.seconds ? { seconds: Number(values.seconds) } : {}),
      ...(values.requests ? { requests: Number(values.requests) } : {}),
      ...(values.model ? { model: values.model } : {}),
      ...(values.pet || values["no-pet"] ? { pet: Boolean(values.pet) } : {}),
    };
    const resolvedPackage = packageSpec?.startsWith("file:")
      ? `file:${resolve(workspace, packageSpec.slice(5))}`
      : packageSpec;
    const manifest = await resolveDriver(raw.driver as string, resolvedPackage, defaultDriverCacheRoot());
    const config = parseConfig(raw, manifest);
    await writeFile(join(workspace, "ludens.json"), `${JSON.stringify(config, null, 2)}\n`, { flag: "wx" });
    await writeFile(join(workspace, "AGENTS.md"), workspaceGuide, { flag: "wx" }).catch(error => {
      if (error.code !== "EEXIST") throw error;
    });
    await writeFile(join(workspace, "perception.py"), perceptionTemplate, { flag: "wx" }).catch(error => {
      if (error.code !== "EEXIST") throw error;
    });
    await ensureWorkspaceIdentity(workspace);
    const entry = await registerWorkspace(workspace, home);
    console.log(JSON.stringify({ ...entry, configPath: join(workspace, "ludens.json") }, null, 2));
    return;
  }

  if (remote?.url) {
    if (values["dry-run"]) {
      throw new Error("--dry-run cannot be used with --remote");
    }
    await withOperatorRpc({ home, remote }, async client => {
      const target = await resolveWorkspaceTargetViaRpc(client, selectedWorkspace, explicitWorkspace);
      if (command === "services") {
        const studio = await client.call("workspaces/getStudio", { workspaceId: target.id });
        console.log(JSON.stringify({ workspaceId: target.id, ...studio }, null, 2));
        return;
      }
      const services = parseServicesOption(typeof values.services === "string" ? values.services : undefined);
      const res = (await client.call("workspaces/serviceControl", {
        workspaceId: target.id,
        action: command === "up" ? "up" : "down",
        ...(services ? { services } : {}),
        ...(command === "up" && values.preempt ? { preempt: true } : {}),
        ...(command === "down" && values["keep-emulator"] ? { keepEmulator: true } : {}),
      })) as { ok: boolean; exitCode: number; stdout: string; stderr: string; studio: unknown };
      if (res.stderr) console.error(res.stderr);
      if (!res.ok) throw new Error(res.stderr || `Workspace ${command} failed with exit code ${res.exitCode}`);
      console.log(res.stdout || JSON.stringify(res.studio, null, 2));
    });
    return;
  }

  const workspace = await realpath(selectedWorkspace);
  let registrationId: string | undefined;
  if (command === "up") {
    try {
      if (values["dry-run"]) {
        await validateWorkspaceRegistration(workspace, home);
      } else {
        const entry = await registerWorkspace(workspace, home);
        registrationId = entry.id;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          "Workspace identity is missing. Use ludens init for a new workspace, or ludens workspace import <path> for an existing workspace.",
        );
      }
      throw error;
    }
  }

  if (command === "up" && values["dry-run"]) {
    const raw = JSON.parse(await readFile(join(workspace, "ludens.json"), "utf8")) as Record<string, unknown>;
    if (typeof raw.driverPackage === "string" && raw.driverPackage.startsWith("file:")) {
      raw.driverPackage = `file:${resolve(workspace, raw.driverPackage.slice(5))}`;
    }
    let manifest = await resolveDriver(String(raw.driver ?? "cua"), raw.driverPackage as string | undefined, defaultDriverCacheRoot());
    const config = parseConfig(raw, manifest);
    if (values.pet || values["no-pet"]) config.pet = Boolean(values.pet);
    if (values.dashboard || values["no-dashboard"]) config.dashboard = Boolean(values.dashboard);
    let activeMachine: BasewareMachineSpec | undefined;
    if (config.machines?.active && config.machines.active !== "workspace-default") {
      const registry = await readMachinesConfig(home);
      const found = registry.machines.find(item => item.id === config.machines!.active);
      if (!found) throw new Error(`Unknown Baseware machine in machines.active: ${config.machines.active}`);
      activeMachine = found;
      const pkg = found.driverPackage?.startsWith("file:")
        ? `file:${resolve(workspace, found.driverPackage.slice(5))}`
        : found.driverPackage;
      manifest = await resolveDriver(found.driver, pkg, defaultDriverCacheRoot());
    }
    const plan = await launchPlan(config, workspace, resolve(import.meta.dir, "../../.."), undefined, manifest, activeMachine);
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  if (!registrationId) {
    try {
      const identity = await readWorkspaceIdentity(workspace);
      await registeredWorkspace(identity.id, home);
      registrationId = identity.id;
    } catch {
      registrationId = undefined;
    }
  }

  // Route `up`, `down`, and `services` locally through the shared app-server UDS daemon
  // so CLI and Electron Desktop operate on a single WorkspaceSupervisor and device lock.
  if (registrationId) {
    const targetId = registrationId;
    const services = parseServicesOption(typeof values.services === "string" ? values.services : undefined);
    await withOperatorRpc({ home }, async client => {
      if (command === "services") {
        const studio = await client.call("workspaces/getStudio", { workspaceId: targetId });
        console.log(JSON.stringify({ workspaceId: targetId, ...studio }, null, 2));
        return;
      }
      const res = (await client.call("workspaces/serviceControl", {
        workspaceId: targetId,
        action: command === "up" ? "up" : "down",
        ...(services ? { services } : {}),
        ...(command === "up" && values.preempt ? { preempt: true } : {}),
        ...(command === "down" && values["keep-emulator"] ? { keepEmulator: true } : {}),
      })) as { ok: boolean; exitCode: number; stdout: string; stderr: string; studio: unknown };
      if (res.stderr) console.error(res.stderr);
      if (!res.ok) throw new Error(res.stderr || `Workspace ${command} failed with exit code ${res.exitCode}`);
      console.log(res.stdout || JSON.stringify(res.studio, null, 2));
    });
    return;
  }

  // Fallback for unregistered standalone directories on `down` / `services`.
  const manifest = await resolveDriver("cua", undefined, defaultDriverCacheRoot());
  const config = parseConfig({ driver: "cua" }, manifest);
  const plan = await launchPlan(config, workspace, resolve(import.meta.dir, "../../.."), undefined, manifest);
  const launcher = new WorkspaceLauncher(plan);
  const result =
    command === "down"
      ? await launcher.down(Boolean(values.dashboard), Boolean(values["keep-emulator"]), Boolean(values.pet))
      : await launcher.status();
  console.log(JSON.stringify(result, null, 2));
}
