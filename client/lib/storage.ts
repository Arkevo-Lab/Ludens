"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DirectoryBackendConfig,
  EffectiveWorkspaceStorage,
  GlobalStorageConfig,
  GlobalStorageUpdateInput,
  RedactedGlobalStorageConfig,
  RedactedS3BackendConfig,
  RedactedStorageProfile,
  S3BackendConfig,
  StorageBackendKind,
  StorageMaintainParams,
  StorageMaintainResult,
  StoragePinParams,
  StoragePinResult,
  StorageProfile,
  StorageProfileInput,
  StorageTestParams,
  StorageTestResult,
  TimelineArchiveLocation,
  VideoQualityPreset,
  VideoQualitySpec,
  WorkspaceStorageMode,
  WorkspaceStorageOverride,
  WorkspaceStorageUsageSummary,
} from "@ludens/protocol/storage";
import { useLudensEvent, useOptionalLudensRpc } from "./ludens-rpc";

export type {
  DirectoryBackendConfig,
  EffectiveWorkspaceStorage,
  GlobalStorageConfig,
  GlobalStorageUpdateInput,
  RedactedGlobalStorageConfig,
  RedactedS3BackendConfig,
  RedactedStorageProfile,
  S3BackendConfig,
  StorageBackendKind,
  StorageMaintainParams,
  StorageMaintainResult,
  StoragePinParams,
  StoragePinResult,
  StorageProfile,
  StorageProfileInput,
  StorageTestParams,
  StorageTestResult,
  TimelineArchiveLocation,
  VideoQualityPreset,
  VideoQualitySpec,
  WorkspaceStorageMode,
  WorkspaceStorageOverride,
  WorkspaceStorageUsageSummary,
};

export const GIB_BYTES = 1024 * 1024 * 1024;
export const DEFAULT_LOCAL_MAX_BYTES = 20 * GIB_BYTES;
export const DEFAULT_LOCAL_CACHE_BYTES = 4 * GIB_BYTES;
export const BUILTIN_LOCAL_PROFILE_ID = "local-default";
export const SECRET_MASK = "••••••••";

export const RECORDING_QUALITY_TIERS: readonly VideoQualityPreset[] = [
  "compact",
  "balanced",
  "high",
] as const;

export const VIDEO_QUALITY_SPECS: Readonly<Record<VideoQualityPreset, VideoQualitySpec>> = {
  compact: {
    crf: 28,
    maxLongEdge: 720,
    recommendedMaxBytes: 5 * GIB_BYTES,
  },
  balanced: {
    crf: 23,
    maxLongEdge: 1080,
    recommendedMaxBytes: 20 * GIB_BYTES,
  },
  high: {
    crf: 18,
    maxLongEdge: null,
    recommendedMaxBytes: 50 * GIB_BYTES,
  },
};

function trimTrailingZeros(formatted: string): string {
  if (!formatted.includes(".")) return formatted;
  return formatted.replace(/\.?0+$/, "");
}

/**
 * Format byte counts using binary powers (B / KB / MB / GB / TB) for UI display.
 */
