import { dashboardWorker } from "@ludens/core/core/query/dashboard-worker";
import type { HostControlStatus, RuntimeControlCommand } from "@ludens/core/core/query/runtime-control";

export type { HostControlStatus, RuntimeControlCommand };

/** One host control command through the shared reader worker. */
export async function controlWorkspaceRuntime(project: string, workspace: string, command: RuntimeControlCommand): Promise<HostControlStatus> {
  return await dashboardWorker().call("runtimeControl", [project, workspace, command]);
}
