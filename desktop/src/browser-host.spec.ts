import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BUILTIN_BROWSER_START_URL,
  viewportFormatMimeType,
  type BrowserHostCaptureResult,
  type BrowserHostEvent,
  type BrowserHostPingResult,
  type BrowserHostRequest,
  type BrowserHostWireMessage,
  type DesktopViewportAttachInput,
  type ViewportFrameFormat,
  type ViewportState,
} from '@ludens/protocol/viewport'
import type { BrowserHostRuntimeInfo } from '@ludens/protocol/browser-host-paths'
import {
  BrowserHost,
  isAllowedBrowserNavigationUrl,
  normalizeViewportBounds,
  validateBrowserNavigationUrl,
  type BrowserPlayResult,
  type BrowserReleaseAllResult,
  type BrowserSessionBackend,
  type BrowserSessionCreateParams,
  type BrowserSessionDispatchKeyInput,
  type BrowserSessionDispatchMouseInput,
  type BrowserSessionFrame,
  type BrowserSessionRelativeMouseInput,
} from './browser-host.js'
import { buildBrowserStartPageHtml } from './browser-start-page.js'

class FakeSessionBackend implements BrowserSessionBackend {
  readonly sessionId: string
  readonly hostId: string
  readonly partition: string
  width: number
  height: number
  history: string[] = []
  historyIndex = -1
  title = 'Ludens WebGL Arena'
  pointerLocked = false
  streaming = false
  closed = false

  readonly keyEvents: BrowserSessionDispatchKeyInput[] = []
  readonly mouseEvents: BrowserSessionDispatchMouseInput[] = []
  readonly relativeMouseEvents: BrowserSessionRelativeMouseInput[] = []
  readonly typedTexts: string[] = []
  readonly attachCalls: Array<{ owner: unknown; input: DesktopViewportAttachInput }> = []
  readonly updateBoundsCalls: Array<{ owner: unknown; input: DesktopViewportAttachInput }> = []
  readonly detachCalls: unknown[] = []

  private readonly frameListeners = new Set<(frame: BrowserSessionFrame) => void>()
  private readonly stateListeners = new Set<(state: ViewportState) => void>()
  private seq = 0

  constructor(params: BrowserSessionCreateParams) {
    this.sessionId = params.sessionId
    this.hostId = params.hostId
    this.partition = params.partition
    this.width = params.width
    this.height = params.height
  }

  private buildState(): ViewportState {
    const url = this.history[this.historyIndex] ?? BUILTIN_BROWSER_START_URL
    return {
      stageKind: 'browser',
      available: !this.closed,
      connected: !this.closed,
      machineId: 'builtin-browser',
      driver: 'browser',
      sessionId: this.sessionId,
      nativeHostId: this.hostId,
      width: this.width,
      height: this.height,
      pointerLocked: this.pointerLocked,
      controlMode: 'manual',
      navigation: {
        url,
        title: this.title,
        loading: false,
        canGoBack: this.historyIndex > 0,
        canGoForward: this.historyIndex >= 0 && this.historyIndex < this.history.length - 1,
      },
      capabilities: {
        navigate: true,
        keyboard: true,
        mouse: true,
        pointerLock: true,
        resize: true,
        nativeEmbed: true,
      },
    }
  }

  pushFrame(dataBase64 = 'ZmFrZS1qcGVn', format: ViewportFrameFormat = 'jpeg'): BrowserSessionFrame {
    const frame: BrowserSessionFrame = {
      format,
      dataBase64,
      width: this.width,
      height: this.height,
      timestampMs: Date.now(),
      seq: ++this.seq,
      pointerLocked: this.pointerLocked,
    }
    for (const listener of this.frameListeners) listener(frame)
    return frame
  }

  private emitState(): ViewportState {
    const state = this.buildState()
    for (const listener of this.stateListeners) listener(state)
    return state
  }

  async loadStartPage(_dataUrl: string, logicalUrl: string): Promise<ViewportState> {
    this.history = this.history.slice(0, this.historyIndex + 1)
    this.history.push(logicalUrl)
    this.historyIndex = this.history.length - 1
    this.title = 'Ludens WebGL Arena'
    return this.emitState()
  }

