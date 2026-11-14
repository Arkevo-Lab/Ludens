import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  protocol,
  screen,
  session,
  systemPreferences,
  Tray,
} from 'electron'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { NodeUdsRpcClient } from '@ludens/core/cli/app-rpc-client'
import { ludensHome, registerWorkspace } from '@ludens/protocol/ludens'
import type { DesktopWindowCommand, DesktopWindowState } from '../lib/desktop.js'
import { AppServerHost, resolveStaticDir } from './app-server-host.js'
import { createCompanion } from './companion.js'
import {
  LUDENS_APP_ENTRY_URL,
  LUDENS_APP_ORIGIN,
  registerLudensPrivilegedSchemes,
  registerLudensProtocols,
} from './custom-protocols.js'
import { dashboardSender, isDashboardUrl, originKey } from './dashboard-window.js'
import type { LudensPetSnapshot } from './ludens-source.js'
import { extractProjectFromUrl, PetSessionCoordinator } from './pet-session.js'
import { ActiveCoreQuitGuard, mapDialogButtonToQuitAction } from './quit-guard.js'
import { DesktopUdsRpcRelay } from './rpc-bridge.js'
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

const rawArgs = process.argv
  .slice(app.isPackaged ? 1 : 2)
  .filter(arg => !arg.startsWith('-psn_'))

const { values } = parseArgs({
  args: rawArgs,
  options: {
    workspace: { type: 'string' },
    server: { type: 'string' },
    dashboard: { type: 'string' },
    profile: { type: 'string' },
    background: { type: 'boolean' },
    'show-window': { type: 'boolean' },
    help: { type: 'boolean' },
  },
})

