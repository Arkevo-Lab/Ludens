import { randomUUID } from 'node:crypto'
import type { Project } from '@ludens/core/core/query/types'
import { consumerRecorder, ludensProjectId, LudensSource, type LudensActivitySnapshot, type LudensActivitySource, type LudensPetSnapshot } from './ludens-source.js'

export interface PetTarget {
  project: string
  workspace: string
  revision: string
  updatedAt: string
}
type SourceFactory = (workspace: string, onSnapshot: (snapshot: LudensPetSnapshot) => void) => LudensActivitySource
type ConsumerPhase = 'idle' | 'switching' | 'following' | 'error'

/** Parse `?project=<id>` from a local dashboard URL matching `origin`. */
export function extractProjectFromUrl(url: string, origin: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.origin !== origin) return null
    const project = parsed.searchParams.get('project')?.trim()
    return project || null
  } catch {
    return null
  }
}

/**
 * Resolve which online Core the Pet should follow in `!auto` mode:
 * 1. Any online Core with `pendingOutbound > 0` (SOS first; prefer focused project if tied)
 * 2. Otherwise the currently focused window's online Core
 * 3. Otherwise a background Core in `auto` mode (or consolidating / first online Core)
 */
export function selectAutoFollowTarget(
  projects: readonly Project[],
  focusedProject: string | null,
): Project | null {
  const online = projects.filter(
    project =>
      project.core?.online === true &&
      project.available !== false &&
      typeof project.workspace === 'string' &&
      project.workspace.length > 0,
  )
  if (online.length === 0) return null

  const sos = online.filter(project => (project.core?.pendingOutbound ?? 0) > 0)
  if (sos.length > 0) {
    if (focusedProject) {
      const focusedSos = sos.find(project => project.id === focusedProject)
      if (focusedSos) return focusedSos
    }
    return sos[0]
  }

  if (focusedProject) {
    const focused = online.find(project => project.id === focusedProject)
    if (focused) return focused
  }

  const autoCore = online.find(project => project.core?.mode === 'auto')
  if (autoCore) return autoCore

  const consolidatingCore = online.find(project => project.core?.consolidating === true)
  if (consolidatingCore) return consolidatingCore

  return online[0]
}

/** One desktop instance follows the Dashboard's selected workspace (or auto-follows active Cores), independently of page navigation. */
export class PetSessionCoordinator implements LudensActivitySource {
  private target: PetTarget | null = null
  private source: LudensActivitySource | undefined
  private generation = 0
  private current: LudensPetSnapshot
  private phase: ConsumerPhase = 'idle'
  private loadedRevision: string | null = null
  private stopped = false
  private repollRequested = false
  private targetPollPromise?: Promise<void>
  private focusedProject: string | null = null
  private autoFollowing = false
  private heartbeatPending = false
  private heartbeatRequest?: Promise<void>
  private readonly abort = new AbortController()
  private readonly instanceId = randomUUID()
  private readonly origin: string
  private readonly createSource: SourceFactory
  private targetTimer?: ReturnType<typeof setInterval>
  private heartbeatTimer?: ReturnType<typeof setInterval>

  constructor(private options: {
    dashboardUrl: string
    onSnapshot(snapshot: LudensPetSnapshot): void
    onTargetChanged(): void
    createSource?: SourceFactory
  }) {
    this.origin = new URL(options.dashboardUrl).origin
    this.current = this.empty('请选择要跟随的工作区')
    this.createSource = options.createSource ?? ((workspace, onSnapshot) => new LudensSource({
      workspace, dashboardUrl: this.origin, record: consumerRecorder(workspace), onSnapshot,
    }))
  }

