import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { format } from 'node:util'

const BROKEN_STDIO_CODES = new Set(['EIO', 'EPIPE', 'EBADF', 'ERR_STREAM_DESTROYED'])
const DEFAULT_MAX_LOG_BYTES = 2 * 1024 * 1024
const MAX_EARLY_LOG_ENTRIES = 64

export interface StdioStreamLike {
  write: (...args: any[]) => boolean
  on(event: 'error', listener: (error: unknown) => void): unknown
  off?(event: 'error', listener: (error: unknown) => void): unknown
  removeListener?(event: 'error', listener: (error: unknown) => void): unknown
  destroyed?: boolean
  writableEnded?: boolean
}

export interface StdioGuardHandle {
  isBroken: () => boolean
  dispose: () => void
}

export interface BoundedMainLogger {
  setLogDir: (dir: string) => void
  log: (level: string, message: string) => void
  getLogDir: () => string | null
}

export interface ProcessEventsLike {
  on(event: 'warning' | 'uncaughtException' | 'unhandledRejection', listener: (...args: any[]) => void): unknown
  off?(event: 'warning' | 'uncaughtException' | 'unhandledRejection', listener: (...args: any[]) => void): unknown
  removeListener?(event: 'warning' | 'uncaughtException' | 'unhandledRejection', listener: (...args: any[]) => void): unknown
}

export interface MainProcessSafetyOptions {
  isReady: () => boolean
  isQuitting: () => boolean
  forceExit: (code: number) => void
  maxLogBytes?: number
  stdout?: StdioStreamLike
  stderr?: StdioStreamLike
  console?: Pick<Console, 'warn' | 'error'>
  processEvents?: ProcessEventsLike
}

export interface MainProcessSafetyHandle {
  setLogDir: (dir: string) => void
  logger: BoundedMainLogger
  isStdoutBroken: () => boolean
  isStderrBroken: () => boolean
  dispose: () => void
}

/** True when an error reflects a closed, revoked, or destroyed stdio pipe/PTY fd. */
export function isBrokenStdioError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && BROKEN_STDIO_CODES.has(code)
}

/**
 * Guards a stdio stream against uncaught `'error'` events and synchronous write throws
 * (e.g. `EIO` after a parent terminal PTY closes), muting subsequent writes once broken.
 */
export function guardStdioStream(
  stream: StdioStreamLike,
  onBroken?: (error?: unknown) => void,
): StdioGuardHandle {
  const originalWrite = stream.write
  let broken = false
  let disposed = false

  const markBroken = (error?: unknown) => {
    if (broken || disposed) return
    broken = true
    // Replace write with a no-op so console.* and Node's internal process.emitWarning cannot throw EIO.
    stream.write = (() => true) as typeof stream.write
    try {
      onBroken?.(error)
    } catch {}
  }

  const onError = (error: unknown) => {
    if (isBrokenStdioError(error) || stream.destroyed || stream.writableEnded) {
      markBroken(error)
    }
  }

  stream.on('error', onError)

  if (stream.destroyed || stream.writableEnded) {
    markBroken()
  } else {
    stream.write = ((...args: unknown[]) => {
      if (broken || stream.destroyed || stream.writableEnded) {
        markBroken()
        return true
      }
      try {
        return originalWrite.apply(stream, args)
      } catch (error) {
        if (isBrokenStdioError(error) || stream.destroyed || stream.writableEnded) {
          markBroken(error)
          return false
        }
        throw error
      }
    }) as typeof stream.write
  }

  return {
    isBroken: () => broken,
    dispose: () => {
      if (disposed) return
      disposed = true
      if (stream.off) stream.off('error', onError)
      else stream.removeListener?.('error', onError)
      stream.write = originalWrite
    },
  }
}

/** Bounded rotating file logger that buffers up to 64 early entries before `setLogDir()` is called. */
export function createBoundedMainLogger(options?: { maxBytes?: number }): BoundedMainLogger {
  const maxBytes = options?.maxBytes && options.maxBytes > 0
    ? options.maxBytes
    : DEFAULT_MAX_LOG_BYTES
  let logDir: string | null = null
  let dirCreated = false
  const earlyBuffer: string[] = []

  const writeEntries = (entries: string[]) => {
    if (!logDir || entries.length === 0) return
    if (!dirCreated) {
      try {
        mkdirSync(logDir, { recursive: true })
        dirCreated = true
      } catch {
        return
      }
    }
    const logPath = join(logDir, 'main.log')
    const rotatedPath = join(logDir, 'main.log.1')
    for (const entry of entries) {
      let shouldRotate = false
      try {
        shouldRotate = statSync(logPath).size >= maxBytes
      } catch {
        // Missing main.log on first write is expected.
      }
      if (shouldRotate) {
        try {
          renameSync(logPath, rotatedPath)
        } catch {}
      }
      try {
        appendFileSync(logPath, entry, 'utf8')
      } catch {
        dirCreated = false
      }
    }
  }

  return {
    setLogDir(dir: string) {
      logDir = dir
      dirCreated = false
      try {
        mkdirSync(dir, { recursive: true })
        dirCreated = true
      } catch {
        return
      }
      if (earlyBuffer.length > 0) {
        const pending = earlyBuffer.splice(0)
        writeEntries(pending)
      }
    },
    log(level: string, message: string) {
      const normalized = message.endsWith('\n') ? message : `${message}\n`
      const line = `${new Date().toISOString()} [${level}] ${normalized}`
      if (!logDir) {
        if (earlyBuffer.length >= MAX_EARLY_LOG_ENTRIES) {
          earlyBuffer.shift()
        }
        earlyBuffer.push(line)
        return
      }
      writeEntries([line])
    },
    getLogDir() {
      return logDir
    },
  }
}

