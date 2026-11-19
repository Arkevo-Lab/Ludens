import { useMemo, useSyncExternalStore } from "react";
import {
  hasDesktopRpcBridge,
  isLoopbackHost,
  type ConnectionTarget,
  type ResolvedConnectionEndpoints,
} from "./connection-target";
import {
  formatConnectionBannerMessage,
  useOptionalLudensRpc,
  type LudensRpcSnapshot,
} from "./ludens-rpc";

export { formatConnectionBannerMessage };

export type LudensRuntimeProfile = "desktop" | "remote" | "web-dev";

export interface HostSessionCapabilities {
  readonly localFsPaths: boolean;
  readonly localFileDrivers: boolean;
  readonly hostProcessOverrides: boolean;
  readonly hostStorageConfig: boolean;
}

export type DevSimulateProfile = "auto" | "remote" | "desktop";

export const DEV_SIMULATE_PROFILE_SESSION_KEY = "ludens.devSimulateProfile";

export const FULL_HOST_CAPABILITIES: HostSessionCapabilities = Object.freeze({
  localFsPaths: true,
  localFileDrivers: true,
  hostProcessOverrides: true,
  hostStorageConfig: true,
});

export const MANAGED_SANDBOX_CAPABILITIES: HostSessionCapabilities = Object.freeze({
  localFsPaths: false,
  localFileDrivers: false,
  hostProcessOverrides: false,
  hostStorageConfig: false,
});

export interface ServerRuntimeMetadata {
  readonly home?: string;
  readonly runtimeProfile?: LudensRuntimeProfile;
  readonly capabilities?: Partial<HostSessionCapabilities>;
}

export interface RuntimeCapabilitiesInput {
  readonly target: ConnectionTarget;
  readonly resolved?: ResolvedConnectionEndpoints;
  readonly serverInfo?: ServerRuntimeMetadata;
  readonly lastKnownServerInfo?: ServerRuntimeMetadata;
  readonly devSimulatedProfile?: DevSimulateProfile;
}

export interface RuntimeCapabilitiesState {
  /** Effective runtime profile after applying any `web-dev` UI simulation override. */
  readonly runtimeProfile: LudensRuntimeProfile;
  /** Underlying session profile reported by or inferred from the connection target. */
  readonly actualProfile: LudensRuntimeProfile;
  /** Effective session capabilities driving host-path & process UI gating. */
  readonly capabilities: HostSessionCapabilities;
  /** Active `sessionStorage` simulation override (`"auto"` unless `actualProfile === "web-dev"`). */
  readonly devSimulatedProfile: DevSimulateProfile;
  /** True when `actualProfile === "web-dev"` and `devSimulatedProfile !== "auto"`. */
  readonly isSimulated: boolean;
  /** Server `LUDENS_HOME` path reported by handshake (`~/.ludens-dev` in isolated `web-dev`). */
  readonly serverHome?: string;
}

export function defaultCapabilitiesForProfile(
  profile: LudensRuntimeProfile,
): HostSessionCapabilities {
  return profile === "remote" ? MANAGED_SANDBOX_CAPABILITIES : FULL_HOST_CAPABILITIES;
}

function isRuntimeProfile(value: unknown): value is LudensRuntimeProfile {
  return value === "desktop" || value === "remote" || value === "web-dev";
}

function normalizeCapabilities(
  raw: Partial<HostSessionCapabilities> | undefined,
  fallbackProfile: LudensRuntimeProfile,
): HostSessionCapabilities {
  const fallback = defaultCapabilitiesForProfile(fallbackProfile);
  if (!raw || typeof raw !== "object") {
    return fallback;
  }
  return {
    localFsPaths:
      typeof raw.localFsPaths === "boolean" ? raw.localFsPaths : fallback.localFsPaths,
    localFileDrivers:
      typeof raw.localFileDrivers === "boolean"
        ? raw.localFileDrivers
        : fallback.localFileDrivers,
    hostProcessOverrides:
      typeof raw.hostProcessOverrides === "boolean"
        ? raw.hostProcessOverrides
        : fallback.hostProcessOverrides,
    hostStorageConfig:
      typeof raw.hostStorageConfig === "boolean"
        ? raw.hostStorageConfig
        : fallback.hostStorageConfig,
  };
}

export function inferFallbackRuntimeProfile(
  target: ConnectionTarget,
  resolved?: ResolvedConnectionEndpoints,
  locationHost?: string,
): LudensRuntimeProfile {
  if (target.kind === "electron-local") {
    return "desktop";
  }
  if (target.kind === "same-origin") {
    const hostCandidate =
      (resolved?.ok ? resolved.httpOrigin : undefined) ??
      resolved?.displayTarget ??
      locationHost ??
      (typeof window !== "undefined" ? window.location?.host : undefined);
    if (isLoopbackHost(hostCandidate)) {
      return "web-dev";
    }
  }
  return "remote";
}

const devSimulateListeners = new Set<() => void>();

function parseDevSimulateProfile(raw: string | null | undefined): DevSimulateProfile {
  if (raw === "remote" || raw === "desktop" || raw === "auto") {
    return raw;
  }
  return "auto";
}

