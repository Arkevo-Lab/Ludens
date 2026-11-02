/** Workspace capability evaluation store: discovery join, execution, history. */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicJson } from "../../bench/store.ts";
import { PythonCapabilities, type PythonCapability, type PythonDiagnostic } from "./python-capabilities.ts";

export type CapabilityEvalStatus = "missing" | "unverified" | "stale" | "failed" | "verified";

export interface CapabilityEvalRecord {
  runId: string;
  capabilityId: string;        // "python/path.py:func"
  evalId: string;              // "python/path.py:eval_func"
  capabilityCodeSHA: string;
  evalCodeSHA: string;
  evaluatedAt: string;         // ISO timestamp
  durationMs: number;
  outcome: "passed" | "failed";
  rewards: Record<string, number> | null;
  details?: Record<string, unknown>;
  error?: { type: string; message: string; traceback?: string };
}

export interface CapabilityEvalBinding {
  id: string;
  origin: { path: string; function: string; line: number };
  codeSHA: string;
  description: string;
}

/** The eval-relevant shape shared by discovered Python capabilities. */
export interface EvaluatedCapability {
  codeSHA: string;
  eval: CapabilityEvalBinding | null;
}

export interface CapabilityEvalView {
  evalStatus: CapabilityEvalStatus;
  evalId: string | null;
  evalRewards: Record<string, number> | null;
  evalEvaluatedAt: string | null;
  evalError: string | null;
}

export const capabilityEvalId = (capability: Pick<PythonCapability, "origin">) =>
  `python/${capability.origin.path}:${capability.origin.function}`;

const evalsDirectory = (workspace: string) => join(workspace, ".ludens", "evals");
const runsDirectory = (workspace: string) => join(evalsDirectory(workspace), "runs");
const RUN_ID = /^[a-zA-Z0-9._-]+$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseRecord(value: unknown, location: string): CapabilityEvalRecord {
  if (!isObject(value) || typeof value.runId !== "string" || typeof value.capabilityId !== "string"
      || typeof value.evalId !== "string" || typeof value.capabilityCodeSHA !== "string"
      || typeof value.evalCodeSHA !== "string" || typeof value.evaluatedAt !== "string"
      || typeof value.durationMs !== "number" || (value.outcome !== "passed" && value.outcome !== "failed")
      || (value.rewards !== null && !isObject(value.rewards))) throw new Error(`Invalid capability eval record: ${location}`);
  return value as unknown as CapabilityEvalRecord;
}


