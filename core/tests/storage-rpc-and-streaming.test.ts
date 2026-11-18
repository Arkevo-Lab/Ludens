import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_RPC_ERROR_CODES, type LudensServerEvent } from "@ludens/protocol/app-rpc";
import { ensureWorkspaceIdentity, registerWorkspace } from "@ludens/protocol/ludens";
import { SECRET_MASK } from "@ludens/protocol/storage";
import { AppRpcClientError, NodeUdsRpcClient, WsAppRpcClient } from "../src/cli/app-rpc-client.ts";
import { mediaFile } from "../src/core/query/data.ts";
import { getReplay } from "../src/core/query/replay.ts";
import { maintainStorage, updateStorageSettings } from "../src/core/query/storage.ts";
import { pythonModulePaths } from "../src/core/subsystems/python-capabilities.ts";
import { pythonCommand, pythonExecutable } from "@ludens/protocol/python";
import { Runtime } from "../src/core/shiori/runtime.ts";
import type { PerceptionRuntime } from "../src/core/subsystems/perception.ts";
import { dispatch as dispatchTransport } from "../src/daemon/transport.ts";
import { startAppServer } from "../src/server/app-server.ts";

async function allocateEphemeralPort(): Promise<number> {
  return new Promise<number>((resolvePort, rejectPort) => {
    const srv = createServer();
    srv.once("error", rejectPort);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(err => (err ? rejectPort(err) : resolvePort(port)));
    });
  });
}

interface TimelineSeedEntry {
  id: string;
  capability: string;
  at: number;
  runId: string;
  asset: string;
  pts: number;
}

async function writeTimelineVideoSegmentIndex(
  timelineRoot: string,
  stem: string,
  firstSequence: number,
  entries: TimelineSeedEntry[],
) {
  const segDir = join(timelineRoot, "segments");
  await mkdir(segDir, { recursive: true });
  const idx = Buffer.alloc(64 * entries.length);
  const lines: string[] = [];
  let offset = 0;

  entries.forEach((entry, i) => {
    const sequence = firstSequence + i;
    const record = {
      id: entry.id,
      sequence,
      capability: entry.capability,
      recordedAt: new Date(entry.at).toISOString(),
      runId: entry.runId,
      media: [
        {
          mediaType: "image/png",
          timeline: {
            recordId: entry.id,
            sequence,
            asset: entry.asset,
            video: {
              pts: entry.pts,
              timeBase: [1, 1000],
              width: 320,
              height: 180,
            },
          },
        },
      ],
    };
    const line = JSON.stringify(record);
    idx.writeDoubleBE(entry.at / 1000, i * 64);
    idx.writeBigUInt64BE(BigInt(sequence), i * 64 + 8);
    idx.writeBigUInt64BE(BigInt(offset), i * 64 + 16);
    idx.writeBigUInt64BE(BigInt(line.length), i * 64 + 24);
    createHash("sha256").update(entry.capability).digest().subarray(0, 16).copy(idx, i * 64 + 32);
    createHash("sha256").update(entry.id).digest().subarray(0, 16).copy(idx, i * 64 + 48);
    lines.push(line);
    offset += line.length + 1;
  });

  await writeFile(join(segDir, `${stem}.idx`), idx);
  await writeFile(join(segDir, `${stem}.jsonl`), `${lines.join("\n")}\n`);
  const last = firstSequence + entries.length - 1;
  const meta = {
    firstSequence,
    lastSequence: last,
    count: entries.length,
    minimum: { recordedAt: new Date(entries[0]!.at).toISOString(), sequence: firstSequence },
    maximum: { recordedAt: new Date(entries.at(-1)!.at).toISOString(), sequence: last },
  };
  const metaPath = join(segDir, `${stem}.meta.json`);
  await writeFile(metaPath, JSON.stringify(meta));
  await utimes(metaPath, 1000, 1000);
}

