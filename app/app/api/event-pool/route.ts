import {
  EVENT_DIRECTIONS,
  POOL_EVENT_STATUSES,
  type EventDirection,
  type PoolEventStatus,
} from "@ludens/protocol/event-pool";
import {
  mutateWorkspaceEventPool,
  readWorkspaceEventPool,
  type EventPoolMutationCommand,
  type EventPoolQueryFilter,
} from "@/lib/event-pool";
import { errorResponse, localRequest } from "@/lib/local-request";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    localRequest(request, false);
    const url = new URL(request.url);
    const project = url.searchParams.get("project")?.trim() ?? "";
    const workspace = url.searchParams.get("workspace")?.trim() ?? "";
    if (!project || !workspace) {
      throw Object.assign(new Error("必须提供 project 与 workspace"), { status: 400 });
    }
    const directionParam = url.searchParams.get("direction")?.trim();
    const statusParam = url.searchParams.get("status")?.trim();
    const limitParam = url.searchParams.get("limit")?.trim();
    const filter: EventPoolQueryFilter = {};
    if (directionParam) {
      if (!(EVENT_DIRECTIONS as readonly string[]).includes(directionParam)) {
        throw Object.assign(new Error("无效的 direction 参数"), { status: 400 });
      }
      filter.direction = directionParam as EventDirection;
    }
    if (statusParam) {
      if (!(POOL_EVENT_STATUSES as readonly string[]).includes(statusParam)) {
        throw Object.assign(new Error("无效的 status 参数"), { status: 400 });
      }
      filter.status = statusParam as PoolEventStatus;
    }
    if (limitParam) {
      const limit = Number(limitParam);
      if (!Number.isInteger(limit) || limit <= 0) {
        throw Object.assign(new Error("limit 必须为正整数"), { status: 400 });
      }
      filter.limit = limit;
    }
    const result = await readWorkspaceEventPool(project, workspace, filter);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error, 409);
  }
}

export async function POST(request: Request) {
  try {
    localRequest(request, true);
    const body = (await request.json()) as {
      project?: string;
      workspace?: string;
      command?: EventPoolMutationCommand;
    };
    if (!body.project || !body.workspace || !body.command?.action) {
      throw Object.assign(new Error("必须提供 project、workspace 与 command"), { status: 400 });
    }
    const result = await mutateWorkspaceEventPool(body.project, body.workspace, body.command);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error, 409);
  }
}