export function formatStorageBytes(
  bytes: number | null | undefined,
  options?: { unlimitedLabel?: string },
): string {
  if (bytes === null || bytes === undefined) {
    return options?.unlimitedLabel ?? "∞";
  }
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${trimTrailingZeros((bytes / 1024).toFixed(1))} KB`;
  }
  if (bytes < GIB_BYTES) {
    return `${trimTrailingZeros((bytes / (1024 * 1024)).toFixed(1))} MB`;
  }
  const tib = GIB_BYTES * 1024;
  if (bytes < tib) {
    return `${trimTrailingZeros((bytes / GIB_BYTES).toFixed(2))} GB`;
  }
  return `${trimTrailingZeros((bytes / tib).toFixed(2))} TB`;
}

export function bytesToGibInput(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) {
    return "";
  }
  return trimTrailingZeros((bytes / GIB_BYTES).toFixed(2));
}

/**
 * Parse a GiB string input into exact bytes (`null` when blank, `NaN` when invalid).
 */
export function gibInputToBytes(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Number.NaN;
  }
  return Math.round(parsed * GIB_BYTES);
}

/**
 * Parse an hours string input into positive integer hours (`null` when blank, `NaN` when invalid).
 */
export function hoursInputToNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Number.NaN;
  }
  return Math.round(parsed);
}

export interface StorageFootprintTotals {
  workspaceCount: number;
  totalLocalBytes: number;
  localVideoBytes: number;
  localVideoSegments: number;
  localCacheBytes: number;
  localObjectsBytes: number;
  segmentsIndexBytes: number;
  logsBytes: number;
  archivedSegments: number;
  archivedBytes: number;
  evictedSegments: number;
  pinnedSegments: number;
}

export function aggregateStorageFootprint(
  usage: readonly WorkspaceStorageUsageSummary[],
): StorageFootprintTotals {
  const totals: StorageFootprintTotals = {
    workspaceCount: usage.length,
    totalLocalBytes: 0,
    localVideoBytes: 0,
    localVideoSegments: 0,
    localCacheBytes: 0,
    localObjectsBytes: 0,
    segmentsIndexBytes: 0,
    logsBytes: 0,
    archivedSegments: 0,
    archivedBytes: 0,
    evictedSegments: 0,
    pinnedSegments: 0,
  };
  for (const item of usage) {
    totals.totalLocalBytes += item.totalLocalBytes || 0;
    totals.localVideoBytes += item.localVideoBytes || 0;
    totals.localVideoSegments += item.localVideoSegments || 0;
    totals.localCacheBytes += item.localCacheBytes || 0;
    totals.localObjectsBytes += item.localObjectsBytes || 0;
    totals.segmentsIndexBytes += item.segmentsIndexBytes || 0;
    totals.logsBytes += item.logsBytes || 0;
    totals.archivedSegments += item.archivedSegments || 0;
    totals.archivedBytes += item.archivedBytes || 0;
    totals.evictedSegments += item.evictedSegments || 0;
    totals.pinnedSegments += item.pinnedSegments || 0;
  }
  return totals;
}

export function fallbackGlobalStorageConfig(): RedactedGlobalStorageConfig {
  return {
    version: 1,
    defaultProfileId: BUILTIN_LOCAL_PROFILE_ID,
    videoQuality: "balanced",
    protectReferenced: true,
    profiles: [
      {
        id: BUILTIN_LOCAL_PROFILE_ID,
        name: "Local Default",
        kind: "local",
        maxBytes: DEFAULT_LOCAL_MAX_BYTES,
        maxAgeHours: null,
        localCacheBytes: null,
      },
    ],
  };
}

export function redactedProfileToInput(profile: RedactedStorageProfile): StorageProfileInput {
  return {
    id: profile.id,
    name: profile.name,
    kind: profile.kind,
    maxBytes: profile.maxBytes ?? null,
    maxAgeHours: profile.maxAgeHours ?? null,
    localCacheBytes: profile.localCacheBytes ?? null,
    ...(profile.directory ? { directory: { path: profile.directory.path } } : {}),
    ...(profile.s3
      ? {
          s3: {
            endpoint: profile.s3.endpoint,
            region: profile.s3.region,
            bucket: profile.s3.bucket,
            ...(profile.s3.prefix ? { prefix: profile.s3.prefix } : {}),
            accessKeyId: profile.s3.accessKeyId,
            ...(profile.s3.forcePathStyle !== undefined
              ? { forcePathStyle: profile.s3.forcePathStyle }
              : {}),
          },
        }
      : {}),
  };
}

export function slugifyStorageProfileId(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (!base) return "";
  if (base === BUILTIN_LOCAL_PROFILE_ID) return `${base}-custom`;
  return /^[a-z0-9]/.test(base) ? base : `p-${base}`;
}

export interface StorageProfileDraft {
  id: string;
  name: string;
  kind: StorageBackendKind;
  maxGib: string;
  maxAgeHours: string;
  localCacheGib: string;
  directoryPath: string;
  s3Endpoint: string;
  s3Region: string;
  s3Bucket: string;
  s3Prefix: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
  s3ForcePathStyle: boolean;
}

export type StorageProfileErrorField =
  | "id"
  | "name"
  | "maxGib"
  | "maxAgeHours"
  | "localCacheGib"
  | "directoryPath"
  | "s3Endpoint"
  | "s3Region"
  | "s3Bucket"
  | "s3AccessKeyId"
  | "s3SecretAccessKey";

export type StorageProfileErrorCode =
  | "required"
  | "invalidId"
  | "duplicateId"
  | "reservedId"
  | "invalidPositiveNumber"
  | "invalidAbsolutePath"
  | "invalidEndpointUrl";

export function createEmptyStorageProfileDraft(
  kind: StorageBackendKind = "directory",
): StorageProfileDraft {
  return {
    id: "",
    name: "",
    kind,
    maxGib: kind === "local" ? bytesToGibInput(DEFAULT_LOCAL_MAX_BYTES) : "",
    maxAgeHours: "",
    localCacheGib:
      kind === "directory" || kind === "s3" ? bytesToGibInput(DEFAULT_LOCAL_CACHE_BYTES) : "",
    directoryPath: "",
    s3Endpoint: "",
    s3Region: "auto",
    s3Bucket: "",
    s3Prefix: "",
    s3AccessKeyId: "",
    s3SecretAccessKey: "",
    s3ForcePathStyle: false,
  };
}

export function storageProfileToDraft(profile: RedactedStorageProfile): StorageProfileDraft {
  return {
    id: profile.id,
    name: profile.name,
    kind: profile.kind,
    maxGib: bytesToGibInput(profile.maxBytes),
    maxAgeHours:
      profile.maxAgeHours !== null && profile.maxAgeHours !== undefined && profile.maxAgeHours > 0
        ? String(profile.maxAgeHours)
        : "",
    localCacheGib:
      profile.localCacheBytes !== null && profile.localCacheBytes !== undefined
        ? bytesToGibInput(profile.localCacheBytes)
        : profile.kind === "directory" || profile.kind === "s3"
          ? bytesToGibInput(DEFAULT_LOCAL_CACHE_BYTES)
          : "",
    directoryPath: profile.directory?.path ?? "",
    s3Endpoint: profile.s3?.endpoint ?? "",
    s3Region: profile.s3?.region ?? "auto",
    s3Bucket: profile.s3?.bucket ?? "",
    s3Prefix: profile.s3?.prefix ?? "",
    s3AccessKeyId: profile.s3?.accessKeyId ?? "",
    s3SecretAccessKey: "",
    s3ForcePathStyle: profile.s3?.forcePathStyle ?? false,
  };
}

function isAbsolutePosixOrWinPath(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed);
}

function isValidHttpEndpoint(value: string): boolean {
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function validateStorageProfileDraft(
  draft: StorageProfileDraft,
  options: {
    editingProfile: RedactedStorageProfile | null;
    existingIds: readonly string[];
  },
): {
  valid: boolean;
  errors: Partial<Record<StorageProfileErrorField, StorageProfileErrorCode>>;
} {
  const errors: Partial<Record<StorageProfileErrorField, StorageProfileErrorCode>> = {};
  const isEditing = Boolean(options.editingProfile);
  const isBuiltin = options.editingProfile?.id === BUILTIN_LOCAL_PROFILE_ID;

  const trimmedId = draft.id.trim();
  if (!trimmedId) {
    errors.id = "required";
  } else if (!isBuiltin && trimmedId === BUILTIN_LOCAL_PROFILE_ID) {
    errors.id = "reservedId";
  } else if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(trimmedId)) {
    errors.id = "invalidId";
  } else if (!isEditing && options.existingIds.includes(trimmedId)) {
    errors.id = "duplicateId";
  }

  if (!draft.name.trim()) {
    errors.name = "required";
  }

  if (draft.kind !== "ephemeral") {
    const maxBytes = gibInputToBytes(draft.maxGib);
    if (Number.isNaN(maxBytes)) {
      errors.maxGib = "invalidPositiveNumber";
    }
    const maxAge = hoursInputToNumber(draft.maxAgeHours);
    if (Number.isNaN(maxAge)) {
      errors.maxAgeHours = "invalidPositiveNumber";
    }
  }

  if (draft.kind === "directory" || draft.kind === "s3") {
    const cacheBytes = gibInputToBytes(draft.localCacheGib);
    if (Number.isNaN(cacheBytes)) {
      errors.localCacheGib = "invalidPositiveNumber";
    }
  }

  if (draft.kind === "directory") {
    if (!draft.directoryPath.trim()) {
      errors.directoryPath = "required";
    } else if (!isAbsolutePosixOrWinPath(draft.directoryPath)) {
      errors.directoryPath = "invalidAbsolutePath";
    }
  }

  if (draft.kind === "s3") {
    if (!draft.s3Endpoint.trim()) {
      errors.s3Endpoint = "required";
    } else if (!isValidHttpEndpoint(draft.s3Endpoint)) {
      errors.s3Endpoint = "invalidEndpointUrl";
    }
    if (!draft.s3Region.trim()) {
      errors.s3Region = "required";
    }
    if (!draft.s3Bucket.trim()) {
      errors.s3Bucket = "required";
    }
    if (!draft.s3AccessKeyId.trim()) {
      errors.s3AccessKeyId = "required";
    }
    const hasSavedSecret = Boolean(options.editingProfile?.s3?.hasSecretAccessKey);
    const trimmedSecret = draft.s3SecretAccessKey.trim();
    if (!hasSavedSecret && (!trimmedSecret || trimmedSecret === SECRET_MASK)) {
      errors.s3SecretAccessKey = "required";
    }
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}

export function draftToStorageProfileInput(draft: StorageProfileDraft): StorageProfileInput {
  const maxBytes = draft.kind === "ephemeral" ? null : gibInputToBytes(draft.maxGib);
  const maxAgeHours = draft.kind === "ephemeral" ? null : hoursInputToNumber(draft.maxAgeHours);
  const localCacheBytes =
    draft.kind === "directory" || draft.kind === "s3"
      ? gibInputToBytes(draft.localCacheGib) ?? DEFAULT_LOCAL_CACHE_BYTES
      : null;

  const trimmedSecret = draft.s3SecretAccessKey.trim();
  const includeSecret = trimmedSecret.length > 0 && trimmedSecret !== SECRET_MASK;

  return {
    id: draft.id.trim(),
    name: draft.name.trim(),
    kind: draft.kind,
    maxBytes,
    maxAgeHours,
    localCacheBytes,
    ...(draft.kind === "directory"
      ? { directory: { path: draft.directoryPath.trim() } }
      : {}),
    ...(draft.kind === "s3"
      ? {
          s3: {
            endpoint: draft.s3Endpoint.trim(),
            region: draft.s3Region.trim(),
            bucket: draft.s3Bucket.trim(),
            ...(draft.s3Prefix.trim() ? { prefix: draft.s3Prefix.trim() } : {}),
            accessKeyId: draft.s3AccessKeyId.trim(),
            ...(includeSecret ? { secretAccessKey: trimmedSecret } : {}),
            forcePathStyle: draft.s3ForcePathStyle,
          },
        }
      : {}),
  };
}

export function buildStorageTestParamsFromDraft(
  draft: StorageProfileDraft,
  editingProfile: RedactedStorageProfile | null,
): StorageTestParams | null {
  if (draft.kind === "directory") {
    return {
      kind: "directory",
      ...(editingProfile ? { profileId: editingProfile.id } : {}),
      directory: { path: draft.directoryPath.trim() },
    };
  }
  if (draft.kind === "s3") {
    const trimmedSecret = draft.s3SecretAccessKey.trim();
    const includeSecret = trimmedSecret.length > 0 && trimmedSecret !== SECRET_MASK;
    return {
      kind: "s3",
      ...(editingProfile ? { profileId: editingProfile.id } : {}),
      s3: {
        endpoint: draft.s3Endpoint.trim(),
        region: draft.s3Region.trim(),
        bucket: draft.s3Bucket.trim(),
        ...(draft.s3Prefix.trim() ? { prefix: draft.s3Prefix.trim() } : {}),
        accessKeyId: draft.s3AccessKeyId.trim(),
        ...(includeSecret ? { secretAccessKey: trimmedSecret } : {}),
        forcePathStyle: draft.s3ForcePathStyle,
      },
    };
  }
  return null;
}

export interface WorkspaceStorageDraft {
  mode: WorkspaceStorageMode;
  profileId: string;
  maxGib: string;
  videoQuality: "" | VideoQualityPreset;
  maxAgeHours: number | null;
  localCacheBytes: number | null;
}

export function workspaceStorageToDraft(
  override: WorkspaceStorageOverride | null | undefined,
  defaultProfileId: string = BUILTIN_LOCAL_PROFILE_ID,
): WorkspaceStorageDraft {
  if (!override) {
    return {
      mode: "inherit",
      profileId: defaultProfileId,
      maxGib: "",
      videoQuality: "",
      maxAgeHours: null,
      localCacheBytes: null,
    };
  }
  return {
    mode: override.mode ?? "inherit",
    profileId: override.profileId?.trim() || defaultProfileId,
    maxGib: bytesToGibInput(override.maxBytes),
    videoQuality: override.videoQuality ?? "",
    maxAgeHours: override.maxAgeHours ?? null,
    localCacheBytes: override.localCacheBytes ?? null,
  };
}

export function normalizeWorkspaceStorageOverride(
  override: WorkspaceStorageOverride | null | undefined,
): WorkspaceStorageOverride | null {
  if (!override) return null;
  const mode: WorkspaceStorageMode = override.mode ?? "inherit";
  const maxBytes =
    mode === "ephemeral"
      ? undefined
      : typeof override.maxBytes === "number" && Number.isFinite(override.maxBytes) && override.maxBytes > 0
        ? Math.round(override.maxBytes)
        : undefined;
  const maxAgeHours =
    mode === "ephemeral"
      ? undefined
      : typeof override.maxAgeHours === "number" && Number.isFinite(override.maxAgeHours) && override.maxAgeHours > 0
        ? Math.round(override.maxAgeHours)
        : undefined;
  const localCacheBytes =
    mode === "ephemeral"
      ? undefined
      : typeof override.localCacheBytes === "number" &&
          Number.isFinite(override.localCacheBytes) &&
          override.localCacheBytes > 0
        ? Math.round(override.localCacheBytes)
        : undefined;
  const videoQuality = override.videoQuality;
  const profileId = mode === "profile" && override.profileId?.trim() ? override.profileId.trim() : undefined;

  if (
    mode === "inherit" &&
    maxBytes === undefined &&
    maxAgeHours === undefined &&
    localCacheBytes === undefined &&
    videoQuality === undefined
  ) {
    return null;
  }

  return {
    mode,
    ...(profileId ? { profileId } : {}),
    ...(maxBytes !== undefined ? { maxBytes } : {}),
    ...(maxAgeHours !== undefined ? { maxAgeHours } : {}),
    ...(localCacheBytes !== undefined ? { localCacheBytes } : {}),
    ...(videoQuality ? { videoQuality } : {}),
  };
}

export function draftToWorkspaceStorageOverride(
  draft: WorkspaceStorageDraft,
): { override: WorkspaceStorageOverride | null; errorCode: "missingProfile" | "invalidMaxGib" | null } {
  if (draft.mode === "profile" && !draft.profileId.trim()) {
    return { override: null, errorCode: "missingProfile" };
  }
  const parsedMaxBytes = draft.mode === "ephemeral" ? null : gibInputToBytes(draft.maxGib);
  if (Number.isNaN(parsedMaxBytes)) {
    return { override: null, errorCode: "invalidMaxGib" };
  }
  const candidate: WorkspaceStorageOverride = {
    mode: draft.mode,
    ...(draft.mode === "profile" ? { profileId: draft.profileId.trim() } : {}),
    ...(parsedMaxBytes !== null ? { maxBytes: parsedMaxBytes } : {}),
    ...(draft.mode !== "ephemeral" && draft.maxAgeHours !== null
      ? { maxAgeHours: draft.maxAgeHours }
      : {}),
    ...(draft.mode !== "ephemeral" && draft.localCacheBytes !== null
      ? { localCacheBytes: draft.localCacheBytes }
      : {}),
    ...(draft.videoQuality ? { videoQuality: draft.videoQuality } : {}),
  };
  return {
    override: normalizeWorkspaceStorageOverride(candidate),
    errorCode: null,
  };
}

export function sameWorkspaceStorageOverride(
  a: WorkspaceStorageOverride | null | undefined,
  b: WorkspaceStorageOverride | null | undefined,
): boolean {
  return JSON.stringify(normalizeWorkspaceStorageOverride(a)) === JSON.stringify(normalizeWorkspaceStorageOverride(b));
}

export function formatVideoQualitySpecBadge(
  quality: VideoQualityPreset,
  options?: { nativeLabel?: string; showQuota?: boolean },
): string {
  const spec = VIDEO_QUALITY_SPECS[quality];
  const resLabel =
    spec.maxLongEdge !== null ? `${spec.maxLongEdge}p` : (options?.nativeLabel ?? "Native");
  const crfLabel = `CRF ${spec.crf}`;
  if (options?.showQuota === false) {
    return `${resLabel} · ${crfLabel}`;
  }
  const gibLabel = `${bytesToGibInput(spec.recommendedMaxBytes)} GiB`;
  return `${resLabel} · ${crfLabel} · ${gibLabel}`;
}

export interface GlobalStorageDefaultsDraft {
  defaultProfileId: string;
  videoQuality: VideoQualityPreset;
  protectReferenced: boolean;
  syncedLocalMaxBytes?: number;
}

export function createGlobalStorageDefaultsDraft(
  config: RedactedGlobalStorageConfig,
): GlobalStorageDefaultsDraft {
  return {
    defaultProfileId: config.defaultProfileId,
    videoQuality: config.videoQuality,
    protectReferenced: config.protectReferenced,
  };
}

export function applyGlobalQualityPreset(
  draft: GlobalStorageDefaultsDraft,
  preset: VideoQualityPreset,
): GlobalStorageDefaultsDraft {
  return {
    ...draft,
    videoQuality: preset,
    syncedLocalMaxBytes: VIDEO_QUALITY_SPECS[preset].recommendedMaxBytes,
  };
}

export function isGlobalStorageDefaultsDirty(
  config: RedactedGlobalStorageConfig,
  draft: GlobalStorageDefaultsDraft,
): boolean {
  const builtinProfile = config.profiles.find(p => p.id === BUILTIN_LOCAL_PROFILE_ID);
  const currentBuiltinMaxBytes =
    builtinProfile?.maxBytes !== undefined ? builtinProfile.maxBytes : DEFAULT_LOCAL_MAX_BYTES;
  const localQuotaChanged =
    draft.syncedLocalMaxBytes !== undefined &&
    draft.syncedLocalMaxBytes !== currentBuiltinMaxBytes;
  return (
    draft.defaultProfileId !== config.defaultProfileId ||
    draft.videoQuality !== config.videoQuality ||
    draft.protectReferenced !== config.protectReferenced ||
    localQuotaChanged
  );
}

export function buildGlobalDefaultsUpdateInput(
  config: RedactedGlobalStorageConfig,
  draft: GlobalStorageDefaultsDraft,
): GlobalStorageUpdateInput {
  const shouldSyncProfiles = draft.syncedLocalMaxBytes !== undefined;
  return {
    defaultProfileId: draft.defaultProfileId,
    videoQuality: draft.videoQuality,
    protectReferenced: draft.protectReferenced,
    ...(shouldSyncProfiles
      ? {
          profiles: config.profiles.map(profile =>
            profile.id === BUILTIN_LOCAL_PROFILE_ID
              ? {
                  ...redactedProfileToInput(profile),
                  maxBytes: draft.syncedLocalMaxBytes!,
                }
              : redactedProfileToInput(profile),
          ),
        }
      : {}),
  };
}

export function shouldShowStudioPresetQuota(draft: WorkspaceStorageDraft): boolean {
  return draft.mode === "local" || draft.mode === "inherit";
}

export function applyStudioQualityPreset(
  draft: WorkspaceStorageDraft,
  preset: VideoQualityPreset,
): WorkspaceStorageDraft {
  if (draft.mode === "profile" || draft.mode === "ephemeral") {
    return {
      ...draft,
      videoQuality: preset,
    };
  }
  return {
    ...draft,
    mode: "local",
    videoQuality: preset,
    maxGib: bytesToGibInput(VIDEO_QUALITY_SPECS[preset].recommendedMaxBytes),
  };
}

export interface StorageOverviewSnapshot {
  config: RedactedGlobalStorageConfig;
  usage: WorkspaceStorageUsageSummary[];
}

export interface UseStorageOverviewOptions {
  enabled?: boolean;
  initialData?: StorageOverviewSnapshot | null;
}

export function maintainActionKey(params: StorageMaintainParams): string {
  return `${params.workspaceId ?? "all"}:${params.action}`;
}

/**
 * Unified hook managing global storage configuration, workspace media usage breakdown,
 * `"storage"` RPC event subscriptions, connectivity probing, maintenance, and segment pinning.
 */
export function useStorageOverview(options?: UseStorageOverviewOptions) {
  const enabled = options?.enabled !== false;
  const [snapshot, setSnapshot] = useState<StorageOverviewSnapshot | null>(
    options?.initialData ?? null,
  );
  const [loading, setLoading] = useState<boolean>(enabled && !options?.initialData);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [maintainingKey, setMaintainingKey] = useState<string | null>(null);
  const [pinningAsset, setPinningAsset] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [lastMaintainResult, setLastMaintainResult] = useState<StorageMaintainResult | null>(null);

  const rpc = useOptionalLudensRpc();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;

  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  const overviewControllerRef = useRef<AbortController | null>(null);
  const mutationControllersRef = useRef(new Set<AbortController>());

  useEffect(() => {
    const controllers = mutationControllersRef.current;
    return () => {
      overviewControllerRef.current?.abort();
      for (const controller of controllers) {
        controller.abort();
      }
      controllers.clear();
    };
  }, []);

  const refresh = useCallback(async (): Promise<StorageOverviewSnapshot | null> => {
    if (!enabled) return null;
    const caller = rpcRef.current;
    if (!caller) {
      setLoading(false);
      setRefreshing(false);
      return snapshotRef.current;
    }

    overviewControllerRef.current?.abort();
    const controller = new AbortController();
    overviewControllerRef.current = controller;

    if (!snapshotRef.current) {
      setLoading(true);
    } else {
      setRefreshing(true);
    }
    setLoadError(null);

    try {
      const result = await caller.call("storage/get", {}, { signal: controller.signal });
      if (controller.signal.aborted || overviewControllerRef.current !== controller) {
        return snapshotRef.current;
      }
      const next: StorageOverviewSnapshot = {
        config: result.config,
        usage: result.usage,
      };
      setSnapshot(next);
      return next;
    } catch (error) {
      if ((error as { name?: string } | null)?.name === "AbortError" || controller.signal.aborted) {
        return snapshotRef.current;
      }
      if (overviewControllerRef.current === controller) {
        setLoadError(error instanceof Error ? error.message : String(error));
      }
      return snapshotRef.current;
    } finally {
      if (overviewControllerRef.current === controller) {
        overviewControllerRef.current = null;
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [enabled, Boolean(rpc), rpc?.reconnectGeneration ?? 0]);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      setRefreshing(false);
      return;
    }
    if (!rpcRef.current) {
      setLoading(false);
      return;
    }
    void refresh();
  }, [enabled, refresh]);

  useLudensEvent(
    ["storage", "workspace"],
    () => {
      void refresh();
    },
    { enabled },
  );

  const runMutation = useCallback(async <T,>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    mutationControllersRef.current.add(controller);
    try {
      return await fn(controller.signal);
    } finally {
      mutationControllersRef.current.delete(controller);
    }
  }, []);

  const updateStorage = useCallback(
    async (input: GlobalStorageUpdateInput): Promise<StorageOverviewSnapshot> => {
      const caller = rpcRef.current;
      if (!caller) {
        throw new Error("RPC client is unavailable");
      }
      setSaving(true);
      setActionError(null);
      try {
        const result = await runMutation(signal =>
          caller.call("storage/update", input, { signal }),
        );
        const next: StorageOverviewSnapshot = {
          config: result.config,
          usage: result.usage,
        };
        setSnapshot(next);
        return next;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setActionError(message);
        throw error;
      } finally {
        setSaving(false);
      }
    },
    [runMutation],
  );

  const testBackend = useCallback(
    async (params: StorageTestParams): Promise<StorageTestResult> => {
      const caller = rpcRef.current;
      if (!caller) {
        return {
          ok: false,
          latencyMs: 0,
          error: "RPC client is unavailable",
        };
      }
      setTesting(true);
      try {
        return await runMutation(signal => caller.call("storage/test", params, { signal }));
      } catch (error) {
        return {
          ok: false,
          latencyMs: 0,
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        setTesting(false);
      }
    },
    [runMutation],
  );

  const maintainStorage = useCallback(
    async (params: StorageMaintainParams): Promise<StorageMaintainResult> => {
      const caller = rpcRef.current;
      if (!caller) {
        throw new Error("RPC client is unavailable");
      }
      const key = maintainActionKey(params);
      setMaintainingKey(key);
      setActionError(null);
      try {
        const result = await runMutation(signal =>
          caller.call("storage/maintain", params, { signal }),
        );
        setLastMaintainResult(result);
        setSnapshot(prev =>
          prev
            ? { ...prev, usage: result.usage }
            : { config: fallbackGlobalStorageConfig(), usage: result.usage },
        );
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setActionError(message);
        throw error;
      } finally {
        setMaintainingKey(current => (current === key ? null : current));
      }
    },
    [runMutation],
  );

  const pinSegment = useCallback(
    async (params: StoragePinParams): Promise<StoragePinResult> => {
      const caller = rpcRef.current;
      if (!caller) {
        throw new Error("RPC client is unavailable");
      }
      const pinKey = `${params.workspaceId}:${params.asset}`;
      setPinningAsset(pinKey);
      setActionError(null);
      try {
        const result = await runMutation(signal => caller.call("storage/pin", params, { signal }));
        setSnapshot(prev => {
          if (!prev) return prev;
          return {
            ...prev,
            usage: prev.usage.map(item =>
              item.workspaceId === result.workspaceId
                ? { ...item, pinnedSegments: result.pins.length }
                : item,
            ),
          };
        });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setActionError(message);
        throw error;
      } finally {
        setPinningAsset(current => (current === pinKey ? null : current));
      }
    },
    [runMutation],
  );

  const clearError = useCallback(() => {
    setLoadError(null);
    setActionError(null);
  }, []);

  const clearMaintainResult = useCallback(() => {
    setLastMaintainResult(null);
  }, []);

  const usage = snapshot?.usage ?? [];
  const totals = useMemo(() => aggregateStorageFootprint(usage), [usage]);

  return {
    snapshot,
    config: snapshot?.config ?? null,
    usage,
    totals,
    loading,
    refreshing,
    saving,
    testing,
    maintainingKey,
    pinningAsset,
    loadError,
    actionError,
    lastMaintainResult,
    refresh,
    updateStorage,
    testBackend,
    maintainStorage,
    pinSegment,
    clearError,
    clearMaintainResult,
  };
}
