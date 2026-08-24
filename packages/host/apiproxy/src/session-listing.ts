import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { SESSION_LIST_DEFAULT_LIMIT } from '@deepseek-ai/dsh-api-protocol/api/sessions.schema'
import type { SessionSummary } from '@deepseek-ai/dsh-api-protocol/api'
import { listProjectionsFor } from './session-history.ts'
import {
  compareSessionSummaries,
  summarizeColdSession,
  summarizeSession,
} from './session-summary.ts'

/** Default maximum artifact size eligible for one cold blankness read. */
export const DEFAULT_COLD_BLANK_PROBE_MAX_BYTES = 1024
/** Default maximum cold-session summaries resolved concurrently. */
export const DEFAULT_COLD_SUMMARY_BATCH_SIZE = 16
/** Default lifetime of one incomplete session-list snapshot cursor. */
export const DEFAULT_SESSION_LIST_SNAPSHOT_TTL_MS = 60_000
/** Default maximum incomplete session-list snapshots retained by one gateway. */
export const DEFAULT_SESSION_LIST_MAX_SNAPSHOTS = 8

interface SessionListCursorPayload {
  readonly version: 1
  readonly snapshotId: string
  readonly offset: number
}

/** An invalid or non-canonical session-list cursor. */
export class SessionListCursorError extends Error {
  constructor(options?: ErrorOptions) {
    super('invalid session list cursor', options)
    this.name = 'SessionListCursorError'
  }
}

/** A session-list cursor whose retained observation has expired. */
export class SessionListCursorStaleError extends Error {
  constructor() {
    super('session list cursor expired; restart from the first page')
    this.name = 'SessionListCursorStaleError'
  }
}

function encodeSessionListCursor(snapshotId: string, offset: number): string {
  const payload: SessionListCursorPayload = { version: 1, snapshotId, offset }
  return Buffer.from(JSON.stringify(payload)).toString('base64url')
}

function decodeSessionListCursor(cursor: string): SessionListCursorPayload {
  let decoded: Buffer
  let value: unknown
  try {
    decoded = Buffer.from(cursor, 'base64url')
    if (decoded.toString('base64url') !== cursor) throw new Error('non-canonical base64url')
    value = JSON.parse(decoded.toString('utf8'))
  } catch (error: unknown) {
    throw new SessionListCursorError({ cause: error })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SessionListCursorError()
  }
  const payload = value as Partial<SessionListCursorPayload>
  if (payload.version !== 1
    || typeof payload.snapshotId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(payload.snapshotId)
    || !Number.isSafeInteger(payload.offset)
    || (payload.offset as number) <= 0) {
    throw new SessionListCursorError()
  }
  return payload as SessionListCursorPayload
}

/** Bounded cold-read and cursor-retention settings for session listing. */
export interface SessionListingOptions {
  coldBlankProbeMaxBytes?: number
  coldSummaryBatchSize?: number
  sessionListSnapshotTtlMs?: number
  sessionListMaxSnapshots?: number
}

/** Own list visibility, cold-summary reads, and cursor snapshot retention. */
export class SessionListing {
  private readonly snapshots = new Map<string, {
    items: readonly SessionSummary[]
    expiresAt: number
  }>()
  private readonly coldBlankProbeMaxBytes: number
  private readonly coldSummaryBatchSize: number
  private readonly snapshotTtlMs: number
  private readonly maxSnapshots: number

  /** Configure one gateway's bounded session-list observation cache. */
  constructor(private readonly ctx: Context, options: SessionListingOptions) {
    this.coldBlankProbeMaxBytes = options.coldBlankProbeMaxBytes
      ?? DEFAULT_COLD_BLANK_PROBE_MAX_BYTES
    this.coldSummaryBatchSize = options.coldSummaryBatchSize
      ?? DEFAULT_COLD_SUMMARY_BATCH_SIZE
    this.snapshotTtlMs = options.sessionListSnapshotTtlMs
      ?? DEFAULT_SESSION_LIST_SNAPSHOT_TTL_MS
    this.maxSnapshots = options.sessionListMaxSnapshots
      ?? DEFAULT_SESSION_LIST_MAX_SNAPSHOTS
  }

