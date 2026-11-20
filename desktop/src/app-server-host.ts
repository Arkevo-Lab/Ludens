import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, posix, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ensureLocalAppDaemon,
  probeAppDaemon,
  resolveAppServerSocketPath,
  stopLocalAppDaemon,
  type EnsureLocalAppDaemonResult,
} from '@ludens/server/daemon/app-daemon'
import type { DaemonStatusResult } from '@ludens/protocol/app-rpc'

export interface PathResolutionOptions {
  here?: string
  resourcesPath?: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  homeDir?: string
  exists?: (path: string) => boolean
}

export interface SpawnCommandSpec {
  command: string
  argsPrefix: string[]
}

export interface DaemonLaunchSpec {
  home: string
  staticDir: string
  spawnCommand: SpawnCommandSpec
  repo?: string
  trustedOrigins?: string[]
}

export interface StartedAppDaemon {
  pid: number
  home: string
  socketPath: string
  wsUrl: string | null
  authMode: 'none' | 'token'
  started: boolean
  startedAt: string
  activeCores: string[]
}

export interface AppServerHostOptions extends PathResolutionOptions {
  home?: string
  staticDir?: string
  repo?: string
  trustedOrigins?: string[]
  spawnCommand?: SpawnCommandSpec
  startupTimeoutMs?: number
  ensureDaemon?: typeof ensureLocalAppDaemon
  probeDaemon?: typeof probeAppDaemon
  stopDaemon?: typeof stopLocalAppDaemon
}

const DEFAULT_HERE = dirname(fileURLToPath(import.meta.url))

function pathApi(platform: NodeJS.Platform = process.platform) {
  return platform === 'win32' ? win32 : posix
}

export function resolveStaticDir(options: PathResolutionOptions = {}): string {
  const pathMod = pathApi(options.platform)
  const here = options.here ?? DEFAULT_HERE
  const exists = options.exists ?? existsSync
  const envDir = (options.env ?? process.env).LUDENS_STATIC_DIR?.trim()
  if (envDir) return pathMod.resolve(envDir)

  const candidates = [
    options.resourcesPath ? pathMod.join(options.resourcesPath, 'client') : undefined,
    pathMod.resolve(here, '../../../client/dist'),
    pathMod.resolve(here, '../../client/dist'),
    pathMod.resolve(here, '../client/dist'),
  ].filter((candidate): candidate is string => Boolean(candidate))

  for (const candidate of candidates) {
    if (exists(pathMod.join(candidate, 'index.html'))) return candidate
  }
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate
  }
  return pathMod.resolve(here, '../../../client/dist')
}

export function resolveBunExecutable(options: PathResolutionOptions = {}): string {
  const platform = options.platform ?? process.platform
  const pathMod = pathApi(platform)
  const env = options.env ?? process.env
  const home = options.homeDir ?? homedir()
  const exists = options.exists ?? existsSync

  if (env.LUDENS_BUN?.trim()) return env.LUDENS_BUN.trim()

  const binName = platform === 'win32' ? 'bun.exe' : 'bun'
  const sep = platform === 'win32' ? ';' : ':'
  const pathEntries = (env.PATH ?? '').split(sep).filter(Boolean)
  for (const dir of pathEntries) {
    const candidate = pathMod.join(dir, binName)
    if (exists(candidate)) return candidate
  }

  const fallbacks = [
    pathMod.join(home, '.bun', 'bin', binName),
    ...(platform === 'win32' ? [] : ['/opt/homebrew/bin/bun', '/usr/local/bin/bun']),
  ]
  for (const candidate of fallbacks) {
    if (exists(candidate)) return candidate
  }

  return binName
}

