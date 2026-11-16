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

export const LUDENS_RPC_CHANNELS = {
  send: 'ludens:rpc:send',
  message: 'ludens:rpc:message',
  status: 'ludens:rpc:status',
  ready: 'ludens:rpc:ready',
  reconnect: 'ludens:rpc:reconnect',
} as const
