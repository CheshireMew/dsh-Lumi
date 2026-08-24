/** Browser-safe legacy API types, schemas, and fetch carrier adapters. */
import type {} from '@deepseek-ai/cordis'
import type { ApiProxy } from './api/index.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Transport-independent application API provided by the host implementation. */
    apiProxy: ApiProxy
  }
}

export type * from './api/index.ts'
export { RpcId, transportError } from './api/index.ts'
export { AbstractApiClient, InProcessApiClient } from './fetch/client.ts'
export type { IApiClient } from './fetch/client.ts'
export { toFetchHandler } from './fetch/handler.ts'
