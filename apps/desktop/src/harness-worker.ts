import { fileURLToPath } from 'node:url'
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { runProfile, type ProcessShutdown } from '@deepseek-ai/dsh/profile-boot'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { isHarnessWorkerCommand, type HarnessWorkerEvent } from './protocol.ts'

const PROFILE = 'anime-desktop'
const INITIAL_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@dsh-anime/bundle-desktop',
] as const

/** Send a cloneable lifecycle fact to the Electron main process. */
function post(message: HarnessWorkerEvent): void { process.parentPort.postMessage(message) }

/** Serialize unknown startup failures without passing Error objects across worlds. */
function fatal(stage: string, error: unknown): Extract<HarnessWorkerEvent, { type: 'fatal' }> {
  const details = (value: unknown, depth = 0): string[] => {
    if (depth > 8) return ['  '.repeat(depth) + '[nested error depth exceeded]']
    if (value instanceof AggregateError) return [`${'  '.repeat(depth)}${value.name}: ${value.message}`, ...value.errors.flatMap(child => details(child, depth + 1))]
    if (value instanceof Error) return [`${'  '.repeat(depth)}${value.name}: ${value.message}`, ...(value.cause === undefined ? [] : details(value.cause, depth + 1))]
    return [`${'  '.repeat(depth)}${String(value)}`]
  }
  return {
    type: 'fatal',
    stage,
    message: details(error).join('\n'),
    ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
  }
}

let shutdown: ProcessShutdown | undefined
let stopping = false

/** Boot the profile once; process replacement owns restart isolation. */
async function boot(): Promise<void> {
  post({ type: 'starting' })
  post({ type: 'log', level: 'info', message: 'Loading anime-desktop profile.' })
  const environment = loadLayeredEnv('dsh-anime')
  const result = await runProfile({
    environment,
    profile: PROFILE,
    patchFiles: [],
    args: ['--host', '127.0.0.1', '--port', '0'],
    installAnchor: fileURLToPath(new URL('../package.json', import.meta.url)),
    initialBundles: INITIAL_BUNDLES,
  })
  shutdown = result.shutdown
  const webServer = result.ctx.get('webServer')
  if (webServer === undefined) throw new Error('anime-desktop: profile booted without the webServer service')
  const port = webServer.port
  post({ type: 'ready', port, url: `http://127.0.0.1:${port}` })
  post({ type: 'log', level: 'info', message: `Harness is listening on 127.0.0.1:${port}.` })
}

/** Reach profile quiescence, report it, and end this worker generation. */
async function stop(code: number): Promise<void> {
  if (stopping) return
  stopping = true
  try {
    await shutdown?.shutdown(code)
    post({ type: 'stopped', code })
    setImmediate(() => { process.exit(code) })
  } catch (error) {
    post(fatal('shutdown', error))
    setImmediate(() => { process.exit(1) })
  }
}

process.parentPort.on('message', ({ data }: { data: unknown }) => {
  if (!isHarnessWorkerCommand(data) || stopping) return
  void stop(0)
})

void boot().catch((error: unknown) => {
  post(fatal('profile-boot', error))
  setImmediate(() => { process.exit(1) })
})
