export const OPENAI_WEBSOCKETS_MODES = ["auto", "on", "off"] as const;
export type OpenaiWebsocketsMode = (typeof OPENAI_WEBSOCKETS_MODES)[number];

export const CACHE_RETENTION_MODES = ["auto", "short", "long", "none"] as const;
export type CacheRetentionMode = (typeof CACHE_RETENTION_MODES)[number];

export const APPEND_ONLY_CONTEXT_MODES = ["auto", "on", "off"] as const;
export type AppendOnlyContextMode = (typeof APPEND_ONLY_CONTEXT_MODES)[number];

export const IMAGE_URL_BACKENDS = [
  "provider-files",
  "cloudflared",
  "tailscale",
  "uguu",
  "tmpfiles",
  "litterbox",
  "0x0",
  "catbox",
  "pinggy",
  "localhost-run",
] as const;
export type ImageUrlBackend = (typeof IMAGE_URL_BACKENDS)[number];

export const DEFAULT_IMAGE_URL_BACKENDS: readonly ImageUrlBackend[] = [
  "provider-files",
  "cloudflared",
  "tailscale",
  "uguu",
  "tmpfiles",
  "litterbox",
  "0x0",
  "catbox",
];

export interface ImageUrlsConfig {
  enabled?: boolean;
  backends?: ImageUrlBackend[];
}

export interface ModelConnectionConfig {
  openaiWebsockets?: OpenaiWebsocketsMode;
  cacheRetention?: CacheRetentionMode;
  appendOnlyContext?: AppendOnlyContextMode;
  imageUrls?: ImageUrlsConfig;
}

export function validateConnectionConfig(input: unknown, prefix = "connection"): ModelConnectionConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${prefix} must be an object`);
  }
  const value = input as Record<string, unknown>;
  const allowedKeys = new Set(["openaiWebsockets", "cacheRetention", "appendOnlyContext", "imageUrls"]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new Error(`${prefix}.${key} is not supported`);
  }
  const result: ModelConnectionConfig = {};
  if (value.openaiWebsockets !== undefined) {
    if (
      typeof value.openaiWebsockets !== "string" ||
      !(OPENAI_WEBSOCKETS_MODES as readonly string[]).includes(value.openaiWebsockets)
    ) {
      throw new Error(`${prefix}.openaiWebsockets must be one of: ${OPENAI_WEBSOCKETS_MODES.join(", ")}`);
    }
    result.openaiWebsockets = value.openaiWebsockets as OpenaiWebsocketsMode;
  }
  if (value.cacheRetention !== undefined) {
    if (
      typeof value.cacheRetention !== "string" ||
      !(CACHE_RETENTION_MODES as readonly string[]).includes(value.cacheRetention)
    ) {
      throw new Error(`${prefix}.cacheRetention must be one of: ${CACHE_RETENTION_MODES.join(", ")}`);
    }
    result.cacheRetention = value.cacheRetention as CacheRetentionMode;
  }
  if (value.appendOnlyContext !== undefined) {
    if (
      typeof value.appendOnlyContext !== "string" ||
      !(APPEND_ONLY_CONTEXT_MODES as readonly string[]).includes(value.appendOnlyContext)
    ) {
      throw new Error(`${prefix}.appendOnlyContext must be one of: ${APPEND_ONLY_CONTEXT_MODES.join(", ")}`);
    }
    result.appendOnlyContext = value.appendOnlyContext as AppendOnlyContextMode;
  }
  if (value.imageUrls !== undefined) {
    if (!value.imageUrls || typeof value.imageUrls !== "object" || Array.isArray(value.imageUrls)) {
      throw new Error(`${prefix}.imageUrls must be an object`);
    }
    const imageUrls = value.imageUrls as Record<string, unknown>;
    for (const key of Object.keys(imageUrls)) {
      if (key !== "enabled" && key !== "backends") {
        throw new Error(`${prefix}.imageUrls.${key} is not supported`);
      }
    }
    const parsedImageUrls: ImageUrlsConfig = {};
    if (imageUrls.enabled !== undefined) {
      if (typeof imageUrls.enabled !== "boolean") {
        throw new Error(`${prefix}.imageUrls.enabled must be a boolean`);
      }
      parsedImageUrls.enabled = imageUrls.enabled;
    }
    if (imageUrls.backends !== undefined) {
      if (
        !Array.isArray(imageUrls.backends) ||
        imageUrls.backends.some(
          item => typeof item !== "string" || !(IMAGE_URL_BACKENDS as readonly string[]).includes(item),
        )
      ) {
        throw new Error(
          `${prefix}.imageUrls.backends must be an array of supported backends (${IMAGE_URL_BACKENDS.join(", ")})`,
        );
      }
      parsedImageUrls.backends = Array.from(new Set(imageUrls.backends as ImageUrlBackend[]));
    }
    if (Object.keys(parsedImageUrls).length > 0) {
      result.imageUrls = parsedImageUrls;
    }
  }
  return result;
}

export function mergeConnectionConfig(
  base?: ModelConnectionConfig,
  override?: ModelConnectionConfig,
): ModelConnectionConfig {
  const merged: ModelConnectionConfig = {};
  const openaiWebsockets = override?.openaiWebsockets ?? base?.openaiWebsockets;
  if (openaiWebsockets !== undefined) merged.openaiWebsockets = openaiWebsockets;
  const cacheRetention = override?.cacheRetention ?? base?.cacheRetention;
  if (cacheRetention !== undefined) merged.cacheRetention = cacheRetention;
  const appendOnlyContext = override?.appendOnlyContext ?? base?.appendOnlyContext;
  if (appendOnlyContext !== undefined) merged.appendOnlyContext = appendOnlyContext;
  const imageUrlsEnabled = override?.imageUrls?.enabled ?? base?.imageUrls?.enabled;
  const imageUrlsBackends = override?.imageUrls?.backends ?? base?.imageUrls?.backends;
  if (imageUrlsEnabled !== undefined || imageUrlsBackends !== undefined) {
    merged.imageUrls = {
      ...(imageUrlsEnabled !== undefined ? { enabled: imageUrlsEnabled } : {}),
      ...(imageUrlsBackends !== undefined ? { backends: [...imageUrlsBackends] } : {}),
    };
  }
  return merged;
}
