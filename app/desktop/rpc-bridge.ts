import { EventEmitter } from 'node:events'
import { createConnection } from 'node:net'
import { StringDecoder } from 'node:string_decoder'
import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import { LUDENS_RPC_CHANNELS, type DesktopRpcStatus } from './rpc-channels.js'

export interface UdsSocketLike extends EventEmitter {
  readonly destroyed?: boolean
  readonly writable?: boolean
  write(chunk: string, encoding?: BufferEncoding): boolean
  destroy(): this
  end?(): this
}

export type ConnectUdsSocket = (socketPath: string) => UdsSocketLike

export interface WebContentsTargetLike {
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): void
  mainFrame?: { url: string } | null
}

export interface IpcMainLike {
  on(channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void): unknown
  removeListener(channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void): unknown
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): unknown
  removeHandler(channel: string): unknown
}

export interface DesktopUdsRpcRelayOptions {
  resolveSocketPath: () => Promise<string> | string
  isTrustedSender: (event: IpcMainEvent | IpcMainInvokeEvent) => boolean
  getTargetWebContents: () => WebContentsTargetLike | WebContents | undefined
  isTrustedWebContents?: (contents: WebContentsTargetLike | WebContents) => boolean
  ipcMain?: IpcMainLike | IpcMain
  connectSocket?: ConnectUdsSocket
  connectTimeoutMs?: number
  initialReconnectDelayMs?: number
  maxReconnectDelayMs?: number
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000
const DEFAULT_INITIAL_RECONNECT_MS = 250
const DEFAULT_MAX_RECONNECT_MS = 5_000
const MAX_PENDING_CONNECTING_FRAMES = 256

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sameStatus(a: DesktopRpcStatus, b: DesktopRpcStatus): boolean {
  return a.state === b.state && a.error === b.error
}

function normalizeOutboundFrame(frameJson: unknown): string | null {
  if (typeof frameJson !== 'string') return null
  const trimmed = frameJson.replace(/\r?\n$/, '')
  if (!trimmed || trimmed.includes('\n') || trimmed.includes('\r')) return null
  return trimmed
}

/**
 * Main-process UDS JSON-RPC relay connecting Renderer IPC (`window.ludens.rpc`)
 * to `app-server.sock` with NDJSON framing, auto-reconnect, and trusted-frame enforcement.
 */
export class DesktopUdsRpcRelay {
  private readonly options: DesktopUdsRpcRelayOptions
  private readonly connectSocket: ConnectUdsSocket
  private readonly connectTimeoutMs: number
  private readonly initialReconnectDelayMs: number
  private readonly maxReconnectDelayMs: number

  private socket: UdsSocketLike | undefined
  private status: DesktopRpcStatus = { state: 'disconnected' }
  private decoder = new StringDecoder('utf8')
  private lineBuffer = ''
  private pendingWrites: string[] = []
  private reconnectDelayMs: number
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private connectPromise: Promise<void> | undefined
  private reconnectPromise: Promise<void> | undefined
  private disposed = false
  private installed = false

  private readonly onSendListener = (event: IpcMainEvent, rawFrame: unknown) => {
    if (this.disposed || !this.options.isTrustedSender(event)) return
    this.sendFrame(rawFrame)
  }

  private readonly onReadyHandler = (event: IpcMainInvokeEvent): DesktopRpcStatus => {
    if (!this.options.isTrustedSender(event)) {
      throw new Error('Untrusted RPC bridge sender')
    }
    if (!this.disposed && this.status.state === 'disconnected') {
      void this.ensureConnected().catch(() => {})
    }
    return this.currentStatus()
  }

  private readonly onReconnectHandler = async (event: IpcMainInvokeEvent): Promise<void> => {
    if (!this.options.isTrustedSender(event)) {
      throw new Error('Untrusted RPC bridge sender')
    }
    await this.reconnect()
  }

  constructor(options: DesktopUdsRpcRelayOptions) {
    this.options = options
    this.connectSocket = options.connectSocket ?? (socketPath => createConnection({ path: socketPath }))
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.initialReconnectDelayMs = options.initialReconnectDelayMs ?? DEFAULT_INITIAL_RECONNECT_MS
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_MS
    this.reconnectDelayMs = this.initialReconnectDelayMs
  }

