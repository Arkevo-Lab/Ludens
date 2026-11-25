import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mainEntry = join(desktopRoot, 'dist/electron/main.js')

const rawArgs = process.argv.slice(2)
let realHome = false
const electronArgs = []
for (const arg of rawArgs) {
  if (arg === '--real-home') {
    realHome = true
  } else {
    electronArgs.push(arg)
  }
}
if (!electronArgs.includes('--parent-watchdog')) {
  electronArgs.push('--parent-watchdog')
}

const explicitHome = process.env.LUDENS_HOME?.trim()
const effectiveHome = realHome
  ? resolve(homedir(), '.ludens')
  : explicitHome
    ? resolve(explicitHome)
    : resolve(homedir(), '.ludens-dev')

mkdirSync(effectiveHome, { recursive: true })

function resolveElectronCommand() {
  if (process.platform === 'win32') {
    const candidates = [
      join(desktopRoot, 'node_modules/electron/dist/electron.exe'),
      resolve(desktopRoot, '../node_modules/electron/dist/electron.exe'),
    ]
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return { command: candidate, args: [mainEntry, ...electronArgs] }
      }
    }
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/c', join(desktopRoot, 'bin/ludens-app.cmd'), ...electronArgs],
    }
  }
  return {
    command: join(desktopRoot, 'bin/ludens-app'),
    args: electronArgs,
  }
}

const env = { ...process.env, LUDENS_HOME: effectiveHome }
delete env.ELECTRON_RUN_AS_NODE

const { command, args } = resolveElectronCommand()
const child = spawn(command, args, {
  cwd: desktopRoot,
  env,
  stdio: ['pipe', 'inherit', 'inherit'],
})
child.stdin?.on('error', () => {})

const closeChildStdin = () => {
  try {
    child.stdin?.end()
  } catch {}
  try {
    child.stdin?.destroy()
  } catch {}
}

const forward = signal => {
  closeChildStdin()
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill(signal)
    } catch {}
  }
}
process.on('SIGINT', () => forward('SIGINT'))
process.on('SIGTERM', () => forward('SIGTERM'))
process.on('exit', closeChildStdin)

child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0)
})
