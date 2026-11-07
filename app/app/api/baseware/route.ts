import { dashboardWorker } from "@ludens/core/core/query/dashboard-worker";
import { localRequest, errorResponse } from "@/lib/local-request";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  try {
    localRequest(request);
    const searchParams = new URL(request.url).searchParams;
    const workspaceId = searchParams.get("workspaceId") || undefined;
    return Response.json(
      await dashboardWorker().call("basewareOverview", [workspaceId], request.signal),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    localRequest(request, true);
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("无效的 Baseware 操作");
    }
    const worker = dashboardWorker();
    if (body.action === "upsertMachine") {
      return Response.json(await worker.call("upsertBasewareMachine", [body.machine], request.signal));
    }
    if (body.action === "probeMachine") {
      return Response.json(await worker.call("probeBasewareMachine", [body.machine ?? { id: body.id }], request.signal));
    }
    throw new Error("未知的 Baseware 操作");
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    localRequest(request, true);
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("无效的 Baseware 配置更新");
    }
    const worker = dashboardWorker();
    if (body.action === "workspaceMachines") {
      return Response.json(await worker.call("updateWorkspaceMachines", [body.id, body.binding], request.signal));
    }
    throw new Error("未知的 Baseware 配置更新");
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    localRequest(request, true);
    const body = await request.json();
    return Response.json(await dashboardWorker().call("removeBasewareMachine", [body?.id], request.signal));
  } catch (error) {
    return errorResponse(error);
  }
}
