import type { Context } from '@deepseek-ai/cordis'
import type { HistoryEntry, SessionProjectionsBlock, ToolEventView } from '@deepseek-ai/dsh-api-protocol/api'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import { isAppendSurfaceEvent, type Session, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import type {} from '@deepseek-ai/dsh-tools'

const DEFAULT_MAX_MESSAGES = 50
/** Conversation message event types used by history and search filtering. */
export const MESSAGE_TYPES = new Set(['user/message', 'assistant/message'])

interface ToolCallData { callId: string; name: string; arguments: string }

function paginate(
  events: readonly SessionEvent[],
  beforeSeq: number | undefined,
  maxMessages: number,
): { events: SessionEvent[]; hasMore: boolean } {
  const boundary = beforeSeq ?? Number.POSITIVE_INFINITY
  const window = events.filter(event => event.seq < boundary)
  if (window.length === 0) return { events: [], hasMore: false }
  let count = 0
  let cut = 0
  for (let i = window.length - 1; i >= 0; i--) {
    const event = window[i] as SessionEvent
    if (!MESSAGE_TYPES.has(event.type) || !isAppendSurfaceEvent(event)) continue
    count++
    const sources = (event as { sourceEventSeqs?: number[] }).sourceEventSeqs
    const groupStart = sources !== undefined && sources.length > 0 ? Math.min(event.seq, ...sources) : event.seq
    if (count >= maxMessages) {
      cut = groupStart
      break
    }
  }
  const page = window.filter(event => event.seq >= cut)
  return { events: page, hasMore: cut > 0 }
}

/**
 * Render one tool event through the current presenter registry.
 * @param ctx - Host context carrying the tool registry.
 * @param event - Tool call or result event to present.
 * @param argsFor - Resolver for the matching call arguments.
 * @param scope - Optional scoped presenter registry.
 * @returns A public tool view, or undefined when no presenter applies.
 */
export function viewFor(
  ctx: Context,
  event: SessionEvent,
  argsFor: (callId: string) => unknown,
  scope?: ScopeKey,
): ToolEventView | undefined {
  try {
    if (event.type === 'tool/call') {
      const { name, arguments: raw } = event.data as ToolCallData
      const view = ctx.tools.get(name, scope)?.presentCall?.(JSON.parse(raw))
      return view === undefined ? undefined : { for: 'call', view }
    }
    if (event.type === 'tool/result') {
      const { message, meta } = event.data
      const [result] = message.content
      const callId = message.source.callId
      const call = argsFor(callId) as { name: string; args: unknown } | undefined
      if (call === undefined) return undefined
      const view = ctx.tools.get(call.name, scope)?.presentResult?.(call.args, {
        content: result.content,
        isError: result.isError === true,
        ...meta === undefined ? {} : { meta },
      })
      return view === undefined ? undefined : { for: 'result', view }
    }
  } catch (error: unknown) {
    console.error(`api-proxy: presenter failed for ${event.type}, falling back to generic: ${String(error)}`)
  }
  return undefined
}

/**
 * Resolve one result's call pairing within a bounded event window.
 * @param events - Event window to scan backwards.
 * @param callId - Tool call identity to match.
 * @returns Parsed tool name and arguments, when available.
 */
export function backscanArgs(
  events: readonly SessionEvent[],
  callId: string,
): { name: string; args: unknown } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i] as SessionEvent
    if (event.type !== 'tool/call') continue
    const data = event.data as ToolCallData
    if (data.callId !== callId) continue
    try {
      return { name: data.name, args: JSON.parse(data.arguments) }
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Build one bounded, presenter-decorated history page.
 * @param ctx - Host context carrying tool presenters.
 * @param events - Stable session event prefix.
 * @param beforeSeq - Exclusive sequence cursor.
 * @param maxMessages - Maximum conversation messages in the page.
 * @param scope - Optional scoped presenter registry.
 * @returns Decorated events and whether older events remain.
 */
export function historyPage(
  ctx: Context,
  events: readonly SessionEvent[],
  beforeSeq: number | undefined,
  maxMessages: number | undefined,
  scope?: ScopeKey,
): { events: HistoryEntry[]; hasMore: boolean } {
  const page = paginate(events, beforeSeq, maxMessages ?? DEFAULT_MAX_MESSAGES)
  return {
    events: page.events.map((event) => {
      const view = viewFor(ctx, event, callId => backscanArgs(page.events, callId), scope)
      return { event, ...view === undefined ? {} : { view } }
    }),
    hasMore: page.hasMore,
  }
}

/**
 * Return the current projection cut for one live session.
 * @param ctx - Host context carrying the projection service.
 * @param session - Attached session to snapshot.
 * @returns Its projection block, when projections are composed.
 */
export function projectionsFor(ctx: Context, session: Session): SessionProjectionsBlock | undefined {
  return ctx.get('sessionProjections')?.snapshot(session)
}

/**
 * Resolve the best-effort projection column for one session-list row.
 * @param ctx - Host context carrying live and cached projection services.
 * @param meta - Session header represented by the row.
 * @param session - Attached session, or undefined for a cold row.
 * @returns A non-empty projection block, when available.
 */
export function listProjectionsFor(
  ctx: Context,
  meta: SessionHeader,
  session: Session | undefined,
): SessionProjectionsBlock | undefined {
  try {
    const block = session !== undefined
      ? ctx.get('sessionProjections')?.snapshot(session)
      : ctx.get('sessionProjectionCache')?.cachedSnapshot(meta)
    return block !== undefined && Object.keys(block.values).length > 0 ? block : undefined
  } catch (error) {
    ctx.logger.warn(`session.list: projection column for "${meta.id}" failed (serving the row without it): ${String(error)}`)
    return undefined
  }
}

/**
 * Restore one projection cut from detached events without activating an agent.
 * @param ctx - Host context carrying the projection service.
 * @param events - Stable detached event prefix.
 * @returns Its reconstructed projection block, when supported.
 */
export function detachedProjectionsFor(
  ctx: Context,
  events: readonly SessionEvent[],
): SessionProjectionsBlock | undefined {
  return ctx.get('sessionProjections')?.restore({}, events, 0).snapshot
}
