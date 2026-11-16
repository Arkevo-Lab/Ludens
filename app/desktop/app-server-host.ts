import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ensureLocalAppDaemon,
  probeAppDaemon,
  resolveAppServerSocketPath,
  type EnsureLocalAppDaemonResult,
} from '@ludens/core/daemon/app-daemon'
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
}

const DEFAULT_HERE = dirname(fileURLToPath(import.meta.url))

export function resolveStaticDir(options: PathResolutionOptions = {}): string {
  const here = options.here ?? DEFAULT_HERE
  const exists = options.exists ?? existsSync
  const envDir = (options.env ?? process.env).LUDENS_STATIC_DIR?.trim()
  if (envDir) return resolve(envDir)

  const candidates = [
    options.resourcesPath ? join(options.resourcesPath, 'out') : undefined,
    resolve(here, '../../out'),
    resolve(here, '../out'),
  ].filter((candidate): candidate is string => Boolean(candidate))

  for (const candidate of candidates) {
    if (exists(join(candidate, 'index.html'))) return candidate
  }
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate
  }
  return resolve(here, '../../out')
}

export function resolveBunExecutable(options: PathResolutionOptions = {}): string {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const home = options.homeDir ?? homedir()
  const exists = options.exists ?? existsSync

  if (env.LUDENS_BUN?.trim()) return env.LUDENS_BUN.trim()

  const binName = platform === 'win32' ? 'bun.exe' : 'bun'
  const sep = platform === 'win32' ? ';' : ':'
  const pathEntries = (env.PATH ?? '').split(sep).filter(Boolean)
  for (const dir of pathEntries) {
    const candidate = join(dir, binName)
    if (exists(candidate)) return candidate
  }

  const fallbacks = [
    join(home, '.bun', 'bin', binName),
    ...(platform === 'win32' ? [] : ['/opt/homebrew/bin/bun', '/usr/local/bin/bun']),
  ]
  for (const candidate of fallbacks) {
    if (exists(candidate)) return candidate
  }

  return binName
}

export function resolveRepoCoreEntry(options: PathResolutionOptions = {}): string {
  const here = options.here ?? DEFAULT_HERE
  const exists = options.exists ?? existsSync
  const candidates = [
    resolve(here, '../../../core/src/cli/main.ts'),
    resolve(here, '../../core/src/cli/main.ts'),
  ]
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate
  }
  return candidates[0]
}

export function resolveLudensHome(options: PathResolutionOptions & { home?: string } = {}): string {
  if (options.home) return resolve(options.home)
  const envHome = (options.env ?? process.env).LUDENS_HOME?.trim()
  if (envHome) {
    if (!isAbsolute(envHome)) {
      throw new Error('LUDENS_HOME must be an absolute directory')
    }
    return resolve(envHome)
  }
  return join(options.homeDir ?? homedir(), '.ludens')
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
  const env = options.env ?? process.env
  const exists = options.exists ?? existsSync
  const home = resolveLudensHome(options)
  const staticDir = options.staticDir ?? resolveStaticDir(options)
  const coreEntry = resolveRepoCoreEntry(options)
  const inferredRepo = exists(coreEntry)
    ? resolve(dirname(coreEntry), '../../..')
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

  if (env.LUDENS_APP_SERVER_BIN?.trim()) {
    return {
      home,
      staticDir,
      spawnCommand: {
        command: env.LUDENS_APP_SERVER_BIN.trim(),
        argsPrefix: [],
      },
      ...(repo ? { repo } : {}),
      ...(options.trustedOrigins ? { trustedOrigins: [...options.trustedOrigins] } : {}),
    }
  }

  if (options.resourcesPath) {
    const packagedBinary = join(
      options.resourcesPath,
      'bin',
      platform === 'win32' ? 'ludens.exe' : 'ludens',
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
  }

  const bun = resolveBunExecutable(options)
  return {
    home,
    staticDir,
    spawnCommand: {
      command: bun,
      argsPrefix: [coreEntry],
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
 * Reuses any existing daemon on `app-server.sock` and leaves the shared daemon running on Electron quit.
 */
export class AppServerHost {
  readonly home: string
  private readonly options: AppServerHostOptions
  private readonly startupTimeoutMs: number
  private readonly ensureDaemon: typeof ensureLocalAppDaemon
  private readonly probeDaemon: typeof probeAppDaemon

  private daemonInfo: StartedAppDaemon | undefined
  private startPromise: Promise<StartedAppDaemon> | undefined
  private stopped = false

  constructor(options: AppServerHostOptions = {}) {
    this.options = options
    this.home = resolveLudensHome(options)
    this.startupTimeoutMs = options.startupTimeoutMs ?? 15_000
    this.ensureDaemon = options.ensureDaemon ?? ensureLocalAppDaemon
    this.probeDaemon = options.probeDaemon ?? probeAppDaemon
  }

  current(): StartedAppDaemon | undefined {
    return this.daemonInfo
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
      this.daemonInfo = toStartedFromStatus(status)
      return this.daemonInfo
    }
    this.daemonInfo = undefined
    return this.start()
  }

  probeStatus(timeoutMs = 1_200): Promise<DaemonStatusResult | null> {
    return this.probeDaemon(this.home, {
      timeoutMs,
      socketPath: this.daemonInfo?.socketPath,
    })
  }

  /** Releases host tracking without stopping the shared background daemon. */
  async stop(): Promise<void> {
    this.stopped = true
    this.daemonInfo = undefined
  }

  private async performStart(): Promise<StartedAppDaemon> {
    const launch = resolveDaemonLaunch({ ...this.options, home: this.home })
    const result = await this.ensureDaemon({
      home: launch.home,
      repo: launch.repo,
      wsListen: null,
      staticDir: launch.staticDir,
      trustedOrigins: launch.trustedOrigins,
      spawnCommand: launch.spawnCommand,
      timeoutMs: this.startupTimeoutMs,
    })
    const started = toStartedDaemon(result, this.home)
    if (!this.stopped) {
      this.daemonInfo = started
    }
    return started
  }
}
