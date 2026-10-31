import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { resolveDriver, defaultDriverCacheRoot } from "@ludens/baseware/drivers/loader.ts";
import workspaceGuide from "../../templates/AGENTS.md" with { type: "text" };
import perceptionTemplate from "../../templates/perception.py" with { type: "text" };
import actionTemplate from "../../templates/action.py" with { type: "text" };
import { ensureWorkspaceIdentity, readGlobalConfig, registerWorkspace, validateWorkspaceRegistration } from "@ludens/protocol/ludens";
import { parseConfig, launchPlan, WorkspaceLauncher } from "../daemon/launcher.ts";

export const WORKSPACE_HELP = `Workspace startup (macOS):
rsa init --name <name> [--workspace <path>] --driver <id> [--driver-package <spec>] [--game <path>] [--cua-command <path>] [--model <id>] [--seconds <n>] [--requests <n>] [--pet | --no-pet]
rsa up [--dry-run] [--pet | --no-pet]
rsa services
rsa down [--keep-emulator] [--dashboard] [--pet]

These commands use <workspace>/rsa.json. Paths are relative to that workspace.
init uses the configured workspaceRoot unless --workspace selects a directory.
An explicit directory does not require --name. Global defaults are copied at creation only.
New hosts start in manual mode; use rsa auto on to let the agent act.
Ludens Pet is off by default. init --pet enables it in rsa.json.
up --pet or --no-pet overrides that setting for this launch without changing rsa.json.
--no-pet leaves any already running shared Pet open.
Repeated up reuses running services; down then up applies configuration changes.
down stops this workspace's managed host, Baseware and emulator (save your game first).
Use down --keep-emulator before changing host settings to preserve the current game.
The shared Dashboard stays up unless --dashboard is given by its owning workspace.
Ludens Pet is shared across workspaces; down --pet stops its managed background job.
A Ludens Pet app opened separately is reused and stays open after down.
Choose which workspace Ludens Pet follows in the Dashboard; up preserves that selection.
The driver manifest decides the bridge port, backend startup and preparation hints; see baseware driver list.`;