  currentStatus(): DesktopRpcStatus {
    return this.status.error
      ? { state: this.status.state, error: this.status.error }
      : { state: this.status.state }
  }

  install(): void {
    if (this.installed || !this.options.ipcMain) return
    this.installed = true
    this.options.ipcMain.on(LUDENS_RPC_CHANNELS.send, this.onSendListener)
    this.options.ipcMain.handle(LUDENS_RPC_CHANNELS.ready, this.onReadyHandler)
    this.options.ipcMain.handle(LUDENS_RPC_CHANNELS.reconnect, this.onReconnectHandler)
  }

  async start(): Promise<void> {
    if (this.disposed) throw new Error('DesktopUdsRpcRelay is disposed')
    this.install()
    await this.ensureConnected()
  }

  async reconnect(): Promise<void> {
    if (this.disposed) throw new Error('DesktopUdsRpcRelay is disposed')
    this.reconnectPromise ??= this.performReconnect().finally(() => {
      this.reconnectPromise = undefined
    })
    return this.reconnectPromise
  }

  sendFrame(rawFrame: unknown): boolean {
    if (this.disposed) return false
    const frame = normalizeOutboundFrame(rawFrame)
    if (!frame) return false

    if (this.status.state === 'connected' && this.socket && !this.socket.destroyed) {
      this.socket.write(`${frame}\n`, 'utf8')
      return true
    }

    if (this.status.state === 'connecting') {
      if (this.pendingWrites.length < MAX_PENDING_CONNECTING_FRAMES) {
        this.pendingWrites.push(frame)
      }
      return true
    }

    // Disconnected: trigger immediate reconnect in background; do not silently replay stale RPCs across sessions
    // except if caller retries once status transitions back to `connected`.
    void this.ensureConnected().catch(() => {})
    return false
  }

  syncStatus(): void {
    this.pushToTarget(LUDENS_RPC_CHANNELS.status, this.currentStatus())
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearReconnectTimer()
    this.pendingWrites = []
    this.destroyActiveSocket()
    if (this.installed && this.options.ipcMain) {
      this.options.ipcMain.removeListener(LUDENS_RPC_CHANNELS.send, this.onSendListener)
      this.options.ipcMain.removeHandler(LUDENS_RPC_CHANNELS.ready)
      this.options.ipcMain.removeHandler(LUDENS_RPC_CHANNELS.reconnect)
      this.installed = false
    }
    this.setStatus({ state: 'disconnected' })
  }

  private async performReconnect(): Promise<void> {
    this.clearReconnectTimer()
    this.pendingWrites = []
    this.destroyActiveSocket()
    this.reconnectDelayMs = this.initialReconnectDelayMs
    this.connectPromise = undefined
    await this.ensureConnected()
  }

  private ensureConnected(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('DesktopUdsRpcRelay is disposed'))
    if (this.status.state === 'connected' && this.socket && !this.socket.destroyed) {
      return Promise.resolve()
    }
    this.connectPromise ??= this.openConnection().finally(() => {
      this.connectPromise = undefined
    })
    return this.connectPromise
  }

