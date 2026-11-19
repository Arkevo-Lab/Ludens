import type { OpenDialogOptions, OpenDialogReturnValue, BrowserWindow } from 'electron'

export const LUDENS_DIALOG_PICK_PATH_CHANNEL = 'ludens:dialog:pick-path' as const

export interface DesktopPickPathOptions {
  mode: 'directory' | 'file'
  title?: string
  defaultPath?: string
  extensions?: string[]
  filterName?: string
}

export function sanitizePickPathOptions(raw: unknown): DesktopPickPathOptions {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('pickPath requires options object')
  }
  const candidate = raw as Record<string, unknown>
  if (candidate.mode !== 'directory' && candidate.mode !== 'file') {
    throw new Error("pickPath mode must be 'directory' or 'file'")
  }
  const cleanString = (value: unknown, maxLen = 512): string | undefined => {
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    if (!trimmed || trimmed.length > maxLen || trimmed.includes('\0')) return undefined
    return trimmed
  }

  let extensions: string[] | undefined
  if (Array.isArray(candidate.extensions)) {
    const normalized = candidate.extensions
      .filter((ext): ext is string => typeof ext === 'string')
      .map(ext => ext.trim().replace(/^\.+/, '').toLowerCase())
      .filter(ext => /^[a-z0-9][a-z0-9_-]{0,15}$/.test(ext))
    if (normalized.length > 0) {
      extensions = Array.from(new Set(normalized))
    }
  }

  return {
    mode: candidate.mode,
    ...(cleanString(candidate.title, 200) ? { title: cleanString(candidate.title, 200) } : {}),
    ...(cleanString(candidate.defaultPath, 1024)
      ? { defaultPath: cleanString(candidate.defaultPath, 1024) }
      : {}),
    ...(extensions ? { extensions } : {}),
    ...(cleanString(candidate.filterName, 120)
      ? { filterName: cleanString(candidate.filterName, 120) }
      : {}),
  }
}

export function buildOpenDialogOptions(options: DesktopPickPathOptions): OpenDialogOptions {
  const properties: OpenDialogOptions['properties'] =
    options.mode === 'directory'
      ? ['openDirectory', 'createDirectory']
      : ['openFile']

  const dialogOptions: OpenDialogOptions = {
    properties,
    ...(options.title ? { title: options.title } : {}),
    ...(options.defaultPath ? { defaultPath: options.defaultPath } : {}),
  }

  if (options.mode === 'file' && options.extensions && options.extensions.length > 0) {
    dialogOptions.filters = [
      {
        name: options.filterName ?? 'Supported Files',
        extensions: options.extensions,
      },
      {
        name: 'All Files',
        extensions: ['*'],
      },
    ]
  }

  return dialogOptions
}

export async function runDialogPickPath(
  owner: BrowserWindow | null | undefined,
  showOpenDialog: {
    (window: BrowserWindow, options: OpenDialogOptions): Promise<OpenDialogReturnValue>
    (options: OpenDialogOptions): Promise<OpenDialogReturnValue>
  },
  rawOptions: unknown,
): Promise<string | null> {
  const sanitized = sanitizePickPathOptions(rawOptions)
  const openOptions = buildOpenDialogOptions(sanitized)
  const result =
    owner && !owner.isDestroyed()
      ? await showOpenDialog(owner, openOptions)
      : await showOpenDialog(openOptions)
  if (result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
    return null
  }
  const picked = result.filePaths[0]
  return typeof picked === 'string' && picked.trim() ? picked : null
}
