import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { listRegisteredWorkspaces, withWorkspaceRegistrationLock } from "@ludens/protocol/ludens";
import { pythonCommand, pythonExecutable } from "@ludens/protocol/python";
import { presignS3Url, s3ProbeConnectivity } from "@ludens/protocol/s3-sigv4";
import {
  SECRET_MASK,
  mergeGlobalStorageUpdate,
  readGlobalStorageConfig,
  readTimelinePins,
  redactGlobalStorageConfig,
  resolveEffectiveWorkspaceStorage,
  updateGlobalStorageConfig,
  validTimelinePinAsset,
  writeTimelinePins,
  type GlobalStorageConfig,
  type GlobalStorageUpdateInput,
  type RedactedGlobalStorageConfig,
  type S3BackendConfig,
  type StorageMaintainParams,
  type StorageMaintainResult,
  type StoragePinParams,
  type StoragePinResult,
  type StorageTestParams,
  type StorageTestResult,
  type TimelineArchiveLocation,
  type WorkspaceStorageUsageSummary,
} from "@ludens/protocol/storage";
import { send } from "../../daemon/transport";
import { resolveWorkspaceAddress } from "../storage/workspace-state";
import { pythonModulePaths } from "../subsystems/python-capabilities";
import { globalHome, workspaceForProject } from "./data";
import { timelinePath } from "./timeline-record";

const STAT_CONCURRENCY = 32;

async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) break;
      results[index] = await worker(items[index]!);
    }
  });
  await Promise.all(runners);
  return results;
}

/** Recursively sum regular file bytes in a directory tree with bounded concurrency, never following symlinks. */
async function sumDirectoryBytes(rootDir: string): Promise<number> {
  let total = 0;
  const queue: string[] = [rootDir];
  while (queue.length > 0) {
    const batch = queue.splice(0, 8);
    await Promise.all(
      batch.map(async dir => {
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        const files: string[] = [];
        for (const entry of entries) {
          if (entry.isSymbolicLink()) continue;
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            queue.push(full);
          } else if (entry.isFile()) {
            files.push(full);
          }
        }
        if (files.length > 0) {
          const sizes = await mapConcurrent(files, STAT_CONCURRENCY, async filePath => {
            const info = await lstat(filePath).catch(() => null);
            return info && info.isFile() && !info.isSymbolicLink() ? info.size : 0;
          });
          for (const size of sizes) total += size;
        }
      }),
    );
  }
  return total;
}

interface VideoDirectoryScan {
  localVideoBytes: number;
  localVideoSegments: number;
  archivedSegments: number;
  archivedBytes: number;
  evictedSegments: number;
}

async function scanVideoDirectory(videoDir: string): Promise<VideoDirectoryScan> {
  const entries = await readdir(videoDir, { withFileTypes: true }).catch(() => []);
  const mp4Files: string[] = [];
  const sidecarFiles: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    if (entry.name.endsWith(".mp4")) {
      mp4Files.push(join(videoDir, entry.name));
    } else if (entry.name.endsWith(".mp4.json")) {
      sidecarFiles.push(join(videoDir, entry.name));
    }
  }

  const [mp4Sizes, sidecarStats] = await Promise.all([
    mapConcurrent(mp4Files, STAT_CONCURRENCY, async filePath => {
      const info = await lstat(filePath).catch(() => null);
      return info && info.isFile() && !info.isSymbolicLink() ? info.size : null;
    }),
    mapConcurrent(sidecarFiles, STAT_CONCURRENCY, async filePath => {
      try {
        const raw = JSON.parse(await readFile(filePath, "utf8")) as {
          status?: unknown;
          archive?: { bytes?: unknown } | null;
        };
        const hasArchive = Boolean(raw && raw.archive && typeof raw.archive === "object");
        const archiveBytes =
          hasArchive && typeof raw.archive?.bytes === "number" && Number.isFinite(raw.archive.bytes) && raw.archive.bytes > 0
            ? raw.archive.bytes
            : 0;
        const evicted = raw?.status === "evicted";
        return { hasArchive, archiveBytes, evicted };
      } catch {
        return { hasArchive: false, archiveBytes: 0, evicted: false };
      }
    }),
  ]);

  let localVideoBytes = 0;
  let localVideoSegments = 0;
  for (const size of mp4Sizes) {
    if (size !== null) {
      localVideoBytes += size;
      localVideoSegments += 1;
    }
  }

  let archivedSegments = 0;
  let archivedBytes = 0;
  let evictedSegments = 0;
  for (const item of sidecarStats) {
    if (item.hasArchive) {
      archivedSegments += 1;
      archivedBytes += item.archiveBytes;
    }
    if (item.evicted) {
      evictedSegments += 1;
    }
  }

  return {
    localVideoBytes,
    localVideoSegments,
    archivedSegments,
    archivedBytes,
    evictedSegments,
  };
}

