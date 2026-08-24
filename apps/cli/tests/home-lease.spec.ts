import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execa } from 'execa'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { acquireDshHomeLease, DshHomeInUseError } from '../src/home-lease.ts'

const temporaryRoots: string[] = []
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const leaseModuleUrl = pathToFileURL(fileURLToPath(new URL('../src/home-lease.ts', import.meta.url))).href

async function temporaryHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-home-lease-'))
  temporaryRoots.push(root)
  return join(root, '.dsh')
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Harness home process lease', () => {
  it('rejects a second owner with live process details and permits an idempotent handoff', async () => {
    const home = await temporaryHome()
    const compromised = vi.fn()
    const first = await acquireDshHomeLease(home, 'web', compromised)

    const contention = acquireDshHomeLease(home, 'headless', vi.fn())
    await expect(contention).rejects.toMatchObject({
      name: 'DshHomeInUseError',
      code: 'dsh-home-in-use',
      home: await realpath(home),
      owner: { pid: process.pid, profile: 'web', startedAt: first.owner.startedAt },
    })
    await expect(contention).rejects.toBeInstanceOf(DshHomeInUseError)

    await Promise.all([first.release(), first.release()])
    const replacement = await acquireDshHomeLease(home, 'headless', compromised)
    expect(replacement.owner.profile).toBe('headless')
    await replacement.release()
    expect(compromised).not.toHaveBeenCalled()
  })

  it('lets different Harness homes run concurrently', async () => {
    const first = await acquireDshHomeLease(await temporaryHome(), 'web', vi.fn())
    const second = await acquireDshHomeLease(await temporaryHome(), 'web', vi.fn())
    expect(first.home).not.toBe(second.home)
    await Promise.all([first.release(), second.release()])
  })

  it('recovers immediately after an owning process is terminated', async () => {
    const home = await temporaryHome()
    const script = [
      `import { acquireDshHomeLease } from ${JSON.stringify(leaseModuleUrl)}`,
      "const lease = await acquireDshHomeLease(process.argv[1], 'child-web', error => { throw error })",
      "process.stdout.write(JSON.stringify(lease.owner) + '\\n')",
      'setInterval(() => {}, 60_000)',
    ].join(';')
    const child = execa(process.execPath, [
      '--import', 'tsx/esm', '--input-type=module', '-e', script, home,
    ], {
      env: { ...process.env, TSX_TSCONFIG_PATH: tsconfigPath },
      reject: false,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    let stopped = false
    try {
      const owner = await new Promise<{ pid: number; profile: string }>((resolveOwner, rejectOwner) => {
        const timer = setTimeout(() => { rejectOwner(new Error('child lease did not become ready')) }, 10_000)
        child.stdout?.setEncoding('utf8')
        child.stdout?.once('data', (line: string) => {
          clearTimeout(timer)
          resolveOwner(JSON.parse(line) as { pid: number; profile: string })
        })
        void child.then((result) => {
          clearTimeout(timer)
          rejectOwner(new Error(`child lease exited before readiness with code ${String(result.exitCode)}`))
        })
      })
      expect(owner).toMatchObject({ pid: child.pid, profile: 'child-web' })
      await expect(acquireDshHomeLease(home, 'parent', vi.fn())).rejects.toMatchObject({
        code: 'dsh-home-in-use',
        owner: { pid: child.pid, profile: 'child-web' },
      })

      child.kill('SIGKILL')
      await child
      stopped = true
      const replacement = await acquireDshHomeLease(home, 'parent', vi.fn())
      await replacement.release()
    } finally {
      if (!stopped) {
        child.kill('SIGKILL')
        await child
      }
    }
  }, 20_000)
})
