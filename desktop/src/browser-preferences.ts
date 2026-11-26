import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { registeredWorkspace } from '@ludens/protocol/ludens'

export interface BrowserUrlPreferenceStore {
  readLastUrl(sessionId: string): Promise<string | undefined>
  writeLastUrl(sessionId: string, url: string): Promise<void>
}

interface StoredBrowserSessionEntry {
  lastUrl: string
  updatedAt: string
}

function isPersistableExternalUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (!trimmed) return false
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return isPlainObject(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

async function writeJsonAtomic(filePath: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.${randomUUID()}.tmp`
  try {
    await writeFile(tempPath, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
    await rename(tempPath, filePath)
  } finally {
    await rm(tempPath, { force: true }).catch(() => {})
  }
}

/**
 * Persists the most recent external (`http:`/`https:`) navigation URL per `sessionId`.
 * - Registered workspaces store it inside `<workspace>/.ludens/settings.json` under `browser.sessions[sessionId]`
 *   (preserving all existing workspace settings such as perception overrides).
 * - Unregistered / ad-hoc sessions fall back to `<home>/browser-preferences.json`.
 */
export function createBrowserUrlPreferenceStore(home: string): BrowserUrlPreferenceStore {
  const writeQueues = new Map<string, Promise<void>>()

  const resolveStoragePath = async (sessionId: string): Promise<{ path: string; isWorkspaceSettings: boolean }> => {
    try {
      const reg = await registeredWorkspace(sessionId, home)
      if (reg?.workspace) {
        return {
          path: join(reg.workspace, '.ludens', 'settings.json'),
          isWorkspaceSettings: true,
        }
      }
    } catch {
      // Fall back to home-level preferences when sessionId is not a registered workspace.
    }
    return {
      path: join(home, 'browser-preferences.json'),
      isWorkspaceSettings: false,
    }
  }

  const enqueue = (filePath: string, task: () => Promise<void>): Promise<void> => {
    const previous = writeQueues.get(filePath) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(task)
    writeQueues.set(filePath, next)
    void next.finally(() => {
      if (writeQueues.get(filePath) === next) {
        writeQueues.delete(filePath)
      }
    })
    return next
  }

  return {
    async readLastUrl(sessionId: string): Promise<string | undefined> {
      const trimmedId = sessionId.trim()
      if (!trimmedId) return undefined
      const { path, isWorkspaceSettings } = await resolveStoragePath(trimmedId)
      const pending = writeQueues.get(path)
      if (pending) await pending.catch(() => {})
      const doc = await readJsonObject(path)
      const container = isWorkspaceSettings ? (isPlainObject(doc.browser) ? doc.browser : null) : doc
      if (!container) return undefined
      const sessions = isPlainObject(container.sessions) ? container.sessions : null
      const entry = sessions && isPlainObject(sessions[trimmedId]) ? sessions[trimmedId] : null
      if (entry && isPersistableExternalUrl(entry.lastUrl)) {
        return entry.lastUrl.trim()
      }
      if (isWorkspaceSettings && isPersistableExternalUrl(container.lastUrl)) {
        return container.lastUrl.trim()
      }
      return undefined
    },

    async writeLastUrl(sessionId: string, url: string): Promise<void> {
      const trimmedId = sessionId.trim()
      if (!trimmedId || !isPersistableExternalUrl(url)) return
      const normalizedUrl = new URL(url.trim()).toString()
      const { path, isWorkspaceSettings } = await resolveStoragePath(trimmedId)
      await enqueue(path, async () => {
        const doc = await readJsonObject(path)
        const entry: StoredBrowserSessionEntry = {
          lastUrl: normalizedUrl,
          updatedAt: new Date().toISOString(),
        }
        if (isWorkspaceSettings) {
          const browser = isPlainObject(doc.browser) ? { ...doc.browser } : {}
          const sessions = isPlainObject(browser.sessions) ? { ...browser.sessions } : {}
          sessions[trimmedId] = entry
          browser.sessions = sessions
          browser.lastUrl = normalizedUrl
          doc.browser = browser
        } else {
          const sessions = isPlainObject(doc.sessions) ? { ...doc.sessions } : {}
          sessions[trimmedId] = entry
          doc.version = 1
          doc.sessions = sessions
        }
        await writeJsonAtomic(path, doc)
      })
    },
  }
}
