import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'

describe('lumi desktop bundle plugin', () => {
  it('registers authenticated discovery for the official DeepSeek settings namespace', () => {
    const registerModelDiscovery = vi.fn(() => () => {})
    const ctx = { llm: { registerModelDiscovery } } as unknown as Context

    apply(ctx)

    expect(registerModelDiscovery).toHaveBeenCalledWith('llm-deepseek', expect.any(Function))
  })
})
