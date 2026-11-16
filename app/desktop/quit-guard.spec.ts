import { describe, expect, it, vi } from 'vitest'
import type { DaemonStatusResult } from '@ludens/protocol/app-rpc'
import {
  ActiveCoreQuitGuard,
  buildQuitDialogLabels,
  mapDialogButtonToQuitAction,
} from './quit-guard.js'

function mockStatus(activeCores: string[]): DaemonStatusResult {
  return {
    protocolVersion: '1.0',
    pid: 1234,
    home: '/tmp/.ludens',
    socketPath: '/tmp/.ludens/run/app-server.sock',
    wsUrl: null,
    authMode: 'none',
    serverSeq: 1,
    activeCores,
    managedWorkspaces: activeCores,
  }
}

describe('ActiveCoreQuitGuard', () => {
  it('localizes zh and en dialog buttons accurately', () => {
    const zh = buildQuitDialogLabels('zh-CN', 2)
    expect(zh.keepBackground).toBe('保持后台继续运行')
    expect(zh.stopAllAndQuit).toBe('停止所有 Core 并退出')
    expect(zh.cancel).toBe('取消')
    expect(zh.message).toContain('2')

    const en = buildQuitDialogLabels('en-US', 1)
    expect(en.keepBackground).toBe('Keep Running in Background')
    expect(en.stopAllAndQuit).toBe('Stop All Cores & Quit')
    expect(en.cancel).toBe('Cancel')
    expect(en.message).toContain('1 active Core')

    expect(mapDialogButtonToQuitAction(0)).toBe('keep-background')
    expect(mapDialogButtonToQuitAction(1)).toBe('stop-all')
    expect(mapDialogButtonToQuitAction(2)).toBe('cancel')
  })

  it('quits immediately without calling cores/stopAll when daemon has 0 active Cores or is unreachable', async () => {
    const stopAllCores = vi.fn()
    const promptUser = vi.fn()
    const onConfirmQuit = vi.fn()
    const triggerQuit = vi.fn()

    const guard = new ActiveCoreQuitGuard({
      getLocale: () => 'en-US',
      queryStatus: async () => mockStatus([]),
      stopAllCores,
      promptUser,
      onConfirmQuit,
      triggerQuit,
    })

    const firstPrevent = vi.fn()
    expect(guard.handleBeforeQuit({ preventDefault: firstPrevent })).toBe(false)
    expect(firstPrevent).toHaveBeenCalledTimes(1)
    await guard.pendingCheck()

    expect(promptUser).not.toHaveBeenCalled()
    expect(stopAllCores).not.toHaveBeenCalled()
    expect(onConfirmQuit).toHaveBeenCalledTimes(1)
    expect(triggerQuit).toHaveBeenCalledTimes(1)
    expect(guard.isQuitConfirmed()).toBe(true)

    // Subsequent before-quit proceeds synchronously without preventing exit
    const secondPrevent = vi.fn()
    expect(guard.handleBeforeQuit({ preventDefault: secondPrevent })).toBe(true)
    expect(secondPrevent).not.toHaveBeenCalled()
  })

  it('does not block quit when daemon/status query times out within <= 1500ms', async () => {
    vi.useFakeTimers()
    const onConfirmQuit = vi.fn()
    const triggerQuit = vi.fn()

    const guard = new ActiveCoreQuitGuard({
      getLocale: () => 'en-US',
      queryStatus: () => new Promise(() => {}),
      stopAllCores: vi.fn(),
      promptUser: vi.fn(),
      onConfirmQuit,
      triggerQuit,
      statusTimeoutMs: 1_200,
    })

    guard.handleBeforeQuit({ preventDefault: vi.fn() })
    await vi.advanceTimersByTimeAsync(1_200)
    await guard.pendingCheck()

    expect(onConfirmQuit).toHaveBeenCalledTimes(1)
    expect(triggerQuit).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('supports Keep Running in Background without stopping Cores when activeCores > 0', async () => {
    const stopAllCores = vi.fn()
    const onConfirmQuit = vi.fn()
    const triggerQuit = vi.fn()
    const promptUser = vi.fn(async () => 'keep-background' as const)

    const guard = new ActiveCoreQuitGuard({
      getLocale: () => 'zh-CN',
      queryStatus: async () => mockStatus(['ws-1']),
      stopAllCores,
      promptUser,
      onConfirmQuit,
      triggerQuit,
    })

    guard.handleBeforeQuit({ preventDefault: vi.fn() })
    await guard.pendingCheck()

    expect(promptUser).toHaveBeenCalledTimes(1)
    expect(stopAllCores).not.toHaveBeenCalled()
    expect(onConfirmQuit).toHaveBeenCalledTimes(1)
    expect(triggerQuit).toHaveBeenCalledTimes(1)
  })

  it('calls cores/stopAll then quits when user selects Stop All Cores & Quit', async () => {
    const order: string[] = []
    const guard = new ActiveCoreQuitGuard({
      getLocale: () => 'en-US',
      queryStatus: async () => mockStatus(['ws-1', 'ws-2']),
      stopAllCores: async () => {
        order.push('stop-all')
        return { stopped: ['ws-1', 'ws-2'] }
      },
      promptUser: async () => 'stop-all',
      onConfirmQuit: () => {
        order.push('confirm-quit')
      },
      triggerQuit: () => {
        order.push('trigger-quit')
      },
    })

    guard.handleBeforeQuit({ preventDefault: vi.fn() })
    await guard.pendingCheck()

    expect(order).toEqual(['stop-all', 'confirm-quit', 'trigger-quit'])
    expect(guard.isQuitConfirmed()).toBe(true)
  })

  it('stays open cleanly on Cancel and re-prompts on the next Cmd+Q without running cleanup', async () => {
    let choice: 'cancel' | 'keep-background' = 'cancel'
    const onConfirmQuit = vi.fn()
    const triggerQuit = vi.fn()
    const promptUser = vi.fn(async () => choice)

    const guard = new ActiveCoreQuitGuard({
      getLocale: () => 'zh-CN',
      queryStatus: async () => mockStatus(['ws-1']),
      stopAllCores: vi.fn(),
      promptUser,
      onConfirmQuit,
      triggerQuit,
    })

    // First Cmd+Q + duplicate rapid trigger while dialog open -> prompt once, cancel leaves app running
    const p1 = vi.fn()
    const p2 = vi.fn()
    guard.handleBeforeQuit({ preventDefault: p1 })
    guard.handleBeforeQuit({ preventDefault: p2 })
    expect(p1).toHaveBeenCalledTimes(1)
    expect(p2).toHaveBeenCalledTimes(1)
    await guard.pendingCheck()

    expect(promptUser).toHaveBeenCalledTimes(1)
    expect(onConfirmQuit).not.toHaveBeenCalled()
    expect(triggerQuit).not.toHaveBeenCalled()
    expect(guard.isQuitConfirmed()).toBe(false)

    // Second Cmd+Q re-checks and allows user to proceed
    choice = 'keep-background'
    guard.handleBeforeQuit({ preventDefault: vi.fn() })
    await guard.pendingCheck()
    expect(promptUser).toHaveBeenCalledTimes(2)
    expect(onConfirmQuit).toHaveBeenCalledTimes(1)
    expect(triggerQuit).toHaveBeenCalledTimes(1)
    expect(guard.isQuitConfirmed()).toBe(true)
  })
})
