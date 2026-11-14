/** Shared read-only activity protocol for the Dashboard hook and Ludens Pet. */
export interface EventSource { component: string; implementation?: string; implementationVersion?: string }
export interface LogBlock {
  id: string;
  kind: "thinking" | "text" | "tool" | "system" | "diagnostic";
  at: string;
  title: string;
  text: string;
  status: "running" | "complete" | "error";
  /** A completed diagnostic/assessment is not necessarily an execution failure. */
  outcome?: "raised" | "unmet";
  tool?: { intent?: string; args?: unknown; result?: unknown };
  data?: Record<string, unknown>;
  source?: EventSource;
  trace?: Record<string, string>;
  eventId?: string;
  seq?: number;
  updatedAt?: string;
}
export interface ActivityBlock extends LogBlock { createdRevision: number; revision: number }
export interface ActivityScope { project: string; runId: string | null; epoch: string | null }
export interface ActivityProjection {
  source: EventSource;
  throughSeq: number;
  latestEventAt: string | null;
  latestSourceAt: string | null;
  generatedAt: string;
  durationMs: number;
  blockCount: number;
  revision: number;
  generation: string;
}
export interface ActivityCurrent {
  workspace: string | null;
  runId: string | null;
  epoch: string | null;
  activity: "running" | "manual" | "offline" | "idle";
  phase: string | null;
  intent: string | null;
  observationId: string | null;
  updatedAt: string | null;
  error: string | null;
}
export interface ActivityResponse {
  scope: ActivityScope;
  mode: "snapshot" | "delta" | "history" | "block";
  blocks: ActivityBlock[];
  cursor?: string | null;
  before?: string | null;
  hasMore: boolean;
  total?: number;
  projection: ActivityProjection;
  current: ActivityCurrent;
}
export interface ActivityChanges extends ActivityResponse {
  mode: "snapshot" | "delta";
  cursor: string | null;
}
export interface ActivityChangesPage extends ActivityChanges {
  /** Call only after the consumer has accepted the blocks into its bounded state or queue. */
  acknowledge(): void;
}
export function sameScope(left: ActivityScope | null, right: ActivityScope | null): boolean {
  return left?.project === right?.project && left?.runId === right?.runId && left?.epoch === right?.epoch;
}
export function acceptsScope(scope: ActivityScope, project: string, run?: string, epoch?: string): boolean {
  return scope.project === project && (run === undefined || scope.runId === run)
    && (epoch === undefined || (epoch === "all" ? scope.epoch === null : scope.epoch === epoch));
}

export interface ActivityChangesRequest {
  project: string;
  run?: string;
  epoch?: string;
  mode: "changes";
  limit?: number;
  cursor?: string;
}

export type ActivityChangesReader = (
  request: ActivityChangesRequest,
  signal: AbortSignal,
) => Promise<ActivityResponse>;

export interface ActivityChangesClientOptions {
  project: string;
  run?: string;
  epoch?: string;
  limit?: number;
  /** Injected transport reader backed by RPC (`activity/get`) or custom fetcher. */
  reader?: ActivityChangesReader;
  /** Alias for `reader` to support fetcher naming cleanly. */
  fetcher?: ActivityChangesReader;
}

/** Retries `ARCHIVE_PREPARING` responses cleanly while respecting caller abort signals. */
export async function retryArchivePreparing<T>(
  read: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  for (;;) {
    signal.throwIfAborted();
    try {
      const result = await read(signal);
      signal.throwIfAborted();
      return result;
    } catch (error) {
      signal.throwIfAborted();
      const err = error as { code?: unknown; data?: { code?: unknown } } | null;
      const code = err?.code ?? err?.data?.code;
      if (code === "ARCHIVE_PREPARING") {
        await new Promise<void>((resolve, reject) => {
          const aborted = () => { clearTimeout(timer); reject(signal.reason); };
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", aborted);
            resolve();
          }, 250);
          signal.addEventListener("abort", aborted, { once: true });
          if (signal.aborted) aborted();
        });
        continue;
      }
      throw error;
    }
  }
}

/** Holds only an opaque cursor. The server owns projection, ordering and reset snapshots. */
export class ActivityChangesClient {
  private cursor: string | null = null;
  private readonly reader: ActivityChangesReader;

  constructor(private options: ActivityChangesClientOptions) {
    const reader = options.reader ?? options.fetcher;
    if (typeof reader !== "function") {
      throw new Error("ActivityChangesClient requires an injected reader function");
    }
    this.reader = reader;
  }

  async read(signal: AbortSignal): Promise<ActivityChangesPage> {
    signal.throwIfAborted();
    const { project, run, epoch, limit } = this.options;
    const previousCursor = this.cursor;
    const request: ActivityChangesRequest = {
      project,
      mode: "changes",
      ...(run !== undefined ? { run } : {}),
      ...(epoch !== undefined ? { epoch } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(previousCursor ? { cursor: previousCursor } : {}),
    };
    const result = await retryArchivePreparing(sig => this.reader(request, sig), signal);
    if (!acceptsScope(result.scope, project, run, epoch)) throw new Error("日志返回了其他运行范围");
    if (result.mode !== "snapshot" && result.mode !== "delta") throw new Error("日志返回了非增量页面");
    const cursor = result.cursor ?? null;
    return { ...result, mode: result.mode, cursor, acknowledge: () => {
      if (!signal.aborted && this.cursor === previousCursor) this.cursor = cursor;
    } };
  }
}
