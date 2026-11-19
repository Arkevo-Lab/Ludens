import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
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

function runBunBuild(bun, args, label) {
  const result = spawnSync(bun, ['build', ...args], { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`Bundling ${label} failed (exit=${result.status ?? 'null'})`)
  }
}

function writePosixBin(path, relativeEntry) {
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      'set -eu',
      'SCRIPT=$0',
      'while [ -L "$SCRIPT" ]; do',
      '  DIRECTORY=$(CDPATH= cd -P -- "$(dirname -- "$SCRIPT")" && pwd)',
      '  SCRIPT=$(readlink "$SCRIPT")',
      '  case "$SCRIPT" in /*) ;; *) SCRIPT=$DIRECTORY/$SCRIPT ;; esac',
      'done',
      'PKG_ROOT=$(CDPATH= cd -P -- "$(dirname -- "$SCRIPT")/.." && pwd)',
      `exec "\${LUDENS_BUN:-bun}" "$PKG_ROOT/${relativeEntry}" "$@"`,
      '',
    ].join('\n'),
  )
  chmodSync(path, 0o755)
}

function writeWinCmdBin(path, relativeWinEntry) {
  writeFileSync(
    path,
    [
      '@echo off',
      'setlocal',
      'if defined LUDENS_BUN goto :custom_bun',
      `bun "%~dp0..\\${relativeWinEntry}" %*`,
      'exit /b %ERRORLEVEL%',
      ':custom_bun',
      `"%LUDENS_BUN%" "%~dp0..\\${relativeWinEntry}" %*`,
      'exit /b %ERRORLEVEL%',
      '',
    ].join('\r\n'),
  )
}

const bun = resolveBunBinary()

// 1. Pre-build self-contained @ludens/server runtime bundle into dist/server/ for packaged Electron extraResources.
const serverMainEntry = resolve('../server/src/cli/main.ts')
const serverWorkerEntry = resolve('../server/src/query/worker.ts')
const serverColdBuilderEntry = resolve('../server/src/query/cold-builder.ts')
if (existsSync(serverMainEntry) && existsSync(serverWorkerEntry) && existsSync(serverColdBuilderEntry)) {
  rmSync('dist/server', { recursive: true, force: true })
  mkdirSync('dist/server', { recursive: true })
  runBunBuild(
    bun,
    [
      serverMainEntry,
      serverWorkerEntry,
      serverColdBuilderEntry,
      '--target=bun',
      '--splitting',
      '--external=omp-legacy-pi-modules',
      '--outdir=dist/server',
      '--entry-naming=[name].js',
    ],
    'packaged server runtime',
  )
  writeFileSync('dist/server/package.json', JSON.stringify({ name: '@ludens/server', type: 'module' }, null, 2) + '\n')
  // DashboardWorker & ColdBuilder resolve `./worker.ts` and `./cold-builder.ts` relative to import.meta.url.
  writeFileSync('dist/server/worker.ts', 'import "./worker.js";\n')
  writeFileSync('dist/server/cold-builder.ts', 'import "./cold-builder.js";\n')
}

// 2. Pre-build self-contained @ludens/core CLI bundle into dist/core/ so Resources/core/bin/ludens-core runs without node_modules.
const coreMainEntry = resolve('../core/src/cli/main.ts')
if (existsSync(coreMainEntry)) {
  rmSync('dist/core', { recursive: true, force: true })
  mkdirSync('dist/core/src/cli', { recursive: true })
  mkdirSync('dist/core/bin', { recursive: true })
  runBunBuild(
    bun,
    [
      coreMainEntry,
      '--target=bun',
      '--splitting',
      '--external=omp-legacy-pi-modules',
      '--outdir=dist/core',
      '--entry-naming=[name].js',
    ],
    'packaged core runtime',
  )
  writeFileSync('dist/core/package.json', JSON.stringify({ name: '@ludens/core', type: 'module' }, null, 2) + '\n')
  writeFileSync('dist/core/src/cli/main.ts', 'import "../../main.js";\n')
  writePosixBin('dist/core/bin/ludens-core', 'main.js')
  writeWinCmdBin('dist/core/bin/ludens-core.cmd', 'main.js')
  for (const subdir of ['prompts', 'templates', 'python']) {
    const srcDir = resolve('../core', subdir)
    if (existsSync(srcDir)) {
      cpSync(srcDir, join('dist/core', subdir), {
        recursive: true,
        filter: p => !p.includes('/.venv') && !p.includes('/__pycache__') && !p.includes('\\.venv') && !p.includes('\\__pycache__'),
      })
    }
  }
}

// 3. Pre-build self-contained @ludens/baseware CLI bundle into dist/baseware/ so Resources/baseware/bin/baseware runs without node_modules.
const basewareMainEntry = resolve('../baseware/src/main.ts')
if (existsSync(basewareMainEntry)) {
  rmSync('dist/baseware', { recursive: true, force: true })
  mkdirSync('dist/baseware/src', { recursive: true })
  mkdirSync('dist/baseware/bin', { recursive: true })
  runBunBuild(
    bun,
    [
      basewareMainEntry,
      '--target=bun',
      '--outfile=dist/baseware/main.js',
    ],
    'packaged baseware runtime',
  )
  writeFileSync('dist/baseware/package.json', JSON.stringify({ name: '@ludens/baseware', type: 'module' }, null, 2) + '\n')
  // Duplicate the self-contained single-file bundle at src/main.ts so `import.meta.main` stays true under Windows cliCommand fallback.
  cpSync('dist/baseware/main.js', 'dist/baseware/src/main.ts')
  writePosixBin('dist/baseware/bin/baseware', 'main.js')
  writeWinCmdBin('dist/baseware/bin/baseware.cmd', 'main.js')
}
