import { controlWorkspaceRuntime, type RuntimeControlCommand } from "@/lib/runtime-control";
import { localRequest, errorResponse } from "@/lib/local-request";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    localRequest(request, true);
    const body = await request.json() as { project?: string; workspace?: string; command?: RuntimeControlCommand };
    if (!body.project || !body.workspace || !body.command?.action) throw new Error("必须提供 project、workspace 与 command");
    return Response.json(await controlWorkspaceRuntime(body.project, body.workspace, body.command), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error, 409); }
}
