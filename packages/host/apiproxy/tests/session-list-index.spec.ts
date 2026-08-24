import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import { SessionListIndex } from '../src/session-list-index.ts'

function header(index: number): SessionHeader {
  return {
    version: 0,
    id: SessionId(`indexed-${String(index).padStart(5, '0')}`),
    createdAt: index,
    cwd: 'C:\\workspace',
  }
}

describe('SessionListIndex', () => {
  it('serves bounded keyset pages after one authority reconciliation', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const snapshots = Array.from({ length: 2_000 }, (_, index) => ({
      header: header(index),
      lastPromptAt: index + 10_000,
      revision: SessionPersistenceRevision(`revision:${String(index)}`),
    }))
    const listSnapshots = vi.fn(async () => snapshots)
    ctx.provide('sessionPersistence', { listSnapshots } as never)
    const index = new SessionListIndex(ctx, ':memory:')

    const first = await index.page(25)
    const last = first.items.at(-1)
    if (last === undefined) throw new Error('missing first-page tail')
    const second = await index.page(25, first.generation, {
      updatedAt: last.updatedAt,
      sessionId: last.header.id,
    })

    expect(first.items).toHaveLength(25)
    expect(second.items).toHaveLength(25)
    expect(first.items[0]?.header.id).toBe('indexed-01999')
    expect(second.items[0]?.header.id).toBe('indexed-01974')
    expect(listSnapshots).toHaveBeenCalledTimes(1)
    await ctx.fiber.dispose()
  })

  it('keeps a leased continuation generation immutable across indexed mutations', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const rows = [0, 1, 2].map(index => ({
      header: header(index),
      lastPromptAt: index,
      revision: SessionPersistenceRevision(`revision:${String(index)}`),
    }))
    ctx.provide('sessionPersistence', { listSnapshots: async () => rows } as never)
    const index = new SessionListIndex(ctx, ':memory:')
    const first = await index.page(3)

    ctx.emit('session-persistence/deleted', rows[0]!.header.id)

    await expect(index.page(3, first.generation)).resolves.toMatchObject({
      items: [{ header: { id: 'indexed-00002' } }, { header: { id: 'indexed-00001' } }, { header: { id: 'indexed-00000' } }],
    })
    const current = await index.page(3)
    expect(current.items.map(item => item.header.id)).toEqual(['indexed-00002', 'indexed-00001'])
    await ctx.fiber.dispose()
  })
})
