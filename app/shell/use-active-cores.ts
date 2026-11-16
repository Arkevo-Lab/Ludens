"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { workspaceName } from "@/features/workspaces/workspace-picker";
import { useOptionalLudensRpc, type LudensRpcCaller } from "@/lib/ludens-rpc";
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
  rpc?: LudensRpcCaller;
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

/** Stop an individual workspace's Core via `workspaces/serviceControl` RPC. */
export async function stopWorkspaceCore(
  rpc: LudensRpcCaller,
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<void> {
  const id = projectId.trim();
  if (!id) throw new Error("Project ID is required");

  const payload = await rpc.call(
    "workspaces/serviceControl",
    {
      workspaceId: id,
      action: "down",
      services: ["host"],
    },
    { signal: options?.signal },
  );

  if (payload && payload.ok === false) {
    const stderr = typeof payload.stderr === "string" ? payload.stderr.trim() : "";
    const stdout = typeof payload.stdout === "string" ? payload.stdout.trim() : "";
    throw new Error(stderr || stdout || "Failed to stop Core");
  }
}

/** Unified sidebar hook for deriving active Cores and stopping a specific Core. */
export function useActiveCores({
  projects,
  onRefresh,
  rpc,
}: UseActiveCoresOptions): UseActiveCoresResult {
  const rpcCtx = useOptionalLudensRpc();
  const activeRpc = rpc ?? rpcCtx ?? undefined;
  const activeCores = useMemo(() => deriveActiveCores(projects), [projects]);
  const [stoppingProjectId, setStoppingProjectId] = useState<string | null>(null);
  const [stopError, setStopError] = useState<string | null>(null);
  const stoppingRef = useRef<string | null>(null);
  const callbacksRef = useRef({ onRefresh, activeRpc });
  callbacksRef.current = { onRefresh, activeRpc };

  const clearStopError = useCallback(() => {
    setStopError(null);
  }, []);

  const stopCore = useCallback(async (projectId: string): Promise<boolean> => {
    const id = projectId.trim();
    if (!id || stoppingRef.current !== null) return false;
    const caller = callbacksRef.current.activeRpc;
    if (!caller) {
      setStopError("RPC client is unavailable");
      return false;
    }

    stoppingRef.current = id;
    setStoppingProjectId(id);
    setStopError(null);

    try {
      await stopWorkspaceCore(caller, id);
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
