import type { FileMedia } from "../core/query/replay-types.ts";
import type { ReplayQuery } from "../core/query/replay.ts";
import { byteRange, fileResponse } from "./file-response.ts";
import { errorResponse, localRequest, normalizeOrigin } from "./local-request.ts";
import { verifyMediaTicket } from "./media-ticket.ts";
import type { RpcWorkerClient } from "./rpc-router.ts";
import { serveStaticFile } from "./static-files.ts";

export interface HttpRouteContext {
  pid: number;
  authMode: "none" | "token";
  mediaSecret: Buffer;
  trustedOrigins: ReadonlySet<string>;
  staticDir?: string;
  worker: RpcWorkerClient;
}

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

function badRequest(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 400 });
}

function buildHealthCorsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get("origin");
  return {
    "Access-Control-Allow-Origin": origin ? normalizeOrigin(origin) : "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function isLoopbackOrTrustedOrigin(origin: string, trustedOrigins: ReadonlySet<string>): boolean {
  const normalized = normalizeOrigin(origin);
  if (trustedOrigins.has(normalized)) return true;
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol === "file:" || parsed.protocol === "app:") return true;
    const host = parsed.hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

function buildMediaCorsHeaders(request: Request, ctx: HttpRouteContext): HeadersInit {
  const origin = request.headers.get("origin");
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Content-Type",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, Content-Type",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Vary": "Origin",
  };
  if (ctx.authMode === "token") {
    headers["Access-Control-Allow-Origin"] = origin ? normalizeOrigin(origin) : "*";
  } else if (!origin) {
    headers["Access-Control-Allow-Origin"] = "*";
  } else if (isLoopbackOrTrustedOrigin(origin, ctx.trustedOrigins)) {
    headers["Access-Control-Allow-Origin"] = normalizeOrigin(origin);
  }
  return headers;
}

