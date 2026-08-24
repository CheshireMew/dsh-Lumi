import type { Context } from '@deepseek-ai/cordis'
import type {
  ApiProxy, RpcError, RpcRequest, RpcResponse, SessionProjectionsBlock, SubagentAddress,
} from '@deepseek-ai/dsh-api-protocol/api'
import { ApiRemoteSessionNotFound as SessionNotFound } from '@deepseek-ai/dsh-api-remotes'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SubagentError, type SubagentListEntry as CatalogSubagentListEntry } from '@deepseek-ai/dsh-subagent'
import {
  detachedProjectionsFor, historyPage, projectionsFor,
} from '../session-history.ts'
import { err, ok } from '../rpc-result.ts'

/** Host services and pure normalization used by the subagent API. */
export interface SubagentsApiRuntime {
  readonly ctx: Context
  /** @param sessionId - detached session id. @returns its servable inspection. */
  inspectServable(sessionId: SessionId): Promise<SessionInspection>
  /** @param value - client time-zone identifier. @returns its canonical form when valid. */
  canonicalClientTimeZone(value: string): string | undefined
}

function subagentHistoryProjections(
  ctx: Context,
  childSessionId: SessionId,
  compute: () => SessionProjectionsBlock | undefined,
): SessionProjectionsBlock | undefined {
  try {
    return compute()
  } catch (error) {
    ctx.logger.warn(`subagent.history: projections for "${childSessionId}" failed (serving the page without them): ${String(error)}`)
    return undefined
  }
}

function subagentPromptError(
  request: RpcRequest<{ childSessionId: SessionId }>,
  error: unknown,
  signal: AbortSignal,
): RpcResponse<never> {
  const childSessionId = request.payload.childSessionId
  if (signal.aborted) {
    return err(request, { code: 'cancelled', message: 'subagent prompt was cancelled', details: {} })
  }
  if (error instanceof SubagentError) {
    switch (error.code) {
      case 'NOT_RESUMABLE':
        return err(request, {
          code: 'subagent-not-resumable', message: 'subagent cannot be resumed', details: { childSessionId },
        })
      case 'UNAUTHORIZED':
        return err(request, {
          code: 'subagent-unauthorized',
          message: 'subagent does not belong to this parent',
          details: { childSessionId },
        })
      case 'DRAINING':
      case 'ACTIVATION_CLOSING':
      case 'CONTINUATION_UNAVAILABLE':
      case 'PERSISTENCE_UNAVAILABLE':
        return err(request, {
          code: 'subagent-delivery-unavailable',
          message: 'subagent follow-up is temporarily unavailable',
          details: { childSessionId },
        })
      default:
        break
    }
  }
  return err(request, { code: 'internal', message: 'subagent prompt failed', details: {} })
}

function projectionsUnavailableError(): RpcError {
  return {
    code: 'internal',
    message: 'subagent catalog is unavailable: this deployment does not mount the sessionProjections registry (load @deepseek-ai/dsh-session-projection)',
    details: {},
  }
}

async function catalogChild(
  ctx: Context,
  address: SubagentAddress,
  signal?: AbortSignal,
): Promise<{
  entry?: Extract<CatalogSubagentListEntry, { kind: 'child' }>
  error?: RpcError
}> {
  const { parentSessionId, childSessionId, mode } = address
  try {
    const entries = await ctx.subagents.listChildren(parentSessionId, signal)
    const entry = entries.find(candidate => candidate.id === childSessionId)
    if (entry === undefined || (entry.kind === 'child' && entry.mode !== mode)) {
      return {
        error: {
          code: 'subagent-not-found',
          message: `session "${childSessionId}" is not a ${mode} direct child of "${parentSessionId}"`,
          details: { parentSessionId, childSessionId },
        },
      }
    }
    if (entry.kind === 'diagnostic') {
      return {
        error: {
          code: 'subagent-catalog-diagnostic',
          message: `subagent "${childSessionId}" is ${entry.reason}`,
          details: { parentSessionId, childSessionId, reason: entry.reason },
        },
      }
    }
    return { entry }
  } catch (error: unknown) {
    if (signal?.aborted || (error instanceof SubagentError && error.code === 'CANCELLED')) {
      return { error: { code: 'cancelled', message: 'subagent catalog read was cancelled', details: {} } }
    }
    if (error instanceof SubagentError && error.code === 'SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE') {
      return { error: projectionsUnavailableError() }
    }
    return { error: { code: 'internal', message: 'subagent catalog read failed', details: {} } }
  }
}

/**
 * Build subagent API methods over the composed host services.
 * @param runtime - Host subagent services.
 * @returns Subagent API methods.
 */
