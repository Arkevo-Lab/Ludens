import { dashboardWorker } from "@ludens/core/core/query/dashboard-worker";
import { localRequest, errorResponse } from "@/lib/local-request";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function GET(request: Request) {
  try {
    localRequest(request);
    const query = new URL(request.url).searchParams;
    const project = query.get("project") ?? "", workspace = query.get("workspace") ?? "";
    return Response.json(await dashboardWorker().call("capabilities", [project, workspace], request.signal),
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    localRequest(request, true);
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("无效的能力评测请求");
    const project = typeof body.project === "string" ? body.project : "";
    const workspace = typeof body.workspace === "string" ? body.workspace : "";
    const capabilityId = typeof body.capabilityId === "string" && body.capabilityId.trim() ? body.capabilityId.trim() : undefined;
    const all = capabilityId ? false : Boolean(body.all ?? true);
    return Response.json(
      await dashboardWorker().call("runWorkspaceCapabilityEval", [project, workspace, { capabilityId, all }], request.signal),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