  async navigate(url: string): Promise<ViewportState> {
    this.history = this.history.slice(0, this.historyIndex + 1)
    this.history.push(url)
    this.historyIndex = this.history.length - 1
    this.title = `Page: ${url}`
    return this.emitState()
  }

  async back(): Promise<ViewportState> {
    if (this.historyIndex > 0) this.historyIndex -= 1
    return this.emitState()
  }

  async forward(): Promise<ViewportState> {
    if (this.historyIndex < this.history.length - 1) this.historyIndex += 1
    return this.emitState()
  }

  async reload(): Promise<ViewportState> {
    return this.emitState()
  }

  async resize(width: number, height: number): Promise<ViewportState> {
    this.width = width
    this.height = height
    return this.emitState()
  }

  async describe(): Promise<ViewportState> {
    return this.buildState()
  }

  async capture(options?: { format?: ViewportFrameFormat; quality?: number }): Promise<BrowserHostCaptureResult> {
    const format = options?.format ?? 'jpeg'
    const state = this.buildState()
    return {
      format,
      mediaType: viewportFormatMimeType(format),
      dataBase64: 'Y2FwdHVyZWQtZnJhbWU=',
      width: this.width,
      height: this.height,
      seq: ++this.seq,
      timestampMs: Date.now(),
      pointerLocked: this.pointerLocked,
      url: state.navigation?.url ?? BUILTIN_BROWSER_START_URL,
      title: state.navigation?.title ?? '',
    }
  }

  async dispatchKeyEvent(input: BrowserSessionDispatchKeyInput): Promise<void> {
    this.keyEvents.push(input)
  }

  async dispatchMouseEvent(input: BrowserSessionDispatchMouseInput): Promise<void> {
    this.mouseEvents.push(input)
  }

  async dispatchRelativeMouseMove(input: BrowserSessionRelativeMouseInput): Promise<void> {
    this.relativeMouseEvents.push(input)
  }

  async insertText(text: string): Promise<void> {
    this.typedTexts.push(text)
  }

  async setStreaming(active: boolean): Promise<void> {
    this.streaming = active
  }

  onFrame(listener: (frame: BrowserSessionFrame) => void): () => void {
    this.frameListeners.add(listener)
    return () => this.frameListeners.delete(listener)
  }

  onState(listener: (state: ViewportState) => void): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  async attachToOwner(owner: unknown, input: DesktopViewportAttachInput): Promise<void> {
    this.attachCalls.push({ owner, input })
  }

  async updateOwnerBounds(owner: unknown, input: DesktopViewportAttachInput): Promise<void> {
    this.updateBoundsCalls.push({ owner, input })
  }

  async detachFromOwner(owner: unknown): Promise<void> {
    this.detachCalls.push(owner)
  }

  async close(): Promise<void> {
    this.closed = true
    this.frameListeners.clear()
    this.stateListeners.clear()
  }
}

class TestUdsClient {
  private readonly socket: Socket
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  readonly events: BrowserHostEvent[] = []
  private readonly eventWaiters: Array<(ev: BrowserHostEvent) => void> = []
  private seq = 0

