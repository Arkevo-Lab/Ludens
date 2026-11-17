import { expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LUDENS_EVENT_TOPICS, type AppRpcMethods, type MediaResolveResult } from "../src/app-rpc.ts";
import { JsonArchive, readArtifact, readArtifactSync } from "../src/log-archive.ts";
import { ensureWorkspaceIdentity } from "../src/ludens.ts";
import {
  UNSIGNED_PAYLOAD,
  buildS3ObjectUrl,
  deriveSigningKey,
  encodeRfc3986,
  presignS3Url,
  s3DeleteObject,
  s3ProbeConnectivity,
  s3PutBytes,
  sha256Hex,
  signS3Headers,
} from "../src/s3-sigv4.ts";
import {
  BUILTIN_LOCAL_PROFILE_ID,
  DEFAULT_LOCAL_CACHE_BYTES,
  DEFAULT_LOCAL_MAX_BYTES,
  SECRET_MASK,
  crfForVideoQuality,
  defaultGlobalStorageConfig,
  mergeGlobalStorageUpdate,
  readGlobalStorageConfig,
  readTimelinePins,
  redactGlobalStorageConfig,
  resolveEffectiveWorkspaceStorage,
  updateGlobalStorageConfig,
  validTimelinePinAsset,
  validateGlobalStorageConfig,
  validateWorkspaceStorageOverride,
  writeGlobalStorageConfig,
  writeTimelinePins,
  type S3BackendConfig,
} from "../src/storage.ts";
import { EVICTED_VIDEO_MESSAGE, decodeTimelineFrame } from "../src/timeline-media.ts";

function verifyIncomingSigV4(
  req: Request,
  bodyBytes: Uint8Array,
  expectedAccessKeyId: string,
  expectedSecretAccessKey: string,
  expectedRegion: string,
): { ok: true } | { ok: false; reason: string } {
  const url = new URL(req.url);
  const queryAlgo = url.searchParams.get("X-Amz-Algorithm");

  if (queryAlgo) {
    if (queryAlgo !== "AWS4-HMAC-SHA256") {
      return { ok: false, reason: "Unsupported query algorithm" };
    }
    const credential = url.searchParams.get("X-Amz-Credential") ?? "";
    const amzDate = url.searchParams.get("X-Amz-Date") ?? "";
    const signedHeaders = url.searchParams.get("X-Amz-SignedHeaders") ?? "";
    const providedSig = url.searchParams.get("X-Amz-Signature") ?? "";
    const dateStamp = amzDate.slice(0, 8);
    const expectedScope = `${dateStamp}/${expectedRegion}/s3/aws4_request`;
    if (credential !== `${expectedAccessKeyId}/${expectedScope}`) {
      return { ok: false, reason: `Credential mismatch: ${credential}` };
    }

    const pairs: Array<[string, string]> = [];
    url.searchParams.forEach((v, k) => {
      if (k !== "X-Amz-Signature") {
        pairs.push([encodeRfc3986(k), encodeRfc3986(v)]);
      }
    });
    pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    const canonicalQuery = pairs.map(([k, v]) => `${k}=${v}`).join("&");

    const headerNames = signedHeaders.split(";");
    const canonicalHeaders = headerNames
      .map(name => `${name}:${(name === "host" ? url.host : (req.headers.get(name) ?? "")).trim()}\n`)
      .join("");

    const canonicalUri = url.pathname
      .split("/")
      .map(seg => encodeRfc3986(decodeURIComponent(seg)))
      .join("/");

    const canonicalRequest = [
      req.method.toUpperCase(),
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      UNSIGNED_PAYLOAD,
    ].join("\n");

    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      expectedScope,
      createHash("sha256").update(canonicalRequest, "utf8").digest("hex"),
    ].join("\n");

    const signingKey = deriveSigningKey(expectedSecretAccessKey, dateStamp, expectedRegion, "s3");
    const expectedSig = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");
    return providedSig === expectedSig
      ? { ok: true }
      : { ok: false, reason: "Presigned signature mismatch" };
  }

  const auth = req.headers.get("authorization") ?? "";
  const match =
    /^AWS4-HMAC-SHA256 Credential=([^,]+),\s*SignedHeaders=([^,]+),\s*Signature=([0-9a-f]+)$/.exec(auth);
  if (!match) {
    return { ok: false, reason: "Missing or malformed Authorization header" };
  }
  const [, credential, signedHeaders, providedSig] = match;
  const amzDate = req.headers.get("x-amz-date") ?? "";
  const payloadHash = req.headers.get("x-amz-content-sha256") ?? "";
  const actualBodyHash = sha256Hex(bodyBytes);
  if (payloadHash !== actualBodyHash) {
    return { ok: false, reason: `Payload hash mismatch: ${payloadHash} !== ${actualBodyHash}` };
  }

  const dateStamp = amzDate.slice(0, 8);
  const expectedScope = `${dateStamp}/${expectedRegion}/s3/aws4_request`;
  if (credential !== `${expectedAccessKeyId}/${expectedScope}`) {
    return { ok: false, reason: `Credential mismatch: ${credential}` };
  }

  const pairs: Array<[string, string]> = [];
  url.searchParams.forEach((v, k) => pairs.push([encodeRfc3986(k), encodeRfc3986(v)]));
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const canonicalQuery = pairs.map(([k, v]) => `${k}=${v}`).join("&");

  const headerNames = signedHeaders!.split(";");
  const canonicalHeaders = headerNames
    .map(name => `${name}:${(name === "host" ? url.host : (req.headers.get(name) ?? "")).trim()}\n`)
    .join("");

  const canonicalUri = url.pathname
    .split("/")
    .map(seg => encodeRfc3986(decodeURIComponent(seg)))
    .join("/");

  const canonicalRequest = [
    req.method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders!,
    payloadHash,
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    expectedScope,
    createHash("sha256").update(canonicalRequest, "utf8").digest("hex"),
  ].join("\n");

  const signingKey = deriveSigningKey(expectedSecretAccessKey, dateStamp, expectedRegion, "s3");
  const expectedSig = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");
  return providedSig === expectedSig
    ? { ok: true }
    : { ok: false, reason: "Header signature mismatch" };
}

