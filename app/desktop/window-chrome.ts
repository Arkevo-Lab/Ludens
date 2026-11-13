import type { BrowserWindowConstructorOptions, NativeImage } from 'electron'

export type DesktopPlatform = 'darwin' | 'win32' | 'linux'
export type DesktopCaptionStyle = 'macos' | 'win32-overlay' | 'custom'
export type MacTitlebarDoubleClickAction = 'maximize' | 'minimize' | 'none'

export const DESKTOP_TITLEBAR_HEIGHT = 38
export const DESKTOP_BG_COLOR = '#090a0d'
export const DESKTOP_SIDEBAR_BG_COLOR = '#0c0e12'
export const DESKTOP_WIN_SYMBOL_COLOR = '#cfd5e2'
export const DESKTOP_WIN_SYMBOL_INACTIVE_COLOR = '#6b7280'

export interface WindowBoundsLike {
  x?: number
  y?: number
  width?: number
  height?: number
}

export interface OwnerWindowOptionsInput {
  platform: NodeJS.Platform | string
  appIcon?: NativeImage
  preloadPath: string
  bounds?: WindowBoundsLike
}

export interface OfflineWaitingHtmlInput {
  locale?: string
  platform: NodeJS.Platform | string
  dashboardOrigin: string
}

export function normalizeDesktopPlatform(platform: NodeJS.Platform | string): DesktopPlatform {
  if (platform === 'darwin') return 'darwin'
  if (platform === 'win32') return 'win32'
  return 'linux'
}

export function resolveCaptionStyle(platform: NodeJS.Platform | string): DesktopCaptionStyle {
  const normalized = normalizeDesktopPlatform(platform)
  if (normalized === 'darwin') return 'macos'
  if (normalized === 'win32') return 'win32-overlay'
  return 'custom'
}

export function resolveMacTitlebarDoubleClickAction(pref?: string | null): MacTitlebarDoubleClickAction {
  const normalized = pref?.trim().toLowerCase()
  if (normalized === 'minimize') return 'minimize'
  if (normalized === 'none') return 'none'
  return 'maximize'
}

export function ownerBrowserWindowOptions(input: OwnerWindowOptionsInput): BrowserWindowConstructorOptions {
  const platform = normalizeDesktopPlatform(input.platform)
  const bounds = input.bounds
  const base: BrowserWindowConstructorOptions = {
    title: 'Ludens',
    width: bounds?.width ?? 1440,
    height: bounds?.height ?? 940,
    ...(typeof bounds?.x === 'number' && Number.isFinite(bounds.x) ? { x: bounds.x } : {}),
    ...(typeof bounds?.y === 'number' && Number.isFinite(bounds.y) ? { y: bounds.y } : {}),
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: DESKTOP_BG_COLOR,
    ...(input.appIcon && !input.appIcon.isEmpty() ? { icon: input.appIcon } : {}),
    webPreferences: {
      preload: input.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  }

  if (platform === 'darwin') {
    return {
      ...base,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 14, y: 12 },
    }
  }

  if (platform === 'win32') {
    return {
      ...base,
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: DESKTOP_BG_COLOR,
        symbolColor: DESKTOP_WIN_SYMBOL_COLOR,
        height: DESKTOP_TITLEBAR_HEIGHT,
      },
      autoHideMenuBar: true,
    }
  }

  return {
    ...base,
    frame: false,
    autoHideMenuBar: true,
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function buildOfflineWaitingHtml(input: OfflineWaitingHtmlInput): string {
  const platform = normalizeDesktopPlatform(input.platform)
  const isZh = (input.locale ?? 'zh').toLowerCase().startsWith('zh')
  const lang = isZh ? 'zh' : 'en'
  const safeOrigin = escapeHtml(input.dashboardOrigin)
  const titlebarPadding = platform === 'darwin'
    ? 'padding-left: 78px; padding-right: 16px;'
    : platform === 'win32'
      ? 'padding-left: 16px; padding-right: 140px;'
      : 'padding-left: 16px; padding-right: 16px;'

  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Ludens · Reconnecting</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    height: 100%;
    background: ${DESKTOP_BG_COLOR};
    color: #e6e9ef;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;
    -webkit-font-smoothing: antialiased;
    overflow: hidden;
  }
  .titlebar {
    height: ${DESKTOP_TITLEBAR_HEIGHT}px;
    display: flex;
    align-items: center;
    ${titlebarPadding}
    background: ${DESKTOP_BG_COLOR};
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    -webkit-app-region: drag;
    user-select: none;
    font-size: 12px;
    color: #8b93a5;
    letter-spacing: 0.02em;
  }
  .main {
    height: calc(100% - ${DESKTOP_TITLEBAR_HEIGHT}px);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 32px;
  }
  .card {
    max-width: 460px;
    width: 100%;
    background: ${DESKTOP_SIDEBAR_BG_COLOR};
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 10px;
    padding: 28px;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 18px;
  }
  .pulse-block {
    width: 12px;
    height: 12px;
    background: #ff4f1f;
    box-shadow: 0 0 12px rgba(255, 79, 31, 0.65);
    animation: pulse 1.6s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.35; transform: scale(0.84); }
  }
  h1 {
    font-size: 16px;
    font-weight: 600;
    color: #f3f5f8;
  }
  p {
    font-size: 13px;
    line-height: 1.6;
    color: #9ba3b4;
    margin-top: 8px;
  }
  .origin {
    margin-top: 14px;
    padding: 8px 10px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.06);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
    color: #cfd5e2;
  }
  .actions {
    margin-top: 20px;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .retry-btn {
    -webkit-app-region: no-drag;
    appearance: none;
    border: 1px solid rgba(255, 79, 31, 0.45);
    background: rgba(255, 79, 31, 0.14);
    color: #ffd7cc;
    font-size: 13px;
    font-weight: 500;
    padding: 8px 14px;
    border-radius: 6px;
    cursor: pointer;
  }
  .retry-btn:hover {
    background: rgba(255, 79, 31, 0.24);
  }
  .hint {
    font-size: 12px;
    color: #6b7280;
  }
</style>
</head>
<body>
  <header class="titlebar">Ludens · Console</header>
  <main class="main">
    <section class="card">
      <div class="brand">
        <span class="pulse-block" aria-hidden="true"></span>
        <h1>等待本地日志服务 · Waiting for Local Service</h1>
      </div>
      <p>卢登斯正在自动重连本地控制台。服务恢复后，此窗口将自动打开。</p>
      <p>Ludens is reconnecting to the local dashboard. This window will open automatically once the service is ready.</p>
      <div class="origin">${safeOrigin}</div>
      <div class="actions">
        <button type="button" class="retry-btn" onclick="location.reload()">立即重试 / Retry now</button>
        <span class="hint">Auto-retry every 5s</span>
      </div>
    </section>
  </main>
</body>
</html>`
}