  identity() { return `${this.origin}:pet:${this.generation}` }
  record: NonNullable<LudensActivitySource['record']> = (...args) => this.source?.record?.(...args)
  setFocusedProject(projectId: string | null) {
    const next = projectId?.trim() || null
    if (next === this.focusedProject) return
    this.focusedProject = next
    if (this.autoFollowing && !this.stopped) {
      if (this.targetPollPromise) {
        this.repollRequested = true
      } else {
        void this.pollTarget()
      }
    }
  }
  private idlePhaseLabel(): string {
    return this.autoFollowing ? '等待活跃 Core' : '请选择要跟随的工作区'
  }
  private empty(phase: string): LudensPetSnapshot {
    return { workspace: this.target?.workspace ?? null, runId: null, epoch: null, phase,
      intent: null, observationUrl: null, updatedAt: null, error: null,
      dashboardUrl: this.target ? `${this.origin}/?project=${encodeURIComponent(this.target.project)}&view=live` : `${this.origin}/` }
  }
  private publish(snapshot: LudensPetSnapshot) {
    this.current = snapshot
    this.options.onSnapshot(snapshot)
  }
  private async request(method: string, body?: unknown) {
    const response = await fetch(`${this.origin}/api/pet`, {
      method, cache: 'no-store', signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(2_000)]),
      headers: { Origin: this.origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) throw new Error(`桌宠日志服务 HTTP ${response.status}`)
    return response.json()
  }
  private async fetchCatalog(): Promise<Project[]> {
    try {
      const response = await fetch(`${this.origin}/api/catalog?includeEmpty=1`, {
        method: 'GET',
        cache: 'no-store',
        signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(2_000)]),
        headers: { Origin: this.origin },
      })
      if (!response.ok) return []
      const data = await response.json()
      return Array.isArray(data) ? (data as Project[]) : []
    } catch {
      return []
    }
  }
  async start(workspace?: string) {
    this.targetTimer = setInterval(() => { void this.pollTarget() }, 2_500)
    this.heartbeatTimer = setInterval(() => { void this.heartbeat() }, 2_500)
    // An explicit launch workspace only supplies the first-ever selection.
    if (workspace) {
      try {
        const projectId = ludensProjectId(workspace)
        this.focusedProject ??= projectId
        await this.request('PUT', { project: projectId, ifUnset: true })
      }
      catch { /* The shared target remains authoritative; the next GET reports connection failures. */ }
    }
    await this.pollTarget()
    await this.heartbeat()
  }
  async pollTarget(): Promise<void> {
    if (this.stopped) return
    if (this.targetPollPromise) {
      this.repollRequested = true
      return this.targetPollPromise
    }
    this.targetPollPromise = this.runPollTarget().finally(() => {
      this.targetPollPromise = undefined
    })
    return this.targetPollPromise
  }
  private async runPollTarget(): Promise<void> {
    try {
      do {
        this.repollRequested = false
        const state = await this.request('GET') as {
          target: PetTarget | null
          targetConfigured?: boolean
          targetUnavailable?: boolean
          autoFollowing?: boolean
        }
        if (this.stopped) return
        let next = state.target
        if (next !== null && (!next || typeof next.project !== 'string' || typeof next.workspace !== 'string' || typeof next.revision !== 'string'))
          throw new Error('桌宠跟随目标无效')
        // Keep the saved selection on the server, but never consume an offline,
        // unregistered, or replaced directory as though it were that workspace.
        if (state.targetUnavailable === true) next = null

        const isAutoFollow = state.targetConfigured === false || (next === null && state.autoFollowing === true)
        this.autoFollowing = isAutoFollow
        if (isAutoFollow) {
          const projects = await this.fetchCatalog()
          if (this.stopped) return
          const chosen = selectAutoFollowTarget(projects, this.focusedProject)
          next = chosen && chosen.workspace
            ? {
                project: chosen.id,
                workspace: chosen.workspace,
                revision: `auto:${chosen.id}`,
                updatedAt: this.target?.project === chosen.id ? this.target.updatedAt : new Date().toISOString(),
              }
            : null
        }

        if (next?.revision !== this.target?.revision || next?.workspace !== this.target?.workspace || next?.project !== this.target?.project
          || (next && !this.source) || (!next && this.phase === 'error')) {
          this.select(next)
        } else if (!next && this.phase === 'idle') {
          const idlePhase = this.idlePhaseLabel()
          if (this.current.phase !== idlePhase) this.publish(this.empty(idlePhase))
        }
      } while (this.repollRequested && !this.stopped)
    } catch (error) {
      if (!this.stopped) {
        this.phase = 'error'
        this.publish({ ...this.current, phase: '日志服务离线', error: String(error) })
      }
    }
  }
  private select(target: PetTarget | null) {
    this.source?.stop?.()
    this.source = undefined
    this.target = target
    const generation = ++this.generation
    this.loadedRevision = null
    this.phase = target ? 'switching' : 'idle'
    this.publish(this.empty(target ? '正在连接日志' : this.idlePhaseLabel()))
    if (target) {
      try {
        this.source = this.createSource(target.workspace, snapshot => {
          if (this.stopped || generation !== this.generation) return
          this.loadedRevision = target.revision
          this.phase = snapshot.error ? 'error' : 'following'
          this.publish(snapshot)
          void this.heartbeat()
        })
      } catch (error) {
        this.phase = 'error'
        this.publish({ ...this.current, phase: '无法打开工作区', error: String(error) })
      }
    }
    this.options.onTargetChanged()
    void this.heartbeat()
  }
  async read(signal?: AbortSignal): Promise<LudensActivitySnapshot> {
    this.abort.signal.throwIfAborted()
    signal?.throwIfAborted()
    const generation = this.generation, source = this.source
    if (source) {
      const snapshot = await source.read(signal)
      if (generation !== this.generation) throw new DOMException('Follow target changed', 'AbortError')
      return snapshot
    }
    return { identity: this.identity(), activity: 'idle', current: this.current, blocks: [], mode: 'snapshot', revision: 0, hasMore: false }
  }
  heartbeat(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    this.heartbeatPending = true
    if (this.heartbeatRequest) return this.heartbeatRequest
    this.heartbeatRequest = (async () => {
      do {
        this.heartbeatPending = false
        try {
          await this.request('POST', {
            instanceId: this.instanceId, pid: process.pid, revision: this.loadedRevision,
            targetRevision: this.target?.revision ?? null, workspace: this.target?.workspace ?? null,
            runId: this.current.runId, phase: this.phase, error: this.current.error,
          })
        } catch { /* The next independent heartbeat retries; log consumption must keep running. */ }
      } while (this.heartbeatPending && !this.stopped)
    })().finally(() => { this.heartbeatRequest = undefined })
    return this.heartbeatRequest
  }
  stop() {
    if (this.stopped) return
    this.stopped = true
    clearInterval(this.targetTimer); clearInterval(this.heartbeatTimer)
    this.abort.abort()
    this.source?.stop?.()
  }
}