async function scanObjectsDirectory(objectsDir: string): Promise<number> {
  const entries = await readdir(objectsDir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || entry.name.endsWith(".json")) continue;
    files.push(join(objectsDir, entry.name));
  }
  const sizes = await mapConcurrent(files, STAT_CONCURRENCY, async filePath => {
    const info = await lstat(filePath).catch(() => null);
    return info && info.isFile() && !info.isSymbolicLink() ? info.size : 0;
  });
  let total = 0;
  for (const s of sizes) total += s;
  return total;
}

function fallbackEffectiveFromGlobal(
  cfg: GlobalStorageConfig,
  workspaceId: string,
  workspacePath: string,
) {
  const profile =
    cfg.profiles.find(item => item.id === cfg.defaultProfileId) ??
    cfg.profiles[0] ?? {
      id: "local-default",
      name: "Local Default",
      kind: "local" as const,
      maxBytes: 20 * 1024 * 1024 * 1024,
    };
  return {
    workspaceId,
    workspacePath,
    kind: profile.kind,
    profileId: profile.id,
    profileName: profile.name,
    maxBytes: profile.maxBytes ?? null,
  };
}

async function scanWorkspaceStorageUsage(
  entry: { id: string; name: string; workspace: string; available: boolean },
  cfg: GlobalStorageConfig,
  home: string,
): Promise<WorkspaceStorageUsageSummary> {
  const effective = entry.available
    ? await resolveEffectiveWorkspaceStorage(entry.workspace, home).catch(() =>
        fallbackEffectiveFromGlobal(cfg, entry.id, entry.workspace),
      )
    : fallbackEffectiveFromGlobal(cfg, entry.id, entry.workspace);

  if (!entry.available) {
    return {
      workspaceId: entry.id,
      workspaceName: entry.name,
      workspacePath: entry.workspace,
      available: false,
      effectiveKind: effective.kind,
      effectiveProfileId: effective.profileId,
      effectiveProfileName: effective.profileName,
      maxBytes: effective.maxBytes,
      localVideoBytes: 0,
      localVideoSegments: 0,
      localCacheBytes: 0,
      localObjectsBytes: 0,
      segmentsIndexBytes: 0,
      logsBytes: 0,
      totalLocalBytes: 0,
      archivedSegments: 0,
      archivedBytes: 0,
      evictedSegments: 0,
      pinnedSegments: 0,
    };
  }

  const timelineRoot = join(entry.workspace, ".ludens", "timeline");
  const [videoScan, localCacheBytes, localObjectsBytes, segmentsIndexBytes, logsBytes, pins] =
    await Promise.all([
      scanVideoDirectory(join(timelineRoot, "video")),
      sumDirectoryBytes(join(timelineRoot, "cache")),
      scanObjectsDirectory(join(timelineRoot, "objects")),
      sumDirectoryBytes(join(timelineRoot, "segments")),
      sumDirectoryBytes(join(entry.workspace, "logs")),
      readTimelinePins(timelineRoot).catch(() => [] as string[]),
    ]);

  const totalLocalBytes =
    videoScan.localVideoBytes +
    localCacheBytes +
    localObjectsBytes +
    segmentsIndexBytes +
    logsBytes;

  return {
    workspaceId: entry.id,
    workspaceName: entry.name,
    workspacePath: entry.workspace,
    available: true,
    effectiveKind: effective.kind,
    effectiveProfileId: effective.profileId,
    effectiveProfileName: effective.profileName,
    maxBytes: effective.maxBytes,
    localVideoBytes: videoScan.localVideoBytes,
    localVideoSegments: videoScan.localVideoSegments,
    localCacheBytes,
    localObjectsBytes,
    segmentsIndexBytes,
    logsBytes,
    totalLocalBytes,
    archivedSegments: videoScan.archivedSegments,
    archivedBytes: videoScan.archivedBytes,
    evictedSegments: videoScan.evictedSegments,
    pinnedSegments: pins.length,
  };
}

