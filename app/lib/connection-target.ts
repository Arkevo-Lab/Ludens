export const CONNECTION_TARGET_STORAGE_KEY = "ludens.connectionTarget";
export const SAME_ORIGIN_TOKEN_SESSION_KEY = "ludens.sameOriginToken";

export type ConnectionTarget =
  | { readonly kind: "electron-local" }
  | { readonly kind: "same-origin"; readonly token?: string }
  | { readonly kind: "remote"; readonly url: string; readonly token?: string };

export type NormalizedRemoteEndpoint =
  | {
      readonly ok: true;
      /** Canonical base URL (`http(s)://host[:port][basePath]`, without `/rpc`). */
      readonly canonicalUrl: string;
      /** HTTP origin (`http(s)://host[:port]`). */
      readonly httpOrigin: string;
      /** WebSocket RPC endpoint (`ws(s)://host[:port][basePath]/rpc`). */
      readonly wsUrl: string;
    }
  | {
      readonly ok: false;
      readonly error: "empty" | "invalid-url" | "unsupported-protocol";
    };

export type ResolvedConnectionEndpoints =
  | {
      readonly ok: true;
      readonly kind: ConnectionTarget["kind"];
      readonly transport: "ipc" | "ws";
      readonly wsUrl?: string;
      readonly httpOrigin?: string;
      readonly mediaBaseUrl: string;
      readonly token?: string;
      readonly displayTarget: string;
    }
  | {
      readonly ok: false;
      readonly kind: ConnectionTarget["kind"];
      readonly error: "unconfigured" | "invalid-url" | "unsupported-protocol" | "ipc-unavailable";
      readonly displayTarget: string;
    };

export interface ConnectionEnv {
  readonly hasDesktopRpc?: boolean;
  readonly location?: Pick<Location, "protocol" | "host" | "pathname" | "search" | "hash">;
  readonly history?: Pick<History, "replaceState">;
  readonly localStorage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  readonly sessionStorage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}

