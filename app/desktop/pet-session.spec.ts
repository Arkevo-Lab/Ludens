import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LudensServerEvent } from '@ludens/protocol/app-rpc'
import { DEFAULT_ACTIVITY_PREFERENCES } from './activity-policy.js'
import { LudensActivityController } from './ludens-activity-controller.js'
import type { LudensActivitySnapshot, LudensPetSnapshot } from './ludens-source.js'
import { extractProjectFromUrl, PetSessionCoordinator, type PetRpcClient, type PetTarget } from './pet-session.js'

function target(name: string): PetTarget {
  return { project: `ws-${name}`, workspace: `/${name}`, revision: name, updatedAt: '2026-10-20T00:00:00Z' }
}

function snapshot(name: string): LudensActivitySnapshot {
  const blocks = [{ id: name, kind: 'text' as const, title: name, text: name, status: 'running' as const, at: '', createdRevision: 1, revision: 1 }]
  return {
    identity: `${name}:run:epoch`,
    activity: 'running',
    blocks,
    mode: 'delta',
    revision: 1,
    hasMore: false,
    current: {
      workspace: `/${name}`,
      runId: `run-${name}`,
      epoch: 'epoch',
      phase: name,
      intent: null,
      observationUrl: null,
      updatedAt: null,
      error: null,
      dashboardUrl: 'ludens-app://console',
    },
  }
}

const directories: string[] = []

