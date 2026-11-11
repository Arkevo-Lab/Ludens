import { dashboardWorker } from "@ludens/core/core/query/dashboard-worker";
import { controlWorkspaceRuntime } from "@/lib/runtime-control";
import { localRequest, errorResponse } from "@/lib/local-request";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    localRequest(request, true);
    const b = await request.json();
    if (b.action === "set_model") {
      const model = typeof b.model === "string" ? b.model.trim() : "";
      const slash = model.indexOf("/");
      if (!b.project || !b.workspace || !model || slash <= 0 || slash === model.length - 1) {
        throw new Error("必须提供 project、workspace 与有效的 provider/id 模型标识");
      }
      return Response.json(
        await controlWorkspaceRuntime(b.project, b.workspace, {
          action: "set_model",
          model,
          ...(typeof b.runId === "string"
            ? { runId: b.runId }
            : typeof b.run === "string"
              ? { runId: b.run }
              : {}),
          ...(b.expectedEpoch !== undefined
            ? { expectedEpoch: b.expectedEpoch }
            : b.epoch !== undefined
              ? { expectedEpoch: b.epoch }
              : {}),
        }),
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (b.action !== "off") throw new Error("仅支持交还控制权");
    return Response.json(await dashboardWorker().call("stop", [b.project, b.run, b.epoch], request.signal));
  } catch (e) {
    return errorResponse(e, 409);
  }
}
