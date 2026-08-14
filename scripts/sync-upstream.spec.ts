import { describe, expect, it } from 'vitest'
import { renderSyncReport, selectSynchronizationBranch } from './sync-upstream.ts'

describe('upstream synchronization planning', () => {
  const commit = '47f943859bef60e4160492346772ded9b24f765a'

  it('resumes the current synchronization branch after the local date changes', () => {
    expect(selectSynchronizationBranch('codex/sync-20260814-47f94385', '2026-08-15', commit))
      .toBe('codex/sync-20260814-47f94385')
  })

  it('uses the current date for a new synchronization branch', () => {
    expect(selectSynchronizationBranch('main', '2026-08-15', commit))
      .toBe('codex/sync-20260815-47f94385')
  })

  it('does not resume a synchronization branch for another official commit', () => {
    expect(selectSynchronizationBranch('codex/sync-20260814-deadbeef', '2026-08-15', commit))
      .toBe('codex/sync-20260815-47f94385')
  })

  it('renders one trailing newline and preserves check outcomes', () => {
    const report = renderSyncReport('2026-08-15', 'codex/sync-20260814-47f94385', commit, commit, [], [], [
      { name: 'passing check', command: 'pnpm run pass', passed: true },
      { name: 'failing check', command: 'pnpm run fail', passed: false },
    ])

    expect(report).toContain('- PASS — `pnpm run pass` (passing check)')
    expect(report).toContain('- FAIL — `pnpm run fail` (failing check)')
    expect(report.endsWith('\n')).toBe(true)
    expect(report.endsWith('\n\n')).toBe(false)
  })
})
