import type { MediaResolveParams } from "@ludens/protocol/app-rpc";
import {
  resolveConnectionEndpoints,
  type ConnectionEnv,
  type ConnectionTarget,
} from "./connection-target";

export type MediaRef = string | MediaResolveParams;

const PASSTHROUGH_PROTOCOLS = new Set(["data:", "blob:", "ludens-media:", "http:", "https:"]);
const SAFE_RELATIVE_PREFIX = "/media";

function buildMediaQueryPath(params: MediaResolveParams): string {
  const search = new URLSearchParams();
  if (params.kind === "asset") {
    search.set("kind", "asset");
    search.set("project", params.project);
    search.set("run", params.run);
    search.set("id", params.id);
    return `/media?${search.toString()}`;
  }

  search.set("kind", "replay");
  search.set("project", params.project);
  search.set("run", params.run);
  if (params.epoch !== undefined) search.set("epoch", String(params.epoch));
  search.set("mode", params.mode);
  if (params.record !== undefined) search.set("record", String(params.record));
  if (params.sequence !== undefined) search.set("sequence", String(params.sequence));
  if (params.media !== undefined) search.set("media", String(params.media));
  if (params.asset) search.set("asset", params.asset);
  if (params.bytes !== undefined) search.set("bytes", String(params.bytes));
  if (params.id) search.set("id", params.id);
  return `/media?${search.toString()}`;
}

function appendTicketIfMissing(pathWithQuery: string, ticket: string): string {
  const [pathname, query = ""] = pathWithQuery.split("?", 2);
  const search = new URLSearchParams(query);
  if (!search.has("mt")) {
    search.set("mt", ticket);
  }
  const serialized = search.toString();
  return serialized ? `${pathname}?${serialized}` : pathname;
}

function isSafePassthroughUrl(raw: string): boolean {
  const schemeMatch = raw.match(/^([a-zA-Z][a-zA-Z\d+.-]*):/);
  if (!schemeMatch) return false;
  const scheme = `${schemeMatch[1]!.toLowerCase()}:`;
  return PASSTHROUGH_PROTOCOLS.has(scheme);
}

/**
 * Resolves either a structured `MediaResolveParams` descriptor or a relative `/media?...` path
 * into a runnable URL for the active `ConnectionTarget`:
 * - `electron-local` -> `ludens-media://local/media?...` (no `mt=`)
 * - `same-origin` / `remote` -> `${mediaBaseUrl}/media?...` (appends `mt=` when ticket present)
 * - Existing `data:`, `blob:`, `ludens-media:`, `http:`, `https:` URLs pass through unchanged.
 */
export function resolveMediaUrl(
  ref: MediaRef | null | undefined,
  target: ConnectionTarget,
  mediaTicket?: string,
  env?: ConnectionEnv,
): string | undefined {
  if (!ref) return undefined;

  let relativePath: string;
  if (typeof ref === "string") {
    const trimmed = ref.trim();
    if (!trimmed) return undefined;

    if (isSafePassthroughUrl(trimmed)) {
      return trimmed;
    }

    if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed) || trimmed.startsWith("//")) {
      return undefined;
    }

    if (!trimmed.startsWith(SAFE_RELATIVE_PREFIX)) {
      return undefined;
    }
    const suffix = trimmed.slice(SAFE_RELATIVE_PREFIX.length);
    if (suffix && !suffix.startsWith("?") && !suffix.startsWith("/")) {
      return undefined;
    }
    relativePath = trimmed;
  } else {
    relativePath = buildMediaQueryPath(ref);
  }

  if (target.kind === "electron-local") {
    return `ludens-media://local${relativePath}`;
  }

  const endpoints = resolveConnectionEndpoints(target, env);
  if (!endpoints.ok) {
    return undefined;
  }

  const pathWithTicket = mediaTicket ? appendTicketIfMissing(relativePath, mediaTicket) : relativePath;
  return `${endpoints.mediaBaseUrl}${pathWithTicket}`;
}

export interface MediaResolver {
  readonly resolve: (ref: MediaRef | null | undefined) => string | undefined;
}

export function createMediaResolver(
  target: ConnectionTarget,
  mediaTicket?: string,
  env?: ConnectionEnv,
): MediaResolver {
  return {
    resolve: (ref) => resolveMediaUrl(ref, target, mediaTicket, env),
  };
}