export function resolveDocsDir(options: PathResolutionOptions = {}): string {
  const pathMod = pathApi(options.platform)
  const here = options.here ?? DEFAULT_HERE
  const exists = options.exists ?? existsSync
  const envDir = (options.env ?? process.env).LUDENS_DOCS_DIR?.trim()
  if (envDir) return pathMod.resolve(envDir)

  const candidates = [
    options.resourcesPath ? pathMod.join(options.resourcesPath, 'docs') : undefined,
    pathMod.resolve(here, '../../../docs'),
    pathMod.resolve(here, '../../docs'),
  ].filter((candidate): candidate is string => Boolean(candidate))

  for (const candidate of candidates) {
    if (exists(candidate)) return candidate
  }
  return options.resourcesPath
    ? pathMod.join(options.resourcesPath, 'docs')
    : pathMod.resolve(here, '../../../docs')
}

export function resolveRepoServerEntry(options: PathResolutionOptions = {}): string {
  const pathMod = pathApi(options.platform)
  const here = options.here ?? DEFAULT_HERE
  const exists = options.exists ?? existsSync
  const candidates = [
    options.resourcesPath ? pathMod.join(options.resourcesPath, 'server', 'main.js') : undefined,
    options.resourcesPath ? pathMod.join(options.resourcesPath, 'server', 'src', 'cli', 'main.ts') : undefined,
    pathMod.resolve(here, '../../../server/src/cli/main.ts'),
    pathMod.resolve(here, '../../server/src/cli/main.ts'),
  ].filter((candidate): candidate is string => Boolean(candidate))
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate
  }
  return candidates[0]
}

export function resolveLudensHome(options: PathResolutionOptions & { home?: string } = {}): string {
  const pathMod = pathApi(options.platform)
  if (options.home) return pathMod.resolve(options.home)
  const envHome = (options.env ?? process.env).LUDENS_HOME?.trim()
  if (envHome) {
    if (!pathMod.isAbsolute(envHome)) {
      throw new Error('LUDENS_HOME must be an absolute directory')
    }
    return pathMod.resolve(envHome)
  }
  return pathMod.join(options.homeDir ?? homedir(), '.ludens')
}

export function resolveDaemonLaunch(
  options: PathResolutionOptions & {
    home?: string
    staticDir?: string
    repo?: string
    trustedOrigins?: string[]
    spawnCommand?: SpawnCommandSpec
  } = {},
): DaemonLaunchSpec {
  const platform = options.platform ?? process.platform
  const pathMod = pathApi(platform)
  const env = options.env ?? process.env
  const exists = options.exists ?? existsSync
  const home = resolveLudensHome(options)
  const staticDir = options.staticDir ?? resolveStaticDir(options)
  const serverEntry = resolveRepoServerEntry(options)
  const hasPackagedResourcesServer = Boolean(
    options.resourcesPath &&
      (exists(pathMod.join(options.resourcesPath, 'server', 'main.js')) ||
        exists(pathMod.join(options.resourcesPath, 'server', 'package.json'))),
  )
  const inferredRepo = hasPackagedResourcesServer
    ? options.resourcesPath
    : exists(serverEntry)
      ? pathMod.basename(serverEntry) === 'main.js'
        ? pathMod.resolve(pathMod.dirname(serverEntry), '..')
        : pathMod.resolve(pathMod.dirname(serverEntry), '../../..')
      : options.resourcesPath
  const repo = options.repo ?? inferredRepo

  if (options.spawnCommand) {
    return {
      home,
      staticDir,
      spawnCommand: {
        command: options.spawnCommand.command,
        argsPrefix: [...options.spawnCommand.argsPrefix],
      },
      ...(repo ? { repo } : {}),
      ...(options.trustedOrigins ? { trustedOrigins: [...options.trustedOrigins] } : {}),
    }
  }

  const explicitServerBin = env.LUDENS_APP_SERVER_BIN?.trim() || env.LUDENS_SERVER_BIN?.trim()
  if (explicitServerBin) {
    return {
      home,
      staticDir,
      spawnCommand: {
        command: explicitServerBin,
        argsPrefix: [],
      },
      ...(repo ? { repo } : {}),
      ...(options.trustedOrigins ? { trustedOrigins: [...options.trustedOrigins] } : {}),
    }
  }

  if (options.resourcesPath) {
    const packagedBinary = pathMod.join(
      options.resourcesPath,
      'bin',
      platform === 'win32' ? 'ludens-server.exe' : 'ludens-server',
    )
    if (exists(packagedBinary)) {
      return {
        home,
        staticDir,
        spawnCommand: {
          command: packagedBinary,
          argsPrefix: [],
        },
        ...(repo ? { repo } : {}),
        ...(options.trustedOrigins ? { trustedOrigins: [...options.trustedOrigins] } : {}),
      }
    }
    const packagedBundleEntry = pathMod.join(options.resourcesPath, 'server', 'main.js')
    if (exists(packagedBundleEntry)) {
      const bun = resolveBunExecutable(options)
      return {
        home,
        staticDir,
        spawnCommand: {
          command: bun,
          argsPrefix: [packagedBundleEntry],
        },
        repo: options.repo ?? options.resourcesPath,
        ...(options.trustedOrigins ? { trustedOrigins: [...options.trustedOrigins] } : {}),
      }
    }
    const packagedServerEntry = pathMod.join(options.resourcesPath, 'server', 'src', 'cli', 'main.ts')
    if (exists(packagedServerEntry)) {
      const bun = resolveBunExecutable(options)
      return {
        home,
        staticDir,
        spawnCommand: {
          command: bun,
          argsPrefix: [packagedServerEntry],
        },
        repo: options.repo ?? options.resourcesPath,
        ...(options.trustedOrigins ? { trustedOrigins: [...options.trustedOrigins] } : {}),
      }
    }
  }

  const bun = resolveBunExecutable(options)
  return {
    home,
    staticDir,
    spawnCommand: {
      command: bun,
      argsPrefix: [serverEntry],
    },
    ...(repo ? { repo } : {}),
    ...(options.trustedOrigins ? { trustedOrigins: [...options.trustedOrigins] } : {}),
  }
}

