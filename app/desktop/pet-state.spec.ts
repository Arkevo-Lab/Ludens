import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
const root = resolve('public/companion')
const source = readFileSync(resolve(root, 'pet-state.js'), 'utf8')
const create = new Function(`${source}\nreturn createPetState;`)()

describe('Ludens static poses', () => {
  it('idles, sleeps, wakes on interaction and resumes the selected pose', () => {
    let now = 0, visible: any
    const pet = create((value: any) => { visible = value }, () => now)
    pet.refresh(); expect(visible.state).toBe('01-idle')
    now = 30000; pet.refresh(); expect(visible.state).toBe('02-perch')
    now = 90000; pet.refresh(); expect(visible.state).toBe('04-drowsy')
    now = 120000; pet.refresh(); expect(visible).toEqual({ state: '05-sleep', effect: 'fx-sleep' })
    pet.choose('21-gaming', 'fx-stars')
    pet.interact('15-dragged', Infinity)
    now += 300000; pet.refresh(); expect(visible.state).toBe('15-dragged')
    pet.interact('16-land', 900)
    now += 901; pet.refresh(); expect(visible).toEqual({ state: '21-gaming', effect: 'fx-stars' })
    pet.choose(null); expect(visible.state).toBe('01-idle')
  })
  it('uses visible log facts, prioritizes interaction and clears activity back to the selected pose', () => {
    let now = 0, visible: any
    const pet = create((value: any) => { visible = value }, () => now)
    pet.choose('22-hug-plush')
    pet.activity({ block: { kind: 'thinking', status: 'running' } })
    expect(visible.state).toBe('07-think')
    pet.interact('14-petted')
    pet.activity({ block: { kind: 'tool', status: 'running' } })
    expect(visible.state).toBe('14-petted')
    now = 2000; pet.refresh(); expect(visible.state).toBe('08-operate')
    pet.activity({ block: { kind: 'tool', status: 'complete' } }); expect(visible.state).toBe('10-success')
    pet.activity({ block: { kind: 'tool', status: 'error' } }); expect(visible.state).toBe('11-failure')
    pet.activity({ title: 'Activity updated', status: 'info' }); expect(visible.state).toBe('06-observe')
    pet.activity(null); expect(visible.state).toBe('22-hug-plush')
  })
  it('shows activity above gameplay and restores the selected pose after play', () => {
    let visible: { state: string; effect: string | null }
    const pet = create((value: { state: string; effect: string | null }) => { visible = value }, () => 0)
    pet.choose('22-hug-plush')
    pet.game(true)
    expect(visible).toEqual({ state: '21-gaming', effect: null })
    pet.activity({ block: { kind: 'thinking', status: 'running' } })
    expect(visible.state).toBe('07-think')
    pet.game(false)
    pet.activity(null)
    expect(visible.state).toBe('22-hug-plush')
  })
  it('ships every catalog entry and keeps the file-free renderer catalog identical', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'ludens/manifest.json'), 'utf8'))
    const catalog = new Function(readFileSync(resolve(root, 'ludens/catalog.js'), 'utf8') + ';return ludensCatalog;')()
    const copy: Record<'en' | 'zh', { assets: Record<string, string> }> = new Function(readFileSync(resolve(root, 'companion-i18n.cjs'), 'utf8') + ';return companionI18n;')()
    expect(catalog).toEqual(manifest)
    expect(new Set(manifest.assets.map((a: any) => a.id)).size).toBe(36)
    expect(manifest.assets.filter((a: any) => a.kind === 'state')).toHaveLength(24)
    for (const asset of manifest.assets) {
      for (const locale of ['en', 'zh'] as const) expect(copy[locale].assets[asset.id], `${locale} ${asset.id}`).toBeTypeOf('string')
      expect(existsSync(resolve(root, 'ludens', asset.file)), asset.file).toBe(true)
      if (asset.vector_file) expect(existsSync(resolve(root, 'ludens', asset.vector_file))).toBe(true)
    }
  })
})
