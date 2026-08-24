import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { resolveSessionPreset, type PresetBearingSession } from '@deepseek-ai/dsh-agent-presets'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import type { SessionProjectionsBlock } from '@deepseek-ai/dsh-api-protocol/api'
import { detachedProjectionsFor, projectionsFor } from './session-history.ts'
import type { SessionRuntime } from './session-runtime.ts'

/** Stable header and event prefix read without acquiring an agent owner. */
export interface SessionReadState {
  id: SessionId
  header: SessionHeader
  events: SessionEvent[]
}

/** Attached or detached source used to build one transcript response. */
export type HistorySource =
  | { readonly kind: 'attached'; readonly session: Session }
  | { readonly kind: 'detached'; readonly header: SessionHeader; readonly events: SessionEvent[] }

/** Own non-resuming transcript reads, presenter scope, and fork workspace inheritance. */
export class SessionReader {
  /** Create one reader over a host and its session runtime. */
  constructor(
    private readonly ctx: Context,
    private readonly runtime: SessionRuntime,
  ) {}

  /**
   * Read one stable session prefix without acquiring an agent owner.
   * @param sessionId - Session identity to inspect.
   * @returns Its header and event prefix.
   */
  async readState(sessionId: SessionId): Promise<SessionReadState> {
    const attached = this.ctx.sessions.get(sessionId)
    if (attached !== undefined) {
      return {
        id: attached.id,
        header: attached.header,
        events: [...attached.events],
      }
    }
    const inspected = await this.runtime.inspectServable(sessionId)
    return { id: inspected.meta.id, header: inspected.meta, events: inspected.events }
  }

  /**
   * Resolve the workspace inherited by a fork without grouping ordinary loose lineage.
   * @param source - Source session header and identity.
   * @returns The direct or inherited workspace, when one exists.
   */
  async forkWorkspace(source: Pick<Session, 'id' | 'header'>): Promise<Workspace | undefined> {
    const workspaces = this.ctx.workspaceRegistry.list()
    const direct = workspaces.find(workspace => workspace.sessionIds.includes(source.id))
    if (direct !== undefined || source.header.origin !== 'subagent') return direct
    const lineage = await this.ctx.sessionQuery.traceSession(source.id)
    for (const ancestor of lineage.ancestors) {
      const workspace = workspaces.find(candidate => candidate.sessionIds.includes(ancestor.header.id))
      if (workspace !== undefined) return workspace
    }
    return undefined
  }

  /**
   * Resolve an attached or detached transcript source without resuming it.
   * @param sessionId - Session identity to inspect.
   * @returns An attached or detached transcript source.
   */
  async historySource(sessionId: SessionId): Promise<HistorySource> {
    const attached = this.ctx.sessions.get(sessionId)
    if (attached !== undefined) return { kind: 'attached', session: attached }
    const inspected = await this.runtime.inspectServable(sessionId)
    return { kind: 'detached', header: inspected.meta, events: inspected.events }
  }

  /**
   * Return the preset-bearing fields for an attached or detached source.
   * @param source - Transcript source to project.
   * @returns Header and events accepted by preset resolution.
   */
  sourceSession(source: HistorySource): PresetBearingSession {
    if (source.kind === 'detached') return { header: source.header, events: source.events }
    return { header: source.session.header, events: source.session.events }
  }

  /**
   * Read events and their projection baseline at the same log position.
   * @param source - Transcript source to copy.
   * @param includeProjections - Whether to reconstruct the projection baseline.
   * @returns Events and optional projections from the same stable prefix.
   */
  historyCut(
    source: HistorySource,
    includeProjections: boolean,
  ): { events: SessionEvent[]; projections?: SessionProjectionsBlock } {
    if (source.kind === 'detached') {
      const projections = includeProjections
        ? detachedProjectionsFor(this.ctx, source.events)
        : undefined
      return { events: source.events, ...projections === undefined ? {} : { projections } }
    }
    const events = [...source.session.events]
    const projections = includeProjections
      ? projectionsFor(this.ctx, source.session)
      : undefined
    return { events, ...projections === undefined ? {} : { projections } }
  }

  /**
   * Resolve the presenter registry scope for a live or cold transcript.
   * @param sessionId - Session identity used to find a live agent.
   * @param session - Preset-bearing transcript state for cold resolution.
   * @returns The live or standing presenter scope, when available.
   */
  async presenterScope(
    sessionId: SessionId,
    session: PresetBearingSession,
  ): Promise<ScopeKey | undefined> {
    const live = this.ctx.get('agents')?.get(sessionId)
    if (live !== undefined) return live
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) return undefined
    try {
      return await presets.standingKeyFor(resolveSessionPreset(session))
    } catch {
      // Unknown or unusable presets degrade to global presenters without resuming the session.
      return undefined
    }
  }
}
