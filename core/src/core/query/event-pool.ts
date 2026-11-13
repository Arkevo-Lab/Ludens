import {
  EMPTY_EVENT_POOL_SUMMARY,
  type EventDirection,
  type EventPoolSnapshot,
  type PoolEvent,
  type PoolEventStatus,
} from "@ludens/protocol/event-pool";
import { resolveWorkspaceAddress } from "@ludens/core/core/storage/workspace-state";
import { openWorkspaceEventPool } from "../storage/event-pool.ts";
import { isHostSocketOfflineError } from "../../cli/event-cli.ts";
import { send } from "../../daemon/transport.ts";
import { globalHome, workspaceForProject } from "./data";
import type { HostControlStatus } from "./runtime-control";

export interface EventPoolQueryFilter {
  direction?: EventDirection;
  status?: PoolEventStatus;
  limit?: number;
}

export type EventPoolMutationCommand =
  | { action: "send"; text: string; title?: string }
  | { action: "reply"; replyTo: string; text: string; resumeAuto?: boolean; seconds?: number | null }
  | { action: "ack"; ids: string[] };

export interface WorkspaceEventPoolReadResult {
  snapshot: EventPoolSnapshot;
  hostOnline: boolean;
  hostStatus?: HostControlStatus;
}

export interface WorkspaceEventPoolMutateResult {
  snapshot: EventPoolSnapshot;
  hostOnline: boolean;
  hostStatus?: HostControlStatus;
  createdEvent?: PoolEvent;
  resolvedOutbound?: PoolEvent;
  updatedEvents?: PoolEvent[];
}

async function resolveScopedWorkspace(project: string, expectedWorkspace: string, root: string) {
  if (!expectedWorkspace) {
    throw Object.assign(new Error("必须明确提供预期工作区目录"), {
      code: "WORKSPACE_SCOPE_REQUIRED",
      status: 400,
    });
  }
  const workspace = await workspaceForProject(project, root);
  if (workspace !== expectedWorkspace) {
    throw Object.assign(new Error("工作区登记目录已变化，请刷新工作区列表后重试"), {
      code: "WORKSPACE_SCOPE_CHANGED",
      status: 409,
    });
  }
  const { socket } = await resolveWorkspaceAddress(workspace);
  return { workspace, socket };
}

function listArgvFromFilter(filter?: EventPoolQueryFilter): string[] {
  const argv = ["list"];
  if (filter?.direction) argv.push("--direction", filter.direction);
  if (filter?.status) argv.push("--status", filter.status);
  if (filter?.limit !== undefined) argv.push("--limit", String(filter.limit));
  return argv;
}

export async function readWorkspaceEventPool(
  project: string,
  expectedWorkspace: string,
  filter?: EventPoolQueryFilter,
  home = globalHome,
): Promise<WorkspaceEventPoolReadResult> {
  const { workspace, socket } = await resolveScopedWorkspace(project, expectedWorkspace, home);
  try {
    const [hostStatus, snapshot] = await Promise.all([
      send(socket, { kind: "status", argv: [] }) as Promise<HostControlStatus>,
      send(socket, { kind: "event", argv: listArgvFromFilter(filter) }) as Promise<EventPoolSnapshot>,
    ]);
    return { snapshot, hostOnline: true, hostStatus };
  } catch (error) {
    if (!isHostSocketOfflineError(error)) throw error;
  }

  try {
    const pool = await openWorkspaceEventPool(workspace, home);
    return { snapshot: await pool.snapshot(filter), hostOnline: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Not an initialized Ludens workspace")) {
      return {
        snapshot: { summary: { ...EMPTY_EVENT_POOL_SUMMARY }, events: [] },
        hostOnline: false,
      };
    }
    throw error;
  }
}

export async function mutateWorkspaceEventPool(
  project: string,
  expectedWorkspace: string,
  command: EventPoolMutationCommand,
  home = globalHome,
): Promise<WorkspaceEventPoolMutateResult> {
  const { workspace, socket } = await resolveScopedWorkspace(project, expectedWorkspace, home);

  try {
    if (command.action === "send") {
      const argv = ["send"];
      if (command.title?.trim()) argv.push("--title", command.title.trim());
      argv.push("--message", command.text);
      const res = (await send(socket, { kind: "event", argv })) as {
        event: PoolEvent;
        status: HostControlStatus;
      };
      const snapshot = (await send(socket, { kind: "event", argv: ["list"] })) as EventPoolSnapshot;
      return {
        snapshot,
        hostOnline: true,
        hostStatus: res.status,
        createdEvent: res.event,
      };
    }

    if (command.action === "reply") {
      const res = (await send(socket, {
        kind: "event",
        argv: ["reply", command.replyTo, "--message", command.text],
      })) as {
        event: PoolEvent;
        resolvedOutbound?: PoolEvent;
        status: HostControlStatus;
      };
      let hostStatus = res.status;
      if (command.resumeAuto && hostStatus.mode === "manual" && !hostStatus.consolidating) {
        const autoArgv = ["on"];
        if (command.seconds != null) autoArgv.push("--seconds", String(command.seconds));
        hostStatus = (await send(socket, {
          kind: "auto",
          argv: autoArgv,
          runId: hostStatus.runId,
          expectedEpoch: hostStatus.epoch ?? undefined,
        })) as HostControlStatus;
      }
      const snapshot = (await send(socket, { kind: "event", argv: ["list"] })) as EventPoolSnapshot;
      return {
        snapshot,
        hostOnline: true,
        hostStatus,
        createdEvent: res.event,
        ...(res.resolvedOutbound ? { resolvedOutbound: res.resolvedOutbound } : {}),
      };
    }

    const res = (await send(socket, {
      kind: "event",
      argv: ["ack", ...command.ids],
    })) as {
      updated: PoolEvent[];
      status: HostControlStatus;
    };
    const snapshot = (await send(socket, { kind: "event", argv: ["list"] })) as EventPoolSnapshot;
    return {
      snapshot,
      hostOnline: true,
      hostStatus: res.status,
      updatedEvents: res.updated,
    };
  } catch (error) {
    if (!isHostSocketOfflineError(error)) throw error;
  }

  if (command.action === "reply" && command.resumeAuto) {
    throw Object.assign(
      new Error("当前工作区 Core 未在线，无法恢复 auto 循环；请仅发送回复或先启动 Core"),
      { code: "CORE_OFFLINE", status: 409 },
    );
  }

  const pool = await openWorkspaceEventPool(workspace, home);
  if (command.action === "send") {
    const res = await pool.postInbound({ text: command.text, title: command.title, runId: null, epoch: null });
    return {
      snapshot: await pool.snapshot(),
      hostOnline: false,
      createdEvent: res.event,
    };
  }
  if (command.action === "reply") {
    const res = await pool.postInbound({
      text: command.text,
      replyTo: command.replyTo,
      runId: null,
      epoch: null,
    });
    return {
      snapshot: await pool.snapshot(),
      hostOnline: false,
      createdEvent: res.event,
      ...(res.resolvedOutbound ? { resolvedOutbound: res.resolvedOutbound } : {}),
    };
  }
  const res = await pool.ack(command.ids, "human");
  return {
    snapshot: await pool.snapshot(),
    hostOnline: false,
    updatedEvents: res.updated,
  };
}
