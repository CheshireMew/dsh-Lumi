import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SESSION_LIST_DEFAULT_LIMIT } from '@deepseek-ai/dsh-api-protocol/api/sessions.schema'
import type { SessionSummary } from '@deepseek-ai/dsh-api-protocol/api'
import { listProjectionsFor } from './session-history.ts'
import {
  compareSessionSummaries,
  summarizeColdSession,
  summarizeSession,
} from './session-summary.ts'
import {
  SessionListIndex,
  SessionListIndexStaleError,
  type IndexedSession,
  type SessionIndexKey,
  type SessionIndexPage,
} from './session-list-index.ts'

/** Default maximum artifact size eligible for one cold blankness read. */
export const DEFAULT_COLD_BLANK_PROBE_MAX_BYTES = 1024
/** Default maximum cold-session summaries resolved concurrently. */
export const DEFAULT_COLD_SUMMARY_BATCH_SIZE = 16
/** Default lifetime of one incomplete session-list snapshot cursor. */
export const DEFAULT_SESSION_LIST_SNAPSHOT_TTL_MS = 60_000
interface SessionListCursorPayload {
  readonly version: 2
  readonly instanceId: string
  readonly issuedAt: number
  readonly generation: number
  readonly updatedAt: number
  readonly sessionId: string
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

function encodeSessionListCursor(payload: SessionListCursorPayload): string {
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
  if (payload.version !== 2
    || typeof payload.instanceId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(payload.instanceId)
    || !Number.isSafeInteger(payload.issuedAt)
    || (payload.issuedAt as number) < 0
    || !Number.isSafeInteger(payload.generation)
    || (payload.generation as number) < 0
    || !Number.isSafeInteger(payload.updatedAt)
    || (payload.updatedAt as number) < 0
    || typeof payload.sessionId !== 'string'
    || payload.sessionId.length === 0) {
    throw new SessionListCursorError()
  }
  return payload as SessionListCursorPayload
}

/** Bounded cold-read and cursor-retention settings for session listing. */
export interface SessionListingOptions {
  coldBlankProbeMaxBytes?: number
  coldSummaryBatchSize?: number
  sessionListSnapshotTtlMs?: number
  /** Dedicated persistent derived-index path; direct test construction defaults to memory. */
  sessionListIndexPath?: string
}

/** Own indexed list visibility, cold-summary reads, and stateless keyset cursors. */
export class SessionListing {
  private readonly instanceId = randomUUID()
  private readonly index: SessionListIndex
  private readonly coldBlankProbeMaxBytes: number
  private readonly coldSummaryBatchSize: number
  private readonly snapshotTtlMs: number

  /** Configure one gateway's bounded session-list observation cache. */
  constructor(private readonly ctx: Context, options: SessionListingOptions) {
    this.coldBlankProbeMaxBytes = options.coldBlankProbeMaxBytes
      ?? DEFAULT_COLD_BLANK_PROBE_MAX_BYTES
    this.coldSummaryBatchSize = options.coldSummaryBatchSize
      ?? DEFAULT_COLD_SUMMARY_BATCH_SIZE
    this.snapshotTtlMs = options.sessionListSnapshotTtlMs
      ?? DEFAULT_SESSION_LIST_SNAPSHOT_TTL_MS
    this.index = new SessionListIndex(
      ctx,
      options.sessionListIndexPath ?? ':memory:',
      this.snapshotTtlMs,
    )
  }

