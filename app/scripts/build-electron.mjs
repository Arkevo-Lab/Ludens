import { build } from 'esbuild'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'

const esmEntries = ['main', 'companion-preview'].map(name => `desktop/${name}.ts`).filter(existsSync)
const cjsEntries = ['preload', 'companion-preload'].map(name => `desktop/${name}.ts`).filter(existsSync)

await build({
  entryPoints: esmEntries,
  outdir: 'dist/electron',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: ['electron'],
  sourcemap: true,
})

await build({
  entryPoints: cjsEntries,
  outdir: 'dist/electron',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['electron'],
  sourcemap: true,
})

mkdirSync('dist/electron', { recursive: true })
writeFileSync('dist/electron/package.json', JSON.stringify({ type: 'module' }, null, 2) + '\n')
