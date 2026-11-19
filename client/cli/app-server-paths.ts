import { readFile } from "node:fs/promises";
import {
  APP_SERVER_SUN_PATH_LIMIT,
  appServerLockFilePath,
  appServerRunDir,
  appServerRuntimeFilePath,
  resolveAppServerSocketPath,
  type AppServerRuntimeInfo,
} from "@ludens/protocol/app-server-paths";

export {
  APP_SERVER_SUN_PATH_LIMIT,
  appServerLockFilePath,
  appServerRunDir,
  appServerRuntimeFilePath,
  resolveAppServerSocketPath,
  type AppServerRuntimeInfo,
};

/** Read `<home>/run/app-server.json` runtime discovery file if present and valid. */
export async function readAppServerRuntimeInfo(home: string): Promise<AppServerRuntimeInfo | null> {
  try {
    const raw = await readFile(appServerRuntimeFilePath(home), "utf8");
    const parsed = JSON.parse(raw) as Partial<AppServerRuntimeInfo>;
    if (
      typeof parsed.pid !== "number" ||
      !Number.isInteger(parsed.pid) ||
      typeof parsed.home !== "string"
    ) {
      return null;
    }
    return {
      pid: parsed.pid,
      socketPath: typeof parsed.socketPath === "string" ? parsed.socketPath : null,
      wsUrl: typeof parsed.wsUrl === "string" ? parsed.wsUrl : null,
      authMode: parsed.authMode === "token" ? "token" : "none",
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
      home: parsed.home,
    };
  } catch {
    return null;
  }
}
