/** Pluggable multi-backend timeline media storage contracts, validation, and locked `~/.ludens/storage.json` state. */
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { atomicJson, ludensHome, readWorkspaceIdentity, withStateLock } from "./ludens";

export const STORAGE_BACKEND_KINDS = ["ephemeral", "local", "directory", "s3"] as const;
export type StorageBackendKind = (typeof STORAGE_BACKEND_KINDS)[number];

export const VIDEO_QUALITY_PRESETS = ["high", "balanced", "compact"] as const;
export type VideoQualityPreset = (typeof VIDEO_QUALITY_PRESETS)[number];

export interface VideoQualitySpec {
  readonly crf: number;
  readonly maxLongEdge: number | null;
  readonly recommendedMaxBytes: number;
}

export const VIDEO_QUALITY_SPECS: Readonly<Record<VideoQualityPreset, VideoQualitySpec>> = {
  compact: {
    crf: 28,
    maxLongEdge: 720,
    recommendedMaxBytes: 5 * 1024 * 1024 * 1024, // 5 GiB
  },
  balanced: {
    crf: 23,
    maxLongEdge: 1080,
    recommendedMaxBytes: 20 * 1024 * 1024 * 1024, // 20 GiB
  },
  high: {
    crf: 18,
    maxLongEdge: null,
    recommendedMaxBytes: 50 * 1024 * 1024 * 1024, // 50 GiB
  },
};

export const WORKSPACE_STORAGE_MODES = ["inherit", "ephemeral", "local", "profile"] as const;
export type WorkspaceStorageMode = (typeof WORKSPACE_STORAGE_MODES)[number];

export const DEFAULT_LOCAL_MAX_BYTES = 20 * 1024 * 1024 * 1024; // 20 GiB
export const DEFAULT_LOCAL_CACHE_BYTES = 4 * 1024 * 1024 * 1024; // 4 GiB
export const BUILTIN_LOCAL_PROFILE_ID = "local-default";
export const SECRET_MASK = "••••••••";

export interface DirectoryBackendConfig {
  path: string;
}

export interface S3BackendConfig {
  endpoint: string;
  region: string;
  bucket: string;
  prefix?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
}

export interface RedactedS3BackendConfig {
  endpoint: string;
  region: string;
  bucket: string;
  prefix?: string;
  accessKeyId: string;
  hasSecretAccessKey: boolean;
  forcePathStyle?: boolean;
}

export interface StorageProfile {
  id: string;
  name: string;
  kind: StorageBackendKind;
  maxBytes?: number | null;
  maxAgeHours?: number | null;
  localCacheBytes?: number | null;
  directory?: DirectoryBackendConfig;
  s3?: S3BackendConfig;
}

export interface RedactedStorageProfile extends Omit<StorageProfile, "s3"> {
  s3?: RedactedS3BackendConfig;
}

export interface GlobalStorageConfig {
  version: 1;
  defaultProfileId: string;
  videoQuality: VideoQualityPreset;
  protectReferenced: boolean;
  profiles: StorageProfile[];
}

export interface RedactedGlobalStorageConfig extends Omit<GlobalStorageConfig, "profiles"> {
  profiles: RedactedStorageProfile[];
}

export interface StorageProfileInput extends Omit<StorageProfile, "s3"> {
  s3?: Omit<S3BackendConfig, "secretAccessKey"> & {
    /** Omit or pass empty/SECRET_MASK when editing an existing profile to keep saved secretAccessKey. */
    secretAccessKey?: string;
  };
}

export interface GlobalStorageUpdateInput {
  defaultProfileId?: string;
  videoQuality?: VideoQualityPreset;
  protectReferenced?: boolean;
  profiles?: StorageProfileInput[];
}

export interface WorkspaceStorageOverride {
  mode: WorkspaceStorageMode;
  profileId?: string;
  maxBytes?: number | null;
  maxAgeHours?: number | null;
  localCacheBytes?: number | null;
  videoQuality?: VideoQualityPreset;
}

export interface EffectiveWorkspaceStorage {
  workspaceId: string;
  workspacePath: string;
  overrideMode: WorkspaceStorageMode;
  profileId: string | null;
  profileName: string;
  kind: StorageBackendKind;
  videoQuality: VideoQualityPreset;
  crf: number;
  maxLongEdge: number | null;
  protectReferenced: boolean;
  maxBytes: number | null;
  maxAgeHours: number | null;
  localCacheBytes: number;
  directory?: DirectoryBackendConfig;
  s3?: S3BackendConfig;
}