afterEach(() => {
  vi.useRealTimers()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('shared Pet follow target over UDS RPC', () => {
  it('extracts project query parameter safely for custom ludens-app:// origins', () => {
    expect(extractProjectFromUrl('ludens-app://console/?project=ws-alpha&view=live', 'ludens-app://console')).toBe('ws-alpha')
    expect(extractProjectFromUrl('ludens-app://other/?project=ws-alpha', 'ludens-app://console')).toBeNull()
    expect(extractProjectFromUrl('http://127.0.0.1:3015/?project=ws-beta', 'http://127.0.0.1:3015')).toBe('ws-beta')
  })

  it('can stay open without a workspace, reports idle, and recovers from offline RPC daemon', async () => {
    const heartbeats: unknown[] = [], createSource = vi.fn(), onSnapshot = vi.fn()
    let offline = true
    const rpc: PetRpcClient = {
      call: vi.fn(async (method, params) => {
        if (offline) throw new Error('offline')
        if (method === 'pet/recordConsumer') heartbeats.push(params)
        if (method === 'pet/getState') return { target: null } as never
        return {} as never
      }),
    }
    const session = new PetSessionCoordinator({
      dashboardUrl: 'ludens-app://console/',
      rpc,
      createSource,
      onSnapshot,
      onTargetChanged: () => {},
    })
    await session.pollTarget()
    expect((await session.read()).current.error).toContain('offline')
    offline = false
    await session.pollTarget()
    await session.heartbeat()
    expect(await session.read()).toMatchObject({
      activity: 'idle',
      blocks: [],
      current: { workspace: null, runId: null, error: null, dashboardUrl: 'ludens-app://console/' },
    })
    expect(createSource).not.toHaveBeenCalled()
    expect(heartbeats.at(-1)).toMatchObject({
      pid: process.pid,
      revision: null,
      targetRevision: null,
      workspace: null,
      runId: null,
      phase: 'idle',
      error: null,
    })
    session.stop()
  })

  it('switches immediately during an old read, clears its bubble, and rejects late old callbacks and results', async () => {
    let selected: PetTarget | null = target('a')
    const heartbeats: unknown[] = [], stops: string[] = [], publications: LudensPetSnapshot[] = []
    const callbacks = new Map<string, (snapshot: LudensPetSnapshot) => void>()
    const pending = new Map<string, (snapshot: LudensActivitySnapshot) => void>()
    const rpc: PetRpcClient = {
      call: vi.fn(async (method, params) => {
        if (method === 'pet/recordConsumer') heartbeats.push(params)
        if (method === 'pet/getState') return { target: selected } as never
        return {} as never
      }),
    }
    const sent: unknown[] = []
    let controller!: LudensActivityController
    const session = new PetSessionCoordinator({
      dashboardUrl: 'ludens-app://console/',
      rpc,
      onSnapshot: value => publications.push(value),
      onTargetChanged: () => { void controller.poll() },
      createSource: (workspace, onSnapshot) => {
        callbacks.set(workspace, onSnapshot)
        return {
          identity: () => workspace,
          stop: () => { stops.push(workspace) },
          read: () => new Promise(resolve => { pending.set(workspace, resolve) }),
        }
      },
    })
    controller = new LudensActivityController(
      session,
      { petVisible: () => true, foreground: () => false, send: (_surface, event) => sent.push(event), open: () => {} },
      structuredClone(DEFAULT_ACTIVITY_PREFERENCES),
    )

    await session.pollTarget()
    callbacks.get('/a')!(snapshot('a').current)
    pending.get('/a')!(snapshot('a'))
    await Promise.resolve(); await Promise.resolve()
    expect(sent.at(-1)).toMatchObject({ type: 'show', input: { id: 'a' } })

    const oldRead = controller.poll()
    selected = target('b')
    await session.pollTarget()
    expect(stops).toEqual(['/a'])
    expect(sent.at(-1)).toMatchObject({ type: 'hide' })
    expect(pending.has('/b')).toBe(true)

    const afterSwitch = publications.length
    callbacks.get('/a')!(snapshot('old-late').current)
    pending.get('/a')!(snapshot('old-late'))
    await oldRead
    expect(publications).toHaveLength(afterSwitch)

    callbacks.get('/b')!(snapshot('b').current)
    pending.get('/b')!(snapshot('b'))
    await Promise.resolve(); await Promise.resolve()
    expect(sent.at(-1)).toMatchObject({ type: 'show', input: { id: 'b' } })

    await session.heartbeat()
    expect(heartbeats.at(-1)).toMatchObject({
      pid: process.pid,
      revision: 'b',
      targetRevision: 'b',
      workspace: '/b',
      runId: 'run-b',
      phase: 'following',
    })

    selected = null
    await session.pollTarget()
    expect(sent.at(-1)).toMatchObject({ type: 'hide' })
    expect((await session.read()).current.workspace).toBeNull()
    controller.stop()
  })

  it('uses launch workspace as ifUnset initialization and reacts immediately to pushed pet/catalog events', async () => {
    vi.useFakeTimers()
    const workspace = mkdtempSync(join(tmpdir(), 'ludens-pet-launch-')), project = `ws-${randomUUID()}`
    directories.push(workspace); mkdirSync(join(workspace, '.ludens'))
    writeFileSync(join(workspace, '.ludens', 'workspace.json'), JSON.stringify({ version: 1, id: project }))

    let selected = target('saved')
    const calls: Array<{ method: string; params: unknown }> = []
    const eventListeners = new Set<(event: LudensServerEvent) => void>()
    const changed = vi.fn()
    const snapshots: LudensPetSnapshot[] = []

    const rpc: PetRpcClient = {
      call: vi.fn(async (method, params) => {
        calls.push({ method, params })
        if (method === 'pet/setTarget') return { target: selected } as never
        if (method === 'pet/recordConsumer') return { consumer: params } as never
        if (method === 'events/subscribe') return { subscribedTopics: ['pet', 'catalog', 'core'] } as never
        return { target: selected, consumer: null, connected: null, consumerError: 'Unreadable heartbeat' } as never
      }),
      onEvent: listener => {
        eventListeners.add(listener)
        return () => eventListeners.delete(listener)
      },
    }

    const session = new PetSessionCoordinator({
      dashboardUrl: 'ludens-app://console/',
      rpc,
      onSnapshot: value => snapshots.push(value),
      onTargetChanged: changed,
      createSource: ws => ({ identity: () => ws, read: () => new Promise(() => {}) }),
    })

    await session.start(workspace)
    expect(calls[0]).toEqual({ method: 'pet/setTarget', params: { project, ifUnset: true } })
    expect(calls.some(c => c.method === 'events/subscribe')).toBe(true)
    expect(snapshots.at(-1)?.workspace).toBe('/saved')

    // Self-echoed recordConsumer event should not trigger redundant polling
    const callsBeforeEcho = calls.length
    for (const listener of eventListeners) {
      listener({ topic: 'pet', seq: 1, at: '', payload: { action: 'recordConsumer' } })
    }
    await Promise.resolve()
    expect(calls.length).toBe(callsBeforeEcho)

    // External setTarget push event immediately switches target before fallback timer
    selected = target('next')
    for (const listener of eventListeners) {
      listener({ topic: 'pet', seq: 2, at: '', payload: { action: 'setTarget' } })
    }
    await vi.waitFor(() => {
      expect(changed).toHaveBeenCalledTimes(2)
    })

    expect(calls.filter(call => call.method === 'pet/setTarget')).toHaveLength(1)
    session.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('attributes a failed source attempt to its selection without claiming that revision loaded', async () => {
    let selected = target('a')
    const heartbeats: unknown[] = [], publications: LudensPetSnapshot[] = []
    const rpc: PetRpcClient = {
      call: vi.fn(async (method, params) => {
        if (method === 'pet/recordConsumer') {
          heartbeats.push(params)
          return { consumer: params } as never
        }
        return { target: selected, consumer: null, connected: false } as never
      }),
    }
    const session = new PetSessionCoordinator({
      dashboardUrl: 'ludens-app://console/',
      rpc,
      onSnapshot: s => publications.push(s),
      onTargetChanged: () => {},
      createSource: () => { throw new Error('Cannot open workspace') },
    })
    try {
      await session.pollTarget()
      await session.heartbeat()
      expect(heartbeats.at(-1)).toMatchObject({
        workspace: '/a',
        revision: null,
        targetRevision: 'a',
        phase: 'error',
        error: 'Error: Cannot open workspace',
      })
      selected = { ...selected, revision: 'a-next' }
      await session.pollTarget()
      await session.heartbeat()
      expect(heartbeats.at(-1)).toMatchObject({
        workspace: '/a',
        revision: null,
        targetRevision: 'a-next',
        phase: 'error',
      })
      expect(publications.at(-1)?.error).toContain('Cannot open workspace')
    } finally {
      session.stop()
    }
  })

  it('does not consume an unavailable saved target, stops an existing source, and resumes only after valid read', async () => {
    const selected = target('saved'), methods: string[] = [], stop = vi.fn()
    let unavailable = true
    const createSource = vi.fn(() => ({ identity: () => '/saved', read: async () => snapshot('saved'), stop }))
    const rpc: PetRpcClient = {
      call: vi.fn(async (method, params) => {
        methods.push(method)
        if (method === 'pet/recordConsumer') return { consumer: params } as never
        return { target: selected, targetUnavailable: unavailable, consumer: null, connected: false } as never
      }),
    }
    const session = new PetSessionCoordinator({
      dashboardUrl: 'ludens-app://console/',
      rpc,
      createSource,
      onSnapshot: () => {},
      onTargetChanged: () => {},
    })
    try {
      await session.pollTarget()
      expect(createSource).not.toHaveBeenCalled()
      expect((await session.read()).current.workspace).toBeNull()
      unavailable = false
      await session.pollTarget()
      expect(createSource).toHaveBeenCalledTimes(1)
      expect(createSource).toHaveBeenCalledWith('/saved', expect.any(Function))
      unavailable = true
      await session.pollTarget()
      expect(stop).toHaveBeenCalledTimes(1)
      expect((await session.read()).current.workspace).toBeNull()
      unavailable = false
      await session.pollTarget()
      expect(createSource).toHaveBeenCalledTimes(2)
      expect(methods).not.toContain('pet/setTarget')
    } finally {
      session.stop()
    }
  })

  it('auto-follows active Cores via catalog/get RPC when targetConfigured is false', async () => {
    const heartbeats: unknown[] = []
    const rpc: PetRpcClient = {
      call: vi.fn(async (method, params) => {
        if (method === 'pet/getState') {
          return { target: null, targetConfigured: false } as never
        }
        if (method === 'catalog/get') {
          expect(params).toEqual({ includeEmpty: true })
          return [
            {
              id: 'proj-idle',
              workspace: '/idle',
              available: true,
              core: { online: false },
            },
            {
              id: 'proj-auto',
              workspace: '/auto-ws',
              available: true,
              core: { online: true, mode: 'auto', pendingOutbound: 0 },
            },
          ] as never
        }
        if (method === 'pet/recordConsumer') {
          heartbeats.push(params)
          return { consumer: params } as never
        }
        return {} as never
      }),
    }
    const created: string[] = []
    const session = new PetSessionCoordinator({
      dashboardUrl: 'ludens-app://console/',
      rpc,
      onSnapshot: () => {},
      onTargetChanged: () => {},
      createSource: ws => {
        created.push(ws)
        return { identity: () => ws, read: () => new Promise(() => {}) }
      },
    })
    try {
      await session.pollTarget()
      await session.heartbeat()
      expect(created).toEqual(['/auto-ws'])
      expect(heartbeats.at(-1)).toMatchObject({
        targetRevision: 'auto:proj-auto',
        workspace: '/auto-ws',
        autoFollowing: true,
      })
    } finally {
      session.stop()
    }
  })
})