function startMockS3Server() {
  const objects = new Map<string, Uint8Array>();
  const requests: Array<{
    method: string;
    pathname: string;
    search: string;
    authHeader: string | null;
    rangeHeader: string | null;
  }> = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const authHeader = req.headers.get("authorization");
      const hasSigV4Header = Boolean(authHeader?.startsWith("AWS4-HMAC-SHA256 "));
      const hasPresignedSigV4 =
        url.searchParams.get("X-Amz-Algorithm") === "AWS4-HMAC-SHA256" &&
        Boolean(url.searchParams.get("X-Amz-Signature"));

      requests.push({
        method: req.method,
        pathname: url.pathname,
        search: url.search,
        authHeader,
        rangeHeader: req.headers.get("range"),
      });

      if (!hasSigV4Header && !hasPresignedSigV4) {
        return new Response("<Error><Code>AccessDenied</Code></Error>", {
          status: 403,
          headers: { "Content-Type": "application/xml" },
        });
      }

      const key = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
      if (req.method === "PUT") {
        const bytes = new Uint8Array(await req.arrayBuffer());
        objects.set(key, bytes);
        return new Response(null, { status: 200, headers: { ETag: '"mock-etag"' } });
      }

      if (req.method === "DELETE") {
        objects.delete(key);
        return new Response(null, { status: 204 });
      }

      if (req.method === "GET" || req.method === "HEAD") {
        const stored = objects.get(key);
        if (!stored) {
          return new Response("<Error><Code>NoSuchKey</Code></Error>", {
            status: 404,
            headers: { "Content-Type": "application/xml" },
          });
        }
        const range = req.headers.get("range");
        if (range) {
          const match = /^bytes=(\d+)-(\d*)$/.exec(range.trim());
          if (!match) {
            return new Response(null, {
              status: 416,
              headers: { "Content-Range": `bytes */${stored.byteLength}` },
            });
          }
          const start = Number(match[1]);
          const end = match[2]
            ? Math.min(Number(match[2]), stored.byteLength - 1)
            : stored.byteLength - 1;
          if (start >= stored.byteLength || end < start) {
            return new Response(null, {
              status: 416,
              headers: { "Content-Range": `bytes */${stored.byteLength}` },
            });
          }
          const slice = stored.subarray(start, end + 1);
          const headers = {
            "Content-Type": "binary/octet-stream",
            "Accept-Ranges": "bytes",
            "Content-Range": `bytes ${start}-${end}/${stored.byteLength}`,
            "Content-Length": String(slice.byteLength),
          };
          const sliceBody = new ArrayBuffer(slice.byteLength);
          new Uint8Array(sliceBody).set(slice);
          return new Response(req.method === "HEAD" ? null : sliceBody, {
            status: 206,
            headers,
          });
        }

        const headers = {
          "Content-Type": "binary/octet-stream",
          "Accept-Ranges": "bytes",
          "Content-Length": String(stored.byteLength),
        };
        const fullBody = new ArrayBuffer(stored.byteLength);
        new Uint8Array(fullBody).set(stored);
        return new Response(req.method === "HEAD" ? null : fullBody, {
          status: 200,
          headers,
        });
      }

      return new Response("Method Not Allowed", { status: 405 });
    },
  });

  return {
    endpoint: `http://127.0.0.1:${server.port}`,
    objects,
    requests,
    stop: () => server.stop(true),
  };
}