export interface TimelineArchiveLocation {
  backend: "directory" | "s3";
  profileId: string;
  key: string;
  bytes: number;
  archivedAt: string;
}

export interface WorkspaceStorageUsageSummary {
  workspaceId: string;
  workspaceName: string;
  workspacePath: string;
  available: boolean;
  effectiveKind: StorageBackendKind;
  effectiveProfileId: string | null;
  effectiveProfileName: string;
  maxBytes: number | null;
  localVideoBytes: number;
  localVideoSegments: number;
  localCacheBytes: number;
  localObjectsBytes: number;
  segmentsIndexBytes: number;
  logsBytes: number;
  totalLocalBytes: number;
  archivedSegments: number;
  archivedBytes: number;
  evictedSegments: number;
  pinnedSegments: number;
}

export interface StorageMaintainParams {
  action: "prune" | "sync" | "clear_cache";
  workspaceId?: string;
}

export interface StorageMaintainResult {
  ok: true;
  action: "prune" | "sync" | "clear_cache";
  freedBytes: number;
  archivedCount: number;
  evictedCount: number;
  errors: Array<{ workspaceId: string; error: string }>;
  usage: WorkspaceStorageUsageSummary[];
}

export interface StorageTestParams {
  kind: "directory" | "s3";
  profileId?: string;
  directory?: DirectoryBackendConfig;
  s3?: StorageProfileInput["s3"];
}

export interface StorageTestResult {
  ok: boolean;
  latencyMs: number;
  detail?: string;
  error?: string;
}

export interface StoragePinParams {
  workspaceId: string;
  asset: string;
  pinned: boolean;
}

export interface StoragePinResult {
  ok: true;
  workspaceId: string;
  pins: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function validStorageProfileId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(id);
}

export function isStorageBackendKind(value: unknown): value is StorageBackendKind {
  return typeof value === "string" && (STORAGE_BACKEND_KINDS as readonly string[]).includes(value);
}

export function isVideoQualityPreset(value: unknown): value is VideoQualityPreset {
  return typeof value === "string" && (VIDEO_QUALITY_PRESETS as readonly string[]).includes(value);
}

export function isWorkspaceStorageMode(value: unknown): value is WorkspaceStorageMode {
  return typeof value === "string" && (WORKSPACE_STORAGE_MODES as readonly string[]).includes(value);
}

export function resolveVideoQualitySpec(quality: VideoQualityPreset): VideoQualitySpec {
  if (!isVideoQualityPreset(quality)) {
    throw new Error(`Invalid video quality preset: ${String(quality)}`);
  }
  return VIDEO_QUALITY_SPECS[quality];
}

export function crfForVideoQuality(quality: VideoQualityPreset): number {
  return resolveVideoQualitySpec(quality).crf;
}

export function maxLongEdgeForVideoQuality(quality: VideoQualityPreset): number | null {
  return resolveVideoQualitySpec(quality).maxLongEdge;
}

export function recommendedMaxBytesForVideoQuality(quality: VideoQualityPreset): number {
  return resolveVideoQualitySpec(quality).recommendedMaxBytes;
}

function builtinLocalProfile(): StorageProfile {
  return {
    id: BUILTIN_LOCAL_PROFILE_ID,
    name: "Local Disk (Default)",
    kind: "local",
    maxBytes: DEFAULT_LOCAL_MAX_BYTES,
    maxAgeHours: null,
  };
}

export function defaultGlobalStorageConfig(): GlobalStorageConfig {
  return {
    version: 1,
    defaultProfileId: BUILTIN_LOCAL_PROFILE_ID,
    videoQuality: "balanced",
    protectReferenced: true,
    profiles: [builtinLocalProfile()],
  };
}

function validateOptionalByteLimit(value: unknown, field: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a positive number of bytes or null`);
  }
  const rounded = Math.round(value);
  if (!Number.isSafeInteger(rounded) || rounded <= 0) {
    throw new Error(`${field} exceeds safe integer byte range`);
  }
  return rounded;
}

function validateOptionalAgeHours(value: unknown, field: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a positive number of hours or null`);
  }
  return value;
}