test("storage.json enforces 0600 permissions, serializes concurrent updates, redacts secrets, and preserves masked S3 secrets", async () => {
  const home = await mkdtemp(join(tmpdir(), "ludens-storage-home-"));
  try {
    const initial = await readGlobalStorageConfig(home);
    expect(initial).toEqual({
      version: 1,
      defaultProfileId: BUILTIN_LOCAL_PROFILE_ID,
      videoQuality: "balanced",
      protectReferenced: true,
      profiles: [
        {
          id: BUILTIN_LOCAL_PROFILE_ID,
          name: "Local Disk (Default)",
          kind: "local",
          maxBytes: DEFAULT_LOCAL_MAX_BYTES,
          maxAgeHours: null,
        },
      ],
    });

    const written = await writeGlobalStorageConfig(
      mergeGlobalStorageUpdate(initial, {
        defaultProfileId: "r2-archive",
        videoQuality: "compact",
        protectReferenced: false,
        profiles: [
          {
            id: "r2-archive",
            name: "Cloudflare R2",
            kind: "s3",
            localCacheBytes: 2 * 1024 * 1024 * 1024,
            s3: {
              endpoint: "https://acct.r2.cloudflarestorage.com/",
              region: "auto",
              bucket: "ludens-media",
              prefix: "/prod/timeline/",
              accessKeyId: "AKIA_TEST_1",
              secretAccessKey: "super-secret-value-1",
            },
          },
        ],
      }),
      home,
    );

    // Built-in local-default is preserved automatically even when omitted from input.profiles
    expect(written.profiles.map(p => p.id)).toEqual([BUILTIN_LOCAL_PROFILE_ID, "r2-archive"]);
    const s3Profile = written.profiles.find(p => p.id === "r2-archive")!;
    expect(s3Profile.s3?.endpoint).toBe("https://acct.r2.cloudflarestorage.com");
    expect(s3Profile.s3?.prefix).toBe("prod/timeline");
    expect(s3Profile.s3?.secretAccessKey).toBe("super-secret-value-1");

    if (process.platform !== "win32") {
      const info = await stat(join(home, "storage.json"));
      expect(info.mode & 0o777).toBe(0o600);
    }

    const redacted = redactGlobalStorageConfig(written);
    const redactedS3 = redacted.profiles.find(p => p.id === "r2-archive")!.s3!;
    expect(redactedS3.hasSecretAccessKey).toBe(true);
    expect("secretAccessKey" in redactedS3).toBe(false);

    // Updating non-secret fields with SECRET_MASK, empty string, or omitted secret preserves existing secretAccessKey
    for (const placeholder of [SECRET_MASK, "", undefined]) {
      const afterEdit = await updateGlobalStorageConfig(
        curr =>
          mergeGlobalStorageUpdate(curr, {
            profiles: [
              curr.profiles[0]!,
              {
                id: "r2-archive",
                name: "Cloudflare R2 Edited",
                kind: "s3",
                s3: {
                  endpoint: "https://acct.r2.cloudflarestorage.com",
                  region: "auto",
                  bucket: "ludens-media",
                  prefix: "prod/v2",
                  accessKeyId: "AKIA_TEST_1",
                  ...(placeholder !== undefined ? { secretAccessKey: placeholder } : {}),
                },
              },
            ],
          }),
        home,
      );
      expect(afterEdit.profiles.find(p => p.id === "r2-archive")!.s3?.secretAccessKey).toBe(
        "super-secret-value-1",
      );
      expect(afterEdit.profiles.find(p => p.id === "r2-archive")!.s3?.prefix).toBe("prod/v2");
    }

    // Brand-new S3 profile without saved secret rejects SECRET_MASK
    expect(() =>
      mergeGlobalStorageUpdate(written, {
        profiles: [
          {
            id: "new-s3",
            name: "New S3",
            kind: "s3",
            s3: {
              endpoint: "https://s3.amazonaws.com",
              region: "us-east-1",
              bucket: "bucket-a",
              accessKeyId: "AKIA_NEW",
              secretAccessKey: SECRET_MASK,
            },
          },
        ],
      }),
    ).toThrow(/secretAccessKey/);

    // Concurrent updates compose cleanly under storage.json.lock
    await Promise.all([
      updateGlobalStorageConfig(async curr => {
        await new Promise(done => setTimeout(done, 15));
        return mergeGlobalStorageUpdate(curr, { videoQuality: "high" });
      }, home),
      updateGlobalStorageConfig(async curr => {
        await new Promise(done => setTimeout(done, 5));
        return mergeGlobalStorageUpdate(curr, { protectReferenced: true });
      }, home),
    ]);
    const finalCfg = await readGlobalStorageConfig(home);
    expect(finalCfg.videoQuality).toBe("high");
    expect(finalCfg.protectReferenced).toBe(true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("resolveEffectiveWorkspaceStorage, validateWorkspaceStorageOverride, and pins.json cover inherit/profile/local/ephemeral and env overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "ludens-storage-ws-"));
  const home = join(root, "home");
  const wsUninit = join(root, "alpha-uninitialized");
  const wsInit = join(root, "beta-initialized");
  const extDir = join(root, "nas-mount");
  const prevPersist = process.env.LUDENS_PERCEPTION_PERSIST;

  try {
    await mkdir(wsUninit, { recursive: true });
    await mkdir(wsInit, { recursive: true });
    await mkdir(extDir, { recursive: true });

    expect(crfForVideoQuality("high")).toBe(18);
    expect(crfForVideoQuality("balanced")).toBe(23);
    expect(crfForVideoQuality("compact")).toBe(28);

    // Fallback to basename before .ludens/workspace.json exists
    delete process.env.LUDENS_PERCEPTION_PERSIST;
    const uninitEff = await resolveEffectiveWorkspaceStorage(wsUninit, home);
    expect(uninitEff.workspaceId).toBe("alpha-uninitialized");
    expect(uninitEff.kind).toBe("local");
    expect(uninitEff.profileId).toBe(BUILTIN_LOCAL_PROFILE_ID);
    expect(uninitEff.maxBytes).toBe(DEFAULT_LOCAL_MAX_BYTES);
    expect(uninitEff.localCacheBytes).toBe(DEFAULT_LOCAL_CACHE_BYTES);
    expect(uninitEff.crf).toBe(23);

    const identity = await ensureWorkspaceIdentity(wsInit);
    await writeGlobalStorageConfig(
      validateGlobalStorageConfig({
        version: 1,
        defaultProfileId: "nas-ssd",
        videoQuality: "balanced",
        protectReferenced: true,
        profiles: [
          {
            id: "nas-ssd",
            name: "External NAS",
            kind: "directory",
            maxBytes: 100 * 1024 * 1024 * 1024,
            localCacheBytes: 8 * 1024 * 1024 * 1024,
            directory: { path: extDir },
          },
          {
            id: "minio-local",
            name: "MinIO Lab",
            kind: "s3",
            s3: {
              endpoint: "http://127.0.0.1:9000",
              region: "us-east-1",
              bucket: "timeline",
              accessKeyId: "minio",
              secretAccessKey: "minio123",
              forcePathStyle: true,
            },
          },
        ],
      }),
      home,
    );

    const inherited = await resolveEffectiveWorkspaceStorage(wsInit, home);
    expect(inherited.workspaceId).toBe(identity.id);
    expect(inherited.kind).toBe("directory");
    expect(inherited.profileId).toBe("nas-ssd");
    expect(inherited.directory?.path).toBe(extDir);
    expect(inherited.localCacheBytes).toBe(8 * 1024 * 1024 * 1024);

    // Workspace ludens.json rejects secret credentials
    expect(() =>
      validateWorkspaceStorageOverride({
        mode: "profile",
        profileId: "minio-local",
        secretAccessKey: "leak",
      }),
    ).toThrow(/not allowed/);

    // Workspace ludens.json profile override + custom videoQuality and maxBytes
    await writeFile(
      join(wsInit, "ludens.json"),
      JSON.stringify({
        storage: {
          mode: "profile",
          profileId: "minio-local",
          maxBytes: 50 * 1024 * 1024 * 1024,
          videoQuality: "high",
        },
      }),
    );
    const profileOverride = await resolveEffectiveWorkspaceStorage(wsInit, home);
    expect(profileOverride.kind).toBe("s3");
    expect(profileOverride.profileId).toBe("minio-local");
    expect(profileOverride.maxBytes).toBe(50 * 1024 * 1024 * 1024);
    expect(profileOverride.videoQuality).toBe("high");
    expect(profileOverride.crf).toBe(18);
    expect(profileOverride.s3?.secretAccessKey).toBe("minio123");

    // LUDENS_PERCEPTION_PERSIST=0 forces ephemeral regardless of ludens.json / storage.json
    process.env.LUDENS_PERCEPTION_PERSIST = "0";
    const envEphemeral = await resolveEffectiveWorkspaceStorage(wsInit, home);
    expect(envEphemeral.kind).toBe("ephemeral");
    expect(envEphemeral.profileId).toBeNull();
    expect(envEphemeral.maxBytes).toBeNull();

    process.env.LUDENS_PERCEPTION_PERSIST = "false";
    expect((await resolveEffectiveWorkspaceStorage(wsInit, home)).kind).toBe("ephemeral");

    // Timeline pins.json reader/writer deduplicates & blocks traversal
    expect(validTimelinePinAsset("video/seg-001.mp4")).toBe(true);
    expect(validTimelinePinAsset(`objects/${"a".repeat(64)}.bin`)).toBe(true);
    expect(validTimelinePinAsset("foo/bar.txt")).toBe(false);
    expect(validTimelinePinAsset("../outside.mp4")).toBe(false);

    const timelineRoot = join(wsInit, ".ludens", "timeline");
    expect(await readTimelinePins(timelineRoot)).toEqual([]);
    const savedPins = await writeTimelinePins(timelineRoot, [
      "video/seg-001.mp4",
      "video/seg-001.mp4",
      `objects/${"a".repeat(64)}.bin`,
    ]);
    expect(savedPins).toEqual(["video/seg-001.mp4", `objects/${"a".repeat(64)}.bin`]);
    expect(await readTimelinePins(timelineRoot)).toEqual(savedPins);
    await expect(writeTimelinePins(timelineRoot, ["../outside.mp4"])).rejects.toThrow(/Invalid timeline pin/);
  } finally {
    if (prevPersist === undefined) delete process.env.LUDENS_PERCEPTION_PERSIST;
    else process.env.LUDENS_PERCEPTION_PERSIST = prevPersist;
    await rm(root, { recursive: true, force: true });
  }
});

test("AWS SigV4 URL builder, header signing, presigned GET/Range URLs, and s3ProbeConnectivity pass against a strict mock S3 server", async () => {
  // Virtual-hosted vs path-style URL checks + verbatim key handling (no duplicate prefix)
  const awsVirtual = buildS3ObjectUrl(
    {
      endpoint: "https://s3.us-east-1.amazonaws.com",
      region: "us-east-1",
      bucket: "ludens-archive",
      prefix: "team-a",
      accessKeyId: "AKIA",
      secretAccessKey: "SECRET",
    },
    "team-a/ws-123/video/abc (1)!.mp4",
  );
  expect(awsVirtual.toString()).toBe(
    "https://ludens-archive.s3.us-east-1.amazonaws.com/team-a/ws-123/video/abc%20%281%29%21.mp4",
  );

  const forcedPath = buildS3ObjectUrl(
    {
      endpoint: "https://s3.us-east-1.amazonaws.com",
      region: "us-east-1",
      bucket: "ludens-archive",
      accessKeyId: "AKIA",
      secretAccessKey: "SECRET",
      forcePathStyle: true,
    },
    "ws-123/video/abc.mp4",
  );
  expect(forcedPath.toString()).toBe(
    "https://s3.us-east-1.amazonaws.com/ludens-archive/ws-123/video/abc.mp4",
  );

  const ACCESS_KEY = "LUDENS_TEST_AKIA";
  const SECRET_KEY = "LUDENS_TEST_SUPER_SECRET_KEY";
  const REGION = "us-east-1";
  const BUCKET = "ludens-bucket";

  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const ops: Array<{ method: string; path: string }> = [];
  let denyDelete = false;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const bodyBytes = new Uint8Array(await req.arrayBuffer());
      ops.push({ method: req.method, path: url.pathname });

      const check = verifyIncomingSigV4(req, bodyBytes, ACCESS_KEY, SECRET_KEY, REGION);
      if (!check.ok) {
        return new Response(`SignatureDoesNotMatch: ${check.reason}`, { status: 403 });
      }

      const prefix = `/${BUCKET}/`;
      if (!url.pathname.startsWith(prefix)) {
        return new Response("NoSuchBucket", { status: 404 });
      }
      const objectKey = url.pathname
        .slice(prefix.length)
        .split("/")
        .map(decodeURIComponent)
        .join("/");

      if (req.method === "PUT") {
        objects.set(objectKey, {
          bytes: bodyBytes,
          contentType: req.headers.get("content-type") ?? "application/octet-stream",
        });
        return new Response(null, { status: 200 });
      }

      if (req.method === "GET" || req.method === "HEAD") {
        const entry = objects.get(objectKey);
        if (!entry) return new Response("NoSuchKey", { status: 404 });
        const range = req.headers.get("range");
        if (range) {
          const m = /^bytes=(\d+)-(\d*)$/.exec(range);
          if (m) {
            const start = Number(m[1]);
            const end = m[2] ? Math.min(Number(m[2]), entry.bytes.byteLength - 1) : entry.bytes.byteLength - 1;
            const slice = entry.bytes.subarray(start, end + 1);
            const out = new Uint8Array(slice.byteLength);
            out.set(slice);
            return new Response(req.method === "HEAD" ? null : out, {
              status: 206,
              headers: {
                "content-type": entry.contentType,
                "content-length": String(out.byteLength),
                "content-range": `bytes ${start}-${end}/${entry.bytes.byteLength}`,
                "accept-ranges": "bytes",
              },
            });
          }
        }
        const out = new Uint8Array(entry.bytes.byteLength);
        out.set(entry.bytes);
        return new Response(req.method === "HEAD" ? null : out, {
          status: 200,
          headers: {
            "content-type": entry.contentType,
            "content-length": String(out.byteLength),
            "accept-ranges": "bytes",
          },
        });
      }

      if (req.method === "DELETE") {
        if (denyDelete) return new Response("AccessDenied on DELETE", { status: 403 });
        objects.delete(objectKey);
        return new Response(null, { status: 204 });
      }

      return new Response("MethodNotAllowed", { status: 405 });
    },
  });

  try {
    const config: S3BackendConfig = {
      endpoint: `http://127.0.0.1:${server.port}`,
      region: REGION,
      bucket: BUCKET,
      prefix: "archive/env-1",
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET_KEY,
    };

    // 1) s3ProbeConnectivity writes/reads/deletes <prefix>/__ludens_probe_<uuid>.txt
    const probe = await s3ProbeConnectivity(config);
    expect(probe.detail).toContain(`s3://${BUCKET}/archive/env-1/__ludens_probe_`);
    expect(objects.size).toBe(0);
    expect(ops.map(o => o.method)).toEqual(["PUT", "GET", "DELETE"]);

    // Verify s3ProbeConnectivity fails if DELETE permission is denied
    denyDelete = true;
    await expect(s3ProbeConnectivity(config)).rejects.toThrow(/S3 DELETE failed \(403/);
    denyDelete = false;
    objects.clear();

    // 2) s3PutBytes + presignS3Url GET & Range request (including special chars in key)
    const videoKey = "archive/env-1/ws-42/video/seg (test)!.mp4";
    const sampleBytes = new TextEncoder().encode("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    await s3PutBytes(config, videoKey, sampleBytes, "video/mp4");
    expect(objects.has(videoKey)).toBe(true);

    const presigned = presignS3Url({
      method: "GET",
      config,
      key: videoKey,
      expiresSeconds: 900,
    });
    expect(presigned).toContain("X-Amz-Algorithm=AWS4-HMAC-SHA256");

    // Full GET via presigned URL (without signing Range header, just like browser/proxy upstream)
    const fullRes = await fetch(presigned);
    expect(fullRes.status).toBe(200);
    expect(new Uint8Array(await fullRes.arrayBuffer())).toEqual(sampleBytes);

    // Byte-Range GET via presigned URL
    const rangeRes = await fetch(presigned, { headers: { Range: "bytes=10-19" } });
    expect(rangeRes.status).toBe(206);
    expect(rangeRes.headers.get("content-range")).toBe(`bytes 10-19/${sampleBytes.byteLength}`);
    expect(new TextDecoder().decode(await rangeRes.arrayBuffer())).toBe("ABCDEFGHIJ");

    // Wrong secret fails signature verification with 403
    await expect(
      s3PutBytes({ ...config, secretAccessKey: "WRONG_SECRET" }, videoKey, sampleBytes, "video/mp4"),
    ).rejects.toThrow(/403/);

    const badUrl = buildS3ObjectUrl(config, videoKey);
    const badHeaders = signS3Headers({
      method: "GET",
      url: badUrl,
      region: REGION,
      accessKeyId: ACCESS_KEY,
      secretAccessKey: "WRONG_SECRET",
    });
    const badGet = await fetch(badUrl, { headers: badHeaders });
    expect(badGet.status).toBe(403);

    // 3) s3DeleteObject cleans up
    await s3DeleteObject(config, videoKey);
    expect(objects.has(videoKey)).toBe(false);
  } finally {
    await server.stop(true);
  }
});

test("timeline-media and log-archive handle evicted segments, archived cold segments, and cached media objects", async () => {
  const rawDir = await mkdtemp(join(tmpdir(), "ludens-timeline-media-"));
  const rootDir = await realpath(rawDir);
  const workspace = join(rootDir, "ws");
  const timelineRoot = join(workspace, ".ludens", "timeline");
  const runDir = join(rootDir, "run");
  const prevPython = process.env.LUDENS_PYTHON;

  try {
    await mkdir(join(timelineRoot, "video"), { recursive: true });
    await mkdir(join(timelineRoot, "cache", "video"), { recursive: true });
    await mkdir(join(timelineRoot, "cache", "objects"), { recursive: true });
    await mkdir(join(timelineRoot, "objects"), { recursive: true });
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "manifest.json"), JSON.stringify({ workspace }));

    const evictedAsset = "video/11111111-1111-1111-1111-111111111111.mp4";
    const missingAsset = "video/22222222-2222-2222-2222-222222222222.mp4";
    const archivedAsset = "video/33333333-3333-3333-3333-333333333333.mp4";
    const cachedAsset = "video/44444444-4444-4444-4444-444444444444.mp4";

    // 1) Evicted segment without archive -> 410 with exact retention policy message
    await writeFile(
      join(timelineRoot, `${evictedAsset}.json`),
      JSON.stringify({
        status: "evicted",
        evictedAt: "2026-11-17T00:00:00.000Z",
        evictedReason: "quota",
      }),
    );
    let evictedErr: (Error & { status?: number }) | undefined;
    try {
      await decodeTimelineFrame(timelineRoot, {
        asset: evictedAsset,
        video: { pts: 0, timeBase: [1, 1_000_000], width: 64, height: 64 },
      });
    } catch (err) {
      evictedErr = err as Error & { status?: number };
    }
    expect(evictedErr?.message).toBe(EVICTED_VIDEO_MESSAGE);
    expect(evictedErr?.status).toBe(410);

    // 2) Ready segment with missing local .mp4 and NO archive / NO cache -> 410 segment is missing
    await writeFile(join(timelineRoot, `${missingAsset}.json`), JSON.stringify({ status: "ready" }));
    let missingErr: (Error & { status?: number }) | undefined;
    try {
      await decodeTimelineFrame(timelineRoot, {
        asset: missingAsset,
        video: { pts: 0, timeBase: [1, 1_000_000], width: 64, height: 64 },
      });
    } catch (err) {
      missingErr = err as Error & { status?: number };
    }
    expect(missingErr?.message).toBe("Recorded video is unavailable: segment is missing");
    expect(missingErr?.status).toBe(410);

    // 3) Ready segment with missing local .mp4 WITH archive OR cache passes through to Python _video (forwarding options.home as LUDENS_HOME)
    const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const envCaptureFile = join(rootDir, "captured-ludens-home.txt");
    const customLudensHome = join(rootDir, "custom-ludens-home");
    const pythonShim = join(rootDir, "fake-python.sh");
    await writeFile(
      pythonShim,
      `#!/bin/sh\nprintf '%s' "$LUDENS_HOME" > "${envCaptureFile}"\nprintf '\\211PNG\\r\\n\\032\\n'\n`,
      { mode: 0o755 },
    );
    await chmod(pythonShim, 0o755);

    if (process.platform !== "win32") {
      process.env.LUDENS_PYTHON = pythonShim;

      await writeFile(
        join(timelineRoot, `${archivedAsset}.json`),
        JSON.stringify({
          status: "ready",
          archive: {
            backend: "s3",
            profileId: "r2",
            key: `ws/${archivedAsset}`,
            bytes: 4096,
            archivedAt: "2026-11-17T00:00:00.000Z",
          },
        }),
      );
      const decodedArchived = await decodeTimelineFrame(
        timelineRoot,
        {
          asset: archivedAsset,
          video: { pts: 1000, timeBase: [1, 1_000_000], width: 64, height: 64 },
        },
        { home: customLudensHome },
      );
      expect(decodedArchived.equals(fakePng)).toBe(true);
      expect(await readFile(envCaptureFile, "utf8")).toBe(customLudensHome);

      await writeFile(join(timelineRoot, `${cachedAsset}.json`), JSON.stringify({ status: "ready" }));
      await writeFile(join(timelineRoot, "cache", cachedAsset), "cached-mp4-placeholder");
      const decodedCached = await decodeTimelineFrame(timelineRoot, {
        asset: cachedAsset,
        video: { pts: 2000, timeBase: [1, 1_000_000], width: 64, height: 64 },
      });
      expect(decodedCached.equals(fakePng)).toBe(true);
    }

    // 4) JsonArchive replaces evicted (non-archived) video reference, keeps archived cold video reference, and reads cached objects
    const archive = new JsonArchive(workspace);
    const frameBytes = Buffer.from("sample-frame-payload-bytes");
    const frameSha = sha256Hex(frameBytes);

    // First bind frameSha to evictedAsset (while initially ready)
    const segA = "video/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.mp4";
    const segB = "video/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.mp4";
    const segC = "video/cccccccc-cccc-cccc-cccc-cccccccccccc.mp4";
    await writeFile(join(timelineRoot, `${segA}.json`), JSON.stringify({ status: "ready" }));
    await writeFile(join(timelineRoot, `${segB}.json`), JSON.stringify({ status: "ready" }));
    await writeFile(join(timelineRoot, `${segC}.json`), JSON.stringify({ status: "ready" }));

    archive.registerMedia({
      sha256: frameSha,
      asset: segA,
      video: { pts: 0, timeBase: [1, 1_000_000], width: 32, height: 32 },
    });
    archive.write({ type: "image", mediaType: "image/png", data: frameBytes.toString("base64") });
    const mediaIndexFile = join(workspace, ".ludens", "archive", "media", `${frameSha}.json`);
    expect(JSON.parse(await readFile(mediaIndexFile, "utf8")).asset).toBe(segA);

    // Now mark segA as evicted (no archive); a fresh JsonArchive instance should replace it with segB!
    await writeFile(join(timelineRoot, `${segA}.json`), JSON.stringify({ status: "evicted", evictedReason: "quota" }));
    const archive2 = new JsonArchive(workspace);
    archive2.registerMedia({
      sha256: frameSha,
      asset: segB,
      video: { pts: 100, timeBase: [1, 1_000_000], width: 32, height: 32 },
    });
    archive2.write({ type: "image", mediaType: "image/png", data: frameBytes.toString("base64") });
    expect(JSON.parse(await readFile(mediaIndexFile, "utf8")).asset).toBe(segB);

    // Mark segB as evicted WITH a valid cold archive -> must NOT be treated as expired/lost!
    await writeFile(
      join(timelineRoot, `${segB}.json`),
      JSON.stringify({
        status: "evicted",
        archive: {
          backend: "directory",
          profileId: "nas",
          key: `ws/${segB}`,
          bytes: 1024,
          archivedAt: "2026-11-17T00:00:00.000Z",
        },
      }),
    );
    const archive3 = new JsonArchive(workspace);
    archive3.registerMedia({
      sha256: frameSha,
      asset: segC,
      video: { pts: 200, timeBase: [1, 1_000_000], width: 32, height: 32 },
    });
    archive3.write({ type: "image", mediaType: "image/png", data: frameBytes.toString("base64") });
    expect(JSON.parse(await readFile(mediaIndexFile, "utf8")).asset).toBe(segB);

    // Static object pruned from timeline/objects/ into timeline/cache/objects/ remains readable
    const staticBytes = Buffer.from("static-binary-image-data");
    const staticSha = sha256Hex(staticBytes);
    const staticRel = `objects/${staticSha}.bin`;
    await writeFile(join(timelineRoot, staticRel), staticBytes);
    const ref = archive3.write({
      type: "image",
      mediaType: "image/png",
      data: staticBytes.toString("base64"),
    });
    // Move from hot timeline/objects/ to timeline/cache/objects/
    await writeFile(join(timelineRoot, "cache", staticRel), staticBytes);
    await unlink(join(timelineRoot, staticRel));

    const hydratedAsync = await readArtifact(runDir, ref, { media: "full" });
    expect(hydratedAsync.data).toBe(staticBytes.toString("base64"));
    const hydratedSync = readArtifactSync(runDir, ref, { media: "full" });
    expect(hydratedSync.data).toBe(staticBytes.toString("base64"));

    // Type-level & runtime App-RPC topic / MediaResolveResult verification
    expect(LUDENS_EVENT_TOPICS).toContain("storage");
    const remoteMedia: MediaResolveResult = {
      remoteUrl: "https://s3.example.com/presigned",
      size: 1234,
      mediaType: "video/mp4",
      cacheControl: "private, max-age=31536000, immutable",
    };
    expect(remoteMedia.remoteUrl).toContain("https://");
    const _rpcCheck: keyof AppRpcMethods = "storage/maintain";
    expect(_rpcCheck).toBe("storage/maintain");
  } finally {
    if (prevPython === undefined) delete process.env.LUDENS_PYTHON;
    else process.env.LUDENS_PYTHON = prevPython;
    await rm(rootDir, { recursive: true, force: true });
  }
});
