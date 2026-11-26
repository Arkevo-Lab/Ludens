import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import {
  browserHostRuntimeFilePath,
  resolveBrowserHostSocketPath,
  type BrowserHostRuntimeInfo,
} from '@ludens/protocol/browser-host-paths'
import { clearStaleLocalSocket, isWindowsNamedPipe } from '@ludens/protocol/local-socket'
import { ludensHome } from '@ludens/protocol/ludens'
import {
  BUILTIN_BROWSER_START_URL,
  DEFAULT_VIEWPORT_HEIGHT,
  DEFAULT_VIEWPORT_WIDTH,
  viewportFormatMimeType,
  type BrowserHostCaptureResult,
  type BrowserHostEnvelope,
  type BrowserHostEvent,
  type BrowserHostPingResult,
  type BrowserHostRequest,
  type BrowserHostWireMessage,
  type BrowserInputStep,
  type DesktopViewportAttachInput,
  type MouseButtonName,
  type NativeViewportBounds,
  type ViewportControlAction,
  type ViewportFrameFormat,
  type ViewportHumanInput,
  type ViewportState,
} from '@ludens/protocol/viewport'
import type { BrowserWindow, WebContentsView } from 'electron'
import {
  createBrowserUrlPreferenceStore,
  type BrowserUrlPreferenceStore,
} from './browser-preferences.js'
import { buildBrowserStartPageHtml } from './browser-start-page.js'
import type { DesktopViewportFramePayload } from './rpc-channels.js'

export const BROWSER_HOST_VERSION = '1.0.0'

const MIN_VIEWPORT_DIM = 160
const MAX_VIEWPORT_DIM = 3840
const DEFAULT_PLAY_TAP_MS = 40
const SUBSCRIBER_HIGH_WATER_BYTES = 512 * 1024
const SCREENCAST_STALL_MS = 350
const FALLBACK_PUMP_INTERVAL_MS = 100
const CACHED_FRAME_FRESH_MS = 2_000

const BLOCKED_PROTOCOLS = new Set(['ludens-app:', 'ludens-media:', 'file:', 'javascript:', 'data:', 'chrome:', 'devtools:'])
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:'])

let cachedStartPageDataUrl: string | undefined

export function getBrowserStartPageDataUrl(): string {
  if (!cachedStartPageDataUrl) {
    cachedStartPageDataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(buildBrowserStartPageHtml())}`
  }
  return cachedStartPageDataUrl
}

export interface ValidatedNavigationTarget {
  kind: 'start' | 'external'
  logicalUrl: string
  targetUrl: string
}

/** Validate a requested navigation URL against Built-in Browser security rules. */
export function validateBrowserNavigationUrl(rawUrl: string): ValidatedNavigationTarget {
  const trimmed = rawUrl.trim()
  if (!trimmed) {
    throw new Error('Navigation URL must not be empty')
  }
  if (trimmed === BUILTIN_BROWSER_START_URL) {
    return {
      kind: 'start',
      logicalUrl: BUILTIN_BROWSER_START_URL,
      targetUrl: getBrowserStartPageDataUrl(),
    }
  }
  if (trimmed === 'about:blank') {
    return {
      kind: 'external',
      logicalUrl: 'about:blank',
      targetUrl: 'about:blank',
    }
  }
  let candidate = trimmed
  const hasExplicitScheme =
    /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate) ||
    /^(ludens-app|ludens-media|file|javascript|data|chrome|devtools|about|mailto|blob):/i.test(candidate)
  if (!hasExplicitScheme) {
    if (/\s/.test(candidate)) {
      throw new Error(`Invalid browser navigation URL: ${rawUrl}`)
    }
    const isLoopback = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(candidate)
    const isDomainLike = /^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+(?::\d+)?(?:[/?#]|$)/.test(candidate)
    if (isLoopback) {
      candidate = `http://${candidate}`
    } else if (isDomainLike) {
      candidate = `https://${candidate}`
    }
  }
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new Error(`Invalid browser navigation URL: ${rawUrl}`)
  }
  if (BLOCKED_PROTOCOLS.has(parsed.protocol) || !ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`Blocked browser navigation protocol: ${parsed.protocol}`)
  }
  return {
    kind: 'external',
    logicalUrl: parsed.href,
    targetUrl: parsed.href,
  }
}

export function isAllowedBrowserNavigationUrl(rawUrl: string): boolean {
  try {
    validateBrowserNavigationUrl(rawUrl)
    return true
  } catch {
    return false
  }
}

export function isAllowedExternalHttpUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl)
    return ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol)
  } catch {
    return false
  }
}

export function normalizeViewportBounds(bounds: NativeViewportBounds): NativeViewportBounds {
  const x = Number.isFinite(bounds.x) ? Math.max(0, Math.round(bounds.x)) : 0
  const y = Number.isFinite(bounds.y) ? Math.max(0, Math.round(bounds.y)) : 0
  const width = Number.isFinite(bounds.width) ? Math.max(0, Math.round(bounds.width)) : 0
  const height = Number.isFinite(bounds.height) ? Math.max(0, Math.round(bounds.height)) : 0
  return { x, y, width, height }
}

function clampDimension(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(MIN_VIEWPORT_DIM, Math.min(MAX_VIEWPORT_DIM, Math.round(value)))
}

function clampCoord(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(Math.max(0, max), value))
}

function mouseButtonBit(button: MouseButtonName): number {
  switch (button) {
    case 'left':
      return 1
    case 'right':
      return 2
    case 'middle':
      return 4
  }
}

function buttonsBitmask(buttons: ReadonlySet<MouseButtonName>): number {
  let mask = 0
  for (const b of buttons) mask |= mouseButtonBit(b)
  return mask
}

function canonicalKeyId(key: string, code?: string): string {
  return (code && code.trim().length > 0 ? code.trim() : key).toLowerCase()
}

interface CdpKeyDescriptor {
  key: string
  code: string
  windowsVirtualKeyCode: number
  text?: string
}

