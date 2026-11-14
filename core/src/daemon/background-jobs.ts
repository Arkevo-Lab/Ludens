import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServiceLaunchOrigin } from "../core/query/types.ts";
import { isPidAlive, probeBackgroundJob, readJobRecord } from "./process-manager.ts";

export { isPidAlive, readJobRecord };

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
  const uid = process.getuid?.() ?? "user";
  const dir = process.platform === "win32" ? tmpdir() : "/tmp";
  return join(dir, `ludens-${service}-${uid}-${workspaceHash}.sock`);
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
