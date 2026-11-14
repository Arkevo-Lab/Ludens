import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { consumerRecorder, ludensProjectId, LudensSource, type ActivityChanges, type ActivityRpcCaller } from './ludens-source.js'

const directories: string[] = []
function workspace() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ludens-pet-source-')))
  directories.push(directory)
  mkdirSync(join(directory, '.ludens'))
  writeFileSync(join(directory, '.ludens', 'workspace.json'), JSON.stringify({ version: 1, id: `ws-${randomUUID()}` }))
  return directory
}
function page(directory: string, overrides: Partial<ActivityChanges> = {}): ActivityChanges {
  return {
    scope: { project: ludensProjectId(directory), runId: 'run-a', epoch: 'epoch-a' }, mode: 'snapshot', cursor: 'opaque:42', hasMore: false,
    blocks: [{ id: 'tool', createdRevision: 10, revision: 42, kind: 'tool', at: '2026-10-17T13:40:00Z',
      title: 'Tool', text: 'streamed intent', status: 'running' }],
    projection: { source: { component: 'dashboard' }, throughSeq: 42, revision: 42, generation: 'generation-a',
      latestEventAt: '2026-10-17T13:40:00Z', latestSourceAt: '2026-10-17T13:40:00Z',
      generatedAt: '2026-10-17T13:40:00Z', durationMs: 2, blockCount: 1000 },
    current: { workspace: directory, runId: 'run-a', epoch: 'epoch-a', activity: 'running',
      phase: '等待模型首事件', intent: '查看证据', observationId: 'actual-model-input', updatedAt: '2026-10-17T13:40:00Z', error: null },
    ...overrides,
  }
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Ludens incremental activity source', () => {
  it('keeps the persisted workspace identity after relocation and rejects missing identity files', () => {
    const directory = workspace(), project = ludensProjectId(directory)
    const source = new LudensSource({ workspace: directory, dashboardUrl: 'ludens-app://console/', onSnapshot: () => {} })
    const relocated = directory + '-moved'; renameSync(directory, relocated); directories.push(relocated)
    expect(ludensProjectId(relocated)).toBe(project)
    const moved = new LudensSource({ workspace: relocated, dashboardUrl: 'ludens-app://console/', onSnapshot: () => {} })
    expect(moved.identity()).toBe(source.identity())
    source.stop(); moved.stop()
    rmSync(join(relocated, '.ludens', 'workspace.json'))
    expect(() => ludensProjectId(relocated)).toThrow()
  })

  it('calls activity/get over RPC, maps observation media to ludens-media://, and commits cursor only after acceptance', async () => {
    const directory = workspace(), link = directory + '-link'; symlinkSync(directory, link); directories.push(link)
    const onSnapshot = vi.fn(), response = page(directory)
    const call = vi.fn().mockResolvedValue(response)
    const rpc: ActivityRpcCaller = { call }
    const source = new LudensSource({ workspace: link, dashboardUrl: 'ludens-app://console/', rpc, onSnapshot })

    const first = await source.read()
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenNthCalledWith(
      1,
      'activity/get',
      { project: ludensProjectId(directory), query: { mode: 'changes' } },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(first).toMatchObject({ mode: 'snapshot', revision: 42, blocks: response.blocks })
    expect(first.current).toMatchObject({ workspace: directory, phase: '等待模型首事件', intent: '查看证据' })
    expect(first.current.observationUrl).toBe(
      `ludens-media://local/media?kind=asset&project=${encodeURIComponent(ludensProjectId(directory))}&run=run-a&id=actual-model-input`,
    )
    expect(first.current.dashboardUrl).toBe(
      `ludens-app://console/?project=${encodeURIComponent(ludensProjectId(directory))}&run=run-a&epoch=epoch-a`,
    )
    expect(onSnapshot).toHaveBeenLastCalledWith(first.current)
    expect(first.current).not.toHaveProperty('blocks')

    await source.read()
    expect((call.mock.calls[1][1] as { query?: { cursor?: string } }).query?.cursor).toBeUndefined()
    first.acknowledge!()
    await source.read()
    expect((call.mock.calls[2][1] as { query?: { cursor?: string } }).query?.cursor).toBe('opaque:42')

    call.mockRejectedValueOnce(new Error('connection refused'))
    expect(await source.read()).toMatchObject({
      activity: 'offline',
      mode: 'delta',
      blocks: [],
      hasMore: false,
      current: { phase: '日志服务离线', error: 'Error: connection refused' },
    })
    source.stop()
  })

  it('passes delta pages and current state directly, including cursor reset after an index generation changes', async () => {
    const directory = workspace(), first = page(directory)
    const delta = page(directory, {
      mode: 'delta',
      cursor: 'opaque:43',
      hasMore: true,
      blocks: [{ ...first.blocks[0], revision: 43, text: 'complete text', status: 'complete' }],
      projection: { ...first.projection, revision: 43 },
      current: { ...first.current, activity: 'manual', phase: '已交还控制权', observationId: null },
    })
    const reset = page(directory, { projection: { ...first.projection, generation: 'generation-b' }, cursor: 'new:42' })
    const call = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(delta)
      .mockResolvedValueOnce(reset)
    const source = new LudensSource({
      workspace: directory,
      dashboardUrl: 'ludens-app://console',
      rpc: { call },
      onSnapshot: () => {},
    })
    const initial = await source.read(); initial.acknowledge!()
    const changes = await source.read(); changes.acknowledge!()
    expect(changes).toMatchObject({ mode: 'delta', revision: 43, hasMore: true, blocks: delta.blocks, activity: 'manual' })
    expect(changes.current.observationUrl).toBeNull()
    const rebuilt = await source.read()
    expect(rebuilt.mode).toBe('snapshot')
    expect(rebuilt.identity).not.toBe(initial.identity)
    expect((call.mock.calls[2][1] as { query?: { cursor?: string } }).query?.cursor).toBe('opaque:43')
    source.stop()
  })

  it('accepts an empty workspace without requesting a catalog or full run', async () => {
    const directory = workspace(), empty = page(directory)
    empty.scope.runId = null; empty.scope.epoch = null; empty.blocks = []; empty.cursor = null
    empty.current = { ...empty.current, runId: null, epoch: null, activity: 'idle', phase: '工作区尚无运行记录', observationId: null }
    const call = vi.fn().mockResolvedValue(empty)
    const source = new LudensSource({
      workspace: directory,
      dashboardUrl: 'ludens-app://console',
      rpc: { call },
      onSnapshot: () => {},
    })
    expect(await source.read()).toMatchObject({ activity: 'idle', blocks: [], current: { workspace: directory, runId: null } })
    expect(call).toHaveBeenCalledTimes(1)
    source.stop()
  })

  it('keeps runtime failures in blocks without treating a healthy log feed as a consumer error', async () => {
    const directory = workspace(), response = page(directory), onSnapshot = vi.fn()
    response.current = { ...response.current, activity: 'manual', phase: '已交还控制权', error: 'Invalid channel/value: A=true' }
    response.blocks = [{ ...response.blocks[0], status: 'error', text: response.current.error! }]
    const call = vi.fn()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce(response)
    const source = new LudensSource({
      workspace: directory,
      dashboardUrl: 'ludens-app://console',
      rpc: { call },
      onSnapshot,
    })
    expect((await source.read()).current.error).toContain('connection refused')
    const recovered = await source.read()
    expect(recovered).toMatchObject({ activity: 'manual', blocks: response.blocks, current: { error: null } })
    expect(onSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ error: null, phase: '已交还控制权' }))
    source.stop()
  })

  it('does not publish stale data after cancellation or stop', async () => {
    const directory = workspace(), onSnapshot = vi.fn(), abort = new AbortController()
    const call = vi.fn(async () => {
      abort.abort(new Error('switched workspace'))
      return page(directory)
    })
    const source = new LudensSource({
      workspace: directory,
      dashboardUrl: 'ludens-app://console',
      rpc: { call },
      onSnapshot,
    })
    await expect(source.read(abort.signal)).rejects.toThrow('switched workspace')
    expect(onSnapshot).not.toHaveBeenCalled()
    source.stop()
    await expect(source.read()).rejects.toThrow()
    expect(onSnapshot).not.toHaveBeenCalled()
  })

  it('rejects data from a different workspace without advancing its cursor', async () => {
    const directory = workspace(), response = page(directory)
    response.current.workspace = '/another-workspace'
    const source = new LudensSource({
      workspace: directory,
      dashboardUrl: 'ludens-app://console',
      rpc: { call: vi.fn().mockResolvedValue(response) },
      onSnapshot: () => {},
    })
    const result = await source.read()
    expect(result).toMatchObject({ activity: 'offline', blocks: [] })
    expect(result.current.error).toContain('当前工作区')
    expect(result.acknowledge).toBeUndefined()
    source.stop()
  })

  it('records cursor progress and failures once without a block-history fingerprint', async () => {
    const directory = workspace(), response = page(directory)
    let fail = false
    const source = new LudensSource({
      workspace: directory,
      dashboardUrl: 'ludens-app://console',
      rpc: {
        call: vi.fn(async () => {
          if (fail) throw new Error('connection refused')
          return response
        }),
      },
      onSnapshot: () => {},
      record: consumerRecorder(directory),
    })
    await source.read(); await source.read()
    fail = true; await source.read(); await source.read()
    const files = readdirSync(join(directory, 'logs', 'consumers'))
    expect(files).toHaveLength(1)
    const rows = readFileSync(join(directory, 'logs', 'consumers', files[0]), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(rows.map(row => row.type)).toEqual(['read', 'read_error'])
    expect(rows[0]).toMatchObject({
      source: { component: 'pet' },
      runId: 'run-a',
      seq: 1,
      trace: { epoch: 'epoch-a' },
      data: { projection: { throughSeq: 42, revision: 42 }, revision: 42, blocks: 1 },
    })
    expect(rows[0].origin.clockId).toBe(rows[1].origin.clockId)
    expect(rows[1].data.error).toContain('connection refused')
    source.stop()
  })
})
