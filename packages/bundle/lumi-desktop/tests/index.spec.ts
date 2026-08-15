import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

describe('lumi desktop bundle marker', () => {
  it('keeps behavior in the profile patch rows', () => {
    expect(() => { apply() }).not.toThrow()
  })
})
