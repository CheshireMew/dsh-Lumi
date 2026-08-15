import { describe, expect, it } from 'vitest'
import { lumiReleaseErrors } from './verify-lumi-release.ts'

describe('Lumi desktop release definition', () => {
  it('keeps signed packaging, updates, identity, and draft publication coherent', () => {
    expect(lumiReleaseErrors({ publish: false })).toEqual([])
  })

  it('publishes only from the version-matched Lumi tag', () => {
    expect(lumiReleaseErrors({ publish: true, refType: 'branch', refName: 'main' }))
      .toContain('publication must run from the exact lumi-v0.1.0-rc.5 tag')
    expect(lumiReleaseErrors({ publish: true, refType: 'tag', refName: 'lumi-v0.1.0-rc.5' })).toEqual([])
  })
})