const SPECIAL_KEY_MAP: Record<string, CdpKeyDescriptor> = {
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  ' ': { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  spacebar: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  shift: { key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 },
  control: { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 },
  ctrl: { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 },
  alt: { key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18 },
  meta: { key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91 },
}

export function resolveCdpKeyDescriptor(key: string, code?: string, text?: string): CdpKeyDescriptor {
  const lower = key.toLowerCase()
  const mapped = SPECIAL_KEY_MAP[lower]
  if (mapped) {
    return {
      key: mapped.key,
      code: code || mapped.code,
      windowsVirtualKeyCode: mapped.windowsVirtualKeyCode,
      text: text ?? mapped.text,
    }
  }
  if (key.length === 1) {
    const upper = key.toUpperCase()
    const charCode = upper.charCodeAt(0)
    const derivedCode =
      code ||
      (charCode >= 65 && charCode <= 90
        ? `Key${upper}`
        : charCode >= 48 && charCode <= 57
          ? `Digit${upper}`
          : '')
    return {
      key,
      code: derivedCode,
      windowsVirtualKeyCode: charCode,
      text: text ?? key,
    }
  }
  return {
    key,
    code: code || key,
    windowsVirtualKeyCode: 0,
    text,
  }
}

export interface BrowserSessionFrame {
  format: ViewportFrameFormat
  dataBase64: string
  width: number
  height: number
  timestampMs: number
  seq: number
  pointerLocked: boolean
}

export interface BrowserSessionCreateParams {
  sessionId: string
  hostId: string
  width: number
  height: number
  partition: string
}

export interface BrowserSessionDispatchKeyInput {
  type: 'keyDown' | 'keyUp'
  key: string
  code?: string
  text?: string
  modifiers?: number
  autoRepeat?: boolean
}

export interface BrowserSessionDispatchMouseInput {
  type: 'mouseMoved' | 'mousePressed' | 'mouseReleased' | 'mouseWheel'
  x: number
  y: number
  button?: MouseButtonName
  buttons?: number
  clickCount?: number
  deltaX?: number
  deltaY?: number
  modifiers?: number
}

export interface BrowserSessionRelativeMouseInput {
  x: number
  y: number
  dx: number
  dy: number
  buttons?: number
  modifiers?: number
}

/** Injectable browser session backend (implemented by Electron WebContentsView in prod, mocked in Vitest). */
export interface BrowserSessionBackend {
  readonly sessionId: string
  loadStartPage(dataUrl: string, logicalUrl: string): Promise<ViewportState>
  navigate(url: string): Promise<ViewportState>
  back(): Promise<ViewportState>
  forward(): Promise<ViewportState>
  reload(): Promise<ViewportState>
  resize(width: number, height: number): Promise<ViewportState>
  describe(): Promise<ViewportState>
  capture(options?: { format?: ViewportFrameFormat; quality?: number }): Promise<BrowserHostCaptureResult>
  dispatchKeyEvent(input: BrowserSessionDispatchKeyInput): Promise<void>
  dispatchMouseEvent(input: BrowserSessionDispatchMouseInput): Promise<void>
  dispatchRelativeMouseMove?(input: BrowserSessionRelativeMouseInput): Promise<void>
  insertText(text: string): Promise<void>
  setStreaming(active: boolean, options?: { maxFps?: number; quality?: number }): Promise<void>
  onFrame(listener: (frame: BrowserSessionFrame) => void): () => void
  onState(listener: (state: ViewportState) => void): () => void
  attachToOwner?(owner: unknown, input: DesktopViewportAttachInput): Promise<void>
  updateOwnerBounds?(owner: unknown, input: DesktopViewportAttachInput): Promise<void>
  detachFromOwner?(owner: unknown): Promise<void>
  close(): Promise<void>
}

export type BrowserSessionFactory = (
  params: BrowserSessionCreateParams,
) => Promise<BrowserSessionBackend> | BrowserSessionBackend

export interface BrowserHostOptions {
  home?: string
  socketPath?: string
  runtimeFilePath?: string
  hostId?: string
  version?: string
  sessionFactory?: BrowserSessionFactory
  urlStore?: BrowserUrlPreferenceStore
  onCloseCleanup?: () => Promise<void> | void
  defaultWidth?: number
  defaultHeight?: number
}

interface HeldKeyEntry {
  key: string
  code?: string
  modifiers?: number
}

interface SubscriberRecord {
  socket: Socket
  maxFps?: number
  quality?: number
  lastFrameSentMs: number
}

interface InProcessFrameSubscriber {
  listener: (frame: DesktopViewportFramePayload) => void
  maxFps: number
  lastFrameSentMs: number
  receivedLiveFrame: boolean
}

export interface BrowserReleaseAllResult {
  ok: true
  releasedKeys: string[]
  releasedButtons: MouseButtonName[]
}

export interface BrowserPlayResult {
  ok: true
  executedSteps: number
  cancelled: boolean
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  if (ms <= 0) return Promise.resolve(true)
  return new Promise(resolve => {
    const onAbort = () => {
      clearTimeout(timer)
      resolve(false)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function writeWireMessage(socket: Socket, message: BrowserHostWireMessage): void {
  if (socket.destroyed || !socket.writable) return
  try {
    socket.write(`${JSON.stringify(message)}\n`)
  } catch {
    // Ignore transient closed-pipe write errors.
  }
}

class ManagedBrowserSession {
  readonly sessionId: string
  readonly backend: BrowserSessionBackend

  private initialized = false
  private width: number
  private height: number
  private cursorX: number
  private cursorY: number
  private readonly heldKeys = new Map<string, HeldKeyEntry>()
  private readonly heldButtons = new Set<MouseButtonName>()
  private readonly subscribers = new Map<Socket, SubscriberRecord>()
  private readonly frameSubscribers = new Set<InProcessFrameSubscriber>()
  private latestState: ViewportState | undefined
  private latestFrame: BrowserSessionFrame | undefined
  private readonly unsubFrame: () => void
  private readonly unsubState: () => void
  private readonly resolveSavedUrl?: () => Promise<string | undefined>
  private readonly onExternalUrl?: (url: string) => void
  private lastPersistedUrl: string | undefined
  private closed = false

  constructor(
    sessionId: string,
    backend: BrowserSessionBackend,
    width: number,
    height: number,
    options?: {
      resolveSavedUrl?: () => Promise<string | undefined>
      onExternalUrl?: (url: string) => void
    },
  ) {
    this.sessionId = sessionId
    this.backend = backend
    this.width = width
    this.height = height
    this.cursorX = Math.round(width / 2)
    this.cursorY = Math.round(height / 2)
    this.resolveSavedUrl = options?.resolveSavedUrl
    this.onExternalUrl = options?.onExternalUrl

    this.unsubFrame = backend.onFrame(frame => {
      if (this.closed) return
      this.latestFrame = frame
      this.broadcastFrame(frame)
    })
    this.unsubState = backend.onState(state => {
      if (this.closed) return
      this.latestState = state
      if (state.width > 0) this.width = state.width
      if (state.height > 0) this.height = state.height
      this.recordExternalNavigation(state.navigation?.url)
      this.broadcastState(state)
    })
  }

  private recordExternalNavigation(rawUrl: string | undefined): void {
    if (!rawUrl || !this.onExternalUrl) return
    try {
      const parsed = validateBrowserNavigationUrl(rawUrl)
      if (parsed.kind !== 'external') return
      if (parsed.logicalUrl === this.lastPersistedUrl) return
      this.lastPersistedUrl = parsed.logicalUrl
      this.onExternalUrl(parsed.logicalUrl)
    } catch {
      // Ignore non-persistable / internal URLs (about:blank, chrome-error://, etc.).
    }
  }

  async ensure(options: { initialUrl?: string; width?: number; height?: number }): Promise<ViewportState> {
    if (!this.initialized) {
      this.initialized = true
      const targetWidth = clampDimension(options.width, this.width)
      const targetHeight = clampDimension(options.height, this.height)
      if (targetWidth !== this.width || targetHeight !== this.height) {
        this.width = targetWidth
        this.height = targetHeight
        this.cursorX = Math.round(targetWidth / 2)
        this.cursorY = Math.round(targetHeight / 2)
        await this.backend.resize(targetWidth, targetHeight)
      }
      const explicitInitial = options.initialUrl?.trim()
      const hasExplicitOverride = Boolean(explicitInitial && explicitInitial !== BUILTIN_BROWSER_START_URL)
      let desiredUrl = explicitInitial || BUILTIN_BROWSER_START_URL
      if (!hasExplicitOverride && this.resolveSavedUrl) {
        const savedUrl = await this.resolveSavedUrl().catch(() => undefined)
        if (savedUrl) {
          desiredUrl = savedUrl
        }
      }
      const initialTarget = validateBrowserNavigationUrl(desiredUrl)
      let state: ViewportState
      try {
        state =
          initialTarget.kind === 'start'
            ? await this.backend.loadStartPage(initialTarget.targetUrl, initialTarget.logicalUrl)
            : await this.backend.navigate(initialTarget.targetUrl)
      } catch {
        // Keep the isolated browser session alive even if the initial remote URL
        // redirects (ERR_ABORTED) or fails to load — the tab is still online.
        state = await this.backend.describe()
      }
      this.latestState = state
      if (state.width > 0) this.width = state.width
      if (state.height > 0) this.height = state.height
      this.recordExternalNavigation(state.navigation?.url)
      await this.backend.setStreaming(true).catch(() => {})
      return state
    }

    const current = await this.backend.describe()
    this.latestState = current
    if (current.width > 0) this.width = current.width
    if (current.height > 0) this.height = current.height
    return current
  }

  async describe(): Promise<ViewportState> {
    const state = await this.backend.describe()
    this.latestState = state
    if (state.width > 0) this.width = state.width
    if (state.height > 0) this.height = state.height
    return state
  }

  async attachOwner(owner: unknown, input: DesktopViewportAttachInput): Promise<void> {
    if (this.backend.attachToOwner) {
      await this.backend.attachToOwner(owner, input)
    }
    await this.syncDimensionsAfterOwnerBounds(input)
  }

  async updateOwnerBounds(owner: unknown, input: DesktopViewportAttachInput): Promise<void> {
    if (this.backend.updateOwnerBounds) {
      await this.backend.updateOwnerBounds(owner, input)
    } else if (this.backend.attachToOwner) {
      await this.backend.attachToOwner(owner, input)
    }
    await this.syncDimensionsAfterOwnerBounds(input)
  }

  private async syncDimensionsAfterOwnerBounds(input: DesktopViewportAttachInput): Promise<void> {
    await this.describe().catch(() => {})
    if (input.bounds.width > 0 && input.bounds.height > 0) {
      const nextW = clampDimension(input.bounds.width, this.width)
      const nextH = clampDimension(input.bounds.height, this.height)
      this.width = nextW
      this.height = nextH
      this.cursorX = clampCoord(this.cursorX, nextW)
      this.cursorY = clampCoord(this.cursorY, nextH)
    }
  }

  async action(action: ViewportControlAction): Promise<ViewportState> {
    let state: ViewportState
    switch (action.kind) {
      case 'navigate': {
        const target = validateBrowserNavigationUrl(action.url)
        state =
          target.kind === 'start'
            ? await this.backend.loadStartPage(target.targetUrl, target.logicalUrl)
            : await this.backend.navigate(target.targetUrl)
        break
      }
      case 'back':
        state = await this.backend.back()
        break
      case 'forward':
        state = await this.backend.forward()
        break
      case 'reload':
        state = await this.backend.reload()
        break
      case 'resize': {
        const width = clampDimension(action.width, this.width)
        const height = clampDimension(action.height, this.height)
        this.width = width
        this.height = height
        this.cursorX = clampCoord(this.cursorX, width)
        this.cursorY = clampCoord(this.cursorY, height)
        state = await this.backend.resize(width, height)
        break
      }
    }
    this.latestState = state
    if (state.width > 0) this.width = state.width
    if (state.height > 0) this.height = state.height
    this.recordExternalNavigation(state.navigation?.url)
    this.broadcastState(state)
    return state
  }

  async capture(options?: { format?: ViewportFrameFormat; quality?: number }): Promise<BrowserHostCaptureResult> {
    return this.backend.capture(options)
  }

  async input(input: ViewportHumanInput): Promise<{ ok: true; pointerLocked: boolean }> {
    switch (input.type) {
      case 'mouseMove': {
        this.cursorX = clampCoord(input.x, this.width)
        this.cursorY = clampCoord(input.y, this.height)
        await this.backend.dispatchMouseEvent({
          type: 'mouseMoved',
          x: this.cursorX,
          y: this.cursorY,
          buttons: input.buttons ?? buttonsBitmask(this.heldButtons),
          modifiers: input.modifiers,
        })
        break
      }
      case 'mouseMoveRelative': {
        const dx = Number.isFinite(input.dx) ? input.dx : 0
        const dy = Number.isFinite(input.dy) ? input.dy : 0
        this.cursorX = clampCoord(this.cursorX + dx, this.width)
        this.cursorY = clampCoord(this.cursorY + dy, this.height)
        const buttons = input.buttons ?? buttonsBitmask(this.heldButtons)
        if (this.backend.dispatchRelativeMouseMove) {
          await this.backend.dispatchRelativeMouseMove({
            x: this.cursorX,
            y: this.cursorY,
            dx,
            dy,
            buttons,
            modifiers: input.modifiers,
          })
        } else {
          await this.backend.dispatchMouseEvent({
            type: 'mouseMoved',
            x: this.cursorX,
            y: this.cursorY,
            buttons,
            modifiers: input.modifiers,
          })
        }
        break
      }
      case 'mouseDown': {
        this.cursorX = clampCoord(input.x, this.width)
        this.cursorY = clampCoord(input.y, this.height)
        this.heldButtons.add(input.button)
        await this.backend.dispatchMouseEvent({
          type: 'mousePressed',
          x: this.cursorX,
          y: this.cursorY,
          button: input.button,
          buttons: buttonsBitmask(this.heldButtons),
          clickCount: input.clickCount ?? 1,
          modifiers: input.modifiers,
        })
        break
      }
      case 'mouseUp': {
        this.cursorX = clampCoord(input.x, this.width)
        this.cursorY = clampCoord(input.y, this.height)
        this.heldButtons.delete(input.button)
        await this.backend.dispatchMouseEvent({
          type: 'mouseReleased',
          x: this.cursorX,
          y: this.cursorY,
          button: input.button,
          buttons: buttonsBitmask(this.heldButtons),
          clickCount: input.clickCount ?? 1,
          modifiers: input.modifiers,
        })
        break
      }
      case 'mouseWheel': {
        this.cursorX = clampCoord(input.x, this.width)
        this.cursorY = clampCoord(input.y, this.height)
        await this.backend.dispatchMouseEvent({
          type: 'mouseWheel',
          x: this.cursorX,
          y: this.cursorY,
          deltaX: input.deltaX,
          deltaY: input.deltaY,
          modifiers: input.modifiers,
        })
        break
      }
      case 'keyDown': {
        const keyId = canonicalKeyId(input.key, input.code)
        this.heldKeys.set(keyId, {
          key: input.key,
          code: input.code,
          modifiers: input.modifiers,
        })
        await this.backend.dispatchKeyEvent({
          type: 'keyDown',
          key: input.key,
          code: input.code,
          text: input.text,
          modifiers: input.modifiers,
          autoRepeat: input.autoRepeat,
        })
        break
      }
      case 'keyUp': {
        const keyId = canonicalKeyId(input.key, input.code)
        this.heldKeys.delete(keyId)
        await this.backend.dispatchKeyEvent({
          type: 'keyUp',
          key: input.key,
          code: input.code,
          modifiers: input.modifiers,
        })
        break
      }
      case 'releaseAll': {
        await this.releaseAll()
        break
      }
    }
    return { ok: true, pointerLocked: Boolean(this.latestState?.pointerLocked) }
  }

  async typeText(text: string): Promise<{ ok: true }> {
    if (text.length > 0) {
      await this.backend.insertText(text)
    }
    return { ok: true }
  }

  async releaseAll(): Promise<BrowserReleaseAllResult> {
    const keysSnapshot = Array.from(this.heldKeys.entries())
    this.heldKeys.clear()
    const releasedKeys: string[] = []
    for (const [, entry] of keysSnapshot) {
      releasedKeys.push(entry.key)
      await this.backend
        .dispatchKeyEvent({
          type: 'keyUp',
          key: entry.key,
          code: entry.code,
          modifiers: entry.modifiers,
        })
        .catch(() => {})
    }

    const buttonsSnapshot = Array.from(this.heldButtons.values())
    this.heldButtons.clear()
    const releasedButtons: MouseButtonName[] = []
    for (const button of buttonsSnapshot) {
      releasedButtons.push(button)
      await this.backend
        .dispatchMouseEvent({
          type: 'mouseReleased',
          x: this.cursorX,
          y: this.cursorY,
          button,
          buttons: 0,
          clickCount: 1,
        })
        .catch(() => {})
    }

    return { ok: true, releasedKeys, releasedButtons }
  }

  getHeldInputSnapshot(): { keys: string[]; buttons: MouseButtonName[]; cursor: { x: number; y: number } } {
    return {
      keys: Array.from(this.heldKeys.values()).map(k => k.key),
      buttons: Array.from(this.heldButtons.values()),
      cursor: { x: this.cursorX, y: this.cursorY },
    }
  }

  async play(steps: BrowserInputStep[], signal: AbortSignal): Promise<BrowserPlayResult> {
    interface ScheduledOp {
      atMs: number
      order: number
      run: () => Promise<void>
    }

    const sortedSteps = [...steps].sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0))
    const ops: ScheduledOp[] = []
    const opHeldKeys = new Map<string, string>()
    const opHeldButtons = new Set<MouseButtonName>()
    let order = 0
    let executedSteps = 0

    for (const step of sortedSteps) {
      const startMs = Math.max(0, Number.isFinite(step.atMs) ? step.atMs : 0)
      const hasDuration = typeof step.durationMs === 'number' && Number.isFinite(step.durationMs)
      const holdMs = hasDuration ? Math.max(0, step.durationMs!) : DEFAULT_PLAY_TAP_MS

      ops.push({
        atMs: startMs,
        order: order++,
        run: async () => {
          executedSteps += 1
          if (typeof step.dx === 'number' || typeof step.dy === 'number') {
            await this.input({
              type: 'mouseMoveRelative',
              dx: step.dx ?? 0,
              dy: step.dy ?? 0,
            })
          } else if (
            typeof step.x === 'number' &&
            typeof step.y === 'number' &&
            !step.mouseButton &&
            typeof step.wheelX !== 'number' &&
            typeof step.wheelY !== 'number'
          ) {
            await this.input({ type: 'mouseMove', x: step.x, y: step.y })
          }

          if (typeof step.wheelX === 'number' || typeof step.wheelY === 'number') {
            await this.input({
              type: 'mouseWheel',
              x: step.x ?? this.cursorX,
              y: step.y ?? this.cursorY,
              deltaX: step.wheelX ?? 0,
              deltaY: step.wheelY ?? 0,
            })
          }

          if (step.mouseButton) {
            opHeldButtons.add(step.mouseButton)
            await this.input({
              type: 'mouseDown',
              x: step.x ?? this.cursorX,
              y: step.y ?? this.cursorY,
              button: step.mouseButton,
              clickCount: 1,
            })
          }

          if (Array.isArray(step.keys)) {
            for (const key of step.keys) {
              if (typeof key !== 'string' || key.length === 0) continue
              opHeldKeys.set(canonicalKeyId(key), key)
              await this.input({ type: 'keyDown', key })
            }
          }
        },
      })

      if (step.mouseButton || (Array.isArray(step.keys) && step.keys.length > 0)) {
        const releaseAt = startMs + holdMs
        const keysToRelease = Array.isArray(step.keys) ? step.keys.filter(k => typeof k === 'string' && k.length > 0) : []
        const buttonToRelease = step.mouseButton
        ops.push({
          atMs: releaseAt,
          order: order++,
          run: async () => {
            for (const key of keysToRelease) {
              opHeldKeys.delete(canonicalKeyId(key))
              await this.input({ type: 'keyUp', key })
            }
            if (buttonToRelease) {
              opHeldButtons.delete(buttonToRelease)
              await this.input({
                type: 'mouseUp',
                x: step.x ?? this.cursorX,
                y: step.y ?? this.cursorY,
                button: buttonToRelease,
                clickCount: 1,
              })
            }
          },
        })
      }
    }

    ops.sort((a, b) => (a.atMs !== b.atMs ? a.atMs - b.atMs : a.order - b.order))

    const releaseOperationInputs = async () => {
      const keys = Array.from(opHeldKeys.values())
      opHeldKeys.clear()
      for (const key of keys) {
        await this.input({ type: 'keyUp', key }).catch(() => {})
      }
      const buttons = Array.from(opHeldButtons.values())
      opHeldButtons.clear()
      for (const button of buttons) {
        await this.input({
          type: 'mouseUp',
          x: this.cursorX,
          y: this.cursorY,
          button,
          clickCount: 1,
        }).catch(() => {})
      }
    }

    const startedAt = Date.now()
    for (const op of ops) {
      if (signal.aborted) {
        await releaseOperationInputs()
        return { ok: true, executedSteps, cancelled: true }
      }
      const delay = op.atMs - (Date.now() - startedAt)
      if (delay > 0) {
        const completedWait = await sleepAbortable(delay, signal)
        if (!completedWait || signal.aborted) {
          await releaseOperationInputs()
          return { ok: true, executedSteps, cancelled: true }
        }
      }
      if (signal.aborted) {
        await releaseOperationInputs()
        return { ok: true, executedSteps, cancelled: true }
      }
      await op.run()
    }

    return { ok: true, executedSteps, cancelled: false }
  }

  async subscribe(socket: Socket, options?: { maxFps?: number; quality?: number }): Promise<void> {
    this.subscribers.set(socket, {
      socket,
      maxFps: options?.maxFps,
      quality: options?.quality,
      lastFrameSentMs: 0,
    })
    await this.backend.setStreaming(true, options).catch(() => {})

    const state = this.latestState ?? (await this.describe().catch(() => undefined))
    if (state) {
      this.sendEvent(socket, { event: 'state', sessionId: this.sessionId, state })
    }
    if (this.latestFrame) {
      this.sendFrameToSubscriber(this.subscribers.get(socket)!, this.latestFrame)
    }
  }

  unsubscribe(socket: Socket): void {
    this.subscribers.delete(socket)
  }

  getLatestFrame(): BrowserSessionFrame | undefined {
    return this.latestFrame
  }

  async enableStreaming(options?: { maxFps?: number; quality?: number }): Promise<void> {
    await this.backend.setStreaming(true, options).catch(() => {})
  }

  private toFramePayload(frame: BrowserSessionFrame): DesktopViewportFramePayload {
    return {
      sessionId: this.sessionId,
      format: frame.format,
      dataBase64: frame.dataBase64,
      width: frame.width,
      height: frame.height,
      timestampMs: frame.timestampMs,
      seq: frame.seq,
      pointerLocked: frame.pointerLocked,
    }
  }

  async subscribeFrames(
    listener: (frame: DesktopViewportFramePayload) => void,
    options?: { maxFps?: number; quality?: number },
  ): Promise<() => void> {
    if (this.closed) return () => {}
    const maxFps =
      typeof options?.maxFps === 'number' && Number.isFinite(options.maxFps) && options.maxFps > 0
        ? options.maxFps
        : 60
    const sub: InProcessFrameSubscriber = {
      listener,
      maxFps,
      lastFrameSentMs: 0,
      receivedLiveFrame: false,
    }
    let active = true
    this.frameSubscribers.add(sub)

    await this.enableStreaming(options)
    if (!active || this.closed) {
      this.frameSubscribers.delete(sub)
      return () => {}
    }

    const latest = this.getLatestFrame()
    if (latest && !sub.receivedLiveFrame) {
      try {
        sub.listener(this.toFramePayload(latest))
      } catch {
        // Ignore subscriber errors.
      }
    } else if (!sub.receivedLiveFrame) {
      const quality = options?.quality ?? 80
      void this.capture({ format: 'jpeg', quality })
        .then(captured => {
          if (!active || this.closed || sub.receivedLiveFrame) return
          try {
            sub.listener({
              sessionId: this.sessionId,
              format: captured.format,
              dataBase64: captured.dataBase64,
              width: captured.width,
              height: captured.height,
              timestampMs: captured.timestampMs,
              seq: captured.seq,
              pointerLocked: captured.pointerLocked,
            })
          } catch {
            // Ignore subscriber errors.
          }
        })
        .catch(() => {})
    }

    return () => {
      active = false
      this.frameSubscribers.delete(sub)
    }
  }

  private sendEvent(socket: Socket, event: BrowserHostEvent): void {
    writeWireMessage(socket, { event })
  }

  private sendFrameToInProcessSubscriber(sub: InProcessFrameSubscriber, frame: BrowserSessionFrame): void {
    if (sub.maxFps > 0 && sub.lastFrameSentMs > 0) {
      const minIntervalMs = Math.floor(1000 / sub.maxFps)
      if (frame.timestampMs - sub.lastFrameSentMs < minIntervalMs) {
        return
      }
    }
    sub.lastFrameSentMs = frame.timestampMs
    sub.receivedLiveFrame = true
    try {
      sub.listener(this.toFramePayload(frame))
    } catch {
      // Ignore subscriber errors.
    }
  }

  private sendFrameToSubscriber(sub: SubscriberRecord, frame: BrowserSessionFrame): void {
    if (sub.socket.destroyed || !sub.socket.writable) {
      this.subscribers.delete(sub.socket)
      return
    }
    if (sub.socket.writableLength > SUBSCRIBER_HIGH_WATER_BYTES) {
      return
    }
    if (sub.maxFps && sub.maxFps > 0) {
      const minIntervalMs = Math.floor(1000 / sub.maxFps)
      if (frame.timestampMs - sub.lastFrameSentMs < minIntervalMs) {
        return
      }
    }
    sub.lastFrameSentMs = frame.timestampMs
    this.sendEvent(sub.socket, {
      event: 'frame',
      sessionId: this.sessionId,
      format: frame.format,
      width: frame.width,
      height: frame.height,
      timestampMs: frame.timestampMs,
      seq: frame.seq,
      pointerLocked: frame.pointerLocked,
      dataBase64: frame.dataBase64,
    })
  }

  private broadcastFrame(frame: BrowserSessionFrame): void {
    for (const sub of Array.from(this.subscribers.values())) {
      this.sendFrameToSubscriber(sub, frame)
    }
    for (const sub of Array.from(this.frameSubscribers)) {
      this.sendFrameToInProcessSubscriber(sub, frame)
    }
  }

  private broadcastState(state: ViewportState): void {
    for (const sub of Array.from(this.subscribers.values())) {
      if (sub.socket.destroyed || !sub.socket.writable) {
        this.subscribers.delete(sub.socket)
        continue
      }
      this.sendEvent(sub.socket, {
        event: 'state',
        sessionId: this.sessionId,
        state,
      })
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.subscribers.clear()
    this.frameSubscribers.clear()
    this.unsubFrame()
    this.unsubState()
    await this.releaseAll().catch(() => {})
    await this.backend.close().catch(() => {})
  }
}

/**
 * Production Electron `WebContentsView` + in-process CDP + hidden keepalive `BrowserWindow`
 * session factory. Loaded lazily so Vitest unit tests never import Electron.
 */
function createProductionElectronSessionFactory(): {
  factory: BrowserSessionFactory
  dispose: () => Promise<void>
} {
  let keepaliveWindow: BrowserWindow | undefined
  let keepaliveWindowPromise: Promise<BrowserWindow> | undefined
  let keepaliveWidth = DEFAULT_VIEWPORT_WIDTH
  let keepaliveHeight = DEFAULT_VIEWPORT_HEIGHT
  let electronModule: typeof import('electron') | undefined

  const getElectron = async (): Promise<typeof import('electron')> => {
    if (!electronModule) {
      electronModule = await import('electron')
    }
    return electronModule
  }

  const ensureKeepaliveWindow = async (
    minWidth = DEFAULT_VIEWPORT_WIDTH,
    minHeight = DEFAULT_VIEWPORT_HEIGHT,
  ): Promise<BrowserWindow> => {
    if (keepaliveWindow && !keepaliveWindow.isDestroyed()) {
      const nextW = Math.max(keepaliveWidth, minWidth)
      const nextH = Math.max(keepaliveHeight, minHeight)
      if (nextW > keepaliveWidth || nextH > keepaliveHeight) {
        keepaliveWidth = nextW
        keepaliveHeight = nextH
        try {
          keepaliveWindow.setContentSize(keepaliveWidth, keepaliveHeight)
        } catch {
          // Ignore resize errors during shutdown.
        }
      }
      return keepaliveWindow
    }
    if (!keepaliveWindowPromise) {
      keepaliveWindowPromise = (async () => {
        const electron = await getElectron()
        keepaliveWidth = Math.max(keepaliveWidth, minWidth)
        keepaliveHeight = Math.max(keepaliveHeight, minHeight)
        const win = new electron.BrowserWindow({
          show: false,
          width: keepaliveWidth,
          height: keepaliveHeight,
          paintWhenInitiallyHidden: true,
          focusable: false,
          skipTaskbar: true,
          webPreferences: {
            backgroundThrottling: false,
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
          },
        })
        win.on('closed', () => {
          if (keepaliveWindow === win) {
            keepaliveWindow = undefined
          }
        })
        keepaliveWindow = win
        return win
      })().finally(() => {
        keepaliveWindowPromise = undefined
      })
    }
    const win = await keepaliveWindowPromise
    if (!win.isDestroyed()) {
      const nextW = Math.max(keepaliveWidth, minWidth)
      const nextH = Math.max(keepaliveHeight, minHeight)
      if (nextW > keepaliveWidth || nextH > keepaliveHeight) {
        keepaliveWidth = nextW
        keepaliveHeight = nextH
        try {
          win.setContentSize(keepaliveWidth, keepaliveHeight)
        } catch {
          // Ignore resize errors during shutdown.
        }
      }
    }
    return win
  }

  const parkInKeepalive = async (view: WebContentsView, width: number, height: number): Promise<void> => {
    try {
      const keepalive = await ensureKeepaliveWindow(width, height)
      if (keepalive.isDestroyed()) return
      try {
        keepalive.contentView.addChildView(view)
      } catch {
        // Already attached to keepalive.
      }
      view.setBounds({ x: 0, y: 0, width, height })
      view.setVisible?.(true)
    } catch {
      // Ignore during app shutdown.
    }
  }

  const factory: BrowserSessionFactory = async params => {
    const electron = await getElectron()
    const ses = electron.session.fromPartition(params.partition)
    const view = new electron.WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        session: ses,
      },
    })
    const wc = view.webContents
    let width = params.width
    let height = params.height
    let logicalStartPage = false
    let startPageDataUrl = getBrowserStartPageDataUrl()
    let pointerLocked = false
    let interactive = true
    let cdpInputDepth = 0
    let attachedOwner: BrowserWindow | undefined
    let screencastRunning = false
    let screencastQuality = 80
    let frameSeq = 0
    let latestFrame: BrowserSessionFrame | undefined
    let lastFrameAt = 0
    let fallbackPumpTimer: ReturnType<typeof setInterval> | undefined
    let fallbackCaptureInFlight = false
    let closed = false

    const frameListeners = new Set<(frame: BrowserSessionFrame) => void>()
    const stateListeners = new Set<(state: ViewportState) => void>()

    await parkInKeepalive(view, width, height)

    const currentLogicalUrl = (): string => {
      if (wc.isDestroyed()) return BUILTIN_BROWSER_START_URL
      const raw = wc.getURL()
      if (!raw || logicalStartPage || raw.startsWith('data:text/html')) {
        return logicalStartPage ? BUILTIN_BROWSER_START_URL : raw || 'about:blank'
      }
      return raw
    }

    const buildState = (): ViewportState => {
      const destroyed = wc.isDestroyed()
      return {
        stageKind: 'browser',
        available: !destroyed && !closed,
        connected: !destroyed && !closed,
        machineId: 'builtin-browser',
        driver: 'browser',
        sessionId: params.sessionId,
        nativeHostId: params.hostId,
        width,
        height,
        pointerLocked,
        controlMode: 'manual',
        navigation: {
          url: currentLogicalUrl(),
          title: destroyed ? '' : wc.getTitle() || (logicalStartPage ? 'Ludens WebGL Arena' : ''),
          loading: destroyed ? false : wc.isLoading(),
          canGoBack: destroyed ? false : wc.navigationHistory.canGoBack(),
          canGoForward: destroyed ? false : wc.navigationHistory.canGoForward(),
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

    const emitState = () => {
      if (closed || wc.isDestroyed()) return
      const state = buildState()
      for (const listener of Array.from(stateListeners)) {
        listener(state)
      }
    }

    const emitFrame = (frame: BrowserSessionFrame) => {
      if (closed) return
      latestFrame = frame
      lastFrameAt = frame.timestampMs
      for (const listener of Array.from(frameListeners)) {
        listener(frame)
      }
    }

    // Security guards: allow http:, https:, about:blank, and exact internal start page only.
    const guardNavigation = (event: Electron.Event, url: string) => {
      if (url === startPageDataUrl) return
      if (url === 'about:blank' || isAllowedExternalHttpUrl(url)) {
        logicalStartPage = false
        return
      }
      event.preventDefault()
    }
    wc.on('will-navigate', guardNavigation)
    wc.on('will-redirect', guardNavigation)
    wc.setWindowOpenHandler(({ url }) => {
      if (isAllowedExternalHttpUrl(url)) {
        logicalStartPage = false
        void wc.loadURL(url).catch(() => {})
      }
      return { action: 'deny' }
    })

    // Suppress accidental human keyboard events while in Auto (non-interactive) mode,
    // without interfering with in-process CDP commands.
    wc.on('before-input-event', event => {
      if (!interactive && cdpInputDepth === 0) {
        event.preventDefault()
      }
    })

    const syncPageInteractiveGuard = async () => {
      if (closed || wc.isDestroyed()) return
      const script = `(() => {
        window.__ludensBlockHumanPointer = ${interactive ? 'false' : 'true'};
        if (!window.__ludensPointerGuardInstalled) {
          window.__ludensPointerGuardInstalled = true;
          const block = (e) => {
            if (window.__ludensBlockHumanPointer && !window.__ludensCdpBypass) {
              e.stopImmediatePropagation();
              e.preventDefault();
            }
          };
          for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'wheel', 'contextmenu']) {
            window.addEventListener(type, block, true);
          }
        }
      })()`
      await wc.executeJavaScript(script, true).catch(() => {})
    }

    wc.on('did-start-loading', emitState)
    wc.on('did-stop-loading', () => {
      void syncPageInteractiveGuard()
      emitState()
    })
    wc.on('did-navigate', (_e, url) => {
      logicalStartPage = url === startPageDataUrl
      void syncPageInteractiveGuard()
      emitState()
    })
    wc.on('did-navigate-in-page', emitState)
    wc.on('page-title-updated', emitState)

    // Attach in-process CDP debugger (0 TCP ports)
    const ensureDebuggerAttached = async (): Promise<boolean> => {
      if (closed || wc.isDestroyed()) return false
      if (!wc.debugger.isAttached()) {
        try {
          wc.debugger.attach('1.3')
          await wc.debugger.sendCommand('Page.enable').catch(() => {})
        } catch {
          return false
        }
      }
      return true
    }

    wc.debugger.on('message', (_event, method, messageParams) => {
      if (closed || method !== 'Page.screencastFrame') return
      const frameParams = messageParams as {
        data?: string
        sessionId?: number
        metadata?: { deviceWidth?: number; deviceHeight?: number }
      }
      if (typeof frameParams.sessionId === 'number') {
        void wc.debugger.sendCommand('Page.screencastFrameAck', { sessionId: frameParams.sessionId }).catch(() => {})
      }
      if (typeof frameParams.data === 'string' && frameParams.data.length > 0) {
        emitFrame({
          format: 'jpeg',
          dataBase64: frameParams.data,
          width: Math.round(frameParams.metadata?.deviceWidth || width),
          height: Math.round(frameParams.metadata?.deviceHeight || height),
          timestampMs: Date.now(),
          seq: ++frameSeq,
          pointerLocked,
        })
      }
    })

    const startScreencast = async (quality = screencastQuality) => {
      if (closed || wc.isDestroyed()) return
      screencastQuality = Math.max(20, Math.min(100, Math.round(quality)))
      const attached = await ensureDebuggerAttached()
      if (!attached) return
      try {
        await wc.debugger.sendCommand('Page.startScreencast', {
          format: 'jpeg',
          quality: screencastQuality,
          maxWidth: width,
          maxHeight: height,
          everyNthFrame: 1,
        })
        screencastRunning = true
      } catch {
        screencastRunning = false
      }
    }

    const captureFallbackFrame = async (
      format: ViewportFrameFormat = 'jpeg',
      quality = screencastQuality,
    ): Promise<BrowserSessionFrame | null> => {
      if (closed || wc.isDestroyed()) return null
      try {
        const img = await wc.capturePage()
        if (img.isEmpty()) return null
        const size = img.getSize()
        const buf =
          format === 'png'
            ? img.toPNG()
            : img.toJPEG(Math.max(20, Math.min(100, Math.round(quality))))
        const frame: BrowserSessionFrame = {
          format: format === 'webp' ? 'jpeg' : format,
          dataBase64: buf.toString('base64'),
          width: size.width || width,
          height: size.height || height,
          timestampMs: Date.now(),
          seq: ++frameSeq,
          pointerLocked,
        }
        return frame
      } catch {
        return null
      }
    }

    const startFallbackPump = () => {
      if (fallbackPumpTimer) return
      fallbackPumpTimer = setInterval(() => {
        if (closed || wc.isDestroyed() || fallbackCaptureInFlight) return
        if (Date.now() - lastFrameAt < SCREENCAST_STALL_MS) return
        fallbackCaptureInFlight = true
        void captureFallbackFrame('jpeg', screencastQuality)
          .then(frame => {
            if (frame) emitFrame(frame)
          })
          .finally(() => {
            fallbackCaptureInFlight = false
          })
      }, FALLBACK_PUMP_INTERVAL_MS)
      fallbackPumpTimer.unref()
    }

    const refreshPointerLockState = async () => {
      if (closed || wc.isDestroyed()) return
      try {
        const locked = Boolean(await wc.executeJavaScript('Boolean(document.pointerLockElement)', true))
        if (locked !== pointerLocked) {
          pointerLocked = locked
          emitState()
        }
      } catch {
        // Ignore if page is mid-navigation.
      }
    }

    const applyInteractiveState = async (nextInteractive: boolean, ownerWin?: BrowserWindow) => {
      interactive = nextInteractive
      await syncPageInteractiveGuard()
      if (!interactive && ownerWin && !ownerWin.isDestroyed()) {
        try {
          ownerWin.webContents.focus()
        } catch {
          // Ignore focus errors.
        }
      }
    }

    const detachFromWindowInternal = async (ownerWin: BrowserWindow) => {
      if (attachedOwner === ownerWin) {
        attachedOwner = undefined
        if (!ownerWin.isDestroyed()) {
          try {
            ownerWin.contentView.removeChildView(view)
          } catch {
            // Already removed.
          }
        }
        await parkInKeepalive(view, width, height)
        if (screencastRunning) {
          await startScreencast(screencastQuality)
        }
      }
    }

    const applyOwnerSlot = async (ownerWin: BrowserWindow, input: DesktopViewportAttachInput) => {
      if (closed || wc.isDestroyed() || ownerWin.isDestroyed()) return
      const bounds = normalizeViewportBounds(input.bounds)
      const hasValidSize = bounds.width > 0 && bounds.height > 0
      let sizeChanged = false
      if (hasValidSize) {
        const nextW = clampDimension(bounds.width, width)
        const nextH = clampDimension(bounds.height, height)
        sizeChanged = nextW !== width || nextH !== height
        width = nextW
        height = nextH
      }

      if (!input.visible || !hasValidSize) {
        const wasAttached = attachedOwner === ownerWin
        await detachFromWindowInternal(ownerWin)
        if (!wasAttached && sizeChanged && !attachedOwner && keepaliveWindow && !keepaliveWindow.isDestroyed()) {
          view.setBounds({ x: 0, y: 0, width, height })
        }
        await applyInteractiveState(input.interactive, ownerWin)
        if (sizeChanged) {
          emitState()
          if (screencastRunning) {
            await startScreencast(screencastQuality)
          }
        }
        return
      }

      if (keepaliveWindow && !keepaliveWindow.isDestroyed()) {
        try {
          keepaliveWindow.contentView.removeChildView(view)
        } catch {
          // Not in keepalive.
        }
      }
      if (attachedOwner && attachedOwner !== ownerWin && !attachedOwner.isDestroyed()) {
        try {
          attachedOwner.contentView.removeChildView(view)
        } catch {
          // Ignore.
        }
      }
      const wasAttachedToSameOwner = attachedOwner === ownerWin
      try {
        ownerWin.contentView.addChildView(view)
      } catch {
        // Already child of owner.
      }
      attachedOwner = ownerWin
      view.setBounds(bounds)
      view.setVisible?.(true)
      await applyInteractiveState(input.interactive, ownerWin)
      if (sizeChanged) {
        emitState()
      }
      if (screencastRunning && (sizeChanged || !wasAttachedToSameOwner)) {
        await startScreencast(screencastQuality)
      }
    }

    // Initiate navigation without blocking indefinitely on slow WebGL subresources
    // or failing the session on redirects (ERR_ABORTED / -3).
    const loadUrlGracefully = async (url: string, commitGraceMs = 1_500): Promise<void> => {
      if (closed || wc.isDestroyed()) return
      let settled = false
      await new Promise<void>(resolveLoad => {
        const done = () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          wc.off('did-navigate', onCommit)
          wc.off('dom-ready', onCommit)
          wc.off('did-fail-load', onCommit)
          resolveLoad()
        }
        const onCommit = () => done()
        const timer = setTimeout(done, commitGraceMs)
        timer.unref?.()
        wc.once('did-navigate', onCommit)
        wc.once('dom-ready', onCommit)
        wc.once('did-fail-load', onCommit)
        void wc.loadURL(url).then(done, () => {
          // Non-fatal: redirects (ERR_ABORTED) or network failures leave the session alive
          // so the user/agent can inspect or navigate elsewhere.
          done()
        })
      })
    }

    const backend: BrowserSessionBackend = {
      sessionId: params.sessionId,

      async loadStartPage(dataUrl: string) {
        startPageDataUrl = dataUrl
        logicalStartPage = true
        await loadUrlGracefully(dataUrl, 2_000)
        await syncPageInteractiveGuard()
        return buildState()
      },

      async navigate(url: string) {
        logicalStartPage = false
        await loadUrlGracefully(url, 1_500)
        await syncPageInteractiveGuard()
        return buildState()
      },

      async back() {
        if (!wc.isDestroyed() && wc.navigationHistory.canGoBack()) {
          wc.navigationHistory.goBack()
        }
        return buildState()
      },

      async forward() {
        if (!wc.isDestroyed() && wc.navigationHistory.canGoForward()) {
          wc.navigationHistory.goForward()
        }
        return buildState()
      },

      async reload() {
        if (!wc.isDestroyed()) {
          wc.reload()
        }
        return buildState()
      },

      async resize(nextWidth: number, nextHeight: number) {
        width = nextWidth
        height = nextHeight
        if (!attachedOwner && keepaliveWindow && !keepaliveWindow.isDestroyed()) {
          view.setBounds({ x: 0, y: 0, width, height })
        }
        if (screencastRunning) {
          await startScreencast(screencastQuality)
        }
        return buildState()
      },

      async describe() {
        await refreshPointerLockState()
        return buildState()
      },

      async capture(options) {
        const format: ViewportFrameFormat = options?.format ?? 'jpeg'
        const quality = options?.quality ?? screencastQuality
        if (
          latestFrame &&
          latestFrame.format === format &&
          Date.now() - latestFrame.timestampMs <= CACHED_FRAME_FRESH_MS
        ) {
          const state = buildState()
          return {
            format: latestFrame.format,
            mediaType: viewportFormatMimeType(latestFrame.format),
            dataBase64: latestFrame.dataBase64,
            width: latestFrame.width,
            height: latestFrame.height,
            seq: latestFrame.seq,
            timestampMs: latestFrame.timestampMs,
            pointerLocked: state.pointerLocked,
            url: state.navigation?.url ?? BUILTIN_BROWSER_START_URL,
            title: state.navigation?.title ?? '',
          }
        }

        const attached = await ensureDebuggerAttached()
        if (attached) {
          try {
            const cdpFormat = format === 'png' ? 'png' : format === 'webp' ? 'webp' : 'jpeg'
            const shot = (await wc.debugger.sendCommand('Page.captureScreenshot', {
              format: cdpFormat,
              ...(cdpFormat !== 'png' ? { quality } : {}),
            })) as { data?: string }
            if (typeof shot?.data === 'string' && shot.data.length > 0) {
              const now = Date.now()
              const frame: BrowserSessionFrame = {
                format,
                dataBase64: shot.data,
                width,
                height,
                timestampMs: now,
                seq: ++frameSeq,
                pointerLocked,
              }
              if (format === 'jpeg') latestFrame = frame
              const state = buildState()
              return {
                format: frame.format,
                mediaType: viewportFormatMimeType(frame.format),
                dataBase64: frame.dataBase64,
                width: frame.width,
                height: frame.height,
                seq: frame.seq,
                timestampMs: frame.timestampMs,
                pointerLocked: state.pointerLocked,
                url: state.navigation?.url ?? BUILTIN_BROWSER_START_URL,
                title: state.navigation?.title ?? '',
              }
            }
          } catch {
            // Fall through to capturePage().
          }
        }

        const fallback = await captureFallbackFrame(format, quality)
        if (!fallback) {
          throw new Error(`Failed to capture frame for browser session ${params.sessionId}`)
        }
        if (fallback.format === 'jpeg') latestFrame = fallback
        const state = buildState()
        return {
          format: fallback.format,
          mediaType: viewportFormatMimeType(fallback.format),
          dataBase64: fallback.dataBase64,
          width: fallback.width,
          height: fallback.height,
          seq: fallback.seq,
          timestampMs: fallback.timestampMs,
          pointerLocked: state.pointerLocked,
          url: state.navigation?.url ?? BUILTIN_BROWSER_START_URL,
          title: state.navigation?.title ?? '',
        }
      },

      async dispatchKeyEvent(input) {
        const attached = await ensureDebuggerAttached()
        if (!attached) return
        const desc = resolveCdpKeyDescriptor(input.key, input.code, input.text)
        cdpInputDepth += 1
        try {
          await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
            type: input.type === 'keyDown' ? (desc.text ? 'keyDown' : 'rawKeyDown') : 'keyUp',
            key: desc.key,
            code: desc.code,
            windowsVirtualKeyCode: desc.windowsVirtualKeyCode,
            nativeVirtualKeyCode: desc.windowsVirtualKeyCode,
            ...(input.type === 'keyDown' && desc.text ? { text: desc.text, unmodifiedText: desc.text } : {}),
            ...(typeof input.modifiers === 'number' ? { modifiers: input.modifiers } : {}),
            ...(typeof input.autoRepeat === 'boolean' ? { autoRepeat: input.autoRepeat } : {}),
          })
        } finally {
          cdpInputDepth = Math.max(0, cdpInputDepth - 1)
        }
      },

      async dispatchMouseEvent(input) {
        const attached = await ensureDebuggerAttached()
        if (!attached) return
        cdpInputDepth += 1
        try {
          if (!interactive) {
            await wc.executeJavaScript('window.__ludensCdpBypass = true', true).catch(() => {})
          }
          await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
            type: input.type,
            x: input.x,
            y: input.y,
            button: input.button ?? 'none',
            buttons: input.buttons ?? 0,
            clickCount: input.clickCount ?? (input.type === 'mousePressed' || input.type === 'mouseReleased' ? 1 : 0),
            ...(typeof input.deltaX === 'number' ? { deltaX: input.deltaX } : {}),
            ...(typeof input.deltaY === 'number' ? { deltaY: input.deltaY } : {}),
            ...(typeof input.modifiers === 'number' ? { modifiers: input.modifiers } : {}),
          })
        } finally {
          if (!interactive) {
            await wc.executeJavaScript('window.__ludensCdpBypass = false', true).catch(() => {})
          }
          cdpInputDepth = Math.max(0, cdpInputDepth - 1)
        }
        if (input.type === 'mousePressed' || input.type === 'mouseReleased') {
          void refreshPointerLockState()
        }
      },

      async dispatchRelativeMouseMove(input) {
        await backend.dispatchMouseEvent({
          type: 'mouseMoved',
          x: input.x,
          y: input.y,
          buttons: input.buttons ?? 0,
          modifiers: input.modifiers,
        })
        if (closed || wc.isDestroyed()) return
        // Dispatch synthetic MouseEvent with movementX/movementY so Three.js / WebGL Pointer Lock cameras rotate smoothly.
        const script = `(() => {
          const target = document.pointerLockElement || document.activeElement || document.body || document;
          const ev = new MouseEvent('mousemove', {
            bubbles: true,
            cancelable: true,
            clientX: ${JSON.stringify(input.x)},
            clientY: ${JSON.stringify(input.y)},
            buttons: ${JSON.stringify(input.buttons ?? 0)},
            movementX: ${JSON.stringify(input.dx)},
            movementY: ${JSON.stringify(input.dy)},
          });
          Object.defineProperty(ev, 'movementX', { value: ${JSON.stringify(input.dx)} });
          Object.defineProperty(ev, 'movementY', { value: ${JSON.stringify(input.dy)} });
          target.dispatchEvent(ev);
          return Boolean(document.pointerLockElement);
        })()`
        try {
          const locked = Boolean(await wc.executeJavaScript(script, true))
          if (locked !== pointerLocked) {
            pointerLocked = locked
            emitState()
          }
        } catch {
          // Ignore transient navigation errors.
        }
      },

      async insertText(text: string) {
        const attached = await ensureDebuggerAttached()
        if (!attached) return
        cdpInputDepth += 1
        try {
          await wc.debugger.sendCommand('Input.insertText', { text })
        } finally {
          cdpInputDepth = Math.max(0, cdpInputDepth - 1)
        }
      },

      async setStreaming(active: boolean, options) {
        if (!active) return
        await startScreencast(options?.quality ?? screencastQuality)
        startFallbackPump()
      },

      onFrame(listener) {
        frameListeners.add(listener)
        return () => frameListeners.delete(listener)
      },

      onState(listener) {
        stateListeners.add(listener)
        return () => stateListeners.delete(listener)
      },

      async attachToOwner(owner, input) {
        await applyOwnerSlot(owner as BrowserWindow, input)
      },

      async updateOwnerBounds(owner, input) {
        await applyOwnerSlot(owner as BrowserWindow, input)
      },

      async detachFromOwner(owner) {
        await detachFromWindowInternal(owner as BrowserWindow)
      },

      async close() {
        if (closed) return
        closed = true
        if (fallbackPumpTimer) {
          clearInterval(fallbackPumpTimer)
          fallbackPumpTimer = undefined
        }
        frameListeners.clear()
        stateListeners.clear()
        if (attachedOwner && !attachedOwner.isDestroyed()) {
          try {
            attachedOwner.contentView.removeChildView(view)
          } catch {}
        }
        if (keepaliveWindow && !keepaliveWindow.isDestroyed()) {
          try {
            keepaliveWindow.contentView.removeChildView(view)
          } catch {}
        }
        if (!wc.isDestroyed()) {
          try {
            if (wc.debugger.isAttached()) {
              await wc.debugger.sendCommand('Page.stopScreencast').catch(() => {})
              wc.debugger.detach()
            }
          } catch {}
          try {
            wc.close()
          } catch {}
        }
      },
    }

    return backend
  }

  const dispose = async () => {
    if (keepaliveWindow && !keepaliveWindow.isDestroyed()) {
      try {
        keepaliveWindow.destroy()
      } catch {}
    }
    keepaliveWindow = undefined
  }

  return { factory, dispose }
}