test("getReplay(mode=media) and mediaFile forward explicit home into decodeTimelineFrame for S3 cold hydration", async () => {
  const rootDir = await realpath(await mkdtemp(join(tmpdir(), "ludens-decode-home-")));
  const home = join(rootDir, "custom-home");
  const wsDir = join(rootDir, "ws-decode");
  const mockS3 = startMockS3Server();

  try {
    await mkdir(join(wsDir, ".ludens", "timeline", "video"), { recursive: true });
    await writeFile(
      join(wsDir, "ludens.json"),
      JSON.stringify({ driver: "cua", storage: { mode: "profile", profileId: "s3-cold" } }),
      "utf8",
    );
    const identity = await ensureWorkspaceIdentity(wsDir);
    await registerWorkspace(wsDir, home);

    await updateStorageSettings(
      {
        profiles: [
          { id: "local-default", name: "Local", kind: "local" },
          {
            id: "s3-cold",
            name: "Cold S3",
            kind: "s3",
            s3: {
              endpoint: mockS3.endpoint,
              region: "us-east-1",
              bucket: "cold-bucket",
              accessKeyId: "AKIAEXAMPLE",
              secretAccessKey: "SECRETEXAMPLE456",
              forcePathStyle: true,
            },
          },
        ],
      },
      home,
    );

    const pyEnv = {
      ...process.env,
      LUDENS_HOME: home,
      PYTHONPATH: [...pythonModulePaths(), ...(process.env.PYTHONPATH ? [process.env.PYTHONPATH] : [])].join(
        process.platform === "win32" ? ";" : ":",
      ),
    };
    const pyScript = `
import io, json, sys
from pathlib import Path
from PIL import Image
from ludens_tools._video import VideoRecorder

ws = Path(sys.argv[1])
tl = ws / ".ludens" / "timeline"
buf = io.BytesIO()
Image.new("RGB", (64, 48), (20, 120, 220)).save(buf, format="PNG")
rec = VideoRecorder(tl, tl / "video", segment_seconds=60, idle_seconds=10)
loc = rec.submit(buf.getvalue(), "ch0", 1700000002.5, (64, 48), sample_hz=1.0)
rec.close()
print(json.dumps(loc))
`;
    const cmd = pythonCommand(pythonExecutable(pyEnv), ["-c", pyScript, wsDir]);
    const proc = Bun.spawnSync([cmd.file, ...cmd.args], { env: pyEnv, cwd: wsDir });
    expect(proc.exitCode).toBe(0);
    const loc = JSON.parse(proc.stdout.toString("utf8").trim()) as {
      asset: string;
      video: { pts: number; timeBase: [number, number]; width: number; height: number };
    };

    const syncRes = await maintainStorage({ action: "sync", workspaceId: identity.id }, home);
    expect(syncRes.archivedCount).toBe(1);
    const clearRes = await maintainStorage({ action: "clear_cache", workspaceId: identity.id }, home);
    expect(clearRes.freedBytes).toBeGreaterThan(0);

    const runId = "2026-04-01T00-00-00.000Z";
    const t0 = Date.parse("2026-04-01T00:00:02.000Z");
    const timelineRoot = join(wsDir, ".ludens", "timeline");
    await writeTimelineVideoSegmentIndex(timelineRoot, "seg-cold", 1, [
      {
        id: "rec-cold-1",
        capability: "cap.screen",
        at: t0 + 500,
        runId,
        asset: loc.asset,
        pts: loc.video.pts,
      },
    ]);
    const exactRecord = JSON.stringify({
      id: "rec-cold-1",
      sequence: 1,
      capability: "cap.screen",
      recordedAt: new Date(t0 + 500).toISOString(),
      runId,
      media: [
        {
          mediaType: "image/png",
          timeline: { recordId: "rec-cold-1", sequence: 1, asset: loc.asset, video: loc.video },
        },
      ],
    });
    const idx = Buffer.alloc(64);
    idx.writeDoubleBE((t0 + 500) / 1000, 0);
    idx.writeBigUInt64BE(1n, 8);
    idx.writeBigUInt64BE(0n, 16);
    idx.writeBigUInt64BE(BigInt(exactRecord.length), 24);
    createHash("sha256").update("cap.screen").digest().subarray(0, 16).copy(idx, 32);
    createHash("sha256").update("rec-cold-1").digest().subarray(0, 16).copy(idx, 48);
    await writeFile(join(timelineRoot, "segments", "seg-cold.idx"), idx);
    await writeFile(join(timelineRoot, "segments", "seg-cold.jsonl"), `${exactRecord}\n`);
    await utimes(join(timelineRoot, "segments", "seg-cold.meta.json"), 2000, 2000);

    const runDir = join(wsDir, "logs", runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "manifest.json"),
      JSON.stringify({
        runId,
        workspace: wsDir,
        workspaceId: identity.id,
        drivers: ["cua"],
        eventSchemaVersion: 1,
      }),
    );
    const events = [
      { seq: 1, type: "run_start", at: "2026-04-01T00:00:01.000Z", trace: {}, data: { workspace: wsDir, workspaceId: identity.id } },
      { seq: 2, type: "control", at: "2026-04-01T00:00:02.000Z", trace: { epoch: "ep-1" }, data: { mode: "auto", epoch: "ep-1" } },
      {
        seq: 3,
        type: "observation",
        at: "2026-04-01T00:00:02.500Z",
        trace: { epoch: "ep-1" },
        data: {
          id: "obs-cold-1",
          mediaType: "image/png",
          timeline: { recordId: "rec-cold-1", sequence: 1, asset: loc.asset, video: loc.video },
        },
      },
      { seq: 4, type: "control", at: "2026-04-01T00:00:04.000Z", trace: { epoch: "ep-1" }, data: { mode: "manual", epoch: "ep-1" } },
    ];
    await writeFile(join(runDir, "events.jsonl"), `${events.map(e => JSON.stringify(e)).join("\n")}\n`);

    const prevHome = process.env.LUDENS_HOME;
    process.env.LUDENS_HOME = join(rootDir, "empty-decoy-home");
    try {
      const replayPng = (await getReplay(
        identity.id,
        runId,
        { mode: "media", epoch: "ep-1", record: "rec-cold-1", sequence: 1, media: 0 },
        home,
      )) as { bytes: Buffer; mediaType: string };
      expect(replayPng.mediaType).toBe("image/png");
      expect(replayPng.bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

      await rm(join(timelineRoot, "cache"), { recursive: true, force: true });
      let obsPng: Awaited<ReturnType<typeof mediaFile>> | undefined;
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          obsPng = await mediaFile(identity.id, runId, "obs-cold-1", home);
          break;
        } catch (err) {
          if ((err as { status?: number })?.status === 202) {
            await Bun.sleep(20);
            continue;
          }
          throw err;
        }
      }
      expect(obsPng?.mediaType).toBe("image/png");
      expect(obsPng?.bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    } finally {
      if (prevHome === undefined) delete process.env.LUDENS_HOME;
      else process.env.LUDENS_HOME = prevHome;
    }
  } finally {
    mockS3.stop();
    await rm(rootDir, { recursive: true, force: true });
  }
}, 25_000);

