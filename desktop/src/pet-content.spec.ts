// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { briefNotification, type SerializedNotification } from './activity-policy.js'
import type { LogBlock } from './ludens-source.js'

// Exercise the exact classic script loaded by the native pet window.
const source = readFileSync(resolve('../client/public/companion/log-content.js'), 'utf8')
const i18n = readFileSync(resolve('../client/public/companion/companion-i18n.cjs'), 'utf8')
const render = new Function(`${i18n}\n${source}\nreturn (target, input, locale = 'zh') => renderLogContent(target, input, companionI18n[locale].activity);`)() as (target: HTMLElement, input: SerializedNotification, locale?: 'en' | 'zh') => void

function notification(kind: LogBlock['kind'], overrides: Partial<LogBlock> = {}): SerializedNotification {
  const block: LogBlock = { id: 'block-1', kind, at: '2026-10-17T17:00:00Z', title: `${kind} title`,
    text: `${kind} source text`, status: 'complete', ...overrides }
  return { id: block.id, title: block.title, description: block.text, status: 'info',
    duration: 4000, block }
}

let target: HTMLElement
beforeEach(() => {
  target = document.createElement('div')
  document.body.append(target)
})
afterEach(() => document.body.replaceChildren())

describe('pet log content', () => {
  it.each(['thinking', 'text', 'tool', 'system', 'diagnostic'] as const)('renders the existing %s kind', kind => {
    const input = notification(kind, kind === 'tool' ? { tool: { args: { command: 'inspect' } } }
      : kind === 'system' || kind === 'diagnostic' ? { data: { elapsedMs: 1300 } } : {})
    render(target, input)
    expect(target.dataset.kind).toBe(kind)
    expect(target.dataset.blockId).toBe('block-1')
    expect(target.querySelector('.log-title')?.textContent).toBe(`${kind} title`)
    expect(target.querySelector('.log-icon path')?.getAttribute('d')).toBeTruthy()
    expect(target.querySelector('.log-body')?.getAttribute('role')).toBe('region')
    if (kind === 'tool') expect(target.querySelector('.log-code')?.textContent).toBe('$ inspect')
    else if (kind === 'system' || kind === 'diagnostic') {
      expect(target.querySelector('dt')?.textContent).toBe('elapsedMs')
      expect(target.querySelector('dd')?.textContent).toBe('1300')
    } else expect(target.querySelector('.log-prose')?.textContent).toBe(`${kind} source text`)
  })

  it('retains all long text in the scrollable reading region', () => {
    const text = '先观察，再行动。\n'.repeat(500) + 'THE-END'
    render(target, notification('text', { text }))
    expect(target.querySelector('.log-prose')?.textContent).toBe(text)
    expect(target.querySelector<HTMLElement>('.log-body')?.tabIndex).toBe(0)
    expect(target.textContent).toContain('THE-END')
  })

  it('inserts source text, titles, tool fields and diagnostic values as text, never HTML', () => {
    const html = '<img src=x onerror="window.pwned=true"><script>window.pwned=true</script>'
    for (const input of [
      notification('text', { title: html, text: html }),
      notification('tool', { tool: { intent: html, args: { command: html }, result: html } }),
      notification('diagnostic', { data: { [html]: html } }),
    ]) {
      render(target, input)
      expect(target.textContent).toContain(html)
      expect(target.querySelectorAll('img, script, [onerror]')).toHaveLength(0)
    }
  })

  it('separates tool intent, structured arguments and a collapsed result', () => {
    render(target, notification('tool', { title: 'exec', tool: {
      intent: 'Inspect the nearby area', args: { command: 'sensor screen capture', delayMs: 200 },
      result: { exitCode: 0, stdout: 'captured' },
    } }))
    expect(target.querySelector('.log-intent')?.textContent).toBe('Inspect the nearby area')
    expect(target.querySelector('pre[aria-label="参数"]')?.textContent).toBe('$ sensor screen capture\n# delayMs: 200')
    const result = target.querySelector('details')!
    expect(result.open).toBe(false)
    expect(result.querySelector('summary')?.textContent).toBe('结果')
    expect(result.querySelector('pre')?.textContent).toBe('captured')
    expect(target.querySelector('.log-status')?.textContent).toBe('完成')
    expect(target.querySelector('.log-prose')).toBeNull()
  })

  it('omits empty tool args/results and shows localized executing fallback while running', () => {
    const emptyVariants = [
      { args: '', result: '' },
      { args: {}, result: { stdout: '' } },
      { args: null, result: { stdout: '  \n', stderr: '', exitCode: 0 } },
      { args: { command: '   ' }, result: { content: [] } },
    ]
    for (const tool of emptyVariants) {
      render(target, notification('tool', { id: 'bash-empty', title: 'bash', status: 'running', tool }))
      expect(target.querySelector('.log-code')).toBeNull()
      expect(target.querySelector('details')).toBeNull()
      expect(target.querySelector('.log-pending')?.textContent).toBe('正在执行…')

      render(target, notification('tool', { id: 'bash-empty-en', title: 'bash', status: 'running', tool }), 'en')
      expect(target.querySelector('.log-code')).toBeNull()
      expect(target.querySelector('details')).toBeNull()
      expect(target.querySelector('.log-pending')?.textContent).toBe('Executing…')

      render(target, notification('tool', { id: 'bash-done', title: 'bash', status: 'complete', tool }))
      expect(target.querySelector('.log-code')).toBeNull()
      expect(target.querySelector('details')).toBeNull()
      expect(target.querySelector('.log-pending')).toBeNull()
    }
  })

  it('formats shell command args and structured shell or MCP results cleanly', () => {
    render(target, notification('tool', {
      title: 'bash',
      tool: {
        args: { command: 'ludens-core controller' },
        result: { exitCode: 0, stdout: 'Controller released.\n', stderr: '' },
      },
    }))
    const argsText = target.querySelector('pre[aria-label="参数"]')?.textContent
    expect(argsText).toBe('$ ludens-core controller')
    expect(argsText).not.toContain('{')
    expect(argsText).not.toContain('}')
    expect(target.querySelector('details pre')?.textContent).toBe('Controller released.')

    render(target, notification('tool', {
      id: 'bash-fail',
      title: 'bash',
      status: 'error',
      tool: {
        args: { command: 'false' },
        result: { exitCode: 2, stdout: '', stderr: 'command failed\n' },
      },
    }))
    expect(target.querySelector('details')?.open).toBe(true)
    expect(target.querySelector('details pre')?.textContent).toBe('command failed\nexit 2')

    render(target, notification('tool', {
      id: 'mcp-tool',
      title: 'read',
      tool: {
        args: { path: '/tmp/notes.md', limit: 20 },
        result: { content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] },
      },
    }))
    expect(JSON.parse(target.querySelector('pre[aria-label="参数"]')!.textContent!)).toEqual({ path: '/tmp/notes.md', limit: 20 })
    expect(target.querySelector('details pre')?.textContent).toBe('first\nsecond')
  })

  it('keeps XSS payloads in command, intent, and structured tool results as pure text', () => {
    const html = '<img src=x onerror="window.pwned=true"><script>window.pwned=true</script>'
    for (const tool of [
      { intent: html, args: { command: html, note: html }, result: { stdout: html, stderr: html, exitCode: 1 } },
      { args: { command: html }, result: { content: [{ type: 'text', text: html }] } },
    ]) {
      render(target, notification('tool', { id: 'xss-tool', tool }))
      expect(target.textContent).toContain(html)
      expect(target.querySelectorAll('img, script, [onerror]')).toHaveLength(0)
    }
  })

  it('expands errors on first display and shows live status without inventing results', () => {
    render(target, notification('tool', { status: 'error', tool: { args: 'inspect', result: 'failed' } }))
    expect(target.querySelector('details')?.open).toBe(true)
    expect(target.dataset.status).toBe('error')
    expect(target.querySelector('.log-status')?.textContent).toBe('出错')
    render(target, notification('tool', { id: 'live', status: 'running', tool: { args: '{"command":' } }))
    expect(target.querySelector('.log-status')?.textContent).toBe('运行中')
    expect(target.querySelector('.log-code')?.textContent).toBe('{"command":')
    expect(target.querySelector('details')).toBeNull()
    render(target, notification('thinking', { id: 'thought', status: 'running' }))
    expect(target.querySelector('.log-stream')?.getAttribute('aria-label')).toBe('正在生成')
  })

  it('preserves result expansion, summary focus and reading position for updates of the same block', () => {
    const input = notification('tool', { status: 'running', tool: { args: 'inspect', result: 'first' } })
    render(target, input)
    target.querySelector('details')!.open = true
    target.querySelector<HTMLElement>('.log-body')!.scrollTop = 72
    target.querySelector<HTMLElement>('summary')!.focus()
    render(target, notification('tool', { status: 'complete', tool: { args: 'inspect', result: 'first\nsecond' } }))
    expect(target.querySelector('details')!.open).toBe(true)
    expect(target.querySelector<HTMLElement>('.log-body')!.scrollTop).toBe(72)
    expect(document.activeElement).toBe(target.querySelector('summary'))
    expect(target.querySelector('details pre')?.textContent).toBe('first\nsecond')
    target.querySelector('details')!.open = false
    render(target, input)
    expect(target.querySelector('details')!.open).toBe(false)
  })

  it('resets reading position and result expansion when switching blocks', () => {
    render(target, notification('tool', { tool: { args: 'cmd-1', result: 'old' } }))
    target.querySelector('details')!.open = true
    target.querySelector<HTMLElement>('.log-body')!.scrollTop = 99
    render(target, notification('tool', { id: 'block-2', tool: { args: 'cmd-2', result: 'new' } }))
    expect(target.dataset.blockId).toBe('block-2')
    expect(target.querySelector('details')!.open).toBe(false)
    expect(target.querySelector<HTMLElement>('.log-body')!.scrollTop).toBe(0)
  })

  it('auto-expands result details when a tool block has output but no intent or arguments', () => {
    render(target, notification('tool', { title: 'bash', status: 'running', tool: { args: '', result: 'Battle completed' } }))
    const details = target.querySelector('details')!
    expect(details).not.toBeNull()
    expect(details.open).toBe(true)
    expect(details.querySelector('pre')?.textContent).toBe('Battle completed')
  })

  it('preserves keyboard focus and scroll position in the reading region during streaming updates', () => {
    render(target, notification('thinking', { status: 'running', text: 'First thought.' }))
    const body = target.querySelector<HTMLElement>('.log-body')!
    body.scrollTop = 42
    body.focus()
    render(target, notification('thinking', { status: 'running', text: 'First thought. Then inspect.' }))
    const updated = target.querySelector<HTMLElement>('.log-body')!
    expect(document.activeElement).toBe(updated)
    expect(updated.scrollTop).toBe(42)
    expect(updated.textContent).toBe('First thought. Then inspect.')
  })

  it('labels manual control clearly while preserving its raw event fields', () => {
    render(target, notification('system', { title: 'control', data: { mode: 'manual', reason: 'timer expired', elapsedMs: 1800000 } }))
    expect(target.querySelector('.log-event')?.textContent).toBe('控制权已收回')
    const fields = Object.fromEntries([...target.querySelectorAll('dt')].map(term => [term.textContent, term.nextElementSibling?.textContent]))
    expect(fields).toEqual({ mode: 'manual', reason: 'timer expired', elapsedMs: '1800000' })
  })

  it('renders English status, tool and control chrome while preserving source content', () => {
    render(target, notification('tool', { title: '工具', status: 'running', tool: { args: 'inspect', result: 'ok' } }), 'en')
    expect(target.querySelector('.log-title')?.textContent).toBe('工具')
    expect(target.querySelector('.log-status')?.textContent).toBe('Running')
    expect(target.querySelector('pre')?.getAttribute('aria-label')).toBe('Arguments')
    expect(target.querySelector('summary')?.textContent).toBe('Result')
    render(target, notification('system', { title: 'control', data: { mode: 'manual' } }), 'en')
    expect(target.querySelector('.log-event')?.textContent).toBe('Control Reclaimed')
  })

  it.each(['en', 'zh'] as const)('preserves redacted manual connection status in %s', locale => {
    const brief = briefNotification(notification('system', {
      id: 'connected:manual', title: '本轮已结束，控制权已收回',
    }))
    render(target, brief, locale)
    expect(target.querySelector('.log-title')?.textContent).toBe(brief.title)
    expect(target.querySelector('.log-body')?.textContent).toBe('')
  })

  it('renders brief notifications without any private source fields', () => {
    const full = notification('tool', { title: 'PRIVATE tool name', text: 'PRIVATE source',
      tool: { intent: 'PRIVATE intent', args: { command: 'PRIVATE command' }, result: 'PRIVATE result' },
      data: { private: 'PRIVATE data' },
    })
    const brief = briefNotification(full)
    render(target, brief)
    expect(brief).not.toHaveProperty('block')
    expect(target.textContent).toContain('Activity updated')
    expect(target.innerHTML).not.toContain('PRIVATE')
    expect(target.querySelector('details')).toBeNull()
  })
})
