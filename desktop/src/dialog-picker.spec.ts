import { describe, expect, it, vi } from 'vitest'
import {
  buildOpenDialogOptions,
  runDialogPickPath,
  sanitizePickPathOptions,
} from './dialog-picker.js'

describe('dialog-picker', () => {
  it('sanitizes directory picker options and enables createDirectory', () => {
    const sanitized = sanitizePickPathOptions({
      mode: 'directory',
      title: '  Select Workspace Folder  ',
      defaultPath: '/Users/demo/workspaces',
    })
    expect(sanitized).toEqual({
      mode: 'directory',
      title: 'Select Workspace Folder',
      defaultPath: '/Users/demo/workspaces',
    })
    expect(buildOpenDialogOptions(sanitized)).toEqual({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select Workspace Folder',
      defaultPath: '/Users/demo/workspaces',
    })
  })

  it('normalizes file extension filters and appends All Files fallback', () => {
    const sanitized = sanitizePickPathOptions({
      mode: 'file',
      title: 'Select ROM',
      extensions: ['.GBA', 'gbc', '.gb', 'gba', 'bad/ext'],
      filterName: 'Game ROMs',
    })
    expect(sanitized.extensions).toEqual(['gba', 'gbc', 'gb'])
    expect(buildOpenDialogOptions(sanitized)).toEqual({
      properties: ['openFile'],
      title: 'Select ROM',
      filters: [
        { name: 'Game ROMs', extensions: ['gba', 'gbc', 'gb'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    })
  })

  it('rejects malformed payloads and returns null on cancel', async () => {
    expect(() => sanitizePickPathOptions(null)).toThrow(/options object/)
    expect(() => sanitizePickPathOptions({ mode: 'save' })).toThrow(/mode/)

    const showOpenDialog = vi.fn().mockResolvedValueOnce({
      canceled: true,
      filePaths: ['/ignored'],
    })
    const cancelled = await runDialogPickPath(null, showOpenDialog as any, { mode: 'directory' })
    expect(cancelled).toBeNull()

    showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/Users/demo/roms/leafgreen.gba'],
    })
    const picked = await runDialogPickPath(null, showOpenDialog as any, {
      mode: 'file',
      extensions: ['gba'],
    })
    expect(picked).toBe('/Users/demo/roms/leafgreen.gba')
  })
})
