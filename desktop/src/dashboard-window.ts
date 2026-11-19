import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from 'electron'

const ALLOWED_DASHBOARD_PROTOCOLS = new Set(['ludens-app:', 'http:', 'https:'])

/** Normalizes trusted app origins including custom privileged schemes (`ludens-app:`). */
export function originKey(input: string): string | null {
  try {
    const url = new URL(input)
    if (!ALLOWED_DASHBOARD_PROTOCOLS.has(url.protocol) || !url.host || url.username || url.password) return null
    return `${url.protocol}//${url.host}`
  } catch { return null }
}

/** Only the configured local application may use the owner's native bridge. */
export function isDashboardUrl(input: string, origin: string): boolean {
  const expected = originKey(origin)
  const candidate = originKey(input)
  return Boolean(expected && candidate && candidate === expected)
}

export function dashboardSender(owner: BrowserWindow, origin: string, event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return !owner.isDestroyed() && event.sender === owner.webContents
    && event.senderFrame === owner.webContents.mainFrame
    && Boolean(event.senderFrame && isDashboardUrl(event.senderFrame.url, origin))
}

export function blockUrl(dashboardUrl: string, blockId: string): string {
  const url = new URL(dashboardUrl)
  url.searchParams.set('view', 'live')
  url.searchParams.set('block', blockId)
  return url.href
}
