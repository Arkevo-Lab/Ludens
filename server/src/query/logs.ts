import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import type {
  LogsEventsParams,
  LogsEventsResult,
  LogsReadParams,
  LogsReadResult,
} from "@ludens/protocol/app-rpc";
import {
  listEventSourceFiles,
  matchesSourceEvent,
  type EventChannel,
  type EventSourceFile,
  type SourceDependency,
} from "@ludens/protocol/event-sources";
import { readRunLogArtifact } from "@ludens/core/cli/log-archive";
import { globalHome, workspaceForProject } from "./data";

const SAFE_RUN_ID = /^[a-zA-Z0-9._-]+$/;

function isSafeRunId(value: string): boolean {
  return SAFE_RUN_ID.test(value) && value !== "." && value !== "..";
}

async function resolveLogRunDir(
  params: { project?: string; workspace?: string; run: string },
  options: { allowHostPath: boolean; root?: string },
): Promise<string> {
  const run = typeof params.run === "string" ? params.run.trim() : "";
  if (!run) {
    throw Object.assign(new Error("Missing or invalid string parameter: run"), { status: 400 });
  }
  const root = options.root ?? globalHome;
  const project = typeof params.project === "string" && params.project.trim() ? params.project.trim() : undefined;

  if (project && isSafeRunId(run)) {
    const workspace = await workspaceForProject(project, root);
    const logsRoot = await realpath(join(workspace, "logs")).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw Object.assign(new Error(`Run not found: ${run}`), { status: 404 });
      }
      throw error;
    });
    const runDir = await realpath(join(logsRoot, run)).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw Object.assign(new Error(`Run not found: ${run}`), { status: 404 });
      }
      throw error;
    });
    if (!runDir.startsWith(logsRoot + sep)) {
      throw Object.assign(new Error(`Run path escapes workspace logs: ${run}`), { status: 403 });
    }
    return runDir;
  }

  if (!options.allowHostPath) {
    throw Object.assign(
      new Error("Reading logs by arbitrary host path is restricted in remote sessions; specify project and run ID"),
      { status: 403, code: "CAPABILITY_RESTRICTED" },
    );
  }

  let candidate: string;
  if (isAbsolute(run) || run.includes("/") || run.includes("\\")) {
    candidate = params.workspace ? resolve(params.workspace, run) : resolve(run);
  } else if (params.workspace) {
    const logsCandidate = join(resolve(params.workspace), "logs", run);
    candidate = await realpath(logsCandidate).catch(() => resolve(params.workspace!, run));
  } else {
    candidate = resolve(run);
  }

  return realpath(candidate).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw Object.assign(new Error(`Run directory not found: ${run}`), { status: 404 });
    }
    throw error;
  });
}

export const DEFAULT_LOG_EVENTS_LIMIT = 200;
export const MAX_LOG_EVENTS_LIMIT = 1000;

interface LogHorizonGroup {
  files: { name: string; path: string; size: number }[];
  dependencies: SourceDependency[];
}

interface LogEventHorizon {
  id: string;
  localPath: string;
  localSize: number | null;
  groups: LogHorizonGroup[];
  createdAt: number;
  expiresAt: number;
  pendingCursors: number[];
  servedCursors: Set<number>;
  invalidated?: boolean;
}

const HORIZON_TTL_MS = 60_000;
const MAX_HORIZON_KEYS = 32;
const MAX_BUCKET_VERSIONS = 128;
const horizonCache = new Map<string, LogEventHorizon[]>();
const inFlightCaptures = new Map<string, Promise<LogEventHorizon>>();

export function clearLogEventHorizons(): void {
  horizonCache.clear();
  inFlightCaptures.clear();
}

async function* readEventFileBounded(
  path: string,
  size: number,
  signal?: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
  signal?.throwIfAborted();
  if (size <= 0) return;
  const stream = createReadStream(path, { encoding: "utf8", end: size - 1, signal });
  let pending = "";
  try {
    for await (const chunk of stream) {
      pending += chunk;
      let start = 0;
      let newline: number;
      while ((newline = pending.indexOf("\n", start)) !== -1) {
        signal?.throwIfAborted();
        const line = pending.slice(start, newline);
        start = newline + 1;
        if (line.trim()) yield JSON.parse(line) as Record<string, unknown>;
      }
      pending = pending.slice(start);
    }
  } finally {
    stream.destroy();
  }
}

