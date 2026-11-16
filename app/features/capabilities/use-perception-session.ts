"use client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { PerceptionSettingsPatch } from "@/lib/perception-config";
import { useOptionalLudensRpc } from "@/lib/ludens-rpc";
import { createPerceptionSession, EMPTY_PERCEPTION_SESSION, type PerceptionSession, type SavedPerception } from "@/features/capabilities/perception-draft";

const sessions = new Map<string, PerceptionSession>();
const emptySubscribe = () => () => {};
const emptySnapshot = () => EMPTY_PERCEPTION_SESSION;
export function usePerceptionSession(project: string, workspace: string) {
  const rpc = useOptionalLudensRpc();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const scope = JSON.stringify([project, workspace]);
  const [active, setActive] = useState<{ scope: string; session: PerceptionSession } | null>(null);
  useEffect(() => {
    let session = sessions.get(scope);
    if (!session) {
      let storage: Storage | undefined;
      try { storage = window.sessionStorage; } catch { /* In-memory recovery remains available. */ }
      const read = async (signal?: AbortSignal): Promise<SavedPerception> => {
        const caller = rpcRef.current;
        if (!caller) throw new Error("RPC client is unavailable");
        return (await caller.call("perception/getSettings", { project, workspace }, { signal, timeoutMs: 25_000 })) as SavedPerception;
      };
      const write = async (patch: PerceptionSettingsPatch): Promise<SavedPerception> => {
        const caller = rpcRef.current;
        if (!caller) throw new Error("RPC client is unavailable");
        return (await caller.call(
          "perception/updateSettings",
          { project, workspace, patch: patch as Record<string, unknown> },
          { timeoutMs: 25_000 },
        )) as SavedPerception;
      };
      session = createPerceptionSession({ scope, storage, read, write });
      sessions.set(scope, session);
    }
    setActive({ scope, session });
    if (rpcRef.current) void session.refresh();
  }, [scope, project, workspace, Boolean(rpc), rpc?.reconnectGeneration ?? 0]);
  const session = active?.scope === scope ? active.session : null;
  const subscribe = useCallback((listener: () => void) => session ? session.subscribe(listener) : emptySubscribe(), [session]);
  const state = useSyncExternalStore(subscribe, session?.snapshot ?? emptySnapshot, emptySnapshot);
  return { state, session };
}
