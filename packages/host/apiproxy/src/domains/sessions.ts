import type { ApiProxy } from '@deepseek-ai/dsh-api-protocol/api'
import type { SessionApiDependencies } from './session-api-dependencies.ts'
import { createSessionConversationApi } from './sessions-conversation.ts'
import { createSessionLifecycleApi } from './sessions-lifecycle.ts'
import { createSessionSearchApi } from './sessions-search.ts'

/**
 * Assemble the session RPC domain from lifecycle, search, and conversation capabilities.
 * @param dependencies - Shared session-domain services and policy.
 * @returns The complete session API.
 */
export function createSessionsApi(dependencies: SessionApiDependencies): ApiProxy['sessions'] {
  return {
    ...createSessionLifecycleApi(dependencies),
    ...createSessionSearchApi(dependencies),
    ...createSessionConversationApi(dependencies),
  }
}
