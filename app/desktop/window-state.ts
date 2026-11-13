import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const DEFAULT_WINDOW_WIDTH = 1440
export const DEFAULT_WINDOW_HEIGHT = 940
export const MIN_WINDOW_WIDTH = 960
export const MIN_WINDOW_HEIGHT = 640

export interface DisplayArea {
  x: number
  y: number
  width: number
  height: number
}

export interface SavedWindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
  fullScreen: boolean
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(Math.max(value, min), max)
}

function sanitizeSize(width: number | undefined, height: number | undefined, area?: DisplayArea): { width: number; height: number } {
  const rawW = typeof width === 'number' && Number.isFinite(width) ? Math.round(width) : DEFAULT_WINDOW_WIDTH
  const rawH = typeof height === 'number' && Number.isFinite(height) ? Math.round(height) : DEFAULT_WINDOW_HEIGHT
  if (!area) {
    return {
      width: Math.max(MIN_WINDOW_WIDTH, rawW),
      height: Math.max(MIN_WINDOW_HEIGHT, rawH),
    }
  }
  const maxW = Math.max(1, Math.round(area.width))
  const maxH = Math.max(1, Math.round(area.height))
  return {
    width: clamp(rawW, Math.min(MIN_WINDOW_WIDTH, maxW), maxW),
    height: clamp(rawH, Math.min(MIN_WINDOW_HEIGHT, maxH), maxH),
  }
}

export function defaultWindowState(primaryWorkArea?: DisplayArea): SavedWindowState {
  const { width, height } = sanitizeSize(DEFAULT_WINDOW_WIDTH, DEFAULT_WINDOW_HEIGHT, primaryWorkArea)
  if (!primaryWorkArea) {
    return { width, height, maximized: false, fullScreen: false }
  }
  return {
    x: Math.round(primaryWorkArea.x + Math.max(0, (primaryWorkArea.width - width) / 2)),
    y: Math.round(primaryWorkArea.y + Math.max(0, (primaryWorkArea.height - height) / 2)),
    width,
    height,
    maximized: false,
    fullScreen: false,
  }
}

function intersectionArea(a: { x: number; y: number; width: number; height: number }, b: DisplayArea): number {
  const left = Math.max(a.x, b.x)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const top = Math.max(a.y, b.y)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  if (right <= left || bottom <= top) return 0
  return (right - left) * (bottom - top)
}

function bestMatchingWorkArea(rect: { x: number; y: number; width: number; height: number }, workAreas: readonly DisplayArea[]): DisplayArea | undefined {
  let best: DisplayArea | undefined
  let bestOverlap = 0
  for (const area of workAreas) {
    const overlap = intersectionArea(rect, area)
    if (overlap > bestOverlap) {
      bestOverlap = overlap
      best = area
    }
  }
  // Require at least a 120x80 visible intersection so a window dangling off an unplugged display resets cleanly.
  if (!best) return undefined
  const left = Math.max(rect.x, best.x)
  const right = Math.min(rect.x + rect.width, best.x + best.width)
  const top = Math.max(rect.y, best.y)
  const bottom = Math.min(rect.y + rect.height, best.y + best.height)
  return right - left >= Math.min(120, rect.width) && bottom - top >= Math.min(80, rect.height)
    ? best
    : undefined
}

export function clampWindowBounds(input: Partial<SavedWindowState> | null | undefined, workAreas: readonly DisplayArea[]): SavedWindowState {
  const maximized = Boolean(input?.maximized)
  const fullScreen = Boolean(input?.fullScreen)
  const primary = workAreas[0]
  const hasPosition = typeof input?.x === 'number' && Number.isFinite(input.x) && typeof input?.y === 'number' && Number.isFinite(input.y)

  if (!primary) {
    const size = sanitizeSize(input?.width, input?.height)
    return {
      ...(hasPosition ? { x: Math.round(input!.x!), y: Math.round(input!.y!) } : {}),
      ...size,
      maximized,
      fullScreen,
    }
  }

  if (hasPosition) {
    const candidateW = typeof input?.width === 'number' && Number.isFinite(input.width) ? Math.round(input.width) : DEFAULT_WINDOW_WIDTH
    const candidateH = typeof input?.height === 'number' && Number.isFinite(input.height) ? Math.round(input.height) : DEFAULT_WINDOW_HEIGHT
    const matched = bestMatchingWorkArea({ x: Math.round(input!.x!), y: Math.round(input!.y!), width: candidateW, height: candidateH }, workAreas)
    if (matched) {
      const size = sanitizeSize(candidateW, candidateH, matched)
      return {
        x: clamp(Math.round(input!.x!), matched.x, matched.x + matched.width - size.width),
        y: clamp(Math.round(input!.y!), matched.y, matched.y + matched.height - size.height),
        ...size,
        maximized,
        fullScreen,
      }
    }
  }

  const size = sanitizeSize(input?.width, input?.height, primary)
  return {
    x: Math.round(primary.x + Math.max(0, (primary.width - size.width) / 2)),
    y: Math.round(primary.y + Math.max(0, (primary.height - size.height) / 2)),
    ...size,
    maximized,
    fullScreen,
  }
}

export function loadWindowState(filePath: string, workAreas: readonly DisplayArea[]): SavedWindowState {
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<SavedWindowState>
    if (!raw || typeof raw !== 'object') return defaultWindowState(workAreas[0])
    return clampWindowBounds(raw, workAreas)
  } catch {
    return defaultWindowState(workAreas[0])
  }
}

const saveQueues = new Map<string, Promise<void>>()
let saveSequence = 0

export function saveWindowStateSync(filePath: string, state: SavedWindowState): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.${process.pid}.${++saveSequence}.sync.tmp`
  writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(tmpPath, filePath)
}

export async function saveWindowState(filePath: string, state: SavedWindowState): Promise<void> {
  const previous = saveQueues.get(filePath) ?? Promise.resolve()
  const payload = `${JSON.stringify(state, null, 2)}\n`
  const next = previous
    .catch(() => {})
    .then(async () => {
      await mkdir(dirname(filePath), { recursive: true })
      const tmpPath = `${filePath}.${process.pid}.${++saveSequence}.tmp`
      await writeFile(tmpPath, payload, 'utf8')
      await rename(tmpPath, filePath)
    })
  saveQueues.set(filePath, next)
  try {
    await next
  } finally {
    if (saveQueues.get(filePath) === next) {
      saveQueues.delete(filePath)
    }
  }
}