function toStartedDaemon(
  result: EnsureLocalAppDaemonResult,
  fallbackHome: string,
): StartedAppDaemon {
  const home = result.runtime.home || result.status.home || fallbackHome
  const socketPath = result.runtime.socketPath
    || result.status.socketPath
    || resolveAppServerSocketPath(home)
  if (!socketPath) {
    throw new Error('Daemon started without a UDS socket path')
  }
  return {
    pid: result.runtime.pid || result.status.pid,
    home,
    socketPath,
    wsUrl: result.runtime.wsUrl ?? result.status.wsUrl ?? null,
    authMode: result.runtime.authMode,
    started: result.started,
    startedAt: result.runtime.startedAt || result.status.startedAt || new Date().toISOString(),
    activeCores: [...result.status.activeCores],
  }
}

function toStartedFromStatus(status: DaemonStatusResult): StartedAppDaemon {
  const socketPath = status.socketPath || resolveAppServerSocketPath(status.home)
  return {
    pid: status.pid,
    home: status.home,
    socketPath,
    wsUrl: status.wsUrl ?? null,
    authMode: status.authMode,
    started: false,
    startedAt: status.startedAt ?? new Date().toISOString(),
    activeCores: [...status.activeCores],
  }
}

/**
 * Ensures the singleton zero-port UDS `app-server` daemon is running for `LUDENS_HOME`.
 * Reuses any existing daemon on `app-server.sock`. When this Electron host spawned a
 * local UDS-only daemon itself, `stop({ stopOwnedDaemon: true })` reclaims it on quit
 * as long as it has no active Cores and no external TCP/WS listener.
 */
export class AppServerHost {
  readonly home: string
  private readonly options: AppServerHostOptions
  private readonly startupTimeoutMs: number
  private readonly ensureDaemon: typeof ensureLocalAppDaemon
  private readonly probeDaemon: typeof probeAppDaemon
  private readonly stopDaemon: typeof stopLocalAppDaemon

  private daemonInfo: StartedAppDaemon | undefined
  private ownedDaemonPid: number | null = null
  private startPromise: Promise<StartedAppDaemon> | undefined
  private stopped = false

  constructor(options: AppServerHostOptions = {}) {
    this.options = options
    this.home = resolveLudensHome(options)
    this.startupTimeoutMs = options.startupTimeoutMs ?? 15_000
    this.ensureDaemon = options.ensureDaemon ?? ensureLocalAppDaemon
    this.probeDaemon = options.probeDaemon ?? probeAppDaemon
    this.stopDaemon = options.stopDaemon ?? stopLocalAppDaemon
  }

