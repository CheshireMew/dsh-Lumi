import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { createApiProxy } from '../src/api-proxy.ts'
import { RpcId, type RpcRequest } from '../src/api/index.ts'

const defaults = {
  defaultModelSelection: () => ({ provider: 'test', model: 'test' }),
  cwd: '/project',
}

let nextRequestId = 0

function request<T>(payload: T): RpcRequest<T> {
  return { rpcId: RpcId(`lifecycle-${nextRequestId++}`), payload }
}

function signal(): AbortSignal {
  return new AbortController().signal
}

function header(
  id: string,
  createdAt: number,
  parentSession?: SessionId,
): SessionHeader {
  return {
    version: 0,
    id: SessionId(id),
    createdAt,
    cwd: '/project',
    ...(parentSession === undefined ? {} : { parentSession }),
  }
}

async function baseContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  return ctx
}

function providePersistence(ctx: Context, initial: readonly SessionHeader[]) {
  const stored = new Map(initial.map(item => [item.id, structuredClone(item)]))
  const deleted: SessionId[] = []
  const persistence = {
    list: (signal?: AbortSignal) => {
      signal?.throwIfAborted()
      return Promise.resolve([...stored.values()].map(item => structuredClone(item)))
    },
    listSnapshots: (signal?: AbortSignal) => {
      signal?.throwIfAborted()
      return Promise.resolve([...stored.values()].map(item => ({
        header: structuredClone(item),
        lastPromptAt: null,
        revision: `test:${item.id}`,
      })))
    },
    locate: () => undefined,
    delete: async (id: SessionId, signal?: AbortSignal) => {
      signal?.throwIfAborted()
      if (!stored.delete(id)) throw new SessionPersistenceNotFoundError(id)
      deleted.push(id)
    },
  }
  ctx.provide('sessionPersistence', persistence as never)
  return { stored, deleted, persistence }
}

describe('session.list pagination', () => {
  it('retains one deterministic newest-first observation across timestamp ties', async () => {
    const ctx = await baseContext()
    try {
      // Deliberately publish out of sort order; the stable identity tiebreak is
      // part of the continuation contract, not an insertion-order accident.
      for (const item of [
        header('tie-b', 200),
        header('old', 100),
        header('new', 300),
        header('tie-a', 200),
      ]) ctx.sessions.create(item.id, { meta: item })
      const api = createApiProxy(ctx, defaults)

      const first = await api.sessions.list(request({ limit: 2 }))
      expect(first.result).toMatchObject({
        ok: true,
        value: { items: [{ sessionId: 'new' }, { sessionId: 'tie-a' }] },
      })
      if (!first.result.ok) throw new Error('unreachable')
      const cursor = first.result.value.nextCursor
      expect(cursor).toBeTypeOf('string')
      if (cursor === undefined) throw new Error('unreachable')

      // A row published after page one belongs to the next refresh, never this
      // retained observation. Fresh-per-page pagination would append it here.
      const late = header('late', 50)
      ctx.sessions.create(late.id, { meta: late })

      const second = await api.sessions.list(request({ limit: 2, cursor }))
      expect(second.result).toMatchObject({
        ok: true,
        value: { items: [{ sessionId: 'tie-b' }, { sessionId: 'old' }] },
      })
      if (!second.result.ok) throw new Error('unreachable')
      expect(second.result.value.nextCursor).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports an evicted snapshot cursor as stale rather than malformed', async () => {
    const ctx = await baseContext()
    try {
      for (const item of [header('three', 3), header('two', 2), header('one', 1)]) {
        ctx.sessions.create(item.id, { meta: item })
      }
      const api = createApiProxy(ctx, { ...defaults, sessionListMaxSnapshots: 1 })
      const first = await api.sessions.list(request({ limit: 1 }))
      if (!first.result.ok) throw new Error('unreachable')
      const evictedCursor = first.result.value.nextCursor
      if (evictedCursor === undefined) throw new Error('unreachable')

      await api.sessions.list(request({ limit: 1 }))
      const stale = await api.sessions.list(request({ limit: 1, cursor: evictedCursor }))
      expect(stale.result).toMatchObject({
        ok: false,
        error: { code: 'session-list-cursor-stale' },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('returns a typed business error for malformed continuation state', async () => {
    const ctx = await baseContext()
    try {
      const response = await createApiProxy(ctx, defaults).sessions.list(request({ cursor: 'not-base64!' }))
      expect(response.result).toMatchObject({
        ok: false,
        error: { code: 'session-list-cursor-invalid' },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('session.delete orchestration', () => {
  it('rejects descendants without recursive authority and otherwise deletes child-first', async () => {
    const ctx = await baseContext()
    try {
      const root = header('root', 1)
      const childB = header('child-b', 2, root.id)
      const childA = header('child-a', 3, root.id)
      const grandchild = header('grandchild', 4, childA.id)
      const storage = providePersistence(ctx, [root, childB, childA, grandchild])
      const api = createApiProxy(ctx, defaults)

      const rejected = await api.sessions.delete(request({ sessionId: root.id, recursive: false }), signal())
      expect(rejected.result).toMatchObject({
        ok: false,
        error: { code: 'session-has-descendants', details: { descendantCount: 3 } },
      })
      expect(storage.deleted).toEqual([])

      const deleted = await api.sessions.delete(request({ sessionId: root.id, recursive: true }), signal())
      expect(deleted.result).toEqual({
        ok: true,
        value: { deletedSessionIds: [grandchild.id, childA.id, childB.id, root.id] },
      })
      expect(storage.deleted).toEqual([grandchild.id, childA.id, childB.id, root.id])
      expect(storage.stored.size).toBe(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('preflights the whole descendant tree and performs no deletion when any member is live', async () => {
    const ctx = await baseContext()
    try {
      const root = header('root-live-tree', 1)
      const liveChild = header('live-child', 2, root.id)
      const storage = providePersistence(ctx, [root])
      ctx.sessions.create(liveChild.id, { meta: liveChild })

      const response = await createApiProxy(ctx, defaults).sessions.delete(
        request({ sessionId: root.id, recursive: true }),
        signal(),
      )
      expect(response.result).toMatchObject({
        ok: false,
        error: { code: 'session-delete-live', details: { sessionId: liveChild.id } },
      })
      expect(storage.deleted).toEqual([])
      expect(storage.stored.has(root.id)).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('can be retried after cancellation interrupts a partially committed recursive delete', async () => {
    const ctx = await baseContext()
    try {
      const root = header('retry-root', 1)
      const child = header('retry-child', 2, root.id)
      const storage = providePersistence(ctx, [root, child])
      const controller = new AbortController()
      const originalDelete = storage.persistence.delete
      storage.persistence.delete = vi.fn(async (id: SessionId, signal?: AbortSignal) => {
        await originalDelete(id, signal)
        controller.abort(new Error('stop after first commit'))
      })
      const api = createApiProxy(ctx, defaults)

      const interrupted = await api.sessions.delete(
        request({ sessionId: root.id, recursive: true }),
        controller.signal,
      )
      expect(interrupted.result).toMatchObject({ ok: false, error: { code: 'cancelled' } })
      expect(storage.deleted).toEqual([child.id])
      expect(storage.stored.has(root.id)).toBe(true)

      storage.persistence.delete = originalDelete
      const retried = await api.sessions.delete(request({ sessionId: root.id, recursive: true }), signal())
      expect(retried.result).toEqual({
        ok: true,
        value: { deletedSessionIds: [root.id] },
      })
      expect(storage.stored.size).toBe(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
