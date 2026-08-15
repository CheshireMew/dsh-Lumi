import { lstat, mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AtomicWriteDurabilityError, withFileLock, writeFileAtomic, writeFileAtomicSync,
} from '../src/index.ts'

const renameControl = vi.hoisted(() => ({ calls: 0, failures: 0, code: 'EPERM' }))
const syncControl = vi.hoisted(() => ({
  failAt: '',
  events: [] as string[],
  syncFailAt: '',
  syncEvents: [] as string[],
  descriptorStages: new Map<number, string>(),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>): number => {
      const descriptor = actual.openSync(...args)
      const flags = String(args[1])
      syncControl.descriptorStages.set(descriptor, flags === 'wx' ? 'temp' : flags === 'r+' ? 'target' : 'directory')
      return descriptor
    },
    fsyncSync: (descriptor: number): void => {
      const stage = syncControl.descriptorStages.get(descriptor) ?? 'unknown'
      syncControl.syncEvents.push(stage)
      if (syncControl.syncFailAt === stage) {
        throw Object.assign(new Error(`EIO: injected synchronous ${stage} sync failure`), { code: 'EIO' })
      }
      actual.fsyncSync(descriptor)
    },
    closeSync: (descriptor: number): void => {
      try { actual.closeSync(descriptor) } finally { syncControl.descriptorStages.delete(descriptor) }
    },
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      const flags = String(args[1])
      const stage = flags === 'wx' ? 'temp' : flags === 'r+' ? 'target' : 'directory'
      return {
        writeFile: handle.writeFile.bind(handle),
        close: handle.close.bind(handle),
        sync: async (): Promise<void> => {
          syncControl.events.push(stage)
          if (syncControl.failAt === stage) throw Object.assign(new Error(`EIO: injected ${stage} sync failure`), { code: 'EIO' })
          await handle.sync()
        },
      }
    },
    rename: async (...args: Parameters<typeof actual.rename>): Promise<void> => {
      renameControl.calls += 1
      if (renameControl.failures > 0) {
        renameControl.failures -= 1
        throw Object.assign(new Error(`${renameControl.code}: injected rename failure`), { code: renameControl.code })
      }
      await actual.rename(...args)
    },
  }
})

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-atomic-write-'))
}

