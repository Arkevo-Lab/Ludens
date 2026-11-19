import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type {
  CreateWorkspaceInputDto,
  ManagedServiceTarget,
} from "@ludens/protocol/app-rpc";
import type { WorkspaceServiceControlResult } from "@ludens/protocol/workspaces";
import type { AppRpcClient } from "./app-rpc-client.ts";
import {
  resolveWorkspaceTargetViaRpc,
  withOperatorRpc,
  type OperatorRpcOptions,
} from "./operator-rpc.ts";

export const WORKSPACE_HELP = `Ludens workspace management & evaluations (RPC):
ludens workspace init --name <name> [--workspace <path>] [--machine <id>] [--driver <id>] [--driver-package <spec>] [--game <path>] [--port <n>] [--cua-command <path>] [--model <id>] [--effort <level>] [--service-tier <tier>] [--seconds <n>] [--requests <n>] [--register-driver] [--pet | --no-pet]
ludens workspace list
ludens workspace open <directory> [--new-id]
ludens workspace forget <id>
ludens workspace import <directory> [--legacy-state <directory>] [--previous-workspace <directory>]
ludens workspace up [--preempt] [--services <emulator,baseware,core>]
ludens workspace down [--keep-emulator] [--services <emulator,baseware,core>]
ludens workspace services
ludens workspace eval list
ludens workspace eval run [<capability-id>] [--all]
ludens workspace eval history [<capability-id>] [--limit <n>]
ludens workspace eval adapt <capability-id> --reason <text> [--record <record-id> ...]
ludens workspace eval <capability-id>

All subcommands support --workspace <id|path>, --remote <url>, and --token <secret>.`;

export const WORKSPACE_EVAL_HELP = `Ludens workspace capability evaluations (RPC):
ludens workspace eval list
ludens workspace eval run [<capability-id>] [--all]
ludens workspace eval history [<capability-id>] [--limit <n>]
ludens workspace eval adapt <capability-id> --reason <text> [--record <record-id> ...]
ludens workspace eval <capability-id>`;

function expandDirectory(value: string): string {
  if (!value.trim()) throw new Error("Directory must not be empty");
  return resolve(
    value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value,
  );
}

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

