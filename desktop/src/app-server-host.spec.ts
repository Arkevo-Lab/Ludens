import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, posix, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { resolveAppServerSocketPath } from '@ludens/server/daemon/app-daemon'
import {
  AppServerHost,
  resolveBunExecutable,
  resolveDaemonLaunch,
  resolveDocsDir,
  resolveLudensHome,
  resolveStaticDir,
} from './app-server-host.js'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('app-server-host', () => {
  describe('path and launch resolution', () => {
    it('resolves staticDir across env override, packaged resources, dist/electron, and desktop source', () => {
      const hereDist = '/repo/desktop/dist/electron'
      const hereDesktop = '/repo/desktop/src'
      const resourcesPath = '/Applications/Ludens.app/Contents/Resources'

      expect(
        resolveStaticDir({
          platform: 'darwin',
          here: hereDist,
          resourcesPath,
          env: { LUDENS_STATIC_DIR: '/custom/static-dist' },
          exists: () => true,
        }),
      ).toBe(posix.resolve('/custom/static-dist'))

      expect(
        resolveStaticDir({
          platform: 'darwin',
          here: hereDist,
          resourcesPath,
          env: {},
          exists: p => p === posix.join(resourcesPath, 'client', 'index.html'),
        }),
      ).toBe(posix.join(resourcesPath, 'client'))

      expect(
        resolveStaticDir({
          platform: 'darwin',
          here: hereDist,
          resourcesPath,
          env: {},
          exists: p => p === '/repo/client/dist/index.html',
        }),
      ).toBe('/repo/client/dist')

      expect(
        resolveStaticDir({
          platform: 'darwin',
          here: hereDesktop,
          env: {},
          exists: p => p === '/repo/client/dist/index.html',
        }),
      ).toBe('/repo/client/dist')
    })

    it('resolves bun executable across LUDENS_BUN, PATH, and standard locations', () => {
      expect(
        resolveBunExecutable({
          platform: 'darwin',
          env: { LUDENS_BUN: '/custom/bin/bun', PATH: '/usr/bin' },
          exists: () => false,
        }),
      ).toBe('/custom/bin/bun')

      expect(
        resolveBunExecutable({
          platform: 'darwin',
          env: { PATH: '/opt/custom/bin:/usr/bin' },
          homeDir: '/Users/tester',
          exists: p => p === '/opt/custom/bin/bun',
        }),
      ).toBe('/opt/custom/bin/bun')

      expect(
        resolveBunExecutable({
          platform: 'darwin',
          env: { PATH: '' },
          homeDir: '/Users/tester',
          exists: p => p === '/opt/homebrew/bin/bun',
        }),
      ).toBe('/opt/homebrew/bin/bun')

      expect(
        resolveBunExecutable({
          platform: 'win32',
          env: { PATH: '' },
          homeDir: 'C:\\Users\\tester',
          exists: p => p === win32.join('C:\\Users\\tester', '.bun', 'bin', 'bun.exe'),
        }),
      ).toBe(win32.join('C:\\Users\\tester', '.bun', 'bin', 'bun.exe'))
    })

    it('resolves LUDENS_HOME strictly and computes zero-port daemon launch specs', () => {
      expect(resolveLudensHome({ platform: 'darwin', env: {}, homeDir: '/Users/tester' })).toBe('/Users/tester/.ludens')
      expect(resolveLudensHome({ platform: 'darwin', env: { LUDENS_HOME: '/tmp/custom-ludens' } })).toBe(posix.resolve('/tmp/custom-ludens'))
      expect(() => resolveLudensHome({ platform: 'darwin', env: { LUDENS_HOME: 'relative/path' } })).toThrow(/absolute/i)

      const resourcesPath = '/Applications/Ludens.app/Contents/Resources'
      const packagedLaunch = resolveDaemonLaunch({
        resourcesPath,
        platform: 'darwin',
        env: { LUDENS_HOME: '/tmp/ludens-packaged' },
        exists: p =>
          p === posix.join(resourcesPath, 'bin', 'ludens-server') ||
          p === posix.join(resourcesPath, 'client', 'index.html'),
      })
      expect(packagedLaunch.spawnCommand).toEqual({
        command: posix.join(resourcesPath, 'bin', 'ludens-server'),
        argsPrefix: [],
      })
      expect(packagedLaunch.staticDir).toBe(posix.join(resourcesPath, 'client'))
      expect(packagedLaunch.repo).toBe(resourcesPath)

      const packagedBundleLaunch = resolveDaemonLaunch({
        resourcesPath,
        platform: 'darwin',
        env: { LUDENS_BUN: '/opt/bun', LUDENS_HOME: '/tmp/ludens-packaged' },
        exists: p =>
          p === posix.join(resourcesPath, 'server', 'main.js') ||
          p === posix.join(resourcesPath, 'client', 'index.html') ||
          p === posix.join(resourcesPath, 'docs'),
      })
      expect(packagedBundleLaunch.spawnCommand).toEqual({
        command: '/opt/bun',
        argsPrefix: [posix.join(resourcesPath, 'server', 'main.js')],
      })
      expect(packagedBundleLaunch.staticDir).toBe(posix.join(resourcesPath, 'client'))
      expect(packagedBundleLaunch.repo).toBe(resourcesPath)

      const packagedSourceLaunch = resolveDaemonLaunch({
        resourcesPath,
        platform: 'darwin',
        env: { LUDENS_BUN: '/opt/bun', LUDENS_HOME: '/tmp/ludens-packaged' },
        exists: p =>
          p === posix.join(resourcesPath, 'server', 'src', 'cli', 'main.ts') ||
          p === posix.join(resourcesPath, 'client', 'index.html') ||
          p === posix.join(resourcesPath, 'docs'),
      })
      expect(packagedSourceLaunch.spawnCommand).toEqual({
        command: '/opt/bun',
        argsPrefix: [posix.join(resourcesPath, 'server', 'src', 'cli', 'main.ts')],
      })
      expect(packagedSourceLaunch.repo).toBe(resourcesPath)
      expect(
        resolveDocsDir({
          platform: 'darwin',
          resourcesPath,
          env: {},
          exists: p => p === posix.join(resourcesPath, 'docs'),
        }),
      ).toBe(posix.join(resourcesPath, 'docs'))

      // Packaged Resources/server/main.js + LUDENS_APP_SERVER_BIN must keep repo === resourcesPath (not Ludens.app)
      const packagedWithOverrideBin = resolveDaemonLaunch({
        resourcesPath,
        platform: 'darwin',
        env: {
          LUDENS_APP_SERVER_BIN: '/opt/custom/ludens-server',
          LUDENS_HOME: '/tmp/ludens-packaged',
        },
        exists: p =>
          p === posix.join(resourcesPath, 'server', 'main.js') ||
          p === posix.join(resourcesPath, 'client', 'index.html'),
      })
      expect(packagedWithOverrideBin.spawnCommand).toEqual({
        command: '/opt/custom/ludens-server',
        argsPrefix: [],
      })
      expect(packagedWithOverrideBin.repo).toBe(resourcesPath)

      expect(
        resolveDaemonLaunch({
          platform: 'darwin',
          env: { LUDENS_SERVER_BIN: '/opt/custom/ludens-server', LUDENS_HOME: '/tmp/ludens-bin' },
          exists: () => false,
        }).spawnCommand,
      ).toEqual({
        command: '/opt/custom/ludens-server',
        argsPrefix: [],
      })

      const repoLaunch = resolveDaemonLaunch({
        here: '/repo/desktop/dist/electron',
        platform: 'darwin',
        env: { LUDENS_BUN: '/opt/bun', LUDENS_HOME: '/tmp/ludens-dev' },
        exists: p => p === '/repo/server/src/cli/main.ts' || p === '/repo/client/dist/index.html',
      })
      expect(repoLaunch.spawnCommand).toEqual({
        command: '/opt/bun',
        argsPrefix: ['/repo/server/src/cli/main.ts'],
      })
      expect(repoLaunch.staticDir).toBe('/repo/client/dist')
      expect(repoLaunch.repo).toBe('/repo')
    })
  })

  describe('daemon lifecycle', () => {
    it('starts UDS-only singleton daemon with wsListen null and zero TCP ports', async () => {
      const home = join(homedir(), '.ludens-test-zero-port')
      const expectedSocket = resolveAppServerSocketPath(home)
      const ensureDaemon = vi.fn(async options => {
        expect(options.home).toBe(resolve(home))
        expect(options.wsListen).toBeNull()
        return {
          started: true,
          runtime: {
            pid: 5150,
            socketPath: expectedSocket,
            wsUrl: null,
            authMode: 'none' as const,
            startedAt: '2026-11-14T08:00:00.000Z',
            home: resolve(home),
          },
          status: {
            protocolVersion: '1.0',
            pid: 5150,
            home: resolve(home),
            socketPath: expectedSocket,
            wsUrl: null,
            authMode: 'none' as const,
            serverSeq: 1,
            activeCores: [],
            managedWorkspaces: [],
            startedAt: '2026-11-14T08:00:00.000Z',
          },
        }
      })

      const host = new AppServerHost({
        home,
        env: { LUDENS_APP_SERVER_BIN: '/usr/local/bin/ludens' },
        exists: () => true,
        ensureDaemon,
      })

      const [first, second] = await Promise.all([host.start(), host.start()])
      const third = await host.start()
      expect(ensureDaemon).toHaveBeenCalledTimes(1)
      expect(first.socketPath).toBe(expectedSocket)
      expect(first.wsUrl).toBeNull()
      expect(first.pid).toBe(5150)
      expect(second).toBe(first)
      expect(third).toBe(first)
      expect(host.current()).toBe(first)
      expect(host.socketPath()).toBe(expectedSocket)
    })

    it('re-ensures offline daemon via ensureOnline and does not terminate background daemon on stop()', async () => {
      const home = join(tmpdir(), 'ludens-recover-test')
      const socketPath = resolveAppServerSocketPath(home)
      let probeOnline = false
      let launchCount = 0

      const ensureDaemon = vi.fn(async () => {
        launchCount += 1
        probeOnline = true
        return {
          started: true,
          runtime: {
            pid: 7000 + launchCount,
            socketPath,
            wsUrl: null,
            authMode: 'none' as const,
            startedAt: '2026-11-14T08:10:00.000Z',
            home,
          },
          status: {
            protocolVersion: '1.0',
            pid: 7000 + launchCount,
            home,
            socketPath,
            wsUrl: null,
            authMode: 'none' as const,
            serverSeq: launchCount,
            activeCores: ['proj-1'],
            managedWorkspaces: [],
            startedAt: '2026-11-14T08:10:00.000Z',
          },
        }
      })

      const probeDaemon = vi.fn(async () => {
        if (!probeOnline) return null
        return {
          protocolVersion: '1.0',
          pid: 7000 + launchCount,
          home,
          socketPath,
          wsUrl: null,
          authMode: 'none' as const,
          serverSeq: 9,
          activeCores: ['proj-1'],
          managedWorkspaces: [],
          startedAt: '2026-11-14T08:10:00.000Z',
        }
      })

      const host = new AppServerHost({
        home,
        env: { LUDENS_APP_SERVER_BIN: '/usr/local/bin/ludens' },
        exists: () => true,
        ensureDaemon,
        probeDaemon,
      })

      const started = await host.start()
      expect(started.pid).toBe(7001)

      // Online check succeeds without respawning
      const online = await host.ensureOnline()
      expect(online.pid).toBe(7001)
      expect(online.activeCores).toEqual(['proj-1'])
      expect(ensureDaemon).toHaveBeenCalledTimes(1)

      // Daemon crashes -> ensureOnline respawns cleanly
      probeOnline = false
      const recovered = await host.ensureOnline()
      expect(recovered.pid).toBe(7002)
      expect(ensureDaemon).toHaveBeenCalledTimes(2)

      // stop() only detaches host state and never sends stop/kill to background daemon
      await host.stop()
      expect(host.current()).toBeUndefined()
      await expect(host.start()).rejects.toThrow(/stopped/i)
    })

    it('assembles and runs autonomous ../server/dist, ../core/dist, and ../baseware/dist bundles from an isolated resourcesPath without node_modules', () => {
      const builtServerDir = resolve(desktopRoot, '../server/dist')
      const builtCoreDir = resolve(desktopRoot, '../core/dist')
      const builtBasewareDir = resolve(desktopRoot, '../baseware/dist')
      if (
        !existsSync(join(builtServerDir, 'main.js')) ||
        !existsSync(join(builtCoreDir, 'bin', 'ludens-core')) ||
        !existsSync(join(builtBasewareDir, 'bin', 'baseware'))
      ) {
        return
      }
      const isolatedRoot = mkdtempSync(join(tmpdir(), 'ludens-packaged-resources-'))
      try {
        const resourcesPath = join(isolatedRoot, 'Resources')
        mkdirSync(join(resourcesPath, 'client'), { recursive: true })
        writeFileSync(join(resourcesPath, 'client', 'index.html'), '<!doctype html><html></html>')
        cpSync(builtServerDir, join(resourcesPath, 'server'), { recursive: true })
        cpSync(builtCoreDir, join(resourcesPath, 'core'), { recursive: true })
        cpSync(builtBasewareDir, join(resourcesPath, 'baseware'), { recursive: true })

        const launch = resolveDaemonLaunch({
          here: join(isolatedRoot, 'app', 'dist', 'electron'),
          resourcesPath,
          env: process.env,
        })
        expect(launch.spawnCommand.argsPrefix).toEqual([join(resourcesPath, 'server', 'main.js')])
        expect(launch.staticDir).toBe(join(resourcesPath, 'client'))
        expect(launch.repo).toBe(resourcesPath)

        const isolatedEnv = {
          PATH: process.env.PATH ?? '',
          LUDENS_BUN: launch.spawnCommand.command,
          LUDENS_REPO_ROOT: resourcesPath,
        }

        const serverRes = spawnSync(
          launch.spawnCommand.command,
          [...launch.spawnCommand.argsPrefix, '--help'],
          { cwd: isolatedRoot, encoding: 'utf8', env: isolatedEnv },
        )
        expect(serverRes.error).toBeUndefined()
        expect(serverRes.status).toBe(0)
        expect(serverRes.stdout).toContain('ludens-server — Ludens Control Plane Server')

        const serverBin = join(
          resourcesPath,
          'server',
          'bin',
          process.platform === 'win32' ? 'ludens-server.cmd' : 'ludens-server',
        )
        if (existsSync(serverBin)) {
          const serverBinRes = spawnSync(serverBin, ['--help'], {
            cwd: isolatedRoot,
            encoding: 'utf8',
            env: isolatedEnv,
          })
          expect(serverBinRes.error).toBeUndefined()
          expect(serverBinRes.status).toBe(0)
          expect(serverBinRes.stdout).toContain('ludens-server — Ludens Control Plane Server')
        }

        const coreBin = join(resourcesPath, 'core', 'bin', process.platform === 'win32' ? 'ludens-core.cmd' : 'ludens-core')
        const coreRes = spawnSync(coreBin, ['--help'], {
          cwd: isolatedRoot,
          encoding: 'utf8',
          env: isolatedEnv,
        })
        expect(coreRes.error).toBeUndefined()
        expect(coreRes.status).toBe(0)
        expect(coreRes.stdout).toContain('ludens-core')

        const basewareBin = join(resourcesPath, 'baseware', 'bin', process.platform === 'win32' ? 'baseware.cmd' : 'baseware')
        const basewareRes = spawnSync(basewareBin, ['--help'], {
          cwd: isolatedRoot,
          encoding: 'utf8',
          env: isolatedEnv,
        })
        expect(basewareRes.error).toBeUndefined()
        expect(basewareRes.status).toBe(0)
        expect(basewareRes.stdout).toContain('baseware serve')

        // Verify Windows cliCommand fallback shims (src/cli/main.ts and src/main.ts) also execute cleanly in isolation
        const coreShimRes = spawnSync(
          launch.spawnCommand.command,
          [join(resourcesPath, 'core', 'src', 'cli', 'main.ts'), '--help'],
          { cwd: isolatedRoot, encoding: 'utf8', env: isolatedEnv },
        )
        expect(coreShimRes.error).toBeUndefined()
        expect(coreShimRes.status).toBe(0)
        expect(coreShimRes.stdout).toContain('ludens-core')

        const basewareShimRes = spawnSync(
          launch.spawnCommand.command,
          [join(resourcesPath, 'baseware', 'src', 'main.ts'), '--help'],
          { cwd: isolatedRoot, encoding: 'utf8', env: isolatedEnv },
        )
        expect(basewareShimRes.error).toBeUndefined()
        expect(basewareShimRes.status).toBe(0)
        expect(basewareShimRes.stdout).toContain('baseware serve')
      } finally {
        rmSync(isolatedRoot, { recursive: true, force: true })
      }
    })
  })

  describe('owned daemon auto-reclaim on stop', () => {
    function makeStatus(overrides: Partial<{ pid: number; wsUrl: string | null; activeCores: string[] }> = {}) {
      return {
        protocolVersion: '1.0' as const,
        pid: overrides.pid ?? 4242,
        home: '/tmp/ludens-reclaim',
        socketPath: '/tmp/ludens-reclaim/run/app-server.sock',
        wsUrl: overrides.wsUrl ?? null,
        authMode: 'none' as const,
        serverSeq: 1,
        activeCores: overrides.activeCores ?? [],
        managedWorkspaces: overrides.activeCores ?? [],
      }
    }

    function makeEnsureResult(started: boolean, overrides: Partial<{ pid: number; wsUrl: string | null; activeCores: string[] }> = {}) {
      const status = makeStatus(overrides)
      return {
        started,
        runtime: {
          pid: status.pid,
          home: status.home,
          socketPath: status.socketPath,
          wsUrl: status.wsUrl,
          authMode: status.authMode,
          startedAt: '2026-11-20T00:00:00.000Z',
        },
        status,
      }
    }

    it('reclaims local UDS-only daemon spawned by Electron when stop({ stopOwnedDaemon: true }) runs with 0 active Cores', async () => {
      const stopDaemon = vi.fn(async () => ({ stopped: true, pid: 4242, stoppedCores: [] }))
      const host = new AppServerHost({
        home: '/tmp/ludens-reclaim',
        ensureDaemon: vi.fn(async () => makeEnsureResult(true, { pid: 4242 })),
        probeDaemon: vi.fn(async () => makeStatus({ pid: 4242, activeCores: [] })),
        stopDaemon,
      })

      await host.start()
      expect(host.isOwnedDaemon()).toBe(true)

      // ensureOnline hitting the same PID preserves ownership
      await host.ensureOnline()
      expect(host.isOwnedDaemon()).toBe(true)

      await host.stop({ stopOwnedDaemon: true })
      expect(host.isOwnedDaemon()).toBe(false)
      expect(stopDaemon).toHaveBeenCalledTimes(1)
      expect(stopDaemon).toHaveBeenCalledWith('/tmp/ludens-reclaim', { stopCores: false, timeoutMs: 3_000 })
    })

    it('does NOT stop an external daemon that was already running before Electron attached', async () => {
      const stopDaemon = vi.fn(async () => ({ stopped: true, pid: 4242, stoppedCores: [] }))
      const host = new AppServerHost({
        home: '/tmp/ludens-reclaim',
        ensureDaemon: vi.fn(async () => makeEnsureResult(false, { pid: 4242 })),
        probeDaemon: vi.fn(async () => makeStatus({ pid: 4242, activeCores: [] })),
        stopDaemon,
      })

      await host.start()
      expect(host.isOwnedDaemon()).toBe(false)

      await host.stop({ stopOwnedDaemon: true })
      expect(stopDaemon).not.toHaveBeenCalled()
    })

    it('does NOT stop owned daemon when keep-background is chosen (stopOwnedDaemon: false) or when active Cores remain', async () => {
      const stopDaemon = vi.fn(async () => ({ stopped: true, pid: 4242, stoppedCores: [] }))
      const host1 = new AppServerHost({
        home: '/tmp/ludens-reclaim',
        ensureDaemon: vi.fn(async () => makeEnsureResult(true, { pid: 4242 })),
        probeDaemon: vi.fn(async () => makeStatus({ pid: 4242, activeCores: [] })),
        stopDaemon,
      })
      await host1.start()
      await host1.stop({ stopOwnedDaemon: false })
      expect(stopDaemon).not.toHaveBeenCalled()

      const host2 = new AppServerHost({
        home: '/tmp/ludens-reclaim',
        ensureDaemon: vi.fn(async () => makeEnsureResult(true, { pid: 4242 })),
        probeDaemon: vi.fn(async () => makeStatus({ pid: 4242, activeCores: ['ws-live'] })),
        stopDaemon,
      })
      await host2.start()
      await host2.stop({ stopOwnedDaemon: true })
      expect(stopDaemon).not.toHaveBeenCalled()
    })

    it('does NOT stop daemon if PID changed externally or a TCP/WS listener is active', async () => {
      const stopDaemon = vi.fn(async () => ({ stopped: true, pid: 4242, stoppedCores: [] }))
      const hostPidChanged = new AppServerHost({
        home: '/tmp/ludens-reclaim',
        ensureDaemon: vi.fn(async () => makeEnsureResult(true, { pid: 4242 })),
        probeDaemon: vi.fn(async () => makeStatus({ pid: 9999, activeCores: [] })),
        stopDaemon,
      })
      await hostPidChanged.start()
      await hostPidChanged.stop({ stopOwnedDaemon: true })
      expect(stopDaemon).not.toHaveBeenCalled()

      const hostWithWs = new AppServerHost({
        home: '/tmp/ludens-reclaim',
        ensureDaemon: vi.fn(async () => makeEnsureResult(true, { pid: 4242 })),
        probeDaemon: vi.fn(async () => makeStatus({ pid: 4242, wsUrl: 'ws://127.0.0.1:43115/rpc', activeCores: [] })),
        stopDaemon,
      })
      await hostWithWs.start()
      await hostWithWs.stop({ stopOwnedDaemon: true })
      expect(stopDaemon).not.toHaveBeenCalled()
    })

    it('awaits in-flight start() and reclaims newly spawned daemon when stop({ stopOwnedDaemon: true }) races with start', async () => {
      let releaseEnsure: (value: ReturnType<typeof makeEnsureResult>) => void = () => {}
      const ensureDaemon = vi.fn(
        () =>
          new Promise<ReturnType<typeof makeEnsureResult>>(resolveEnsure => {
            releaseEnsure = resolveEnsure
          }),
      )
      const stopDaemon = vi.fn(async () => ({ stopped: true, pid: 4242, stoppedCores: [] }))
      const host = new AppServerHost({
        home: '/tmp/ludens-reclaim',
        ensureDaemon,
        probeDaemon: vi.fn(async () => makeStatus({ pid: 4242, activeCores: [] })),
        stopDaemon,
      })

      const startPromise = host.start()
      const stopPromise = host.stop({ stopOwnedDaemon: true })
      await Promise.resolve()
      expect(stopDaemon).not.toHaveBeenCalled()

      releaseEnsure(makeEnsureResult(true, { pid: 4242, wsUrl: null, activeCores: [] }))
      await Promise.all([startPromise, stopPromise])

      expect(stopDaemon).toHaveBeenCalledTimes(1)
      expect(stopDaemon).toHaveBeenCalledWith('/tmp/ludens-reclaim', { stopCores: false, timeoutMs: 3_000 })
      expect(host.isOwnedDaemon()).toBe(false)
      expect(host.current()).toBeUndefined()
    })

    it('does NOT stop pre-existing external daemon when stop({ stopOwnedDaemon: true }) races with start()', async () => {
      let releaseEnsure: (value: ReturnType<typeof makeEnsureResult>) => void = () => {}
      const ensureDaemon = vi.fn(
        () =>
          new Promise<ReturnType<typeof makeEnsureResult>>(resolveEnsure => {
            releaseEnsure = resolveEnsure
          }),
      )
      const stopDaemon = vi.fn(async () => ({ stopped: true, pid: 4242, stoppedCores: [] }))
      const host = new AppServerHost({
        home: '/tmp/ludens-reclaim',
        ensureDaemon,
        probeDaemon: vi.fn(async () => makeStatus({ pid: 4242, activeCores: [] })),
        stopDaemon,
      })

      const startPromise = host.start()
      const stopPromise = host.stop({ stopOwnedDaemon: true })
      await Promise.resolve()

      releaseEnsure(makeEnsureResult(false, { pid: 4242, wsUrl: null, activeCores: [] }))
      await Promise.all([startPromise, stopPromise])

      expect(stopDaemon).not.toHaveBeenCalled()
      expect(host.isOwnedDaemon()).toBe(false)
      expect(host.current()).toBeUndefined()
    })
  })
})