  private async openConnection(): Promise<void> {
    this.clearReconnectTimer()
    this.setStatus({ state: 'connecting' })
    this.decoder = new StringDecoder('utf8')
    this.lineBuffer = ''

    let socketPath: string
    try {
      socketPath = await this.options.resolveSocketPath()
    } catch (error) {
      const message = toErrorMessage(error)
      this.pendingWrites = []
      this.setStatus({ state: 'disconnected', error: message })
      this.scheduleReconnect()
      throw error
    }

    if (this.disposed) {
      throw new Error('DesktopUdsRpcRelay is disposed')
    }

    await new Promise<void>((resolveConnect, rejectConnect) => {
      const socket = this.connectSocket(socketPath)
      this.socket = socket

      let connected = false
      let lastError: string | undefined

      const cleanupConnectListeners = () => {
        clearTimeout(connectTimer)
        socket.removeListener('connect', onConnect)
        socket.removeListener('error', onConnectError)
        socket.removeListener('close', onPrematureClose)
      }

      const failConnect = (error: Error) => {
        cleanupConnectListeners()
        if (this.socket === socket) {
          this.socket = undefined
        }
        try { socket.destroy() } catch {}
        this.pendingWrites = []
        this.setStatus({ state: 'disconnected', error: error.message })
        this.scheduleReconnect()
        rejectConnect(error)
      }

      const connectTimer = setTimeout(() => {
        failConnect(new Error(`Timed out connecting to app-server UDS socket (${this.connectTimeoutMs}ms)`))
      }, this.connectTimeoutMs)

      const onConnect = () => {
        if (this.disposed || this.socket !== socket) {
          cleanupConnectListeners()
          try { socket.destroy() } catch {}
          rejectConnect(new Error('UDS RPC connection cancelled'))
          return
        }
        connected = true
        cleanupConnectListeners()
        this.reconnectDelayMs = this.initialReconnectDelayMs
        this.attachLiveListeners(socket, () => lastError)
        this.setStatus({ state: 'connected' })

        const queued = this.pendingWrites
        this.pendingWrites = []
        for (const frame of queued) {
          if (socket.destroyed) break
          socket.write(`${frame}\n`, 'utf8')
        }
        resolveConnect()
      }

      const onConnectError = (err: unknown) => {
        lastError = toErrorMessage(err)
        if (!connected) {
          failConnect(err instanceof Error ? err : new Error(lastError))
        }
      }

      const onPrematureClose = () => {
        if (!connected) {
          failConnect(new Error(lastError ?? 'UDS socket closed before connecting'))
        }
      }

      socket.once('connect', onConnect)
      socket.on('error', onConnectError)
      socket.once('close', onPrematureClose)
    })
  }

  private attachLiveListeners(socket: UdsSocketLike, readLastError: () => string | undefined): void {
    let liveError: string | undefined = readLastError()

    const onData = (chunk: Buffer | string) => {
      if (this.disposed || this.socket !== socket) return
      const decoded = typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
      if (!decoded) return
      this.lineBuffer += decoded
      const parts = this.lineBuffer.split('\n')
      this.lineBuffer = parts.pop() ?? ''
      for (const rawLine of parts) {
        const line = rawLine.replace(/\r$/, '')
        if (!line.trim()) continue
        this.pushToTarget(LUDENS_RPC_CHANNELS.message, line)
      }
    }

    const onError = (err: unknown) => {
      liveError = toErrorMessage(err)
    }

    const onClose = () => {
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      const tail = this.decoder.end()
      if (tail) {
        this.lineBuffer += tail
        const parts = this.lineBuffer.split('\n')
        this.lineBuffer = parts.pop() ?? ''
        for (const rawLine of parts) {
          const line = rawLine.replace(/\r$/, '')
          if (!line.trim()) continue
          this.pushToTarget(LUDENS_RPC_CHANNELS.message, line)
        }
      }
      if (this.socket !== socket) return
      this.socket = undefined
      this.pendingWrites = []
      if (!this.disposed) {
        this.setStatus(
          liveError
            ? { state: 'disconnected', error: liveError }
            : { state: 'disconnected' },
        )
        this.scheduleReconnect()
      }
    }

    socket.on('data', onData)
    socket.on('error', onError)
    socket.once('close', onClose)
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer || this.connectPromise) return
    const delay = this.reconnectDelayMs
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.maxReconnectDelayMs)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (this.disposed) return
      void this.ensureConnected().catch(() => {})
    }, delay)
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
  }

  private destroyActiveSocket(): void {
    const active = this.socket
    this.socket = undefined
    if (!active) return
    try {
      active.removeAllListeners()
      active.destroy()
    } catch {}
  }

  private setStatus(next: DesktopRpcStatus): void {
    if (sameStatus(this.status, next)) return
    this.status = next
    this.pushToTarget(LUDENS_RPC_CHANNELS.status, this.currentStatus())
  }

  private pushToTarget(channel: string, payload: unknown): void {
    const target = this.options.getTargetWebContents()
    if (!target || target.isDestroyed()) return
    if (this.options.isTrustedWebContents && !this.options.isTrustedWebContents(target)) return
    try {
      target.send(channel, payload)
    } catch {}
  }
}