export function createSubagentsApi(runtime: SubagentsApiRuntime): ApiProxy['subagents'] {
  const { ctx } = runtime
  return {
    async list(request, signal) {
      try {
        const entries = await ctx.subagents.listChildren(request.payload.parentSessionId, signal)
        return ok(request, {
          entries: entries.map(entry => entry.kind === 'child'
            ? {
              ...entry,
              activity: ctx.agents.get(entry.id)?.status === 'running' ? 'running' : 'inactive',
            }
            : entry),
          parentAvailable: ctx.agents.get(request.payload.parentSessionId) !== undefined,
        })
      } catch (error: unknown) {
        if (signal?.aborted || (error instanceof SubagentError && error.code === 'CANCELLED')) {
          return err(request, { code: 'cancelled', message: 'subagent catalog read was cancelled', details: {} })
        }
        if (error instanceof SubagentError && error.code === 'SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE') {
          return err(request, projectionsUnavailableError())
        }
        return err(request, { code: 'internal', message: 'subagent catalog read failed', details: {} })
      }
    },

    async history(request, signal) {
      const { parentSessionId, childSessionId, mode, beforeSeq, maxMessages } = request.payload
      const verified = await catalogChild(ctx, { parentSessionId, childSessionId, mode }, signal)
      if (verified.error !== undefined) return err(request, verified.error)
      let header: SessionHeader
      let events: SessionEvent[]
      let projections: SessionProjectionsBlock | undefined
      const attached = ctx.sessions.get(childSessionId)
      if (attached !== undefined) {
        header = attached.header
        events = [...attached.events]
        projections = beforeSeq === undefined
          ? subagentHistoryProjections(ctx, childSessionId, () => projectionsFor(ctx, attached))
          : undefined
      } else {
        try {
          const inspected = await runtime.inspectServable(childSessionId)
          header = inspected.meta
          events = [...inspected.events]
          projections = beforeSeq === undefined
            ? subagentHistoryProjections(
              ctx, childSessionId, () => detachedProjectionsFor(ctx, inspected.events))
            : undefined
        } catch (error: unknown) {
          if (signal?.aborted) {
            return err(request, { code: 'cancelled', message: 'subagent history read was cancelled', details: {} })
          }
          if (error instanceof SessionNotFound) {
            return err(request, {
              code: 'subagent-not-found',
              message: 'subagent disappeared during history read',
              details: { parentSessionId, childSessionId },
            })
          }
          return err(request, { code: 'internal', message: 'subagent history read failed', details: {} })
        }
      }
      if (signal?.aborted) {
        return err(request, { code: 'cancelled', message: 'subagent history read was cancelled', details: {} })
      }
      if (header.parentSession !== parentSessionId) {
        return err(request, {
          code: 'subagent-unauthorized',
          message: 'subagent parent changed during history read',
          details: { childSessionId },
        })
      }
      const page = historyPage(ctx, events, beforeSeq, maxMessages)
      return ok(request, { ...page, ...projections === undefined ? {} : { projections } })
    },

    async prompt(request, signal) {
      const { parentSessionId, childSessionId, content, clientTimeZone } = request.payload
      const canonicalTimeZone = clientTimeZone === undefined
        ? undefined
        : runtime.canonicalClientTimeZone(clientTimeZone)
      if (clientTimeZone !== undefined && canonicalTimeZone === undefined) {
        return err(request, {
          code: 'invalid-time-zone',
          message: 'clientTimeZone must be UTC or a valid IANA Area/Location name',
          details: { value: clientTimeZone },
        })
      }
      const parent = ctx.agents.get(parentSessionId)
      if (parent === undefined) {
        return err(request, {
          code: 'subagent-parent-unavailable',
          message: `parent session "${parentSessionId}" is not live`,
          details: { parentSessionId },
        })
      }
      const verified = await catalogChild(ctx, {
        parentSessionId, childSessionId, mode: 'continuable',
      }, signal)
      if (verified.error !== undefined) return err(request, verified.error)
      try {
        const messageId = await ctx.subagents.followup(parent, childSessionId, content, {
          source: {
            kind: 'user', rpcId: request.rpcId,
            ...(canonicalTimeZone === undefined ? {} : { clientTimeZone: canonicalTimeZone }),
          },
          signal,
        })
        return ok(request, { messageId })
      } catch (error: unknown) {
        return subagentPromptError(request, error, signal)
      }
    },

    interrupt(request) {
      const { parentSessionId, childSessionId } = request.payload
      try {
        ctx.subagents.interrupt(childSessionId, { kind: 'user', parentSessionId })
      } catch (error: unknown) {
        if (error instanceof SubagentError && error.code === 'UNAUTHORIZED') {
          return Promise.resolve(err(request, {
            code: 'subagent-unauthorized',
            message: 'subagent does not belong to this parent',
            details: { childSessionId },
          }))
        }
        return Promise.resolve(err(request, {
          code: 'internal', message: 'subagent interrupt failed', details: {},
        }))
      }
      return Promise.resolve(ok(request, { accepted: true as const }))
    },
  }
}