export async function workspaceCommand(command: string, args: string[], selectedWorkspace: string, explicitWorkspace = false) {
  if (args.includes("--help")) { console.log(WORKSPACE_HELP); return; }
  const { values } = parseArgs({ args, options: command === "init" ? {
    driver: { type: "string" }, "driver-package": { type: "string" }, game: { type: "string" },
    "cua-command": { type: "string" }, seconds: { type: "string" }, requests: { type: "string" }, model: { type: "string" },
    name: { type: "string" }, workspace: { type: "string" }, pet: { type: "boolean" }, "no-pet": { type: "boolean" },
  } : command === "up" ? { "dry-run": { type: "boolean" }, pet: { type: "boolean" }, "no-pet": { type: "boolean" } }
    : command === "down" ? { dashboard: { type: "boolean" }, pet: { type: "boolean" }, "keep-emulator": { type: "boolean" } } : {} });
  if (values.pet && values["no-pet"]) throw new Error("Choose either --pet or --no-pet");
  if (command === "init") {
    const global = await readGlobalConfig();
    if (values.name !== undefined && (typeof values.name !== "string" || !values.name.trim() || /[\\/\x00]/.test(values.name) || [".", ".."].includes(values.name))) {
      throw new Error("--name must be a single non-empty directory name");
    }
    if (typeof values.workspace === "string" && explicitWorkspace && resolve(values.workspace) !== resolve(selectedWorkspace)) {
      throw new Error("Choose one --workspace directory");
    }
    const directory = typeof values.workspace === "string" ? resolve(values.workspace) : explicitWorkspace ? resolve(selectedWorkspace)
      : typeof values.name === "string" ? join(global.workspaceRoot, values.name) : undefined;
    if (!directory) throw new Error("Use --name to create under the default workspaceRoot, or --workspace <path> to select a directory");
    if (typeof values.driver !== "string" || !values.driver.trim()) throw new Error("init requires --driver <id>");
    await mkdir(directory, { recursive: true });
    const workspace = await realpath(directory);
    const packageSpec = typeof values["driver-package"] === "string" ? values["driver-package"] : undefined;
    const raw = { ...global.defaults, driver: values.driver,
      ...(packageSpec ? { driverPackage: packageSpec } : {}),
      ...(values.game ? { game: values.game } : {}), ...(values["cua-command"] ? { cuaCommand: values["cua-command"] } : {}),
      ...(values.seconds ? { seconds: Number(values.seconds) } : {}), ...(values.requests ? { requests: Number(values.requests) } : {}),
      ...(values.model ? { model: values.model } : {}), ...(values.pet || values["no-pet"] ? { pet: Boolean(values.pet) } : {}) };
    const resolvedPackage = packageSpec?.startsWith("file:") ? `file:${resolve(workspace, packageSpec.slice(5))}` : packageSpec;
    const manifest = await resolveDriver(raw.driver as string, resolvedPackage, defaultDriverCacheRoot());
    const config = parseConfig(raw, manifest);
    await writeFile(join(workspace, "rsa.json"), `${JSON.stringify(config, null, 2)}\n`, { flag: "wx" });
    await writeFile(join(workspace, "AGENTS.md"), workspaceGuide, { flag: "wx" }).catch(error => { if (error.code !== "EEXIST") throw error; });
    await writeFile(join(workspace, "perception.py"), perceptionTemplate, { flag: "wx" }).catch(error => { if (error.code !== "EEXIST") throw error; });
    await writeFile(join(workspace, "action.py"), actionTemplate, { flag: "wx" }).catch(error => { if (error.code !== "EEXIST") throw error; });
    await ensureWorkspaceIdentity(workspace);
    const entry = await registerWorkspace(workspace);
    console.log(JSON.stringify({ ...entry, configPath: join(workspace, "rsa.json") }, null, 2));
    return;
  }
  const workspace = await realpath(selectedWorkspace);
  if (command === "up") {
    // Reject missing identities and conflicting copies before package discovery or device startup.
    try {
      if (values["dry-run"]) await validateWorkspaceRegistration(workspace);
      else await registerWorkspace(workspace);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("Workspace identity is missing. Use rsa init for a new workspace, or rsa workspace import <path> for an existing workspace.");
      }
      throw error;
    }
  }
  // Status and shutdown remain available even if the launch config was removed or edited badly.
  const raw = command === "up" ? await Bun.file(join(workspace, "rsa.json")).json() : { driver: "cua" };
  if (typeof raw.driverPackage === "string" && raw.driverPackage.startsWith("file:")) raw.driverPackage = `file:${resolve(workspace, raw.driverPackage.slice(5))}`;
  const manifest = await resolveDriver(raw.driver, raw.driverPackage, defaultDriverCacheRoot());
  const config = parseConfig(raw, manifest);
  if (command === "up" && (values.pet || values["no-pet"])) config.pet = Boolean(values.pet);
  const plan = await launchPlan(config, workspace, resolve(import.meta.dir, "../../.."), undefined, manifest);
  if (values["dry-run"]) { console.log(JSON.stringify(plan, null, 2)); return; }
  if (process.platform !== "darwin") throw new Error("Workspace service commands currently use macOS launchd");
  if (command === "up") {
    const repo = resolve(import.meta.dir, "../../..");
    const required = [
      ...(config.game && manifest.launchCommand ? [resolve(workspace, config.game)] : []),
      ...(config.dashboard ? [join(repo, "app/node_modules/next/package.json")] : []),
      ...(config.pet ? [join(repo, "app/dist/electron/main.js"), join(repo, "app/node_modules/electron/package.json")] : []),
    ];
    for (const path of required) if (!await Bun.file(path).exists()) throw new Error(`Missing ${path}. Install/build the components as described in README.md.`);
    const executable = config.game ? manifest.launchCommand?.[0] : undefined;
    if (executable && !Bun.which(executable, { cwd: workspace })) throw new Error(`Missing executable ${executable}. Install/build the components as described in README.md.`);
  }
  const launcher = new WorkspaceLauncher(plan);
  const result = command === "up" ? await launcher.up() : command === "down"
    ? await launcher.down(Boolean(values.dashboard), Boolean(values["keep-emulator"]), Boolean(values.pet)) : await launcher.status();
  console.log(JSON.stringify(result, null, 2));
}
