import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = join(pkgRoot, 'dist')

function resolveBunBinary() {
  if (process.env.LUDENS_BUN?.trim()) return process.env.LUDENS_BUN.trim()
  if (process.versions?.bun) return process.execPath
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

rmSync(distDir, { recursive: true, force: true })
mkdirSync(join(distDir, 'src'), { recursive: true })
mkdirSync(join(distDir, 'bin'), { recursive: true })

const bun = resolveBunBinary()
const result = spawnSync(
  bun,
  ['build', 'src/main.ts', '--target=bun', '--outfile=dist/main.js'],
  { cwd: pkgRoot, stdio: 'inherit' },
)
if (result.error) throw result.error
if (result.status !== 0) {
  throw new Error(`Bundling @ludens/baseware failed (exit=${result.status ?? 'null'})`)
}

writeFileSync(
  join(distDir, 'package.json'),
  JSON.stringify({ name: '@ludens/baseware', type: 'module' }, null, 2) + '\n',
)
// Duplicate the self-contained single-file bundle at src/main.ts so `import.meta.main` stays true under Windows cliCommand fallback.
cpSync(join(distDir, 'main.js'), join(distDir, 'src', 'main.ts'))
writePosixBin(join(distDir, 'bin', 'baseware'), 'main.js')
writeWinCmdBin(join(distDir, 'bin', 'baseware.cmd'), 'main.js')
