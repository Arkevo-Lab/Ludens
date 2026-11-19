/** Pure perception configuration DTOs, slider limits, and patch validator. */

/** Workspace overrides only; absent values inherit the perception process environment. */
export interface PerceptionSettings {
  hotSeconds: number;
  videoSegmentSeconds: number;
  videoIdleSeconds: number;
}

export type PerceptionSettingsPatch = Partial<{ [K in keyof PerceptionSettings]: number | null }>;

export interface PerceptionRuntimeSnapshot {
  checkedAt: string;
  connection: "reachable" | "unavailable";
  reason?: "not-running" | "unresponsive" | "invalid-status" | "scope-mismatch";
  runId: string | null;
  perception: {
    state: "unimplemented" | "loading" | "ready" | "stopped" | "error";
    generation: string | null;
    pid: number | null;
    sampleHz: number | null;
    values: PerceptionSettings | null;
    valueStatus: "current" | "last-loaded" | "unavailable";
    persistent: boolean | null;
    error?: string;
  } | null;
}

export const PERCEPTION_LIMITS = {
  hotSeconds: { min: 10, max: 3600 },
  videoSegmentSeconds: { min: 10, max: 3600 },
  videoIdleSeconds: { min: 1, max: 600 },
} as const;

export function parsePerceptionPatch(input: unknown): PerceptionSettingsPatch {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("设置必须是 JSON 对象");
  }
  const patch: PerceptionSettingsPatch = {};
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(PERCEPTION_LIMITS, key)) {
      throw new Error("未知的工作区设置: " + key);
    }
    const name = key as keyof PerceptionSettings;
    const { min, max } = PERCEPTION_LIMITS[name];
    if (value !== null && (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)) {
      throw new Error(`设置值必须是 ${min}–${max} 之间的整数秒，或 null 以恢复继承`);
    }
    patch[name] = value as number | null;
  }
  return patch;
}
