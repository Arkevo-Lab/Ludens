import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createBoundedMainLogger,
  guardStdioStream,
  installMainProcessSafety,
  installParentWatchdog,
  isBrokenStdioError,
  type StdioStreamLike,
} from './process-safety.js'

class MockStdioStream extends EventEmitter implements StdioStreamLike {
  destroyed = false
  writableEnded = false
  readonly chunks: string[] = []
  throwOnWrite: Error | null = null

  write = (chunk: unknown): boolean => {
    if (this.throwOnWrite) {
      throw this.throwOnWrite
    }
    this.chunks.push(String(chunk))
    return true
  }
}

const tempDirs: string[] = []
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ludens-process-safety-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('process-safety', () => {
  it('detects broken stdio errno codes accurately', () => {
    for (const code of ['EIO', 'EPIPE', 'EBADF', 'ERR_STREAM_DESTROYED']) {
      expect(isBrokenStdioError(Object.assign(new Error(code), { code }))).toBe(true)
    }
    expect(isBrokenStdioError(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))).toBe(false)
    expect(isBrokenStdioError(new Error('plain error'))).toBe(false)
    expect(isBrokenStdioError(null)).toBe(false)
    expect(isBrokenStdioError('EIO')).toBe(false)
  })

  it('guards stdio streams on emitted EIO and synchronous EPIPE throws and mutes future console writes', () => {
    const stdout = new MockStdioStream()
    const onBroken = vi.fn()
    const stdoutGuard = guardStdioStream(stdout, onBroken)

    expect(stdout.write('ok')).toBe(true)
    expect(stdout.chunks).toEqual(['ok'])

    // Emitted EIO error does not throw unhandled error and mutes future writes
    const eio = Object.assign(new Error('write EIO'), { code: 'EIO' })
    expect(() => stdout.emit('error', eio)).not.toThrow()
    expect(stdoutGuard.isBroken()).toBe(true)
    expect(onBroken).toHaveBeenCalledTimes(1)
    expect(stdout.write('ignored-after-eio')).toBe(true)
    expect(stdout.chunks).toEqual(['ok'])
    stdoutGuard.dispose()

    // Synchronous EPIPE throw flips broken state, returns false, and mutes subsequent writes
    const logDir = makeTempDir()
    const stderr = new MockStdioStream()
    stderr.throwOnWrite = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
    const fakeConsole = {
      warn: vi.fn((...args: unknown[]) => { stderr.write(args.join(' ')) }),
      error: vi.fn((...args: unknown[]) => { stderr.write(args.join(' ')) }),
    }
    const procEvents = new EventEmitter()
    const safety = installMainProcessSafety({
      isReady: () => true,
      isQuitting: () => false,
      forceExit: vi.fn(),
      stdout: new MockStdioStream(),
      stderr,
      console: fakeConsole,
      processEvents: procEvents,
    })
    safety.setLogDir(logDir)

    expect(stderr.write('first-throw')).toBe(false)
    expect(safety.isStderrBroken()).toBe(true)
    expect(stderr.write('muted-after-epipe')).toBe(true)

    expect(() => fakeConsole.error('still logged to main.log', 42)).not.toThrow()
    expect(() => fakeConsole.warn('warning still logged')).not.toThrow()
    const content = readFileSync(join(logDir, 'main.log'), 'utf8')
    expect(content).toContain('[error] still logged to main.log 42')
    expect(content).toContain('[warn] warning still logged')
    safety.dispose()
  })

  it('mutes stream when console.error triggers synchronous EIO during write', () => {
    const logDir = makeTempDir()
    const stdout = new MockStdioStream()
    const stderr = new MockStdioStream()
    const origErrorCalls: unknown[][] = []
    const fakeConsole = {
      warn: vi.fn(),
      error: vi.fn((...args: unknown[]) => {
        origErrorCalls.push(args)
        stderr.write(args.join(' '))
      }),
    }
    const procEvents = new EventEmitter()
    const safety = installMainProcessSafety({
      isReady: () => true,
      isQuitting: () => false,
      forceExit: vi.fn(),
      stdout,
      stderr,
      console: fakeConsole,
      processEvents: procEvents,
    })
    safety.setLogDir(logDir)

    stderr.throwOnWrite = Object.assign(new Error('write EIO'), { code: 'EIO' })
    expect(() => fakeConsole.error('first failure')).not.toThrow()
    expect(safety.isStderrBroken()).toBe(true)
    expect(origErrorCalls).toHaveLength(1)

    // Subsequent console.error skips forwarding to broken stderr but keeps logging to main.log
    expect(() => fakeConsole.error('second message')).not.toThrow()
    expect(origErrorCalls).toHaveLength(1)
    const logContent = readFileSync(join(logDir, 'main.log'), 'utf8')
    expect(logContent).toContain('first failure')
    expect(logContent).toContain('second message')
    safety.dispose()
  })

  it('buffers up to 64 early entries, flushes on setLogDir, rotates at 2 MiB, and never throws on unwritable dirs', () => {
    const logger = createBoundedMainLogger()
    for (let i = 1; i <= 70; i++) {
      logger.log('info', `early-${i}`)
    }

    const dir = makeTempDir()
    const logsDir = join(dir, 'logs')
    logger.setLogDir(logsDir)

    const initialLog = readFileSync(join(logsDir, 'main.log'), 'utf8').trim().split('\n')
    expect(initialLog).toHaveLength(64)
    expect(initialLog[0]).toContain('early-7')
    expect(initialLog.at(-1)).toContain('early-70')

    // Default 2 MiB rotation threshold
    const twoMiBPayload = 'x'.repeat(2 * 1024 * 1024)
    logger.log('info', twoMiBPayload)
    expect(existsSync(join(logsDir, 'main.log.1'))).toBe(false)
    logger.log('info', 'after-rotation')
    expect(existsSync(join(logsDir, 'main.log.1'))).toBe(true)
    expect(readFileSync(join(logsDir, 'main.log.1'), 'utf8')).toContain(twoMiBPayload)
    expect(readFileSync(join(logsDir, 'main.log'), 'utf8')).toContain('after-rotation')

    // Unwritable log path (regular file blocking directory creation) never throws
    const blockedPath = join(dir, 'not-a-directory')
    writeFileSync(blockedPath, 'occupied')
    const resilientLogger = createBoundedMainLogger({ maxBytes: 128 })
    resilientLogger.log('warn', 'buffered-early')
    expect(() => resilientLogger.setLogDir(join(blockedPath, 'nested'))).not.toThrow()
    expect(() => resilientLogger.log('error', 'cannot-write')).not.toThrow()
  })

  it('enforces uncaughtException exit policy across boot, quitting, and post-ready states', () => {
    const logDir = makeTempDir()
    let ready = false
    let quitting = false
    const forceExit = vi.fn()
    const stdout = new MockStdioStream()
    const stderr = new MockStdioStream()
    const stderrLines: string[] = []
    const fakeConsole = {
      warn: vi.fn(),
      error: vi.fn((...args: unknown[]) => {
        stderrLines.push(args.map(String).join(' '))
      }),
    }
    const procEvents = new EventEmitter()

    const safety = installMainProcessSafety({
      isReady: () => ready,
      isQuitting: () => quitting,
      forceExit,
      stdout,
      stderr,
      console: fakeConsole,
      processEvents: procEvents,
    })
    safety.setLogDir(logDir)

    // 1. Pre-ready (!isReady) -> forceExit(1)
    procEvents.emit('uncaughtException', new Error('boot failure'))
    expect(forceExit).toHaveBeenNthCalledWith(1, 1)

    // 2. Post-ready (isReady && !isQuitting) -> logged without forceExit
    ready = true
    procEvents.emit('uncaughtException', new Error('runtime glitch'))
    procEvents.emit('uncaughtException', Object.assign(new Error('write EIO'), { code: 'EIO' }))
    procEvents.emit('unhandledRejection', new Error('async rejection'))
    procEvents.emit('warning', new Error('deprecation warning'))
    expect(forceExit).toHaveBeenCalledTimes(1)

    // Broken stdio error should be logged to main.log without forwarding to stderr
    expect(stderrLines.some(line => line.includes('write EIO'))).toBe(false)
    expect(stderrLines.some(line => line.includes('runtime glitch'))).toBe(true)

    // 3. Quitting (isQuitting) -> forceExit(0)
    quitting = true
    procEvents.emit('uncaughtException', new Error('shutdown error'))
    expect(forceExit).toHaveBeenNthCalledWith(2, 0)

    const logText = readFileSync(join(logDir, 'main.log'), 'utf8')
    expect(logText).toContain('[uncaughtException] Error: boot failure')
    expect(logText).toContain('[uncaughtException] Error: runtime glitch')
    expect(logText).toContain('[uncaughtException] Error: write EIO')
    expect(logText).toContain('[unhandledRejection] Error: async rejection')
    expect(logText).toContain('[warning] Error: deprecation warning')
    expect(logText).toContain('[uncaughtException] Error: shutdown error')

    safety.dispose()
  })

  it('registers and disposes default global process listeners cleanly', () => {
    const beforeUncaught = process.listenerCount('uncaughtException')
    const beforeRejection = process.listenerCount('unhandledRejection')
    const beforeWarning = process.listenerCount('warning')
    const origWarn = console.warn
    const origError = console.error

    const safety = installMainProcessSafety({
      isReady: () => true,
      isQuitting: () => false,
      forceExit: vi.fn(),
    })

    expect(process.listenerCount('uncaughtException')).toBe(beforeUncaught + 1)
    expect(process.listenerCount('unhandledRejection')).toBe(beforeRejection + 1)
    expect(process.listenerCount('warning')).toBe(beforeWarning + 1)
    expect(console.warn).not.toBe(origWarn)
    expect(console.error).not.toBe(origError)

    safety.dispose()
    expect(process.listenerCount('uncaughtException')).toBe(beforeUncaught)
    expect(process.listenerCount('unhandledRejection')).toBe(beforeRejection)
    expect(process.listenerCount('warning')).toBe(beforeWarning)
    expect(console.warn).toBe(origWarn)
    expect(console.error).toBe(origError)
  })

  it('fires installParentWatchdog at most once on end, close, or error and supports dispose', () => {
    const onEnd = vi.fn()
    const s1 = new PassThrough()
    const resumeSpy = vi.spyOn(s1, 'resume')
    installParentWatchdog(s1, onEnd)
    expect(resumeSpy).toHaveBeenCalledTimes(1)
    s1.end()
    s1.destroy()
    s1.emit('error', new Error('broken pipe'))
    expect(onEnd).toHaveBeenCalledTimes(1)

    const onClose = vi.fn()
    const s2 = Object.assign(new EventEmitter(), { resume: vi.fn() }) as unknown as NodeJS.ReadableStream
    installParentWatchdog(s2, onClose)
    s2.emit('close')
    s2.emit('end')
    expect(onClose).toHaveBeenCalledTimes(1)

    const onError = vi.fn()
    const s3 = Object.assign(new EventEmitter(), { resume: vi.fn() }) as unknown as NodeJS.ReadableStream
    installParentWatchdog(s3, onError)
    s3.emit('error', new Error('EPIPE'))
    s3.emit('close')
    expect(onError).toHaveBeenCalledTimes(1)

    const onDisposed = vi.fn()
    const s4 = Object.assign(new EventEmitter(), { resume: vi.fn() }) as unknown as NodeJS.ReadableStream
    const dispose = installParentWatchdog(s4, onDisposed)
    dispose()
    s4.emit('end')
    s4.emit('close')
    expect(onDisposed).not.toHaveBeenCalled()
    expect(s4.listenerCount('end')).toBe(0)
    expect(s4.listenerCount('close')).toBe(0)
    expect(s4.listenerCount('error')).toBe(0)
  })
})
