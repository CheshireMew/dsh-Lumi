import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'

const dshBin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const holderPlugin = pathToFileURL(fileURLToPath(new URL('./fixtures/home-lease-holder.mjs', import.meta.url))).href
const EXPECTED = join(process.cwd(), 'apps/cli/tests/snapshots/home-ownership.expected.txt')
const READY = 'dsh-test: home lease ready'

function spawnHost(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  return execa(command, args, {
    cwd,
    env,
    reject: false,
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

type HostProcess = ReturnType<typeof spawnHost>

function waitForReady(child: HostProcess): Promise<void> {
  return new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => { rejectReady(new Error('profile Host did not become ready')) }, 15_000)
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      if (!chunk.includes(READY)) return
      clearTimeout(timer)
      resolveReady()
    })
    void child.then((result) => {
      clearTimeout(timer)
      rejectReady(new Error(`profile Host exited before readiness with code ${String(result.exitCode)}: ${result.stderr}`))
    })
  })
}

describe('dsh Harness-home ownership', () => {
  it('rejects a concurrent Host and hands the home over after process death', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-home-ownership-snapshot-'))
    const home = join(root, '.dsh')
    const profile = 'lease-fixture'
    const profileDir = join(home, 'profiles', profile)
    await mkdir(profileDir, { recursive: true })
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-lease-fixture',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [] } },
    }, undefined, 2) + '\n')
    await writeFile(join(profileDir, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: lease-holder',
      `      name: '${holderPlugin}'`,
      '',
    ].join('\n'))
    const launch = resolveExampleLaunch({
      srcBin: dshBin,
      configArgs: ['--profile', profile],
      tsconfigPath,
      env: {
        DSH_HOME: home,
        DSH_TELEMETRY_DISABLED: '1',
      },
    })
    const spawn = (): HostProcess => spawnHost(
      launch.command,
      launch.args,
      root,
      { ...process.env, ...launch.env },
    )

    let first: HostProcess | undefined
    let replacement: HostProcess | undefined
    try {
      first = spawn()
      await waitForReady(first)
      const rejected = await spawn()
      const ownershipMessage = rejected.stderr.match(/Harness home .*?before starting another profile\./u)?.[0]
      if (ownershipMessage === undefined) throw new Error(`missing ownership diagnostic: ${rejected.stderr}`)
      const serializedHome = JSON.stringify(await realpath(home)).slice(1, -1)
      const normalizedMessage = ownershipMessage
        .replaceAll(serializedHome, '{{home}}')
        .replace(/PID \d+/u, 'PID {{pid}}')
        .replace(/since \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/u, 'since {{startedAt}}')

      first.kill('SIGKILL')
      await first
      first = undefined

      replacement = spawn()
      await waitForReady(replacement)
      const shape = [
        `concurrent-exit=${String(rejected.exitCode)}`,
        `message=${normalizedMessage}`,
        'owner-crash=observed',
        'replacement=ready',
      ].join('\n') + '\n'
      if (process.env.DSH_SNAPSHOT === 'record' || process.env.DSH_SNAPSHOT === 'refresh') {
        await mkdir(dirname(EXPECTED), { recursive: true })
        writeFileSync(EXPECTED, shape)
      }
      await expect(shape).toMatchFileSnapshot(EXPECTED)
    } finally {
      first?.kill('SIGKILL')
      replacement?.kill('SIGKILL')
      await Promise.all([first, replacement].flatMap(child => child === undefined ? [] : [child]))
      await rm(root, { recursive: true, force: true })
    }
  }, 45_000)
})
