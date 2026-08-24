import { describe, expect, it } from 'vitest'
import {
  matchesUpstreamPatchPath,
  touchedUpstreamPatchIds,
  type UpstreamPatch,
} from './verify-upstream-patches.ts'

function patch(id: string, paths: string[]): UpstreamPatch {
  return {
    id,
    title: id,
    reason: 'test reason',
    paths,
    validation: ['test'],
    retirement: 'test retirement',
    reviewedThrough: '0123456789012345678901234567890123456789',
    lastOutcome: 'retain',
    reviewNote: 'test review',
  }
}

describe('upstream patch inventory', () => {
  it('matches only exact paths and explicit recursive directories', () => {
    expect(matchesUpstreamPatchPath('packages/a/src/index.ts', 'packages/a/**')).toBe(true)
    expect(matchesUpstreamPatchPath('packages/ab/src/index.ts', 'packages/a/**')).toBe(false)
    expect(matchesUpstreamPatchPath('package.json', 'package.json')).toBe(true)
    expect(matchesUpstreamPatchPath('package.json.bak', 'package.json')).toBe(false)
  })

  it('reports every maintained patch touched by official paths in manifest order', () => {
    const patches = [
      patch('api', ['packages/host/apiproxy/**']),
      patch('identity', ['packages/util/product-identity/**', 'packages/acp/acp/src/index.ts']),
      patch('unrelated', ['packages/client/ui-theme/**']),
    ]
    expect(touchedUpstreamPatchIds(patches, [
      'packages/acp/acp/src/index.ts',
      'packages/host/apiproxy/src/api-proxy.ts',
    ])).toEqual(['api', 'identity'])
  })
})
