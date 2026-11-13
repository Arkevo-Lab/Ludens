import {
  EVENT_DIRECTIONS,
  POOL_EVENT_STATUSES,
  type EventDirection,
  type PoolEventStatus,
} from "@ludens/protocol/event-pool";
import { isOmpEffort, isOmpServiceTier } from "@ludens/protocol/ludens";
import type { ActivityQuery } from "../core/query/activity";
import type { DashboardWorker } from "../core/query/dashboard-worker";
import type { DiagnosticQuery } from "../core/query/diagnostic-events";
import type { EventPoolMutationCommand, EventPoolQueryFilter } from "../core/query/event-pool";
import { parsePerceptionPatch } from "../core/query/perception-config";
import type { ReplayQuery } from "../core/query/replay";
import type { RuntimeControlCommand } from "../core/query/runtime-control";
import { controlWorkspaceService } from "../core/query/workspaces";
import type { WorkspaceSupervisor } from "../daemon/supervisor";
import { fileResponse } from "./file-response";
import { errorResponse, localRequest } from "./local-request";

export interface ApiRouteContext {
  home: string;
  worker: DashboardWorker;
  supervisor: WorkspaceSupervisor;
  trustedOrigins: ReadonlySet<string>;
  requestShutdown: () => void;
}

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

function methodNotAllowed(allowed: readonly string[]): Response {
  return Response.json(
    { error: "Method Not Allowed" },
    { status: 405, headers: { Allow: allowed.join(", "), "Cache-Control": "no-store" } },
  );
}

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { status: 400 });
}

async function readJsonObject(
  request: Request,
  invalidMessage = "请求体必须是 JSON 对象",
): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw badRequest("无效的 JSON 请求体");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw badRequest(invalidMessage);
  }
  return parsed as Record<string, unknown>;
}

