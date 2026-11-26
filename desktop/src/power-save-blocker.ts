import { readFileSync, statSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DaemonStatusResult } from '@ludens/protocol/app-rpc'

export const LUDENS_POWER_CHANNELS = {
  getState: 'ludens:power:get-state',
  setPreventAppSuspension: 'ludens:power:set-prevent-app-suspension',
  state: 'ludens:power:state',
} as const

export interface PowerSavePreferences {
  version: 1
  preventAppSuspension: boolean
}

export const DEFAULT_POWER_SAVE_PREFERENCES: PowerSavePreferences = {
  version: 1,
  preventAppSuspension: true,
}

export interface DesktopPowerState {
  preventAppSuspension: boolean
  blocking: boolean
  activeCoreCount: number
}

export interface PowerSaveBlockerApi {
  start(type: 'prevent-app-suspension' | 'prevent-display-sleep'): number
  stop(id: number): void
  isStarted(id: number): boolean
}

export function createPowerSavePreferenceStore(
  path: string,
  defaults: PowerSavePreferences = DEFAULT_POWER_SAVE_PREFERENCES,
) {
  let current: PowerSavePreferences = { ...defaults }
  try {
    if (statSync(path).size < 4_096) {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<PowerSavePreferences>
      if (parsed && typeof parsed === 'object' && typeof parsed.preventAppSuspension === 'boolean') {
        current = { version: 1, preventAppSuspension: parsed.preventAppSuspension }
      }
    }
  } catch {
    // Missing or invalid disk state: fall back to official defaults.
  }

  let queue = Promise.resolve()
  const persist = async (value: PowerSavePreferences): Promise<PowerSavePreferences> => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
    await rename(`${path}.tmp`, path)
    current = value
    return { ...current }
  }

  return {
    get: (): PowerSavePreferences => ({ ...current }),
    update(patch: { preventAppSuspension: boolean }): Promise<PowerSavePreferences> {
      const next: PowerSavePreferences = {
        version: 1,
        preventAppSuspension: Boolean(patch.preventAppSuspension),
      }
      const run = queue.then(() => persist(next))
      queue = run.then(
        () => {},
        () => {},
      )
      return run
    },
  }
}

export interface DesktopPowerSaveControllerOptions {
  blocker: PowerSaveBlockerApi
  store: ReturnType<typeof createPowerSavePreferenceStore>
  queryStatus: (timeoutMs: number) => Promise<DaemonStatusResult | null>
  onStateChange?: (state: DesktopPowerState) => void
  pollIntervalMs?: number
  statusTimeoutMs?: number
}

/**
 * Holds Electron `powerSaveBlocker.start('prevent-app-suspension')` while any Core / Auto
 * session is active and the user's preference permits it; releases automatically when idle
 * or on shutdown.
 */
export class DesktopPowerSaveController {
  private blockerId: number | null = null
  private activeCoreCount = 0
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private refreshing: Promise<DesktopPowerState> | undefined
  private disposed = false
  private lastEmittedKey = ''
  private readonly pollIntervalMs: number
  private readonly statusTimeoutMs: number

  constructor(private readonly options: DesktopPowerSaveControllerOptions) {
    this.pollIntervalMs = Math.max(1_000, options.pollIntervalMs ?? 5_000)
    this.statusTimeoutMs = Math.min(options.statusTimeoutMs ?? 1_500, 3_000)
  }

  getState(): DesktopPowerState {
    const prefs = this.options.store.get()
    return {
      preventAppSuspension: prefs.preventAppSuspension,
      blocking: this.blockerId !== null && this.options.blocker.isStarted(this.blockerId),
      activeCoreCount: this.activeCoreCount,
    }
  }

  start(): void {
    if (this.disposed || this.pollTimer) return
    this.pollTimer = setInterval(() => {
      void this.refresh()
    }, this.pollIntervalMs)
    this.pollTimer.unref?.()
    void this.refresh()
  }

  async setPreventAppSuspension(enabled: boolean): Promise<DesktopPowerState> {
    if (this.disposed) return this.getState()
    await this.options.store.update({ preventAppSuspension: Boolean(enabled) })
    this.reconcile()
    return this.getState()
  }

  async refresh(): Promise<DesktopPowerState> {
    if (this.disposed) return this.getState()
    if (this.refreshing) return this.refreshing
    this.refreshing = (async () => {
      try {
        const status = await this.options.queryStatus(this.statusTimeoutMs)
        if (!this.disposed) {
          this.activeCoreCount = Array.isArray(status?.activeCores) ? status.activeCores.length : 0
          this.reconcile()
        }
      } catch {
        if (!this.disposed) {
          this.activeCoreCount = 0
          this.reconcile()
        }
      }
      return this.getState()
    })().finally(() => {
      this.refreshing = undefined
    })
    return this.refreshing
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
    }
    this.releaseBlocker()
  }

  private reconcile(): void {
    const prefs = this.options.store.get()
    const shouldBlock = !this.disposed && prefs.preventAppSuspension && this.activeCoreCount > 0
    if (shouldBlock) {
      if (this.blockerId === null || !this.options.blocker.isStarted(this.blockerId)) {
        this.blockerId = this.options.blocker.start('prevent-app-suspension')
      }
    } else {
      this.releaseBlocker()
    }
    this.emitIfChanged()
  }

  private releaseBlocker(): void {
    if (this.blockerId !== null) {
      const id = this.blockerId
      this.blockerId = null
      try {
        if (this.options.blocker.isStarted(id)) {
          this.options.blocker.stop(id)
        }
      } catch {}
    }
  }

  private emitIfChanged(): void {
    const state = this.getState()
    const key = `${state.preventAppSuspension}:${state.blocking}:${state.activeCoreCount}`
    if (key === this.lastEmittedKey) return
    this.lastEmittedKey = key
    this.options.onStateChange?.(state)
  }
}
