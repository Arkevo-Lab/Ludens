"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AvailableModelsCatalog } from "@/components/model-picker-dialog";
import type { DiscoveredDriver } from "@ludens/protocol/drivers";
import type { WorkspaceBasewareSnapshot } from "@ludens/protocol/workspaces";
import type { OmpEffort, OmpServiceTier, WorkspaceDefaults } from "@ludens/protocol/workspaces";
import { BUILTIN_CUA_DRIVER_SPEC } from "@ludens/protocol/drivers";
import { useLudensEvent, useOptionalLudensRpc } from "@/lib/ludens-rpc";

export interface ResolvedCreationModelDefaults {
  model: string;
  serviceTier: OmpServiceTier | null;
  effort: OmpEffort | null;
  authenticated: boolean;
  catalogLoaded: boolean;
}

export function resolveCreationModelDefaults(
  globalDefaults: WorkspaceDefaults | undefined,
  catalog: AvailableModelsCatalog | null,
): ResolvedCreationModelDefaults {
  const configuredModel = globalDefaults?.model?.trim() || catalog?.currentModel?.trim() || "openai-codex/gpt-6.2-sol";
  const configuredTier = globalDefaults?.serviceTier ?? catalog?.currentServiceTier ?? null;
  const configuredEffort = globalDefaults?.effort ?? catalog?.currentEffort ?? null;

  if (!catalog || catalog.models.length === 0) {
    return {
      model: configuredModel,
      serviceTier: configuredTier,
      effort: configuredEffort,
      authenticated: true,
      catalogLoaded: false,
    };
  }

  const exactMatch = catalog.models.find(item => item.fullId === configuredModel);
  if (exactMatch?.authenticated) {
    return {
      model: configuredModel,
      serviceTier: configuredTier,
      effort: configuredEffort,
      authenticated: true,
      catalogLoaded: true,
    };
  }

  const firstAuthenticated = catalog.models.find(item => item.authenticated);
  if (firstAuthenticated && !globalDefaults?.model) {
    return {
      model: firstAuthenticated.fullId,
      serviceTier: null,
      effort: firstAuthenticated.defaultEffort ?? null,
      authenticated: true,
      catalogLoaded: true,
    };
  }

  return {
    model: configuredModel,
    serviceTier: configuredTier,
    effort: configuredEffort,
    authenticated: Boolean(exactMatch?.authenticated),
    catalogLoaded: true,
  };
}

export function isSelectedModelAuthenticated(
  modelFullId: string | undefined,
  catalog: AvailableModelsCatalog | null,
): boolean | null {
  if (!catalog || catalog.models.length === 0) return null;
  const clean = modelFullId?.trim();
  if (!clean) return false;
  const found = catalog.models.find(item => item.fullId === clean);
  if (found) return found.authenticated;
  const slash = clean.indexOf("/");
  if (slash > 0) {
    const providerId = clean.slice(0, slash);
    const provider = catalog.providers.find(p => p.id === providerId);
    if (provider) return provider.authenticated;
  }
  return false;
}

export function useWorkspaceCreationCatalog(options: { enabled: boolean }) {
  const { enabled } = options;
  const rpc = useOptionalLudensRpc();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;

  const [baseware, setBaseware] = useState<WorkspaceBasewareSnapshot | null>(null);
  const [modelsCatalog, setModelsCatalog] = useState<AvailableModelsCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [discoveredCache, setDiscoveredCache] = useState<Record<string, DiscoveredDriver>>({});
  const inFlightDiscoverRef = useRef<Map<string, Promise<DiscoveredDriver>>>(new Map());

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const caller = rpcRef.current;
    if (!caller || !enabled) return;
    setLoading(true);
    try {
      const [overviewRes, modelsRes] = await Promise.allSettled([
        caller.call("baseware/overview", undefined, signal ? { signal } : undefined),
        caller.call("models/list", undefined, signal ? { signal } : undefined),
      ]);
      if (signal?.aborted) return;
      if (overviewRes.status === "fulfilled" && overviewRes.value) {
        setBaseware(overviewRes.value as unknown as WorkspaceBasewareSnapshot);
      }
      if (modelsRes.status === "fulfilled" && modelsRes.value) {
        setModelsCatalog(modelsRes.value as unknown as AvailableModelsCatalog);
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [enabled, refresh, Boolean(rpc), rpc?.reconnectGeneration ?? 0]);

  useLudensEvent(
    ["baseware", "workspace", "catalog"],
    () => {
      if (enabled) void refresh();
    },
    { enabled },
  );

  const discoverSpec = useCallback(
    async (rawSpec: string, signal?: AbortSignal): Promise<DiscoveredDriver> => {
      const spec = rawSpec.trim();
      if (!spec || spec === BUILTIN_CUA_DRIVER_SPEC) {
        return {
          id: "cua",
          spec: BUILTIN_CUA_DRIVER_SPEC,
          version: "builtin",
          transport: "stdio",
          needsGame: false,
        };
      }
      if (discoveredCache[spec]) {
        return discoveredCache[spec]!;
      }
      const existingPromise = inFlightDiscoverRef.current.get(spec);
      if (existingPromise && !signal) {
        return existingPromise;
      }
      const caller = rpcRef.current;
      if (!caller) {
        throw new Error("RPC client is unavailable");
      }
      const promise = (caller.call(
        "drivers/discover",
        { spec },
        signal ? { signal } : undefined,
      ) as unknown as Promise<DiscoveredDriver>).then(driver => {
        setDiscoveredCache(prev => ({ ...prev, [spec]: driver }));
        return driver;
      }).finally(() => {
        inFlightDiscoverRef.current.delete(spec);
      });
      if (!signal) {
        inFlightDiscoverRef.current.set(spec, promise);
      }
      return promise;
    },
    [discoveredCache],
  );

  return {
    baseware,
    machines: baseware?.machines ?? [],
    drivers: baseware?.drivers ?? [],
    modelsCatalog,
    loading,
    discoveredCache,
    discoverSpec,
    refresh,
  };
}
