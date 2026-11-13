import { describe, expect, it } from 'vitest'
import {
  buildOfflineWaitingHtml,
  DESKTOP_BG_COLOR,
  DESKTOP_SIDEBAR_BG_COLOR,
  DESKTOP_TITLEBAR_HEIGHT,
  DESKTOP_WIN_SYMBOL_COLOR,
  ownerBrowserWindowOptions,
  resolveCaptionStyle,
  resolveMacTitlebarDoubleClickAction,
} from './window-chrome.js'

describe('window-chrome', () => {
  it('defines expected constants and caption styles per platform', () => {
    expect(DESKTOP_TITLEBAR_HEIGHT).toBe(38)
    expect(DESKTOP_BG_COLOR).toBe('#090a0d')
    expect(DESKTOP_SIDEBAR_BG_COLOR).toBe('#0c0e12')
    expect(DESKTOP_WIN_SYMBOL_COLOR).toBe('#cfd5e2')

    expect(resolveCaptionStyle('darwin')).toBe('macos')
    expect(resolveCaptionStyle('win32')).toBe('win32-overlay')
    expect(resolveCaptionStyle('linux')).toBe('custom')
    expect(resolveCaptionStyle('freebsd')).toBe('custom')
  })

  it('builds darwin BrowserWindow options with hiddenInset and centered traffic lights', () => {
    const opts = ownerBrowserWindowOptions({
      platform: 'darwin',
      preloadPath: '/tmp/preload.cjs',
      bounds: { x: 100, y: 80, width: 1280, height: 800 },
    })

    expect(opts.title).toBe('Ludens')
    expect(opts.minWidth).toBe(960)
    expect(opts.minHeight).toBe(640)
    expect(opts.show).toBe(false)
    expect(opts.backgroundColor).toBe('#090a0d')
    expect(opts.titleBarStyle).toBe('hiddenInset')
    expect(opts.trafficLightPosition).toEqual({ x: 14, y: 12 })
    expect(opts.x).toBe(100)
    expect(opts.y).toBe(80)
    expect(opts.width).toBe(1280)
    expect(opts.height).toBe(800)
    expect(opts.webPreferences).toEqual({
      preload: '/tmp/preload.cjs',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    })
  })

  it('builds win32 BrowserWindow options with hidden titlebar, WCO overlay, and autoHideMenuBar', () => {
    const opts = ownerBrowserWindowOptions({
      platform: 'win32',
      preloadPath: 'C:\\app\\preload.cjs',
    })

    expect(opts.title).toBe('Ludens')
    expect(opts.titleBarStyle).toBe('hidden')
    expect(opts.titleBarOverlay).toEqual({
      color: '#090a0d',
      symbolColor: '#cfd5e2',
      height: 38,
    })
    expect(opts.autoHideMenuBar).toBe(true)
    expect(opts.width).toBe(1440)
    expect(opts.height).toBe(940)
  })

  it('builds linux BrowserWindow options as frameless with hidden menu bar', () => {
    const opts = ownerBrowserWindowOptions({
      platform: 'linux',
      preloadPath: '/app/preload.cjs',
    })

    expect(opts.frame).toBe(false)
    expect(opts.autoHideMenuBar).toBe(true)
    expect(opts.backgroundColor).toBe('#090a0d')
  })

  it('resolves macOS AppleActionOnDoubleClick preference safely', () => {
    expect(resolveMacTitlebarDoubleClickAction('Minimize')).toBe('minimize')
    expect(resolveMacTitlebarDoubleClickAction('minimize')).toBe('minimize')
    expect(resolveMacTitlebarDoubleClickAction('None')).toBe('none')
    expect(resolveMacTitlebarDoubleClickAction('Maximize')).toBe('maximize')
    expect(resolveMacTitlebarDoubleClickAction(undefined)).toBe('maximize')
    expect(resolveMacTitlebarDoubleClickAction(null)).toBe('maximize')
    expect(resolveMacTitlebarDoubleClickAction('')).toBe('maximize')
  })

  it('renders dark offline waiting HTML with platform-specific titlebar safe areas and retry button', () => {
    const macHtml = buildOfflineWaitingHtml({
      locale: 'zh-CN',
      platform: 'darwin',
      dashboardOrigin: 'http://127.0.0.1:3015',
    })
    expect(macHtml).toContain('#090a0d')
    expect(macHtml).toContain('#ff4f1f')
    expect(macHtml).toContain('-webkit-app-region: drag')
    expect(macHtml).toContain('-webkit-app-region: no-drag')
    expect(macHtml).toContain('padding-left: 78px')
    expect(macHtml).toContain('立即重试 / Retry now')
    expect(macHtml).toContain('location.reload()')
    expect(macHtml).toContain('http://127.0.0.1:3015')

    const winHtml = buildOfflineWaitingHtml({
      locale: 'en-US',
      platform: 'win32',
      dashboardOrigin: 'http://127.0.0.1:3015/<script>',
    })
    expect(winHtml).toContain('padding-right: 140px')
    expect(winHtml).toContain('&lt;script&gt;')
    expect(winHtml).not.toContain('<script>')
  })
})
