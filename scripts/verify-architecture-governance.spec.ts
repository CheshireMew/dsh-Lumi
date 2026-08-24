import { describe, expect, it } from 'vitest'
import {
  findDependencyCycles,
  literalColors,
  symbolLineCount,
  type PackageManifestInput,
} from './verify-architecture-governance.ts'

describe('architecture governance', () => {
  it('reports production dependency cycles and ignores external packages', () => {
    const manifests = new Map<string, PackageManifestInput>([
      ['a', { name: 'a', dependencies: { b: 'workspace:^', external: '^1' } }],
      ['b', { name: 'b', optionalDependencies: { c: 'workspace:^' } }],
      ['c', { name: 'c', dependencies: { a: 'workspace:^' } }],
    ])
    expect(findDependencyCycles(manifests)).toEqual([['a', 'b', 'c', 'a']])
  })

  it('ignores documented design references but finds executable color literals', () => {
    expect(literalColors('/* #fff */\n.value { color: #abcdef; background: rgb(1 2 3); }'))
      .toEqual(['#abcdef', 'rgb('])
  })

  it('measures governed declarations with inclusive lines', () => {
    const source = 'export function sample() {\n  return 1\n}\n'
    expect(symbolLineCount(source, 'sample', 'function')).toBe(3)
    expect(symbolLineCount(source, 'Missing', 'class')).toBeUndefined()
  })
})
