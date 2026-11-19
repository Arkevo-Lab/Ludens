import { realpath } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import type {
  LogsEventsParams,
  LogsEventsResult,
  LogsReadParams,
  LogsReadResult,
} from "@ludens/protocol/app-rpc";
import { readRunEvents } from "@ludens/protocol/event-sources";
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

export async function queryRunLogEvents(
  params: LogsEventsParams,
  options: { allowHostPath: boolean; root?: string; signal?: AbortSignal } = { allowHostPath: true },
): Promise<LogsEventsResult> {
  options.signal?.throwIfAborted();
  const runDir = await resolveLogRunDir(params, options);
  options.signal?.throwIfAborted();
  const channel = params.channel === "diagnostics" ? "diagnostics" : "events";
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

  const events: Record<string, unknown>[] = [];
  let index = 0;
  let hasMore = false;

  for await (const event of readRunEvents(runDir, { channel, signal: options.signal })) {
    options.signal?.throwIfAborted();
    if (index < cursor) {
      index += 1;
      continue;
    }
    if (events.length >= limit) {
      hasMore = true;
      break;
    }
    events.push(event as Record<string, unknown>);
    index += 1;
  }

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
