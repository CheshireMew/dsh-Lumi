import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  dependencies: Record<string, string>
}

describe('web-app performance composition', () => {
  it('routes high-frequency projection rows to SQLite while JSON remains the default backend', () => {
    expect(manifest.dependencies['@deepseek-ai/dsh-storage-sqlite']).toBe('workspace:^')
    expect(patch).toContain("name: '@deepseek-ai/dsh-storage-sqlite'")
    expect(patch).toMatch(/backend: json[\s\S]*routes:[\s\S]*session_projcache: sqlite/u)
  })

  it('pins bounded carrier, index, and browser residency limits in the production profile', () => {
    expect(patch).toContain('eventQueueCapacity: 8192')
    expect(patch).toContain("sessionListIndexPath: !!js dshHomePath('indexes/session-list.sqlite3')")
    expect(patch).toContain('websocketInboxCapacity: 8192')
    expect(patch).toContain('maxResidentSessions: 8')
  })
})