  /**
   * Build the attached and persisted session-list baseline.
   * @param signal - Optional listing lifetime.
   * @returns Visible session summaries in stable newest-first order.
   */
  async listSummaries(signal?: AbortSignal): Promise<SessionSummary[]> {
    signal?.throwIfAborted()
    const summarizeAttached = (session: Session): SessionSummary => {
      const agent = this.ctx.agents.get(session.id)
      const projections = listProjectionsFor(this.ctx, session.header, session)
      return {
        ...summarizeSession(session, agent?.status === 'running'),
        ...projections === undefined ? {} : { projections },
      }
    }
    const items = this.ctx.sessions.list().map(summarizeAttached)
    signal?.throwIfAborted()
    const attached = new Set(items.map(item => item.sessionId))
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence !== undefined) {
      const cold = (await persistence.listSnapshots(signal))
        .filter(snapshot => !attached.has(snapshot.header.id) && snapshot.header.cwd !== undefined)
      signal?.throwIfAborted()
      for (let offset = 0; offset < cold.length; offset += this.coldSummaryBatchSize) {
        signal?.throwIfAborted()
        const batch = cold.slice(offset, offset + this.coldSummaryBatchSize)
        const settled = await Promise.allSettled(batch.map(async (snapshot) => {
          const meta = snapshot.header
          const projections = listProjectionsFor(this.ctx, meta, undefined)
          const summary = await summarizeColdSession(
            this.ctx,
            persistence,
            meta,
            snapshot.lastPromptAt,
            projections?.values.sessionListMetadata,
            this.coldBlankProbeMaxBytes,
            signal,
          )
          const attachedSession = this.ctx.sessions.get(meta.id)
          if (attachedSession !== undefined) return summarizeAttached(attachedSession)
          return {
            ...summary,
            ...projections === undefined ? {} : { projections },
          }
        }))
        const summaries: SessionSummary[] = []
        let rejected = false
        let failure: unknown
        for (const result of settled) {
          if (result.status === 'fulfilled') summaries.push(result.value)
          else if (!rejected) {
            rejected = true
            failure = result.reason
          }
        }
        if (rejected) throw failure
        signal?.throwIfAborted()
        items.push(...summaries)
      }
    }
    items.sort(compareSessionSummaries)
    return items
  }

  /**
   * Slice one page from an immutable visibility observation.
   * @param cursor - Cursor for a retained observation, or undefined for a fresh list.
   * @param limit - Maximum rows returned in this page.
   * @returns Page rows and the next cursor when more rows remain.
   */
  async listPage(
    cursor: string | undefined,
    limit = SESSION_LIST_DEFAULT_LIMIT,
  ): Promise<{ items: SessionSummary[]; nextCursor?: string }> {
    const now = Date.now()
    this.pruneSnapshots(now)
    if (cursor !== undefined) {
      const key = decodeSessionListCursor(cursor)
      const snapshot = this.snapshots.get(key.snapshotId)
      if (snapshot === undefined || snapshot.expiresAt <= now) {
        this.snapshots.delete(key.snapshotId)
        throw new SessionListCursorStaleError()
      }
      if (key.offset >= snapshot.items.length) throw new SessionListCursorError()
      const page = snapshot.items.slice(key.offset, key.offset + limit)
      const nextOffset = key.offset + page.length
      const hasMore = nextOffset < snapshot.items.length
      this.snapshots.delete(key.snapshotId)
      if (hasMore) {
        this.snapshots.set(key.snapshotId, {
          items: snapshot.items,
          expiresAt: now + this.snapshotTtlMs,
        })
      }
      return {
        items: page,
        ...(hasMore ? { nextCursor: encodeSessionListCursor(key.snapshotId, nextOffset) } : {}),
      }
    }
    const items = await this.listSummaries()
    const page = items.slice(0, limit)
    const hasMore = page.length < items.length
    if (!hasMore) return { items: page }
    this.pruneSnapshots(Date.now(), 1)
    const snapshotId = randomUUID()
    this.snapshots.set(snapshotId, {
      items,
      expiresAt: Date.now() + this.snapshotTtlMs,
    })
    return {
      items: page,
      nextCursor: encodeSessionListCursor(snapshotId, page.length),
    }
  }

  /** Drop expired snapshots and keep retained observations within the configured bound. */
  private pruneSnapshots(now: number, reserve = 0): void {
    for (const [snapshotId, snapshot] of this.snapshots) {
      if (snapshot.expiresAt <= now) this.snapshots.delete(snapshotId)
    }
    while (this.snapshots.size + reserve > this.maxSnapshots) {
      const oldest = this.snapshots.keys().next().value
      if (oldest === undefined) return
      this.snapshots.delete(oldest)
    }
  }
}