  current(): StartedAppDaemon | undefined {
    return this.daemonInfo
  }

  isOwnedDaemon(): boolean {
    return this.ownedDaemonPid !== null
  }

  socketPath(): string {
    return this.daemonInfo?.socketPath ?? resolveAppServerSocketPath(this.home)
  }

  start(): Promise<StartedAppDaemon> {
    if (this.stopped) {
      return Promise.reject(new Error('AppServerHost is stopped'))
    }
    if (this.daemonInfo) {
      return Promise.resolve(this.daemonInfo)
    }
    this.startPromise ??= this.performStart().finally(() => {
      this.startPromise = undefined
    })
    return this.startPromise
  }

  /** Re-verifies UDS daemon reachability and respawns via singleton lock if offline. */
  async ensureOnline(timeoutMs = 1_200): Promise<StartedAppDaemon> {
    if (this.stopped) {
      throw new Error('AppServerHost is stopped')
    }
    const status = await this.probeStatus(timeoutMs)
    if (status) {
      const stillOwned = this.ownedDaemonPid !== null && status.pid === this.ownedDaemonPid && !status.wsUrl
      this.ownedDaemonPid = stillOwned ? status.pid : null
      this.daemonInfo = { ...toStartedFromStatus(status), started: stillOwned }
      return this.daemonInfo
    }
    this.daemonInfo = undefined
    this.ownedDaemonPid = null
    return this.start()
  }

  probeStatus(timeoutMs = 1_200): Promise<DaemonStatusResult | null> {
    return this.probeDaemon(this.home, {
      timeoutMs,
      socketPath: this.daemonInfo?.socketPath,
    })
  }

  /**
   * Releases host tracking. When `stopOwnedDaemon` is true and this host spawned the
   * current local UDS-only daemon (no external TCP/WS listener and 0 active Cores),
   * cleanly shuts down that owned daemon via `daemon/shutdown`.
   */
  async stop(options: { stopOwnedDaemon?: boolean } = {}): Promise<void> {
    const ownedPid = this.ownedDaemonPid
    const socketPath = this.socketPath()
    this.stopped = true
    this.daemonInfo = undefined
    this.ownedDaemonPid = null

    if (!options.stopOwnedDaemon || ownedPid === null) {
      return
    }
    const status = await this.probeDaemon(this.home, { timeoutMs: 1_200, socketPath }).catch(() => null)
    if (!status || status.pid !== ownedPid || status.wsUrl || status.activeCores.length > 0) {
      return
    }
    await this.stopDaemon(this.home, { stopCores: false, timeoutMs: 3_000 }).catch(() => {})
  }

  private async performStart(): Promise<StartedAppDaemon> {
    const launch = resolveDaemonLaunch({ ...this.options, home: this.home })
    const previousRepoRoot = process.env.LUDENS_REPO_ROOT
    const injectedRepoRoot = Boolean(launch.repo && !previousRepoRoot)
    if (injectedRepoRoot && launch.repo) {
      process.env.LUDENS_REPO_ROOT = launch.repo
    }
    let result: EnsureLocalAppDaemonResult
    try {
      result = await this.ensureDaemon({
        home: launch.home,
        repo: launch.repo,
        wsListen: null,
        staticDir: launch.staticDir,
        trustedOrigins: launch.trustedOrigins,
        spawnCommand: launch.spawnCommand,
        timeoutMs: this.startupTimeoutMs,
      })
    } finally {
      if (injectedRepoRoot) {
        if (previousRepoRoot === undefined) delete process.env.LUDENS_REPO_ROOT
        else process.env.LUDENS_REPO_ROOT = previousRepoRoot
      }
    }
    const started = toStartedDaemon(result, this.home)
    if (!this.stopped) {
      this.daemonInfo = started
      this.ownedDaemonPid = started.started && started.pid > 0 && !started.wsUrl ? started.pid : null
    }
    return started
  }
}