/**
 * Local zero-port UDS `BrowserHost` managing per-workspace isolated browser sessions,
 * NDJSON RPC + event streaming, and native Electron `WebContentsView` slot attachment.
 */
export class BrowserHost {
  readonly home: string
  readonly hostId: string
  readonly socketPath: string
  readonly runtimeFilePath: string
  readonly version: string

  private readonly defaultWidth: number
  private readonly defaultHeight: number
  private readonly sessionFactory: BrowserSessionFactory
  private readonly urlStore: BrowserUrlPreferenceStore
  private readonly onCloseCleanup?: () => Promise<void> | void

  private server: Server | undefined
  private startedAt = ''
  private running = false
  private readonly clients = new Set<Socket>()
  private readonly sessions = new Map<string, ManagedBrowserSession>()
  private readonly sessionCreations = new Map<string, Promise<ManagedBrowserSession>>()
  private readonly activeOperations = new Map<string, AbortController>()
  private readonly ownerAttachedSession = new Map<unknown, { sessionId: string; lastInput: DesktopViewportAttachInput }>()
  private readonly ownerAttachGen = new Map<unknown, number>()

  constructor(options: BrowserHostOptions = {}) {
    this.home = options.home ?? ludensHome()
    this.hostId = options.hostId ?? `browser-host-${randomUUID()}`
    this.socketPath = options.socketPath ?? resolveBrowserHostSocketPath(this.home)
    this.runtimeFilePath = options.runtimeFilePath ?? browserHostRuntimeFilePath(this.home)
    this.version = options.version ?? BROWSER_HOST_VERSION
    this.defaultWidth = options.defaultWidth ?? DEFAULT_VIEWPORT_WIDTH
    this.defaultHeight = options.defaultHeight ?? DEFAULT_VIEWPORT_HEIGHT
    this.urlStore = options.urlStore ?? createBrowserUrlPreferenceStore(this.home)

    if (options.sessionFactory) {
      this.sessionFactory = options.sessionFactory
      this.onCloseCleanup = options.onCloseCleanup
    } else {
      const prod = createProductionElectronSessionFactory()
      this.sessionFactory = prod.factory
      this.onCloseCleanup = async () => {
        await prod.dispose()
        await options.onCloseCleanup?.()
      }
    }
  }

