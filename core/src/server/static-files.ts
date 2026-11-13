import { open, realpath, type FileHandle } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

export function mimeTypeForPath(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

function extractRawPathname(urlText: string): string {
  const schemeEnd = urlText.indexOf("://");
  const pathStart = schemeEnd >= 0 ? urlText.indexOf("/", schemeEnd + 3) : urlText.indexOf("/");
  const withQuery = pathStart >= 0 ? urlText.slice(pathStart) : "/";
  const qIdx = withQuery.indexOf("?");
  const hashIdx = withQuery.indexOf("#");
  let end = withQuery.length;
  if (qIdx >= 0 && qIdx < end) end = qIdx;
  if (hashIdx >= 0 && hashIdx < end) end = hashIdx;
  return withQuery.slice(0, end) || "/";
}

function hasUnsafePathSegments(pathname: string): boolean {
  if (pathname.includes("\0") || pathname.includes("\\")) return true;
  for (const segment of pathname.split("/")) {
    if (segment === "..") return true;
  }
  return false;
}

function forbiddenResponse(): Response {
  return Response.json(
    { error: "Forbidden" },
    { status: 403, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
  );
}

function notFoundResponse(): Response {
  return Response.json(
    { error: "Not Found" },
    { status: 404, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
  );
}

async function openSafeFile(
  candidate: string,
  staticRoot: string,
  realStaticRoot: string,
): Promise<{ handle: FileHandle; path: string; size: number } | "forbidden" | null> {
  const resolved = resolve(candidate);
  if (resolved !== staticRoot && !resolved.startsWith(staticRoot + sep)) {
    return "forbidden";
  }
  let handle: FileHandle;
  try {
    handle = await open(resolved, "r");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") {
      return null;
    }
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      await handle.close();
      return null;
    }
    const realCandidate = await realpath(resolved);
    if (realCandidate !== realStaticRoot && !realCandidate.startsWith(realStaticRoot + sep)) {
      await handle.close();
      return "forbidden";
    }
    return { handle, path: realCandidate, size: info.size };
  } catch (error) {
    await handle.close().catch(() => {});
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") {
      return null;
    }
    throw error;
  }
}

/**
 * Serve static SPA files from `staticDir` with strict path-traversal rejection,
 * immutable caching for `/_next/static/*`, `no-cache` for HTML, and SPA `index.html` fallback.
 */
export async function serveStaticFile(
  request: Request,
  staticDir: string,
  rawPathnameOverride?: string,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return Response.json(
      { error: "Method Not Allowed" },
      { status: 405, headers: { Allow: "GET, HEAD", "Cache-Control": "no-store" } },
    );
  }

  const rawPathname = rawPathnameOverride ?? extractRawPathname(request.url);
  if (hasUnsafePathSegments(rawPathname)) {
    return forbiddenResponse();
  }

  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(rawPathname);
  } catch {
    return forbiddenResponse();
  }
  if (!decodedPathname.startsWith("/") || hasUnsafePathSegments(decodedPathname)) {
    return forbiddenResponse();
  }

  const staticRoot = resolve(staticDir);
  const realStaticRoot = await realpath(staticRoot).catch(() => staticRoot);
  const relativeTarget = decodedPathname.replace(/^\/+/, "");
  const directTarget = resolve(staticRoot, relativeTarget);
  if (directTarget !== staticRoot && !directTarget.startsWith(staticRoot + sep)) {
    return forbiddenResponse();
  }

  const candidates: string[] = [];
  if (relativeTarget === "") {
    candidates.push(join(staticRoot, "index.html"));
  } else {
    const cleanRel = relativeTarget.replace(/\/+$/, "");
    const leaf = basename(cleanRel);
    const hasExtension = leaf.includes(".") && !leaf.startsWith(".");
    candidates.push(join(staticRoot, cleanRel));
    if (!hasExtension) {
      candidates.push(join(staticRoot, cleanRel, "index.html"));
      candidates.push(join(staticRoot, `${cleanRel}.html`));
      candidates.push(join(staticRoot, "index.html"));
    }
  }

  let matched: { handle: FileHandle; path: string; size: number } | null = null;
  for (const candidate of candidates) {
    const checked = await openSafeFile(candidate, staticRoot, realStaticRoot);
    if (checked === "forbidden") return forbiddenResponse();
    if (checked) {
      matched = checked;
      break;
    }
  }

  if (!matched) {
    return notFoundResponse();
  }

  let ownsHandle = true;
  try {
    const mimeType = mimeTypeForPath(matched.path);
    const isHtml = extname(matched.path).toLowerCase() === ".html";
    const cacheControl = decodedPathname.startsWith("/_next/static/")
      ? "public, max-age=31536000, immutable"
      : isHtml
        ? "no-cache"
        : "public, max-age=3600";

    const headers = new Headers({
      "Content-Type": mimeType,
      "Content-Length": String(matched.size),
      "Cache-Control": cacheControl,
      "X-Content-Type-Options": "nosniff",
    });

    if (request.method === "HEAD" || matched.size === 0) {
      return new Response(null, { status: 200, headers });
    }

    request.signal.throwIfAborted();
    const stream = matched.handle.createReadStream({ autoClose: true, highWaterMark: 64 * 1024 });
    ownsHandle = false;
    const abort = () => stream.destroy(new DOMException("Aborted", "AbortError"));
    request.signal.addEventListener("abort", abort, { once: true });
    stream.once("close", () => request.signal.removeEventListener("abort", abort));
    return new Response(Readable.toWeb(stream) as unknown as BodyInit, { status: 200, headers });
  } finally {
    if (ownsHandle) await matched.handle.close().catch(() => {});
  }
}