export function getDevSimulatedProfile(
  storage?: Pick<Storage, "getItem"> | null,
): DevSimulateProfile {
  try {
    const targetStorage =
      storage ?? (typeof window !== "undefined" ? window.sessionStorage : undefined);
    if (!targetStorage) return "auto";
    return parseDevSimulateProfile(targetStorage.getItem(DEV_SIMULATE_PROFILE_SESSION_KEY));
  } catch {
    return "auto";
  }
}

export function setDevSimulatedProfile(
  next: DevSimulateProfile,
  storage?: Pick<Storage, "setItem" | "removeItem"> | null,
): void {
  const normalized = parseDevSimulateProfile(next);
  try {
    const targetStorage =
      storage ?? (typeof window !== "undefined" ? window.sessionStorage : undefined);
    if (targetStorage) {
      if (normalized === "auto") {
        targetStorage.removeItem(DEV_SIMULATE_PROFILE_SESSION_KEY);
      } else {
        targetStorage.setItem(DEV_SIMULATE_PROFILE_SESSION_KEY, normalized);
      }
    }
  } catch {
    // Ignore storage quota/sandbox errors; still notify in-memory listeners if possible.
  }
  for (const listener of [...devSimulateListeners]) {
    try {
      listener();
    } catch {
      // Keep notifying remaining subscribers.
    }
  }
}

export function subscribeDevSimulatedProfile(listener: () => void): () => void {
  devSimulateListeners.add(listener);
  return () => {
    devSimulateListeners.delete(listener);
  };
}

export function resolveRuntimeCapabilities(
  input: RuntimeCapabilitiesInput,
): RuntimeCapabilitiesState {
  const effectiveInfo = input.serverInfo ?? input.lastKnownServerInfo;
  const reportedProfile = isRuntimeProfile(effectiveInfo?.runtimeProfile)
    ? effectiveInfo.runtimeProfile
    : undefined;
  const actualProfile =
    reportedProfile ?? inferFallbackRuntimeProfile(input.target, input.resolved);

  const serverHome =
    typeof effectiveInfo?.home === "string" && effectiveInfo.home.trim().length > 0
      ? effectiveInfo.home
      : undefined;

  const simOverride: DevSimulateProfile =
    actualProfile === "web-dev"
      ? parseDevSimulateProfile(input.devSimulatedProfile)
      : "auto";

  if (actualProfile === "web-dev" && simOverride !== "auto") {
    return {
      runtimeProfile: simOverride,
      actualProfile,
      capabilities: defaultCapabilitiesForProfile(simOverride),
      devSimulatedProfile: simOverride,
      isSimulated: true,
      serverHome,
    };
  }

  const capabilities = normalizeCapabilities(effectiveInfo?.capabilities, actualProfile);
  return {
    runtimeProfile: actualProfile,
    actualProfile,
    capabilities,
    devSimulatedProfile: "auto",
    isSimulated: false,
    serverHome,
  };
}

export function resolveSnapshotRuntimeCapabilities(
  snapshot: Pick<
    LudensRpcSnapshot,
    "target" | "resolved" | "serverInfo" | "lastKnownServerInfo"
  >,
  devSimulatedProfile: DevSimulateProfile = "auto",
): RuntimeCapabilitiesState {
  return resolveRuntimeCapabilities({
    target: snapshot.target,
    resolved: snapshot.resolved,
    serverInfo: snapshot.serverInfo as ServerRuntimeMetadata | undefined,
    lastKnownServerInfo: snapshot.lastKnownServerInfo as ServerRuntimeMetadata | undefined,
    devSimulatedProfile,
  });
}

function resolveStandaloneDefaultTarget(): ConnectionTarget {
  if (typeof window === "undefined") {
    return { kind: "electron-local" };
  }
  if (hasDesktopRpcBridge(window)) {
    return { kind: "electron-local" };
  }
  const proto = (window.location?.protocol ?? "").toLowerCase();
  if ((proto === "http:" || proto === "https:") && window.location?.host) {
    return { kind: "same-origin" };
  }
  return { kind: "electron-local" };
}

export function useRuntimeCapabilities(): RuntimeCapabilitiesState & {
  readonly setDevSimulatedProfile: (next: DevSimulateProfile) => void;
} {
  const rpcCtx = useOptionalLudensRpc();
  const devSimulatedProfile = useSyncExternalStore(
    subscribeDevSimulatedProfile,
    () => getDevSimulatedProfile(),
    () => getDevSimulatedProfile(),
  );

  return useMemo(() => {
    const state = rpcCtx
      ? resolveSnapshotRuntimeCapabilities(rpcCtx.snapshot, devSimulatedProfile)
      : resolveRuntimeCapabilities({
          target: resolveStandaloneDefaultTarget(),
          devSimulatedProfile,
        });
    return {
      ...state,
      setDevSimulatedProfile: (next: DevSimulateProfile) => setDevSimulatedProfile(next),
    };
  }, [rpcCtx, devSimulatedProfile]);
}
