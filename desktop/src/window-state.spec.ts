import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clampWindowBounds,
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  defaultWindowState,
  loadWindowState,
  saveWindowState,
  saveWindowStateSync,
  type DisplayArea,
} from './window-state.js'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('window-state', () => {
  const primary: DisplayArea = { x: 0, y: 0, width: 1920, height: 1080 }
  const secondary: DisplayArea = { x: 1920, y: 0, width: 2560, height: 1440 }

  it('creates centered default 1440x940 window state', () => {
    const state = defaultWindowState(primary)
    expect(state).toEqual({
      x: 240,
      y: 70,
      width: DEFAULT_WINDOW_WIDTH,
      height: DEFAULT_WINDOW_HEIGHT,
      maximized: false,
      fullScreen: false,
    })
  })

  it('preserves valid position on a secondary monitor', () => {
    const state = clampWindowBounds(
      { x: 2000, y: 120, width: 1200, height: 800, maximized: false, fullScreen: false },
      [primary, secondary],
    )
    expect(state).toEqual({
      x: 2000,
      y: 120,
      width: 1200,
      height: 800,
      maximized: false,
      fullScreen: false,
    })
  })

  it('falls back to centered primary workArea when external monitor is unplugged', () => {
    const state = clampWindowBounds(
      { x: 2100, y: 120, width: 1200, height: 800, maximized: true, fullScreen: false },
      [primary],
    )
    expect(state).toEqual({
      x: 360,
      y: 140,
      width: 1200,
      height: 800,
      maximized: true,
      fullScreen: false,
    })
  })

  it('clamps oversized dimensions to the target workArea', () => {
    const smallDisplay: DisplayArea = { x: 0, y: 0, width: 1280, height: 720 }
    const state = clampWindowBounds(
      { x: 20, y: 20, width: 1600, height: 1000, maximized: false, fullScreen: false },
      [smallDisplay],
    )
    expect(state.width).toBe(1280)
    expect(state.height).toBe(720)
    expect(state.x).toBe(0)
    expect(state.y).toBe(0)
  })

  it('atomically saves and loads window-state.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ludens-win-state-'))
    tempDirs.push(dir)
    const filePath = join(dir, 'nested', 'window-state.json')

    await saveWindowState(filePath, {
      x: 150,
      y: 90,
      width: 1300,
      height: 860,
      maximized: true,
      fullScreen: false,
    })

    const raw = JSON.parse(readFileSync(filePath, 'utf8'))
    expect(raw.width).toBe(1300)
    expect(raw.maximized).toBe(true)

    const loaded = loadWindowState(filePath, [primary])
    expect(loaded).toEqual({
      x: 150,
      y: 90,
      width: 1300,
      height: 860,
      maximized: true,
      fullScreen: false,
    })
  })

  it('returns default state when window-state.json is missing', () => {
    const loaded = loadWindowState('/nonexistent/path/window-state.json', [primary])
    expect(loaded).toEqual(defaultWindowState(primary))
  })

  it('serializes concurrent async saves and supports synchronous quit save', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ludens-win-state-race-'))
    tempDirs.push(dir)
    const filePath = join(dir, 'window-state.json')

    await Promise.all([
      saveWindowState(filePath, { x: 10, y: 10, width: 1000, height: 700, maximized: false, fullScreen: false }),
      saveWindowState(filePath, { x: 20, y: 20, width: 1100, height: 740, maximized: false, fullScreen: false }),
      saveWindowState(filePath, { x: 30, y: 30, width: 1240, height: 820, maximized: true, fullScreen: false }),
    ])

    expect(loadWindowState(filePath, [primary])).toEqual({
      x: 30,
      y: 30,
      width: 1240,
      height: 820,
      maximized: true,
      fullScreen: false,
    })

    saveWindowStateSync(filePath, {
      x: 80,
      y: 60,
      width: 1360,
      height: 880,
      maximized: false,
      fullScreen: true,
    })

    expect(loadWindowState(filePath, [primary])).toEqual({
      x: 80,
      y: 60,
      width: 1360,
      height: 880,
      maximized: false,
      fullScreen: true,
    })
  })
})
