import { dashboardWorker } from "@ludens/core/core/query/dashboard-worker";
import { localRequest, errorResponse } from "@/lib/local-request";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function GET(request: Request) {
  try {
    localRequest(request);
    const searchParams = new URL(request.url).searchParams;
    const studioId = searchParams.get("studio");
    if (studioId) {
      return Response.json(await dashboardWorker().call("workspaceStudio", [studioId], request.signal), { headers: { "Cache-Control": "no-store" } });
    }
    const workspaceId = searchParams.get("workspaceId");
    if (workspaceId) {
      return Response.json(await dashboardWorker().call("workspaceConnection", [workspaceId], request.signal), { headers: { "Cache-Control": "no-store" } });
    }
    return Response.json(await dashboardWorker().call("workspaceSettings", [], request.signal), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    localRequest(request, true);
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("无效的工作区操作");
    const worker = dashboardWorker();
    if (body.action === "register") return Response.json(await worker.call("openWorkspace", [body.workspace], request.signal));
    if (body.action === "create") return Response.json(await worker.call("createWorkspace", [body.workspace], request.signal));
    throw new Error("未知的工作区操作");
  } catch (error) { return errorResponse(error); }
}
export async function PUT(request: Request) {
  try {
    localRequest(request, true);
    const body = await request.json();
    const worker = dashboardWorker();
    if (body?.action === "globalConnection") {
      return Response.json(await worker.call("updateGlobalConnection", [body.connection], request.signal));
    }
    if (body?.action === "globalDefaults") {
      return Response.json(await worker.call("updateGlobalDefaults", [body.defaults], request.signal));
    }
    if (body?.action === "workspaceConnection") {
      return Response.json(await worker.call("updateWorkspaceConnection", [body.id, body.connection], request.signal));
    }
    if (body?.action === "workspaceStudioConfig") {
      return Response.json(await worker.call("updateWorkspaceStudioConfig", [body.id, body.patch], request.signal));
    }
    if (body?.action === "workspaceShiori") {
      return Response.json(await worker.call("updateWorkspaceShiori", [body.id, body.shiori], request.signal));
    }
    if (body?.action === "workspaceServiceControl") {
      return Response.json(await worker.call("controlWorkspaceService", [body.id, body.service], request.signal));
    }
    return Response.json(await worker.call("updateWorkspaceRoot", [body?.workspaceRoot], request.signal));
  } catch (error) { return errorResponse(error); }
}
export async function DELETE(request: Request) {
  try {
    localRequest(request, true);
    const body = await request.json();
    return Response.json(await dashboardWorker().call("removeWorkspace", [body?.id], request.signal));
  } catch (error) { return errorResponse(error); }
}