export function validateDirectoryBackendConfig(value: unknown, field = "directory"): DirectoryBackendConfig {
  if (!isObject(value) || typeof value.path !== "string" || !value.path.trim()) {
    throw new Error(`${field}.path must be a non-empty absolute directory path`);
  }
  const trimmed = value.path.trim();
  if (!isAbsolute(trimmed)) {
    throw new Error(`${field}.path must be an absolute directory path`);
  }
  return { path: resolve(trimmed) };
}

export function validateS3BackendConfig(value: unknown, field = "s3"): S3BackendConfig {
  if (!isObject(value)) {
    throw new Error(`${field} must be an object`);
  }
  if (typeof value.endpoint !== "string" || !value.endpoint.trim()) {
    throw new Error(`${field}.endpoint must be a non-empty http:// or https:// URL`);
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(value.endpoint.trim());
  } catch {
    throw new Error(`${field}.endpoint must be a valid URL`);
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error(`${field}.endpoint must use http:// or https://`);
  }
  const endpoint = value.endpoint.trim().replace(/\/+$/, "");

  if (typeof value.region !== "string" || !value.region.trim()) {
    throw new Error(`${field}.region must be a non-empty string`);
  }
  const region = value.region.trim();

  if (typeof value.bucket !== "string" || !value.bucket.trim() || value.bucket.includes("/")) {
    throw new Error(`${field}.bucket must be a non-empty bucket name without slashes`);
  }
  const bucket = value.bucket.trim();

  let prefix: string | undefined;
  if (value.prefix !== undefined && value.prefix !== null && value.prefix !== "") {
    if (typeof value.prefix !== "string") {
      throw new Error(`${field}.prefix must be a string`);
    }
    const cleaned = value.prefix.trim().replace(/^\/+|\/+$/g, "");
    if (cleaned) prefix = cleaned;
  }

  if (typeof value.accessKeyId !== "string" || !value.accessKeyId.trim()) {
    throw new Error(`${field}.accessKeyId must be a non-empty string`);
  }
  const accessKeyId = value.accessKeyId.trim();

  if (typeof value.secretAccessKey !== "string" || !value.secretAccessKey || value.secretAccessKey === SECRET_MASK) {
    throw new Error(`${field}.secretAccessKey must be a non-empty secret string`);
  }
  const secretAccessKey = value.secretAccessKey;

  let forcePathStyle: boolean | undefined;
  if (value.forcePathStyle !== undefined) {
    if (typeof value.forcePathStyle !== "boolean") {
      throw new Error(`${field}.forcePathStyle must be boolean`);
    }
    forcePathStyle = value.forcePathStyle;
  }

  return {
    endpoint,
    region,
    bucket,
    ...(prefix ? { prefix } : {}),
    accessKeyId,
    secretAccessKey,
    ...(forcePathStyle !== undefined ? { forcePathStyle } : {}),
  };
}

function validateStorageProfile(value: unknown, field = "profile"): StorageProfile {
  if (!isObject(value)) throw new Error(`${field} must be an object`);
  if (!validStorageProfileId(value.id)) {
    throw new Error(`${field}.id must be 1–96 alphanumeric/dash/underscore characters`);
  }
  if (typeof value.name !== "string" || !value.name.trim()) {
    throw new Error(`${field}.name must be a non-empty string`);
  }
  if (!isStorageBackendKind(value.kind)) {
    throw new Error(`${field}.kind must be one of: ${STORAGE_BACKEND_KINDS.join(", ")}`);
  }
  if (value.id === BUILTIN_LOCAL_PROFILE_ID && value.kind !== "local") {
    throw new Error(`Built-in profile "${BUILTIN_LOCAL_PROFILE_ID}" must have kind "local"`);
  }

  const maxBytes = validateOptionalByteLimit(value.maxBytes, `${field}.maxBytes`);
  const maxAgeHours = validateOptionalAgeHours(value.maxAgeHours, `${field}.maxAgeHours`);
  const localCacheBytes = validateOptionalByteLimit(value.localCacheBytes, `${field}.localCacheBytes`);

  const profile: StorageProfile = {
    id: value.id,
    name: value.name.trim(),
    kind: value.kind,
  };

  if (value.kind === "ephemeral") {
    profile.maxBytes = null;
    profile.maxAgeHours = null;
  } else {
    if (maxBytes !== undefined) {
      profile.maxBytes = maxBytes;
    } else if (value.kind === "local") {
      profile.maxBytes = DEFAULT_LOCAL_MAX_BYTES;
    } else {
      profile.maxBytes = null;
    }
    profile.maxAgeHours = maxAgeHours ?? null;
  }

  if (value.kind === "directory" || value.kind === "s3") {
    if (localCacheBytes !== undefined) {
      profile.localCacheBytes = localCacheBytes;
    }
  } else if (localCacheBytes !== undefined) {
    profile.localCacheBytes = localCacheBytes;
  }

  if (value.kind === "directory") {
    profile.directory = validateDirectoryBackendConfig(value.directory, `${field}.directory`);
  } else if (value.kind === "s3") {
    profile.s3 = validateS3BackendConfig(value.s3, `${field}.s3`);
  }

  return profile;
}

