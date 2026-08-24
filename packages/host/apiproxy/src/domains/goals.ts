import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApiProxy, GoalRef, RpcError, RpcRequest, RpcResponse } from '@deepseek-ai/dsh-api-protocol/api'
import type { ApiRemoteAgentResult } from '@deepseek-ai/dsh-api-remotes'
import { GoalError, type GoalRef as CoreGoalRef, type GoalService } from '@deepseek-ai/dsh-goal'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { err, ok } from '../rpc-result.ts'

/** Session and goal-service resolution used by goal API methods. */
export interface GoalsApiRuntime {
  /** @param sessionId - target session. @returns its live or resumed agent. */
  agentFor(sessionId: SessionId): Promise<ApiRemoteAgentResult>
  /** @param agent - owning agent. @returns its scoped or host goal service. */
  goalServiceFor(agent: Agent): GoalService | { error: RpcError }
}

/** Map one goal-domain rejection to the wire error. */
function goalError(request: RpcRequest<unknown>, error: unknown): RpcResponse<never> {
  const details = error instanceof GoalError ? { goalCode: error.code } : {}
  return err(request, { code: 'internal', message: String(error), details })
}

/** Resolve an agent, apply one goal mutation, and acknowledge the new revision. */
async function mutateGoal(
  runtime: GoalsApiRuntime,
  request: RpcRequest<{ sessionId: SessionId }>,
  mutation: (goals: GoalService, agent: Agent) => CoreGoalRef,
): Promise<RpcResponse<{ ref: GoalRef }>> {
  const found = await runtime.agentFor(request.payload.sessionId)
  if ('error' in found) return err(request, found.error)
  const goals = runtime.goalServiceFor(found.agent)
  if ('error' in goals) return err(request, goals.error)
  try {
    const ref = mutation(goals, found.agent)
    return ok(request, { ref: { id: ref.id, revision: ref.revision } })
  } catch (error: unknown) {
    return goalError(request, error)
  }
}

/**
 * Build goal mutations over the session-scoped goal service.
 * @param runtime - session and goal-service resolution.
 * @returns the goals API domain.
 */
export function createGoalsApi(runtime: GoalsApiRuntime): ApiProxy['goals'] {
  return {
    create(request) {
      const { objective, maxGoalRounds } = request.payload
      return mutateGoal(runtime, request, (goals, agent) => goals.create(agent, {
        objective,
        ...(maxGoalRounds !== undefined ? { maxGoalRounds } : {}),
      }))
    },

    edit(request) {
      const { ref, objective, maxGoalRounds } = request.payload
      return mutateGoal(runtime, request, (goals, agent) => goals.edit(agent, ref, {
        ...(objective !== undefined ? { objective } : {}),
        ...(maxGoalRounds !== undefined ? { maxGoalRounds } : {}),
      }))
    },

    pause(request) {
      return mutateGoal(runtime, request, (goals, agent) => goals.pause(agent, request.payload.ref))
    },

    resume(request) {
      return mutateGoal(runtime, request, (goals, agent) => goals.resume(agent, request.payload.ref))
    },

    complete(request) {
      return mutateGoal(runtime, request, (goals, agent) => goals.complete(agent, request.payload.ref))
    },

    async clear(request) {
      const found = await runtime.agentFor(request.payload.sessionId)
      if ('error' in found) return err(request, found.error)
      const goals = runtime.goalServiceFor(found.agent)
      if ('error' in goals) return err(request, goals.error)
      try {
        goals.clear(found.agent, request.payload.ref)
        return ok(request, { cleared: true as const })
      } catch (error: unknown) {
        return goalError(request, error)
      }
    },
  }
}
