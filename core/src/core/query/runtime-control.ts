import type { EventPoolSummary } from "@ludens/protocol/event-pool";
import type { OmpEffort, OmpServiceTier } from "@ludens/protocol/ludens";
import { globalHome, workspaceForProject } from "./data";
import { updateWorkspaceShiori } from "./workspaces";
import { resolveWorkspaceAddress } from "@ludens/core/core/storage/workspace-state";
import { send } from "../../daemon/transport.ts";

export type RuntimeControlCommand =
  | { action: "status" }
  | { action: "auto_on"; message?: string; seconds?: number | null; runId?: string; expectedEpoch?: string | null }
  | { action: "auto_off"; runId?: string; expectedEpoch?: string | null }
  | { action: "auto_budget"; seconds: number | null; runId?: string; expectedEpoch?: string | null }
  | { action: "steer"; message: string; runId?: string; expectedEpoch?: string | null }
  | { action: "consolidate"; seconds?: number; runId?: string; expectedEpoch?: string | null }
  | {
      action: "set_model";
      model: string;
      serviceTier?: OmpServiceTier | null;
      effort?: OmpEffort | null;
      runId?: string;
      expectedEpoch?: string | null;
    }
  | { action: "perception_inject"; enabled: boolean }
  | { action: "perception_reload" };

/** The host status snapshot every control command replies with. */
export interface HostControlStatus {
  runId: string;
  epoch: string | null;
  mode: string;
  model?: string | null;
  serviceTier?: OmpServiceTier | null;
  effort?: OmpEffort | null;
  queue: { steering: number };
  eventPool?: EventPoolSummary;
  [key: string]: unknown;
}

/** Same registry scope check as every other workspace operation. */
async function controlWorkspace(project: string, expectedWorkspace: string, root: string) {
  if (!expectedWorkspace) throw Object.assign(new Error("必须明确提供预期工作区目录"), { code: "WORKSPACE_SCOPE_REQUIRED", status: 400 });
  const workspace = await workspaceForProject(project, root);
  if (workspace !== expectedWorkspace) throw Object.assign(new Error("工作区登记目录已变化，请刷新工作区列表后重试"),
    { code: "WORKSPACE_SCOPE_CHANGED", status: 409 });
  const { socket } = await resolveWorkspaceAddress(workspace);
  return socket;
}

function wrapSocketError(cause: unknown): never {
  const code = (cause as { code?: string } | null)?.code;
  const message = cause instanceof Error ? cause.message : String(cause);
  if (code === "ENOENT" || code === "ECONNREFUSED" || message.includes("ENOENT") || message.includes("ECONNREFUSED")) {
    throw Object.assign(new Error("当前工作区 Core 未在线（未检测到运行中的 Core 进程）"), {
      code: "CORE_OFFLINE",
      status: 409,
    });
  }
  throw cause;
}

/**
 * Send one control command to a workspace host and return its latest status.
 * Callers that have not read the host status yet may omit runId; it is fetched
 * first so the host can still reject stale cycles.
 */
export async function controlWorkspaceRuntime(project: string, workspace: string, command: RuntimeControlCommand, home = globalHome): Promise<HostControlStatus> {
  const socket = await controlWorkspace(project, workspace, home);
  const rpc = async (request: Parameters<typeof send>[1]) => {
    try {
      return await send(socket, request);
    } catch (cause) {
      wrapSocketError(cause);
    }
  };
  const status = async (): Promise<HostControlStatus> => await rpc({ kind: "status", argv: [] }) as HostControlStatus;
  const scoped = async (request: Parameters<typeof send>[1]): Promise<HostControlStatus> => {
    if (request.runId === undefined) request.runId = (await status()).runId;
    return await rpc(request) as HostControlStatus;
  };
  switch (command.action) {
    case "status":
      return await status();
    case "auto_on":
      const argv = ["on"];
      if (command.message?.trim()) argv.push("--message", command.message.trim());
      if (command.seconds != null) argv.push("--seconds", String(command.seconds));
      return await scoped({ kind: "auto", argv, runId: command.runId, expectedEpoch: command.expectedEpoch ?? undefined });
    case "auto_off":
      return await scoped({ kind: "auto", argv: ["off"], runId: command.runId, expectedEpoch: command.expectedEpoch ?? undefined });
    case "auto_budget":
      return await scoped({ kind: "auto", argv: ["timer", command.seconds == null ? "off" : String(command.seconds)], runId: command.runId, expectedEpoch: command.expectedEpoch ?? undefined });
    case "steer":
      return await scoped({ kind: "steer",
        argv: ["--message", command.message],
        runId: command.runId, expectedEpoch: command.expectedEpoch ?? undefined });
    case "consolidate":
      return await scoped({ kind: "consolidate", argv: command.seconds ? ["--seconds", String(command.seconds)] : [], runId: command.runId, expectedEpoch: command.expectedEpoch ?? undefined });
    case "set_model": {
      const nextModel = typeof command.model === "string" ? command.model.trim() : "";
      const slash = nextModel.indexOf("/");
      if (slash <= 0 || slash === nextModel.length - 1) {
        throw new Error("model 必须是 provider/model 格式的非空字符串");
      }
      try {
        const result = await scoped({
          kind: "model",
          argv: [
            nextModel,
            ...(command.serviceTier !== undefined ? ["--service-tier", command.serviceTier ?? "none"] : []),
            ...(command.effort !== undefined ? ["--effort", command.effort ?? "none"] : []),
          ],
          runId: command.runId,
          expectedEpoch: command.expectedEpoch ?? undefined,
        });
        await updateWorkspaceShiori(
          project,
          {
            model: nextModel,
            serviceTier: result.serviceTier ?? null,
            ...(command.effort !== undefined || "effort" in result ? { effort: result.effort ?? null } : {}),
          },
          home,
        );
        return result;
      } catch (error) {
        if ((error as { code?: string } | null)?.code === "CORE_OFFLINE") {
          await updateWorkspaceShiori(
            project,
            {
              model: nextModel,
              ...(command.serviceTier !== undefined ? { serviceTier: command.serviceTier } : {}),
              ...(command.effort !== undefined ? { effort: command.effort } : {}),
            },
            home,
          );
          return {
            runId: "",
            epoch: null,
            mode: "manual",
            connected: false,
            coreOffline: true,
            model: nextModel,
            serviceTier: command.serviceTier ?? null,
            effort: command.effort ?? null,
            queue: { steering: 0 },
          };
        }
        throw error;
      }
    }
    case "perception_inject": {
      await rpc({ kind: "perception", argv: ["inject", command.enabled ? "on" : "off"] });
      return await status();
    }
    case "perception_reload": {
      await rpc({ kind: "perception", argv: ["reload"] });
      return await status();
    }
  }
}
