import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface BackgroundJobStatus {
  target: string;
  registered: boolean;
  pid: number | null;
  state: string | null;
  lastExitCode: number | null;
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

export function isPidAlive(pid: unknown): pid is number {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function readBackgroundJobState(stateFile: string, target: string): Promise<BackgroundJobStatus> {
  try {
    const raw = JSON.parse(await readFile(stateFile, "utf8")) as Record<string, unknown>;
    const recordedPid = raw.pid;
    if (isPidAlive(recordedPid)) {
      return { target, registered: true, pid: recordedPid, state: "running", lastExitCode: null };
    }
    const lastExitCode = typeof raw.lastExitCode === "number"
      ? raw.lastExitCode
      : typeof recordedPid === "number" && recordedPid > 0
        ? -1
        : null;
    return { target, registered: true, pid: null, state: "exited", lastExitCode };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { target, registered: false, pid: null, state: null, lastExitCode: null };
    }
    return { target, registered: false, pid: null, state: null, lastExitCode: null };
  }
}