export async function getStorageOverview(
  home = globalHome,
): Promise<{ config: RedactedGlobalStorageConfig; usage: WorkspaceStorageUsageSummary[] }> {
  const [cfg, workspaces] = await Promise.all([
    readGlobalStorageConfig(home),
    listRegisteredWorkspaces(home),
  ]);
  const usage = await Promise.all(
    workspaces.map(entry => scanWorkspaceStorageUsage(entry, cfg, home)),
  );
  return {
    config: redactGlobalStorageConfig(cfg),
    usage,
  };
}

export async function updateStorageSettings(
  input: GlobalStorageUpdateInput,
  home = globalHome,
): Promise<{ config: RedactedGlobalStorageConfig; usage: WorkspaceStorageUsageSummary[] }> {
  const updated = await updateGlobalStorageConfig(
    current => mergeGlobalStorageUpdate(current, input),
    home,
  );
  const workspaces = await listRegisteredWorkspaces(home);
  const usage = await Promise.all(
    workspaces.map(entry => scanWorkspaceStorageUsage(entry, updated, home)),
  );
  return {
    config: redactGlobalStorageConfig(updated),
    usage,
  };
}

export async function testStorageBackend(
  params: StorageTestParams,
  home = globalHome,
  signal?: AbortSignal,
): Promise<StorageTestResult> {
  const started = performance.now();
  const elapsed = () => Math.max(0, Math.round(performance.now() - started));

  try {
    if (params.kind === "directory") {
      let rawPath = params.directory?.path?.trim() ?? "";
      if (!rawPath && params.profileId) {
        const cfg = await readGlobalStorageConfig(home);
        rawPath = cfg.profiles.find(item => item.id === params.profileId)?.directory?.path?.trim() ?? "";
      }
      if (!rawPath || !isAbsolute(rawPath)) {
        return {
          ok: false,
          latencyMs: elapsed(),
          error: "外置存储目录必须是完整的绝对路径 (Directory path must be an absolute path)",
        };
      }
      const targetDir = resolve(rawPath);
      await mkdir(targetDir, { recursive: true });
      const probeName = `__ludens_probe_${randomUUID()}`;
      const probePath = join(targetDir, probeName);
      const probeContent = `ludens-storage-probe:${probeName}\n`;
      try {
        await writeFile(probePath, probeContent, { encoding: "utf8", mode: 0o600, signal });
        const verify = await readFile(probePath, { encoding: "utf8", signal });
        if (verify !== probeContent) {
          throw new Error("Directory probe read-back verification mismatch");
        }
      } finally {
        await unlink(probePath).catch(() => {});
      }
      return {
        ok: true,
        latencyMs: elapsed(),
        detail: `Read/write/delete probe succeeded (${targetDir})`,
      };
    }

    if (params.kind === "s3") {
      const cfg = await readGlobalStorageConfig(home);
      const savedProfile = params.profileId
        ? cfg.profiles.find(item => item.id === params.profileId && item.kind === "s3")
        : undefined;
      const inputS3 = params.s3;
      const endpoint = inputS3?.endpoint?.trim() || savedProfile?.s3?.endpoint?.trim() || "";
      const region = inputS3?.region?.trim() || savedProfile?.s3?.region?.trim() || "";
      const bucket = inputS3?.bucket?.trim() || savedProfile?.s3?.bucket?.trim() || "";
      const prefix =
        inputS3 !== undefined
          ? inputS3.prefix?.trim() || undefined
          : savedProfile?.s3?.prefix?.trim() || undefined;
      const accessKeyId = inputS3?.accessKeyId?.trim() || savedProfile?.s3?.accessKeyId?.trim() || "";
      const rawSecret = inputS3?.secretAccessKey;
      const secretAccessKey =
        rawSecret && rawSecret !== SECRET_MASK
          ? rawSecret
          : savedProfile?.s3?.secretAccessKey ?? "";
      const forcePathStyle =
        inputS3?.forcePathStyle !== undefined
          ? Boolean(inputS3.forcePathStyle)
          : savedProfile?.s3?.forcePathStyle;

      if (!endpoint || !region || !bucket || !accessKeyId || !secretAccessKey) {
        return {
          ok: false,
          latencyMs: elapsed(),
          error: "请完整填写 S3 Endpoint、Region、Bucket、AccessKeyId 与 SecretAccessKey",
        };
      }

      const fullS3: S3BackendConfig = {
        endpoint,
        region,
        bucket,
        ...(prefix ? { prefix } : {}),
        accessKeyId,
        secretAccessKey,
        ...(forcePathStyle !== undefined ? { forcePathStyle } : {}),
      };
      const probe = await s3ProbeConnectivity(fullS3, signal);
      return {
        ok: true,
        latencyMs: elapsed(),
        detail: probe.detail,
      };
    }

    return {
      ok: false,
      latencyMs: elapsed(),
      error: `Unsupported storage backend kind: ${String((params as { kind?: unknown }).kind)}`,
    };
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    return {
      ok: false,
      latencyMs: elapsed(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface OnlineMaintainOutcome {
  freedBytes?: number;
  archivedCount?: number;
  evictedCount?: number;
  errors?: string[];
}

export type OnlineMaintainForwarder = (
  workspace: { workspaceId: string; workspacePath: string },
  action: StorageMaintainParams["action"],
  signal?: AbortSignal,
) => Promise<OnlineMaintainOutcome | null>;

function isOfflineHostError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return (
    code === "ENOENT" ||
    code === "ECONNREFUSED" ||
    code === "EPIPE" ||
    message.includes("ENOENT") ||
    message.includes("ECONNREFUSED") ||
    message.includes("Host disconnected") ||
    message.includes("Perception is not configured") ||
    message.includes("Perception worker is unavailable") ||
    message.includes("Workspace timeline has not started")
  );
}

async function defaultOnlineMaintainForwarder(
  workspace: { workspaceId: string; workspacePath: string },
  action: StorageMaintainParams["action"],
): Promise<OnlineMaintainOutcome | null> {
  try {
    const { socket } = await resolveWorkspaceAddress(workspace.workspacePath);
    const result = await send(socket, { kind: "perception", argv: ["maintain", action] });
    if (result && typeof result === "object") {
      return result as OnlineMaintainOutcome;
    }
    return {};
  } catch (error) {
    if (isOfflineHostError(error)) return null;
    throw error;
  }
}

async function runOfflineStorageCli(
  workspacePath: string,
  action: StorageMaintainParams["action"],
  home: string,
  signal?: AbortSignal,
): Promise<OnlineMaintainOutcome> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LUDENS_HOME: resolve(home),
  };
  env.PYTHONPATH = [
    ...pythonModulePaths(),
    ...(env.PYTHONPATH ? [env.PYTHONPATH] : []),
  ].join(delimiter);
  const cmd = pythonCommand(pythonExecutable(env), [
    "-m",
    "ludens_tools._storage",
    "--workspace",
    workspacePath,
    "--action",
    action,
  ]);

  return new Promise<OnlineMaintainOutcome>((resolvePromise, rejectPromise) => {
    const child = spawn(cmd.file, cmd.args, {
      cwd: workspacePath,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: cmd.windowsVerbatimArguments,
    });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, 120_000);
    const onAbort = () => {
      try {
        child.kill("SIGKILL");
      } catch {}
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", chunk => outChunks.push(chunk));
    child.stderr.on("data", chunk => errChunks.push(chunk));
    child.once("error", err => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      rejectPromise(err);
    });
    child.once("close", code => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) {
        rejectPromise(signal.reason ?? new DOMException("Aborted", "AbortError"));
        return;
      }
      const stdout = Buffer.concat(outChunks).toString("utf8").trim();
      const stderr = Buffer.concat(errChunks).toString("utf8").trim();
      if (code !== 0) {
        rejectPromise(
          new Error(stderr || stdout || `ludens_tools._storage exited with status ${code}`),
        );
        return;
      }
      if (!stdout) {
        resolvePromise({});
        return;
      }
      try {
        const lines = stdout.split(/\r?\n/).filter(Boolean);
        const parsed = JSON.parse(lines.at(-1)!) as OnlineMaintainOutcome;
        resolvePromise(parsed);
      } catch (parseErr) {
        rejectPromise(
          new Error(`Invalid JSON from ludens_tools._storage: ${stdout.slice(0, 240)} (${String(parseErr)})`),
        );
      }
    });
  });
}