function bufferMediaResponse(
  request: Request,
  bytesInput: Uint8Array,
  mediaType: string,
  cacheControl: string | undefined,
  extraHeaders: HeadersInit,
): Response {
  const buffer = Buffer.isBuffer(bytesInput) ? bytesInput : Buffer.from(bytesInput);
  const size = buffer.byteLength;
  const headers = new Headers({
    "Content-Type": mediaType,
    "Accept-Ranges": "bytes",
    "Cache-Control": cacheControl ?? "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  new Headers(extraHeaders).forEach((value, key) => {
    headers.set(key, value);
  });

  let range: ReturnType<typeof byteRange>;
  try {
    range = byteRange(request.headers.get("range"), size);
  } catch {
    headers.set("Content-Range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  headers.set("Content-Length", String(Math.max(0, end - start + 1)));
  if (range) {
    headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
  }
  if (request.method === "HEAD" || size === 0) {
    return new Response(null, { status: range ? 206 : 200, headers });
  }
  const slice = range ? buffer.subarray(start, end + 1) : buffer;
  const body = new ArrayBuffer(slice.byteLength);
  new Uint8Array(body).set(slice);
  return new Response(body, {
    status: range ? 206 : 200,
    headers,
  });
}

function authorizeMediaRequest(request: Request, url: URL, ctx: HttpRouteContext): Response | null {
  const ticket = url.searchParams.get("mt");
  const corsHeaders = buildMediaCorsHeaders(request, ctx);

  if (ctx.authMode === "token") {
    if (!verifyMediaTicket(ctx.mediaSecret, ticket)) {
      return Response.json(
        { error: "Unauthorized", code: "UNAUTHORIZED" },
        { status: 401, headers: { ...NO_STORE_HEADERS, ...corsHeaders } },
      );
    }
    return null;
  }

  // Loopback `auth.mode === "none"`: valid capability ticket or loopback Host/Origin check.
  if (ticket && verifyMediaTicket(ctx.mediaSecret, ticket)) {
    return null;
  }
  localRequest(request, { mutation: false, trustedOrigins: ctx.trustedOrigins });
  return null;
}

/**
 * Handles minimal non-RPC HTTP endpoints on `wsListen` (`/health`, `/media`, and optional static SPA).
 * Legacy `/api/*` REST JSON routes are completely removed in favor of JSON-RPC `/rpc` & UDS.
 */
export async function handleHttpRequest(
  request: Request,
  url: URL,
  ctx: HttpRouteContext,
): Promise<Response> {
  const method = request.method.toUpperCase();
  const pathname = url.pathname;

  if (pathname === "/health") {
    const cors = buildHealthCorsHeaders(request);
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { ...NO_STORE_HEADERS, ...cors } });
    }
    if (method !== "GET" && method !== "HEAD") {
      return Response.json(
        { error: "Method Not Allowed" },
        { status: 405, headers: { Allow: "GET, HEAD, OPTIONS", ...NO_STORE_HEADERS, ...cors } },
      );
    }
    if (method === "HEAD") {
      return new Response(null, { status: 200, headers: { ...NO_STORE_HEADERS, ...cors } });
    }
    return Response.json(
      { ok: true, pid: ctx.pid, authRequired: ctx.authMode === "token" },
      { headers: { ...NO_STORE_HEADERS, ...cors } },
    );
  }

  if (pathname === "/media") {
    const mediaCors = buildMediaCorsHeaders(request, ctx);
    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Max-Age": "600",
          ...NO_STORE_HEADERS,
          ...mediaCors,
        },
      });
    }
    if (method !== "GET" && method !== "HEAD") {
      return Response.json(
        { error: "Method Not Allowed" },
        { status: 405, headers: { Allow: "GET, HEAD, OPTIONS", ...NO_STORE_HEADERS, ...mediaCors } },
      );
    }

    try {
      const authError = authorizeMediaRequest(request, url, ctx);
      if (authError) return authError;

      const kind = url.searchParams.get("kind");
      const project = url.searchParams.get("project")?.trim();
      const run = url.searchParams.get("run")?.trim();
      if (!project || !run) {
        throw badRequest("Missing project or run parameter");
      }

      if (kind === "asset") {
        const id = url.searchParams.get("id")?.trim();
        if (!id) throw badRequest("Missing asset id parameter");
        const media = await ctx.worker.call("media", [project, run, id], request.signal);
        if (media && typeof media === "object" && "file" in media && typeof (media as { file?: unknown }).file === "string") {
          return await fileResponse(request, media as unknown as FileMedia, mediaCors);
        }
        return bufferMediaResponse(
          request,
          media.bytes,
          media.mediaType,
          media.cacheControl,
          mediaCors,
        );
      }

      if (kind === "replay") {
        const mode = url.searchParams.get("mode");
        if (mode !== "media" && mode !== "segment") {
          throw badRequest("Replay /media requires mode=media or mode=segment");
        }
        const rawNumber = (key: string): number | undefined => {
          const val = url.searchParams.get(key);
          if (val === null || val === "") return undefined;
          const parsed = Number(val);
          if (!Number.isFinite(parsed)) throw badRequest(`Invalid numeric parameter: ${key}`);
          return parsed;
        };
        const query: ReplayQuery = {
          mode,
          ...(url.searchParams.get("epoch") ? { epoch: url.searchParams.get("epoch")! } : {}),
          ...(url.searchParams.get("id") ? { id: url.searchParams.get("id")! } : {}),
          ...(url.searchParams.get("record") ? { record: url.searchParams.get("record")! } : {}),
          ...(rawNumber("sequence") !== undefined ? { sequence: rawNumber("sequence") } : {}),
          ...(rawNumber("media") !== undefined ? { media: rawNumber("media") } : {}),
          ...(url.searchParams.get("asset") ? { asset: url.searchParams.get("asset")! } : {}),
          ...(rawNumber("bytes") !== undefined ? { bytes: rawNumber("bytes") } : {}),
        };
        const result = await ctx.worker.call("replay", [project, run, query], request.signal);
        if (result && typeof result === "object" && "file" in result && typeof (result as { file?: unknown }).file === "string") {
          return await fileResponse(request, result as FileMedia, mediaCors);
        }
        if (result && typeof result === "object" && "bytes" in result && (result as { bytes?: unknown }).bytes !== undefined) {
          const bufMedia = result as { bytes: Uint8Array; mediaType?: string; cacheControl?: string };
          return bufferMediaResponse(
            request,
            bufMedia.bytes,
            bufMedia.mediaType ?? "application/octet-stream",
            bufMedia.cacheControl,
            mediaCors,
          );
        }
        return Response.json(
          { error: "Media not found", code: "NOT_FOUND" },
          { status: 404, headers: { ...NO_STORE_HEADERS, ...mediaCors } },
        );
      }

      throw badRequest("Media kind must be 'asset' or 'replay'");
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return Response.json(
      { error: "Legacy HTTP REST API removed; connect via JSON-RPC (/rpc or UDS)" },
      { status: 404, headers: NO_STORE_HEADERS },
    );
  }

  if (ctx.staticDir) {
    return serveStaticFile(request, ctx.staticDir, pathname);
  }

  return Response.json(
    { error: "Not Found" },
    { status: 404, headers: NO_STORE_HEADERS },
  );
}