/** Read `.ludens/evals/latest.json`; an absent store reads as no records. */
export async function readLatestEvals(workspace: string): Promise<Record<string, CapabilityEvalRecord>> {
  let document: unknown;
  try { document = JSON.parse(await readFile(join(evalsDirectory(workspace), "latest.json"), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  if (!isObject(document) || document.version !== 1 || !isObject(document.capabilities)) throw new Error("Invalid capability eval store: latest.json");
  const records: Record<string, CapabilityEvalRecord> = {};
  for (const [id, value] of Object.entries(document.capabilities)) records[id] = parseRecord(value, id);
  return records;
}

/** Persist one immutable run record, then republish `latest.json` for its capability. */
export async function writeEvalRecord(workspace: string, record: CapabilityEvalRecord) {
  if (!RUN_ID.test(record.runId) || record.runId === "." || record.runId === "..") throw new Error("Invalid eval run ID");
  await mkdir(runsDirectory(workspace), { recursive: true });
  await atomicJson(join(runsDirectory(workspace), `${record.runId}.json`), record);
  const latest = await readLatestEvals(workspace);
  latest[record.capabilityId] = record;
  await atomicJson(join(evalsDirectory(workspace), "latest.json"), { version: 1, capabilities: latest });
}


/** Join a discovered capability with its latest record into the dashboard/CLI view. */
export function resolveCapabilityEval(capability: EvaluatedCapability, latestRecord?: CapabilityEvalRecord | null): CapabilityEvalView {
  if (!capability.eval) return { evalStatus: "missing", evalId: null, evalRewards: null, evalEvaluatedAt: null, evalError: null };
  const evalId = capability.eval.id;
  if (!latestRecord) return { evalStatus: "unverified", evalId, evalRewards: null, evalEvaluatedAt: null, evalError: null };
  const view = { evalId, evalRewards: latestRecord.rewards, evalEvaluatedAt: latestRecord.evaluatedAt };
  if (latestRecord.capabilityCodeSHA !== capability.codeSHA || latestRecord.evalCodeSHA !== capability.eval.codeSHA
      || latestRecord.evalId !== capability.eval.id)
    return { ...view, evalStatus: "stale", evalError: null };
  if (latestRecord.outcome !== "passed" || !latestRecord.rewards || Object.keys(latestRecord.rewards).length === 0)
    return { ...view, evalStatus: "failed",
      evalError: latestRecord.error ? `${latestRecord.error.type}: ${latestRecord.error.message}` : "Eval finished without rewards" };
  return { ...view, evalStatus: "verified", evalError: null };
}

export interface CapabilityEvalListItem {
  id: string;
  description: string;
  recorded: boolean;
  eval: CapabilityEvalBinding | null;
}

export interface CapabilityEvalListing {
  capabilities: (CapabilityEvalListItem & CapabilityEvalView)[];
  summary: Record<CapabilityEvalStatus, number>;
  diagnostics: PythonDiagnostic[];
}

/** Discover workspace capabilities and join them with the persisted eval store. */
export async function listCapabilityEvals(workspace: string, options: { signal?: AbortSignal } = {}): Promise<CapabilityEvalListing> {
  const discovered = await new PythonCapabilities(workspace).discover(options.signal);
  const summary: Record<CapabilityEvalStatus, number> = { missing: 0, unverified: 0, stale: 0, failed: 0, verified: 0 };
  const latest = await readLatestEvals(workspace);
  const capabilities = discovered.capabilities.map(capability => {
    const id = capabilityEvalId(capability);
    const view = resolveCapabilityEval(capability, latest[id]);
    summary[view.evalStatus]++;
    return { id, description: capability.description.trim().split("\n")[0] ?? "", recorded: capability.recorded ?? false,
      eval: capability.eval ?? null, ...view };
  });
  return { capabilities, summary, diagnostics: discovered.diagnostics };
}

export interface CapabilityEvalRunResult extends CapabilityEvalRecord {
  evalStatus: CapabilityEvalStatus;
}

export interface CapabilityEvalRun {
  results: CapabilityEvalRunResult[];
  outcome: "passed" | "failed";
}

export function newEvalRunId(now = new Date()) {
  return `eval-${now.toISOString().replaceAll(":", "-").replaceAll(".", "-")}-${randomUUID().slice(0, 8)}`;
}

/** Execute bound @eval_capability functions and persist each run. */
export async function runCapabilityEvals(workspace: string, options: { capabilityId?: string; all?: boolean; signal?: AbortSignal } = {}): Promise<CapabilityEvalRun> {
  const python = new PythonCapabilities(workspace);
  const discovered = await python.discover(options.signal);
  const entries = discovered.capabilities.map(capability => ({ capability, id: capabilityEvalId(capability) }));
  let targets: typeof entries;
  if (options.capabilityId) {
    const target = entries.find(entry => entry.id === options.capabilityId);
    if (!target) throw new Error(`Unknown Python capability: ${options.capabilityId}; use ludens eval list`);
    targets = [target];
  } else if (options.all) {
    targets = entries.filter(entry => entry.capability.eval);
  } else throw new Error("Specify a capability ID or --all");
  const results: CapabilityEvalRunResult[] = [];
  for (const { capability, id } of targets) {
    if (!capability.eval) {
      // No binding to execute or persist; the run itself still reports failure.
      results.push({ runId: newEvalRunId(), capabilityId: id, evalId: "", capabilityCodeSHA: capability.codeSHA,
        evalCodeSHA: "", evaluatedAt: new Date().toISOString(), durationMs: 0, outcome: "failed", rewards: null,
        error: { type: "MissingEval", message: `Capability ${id} has no @eval_capability bound` }, evalStatus: "missing" });
      continue;
    }
    const runId = newEvalRunId(), started = performance.now();
    const execution = await python.evaluate(capability.id, { signal: options.signal });
    const record: CapabilityEvalRecord = { runId, capabilityId: id, evalId: capability.eval.id,
      capabilityCodeSHA: capability.codeSHA, evalCodeSHA: capability.eval.codeSHA,
      evaluatedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - started),
      outcome: execution.isError ? "failed" : "passed", rewards: execution.details.rewards ?? null,
      ...(execution.details.details ? { details: execution.details.details } : {}),
      ...(execution.details.error ? { error: execution.details.error } : {}) };
    await writeEvalRecord(workspace, record);
    results.push({ ...record, evalStatus: resolveCapabilityEval(capability, record).evalStatus });
  }
  return { results, outcome: results.every(result => result.outcome === "passed") ? "passed" : "failed" };
}

/** List persisted eval runs newest-first from `.ludens/evals/runs/`. */
export async function historyCapabilityEvals(workspace: string, options: { capabilityId?: string; limit?: number } = {}): Promise<CapabilityEvalRecord[]> {
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("--limit must be an integer from 1 to 500");
  let names: string[];
  try { names = await readdir(runsDirectory(workspace)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: CapabilityEvalRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try { records.push(parseRecord(JSON.parse(await readFile(join(runsDirectory(workspace), name), "utf8")), name)); }
    catch { /* An externally damaged run file never hides the remaining history. */ }
  }
  records.sort((left, right) => right.evaluatedAt.localeCompare(left.evaluatedAt) || right.runId.localeCompare(left.runId));
  return records.filter(record => !options.capabilityId || record.capabilityId === options.capabilityId).slice(0, limit);
}
