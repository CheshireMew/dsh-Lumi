import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dailyLogPath } from '../src/paths.ts'

describe('desktop paths', () => {
  it('uses a stable local-date filename for each owned process', () => {
    const date = new Date(2026, 7, 14, 23, 59, 58)
    expect(dailyLogPath('D:\\Harness\\logs', 'main', date))
      .toBe(join('D:\\Harness\\logs', 'main-2026-08-14.log'))
    expect(dailyLogPath('D:\\Harness\\logs', 'harness', date))
      .toBe(join('D:\\Harness\\logs', 'harness-2026-08-14.log'))
  })
})
