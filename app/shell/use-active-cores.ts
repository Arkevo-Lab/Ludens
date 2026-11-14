"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { workspaceName } from "@/features/workspaces/workspace-picker";
import type { Project, ServiceLaunchOrigin } from "@/lib/types";

export interface ActiveCoreItem {
  projectId: string;
  name: string;
  workspace?: string;
  mode: string;
  consolidating: boolean;
  launchedBy?: ServiceLaunchOrigin;
  appInstanceId?: string;
  pendingOutbound: number;
  runId?: string;
  model?: string | null;
  pid?: number;
}

export interface UseActiveCoresOptions {
  projects: readonly Project[];
  onRefresh?: () => void;
  fetchImpl?: typeof fetch;
}

export interface UseActiveCoresResult {
  activeCores: ActiveCoreItem[];
  stoppingProjectId: string | null;
  stopError: string | null;
  stopCore: (projectId: string) => Promise<boolean>;
  clearStopError: () => void;
}

function modeRank(item: Pick<ActiveCoreItem, "mode" | "consolidating">): number {
  if (item.mode === "auto") return 0;
  if (item.consolidating) return 1;
  return 2;
}

/**
 * Derive and priority-sort online workspace Cores from the catalog:
 * 1. Pending outbound SOS messages first (higher count first)
 * 2. Active autonomous / consolidating Cores before manual standby
 * 3. Deterministic workspace name / ID tie-breaker
 */
export function deriveActiveCores(projects: readonly Project[]): ActiveCoreItem[] {
  const active: ActiveCoreItem[] = [];
  for (const project of projects) {
    const core = project.core;
    if (!core?.online) continue;
    const pendingOutbound =
      typeof core.pendingOutbound === "number" && Number.isFinite(core.pendingOutbound) && core.pendingOutbound > 0
        ? Math.floor(core.pendingOutbound)
        : 0;
    active.push({
      projectId: project.id,
      name: workspaceName(project, project.id),
      ...(project.workspace ? { workspace: project.workspace } : {}),
      mode: core.mode ?? "manual",
      consolidating: Boolean(core.consolidating),
      ...(core.launchedBy ? { launchedBy: core.launchedBy } : {}),
      ...(core.appInstanceId ? { appInstanceId: core.appInstanceId } : {}),
      pendingOutbound,
      ...(core.runId ? { runId: core.runId } : {}),
      ...(core.model !== undefined ? { model: core.model } : {}),
      ...(typeof core.pid === "number" ? { pid: core.pid } : {}),
    });
  }

  return active.sort((a, b) => {
    const aHasSos = a.pendingOutbound > 0 ? 1 : 0;
    const bHasSos = b.pendingOutbound > 0 ? 1 : 0;
    if (aHasSos !== bHasSos) return bHasSos - aHasSos;
    if (a.pendingOutbound !== b.pendingOutbound) return b.pendingOutbound - a.pendingOutbound;
    const rankDiff = modeRank(a) - modeRank(b);
    if (rankDiff !== 0) return rankDiff;
    return a.name.localeCompare(b.name) || a.projectId.localeCompare(b.projectId);
  });
}

/** Stop an individual workspace's Core via `/api/workspaces/service`. */
export async function stopWorkspaceCore(
  projectId: string,
  options?: { fetchImpl?: typeof fetch; signal?: AbortSignal },
): Promise<void> {
  const id = projectId.trim();
  if (!id) throw new Error("Project ID is required");

  const fetchFn = options?.fetchImpl ?? fetch;
  const response = await fetchFn("/api/workspaces/service", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project: id,
      service: "host",
      action: "stop",
    }),
    signal: options?.signal,
  });

  if (!response.ok) {
    let message = "";
    try {
      const text = await response.text();
      if (text.trim()) {
        try {
          const parsed = JSON.parse(text) as { error?: unknown };
          if (typeof parsed?.error === "string" && parsed.error.trim()) {
            message = parsed.error.trim();
          }
        } catch {
          message = text.trim();
        }
      }
    } catch {
      message = "";
    }
    throw new Error(message || `Failed to stop Core (${response.status})`);
  }
}

/** Unified sidebar hook for deriving active Cores and stopping a specific Core. */
export function useActiveCores({
  projects,
  onRefresh,
  fetchImpl,
}: UseActiveCoresOptions): UseActiveCoresResult {
  const activeCores = useMemo(() => deriveActiveCores(projects), [projects]);
  const [stoppingProjectId, setStoppingProjectId] = useState<string | null>(null);
  const [stopError, setStopError] = useState<string | null>(null);
  const stoppingRef = useRef<string | null>(null);
  const callbacksRef = useRef({ onRefresh, fetchImpl });
  callbacksRef.current = { onRefresh, fetchImpl };

  const clearStopError = useCallback(() => {
    setStopError(null);
  }, []);

  const stopCore = useCallback(async (projectId: string): Promise<boolean> => {
    const id = projectId.trim();
    if (!id || stoppingRef.current !== null) return false;

    stoppingRef.current = id;
    setStoppingProjectId(id);
    setStopError(null);

    try {
      await stopWorkspaceCore(id, { fetchImpl: callbacksRef.current.fetchImpl });
      callbacksRef.current.onRefresh?.();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStopError(message);
      return false;
    } finally {
      stoppingRef.current = null;
      setStoppingProjectId(null);
    }
  }, []);

  return {
    activeCores,
    stoppingProjectId,
    stopError,
    stopCore,
    clearStopError,
  };
}
