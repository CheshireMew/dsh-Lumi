import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from './index.ts'

/** Minimal live-session identity consumed by {@link knownSessionIds}. */
export interface LiveSessionIdentity {
  /** Session identity currently owned by the live store. */
  readonly id: SessionId
}

/** Minimal derived row store needed by {@link pruneUnknownSessionRows}. */
export interface SessionSidecarRows {
  /** Current derived records keyed by owning Session id. */
  entries(): IterableIterator<[SessionId, unknown]>
  /** @param sessionId - orphaned owner id. @returns Whether a row was removed. */
  delete(sessionId: SessionId): Promise<boolean>
}

/**
 * Collect identities that still have either a durable log or a live owner.
 * Derived stores use this authority when pruning records after an interrupted
 * post-deletion cleanup.
 * @param persistence - authoritative durable session catalog.
 * @param liveSessions - current live session observations.
 * @param signal - optional cancellation for the durable listing.
 * @returns the union of durable and live session identities.
 */
export async function knownSessionIds(
  persistence: SessionPersistence,
  liveSessions: Iterable<LiveSessionIdentity>,
  signal?: AbortSignal,
): Promise<Set<SessionId>> {
  const known = new Set((await persistence.list(signal)).map(header => header.id))
  for (const session of liveSessions) known.add(session.id)
  return known
}

/**
 * Remove derived rows whose owning Session has neither durable nor live state.
 * @param persistence - authoritative durable session catalog.
 * @param liveSessions - current live session observations.
 * @param rows - derived rows keyed by Session id.
 * @param signal - optional cancellation for the durable listing.
 */
export async function pruneUnknownSessionRows(
  persistence: SessionPersistence,
  liveSessions: Iterable<LiveSessionIdentity>,
  rows: SessionSidecarRows,
  signal?: AbortSignal,
): Promise<void> {
  const known = await knownSessionIds(persistence, liveSessions, signal)
  for (const [sessionId] of rows.entries()) {
    if (!known.has(sessionId)) await rows.delete(sessionId)
  }
}
