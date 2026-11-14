import { EventEmitter } from 'node:events'
import { createServer, type Socket } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LUDENS_RPC_CHANNELS, type DesktopRpcStatus } from './rpc-channels.js'
import {
  DesktopUdsRpcRelay,
  type IpcMainLike,
  type UdsSocketLike,
  type WebContentsTargetLike,
} from './rpc-bridge.js'

class MockUdsSocket extends EventEmitter implements UdsSocketLike {
  destroyed = false
  writable = true
  readonly written: string[] = []

  write(chunk: string): boolean {
    if (this.destroyed) return false
    this.written.push(chunk)
    return true
  }

  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true
      this.writable = false
      queueMicrotask(() => {
        this.emit('close')
      })
    }
    return this
  }
}

class MockIpcMain implements IpcMainLike {
  readonly listeners = new Map<string, (event: unknown, ...args: unknown[]) => void>()
  readonly handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void {
    this.listeners.set(channel, listener as never)
  }

  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void {
    if (this.listeners.get(channel) === listener) {
      this.listeners.delete(channel)
    }
  }

  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void {
    this.handlers.set(channel, listener as never)
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel)
  }

  emitSend(event: unknown, frame: unknown): void {
    this.listeners.get(LUDENS_RPC_CHANNELS.send)?.(event, frame)
  }

  async invoke(channel: string, event: unknown): Promise<unknown> {
    const handler = this.handlers.get(channel)
    if (!handler) throw new Error(`Missing handler for ${channel}`)
    return handler(event)
  }
}

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!()
  }
})

describe('DesktopUdsRpcRelay', () => {
  it('relays NDJSON lines bidirectionally over a real Unix socket and validates sender trust', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ludens-rpc-relay-'))
    const socketPath = join(dir, 'test.sock')
    const serverSockets: Socket[] = []
    const receivedOnServer: string[] = []

    const server = createServer(conn => {
      serverSockets.push(conn)
      conn.setEncoding('utf8')
      let buf = ''
      conn.on('data', chunk => {
        buf += chunk
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (line.trim()) {
            receivedOnServer.push(line)
            const parsed = JSON.parse(line) as { id: number }
            conn.write(`${JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { ok: true } })}\n`)
          }
        }
      })
    })
    await new Promise<void>(resolve => server.listen(socketPath, resolve))
    cleanups.push(async () => {
      for (const s of serverSockets) s.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
      rmSync(dir, { recursive: true, force: true })
    })

    const ipcMain = new MockIpcMain()
    const pushed: Array<{ channel: string; payload: unknown }> = []
    const webContents: WebContentsTargetLike = {
      isDestroyed: () => false,
      send: (channel, payload) => {
        pushed.push({ channel, payload })
      },
      mainFrame: { url: 'ludens-app://console/?view=live' },
    }
    const trustedEvent = { id: 'trusted' } as never
    const untrustedEvent = { id: 'evil' } as never

    const relay = new DesktopUdsRpcRelay({
      resolveSocketPath: () => socketPath,
      isTrustedSender: event => event === trustedEvent,
      getTargetWebContents: () => webContents,
      isTrustedWebContents: target => target.mainFrame?.url.startsWith('ludens-app://console/') ?? false,
      ipcMain,
    })
    cleanups.push(() => relay.dispose())

    await relay.start()
    expect(relay.currentStatus()).toEqual({ state: 'connected' })
    expect(await ipcMain.invoke(LUDENS_RPC_CHANNELS.ready, trustedEvent)).toEqual({ state: 'connected' })
    await expect(ipcMain.invoke(LUDENS_RPC_CHANNELS.ready, untrustedEvent)).rejects.toThrow(/Untrusted/i)

    // Untrusted send is silently dropped; newline-injected frame is rejected
    ipcMain.emitSend(untrustedEvent, '{"jsonrpc":"2.0","id":1,"method":"daemon/status"}')
    ipcMain.emitSend(trustedEvent, '{"jsonrpc":"2.0","id":1}\n{"malicious":true}')
    ipcMain.emitSend(trustedEvent, JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'daemon/status' }))

    await vi.waitFor(() => {
      expect(pushed.some(entry => entry.channel === LUDENS_RPC_CHANNELS.message)).toBe(true)
    })

    expect(receivedOnServer).toEqual(['{"jsonrpc":"2.0","id":42,"method":"daemon/status"}'])
    const messagePushes = pushed.filter(entry => entry.channel === LUDENS_RPC_CHANNELS.message)
    expect(messagePushes.map(entry => entry.payload)).toEqual([
      '{"jsonrpc":"2.0","id":42,"result":{"ok":true}}',
    ])
  })

  it('auto-reconnects with status updates when the socket drops or reconnect() is invoked', async () => {
    const sockets: MockUdsSocket[] = []
    let resolveCount = 0
    const statuses: DesktopRpcStatus[] = []
    const messages: string[] = []
    const ipcMain = new MockIpcMain()

    const webContents: WebContentsTargetLike = {
      isDestroyed: () => false,
      send: (channel, payload) => {
        if (channel === LUDENS_RPC_CHANNELS.status) statuses.push(payload as DesktopRpcStatus)
        if (channel === LUDENS_RPC_CHANNELS.message) messages.push(payload as string)
      },
    }
    const trustedEvent = { ok: true } as never

    const relay = new DesktopUdsRpcRelay({
      resolveSocketPath: () => {
        resolveCount += 1
        return `/tmp/mock-${resolveCount}.sock`
      },
      isTrustedSender: event => event === trustedEvent,
      getTargetWebContents: () => webContents,
      ipcMain,
      initialReconnectDelayMs: 15,
      maxReconnectDelayMs: 60,
      connectSocket: () => {
        const sock = new MockUdsSocket()
        sockets.push(sock)
        queueMicrotask(() => sock.emit('connect'))
        return sock
      },
    })
    cleanups.push(() => relay.dispose())

    await relay.start()
    expect(statuses.map(s => s.state)).toEqual(['connecting', 'connected'])

    // Split UTF-8 chunk across reads -> cleanly reassembles NDJSON lines
    sockets[0].emit('data', Buffer.from('{"text":"你', 'utf8'))
    sockets[0].emit('data', Buffer.from('好"}\n{"id":2}\n', 'utf8'))
    expect(messages).toEqual(['{"text":"你好"}', '{"id":2}'])

    // Simulate daemon drop -> disconnected -> connecting -> connected
    sockets[0].destroy()
    await vi.waitFor(() => {
      expect(sockets.length).toBe(2)
      expect(relay.currentStatus().state).toBe('connected')
    })
    expect(statuses.map(s => s.state)).toEqual([
      'connecting',
      'connected',
      'disconnected',
      'connecting',
      'connected',
    ])

    // Explicit IPC reconnect handler spawns a fresh socket via resolveSocketPath
    await ipcMain.invoke(LUDENS_RPC_CHANNELS.reconnect, trustedEvent)
    expect(sockets.length).toBe(3)
    expect(resolveCount).toBe(3)
  })
})
