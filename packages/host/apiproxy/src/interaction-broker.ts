import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CallId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionEvent, SessionEventMap, SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome, ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {
  AskUserQuestionAnswer,
  AskUserQuestionItem,
  AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import type {
  ClientResponse,
  MuxFrame,
  QuestionResponsePayload,
  QueuedInboxItem,
} from '@deepseek-ai/dsh-api-protocol/api'
import { approvalResponsePayloadSchema } from '@deepseek-ai/dsh-api-protocol/api/approvals.schema'
import { questionResponsePayloadSchema } from '@deepseek-ai/dsh-api-protocol/api/questions.schema'
import { RpcId, type RpcReceipt, type RpcRequest } from '@deepseek-ai/dsh-api-protocol/api/rpc'
import { frame, type FrameQueue } from './frame-queue.ts'

interface PendingApproval {
  rpcId: RpcId
  sessionId: SessionId
  approvalId: ApprovalRequestId
  toolName: string
  callId?: CallId
  reason?: string
  resolve(outcome: ApprovalOutcome): void
}

interface PendingQuestion {
  rpcId: RpcId
  sessionId: SessionId
  questions: AskUserQuestionItem[]
  resolve: (answer: AskUserQuestionAnswer) => void
  reject: (error: UserQuestionError) => void
  signal?: AbortSignal
  onAbort?: () => void
}

/** Project a pending approval into its answerable mux frame. */
function requestedFrame(pending: PendingApproval): RpcRequest<MuxFrame> {
  return {
    rpcId: pending.rpcId,
    payload: {
      type: 'approval/requested',
      sessionId: pending.sessionId,
      approvalId: pending.approvalId,
      toolName: pending.toolName,
      ...pending.callId === undefined ? {} : { callId: pending.callId },
      ...pending.reason === undefined ? {} : { reason: pending.reason },
    },
  }
}

/** Validate one answer batch against the exact question request it resolves. */
function matchesQuestions(payload: QuestionResponsePayload, pending: PendingQuestion): boolean {
  if (payload.sessionId !== pending.sessionId) return false
  const answers = payload.answer.answers
  if (answers.length !== pending.questions.length) return false
  return answers.every((answer, index) => {
    const question = pending.questions[index] as AskUserQuestionItem
    if (answer.id !== question.id) return false
    if (new Set(answer.selected).size !== answer.selected.length) return false
    const custom = answer.custom?.trim()
    if (custom !== undefined && custom === '') return false
    if (question.multiSelect !== true) {
      if (custom !== undefined && answer.selected.length > 0) return false
      if (answer.selected.length > 1) return false
    }
    const labels = new Set(question.options?.map(option => option.label) ?? [])
    return answer.selected.every(label => labels.has(label))
  })
}

/** Own pending questions, approvals, and their shared mux correlation ids. */
export class InteractionBroker {
  private readonly pendingQuestions = new Map<RpcId, PendingQuestion>()
  private readonly pendingApprovals = new Map<RpcId, PendingApproval>()
  private readonly muxQueues = new Set<FrameQueue<RpcRequest<MuxFrame>>>()

  /** Register interaction providers and lifecycle cleanup on one host context. */
  constructor(private readonly ctx: Context) {
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'agent/inbox/spliced') return
      const agent = ctx.agents.get(session.id)
      if (agent?.session !== session) return
      this.broadcast({
        type: 'session/queue',
        sessionId: session.id,
        items: this.queueItems(agent, event.data),
      })
    })
    this.installQuestionProvider()
    this.installApprovalProvider()
  }

  /**
   * Send one transient frame to every connected mux consumer.
   * @param payload - Interaction frame to broadcast.
   */
  broadcast(payload: MuxFrame): void {
    const envelope = frame(payload)
    for (const queue of this.muxQueues) queue.push(envelope)
  }

  /**
   * Attach a mux queue and replay every answerable pending interaction.
   * @param queue - Newly connected mux queue.
   */
  attach(queue: FrameQueue<RpcRequest<MuxFrame>>): void {
    this.muxQueues.add(queue)
    for (const pending of this.pendingQuestions.values()) {
      queue.push({
        rpcId: pending.rpcId,
        payload: {
          type: 'question/requested',
          sessionId: pending.sessionId,
          questions: pending.questions,
        },
      })
    }
    for (const pending of this.pendingApprovals.values()) queue.push(requestedFrame(pending))
  }

  /**
   * Detach one closed mux queue.
   * @param queue - Queue whose consumer has closed.
   */
  detach(queue: FrameQueue<RpcRequest<MuxFrame>>): void {
    this.muxQueues.delete(queue)
  }

  /**
   * Project both durable inbox lists, optionally including the splice being emitted.
   * @param agent - Agent whose inbox is projected.
   * @param splice - Event being emitted before the durable lists reflect it.
   * @returns Public queue items in delivery order.
   */
  queueItems(agent: Agent, splice?: SessionEventMap['agent/inbox/spliced']): QueuedInboxItem[] {
    const project = (target: 'next-turn' | 'next-step'): readonly UserMessage[] => {
      const messages = target === 'next-turn' ? agent.inbox.nextTurn : agent.inbox.nextStep
      return splice?.target === target
        ? messages.toSpliced(splice.start, splice.removedCount ?? 0, ...splice.inserted)
        : messages
    }
    return [
      ...project('next-turn').map(message => ({
        id: message.id,
        placement: 'queued' as const,
        message,
      })),
      ...project('next-step').map(message => ({
        id: message.id,
        placement: message.source.kind === 'user' ? 'steering' as const : 'context' as const,
        message,
      })),
    ]
  }

  /**
   * Route one client answer to the pending approval or question with the same id.
   * @param message - Correlated client response.
   * @returns Whether the response claimed a pending interaction.
   */
  respond(message: ClientResponse): Promise<RpcReceipt> {
    const approval = this.pendingApprovals.get(message.rpcId)
    if (approval !== undefined) {
      if (!message.result.ok) return Promise.resolve({ accepted: false, reason: 'bad-response' })
      const parsed = approvalResponsePayloadSchema.safeParse(message.result.value)
      if (!parsed.success
        || parsed.data.approvalId !== approval.approvalId
        || parsed.data.sessionId !== approval.sessionId) {
        return Promise.resolve({ accepted: false, reason: 'bad-response' })
      }
      approval.resolve(parsed.data.outcome)
      return Promise.resolve({ accepted: true })
    }
    const pending = this.pendingQuestions.get(message.rpcId)
    if (pending === undefined) return Promise.resolve({ accepted: false, reason: 'not-pending' })
    if (!message.result.ok) {
      if (message.result.error.code !== 'cancelled') {
        return Promise.resolve({ accepted: false, reason: 'bad-response' })
      }
      this.claimQuestion(pending, 'cancelled')
      pending.reject(new UserQuestionError('the user cancelled ask_user_question', 'ASK_CANCELLED'))
      return Promise.resolve({ accepted: true })
    }
    const parsed = questionResponsePayloadSchema.safeParse(message.result.value)
    if (!parsed.success) return Promise.resolve({ accepted: false, reason: 'bad-response' })
    const payload: QuestionResponsePayload = {
      sessionId: parsed.data.sessionId,
      answer: {
        answers: parsed.data.answer.answers.map(answer => ({
          id: answer.id,
          selected: answer.selected,
          ...(answer.custom === undefined ? {} : { custom: answer.custom }),
        })),
      },
    }
    if (!matchesQuestions(payload, pending)) {
      return Promise.resolve({ accepted: false, reason: 'bad-response' })
    }
    this.claimQuestion(pending, 'answered')
    pending.resolve(payload.answer)
    return Promise.resolve({ accepted: true })
  }

  /** Remove a question wait before settling it so the first claimant wins. */
  private claimQuestion(pending: PendingQuestion, outcome: 'answered' | 'cancelled'): void {
    this.pendingQuestions.delete(pending.rpcId)
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener('abort', pending.onAbort)
    }
    this.broadcast({
      type: 'question/resolved',
      sessionId: pending.sessionId,
      questionRpcId: pending.rpcId,
      outcome,
    })
  }

  /** Install the browser-backed user-question provider. */
  private installQuestionProvider(): void {
    const disposeProvider = this.ctx.userQuestions.registerProvider({
      ask: (request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> => {
        const sessionId = request.agent?.id
        if (sessionId === undefined) {
          return Promise.reject(new UserQuestionError(
            'web user interaction requires an agent-owned session',
            'ASK_MISSING_AGENT',
          ))
        }
        return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
          const rpcId = RpcId(randomUUID())
          const pending: PendingQuestion = {
            rpcId,
            sessionId,
            questions: request.questions,
            resolve,
            reject,
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          }
          const onAbort = (): void => {
            this.claimQuestion(pending, 'cancelled')
            reject(new UserQuestionError(
              'ask_user_question was aborted before the user answered',
              'ASK_ABORTED',
            ))
          }
          pending.onAbort = onAbort
          this.pendingQuestions.set(rpcId, pending)
          request.signal?.addEventListener('abort', onAbort, { once: true })
          const envelope: RpcRequest<MuxFrame> = {
            rpcId,
            payload: { type: 'question/requested', sessionId, questions: request.questions },
          }
          for (const queue of this.muxQueues) queue.push(envelope)
        })
      },
    })
    this.ctx.effect(() => () => {
      disposeProvider()
      for (const pending of [...this.pendingQuestions.values()]) {
        this.claimQuestion(pending, 'cancelled')
        pending.reject(new UserQuestionError(
          'web user-questions provider was disposed',
          'ASK_ABORTED',
        ))
      }
    }, 'api-proxy: user-questions provider')
  }

  /** Install the browser-backed approval provider when that service is composed. */
  private installApprovalProvider(): void {
    if (this.ctx.get('approval') === undefined) return
    this.ctx.effect(() => () => {
      for (const pending of [...this.pendingApprovals.values()]) pending.resolve('cancelled')
    }, 'api-proxy: approval registry teardown')
    this.ctx.on('approval/request', (request, next) => {
      if (request.signal?.aborted === true) return Promise.resolve<ApprovalOutcome>('cancelled')
      const claimed = new Set<ApprovalRequestId>()
      for (const entry of this.pendingApprovals.values()) claimed.add(entry.approvalId)
      const decided = new Set<ApprovalRequestId>()
      let approvalId: ApprovalRequestId | undefined
      for (let index = request.agent.session.events.length - 1; index >= 0; index -= 1) {
        const event = request.agent.session.events[index] as SessionEvent
        if (event.type === 'approval/decided') {
          decided.add(event.data.id)
        } else if (event.type === 'approval/asked') {
          if (decided.has(event.data.id) || claimed.has(event.data.id)) continue
          if ((request.callId ?? null) !== (event.data.callId ?? null)) continue
          approvalId = event.data.id
          break
        }
      }
      if (approvalId === undefined) return next()
      const id = approvalId
      return new Promise<ApprovalOutcome>((resolve) => {
        const settle = (outcome: ApprovalOutcome): void => {
          /* v8 ignore next 3 -- the table route and removed listener make double settlement unreachable. */
          if (!this.pendingApprovals.delete(pending.rpcId)) return
          request.signal?.removeEventListener('abort', onAbort)
          this.broadcast({
            type: 'approval/resolved',
            sessionId: pending.sessionId,
            approvalId: id,
            outcome,
          })
          resolve(outcome)
        }
        const onAbort = (): void => { settle('cancelled') }
        const pending: PendingApproval = {
          rpcId: RpcId(randomUUID()),
          sessionId: request.agent.session.id,
          approvalId: id,
          toolName: request.toolName,
          ...request.callId === undefined ? {} : { callId: request.callId },
          ...request.reason === undefined ? {} : { reason: request.reason },
          resolve: settle,
        }
        this.pendingApprovals.set(pending.rpcId, pending)
        request.signal?.addEventListener('abort', onAbort, { once: true })
        const envelope = requestedFrame(pending)
        for (const queue of this.muxQueues) queue.push(envelope)
      })
    })
  }
}