export async function runWorkspaceEvalWithClient(
  client: AppRpcClient,
  args: string[],
  selectedWorkspace: string,
  explicitWorkspace: boolean,
  out: (line: string) => void = console.log,
): Promise<number> {
  if (!args.length || args[0] === "--help" || args.includes("--help")) {
    out(WORKSPACE_EVAL_HELP);
    return 0;
  }

  const [first, ...rest] = args;
  const subcommand =
    first === "list" || first === "run" || first === "history" || first === "adapt"
      ? first
      : first?.startsWith("python/")
        ? "run"
        : undefined;
  if (!subcommand) {
    throw new Error(`Unknown workspace eval subcommand '${first}'; see ludens workspace eval --help`);
  }

  const target = await resolveWorkspaceTargetViaRpc(client, selectedWorkspace, explicitWorkspace);
  const positionalArgs = subcommand === "run" && first !== "run" ? [first!, ...rest] : rest;

  if (subcommand === "list") {
    if (positionalArgs.length > 0) {
      throw new Error("workspace eval list takes no arguments");
    }
    const catalog = await client.call("capabilities/get", {
      project: target.id,
      workspace: target.workspace,
    });
    out(JSON.stringify(catalog, null, 2));
    return 0;
  }

  if (subcommand === "run") {
    const { values, positionals } = parseArgs({
      args: positionalArgs,
      allowPositionals: true,
      options: {
        all: { type: "boolean" },
      },
      strict: true,
    });
    if (values.all && positionals.length > 0) {
      throw new Error("Choose either a capability ID or --all");
    }
    const capabilityId = positionals[0];
    if (!capabilityId && !values.all) {
      throw new Error("workspace eval run requires a capability ID or --all");
    }
    if (positionals.length > 1) {
      throw new Error("workspace eval run takes at most one capability ID");
    }
    const result = await client.call("capabilities/eval", {
      project: target.id,
      workspace: target.workspace,
      options: capabilityId ? { capabilityId } : { all: true },
    });
    out(JSON.stringify(result.run, null, 2));
    return result.run.outcome === "passed" ? 0 : 1;
  }

  if (subcommand === "history") {
    const { values, positionals } = parseArgs({
      args: positionalArgs,
      allowPositionals: true,
      options: {
        limit: { type: "string" },
      },
      strict: true,
    });
    if (positionals.length > 1) {
      throw new Error("workspace eval history takes at most one capability ID");
    }
    const MAX_EVAL_HISTORY_LIMIT = 500;
    const limit = values.limit !== undefined ? Number(values.limit) : undefined;
    if (
      limit !== undefined &&
      (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVAL_HISTORY_LIMIT)
    ) {
      throw new Error(`--limit must be an integer between 1 and ${MAX_EVAL_HISTORY_LIMIT}`);
    }
    const history = await client.call("capabilities/evalHistory", {
      project: target.id,
      workspace: target.workspace,
      ...(positionals[0] ? { capabilityId: positionals[0] } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    out(JSON.stringify(history, null, 2));
    return 0;
  }

  // adapt
  const { values, positionals } = parseArgs({
    args: positionalArgs,
    allowPositionals: true,
    options: {
      reason: { type: "string" },
      record: { type: "string", multiple: true },
    },
    strict: true,
  });
  const capabilityId = positionals[0];
  if (!capabilityId || positionals.length > 1) {
    throw new Error("workspace eval adapt requires one capability ID");
  }
  if (!values.reason?.trim()) {
    throw new Error("workspace eval adapt requires --reason <text>");
  }
  const adapted = await client.call("capabilities/evalAdapt", {
    project: target.id,
    workspace: target.workspace,
    capabilityId,
    reason: values.reason,
    ...(values.record && values.record.length > 0 ? { records: values.record } : {}),
  });
  out(JSON.stringify(adapted, null, 2));
  return 0;
}

export async function runWorkspaceWithClient(
  client: AppRpcClient,
  args: string[],
  selectedWorkspace: string,
  explicitWorkspace: boolean,
  mode: "remote" | "uds",
  io: {
    out?: (line: string) => void;
    err?: (line: string) => void;
  } = {},
): Promise<number> {
  const out = io.out ?? console.log;
  const err = io.err ?? console.error;
  const [action, ...rest] = args;

  if (!action || action === "--help" || (action !== "eval" && rest.includes("--help"))) {
    out(WORKSPACE_HELP);
    return 0;
  }

  if (action === "list") {
    if (rest.length > 0) throw new Error("workspace list takes no arguments");
    const settings = await client.call("workspaces/getSettings");
    out(JSON.stringify(settings.workspaces ?? [], null, 2));
    return 0;
  }

  if (action === "forget") {
    if (rest.length !== 1) throw new Error("workspace forget requires one <id>");
    await client.call("workspaces/mutate", { action: "remove", id: rest[0]! });
    out(JSON.stringify({ forgotten: rest[0] }));
    return 0;
  }

  if (action === "open") {
    const { positionals, values } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        "new-id": { type: "boolean", default: false },
      },
      strict: true,
    });
    if (positionals.length !== 1) {
      throw new Error("workspace open requires one <directory>");
    }
    const workspacePath =
      mode === "remote" ? positionals[0]! : expandDirectory(positionals[0]!);
    const opened = await client.call("workspaces/mutate", {
      action: "open",
      workspace: workspacePath,
      ...(values["new-id"] ? { newId: true } : {}),
    });
    out(JSON.stringify(opened, null, 2));
    return 0;
  }

  if (action === "import") {
    const { positionals, values } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        "legacy-state": { type: "string" },
        "previous-workspace": { type: "string" },
      },
      strict: true,
    });
    if (positionals.length !== 1) {
      throw new Error("workspace import requires one <directory>");
    }
    const normalizePath = (p: string) => (mode === "remote" ? p : expandDirectory(p));
    const imported = await client.call("workspaces/import", {
      workspace: normalizePath(positionals[0]!),
      ...(typeof values["legacy-state"] === "string"
        ? { legacyStateDir: normalizePath(values["legacy-state"]) }
        : {}),
      ...(typeof values["previous-workspace"] === "string"
        ? { previousWorkspace: normalizePath(values["previous-workspace"]) }
        : {}),
    });
    out(JSON.stringify(imported, null, 2));
    return 0;
  }

  if (action === "init") {
    const { values } = parseArgs({
      args: rest,
      options: {
        machine: { type: "string" },
        driver: { type: "string" },
        "driver-package": { type: "string" },
        game: { type: "string" },
        port: { type: "string" },
        "cua-command": { type: "string" },
        seconds: { type: "string" },
        requests: { type: "string" },
        model: { type: "string" },
        effort: { type: "string" },
        "service-tier": { type: "string" },
        name: { type: "string" },
        workspace: { type: "string" },
        "register-driver": { type: "boolean" },
        pet: { type: "boolean" },
        "no-pet": { type: "boolean" },
      },
      strict: true,
    });
    if (values.pet && values["no-pet"]) {
      throw new Error("Choose either --pet or --no-pet");
    }
    if (
      values.name !== undefined &&
      (!values.name.trim() || /[\\/\x00]/.test(values.name) || [".", ".."].includes(values.name))
    ) {
      throw new Error("--name must be a single non-empty directory name");
    }
    if (
      typeof values.workspace === "string" &&
      explicitWorkspace &&
      resolve(values.workspace) !== resolve(selectedWorkspace)
    ) {
      throw new Error("Choose one --workspace directory");
    }
    const machineArg = typeof values.machine === "string" ? values.machine.trim() : "";
    const driverArg = typeof values.driver === "string" ? values.driver.trim() : "";
    if (!driverArg && !machineArg) {
      throw new Error("workspace init requires --driver <id> or --machine <id>");
    }

    const explicitDir =
      typeof values.workspace === "string"
        ? mode === "remote"
          ? values.workspace
          : expandDirectory(values.workspace)
        : explicitWorkspace
          ? mode === "remote"
            ? selectedWorkspace
            : expandDirectory(selectedWorkspace)
          : undefined;

    const derivedName = values.name?.trim() || (explicitDir ? basename(explicitDir) : "");
    if (!derivedName) {
      throw new Error("workspace init requires --name <name> (or --workspace <directory>)");
    }

    const input: CreateWorkspaceInputDto = {
      name: derivedName,
      driver: driverArg,
      ...(machineArg ? { machineId: machineArg } : {}),
      ...(explicitDir ? { workspace: explicitDir } : {}),
      ...(typeof values["driver-package"] === "string"
        ? { driverPackage: values["driver-package"] }
        : {}),
      ...(typeof values.game === "string" ? { game: values.game } : {}),
      ...(typeof values.port === "string" ? { port: Number(values.port) } : {}),
      ...(typeof values["cua-command"] === "string"
        ? { cuaCommand: values["cua-command"] }
        : {}),
      ...(typeof values.seconds === "string" ? { seconds: Number(values.seconds) } : {}),
      ...(typeof values.requests === "string" ? { requests: Number(values.requests) } : {}),
      ...(typeof values.model === "string" ? { model: values.model } : {}),
      ...(typeof values.effort === "string"
        ? { effort: values.effort as CreateWorkspaceInputDto["effort"] }
        : {}),
      ...(typeof values["service-tier"] === "string"
        ? { serviceTier: values["service-tier"] as CreateWorkspaceInputDto["serviceTier"] }
        : {}),
      ...(values["register-driver"] ? { registerDriver: true } : {}),
      ...(values.pet || values["no-pet"] ? { pet: Boolean(values.pet) } : {}),
    };

    const created = await client.call("workspaces/mutate", {
      action: "create",
      input,
    });
    out(JSON.stringify(created, null, 2));
    return 0;
  }

  if (action === "services") {
    if (rest.length > 0) throw new Error("workspace services takes no arguments");
    const target = await resolveWorkspaceTargetViaRpc(client, selectedWorkspace, explicitWorkspace);
    const studio = await client.call("workspaces/getStudio", { workspaceId: target.id });
    out(JSON.stringify({ workspaceId: target.id, ...studio }, null, 2));
    return 0;
  }

  if (action === "up" || action === "down") {
    const { values } = parseArgs({
      args: rest,
      options:
        action === "up"
          ? {
              preempt: { type: "boolean", default: false },
              services: { type: "string" },
            }
          : {
              "keep-emulator": { type: "boolean", default: false },
              services: { type: "string" },
            },
      strict: true,
    });
    const target = await resolveWorkspaceTargetViaRpc(client, selectedWorkspace, explicitWorkspace);
    const services = parseServicesOption(
      typeof values.services === "string" ? values.services : undefined,
    );
    const res = (await client.call("workspaces/serviceControl", {
      workspaceId: target.id,
      action,
      ...(services ? { services } : {}),
      ...(action === "up" && values.preempt ? { preempt: true } : {}),
      ...(action === "down" && values["keep-emulator"] ? { keepEmulator: true } : {}),
    })) as WorkspaceServiceControlResult;
    if (res.stderr) err(res.stderr);
    if (!res.ok) {
      throw new Error(res.stderr || `Workspace ${action} failed with exit code ${res.exitCode}`);
    }
    out(res.stdout || JSON.stringify(res.studio, null, 2));
    return 0;
  }

  if (action === "eval") {
    return runWorkspaceEvalWithClient(client, rest, selectedWorkspace, explicitWorkspace, out);
  }

  throw new Error(
    `Unknown workspace subcommand '${action}'; use init, list, open, forget, import, up, down, services, or eval`,
  );
}

export async function workspaceCommand(
  args: string[],
  selectedWorkspace: string,
  explicitWorkspace: boolean,
  rpcOptions: OperatorRpcOptions,
  io?: { out?: (line: string) => void; err?: (line: string) => void },
): Promise<number> {
  const [action, ...rest] = args;
  if (!action || action === "--help" || (action !== "eval" && rest.includes("--help"))) {
    (io?.out ?? console.log)(WORKSPACE_HELP);
    return 0;
  }
  if (action === "eval" && (!rest.length || rest[0] === "--help" || rest.includes("--help"))) {
    (io?.out ?? console.log)(WORKSPACE_EVAL_HELP);
    return 0;
  }
  return withOperatorRpc(rpcOptions, (client, mode) =>
    runWorkspaceWithClient(client, args, selectedWorkspace, explicitWorkspace, mode, io),
  );
}
