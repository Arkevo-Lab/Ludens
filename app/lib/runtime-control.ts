import { dashboardWorker } from "@ludens/core/core/query/dashboard-worker";
import type { OmpServiceTier } from "@ludens/protocol/ludens";
import type {
  HostControlStatus as CoreHostControlStatus,
  RuntimeControlCommand as CoreRuntimeControlCommand,
} from "@ludens/core/core/query/runtime-control";

export type RuntimeControlCommand =
  | CoreRuntimeControlCommand
  | { action: "set_model"; model: string; serviceTier?: OmpServiceTier | null; runId?: string; expectedEpoch?: string | null };

export type HostControlStatus = CoreHostControlStatus & {
  model?: string | null;
  serviceTier?: OmpServiceTier | null;
  hostOffline?: boolean;
};

/** One host control command through the shared reader worker. */
export async function controlWorkspaceRuntime(
  project: string,
  workspace: string,
  command: RuntimeControlCommand,
): Promise<HostControlStatus> {
  return (await dashboardWorker().call("runtimeControl", [
    project,
    workspace,
    command as CoreRuntimeControlCommand,
  ])) as HostControlStatus;
}
