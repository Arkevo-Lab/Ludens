export interface LocalRequestOptions {
  mutation?: boolean;
  trustedOrigins?: ReadonlySet<string> | readonly string[];
}

export function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, "");
}

function extractHostname(rawHost: string | null): string | null {
  if (!rawHost) return null;
  const trimmed = rawHost.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("[")) {
    const closeIdx = trimmed.indexOf("]");
    if (closeIdx <= 1) return null;
    const rest = trimmed.slice(closeIdx + 1);
    if (rest !== "" && !/^:\d+$/.test(rest)) return null;
    return trimmed.slice(0, closeIdx + 1).toLowerCase();
  }
  if (trimmed.toLowerCase() === "::1") return "[::1]";
  const parts = trimmed.split(":");
  if (parts.length > 2) return null;
  if (parts.length === 2 && !/^\d+$/.test(parts[1]!)) return null;
  return parts[0]!.toLowerCase();
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** HTTP trust checks stay outside the archive worker. */
export function localRequest(
  request: Request,
  optionsOrMutation: boolean | LocalRequestOptions = false,
): void {
  const options: LocalRequestOptions =
    typeof optionsOrMutation === "boolean" ? { mutation: optionsOrMutation } : optionsOrMutation;

  const rawHost = request.headers.get("host");
  const hostname = extractHostname(rawHost);
  if (!hostname || !LOOPBACK_HOSTS.has(hostname)) {
    throw Object.assign(new Error("只允许本地访问"), { status: 403 });
  }

  const rawForwardedHost = request.headers.get("x-forwarded-host");
  if (rawForwardedHost !== null) {
    const forwardedParts = rawForwardedHost.split(",");
    for (const part of forwardedParts) {
      const fwdHostname = extractHostname(part);
      if (!fwdHostname || !LOOPBACK_HOSTS.has(fwdHostname)) {
        throw Object.assign(new Error("只允许本地访问"), { status: 403 });
      }
    }
  }

  if (options.mutation) {
    const rawOrigin = request.headers.get("origin");
    const origin = rawOrigin ? normalizeOrigin(rawOrigin) : "";
    const url = new URL(request.url);
    const selfOrigin = normalizeOrigin(`${url.protocol}//${rawHost}`);
    let trusted = Boolean(origin) && origin === selfOrigin;
    if (!trusted && origin && options.trustedOrigins) {
      if (options.trustedOrigins instanceof Set) {
        trusted = options.trustedOrigins.has(origin);
      } else {
        for (const candidate of options.trustedOrigins) {
          if (normalizeOrigin(candidate) === origin) {
            trusted = true;
            break;
          }
        }
      }
    }
    if (!trusted) {
      throw Object.assign(new Error("只允许同源控制请求"), { status: 403 });
    }
  }
}

export function errorResponse(error: unknown, fallback = 400): Response {
  const value = (error ?? {}) as Error & { status?: number; code?: string; progress?: unknown; conflict?: unknown };
  return Response.json(
    {
      error: value.message ?? String(error),
      ...(value.code ? { code: value.code } : {}),
      ...(value.progress === undefined ? {} : { progress: value.progress }),
      ...(value.conflict === undefined ? {} : { conflict: value.conflict }),
    },
    {
      status: value.status ?? fallback,
      headers: {
        "Cache-Control": "no-store",
        ...([202, 409, 503].includes(value.status ?? 0) ? { "Retry-After": "1" } : {}),
      },
    },
  );
}