async function captureLogHorizon(
  runDir: string,
  channel: EventChannel,
  ttlMs = HORIZON_TTL_MS,
  signal?: AbortSignal,
): Promise<LogEventHorizon> {
  signal?.throwIfAborted();
  let manifest: { eventSources?: SourceDependency[] } = {};
  try {
    manifest = JSON.parse(await readFile(join(runDir, "manifest.json"), { encoding: "utf8", signal }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const dependencies: SourceDependency[] = manifest.eventSources ?? [];
  if (!Array.isArray(dependencies)) {
    throw Object.assign(new Error("Invalid eventSources manifest"), { code: "EVENT_SOURCE_UNAVAILABLE" });
  }
  const sources = await Promise.all(dependencies.map(dependency => listEventSourceFiles(dependency, channel)));
  signal?.throwIfAborted();

  const localPath = join(runDir, channel === "events" ? "events.jsonl" : "diagnostics.jsonl");
  let localSize: number | null = null;
  try {
    localSize = (await stat(localPath)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const groupMap = new Map<string, { files: Map<string, EventSourceFile>; dependencies: SourceDependency[] }>();
  for (const [index, files] of sources.entries()) {
    const dependency = dependencies[index]!;
    const key = JSON.stringify([dependency.sourceId, dependency.root]);
    let group = groupMap.get(key);
    if (!group) {
      group = { files: new Map(), dependencies: [] };
      groupMap.set(key, group);
    }
    group.dependencies.push(dependency);
    for (const file of files) group.files.set(file.name, file);
  }

  const groups: LogHorizonGroup[] = [];
  for (const group of groupMap.values()) {
    const sortedFiles = [...group.files.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(file => ({ name: file.name, path: file.path, size: file.size }));
    groups.push({ files: sortedFiles, dependencies: group.dependencies });
  }

  const now = Date.now();
  return {
    id: randomUUID(),
    localPath,
    localSize,
    groups,
    createdAt: now,
    expiresAt: now + ttlMs,
    pendingCursors: [],
    servedCursors: new Set<number>(),
  };
}

async function captureLogHorizonDeduped(
  cacheKey: string,
  runDir: string,
  channel: EventChannel,
  ttlMs: number,
  signal?: AbortSignal,
): Promise<LogEventHorizon> {
  signal?.throwIfAborted();
  let pending = inFlightCaptures.get(cacheKey);
  if (!pending) {
    pending = captureLogHorizon(runDir, channel, ttlMs).finally(() => {
      if (inFlightCaptures.get(cacheKey) === pending) {
        inFlightCaptures.delete(cacheKey);
      }
    });
    inFlightCaptures.set(cacheKey, pending);
  }
  if (!signal) return pending;
  const result = await new Promise<LogEventHorizon>((resolvePromise, rejectPromise) => {
    const onAbort = () => rejectPromise(signal.reason ?? Object.assign(new Error("Aborted"), { name: "AbortError" }));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      val => {
        signal.removeEventListener("abort", onAbort);
        resolvePromise(val);
      },
      err => {
        signal.removeEventListener("abort", onAbort);
        rejectPromise(err);
      },
    );
  });
  signal.throwIfAborted();
  return result;
}

async function isHorizonIntact(horizon: LogEventHorizon): Promise<boolean> {
  if (horizon.localSize !== null) {
    const info = await stat(horizon.localPath).catch(() => null);
    if (!info || info.size < horizon.localSize) return false;
  }
  for (const group of horizon.groups) {
    for (const file of group.files) {
      const info = await stat(file.path).catch(() => null);
      if (!info || info.size < file.size) return false;
    }
  }
  return true;
}

async function* readHorizonEvents(
  horizon: LogEventHorizon,
  signal?: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
  signal?.throwIfAborted();
  const iterators: AsyncGenerator<Record<string, unknown>>[] = [];
  if (horizon.localSize !== null) {
    iterators.push(readEventFileBounded(horizon.localPath, horizon.localSize, signal));
  }
  for (const group of horizon.groups) {
    iterators.push(
      (async function* () {
        for (const file of group.files) {
          for await (const event of readEventFileBounded(file.path, file.size, signal)) {
            signal?.throwIfAborted();
            if (group.dependencies.some(dependency => matchesSourceEvent(event, dependency))) {
              yield event;
            }
          }
        }
      })(),
    );
  }
  const timestamp = (event: Record<string, unknown>) => {
    const origin = event.origin as { at?: string } | undefined;
    const raw = (typeof event.at === "string" ? event.at : undefined) ?? origin?.at;
    const value = raw ? Date.parse(raw) : Number.NaN;
    return Number.isFinite(value) ? value : 0;
  };
  try {
    const heads = await Promise.all(iterators.map(iterator => iterator.next()));
    while (true) {
      signal?.throwIfAborted();
      let selected = -1;
      for (let index = 0; index < heads.length; index++) {
        if (
          !heads[index]!.done &&
          (selected === -1 || timestamp(heads[index]!.value!) < timestamp(heads[selected]!.value!))
        ) {
          selected = index;
        }
      }
      if (selected === -1) break;
      yield heads[selected]!.value!;
      heads[selected] = await iterators[selected]!.next();
    }
  } finally {
    await Promise.all(iterators.map(iterator => iterator.return(undefined)));
  }
}

function storeBucket(key: string, bucket: LogEventHorizon[]): void {
  const now = Date.now();
  while (bucket.length > MAX_BUCKET_VERSIONS) {
    const deadIdx = bucket.findIndex(h => h.invalidated || h.expiresAt <= now);
    if (deadIdx >= 0) {
      bucket.splice(deadIdx, 1);
      continue;
    }
    const idleIdx = bucket.findIndex(h => h.pendingCursors.length === 0);
    if (idleIdx >= 0) {
      bucket.splice(idleIdx, 1);
      continue;
    }
    bucket.shift();
  }
  horizonCache.delete(key);
  horizonCache.set(key, bucket);
  while (horizonCache.size > MAX_HORIZON_KEYS) {
    const oldest = horizonCache.keys().next().value;
    if (oldest === undefined) break;
    horizonCache.delete(oldest);
  }
}

export async function queryRunLogEvents(
  params: LogsEventsParams,
  options: { allowHostPath: boolean; root?: string; signal?: AbortSignal; horizonTtlMs?: number } = { allowHostPath: true },
): Promise<LogsEventsResult> {
  options.signal?.throwIfAborted();
  const runDir = await resolveLogRunDir(params, options);
  options.signal?.throwIfAborted();
  const channel: EventChannel = params.channel === "diagnostics" ? "diagnostics" : "events";
  const ttlMs =
    typeof options.horizonTtlMs === "number" && Number.isFinite(options.horizonTtlMs) && options.horizonTtlMs > 0
      ? options.horizonTtlMs
      : HORIZON_TTL_MS;
  const cursor =
    typeof params.cursor === "number" && Number.isSafeInteger(params.cursor) && params.cursor >= 0
      ? params.cursor
      : 0;
  let limit = DEFAULT_LOG_EVENTS_LIMIT;
  if (params.limit !== undefined) {
    if (
      typeof params.limit !== "number" ||
      !Number.isSafeInteger(params.limit) ||
      params.limit < 1 ||
      params.limit > MAX_LOG_EVENTS_LIMIT
    ) {
      throw Object.assign(
        new Error(`limit must be an integer between 1 and ${MAX_LOG_EVENTS_LIMIT}`),
        { status: 400 },
      );
    }
    limit = params.limit;
  }
  const snapshot =
    params.snapshot === undefined
      ? undefined
      : typeof params.snapshot === "string" && params.snapshot.trim()
        ? params.snapshot.trim()
        : (() => {
            throw Object.assign(new Error("snapshot must be a non-empty string"), { status: 400 });
          })();

  const cacheKey = `${runDir}\0${channel}`;
  const now = Date.now();
  const bucket = horizonCache.get(cacheKey) ?? [];
  let horizon: LogEventHorizon;

  if (snapshot !== undefined) {
    const matched = bucket.find(h => h.id === snapshot);
    if (!matched || matched.invalidated || matched.expiresAt <= now || !(await isHorizonIntact(matched))) {
      if (matched) {
        matched.invalidated = true;
        const pendingIdx = matched.pendingCursors.indexOf(cursor);
        if (pendingIdx >= 0) {
          matched.pendingCursors.splice(pendingIdx, 1);
        }
        storeBucket(cacheKey, bucket);
      }
      throw Object.assign(
        new Error("Log pagination snapshot expired or changed; restart from cursor 0"),
        { status: 409 },
      );
    }
    const pendingIdx = matched.pendingCursors.indexOf(cursor);
    if (pendingIdx >= 0) {
      matched.pendingCursors.splice(pendingIdx, 1);
    }
    matched.expiresAt = now + ttlMs;
    horizon = matched;
    storeBucket(cacheKey, bucket);
  } else if (cursor === 0) {
    const captured = await captureLogHorizonDeduped(cacheKey, runDir, channel, ttlMs, options.signal);
    horizon = {
      id: randomUUID(),
      localPath: captured.localPath,
      localSize: captured.localSize,
      groups: captured.groups,
      createdAt: now,
      expiresAt: now + ttlMs,
      pendingCursors: [],
      servedCursors: new Set<number>(),
    };
    bucket.push(horizon);
    storeBucket(cacheKey, bucket);
  } else if (bucket.length > 0) {
    const liveHorizons: LogEventHorizon[] = [];
    const deadHorizons: LogEventHorizon[] = [];
    for (const candidate of bucket) {
      if (candidate.invalidated || candidate.expiresAt <= now) {
        deadHorizons.push(candidate);
        continue;
      }
      if (!(await isHorizonIntact(candidate))) {
        candidate.invalidated = true;
        deadHorizons.push(candidate);
        continue;
      }
      liveHorizons.push(candidate);
    }
    const matched =
      liveHorizons.find(h => h.pendingCursors.includes(cursor)) ??
      deadHorizons.find(h => h.pendingCursors.includes(cursor)) ??
      liveHorizons.find(h => h.servedCursors.has(cursor)) ??
      deadHorizons.find(h => h.servedCursors.has(cursor)) ??
      liveHorizons[liveHorizons.length - 1] ??
      bucket[bucket.length - 1]!;
    if (matched.invalidated || matched.expiresAt <= now) {
      matched.invalidated = true;
      const pendingIdx = matched.pendingCursors.indexOf(cursor);
      if (pendingIdx >= 0) {
        matched.pendingCursors.splice(pendingIdx, 1);
      }
      storeBucket(cacheKey, bucket);
      throw Object.assign(
        new Error("Log pagination snapshot expired or changed; restart from cursor 0"),
        { status: 409 },
      );
    }
    const pendingIdx = matched.pendingCursors.indexOf(cursor);
    if (pendingIdx >= 0) {
      matched.pendingCursors.splice(pendingIdx, 1);
    }
    matched.expiresAt = now + ttlMs;
    horizon = matched;
    storeBucket(cacheKey, bucket);
  } else {
    const captured = await captureLogHorizonDeduped(cacheKey, runDir, channel, ttlMs, options.signal);
    horizon = {
      id: randomUUID(),
      localPath: captured.localPath,
      localSize: captured.localSize,
      groups: captured.groups,
      createdAt: now,
      expiresAt: now + ttlMs,
      pendingCursors: [],
      servedCursors: new Set<number>(),
    };
    bucket.push(horizon);
    storeBucket(cacheKey, bucket);
  }

  const events: Record<string, unknown>[] = [];
  let index = 0;
  let hasMore = false;

  for await (const event of readHorizonEvents(horizon, options.signal)) {
    options.signal?.throwIfAborted();
    if (index < cursor) {
      index += 1;
      continue;
    }
    if (events.length >= limit) {
      hasMore = true;
      break;
    }
    events.push(event);
    index += 1;
  }

  const nextCursor = hasMore ? cursor + events.length : null;
  horizon.servedCursors.add(cursor);
  if (hasMore && nextCursor !== null && !horizon.pendingCursors.includes(nextCursor)) {
    horizon.pendingCursors.push(nextCursor);
  }
  horizon.expiresAt = Date.now() + ttlMs;
  storeBucket(cacheKey, bucket);

  return {
    events,
    nextCursor,
    hasMore,
    snapshot: horizon.id,
  };
}

export async function queryRunLogArtifact(
  params: LogsReadParams,
  options: { allowHostPath: boolean; root?: string } = { allowHostPath: true },
): Promise<LogsReadResult> {
  const runDir = await resolveLogRunDir(params, options);
  const hasRef = params.reference !== undefined;
  const hasEvent = params.eventSeq !== undefined;
  if (hasRef === hasEvent) {
    throw Object.assign(new Error("Supply exactly one of reference or eventSeq"), { status: 400 });
  }
  if (hasEvent) {
    if (!Number.isSafeInteger(params.eventSeq) || (params.eventSeq as number) < 1 || !params.field?.trim()) {
      throw Object.assign(new Error("eventSeq requires a positive integer and non-empty field"), { status: 400 });
    }
  } else if (params.field !== undefined) {
    throw Object.assign(new Error("field requires eventSeq"), { status: 400 });
  }

  const value = await readRunLogArtifact(runDir, {
    ...(hasEvent ? { event: params.eventSeq, field: params.field } : { reference: params.reference }),
    full: params.media === "full",
  });
  return { value };
}
