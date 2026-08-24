import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import {
  PRODUCT_IDENTITY,
  PRODUCT_TOKEN,
  PRODUCT_USER_AGENT,
  PRODUCT_VERSION,
  productUserAgent,
} from '../src/index.ts'

describe('product identity', () => {
  it('reads the published version from its package manifest', () => {
    const manifest = createRequire(import.meta.url)('../package.json') as { version: string }
    expect(PRODUCT_VERSION).toBe(manifest.version)
    expect(PRODUCT_IDENTITY.version).toBe(manifest.version)
    expect(PRODUCT_TOKEN).toBe(`deepseek-harness/${manifest.version}`)
    expect(PRODUCT_USER_AGENT).toBe(`deepseek-harness/${manifest.version} (+https://github.com/deepseek-ai/deepseek-harness)`)
  })

  it('renders an explicitly supplied identity', () => {
    expect(productUserAgent({ product: 'white-label', version: '2.0.0', url: 'https://example.test' }))
      .toBe('white-label/2.0.0 (+https://example.test)')
  })
})
