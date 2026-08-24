import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import {
  contentHasImage,
  createUserMessage,
  freezeMessage,
  ReasoningEffortId,
  type MessageSource,
} from '@deepseek-ai/dsh-llm'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { ApiRemoteSessionNotFound as SessionNotFound } from '@deepseek-ai/dsh-api-remotes'
import type { ApiProxy } from '@deepseek-ai/dsh-api-protocol/api'
import { err, ok } from '../rpc-result.ts'
import { historyPage } from '../session-history.ts'
import {
  canonicalClientTimeZone,
  durablePromptContent,
  messagesHaveImage,
  referencedImage,
} from '../prompt-content.ts'
import { buildModelCatalog } from './llm.ts'
import type { SessionApiDependencies } from './session-api-dependencies.ts'

type ConversationApi = Pick<ApiProxy['sessions'],
  'history' | 'models' | 'selectModel' | 'prompt' | 'attachment' | 'updateQueue'>

/**
 * Build transcript, model, prompt, attachment, and inbox operations.
 * @param dependencies - Shared session-domain services and policy.
 * @returns Conversation-facing session API methods.
 */
export function createSessionConversationApi(dependencies: SessionApiDependencies): ConversationApi {
  const { ctx, defaults, runtime, reader } = dependencies
  return {
    async history(request) {
      const { sessionId, beforeSeq, maxMessages } = request.payload
      try {
        const source = await reader.historySource(sessionId)
        const scope = await reader.presenterScope(sessionId, reader.sourceSession(source))
        const cut = reader.historyCut(source, beforeSeq === undefined)
        const page = historyPage(ctx, cut.events, beforeSeq, maxMessages, scope)
        return ok(request, {
          events: page.events,
          hasMore: page.hasMore,
          ...cut.projections === undefined ? {} : { projections: cut.projections },
        })
      } catch (error: unknown) {
        if (error instanceof SessionNotFound) {
          return err(request, { code: 'session-not-found', message: error.message, details: { sessionId } })
        }
        return err(request, {
          code: 'internal',
          message: `history unavailable for session "${sessionId}": ${String(error)}`,
          details: {},
        })
      }
    },

    async models(request) {
      const { sessionId } = request.payload
      const found = await runtime.agentFor(sessionId)
      if ('error' in found) return err(request, found.error)
      const current = runtime.selectionFor(found.agent).current
      const { groups, failures } = await buildModelCatalog(ctx.llm)
      return ok(request, {
        current: { ...current },
        routable: runtime.routeServed(current.provider),
        groups,
        failures,
      })
    },

    async selectModel(request) {
      const { sessionId, provider, model, reasoningEffort } = request.payload
      const found = await runtime.agentFor(sessionId)
      if ('error' in found) return err(request, found.error)
      return runtime.serializeImageAdmission(found.agent, async () => {
        try {
          const resolved = await ctx.llm.resolveCallConfig({
            provider,
            model,
            ...reasoningEffort === undefined
              ? {}
              : { reasoningEffort: ReasoningEffortId(reasoningEffort) },
          })
          const pendingImage = [...found.agent.inbox.nextTurn, ...found.agent.inbox.nextStep]
            .some(message => contentHasImage(message.content))
          if (pendingImage || messagesHaveImage(found.agent.session.deriveMessages())) {
            const info = await ctx.llm.resolveModelInfo(resolved.provider, resolved.model)
            if (info.inputModalities !== undefined && !info.inputModalities.includes('image')) {
              return err(request, {
                code: 'model-unavailable',
                message: `Model "${resolved.model}" does not accept image input, but this session already contains images; select an image-capable model.`,
                details: { provider, model },
              })
            }
          }
          const selected: ModelSelection = {
            provider: resolved.provider,
            model: resolved.model,
            ...resolved.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: resolved.reasoningEffort },
          }
          runtime.selectionFor(found.agent).current = selected
          try {
            await defaults.saveDefaultModelSelection?.(selected)
          } catch (error: unknown) {
            ctx.logger.warn(
              `api-proxy: the model switch applies to this session but was not saved as the default: ${String(error)}`,
            )
          }
          return ok(request, { selected: { ...selected } })
        } catch (error: unknown) {
          return err(request, {
            code: 'model-unavailable',
            message: error instanceof Error ? error.message : String(error),
            details: { provider, model },
          })
        }
      })
    },

    async prompt(request) {
      const { sessionId, mode, content, clientTimeZone } = request.payload
      const canonicalTimeZone = clientTimeZone === undefined
        ? undefined
        : canonicalClientTimeZone(clientTimeZone)
      if (clientTimeZone !== undefined && canonicalTimeZone === undefined) {
        return err(request, {
          code: 'invalid-time-zone',
          message: 'clientTimeZone must be UTC or a valid IANA Area/Location name',
          details: { value: clientTimeZone },
        })
      }
      const resolved = await runtime.turnAgentFor<{ accepted: true }>(request, sessionId)
      if ('refused' in resolved) return resolved.refused
      const agent = resolved.agent
      const source: MessageSource = {
        kind: 'user',
        rpcId: request.rpcId,
        ...(canonicalTimeZone === undefined ? {} : { clientTimeZone: canonicalTimeZone }),
      }
      const hasImage = content.some(part => part.type === 'image')
      const admit = async (): ReturnType<ApiProxy['sessions']['prompt']> => {
        try {
          if (hasImage) {
            const current = runtime.selectionFor(agent).current
            const modelInfo = await ctx.llm.resolveModelInfo(current.provider, current.model)
            if (modelInfo.inputModalities !== undefined && !modelInfo.inputModalities.includes('image')) {
              return err(request, {
                code: 'attachment-error',
                message: `Model "${current.model}" does not support image input.`,
                details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
              })
            }
          }
          const durable = await durablePromptContent(ctx, content)
          const message: UserMessage = createUserMessage({ content: durable, source })
          if (mode === 'steer') agent.steer(message)
          else agent.followup(message)
        } catch (error: unknown) {
          if (error instanceof AttachmentError) {
            return err(request, {
              code: 'attachment-error',
              message: error.message,
              details: { reason: error.code },
            })
          }
          return err(request, {
            code: 'agent-busy',
            message: 'prompt rejected',
            details: { reason: String(error) },
          })
        }
        return ok(request, { accepted: true as const })
      }
      return hasImage ? runtime.serializeImageAdmission(agent, admit) : admit()
    },

    async attachment(request) {
      const { sessionId, attachmentId } = request.payload
      let state
      try {
        state = await reader.readState(sessionId)
      } catch (error: unknown) {
        if (error instanceof SessionNotFound) {
          return err(request, {
            code: 'session-not-found',
            message: error.message,
            details: { sessionId },
          })
        }
        return err(request, {
          code: 'internal',
          message: `attachment authorization unavailable for session "${sessionId}": ${String(error)}`,
          details: {},
        })
      }
      const ref = referencedImage(state.events, String(attachmentId))
      if (ref === undefined) {
        return err(request, {
          code: 'attachment-error',
          message: 'Image is not referenced by this session.',
          details: { reason: 'ATTACHMENT_NOT_REFERENCED' },
        })
      }
      try {
        const stored = await ctx.attachments.readImage(ref)
        return ok(request, {
          attachment: stored.ref,
          data: Buffer.from(stored.data).toString('base64'),
        })
      } catch (error: unknown) {
        if (error instanceof AttachmentError) {
          return err(request, {
            code: 'attachment-error',
            message: error.message,
            details: { reason: error.code },
          })
        }
        return err(request, {
          code: 'internal',
          message: 'Unable to read image attachment.',
          details: {},
        })
      }
    },

    updateQueue(request) {
      const { sessionId, itemId, action } = request.payload
      if (action.kind === 'edit' && action.content.some(block => block.type !== 'text')) {
        return Promise.resolve(err(request, {
          code: 'attachment-error',
          message: 'queue edits accept text content only',
          details: { reason: 'QUEUE_EDIT_NON_TEXT' },
        }))
      }
      const agent = ctx.agents.get(sessionId)
      if (agent !== undefined && runtime.hasSubagentOwner(agent.session, agent)) {
        return Promise.resolve(err(request, runtime.subagentOwnershipError(sessionId)))
      }
      if (agent === undefined) {
        return Promise.resolve(err(request, {
          code: 'queue-item-not-found',
          message: 'queued item is no longer pending',
          details: { itemId },
        }))
      }
      const target = agent.inbox.nextTurn.some(message => message.id === itemId)
        ? 'next-turn'
        : agent.inbox.nextStep.some(message => message.id === itemId) ? 'next-step' : undefined
      const message = target === undefined
        ? undefined
        : (target === 'next-turn' ? agent.inbox.nextTurn : agent.inbox.nextStep)
          .find(candidate => candidate.id === itemId)
      if (target === undefined || message === undefined) {
        return Promise.resolve(err(request, {
          code: 'queue-item-not-found',
          message: 'queued item is no longer pending',
          details: { itemId },
        }))
      }
      if (action.kind === 'steer' && (target !== 'next-turn' || agent.status !== 'running')) {
        return Promise.resolve(err(request, {
          code: 'steer-unavailable',
          message: 'current turn no longer accepts steering',
          details: { itemId },
        }))
      }
      if (action.kind === 'edit') {
        agent.inbox.replace(itemId, freezeMessage({ ...message, content: action.content }))
      } else {
        agent.inbox.remove(itemId)
        if (action.kind === 'steer') agent.steer(message)
      }
      return Promise.resolve(ok(request, { accepted: true as const }))
    },
  }
}