  /**
   * Build the attached and persisted session-list baseline.
   * @param signal - Optional listing lifetime.
   * @returns Visible session summaries in stable newest-first order.
   */
  async listSummaries(signal?: AbortSignal): Promise<SessionSummary[]> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      signal?.throwIfAborted()
      const items: SessionSummary[] = []
      let generation: number | undefined
      let after: SessionIndexKey | undefined
      try {
        for (;;) {
          const page = await this.index.page(256, generation, after, signal)
          generation ??= page.generation
          items.push(...await this.summarize(page.items, signal))
          if (!page.hasMore) return items
          const last = page.items.at(-1)
          if (last === undefined) return items
          after = { updatedAt: last.updatedAt, sessionId: last.header.id }
        }
      } catch (error: unknown) {
        if (!(error instanceof SessionListIndexStaleError) || attempt === 1) throw error
      }
    }
    /* v8 ignore next -- the retry loop either returns or throws. */
    throw new Error('session-list index retry exhausted')
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
    const decoded = cursor === undefined ? undefined : decodeSessionListCursor(cursor)
    if (decoded !== undefined
      && (decoded.instanceId !== this.instanceId || now - decoded.issuedAt > this.snapshotTtlMs)) {
      throw new SessionListCursorStaleError()
    }
    let page: SessionIndexPage
    try {
      page = await this.index.page(
        limit,
        decoded?.generation,
        decoded === undefined
          ? undefined
          : { updatedAt: decoded.updatedAt, sessionId: SessionId(decoded.sessionId) },
      )
    } catch (error: unknown) {
      if (error instanceof SessionListIndexStaleError) throw new SessionListCursorStaleError()
      throw error
    }
    const items = await this.summarize(page.items)
    const last = page.items.at(-1)
    return {
      items,
      ...(page.hasMore && last !== undefined
        ? {
          nextCursor: encodeSessionListCursor({
            version: 2,
            instanceId: this.instanceId,
            issuedAt: now,
            generation: page.generation,
            updatedAt: last.updatedAt,
            sessionId: last.header.id,
          }),
        }
        : {}),
    }
  }

  /** Resolve presenter projections and blankness only for rows in the requested page. */
  private async summarize(
    indexed: readonly IndexedSession[],
    signal?: AbortSignal,
  ): Promise<SessionSummary[]> {
    const persistence = this.ctx.get('sessionPersistence')
    const summarizeAttached = (session: Session, updatedAt: number): SessionSummary => {
      const projections = listProjectionsFor(this.ctx, session.header, session)
      return {
        ...summarizeSession(session, this.ctx.agents.get(session.id)?.status === 'running'),
        updatedAt,
        ...projections === undefined ? {} : { projections },
      }
    }
    const items: SessionSummary[] = []
    for (let offset = 0; offset < indexed.length; offset += this.coldSummaryBatchSize) {
      signal?.throwIfAborted()
      const batch = indexed.slice(offset, offset + this.coldSummaryBatchSize)
      const settled = await Promise.allSettled(batch.map(async (record) => {
        const attached = this.ctx.sessions.get(record.header.id)
        if (attached !== undefined) return summarizeAttached(attached, record.updatedAt)
        if (persistence === undefined || record.header.cwd === undefined) return undefined
        const projections = listProjectionsFor(this.ctx, record.header, undefined)
        const summary = await summarizeColdSession(
          this.ctx,
          persistence,
          record.header,
          record.lastPromptAt,
          projections?.values.sessionListMetadata,
          this.coldBlankProbeMaxBytes,
          signal,
        )
        const published = this.ctx.sessions.get(record.header.id)
        if (published !== undefined) {
          const live = summarizeSession(
            published,
            this.ctx.agents.get(published.id)?.status === 'running',
          )
          const liveProjections = listProjectionsFor(this.ctx, published.header, published)
          return {
            ...live,
            ...liveProjections === undefined ? {} : { projections: liveProjections },
          }
        }
        return {
          ...summary,
          ...projections === undefined ? {} : { projections },
        }
      }))
      const summaries: Array<SessionSummary | undefined> = []
      let failed = false
      let firstFailure: unknown
      for (const result of settled) {
        if (result.status === 'fulfilled') {
          summaries.push(result.value)
        } else if (!failed) {
          failed = true
          firstFailure = result.reason
        }
      }
      if (failed) throw firstFailure
      items.push(...summaries.filter((item): item is SessionSummary => item !== undefined))
    }
    return items.sort(compareSessionSummaries)
  }
}