export async function maintainStorage(
  params: StorageMaintainParams,
  home = globalHome,
  onlineForwarder: OnlineMaintainForwarder = defaultOnlineMaintainForwarder,
  signal?: AbortSignal,
): Promise<StorageMaintainResult> {
  if (params.action !== "prune" && params.action !== "sync" && params.action !== "clear_cache") {
    throw Object.assign(new Error(`Invalid storage maintain action: ${String(params.action)}`), {
      status: 400,
    });
  }

  const registered = await listRegisteredWorkspaces(home);
  let targets = registered;
  if (params.workspaceId !== undefined) {
    const found = registered.find(item => item.id === params.workspaceId);
    if (!found) {
      throw Object.assign(new Error(`未找到工作区：${params.workspaceId}`), { status: 404 });
    }
    targets = [found];
  } else {
    targets = registered.filter(item => item.available);
  }

  let freedBytes = 0;
  let archivedCount = 0;
  let evictedCount = 0;
  const errors: Array<{ workspaceId: string; error: string }> = [];

  for (const entry of targets) {
    signal?.throwIfAborted();
    if (!entry.available) {
      errors.push({ workspaceId: entry.id, error: "工作区目录当前不可用" });
      continue;
    }
    const canonicalPath = await realpath(entry.workspace).catch(() => resolve(entry.workspace));
    const wsTarget = { workspaceId: entry.id, workspacePath: canonicalPath };
    try {
      let outcome = await onlineForwarder(wsTarget, params.action, signal);
      if (outcome === null) {
        try {
          outcome = await runOfflineStorageCli(canonicalPath, params.action, home, signal);
        } catch (cliError) {
          const msg = cliError instanceof Error ? cliError.message : String(cliError);
          if (msg.includes("writer") || msg.includes("busy") || msg.includes("lock")) {
            const retried = await onlineForwarder(wsTarget, params.action, signal);
            if (retried !== null) outcome = retried;
            else throw cliError;
          } else {
            throw cliError;
          }
        }
      }
      if (typeof outcome.freedBytes === "number" && Number.isFinite(outcome.freedBytes)) {
        freedBytes += Math.max(0, outcome.freedBytes);
      }
      if (typeof outcome.archivedCount === "number" && Number.isFinite(outcome.archivedCount)) {
        archivedCount += Math.max(0, outcome.archivedCount);
      }
      if (typeof outcome.evictedCount === "number" && Number.isFinite(outcome.evictedCount)) {
        evictedCount += Math.max(0, outcome.evictedCount);
      }
      if (Array.isArray(outcome.errors)) {
        for (const errItem of outcome.errors) {
          errors.push({ workspaceId: entry.id, error: String(errItem) });
        }
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      errors.push({
        workspaceId: entry.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const { usage } = await getStorageOverview(home);
  return {
    ok: true,
    action: params.action,
    freedBytes,
    archivedCount,
    evictedCount,
    errors,
    usage,
  };
}

export async function pinTimelineSegment(
  params: StoragePinParams,
  home = globalHome,
): Promise<StoragePinResult> {
  if (typeof params.workspaceId !== "string" || !params.workspaceId.trim()) {
    throw Object.assign(new Error("请选择工作区"), { status: 400 });
  }
  const asset = typeof params.asset === "string" ? params.asset.trim() : "";
  if (!validTimelinePinAsset(asset)) {
    throw Object.assign(new Error("无效的时空轴媒体路径"), { status: 400 });
  }
  if (typeof params.pinned !== "boolean") {
    throw Object.assign(new Error("pinned 必须是布尔值"), { status: 400 });
  }
  const workspaceId = params.workspaceId.trim();
  return withWorkspaceRegistrationLock(home, workspaceId, async () => {
    const workspacePath = await workspaceForProject(workspaceId, home);
    const timelineRoot = join(workspacePath, ".ludens", "timeline");
    await mkdir(timelineRoot, { recursive: true });
    const existing = await readTimelinePins(timelineRoot);
    const nextSet = new Set(existing);
    if (params.pinned) nextSet.add(asset);
    else nextSet.delete(asset);
    const pins = await writeTimelinePins(timelineRoot, [...nextSet]);
    return {
      ok: true,
      workspaceId,
      pins,
    };
  });
}

export type ResolvedTimelineAssetLocation =
  | { kind: "file"; file: string }
  | { kind: "remote"; remoteUrl: string; size?: number }
  | { kind: "missing" };

function isValidArchiveKey(key: string): boolean {
  if (!key || key.startsWith("/") || key.includes("\\") || key.includes("\0")) return false;
  return key.split("/").every(part => part.length > 0 && part !== "." && part !== "..");
}

/**
 * Resolves a timeline asset (`video/<uuid>.mp4` or `objects/<sha256>.bin`) across:
 * 1) Local hot spool (`.ludens/timeline/<asset>`)
 * 2) Local pull-through LRU cache (`.ludens/timeline/cache/<asset>`)
 * 3) External `directory` archive (`503` if unmounted/missing)
 * 4) S3-compatible object storage archive (presigned `GET` URL for zero-CORS Range proxy)
 * Throws `410` if `status === "evicted"` without an active archive copy.
 */
export async function resolveStoredTimelineAsset(options: {
  timelineRoot: string;
  workspacePath: string;
  home: string;
  asset: string;
  status?: string;
  archive?: TimelineArchiveLocation;
  signal?: AbortSignal;
}): Promise<ResolvedTimelineAssetLocation> {
  const { timelineRoot, workspacePath, home, asset, signal } = options;

  // 1) Local hot spool
  const localFile = await timelinePath(timelineRoot, asset).catch(err => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  });
  if (localFile) {
    return { kind: "file", file: localFile };
  }

  // 2) Local pull-through LRU cache
  const cachedFile = await timelinePath(timelineRoot, `cache/${asset}`).catch(err => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  });
  if (cachedFile) {
    const now = new Date();
    void utimes(cachedFile, now, now).catch(() => {});
    return { kind: "file", file: cachedFile };
  }

  // 3) Inspect sidecar if status/archive were not pre-loaded by caller
  let effectiveStatus = options.status;
  let effectiveArchive = options.archive;
  if (effectiveStatus === undefined && effectiveArchive === undefined) {
    const sidecarPath = await timelinePath(timelineRoot, `${asset}.json`).catch(err => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    });
    if (sidecarPath) {
      try {
        const parsed = JSON.parse(await readFile(sidecarPath, { encoding: "utf8", signal })) as {
          status?: string;
          archive?: TimelineArchiveLocation;
        };
        effectiveStatus = parsed.status;
        if (parsed.archive && typeof parsed.archive === "object") {
          effectiveArchive = parsed.archive;
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
  }

  if (effectiveStatus === "evicted" && !effectiveArchive) {
    throw Object.assign(
      new Error("此视频片段已按存储配额策略自动回收 (Recorded video was evicted by storage policy)"),
      { status: 410, code: "MEDIA_EVICTED" },
    );
  }

  if (!effectiveArchive) {
    return { kind: "missing" };
  }

  if (effectiveArchive.backend === "directory") {
    if (!isValidArchiveKey(effectiveArchive.key)) {
      throw Object.assign(new Error("无效的外置归档路径键"), { status: 400 });
    }
    const cfg = await readGlobalStorageConfig(home);
    let dirPath = cfg.profiles.find(
      item => item.id === effectiveArchive!.profileId && item.kind === "directory",
    )?.directory?.path;
    if (!dirPath) {
      const wsEffective = await resolveEffectiveWorkspaceStorage(workspacePath, home).catch(() => null);
      dirPath = wsEffective?.directory?.path;
    }
    if (!dirPath || !isAbsolute(dirPath)) {
      throw Object.assign(new Error("外置存储目录当前不可用"), {
        status: 503,
        code: "STORAGE_UNAVAILABLE",
      });
    }
    const canonicalDir = await realpath(dirPath).catch(() => null);
    if (!canonicalDir) {
      throw Object.assign(new Error("外置存储目录当前不可用"), {
        status: 503,
        code: "STORAGE_UNAVAILABLE",
      });
    }
    const candidate = resolve(canonicalDir, ...effectiveArchive.key.split("/"));
    const relCandidate = relative(canonicalDir, candidate);
    if (!relCandidate || isAbsolute(relCandidate) || relCandidate === ".." || relCandidate.startsWith(`..${sep}`)) {
      throw Object.assign(new Error("外置归档文件路径越界"), { status: 403 });
    }
    const canonicalFile = await realpath(candidate).catch(() => null);
    if (!canonicalFile) {
      throw Object.assign(new Error("外置存储目录当前不可用"), {
        status: 503,
        code: "STORAGE_UNAVAILABLE",
      });
    }
    const relReal = relative(canonicalDir, canonicalFile);
    if (!relReal || isAbsolute(relReal) || relReal === ".." || relReal.startsWith(`..${sep}`)) {
      throw Object.assign(new Error("外置归档文件符号链接越界"), { status: 403 });
    }
    const info = await stat(canonicalFile).catch(() => null);
    if (!info || !info.isFile()) {
      throw Object.assign(new Error("外置存储目录当前不可用"), {
        status: 503,
        code: "STORAGE_UNAVAILABLE",
      });
    }
    return { kind: "file", file: canonicalFile };
  }

  if (effectiveArchive.backend === "s3") {
    const cfg = await readGlobalStorageConfig(home);
    let s3Cfg = cfg.profiles.find(
      item => item.id === effectiveArchive!.profileId && item.kind === "s3",
    )?.s3;
    if (!s3Cfg) {
      const wsEffective = await resolveEffectiveWorkspaceStorage(workspacePath, home).catch(() => null);
      s3Cfg = wsEffective?.s3;
    }
    if (!s3Cfg) {
      throw Object.assign(new Error("对象存储配置当前不可用"), {
        status: 503,
        code: "STORAGE_UNAVAILABLE",
      });
    }
    const remoteUrl = presignS3Url({
      method: "GET",
      config: s3Cfg,
      key: effectiveArchive.key,
      expiresSeconds: 3600,
    });
    return {
      kind: "remote",
      remoteUrl,
      ...(typeof effectiveArchive.bytes === "number" && effectiveArchive.bytes > 0
        ? { size: effectiveArchive.bytes }
        : {}),
    };
  }

  return { kind: "missing" };
}
