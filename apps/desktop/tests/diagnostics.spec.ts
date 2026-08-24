import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { describe, expect, it } from 'vitest'
import { appendBoundedLog, createDesktopLogStream, pruneDiagnosticFiles } from '../src/diagnostics.ts'

describe('desktop diagnostics', () => {
  it('rotates before a daily log exceeds its byte bound', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lumi-log-'))
    const path = join(dir, 'main.log')
    await appendBoundedLog(path, '12345678', 10)
    await appendBoundedLog(path, 'abcd', 10)
    expect(readFileSync(`${path}.previous`, 'utf8')).toBe('12345678')
    expect(readFileSync(path, 'utf8')).toBe('abcd')
    await appendBoundedLog(path, '0123456789tail', 10)
    expect(readFileSync(path, 'utf8')).toBe('456789tail')
  })

  it('applies Writable backpressure while asynchronous rotation keeps both files bounded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lumi-log-stream-'))
    const stream = createDesktopLogStream(dir, 1_024)
    let backpressured = false
    for (let index = 0; index < 2_000; index += 1) {
      backpressured = !stream.write(`${String(index).padStart(4, '0')}:${'x'.repeat(120)}\n`) || backpressured
    }
    stream.end()
    await finished(stream)

    expect(backpressured).toBe(true)
    const files = readdirSync(dir).filter(name => name.includes('harness'))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) expect(statSync(join(dir, file)).size).toBeLessThanOrEqual(1_024)
  })

  it('prunes only regular diagnostics outside count and age retention', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lumi-retention-'))
    const now = new Date('2026-08-15T00:00:00Z')
    for (const [name, ageDays] of [['new.dmp', 0], ['middle.dmp', 1], ['old.dmp', 40]] as const) {
      const path = join(dir, name)
      writeFileSync(path, name)
      const modified = new Date(now.getTime() - ageDays * 86_400_000)
      utimesSync(path, modified, modified)
    }
    mkdirSync(join(dir, 'owned-directory'))
    expect(pruneDiagnosticFiles(dir, 1, 30 * 86_400_000, now.getTime())).toBe(2)
    expect(existsSync(join(dir, 'new.dmp'))).toBe(true)
    expect(existsSync(join(dir, 'middle.dmp'))).toBe(false)
    expect(existsSync(join(dir, 'old.dmp'))).toBe(false)
    expect(existsSync(join(dir, 'owned-directory'))).toBe(true)
  })
})
