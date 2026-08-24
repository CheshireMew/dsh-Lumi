import { randomUUID } from 'node:crypto'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { WorkspaceId as brandWorkspaceId } from '@deepseek-ai/dsh-workspace'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import { SessionTitleInvalidError } from '@deepseek-ai/dsh-session-title'
import {
  ApiRemoteSessionNotFound as SessionNotFound,
  ApiRemoteSubagentSessionOwnership as SubagentSessionOwnership,
} from '@deepseek-ai/dsh-api-remotes'
import type { ApiProxy } from '@deepseek-ai/dsh-api-protocol/api'
import { err, ok } from '../rpc-result.ts'
import { isAborted } from '../prompt-content.ts'
import {
  SessionListCursorError,
  SessionListCursorStaleError,
} from '../session-listing.ts'
import { AgentPresetConflict, SessionCwdConflict } from '../session-runtime.ts'
import { presetFailure } from './agent-presets.ts'
import type { SessionApiDependencies } from './session-api-dependencies.ts'

type LifecycleApi = Pick<ApiProxy['sessions'],
  'list' | 'delete' | 'create' | 'rename' | 'fork' | 'cancel'>

/**
 * Build session identity, retention, naming, and lineage operations.
 * @param dependencies - Shared session-domain services and policy.
 * @returns Lifecycle-facing session API methods.
 */