  private constructor(socket: Socket) {
    this.socket = socket
    const decoder = new StringDecoder('utf8')
    let buffer = ''
    socket.on('data', chunk => {
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk)
      let idx = buffer.indexOf('\n')
      while (idx !== -1) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (line) this.handleMessage(JSON.parse(line) as BrowserHostWireMessage)
        idx = buffer.indexOf('\n')
      }
    })
  }

  static async connect(socketPath: string): Promise<TestUdsClient> {
    const socket = createConnection({ path: socketPath })
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('error', reject)
    })
    return new TestUdsClient(socket)
  }

  private handleMessage(msg: BrowserHostWireMessage): void {
    if ('event' in msg) {
      this.events.push(msg.event)
      const waiter = this.eventWaiters.shift()
      if (waiter) waiter(msg.event)
      return
    }
    const entry = this.pending.get(msg.id)
    if (!entry) return
    this.pending.delete(msg.id)
    if (msg.ok) entry.resolve(msg.value)
    else entry.reject(new Error(msg.error))
  }

  call<T = unknown>(request: BrowserHostRequest, explicitId?: string): Promise<T> {
    const id = explicitId ?? `req-${++this.seq}`
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: v => resolve(v as T), reject })
      this.socket.write(`${JSON.stringify({ id, request })}\n`)
    })
  }

  waitForEvent(predicate: (ev: BrowserHostEvent) => boolean, timeoutMs = 1_500): Promise<BrowserHostEvent> {
    const existing = this.events.find(predicate)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for BrowserHostEvent')), timeoutMs)
      const check = (ev: BrowserHostEvent) => {
        if (predicate(ev)) {
          clearTimeout(timer)
          resolve(ev)
        } else {
          this.eventWaiters.push(check)
        }
      }
      this.eventWaiters.push(check)
    })
  }

  close(): Promise<void> {
    return new Promise(resolve => {
      if (this.socket.destroyed) return resolve()
      this.socket.once('close', () => resolve())
      this.socket.destroy()
    })
  }
}

const tempDirs: string[] = []
const hosts: BrowserHost[] = []

async function createTempHost() {
  const dir = await mkdtemp(join(tmpdir(), 'ludens-bh-'))
  tempDirs.push(dir)
  const backends = new Map<string, FakeSessionBackend>()
  const host = new BrowserHost({
    home: dir,
    hostId: 'test-host-001',
    sessionFactory: params => {
      const backend = new FakeSessionBackend(params)
      backends.set(params.sessionId, backend)
      return backend
    },
  })
  hosts.push(host)
  const info = await host.start()
  return { dir, host, info, backends }
}

afterEach(async () => {
  while (hosts.length > 0) {
    await hosts.pop()!.close().catch(() => {})
  }
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true }).catch(() => {})
  }
})