export function validateGlobalStorageConfig(value: unknown): GlobalStorageConfig {
  if (!isObject(value) || value.version !== 1) {
    throw new Error("storage.json must contain version: 1");
  }
  const unknownKeys = Object.keys(value).filter(
    key => !["version", "defaultProfileId", "videoQuality", "protectReferenced", "profiles"].includes(key),
  );
  if (unknownKeys.length > 0) {
    throw new Error(`Unknown global storage config keys: ${unknownKeys.join(", ")}`);
  }

  const videoQuality: VideoQualityPreset =
    value.videoQuality === undefined ? "balanced" : isVideoQualityPreset(value.videoQuality) ? value.videoQuality : (() => {
      throw new Error(`videoQuality must be one of: ${VIDEO_QUALITY_PRESETS.join(", ")}`);
    })();

  if (value.protectReferenced !== undefined && typeof value.protectReferenced !== "boolean") {
    throw new Error("protectReferenced must be boolean");
  }
  const protectReferenced = value.protectReferenced ?? true;

  if (!Array.isArray(value.profiles)) {
    throw new Error("profiles must be an array");
  }

  const seenIds = new Set<string>();
  const profiles: StorageProfile[] = [];
  for (let i = 0; i < value.profiles.length; i++) {
    const validated = validateStorageProfile(value.profiles[i], `profiles[${i}]`);
    if (seenIds.has(validated.id)) {
      throw new Error(`Duplicate storage profile ID: ${validated.id}`);
    }
    seenIds.add(validated.id);
    profiles.push(validated);
  }

  if (!seenIds.has(BUILTIN_LOCAL_PROFILE_ID)) {
    profiles.unshift(builtinLocalProfile());
    seenIds.add(BUILTIN_LOCAL_PROFILE_ID);
  }

  const defaultProfileId =
    typeof value.defaultProfileId === "string" && value.defaultProfileId.trim()
      ? value.defaultProfileId.trim()
      : BUILTIN_LOCAL_PROFILE_ID;

  if (!seenIds.has(defaultProfileId)) {
    throw new Error(`defaultProfileId "${defaultProfileId}" does not match any storage profile`);
  }

  return {
    version: 1,
    defaultProfileId,
    videoQuality,
    protectReferenced,
    profiles,
  };
}

