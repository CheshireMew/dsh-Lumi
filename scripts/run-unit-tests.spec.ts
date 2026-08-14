import { describe, expect, it } from 'vitest'
import { unitTestInvocations } from './run-unit-tests.ts'

describe('unit-test invocation planning', () => {
  it('runs eight bounded shards in order on Windows', () => {
    expect(unitTestInvocations('win32', [])).toEqual(Array.from({ length: 8 }, (_, index) => [
      'exec',
      'vitest',
      'run',
      `--shard=${index + 1}/8`,
    ]))
  })

  it('retains one canonical invocation on other platforms', () => {
    expect(unitTestInvocations('linux', [])).toEqual([['exec', 'vitest', 'run']])
  })

  it('forwards an explicit filter through one invocation on Windows', () => {
    expect(unitTestInvocations('win32', ['packages/util/atomic-write/tests/atomic-write.spec.ts']))
      .toEqual([['exec', 'vitest', 'run', 'packages/util/atomic-write/tests/atomic-write.spec.ts']])
  })
})
