"use client";

import type { WorkspacesServiceControlParams } from "@ludens/protocol/app-rpc";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useOptionalLudensRpc, type LudensRpcCaller } from "@/lib/ludens-rpc";
import type {
  WorkspaceServiceControlResult,
  WorkspaceStudioSnapshot,
} from "@/lib/workspaces";

export type WorkspaceServiceOperation = "up" | "down" | "reload";

export interface WorkspaceServiceSnapshot {
  pendingOperation: WorkspaceServiceOperation | null;
  busy: boolean;
  lastResult: WorkspaceServiceControlResult | null;
  error: string | null;
}

export interface RunWorkspaceServiceOptions {
  rpc?: LudensRpcCaller;
  signal?: AbortSignal;
  fallbackError?: string;
  onSuccess?: (result: WorkspaceServiceControlResult) => void;
  onStudioSnapshot?: (
    studio: WorkspaceStudioSnapshot,
    result: WorkspaceServiceControlResult,
  ) => void;
}

export interface UseWorkspaceServiceOptions {
  workspaceId?: string | null;
  onSuccess?: (result: WorkspaceServiceControlResult) => void;
  onStudioSnapshot?: (
    studio: WorkspaceStudioSnapshot,
    result: WorkspaceServiceControlResult,
  ) => void;
  fallbackError?: string;
  rpc?: LudensRpcCaller;
}

export interface UseWorkspaceServiceResult extends WorkspaceServiceSnapshot {
  clearError: () => void;
  clearResult: () => void;
  startWorkspace: () => Promise<WorkspaceServiceControlResult | null>;
  stopWorkspace: () => Promise<WorkspaceServiceControlResult | null>;
  reloadWorkspace: () => Promise<WorkspaceServiceControlResult | null>;
  runOperation: (
    operation: WorkspaceServiceOperation,
  ) => Promise<WorkspaceServiceControlResult | null>;
}

export const IDLE_WORKSPACE_SERVICE_SNAPSHOT: WorkspaceServiceSnapshot = Object.freeze({
  pendingOperation: null,
  busy: false,
  lastResult: null,
  error: null,
});

export function buildWorkspaceServiceParams(
  workspaceId: string,
  operation: WorkspaceServiceOperation,
): WorkspacesServiceControlParams {
  return {
    workspaceId: workspaceId.trim(),
    action: operation,
  };
}

export function formatWorkspaceServiceFailure(
  result: Pick<
    WorkspaceServiceControlResult,
    "ok" | "operation" | "exitCode" | "stdout" | "stderr"
  >,
  fallbackError?: string,
): string | null {
  if (result.ok && result.exitCode === 0) return null;
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  if (stderr) return stderr;
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  if (stdout) return stdout;
  const fallback = fallbackError?.trim();
  if (fallback) return fallback;
  return `ludens ${result.operation} exited with code ${result.exitCode}`;
}

export async function requestWorkspaceServiceControl(
  rpc: LudensRpcCaller,
  workspaceId: string,
  operation: WorkspaceServiceOperation,
  options?: {
    signal?: AbortSignal;
    fallbackError?: string;
  },
): Promise<WorkspaceServiceControlResult> {
  const id = workspaceId.trim();
  if (!id) {
    throw new Error(options?.fallbackError?.trim() || "Workspace ID is required");
  }

  const payload = await rpc.call(
    "workspaces/serviceControl",
    buildWorkspaceServiceParams(id, operation),
    { signal: options?.signal },
  );

  const exitCode =
    typeof payload?.exitCode === "number"
      ? payload.exitCode
      : payload?.ok === true
        ? 0
        : 1;
  const ok = Boolean(payload?.ok) && exitCode === 0;
  const stdout = typeof payload?.stdout === "string" ? payload.stdout : "";
  const stderr = typeof payload?.stderr === "string" ? payload.stderr : "";

  return {
    ok,
    operation,
    exitCode,
    stdout,
    stderr,
    studio: (payload?.studio ?? null) as unknown as WorkspaceStudioSnapshot,
  };
}

export interface WorkspaceServiceStore {
  getSnapshot(workspaceId?: string | null): WorkspaceServiceSnapshot;
  subscribe(workspaceId: string | null | undefined, listener: () => void): () => void;
  clearError(workspaceId?: string | null): void;
  clearResult(workspaceId?: string | null): void;
  runOperation(
    workspaceId: string | null | undefined,
    operation: WorkspaceServiceOperation,
    options?: RunWorkspaceServiceOptions,
  ): Promise<WorkspaceServiceControlResult | null>;
}

interface WorkspaceServiceEntry {
  snapshot: WorkspaceServiceSnapshot;
  listeners: Set<() => void>;
}

