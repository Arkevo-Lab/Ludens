import type { DesktopViewportAttachInput, NativeViewportBounds } from '@ludens/protocol/viewport'

export interface DesktopRpcStatus {
  readonly state: 'connecting' | 'connected' | 'disconnected'
  readonly error?: string
}

export interface DesktopRpcBridge {
  send(frameJson: string): void
  onMessage(callback: (frameJson: string) => void): () => void
  onStatus?(callback: (status: DesktopRpcStatus) => void): () => void
  reconnect?(): Promise<void>
}

export interface DesktopViewportHostInfo {
  readonly available: boolean
  readonly hostId: string
  readonly socketPath: string
  readonly pid: number
}

export type DesktopViewportUpdateBoundsInput = Partial<DesktopViewportAttachInput> & {
  bounds: NativeViewportBounds
}

export interface DesktopViewportFramePayload {
  readonly sessionId: string
  readonly format: 'jpeg' | 'png' | 'webp'
  readonly dataBase64: string
  readonly width: number
  readonly height: number
  readonly timestampMs: number
  readonly seq: number
  readonly pointerLocked: boolean
}

export interface DesktopViewportFrameStreamInput {
  readonly sessionId: string
  readonly active: boolean
  readonly maxFps?: number
  readonly quality?: number
}

export interface DesktopViewportBridge {
  getHostInfo(): Promise<DesktopViewportHostInfo>
  attach(input: DesktopViewportAttachInput): Promise<{ ok: true }>
  updateBounds(input: DesktopViewportUpdateBoundsInput): Promise<{ ok: true }>
  detach(sessionId?: string | { sessionId?: string }): Promise<{ ok: true }>
  setFrameStream?(input: DesktopViewportFrameStreamInput): Promise<{ ok: boolean }>
  onFrame?(callback: (frame: DesktopViewportFramePayload) => void): () => void
}

export const LUDENS_RPC_CHANNELS = {
  send: 'ludens:rpc:send',
  message: 'ludens:rpc:message',
  status: 'ludens:rpc:status',
  ready: 'ludens:rpc:ready',
  reconnect: 'ludens:rpc:reconnect',
} as const

export const LUDENS_VIEWPORT_CHANNELS = {
  getHostInfo: 'ludens:viewport:get-host-info',
  attach: 'ludens:viewport:attach',
  updateBounds: 'ludens:viewport:update-bounds',
  detach: 'ludens:viewport:detach',
  setFrameStream: 'ludens:viewport:set-frame-stream',
  frame: 'ludens:viewport:frame',
} as const
