import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { workspaceDomainState } from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-cordis-host-runner/types'
import { API_REMOTE_FORWARDED_EVENTS } from '@deepseek-ai/dsh-api-remotes'
import type { ApiProxy, HostFrame, MuxFrame, WorkspaceId } from '@deepseek-ai/dsh-api-protocol/api'
import type { RpcRequest } from '@deepseek-ai/dsh-api-protocol/api/rpc'
import {
  assertJsonArgs,
  frame,
  FrameQueue,
  jobViews,
  subscribeSession,
} from '../frame-queue.ts'
import { backscanArgs, viewFor } from '../session-history.ts'
import { InteractionBroker } from '../interaction-broker.ts'
import { sessionBlank, sessionListFields } from '../session-summary.ts'
import { changedWorkspaceView, workspaceView } from './workspace.ts'

interface ToolCallData {
  callId: string
  name: string
  arguments: string
}

/**
 * Build the session and host event streams over one shared interaction broker.
 * @param ctx - Host context carrying event sources.
 * @param interactions - Broker for question, approval, and queue frames.
 * @param queueCapacity - Maximum undelivered frames retained per stream.
 * @returns Session and host event-stream methods.
 */
export function createEventsApi(
  ctx: Context,
  interactions: InteractionBroker,
  queueCapacity: number,
): ApiProxy['events'] {
  return {
    mux(_request, signal) {
      const queue = new FrameQueue<RpcRequest<MuxFrame>>(queueCapacity)
      interactions.attach(queue)
      for (const session of ctx.sessions.list()) subscribeSession(queue, session)
      for (const session of ctx.sessions.list()) {
        const agent = ctx.agents.get(session.id)
        if (agent?.session === session && agent.inbox.hasPending) {
          queue.push(frame({
            type: 'session/queue',
            sessionId: session.id,
            items: interactions.queueItems(agent),
          }))
        }
      }
      const jobs = ctx.get('jobs')
      if (jobs !== undefined) {
        for (const session of ctx.sessions.list()) {
          const views = jobViews(jobs.list(ctx.agents.get(session.id)))
          if (views.length > 0) {
            queue.push(frame({ type: 'session/jobs', sessionId: session.id, jobs: views }))
          }
        }
      }
      const openCalls = new Map<SessionId, Map<string, { name: string; args: unknown }>>()
      const disposers = [
        ctx.on('session/event', (session: Session, event: SessionEvent) => {
          if (event.type === 'tool/call') {
            const data = event.data as ToolCallData
            try {
              let table = openCalls.get(session.id)
              if (table === undefined) {
                table = new Map<string, { name: string; args: unknown }>()
                openCalls.set(session.id, table)
              }
              table.set(data.callId, { name: data.name, args: JSON.parse(data.arguments) })
            } catch {
              // Invalid model arguments have no presenter args; the result view falls back safely.
            }
          } else if (event.type === 'turn/end') {
            openCalls.delete(session.id)
          }
          const view = viewFor(
            ctx,
            event,
            callId => openCalls.get(session.id)?.get(callId) ?? backscanArgs(session.events, callId),
            ctx.agents.get(session.id),
          )
          queue.push(frame({
            type: 'session/event',
            sessionId: session.id,
            event,
            ...view === undefined ? {} : { view },
          }))
        }),
        ctx.on('session/created', (session: Session) => {
          subscribeSession(queue, session)
          const views = jobs === undefined ? [] : jobViews(jobs.list(ctx.agents.get(session.id)))
          if (views.length > 0) {
            queue.push(frame({ type: 'session/jobs', sessionId: session.id, jobs: views }))
          }
        }),
        ctx.on('session/disposed', (session: Session) => {
          openCalls.delete(session.id)
        }),
        ...jobs === undefined ? [] : [jobs.onJobsChanged((owner) => {
          if (owner !== undefined) {
            queue.push(frame({
              type: 'session/jobs',
              sessionId: owner.id,
              jobs: jobViews(jobs.list(owner)),
            }))
            return
          }
          for (const session of ctx.sessions.list()) {
            queue.push(frame({
              type: 'session/jobs',
              sessionId: session.id,
              jobs: jobViews(jobs.list(ctx.agents.get(session.id))),
            }))
          }
        })],
      ]
      return queue.iterate(signal, () => {
        interactions.detach(queue)
        for (const dispose of disposers) dispose()
      })
    },

    host(_request, signal) {
      const queue = new FrameQueue<RpcRequest<HostFrame>>(queueCapacity)
      const committedWorkspaces = ctx.workspaceRegistry.list()
      const committedWorkspaceIds = new Set(committedWorkspaces.map(workspace => String(workspace.id)))
      let committedWorkspaceOrder = committedWorkspaces.map(workspace => workspace.id)
      let archivedSessionIds = ctx.workspaceRegistry.archivedSessionIds
      const disposers = [
        ctx.on('session/created', (session: Session) => {
          queue.push(frame({
            type: 'host/session-added',
            sessionId: session.id,
            blank: sessionBlank(session),
            ...sessionListFields(session.header, session.events),
          }))
        }),
        ctx.on('session/disposed', (session: Session) => {
          queue.push(frame({ type: 'host/session-removed', sessionId: session.id }))
        }),
        ctx.on('session-persistence/deleted', (sessionId: SessionId) => {
          queue.push(frame({ type: 'host/session-deleted', sessionId }))
        }),
        ctx.on('agent/status', ({ agent, status }: { agent: Agent; status: AgentStatus }) => {
          queue.push(frame({
            type: 'host/session-status',
            sessionId: agent.id,
            running: status === 'running',
          }))
        }),
        ctx.on('agent/error', ({ agent, error }: { agent: Agent; error: unknown }) => {
          queue.push(frame({
            type: 'host/agent-error',
            sessionId: agent.id,
            message: errorChain(error),
          }))
        }),
        ctx.on('domain/changed', (change) => {
          if (change.domain !== 'workspace') return
          if (change.table === '') {
            if (change.operation !== 'put') return
            const state = workspaceDomainState.parse(change.value)
            const orderChanged = state.workspaceIds.length === committedWorkspaceOrder.length
              && state.workspaceIds.every(workspaceId => committedWorkspaceIds.has(String(workspaceId)))
              && state.workspaceIds.some((workspaceId, index) => workspaceId !== committedWorkspaceOrder[index])
            for (const workspaceId of state.workspaceIds) {
              if (committedWorkspaceIds.has(workspaceId)) continue
              const workspace = ctx.workspaceRegistry.get(workspaceId)
              if (workspace === undefined) {
                throw new Error(`committed workspace registry references missing workspace "${workspaceId}"`)
              }
              committedWorkspaceIds.add(workspaceId)
              queue.push(frame({ type: 'host/workspace-changed', workspace: workspaceView(workspace) }))
            }
            committedWorkspaceOrder = [...state.workspaceIds]
            if (orderChanged) {
              queue.push(frame({
                type: 'host/workspace-order-changed',
                workspaceIds: [...state.workspaceIds],
              }))
            }
            if (state.archivedSessionIds.length !== archivedSessionIds.length
              || state.archivedSessionIds.some((id, index) => id !== archivedSessionIds[index])) {
              archivedSessionIds = state.archivedSessionIds
              queue.push(frame({
                type: 'host/archived-sessions-changed',
                archivedSessionIds: [...state.archivedSessionIds],
              }))
            }
            return
          }
          if (change.table !== 'workspaces') return
          if (change.operation === 'deleted') {
            if (!committedWorkspaceIds.delete(change.key)) return
            queue.push(frame({
              type: 'host/workspace-removed',
              workspaceId: change.key as WorkspaceId,
            }))
            return
          }
          if (!committedWorkspaceIds.has(change.key)) return
          queue.push(frame({
            type: 'host/workspace-changed',
            workspace: changedWorkspaceView(change.key, change.value),
          }))
        }),
        ...API_REMOTE_FORWARDED_EVENTS.map(name => ctx.on(
          name,
          ((...args: unknown[]) => {
            queue.push(frame({
              type: 'host/remote-event',
              event: name,
              args: assertJsonArgs(name, args),
            }))
          }),
        )),
      ]
      return queue.iterate(signal, () => {
        for (const dispose of disposers) dispose()
      })
    },
  }
}
