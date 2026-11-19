import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

const esmEntries = ['main', 'companion-preview'].map(name => `src/${name}.ts`).filter(existsSync)
const cjsEntries = ['preload', 'companion-preload'].map(name => `src/${name}.ts`).filter(existsSync)

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
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['electron'],
  sourcemap: true,
})

mkdirSync('dist/electron', { recursive: true })
writeFileSync('dist/electron/package.json', JSON.stringify({ type: 'module' }, null, 2) + '\n')

function resolveBunBinary() {
  if (process.env.LUDENS_BUN?.trim()) return process.env.LUDENS_BUN.trim()
  const binName = process.platform === 'win32' ? 'bun.exe' : 'bun'
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(dir, binName)
    if (existsSync(candidate)) return candidate
  }
  const fallbacks = [
    join(homedir(), '.bun', 'bin', binName),
    ...(process.platform === 'win32' ? [] : ['/opt/homebrew/bin/bun', '/usr/local/bin/bun']),
  ]
  for (const candidate of fallbacks) {
    if (existsSync(candidate)) return candidate
  }
  return binName
}

// Pre-build self-contained @ludens/server runtime bundle into dist/server/ for packaged Electron extraResources.
const serverMainEntry = resolve('../server/src/cli/main.ts')
const serverWorkerEntry = resolve('../server/src/query/worker.ts')
const serverColdBuilderEntry = resolve('../server/src/query/cold-builder.ts')
if (existsSync(serverMainEntry) && existsSync(serverWorkerEntry) && existsSync(serverColdBuilderEntry)) {
  rmSync('dist/server', { recursive: true, force: true })
  mkdirSync('dist/server', { recursive: true })
  const bun = resolveBunBinary()
  const result = spawnSync(
    bun,
    [
      'build',
      serverMainEntry,
      serverWorkerEntry,
      serverColdBuilderEntry,
      '--target=bun',
      '--splitting',
      '--external=omp-legacy-pi-modules',
      '--outdir=dist/server',
      '--entry-naming=[name].js',
    ],
    { stdio: 'inherit' },
  )
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`Bundling packaged server runtime failed (exit=${result.status ?? 'null'})`)
  }
  writeFileSync('dist/server/package.json', JSON.stringify({ type: 'module' }, null, 2) + '\n')
  // DashboardWorker & ColdBuilder resolve `./worker.ts` and `./cold-builder.ts` relative to import.meta.url.
  writeFileSync('dist/server/worker.ts', 'import "./worker.js";\n')
  writeFileSync('dist/server/cold-builder.ts', 'import "./cold-builder.js";\n')
}
