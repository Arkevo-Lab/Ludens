import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { resolveAppServerSocketPath } from '@ludens/core/daemon/app-daemon'
import {
  AppServerHost,
  resolveBunExecutable,
  resolveDaemonLaunch,
  resolveLudensHome,
  resolveStaticDir,
} from './app-server-host.js'

describe('app-server-host', () => {
  describe('path and launch resolution', () => {
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

    it('resolves bun executable across LUDENS_BUN, PATH, and standard locations', () => {
      expect(
        resolveBunExecutable({
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
          exists: p => p === join('C:\\Users\\tester', '.bun', 'bin', 'bun.exe'),
        }),
      ).toBe(join('C:\\Users\\tester', '.bun', 'bin', 'bun.exe'))
    })

    it('resolves LUDENS_HOME strictly and computes zero-port daemon launch specs', () => {
      expect(resolveLudensHome({ env: {}, homeDir: '/Users/tester' })).toBe('/Users/tester/.ludens')
      expect(resolveLudensHome({ env: { LUDENS_HOME: '/tmp/custom-ludens' } })).toBe(resolve('/tmp/custom-ludens'))
      expect(() => resolveLudensHome({ env: { LUDENS_HOME: 'relative/path' } })).toThrow(/absolute/i)

      const resourcesPath = '/Applications/Ludens.app/Contents/Resources'
      const packagedLaunch = resolveDaemonLaunch({
        resourcesPath,
        platform: 'darwin',
        env: { LUDENS_HOME: '/tmp/ludens-packaged' },
        exists: p => p === join(resourcesPath, 'bin', 'ludens') || p === join(resourcesPath, 'out', 'index.html'),
      })
      expect(packagedLaunch.spawnCommand).toEqual({
        command: join(resourcesPath, 'bin', 'ludens'),
        argsPrefix: [],
      })
      expect(packagedLaunch.staticDir).toBe(join(resourcesPath, 'out'))
      expect(packagedLaunch.repo).toBe(resourcesPath)

      const repoLaunch = resolveDaemonLaunch({
        here: '/repo/app/dist/electron',
        platform: 'darwin',
        env: { LUDENS_BUN: '/opt/bun', LUDENS_HOME: '/tmp/ludens-dev' },
        exists: p => p === '/repo/core/src/cli/main.ts' || p === '/repo/app/out/index.html',
      })
      expect(repoLaunch.spawnCommand).toEqual({
        command: '/opt/bun',
        argsPrefix: ['/repo/core/src/cli/main.ts'],
      })
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
      const home = '/tmp/ludens-recover-test'
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
  })
})
