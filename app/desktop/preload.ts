import { contextBridge, ipcRenderer } from 'electron'
import {
  LUDENS_RPC_CHANNELS,
  type DesktopRpcBridge,
  type DesktopRpcStatus,
} from './rpc-channels.js'
import {
  DESKTOP_TITLEBAR_HEIGHT,
  normalizeDesktopPlatform,
  resolveCaptionStyle,
} from './window-chrome.js'

function on(channel: string, callback: (value: any) => void) {
  const listener = (_event: Electron.IpcRendererEvent, value: unknown) => callback(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

function sanitizeRpcStatus(value: unknown): DesktopRpcStatus | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as { state?: unknown; error?: unknown }
  if (
    candidate.state !== 'connecting' &&
    candidate.state !== 'connected' &&
    candidate.state !== 'disconnected'
  ) {
    return null
  }
  return typeof candidate.error === 'string' && candidate.error.length > 0
    ? { state: candidate.state, error: candidate.error }
    : { state: candidate.state }
}

const platform = normalizeDesktopPlatform(process.platform)
const initialState = {
  platform,
  captionStyle: resolveCaptionStyle(platform),
  titlebarHeight: DESKTOP_TITLEBAR_HEIGHT,
} as const

const rpcBridge: DesktopRpcBridge = {
  send: (frameJson: string) => {
    if (typeof frameJson !== 'string') return
    ipcRenderer.send(LUDENS_RPC_CHANNELS.send, frameJson)
  },
  onMessage: (callback: (frameJson: string) => void) =>
    on(LUDENS_RPC_CHANNELS.message, value => {
      if (typeof value === 'string') callback(value)
    }),
  onStatus: (callback: (status: DesktopRpcStatus) => void) => {
    let active = true
    let receivedPush = false
    const unsubscribe = on(LUDENS_RPC_CHANNELS.status, value => {
      if (!active) return
      const parsed = sanitizeRpcStatus(value)
      if (!parsed) return
      receivedPush = true
      callback(parsed)
    })
    void ipcRenderer.invoke(LUDENS_RPC_CHANNELS.ready).then(value => {
      if (!active || receivedPush) return
      const parsed = sanitizeRpcStatus(value)
      if (parsed) callback(parsed)
    }).catch(() => {})
    return () => {
      active = false
      unsubscribe()
    }
  },
  reconnect: async () => {
    await ipcRenderer.invoke(LUDENS_RPC_CHANNELS.reconnect)
  },
}

// Narrow UDS RPC relay, Pet settings, activity, and window-chrome IPC bridge; no node:net or fs exposure.
contextBridge.exposeInMainWorld('ludens', {
  rpc: rpcBridge,
  companion: {
    getSound: () => ipcRenderer.invoke('ludens:companion:sound:get'),
    updateSound: (value: unknown) => ipcRenderer.invoke('ludens:companion:sound:update', value),
    resetSound: () => ipcRenderer.invoke('ludens:companion:sound:reset'),
    onSound: (callback: (value: unknown) => void) => on('ludens:companion:sound:changed', callback),
    getVisible: () => ipcRenderer.invoke('ludens:companion:get-visible'),
    toggle: () => ipcRenderer.invoke('ludens:companion:toggle'),
    onVisibility: (callback: (value: boolean) => void) => on('ludens:companion:visibility', callback),
    setLocale: (locale: string) => ipcRenderer.invoke('ludens:companion:set-locale', locale),
    activity: {
      getPreferences: () => ipcRenderer.invoke('ludens:activity:preferences'),
      updatePreferences: (value: unknown) => ipcRenderer.invoke('ludens:activity:update-preferences', value),
      resetPreferences: () => ipcRenderer.invoke('ludens:activity:reset-preferences'),
      onPreferences: (callback: (value: unknown) => void) => on('ludens:activity:preferences-changed', callback),
      open: (displayId: string) => ipcRenderer.invoke('ludens:activity:open', displayId),
      dismiss: (displayId: string) => ipcRenderer.invoke('ludens:activity:dismiss', displayId),
      onOpen: (callback: (value: string) => void) => on('ludens:activity:open', callback),
      onDisplay: (callback: (value: any) => void) => {
        let active = true
        const changed = new Set<string>()
        const unsubscribe = on('ludens:activity:display', value => { changed.add(value.displayId); callback(value) })
        void ipcRenderer.invoke('ludens:activity:snapshot').then(events => {
          if (active) for (const event of events) if (!changed.has(event.displayId)) callback(event)
        }).catch(() => {})
        return () => { active = false; unsubscribe() }
      },
    },
  },
  window: {
    platform,
    initialState,
    getState: () => ipcRenderer.invoke('ludens:window:get-state'),
    onState: (callback: (state: unknown) => void) => on('ludens:window:state', callback),
    onCommand: (callback: (command: unknown) => void) => on('ludens:window:command', callback),
    minimize: () => ipcRenderer.invoke('ludens:window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('ludens:window:toggle-maximize'),
    close: () => ipcRenderer.invoke('ludens:window:close'),
    handleTitlebarDoubleClick: () => ipcRenderer.invoke('ludens:window:titlebar-double-click'),
    goBack: () => ipcRenderer.invoke('ludens:window:go-back'),
    goForward: () => ipcRenderer.invoke('ludens:window:go-forward'),
    reload: () => ipcRenderer.invoke('ludens:window:reload'),
    setOverlayTheme: (options: { color: string; symbolColor: string; height?: number }) =>
      ipcRenderer.invoke('ludens:window:set-overlay-theme', options),
  },
})
contextBridge.exposeInMainWorld('ludensPet', {
  getSnapshot: () => ipcRenderer.invoke('ludens-pet:snapshot'),
  onSnapshot: (callback: (value: unknown) => void) => on('ludens-pet:snapshot', callback),
  openDashboard: () => ipcRenderer.invoke('ludens-pet:open-dashboard'),
})
