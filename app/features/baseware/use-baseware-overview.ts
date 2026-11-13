"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BasewareMachineSpec } from "@ludens/protocol/machines";
import type { RegisteredDriverSpec } from "@ludens/protocol/drivers";
import type { WorkspaceBasewareSnapshot } from "@/lib/workspaces";
import type { CapabilitiesResult } from "@/lib/capabilities";
import { useReadResource } from "@/components/use-read-resource";
import type { MachineBindMode } from "./baseware-model";

export interface ProbeOutcome {
  ok: boolean;
  latencyMs: number;
  detail: string;
}

export type ProbeState = "probing" | ProbeOutcome;

export interface DiscoveredDriverSummary {
  spec: string;
  id: string;
  version: string;
  transport?: string;
  defaultPort?: number;
  needsGame?: boolean;
  launchHint?: string;
}

export type WorkspaceMachineOperation =
  | "setPrimary"
  | "toggleAllowed"
  | "mount"
  | "unmount"
  | "reconnect";

export interface UseBasewareOverviewOptions {
  project: string;
  workspace: string | null;
  ready: boolean;
  loadFailedMessage: string;
  capabilitiesFailedMessage: string;
}

export function useBasewareOverview({
  project,
  workspace,
  ready,
  loadFailedMessage,
  capabilitiesFailedMessage,
}: UseBasewareOverviewOptions) {
  const [snapshot, setSnapshot] = useState<WorkspaceBasewareSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [actionNotice, setActionNotice] = useState("");
  const [busyDriverKey, setBusyDriverKey] = useState<string | null>(null);
  const [busyMachineId, setBusyMachineId] = useState<string | null>(null);
  const [probeStates, setProbeStates] = useState<Record<string, ProbeState>>({});

  const overviewRequestRef = useRef<AbortController | null>(null);
  const mutationControllersRef = useRef(new Set<AbortController>());
  const projectRef = useRef(project);
  projectRef.current = project;

  const capUrl = ready && project && workspace
    ? `/api/capabilities?project=${encodeURIComponent(project)}&workspace=${encodeURIComponent(workspace)}`
    : null;
  const capabilities = useReadResource<CapabilitiesResult>(capUrl, capabilitiesFailedMessage);
  const retryCapabilities = capabilities.retry;

  useEffect(() => {
    const controllers = mutationControllersRef.current;
    return () => {
      overviewRequestRef.current?.abort();
      for (const controller of controllers) {
        controller.abort();
      }
      controllers.clear();
    };
  }, []);

  const loadOverview = useCallback(async () => {
    if (!ready) return;
    overviewRequestRef.current?.abort();
    const controller = new AbortController();
    overviewRequestRef.current = controller;
    setLoading(true);
    setLoadError("");
    try {
      const qs = project ? `?workspaceId=${encodeURIComponent(project)}` : "";
      const response = await fetch(`/api/baseware${qs}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(typeof data?.error === "string" ? data.error : loadFailedMessage);
      }
      if (!controller.signal.aborted && overviewRequestRef.current === controller) {
        setSnapshot(data as WorkspaceBasewareSnapshot);
      }
    } catch (error) {
      if ((error as { name?: string })?.name === "AbortError") return;
      if (overviewRequestRef.current === controller) {
        setLoadError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (overviewRequestRef.current === controller) {
        overviewRequestRef.current = null;
        setLoading(false);
      }
    }
  }, [project, ready, loadFailedMessage]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const reloadAll = useCallback(async () => {
    await loadOverview();
    retryCapabilities();
  }, [loadOverview, retryCapabilities]);

  const runMutation = useCallback(async <T,>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    mutationControllersRef.current.add(controller);
    try {
      return await fn(controller.signal);
    } finally {
      mutationControllersRef.current.delete(controller);
    }
  }, []);

  const clearFeedback = useCallback(() => {
    setActionError("");
    setActionNotice("");
  }, []);

  const discoverDriverSpec = useCallback(
    (spec: string) =>
      runMutation<DiscoveredDriverSummary>(async signal => {
        const response = await fetch("/api/drivers/discover", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ spec: spec.trim() }),
          signal,
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(typeof data?.error === "string" ? data.error : "Driver discovery failed");
        }
        return data as DiscoveredDriverSummary;
      }),
    [runMutation],
  );

  const registerDriver = useCallback(
    async (spec: string, keyForBusy?: string): Promise<RegisteredDriverSpec> => {
      const requestWorkspace = projectRef.current;
      setActionError("");
      setActionNotice("");
      if (keyForBusy) setBusyDriverKey(keyForBusy);
      try {
        return await runMutation(async signal => {
          const response = await fetch("/api/baseware", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "registerDriver",
              spec: spec.trim(),
              ...(requestWorkspace ? { workspaceId: requestWorkspace } : {}),
            }),
            signal,
          });
          const data = await response.json();
          if (!response.ok) {
            throw new Error(typeof data?.error === "string" ? data.error : "Failed to register driver");
          }
          if (requestWorkspace === projectRef.current) {
            if (data?.snapshot) {
              setSnapshot(data.snapshot as WorkspaceBasewareSnapshot);
            } else {
              await loadOverview();
            }
          }
          return data.driver as RegisteredDriverSpec;
        });
      } catch (error) {
        if (requestWorkspace === projectRef.current) {
          const msg = error instanceof Error ? error.message : String(error);
          setActionError(msg);
        }
        throw error;
      } finally {
        if (keyForBusy) setBusyDriverKey(null);
      }
    },
    [runMutation, loadOverview],
  );

  const unregisterDriver = useCallback(
    async (input: { id: string; spec?: string; key?: string }) => {
      const requestWorkspace = projectRef.current;
      setActionError("");
      setActionNotice("");
      const busyKey = input.key ?? input.id;
      setBusyDriverKey(busyKey);
      try {
        await runMutation(async signal => {
          const response = await fetch("/api/baseware", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "unregisterDriver",
              id: input.id,
              ...(input.spec ? { spec: input.spec } : {}),
              ...(requestWorkspace ? { workspaceId: requestWorkspace } : {}),
            }),
            signal,
          });
          const data = await response.json();
          if (!response.ok) {
            throw new Error(typeof data?.error === "string" ? data.error : "Failed to unregister driver");
          }
          if (requestWorkspace === projectRef.current) {
            if (data?.snapshot) {
              setSnapshot(data.snapshot as WorkspaceBasewareSnapshot);
            } else {
              await loadOverview();
            }
          }
        });
      } catch (error) {
        if (requestWorkspace === projectRef.current) {
          const msg = error instanceof Error ? error.message : String(error);
          setActionError(msg);
        }
        throw error;
      } finally {
        setBusyDriverKey(null);
      }
    },
    [runMutation, loadOverview],
  );

  const probeMachine = useCallback(
    async (machine: BasewareMachineSpec): Promise<ProbeOutcome> => {
      setProbeStates(prev => ({ ...prev, [machine.id]: "probing" }));
      try {
        const result = await runMutation<ProbeOutcome>(async signal => {
          const response = await fetch("/api/baseware", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "probeMachine", machine }),
            signal,
          });
          const data = await response.json();
          if (!response.ok) {
            throw new Error(typeof data?.error === "string" ? data.error : "Probe failed");
          }
          return data as ProbeOutcome;
        });
        setProbeStates(prev => ({ ...prev, [machine.id]: result }));
        return result;
      } catch (error) {
        const outcome: ProbeOutcome = {
          ok: false,
          latencyMs: 0,
          detail: error instanceof Error ? error.message : String(error),
        };
        setProbeStates(prev => ({ ...prev, [machine.id]: outcome }));
        return outcome;
      }
    },
    [runMutation],
  );

  const probeDraftMachine = useCallback(
    (machine: BasewareMachineSpec) =>
      runMutation<ProbeOutcome>(async signal => {
        const response = await fetch("/api/baseware", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "probeMachine", machine }),
          signal,
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(typeof data?.error === "string" ? data.error : "Probe failed");
        }
        return data as ProbeOutcome;
      }),
    [runMutation],
  );

  const controlWorkspaceMachine = useCallback(
    async (operation: WorkspaceMachineOperation, machineId: string) => {
      const requestWorkspace = projectRef.current;
      if (!requestWorkspace) return null;
      setBusyMachineId(machineId);
      setActionError("");
      setActionNotice("");
      try {
        const next = await runMutation<WorkspaceBasewareSnapshot>(async signal => {
          const response = await fetch("/api/baseware", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "controlWorkspaceMachine",
              workspaceId: requestWorkspace,
              operation,
              machineId,
            }),
            signal,
          });
          const data = await response.json();
          if (!response.ok) {
            throw new Error(typeof data?.error === "string" ? data.error : "Operation failed");
          }
          return data as WorkspaceBasewareSnapshot;
        });
        if (requestWorkspace === projectRef.current) {
          setSnapshot(next);
          retryCapabilities();
        }
        return next;
      } catch (error) {
        if (requestWorkspace === projectRef.current) {
          const msg = error instanceof Error ? error.message : String(error);
          setActionError(msg);
        }
        throw error;
      } finally {
        setBusyMachineId(null);
      }
    },
    [runMutation, retryCapabilities],
  );

  const upsertMachine = useCallback(
    async (
      machine: BasewareMachineSpec,
      bindMode: MachineBindMode = "none",
    ): Promise<BasewareMachineSpec> => {
      const requestWorkspace = projectRef.current;
      setActionError("");
      setActionNotice("");
      setBusyMachineId(machine.id);
      try {
        return await runMutation(async signal => {
          const response = await fetch("/api/baseware", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "upsertMachine",
              machine,
              ...(requestWorkspace && bindMode !== "none"
                ? { workspaceId: requestWorkspace, bindMode }
                : {}),
            }),
            signal,
          });
          const data = await response.json();
          if (!response.ok) {
            throw new Error(typeof data?.error === "string" ? data.error : "Failed to save machine");
          }
          if (requestWorkspace === projectRef.current) {
            if (data?.snapshot) {
              setSnapshot(data.snapshot as WorkspaceBasewareSnapshot);
            } else {
              await loadOverview();
            }
            retryCapabilities();
          }
          return data.machine as BasewareMachineSpec;
        });
      } catch (error) {
        if (requestWorkspace === projectRef.current) {
          const msg = error instanceof Error ? error.message : String(error);
          setActionError(msg);
        }
        throw error;
      } finally {
        setBusyMachineId(null);
      }
    },
    [runMutation, loadOverview, retryCapabilities],
  );

  const deleteMachine = useCallback(
    async (id: string) => {
      setActionError("");
      setActionNotice("");
      setBusyMachineId(id);
      try {
        await runMutation(async signal => {
          const response = await fetch("/api/baseware", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id }),
            signal,
          });
          const data = await response.json();
          if (!response.ok) {
            throw new Error(typeof data?.error === "string" ? data.error : "Failed to remove machine");
          }
          await reloadAll();
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        setActionError(msg);
        throw error;
      } finally {
        setBusyMachineId(null);
      }
    },
    [runMutation, reloadAll],
  );

  return {
    snapshot,
    loading,
    loadError,
    actionError,
    actionNotice,
    setActionNotice,
    setActionError,
    clearFeedback,
    busyDriverKey,
    busyMachineId,
    probeStates,
    capabilities,
    reloadAll,
    discoverDriverSpec,
    registerDriver,
    unregisterDriver,
    probeMachine,
    probeDraftMachine,
    controlWorkspaceMachine,
    upsertMachine,
    deleteMachine,
  };
}
