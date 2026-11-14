import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { NodeUdsRpcClient } from '@ludens/core/cli/app-rpc-client'
import { resolveAppServerSocketPath } from '@ludens/core/daemon/app-daemon'
import { ActivityChangesClient, type ActivityBlock, type ActivityChangesReader, type ActivityProjection } from '@ludens/protocol/activity'
import type { AppRpcMethod, AppRpcParams, AppRpcResult } from '@ludens/protocol/app-rpc'
import { ludensHome, readWorkspaceIdentitySync } from '@ludens/protocol/ludens'
import { buildLudensMediaAssetUrl } from './custom-protocols.js'
import { originKey } from './dashboard-window.js'

export type { ActivityBlock, ActivityProjection, ActivityChanges, LogBlock } from '@ludens/protocol/activity'

export interface ActivityRpcCaller {
  call<M extends AppRpcMethod>(
    method: M,
    params?: AppRpcParams<M>,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<AppRpcResult<M>>
}

export type ConsumerRecord = (type: string, data: Record<string, unknown>, context?: {
  runId?: string | null; epoch?: string | null; trace?: Record<string, string>
}) => void

/** A separate consumer journal cannot feed back into the host's event stream. */
export function consumerRecorder(workspace: string): ConsumerRecord {
  const clockId = randomUUID(), directory = join(workspace, 'logs', 'consumers')
  const path = join(directory, `pet-${process.pid}-${clockId}.jsonl`)
  mkdirSync(directory, { recursive: true })
  let seq = 0
  return (type, data, context = {}) => {
    seq++
    const at = new Date().toISOString(), atMs = performance.now()
    appendFileSync(path, JSON.stringify({ schemaVersion: 2, source: { component: 'pet' },
      runId: context.runId ?? null, seq, at, atMs,
      origin: { eventId: `${clockId}:${seq}`, clockId, seq, at, atMs },
      trace: { ...context.trace, ...(context.epoch ? { epoch: context.epoch } : {}) }, type, data }) + '\n')
  }
}

export interface LudensPetSnapshot {
  workspace: string | null
  runId: string | null
  epoch: string | null
  phase: string
  intent: string | null
  observationUrl: string | null
  updatedAt: string | null
  error: string | null
  dashboardUrl: string
}

export interface LudensActivitySnapshot {
  /** Identifies one run/epoch, so switching it also clears old bubbles. */
  identity: string
  activity: 'running' | 'manual' | 'offline' | 'idle'
  current: LudensPetSnapshot
  blocks: ActivityBlock[]
  mode: 'snapshot' | 'delta'
  revision: number
  hasMore: boolean
  /** Advance the source cursor only after this page has entered the queue. */
  acknowledge?(): void
  projection?: ActivityProjection
}

export interface LudensActivitySource {
  identity(): string | null
  read(signal?: AbortSignal): Promise<LudensActivitySnapshot>
  stop?(): void
  record?: ConsumerRecord
}

/** Read the workspace's persistent identity without creating or registering it. */
export function ludensProjectId(workspace: string): string {
  return readWorkspaceIdentitySync(workspace).id
}

function url(base: string, path: string, query: Record<string, string | null> = {}): string {
  const result = new URL(path, base)
  for (const [key, value] of Object.entries(query)) if (value !== null) result.searchParams.set(key, value)
  return result.href
}

/** Read-only UDS RPC activity source; never calls REST endpoints or control commands. */
export class LudensSource implements LudensActivitySource {
  private readonly workspace: string
  private readonly project: string
  private readonly dashboardUrl: string
  private latest: Omit<LudensActivitySnapshot, 'blocks' | 'acknowledge'>
  private readonly client: ActivityChangesClient
  private readonly socketPath?: string
  private ownedRpc: NodeUdsRpcClient | undefined
  private readonly rpc: ActivityRpcCaller
  private abort = new AbortController()
  private progress = ''
  readonly record: ConsumerRecord

