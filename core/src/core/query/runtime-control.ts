import { globalHome, workspaceForProject } from "./data";
import { resolveWorkspaceAddress } from "@ludens/core/core/storage/workspace-state";
import { send } from "../../daemon/transport.ts";

export type RuntimeControlCommand =
  | { action: "status" }
  | { action: "auto_on"; message?: string; runId?: string; expectedEpoch?: string | null }
  | { action: "auto_off"; runId?: string; expectedEpoch?: string | null }
  | { action: "steer"; message: string; delivery?: "steer" | "follow_up"; runId?: string; expectedEpoch?: string | null }
  | { action: "consolidate"; seconds?: number; runId?: string; expectedEpoch?: string | null }
  | { action: "perception_inject"; enabled: boolean }
  | { action: "perception_reload" };

/** The host status snapshot every control command replies with. */
export interface HostControlStatus {
  runId: string;
  epoch: string | null;
  mode: string;
  queue: { steering: number; followUp: number };
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

/**
 * Send one control command to a workspace host and return its latest status.
 * Callers that have not read the host status yet may omit runId; it is fetched
 * first so the host can still reject stale cycles.
 */
export async function controlWorkspaceRuntime(project: string, workspace: string, command: RuntimeControlCommand, home = globalHome): Promise<HostControlStatus> {
  const socket = await controlWorkspace(project, workspace, home);
  const status = async (): Promise<HostControlStatus> => await send(socket, { kind: "status", argv: [] }) as HostControlStatus;
  const scoped = async (request: Parameters<typeof send>[1]): Promise<HostControlStatus> => {
    if (request.runId === undefined) request.runId = (await status()).runId;
    return await send(socket, request) as HostControlStatus;
  };
  switch (command.action) {
    case "status":
      return await status();
    case "auto_on":
      return await scoped({ kind: "auto", argv: command.message?.trim() ? ["on", "--message", command.message.trim()] : ["on"], runId: command.runId, expectedEpoch: command.expectedEpoch ?? undefined });
    case "auto_off":
      return await scoped({ kind: "auto", argv: ["off"], runId: command.runId, expectedEpoch: command.expectedEpoch ?? undefined });
    case "steer":
      return await scoped({ kind: "steer",
        argv: command.delivery === "follow_up" ? ["--follow-up", "--message", command.message] : ["--message", command.message],
        runId: command.runId, expectedEpoch: command.expectedEpoch ?? undefined });
    case "consolidate":
      return await scoped({ kind: "consolidate", argv: command.seconds ? ["--seconds", String(command.seconds)] : [], runId: command.runId, expectedEpoch: command.expectedEpoch ?? undefined });
    case "perception_inject": {
      await send(socket, { kind: "perception", argv: ["inject", command.enabled ? "on" : "off"] });
      return await status();
    }
    case "perception_reload": {
      await send(socket, { kind: "perception", argv: ["reload"] });
      return await status();
    }
  }
}
