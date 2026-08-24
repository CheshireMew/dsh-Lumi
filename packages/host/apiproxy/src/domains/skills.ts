import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type { ApiProxy } from '@deepseek-ai/dsh-api-protocol/api'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { isUserInvocable } from '@deepseek-ai/dsh-skill'
import { err, ok } from '../rpc-result.ts'

/** Host context plus cold-session scope resolution used by skill listing. */
export interface SkillsApiRuntime {
  readonly ctx: Context
  /** @returns the scope whose layered skill registry describes this session. */
  presenterScopeFor(sessionId: SessionId, session: Session): Promise<ScopeKey | undefined>
}

/**
 * Build skill-listing API methods over session and registry access.
 * @param runtime - Session and skill-registry access.
 * @returns Skills API methods.
 */
export function createSkillsApi(runtime: SkillsApiRuntime): ApiProxy['skills'] {
  const { ctx } = runtime
  return {
    async list(request) {
      const { sessionId } = request.payload
      const session = ctx.sessions.get(sessionId)
      if (session === undefined) {
        return err(request, {
          code: 'session-not-found',
          message: `session "${sessionId}" not found (not attached)`,
          details: { sessionId },
        })
      }
      if (session.header.cwd === undefined) {
        return err(request, {
          code: 'internal', message: `session "${sessionId}" has no project cwd`, details: {},
        })
      }
      const cwd = session.header.cwd
      const live = ctx.agents.get(sessionId)
      const presets = ctx.get('agentPresets')
      const scoped = live === undefined ? undefined : presets?.serviceFor(live, 'skills')
      const skillRegistry = scoped ?? ctx.get('skills')
      if (skillRegistry === undefined) {
        return err(request, {
          code: 'internal',
          message: 'skill registry is absent: neither this session\'s agent preset nor the host composition mounts @deepseek-ai/dsh-skill',
          details: {},
        })
      }
      const scope = await runtime.presenterScopeFor(sessionId, session)
      try {
        const skills = (await skillRegistry.list({ cwd, scope })).filter(isUserInvocable)
        return ok(request, {
          skills: skills.map(skill => ({
            name: skill.name,
            description: skill.description,
            ...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
            modelInvocable: skill.invocation.modelInvocable,
          })),
        })
      } catch (error: unknown) {
        return err(request, {
          code: 'internal', message: `skill listing failed: ${String(error)}`, details: {},
        })
      }
    },
  }
}
