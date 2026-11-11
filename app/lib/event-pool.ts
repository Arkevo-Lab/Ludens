import { dashboardWorker } from "@ludens/core/core/query/dashboard-worker";
import type {
  EventPoolMutationCommand,
  EventPoolQueryFilter,
  WorkspaceEventPoolMutateResult,
  WorkspaceEventPoolReadResult,
} from "@ludens/core/core/query/event-pool";

export type {
  EventPoolMutationCommand,
  EventPoolQueryFilter,
  WorkspaceEventPoolMutateResult,
  WorkspaceEventPoolReadResult,
};

export async function readWorkspaceEventPool(
  project: string,
  workspace: string,
  filter?: EventPoolQueryFilter,
): Promise<WorkspaceEventPoolReadResult> {
  return await dashboardWorker().call("eventPoolRead", [project, workspace, filter]);
}

export async function mutateWorkspaceEventPool(
  project: string,
  workspace: string,
  command: EventPoolMutationCommand,
): Promise<WorkspaceEventPoolMutateResult> {
  return await dashboardWorker().call("eventPoolMutate", [project, workspace, command]);
}
