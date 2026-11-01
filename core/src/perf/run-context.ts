import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { EventLog } from "../core/storage/events.ts";
import type { BenchmarkContext } from "../bench/types.ts";

/** Perf suites reuse the Shiori-local program context: a workspace, a run directory and one event writer. */
export type PerfContext = BenchmarkContext;

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
  return { runDir, workspace, log, metadata: {}, model: options.model ?? "openai-codex/gpt-6.1-sol",
    seconds, maxRequests: 1000, seed: options.seed ?? 7, signal: options.signal,
    budget: { deadlineMs: Date.now() + seconds * 1000, signal: new AbortController().signal } };
}
