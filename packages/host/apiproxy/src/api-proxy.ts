/**
 * Host-side ApiProxy implementation. Signature discipline: unary takes the
 * narrow RpcRequest<P> and echoes request.rpcId on the RpcResponse<T>.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets/types'
import type {} from '@deepseek-ai/dsh-tools'
import type { ApiProxy, SessionListMetadata } from '@deepseek-ai/dsh-api-protocol/api'
import {
  DEFAULT_SESSION_LOG_COMPRESSION_LEVEL,
} from './session-export.ts'
// Type-only: resolves `ctx.get('sessionProjections')` to the projection registry.
import type {} from '@deepseek-ai/dsh-session-projection'
// Type-only: resolves `ctx.get('sessionProjectionCache')` (the cold listing column).
import type {} from '@deepseek-ai/dsh-session-projection-cache'
// GoalError narrows domain rejections to their stable codes at the wire boundary.
// Type-only edges: resolve the command-change stream and `ctx.get('skills')`.
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-skill'
// The settings/credentials seams: brand guards run at this wire boundary; the
// service reads stay optional (`ctx.get`) so a composition without either
// provider still serves every other domain.
import { imageLimitsProjectionSchema, sessionListMetadataProjectionSchema } from '@deepseek-ai/dsh-api-protocol/api/sessions.schema'
import type { RpcError, RpcRequest, RpcResponse } from '@deepseek-ai/dsh-api-protocol/api/rpc'
import { canOpenNativePath, openNativePath, openNativeTextFile } from './native-path-opener.ts'
import { err, ok } from './rpc-result.ts'
import { createHostApi } from './domains/host.ts'
import { createGoalsApi } from './domains/goals.ts'
import { createCredentialsApi } from './domains/credentials.ts'
import { createLlmApi } from './domains/llm.ts'
import { createDownloadsApi } from './domains/downloads.ts'
import { createSettingsApi } from './domains/settings.ts'
import { createAgentPresetsApi } from './domains/agent-presets.ts'
import { createSkillsApi } from './domains/skills.ts'
import { createSubagentsApi } from './domains/subagents.ts'
import { WorkspaceApiCoordinator } from './domains/workspace.ts'
import {
  canonicalClientTimeZone,
} from './prompt-content.ts'
import { InteractionBroker } from './interaction-broker.ts'
import { createEventsApi } from './domains/events.ts'
import { createSessionsApi } from './domains/sessions.ts'
import { SessionRuntime } from './session-runtime.ts'
import { SessionReader } from './session-reader.ts'
import type { ApiProxyDefaults } from './api-proxy-defaults.ts'
export type { ApiProxyDefaults } from './api-proxy-defaults.ts'
import {
  applySessionListMetadata,
  sessionBlank,
} from './session-summary.ts'
import { SessionListing } from './session-listing.ts'
export {
  DEFAULT_COLD_BLANK_PROBE_MAX_BYTES,
  DEFAULT_COLD_SUMMARY_BATCH_SIZE,
  DEFAULT_SESSION_LIST_SNAPSHOT_TTL_MS,
} from './session-listing.ts'

/** Default maximum provider calls made by one session search. */
export const DEFAULT_SESSION_SEARCH_PROVIDER_CALL_LIMIT = 100
/** Default maximum undelivered frames retained by one Host event stream. */
export const DEFAULT_EVENT_QUEUE_CAPACITY = 8_192

/**
 * Implement ApiProxy over a composed host context.
 * @param ctx - a context with the Host spine and Workspace registry mounted.
 * @param defaults - host routing and project-directory defaults.
 * @returns the ApiProxy implementation.
 */
