/** Shared local Electron BrowserHost UDS / Named Pipe discovery path contract. */

import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { APP_SERVER_SUN_PATH_LIMIT, appServerRunDir } from "./app-server-paths.ts";

export interface BrowserHostRuntimeInfo {
  hostId: string;
  pid: number;
  socketPath: string;
  startedAt: string;
  home: string;
  version: string;
}

/** Resolve `<home>/run/browser-host.json` runtime discovery file path. */
export function browserHostRuntimeFilePath(home: string): string {
  return join(appServerRunDir(home), "browser-host.json");
}

/**
 * Resolve the local IPC socket / Named Pipe path for the Desktop BrowserHost.
 * Mirrors `resolveAppServerSocketPath` (Windows Named Pipe + 96-byte BSD sun_path fallback).
 */
export function resolveBrowserHostSocketPath(home: string): string {
  const canonicalHome = resolve(home);
  const homeHash = createHash("sha256").update(canonicalHome, "utf8").digest("hex").slice(0, 12);
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\ludens-browser-${homeHash}`;
  }
  const preferred = join(canonicalHome, "run", "browser-host.sock");
  if (Buffer.byteLength(preferred, "utf8") <= APP_SERVER_SUN_PATH_LIMIT) {
    return preferred;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return `/tmp/ludens-browser-${uid}-${homeHash}.sock`;
}
