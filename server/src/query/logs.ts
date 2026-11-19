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
  localPath: string;
  localSize: number | null;
  groups: LogHorizonGroup[];
  createdAt: number;
  lastPageAt: number;
  expiresAt: number;
  activeReaders: number;
}

const HORIZON_TTL_MS = 60_000;
const ACTIVE_PAGINATION_WINDOW_MS = 5_000;
const MAX_HORIZON_ENTRIES = 32;
const horizonCache = new Map<string, LogEventHorizon>();

export function clearLogEventHorizons(): void {
  horizonCache.clear();
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
    localPath,
    localSize,
    groups,
    createdAt: now,
    lastPageAt: now,
    expiresAt: now + HORIZON_TTL_MS,
    activeReaders: 0,
  };
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

function storeHorizon(key: string, horizon: LogEventHorizon): void {
  horizonCache.delete(key);
  horizonCache.set(key, horizon);
  while (horizonCache.size > MAX_HORIZON_ENTRIES) {
    const oldest = horizonCache.keys().next().value;
    if (oldest === undefined) break;
    horizonCache.delete(oldest);
  }
}

export async function queryRunLogEvents(
  params: LogsEventsParams,
  options: { allowHostPath: boolean; root?: string; signal?: AbortSignal } = { allowHostPath: true },
): Promise<LogsEventsResult> {
  options.signal?.throwIfAborted();
  const runDir = await resolveLogRunDir(params, options);
  options.signal?.throwIfAborted();
  const channel: EventChannel = params.channel === "diagnostics" ? "diagnostics" : "events";
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

  const cacheKey = `${runDir}\0${channel}`;
  const now = Date.now();
  const cached = horizonCache.get(cacheKey);
  let horizon: LogEventHorizon | undefined;
  let reused = false;

  if (cursor > 0) {
    if (cached) {
      if (cached.expiresAt <= now) {
        horizonCache.delete(cacheKey);
        throw Object.assign(
          new Error("Log pagination snapshot expired; restart from cursor 0"),
          { status: 409 },
        );
      }
      if (!(await isHorizonIntact(cached))) {
        horizonCache.delete(cacheKey);
        throw Object.assign(
          new Error("Log archive changed during pagination; restart from cursor 0"),
          { status: 409 },
        );
      }
      cached.expiresAt = now + HORIZON_TTL_MS;
      cached.lastPageAt = now;
      horizon = cached;
      reused = true;
    }
  } else if (
    cached &&
    cached.expiresAt > now &&
    cached.activeReaders > 0 &&
    now - cached.lastPageAt < ACTIVE_PAGINATION_WINDOW_MS &&
    (await isHorizonIntact(cached))
  ) {
    // Share the active snapshot with concurrent readers so a fresh cursor=0 request
    // never clobbers another reader's in-progress pagination.
    cached.expiresAt = now + HORIZON_TTL_MS;
    cached.lastPageAt = now;
    horizon = cached;
    reused = true;
  }

  if (!horizon) {
    horizon = await captureLogHorizon(runDir, channel, options.signal);
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

  if (cursor === 0) {
    if (hasMore) {
      horizon.activeReaders += 1;
    }
  } else if (!hasMore && reused) {
    horizon.activeReaders = Math.max(0, horizon.activeReaders - 1);
  }

  // Keep the snapshot cached until TTL/LRU eviction rather than deleting on !hasMore,
  // so concurrent readers and retries on the final page remain consistent.
  horizon.lastPageAt = Date.now();
  horizon.expiresAt = horizon.lastPageAt + HORIZON_TTL_MS;
  storeHorizon(cacheKey, horizon);

  return {
    events,
    nextCursor: hasMore ? cursor + events.length : null,
    hasMore,
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