test("storage RPC (get/update/test/pin), secret masking & preservation, ludens.json override, and /media Range streaming across S3 / directory / cache / evicted", async () => {
  const rootDir = await realpath(await mkdtemp(join(tmpdir(), "ludens-storage-rpc-")));
  const home = join(rootDir, "home");
  const wsDir = join(rootDir, "workspace-alpha");
  const extMountDir = join(rootDir, "external-ssd");
  const mockS3 = startMockS3Server();

  let appServer: Awaited<ReturnType<typeof startAppServer>> | undefined;
  let udsClient: NodeUdsRpcClient | undefined;
  let wsClient: WsAppRpcClient | undefined;

  try {
    await mkdir(wsDir, { recursive: true });
    await mkdir(extMountDir, { recursive: true });
    await writeFile(
      join(wsDir, "ludens.json"),
      JSON.stringify({ driver: "cua", model: "openai-codex/gpt-6.1-sol" }, null, 2),
      "utf8",
    );
    const identity = await ensureWorkspaceIdentity(wsDir);
    await registerWorkspace(wsDir, home);

    const timelineRoot = join(wsDir, ".ludens", "timeline");
    const videoDir = join(timelineRoot, "video");
    const cacheVideoDir = join(timelineRoot, "cache", "video");
    const objectsDir = join(timelineRoot, "objects");
    await mkdir(videoDir, { recursive: true });
    await mkdir(cacheVideoDir, { recursive: true });
    await mkdir(objectsDir, { recursive: true });

    // 1. Seed local segment, cached segment, directory-archived segment, S3-archived segment, and evicted segment
    const localClip = Buffer.from("LOCAL_VIDEO_SEGMENT_PAYLOAD_0123456789");
    await writeFile(join(videoDir, "seg-local.mp4"), localClip);
    await writeFile(
      join(videoDir, "seg-local.mp4.json"),
      JSON.stringify({ status: "ready", durationSeconds: 5 }),
    );

    const cachedClip = Buffer.from("CACHED_VIDEO_SEGMENT_PAYLOAD_ABCDEFGHIJ");
    await writeFile(join(cacheVideoDir, "seg-cache.mp4"), cachedClip);
    await writeFile(
      join(videoDir, "seg-cache.mp4.json"),
      JSON.stringify({
        status: "ready",
        durationSeconds: 5,
        archive: {
          backend: "s3",
          profileId: "s3-archive",
          key: `archive/${identity.id}/video/seg-cache.mp4`,
          bytes: cachedClip.byteLength,
          archivedAt: "2026-03-01T00:00:05.000Z",
        },
      }),
    );

    const dirClip = Buffer.from("EXTERNAL_DIRECTORY_SEGMENT_0123456789_XYZ");
    const extClipRelKey = `${identity.id}/video/seg-dir.mp4`;
    await mkdir(join(extMountDir, identity.id, "video"), { recursive: true });
    await writeFile(join(extMountDir, extClipRelKey), dirClip);
    await writeFile(
      join(videoDir, "seg-dir.mp4.json"),
      JSON.stringify({
        status: "ready",
        durationSeconds: 5,
        archive: {
          backend: "directory",
          profileId: "ext-ssd",
          key: extClipRelKey,
          bytes: dirClip.byteLength,
          archivedAt: "2026-03-01T00:00:06.000Z",
        },
      }),
    );

    const s3Clip = Buffer.from("S3_CLOUD_SEGMENT_0123456789_QRSTUVWXYZ_END");
    const s3ObjectKey = `archive/${identity.id}/video/seg-s3.mp4`;
    // Path-style bucket URL in mock S3 server: /ludens-bucket/<s3ObjectKey>
    mockS3.objects.set(`ludens-bucket/${s3ObjectKey}`, new Uint8Array(s3Clip));
    await writeFile(
      join(videoDir, "seg-s3.mp4.json"),
      JSON.stringify({
        status: "ready",
        durationSeconds: 5,
        archive: {
          backend: "s3",
          profileId: "s3-archive",
          key: s3ObjectKey,
          bytes: s3Clip.byteLength,
          archivedAt: "2026-03-01T00:00:07.000Z",
        },
      }),
    );

    await writeFile(
      join(videoDir, "seg-evicted.mp4.json"),
      JSON.stringify({
        status: "evicted",
        durationSeconds: 5,
        evictedAt: "2026-03-01T00:00:08.000Z",
        evictedReason: "quota",
      }),
    );

    await writeFile(join(objectsDir, "deadbeef.bin"), Buffer.from("STATIC_OBJECT_BYTES"));

    // Seed timeline index & run log for replay + HTTP /media
    const runId = "2026-03-01T00-00-00.000Z";
    const t0 = Date.parse("2026-03-01T00:00:02.000Z");
    await writeTimelineVideoSegmentIndex(timelineRoot, "seg-0001", 1, [
      { id: "rec-local", capability: "cap.screen", at: t0 + 100, runId, asset: "video/seg-local.mp4", pts: 100 },
      { id: "rec-cache", capability: "cap.screen", at: t0 + 200, runId, asset: "video/seg-cache.mp4", pts: 200 },
      { id: "rec-dir", capability: "cap.screen", at: t0 + 300, runId, asset: "video/seg-dir.mp4", pts: 300 },
      { id: "rec-s3", capability: "cap.screen", at: t0 + 400, runId, asset: "video/seg-s3.mp4", pts: 400 },
      { id: "rec-evicted", capability: "cap.screen", at: t0 + 500, runId, asset: "video/seg-evicted.mp4", pts: 500 },
    ]);

    const runDir = join(wsDir, "logs", runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "manifest.json"),
      JSON.stringify({
        runId,
        workspace: wsDir,
        workspaceId: identity.id,
        model: "openai-codex/gpt-6.1-sol",
        drivers: ["cua"],
        eventSchemaVersion: 1,
      }),
      "utf8",
    );
    const events = [
      { seq: 1, type: "run_start", atMs: t0 - 1000, at: "2026-03-01T00:00:01.000Z", data: { workspace: wsDir, workspaceId: identity.id } },
      { seq: 2, type: "control", atMs: t0, at: "2026-03-01T00:00:02.000Z", trace: { epoch: "ep-1" }, data: { mode: "auto", epoch: "ep-1" } },
      { seq: 3, type: "control", atMs: t0 + 2000, at: "2026-03-01T00:00:04.000Z", trace: { epoch: "ep-1" }, data: { mode: "manual", epoch: "ep-1" } },
      { seq: 4, type: "run_end", atMs: t0 + 3000, at: "2026-03-01T00:00:05.000Z", data: { mode: "manual" } },
    ];
    await writeFile(join(runDir, "events.jsonl"), `${events.map(e => JSON.stringify(e)).join("\n")}\n`, "utf8");

    const wsPort = await allocateEphemeralPort();
    appServer = await startAppServer({
      home,
      wsListen: { host: "127.0.0.1", port: wsPort },
      auth: { mode: "token", token: "storage-test-token" },
    });

    udsClient = new NodeUdsRpcClient({ socketPath: appServer.socketPath! });
    const initRes = await udsClient.initialize({
      clientInfo: { name: "storage-test-uds", version: "1.0.0" },
    });
    const mediaTicket = initRes.media.ticket!;

    wsClient = new WsAppRpcClient({ url: appServer.wsUrl!, token: "storage-test-token" });
    await wsClient.connect();
    const storageEvents: LudensServerEvent[] = [];
    wsClient.onEvent(ev => {
      if (ev.topic === "storage") storageEvents.push(ev);
    });
    await wsClient.call("events/subscribe", { topics: ["storage"] });

    // 2. Test initial storage/get
    const initial = await udsClient.call("storage/get", {});
    expect(initial.config.defaultProfileId).toBe("local-default");
    expect(initial.config.videoQuality).toBe("balanced");
    expect(initial.config.protectReferenced).toBe(true);
    expect(initial.usage).toHaveLength(1);
    const wsUsage0 = initial.usage[0]!;
    expect(wsUsage0.workspaceId).toBe(identity.id);
    expect(wsUsage0.effectiveKind).toBe("local");
    expect(wsUsage0.localVideoSegments).toBe(1);
    expect(wsUsage0.localVideoBytes).toBe(localClip.byteLength);
    expect(wsUsage0.localCacheBytes).toBe(cachedClip.byteLength);
    expect(wsUsage0.localObjectsBytes).toBe(Buffer.byteLength("STATIC_OBJECT_BYTES"));
    expect(wsUsage0.archivedSegments).toBe(3);
    expect(wsUsage0.archivedBytes).toBe(cachedClip.byteLength + dirClip.byteLength + s3Clip.byteLength);
    expect(wsUsage0.evictedSegments).toBe(1);
    expect(wsUsage0.pinnedSegments).toBe(0);

    // 3. Test storage/update with S3 + Directory profiles, secret redaction & preservation
    const updated1 = await udsClient.call("storage/update", {
      videoQuality: "high",
      profiles: [
        {
          id: "local-default",
          name: "Local Ring",
          kind: "local",
          maxBytes: 10 * 1024 * 1024 * 1024,
        },
        {
          id: "ext-ssd",
          name: "External SSD",
          kind: "directory",
          localCacheBytes: 2 * 1024 * 1024 * 1024,
          directory: { path: extMountDir },
        },
        {
          id: "s3-archive",
          name: "Local Mock S3",
          kind: "s3",
          localCacheBytes: 2 * 1024 * 1024 * 1024,
          s3: {
            endpoint: mockS3.endpoint,
            region: "us-east-1",
            bucket: "ludens-bucket",
            prefix: "archive",
            accessKeyId: "AKIAIOSFODNN7EXAMPLE",
            secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
            forcePathStyle: true,
          },
        },
      ],
    });
    expect(updated1.config.videoQuality).toBe("high");
    const redactedS3 = updated1.config.profiles.find(p => p.id === "s3-archive");
    expect(redactedS3?.s3?.hasSecretAccessKey).toBe(true);
    expect("secretAccessKey" in (redactedS3?.s3 ?? {})).toBe(false);

    const storageJsonPath = join(home, "storage.json");
    if (process.platform !== "win32") {
      expect((await stat(storageJsonPath)).mode & 0o777).toBe(0o600);
    }
    const rawOnDisk1 = JSON.parse(await readFile(storageJsonPath, "utf8")) as {
      profiles: Array<{ id: string; s3?: { secretAccessKey?: string } }>;
    };
    expect(rawOnDisk1.profiles.find(p => p.id === "s3-archive")?.s3?.secretAccessKey).toBe(
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    );

    // Update again passing SECRET_MASK: saved secretAccessKey must be preserved!
    const updated2 = await udsClient.call("storage/update", {
      profiles: [
        {
          id: "local-default",
          name: "Local Ring",
          kind: "local",
          maxBytes: 10 * 1024 * 1024 * 1024,
        },
        {
          id: "ext-ssd",
          name: "External SSD",
          kind: "directory",
          directory: { path: extMountDir },
        },
        {
          id: "s3-archive",
          name: "Local Mock S3 Renamed",
          kind: "s3",
          s3: {
            endpoint: mockS3.endpoint,
            region: "us-east-1",
            bucket: "ludens-bucket",
            prefix: "archive",
            accessKeyId: "AKIAIOSFODNN7EXAMPLE",
            secretAccessKey: SECRET_MASK,
            forcePathStyle: true,
          },
        },
      ],
    });
    expect(updated2.config.profiles.find(p => p.id === "s3-archive")?.name).toBe("Local Mock S3 Renamed");
    const rawOnDisk2 = JSON.parse(await readFile(storageJsonPath, "utf8")) as {
      profiles: Array<{ id: string; s3?: { secretAccessKey?: string } }>;
    };
    expect(rawOnDisk2.profiles.find(p => p.id === "s3-archive")?.s3?.secretAccessKey).toBe(
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    );

    // 4. Test storage/test for directory and S3 (using saved secret via profileId + SECRET_MASK)
    const badDirProbe = await udsClient.call("storage/test", {
      kind: "directory",
      directory: { path: "relative/not-allowed" },
    });
    expect(badDirProbe.ok).toBe(false);

    const goodDirProbe = await udsClient.call("storage/test", {
      kind: "directory",
      directory: { path: extMountDir },
    });
    expect(goodDirProbe.ok).toBe(true);
    expect(goodDirProbe.latencyMs).toBeGreaterThanOrEqual(0);
    const leftoverProbes = (await readdir(extMountDir)).filter(name => name.startsWith("__ludens_probe_"));
    expect(leftoverProbes).toHaveLength(0);

    const s3Probe = await udsClient.call("storage/test", {
      kind: "s3",
      profileId: "s3-archive",
      s3: {
        endpoint: mockS3.endpoint,
        region: "us-east-1",
        bucket: "ludens-bucket",
        prefix: "archive",
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: SECRET_MASK,
        forcePathStyle: true,
      },
    });
    expect(s3Probe.ok).toBe(true);
    expect(mockS3.requests.some(r => r.method === "PUT" && r.pathname.includes("__ludens_probe_"))).toBe(true);
    expect(mockS3.requests.some(r => r.method === "DELETE" && r.pathname.includes("__ludens_probe_"))).toBe(true);

    // 5. Test storage/pin & ludens.json storage override persistence
    let badPinError: unknown = null;
    try {
      await udsClient.call("storage/pin", {
        workspaceId: identity.id,
        asset: "foo/bar.txt",
        pinned: true,
      });
    } catch (err) {
      badPinError = err;
    }
    expect(badPinError).toBeInstanceOf(AppRpcClientError);
    expect((badPinError as AppRpcClientError).code).toBe(APP_RPC_ERROR_CODES.INVALID_PARAMS);

    const pin1 = await udsClient.call("storage/pin", {
      workspaceId: identity.id,
      asset: "video/seg-local.mp4",
      pinned: true,
    });
    expect(pin1.pins).toEqual(["video/seg-local.mp4"]);

    await udsClient.call("workspaces/mutate", {
      action: "updateStudioConfig",
      workspaceId: identity.id,
      patch: {
        storage: {
          mode: "profile",
          profileId: "s3-archive",
          videoQuality: "compact",
        },
      },
    });
    const studioSnap = (await udsClient.call("workspaces/getStudio", { workspaceId: identity.id })) as {
      config?: { storage?: unknown } | null;
    };
    expect(studioSnap.config?.storage).toEqual({
      mode: "profile",
      profileId: "s3-archive",
      videoQuality: "compact",
    });
    const ludensJsonRaw = JSON.parse(await readFile(join(wsDir, "ludens.json"), "utf8")) as Record<string, unknown>;
    expect(ludensJsonRaw.storage).toEqual({
      mode: "profile",
      profileId: "s3-archive",
      videoQuality: "compact",
    });

    const afterPinAndOverride = await udsClient.call("storage/get", {});
    expect(afterPinAndOverride.usage[0]?.pinnedSegments).toBe(1);
    expect(afterPinAndOverride.usage[0]?.effectiveKind).toBe("s3");
    expect(afterPinAndOverride.usage[0]?.effectiveProfileId).toBe("s3-archive");

    // Unpin & clear override
    const pin2 = await udsClient.call("storage/pin", {
      workspaceId: identity.id,
      asset: "video/seg-local.mp4",
      pinned: false,
    });
    expect(pin2.pins).toEqual([]);

    // 6. Test replay frames window + UDS media/resolve + HTTP /media zero-CORS Range streaming
    const framesWin = (await udsClient.call("replay/get", {
      project: identity.id,
      run: runId,
      query: { mode: "frames", epoch: "ep-1", start: t0, end: t0 + 1000 },
    })) as {
      frames: Array<{ id: string; sequence: number; media: Array<{ video?: { status: string; revision: string; reason?: string } }> }>;
    };
    expect(framesWin.frames).toHaveLength(5);
    const evictedFrame = framesWin.frames.find(f => f.id === "rec-evicted");
    expect(evictedFrame?.media[0]?.video?.status).toBe("error");
    expect(evictedFrame?.media[0]?.video?.revision).toBe("evicted");
    expect(evictedFrame?.media[0]?.video?.reason).toContain("回收");

    // UDS media/resolve for S3 returns presigned remoteUrl; WS media/resolve is rejected
    const udsResolvedS3 = await udsClient.call("media/resolve", {
      kind: "replay",
      project: identity.id,
      run: runId,
      epoch: "ep-1",
      mode: "segment",
      record: "rec-s3",
      sequence: 4,
      media: 0,
    });
    expect("remoteUrl" in udsResolvedS3 && udsResolvedS3.remoteUrl.includes("X-Amz-Signature=")).toBe(true);
    let wsResolveErr: unknown = null;
    try {
      await wsClient.call("media/resolve", {
        kind: "replay",
        project: identity.id,
        run: runId,
        epoch: "ep-1",
        mode: "segment",
        record: "rec-s3",
        sequence: 4,
        media: 0,
      });
    } catch (err) {
      wsResolveErr = err;
    }
    expect(wsResolveErr).toBeTruthy();
    expect(String(wsResolveErr)).toContain("restricted to local UDS");

    const baseHttpUrl = appServer.url!;
    const makeSegmentHttpUrl = (record: string, sequence: number) =>
      `${baseHttpUrl}/media?kind=replay&project=${encodeURIComponent(identity.id)}&run=${encodeURIComponent(runId)}&epoch=ep-1&mode=segment&record=${record}&sequence=${sequence}&media=0&mt=${encodeURIComponent(mediaTicket)}`;

    // 6a. S3 full 200 + 206 Partial Content + HEAD + 416 Range via HTTP /media proxy
    const s3FullRes = await fetch(makeSegmentHttpUrl("rec-s3", 4), {
      headers: { Origin: "http://example.console.local" },
    });
    expect(s3FullRes.status).toBe(200);
    expect(s3FullRes.headers.get("Content-Type")).toBe("video/mp4");
    expect(s3FullRes.headers.get("Accept-Ranges")).toBe("bytes");
    expect(s3FullRes.headers.get("Access-Control-Allow-Origin")).toBe("http://example.console.local");
    expect(Buffer.from(await s3FullRes.arrayBuffer())).toEqual(s3Clip);

    const s3RangeRes = await fetch(makeSegmentHttpUrl("rec-s3", 4), {
      headers: { Range: "bytes=9-25" },
    });
    expect(s3RangeRes.status).toBe(206);
    expect(s3RangeRes.headers.get("Content-Range")).toBe(`bytes 9-25/${s3Clip.byteLength}`);
    expect(s3RangeRes.headers.get("Content-Length")).toBe("17");
    expect(Buffer.from(await s3RangeRes.arrayBuffer()).toString()).toBe("SEGMENT_012345678");

    const s3HeadRes = await fetch(makeSegmentHttpUrl("rec-s3", 4), {
      method: "HEAD",
      headers: { Range: "bytes=0-8" },
    });
    expect(s3HeadRes.status).toBe(206);
    expect(s3HeadRes.headers.get("Content-Length")).toBe("9");
    expect(await s3HeadRes.text()).toBe("");

    const s3BadRangeRes = await fetch(makeSegmentHttpUrl("rec-s3", 4), {
      headers: { Range: "bytes=9999-10000" },
    });
    expect(s3BadRangeRes.status).toBe(416);

    // 6b. Local pull-through cache streaming
    const cacheRangeRes = await fetch(makeSegmentHttpUrl("rec-cache", 2), {
      headers: { Range: "bytes=0-11" },
    });
    expect(cacheRangeRes.status).toBe(206);
    expect(Buffer.from(await cacheRangeRes.arrayBuffer()).toString()).toBe("CACHED_VIDEO");

    // 6c. External directory streaming + 503 when unmounted
    const dirRangeRes = await fetch(makeSegmentHttpUrl("rec-dir", 3), {
      headers: { Range: "bytes=0-17" },
    });
    expect(dirRangeRes.status).toBe(206);
    expect(Buffer.from(await dirRangeRes.arrayBuffer()).toString()).toBe("EXTERNAL_DIRECTORY");

    await rm(extMountDir, { recursive: true, force: true });
    const unmountedDirRes = await fetch(makeSegmentHttpUrl("rec-dir", 3));
    expect(unmountedDirRes.status).toBe(503);
    const unmountedJson = (await unmountedDirRes.json()) as { error: string };
    expect(unmountedJson.error).toContain("外置存储目录当前不可用");

    // 6d. Evicted segment returns 410 Gone
    const evictedRes = await fetch(makeSegmentHttpUrl("rec-evicted", 5));
    expect(evictedRes.status).toBe(410);
    const evictedJson = (await evictedRes.json()) as { error: string };
    expect(evictedJson.error).toContain("回收");

    // Verify storage events were published over EventHub
    await Bun.sleep(50);
    expect(storageEvents.length).toBeGreaterThanOrEqual(3);
  } finally {
    wsClient?.close();
    udsClient?.close();
    await appServer?.close({ emergency: true }).catch(() => {});
    mockS3.stop();
    await rm(rootDir, { recursive: true, force: true });
  }
}, 25_000);

