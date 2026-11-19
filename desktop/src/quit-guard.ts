import type { CoresStopAllResult, DaemonStatusResult } from '@ludens/protocol/app-rpc'

export const DEFAULT_QUIT_STATUS_TIMEOUT_MS = 1_200

export type QuitDialogAction = 'keep-background' | 'stop-all' | 'cancel'

export interface QuitGuardLabels {
  title: string
  message: string
  detail: string
  keepBackground: string
  stopAllAndQuit: string
  cancel: string
}

export interface QuitGuardOptions {
  getLocale: () => string
  queryStatus: (timeoutMs: number) => Promise<DaemonStatusResult | null>
  stopAllCores: () => Promise<CoresStopAllResult | void>
  promptUser: (labels: QuitGuardLabels, activeCores: readonly string[]) => Promise<QuitDialogAction>
  onConfirmQuit: () => Promise<void> | void
  triggerQuit: () => void
  statusTimeoutMs?: number
}

export function buildQuitDialogLabels(locale: string, activeCoreCount: number): QuitGuardLabels {
  const isZh = locale.toLowerCase().startsWith('zh')
  if (isZh) {
    return {
      title: '退出 Ludens',
      message: `当前仍有 ${activeCoreCount} 个 Core 正在后台运行`,
      detail: '选择保持后台继续运行（保留守护进程与活跃 Core），或停止所有 Core 后退出应用。',
      keepBackground: '保持后台继续运行',
      stopAllAndQuit: '停止所有 Core 并退出',
      cancel: '取消',
    }
  }
  return {
    title: 'Quit Ludens',
    message: `${activeCoreCount} active Core${activeCoreCount === 1 ? '' : 's'} still running`,
    detail: 'Keep the background daemon and active Cores running, or stop all Cores before quitting.',
    keepBackground: 'Keep Running in Background',
    stopAllAndQuit: 'Stop All Cores & Quit',
    cancel: 'Cancel',
  }
}

export function mapDialogButtonToQuitAction(responseIndex: number): QuitDialogAction {
  if (responseIndex === 0) return 'keep-background'
  if (responseIndex === 1) return 'stop-all'
  return 'cancel'
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise<T>(resolve => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs)
    timer.unref?.()
    promise
      .then(value => {
        clearTimeout(timer)
        resolve(value)
      })
      .catch(() => {
        clearTimeout(timer)
        resolve(fallback)
      })
  })
}

/**
 * Coordinates Electron `before-quit` confirmation when local background Cores are active:
 * - No running Cores / offline daemon -> exits immediately without touching the background daemon
 * - Active Cores present -> prompts 3-choice confirmation (Keep Running / Stop All & Quit / Cancel)
 */
export class ActiveCoreQuitGuard {
  private quitConfirmed = false
  private checkPromise: Promise<void> | undefined
  private readonly statusTimeoutMs: number

  constructor(private readonly options: QuitGuardOptions) {
    this.statusTimeoutMs = Math.min(options.statusTimeoutMs ?? DEFAULT_QUIT_STATUS_TIMEOUT_MS, 1_500)
  }

  isQuitConfirmed(): boolean {
    return this.quitConfirmed
  }

  /**
   * Call from Electron `app.on('before-quit', event => ...)`.
   * Returns `true` when Electron may continue quitting synchronously.
   */
  handleBeforeQuit(event: { preventDefault(): void }): boolean {
    if (this.quitConfirmed) {
      return true
    }
    event.preventDefault()
    if (!this.checkPromise) {
      this.checkPromise = this.runCheck().finally(() => {
        this.checkPromise = undefined
      })
    }
    return false
  }

  /** Resolves the current async check (useful for deterministic unit tests). */
  pendingCheck(): Promise<void> | undefined {
    return this.checkPromise
  }

  private async confirmAndQuit(): Promise<void> {
    await this.options.onConfirmQuit()
    this.quitConfirmed = true
    this.options.triggerQuit()
  }

  private async runCheck(): Promise<void> {
    const status = await withTimeout(
      this.options.queryStatus(this.statusTimeoutMs),
      this.statusTimeoutMs,
      null,
    )
    const activeCores = status?.activeCores ?? []
    if (activeCores.length === 0) {
      await this.confirmAndQuit()
      return
    }

    const labels = buildQuitDialogLabels(this.options.getLocale(), activeCores.length)
    let action: QuitDialogAction
    try {
      action = await this.options.promptUser(labels, activeCores)
    } catch {
      return
    }

    if (action === 'cancel') {
      return
    }

    if (action === 'stop-all') {
      await this.options.stopAllCores().catch(() => {})
    }

    await this.confirmAndQuit()
  }
}
