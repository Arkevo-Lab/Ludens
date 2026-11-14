"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BasewareMachineSpec } from "@ludens/protocol/machines";
import type { RegisteredDriverSpec } from "@ludens/protocol/drivers";
import type { WorkspaceBasewareSnapshot } from "@/lib/workspaces";
import type { CapabilitiesResult } from "@/lib/capabilities";
import { useLudensEvent, useOptionalLudensRpc } from "@/lib/ludens-rpc";
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
  const rpc = useOptionalLudensRpc();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const projectRef = useRef(project);
  projectRef.current = project;

  const canReadCaps = ready && Boolean(rpc) && Boolean(project) && Boolean(workspace);
  const capabilities = useReadResource<CapabilitiesResult>(
    canReadCaps ? `capabilities:${project}:${workspace}` : null,
    canReadCaps
      ? signal => rpcRef.current!.call("capabilities/get", { project, workspace: workspace! }, { signal }) as unknown as Promise<CapabilitiesResult>
      : null,
    capabilitiesFailedMessage,
    { refreshOnEvents: ["baseware", "workspace", "core"], workspaceId: project },
  );
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
    const caller = rpcRef.current;
    if (!caller) {
      setLoadError(loadFailedMessage);
      return;
    }
    overviewRequestRef.current?.abort();
    const controller = new AbortController();
    overviewRequestRef.current = controller;
    setLoading(true);
    setLoadError("");
    try {
      const data = await caller.call(
        "baseware/overview",
        project ? { workspaceId: project } : undefined,
        { signal: controller.signal },
      );
      if (!controller.signal.aborted && overviewRequestRef.current === controller) {
        setSnapshot(data as unknown as WorkspaceBasewareSnapshot);
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
  }, [project, ready, loadFailedMessage, Boolean(rpc), rpc?.reconnectGeneration ?? 0]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  useLudensEvent(
    ["baseware", "workspace", "core"],
    () => {
      void loadOverview();
    },
    { enabled: ready, workspaceId: project || undefined },
  );

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
        const caller = rpcRef.current;
        if (!caller) throw new Error("RPC client is unavailable");
        const data = await caller.call("drivers/discover", { spec: spec.trim() }, { signal });
        return data as unknown as DiscoveredDriverSummary;
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
          const caller = rpcRef.current;
          if (!caller) throw new Error("RPC client is unavailable");
          const data = (await caller.call(
            "baseware/mutate",
            {
              action: "registerDriver",
              spec: spec.trim(),
              ...(requestWorkspace ? { workspaceId: requestWorkspace } : {}),
            },
            { signal },
          )) as { snapshot?: WorkspaceBasewareSnapshot; driver?: RegisteredDriverSpec };
          if (requestWorkspace === projectRef.current) {
            if (data?.snapshot) {
              setSnapshot(data.snapshot);
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
          const caller = rpcRef.current;
          if (!caller) throw new Error("RPC client is unavailable");
          const data = (await caller.call(
            "baseware/mutate",
            {
              action: "unregisterDriver",
              id: input.id,
              ...(input.spec ? { spec: input.spec } : {}),
              ...(requestWorkspace ? { workspaceId: requestWorkspace } : {}),
            },
            { signal },
          )) as { snapshot?: WorkspaceBasewareSnapshot };
          if (requestWorkspace === projectRef.current) {
            if (data?.snapshot) {
              setSnapshot(data.snapshot);
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
          const caller = rpcRef.current;
          if (!caller) throw new Error("RPC client is unavailable");
          const data = await caller.call("baseware/mutate", { action: "probeMachine", machine }, { signal });
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
        const caller = rpcRef.current;
        if (!caller) throw new Error("RPC client is unavailable");
        const data = await caller.call("baseware/mutate", { action: "probeMachine", machine }, { signal });
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
          const caller = rpcRef.current;
          if (!caller) throw new Error("RPC client is unavailable");
          const data = await caller.call(
            "baseware/mutate",
            {
              action: "controlWorkspaceMachine",
              workspaceId: requestWorkspace,
              // protocol BasewareMutateParams narrows operation to "up"|"down"|"reload" while core expects WorkspaceMachineOperation
              operation: operation as unknown as "up",
              machineId,
            },
            { signal },
          );
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
          const caller = rpcRef.current;
          if (!caller) throw new Error("RPC client is unavailable");
          const data = (await caller.call(
            "baseware/mutate",
            {
              action: "upsertMachine",
              machine,
              ...(requestWorkspace && bindMode !== "none"
                ? { workspaceId: requestWorkspace, bindMode }
                : {}),
            },
            { signal },
          )) as { snapshot?: WorkspaceBasewareSnapshot; machine?: BasewareMachineSpec };
          if (requestWorkspace === projectRef.current) {
            if (data?.snapshot) {
              setSnapshot(data.snapshot);
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
          const caller = rpcRef.current;
          if (!caller) throw new Error("RPC client is unavailable");
          await caller.call("baseware/mutate", { action: "removeMachine", id }, { signal });
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