export function validateWorkspaceStorageOverride(
  value: unknown,
  field = "storage",
): WorkspaceStorageOverride {
  if (!isObject(value)) {
    throw new Error(`${field} must be an object`);
  }
  const allowedKeys = new Set([
    "mode",
    "profileId",
    "maxBytes",
    "maxAgeHours",
    "localCacheBytes",
    "videoQuality",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`${field}.${key} is not allowed in workspace storage override`);
    }
  }

  if (!isWorkspaceStorageMode(value.mode)) {
    throw new Error(`${field}.mode must be one of: ${WORKSPACE_STORAGE_MODES.join(", ")}`);
  }

  const result: WorkspaceStorageOverride = { mode: value.mode };

  if (value.mode === "profile") {
    if (!validStorageProfileId(value.profileId)) {
      throw new Error(`${field}.profileId is required when mode is "profile"`);
    }
    result.profileId = value.profileId;
  } else if (value.profileId !== undefined && value.profileId !== null && value.profileId !== "") {
    if (!validStorageProfileId(value.profileId)) {
      throw new Error(`${field}.profileId must be a valid profile ID`);
    }
    result.profileId = value.profileId;
  }

  const maxBytes = validateOptionalByteLimit(value.maxBytes, `${field}.maxBytes`);
  if (maxBytes !== undefined) result.maxBytes = maxBytes;

  const maxAgeHours = validateOptionalAgeHours(value.maxAgeHours, `${field}.maxAgeHours`);
  if (maxAgeHours !== undefined) result.maxAgeHours = maxAgeHours;

  const localCacheBytes = validateOptionalByteLimit(value.localCacheBytes, `${field}.localCacheBytes`);
  if (localCacheBytes !== undefined) result.localCacheBytes = localCacheBytes;

  if (value.videoQuality !== undefined && value.videoQuality !== null && value.videoQuality !== "") {
    if (!isVideoQualityPreset(value.videoQuality)) {
      throw new Error(`${field}.videoQuality must be one of: ${VIDEO_QUALITY_PRESETS.join(", ")}`);
    }
    result.videoQuality = value.videoQuality;
  }

  return result;
}

export function redactGlobalStorageConfig(config: GlobalStorageConfig): RedactedGlobalStorageConfig {
  return {
    version: config.version,
    defaultProfileId: config.defaultProfileId,
    videoQuality: config.videoQuality,
    protectReferenced: config.protectReferenced,
    profiles: config.profiles.map((profile): RedactedStorageProfile => {
      const { s3, ...rest } = profile;
      if (!s3) return { ...rest };
      return {
        ...rest,
        s3: {
          endpoint: s3.endpoint,
          region: s3.region,
          bucket: s3.bucket,
          ...(s3.prefix ? { prefix: s3.prefix } : {}),
          accessKeyId: s3.accessKeyId,
          hasSecretAccessKey: Boolean(s3.secretAccessKey),
          ...(s3.forcePathStyle !== undefined ? { forcePathStyle: s3.forcePathStyle } : {}),
        },
      };
    }),
  };
}

export function isMaskedOrEmptySecret(secret: unknown): boolean {
  return secret === undefined || secret === null || secret === "" || secret === SECRET_MASK;
}

export function mergeGlobalStorageUpdate(
  current: GlobalStorageConfig,
  input: GlobalStorageUpdateInput,
): GlobalStorageConfig {
  if (!isObject(input)) {
    throw new Error("Storage update input must be an object");
  }
  const existingById = new Map(current.profiles.map(profile => [profile.id, profile]));

  let nextProfiles: unknown[];
  if (input.profiles !== undefined) {
    if (!Array.isArray(input.profiles)) {
      throw new Error("profiles must be an array");
    }
    nextProfiles = input.profiles.map((item, idx) => {
      if (!isObject(item)) {
        throw new Error(`profiles[${idx}] must be an object`);
      }
      if (item.kind === "s3" && isObject(item.s3)) {
        const rawSecret = item.s3.secretAccessKey;
        if (isMaskedOrEmptySecret(rawSecret)) {
          const prior = typeof item.id === "string" ? existingById.get(item.id) : undefined;
          const preserved = prior?.s3?.secretAccessKey;
          if (!preserved) {
            throw new Error(`profiles[${idx}].s3.secretAccessKey is required for S3 profile "${String(item.id ?? "")}"`);
          }
          return {
            ...item,
            s3: {
              ...item.s3,
              secretAccessKey: preserved,
            },
          };
        }
      }
      return item;
    });

    const hasBuiltin = nextProfiles.some(
      item => isObject(item) && item.id === BUILTIN_LOCAL_PROFILE_ID,
    );
    if (!hasBuiltin) {
      const existingBuiltin = existingById.get(BUILTIN_LOCAL_PROFILE_ID) ?? builtinLocalProfile();
      nextProfiles.unshift(existingBuiltin);
    }
  } else {
    nextProfiles = current.profiles;
  }

  return validateGlobalStorageConfig({
    version: 1,
    defaultProfileId: input.defaultProfileId ?? current.defaultProfileId,
    videoQuality: input.videoQuality ?? current.videoQuality,
    protectReferenced: input.protectReferenced ?? current.protectReferenced,
    profiles: nextProfiles,
  });
}