describe('writeFileAtomic', () => {
  beforeEach(() => {
    renameControl.calls = 0
    renameControl.failures = 0
    renameControl.code = 'EPERM'
    syncControl.failAt = ''
    syncControl.events = []
    syncControl.syncFailAt = ''
    syncControl.syncEvents = []
    syncControl.descriptorStages.clear()
  })

  it('creates the file and its parents with exactly the stated mode', async () => {
    const dir = await scratch()
    const target = join(dir, 'nested', 'deep', 'doc.yaml')
    await writeFileAtomic(target, 'a: 1\n', { mode: 0o600 })
    expect(await readFile(target, 'utf8')).toBe('a: 1\n')
    if (process.platform !== 'win32') expect((await stat(target)).mode & 0o777).toBe(0o600)
    expect(syncControl.events).toEqual(['temp', 'target', 'directory'])
  })

  it('keeps the previous file when the pre-rename durability barrier fails', async () => {
    const dir = await scratch()
    const target = join(dir, 'doc.yaml')
    await writeFile(target, 'old')
    syncControl.failAt = 'temp'
    await expect(writeFileAtomic(target, 'new', { mode: 0o600 })).rejects.not.toBeInstanceOf(AtomicWriteDurabilityError)
    expect(await readFile(target, 'utf8')).toBe('old')
    expect((await readdir(dir)).filter(entry => entry.includes('.tmp'))).toEqual([])
  })

  it.each(['target', 'directory'])('reports a visible commit when the %s durability barrier fails', async (stage) => {
    const dir = await scratch()
    const target = join(dir, 'doc.yaml')
    await writeFile(target, 'old')
    syncControl.failAt = stage
    const failure = await writeFileAtomic(target, 'new', { mode: 0o600 }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AtomicWriteDurabilityError)
    expect(failure).toMatchObject({ committed: true, filename: target })
    expect(await readFile(target, 'utf8')).toBe('new')
    expect((await readdir(dir)).filter(entry => entry.includes('.tmp'))).toEqual([])
  })

  it('replaces existing content and narrows a wider-permission file to the stated mode', async () => {
    const dir = await scratch()
    const target = join(dir, 'doc.yaml')
    await writeFile(target, 'old', { mode: 0o644 })
    await writeFileAtomic(target, 'new', { mode: 0o600 })
    expect(await readFile(target, 'utf8')).toBe('new')
    if (process.platform !== 'win32') expect((await stat(target)).mode & 0o777).toBe(0o600)
  })

  it('replaces a symlinked target itself without writing through to the referent', async () => {
    const dir = await scratch()
    const victim = join(dir, 'victim')
    await writeFile(victim, 'victim-content')
    const target = join(dir, 'doc.yaml')
    await symlink(victim, target)
    await writeFileAtomic(target, 'replaced', { mode: 0o600 })
    expect((await lstat(target)).isSymbolicLink()).toBe(false)
    expect(await readFile(target, 'utf8')).toBe('replaced')
    expect(await readFile(victim, 'utf8')).toBe('victim-content')
  })

  it('leaves no temp sibling and rethrows when the rename fails', async () => {
    const dir = await scratch()
    const target = join(dir, 'occupied')
    await mkdir(target)
    await expect(writeFileAtomic(target, 'content', { mode: 0o600 })).rejects.toThrow()
    expect((await readdir(dir)).filter(entry => entry.includes('.tmp'))).toEqual([])
  }, 10_000)

  it.each(['EACCES', 'EBUSY', 'EPERM'])('retries a transient %s rename failure', async (code) => {
    const dir = await scratch()
    const target = join(dir, 'doc.yaml')
    renameControl.failures = 2
    renameControl.code = code

    await writeFileAtomic(target, 'new', { mode: 0o600 })

    expect(renameControl.calls).toBe(3)
    expect(await readFile(target, 'utf8')).toBe('new')
  })

  it('bounds transient rename retries and removes the temp sibling', async () => {
    const dir = await scratch()
    const target = join(dir, 'doc.yaml')
    renameControl.failures = 20

    await expect(writeFileAtomic(target, 'new', { mode: 0o600 })).rejects.toMatchObject({ code: 'EPERM' })

    expect(renameControl.calls).toBe(11)
    expect((await readdir(dir)).filter(entry => entry.includes('.tmp'))).toEqual([])
  }, 10_000)

  it('offers the same durable replacement for synchronous lifecycle handlers', async () => {
    const dir = await scratch()
    const target = join(dir, 'window.json')
    writeFileAtomicSync(target, 'first', { mode: 0o600 })
    writeFileAtomicSync(target, 'second', { mode: 0o600 })
    expect(await readFile(target, 'utf8')).toBe('second')
  })

  it('keeps the previous file when the synchronous pre-rename flush fails', async () => {
    const dir = await scratch()
    const target = join(dir, 'window.json')
    await writeFile(target, 'old')
    syncControl.syncFailAt = 'temp'

    expect(() => { writeFileAtomicSync(target, 'new', { mode: 0o600 }) }).toThrow(/injected synchronous temp/)

    expect(await readFile(target, 'utf8')).toBe('old')
    expect((await readdir(dir)).filter(entry => entry.includes('.tmp'))).toEqual([])
  })

  it.each(['target', 'directory'])('reports a visible synchronous commit when the %s flush fails', async (stage) => {
    const dir = await scratch()
    const target = join(dir, 'window.json')
    await writeFile(target, 'old')
    syncControl.syncFailAt = stage

    const failure = (() => {
      try {
        writeFileAtomicSync(target, 'new', { mode: 0o600 })
      } catch (error) {
        return error
      }
      return undefined
    })()

    expect(failure).toBeInstanceOf(AtomicWriteDurabilityError)
    expect(failure).toMatchObject({ committed: true, filename: target })
    expect(await readFile(target, 'utf8')).toBe('new')
  })
})

describe('withFileLock', () => {
  it('rejects an invalid parent hierarchy before running the operation', async () => {
    const dir = await scratch()
    const parent = join(dir, 'not-a-directory')
    await writeFile(parent, 'occupied')
    let called = false

    await expect(withFileLock(join(parent, 'document'), async () => {
      called = true
    })).rejects.toThrow(/ENOENT|ENOTDIR|not a directory/i)
    expect(called).toBe(false)
  })
})
