import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

export const APP_SERVER_SUN_PATH_LIMIT = 96;

export interface AppServerRuntimeInfo {
  pid: number;
  socketPath: string | null;
  wsUrl: string | null;
  authMode: "none" | "token";
  startedAt: string;
  home: string;
}

/** Resolve `<home>/run` directory where app-server runtime and lock metadata reside. */
export function appServerRunDir(home: string): string {
  return join(resolve(home), "run");
}

/** Resolve `<home>/run/app-server.json` runtime discovery file path. */
export function appServerRuntimeFilePath(home: string): string {
  return join(appServerRunDir(home), "app-server.json");
}

/** Resolve `<home>/run/app-server.lock` singleton startup lock directory/file path. */
export function appServerLockFilePath(home: string): string {
  return join(appServerRunDir(home), "app-server.lock");
}

/**
 * Resolve the local Unix Domain Socket path for a given Ludens home.
 * Automatically falls back to `/tmp/ludens-app-<uid>-<sha256>.sock` when
 * `<home>/run/app-server.sock` exceeds the macOS/BSD `sun_path` limit cleanly.
 */
export function resolveAppServerSocketPath(home: string): string {
  const canonicalHome = resolve(home);
  const preferred = join(canonicalHome, "run", "app-server.sock");
  if (Buffer.byteLength(preferred, "utf8") <= APP_SERVER_SUN_PATH_LIMIT) {
    return preferred;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const homeHash = createHash("sha256").update(canonicalHome, "utf8").digest("hex").slice(0, 12);
  return `/tmp/ludens-app-${uid}-${homeHash}.sock`;
}
