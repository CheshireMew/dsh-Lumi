import { SessionQueryError, type SessionSearchCursor } from '@deepseek-ai/dsh-session-query'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ApiProxy, SessionSearchItem } from '@deepseek-ai/dsh-api-protocol/api'
import {
  SESSION_SEARCH_RESULT_LIMIT,
  SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS,
  truncateUnicodeCodePoints,
} from '@deepseek-ai/dsh-api-protocol/api/session-search'
import { err, ok } from '../rpc-result.ts'
import { isAborted } from '../prompt-content.ts'
import { MESSAGE_TYPES } from '../session-history.ts'
import type { SessionApiDependencies } from './session-api-dependencies.ts'

/**
 * Build the bounded, visibility-filtered session-search operation.
 * @param dependencies - Shared session-domain services and search work budget.
 * @returns The session search API method.
 */
export function createSessionSearchApi(
  dependencies: SessionApiDependencies,
): Pick<ApiProxy['sessions'], 'search'> {
  const { ctx, listing, searchProviderCallLimit } = dependencies
  return {
    async search(request, signal) {
      const cancelled = () => err<{ items: SessionSearchItem[]; hasMore: boolean }>(request, {
        code: 'cancelled',
        message: 'session search was aborted',
        details: {},
      })
      if (isAborted(signal)) return cancelled()
      const sessionQuery = ctx.get('sessionQuery')
      if (sessionQuery === undefined) {
        return err(request, {
          code: 'internal',
          message: 'session search is unavailable: this deployment does not mount @deepseek-ai/dsh-session-query',
          details: {},
        })
      }
      try {
        const visible = await listing.listSummaries(signal)
        if (isAborted(signal)) return cancelled()
        if (visible.length === 0) return ok(request, { items: [], hasMore: false })
        const visibleIds = new Set(visible.map(item => item.sessionId))
        const authorized: SessionSearchItem[] = []
        const acceptedIds = new Set<SessionId>()
        const seenCursors = new Set<SessionSearchCursor>()
        let cursor: SessionSearchCursor | undefined
        let providerCallCount = 0
        let providerPageLimit = SESSION_SEARCH_RESULT_LIMIT
        while (authorized.length <= SESSION_SEARCH_RESULT_LIMIT) {
          if (isAborted(signal)) return cancelled()
          if (providerCallCount >= searchProviderCallLimit) {
            throw new Error(
              `session search provider exceeded the ${searchProviderCallLimit}-call work budget`,
            )
          }
          providerCallCount++
          const requestedCursor = cursor
          const requestedPageLimit = providerPageLimit
          let page
          try {
            page = await sessionQuery.searchSessions({
              query: request.payload.query,
              eventFilters: [
                { kind: 'type', values: ['user/message', 'assistant/message'] },
                { kind: 'surface', values: ['current'] },
              ],
              limit: requestedPageLimit,
              ...requestedCursor === undefined ? {} : { cursor: requestedCursor },
            }, { signal })
          } catch (error: unknown) {
            if (isAborted(signal)) return cancelled()
            if (requestedCursor === undefined
              && error instanceof SessionQueryError
              && error.code === 'SESSION_QUERY_INVALID_LIMIT'
              && requestedPageLimit > 1) {
              providerPageLimit = Math.max(1, Math.floor(requestedPageLimit / 2))
              continue
            }
            if (requestedCursor !== undefined
              && error instanceof SessionQueryError
              && error.code === 'SESSION_QUERY_STALE_CURSOR') {
              authorized.length = 0
              acceptedIds.clear()
              seenCursors.clear()
              cursor = undefined
              continue
            }
            throw error
          }
          if (isAborted(signal)) return cancelled()
          const providerItemCount = page.items.length
          if (providerItemCount > requestedPageLimit) {
            throw new Error(
              `session search provider returned ${providerItemCount} items; maximum is ${requestedPageLimit}`,
            )
          }
          for (const hit of page.items) {
            if (authorized.length > SESSION_SEARCH_RESULT_LIMIT) continue
            if (!visibleIds.has(hit.header.id)
              || hit.bestMatch.sessionId !== hit.header.id
              || hit.bestMatch.surface !== 'current'
              || !MESSAGE_TYPES.has(hit.bestMatch.type)
              || acceptedIds.has(hit.header.id)) continue
            acceptedIds.add(hit.header.id)
            authorized.push({
              sessionId: hit.header.id,
              snippet: truncateUnicodeCodePoints(
                hit.bestMatch.snippet,
                SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS,
              ),
            })
          }
          const nextCursor = page.nextCursor
          if (nextCursor !== undefined) {
            if (seenCursors.has(nextCursor)) {
              throw new Error('session search provider repeated a continuation cursor')
            }
            seenCursors.add(nextCursor)
          }
          if (authorized.length > SESSION_SEARCH_RESULT_LIMIT || nextCursor === undefined) break
          cursor = nextCursor
        }
        return ok(request, {
          items: authorized.slice(0, SESSION_SEARCH_RESULT_LIMIT),
          hasMore: authorized.length > SESSION_SEARCH_RESULT_LIMIT,
        })
      } catch (error: unknown) {
        if (isAborted(signal)
          || (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_ABORTED')) {
          return cancelled()
        }
        return err(request, {
          code: 'internal',
          message: `session search failed: ${String(error)}`,
          details: {},
        })
      }
    },
  }
}
