import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { EventLog } from "../core/storage/events.ts";

/** Perf suites reuse the Shiori-local program context: a workspace, a run directory and one event writer. */
export interface PerfContext {
  runDir: string;
  workspace: string;
  log: EventLog;
  metadata: Record<string, unknown>;
  model: string;
  seconds: number;
  seed: number;
  signal?: AbortSignal;
}

export interface PerfContextOptions {
  seed?: number; seconds?: number; signal?: AbortSignal; model?: string;
}

/** Creates an isolated context under `root` (a temporary directory owned by the caller). */
export async function createPerfContext(root: string, options: PerfContextOptions = {}): Promise<PerfContext> {
  const runId = `perf-${new Date().toISOString().replaceAll(":", "-")}-${crypto.randomUUID().slice(0, 8)}`;
  const runDir = join(root, "logs", runId), workspace = join(root, "workspace");
  await mkdir(runDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  const seconds = options.seconds ?? 60;
  const log = new EventLog(runDir, { id: runId, now: () => performance.now() }, workspace);
  return { runDir, workspace, log, metadata: {}, model: options.model ?? "openai-codex/gpt-6.2-sol",
    seconds, seed: options.seed ?? 7, signal: options.signal };
}
