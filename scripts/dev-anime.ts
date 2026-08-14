import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { watch, type FSWatcher } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const electron = process.platform === 'win32'
  ? resolve(root, 'node_modules', '.bin', 'electron.cmd')
  : resolve(root, 'node_modules', '.bin', 'electron')
const environment = {
  ...process.env,
  ELECTRON_CACHE: process.env.ELECTRON_CACHE ?? (process.platform === 'win32' ? 'D:\\Tools\\electron-cache' : undefined),
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
}

/** Spawn one long-lived development child with inherited diagnostics. */
function start(command: string, args: readonly string[]): ChildProcess {
  return spawn(command, args, { cwd: root, env: environment, stdio: 'inherit', shell: false })
}

const built = spawnSync(pnpm, ['run', 'build:anime'], { cwd: root, env: environment, stdio: 'inherit', shell: false })
if (built.status !== 0) process.exit(built.status ?? 1)

const children: ChildProcess[] = [
  start(pnpm, ['--filter', '@deepseek-ai/dsh-web-frontend', 'run', 'watch']),
  start(pnpm, ['--filter', '@dsh-anime/client-character', 'run', 'watch']),
  start(pnpm, ['--filter', '@dsh-anime/client-shell', 'run', 'watch']),
  start(pnpm, ['--filter', '@dsh-anime/desktop', 'exec', 'tsc', '-b', '--watch', '--preserveWatchOutput']),
  start(pnpm, ['--filter', '@dsh-anime/desktop', 'exec', 'tsdown', '--watch']),
]

let desktop: ChildProcess | undefined
let restarting: Promise<void> = Promise.resolve()
let debounce: ReturnType<typeof setTimeout> | undefined

/** Stop one Electron generation before launching the next. */
async function restartDesktop(): Promise<void> {
  const previous = desktop
  if (previous !== undefined && previous.exitCode === null) {
    await new Promise<void>((resolveExit) => {
      previous.once('exit', () => { resolveExit() })
      previous.kill()
    })
  }
  desktop = start(electron, ['apps/desktop'])
}

function scheduleRestart(): void {
  if (debounce !== undefined) clearTimeout(debounce)
  debounce = setTimeout(() => {
    debounce = undefined
    restarting = restarting.then(restartDesktop)
  }, 350)
}

const watcher: FSWatcher = watch(resolve(root, 'apps', 'desktop', 'lib'), { recursive: true }, scheduleRestart)
await restartDesktop()

/** Reach child-process quiescence before ending the coordinator. */
async function stop(): Promise<void> {
  watcher.close()
  if (debounce !== undefined) clearTimeout(debounce)
  const active = [...children, ...(desktop === undefined ? [] : [desktop])].filter(child => child.exitCode === null)
  await Promise.all(active.map(child => new Promise<void>((resolveExit) => {
    child.once('exit', () => { resolveExit() })
    child.kill()
  })))
}

process.once('SIGINT', () => { void stop().finally(() => { process.exit(130) }) })
process.once('SIGTERM', () => { void stop().finally(() => { process.exit(0) }) })
for (const child of children) child.once('exit', (code) => {
  if (code !== 0 && code !== null) void stop().finally(() => { process.exit(code) })
})