  isRunning(): boolean {
    return this.running
  }

  runtimeInfo(): BrowserHostRuntimeInfo {
    return {
      hostId: this.hostId,
      pid: process.pid,
      socketPath: this.socketPath,
      startedAt: this.startedAt || new Date().toISOString(),
      home: this.home,
      version: this.version,
    }
  }

  listSessions(): string[] {
    return Array.from(this.sessions.keys())
  }

  getHostInfo(): { available: boolean; hostId: string; socketPath: string; pid: number } {
    return {
      available: this.running,
      hostId: this.hostId,
      socketPath: this.socketPath,
      pid: process.pid,
    }
  }

  async start(): Promise<BrowserHostRuntimeInfo> {
    if (this.running) return this.runtimeInfo()

    if (!isWindowsNamedPipe(this.socketPath)) {
      await mkdir(dirname(this.socketPath), { recursive: true })
    }
    await mkdir(dirname(this.runtimeFilePath), { recursive: true })

    await clearStaleLocalSocket(this.socketPath, () => {
      return new Error(`BrowserHost socket is already in use: ${this.socketPath}`)
    })

    const server = createServer(socket => {
      this.handleClientSocket(socket)
    })

    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: Error) => {
        server.off('listening', onListening)
        rejectListen(error)
      }
      const onListening = () => {
        server.off('error', onError)
        resolveListen()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.socketPath)
    })

    if (!isWindowsNamedPipe(this.socketPath) && process.platform !== 'win32') {
      await chmod(this.socketPath, 0o600).catch(() => {})
    }

    this.server = server
    this.startedAt = new Date().toISOString()
    this.running = true

    const info = this.runtimeInfo()
    await this.writeRuntimeFileAtomically(info)
    return info
  }

  async close(): Promise<void> {
    if (!this.running && !this.server) return
    this.running = false

    for (const controller of this.activeOperations.values()) {
      controller.abort()
    }
    this.activeOperations.clear()

    for (const socket of Array.from(this.clients)) {
      try {
        socket.destroy()
      } catch {}
    }
    this.clients.clear()

    for (const session of Array.from(this.sessions.values())) {
      await session.close().catch(() => {})
    }
    this.sessions.clear()
    this.sessionCreations.clear()
    this.ownerAttachedSession.clear()
    this.ownerAttachGen.clear()

    const srv = this.server
    this.server = undefined
    if (srv) {
      await new Promise<void>(resolveClose => {
        srv.close(() => resolveClose())
      }).catch(() => {})
    }

    await this.onCloseCleanup?.()

    if (!isWindowsNamedPipe(this.socketPath)) {
      await unlink(this.socketPath).catch(() => {})
    }
    await this.removeRuntimeFileIfOwned()
  }

  /** Attach or update a session's native `WebContentsView` inside `owner`'s viewport slot. */
  async attachToOwner(owner: unknown, input: DesktopViewportAttachInput): Promise<void> {
    if (!input.sessionId || typeof input.sessionId !== 'string') {
      throw new Error('attachToOwner requires a valid sessionId')
    }
    const gen = (this.ownerAttachGen.get(owner) ?? 0) + 1
    this.ownerAttachGen.set(owner, gen)

    const normalizedBounds = normalizeViewportBounds(input.bounds)
    const normalizedInput: DesktopViewportAttachInput = {
      sessionId: input.sessionId,
      initialUrl: input.initialUrl,
      bounds: normalizedBounds,
      visible: Boolean(input.visible),
      interactive: Boolean(input.interactive),
    }

    const previous = this.ownerAttachedSession.get(owner)
    if (previous && previous.sessionId !== normalizedInput.sessionId) {
      const prevSession = this.sessions.get(previous.sessionId)
      if (prevSession?.backend.detachFromOwner) {
        await prevSession.backend.detachFromOwner(owner).catch(() => {})
      }
      if (this.ownerAttachedSession.get(owner)?.sessionId === previous.sessionId) {
        this.ownerAttachedSession.delete(owner)
      }
      if (this.ownerAttachGen.get(owner) !== gen) return
    }

    const session = await this.getOrCreateSession({
      sessionId: normalizedInput.sessionId,
      initialUrl: normalizedInput.initialUrl,
      width: normalizedBounds.width > 0 ? normalizedBounds.width : this.defaultWidth,
      height: normalizedBounds.height > 0 ? normalizedBounds.height : this.defaultHeight,
    })
    if (this.ownerAttachGen.get(owner) !== gen) return

    const latestPrevious = this.ownerAttachedSession.get(owner)
    if (latestPrevious && latestPrevious.sessionId !== normalizedInput.sessionId) {
      const prevSession = this.sessions.get(latestPrevious.sessionId)
      if (prevSession?.backend.detachFromOwner) {
        await prevSession.backend.detachFromOwner(owner).catch(() => {})
      }
      if (this.ownerAttachGen.get(owner) !== gen) return
    }

    await session.attachOwner(owner, normalizedInput)
    if (this.ownerAttachGen.get(owner) !== gen) {
      if (session.backend.detachFromOwner) {
        await session.backend.detachFromOwner(owner).catch(() => {})
      }
      return
    }
    this.ownerAttachedSession.set(owner, {
      sessionId: normalizedInput.sessionId,
      lastInput: normalizedInput,
    })
  }

  /** Update bounds / visibility / interactivity for an attached session (or current session on `owner`). */
  async updateOwnerBounds(
    owner: unknown,
    input: Partial<DesktopViewportAttachInput> & { bounds: NativeViewportBounds },
  ): Promise<void> {
    const current = this.ownerAttachedSession.get(owner)
    const sessionId = input.sessionId || current?.sessionId
    if (!sessionId) return
    const nextInput: DesktopViewportAttachInput = {
      sessionId,
      initialUrl: input.initialUrl ?? current?.lastInput.initialUrl,
      bounds: normalizeViewportBounds(input.bounds),
      visible: input.visible ?? current?.lastInput.visible ?? true,
      interactive: input.interactive ?? current?.lastInput.interactive ?? true,
    }
    const session = this.sessions.get(sessionId)
    if (!session) {
      await this.attachToOwner(owner, nextInput)
      return
    }
    await session.updateOwnerBounds(owner, nextInput)
    this.ownerAttachedSession.set(owner, { sessionId, lastInput: nextInput })
  }

  /** Subscribe an in-process listener (e.g. Electron IPC) to live viewport frames for a session. */
  async subscribeSessionFrames(
    sessionId: string,
    listener: (frame: DesktopViewportFramePayload) => void,
    options?: { maxFps?: number; quality?: number },
  ): Promise<() => void> {
    const trimmedId = sessionId.trim()
    if (!trimmedId) return () => {}
    let session = this.sessions.get(trimmedId)
    if (!session) {
      const pending = this.sessionCreations.get(trimmedId)
      if (pending) {
        session = await pending.catch(() => undefined)
      }
    }
    if (!session) return () => {}
    return session.subscribeFrames(listener, options)
  }

  /** Detach the session from `owner` and park it back in the background keepalive host. */
  async detachFromOwner(owner: unknown, sessionId?: string): Promise<void> {
    const current = this.ownerAttachedSession.get(owner)
    const targetSessionId = sessionId || current?.sessionId
    if (!targetSessionId) return
    if (!sessionId || current?.sessionId === targetSessionId) {
      this.ownerAttachGen.set(owner, (this.ownerAttachGen.get(owner) ?? 0) + 1)
    }
    const session = this.sessions.get(targetSessionId)
    if (session?.backend.detachFromOwner) {
      await session.backend.detachFromOwner(owner).catch(() => {})
    }
    if (current && current.sessionId === targetSessionId) {
      this.ownerAttachedSession.delete(owner)
    }
  }

  /** Temporarily park an owner's attached view when the owner window hides to tray. */
  async suspendOwnerView(owner: unknown): Promise<void> {
    const current = this.ownerAttachedSession.get(owner)
    if (!current) return
    const session = this.sessions.get(current.sessionId)
    if (session?.backend.detachFromOwner) {
      await session.backend.detachFromOwner(owner).catch(() => {})
    }
  }

  /** Restore an owner's attached view when the owner window becomes visible again. */
  async resumeOwnerView(owner: unknown): Promise<void> {
    const current = this.ownerAttachedSession.get(owner)
    if (!current) return
    const session = this.sessions.get(current.sessionId)
    if (session && current.lastInput.visible) {
      await session.attachOwner(owner, current.lastInput).catch(() => {})
    }
  }

  private async writeRuntimeFileAtomically(info: BrowserHostRuntimeInfo): Promise<void> {
    const tmpPath = `${this.runtimeFilePath}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`
    const payload = `${JSON.stringify(info, null, 2)}\n`
    await writeFile(tmpPath, payload, { encoding: 'utf8', mode: 0o600 })
    await rename(tmpPath, this.runtimeFilePath)
  }

  private async removeRuntimeFileIfOwned(): Promise<void> {
    try {
      const raw = await readFile(this.runtimeFilePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<BrowserHostRuntimeInfo>
      if (parsed.hostId && parsed.hostId !== this.hostId) {
        return
      }
    } catch {
      // Missing or invalid file — attempt cleanup anyway.
    }
    await unlink(this.runtimeFilePath).catch(() => {})
  }

  private async getOrCreateSession(params: {
    sessionId: string
    initialUrl?: string
    width?: number
    height?: number
    partition?: string
  }): Promise<ManagedBrowserSession> {
    const existing = this.sessions.get(params.sessionId)
    if (existing) {
      await existing.ensure(params)
      return existing
    }

    let pending = this.sessionCreations.get(params.sessionId)
    if (!pending) {
      pending = (async () => {
        const width = clampDimension(params.width, this.defaultWidth)
        const height = clampDimension(params.height, this.defaultHeight)
        const partition = params.partition?.trim() || `persist:ludens-browser-${params.sessionId}`
        const backend = await this.sessionFactory({
          sessionId: params.sessionId,
          hostId: this.hostId,
          width,
          height,
          partition,
        })
        const managed = new ManagedBrowserSession(params.sessionId, backend, width, height, {
          resolveSavedUrl: () => this.urlStore.readLastUrl(params.sessionId),
          onExternalUrl: url => {
            void this.urlStore.writeLastUrl(params.sessionId, url).catch(() => {})
          },
        })
        try {
          await managed.ensure(params)
        } catch (error) {
          await managed.close().catch(() => {})
          throw error
        }
        this.sessions.set(params.sessionId, managed)
        return managed
      })().finally(() => {
        this.sessionCreations.delete(params.sessionId)
      })
      this.sessionCreations.set(params.sessionId, pending)
    }
    return pending
  }

  private requireSession(sessionId: string): ManagedBrowserSession {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Unknown browser session: ${sessionId}`)
    }
    return session
  }

  private handleClientSocket(socket: Socket): void {
    this.clients.add(socket)
    const decoder = new StringDecoder('utf8')
    let buffer = ''

    const cleanupClient = () => {
      this.clients.delete(socket)
      for (const session of this.sessions.values()) {
        session.unsubscribe(socket)
      }
    }

    socket.on('close', cleanupClient)
    socket.on('error', cleanupClient)

    socket.on('data', chunk => {
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk)
      let newlineIdx = buffer.indexOf('\n')
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trim()
        buffer = buffer.slice(newlineIdx + 1)
        if (line.length > 0) {
          void this.handleClientLine(socket, line)
        }
        newlineIdx = buffer.indexOf('\n')
      }
    })
  }

  private async handleClientLine(socket: Socket, line: string): Promise<void> {
    let envelope: BrowserHostEnvelope
    try {
      const parsed = JSON.parse(line) as Partial<BrowserHostEnvelope>
      if (!parsed || typeof parsed.id !== 'string' || !parsed.request || typeof parsed.request !== 'object') {
        throw new Error('Malformed BrowserHost envelope')
      }
      envelope = parsed as BrowserHostEnvelope
    } catch (error) {
      writeWireMessage(socket, {
        id: 'invalid',
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }

    try {
      const value = await this.dispatchRequest(socket, envelope.id, envelope.request)
      writeWireMessage(socket, { id: envelope.id, ok: true, value })
    } catch (error) {
      writeWireMessage(socket, {
        id: envelope.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async dispatchRequest(
    socket: Socket,
    envelopeId: string,
    request: BrowserHostRequest,
  ): Promise<unknown> {
    switch (request.kind) {
      case 'ping': {
        const result: BrowserHostPingResult = {
          hostId: this.hostId,
          pid: process.pid,
          version: this.version,
          sessions: this.listSessions(),
        }
        return result
      }
      case 'session.ensure': {
        const session = await this.getOrCreateSession({
          sessionId: request.sessionId,
          initialUrl: request.initialUrl,
          width: request.width,
          height: request.height,
          partition: request.partition,
        })
        return session.describe()
      }
      case 'session.describe': {
        return this.requireSession(request.sessionId).describe()
      }
      case 'session.close': {
        const session = this.sessions.get(request.sessionId)
        if (session) {
          this.sessions.delete(request.sessionId)
          for (const [owner, entry] of Array.from(this.ownerAttachedSession.entries())) {
            if (entry.sessionId === request.sessionId) {
              this.ownerAttachedSession.delete(owner)
            }
          }
          await session.close()
        }
        return { ok: true }
      }
      case 'session.action': {
        return this.requireSession(request.sessionId).action(request.action)
      }
      case 'session.capture': {
        return this.requireSession(request.sessionId).capture({
          format: request.format,
          quality: request.quality,
        })
      }
      case 'session.input': {
        return this.requireSession(request.sessionId).input(request.input)
      }
      case 'session.type': {
        return this.requireSession(request.sessionId).typeText(request.text)
      }
      case 'session.play': {
        const session = this.requireSession(request.sessionId)
        const controller = new AbortController()
        this.activeOperations.set(envelopeId, controller)
        try {
          return await session.play(request.steps, controller.signal)
        } finally {
          this.activeOperations.delete(envelopeId)
        }
      }
      case 'session.releaseAll': {
        return this.requireSession(request.sessionId).releaseAll()
      }
      case 'session.subscribe': {
        await this.requireSession(request.sessionId).subscribe(socket, {
          maxFps: request.maxFps,
          quality: request.quality,
        })
        return { ok: true }
      }
      case 'session.unsubscribe': {
        const session = this.sessions.get(request.sessionId)
        session?.unsubscribe(socket)
        return { ok: true }
      }
      case 'cancel': {
        const controller = this.activeOperations.get(request.operationId)
        if (controller) {
          controller.abort()
          return { ok: true, cancelled: true }
        }
        return { ok: true, cancelled: false }
      }
      default: {
        const exhaustive: never = request
        throw new Error(`Unsupported BrowserHost request: ${JSON.stringify(exhaustive)}`)
      }
    }
  }
}
