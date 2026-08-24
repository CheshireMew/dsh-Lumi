/** Persistent derived index for sublinear session-list pages. */

import { mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import {
  advanceLastHumanPromptAt, Session, SessionId,
  type SessionEvent, type SessionHeader,
} from '@deepseek-ai/dsh-session'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'

const APPLICATION_ID = 0x4453484c
const SCHEMA_VERSION = 2

interface IndexRow {
  id: string
  header_json: string
  last_prompt_at: number | null
  updated_at: number
  running: number
  revision: string
}

/** One lightweight row materialized from the derived index. */
export interface IndexedSession {
  readonly header: SessionHeader
  readonly lastPromptAt: number | null
  readonly updatedAt: number
  readonly running: boolean
}

/** Stable key used for continuation within one index generation. */
export interface SessionIndexKey {
  readonly updatedAt: number
  readonly sessionId: SessionId
}

/** One keyset page from a single index generation. */
export interface SessionIndexPage {
  readonly generation: number
  readonly items: readonly IndexedSession[]
  readonly hasMore: boolean
}

interface CatalogRecord extends IndexedSession {
  readonly revision: string
}

/** Create a missing database without changing permissions on an existing file. */
async function createDatabaseFile(path: string): Promise<void> {
  try {
    const handle = await open(path, 'wx', 0o600)
    await handle.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/** Durable session-list read model. The session log remains authoritative. */
export class SessionListIndex {
  private db: DatabaseSync | undefined
  private readonly ready: Promise<void>
  private mutations = Promise.resolve()
  private readonly reconciliations = new Set<Promise<void>>()
  private readonly livePromptTimes = new Map<SessionId, number | null>()
  private mutationFailed = false
  private closing = false
  private closePromise: Promise<void> | undefined

  /**
   * @param ctx - Host context carrying live and persisted session sources.
   * @param path - Dedicated derived-index path, or `:memory:` for tests.
   */
  constructor(
    private readonly ctx: Context,
    private readonly path: string,
    private readonly historyRetentionMs = 60_000,
  ) {
    if (!Number.isSafeInteger(historyRetentionMs) || historyRetentionMs < 1) {
      throw new RangeError('session-list index history retention must be a positive safe integer')
    }
    this.ready = this.open()
    const disposers = [
      ctx.on('session/created', (session) => { this.queueUpsert(this.liveRecord(session)) }),
      ctx.on('session/event', (session, event) => { this.queueSessionEvent(session, event) }),
      ctx.on('session/disposed', (session) => {
        if (session.events.length === 0) this.queueDelete(session.id)
        else this.queueUpsert(this.liveRecord(session, false))
        this.livePromptTimes.delete(session.id)
      }),
      ctx.on('session-persistence/deleted', (sessionId) => { this.queueDelete(sessionId) }),
      ctx.on('agent/status', ({ agent, status }: { agent: Agent; status: AgentStatus }) => {
        this.queueUpsert(this.liveRecord(agent.session, status === 'running'))
      }),
    ]
    ctx.effect(() => () => {
      for (const dispose of disposers) dispose()
      return this.close()
    }, 'api-proxy: session-list index')
  }

  /**
   * Read one ordered page without scanning or sorting the complete catalog.
   * @param limit - Maximum number of rows returned.
   * @param expectedGeneration - Leased generation for a continuation page.
   * @param after - Exclusive ordering key from the preceding page.
   * @param signal - Optional request cancellation signal.
   * @returns The indexed rows, generation, and continuation indicator.
   */
  async page(
    limit: number,
    expectedGeneration?: number,
    after?: SessionIndexKey,
    signal?: AbortSignal,
  ): Promise<SessionIndexPage> {
    signal?.throwIfAborted()
    await this.ready
    await this.settleMutations()
    signal?.throwIfAborted()
    const db = this.requireDb()
    const generation = expectedGeneration ?? this.generation(db)
    const retained = db.prepare(
      'UPDATE index_generations SET retain_until = MAX(retain_until, ?) WHERE generation = ?',
    ).run(Date.now() + this.historyRetentionMs, generation)
    if (retained.changes !== 1) {
      throw new SessionListIndexStaleError()
    }
    const current = expectedGeneration === undefined
    const rows = (current
      ? (after === undefined
        ? db.prepare(`
          SELECT id, header_json, last_prompt_at, updated_at, running, revision
          FROM sessions
          WHERE valid_to IS NULL
          ORDER BY updated_at DESC, id ASC
          LIMIT ?
        `).all(limit + 1)
        : db.prepare(`
          SELECT id, header_json, last_prompt_at, updated_at, running, revision
          FROM sessions
          WHERE valid_to IS NULL
            AND (updated_at < ? OR (updated_at = ? AND id > ?))
          ORDER BY updated_at DESC, id ASC
          LIMIT ?
        `).all(after.updatedAt, after.updatedAt, after.sessionId, limit + 1))
      : (after === undefined
        ? db.prepare(`
          SELECT id, header_json, last_prompt_at, updated_at, running, revision
          FROM sessions
          WHERE valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
          ORDER BY updated_at DESC, id ASC
          LIMIT ?
        `).all(generation, generation, limit + 1)
        : db.prepare(`
          SELECT id, header_json, last_prompt_at, updated_at, running, revision
          FROM sessions
          WHERE valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
            AND (updated_at < ? OR (updated_at = ? AND id > ?))
          ORDER BY updated_at DESC, id ASC
          LIMIT ?
        `).all(
          generation, generation,
          after.updatedAt, after.updatedAt, after.sessionId, limit + 1,
        ))) as unknown as IndexRow[]
    signal?.throwIfAborted()
    return {
      generation,
      items: rows.slice(0, limit).map(row => this.readRow(row)),
      hasMore: rows.length > limit,
    }
  }

  /**
   * Reconcile the derived index from the whole-store authority off the request path.
   * @param signal - Optional cancellation signal for persistence enumeration.
   */
  async reconcile(signal?: AbortSignal): Promise<void> {
    await this.ready
    await this.trackReconciliation(true, signal)
  }

  /** Open, validate, and mark the current process as an unclean index owner. */
  private async open(): Promise<void> {
    const actual = this.path === ':memory:' ? this.path : resolve(this.path)
    if (actual !== ':memory:') {
      await mkdir(dirname(actual), { recursive: true, mode: 0o700 })
      await createDatabaseFile(actual)
    }
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(actual)
    this.db = db
    try {
      const application = db.prepare('PRAGMA application_id').get() as { application_id: number }
      if (application.application_id !== 0 && application.application_id !== APPLICATION_ID) {
        throw new Error(`session-list index at "${actual}" belongs to another application`)
      }
      const version = db.prepare('PRAGMA user_version').get() as { user_version: number }
      if (application.application_id === APPLICATION_ID && version.user_version !== SCHEMA_VERSION) {
        db.exec('DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS index_generations; DROP TABLE IF EXISTS index_state')
      }
      db.exec('PRAGMA journal_mode = WAL')
      db.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
      db.exec(`
        CREATE TABLE IF NOT EXISTS index_state (
          singleton  INTEGER PRIMARY KEY CHECK (singleton = 1),
          generation INTEGER NOT NULL,
          clean      INTEGER NOT NULL CHECK (clean IN (0, 1))
        ) STRICT;
        INSERT OR IGNORE INTO index_state (singleton, generation, clean) VALUES (1, 0, 0);
        CREATE TABLE IF NOT EXISTS index_generations (
          generation INTEGER PRIMARY KEY,
          retain_until INTEGER NOT NULL
        ) STRICT;
        INSERT OR IGNORE INTO index_generations (generation, retain_until) VALUES (0, 0);
        CREATE TABLE IF NOT EXISTS sessions (
          id             TEXT NOT NULL,
          valid_from     INTEGER NOT NULL,
          valid_to       INTEGER,
          header_json    TEXT NOT NULL,
          last_prompt_at INTEGER,
          updated_at     INTEGER NOT NULL,
          running        INTEGER NOT NULL CHECK (running IN (0, 1)),
          revision       TEXT NOT NULL,
          PRIMARY KEY (id, valid_from),
          CHECK (valid_to IS NULL OR valid_to > valid_from)
        ) STRICT;
        CREATE UNIQUE INDEX IF NOT EXISTS sessions_current_id
          ON sessions(id) WHERE valid_to IS NULL;
        CREATE INDEX IF NOT EXISTS sessions_current_order
          ON sessions(updated_at DESC, id ASC) WHERE valid_to IS NULL;
        CREATE INDEX IF NOT EXISTS sessions_version_visibility
          ON sessions(valid_from, valid_to, updated_at DESC, id ASC);
        PRAGMA user_version = ${SCHEMA_VERSION};
      `)
      const state = db.prepare(
        'SELECT clean FROM index_state WHERE singleton = 1',
      ).get() as { clean: number }
      // Cursors never survive a gateway process, so startup can discard every
      // predecessor while retaining the current derived catalog.
      db.prepare('DELETE FROM sessions WHERE valid_to IS NOT NULL').run()
      db.prepare('DELETE FROM index_generations WHERE generation < ?').run(this.generation(db))
      db.prepare('UPDATE index_state SET clean = 0 WHERE singleton = 1').run()
      if (state.clean === 1) {
        void this.trackReconciliation(true).catch((error: unknown) => {
          this.ctx.logger.warn(`session-list index background reconciliation failed: ${String(error)}`)
        })
      } else {
        await this.reconcileFromAuthority(true)
      }
    } catch (error: unknown) {
      db.close()
      this.db = undefined
      throw error
    }
  }

  /** Build one authoritative catalog cut and commit it after earlier live mutations. */
  private async reconcileFromAuthority(includeLive: boolean, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const persistence = this.ctx.get('sessionPersistence')
    const snapshots = persistence === undefined ? [] : await persistence.listSnapshots(signal)
    signal?.throwIfAborted()
    const records = new Map<SessionId, CatalogRecord>()
    for (const snapshot of snapshots) records.set(snapshot.header.id, this.persistedRecord(snapshot))
    if (includeLive) {
      for (const session of this.ctx.sessions.list()) records.set(session.id, this.liveRecord(session))
    }
    await this.enqueueMutation(() => { this.replaceCatalog(records) })
  }

  /** Track authority reads so graceful close cannot overtake an in-flight reconciliation. */
  private trackReconciliation(includeLive: boolean, signal?: AbortSignal): Promise<void> {
    if (this.closing) return Promise.resolve()
    const pending = this.reconcileFromAuthority(includeLive, signal)
    this.reconciliations.add(pending)
    void pending.finally(() => { this.reconciliations.delete(pending) }).catch(() => {})
    return pending
  }

  /** Replace the complete derived catalog in one transaction and advance one generation if changed. */
  private replaceCatalog(records: ReadonlyMap<SessionId, CatalogRecord>): void {
    const db = this.requireDb()
    const existing = new Map(
      (db.prepare(`
        SELECT id, header_json, last_prompt_at, updated_at, running, revision
        FROM sessions WHERE valid_to IS NULL
      `).all() as unknown as IndexRow[]).map(row => [SessionId(row.id), row]),
    )
    const changed: CatalogRecord[] = []
    const removed: SessionId[] = []
    for (const record of records.values()) {
      const row = existing.get(record.header.id)
      existing.delete(record.header.id)
      if (row === undefined || !this.rowMatches(row, record)) changed.push(record)
    }
    removed.push(...existing.keys())
    if (changed.length === 0 && removed.length === 0) return
    db.exec('BEGIN IMMEDIATE')
    try {
      const generation = this.advanceGeneration(db)
      const close = db.prepare('UPDATE sessions SET valid_to = ? WHERE id = ? AND valid_to IS NULL')
      const insert = this.prepareInsert(db)
      for (const record of changed) {
        close.run(generation, record.header.id)
        this.insertRecord(insert, record, generation)
      }
      for (const id of removed) close.run(generation, id)
      this.pruneHistory(db, generation)
      db.exec('COMMIT')
    } catch (error: unknown) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  /** Persist only session events that change list ordering metadata. */
  private queueSessionEvent(session: Session, event: SessionEvent): void {
    if (!this.livePromptTimes.has(session.id)) {
      this.queueUpsert(this.liveRecord(session))
      return
    }
    const previous = this.livePromptTimes.get(session.id) ?? null
    const next = advanceLastHumanPromptAt(previous, event)
    if (next === previous) return
    this.livePromptTimes.set(session.id, next)
    this.queueUpsert(this.liveRecord(session))
  }

  /** Queue one live-row replacement without throwing into the event emitter. */
  private queueUpsert(record: CatalogRecord): void {
    void this.ready.then(() => this.enqueueMutation(() => {
      this.replaceRecord(record)
    })).catch((error: unknown) => {
      this.mutationFailed = true
      this.ctx.logger.warn(`session-list index update failed for "${record.header.id}": ${String(error)}`)
    })
  }

  /** Queue one row removal without throwing into the event emitter. */
  private queueDelete(id: SessionId): void {
    void this.ready.then(() => this.enqueueMutation(() => {
      this.deleteRecord(id)
    })).catch((error: unknown) => {
      this.mutationFailed = true
      this.ctx.logger.warn(`session-list index delete failed for "${id}": ${String(error)}`)
    })
  }

  /** Serialize derived-index writes; a failed write leaves the next request to reconcile. */
  private enqueueMutation(operation: () => void): Promise<void> {
    const pending = this.mutations.then(operation)
    this.mutations = pending.catch(() => {})
    return pending
  }

  /** Repair a failed incremental update before serving another observation. */
  private async settleMutations(): Promise<void> {
    await this.mutations
    if (!this.mutationFailed) return
    this.mutationFailed = false
    try {
      await this.reconcileFromAuthority(true)
    } catch (error: unknown) {
      this.mutationFailed = true
      throw error
    }
  }

  /** Replace one current row in a generation-preserving transaction. */
  private replaceRecord(record: CatalogRecord): void {
    const db = this.requireDb()
    const row = db.prepare(`
      SELECT id, header_json, last_prompt_at, updated_at, running, revision
      FROM sessions WHERE id = ? AND valid_to IS NULL
    `).get(record.header.id) as unknown as IndexRow | undefined
    if (row !== undefined && this.rowMatches(row, record)) return
    db.exec('BEGIN IMMEDIATE')
    try {
      const generation = this.advanceGeneration(db)
      db.prepare('UPDATE sessions SET valid_to = ? WHERE id = ? AND valid_to IS NULL')
        .run(generation, record.header.id)
      this.insertRecord(this.prepareInsert(db), record, generation)
      this.pruneHistory(db, generation)
      db.exec('COMMIT')
    } catch (error: unknown) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  /** Close one current row while retaining active cursor generations. */
  private deleteRecord(id: SessionId): void {
    const db = this.requireDb()
    const exists = db.prepare('SELECT 1 FROM sessions WHERE id = ? AND valid_to IS NULL').get(id)
    if (exists === undefined) return
    db.exec('BEGIN IMMEDIATE')
    try {
      const generation = this.advanceGeneration(db)
      db.prepare('UPDATE sessions SET valid_to = ? WHERE id = ? AND valid_to IS NULL').run(generation, id)
      this.pruneHistory(db, generation)
      db.exec('COMMIT')
    } catch (error: unknown) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  /** Prepare the reusable row insert used by bulk reconciliation. */
  private prepareInsert(db: DatabaseSync): StatementSync {
    return db.prepare(`
      INSERT INTO sessions (
        id, valid_from, valid_to, header_json, last_prompt_at, updated_at, running, revision
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)
    `)
  }

  /** Insert one detached catalog record as the current version. */
  private insertRecord(insert: StatementSync, record: CatalogRecord, generation: number): void {
    insert.run(
      record.header.id,
      generation,
      JSON.stringify(record.header),
      record.lastPromptAt,
      record.updatedAt,
      record.running ? 1 : 0,
      record.revision,
    )
  }

  /** Compare current row fields without reparsing the validated header. */
  private rowMatches(row: IndexRow, record: CatalogRecord): boolean {
    return row.header_json === JSON.stringify(record.header)
      && row.last_prompt_at === record.lastPromptAt
      && row.updated_at === record.updatedAt
      && row.running === (record.running ? 1 : 0)
      && row.revision === record.revision
  }

  /** Remove predecessor rows whose last cursor lease has expired. */
  private pruneHistory(db: DatabaseSync, currentGeneration: number): void {
    const expired = db.prepare(`
      SELECT MAX(generation) AS generation
      FROM index_generations
      WHERE generation < ? AND retain_until < ?
    `).get(currentGeneration, Date.now()) as { generation: number | null }
    if (expired.generation === null) return
    db.prepare('DELETE FROM index_generations WHERE generation <= ?').run(expired.generation)
    const oldest = db.prepare(
      'SELECT MIN(generation) AS generation FROM index_generations',
    ).get() as { generation: number }
    db.prepare('DELETE FROM sessions WHERE valid_to IS NOT NULL AND valid_to <= ?').run(oldest.generation)
  }

  /** Materialize one live row from the exact in-memory event log. */
  private liveRecord(session: Session, running?: boolean): CatalogRecord {
    let lastPromptAt: number | null = this.livePromptTimes.get(session.id) ?? null
    if (!this.livePromptTimes.has(session.id)) {
      lastPromptAt = null
      for (const event of session.events) lastPromptAt = advanceLastHumanPromptAt(lastPromptAt, event)
    }
    this.livePromptTimes.set(session.id, lastPromptAt ?? null)
    return {
      header: session.header,
      lastPromptAt,
      updatedAt: Math.max(session.header.createdAt, lastPromptAt ?? 0),
      running: running ?? this.ctx.agents.get(session.id)?.status === 'running',
      revision: `live:${lastPromptAt ?? 'none'}`,
    }
  }

  /** Materialize one cold row from the persistence provider's lightweight snapshot. */
  private persistedRecord(snapshot: SessionPersistenceSnapshot): CatalogRecord {
    return {
      header: snapshot.header,
      lastPromptAt: snapshot.lastPromptAt,
      updatedAt: Math.max(snapshot.header.createdAt, snapshot.lastPromptAt ?? 0),
      running: false,
      revision: snapshot.revision,
    }
  }

  /** Validate and detach one derived durable row before it reaches callers. */
  private readRow(row: IndexRow): IndexedSession {
    const id = SessionId(row.id)
    const header = Session.create(id, undefined, JSON.parse(row.header_json) as SessionHeader).header
    if (!Number.isSafeInteger(row.updated_at) || row.updated_at < 0) {
      throw new Error(`session-list index row "${id}" has an invalid update timestamp`)
    }
    if (row.last_prompt_at !== null
      && (!Number.isSafeInteger(row.last_prompt_at) || row.last_prompt_at < 0)) {
      throw new Error(`session-list index row "${id}" has an invalid prompt timestamp`)
    }
    return {
      header,
      lastPromptAt: row.last_prompt_at,
      updatedAt: row.updated_at,
      running: row.running === 1,
    }
  }

  /** Advance the observation generation and register its cursor lease row. */
  private advanceGeneration(db: DatabaseSync): number {
    db.prepare('UPDATE index_state SET generation = generation + 1 WHERE singleton = 1').run()
    const generation = this.generation(db)
    db.prepare('INSERT INTO index_generations (generation, retain_until) VALUES (?, 0)').run(generation)
    return generation
  }

  /** Read the current observation generation. */
  private generation(db: DatabaseSync): number {
    return (db.prepare(
      'SELECT generation FROM index_state WHERE singleton = 1',
    ).get() as { generation: number }).generation
  }

  /** Flush the authority, commit a persistence-only catalog, and mark a graceful close. */
  private close(): Promise<void> {
    this.closePromise ??= (async () => {
      try {
        await this.ready
        this.closing = true
        await Promise.allSettled([...this.reconciliations])
        for (const session of this.ctx.sessions.list()) await this.ctx.sessions.flush(session)
        await this.reconcileFromAuthority(false)
        await this.mutations
        this.requireDb().prepare('UPDATE index_state SET clean = 1 WHERE singleton = 1').run()
      } finally {
        this.db?.close()
        this.db = undefined
      }
    })()
    return this.closePromise
  }

  private requireDb(): DatabaseSync {
    if (this.db === undefined) throw new Error('session-list index is closed')
    return this.db
  }
}

/** Cursor generation whose lease has expired from the derived index. */
export class SessionListIndexStaleError extends Error {
  constructor() {
    super('session-list index cursor generation expired')
    this.name = 'SessionListIndexStaleError'
  }
}
