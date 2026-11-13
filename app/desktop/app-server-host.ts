import { spawn } from 'node:child_process'
import type { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface WritablePipeLike {
  end(): void
  destroy?(): void
  on?(event: string, listener: (...args: unknown[]) => void): unknown
  readonly writableEnded?: boolean
  readonly destroyed?: boolean
}

export interface SpawnedProcessLike extends EventEmitter {
  readonly pid?: number
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  readonly stdin: WritablePipeLike | null
  readonly stdout: NodeJS.ReadableStream | null
  readonly stderr: NodeJS.ReadableStream | null
  kill(signal?: NodeJS.Signals | number): boolean
}

export interface SpawnOptionsLike {
  cwd?: string
  env?: NodeJS.ProcessEnv
  stdio?: ['pipe', 'pipe', 'pipe'] | 'ignore'
  windowsHide?: boolean
}

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsLike,
) => SpawnedProcessLike

export interface StartedAppServer {
  url: string
  origin: string
  href: string
  port: number
  pid?: number
}

export interface PathResolutionOptions {
  here?: string
  resourcesPath?: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  homeDir?: string
  exists?: (path: string) => boolean
}

export interface AppServerLaunchSpec {
  command: string
  args: string[]
  staticDir: string
}

export interface AppServerHostOptions extends PathResolutionOptions {
  staticDir?: string
  command?: string
  args?: string[]
  startupTimeoutMs?: number
  shutdownTimeoutMs?: number
  spawnImpl?: SpawnLike
  fetchImpl?: typeof fetch
}

const DEFAULT_HERE = dirname(fileURLToPath(import.meta.url))
const MAX_STDERR_CHARS = 8_192

export function resolveStaticDir(options: PathResolutionOptions = {}): string {
  const here = options.here ?? DEFAULT_HERE
  const exists = options.exists ?? existsSync
  const envDir = options.env?.LUDENS_STATIC_DIR?.trim()
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

export function resolveAppServerLaunch(
  options: PathResolutionOptions & { staticDir?: string } = {},
): AppServerLaunchSpec {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const exists = options.exists ?? existsSync
  const staticDir = options.staticDir ?? resolveStaticDir(options)
  const serverFlags = [
    'app-server',
    '--port',
    '0',
    '--parent-watchdog',
    '--static-dir',
    staticDir,
  ]

  if (env.LUDENS_APP_SERVER_BIN?.trim()) {
    return {
      command: env.LUDENS_APP_SERVER_BIN.trim(),
      args: serverFlags,
      staticDir,
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
        command: packagedBinary,
        args: serverFlags,
        staticDir,
      }
    }
  }

  const bun = resolveBunExecutable(options)
  const coreEntry = resolveRepoCoreEntry(options)
  return {
    command: bun,
    args: [coreEntry, ...serverFlags],
    staticDir,
  }
}

function isProcessExited(child: SpawnedProcessLike): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