export async function readGlobalStorageConfig(home = ludensHome()): Promise<GlobalStorageConfig> {
  try {
    const raw = await readFile(join(home, "storage.json"), "utf8");
    return validateGlobalStorageConfig(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return defaultGlobalStorageConfig();
    }
    throw error;
  }
}

export async function writeGlobalStorageConfig(
  config: GlobalStorageConfig,
  home = ludensHome(),
): Promise<GlobalStorageConfig> {
  const validated = validateGlobalStorageConfig(config);
  return withStateLock(join(home, "storage.json.lock"), async () => {
    await atomicJson(join(home, "storage.json"), validated);
    return validated;
  });
}

export async function updateGlobalStorageConfig(
  updater: (current: GlobalStorageConfig) => GlobalStorageConfig | Promise<GlobalStorageConfig>,
  home = ludensHome(),
): Promise<GlobalStorageConfig> {
  return withStateLock(join(home, "storage.json.lock"), async () => {
    const current = await readGlobalStorageConfig(home);
    const validated = validateGlobalStorageConfig(await updater(current));
    await atomicJson(join(home, "storage.json"), validated);
    return validated;
  });
}

async function readWorkspaceOverrideFromLudensJson(workspacePath: string): Promise<WorkspaceStorageOverride> {
  try {
    const raw = await readFile(join(workspacePath, "ludens.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (isObject(parsed) && parsed.storage !== undefined && parsed.storage !== null) {
      return validateWorkspaceStorageOverride(parsed.storage, "ludens.json.storage");
    }
    return { mode: "inherit" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { mode: "inherit" };
    }
    throw error;
  }
}

async function resolveWorkspaceIdOrBasename(workspacePath: string): Promise<string> {
  try {
    const identity = await readWorkspaceIdentity(workspacePath);
    return identity.id;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return basename(workspacePath) || "workspace";
    }
    throw error;
  }
}

function resolveEffectiveCrf(quality: VideoQualityPreset): number {
  const envCrf = process.env.LUDENS_VIDEO_CRF?.trim();
  if (envCrf) {
    const parsed = Number(envCrf);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 51) {
      return parsed;
    }
  }
  return crfForVideoQuality(quality);
}

