import { stat } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { advanceLastHumanPromptAt, type Session, type SessionEvent, type SessionHeader, type SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import type { SessionListMetadata, SessionSummary } from '@deepseek-ai/dsh-api-protocol/api'

/**
 * Test whether a session has not started any model-loop turn.
 * @param session - Session to inspect.
 * @returns Whether no turn has started.
 */
export function sessionBlank(session: Session): boolean {
  return !session.events.some(event => event.type === 'turn/start')
}

/**
 * Advance the session-list metadata projection by one committed event.
 * @param state - Previous projection state.
 * @param event - Next committed event.
 * @returns The advanced projection state.
 */
export function applySessionListMetadata(
  state: SessionListMetadata,
  event: SessionEvent,
): SessionListMetadata {
  const blank = state.blank && event.type !== 'turn/start'
  const lastPromptAt = advanceLastHumanPromptAt(state.lastPromptAt, event)
  return blank === state.blank && lastPromptAt === state.lastPromptAt
    ? state
    : { blank, lastPromptAt }
}

/** Fold exact list metadata for an attached session. */
function sessionListMetadata(events: readonly SessionEvent[]): SessionListMetadata {
  let state: SessionListMetadata = { blank: true, lastPromptAt: null }
  for (const event of events) state = applySessionListMetadata(state, event)
  return state
}

/** Sort by creation or latest human prompt, whichever is newer. */
function sessionListUpdatedAt(header: SessionHeader, lastPromptAt: number | null): number {
  return Math.max(header.createdAt, lastPromptAt ?? 0)
}

/**
 * Project shared session-header fields for list baselines and creation frames.
 * @param header - Session header to project.
 * @param events - Events used to resolve the selected agent preset.
 * @returns Optional public lineage, cwd, and preset fields.
 */
export function sessionListFields(
  header: SessionHeader,
  events: readonly SessionEvent[] = [],
): {
  parentSessionId?: SessionId
  origin?: 'subagent'
  cwd?: string
  agentPreset?: string
} {
  const agentPreset = resolveSessionPreset({ header, events })
  return {
    ...header.parentSession === undefined ? {} : { parentSessionId: header.parentSession },
    ...header.origin === undefined ? {} : { origin: header.origin },
    ...header.cwd === undefined ? {} : { cwd: header.cwd },
    ...agentPreset === undefined ? {} : { agentPreset },
  }
}

/**
 * Project one attached session onto its list row.
 * @param session - Attached session to summarize.
 * @param running - Whether its agent is currently running.
 * @returns Public session-list row.
 */
export function summarizeSession(session: Session, running: boolean): SessionSummary {
  const metadata = sessionListMetadata(session.events)
  return {
    sessionId: session.id,
    updatedAt: sessionListUpdatedAt(session.header, metadata.lastPromptAt),
    running,
    blank: metadata.blank,
    ...sessionListFields(session.header, session.events),
  }
}

/** Verify cold-session blankness only when its artifact is within the configured read budget. */
async function probeColdSessionMetadata(
  ctx: Context,
  persistence: SessionPersistence,
  meta: SessionHeader,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<SessionListMetadata | undefined> {
  if (maxBytes === 0) return undefined
  signal?.throwIfAborted()
  const location = persistence.locate(meta)
  if (location === undefined) return undefined
  signal?.throwIfAborted()
  let size: number
  try {
    size = (await stat(location.path)).size
  } catch {
    signal?.throwIfAborted()
    return undefined
  }
  if (size > maxBytes) return undefined
  try {
    const { events } = await persistence.readFrom(meta.id, 0, signal)
    signal?.throwIfAborted()
    return sessionListMetadata(events)
  } catch (error) {
    signal?.throwIfAborted()
    ctx.logger.warn(`session.list: blank probe for "${meta.id}" failed (serving it as visible): ${String(error)}`)
    return undefined
  }
}

/**
 * Project one persisted but unattached session onto its list row.
 * @param ctx - Host context used for warnings and projections.
 * @param persistence - Session storage provider.
 * @param meta - Persisted session header.
 * @param lastPromptAt - Snapshot timestamp for the latest human prompt.
 * @param metadata - Cached session-list projection, when available.
 * @param blankProbeMaxBytes - Maximum artifact size eligible for a blankness read.
 * @param signal - Optional listing lifetime.
 * @returns Public session-list row.
 */
export async function summarizeColdSession(
  ctx: Context,
  persistence: SessionPersistence,
  meta: SessionHeader,
  lastPromptAt: number | null,
  metadata: SessionListMetadata | undefined,
  blankProbeMaxBytes: number,
  signal?: AbortSignal,
): Promise<SessionSummary> {
  const probed = metadata?.blank === false
    ? undefined
    : await probeColdSessionMetadata(ctx, persistence, meta, blankProbeMaxBytes, signal)
  return {
    sessionId: meta.id,
    updatedAt: sessionListUpdatedAt(meta, lastPromptAt),
    running: false,
    blank: metadata?.blank === false ? false : probed?.blank ?? false,
    ...sessionListFields(meta),
  }
}

/**
 * Compare session summaries using the stable newest-first ordering.
 * @param left - First summary.
 * @param right - Second summary.
 * @returns A sort comparator result.
 */
export function compareSessionSummaries(left: SessionSummary, right: SessionSummary): number {
  return right.updatedAt - left.updatedAt
    || String(left.sessionId).localeCompare(String(right.sessionId))
}