function validateHandshakeUrl(rawUrl: string, rawPort: unknown): StartedAppServer {
  const parsed = new URL(rawUrl)
  if (
    parsed.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error(`Invalid app-server handshake URL: ${rawUrl}`)
  }
  const port = typeof rawPort === 'number' && Number.isInteger(rawPort) && rawPort > 0
    ? rawPort
    : Number(parsed.port)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid app-server handshake port in URL: ${rawUrl}`)
  }
  return {
    url: parsed.origin,
    origin: parsed.origin,
    href: parsed.href,
    port,
  }
}

export class AppServerHost {
  private readonly options: AppServerHostOptions
  private readonly spawnImpl: SpawnLike
  private readonly fetchImpl: typeof fetch
  private readonly platform: NodeJS.Platform
  private readonly startupTimeoutMs: number
  private readonly shutdownTimeoutMs: number

  private child: SpawnedProcessLike | undefined
  private serverInfo: StartedAppServer | undefined
  private startPromise: Promise<StartedAppServer> | undefined
  private stopPromise: Promise<void> | undefined
  private exitPromise: Promise<void> | undefined
  private stderrBuffer = ''

  constructor(options: AppServerHostOptions = {}) {
    this.options = options
    this.spawnImpl = options.spawnImpl ?? ((command, args, spawnOptions) => spawn(command, [...args], spawnOptions) as unknown as SpawnedProcessLike)
    this.fetchImpl = options.fetchImpl ?? fetch
    this.platform = options.platform ?? process.platform
    this.startupTimeoutMs = options.startupTimeoutMs ?? 15_000
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 8_000
  }

  current(): StartedAppServer | undefined {
    return this.serverInfo
  }

  start(): Promise<StartedAppServer> {
    if (this.stopPromise) {
      return Promise.reject(new Error('AppServerHost is stopping'))
    }
    this.startPromise ??= this.performStart()
    return this.startPromise
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.performStop()
    return this.stopPromise
  }

  private async performStart(): Promise<StartedAppServer> {
    const exists = this.options.exists ?? existsSync
    const launch = this.options.command
      ? {
          command: this.options.command,
          args: this.options.args ?? [],
          staticDir: this.options.staticDir ?? resolveStaticDir(this.options),
        }
      : resolveAppServerLaunch(this.options)

    if (
      !this.options.command &&
      launch.args[0]?.endsWith('core/src/cli/main.ts') &&
      !exists(launch.args[0])
    ) {
      throw new Error(
        `Ludens app-server backend not found (missing packaged resources/bin/ludens and repo entry ${launch.args[0]}). Bundle resources/bin/ludens or set LUDENS_APP_SERVER_BIN.`,
      )
    }

    const child = this.spawnImpl(launch.command, launch.args, {
      env: this.options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child

    // Keep stdin open for the entire lifetime of the host so OS pipe closure
    // triggers --parent-watchdog immediately if Electron crashes or is SIGKILL'd.
    child.stdin?.on?.('error', () => {})

    this.exitPromise = new Promise<void>(resolveExit => {
      if (isProcessExited(child)) {
        resolveExit()
        return
      }
      const done = () => resolveExit()
      child.once('exit', done)
      child.once('error', done)
    })

    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      this.stderrBuffer = (this.stderrBuffer + text).slice(-MAX_STDERR_CHARS)
    })

    return await new Promise<StartedAppServer>((resolveReady, rejectReady) => {
      let stdoutBuffer = ''
      let settled = false

      const formatFailure = (reason: string): Error => {
        const stderr = this.stderrBuffer.trim()
        return new Error(stderr ? `${reason}\n${stderr}` : reason)
      }

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        cleanupStartupListeners()
        void this.stop().catch(() => {})
        rejectReady(
          formatFailure(`Timed out waiting for ludens app-server ready handshake (${this.startupTimeoutMs}ms)`),
        )
      }, this.startupTimeoutMs)

      const onError = (error: unknown) => {
        if (settled) return
        settled = true
        cleanupStartupListeners()
        const detail = error instanceof Error ? error.message : String(error)
        rejectReady(formatFailure(`Failed to spawn ludens app-server: ${detail}`))
      }

      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return
        settled = true
        cleanupStartupListeners()
        rejectReady(
          formatFailure(
            `ludens app-server exited before ready handshake (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
          ),
        )
      }

      const onStdout = (chunk: Buffer | string) => {
        if (settled) return
        stdoutBuffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        let newlineIndex = stdoutBuffer.indexOf('\n')
        while (newlineIndex !== -1) {
          const line = stdoutBuffer.slice(0, newlineIndex).trim()
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
          if (line) {
            let parsed: unknown
            try {
              parsed = JSON.parse(line)
            } catch {
              parsed = undefined
            }
            if (parsed && typeof parsed === 'object') {
              const record = parsed as Record<string, unknown>
              if (record.ready === true && typeof record.url === 'string') {
                try {
                  const validated = validateHandshakeUrl(record.url, record.port)
                  const info: StartedAppServer = {
                    ...validated,
                    pid: typeof record.pid === 'number' ? record.pid : child.pid,
                  }
                  settled = true
                  cleanupStartupListeners()
                  stdoutBuffer = ''
                  this.serverInfo = info
                  resolveReady(info)
                  return
                } catch (error) {
                  settled = true
                  cleanupStartupListeners()
                  void this.stop().catch(() => {})
                  rejectReady(
                    formatFailure(error instanceof Error ? error.message : String(error)),
                  )
                  return
                }
              }
            }
          }
          newlineIndex = stdoutBuffer.indexOf('\n')
        }
      }

      const cleanupStartupListeners = () => {
        clearTimeout(timer)
        child.off('error', onError)
        child.off('exit', onExit)
      }

      child.once('error', onError)
      child.once('exit', onExit)
      child.stdout?.on('data', onStdout)

      if (isProcessExited(child) && !settled) {
        onExit(child.exitCode, child.signalCode)
      }
    })
  }

  private async performStop(): Promise<void> {
    const child = this.child
    const serverInfo = this.serverInfo
    const exitPromise = this.exitPromise
    this.serverInfo = undefined

    if (!child) return

    const deadline = Date.now() + this.shutdownTimeoutMs

    if (serverInfo && !isProcessExited(child)) {
      const requestTimeoutMs = Math.max(250, Math.min(2_000, this.shutdownTimeoutMs))
      try {
        await this.fetchImpl(`${serverInfo.origin}/api/app-server/shutdown`, {
          method: 'POST',
          headers: { Origin: serverInfo.origin },
          signal: AbortSignal.timeout(requestTimeoutMs),
        })
      } catch {
        // Ignore network errors if app-server already began exiting.
      }
    }

    try {
      child.stdin?.end()
      child.stdin?.destroy?.()
    } catch {}

    // On Windows, child.kill('SIGTERM') invokes TerminateProcess immediately and
    // preempts graceful shutdown via /api/app-server/shutdown or stdin EOF.
    if (this.platform !== 'win32' && !isProcessExited(child)) {
      try {
        child.kill('SIGTERM')
      } catch {}
    }

    if (exitPromise && !isProcessExited(child)) {
      const remainingMs = Math.max(50, deadline - Date.now())
      await Promise.race([
        exitPromise,
        new Promise<void>(resolveTimer => setTimeout(resolveTimer, remainingMs)),
      ])
    }

    if (!isProcessExited(child)) {
      if (this.platform === 'win32' && typeof child.pid === 'number') {
        await new Promise<void>(resolveKill => {
          try {
            const killer = this.spawnImpl(
              'taskkill',
              ['/PID', String(child.pid), '/T', '/F'],
              { stdio: 'ignore', windowsHide: true },
            )
            if (isProcessExited(killer)) {
              resolveKill()
              return
            }
            const timer = setTimeout(() => {
              try {
                killer.kill()
              } catch {}
              resolveKill()
            }, 2_000)
            const done = () => {
              clearTimeout(timer)
              resolveKill()
            }
            killer.once('exit', done)
            killer.once('close', done)
            killer.once('error', done)
          } catch {
            resolveKill()
          }
        })
      }
      if (!isProcessExited(child)) {
        try {
          child.kill('SIGKILL')
        } catch {}
      }
      if (exitPromise) {
        await Promise.race([
          exitPromise,
          new Promise<void>(resolveTimer => setTimeout(resolveTimer, 500)),
        ])
      }
    }

    this.child = undefined
  }
}