export function createSessionLifecycleApi(dependencies: SessionApiDependencies): LifecycleApi {
  const { ctx, defaults, runtime, reader, listing } = dependencies
  return {
    async list(request) {
      try {
        return ok(request, await listing.listPage(request.payload.cursor, request.payload.limit))
      } catch (error: unknown) {
        if (error instanceof SessionListCursorStaleError) {
          return err(request, {
            code: 'session-list-cursor-stale',
            message: error.message,
            details: {},
          })
        }
        if (!(error instanceof SessionListCursorError)) throw error
        return err(request, {
          code: 'session-list-cursor-invalid',
          message: error.message,
          details: {},
        })
      }
    },

    async delete(request, signal) {
      const { sessionId, recursive = false } = request.payload
      if (isAborted(signal)) {
        return err(request, { code: 'cancelled', message: 'session deletion was aborted', details: {} })
      }
      const persistence = ctx.get('sessionPersistence')
      const storedHeaders = persistence === undefined ? [] : await persistence.list(signal)
      const storedIds = new Set(storedHeaders.map(header => header.id))
      const headers = new Map<SessionId, SessionHeader>(storedHeaders.map(header => [header.id, header]))
      for (const live of ctx.sessions.list()) headers.set(live.id, live.header)
      const children = new Map<SessionId, SessionId[]>()
      for (const header of headers.values()) {
        if (header.parentSession === undefined) continue
        const siblings = children.get(header.parentSession)
        if (siblings === undefined) children.set(header.parentSession, [header.id])
        else siblings.push(header.id)
      }
      for (const siblings of children.values()) {
        siblings.sort((left, right) => String(left).localeCompare(String(right)))
      }

      const reachable = new Set<SessionId>()
      const traversal = [sessionId]
      while (traversal.length > 0) {
        const current = traversal.pop() as SessionId
        if (reachable.has(current)) continue
        reachable.add(current)
        traversal.push(...(children.get(current) ?? []))
      }
      const descendants = [...reachable].filter(id => id !== sessionId)
      if (!headers.has(sessionId) && descendants.length === 0) {
        return err(request, {
          code: 'session-not-found',
          message: `session '${sessionId}' was not found`,
          details: { sessionId },
        })
      }
      const liveTarget = [...reachable].find(id => ctx.sessions.get(id) !== undefined)
      if (liveTarget !== undefined) {
        return err(request, {
          code: 'session-delete-live',
          message: `cannot delete session '${liveTarget}' while it is live`,
          details: { sessionId: liveTarget },
        })
      }
      if (!recursive && descendants.length > 0) {
        return err(request, {
          code: 'session-has-descendants',
          message: `session '${sessionId}' has ${descendants.length} descendant session(s); retry with recursive deletion`,
          details: { sessionId, descendantCount: descendants.length },
        })
      }
      if (persistence === undefined) {
        return err(request, {
          code: 'session-not-found',
          message: `session '${sessionId}' has no persisted log`,
          details: { sessionId },
        })
      }

      const postorder: SessionId[] = []
      const expanded = new Set<SessionId>()
      const stack: Array<{ id: SessionId; exit: boolean }> = [{ id: sessionId, exit: false }]
      while (stack.length > 0) {
        const current = stack.pop() as { id: SessionId; exit: boolean }
        if (current.exit) {
          if (storedIds.has(current.id)) postorder.push(current.id)
          continue
        }
        if (expanded.has(current.id)) continue
        expanded.add(current.id)
        stack.push({ id: current.id, exit: true })
        const descendantsForId = children.get(current.id) ?? []
        for (let index = descendantsForId.length - 1; index >= 0; index -= 1) {
          stack.push({ id: descendantsForId[index] as SessionId, exit: false })
        }
      }

      const deletedSessionIds: SessionId[] = []
      for (const id of postorder) {
        if (isAborted(signal)) {
          return err(request, { code: 'cancelled', message: 'session deletion was aborted', details: {} })
        }
        try {
          await persistence.delete(id, signal)
          deletedSessionIds.push(id)
        } catch (error: unknown) {
          if (!(recursive && error instanceof SessionPersistenceNotFoundError)) throw error
        }
      }
      return ok(request, { deletedSessionIds })
    },

    async create(request) {
      const sessionId = request.payload.sessionId ?? `session-${randomUUID()}` as SessionId
      let workspace: Workspace | undefined
      if (request.payload.workspaceId !== undefined) {
        workspace = ctx.workspaceRegistry.get(brandWorkspaceId(request.payload.workspaceId))
        if (workspace === undefined) {
          return err(request, {
            code: 'workspace-not-found',
            message: `workspace "${request.payload.workspaceId}" not found`,
            details: { workspaceId: request.payload.workspaceId },
          })
        }
      }
      const cwd = workspace?.path ?? request.payload.cwd ?? defaults.cwd
      const requestedPreset = request.payload.agentPreset
      try {
        await runtime.ensureSession(
          sessionId,
          cwd,
          request.payload.sessionId !== undefined,
          requestedPreset,
        )
      } catch (error: unknown) {
        if (error instanceof AgentPresetConflict) {
          return err(request, {
            code: 'agent-preset-conflict',
            message: error.message,
            details: {
              sessionId: error.sessionId,
              requestedPreset: error.requestedPreset,
              ...error.existingPreset === undefined ? {} : { existingPreset: error.existingPreset },
            },
          })
        }
        const refused = presetFailure(request, error)
        if (refused !== undefined) return refused
        if (error instanceof SessionCwdConflict) {
          return err(request, {
            code: 'session-conflict',
            message: error.message,
            details: {
              sessionId: error.sessionId,
              requestedCwd: error.requestedCwd,
              ...error.existingCwd === undefined ? {} : { existingCwd: error.existingCwd },
            },
          })
        }
        if (error instanceof SubagentSessionOwnership) {
          return err(request, runtime.subagentOwnershipError(error.sessionId))
        }
        return err(request, {
          code: 'internal',
          message: `failed to create session "${sessionId}": ${String(error)}`,
          details: {},
        })
      }
      if (workspace !== undefined) {
        try {
          await workspace.attachSession(sessionId)
        } catch (error: unknown) {
          return err(request, {
            code: 'workspace-attach-failed',
            message: `session "${sessionId}" was created but could not attach to workspace "${workspace.id}": ${String(error)}`,
            details: { sessionId, workspaceId: workspace.id },
          })
        }
      }
      const created = ctx.agents.get(sessionId)
      const createdPreset = created === undefined ? undefined : resolveSessionPreset(created.session)
      return ok(request, {
        sessionId,
        ...createdPreset === undefined ? {} : { agentPreset: createdPreset },
      })
    },

    async rename(request) {
      const { sessionId, title } = request.payload
      const found = await runtime.agentFor(sessionId)
      if ('error' in found) return err(request, found.error)
      const titles = ctx.get('sessionTitle')
      if (titles === undefined) {
        return err(request, {
          code: 'internal',
          message: 'renaming is unavailable: this deployment mounts no session-title service',
          details: {},
        })
      }
      try {
        const accepted = titles.rename(found.agent.session, title)
        return ok(request, { title: accepted.title, seq: accepted.eventSeq })
      } catch (error: unknown) {
        if (error instanceof SessionTitleInvalidError) {
          return err(request, {
            code: 'title-invalid',
            message: error.message,
            details: { sessionId },
          })
        }
        return err(request, {
          code: 'internal',
          message: `failed to rename session "${sessionId}": ${String(error)}`,
          details: {},
        })
      }
    },

    async fork(request) {
      const { sessionId, atSeq } = request.payload
      let source
      try {
        source = await reader.readState(sessionId)
      } catch (error: unknown) {
        if (error instanceof SessionNotFound) {
          return err(request, { code: 'session-not-found', message: error.message, details: { sessionId } })
        }
        return err(request, {
          code: 'internal',
          message: `fork source unavailable for session "${sessionId}": ${String(error)}`,
          details: {},
        })
      }
      const events = source.events
      const lastSeq = events.at(-1)?.seq ?? -1
      const anchoredBoundary = atSeq === undefined
        ? undefined
        : events.find(event => event.type === 'turn/end' && event.seq >= atSeq)
      const boundary = anchoredBoundary
        ?? (atSeq === undefined || atSeq > lastSeq
          ? events.findLast(event => event.type === 'turn/end')
          : undefined)
      if (boundary === undefined) {
        return err(request, {
          code: 'fork-unavailable',
          message: atSeq !== undefined && atSeq <= lastSeq
            ? `session "${sessionId}" has not completed the turn containing event ${String(atSeq)}`
            : `session "${sessionId}" has no completed turn to fork from`,
          details: { sessionId },
        })
      }
      let cut = boundary.seq + 1
      while (cut < events.length && events[cut]?.type !== 'turn/start') cut++
      let workspace: Workspace | undefined
      try {
        workspace = await reader.forkWorkspace(source)
      } catch (error: unknown) {
        return err(request, {
          code: 'internal',
          message: `failed to resolve fork workspace for session "${sessionId}": ${String(error)}`,
          details: {},
        })
      }
      const childId = `session-${randomUUID()}` as SessionId
      const composition = await runtime.composeAgent(resolveSessionPreset(source))
      try {
        await ctx.agents.create({
          sessionId: childId,
          seed: events.slice(0, cut),
          meta: {
            ...source.header.cwd === undefined ? {} : { cwd: source.header.cwd },
            parentSession: source.id,
            seedLength: cut,
            ...composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset },
          },
          agentOptions: runtime.agentOptions(),
          setup: composition.setup,
        })
      } catch (error: unknown) {
        return err(request, {
          code: 'internal',
          message: `failed to fork session "${sessionId}": ${String(error)}`,
          details: {},
        })
      }
      if (workspace !== undefined) {
        try {
          await workspace.attachSession(childId)
        } catch (error: unknown) {
          return err(request, {
            code: 'workspace-attach-failed',
            message: `session "${childId}" was forked but could not attach to workspace "${workspace.id}": ${String(error)}`,
            details: { sessionId: childId, workspaceId: workspace.id },
          })
        }
      }
      return ok(request, { sessionId: childId })
    },

    cancel(request) {
      const { sessionId } = request.payload
      const agent = ctx.agents.get(sessionId)
      if (agent === undefined) {
        return Promise.resolve(err(request, {
          code: 'session-not-found',
          message: `session "${sessionId}" not found (not attached)`,
          details: { sessionId },
        }))
      }
      if (runtime.hasSubagentOwner(agent.session, agent)) {
        return Promise.resolve(err(request, runtime.subagentOwnershipError(sessionId)))
      }
      agent.cancel({ kind: 'user' }, { keepInbox: true })
      return Promise.resolve(ok(request, { accepted: true as const }))
    },
  }
}
