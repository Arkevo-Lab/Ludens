import { parseArgs } from "node:util";
import type { RuntimeControlCommandDto } from "@ludens/protocol/app-rpc";
import { isOmpEffort, isOmpServiceTier } from "@ludens/protocol/workspaces";
import type { AppRpcClient } from "./app-rpc-client.ts";
import {
  resolveWorkspaceTargetViaRpc,
  withOperatorRpc,
  type OperatorRpcOptions,
} from "./operator-rpc.ts";

export const CONTROL_HELP = `Ludens remote control (RPC):
ludens status [--workspace <id|path>] [--remote <url> --token <secret>]
ludens auto on [--message <text>] [--seconds <n>] [--preempt]
ludens auto timer <seconds|off>
ludens auto off
ludens steer <message>
ludens consolidate [--seconds <n>]
ludens stop
ludens model [<provider/id>] [--service-tier none|priority|ultrafast] [--effort none|minimal|low|medium|high|xhigh|max]

All control commands operate via ludens-server JSON-RPC (local UDS or remote WebSocket).`;

export async function runControlWithClient(
  client: AppRpcClient,
  argv: string[],
  selectedWorkspace: string,
  explicitWorkspace: boolean,
  out: (line: string) => void = console.log,
): Promise<void> {
  const [kind, ...rest] = argv;
  if (!kind || kind === "--help" || rest.includes("--help")) {
    out(CONTROL_HELP);
    return;
  }

  const target = await resolveWorkspaceTargetViaRpc(client, selectedWorkspace, explicitWorkspace);

  if (kind === "stop") {
    const catalog = (await client.call("catalog/get", { includeEmpty: true })) as Array<{
      id?: string;
      runs?: Array<{ id: string; epoch?: string | null; endedAt?: string }>;
    }>;
    const project = catalog.find(item => item.id === target.id);
    const activeRun = project?.runs?.find(run => !run.endedAt) ?? project?.runs?.[0];
    if (!activeRun) {
      throw new Error(`No active or recorded run found for workspace ${target.id}`);
    }
    const res = await client.call("run/stop", {
      project: target.id,
      run: activeRun.id,
      ...(activeRun.epoch !== undefined ? { epoch: activeRun.epoch } : {}),
    });
    out(JSON.stringify(res, null, 2));
    return;
  }

  let command: RuntimeControlCommandDto;
  let preempt = false;

  if (kind === "status") {
    command = { action: "status" };
  } else if (kind === "auto") {
    const [sub, ...autoArgs] = rest;
    if (sub === "off") {
      command = { action: "auto_off" };
    } else if (sub === "on") {
      const { values } = parseArgs({
        args: autoArgs,
        options: {
          message: { type: "string" },
          seconds: { type: "string" },
          preempt: { type: "boolean", default: false },
        },
        strict: true,
      });
      preempt = Boolean(values.preempt);
      const seconds = values.seconds !== undefined ? Number(values.seconds) : undefined;
      if (seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0)) {
        throw new Error("--seconds must be a positive number");
      }
      command = {
        action: "auto_on",
        ...(values.message !== undefined ? { message: values.message } : {}),
        ...(seconds !== undefined ? { seconds } : {}),
      };
    } else if (sub === "timer") {
      const rawSeconds = autoArgs[0];
      if (!rawSeconds) throw new Error("auto timer requires <seconds|off>");
      if (rawSeconds !== "off") {
        const parsed = Number(rawSeconds);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error("auto timer requires a positive number or 'off'");
        }
        command = { action: "auto_budget", seconds: parsed };
      } else {
        command = { action: "auto_budget", seconds: null };
      }
    } else {
      throw new Error("Use ludens auto <on|off|timer>");
    }
  } else if (kind === "steer") {
    const message = rest.join(" ").trim();
    if (!message) throw new Error("steer requires a message");
    command = { action: "steer", message };
  } else if (kind === "consolidate") {
    const { values } = parseArgs({
      args: rest,
      options: { seconds: { type: "string" } },
      strict: true,
    });
    const seconds = values.seconds !== undefined ? Number(values.seconds) : undefined;
    if (seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0)) {
      throw new Error("--seconds must be a positive number");
    }
    command = { action: "consolidate", ...(seconds !== undefined ? { seconds } : {}) };
  } else if (kind === "model") {
    if (rest.length === 0) {
      const status = (await client.call("runtime/control", {
        project: target.id,
        workspace: target.workspace,
        command: { action: "status" },
      })) as { model?: string | null };
      out(status.model ?? "none");
      return;
    }
    const { positionals, values } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        "service-tier": { type: "string" },
        effort: { type: "string" },
      },
      strict: true,
    });
    const model = positionals[0] ?? "";
    if (!model) throw new Error("model requires <provider/id>");
    const tierRaw = values["service-tier"];
    const effortRaw = values.effort;
    const serviceTier = tierRaw === "none" ? null : tierRaw;
    const effort = effortRaw === "none" ? null : effortRaw;
    if (serviceTier !== undefined && serviceTier !== null && !isOmpServiceTier(serviceTier)) {
      throw new Error("--service-tier must be none, priority, or ultrafast");
    }
    if (effort !== undefined && effort !== null && !isOmpEffort(effort)) {
      throw new Error("--effort must be none, minimal, low, medium, high, xhigh, or max");
    }
    command = {
      action: "set_model",
      model,
      ...(serviceTier !== undefined ? { serviceTier } : {}),
      ...(effort !== undefined ? { effort } : {}),
    };
  } else {
    throw new Error(
      `Unsupported control command '${kind}'; use status, auto, steer, consolidate, stop, or model`,
    );
  }

  const res = await client.call("runtime/control", {
    project: target.id,
    workspace: target.workspace,
    command,
    ...(preempt ? { preempt: true } : {}),
  });
  out(JSON.stringify(res, null, 2));
}

export async function controlCommand(
  argv: string[],
  selectedWorkspace: string,
  explicitWorkspace: boolean,
  rpcOptions: OperatorRpcOptions,
  out: (line: string) => void = console.log,
): Promise<void> {
  if (!argv.length || argv[0] === "--help" || argv.includes("--help")) {
    out(CONTROL_HELP);
    return;
  }
  await withOperatorRpc(rpcOptions, client =>
    runControlWithClient(client, argv, selectedWorkspace, explicitWorkspace, out),
  );
}