if (values.help) {
  console.log(
    [
      'Ludens — Desktop Console & Multimodal Harness Host',
      '',
      '--workspace PATH   Initial workspace to register/select on launch',
      '--server URL       Load an explicit local dev server URL instead of ludens-app://console/',
      '--dashboard URL    Alias for --server',
      '--profile PATH     Custom desktop profile directory (default: ~/.ludens/desktop/profile)',
      '--background       Start hidden in the system tray + Desktop Pet without opening the main window',
      '--show-window      Open the main window on launch (default unless --background is passed)',
      '--help             Show this help message',
      '',
      'By default, Ludens ensures a zero-port UDS `ludens app-server` daemon for the active LUDENS_HOME and serves `app/out` via `ludens-app://console/`.',
      'Pass --server URL only to override with an explicit external dev server. Closing the window hides to Tray + Desktop Pet; Cmd+Q checks active Cores before quitting managed workspace services.',
    ].join('\n'),
  )
  app.exit(0)
} else {
  const initialWorkspace = values.workspace ?? process.env.LUDENS_WORKSPACE
  const workspace = initialWorkspace ? realpathSync(resolve(initialWorkspace)) : undefined
  const explicitDevArg =
    values.server ??
    values.dashboard ??
    process.env.LUDENS_APP_DEV_URL?.trim() ??
    process.env.LUDENS_DEV_URL?.trim()

  let externalDevServer: URL | undefined
  if (explicitDevArg) {
    externalDevServer = new URL(explicitDevArg)
    if (
      (externalDevServer.protocol !== 'http:' && externalDevServer.protocol !== 'https:') ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(externalDevServer.hostname) ||
      externalDevServer.username ||
      externalDevServer.password
    ) {
      throw new Error('--server / LUDENS_APP_DEV_URL must be a local HTTP(S) URL')
    }
  }

  const serverOrigin = externalDevServer
    ? (originKey(externalDevServer.href) ?? externalDevServer.origin)
    : LUDENS_APP_ORIGIN
  const serverHref = externalDevServer ? externalDevServer.href : LUDENS_APP_ENTRY_URL

  // Custom schemes MUST be registered synchronously before `app.whenReady()`.
  registerLudensPrivilegedSchemes(protocol)

  const here = dirname(fileURLToPath(import.meta.url))
  nativeTheme.themeSource = 'dark'
  if (process.platform === 'win32') app.setAppUserModelId('dev.ludens.app')
  app.setName('Ludens')
  app.setPath('userData', resolve(values.profile ?? join(ludensHome(), 'desktop', 'profile')))
  mkdirSync(app.getPath('userData'), { recursive: true })

  if (!app.requestSingleInstanceLock()) {
    app.exit(0)
  } else {
    const appServerHost = new AppServerHost({
      here,
      resourcesPath: process.resourcesPath,
      env: process.env,
    })
    const daemonReadyPromise = appServerHost.start()
    // Prevent unhandled rejection noise before app.whenReady() handles daemon readiness.
    void daemonReadyPromise.catch(() => {})

    let quitting = false
    let owner: BrowserWindow | undefined
    let tray: Tray | undefined
    let source: PetSessionCoordinator | undefined
    let rpcRelay: DesktopUdsRpcRelay | undefined
    let mainMediaClient: NodeUdsRpcClient | undefined
    let mainMediaSocketPath: string | undefined
    let retryDashboard: (() => void) | undefined
    let dashboardTimer: ReturnType<typeof setInterval> | undefined
    let saveStateTimer: ReturnType<typeof setTimeout> | undefined
    let syncTrayTheme: (() => void) | undefined
    let captureWindowState: (() => SavedWindowState | undefined) | undefined
    let appliedInitialPlacement = false

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

    const ensureMainMediaClient = async (): Promise<NodeUdsRpcClient> => {
      if (!appServerHost.current()) {
        await daemonReadyPromise.catch(() => {})
        if (!appServerHost.current()) {
          await appServerHost.ensureOnline()
        }
      }
      const socketPath = appServerHost.socketPath()
      if (!mainMediaClient || mainMediaSocketPath !== socketPath) {
        await mainMediaClient?.close().catch(() => {})
        mainMediaSocketPath = socketPath
        mainMediaClient = new NodeUdsRpcClient({ socketPath, connectTimeoutMs: 5_000 })
      }
      return mainMediaClient
    }

    const quitGuard = new ActiveCoreQuitGuard({
      getLocale: () => app.getLocale(),
      queryStatus: timeoutMs => appServerHost.probeStatus(timeoutMs),
      stopAllCores: async () => {
        const status = await appServerHost.probeStatus(1_200)
        const socketPath = status?.socketPath ?? appServerHost.socketPath()
        const client = new NodeUdsRpcClient({ socketPath, connectTimeoutMs: 1_500 })
        try {
          return await client.call('cores/stopAll', undefined, { timeoutMs: 8_000 })
        } finally {
          await client.close().catch(() => {})
        }
      },
      promptUser: async labels => {
        const parent = owner && !owner.isDestroyed() && owner.isVisible() ? owner : undefined
        const dialogOptions: Electron.MessageBoxOptions = {
          type: 'question',
          buttons: [labels.keepBackground, labels.stopAllAndQuit, labels.cancel],
          defaultId: 0,
          cancelId: 2,
          noLink: true,
          title: labels.title,
          message: labels.message,
          detail: labels.detail,
        }
        const result = parent
          ? await dialog.showMessageBox(parent, dialogOptions)
          : await dialog.showMessageBox(dialogOptions)
        return mapDialogButtonToQuitAction(result.response)
      },
      onConfirmQuit: async () => {
        quitting = true
        clearInterval(dashboardTimer)
        clearTimeout(saveStateTimer)
        if (syncTrayTheme) nativeTheme.off('updated', syncTrayTheme)
        const nextState = captureWindowState?.()
        if (nextState) {
          try {
            saveWindowStateSync(windowStatePath, nextState)
          } catch {}
        }
        source?.stop()
        rpcRelay?.dispose()
        await mainMediaClient?.close().catch(() => {})
        mainMediaClient = undefined
        await appServerHost.stop().catch(() => {})
      },
      triggerQuit: () => {
        app.quit()
      },
    })

    app.on('second-instance', showOwner)
    app.on('activate', showOwner)
    app.on('before-quit', event => {
      quitGuard.handleBeforeQuit(event)
    })
    app.on('window-all-closed', () => app.quit())

    void app.whenReady().then(async () => {
      const staticDir = resolveStaticDir({
        here,
        resourcesPath: process.resourcesPath,
        env: process.env,
      })

      registerLudensProtocols(session.defaultSession, {
        staticDir,
        resolveMedia: async (params, signal) => {
          const client = await ensureMainMediaClient()
          try {
            return await client.call('media/resolve', params, { signal, timeoutMs: 15_000 })
          } catch (error) {
            const err = error as NodeJS.ErrnoException
            if (
              !signal.aborted &&
              (err?.code === 'ENOENT' ||
                err?.code === 'ECONNREFUSED' ||
                err?.message?.includes('UDS'))
            ) {
              await appServerHost.ensureOnline()
              const recovered = await ensureMainMediaClient()
              return recovered.call('media/resolve', params, { signal, timeoutMs: 15_000 })
            }
            throw error
          }
        },
      })

      const primaryWorkArea = screen.getPrimaryDisplay().workArea
      const workAreas = [
        primaryWorkArea,
        ...screen.getAllDisplays()
          .map(display => display.workArea)
          .filter(
            area =>
              area.x !== primaryWorkArea.x ||
              area.y !== primaryWorkArea.y ||
              area.width !== primaryWorkArea.width ||
              area.height !== primaryWorkArea.height,
          ),
      ]
      persistedState = loadWindowState(windowStatePath, workAreas)

      const publicAssets = app.isPackaged && existsSync(join(process.resourcesPath, 'public'))
        ? join(process.resourcesPath, 'public')
        : existsSync(resolve(here, '../public/companion'))
          ? resolve(here, '../public')
          : resolve(here, '../../public')
      const appIcon = nativeImage.createFromPath(resolve(publicAssets, 'brand/ludens-app-icon.png'))
      if (!appIcon.isEmpty()) app.dock?.setIcon(appIcon)

      let initialProjectId: string | undefined
      if (workspace) {
        try {
          const registered = await registerWorkspace(workspace)
          initialProjectId = registered.id
        } catch {
          // Non-fatal if directory is not yet initialized; console can still open/import it.
        }
      }

      let snapshot: LudensPetSnapshot = {
        workspace: null,
        runId: null,
        epoch: null,
        phase: '请选择要跟随的工作区',
        intent: null,
        observationUrl: null,
        updatedAt: null,
        error: null,
        dashboardUrl: serverHref,
      }

      owner = new BrowserWindow(
        ownerBrowserWindowOptions({
          platform: process.platform,
          appIcon,
          preloadPath: join(here, 'preload.cjs'),
          bounds: persistedState,
        }),
      )
      owner.setMaxListeners(24)
      owner.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      const navigation = (event: Electron.Event, url: string) => {
        if (!isDashboardUrl(url, serverOrigin)) event.preventDefault()
      }
      owner.webContents.on('will-navigate', navigation)
      owner.webContents.on('will-redirect', navigation)

      const trusted = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) =>
        !!owner && dashboardSender(owner, serverOrigin, event)

      rpcRelay = new DesktopUdsRpcRelay({
        ipcMain,
        resolveSocketPath: async () => (await appServerHost.ensureOnline()).socketPath,
        isTrustedSender: trusted,
        getTargetWebContents: () => (owner && !owner.isDestroyed() ? owner.webContents : undefined),
        isTrustedWebContents: contents =>
          !!owner &&
          !owner.isDestroyed() &&
          contents === owner.webContents &&
          Boolean(contents.mainFrame && isDashboardUrl(contents.mainFrame.url, serverOrigin)),
      })
      rpcRelay.install()

      const initial = new URL(serverHref)
      if (initialProjectId) initial.searchParams.set('project', initialProjectId)
      initial.searchParams.set('view', 'live')
      let dashboardTarget = initial.href
      let loadingDashboard = false
      let dashboardReady = false

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
        if (owner && !owner.isDestroyed() && isDashboardUrl(owner.webContents.getURL(), serverOrigin)) {
          owner.webContents.send('ludens:window:state', currentWindowState())
        }
      }
      const sendWindowCommand = (command: DesktopWindowCommand) => {
        if (owner && !owner.isDestroyed() && isDashboardUrl(owner.webContents.getURL(), serverOrigin)) {
          owner.webContents.send('ludens:window:command', command)
        }
      }
      captureWindowState = (): SavedWindowState | undefined => {
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
          const next = captureWindowState?.()
          if (next) void saveWindowState(windowStatePath, next).catch(() => {})
        }, 250)
      }

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
      owner.on('maximize', () => {
        scheduleWindowStateSave()
        publishWindowState()
      })
      owner.on('unmaximize', () => {
        scheduleWindowStateSave()
        publishWindowState()
      })
      owner.on('enter-full-screen', () => {
        scheduleWindowStateSave()
        publishWindowState()
      })
      owner.on('leave-full-screen', () => {
        scheduleWindowStateSave()
        publishWindowState()
      })
      owner.on('focus', () => {
        syncWin32OverlayFocus()
        publishWindowState()
      })
      owner.on('blur', () => {
        syncWin32OverlayFocus()
        publishWindowState()
      })

      const rememberDashboard = (_event: Electron.Event, url: string) => {
        if (isDashboardUrl(url, serverOrigin)) {
          dashboardTarget = url
          source?.setFocusedProject(extractProjectFromUrl(url, serverOrigin))
        }
      }
      owner.webContents.on('did-navigate', (event, url, status) => {
        rememberDashboard(event, url)
        if (status > 0 && isDashboardUrl(url, serverOrigin)) dashboardReady = true
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
          dashboardOrigin: serverOrigin,
          retryUrl: dashboardTarget,
        })
        await owner.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(offline)}`).catch(() => {})
      }

      owner.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
        // Aborted/superseded navigation and subresources must not replace a healthy page.
        if (!isMainFrame || code === -3 || !isDashboardUrl(url, serverOrigin)) return
        dashboardTarget = url
        dashboardReady = false
        console.error(`[ludens] console load failed: ${description} (${code})`)
        if (!loadingDashboard && !quitting) {
          void showOfflineWaitingPage()
        }
      })
      owner.webContents.on('render-process-gone', (_event, details) => {
        dashboardReady = false
        console.error(`[ludens] console renderer exited: ${details.reason}`)
      })
      owner.on('close', event => {
        if (!quitting) {
          event.preventDefault()
          owner?.hide()
        }
      })

      const openDetails = (url: string) => {
        if (!owner || owner.isDestroyed() || !isDashboardUrl(url, serverOrigin)) return
        void owner.loadURL(url).catch(error => console.error('[ludens] console navigation failed:', error))
      }
      const companion = createCompanion(owner, { trustedOwner: trusted, openDetails }, () =>
        updateApplicationMenu(),
      )

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
        if (
          process.platform !== 'win32' ||
          !owner ||
          owner.isDestroyed() ||
          !rawOptions ||
          typeof rawOptions !== 'object'
        ) {
          return
        }
        const options = rawOptions as { color?: unknown; symbolColor?: unknown; height?: unknown }
        const color = typeof options.color === 'string' ? options.color : DESKTOP_BG_COLOR
        const symbolColor =
          typeof options.symbolColor === 'string' ? options.symbolColor : DESKTOP_WIN_SYMBOL_COLOR
        const height =
          typeof options.height === 'number' && Number.isFinite(options.height)
            ? options.height
            : DESKTOP_TITLEBAR_HEIGHT
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
        rpcRelay?.syncStatus()
      })

      tray = new Tray(createLudensTrayIcon(publicAssets, nativeTheme.shouldUseDarkColors))
      tray.setToolTip('Ludens')
      syncTrayTheme = () => {
        if (!quitting && tray && !tray.isDestroyed()) {
          tray.setImage(createLudensTrayIcon(publicAssets, nativeTheme.shouldUseDarkColors))
        }
      }
      nativeTheme.on('updated', syncTrayTheme)
      tray.on('click', () => showOwner())
      tray.on('right-click', () => {
        const openLabel = companion ? companion.copy().open : 'Open Ludens'
        const quitLabel = companion ? companion.copy().quit : 'Quit Ludens'
        Menu.buildFromTemplate([
          { label: openLabel, click: showOwner },
          ...(companion ? companion.trayMenuItems() : []),
          { type: 'separator' },
          { label: quitLabel, click: () => app.quit() },
        ]).popup()
      })

      function updateApplicationMenu() {
        if (process.platform !== 'darwin') {
          Menu.setApplicationMenu(null)
          owner?.removeMenu()
          return
        }
        const openLabel = companion ? companion.copy().open : 'Open Ludens'
        Menu.setApplicationMenu(
          Menu.buildFromTemplate([
            {
              label: 'Ludens',
              submenu: [
                { label: openLabel, click: showOwner },
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
                {
                  label: 'Toggle Sidebar',
                  accelerator: 'CmdOrCtrl+B',
                  click: () => sendWindowCommand('toggle-sidebar'),
                },
                {
                  label: 'Quick Switcher',
                  accelerator: 'CmdOrCtrl+K',
                  click: () => sendWindowCommand('quick-switcher'),
                },
                { type: 'separator' },
                {
                  label: 'Back',
                  accelerator: 'Cmd+[',
                  click: () => sendWindowCommand('navigate-back'),
                },
                {
                  label: 'Forward',
                  accelerator: 'Cmd+]',
                  click: () => sendWindowCommand('navigate-forward'),
                },
                { type: 'separator' },
                {
                  label: 'Reload',
                  accelerator: 'Cmd+R',
                  click: () => owner?.webContents.reload(),
                },
                { role: 'togglefullscreen' },
              ],
            },
            { role: 'windowMenu' },
          ]),
        )
      }
      updateApplicationMenu()

      const loadDashboard = async () => {
        if (
          loadingDashboard ||
          dashboardReady ||
          quitting ||
          !owner ||
          owner.isDestroyed() ||
          owner.webContents.isLoadingMainFrame()
        ) {
          return
        }
        loadingDashboard = true
        try {
          await owner.loadURL(dashboardTarget)
          dashboardReady = true
        } catch (error) {
          const failure = error as { code?: string; errno?: number }
          if (failure.code === 'ERR_ABORTED' || failure.errno === -3) return
          await showOfflineWaitingPage()
        } finally {
          loadingDashboard = false
        }
      }
      retryDashboard = () => {
        void loadDashboard()
      }
      dashboardTimer = setInterval(retryDashboard, 5_000)

      // Start loading the static SPA immediately while finishing UDS daemon startup.
      const loadPromise = loadDashboard()
      const shouldShowWindow = values['show-window'] ? true : !values.background
      if (shouldShowWindow) showOwner()

      const daemonInfo = await daemonReadyPromise
      void rpcRelay.start().catch(error => {
        console.error('[ludens] UDS RPC relay initial connection failed (will retry):', error)
      })

      source = new PetSessionCoordinator({
        dashboardUrl: serverHref,
        socketPath: daemonInfo.socketPath,
        onTargetChanged: () => {
          if (source && companion) companion.configureActivity(source)
        },
        onSnapshot: value => {
          snapshot = value
          if (owner && !owner.isDestroyed()) owner.webContents.send('ludens-pet:snapshot', value)
        },
      })
      if (companion) companion.configureActivity(source)
      source.setFocusedProject(extractProjectFromUrl(dashboardTarget, serverOrigin))
      void source.start(workspace)

      await loadPromise
      console.log(
        `[ludens] ui=${serverOrigin} uds=${daemonInfo.socketPath} pid=${daemonInfo.pid} profile=${app.getPath('userData')}`,
      )
    }).catch(async error => {
      console.error(error)
      rpcRelay?.dispose()
      await mainMediaClient?.close().catch(() => {})
      await appServerHost.stop().catch(() => {})
      app.exit(1)
    })
  }
}
