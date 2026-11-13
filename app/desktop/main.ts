import { app, BrowserWindow, ipcMain, Menu, nativeImage, nativeTheme, screen, systemPreferences, Tray } from 'electron'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { ludensHome } from '@ludens/protocol/ludens'
import type { DesktopWindowCommand, DesktopWindowState } from '../lib/desktop.js'
import { createCompanion } from './companion.js'
import type { LudensPetSnapshot } from './ludens-source.js'
import { PetSessionCoordinator } from './pet-session.js'
import { dashboardSender, isDashboardUrl } from './dashboard-window.js'
import { createLudensTrayIcon } from './tray-icon.js'
import {
  buildOfflineWaitingHtml,
  DESKTOP_BG_COLOR,
  DESKTOP_TITLEBAR_HEIGHT,
  DESKTOP_WIN_SYMBOL_COLOR,
  DESKTOP_WIN_SYMBOL_INACTIVE_COLOR,
  normalizeDesktopPlatform,
  ownerBrowserWindowOptions,
  resolveCaptionStyle,
  resolveMacTitlebarDoubleClickAction,
} from './window-chrome.js'
import { loadWindowState, saveWindowState, saveWindowStateSync, type SavedWindowState } from './window-state.js'

const { values } = parseArgs({ args: process.argv.slice(2), options: {
  workspace: { type: 'string' }, dashboard: { type: 'string' }, profile: { type: 'string' },
  'show-window': { type: 'boolean' }, help: { type: 'boolean' },
} })
if (values.help) {
  console.log('Ludens Pet — Ludens log viewer\n\n--workspace PATH   Initial workspace, only when no follow target has been saved\n--dashboard URL    Local Ludens dashboard (default: http://127.0.0.1:3015)\n--profile PATH     Separate local pet preferences\n--show-window      Open the run/settings window on launch\n\nChoose the workspace to follow in the Dashboard. The pet reads existing logs; it never starts or stops the game agent.')
  app.exit(0)
} else {
  const initialWorkspace = values.workspace ?? process.env.LUDENS_WORKSPACE
  const workspace = initialWorkspace ? realpathSync(resolve(initialWorkspace)) : undefined
  const dashboard = new URL(values.dashboard ?? 'http://127.0.0.1:3015')
  if (dashboard.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(dashboard.hostname) || dashboard.username || dashboard.password) {
    throw new Error('--dashboard must be a local HTTP URL')
  }
  const here = dirname(fileURLToPath(import.meta.url))
  nativeTheme.themeSource = 'dark'
  if (process.platform === 'win32') app.setAppUserModelId('dev.ludens.app')
  app.setName('Ludens')
  app.setPath('userData', resolve(values.profile ?? join(ludensHome(), 'pet', 'profile')))
  mkdirSync(app.getPath('userData'), { recursive: true })
  if (!app.requestSingleInstanceLock()) {
    app.exit(0)
  } else {
    let quitting = false
    let owner: BrowserWindow | undefined
    let tray: Tray | undefined
    let source: PetSessionCoordinator | undefined
    let retryDashboard: (() => void) | undefined
    let dashboardTimer: ReturnType<typeof setInterval> | undefined
    let saveStateTimer: ReturnType<typeof setTimeout> | undefined
    let appliedInitialPlacement = false
    let snapshot: LudensPetSnapshot = {
      workspace: null, runId: null, epoch: null, phase: '请选择要跟随的工作区', intent: null,
      observationUrl: null, updatedAt: null, error: null, dashboardUrl: dashboard.href,
    }
    const windowStatePath = join(app.getPath('userData'), 'window-state.json')
    let persistedState: SavedWindowState | undefined
    const showOwner = () => {
      if (!owner || owner.isDestroyed()) return
      if (!appliedInitialPlacement && persistedState) {
        appliedInitialPlacement = true
        if (persistedState.maximized) owner.maximize()
        if (persistedState.fullScreen && process.platform === 'darwin') owner.setFullScreen(true)
      }
      if (owner.isMinimized()) owner.restore()
      owner.show()
      owner.focus()
      retryDashboard?.()
    }
    app.on('second-instance', showOwner)
    app.on('activate', showOwner)
    app.on('before-quit', () => {
      quitting = true
      clearInterval(dashboardTimer)
      clearTimeout(saveStateTimer)
      source?.stop()
    })
    app.on('window-all-closed', () => app.quit())
    void app.whenReady().then(async () => {
      const primaryWorkArea = screen.getPrimaryDisplay().workArea
      const workAreas = [
        primaryWorkArea,
        ...screen.getAllDisplays()
          .map(display => display.workArea)
          .filter(area => area.x !== primaryWorkArea.x || area.y !== primaryWorkArea.y || area.width !== primaryWorkArea.width || area.height !== primaryWorkArea.height),
      ]
      persistedState = loadWindowState(windowStatePath, workAreas)

      const publicAssets = existsSync(resolve(here, '../public/companion')) ? resolve(here, '../public') : resolve(here, '../../public')
      const appIcon = nativeImage.createFromPath(resolve(publicAssets, 'brand/ludens-app-icon.png'))
      if (!appIcon.isEmpty()) app.dock?.setIcon(appIcon)
      owner = new BrowserWindow(ownerBrowserWindowOptions({
        platform: process.platform,
        appIcon,
        preloadPath: join(here, 'preload.cjs'),
        bounds: persistedState,
      }))
      owner.setMaxListeners(24)
      owner.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      const navigation = (event: Electron.Event, url: string) => { if (!isDashboardUrl(url, dashboard.origin)) event.preventDefault() }
      owner.webContents.on('will-navigate', navigation)
      owner.webContents.on('will-redirect', navigation)
      const initial = new URL(dashboard.origin)
      initial.searchParams.set('view', 'live')
      let dashboardTarget = initial.href
      let loadingDashboard = false, dashboardReady = false

      const desktopPlatform = normalizeDesktopPlatform(process.platform)
      const captionStyle = resolveCaptionStyle(process.platform)
      const currentWindowState = (): DesktopWindowState => ({
        platform: desktopPlatform,
        captionStyle,
        titlebarHeight: DESKTOP_TITLEBAR_HEIGHT,
        maximized: owner ? owner.isMaximized() : false,
        fullScreen: owner ? owner.isFullScreen() : false,
        focused: owner ? owner.isFocused() : false,
        canGoBack: owner ? owner.webContents.navigationHistory.canGoBack() : false,
        canGoForward: owner ? owner.webContents.navigationHistory.canGoForward() : false,
      })
      const publishWindowState = () => {
        if (owner && !owner.isDestroyed() && isDashboardUrl(owner.webContents.getURL(), dashboard.origin)) {
          owner.webContents.send('ludens:window:state', currentWindowState())
        }
      }
      const sendWindowCommand = (command: DesktopWindowCommand) => {
        if (owner && !owner.isDestroyed() && isDashboardUrl(owner.webContents.getURL(), dashboard.origin)) {
          owner.webContents.send('ludens:window:command', command)
        }
      }
      const captureWindowState = (): SavedWindowState | undefined => {
        if (!owner || owner.isDestroyed()) return undefined
        const maximized = owner.isMaximized()
        const fullScreen = owner.isFullScreen()
        const normal = maximized || fullScreen ? owner.getNormalBounds() : owner.getBounds()
        return {
          x: normal.x,
          y: normal.y,
          width: normal.width,
          height: normal.height,
          maximized,
          fullScreen,
        }
      }
      const scheduleWindowStateSave = () => {
        clearTimeout(saveStateTimer)
        saveStateTimer = setTimeout(() => {
          const next = captureWindowState()
          if (next) void saveWindowState(windowStatePath, next).catch(() => {})
        }, 250)
      }
      app.on('before-quit', () => {
        const next = captureWindowState()
        if (!next) return
        try {
          saveWindowStateSync(windowStatePath, next)
        } catch {}
      })

      const syncWin32OverlayFocus = () => {
        if (process.platform !== 'win32' || !owner || owner.isDestroyed()) return
        owner.setTitleBarOverlay?.({
          color: DESKTOP_BG_COLOR,
          symbolColor: owner.isFocused() ? DESKTOP_WIN_SYMBOL_COLOR : DESKTOP_WIN_SYMBOL_INACTIVE_COLOR,
          height: DESKTOP_TITLEBAR_HEIGHT,
        })
      }

      owner.on('resize', scheduleWindowStateSave)
      owner.on('move', scheduleWindowStateSave)
      owner.on('maximize', () => { scheduleWindowStateSave(); publishWindowState() })
      owner.on('unmaximize', () => { scheduleWindowStateSave(); publishWindowState() })
      owner.on('enter-full-screen', () => { scheduleWindowStateSave(); publishWindowState() })
      owner.on('leave-full-screen', () => { scheduleWindowStateSave(); publishWindowState() })
      owner.on('focus', () => { syncWin32OverlayFocus(); publishWindowState() })
      owner.on('blur', () => { syncWin32OverlayFocus(); publishWindowState() })

      const rememberDashboard = (_event: Electron.Event, url: string) => {
        if (isDashboardUrl(url, dashboard.origin)) dashboardTarget = url
      }
      owner.webContents.on('did-navigate', (event, url, status) => {
        rememberDashboard(event, url)
        if (status > 0 && isDashboardUrl(url, dashboard.origin)) dashboardReady = true
        publishWindowState()
      })
      owner.webContents.on('did-navigate-in-page', (event, url, isMainFrame) => {
        if (isMainFrame) {
          rememberDashboard(event, url)
          publishWindowState()
        }
      })
      const showOfflineWaitingPage = async () => {
        if (!owner || owner.isDestroyed() || quitting) return
        const offline = buildOfflineWaitingHtml({
          locale: app.getLocale(),
          platform: process.platform,
          dashboardOrigin: dashboard.origin,
          retryUrl: dashboardTarget,
        })
        await owner.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(offline)}`).catch(() => {})
      }

      owner.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
        // Aborted/superseded navigation and subresources must not replace a healthy page.
        if (!isMainFrame || code === -3 || !isDashboardUrl(url, dashboard.origin)) return
        dashboardTarget = url
        dashboardReady = false
        console.error(`[ludens-pet] dashboard load failed: ${description} (${code})`)
        if (!loadingDashboard && !quitting) {
          void showOfflineWaitingPage()
        }
      })
      owner.webContents.on('render-process-gone', (_event, details) => {
        dashboardReady = false
        console.error(`[ludens-pet] dashboard renderer exited: ${details.reason}`)
      })
      owner.on('close', event => { if (!quitting) { event.preventDefault(); owner?.hide() } })
      const trusted = (event: Electron.IpcMainInvokeEvent) => !!owner && dashboardSender(owner, dashboard.origin, event)
      const openDetails = (url: string) => {
        if (!owner || owner.isDestroyed() || !isDashboardUrl(url, dashboard.origin)) return
        void owner.loadURL(url).catch(error => console.error('[ludens-pet] dashboard navigation failed:', error))
      }
      const pet = createCompanion(owner, { trustedOwner: trusted, openDetails }, () => updateApplicationMenu())
      if (!pet) throw new Error('Ludens Pet is disabled by LUDENS_DISABLE_COMPANION')
      const companion = pet

      const toggleOwnerMaximize = (): boolean => {
        if (!owner || owner.isDestroyed()) return false
        if (owner.isFullScreen()) {
          owner.setFullScreen(false)
        } else if (owner.isMaximized()) {
          owner.unmaximize()
        } else {
          owner.maximize()
        }
        return owner.isMaximized()
      }

      ipcMain.handle('ludens:window:get-state', event => {
        if (!trusted(event)) throw new Error('Unauthorized window access')
        return currentWindowState()
      })
      ipcMain.handle('ludens:window:minimize', event => {
        if (!trusted(event)) throw new Error('Unauthorized window access')
        owner?.minimize()
      })
      ipcMain.handle('ludens:window:toggle-maximize', event => {
        if (!trusted(event)) throw new Error('Unauthorized window access')
        return toggleOwnerMaximize()
      })
      ipcMain.handle('ludens:window:close', event => {
        if (!trusted(event)) throw new Error('Unauthorized window access')
        owner?.close()
      })
      ipcMain.handle('ludens:window:titlebar-double-click', event => {
        if (!trusted(event)) throw new Error('Unauthorized window access')
        if (!owner || owner.isDestroyed()) return
        if (process.platform === 'darwin') {
          const pref = systemPreferences.getUserDefault('AppleActionOnDoubleClick', 'string')
          const action = resolveMacTitlebarDoubleClickAction(pref)
          if (action === 'minimize') owner.minimize()
          else if (action === 'maximize') toggleOwnerMaximize()
          return
        }
        toggleOwnerMaximize()
      })
      ipcMain.handle('ludens:window:go-back', event => {
        if (!trusted(event)) throw new Error('Unauthorized window access')
        if (!owner || owner.isDestroyed() || !owner.webContents.navigationHistory.canGoBack()) return false
        owner.webContents.navigationHistory.goBack()
        return true
      })
      ipcMain.handle('ludens:window:go-forward', event => {
        if (!trusted(event)) throw new Error('Unauthorized window access')
        if (!owner || owner.isDestroyed() || !owner.webContents.navigationHistory.canGoForward()) return false
        owner.webContents.navigationHistory.goForward()
        return true
      })
      ipcMain.handle('ludens:window:reload', event => {
        if (!trusted(event)) throw new Error('Unauthorized window access')
        owner?.webContents.reload()
      })
      ipcMain.handle('ludens:window:set-overlay-theme', (event, rawOptions: unknown) => {
        if (!trusted(event)) throw new Error('Unauthorized window access')
        if (process.platform !== 'win32' || !owner || owner.isDestroyed() || !rawOptions || typeof rawOptions !== 'object') return
        const options = rawOptions as { color?: unknown; symbolColor?: unknown; height?: unknown }
        const color = typeof options.color === 'string' ? options.color : DESKTOP_BG_COLOR
        const symbolColor = typeof options.symbolColor === 'string' ? options.symbolColor : DESKTOP_WIN_SYMBOL_COLOR
        const height = typeof options.height === 'number' && Number.isFinite(options.height) ? options.height : DESKTOP_TITLEBAR_HEIGHT
        owner.setTitleBarOverlay?.({ color, symbolColor, height })
      })

      ipcMain.handle('ludens-pet:snapshot', event => {
        if (!trusted(event)) throw new Error('Unauthorized pet access')
        return snapshot
      })
      ipcMain.handle('ludens-pet:open-dashboard', async event => {
        if (!trusted(event)) throw new Error('Unauthorized pet access')
        openDetails(snapshot.dashboardUrl)
        showOwner()
      })
      owner.webContents.on('did-finish-load', () => {
        owner?.webContents.send('ludens-pet:snapshot', snapshot)
        publishWindowState()
      })
      source = new PetSessionCoordinator({ dashboardUrl: dashboard.href, onTargetChanged: () => {
        if (source) pet.configureActivity(source)
      }, onSnapshot: value => {
        snapshot = value
        if (owner && !owner.isDestroyed()) owner.webContents.send('ludens-pet:snapshot', value)
      } })
      pet.configureActivity(source)
      void source.start(workspace)
      tray = new Tray(createLudensTrayIcon(publicAssets, nativeTheme.shouldUseDarkColors))
      tray.setToolTip('Ludens')
      const syncTrayTheme = () => {
        if (!quitting && tray && !tray.isDestroyed()) {
          tray.setImage(createLudensTrayIcon(publicAssets, nativeTheme.shouldUseDarkColors))
        }
      }
      nativeTheme.on('updated', syncTrayTheme)
      app.on('before-quit', () => nativeTheme.off('updated', syncTrayTheme))
      tray.on('click', () => showOwner())
      tray.on('right-click', () => Menu.buildFromTemplate([
        { label: pet.copy().open, click: showOwner },
        ...pet.trayMenuItems(),
        { type: 'separator' },
        { label: pet.copy().quit, click: () => app.quit() },
      ]).popup())
      function updateApplicationMenu() {
        if (process.platform !== 'darwin') {
          Menu.setApplicationMenu(null)
          owner?.removeMenu()
          return
        }
        Menu.setApplicationMenu(Menu.buildFromTemplate([
          {
            label: 'Ludens',
            submenu: [
              { label: companion.copy().open, click: showOwner },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
          { role: 'editMenu' },
          {
            label: 'View',
            submenu: [
              { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: () => sendWindowCommand('toggle-sidebar') },
              { label: 'Quick Switcher', accelerator: 'CmdOrCtrl+K', click: () => sendWindowCommand('quick-switcher') },
              { type: 'separator' },
              { label: 'Back', accelerator: 'Cmd+[', click: () => sendWindowCommand('navigate-back') },
              { label: 'Forward', accelerator: 'Cmd+]', click: () => sendWindowCommand('navigate-forward') },
              { type: 'separator' },
              { label: 'Reload', accelerator: 'Cmd+R', click: () => owner?.webContents.reload() },
              { role: 'togglefullscreen' },
            ],
          },
          { role: 'windowMenu' },
        ]))
      }
      updateApplicationMenu()
      const loadDashboard = async () => {
        if (loadingDashboard || dashboardReady || quitting || !owner || owner.isDestroyed() || owner.webContents.isLoadingMainFrame()) return
        loadingDashboard = true
        try {
          await owner.loadURL(dashboardTarget)
          dashboardReady = true
        } catch (error) {
          const failure = error as { code?: string; errno?: number }
          if (failure.code === 'ERR_ABORTED' || failure.errno === -3) return
          await showOfflineWaitingPage()
        } finally { loadingDashboard = false }
      }
      retryDashboard = () => { void loadDashboard() }
      dashboardTimer = setInterval(retryDashboard, 5_000)
      await loadDashboard()
      if (values['show-window'] || !workspace) showOwner()
      console.log(`[ludens-pet] dashboard=${dashboard.origin} profile=${app.getPath('userData')}`)
    }).catch(error => { console.error(error); app.exit(1) })
  }
}
