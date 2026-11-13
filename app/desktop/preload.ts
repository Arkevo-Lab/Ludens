import { contextBridge, ipcRenderer } from 'electron'
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

const platform = normalizeDesktopPlatform(process.platform)
const initialState = {
  platform,
  captionStyle: resolveCaptionStyle(platform),
  titlebarHeight: DESKTOP_TITLEBAR_HEIGHT,
} as const

// Narrow Pet settings, activity, and window-chrome IPC bridge; no general filesystem access.
contextBridge.exposeInMainWorld('ludens', {
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