  constructor(private options: {
    workspace: string
    dashboardUrl: string
    rpc?: ActivityRpcCaller
    socketPath?: string
    onSnapshot(snapshot: LudensPetSnapshot): void
    record?: ConsumerRecord
  }) {
    this.workspace = realpathSync(options.workspace)
    this.project = ludensProjectId(this.workspace)
    this.dashboardUrl = originKey(options.dashboardUrl) ?? new URL(options.dashboardUrl).origin
    this.socketPath = options.socketPath
    this.rpc = options.rpc ?? {
      call: (method, params, callOptions) => {
        this.ownedRpc ??= new NodeUdsRpcClient({
          socketPath: this.socketPath ?? resolveAppServerSocketPath(ludensHome()),
          connectTimeoutMs: 2_000,
        })
        return this.ownedRpc.call(method, params, callOptions)
      },
    }

    const reader: ActivityChangesReader = (request, signal) =>
      this.rpc.call(
        'activity/get',
        {
          project: request.project,
          ...(request.run !== undefined ? { run: request.run } : {}),
          ...(request.epoch !== undefined ? { epoch: request.epoch } : {}),
          query: {
            mode: request.mode,
            ...(request.limit !== undefined ? { limit: request.limit } : {}),
            ...(request.cursor !== undefined ? { cursor: request.cursor } : {}),
          },
        },
        { signal },
      )

    this.client = new ActivityChangesClient({ project: this.project, reader })
    this.latest = {
      identity: this.identity(),
      activity: 'idle',
      mode: 'snapshot',
      revision: 0,
      hasMore: false,
      current: {
        workspace: this.workspace,
        runId: null,
        epoch: null,
        phase: '尚未读取日志',
        intent: null,
        observationUrl: null,
        updatedAt: null,
        error: null,
        dashboardUrl: this.dashboardUrl,
      },
    }
    this.record = options.record ?? (() => {})
  }

  identity() { return `${this.project}:pet` }

  stop() {
    this.abort.abort()
    void this.ownedRpc?.close().catch(() => {})
  }

  async read(signal?: AbortSignal): Promise<LudensActivitySnapshot> {
    this.abort.signal.throwIfAborted()
    signal?.throwIfAborted()
    const requestSignal = signal ? AbortSignal.any([this.abort.signal, signal]) : this.abort.signal
    const started = performance.now()
    let next: LudensActivitySnapshot
    let readError: string | undefined
    try {
      const page = await this.client.read(requestSignal)
      if (page.current.workspace) {
        let canonicalWorkspace = page.current.workspace
        try {
          canonicalWorkspace = realpathSync(page.current.workspace)
        } catch {}
        if (canonicalWorkspace !== this.workspace) {
          throw new Error('日志服务返回了非当前工作区的状态')
        }
      }
      const { observationId, activity, ...current } = page.current
      next = {
        identity: [this.identity(), page.projection.generation, page.scope.runId, page.scope.epoch].join(':'),
        activity,
        blocks: page.blocks,
        mode: page.mode,
        revision: page.projection.revision,
        hasMore: page.hasMore,
        projection: page.projection,
        current: {
          ...current,
          workspace: current.workspace ?? this.workspace,
          phase: current.phase ?? '尚未读取日志',
          // Pet health describes log consumption; runtime failures are activity blocks.
          error: null,
          observationUrl: observationId && current.runId
            ? buildLudensMediaAssetUrl({
                project: this.project,
                run: current.runId,
                id: observationId,
              })
            : null,
          dashboardUrl: url(this.dashboardUrl, '/', {
            project: this.project,
            run: current.runId,
            epoch: current.epoch,
          }),
        },
        acknowledge: page.acknowledge,
      }
    } catch (error) {
      if (signal?.aborted || this.abort.signal.aborted) throw error
      readError = String(error)
      next = {
        ...this.latest,
        mode: 'delta',
        hasMore: false,
        blocks: [],
        activity: 'offline',
        current: {
          ...this.latest.current,
          phase: '日志服务离线',
          intent: null,
          error: String(error),
        },
      }
    }
    if (signal?.aborted) throw signal.reason
    this.abort.signal.throwIfAborted()
    // Revisions include streaming text; no full-history fingerprint or retained block cache.
    const progress = JSON.stringify([next.identity, next.activity, next.current.error, next.projection?.throughSeq, next.revision])
    if (progress !== this.progress) {
      this.record(readError ? 'read_error' : 'read', {
        durationMs: performance.now() - started,
        projection: next.projection,
        blocks: next.blocks.length,
        activity: next.activity,
        mode: next.mode,
        revision: next.revision,
        hasMore: next.hasMore,
        error: readError ?? null,
      }, next.current)
      this.progress = progress
    }
    const { blocks: _blocks, acknowledge: _acknowledge, ...latest } = next
    this.latest = latest
    this.options.onSnapshot(next.current)
    return next
  }
}