export interface HashBootstrapResult {
  readonly token?: string;
  readonly remote?: string;
  readonly scrubbed: boolean;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function hasDesktopRpcBridge(
  win: Window | undefined = typeof window !== "undefined" ? window : undefined,
): boolean {
  return Boolean(win?.ludens?.rpc && typeof win.ludens.rpc.send === "function");
}

function trimOptionalToken(token: string | null | undefined): string | undefined {
  if (typeof token !== "string") return undefined;
  const trimmed = token.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function safeStorage(getter: () => Storage | undefined): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  try {
    const store = getter();
    if (store) return store;
  } catch {
    // Storage may throw in restricted origins or sandboxed contexts.
  }
  return {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
}

function defaultEnv(overrides?: ConnectionEnv): Required<ConnectionEnv> {
  const win = typeof window !== "undefined" ? window : undefined;
  return {
    hasDesktopRpc: overrides?.hasDesktopRpc ?? hasDesktopRpcBridge(win),
    location: overrides?.location ?? (typeof location !== "undefined" ? location : {
      protocol: "",
      host: "",
      pathname: "/",
      search: "",
      hash: "",
    }),
    history: overrides?.history ?? (typeof history !== "undefined" ? history : {
      replaceState: () => {},
    }),
    localStorage: overrides?.localStorage ?? safeStorage(() => win?.localStorage),
    sessionStorage: overrides?.sessionStorage ?? safeStorage(() => win?.sessionStorage),
  };
}

/**
 * Normalizes `http(s)://...`, `ws(s)://...`, or bare `host:port` into HTTP origin + WS `/rpc` endpoint.
 */
export function normalizeRemoteUrl(rawInput: string): NormalizedRemoteEndpoint {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return { ok: false, error: "empty" };
  }

  let candidate = trimmed;
  if (!/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(candidate)) {
    const hostPart = candidate.split("/")[0] ?? "";
    const hostWithoutPort = hostPart.startsWith("[")
      ? hostPart.slice(0, hostPart.indexOf("]") + 1)
      : hostPart.split(":")[0] ?? "";
    const isLocalOrExplicitPort =
      LOOPBACK_HOSTS.has(hostWithoutPort.toLowerCase()) ||
      /^\d+\.\d+\.\d+\.\d+$/.test(hostWithoutPort) ||
      /:(\d+)$/.test(hostPart);
    candidate = `${isLocalOrExplicitPort ? "http" : "https"}://${candidate}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, error: "invalid-url" };
  }

  const proto = parsed.protocol.toLowerCase();
  if (proto !== "http:" && proto !== "https:" && proto !== "ws:" && proto !== "wss:") {
    return { ok: false, error: "unsupported-protocol" };
  }
  if (!parsed.host) {
    return { ok: false, error: "invalid-url" };
  }

  const secure = proto === "https:" || proto === "wss:";
  const httpProto = secure ? "https:" : "http:";
  const wsProto = secure ? "wss:" : "ws:";

  let pathname = parsed.pathname.replace(/\/+$/, "");
  if (pathname.endsWith("/rpc")) {
    pathname = pathname.slice(0, -4);
  }
  const basePath = pathname && pathname !== "/" ? pathname : "";

  const httpOrigin = `${httpProto}//${parsed.host}`;
  const canonicalUrl = `${httpOrigin}${basePath}`;
  const wsUrl = `${wsProto}//${parsed.host}${basePath}/rpc`;

  return {
    ok: true,
    canonicalUrl,
    httpOrigin,
    wsUrl,
  };
}

/**
 * Parses URL hash bootstrap parameters (`#token=...` and optional `remote=...`) and immediately
 * erases `location.hash` via `history.replaceState` so tokens never stay in address bars or history.
 */
export function consumeUrlHashBootstrap(overrides?: ConnectionEnv): HashBootstrapResult {
  const env = defaultEnv(overrides);
  const hash = env.location.hash ?? "";
  if (!hash || hash === "#") {
    return { scrubbed: false };
  }

  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  const params = new URLSearchParams(fragment);
  const token = trimOptionalToken(params.get("token"));
  const remoteRaw = trimOptionalToken(params.get("remote"));

  if (!token && !remoteRaw) {
    return { scrubbed: false };
  }

  const cleanUrl = `${env.location.pathname || "/"}${env.location.search || ""}`;
  try {
    env.history.replaceState(null, "", cleanUrl);
  } catch {
    // Best-effort even if history API is restricted.
  }

  return {
    token,
    remote: remoteRaw,
    scrubbed: true,
  };
}

export function loadStoredConnectionTarget(overrides?: ConnectionEnv): ConnectionTarget | null {
  const env = defaultEnv(overrides);
  try {
    const raw = env.localStorage.getItem(CONNECTION_TARGET_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    if (record.kind === "remote" && typeof record.url === "string") {
      const normalized = normalizeRemoteUrl(record.url);
      if (!normalized.ok) return null;
      const token = trimOptionalToken(typeof record.token === "string" ? record.token : undefined);
      return token
        ? { kind: "remote", url: normalized.canonicalUrl, token }
        : { kind: "remote", url: normalized.canonicalUrl };
    }
    if (record.kind === "same-origin") {
      const sessionToken = trimOptionalToken(env.sessionStorage.getItem(SAME_ORIGIN_TOKEN_SESSION_KEY));
      const token = sessionToken ?? trimOptionalToken(typeof record.token === "string" ? record.token : undefined);
      return token ? { kind: "same-origin", token } : { kind: "same-origin" };
    }
    if (record.kind === "electron-local" && env.hasDesktopRpc) {
      return { kind: "electron-local" };
    }
  } catch {
    // Ignore invalid JSON payloads.
  }
  return null;
}

export function saveConnectionTarget(target: ConnectionTarget, overrides?: ConnectionEnv): void {
  const env = defaultEnv(overrides);
  try {
    if (target.kind === "remote") {
      const normalized = normalizeRemoteUrl(target.url);
      const url = normalized.ok ? normalized.canonicalUrl : target.url.trim();
      const token = trimOptionalToken(target.token);
      env.localStorage.setItem(
        CONNECTION_TARGET_STORAGE_KEY,
        JSON.stringify(token ? { kind: "remote", url, token } : { kind: "remote", url }),
      );
      return;
    }
    if (target.kind === "same-origin") {
      env.localStorage.setItem(CONNECTION_TARGET_STORAGE_KEY, JSON.stringify({ kind: "same-origin" }));
      const token = trimOptionalToken(target.token);
      if (token) {
        env.sessionStorage.setItem(SAME_ORIGIN_TOKEN_SESSION_KEY, token);
      } else {
        env.sessionStorage.removeItem(SAME_ORIGIN_TOKEN_SESSION_KEY);
      }
      return;
    }
    env.localStorage.removeItem(CONNECTION_TARGET_STORAGE_KEY);
    env.sessionStorage.removeItem(SAME_ORIGIN_TOKEN_SESSION_KEY);
  } catch {
    // Ignore storage failures.
  }
}

export function clearStoredConnectionTarget(overrides?: ConnectionEnv): void {
  const env = defaultEnv(overrides);
  try {
    env.localStorage.removeItem(CONNECTION_TARGET_STORAGE_KEY);
    env.sessionStorage.removeItem(SAME_ORIGIN_TOKEN_SESSION_KEY);
  } catch {
    // Ignore storage failures.
  }
}

export function isSameOriginAvailable(overrides?: ConnectionEnv): boolean {
  const env = defaultEnv(overrides);
  const proto = (env.location.protocol ?? "").toLowerCase();
  return (proto === "http:" || proto === "https:") && Boolean(env.location.host);
}

/**
 * Resolves the startup `ConnectionTarget` synchronously, scrubbing any `#token=` hash first.
 */
export function resolveInitialConnectionTarget(overrides?: ConnectionEnv): {
  readonly target: ConnectionTarget;
  readonly hashBootstrapped: boolean;
} {
  const env = defaultEnv(overrides);
  const hashResult = consumeUrlHashBootstrap(env);

  if (hashResult.remote) {
    const normalized = normalizeRemoteUrl(hashResult.remote);
    if (normalized.ok) {
      const remoteTarget: ConnectionTarget = hashResult.token
        ? { kind: "remote", url: normalized.canonicalUrl, token: hashResult.token }
        : { kind: "remote", url: normalized.canonicalUrl };
      saveConnectionTarget(remoteTarget, env);
      return { target: remoteTarget, hashBootstrapped: hashResult.scrubbed };
    }
  }

  const stored = loadStoredConnectionTarget(env);
  if (stored) {
    if (hashResult.token) {
      if (stored.kind === "remote") {
        const updated: ConnectionTarget = { kind: "remote", url: stored.url, token: hashResult.token };
        saveConnectionTarget(updated, env);
        return { target: updated, hashBootstrapped: hashResult.scrubbed };
      }
      if (stored.kind === "same-origin") {
        try {
          env.sessionStorage.setItem(SAME_ORIGIN_TOKEN_SESSION_KEY, hashResult.token);
        } catch {
          // Keep in memory only.
        }
        return {
          target: { kind: "same-origin", token: hashResult.token },
          hashBootstrapped: hashResult.scrubbed,
        };
      }
    }
    return { target: stored, hashBootstrapped: hashResult.scrubbed };
  }

  if (env.hasDesktopRpc && !hashResult.token) {
    return { target: { kind: "electron-local" }, hashBootstrapped: hashResult.scrubbed };
  }

  const sessionToken = trimOptionalToken(env.sessionStorage.getItem(SAME_ORIGIN_TOKEN_SESSION_KEY));
  const effectiveToken = hashResult.token ?? sessionToken;
  if (hashResult.token) {
    try {
      env.sessionStorage.setItem(SAME_ORIGIN_TOKEN_SESSION_KEY, hashResult.token);
    } catch {
      // Keep in memory only.
    }
  }

  if (isSameOriginAvailable(env)) {
    return {
      target: effectiveToken ? { kind: "same-origin", token: effectiveToken } : { kind: "same-origin" },
      hashBootstrapped: hashResult.scrubbed,
    };
  }

  if (env.hasDesktopRpc) {
    return { target: { kind: "electron-local" }, hashBootstrapped: hashResult.scrubbed };
  }

  return {
    target: { kind: "remote", url: "", ...(effectiveToken ? { token: effectiveToken } : {}) },
    hashBootstrapped: hashResult.scrubbed,
  };
}

export function resolveConnectionEndpoints(
  target: ConnectionTarget,
  overrides?: ConnectionEnv,
): ResolvedConnectionEndpoints {
  const env = defaultEnv(overrides);

  if (target.kind === "electron-local") {
    if (!env.hasDesktopRpc) {
      return {
        ok: false,
        kind: "electron-local",
        error: "ipc-unavailable",
        displayTarget: "Desktop IPC",
      };
    }
    return {
      ok: true,
      kind: "electron-local",
      transport: "ipc",
      mediaBaseUrl: "ludens-media://local",
      displayTarget: "Desktop IPC",
    };
  }

  if (target.kind === "same-origin") {
    if (!isSameOriginAvailable(env)) {
      return {
        ok: false,
        kind: "same-origin",
        error: "unconfigured",
        displayTarget: "Same-Origin",
      };
    }
    const proto = env.location.protocol.toLowerCase();
    const httpOrigin = `${proto}//${env.location.host}`;
    const wsProto = proto === "https:" ? "wss:" : "ws:";
    return {
      ok: true,
      kind: "same-origin",
      transport: "ws",
      wsUrl: `${wsProto}//${env.location.host}/rpc`,
      httpOrigin,
      mediaBaseUrl: httpOrigin,
      token: trimOptionalToken(target.token),
      displayTarget: env.location.host,
    };
  }

  const normalized = normalizeRemoteUrl(target.url);
  if (!normalized.ok) {
    return {
      ok: false,
      kind: "remote",
      error: normalized.error === "empty" ? "unconfigured" : normalized.error,
      displayTarget: target.url.trim() || "Remote",
    };
  }

  return {
    ok: true,
    kind: "remote",
    transport: "ws",
    wsUrl: normalized.wsUrl,
    httpOrigin: normalized.httpOrigin,
    mediaBaseUrl: normalized.canonicalUrl,
    token: trimOptionalToken(target.token),
    displayTarget: normalized.canonicalUrl,
  };
}
