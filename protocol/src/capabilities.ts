/** Pure capability discovery & evaluation DTOs and status resolution helpers. */

export type CapabilityEvalStatus = "missing" | "unverified" | "stale" | "adapting" | "failed" | "verified";
export type CapabilityStaleReason = "capability" | "eval" | "env";

export interface CapabilityEvalAdaptation {
  reason: string;
  records: string[];
  adaptedAt: string;
  evalCodeSHA: string;
  envCodeSHA?: string | null;
}

export interface CapabilityEvalRecord {
  runId: string;
  capabilityId: string;
  evalId: string;
  capabilityCodeSHA: string;
  evalCodeSHA: string;
  envId?: string | null;
  envCodeSHA?: string | null;
  evaluatedAt: string;
  durationMs: number;
  outcome: "passed" | "failed";
  rewards: Record<string, number> | null;
  details?: Record<string, unknown>;
  error?: { type: string; message: string; traceback?: string };
  adaptation?: CapabilityEvalAdaptation;
}

export interface CapabilityEnvBinding {
  id: string;
  origin: { path: string; function: string; line: number };
  codeSHA: string;
  description: string;
}

export interface CapabilityEvalBinding {
  id: string;
  origin: { path: string; function: string; line: number };
  codeSHA: string;
  description: string;
  env?: CapabilityEnvBinding | null;
}

export interface EvaluatedCapability {
  codeSHA: string;
  eval: CapabilityEvalBinding | null;
}

export interface CapabilityEvalView {
  evalStatus: CapabilityEvalStatus;
  evalId: string | null;
  evalEnvId: string | null;
  evalEnv: CapabilityEnvBinding | null;
  evalRewards: Record<string, number> | null;
  evalEvaluatedAt: string | null;
  evalError: string | null;
}

export interface CapabilityEntry {
  id: string;
  kind: "device" | "workspace";
  description: string;
  requiresControl: boolean | null;
  readOnly: boolean | null;
  observe?: boolean;
  origin?: { path: string; function: string; line: number };
  codeSHA?: string;
  eval?: CapabilityEvalBinding | null;
  evalStatus?: CapabilityEvalStatus | null;
  evalId?: string | null;
  evalEnv?: CapabilityEnvBinding | null;
  evalEnvId?: string | null;
  evalRewards?: Record<string, number> | null;
  evalEvaluatedAt?: string | null;
  evalError?: string | null;
  staleReasons?: CapabilityStaleReason[];
  latestRecord?: CapabilityEvalRecord | null;
  history?: CapabilityEvalRecord[];
}

export interface CapabilityEnvEntry {
  id: string;
  name: string;
  description: string;
  origin: { path: string; function: string; line: number };
  codeSHA: string;
  boundCapabilities: string[];
  boundEvals: string[];
}

export interface CapabilitiesResult {
  project: string;
  workspace: string;
  checkedAt: string;
  groups: { id: "device" | "workspace"; items: CapabilityEntry[] }[];
  envs: CapabilityEnvEntry[];
  evalSummary: Record<CapabilityEvalStatus, number>;
  issues: { error: string }[];
  sources: Record<"device" | "workspace", { status: "available" | "partial" | "missing" | "error"; issueCount: number }>;
  deviceSnapshot: { generatedAt: string | null; drivers: { id: string; version: string | null }[] } | null;
}

export interface CapabilityRuntime {
  checkedAt: string;
  host: "reachable" | "unavailable";
  reason?: "not-running" | "unresponsive" | "invalid-status" | "scope-mismatch";
  runId: string | null;
  /** Host's control-session flag; not a physical-device or game readiness test. */
  controlConnected: boolean | null;
}

export interface CapabilityEvalListItem {
  id: string;
  description: string;
  recorded: boolean;
  eval: CapabilityEvalBinding | null;
}

export interface CapabilityEvalRunResult extends CapabilityEvalRecord {
  evalStatus: CapabilityEvalStatus;
}

export interface CapabilityEvalRun {
  results: CapabilityEvalRunResult[];
  outcome: "passed" | "failed";
}

export interface WorkspaceCapabilityEvalResult {
  run: CapabilityEvalRun;
  catalog: CapabilitiesResult;
}

function formatAdaptationError(adaptation: CapabilityEvalAdaptation): string {
  const suffix = adaptation.records.length ? ` (records: ${adaptation.records.join(", ")})` : "";
  return `EvalAdapting: ${adaptation.reason}${suffix}`;
}

/** Adaptation holds only while both the eval module and the bound env module are unchanged. */
export function isStillAdapting(capability: EvaluatedCapability, latestRecord?: CapabilityEvalRecord | null): boolean {
  if (!latestRecord?.adaptation) return false;
  return (
    (capability.eval?.codeSHA ?? "") === latestRecord.adaptation.evalCodeSHA &&
    (latestRecord.adaptation.envCodeSHA ?? null) === (capability.eval?.env?.codeSHA ?? null)
  );
}

/** Join a discovered capability with its latest record into the dashboard/CLI view. */
export function resolveCapabilityEval(
  capability: EvaluatedCapability,
  latestRecord?: CapabilityEvalRecord | null,
): CapabilityEvalView {
  const evalId = capability.eval?.id ?? null;
  const evalEnv = capability.eval?.env ?? null;
  const base = { evalId, evalEnvId: evalEnv?.id ?? null, evalEnv };
  const adaptation = latestRecord?.adaptation;
  if (adaptation && isStillAdapting(capability, latestRecord)) {
    return {
      ...base,
      evalStatus: "adapting",
      evalRewards: latestRecord.rewards,
      evalEvaluatedAt: latestRecord.evaluatedAt,
      evalError: formatAdaptationError(adaptation),
    };
  }
  if (!capability.eval) {
    return { ...base, evalStatus: "missing", evalRewards: null, evalEvaluatedAt: null, evalError: null };
  }
  if (!latestRecord) {
    return { ...base, evalStatus: "unverified", evalRewards: null, evalEvaluatedAt: null, evalError: null };
  }
  const view = { ...base, evalRewards: latestRecord.rewards, evalEvaluatedAt: latestRecord.evaluatedAt };
  if (
    latestRecord.capabilityCodeSHA !== capability.codeSHA ||
    latestRecord.evalId !== capability.eval.id ||
    latestRecord.evalCodeSHA !== capability.eval.codeSHA ||
    (latestRecord.envId ?? null) !== (capability.eval.env?.id ?? null) ||
    (latestRecord.envCodeSHA ?? null) !== (capability.eval.env?.codeSHA ?? null)
  ) {
    return { ...view, evalStatus: "stale", evalError: null };
  }
  if (latestRecord.outcome !== "passed" || !latestRecord.rewards || Object.keys(latestRecord.rewards).length === 0) {
    return {
      ...view,
      evalStatus: "failed",
      evalError: latestRecord.error
        ? `${latestRecord.error.type}: ${latestRecord.error.message}`
        : "Eval finished without rewards",
    };
  }
  return { ...view, evalStatus: "verified", evalError: null };
}