export async function resolveEffectiveWorkspaceStorage(
  workspacePath: string,
  home = ludensHome(),
): Promise<EffectiveWorkspaceStorage> {
  const resolvedPath = resolve(workspacePath);
  const [workspaceId, override, globalConfig] = await Promise.all([
    resolveWorkspaceIdOrBasename(resolvedPath),
    readWorkspaceOverrideFromLudensJson(resolvedPath),
    readGlobalStorageConfig(home),
  ]);

  const videoQuality = override.videoQuality ?? globalConfig.videoQuality;
  const crf = resolveEffectiveCrf(videoQuality);
  const maxLongEdge = resolveVideoQualitySpec(videoQuality).maxLongEdge;
  const protectReferenced = globalConfig.protectReferenced;

  const persistEnv = process.env.LUDENS_PERCEPTION_PERSIST?.trim().toLowerCase();
  if (persistEnv === "0" || persistEnv === "false") {
    return {
      workspaceId,
      workspacePath: resolvedPath,
      overrideMode: override.mode,
      profileId: null,
      profileName: "Ephemeral (LUDENS_PERCEPTION_PERSIST=0)",
      kind: "ephemeral",
      videoQuality,
      crf,
      maxLongEdge,
      protectReferenced,
      maxBytes: null,
      maxAgeHours: null,
      localCacheBytes: override.localCacheBytes ?? DEFAULT_LOCAL_CACHE_BYTES,
    };
  }

  if (override.mode === "ephemeral") {
    return {
      workspaceId,
      workspacePath: resolvedPath,
      overrideMode: "ephemeral",
      profileId: null,
      profileName: "Ephemeral",
      kind: "ephemeral",
      videoQuality,
      crf,
      maxLongEdge,
      protectReferenced,
      maxBytes: null,
      maxAgeHours: null,
      localCacheBytes: override.localCacheBytes ?? DEFAULT_LOCAL_CACHE_BYTES,
    };
  }

  if (override.mode === "local") {
    const builtin = globalConfig.profiles.find(p => p.id === BUILTIN_LOCAL_PROFILE_ID);
    const defaultMaxBytes = builtin?.maxBytes !== undefined ? builtin.maxBytes : DEFAULT_LOCAL_MAX_BYTES;
    const defaultMaxAgeHours = builtin?.maxAgeHours ?? null;
    return {
      workspaceId,
      workspacePath: resolvedPath,
      overrideMode: "local",
      profileId: null,
      profileName: "Local Disk",
      kind: "local",
      videoQuality,
      crf,
      maxLongEdge,
      protectReferenced,
      maxBytes: override.maxBytes !== undefined ? override.maxBytes : defaultMaxBytes,
      maxAgeHours: override.maxAgeHours !== undefined ? override.maxAgeHours : defaultMaxAgeHours,
      localCacheBytes: override.localCacheBytes ?? DEFAULT_LOCAL_CACHE_BYTES,
    };
  }

  const defaultProfile =
    globalConfig.profiles.find(p => p.id === globalConfig.defaultProfileId) ??
    globalConfig.profiles[0] ??
    builtinLocalProfile();

  const selectedProfile =
    override.mode === "profile" && override.profileId
      ? (globalConfig.profiles.find(p => p.id === override.profileId) ?? defaultProfile)
      : defaultProfile;

  const kind = selectedProfile.kind;
  const maxBytes =
    kind === "ephemeral"
      ? null
      : override.maxBytes !== undefined
        ? override.maxBytes
        : selectedProfile.maxBytes !== undefined
          ? selectedProfile.maxBytes
          : kind === "local"
            ? DEFAULT_LOCAL_MAX_BYTES
            : null;

  const maxAgeHours =
    kind === "ephemeral"
      ? null
      : override.maxAgeHours !== undefined
        ? override.maxAgeHours
        : (selectedProfile.maxAgeHours ?? null);

  const localCacheBytes =
    override.localCacheBytes ?? selectedProfile.localCacheBytes ?? DEFAULT_LOCAL_CACHE_BYTES;

  return {
    workspaceId,
    workspacePath: resolvedPath,
    overrideMode: override.mode,
    profileId: selectedProfile.id,
    profileName: selectedProfile.name,
    kind,
    videoQuality,
    crf,
    maxLongEdge,
    protectReferenced,
    maxBytes,
    maxAgeHours,
    localCacheBytes,
    ...(kind === "directory" && selectedProfile.directory
      ? { directory: { ...selectedProfile.directory } }
      : {}),
    ...(kind === "s3" && selectedProfile.s3
      ? { s3: { ...selectedProfile.s3 } }
      : {}),
  };
}

const PIN_ASSET_PATTERN = /^(?:window-[A-Za-z0-9_-]+\/)?(?:video\/[A-Za-z0-9._-]+\.mp4|objects\/[A-Za-z0-9._-]+\.bin)$/;

export function validTimelinePinAsset(asset: unknown): asset is string {
  if (typeof asset !== "string" || !PIN_ASSET_PATTERN.test(asset)) return false;
  return !asset.split("/").some(part => part === "." || part === "..");
}

function validatePinsList(items: unknown, field = "pins.assets"): string[] {
  if (!Array.isArray(items)) {
    throw new Error(`${field} must be an array of timeline asset paths`);
  }
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!validTimelinePinAsset(item)) {
      throw new Error(`Invalid timeline pin asset: ${String(item)}`);
    }
    if (!seen.has(item)) {
      seen.add(item);
      deduped.push(item);
    }
  }
  return deduped;
}

export async function readTimelinePins(timelineRoot: string): Promise<string[]> {
  const path = join(resolve(timelineRoot), "pins.json");
  try {
    const raw = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed) || parsed.version !== 1) {
      throw new Error("pins.json must contain version: 1 and assets array");
    }
    return validatePinsList(parsed.assets, "pins.json.assets");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function writeTimelinePins(timelineRoot: string, pins: string[]): Promise<string[]> {
  const root = resolve(timelineRoot);
  const validated = validatePinsList(pins, "pins");
  return withStateLock(join(root, "pins.json.lock"), async () => {
    await atomicJson(join(root, "pins.json"), { version: 1, assets: validated });
    return validated;
  });
}
