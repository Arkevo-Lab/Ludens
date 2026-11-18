/** Zero-dependency AWS Signature Version 4 (HMAC-SHA256) client for S3-compatible object storage. */
import { createHash, createHmac, randomUUID } from "node:crypto";
import type { S3BackendConfig } from "./storage";

export const EMPTY_PAYLOAD_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function sha256Hex(data: string | Uint8Array): string {
  const hash = createHash("sha256");
  if (typeof data === "string") {
    hash.update(data, "utf8");
  } else {
    hash.update(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  }
  return hash.digest("hex");
}

function hmacSha256(key: string | Buffer, message: string): Buffer {
  return createHmac("sha256", key).update(message, "utf8").digest();
}

function hmacSha256Hex(key: Buffer, message: string): string {
  return createHmac("sha256", key).update(message, "utf8").digest("hex");
}

export function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service = "s3",
): Buffer {
  const kDate = hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, "aws4_request");
}

export function formatAmzDate(now: Date = new Date()): { amzDate: string; dateStamp: string } {
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

function shouldUsePathStyle(endpointUrl: URL, bucket: string, forcePathStyle?: boolean): boolean {
  if (forcePathStyle) return true;
  if (bucket.includes(".")) return true;
  const host = endpointUrl.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (host.startsWith("[") || host.includes(":")) return true;
  if (!host.includes(".")) return true;
  return false;
}

export function joinS3Key(prefix: string | undefined, relativeKey: string): string {
  const cleanPrefix = prefix?.trim().replace(/^\/+|\/+$/g, "");
  const cleanKey = relativeKey.replace(/^\/+/, "");
  return cleanPrefix ? `${cleanPrefix}/${cleanKey}` : cleanKey;
}

function canonicalizeUriPath(pathname: string): string {
  if (!pathname || pathname === "/") return "/";
  const segments = pathname.split("/");
  return segments
    .map(segment => {
      try {
        return encodeRfc3986(decodeURIComponent(segment));
      } catch {
        return encodeRfc3986(segment);
      }
    })
    .join("/");
}

function canonicalQueryString(searchParams: URLSearchParams): string {
  const pairs: Array<[string, string]> = [];
  searchParams.forEach((value, key) => {
    pairs.push([encodeRfc3986(key), encodeRfc3986(value)]);
  });
  pairs.sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0,
  );
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

function normalizeHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function buildS3ObjectUrl(config: S3BackendConfig, key: string): URL {
  const base = new URL(config.endpoint);
  base.search = "";
  base.hash = "";

  const basePath = base.pathname.replace(/\/+$/, "");
  const cleanKey = key.replace(/^\/+/, "");
  const encodedKey = cleanKey
    ? cleanKey
        .split("/")
        .map(encodeRfc3986)
        .join("/")
    : "";

  const pathStyle = shouldUsePathStyle(base, config.bucket, config.forcePathStyle);
  if (pathStyle) {
    const encodedBucket = encodeRfc3986(config.bucket);
    base.pathname = `${basePath}/${encodedBucket}${encodedKey ? `/${encodedKey}` : ""}`;
  } else {
    if (!base.hostname.toLowerCase().startsWith(`${config.bucket.toLowerCase()}.`)) {
      base.hostname = `${config.bucket}.${base.hostname}`;
    }
    base.pathname = `${basePath}/${encodedKey}` || "/";
  }
  return base;
}

export function signS3Headers(params: {
  method: string;
  url: URL;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  headers?: Record<string, string>;
  payloadHash?: string;
  now?: Date;
}): Record<string, string> {
  const method = params.method.toUpperCase();
  const region = (params.region || "auto").trim();
  const payloadHash = params.payloadHash ?? EMPTY_PAYLOAD_SHA256;
  const { amzDate, dateStamp } = formatAmzDate(params.now);

  const headerMap = new Map<string, { name: string; values: string[] }>();
  if (params.headers) {
    for (const [rawName, rawValue] of Object.entries(params.headers)) {
      const lower = rawName.trim().toLowerCase();
      if (!lower || lower === "authorization") continue;
      const existing = headerMap.get(lower);
      if (existing) {
        existing.values.push(normalizeHeaderValue(rawValue));
      } else {
        headerMap.set(lower, { name: rawName.trim(), values: [normalizeHeaderValue(rawValue)] });
      }
    }
  }

  if (!headerMap.has("host")) {
    headerMap.set("host", { name: "host", values: [params.url.host] });
  }
  if (!headerMap.has("x-amz-date")) {
    headerMap.set("x-amz-date", { name: "x-amz-date", values: [amzDate] });
  }
  if (!headerMap.has("x-amz-content-sha256")) {
    headerMap.set("x-amz-content-sha256", { name: "x-amz-content-sha256", values: [payloadHash] });
  }

  const sortedNames = [...headerMap.keys()].sort();
  const canonicalHeaders = sortedNames
    .map(lower => `${lower}:${headerMap.get(lower)!.values.join(",")}\n`)
    .join("");
  const signedHeaders = sortedNames.join(";");

  const canonicalUri = canonicalizeUriPath(params.url.pathname);
  const canonicalQuery = canonicalQueryString(params.url.searchParams);
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = deriveSigningKey(params.secretAccessKey, dateStamp, region, "s3");
  const signature = hmacSha256Hex(signingKey, stringToSign);
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${params.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const output: Record<string, string> = {};
  for (const lower of sortedNames) {
    const entry = headerMap.get(lower)!;
    output[entry.name] = entry.values.join(",");
  }
  output.Authorization = authorization;
  return output;
}

export function presignS3Url(params: {
  method?: "GET" | "HEAD" | "PUT";
  config: S3BackendConfig;
  key: string;
  expiresSeconds?: number;
  now?: Date;
}): string {
  const method = (params.method ?? "GET").toUpperCase();
  const rawExpires = params.expiresSeconds ?? 3600;
  if (!Number.isFinite(rawExpires) || rawExpires <= 0) {
    throw new Error("expiresSeconds must be a positive number");
  }
  const expiresSeconds = Math.min(604_800, Math.max(1, Math.floor(rawExpires)));
  const region = (params.config.region || "auto").trim();
  const { amzDate, dateStamp } = formatAmzDate(params.now);
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;

  const url = buildS3ObjectUrl(params.config, params.key);
  url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  url.searchParams.set("X-Amz-Credential", `${params.config.accessKeyId}/${credentialScope}`);
  url.searchParams.set("X-Amz-Date", amzDate);
  url.searchParams.set("X-Amz-Expires", String(expiresSeconds));
  url.searchParams.set("X-Amz-SignedHeaders", "host");

  const canonicalUri = canonicalizeUriPath(url.pathname);
  const canonicalQuery = canonicalQueryString(url.searchParams);
  const canonicalHeaders = `host:${url.host}\n`;
  const signedHeaders = "host";

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    UNSIGNED_PAYLOAD,
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = deriveSigningKey(params.config.secretAccessKey, dateStamp, region, "s3");
  const signature = hmacSha256Hex(signingKey, stringToSign);

  return `${url.origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

async function readErrorSnippet(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.trim().slice(0, 512);
  } catch {
    return "";
  }
}

export async function s3PutBytes(
  config: S3BackendConfig,
  key: string,
  body: Uint8Array,
  contentType = "application/octet-stream",
  signal?: AbortSignal,
): Promise<void> {
  const url = buildS3ObjectUrl(config, key);
  const payload = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  const payloadHash = sha256Hex(payload);
  const headers = signS3Headers({
    method: "PUT",
    url,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    headers: {
      "content-type": contentType,
      "content-length": String(payload.byteLength),
    },
    payloadHash,
  });

  const bodyBytes = new Uint8Array(payload.byteLength);
  bodyBytes.set(payload);
  const response = await fetch(url, {
    method: "PUT",
    headers,
    body: bodyBytes,
    signal,
  });
  if (!response.ok) {
    const snippet = await readErrorSnippet(response);
    throw new Error(
      `S3 PUT failed (${response.status} ${response.statusText})${snippet ? `: ${snippet}` : ""}`,
    );
  }
}

export async function s3DeleteObject(
  config: S3BackendConfig,
  key: string,
  signal?: AbortSignal,
): Promise<void> {
  const url = buildS3ObjectUrl(config, key);
  const headers = signS3Headers({
    method: "DELETE",
    url,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  });
  const response = await fetch(url, {
    method: "DELETE",
    headers,
    signal,
  });
  if (!response.ok && response.status !== 404) {
    const snippet = await readErrorSnippet(response);
    throw new Error(
      `S3 DELETE failed (${response.status} ${response.statusText})${snippet ? `: ${snippet}` : ""}`,
    );
  }
}

export async function s3ProbeConnectivity(
  config: S3BackendConfig,
  signal?: AbortSignal,
): Promise<{ detail: string }> {
  const probeToken = randomUUID();
  const probeKey = joinS3Key(config.prefix, `__ludens_probe_${probeToken}.txt`);
  const probeBytes = Buffer.from(`ludens-storage-probe:${probeToken}`, "utf8");

  await s3PutBytes(config, probeKey, probeBytes, "text/plain; charset=utf-8", signal);

  let readVerified = false;
  let getError: unknown;
  try {
    const url = buildS3ObjectUrl(config, probeKey);
    const headers = signS3Headers({
      method: "GET",
      url,
      region: config.region,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    });
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal,
    });
    if (!response.ok) {
      const snippet = await readErrorSnippet(response);
      throw new Error(
        `S3 GET probe failed (${response.status} ${response.statusText})${snippet ? `: ${snippet}` : ""}`,
      );
    }
    const returned = Buffer.from(await response.arrayBuffer());
    if (!returned.equals(probeBytes)) {
      throw new Error("S3 GET probe payload mismatch");
    }
    readVerified = true;
  } catch (error) {
    getError = error;
  }

  if (!readVerified) {
    await s3DeleteObject(config, probeKey, signal).catch(() => {});
    throw getError instanceof Error ? getError : new Error(String(getError));
  }

  await s3DeleteObject(config, probeKey, signal);
  return {
    detail: `Verified PUT/GET/DELETE on s3://${config.bucket}/${probeKey}`,
  };
}