export function createApiProxy(ctx: Context, defaults: ApiProxyDefaults): ApiProxy {
  const sessionExportCompressionLevel = defaults.sessionExportCompressionLevel
    ?? DEFAULT_SESSION_LOG_COMPRESSION_LEVEL
  const sessionSearchProviderCallLimit = defaults.sessionSearchProviderCallLimit
    ?? DEFAULT_SESSION_SEARCH_PROVIDER_CALL_LIMIT
  const eventQueueCapacity = defaults.eventQueueCapacity ?? DEFAULT_EVENT_QUEUE_CAPACITY
  const sessionRuntime = new SessionRuntime(ctx, defaults)
  const sessionReader = new SessionReader(ctx, sessionRuntime)
  const workspaceCoordinator = new WorkspaceApiCoordinator(() => ctx.workspaceRegistry)
  const interactions = new InteractionBroker(ctx)
  const sessionListing = new SessionListing(ctx, defaults)

  // Projection change feed → session/projection push frames. The carrier
  // mints the wire frame (the Service Definition package holds no wire vocabulary); the
  // child activates only when a projection registry is composed, and the
  // subscription unwinds with this gateway's fiber.
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.onChanged((session, key, value, seq) => {
      interactions.broadcast({ type: 'session/projection', sessionId: session.id, key, value, seq })
    })
  })

  // The cache supplies recency and a monotonic non-blank hint. A cached
  // `blank: true` remains only a prefix fact and is verified on the cold path.
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register<'sessionListMetadata', SessionListMetadata>({
      key: 'sessionListMetadata',
      schema: sessionListMetadataProjectionSchema,
      init: () => ({ blank: true, lastPromptAt: null }),
      apply: applySessionListMetadata,
      view: state => state,
      stateVersion: 1,
    })
  })

  // The imageLimits projection unit: the attachments config this proxy
  // enforces at prompt admission, constant per host boot. `apply` keeps the
  // same state reference for every event, so no change frames are ever
  // pushed — baselines alone carry the value — and clients pre-check intake
  // and label upload affordances from it. Registered here, not in the
  // attachment Service Definition: dsh-llm depends on dsh-attachment, so the
  // seam package cannot reference the projection registry without a cycle,
  // and the per-message rules the value describes are this proxy's own
  // admission checks. The child activates only while both seams are composed.
  // `view` reading the live service instead of the (null) state is sanctioned
  // exactly for boot-constant units: the value cannot change within a process
  // lifetime, so the fold stays observationally pure, and a stale persisted
  // cache row re-viewing to the current config is the correct outcome.
  ctx.inject(['sessionProjections', 'attachments'], (projectionCtx) => {
    projectionCtx.sessionProjections.register<'imageLimits', null>({
      key: 'imageLimits',
      schema: imageLimitsProjectionSchema,
      init: () => null,
      apply: state => state,
      view: () => projectionCtx.attachments.imageLimits,
      stateVersion: 1,
    })
  })

  /**
   * Resolve the goal service THIS agent runs.
   *
   * The service is per session: an agent preset mounts it behind an `isolate`
   * realm, which no host context resolves. Reading it from the root would
   * answer "absent" for a session whose composition mounts it — so the lookup
   * is keyed by the agent, and only a deployment composing it nowhere is
   * genuinely absent.
   */
  function goalServiceFor(agent: Agent): NonNullable<ReturnType<typeof ctx.get<'goals'>>> | { error: RpcError } {
    const presets = ctx.get('agentPresets')
    const goals = presets?.serviceFor(agent, 'goals') ?? ctx.get('goals')
    if (goals === undefined) {
      return { error: { code: 'internal', message: 'goal service is absent: neither this session\'s agent preset nor the host composition mounts @deepseek-ai/dsh-goal', details: {} } }
    }
    return goals
  }

  /** Open one Host-resolved target and map native failures onto the wire vocabulary. */
  async function openTarget(
    request: RpcRequest<unknown>, path: string, signal: AbortSignal,
    open: (path: string, signal: AbortSignal) => Promise<void>,
  ): Promise<RpcResponse<{ opened: true }>> {
    try {
      await open(path, signal)
      return ok(request, { opened: true as const })
    } catch (error: unknown) {
      if (signal.aborted) {
        return err(request, {
          code: 'cancelled',
          message: 'path open was aborted',
          details: {},
        })
      }
      return err(request, {
        code: 'internal',
        message: `path open failed: ${error instanceof Error ? error.message : String(error)}`,
        details: {},
      })
    }
  }

  /** Open one Host-resolved path with its default application. */
  function openPath(
    request: RpcRequest<unknown>, path: string, signal: AbortSignal,
  ): Promise<RpcResponse<{ opened: true }>> {
    const open = defaults.openPath
      ?? ((target: string, openSignal: AbortSignal) => openNativePath(target, openSignal))
    return openTarget(request, path, signal, open)
  }

  /** Open one Host-resolved text document in a native editor. */
  function openTextFile(
    request: RpcRequest<unknown>, path: string, signal: AbortSignal,
  ): Promise<RpcResponse<{ opened: true }>> {
    const open = defaults.openTextFile
      ?? ((target: string, openSignal: AbortSignal) => openNativeTextFile(target, openSignal))
    return openTarget(request, path, signal, open)
  }

  /** Whether this deployment can hand a path to a native opener at all. */
  function canOpenPaths(): boolean {
    if (defaults.canOpenPath !== undefined) return defaults.canOpenPath()
    // An injected opener is by definition usable; otherwise ask the platform.
    return defaults.openPath !== undefined || canOpenNativePath()
  }

  return {
    sessions: createSessionsApi({
      ctx,
      defaults,
      runtime: sessionRuntime,
      reader: sessionReader,
      listing: sessionListing,
      searchProviderCallLimit: sessionSearchProviderCallLimit,
    }),

    subagents: createSubagentsApi({
      ctx,
      inspectServable: sessionId => sessionRuntime.inspectServable(sessionId),
      canonicalClientTimeZone,
    }),

    workspace: workspaceCoordinator.api(),

    host: createHostApi({
      cwd: defaults.cwd,
      defaultModelSelection: defaults.defaultModelSelection,
      attachedSessionCount: () => ctx.agents.list().length,
      directoryPickerCapability: () => ctx.directoryPicker.capability(),
      canOpenPaths,
      openPath,
    }),

    goals: createGoalsApi({ agentFor: sessionRuntime.agentFor, goalServiceFor }),

    agentPresets: createAgentPresetsApi({
      ctx,
      agentFor: sessionRuntime.agentFor,
      sessionBlank: agent => sessionBlank(agent.session),
      canOpenPaths,
      openPath,
    }),

    skills: createSkillsApi({
      ctx,
      presenterScopeFor: (sessionId, session) => sessionReader.presenterScope(sessionId, session),
    }),

    settings: createSettingsApi({
      settings: ctx.get('settings'),
      modelProviderNamespaces: () => ctx.llm.listConfigurableProviders().map(entry => entry.settingsNs),
      openTextFile,
    }),

    credentials: createCredentialsApi(ctx.get('credentials')),

    llm: createLlmApi(() => ctx.llm),

    events: createEventsApi(ctx, interactions, eventQueueCapacity),

    downloads: createDownloadsApi(ctx, sessionExportCompressionLevel),

    respond: message => interactions.respond(message),
  }
}
