import { dashboardWorker } from "@ludens/core/core/query/dashboard-worker";
import { localRequest, errorResponse } from "@/lib/local-request";
import type { AvailableModelsCatalog } from "@/components/model-picker-dialog";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    localRequest(request);
    const project = new URL(request.url).searchParams.get("project")?.trim() || undefined;
    const worker = dashboardWorker() as unknown as {
      call(
        method: "availableModels",
        args: [string] | [],
        signal?: AbortSignal,
      ): Promise<AvailableModelsCatalog>;
    };
    const catalog = await worker.call(
      "availableModels",
      project ? [project] : [],
      request.signal,
    );
    return Response.json(catalog, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