export async function handleApiRequest(
  request: Request,
  url: URL,
  ctx: ApiRouteContext,
): Promise<Response> {
  const pathname = url.pathname.length > 1 && url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  const method = request.method.toUpperCase();
  const q = url.searchParams;
  const checkLocal = (mutation = false) =>
    localRequest(request, { mutation, trustedOrigins: ctx.trustedOrigins });

  switch (pathname) {
    case "/api/health": {
      if (method !== "GET") return methodNotAllowed(["GET"]);
      try {
        checkLocal(false);
        return Response.json(
          {
            ok: true,
            pid: process.pid,
            home: ctx.home,
            managedWorkspaces: ctx.supervisor.managedWorkspaceIds(),
          },
          { headers: NO_STORE_HEADERS },
        );
      } catch (error) {
        return errorResponse(error);
      }
    }

    case "/api/app-server/shutdown": {
      if (method !== "POST") return methodNotAllowed(["POST"]);
      try {
        checkLocal(true);
        ctx.requestShutdown();
        return Response.json(
          { ok: true },
          { headers: { "Cache-Control": "no-store", Connection: "close" } },
        );
      } catch (error) {
        return errorResponse(error);
      }
    }

    case "/api/activity": {
      if (method !== "GET") return methodNotAllowed(["GET"]);
      try {
        checkLocal(false);
        const mode = q.get("mode") ?? "changes";
        if (!["changes", "history", "block"].includes(mode)) throw new Error("无效的日志查询模式");
        return Response.json(
          await ctx.worker.call(
            "activity",
            [
              q.get("project") ?? "",
              q.get("run") ?? undefined,
              q.get("epoch") ?? undefined,
              {
                mode: mode as ActivityQuery["mode"],
                cursor: q.get("cursor") ?? undefined,
                before: q.get("before") ?? undefined,
                kind: q.get("kind") ?? undefined,
                q: q.get("q") ?? undefined,
                id: q.get("id") ?? undefined,
                limit: q.has("limit") ? Number(q.get("limit")) : undefined,
              },
            ],
            request.signal,
          ),
        );
      } catch (error) {
        return errorResponse(error);
      }
    }

    case "/api/baseware": {
      if (!["GET", "POST", "PUT", "DELETE"].includes(method)) {
        return methodNotAllowed(["GET", "POST", "PUT", "DELETE"]);
      }
      try {
        if (method === "GET") {
          checkLocal(false);
          const workspaceId = q.get("workspaceId") || undefined;
          return Response.json(
            await ctx.worker.call("basewareOverview", [workspaceId], request.signal),
            { headers: NO_STORE_HEADERS },
          );
        }
        checkLocal(true);
        const body = await readJsonObject(
          request,
          method === "PUT" ? "无效的 Baseware 配置更新" : "无效的 Baseware 操作",
        );
        if (method === "POST") {
          if (body.action === "upsertMachine") {
            return Response.json(await ctx.worker.call("upsertBasewareMachine", [body.machine], request.signal));
          }
          if (body.action === "probeMachine") {
            return Response.json(
              await ctx.worker.call(
                "probeBasewareMachine",
                [body.machine ?? { id: body.id as string }],
                request.signal,
              ),
            );
          }
          if (body.action === "controlWorkspaceMachine") {
            return Response.json(
              await ctx.worker.call(
                "controlWorkspaceMachine",
                [
                  body.workspaceId ?? body.id,
                  {
                    operation: body.operation as "up" | "down" | "reload",
                    machineId: body.machineId as string | undefined,
                  },
                ],
                request.signal,
              ),
            );
          }
          throw badRequest("未知的 Baseware 操作");
        }
        if (method === "PUT") {
          if (body.action === "workspaceMachines") {
            return Response.json(
              await ctx.worker.call("updateWorkspaceMachines", [body.id, body.binding], request.signal),
            );
          }
          throw badRequest("未知的 Baseware 配置更新");
        }
        return Response.json(await ctx.worker.call("removeBasewareMachine", [body.id], request.signal));
      } catch (error) {
        return errorResponse(error);
      }
    }

    case "/api/capabilities": {
      if (method !== "GET" && method !== "POST") return methodNotAllowed(["GET", "POST"]);
      try {
        if (method === "GET") {
          checkLocal(false);
          const project = q.get("project") ?? "";
          const workspace = q.get("workspace") ?? "";
          return Response.json(
            await ctx.worker.call("capabilities", [project, workspace], request.signal),
            { headers: NO_STORE_HEADERS },
          );
        }
        checkLocal(true);
        const body = await readJsonObject(request, "无效的能力评测请求");
        const project = typeof body.project === "string" ? body.project : "";
        const workspace = typeof body.workspace === "string" ? body.workspace : "";
        const capabilityId =
          typeof body.capabilityId === "string" && body.capabilityId.trim() ? body.capabilityId.trim() : undefined;
        const all = capabilityId ? false : Boolean(body.all ?? true);
        return Response.json(
          await ctx.worker.call(
            "runWorkspaceCapabilityEval",
            [project, workspace, { capabilityId, all }],
            request.signal,
          ),
          { headers: NO_STORE_HEADERS },
        );
      } catch (error) {
        return errorResponse(error);
      }
    }

    case "/api/capabilities/runtime": {
      if (method !== "GET") return methodNotAllowed(["GET"]);
      try {
        checkLocal(false);
        const project = q.get("project") ?? "";
        const workspace = q.get("workspace") ?? "";
        return Response.json(
          await ctx.worker.call("capabilityRuntime", [project, workspace], request.signal),
          { headers: NO_STORE_HEADERS },
        );
      } catch (error) {
        return errorResponse(error);
      }
    }

    case "/api/catalog": {
      if (method !== "GET") return methodNotAllowed(["GET"]);
      try {
        checkLocal(false);
        const includeEmpty = q.get("includeEmpty") === "1";
        return Response.json(await ctx.worker.call("catalog", [includeEmpty], request.signal));
      } catch (error) {
        return errorResponse(error);
      }
    }

    case "/api/control": {
      if (method !== "POST") return methodNotAllowed(["POST"]);
      try {
        checkLocal(true);
        const b = await readJsonObject(request, "无效的控制请求");
        if (b.action === "set_model") {
          const model = typeof b.model === "string" ? b.model.trim() : "";
          const slash = model.indexOf("/");
          const serviceTier = b.serviceTier;
          const effort = b.effort;
          if (serviceTier !== undefined && serviceTier !== null && !isOmpServiceTier(serviceTier)) {
            throw badRequest("serviceTier 必须是 priority、ultrafast 或 null");
          }
          if (effort !== undefined && effort !== null && !isOmpEffort(effort)) {
            throw badRequest("effort 必须是 minimal、low、medium、high、xhigh、max 或 null");
          }
          if (
            typeof b.project !== "string" ||
            !b.project ||
            typeof b.workspace !== "string" ||
            !b.workspace ||
            !model ||
            slash <= 0 ||
            slash === model.length - 1
          ) {
            throw badRequest("必须提供 project、workspace 与有效的 provider/id 模型标识");
          }
          return Response.json(
            await ctx.worker.call(
              "runtimeControl",
              [
                b.project,
                b.workspace,
                {
                  action: "set_model",
                  model,
                  ...(serviceTier !== undefined ? { serviceTier } : {}),
                  ...(effort !== undefined ? { effort } : {}),
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
                } as RuntimeControlCommand,
              ],
              request.signal,
            ),
            { headers: NO_STORE_HEADERS },
          );
        }
        if (b.action !== "off") throw badRequest("仅支持交还控制权");
        return Response.json(
          await ctx.worker.call(
            "stop",
            [
              typeof b.project === "string" ? b.project : "",
              typeof b.run === "string" ? b.run : "",
              typeof b.epoch === "string" ? b.epoch : null,
            ],
            request.signal,
          ),
        );
      } catch (error) {
        return errorResponse(error, 409);
      }
    }

    case "/api/diagnostics": {
      if (method !== "GET") return methodNotAllowed(["GET"]);
      try {
        checkLocal(false);
        const query: DiagnosticQuery = {};
        for (const key of ["afterPosition", "limit"] as const) {
          if (q.has(key)) {
            const value = Number(q.get(key));
            if (!Number.isSafeInteger(value) || value < (key === "limit" ? 1 : 0)) {
              throw new Error("无效的诊断分页参数");
            }
            query[key] = value;
          }
        }
        for (const key of [
          "epoch",
          "fromAt",
          "toAt",
          "traceId",
          "spanId",
          "actionId",
          "observationId",
        ] as const) {
          if (q.has(key)) query[key] = q.get(key)!;
        }
        return Response.json(
          await ctx.worker.call(
            "diagnosticEvents",
            [q.get("project") ?? "", q.get("run") ?? "", query],
            request.signal,
          ),
        );
      } catch (error) {
        return errorResponse(error);
      }
    }

    case "/api/docs": {
      if (method !== "GET") return methodNotAllowed(["GET"]);
      try {
        checkLocal(false);
        const id = q.get("doc") ?? "";
        const lang = q.get("lang") === "zh" ? "zh" : "en";
        return Response.json(
          id
            ? await ctx.worker.call("readDoc", [id, undefined, lang], request.signal)
            : await ctx.worker.call("docGroups", [undefined, lang], request.signal),
        );
      } catch (error) {
        return errorResponse(error);
      }
    }

    case "/api/drivers/discover": {
      if (method !== "POST") return methodNotAllowed(["POST"]);
      try {
        checkLocal(true);
        const body = await readJsonObject(request, "驱动包地址必须是字符串");
        if (typeof body.spec !== "string") {
          throw badRequest("驱动包地址必须是字符串");
        }
        return Response.json(await ctx.worker.call("discoverDriver", [body.spec], request.signal));
      } catch (error) {
        return errorResponse(error);
      }
    }

    case "/api/event-pool": {
      if (method !== "GET" && method !== "POST") return methodNotAllowed(["GET", "POST"]);
      try {
        if (method === "GET") {
          checkLocal(false);
          const project = q.get("project")?.trim() ?? "";
          const workspace = q.get("workspace")?.trim() ?? "";
          if (!project || !workspace) {
            throw Object.assign(new Error("必须提供 project 与 workspace"), { status: 400 });
          }
          const directionParam = q.get("direction")?.trim();
          const statusParam = q.get("status")?.trim();
          const limitParam = q.get("limit")?.trim();
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
          const result = await ctx.worker.call("eventPoolRead", [project, workspace, filter], request.signal);
          return Response.json(result, { headers: NO_STORE_HEADERS });
        }
        checkLocal(true);
        const rawBody = await readJsonObject(request, "无效的事件池操作");
        const body = rawBody as {
          project?: string;
          workspace?: string;
          command?: EventPoolMutationCommand;
        };
        if (
          typeof body.project !== "string" ||
          !body.project ||
          typeof body.workspace !== "string" ||
          !body.workspace ||
          !body.command ||
          typeof body.command !== "object" ||
          !body.command.action
        ) {
          throw badRequest("必须提供 project、workspace 与 command");
        }
        const result = await ctx.worker.call(
          "eventPoolMutate",
          [body.project, body.workspace, body.command],
          request.signal,
        );
        return Response.json(result, { headers: NO_STORE_HEADERS });
      } catch (error) {
        return errorResponse(error, 409);
      }
    }

    case "/api/media": {
      if (method !== "GET") return methodNotAllowed(["GET"]);
      try {
        checkLocal(false);
        if (q.has("record")) {
          return Response.json(
            await ctx.worker.call(
              "timelineRecord",
              [
                q.get("project") ?? "",
                q.get("run") ?? "",
                q.get("record") ?? "",
                Number(q.get("sequence")),
                { call: q.get("call") ?? undefined, observation: q.get("id") ?? undefined },
              ],
              request.signal,
            ),
            { headers: NO_STORE_HEADERS },
          );
        }
        const m = await ctx.worker.call(
          "media",
          [q.get("project") ?? "", q.get("run") ?? "", q.get("id") ?? ""],
          request.signal,
        );
        return new Response(new Uint8Array(m.bytes), {
          headers: {
            "Content-Type": m.mediaType,
            "Cache-Control": m.cacheControl,
          },
        });
      } catch (error) {
        return errorResponse(error, 404);
      }
    }

    case "/api/models": {
      if (method !== "GET") return methodNotAllowed(["GET"]);
      try {
        checkLocal(false);
        const project = q.get("project")?.trim() || undefined;
        const catalog = await ctx.worker.call(
          "availableModels",
          project ? [project] : [],
          request.signal,
        );
        return Response.json(catalog, { headers: NO_STORE_HEADERS });
      } catch (error) {
        return errorResponse(error);
      }
    }

    case "/api/perception-config": {
      if (method !== "GET" && method !== "PUT") return methodNotAllowed(["GET", "PUT"]);
      try {
        const project = q.get("project") ?? "";
        const workspace = q.get("workspace") ?? "";
        if (method === "GET") {
          checkLocal(false);
          return Response.json(
            await ctx.worker.call("perceptionSettings", [project, workspace], request.signal),
            { headers: NO_STORE_HEADERS },
          );
        }
        checkLocal(true);
        const patch = parsePerceptionPatch(await request.json());
        return Response.json(
          await ctx.worker.call("updatePerceptionSettings", [project, patch, workspace], request.signal),
          { headers: NO_STORE_HEADERS },
        );
      } catch (error) {
        return errorResponse(error);
      }
    }

    case "/api/perception-config/runtime": {
      if (method !== "GET") return methodNotAllowed(["GET"]);
      try {
        checkLocal(false);
        const project = q.get("project") ?? "";
        const workspace = q.get("workspace") ?? "";
        return Response.json(
          await ctx.worker.call("perceptionRuntime", [project, workspace], request.signal),
          { headers: NO_STORE_HEADERS },
        );
      } catch (error) {
        return errorResponse(error);
      }
    }

    case "/api/pet": {
      if (method !== "GET" && method !== "PUT" && method !== "POST") {
        return methodNotAllowed(["GET", "PUT", "POST"]);
      }
      try {
        if (method === "GET") {
          checkLocal(false);
          return Response.json(await ctx.worker.call("petState", [], request.signal), {
            headers: NO_STORE_HEADERS,
          });
        }
        checkLocal(true);
        const input = await readJsonObject(request, "无效的 Pet 请求");
        if (method === "PUT") {
          return Response.json(
            await ctx.worker.call("petTarget", [input.project, input.ifUnset === true], request.signal),
          );
        }
        return Response.json(await ctx.worker.call("petConsumer", [input], request.signal));
      } catch (error) {
        return errorResponse(error);
      }
    }

    case "/api/replay": {
      if (method !== "GET" && method !== "HEAD") return methodNotAllowed(["GET", "HEAD"]);
      try {
        checkLocal(false);
        const result = await ctx.worker.call(
          "replay",
          [
            q.get("project") ?? "",
            q.get("run") ?? "",
            {
              mode: (q.get("mode") ?? "overview") as ReplayQuery["mode"],
              epoch: q.get("epoch") ?? undefined,
              start: q.has("start") ? Number(q.get("start")) : undefined,
              end: q.has("end") ? Number(q.get("end")) : undefined,
              cursor: q.get("cursor") ?? undefined,
              id: q.get("id") ?? undefined,
              record: q.get("record") ?? undefined,
              sequence: q.has("sequence") ? Number(q.get("sequence")) : undefined,
              media: q.has("media") ? Number(q.get("media")) : undefined,
              asset: q.get("asset") ?? undefined,
              bytes: q.has("bytes") ? Number(q.get("bytes")) : undefined,
              q: q.get("q") ?? undefined,
              track: (q.get("track") ?? undefined) as ReplayQuery["track"],
            },
          ],
          request.signal,
        );
        if ("file" in result) return await fileResponse(request, result);
        if ("bytes" in result) {
          return new Response(new Uint8Array(result.bytes), {
            headers: {
              "Content-Type": result.mediaType,
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
            },
          });
        }
        return Response.json(result, { headers: NO_STORE_HEADERS });
      } catch (error) {
        return errorResponse(error);
      }
    }

    case "/api/run": {
      if (method !== "GET" && method !== "POST") return methodNotAllowed(["GET", "POST"]);
      if (method === "GET") {
        try {
          checkLocal(false);
          if (q.get("build") === "state") {
            return Response.json(
              await ctx.worker.call("archiveBuild", [q.get("project") ?? "", q.get("run") ?? ""], request.signal),
            );
          }
          const beforeCall = q.has("beforeCall") ? Number(q.get("beforeCall")) : undefined;
          if (beforeCall !== undefined && (!Number.isSafeInteger(beforeCall) || beforeCall < 1)) {
            throw new Error("无效的请求分页位置");
          }
          return Response.json(
            await ctx.worker.call(
              "run",
              [
                q.get("project") ?? "",
                q.get("run") ?? "",
                q.get("epoch") ?? undefined,
                { beforeCall, call: q.get("call") ?? undefined, image: q.get("image") ?? undefined },
              ],
              request.signal,
            ),
          );
        } catch (error) {
          return errorResponse(error);
        }
      }
      try {
        checkLocal(true);
        const body = await readJsonObject(request, "无效的目录构建操作");
        if (
          typeof body.project !== "string" ||
          typeof body.run !== "string" ||
          typeof body.buildId !== "string" ||
          !body.buildId ||
          (body.action !== "cancel" && body.action !== "retry")
        ) {
          throw badRequest("无效的目录构建操作");
        }
        return Response.json(
          await ctx.worker.call(
            "archiveBuild",
            [body.project, body.run, body.action, body.buildId],
            request.signal,
          ),
        );
      } catch (error) {
        return errorResponse(error, 409);
      }
    }

    case "/api/runtime/control": {
      if (method !== "POST") return methodNotAllowed(["POST"]);
      try {
        checkLocal(true);
        const rawBody = await readJsonObject(request, "必须提供 project、workspace 与 command");
        const body = rawBody as {
          project?: string;
          workspace?: string;
          command?: RuntimeControlCommand;
        };
        if (
          typeof body.project !== "string" ||
          !body.project ||
          typeof body.workspace !== "string" ||
          !body.workspace ||
          !body.command ||
          typeof body.command !== "object" ||
          !body.command.action
        ) {
          throw badRequest("必须提供 project、workspace 与 command");
        }
        return Response.json(
          await ctx.worker.call(
            "runtimeControl",
            [body.project, body.workspace, body.command],
            request.signal,
          ),
          { headers: NO_STORE_HEADERS },
        );
      } catch (error) {
        return errorResponse(error, 409);
      }
    }

    case "/api/workspaces": {
      if (!["GET", "POST", "PUT", "DELETE"].includes(method)) {
        return methodNotAllowed(["GET", "POST", "PUT", "DELETE"]);
      }
      try {
        if (method === "GET") {
          checkLocal(false);
          const studioId = q.get("studio");
          if (studioId) {
            return Response.json(await ctx.worker.call("workspaceStudio", [studioId], request.signal), {
              headers: NO_STORE_HEADERS,
            });
          }
          const workspaceId = q.get("workspaceId");
          if (workspaceId) {
            return Response.json(await ctx.worker.call("workspaceConnection", [workspaceId], request.signal), {
              headers: NO_STORE_HEADERS,
            });
          }
          return Response.json(await ctx.worker.call("workspaceSettings", [], request.signal), {
            headers: NO_STORE_HEADERS,
          });
        }
        checkLocal(true);
        const body = await readJsonObject(request, "无效的工作区操作");
        if (method === "POST") {
          if (body.action === "register") {
            return Response.json(await ctx.worker.call("openWorkspace", [body.workspace], request.signal));
          }
          if (body.action === "create") {
            return Response.json(await ctx.worker.call("createWorkspace", [body.workspace], request.signal));
          }
          throw badRequest("未知的工作区操作");
        }
        if (method === "PUT") {
          if (body?.action === "globalConnection") {
            return Response.json(
              await ctx.worker.call("updateGlobalConnection", [body.connection], request.signal),
            );
          }
          if (body?.action === "globalDefaults") {
            return Response.json(await ctx.worker.call("updateGlobalDefaults", [body.defaults], request.signal));
          }
          if (body?.action === "workspaceConnection") {
            return Response.json(
              await ctx.worker.call("updateWorkspaceConnection", [body.id, body.connection], request.signal),
            );
          }
          if (body?.action === "workspaceStudioConfig") {
            return Response.json(
              await ctx.worker.call("updateWorkspaceStudioConfig", [body.id, body.patch], request.signal),
            );
          }
          if (body?.action === "workspaceShiori") {
            return Response.json(
              await ctx.worker.call("updateWorkspaceShiori", [body.id, body.shiori], request.signal),
            );
          }
          if (body?.action === "workspaceServiceControl") {
            const result = await controlWorkspaceService(body.id, body.service, ctx.home, ctx.supervisor);
            await ctx.worker.call("clearCatalogCache", []).catch(() => null);
            return Response.json(result);
          }
          return Response.json(await ctx.worker.call("updateWorkspaceRoot", [body?.workspaceRoot], request.signal));
        }
        return Response.json(await ctx.worker.call("removeWorkspace", [body?.id], request.signal));
      } catch (error) {
        return errorResponse(error);
      }
    }

    default:
      return Response.json({ error: "Not Found" }, { status: 404, headers: NO_STORE_HEADERS });
  }
}
