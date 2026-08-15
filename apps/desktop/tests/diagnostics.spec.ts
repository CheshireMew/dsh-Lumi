import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appendBoundedLog, pruneDiagnosticFiles } from '../src/diagnostics.ts'

describe('desktop diagnostics', () => {
  it('rotates before a daily log exceeds its byte bound', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lumi-log-'))
    const path = join(dir, 'main.log')
    appendBoundedLog(path, '12345678', 10)
    appendBoundedLog(path, 'abcd', 10)
    expect(readFileSync(`${path}.previous`, 'utf8')).toBe('12345678')
    expect(readFileSync(path, 'utf8')).toBe('abcd')
    appendBoundedLog(path, '0123456789tail', 10)
    expect(readFileSync(path, 'utf8')).toBe('456789tail')
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
