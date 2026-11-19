import { localServiceSocketPath } from "@ludens/protocol/local-socket";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ServiceLaunchOrigin } from "../query/types.ts";
import { isPidAlive, probeBackgroundJob, readJobRecord } from "./process-manager.ts";

export { isPidAlive, readJobRecord };

export function cliCommand(path: string, platform: NodeJS.Platform = process.platform): [string, ...string[]] {
  if (platform !== "win32") return [path];
  const pkgRoot = resolve(dirname(path), "..");
  const bundled = join(pkgRoot, "main.js");
  const entry = existsSync(bundled)
    ? bundled
    : join(pkgRoot, basename(path) === "baseware" ? "src/main.ts" : "src/cli/main.ts");
  const bunExe = process.env.LUDENS_BUN?.trim() || (process.versions.bun ? process.execPath : "bun.exe");
  return [bunExe, entry];
}

export interface BackgroundJobStatus {
  target: string;
  registered: boolean;
  pid: number | null;
  state: string | null;
  lastExitCode: number | null;
  launchedBy?: ServiceLaunchOrigin;
  appInstanceId?: string;
}

export function ludensSocketPath(service: "core" | "baseware", workspaceHash: string): string {
  return localServiceSocketPath(service, workspaceHash);
}

export function jobTargetLabel(workspaceHash: string, name: string): string {
  return name === "pet" ? "dev.ludens.pet" : `dev.ludens.core.${workspaceHash}.${name}`;
}

export function jobStateFilePath(logDir: string, name: string): string {
  return join(logDir, `${name}.job.json`);
}

export async function readBackgroundJobState(stateFile: string, target: string): Promise<BackgroundJobStatus> {
  const [probe, record] = await Promise.all([probeBackgroundJob(stateFile), readJobRecord(stateFile)]);
  return {
    target,
    ...probe,
    ...(record?.launchedBy ? { launchedBy: record.launchedBy } : {}),
    ...(record?.appInstanceId ? { appInstanceId: record.appInstanceId } : {}),
  };
}