test("maintainStorage forwards to online workspace host and transport dispatches perception maintain", async () => {
  const rootDir = await realpath(await mkdtemp(join(tmpdir(), "ludens-storage-maintain-")));
  const home = join(rootDir, "home");
  const wsDir = join(rootDir, "ws-online");

  try {
    await mkdir(wsDir, { recursive: true });
    await writeFile(join(wsDir, "ludens.json"), JSON.stringify({ driver: "cua" }), "utf8");
    const identity = await ensureWorkspaceIdentity(wsDir);
    await registerWorkspace(wsDir, home);

    const seenModes: string[] = [];
    const fakeRuntime = new Runtime(undefined, () => {});
    fakeRuntime.attach({
      perception: {
        maintainStorage: async (mode: "sync" | "prune" | "clear_cache") => {
          seenModes.push(mode);
          return {
            freedBytes: 4096,
            archivedCount: 2,
            evictedCount: 1,
            errors: [],
          };
        },
      } as unknown as PerceptionRuntime,
    });

    const dispatched = (await dispatchTransport(fakeRuntime, {
      kind: "perception",
      argv: ["maintain", "sync"],
    })) as { freedBytes: number; archivedCount: number; evictedCount: number; errors: string[] };
    expect(dispatched).toEqual({
      freedBytes: 4096,
      archivedCount: 2,
      evictedCount: 1,
      errors: [],
    });
    expect(seenModes).toEqual(["sync"]);

    const res = await maintainStorage(
      { action: "prune", workspaceId: identity.id },
      home,
      async (ws, action) => {
        expect(ws.workspaceId).toBe(identity.id);
        expect(action).toBe("prune");
        return { freedBytes: 8192, archivedCount: 0, evictedCount: 3, errors: [] };
      },
    );
    expect(res.ok).toBe(true);
    expect(res.action).toBe("prune");
    expect(res.freedBytes).toBe(8192);
    expect(res.evictedCount).toBe(3);
    expect(res.errors).toEqual([]);
    expect(res.usage).toHaveLength(1);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("storage/maintain RPC executes offline Python _storage CLI end-to-end (sync to mock S3 + clear_cache)", async () => {
  const rootDir = await realpath(await mkdtemp(join(tmpdir(), "ludens-storage-e2e-cli-")));
  const home = join(rootDir, "home");
  const wsDir = join(rootDir, "ws-e2e");
  const mockS3 = startMockS3Server();
  let appServer: Awaited<ReturnType<typeof startAppServer>> | undefined;
  let udsClient: NodeUdsRpcClient | undefined;

  try {
    await mkdir(join(wsDir, ".ludens", "timeline", "video"), { recursive: true });
    await writeFile(
      join(wsDir, "ludens.json"),
      JSON.stringify({
        driver: "cua",
        storage: { mode: "profile", profileId: "s3-e2e" },
      }),
      "utf8",
    );
    const identity = await ensureWorkspaceIdentity(wsDir);
    await registerWorkspace(wsDir, home);

    const clipBytes = Buffer.from("REAL_OFFLINE_SYNC_MP4_BYTES_0123456789");
    await writeFile(join(wsDir, ".ludens", "timeline", "video", "clip-sync.mp4"), clipBytes);
    await writeFile(
      join(wsDir, ".ludens", "timeline", "video", "clip-sync.mp4.json"),
      JSON.stringify({ status: "ready", durationSeconds: 4 }),
      "utf8",
    );

    appServer = await startAppServer({ home });
    udsClient = new NodeUdsRpcClient({ socketPath: appServer.socketPath! });
    await udsClient.initialize({ clientInfo: { name: "e2e-cli", version: "1.0.0" } });

    await udsClient.call("storage/update", {
      profiles: [
        {
          id: "local-default",
          name: "Local Default",
          kind: "local",
          maxBytes: 20 * 1024 * 1024 * 1024,
        },
        {
          id: "s3-e2e",
          name: "E2E Mock S3",
          kind: "s3",
          s3: {
            endpoint: mockS3.endpoint,
            region: "us-east-1",
            bucket: "e2e-bucket",
            prefix: "cold",
            accessKeyId: "AKIAEXAMPLE",
            secretAccessKey: "SECRETEXAMPLE123",
            forcePathStyle: true,
          },
        },
      ],
    });

    const syncRes = await udsClient.call("storage/maintain", {
      action: "sync",
      workspaceId: identity.id,
    });
    expect(syncRes.ok).toBe(true);
    expect(syncRes.errors).toEqual([]);
    expect(syncRes.archivedCount).toBe(1);
    expect(syncRes.usage[0]?.archivedSegments).toBe(1);
    expect(mockS3.objects.get(`e2e-bucket/cold/${identity.id}/video/clip-sync.mp4`)).toEqual(
      new Uint8Array(clipBytes),
    );

    const clearRes = await udsClient.call("storage/maintain", {
      action: "clear_cache",
      workspaceId: identity.id,
    });
    expect(clearRes.ok).toBe(true);
    expect(clearRes.errors).toEqual([]);
    expect(clearRes.freedBytes).toBe(clipBytes.byteLength);
    expect(clearRes.usage[0]?.localVideoSegments).toBe(0);
    expect(clearRes.usage[0]?.archivedSegments).toBe(1);
  } finally {
    await udsClient?.close();
    await appServer?.close({ emergency: true }).catch(() => {});
    mockS3.stop();
    await rm(rootDir, { recursive: true, force: true });
  }
}, 20_000);