describe('browser-start-page', () => {
  it('generates a self-contained zero-network 3D WebGL Arena HTML document', () => {
    const html = buildBrowserStartPageHtml()
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('<title>Ludens WebGL Arena</title>')
    expect(html).toContain('<canvas id="arena"')
    expect(html).toContain('requestPointerLock')
    expect(html).toContain('hud-fps')
    expect(html).toContain('hud-score')
    expect(html).toContain('keys-hud')
    // Zero external network dependencies
    expect(html).not.toMatch(/https?:\/\//i)
  })
})

describe('URL security & bounds normalization', () => {
  it('allows BUILTIN_BROWSER_START_URL, http(s), and about:blank', () => {
    const start = validateBrowserNavigationUrl(BUILTIN_BROWSER_START_URL)
    expect(start.kind).toBe('start')
    expect(start.logicalUrl).toBe(BUILTIN_BROWSER_START_URL)
    expect(start.targetUrl.startsWith('data:text/html;charset=utf-8,')).toBe(true)

    expect(validateBrowserNavigationUrl('https://threejs.org/examples/').logicalUrl).toBe(
      'https://threejs.org/examples/',
    )
    expect(validateBrowserNavigationUrl('http://localhost:5173/game').logicalUrl).toBe(
      'http://localhost:5173/game',
    )
    expect(validateBrowserNavigationUrl('about:blank').logicalUrl).toBe('about:blank')
  })

  it('blocks ludens-app:, ludens-media:, file:, javascript:, and arbitrary data: URLs', () => {
    const blocked = [
      'ludens-app://console/',
      'ludens-media://asset/123',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<h1>evil</h1>',
      'chrome://settings',
      '',
      'not a valid url',
    ]
    for (const url of blocked) {
      expect(isAllowedBrowserNavigationUrl(url)).toBe(false)
      expect(() => validateBrowserNavigationUrl(url)).toThrow()
    }
  })

  it('normalizes viewport bounds to non-negative integers', () => {
    expect(normalizeViewportBounds({ x: 10.6, y: -4.2, width: 640.4, height: 360.8 })).toEqual({
      x: 11,
      y: 0,
      width: 640,
      height: 361,
    })
  })
})

describe('BrowserHost UDS protocol, sessions, inputs, and native attachment', () => {
  it('writes atomic runtime JSON, sets 0600 socket perms on POSIX, responds to ping, and cleans up on close', async () => {
    const { host, info } = await createTempHost()
    expect(existsSync(host.runtimeFilePath)).toBe(true)
    const runtimeJson = JSON.parse(await readFile(host.runtimeFilePath, 'utf8')) as BrowserHostRuntimeInfo
    expect(runtimeJson.hostId).toBe('test-host-001')
    expect(runtimeJson.socketPath).toBe(info.socketPath)
    expect(runtimeJson.pid).toBe(process.pid)

    if (process.platform !== 'win32') {
      const sockStat = await stat(host.socketPath)
      expect(sockStat.mode & 0o777).toBe(0o600)
    }

    const client = await TestUdsClient.connect(host.socketPath)
    const ping = await client.call<BrowserHostPingResult>({ kind: 'ping' })
    expect(ping.hostId).toBe('test-host-001')
    expect(ping.pid).toBe(process.pid)
    expect(ping.sessions).toEqual([])
    await client.close()

    await host.close()
    expect(existsSync(host.socketPath)).toBe(false)
    expect(existsSync(host.runtimeFilePath)).toBe(false)
  })

  it('does not delete runtime file owned by another hostId on close', async () => {
    const { host } = await createTempHost()
    await writeFile(
      host.runtimeFilePath,
      JSON.stringify({ hostId: 'newer-host-id', pid: 999999 }),
      'utf8',
    )
    await host.close()
    expect(existsSync(host.runtimeFilePath)).toBe(true)
  })

  it('creates isolated per-session partitions, enforces URL security, preserves open page on re-ensure, and streams frames/state', async () => {
    const { host, backends } = await createTempHost()
    const client = await TestUdsClient.connect(host.socketPath)

    const s1 = await client.call<ViewportState>({
      kind: 'session.ensure',
      sessionId: 'ws-alpha',
      width: 1280,
      height: 720,
    })
    expect(s1.sessionId).toBe('ws-alpha')
    expect(s1.nativeHostId).toBe('test-host-001')
    expect(s1.navigation?.url).toBe(BUILTIN_BROWSER_START_URL)
    expect(backends.get('ws-alpha')?.partition).toBe('persist:ludens-browser-ws-alpha')

    // Reject blocked navigation over UDS
    await expect(
      client.call({
        kind: 'session.action',
        sessionId: 'ws-alpha',
        action: { kind: 'navigate', url: 'ludens-app://console/' },
      }),
    ).rejects.toThrow(/Blocked browser navigation protocol/)
    await expect(
      client.call({
        kind: 'session.action',
        sessionId: 'ws-alpha',
        action: { kind: 'navigate', url: 'file:///etc/passwd' },
      }),
    ).rejects.toThrow(/Blocked browser navigation protocol/)

    // Valid navigation + back/forward/resize
    const navState = await client.call<ViewportState>({
      kind: 'session.action',
      sessionId: 'ws-alpha',
      action: { kind: 'navigate', url: 'https://example.com/game' },
    })
    expect(navState.navigation?.url).toBe('https://example.com/game')
    expect(navState.navigation?.canGoBack).toBe(true)

    // Repeated session.ensure must preserve the open page
    const reEnsured = await client.call<ViewportState>({
      kind: 'session.ensure',
      sessionId: 'ws-alpha',
      initialUrl: BUILTIN_BROWSER_START_URL,
    })
    expect(reEnsured.navigation?.url).toBe('https://example.com/game')

    // Subscribe and receive initial state + pushed frame
    await client.call({ kind: 'session.subscribe', sessionId: 'ws-alpha' })
    const initialStateEv = await client.waitForEvent(e => e.event === 'state')
    expect(initialStateEv.event).toBe('state')

    backends.get('ws-alpha')!.pushFrame('YWJjMTIz')
    const frameEv = await client.waitForEvent(e => e.event === 'frame')
    expect(frameEv.event).toBe('frame')
    if (frameEv.event === 'frame') {
      expect(frameEv.dataBase64).toBe('YWJjMTIz')
      expect(frameEv.sessionId).toBe('ws-alpha')
    }

    // Capture works cleanly
    const capture = await client.call<BrowserHostCaptureResult>({
      kind: 'session.capture',
      sessionId: 'ws-alpha',
      format: 'jpeg',
    })
    expect(capture.mediaType).toBe('image/jpeg')
    expect(capture.dataBase64).toBe('Y2FwdHVyZWQtZnJhbWU=')

    await client.call({ kind: 'session.unsubscribe', sessionId: 'ws-alpha' })
    await client.close()
  })

  it('tracks held keys & mouse buttons, clamps mouseMoveRelative, and deterministically releases all on releaseAll', async () => {
    const { host, backends } = await createTempHost()
    const client = await TestUdsClient.connect(host.socketPath)

    await client.call({ kind: 'session.ensure', sessionId: 'ws-input', width: 800, height: 600 })
    const backend = backends.get('ws-input')!

    await client.call({
      kind: 'session.input',
      sessionId: 'ws-input',
      input: { type: 'keyDown', key: 'w', code: 'KeyW' },
    })
    await client.call({
      kind: 'session.input',
      sessionId: 'ws-input',
      input: { type: 'keyDown', key: 'Shift', code: 'ShiftLeft' },
    })
    await client.call({
      kind: 'session.input',
      sessionId: 'ws-input',
      input: { type: 'mouseDown', x: 400, y: 300, button: 'left' },
    })
    await client.call({
      kind: 'session.input',
      sessionId: 'ws-input',
      input: { type: 'mouseMoveRelative', dx: 600, dy: -500 },
    })
    await client.call({
      kind: 'session.type',
      sessionId: 'ws-input',
      text: 'hello',
    })

    // Virtual cursor clamped to [0..800, 0..600] while preserving raw dx/dy
    expect(backend.relativeMouseEvents).toHaveLength(1)
    expect(backend.relativeMouseEvents[0]).toMatchObject({
      x: 800,
      y: 0,
      dx: 600,
      dy: -500,
      buttons: 1,
    })
    expect(backend.typedTexts).toEqual(['hello'])

    const released = await client.call<BrowserReleaseAllResult>({
      kind: 'session.releaseAll',
      sessionId: 'ws-input',
    })
    expect(released.ok).toBe(true)
    expect(released.releasedKeys).toEqual(['w', 'Shift'])
    expect(released.releasedButtons).toEqual(['left'])

    const keyUps = backend.keyEvents.filter(e => e.type === 'keyUp').map(e => e.key)
    expect(keyUps).toEqual(['w', 'Shift'])
    const mouseUps = backend.mouseEvents.filter(e => e.type === 'mouseReleased').map(e => e.button)
    expect(mouseUps).toEqual(['left'])

    // Second releaseAll is a clean no-op
    const releasedAgain = await client.call<BrowserReleaseAllResult>({
      kind: 'session.releaseAll',
      sessionId: 'ws-input',
    })
    expect(releasedAgain.releasedKeys).toEqual([])
    expect(releasedAgain.releasedButtons).toEqual([])

    await client.close()
  })

  it('executes session.play timeline sorted by atMs and releases held inputs cleanly when cancelled', async () => {
    const { host, backends } = await createTempHost()
    const client = await TestUdsClient.connect(host.socketPath)

    await client.call({ kind: 'session.ensure', sessionId: 'ws-play', width: 800, height: 600 })
    const backend = backends.get('ws-play')!

    // Out-of-order steps sorted by atMs
    const completed = await client.call<BrowserPlayResult>({
      kind: 'session.play',
      sessionId: 'ws-play',
      steps: [
        { atMs: 25, durationMs: 15, keys: ['d'] },
        { atMs: 0, durationMs: 15, keys: ['w'] },
      ],
    })
    expect(completed).toEqual({ ok: true, executedSteps: 2, cancelled: false })
    const keyDownOrder = backend.keyEvents.filter(e => e.type === 'keyDown').map(e => e.key)
    const keyUpOrder = backend.keyEvents.filter(e => e.type === 'keyUp').map(e => e.key)
    expect(keyDownOrder).toEqual(['w', 'd'])
    expect(keyUpOrder).toEqual(['w', 'd'])

    backend.keyEvents.length = 0
    backend.mouseEvents.length = 0

    // Long-held play operation cancelled mid-flight
    const playPromise = client.call<BrowserPlayResult>(
      {
        kind: 'session.play',
        sessionId: 'ws-play',
        steps: [
          { atMs: 0, durationMs: 5_000, keys: ['w', ' '], mouseButton: 'left', x: 200, y: 200 },
          { atMs: 2_000, durationMs: 500, keys: ['a'] },
        ],
      },
      'op-play-cancel',
    )

    // Wait briefly so step 0 presses keys & mouse
    await new Promise(r => setTimeout(r, 35))
    const cancelRes = await client.call<{ ok: true; cancelled: boolean }>({
      kind: 'cancel',
      operationId: 'op-play-cancel',
    })
    expect(cancelRes).toEqual({ ok: true, cancelled: true })

    const playRes = await playPromise
    expect(playRes.cancelled).toBe(true)
    expect(playRes.executedSteps).toBe(1)

    // All inputs held by step 0 were deterministically released on cancellation
    expect(backend.keyEvents.filter(e => e.type === 'keyUp').map(e => e.key)).toEqual(['w', ' '])
    expect(backend.mouseEvents.filter(e => e.type === 'mouseReleased').map(e => e.button)).toEqual(['left'])

    // Step 1 ('a') never fired
    expect(backend.keyEvents.some(e => e.key === 'a')).toBe(false)

    await client.close()
  })

  it('manages native owner attachment, session switching, modal visibility, bounds updates, and tray suspend/resume', async () => {
    const { host, backends } = await createTempHost()
    const fakeOwner = { id: 'owner-window-1' }

    await host.attachToOwner(fakeOwner, {
      sessionId: 'ws-1',
      bounds: { x: 420.4, y: 44.6, width: 600.2, height: 500.8 },
      visible: true,
      interactive: true,
    })

    const b1 = backends.get('ws-1')!
    expect(b1.attachCalls).toHaveLength(1)
    expect(b1.attachCalls[0].input.bounds).toEqual({ x: 420, y: 45, width: 600, height: 501 })

    // Update bounds without repeating sessionId + toggle Auto non-interactive mode & modal hide
    await host.updateOwnerBounds(fakeOwner, {
      bounds: { x: 400, y: 44, width: 620, height: 500 },
      visible: false,
      interactive: false,
    })
    expect(b1.updateBoundsCalls).toHaveLength(1)
    expect(b1.updateBoundsCalls[0].input).toMatchObject({
      sessionId: 'ws-1',
      visible: false,
      interactive: false,
    })

    // Switching owner to ws-2 detaches ws-1 first
    await host.attachToOwner(fakeOwner, {
      sessionId: 'ws-2',
      initialUrl: 'https://example.org',
      bounds: { x: 400, y: 44, width: 620, height: 500 },
      visible: true,
      interactive: true,
    })
    expect(b1.detachCalls).toHaveLength(1)
    const b2 = backends.get('ws-2')!
    expect(b2.attachCalls).toHaveLength(1)
    expect((await b2.describe()).navigation?.url).toBe('https://example.org/')

    // Suspend on tray hide, resume on show
    await host.suspendOwnerView(fakeOwner)
    expect(b2.detachCalls).toHaveLength(1)
    await host.resumeOwnerView(fakeOwner)
    expect(b2.attachCalls).toHaveLength(2)

    await host.detachFromOwner(fakeOwner)
    expect(b2.detachCalls).toHaveLength(2)
  })
})
