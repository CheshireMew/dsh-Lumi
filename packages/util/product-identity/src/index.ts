/**
 * Public DeepSeek Harness identity shared by protocol handshakes and HTTP
 * attribution. The package manifest is the only product-version source.
 * @module @deepseek-ai/dsh-product-identity
 */

import { createRequire } from 'node:module'

const manifest = createRequire(import.meta.url)('../package.json') as { version: string }

/** Public identity fields safe to send to external services and clients. */
export interface ProductIdentity {
  /** Lowercase product token used by protocol clients and User-Agent values. */
  product: string
  /** Published package-family version. */
  version: string
  /** Public repository URL used for attribution. */
  url: string
}

/** Published DeepSeek Harness package-family version. */
export const PRODUCT_VERSION = manifest.version

/** Canonical public DeepSeek Harness identity. */
export const PRODUCT_IDENTITY: ProductIdentity = Object.freeze({
  product: 'deepseek-harness',
  version: PRODUCT_VERSION,
  url: 'https://github.com/deepseek-ai/deepseek-harness',
})

/** Product/version token for protocol clients that accept no URL comment. */
export const PRODUCT_TOKEN = `${PRODUCT_IDENTITY.product}/${PRODUCT_IDENTITY.version}`

/**
 * Render an HTTP User-Agent value with a public project URL.
 * @param identity - product identity to render.
 * @returns an RFC 9110 product token followed by an attribution comment.
 */
export function productUserAgent(identity: ProductIdentity = PRODUCT_IDENTITY): string {
  return `${identity.product}/${identity.version} (+${identity.url})`
}

/** Default DeepSeek Harness User-Agent value. */
export const PRODUCT_USER_AGENT = productUserAgent()