export function createWorkspaceServiceStore(
  defaultRpc?: LudensRpcCaller,
): WorkspaceServiceStore {
  const entries = new Map<string, WorkspaceServiceEntry>();

  const getOrCreate = (id: string): WorkspaceServiceEntry => {
    let entry = entries.get(id);
    if (!entry) {
      entry = {
        snapshot: IDLE_WORKSPACE_SERVICE_SNAPSHOT,
        listeners: new Set(),
      };
      entries.set(id, entry);
    }
    return entry;
  };

  const updateSnapshot = (id: string, next: WorkspaceServiceSnapshot) => {
    const entry = getOrCreate(id);
    entry.snapshot = next;
    for (const listener of entry.listeners) {
      listener();
    }
  };

  return {
    getSnapshot(workspaceId?: string | null): WorkspaceServiceSnapshot {
      const id = workspaceId?.trim() ?? "";
      if (!id) return IDLE_WORKSPACE_SERVICE_SNAPSHOT;
      return entries.get(id)?.snapshot ?? IDLE_WORKSPACE_SERVICE_SNAPSHOT;
    },

    subscribe(workspaceId: string | null | undefined, listener: () => void): () => void {
      const id = workspaceId?.trim() ?? "";
      if (!id) return () => {};
      const entry = getOrCreate(id);
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
      };
    },

    clearError(workspaceId?: string | null): void {
      const id = workspaceId?.trim() ?? "";
      if (!id) return;
      const entry = entries.get(id);
      if (!entry || entry.snapshot.error === null) return;
      updateSnapshot(id, {
        ...entry.snapshot,
        error: null,
      });
    },

    clearResult(workspaceId?: string | null): void {
      const id = workspaceId?.trim() ?? "";
      if (!id) return;
      const entry = entries.get(id);
      if (!entry) return;
      if (entry.snapshot.lastResult === null && entry.snapshot.error === null) return;
      updateSnapshot(id, {
        ...entry.snapshot,
        lastResult: null,
        error: null,
      });
    },

    async runOperation(
      workspaceId: string | null | undefined,
      operation: WorkspaceServiceOperation,
      options?: RunWorkspaceServiceOptions,
    ): Promise<WorkspaceServiceControlResult | null> {
      const id = workspaceId?.trim() ?? "";
      if (!id) return null;

      const entry = getOrCreate(id);
      if (entry.snapshot.busy) {
        return null;
      }

      const rpc = options?.rpc ?? defaultRpc;
      if (!rpc) {
        updateSnapshot(id, {
          pendingOperation: null,
          busy: false,
          lastResult: null,
          error: options?.fallbackError || "RPC client is unavailable",
        });
        return null;
      }

      updateSnapshot(id, {
        pendingOperation: operation,
        busy: true,
        lastResult: entry.snapshot.lastResult,
        error: null,
      });

      try {
        const result = await requestWorkspaceServiceControl(rpc, id, operation, {
          signal: options?.signal,
          fallbackError: options?.fallbackError,
        });
        const failureMessage = formatWorkspaceServiceFailure(
          result,
          options?.fallbackError,
        );

        updateSnapshot(id, {
          pendingOperation: null,
          busy: false,
          lastResult: result,
          error: failureMessage,
        });

        if (result.studio) {
          options?.onStudioSnapshot?.(result.studio, result);
        }
        if (failureMessage === null) {
          options?.onSuccess?.(result);
        }
        return result;
      } catch (cause) {
        const message =
          cause instanceof Error
            ? cause.message
            : String(cause || options?.fallbackError || "Workspace service control failed");
        updateSnapshot(id, {
          pendingOperation: null,
          busy: false,
          lastResult: null,
          error: message || options?.fallbackError || "Workspace service control failed",
        });
        return null;
      }
    },
  };
}

const defaultWorkspaceServiceStore = createWorkspaceServiceStore();

export function useWorkspaceService({
  workspaceId,
  onSuccess,
  onStudioSnapshot,
  fallbackError,
  rpc,
}: UseWorkspaceServiceOptions): UseWorkspaceServiceResult {
  const rpcCtx = useOptionalLudensRpc();
  const activeRpc = rpc ?? rpcCtx ?? undefined;
  const normalizedWorkspaceId = workspaceId?.trim() ?? "";
  const activeWorkspaceIdRef = useRef(normalizedWorkspaceId);
  activeWorkspaceIdRef.current = normalizedWorkspaceId;

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const callbacksRef = useRef({
    onSuccess,
    onStudioSnapshot,
    fallbackError,
    activeRpc,
  });
  callbacksRef.current = {
    onSuccess,
    onStudioSnapshot,
    fallbackError,
    activeRpc,
  };

  const subscribe = useCallback(
    (listener: () => void) => defaultWorkspaceServiceStore.subscribe(workspaceId, listener),
    [workspaceId],
  );
  const getSnapshot = useCallback(
    () => defaultWorkspaceServiceStore.getSnapshot(workspaceId),
    [workspaceId],
  );
  const getServerSnapshot = useCallback(() => IDLE_WORKSPACE_SERVICE_SNAPSHOT, []);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const clearError = useCallback(() => {
    defaultWorkspaceServiceStore.clearError(workspaceId);
  }, [workspaceId]);

  const clearResult = useCallback(() => {
    defaultWorkspaceServiceStore.clearResult(workspaceId);
  }, [workspaceId]);

  const runOperation = useCallback(
    (operation: WorkspaceServiceOperation) => {
      const dispatchedId = workspaceId?.trim() ?? "";
      return defaultWorkspaceServiceStore.runOperation(workspaceId, operation, {
        rpc: callbacksRef.current.activeRpc,
        fallbackError: callbacksRef.current.fallbackError,
        onSuccess: result => {
          if (!mountedRef.current || activeWorkspaceIdRef.current !== dispatchedId) return;
          callbacksRef.current.onSuccess?.(result);
        },
        onStudioSnapshot: (studio, result) => {
          if (!mountedRef.current || activeWorkspaceIdRef.current !== dispatchedId) return;
          callbacksRef.current.onStudioSnapshot?.(studio, result);
        },
      });
    },
    [workspaceId],
  );

  const startWorkspace = useCallback(() => runOperation("up"), [runOperation]);
  const stopWorkspace = useCallback(() => runOperation("down"), [runOperation]);
  const reloadWorkspace = useCallback(() => runOperation("reload"), [runOperation]);

  return {
    ...snapshot,
    clearError,
    clearResult,
    startWorkspace,
    stopWorkspace,
    reloadWorkspace,
    runOperation,
  };
}
