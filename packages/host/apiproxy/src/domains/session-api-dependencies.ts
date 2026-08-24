import type { Context } from '@deepseek-ai/cordis'
import type { ApiProxyDefaults } from '../api-proxy-defaults.ts'
import type { SessionListing } from '../session-listing.ts'
import type { SessionReader } from '../session-reader.ts'
import type { SessionRuntime } from '../session-runtime.ts'

/** Shared collaborators used by the separate session RPC capability groups. */
export interface SessionApiDependencies {
  ctx: Context
  defaults: ApiProxyDefaults
  runtime: SessionRuntime
  reader: SessionReader
  listing: SessionListing
  searchProviderCallLimit: number
}
