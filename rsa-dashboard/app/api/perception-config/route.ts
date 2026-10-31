import { dashboardWorker } from "@ludens/rsa/core/query/dashboard-worker";
import { localRequest, errorResponse } from "@/lib/local-request";
import { parsePerceptionPatch } from "@ludens/rsa/core/query/perception-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    localRequest(request);
    const query = new URL(request.url).searchParams;
    const project = query.get("project") ?? "", workspace = query.get("workspace") ?? "";
    return Response.json(await dashboardWorker().call("perceptionSettings", [project, workspace], request.signal),
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    localRequest(request, true);
    const patch = parsePerceptionPatch(await request.json());
    const query = new URL(request.url).searchParams;
    const project = query.get("project") ?? "", workspace = query.get("workspace") ?? "";
    return Response.json(await dashboardWorker().call("updatePerceptionSettings", [project, patch, workspace], request.signal),
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
