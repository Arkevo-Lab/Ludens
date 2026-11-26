import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createPowerSavePreferenceStore,
  DesktopPowerSaveController,
  type DesktopPowerState,
  type PowerSaveBlockerApi,
} from './power-save-blocker.js'

function createFakeBlocker() {
  let nextId = 1
  const active = new Map<number, string>()
  const start = vi.fn((type: 'prevent-app-suspension' | 'prevent-display-sleep') => {
    const id = nextId++
    active.set(id, type)
    return id
  })
  const stop = vi.fn((id: number) => {
    active.delete(id)
  })
  const isStarted = vi.fn((id: number) => active.has(id))
  const api: PowerSaveBlockerApi = { start, stop, isStarted }
  return { api, active, start, stop, isStarted }
}

describe('DesktopPowerSaveController', () => {
  it('starts prevent-app-suspension while active Cores run and releases when idle, disabled, or disposed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ludens-power-test-'))
    try {
      const prefPath = join(dir, 'power-preferences.json')
      const store = createPowerSavePreferenceStore(prefPath)
      expect(store.get().preventAppSuspension).toBe(true)

      const blocker = createFakeBlocker()
      let activeCores: string[] = []
      const states: DesktopPowerState[] = []

      const controller = new DesktopPowerSaveController({
        blocker: blocker.api,
        store,
        queryStatus: async () => ({
          running: true,
          pid: 123,
          socketPath: '/tmp/app.sock',
          startedAt: '2026-11-26T00:00:00.000Z',
          version: '0.1.0',
          activeCores,
        }),
        onStateChange: state => states.push(state),
      })

      // Idle: does not start blocker
      await controller.refresh()
      expect(blocker.start).not.toHaveBeenCalled()
      expect(controller.getState()).toEqual({
        preventAppSuspension: true,
        blocking: false,
        activeCoreCount: 0,
      })

      // Active Core starts: acquires prevent-app-suspension once
      activeCores = ['ws-pokemon']
      await controller.refresh()
      await controller.refresh()
      expect(blocker.start).toHaveBeenCalledTimes(1)
      expect(blocker.start).toHaveBeenCalledWith('prevent-app-suspension')
      expect(controller.getState()).toEqual({
        preventAppSuspension: true,
        blocking: true,
        activeCoreCount: 1,
      })

      // User disables preference: immediately releases blocker and persists to disk
      const afterDisable = await controller.setPreventAppSuspension(false)
      expect(afterDisable).toEqual({
        preventAppSuspension: false,
        blocking: false,
        activeCoreCount: 1,
      })
      expect(blocker.stop).toHaveBeenCalledTimes(1)
      expect(createPowerSavePreferenceStore(prefPath).get().preventAppSuspension).toBe(false)

      // User re-enables preference while Core is still active: re-acquires immediately
      const afterEnable = await controller.setPreventAppSuspension(true)
      expect(afterEnable.blocking).toBe(true)
      expect(blocker.start).toHaveBeenCalledTimes(2)

      // Core stops (idle): automatically releases
      activeCores = []
      await controller.refresh()
      expect(controller.getState().blocking).toBe(false)
      expect(blocker.stop).toHaveBeenCalledTimes(2)

      // Dispose releases any active blocker cleanly
      activeCores = ['ws-pokemon']
      await controller.refresh()
      expect(controller.getState().blocking).toBe(true)
      controller.dispose()
      expect(blocker.stop).toHaveBeenCalledTimes(3)
      expect(blocker.active.size).toBe(0)
      expect(states.length).toBeGreaterThanOrEqual(4)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
