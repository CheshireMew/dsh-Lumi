import { mkdir } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import {
  installModelSelection,
  type Agent,
  type AgentOptions,
  type ModelSelection,
  type ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import {
  ApiRemoteSubagentSessionOwnership as SubagentSessionOwnership,
  apiRemoteSubagentOwnershipError,
  createApiRemoteAgentResolver,
  hasApiRemoteSubagentOwner,
  inspectApiRemoteSession,
} from '@deepseek-ai/dsh-api-remotes'
import type { RpcError, RpcRequest, RpcResponse } from '@deepseek-ai/dsh-api-protocol/api/rpc'
import type { ApiProxyDefaults } from './api-proxy-defaults.ts'
import { err } from './rpc-result.ts'

type WebModelSelectionRef = ModelSelectionRef & { current: ModelSelection }

/** The requested preset differs from the composition an existing session runs. */
export class AgentPresetConflict extends Error {
  constructor(
    readonly sessionId: SessionId,
    readonly requestedPreset: string,
    readonly existingPreset: string | undefined,
  ) {
    super(
      existingPreset === undefined
        ? `session "${sessionId}" records no agent preset, so it cannot be adopted under one; `
        + 'a deployment composing no roster records none on any session — '
        : `session "${sessionId}" already runs agent preset ${JSON.stringify(existingPreset)}; `
      + `requested ${JSON.stringify(requestedPreset)}. A session's preset is fixed at creation.`,
    )
  }
}

/** Requested identity already belongs to a session with another project cwd. */
export class SessionCwdConflict extends Error {
  constructor(
    readonly sessionId: SessionId,
    readonly requestedCwd: string,
    readonly existingCwd: string | undefined,
  ) {
    super(
      `session "${sessionId}" already exists with cwd ${JSON.stringify(existingCwd)}; `
      + `requested ${JSON.stringify(requestedCwd)}`,
    )
  }
}

/** Own session identity adoption, composition, model selection, and turn routing. */
export class SessionRuntime {
  private readonly selections = new WeakMap<Agent, WebModelSelectionRef>()
  private readonly creations = new Map<SessionId, Promise<Agent>>()
  private readonly imageAdmissionChains = new WeakMap<Agent, Promise<void>>()
  /** Resolve an attached or persisted API-visible session to its owning agent. */
  readonly agentFor: ReturnType<typeof createApiRemoteAgentResolver>

  /** Create one runtime over a composed host context. */
  constructor(
    private readonly ctx: Context,
    private readonly defaults: ApiProxyDefaults,
  ) {
    this.agentFor = createApiRemoteAgentResolver(ctx, {
      agentOptions: () => this.agentOptions(),
      setup: async ({ meta, events }) =>
        (await this.composeAgent(resolveSessionPreset({ header: meta, events }))).setup,
    })
  }

  /**
   * Resolve the seed model passed to agent creation and resume.
   * @returns The current deployment default selection.
   */
  agentOptions(): AgentOptions {
    const { provider, model } = this.defaults.defaultModelSelection()
    return { provider, model }
  }

  /**
   * Serialize image admission and selection changes for one agent.
   * @param agent - Agent whose admission state is protected.
   * @param operation - Operation to run after earlier admissions settle.
   * @returns The operation result.
   */
  serializeImageAdmission<T>(agent: Agent, operation: () => Promise<T>): Promise<T> {
    const result = (this.imageAdmissionChains.get(agent) ?? Promise.resolve()).then(operation)
    this.imageAdmissionChains.set(agent, result.then(() => undefined, () => undefined))
    return result
  }

  /**
   * Install or return the session-local model selection read by prompt assembly.
   * @param agent - Agent whose selection is requested.
   * @returns Its mutable model-selection reference.
   */
  selectionFor(agent: Agent): WebModelSelectionRef {
    const installed = this.selections.get(agent)
    if (installed !== undefined) return installed
    let picked: ModelSelection | undefined
    const selection: WebModelSelectionRef = {
      get current(): ModelSelection {
        if (picked !== undefined) return picked
        const logged = agent.session.requestHeader()?.config
        if (logged === undefined) return thisDefault()
        return {
          provider: logged.provider,
          model: logged.model,
          ...logged.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: logged.reasoningEffort },
        }
      },
      set current(next: ModelSelection) {
        picked = next
      },
      assembled: undefined,
    }
    const thisDefault = (): ModelSelection => this.defaults.defaultModelSelection()
    installModelSelection(agent.ctx, selection)
    this.selections.set(agent, selection)
    return selection
  }

  /**
   * Resolve the preset and setup callback for a fresh or resumed agent.
   * @param presetId - Requested preset, or undefined for the roster default.
   * @returns The resolved preset identity and agent setup callback.
   */
  async composeAgent(presetId: string | undefined): Promise<{
    agentPreset?: string
    setup: (agentCtx: Context) => Promise<void>
  }> {
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) {
      return {
        setup: (agentCtx: Context) => {
          this.installSelection(agentCtx)
          return Promise.resolve()
        },
      }
    }
    const resolvedId = (await presets.resolve(presetId)).id
    return {
      agentPreset: resolvedId,
      setup: async (agentCtx: Context) => {
        this.installSelection(agentCtx)
        await presets.mount(agentCtx, resolvedId)
      },
    }
  }

  /**
   * Test whether a session is owned by a subagent provider.
   * @param session - Session header to inspect.
   * @param agent - Attached agent, when present.
   * @returns Whether API session operations must defer to a subagent provider.
   */
  hasSubagentOwner(session: Pick<Session, 'header'>, agent: Agent | undefined): boolean {
    return hasApiRemoteSubagentOwner(this.ctx, session, agent)
  }

  /**
   * Map subagent ownership onto the public RPC error.
   * @param sessionId - Refused session identity.
   * @returns The public ownership error.
   */
  subagentOwnershipError(sessionId: SessionId): RpcError {
    return apiRemoteSubagentOwnershipError(sessionId)
  }

  /**
   * Inspect one attached or persisted servable session without resuming it.
   * @param sessionId - Session identity to inspect.
   * @returns Its header and stable event prefix.
   */
  inspectServable(sessionId: SessionId): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return inspectApiRemoteSession(this.ctx, sessionId)
  }

  /**
   * Resolve one requested identity to a live agent, creating or resuming it once.
   * @param sessionId - Requested session identity.
   * @param cwd - Project directory the session must own.
   * @param checkPersistedIdentity - Whether to adopt an existing persisted session.
   * @param presetId - Requested preset for a new or compatible blank session.
   * @returns The attached live agent.
   */
  async ensureSession(
    sessionId: SessionId,
    cwd: string,
    checkPersistedIdentity: boolean,
    presetId?: string,
  ): Promise<Agent> {
    let creation = this.creations.get(sessionId)
    if (creation === undefined) {
      creation = this.createOrResume(sessionId, cwd, checkPersistedIdentity, presetId)
        .catch((error: unknown) => {
          const live = this.ctx.agents.get(sessionId)
          if (live !== undefined) {
            if (this.hasSubagentOwner(live.session, live)) throw new SubagentSessionOwnership(sessionId)
            return live
          }
          const attached = this.ctx.sessions.get(sessionId)
          if (attached !== undefined && this.hasSubagentOwner(attached, undefined)) {
            throw new SubagentSessionOwnership(sessionId)
          }
          throw error
        })
        .finally(() => { this.creations.delete(sessionId) })
      this.creations.set(sessionId, creation)
    }
    const agent = await creation
    if (this.hasSubagentOwner(agent.session, agent)) throw new SubagentSessionOwnership(sessionId)
    this.assertPresetUnchanged(sessionId, presetId, resolveSessionPreset(agent.session))
    if (agent.session.header.cwd !== cwd) {
      throw new SessionCwdConflict(sessionId, cwd, agent.session.header.cwd)
    }
    return agent
  }

  /**
   * Test whether an adapter currently serves the selected provider.
   * @param provider - Provider identity to route.
   * @returns Whether the current LLM registry can serve it.
   */
  routeServed(provider: string): boolean {
    const llm = this.ctx.get('llm')
    return llm === undefined || llm.listProviders().some(entry => entry.id === provider)
  }

  /**
   * Resolve a turn-starting agent and reject selections with no serving adapter.
   * @param request - Correlated request used for a refusal.
   * @param sessionId - Target session identity.
   * @returns The live agent or a correlated refusal.
   */
  async turnAgentFor<T>(
    request: RpcRequest<unknown>,
    sessionId: SessionId,
  ): Promise<{ agent: Agent } | { refused: RpcResponse<T> }> {
    const found = await this.agentFor(sessionId)
    if ('error' in found) return { refused: err(request, found.error) }
    const agent = found.agent
    const selection = this.selectionFor(agent).current
    if (!this.routeServed(selection.provider)) {
      return {
        refused: err(request, {
          code: 'model-unavailable',
          message: `no adapter serves provider "${selection.provider}"; select a model for this session`,
          details: { provider: selection.provider, model: selection.model },
        }),
      }
    }
    return { agent }
  }

  /** Install model selection during scoped agent setup. */
  private installSelection(agentCtx: Context): void {
    const agent = agentCtx.agent
    if (agent === undefined) throw new Error('api-proxy: agent setup has no scoped agent')
    this.selectionFor(agent)
  }

  /** Reject explicit adoption under a composition different from the stored one. */
  private assertPresetUnchanged(
    sessionId: SessionId,
    requested: string | undefined,
    existing: string | undefined,
  ): void {
    if (requested === undefined || requested === existing) return
    throw new AgentPresetConflict(sessionId, requested, existing)
  }

  /** Perform the single in-flight create or persisted resume for one identity. */
  private async createOrResume(
    sessionId: SessionId,
    cwd: string,
    checkPersistedIdentity: boolean,
    presetId: string | undefined,
  ): Promise<Agent> {
    const attached = this.ctx.sessions.get(sessionId)
    const live = this.ctx.agents.get(sessionId)
    if (attached !== undefined && this.hasSubagentOwner(attached, live)) {
      throw new SubagentSessionOwnership(sessionId)
    }
    if (live !== undefined) return live

    const persistence = checkPersistedIdentity ? this.ctx.get('sessionPersistence') : undefined
    const stored = persistence === undefined
      ? undefined
      : (await persistence.list()).find(header => header.id === sessionId)
    if (persistence !== undefined && stored !== undefined) {
      const inspected = await persistence.inspect(sessionId)
      if (this.hasSubagentOwner({ header: inspected.meta }, undefined)) {
        throw new SubagentSessionOwnership(sessionId)
      }
      if (inspected.meta.cwd !== cwd) {
        throw new SessionCwdConflict(sessionId, cwd, inspected.meta.cwd)
      }
      const storedPreset = resolveSessionPreset({ header: inspected.meta, events: inspected.events })
      this.assertPresetUnchanged(sessionId, presetId, storedPreset)
      return (await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: this.agentOptions(),
        setup: (await this.composeAgent(storedPreset)).setup,
      })).agent
    }

    try {
      await mkdir(cwd, { recursive: true })
    } catch (error: unknown) {
      throw new Error(`failed to ensure project directory "${cwd}": ${String(error)}`, { cause: error })
    }
    const composition = await this.composeAgent(presetId)
    return (await this.ctx.agents.create({
      sessionId,
      agentOptions: this.agentOptions(),
      meta: {
        cwd,
        ...composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset },
      },
      setup: composition.setup,
    })).agent
  }
}
