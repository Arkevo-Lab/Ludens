import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  AppServerHost,
  resolveAppServerLaunch,
  resolveBunExecutable,
  resolveStaticDir,
  type SpawnedProcessLike,
  type SpawnOptionsLike,
  type WritablePipeLike,
} from './app-server-host.js'

class MockWritablePipe extends EventEmitter implements WritablePipeLike {
  writableEnded = false
  destroyed = false

  end(): void {
    this.writableEnded = true
  }

  destroy(): void {
    this.destroyed = true
  }
}

class MockChildProcess extends EventEmitter implements SpawnedProcessLike {
  readonly pid: number
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly stdin = new MockWritablePipe()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly signals: Array<NodeJS.Signals | number | undefined> = []
  autoExitOnKill = true

  constructor(pid = 4242) {
    super()
    this.pid = pid
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal)
    if (this.autoExitOnKill && this.exitCode === null && this.signalCode === null) {
      this.signalCode = typeof signal === 'string' ? signal : 'SIGTERM'
      queueMicrotask(() => {
        this.emit('exit', null, this.signalCode)
      })
    }
    return true
  }

  finish(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code
    this.signalCode = signal
    this.emit('exit', code, signal)
  }
}

describe('app-server-host', () => {
  describe('path resolution', () => {
    it('resolves staticDir across env override, packaged resources, dist/electron, and desktop source', () => {
      const hereDist = '/repo/app/dist/electron'
      const hereDesktop = '/repo/app/desktop'
      const resourcesPath = '/Applications/Ludens.app/Contents/Resources'

      expect(
        resolveStaticDir({
          here: hereDist,
          resourcesPath,
          env: { LUDENS_STATIC_DIR: '/custom/static-out' },
          exists: () => true,
        }),
      ).toBe(resolve('/custom/static-out'))

      expect(
        resolveStaticDir({
          here: hereDist,
          resourcesPath,
          env: {},
          exists: p => p === join(resourcesPath, 'out', 'index.html'),
        }),
      ).toBe(join(resourcesPath, 'out'))

      expect(
        resolveStaticDir({
          here: hereDist,
          resourcesPath,
          env: {},
          exists: p => p === '/repo/app/out/index.html',
        }),
      ).toBe('/repo/app/out')

      expect(
        resolveStaticDir({
          here: hereDesktop,
          env: {},
          exists: p => p === '/repo/app/out/index.html',
        }),
      ).toBe('/repo/app/out')
    })

    it('resolves packaged ludens binary on macOS/Linux and Windows, falling back to dev bun + core CLI', () => {
      const macResources = '/Applications/Ludens.app/Contents/Resources'
      const macPackaged = resolveAppServerLaunch({
        here: '/Applications/Ludens.app/Contents/Resources/app.asar/dist/electron',
        resourcesPath: macResources,
        platform: 'darwin',
        staticDir: '/Applications/Ludens.app/Contents/Resources/out',
        exists: p => p === join(macResources, 'bin', 'ludens'),
      })
      expect(macPackaged).toEqual({
        command: join(macResources, 'bin', 'ludens'),
        args: [
          'app-server',
          '--port',
          '0',
          '--parent-watchdog',
          '--static-dir',
          '/Applications/Ludens.app/Contents/Resources/out',
        ],
        staticDir: '/Applications/Ludens.app/Contents/Resources/out',
      })

      const winResources = 'C:\\Program Files\\Ludens\\resources'
      const winBin = join(winResources, 'bin', 'ludens.exe')
      const winPackaged = resolveAppServerLaunch({
        here: 'C:\\Program Files\\Ludens\\resources\\app.asar\\dist\\electron',
        resourcesPath: winResources,
        platform: 'win32',
        staticDir: join(winResources, 'out'),
        exists: p => p === winBin,
      })
      expect(winPackaged.command).toBe(winBin)
      expect(winPackaged.args).toEqual([
        'app-server',
        '--port',
        '0',
        '--parent-watchdog',
        '--static-dir',
        join(winResources, 'out'),
      ])

      const devLaunch = resolveAppServerLaunch({
        here: '/repo/app/dist/electron',
        resourcesPath: '/repo/app/node_modules/electron/dist/Electron.app/Contents/Resources',
        platform: 'darwin',
        homeDir: '/Users/dev',
        env: { PATH: '/usr/bin:/bin' },
        staticDir: '/repo/app/out',
        exists: p =>
          p === '/Users/dev/.bun/bin/bun' || p === '/repo/core/src/cli/main.ts',
      })
      expect(devLaunch).toEqual({
        command: '/Users/dev/.bun/bin/bun',
        args: [
          '/repo/core/src/cli/main.ts',
          'app-server',
          '--port',
          '0',
          '--parent-watchdog',
          '--static-dir',
          '/repo/app/out',
        ],
        staticDir: '/repo/app/out',
      })
    })

    it('resolves bun executable from LUDENS_BUN, PATH, and ~/.bun/bin', () => {
      expect(
        resolveBunExecutable({
          env: { LUDENS_BUN: '/opt/custom/bun' },
          exists: () => false,
        }),
      ).toBe('/opt/custom/bun')

      expect(
        resolveBunExecutable({
          platform: 'darwin',
          env: { PATH: '/usr/bin:/usr/local/custom' },
          homeDir: '/Users/alice',
          exists: p => p === '/usr/local/custom/bun',
        }),
      ).toBe('/usr/local/custom/bun')

      expect(
        resolveAppServerLaunch({
          env: { LUDENS_APP_SERVER_BIN: '/opt/ludens/bin/ludens' },
          staticDir: '/repo/app/out',
          exists: () => false,
        }),
      ).toEqual({
        command: '/opt/ludens/bin/ludens',
        args: ['app-server', '--port', '0', '--parent-watchdog', '--static-dir', '/repo/app/out'],
        staticDir: '/repo/app/out',
      })
    })

    it('throws an actionable error when packaged app has neither resources/bin/ludens nor repo core entry', async () => {
      const host = new AppServerHost({
        here: '/Applications/Ludens.app/Contents/Resources/app.asar/dist/electron',
        resourcesPath: '/Applications/Ludens.app/Contents/Resources',
        platform: 'darwin',
        env: {},
        exists: () => false,
      })
      await expect(host.start()).rejects.toThrow(/Ludens app-server backend not found/)
    })
  })

  describe('lifecycle, watchdog stdin pipe, and shutdown', () => {
    it('parses chunked stdout ready JSON and keeps child.stdin open while running', async () => {
      const child = new MockChildProcess(7788)
      const calls: Array<{ command: string; args: readonly string[]; options: SpawnOptionsLike }> = []

      const host = new AppServerHost({
        command: '/opt/homebrew/bin/bun',
        args: ['/repo/core/src/cli/main.ts', 'app-server', '--port', '0', '--parent-watchdog'],
        staticDir: '/repo/app/out',
        spawnImpl: (command, args, options) => {
          calls.push({ command, args, options })
          return child
        },
      })

      const starting = host.start()
      const duplicate = host.start()
      expect(duplicate).toBe(starting)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.options.stdio).toEqual(['pipe', 'pipe', 'pipe'])

      // Non-JSON log line followed by split JSON handshake across two chunks
      child.stdout.write('[boot] warming index\n{"ready":true,"url":"http://127.0.0.1:54321"')
      child.stdout.write(',"port":54321,"pid":7788}\n')

      const info = await starting
      expect(info).toEqual({
        url: 'http://127.0.0.1:54321',
        origin: 'http://127.0.0.1:54321',
        href: 'http://127.0.0.1:54321/',
        port: 54321,
        pid: 7788,
      })

      // Critical invariant: stdin MUST stay open while running so --parent-watchdog detects parent death
      expect(child.stdin.writableEnded).toBe(false)
      expect(child.stdin.destroyed).toBe(false)
    })

    it('reports buffered stderr clearly when child exits early before ready handshake', async () => {
      const child = new MockChildProcess(9911)
      const host = new AppServerHost({
        command: 'bun',
        args: ['app-server'],
        spawnImpl: () => child,
      })

      const starting = host.start()
      child.stderr.write('Error: port bind failed in test\n')
      child.finish(1, null)

      await expect(starting).rejects.toThrow(/exited before ready handshake \(code=1[\s\S]*port bind failed in test/)
    })

    it('times out cleanly and terminates hung child when handshake never arrives', async () => {
      const child = new MockChildProcess(9922)
      const host = new AppServerHost({
        command: 'bun',
        args: ['app-server'],
        startupTimeoutMs: 60,
        shutdownTimeoutMs: 100,
        spawnImpl: () => child,
      })

      child.stderr.write('stuck before listening\n')
      await expect(host.start()).rejects.toThrow(/Timed out waiting for ludens app-server ready handshake[\s\S]*stuck before listening/)
      expect(child.stdin.writableEnded).toBe(true)
      expect(child.signals).toContain('SIGTERM')
    })

    it('gracefully POSTs /api/app-server/shutdown with matching Origin, closes stdin, and sends SIGTERM', async () => {
      const child = new MockChildProcess(5501)
      child.autoExitOnKill = false

      const fetchSpy = vi.fn<typeof fetch>(async () => {
        // Simulate server beginning graceful shutdown and exiting shortly after replying
        setTimeout(() => child.finish(0, null), 15)
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      })

      const host = new AppServerHost({
        command: 'bun',
        args: ['app-server'],
        spawnImpl: () => child,
        fetchImpl: fetchSpy,
      })

      const startPromise = host.start()
      child.stdout.write('{"ready":true,"url":"http://127.0.0.1:59111","port":59111}\n')
      await startPromise

      expect(child.stdin.writableEnded).toBe(false)
      await host.stop()

      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const [calledUrl, calledInit] = fetchSpy.mock.calls[0]!
      expect(calledUrl).toBe('http://127.0.0.1:59111/api/app-server/shutdown')
      expect(calledInit?.method).toBe('POST')
      expect((calledInit?.headers as Record<string, string>)?.Origin).toBe('http://127.0.0.1:59111')
      expect(child.stdin.writableEnded).toBe(true)
      expect(child.signals).toContain('SIGTERM')
      expect(child.signals).not.toContain('SIGKILL')
    })

    it('escalates to SIGKILL on POSIX and taskkill /T /F on Windows when child ignores SIGTERM', async () => {
      const posixChild = new MockChildProcess(6601)
      posixChild.autoExitOnKill = false
      posixChild.kill = vi.fn((signal?: NodeJS.Signals | number) => {
        posixChild.signals.push(signal)
        if (signal === 'SIGKILL') {
          posixChild.finish(null, 'SIGKILL')
        }
        return true
      })

      const posixHost = new AppServerHost({
        platform: 'darwin',
        command: 'bun',
        args: ['app-server'],
        shutdownTimeoutMs: 60,
        spawnImpl: () => posixChild,
        fetchImpl: async () => new Response('{"ok":true}', { status: 200 }),
      })

      const pStart = posixHost.start()
      posixChild.stdout.write('{"ready":true,"url":"http://127.0.0.1:59222","port":59222}\n')
      await pStart
      await posixHost.stop()
      expect(posixChild.signals).toEqual(['SIGTERM', 'SIGKILL'])

      // Windows graceful stop check: does NOT call child.kill('SIGTERM') prematurely
      const winGracefulChild = new MockChildProcess(6600)
      winGracefulChild.autoExitOnKill = false
      const winGracefulHost = new AppServerHost({
        platform: 'win32',
        command: 'bun.exe',
        args: ['app-server'],
        shutdownTimeoutMs: 500,
        spawnImpl: () => winGracefulChild,
        fetchImpl: async () => {
          setTimeout(() => winGracefulChild.finish(0, null), 15)
          return new Response('{"ok":true}', { status: 200 })
        },
      })
      const wgStart = winGracefulHost.start()
      winGracefulChild.stdout.write('{"ready":true,"url":"http://127.0.0.1:59330","port":59330}\n')
      await wgStart
      await winGracefulHost.stop()
      expect(winGracefulChild.signals).toEqual([])

      // Windows escalation check: awaits taskkill before completing stop()
      const winChild = new MockChildProcess(6602)
      winChild.autoExitOnKill = false
      const spawnedCommands: Array<{ command: string; args: readonly string[] }> = []
      let taskkillExited = false

      const winHost = new AppServerHost({
        platform: 'win32',
        command: 'bun.exe',
        args: ['app-server'],
        shutdownTimeoutMs: 60,
        spawnImpl: (command, args) => {
          spawnedCommands.push({ command, args })
          if (command === 'taskkill') {
            const killer = new MockChildProcess(9999)
            killer.autoExitOnKill = false
            setTimeout(() => {
              taskkillExited = true
              winChild.finish(1, null)
              killer.finish(0, null)
            }, 20)
            return killer
          }
          return winChild
        },
        fetchImpl: async () => {
          throw new Error('ECONNREFUSED')
        },
      })

      const wStart = winHost.start()
      winChild.stdout.write('{"ready":true,"url":"http://127.0.0.1:59333","port":59333}\n')
      await wStart
      await winHost.stop()

      expect(taskkillExited).toBe(true)
      expect(spawnedCommands).toContainEqual({
        command: 'taskkill',
        args: ['/PID', '6602', '/T', '/F'],
      })
    })
  })
})