function formatLogArgs(args: unknown[]): string {
  try {
    return format(...args)
  } catch {
    return args
      .map(arg => {
        try {
          return String(arg)
        } catch {
          return '[unformattable]'
        }
      })
      .join(' ')
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`
  }
  try {
    return typeof error === 'string' ? error : format(error)
  } catch {
    return 'Unknown error'
  }
}

/**
 * Installs stdio stream guards, bounded main.log console mirroring, and process-level
 * warning/exception/rejection handlers so Electron cannot block on native crash dialogs or EIO loops.
 */
export function installMainProcessSafety(options: MainProcessSafetyOptions): MainProcessSafetyHandle {
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr
  const targetConsole = options.console ?? console
  const proc = options.processEvents ?? process

  const logger = createBoundedMainLogger({ maxBytes: options.maxLogBytes })
  const stdoutGuard = guardStdioStream(stdout)
  const stderrGuard = guardStdioStream(stderr)

  const originalWarn = targetConsole.warn
  const originalError = targetConsole.error

  targetConsole.warn = (...args: unknown[]) => {
    logger.log('warn', formatLogArgs(args))
    if (!stderrGuard.isBroken()) {
      try {
        originalWarn.apply(targetConsole, args)
      } catch {}
    }
  }

  targetConsole.error = (...args: unknown[]) => {
    logger.log('error', formatLogArgs(args))
    if (!stderrGuard.isBroken()) {
      try {
        originalError.apply(targetConsole, args)
      } catch {}
    }
  }

  const onWarning = (warning: unknown) => {
    logger.log('warning', formatError(warning))
  }

  const onUncaughtException = (error: unknown) => {
    logger.log('uncaughtException', formatError(error))
    if (!stderrGuard.isBroken() && !isBrokenStdioError(error)) {
      try {
        originalError.call(targetConsole, '[ludens] uncaughtException:', error)
      } catch {}
    }
    if (!options.isReady() || options.isQuitting()) {
      options.forceExit(options.isQuitting() ? 0 : 1)
    }
  }

  const onUnhandledRejection = (reason: unknown) => {
    logger.log('unhandledRejection', formatError(reason))
    if (!stderrGuard.isBroken() && !isBrokenStdioError(reason)) {
      try {
        originalError.call(targetConsole, '[ludens] unhandledRejection:', reason)
      } catch {}
    }
  }

  proc.on('warning', onWarning)
  proc.on('uncaughtException', onUncaughtException)
  proc.on('unhandledRejection', onUnhandledRejection)

  const removeListener = (
    event: 'warning' | 'uncaughtException' | 'unhandledRejection',
    listener: (...args: any[]) => void,
  ) => {
    if (proc.off) proc.off(event, listener)
    else proc.removeListener?.(event, listener)
  }

  let disposed = false
  return {
    setLogDir: (dir: string) => logger.setLogDir(dir),
    logger,
    isStdoutBroken: () => stdoutGuard.isBroken(),
    isStderrBroken: () => stderrGuard.isBroken(),
    dispose: () => {
      if (disposed) return
      disposed = true
      removeListener('warning', onWarning)
      removeListener('uncaughtException', onUncaughtException)
      removeListener('unhandledRejection', onUnhandledRejection)
      targetConsole.warn = originalWarn
      targetConsole.error = originalError
      stdoutGuard.dispose()
      stderrGuard.dispose()
    },
  }
}

/**
 * Watches parent stdin pipe EOF/close/error so a dev-launched Electron process exits immediately
 * if its launcher terminates or disconnects.
 */
export function installParentWatchdog(
  stream: NodeJS.ReadableStream,
  onParentGone: () => void,
): () => void {
  let fired = false
  let disposed = false

  const removeListeners = () => {
    stream.removeListener('end', trigger)
    stream.removeListener('close', trigger)
    stream.removeListener('error', trigger)
  }

  const trigger = () => {
    if (fired || disposed) return
    fired = true
    removeListeners()
    onParentGone()
  }

  stream.on('end', trigger)
  stream.on('close', trigger)
  stream.on('error', trigger)
  try {
    ;(stream as { resume?: () => void }).resume?.()
  } catch {}

  return () => {
    if (disposed) return
    disposed = true
    removeListeners()
  }
}
