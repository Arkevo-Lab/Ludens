"use client";

import { useEffect, useRef, useState } from "react";
import { PET_AUTO_TARGET, type PetState, type PetTarget, type PetTargetReceipt } from "@/lib/pet";
import { useLudensEvent, useOptionalLudensRpc, type LudensRpcCaller } from "@/lib/ludens-rpc";
import { createPetFollowResource, type PetFollowSnapshot } from "@/features/pet/pet-follow-resource";

const target = (value: unknown): value is PetTarget | null => value === null || (typeof value === "object" && value !== null
  && ["project", "workspace", "revision", "updatedAt"].every(key => typeof (value as Record<string, unknown>)[key] === "string"));

async function readState(rpc: LudensRpcCaller | null, signal: AbortSignal): Promise<PetState> {
  if (!rpc) throw new Error("RPC client is unavailable");
  const value = (await rpc.call("pet/getState", undefined, { signal })) as unknown as PetState | null;
  if (!value || !target(value.target) || typeof value.targetConfigured !== "boolean" || ![true, false, null].includes(value.connected)
    || (value.consumer !== null && (typeof value.consumer !== "object" || !value.consumer))) throw new Error("Invalid pet status response");
  return value;
}

export function isValidPetTargetReceipt(project: string | null, value: unknown): value is PetTargetReceipt {
  if (!value || typeof value !== "object") return false;
  const candidate = value as PetTargetReceipt;
  if (!target(candidate.target)) return false;
  if (project === PET_AUTO_TARGET) {
    return candidate.target === null || candidate.target.project === PET_AUTO_TARGET;
  }
  return (candidate.target?.project ?? null) === project;
}

async function writeTarget(rpc: LudensRpcCaller | null, project: string | null, signal: AbortSignal): Promise<PetTargetReceipt> {
  if (!rpc) throw new Error("RPC client is unavailable");
  const value = await rpc.call("pet/setTarget", { project }, { signal });
  if (!isValidPetTargetReceipt(project, value)) throw new Error("Invalid pet target receipt");
  return value as unknown as PetTargetReceipt;
}

export function usePetFollow() {
  const rpc = useOptionalLudensRpc();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const [snapshot, setSnapshot] = useState<PetFollowSnapshot>({ state: null, pending: false, reading: true,
    readError: "", writeError: "", requested: undefined, lastReadAt: null, lastSaved: undefined, canWrite: false });
  const resource = useRef<ReturnType<typeof createPetFollowResource> | null>(null);
  useEffect(() => {
    const value = createPetFollowResource({
      read: signal => readState(rpcRef.current, signal),
      write: (project, signal) => writeTarget(rpcRef.current, project, signal),
      onChange: setSnapshot,
      intervalMs: 0,
    });
    resource.current = value;
    void value.refresh();
    return () => { value.dispose(); if (resource.current === value) resource.current = null; };
  }, []);
  useEffect(() => {
    if (!rpc) return;
    void resource.current?.refresh();
  }, [Boolean(rpc), rpc?.reconnectGeneration ?? 0]);
  useLudensEvent(["pet", "core", "workspace"], () => {
    void resource.current?.refresh();
  });
  return { ...snapshot,
    follow: (project: string | null) => resource.current?.follow(project) ?? Promise.resolve(),
    refresh: () => { void resource.current?.refresh(); },
  };
}
export type PetFollow = ReturnType<typeof usePetFollow>;
