import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  InvalidPresetIdError, PresetExistsError, PresetMountError,
  PresetNotWritableError, UnknownPresetError,
} from '@deepseek-ai/dsh-agent-presets'
import type { ApiProxy, RpcError, RpcRequest, RpcResponse } from '@deepseek-ai/dsh-api-protocol/api'
import type { ApiRemoteAgentResult } from '@deepseek-ai/dsh-api-remotes'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { err, ok } from '../rpc-result.ts'

/**
 * Convert roster resolution and mount failures shared by create and select.
 * @param request - request being answered.
 * @param error - thrown roster failure.
 * @returns a protocol refusal, or undefined for an unrelated error.
 */
export function presetFailure(
  request: RpcRequest<unknown>,
  error: unknown,
): RpcResponse<never> | undefined {
  if (error instanceof UnknownPresetError) {
    return err(request, {
      code: 'agent-preset-not-found', message: error.message,
      details: { agentPreset: error.presetId, available: [...error.available] },
    })
  }
  if (error instanceof PresetMountError) {
    return err(request, {
      code: 'agent-preset-invalid', message: error.message,
      details: { agentPreset: error.presetId, reason: error.reason },
    })
  }
  return undefined
}

function noRoster(agentPreset: string): RpcError {
  return {
    code: 'agent-preset-not-found',
    message: 'this deployment composes no agent presets',
    details: { agentPreset, available: [] },
  }
}

function presetError(agentPreset: string, error: unknown): RpcError {
  if (error instanceof UnknownPresetError) {
    return {
      code: 'agent-preset-not-found', message: error.message,
      details: { agentPreset: error.presetId, available: [...error.available] },
    }
  }
  if (error instanceof InvalidPresetIdError || error instanceof PresetExistsError) {
    return { code: 'agent-preset-invalid', message: error.message, details: { agentPreset, reason: error.message } }
  }
  if (error instanceof PresetNotWritableError) {
    return { code: 'agent-preset-read-only', message: error.message, details: { agentPreset, reason: error.message } }
  }
  return {
    code: 'internal',
    message: `agent preset "${agentPreset}": ${String(error)}`,
    details: {},
  }
}

/** Host services and policy needed by the agent-preset API. */
export interface AgentPresetsApiRuntime {
  readonly ctx: Context
  /** @param sessionId - target session. @returns its live or resumed agent. */
  agentFor(sessionId: SessionId): Promise<ApiRemoteAgentResult>
  /** @param agent - target agent. @returns whether its session has no conversation yet. */
  sessionBlank(agent: Agent): boolean
  /** @returns whether native path opening is available. */
  canOpenPaths(): boolean
  /** @param request - correlated request. @param path - target path. @param signal - caller lifetime. */
  openPath(request: RpcRequest<unknown>, path: string, signal: AbortSignal):
  Promise<RpcResponse<{ opened: true }>>
}

/**
 * Build the agent-preset API over host services and path policy.
 * @param runtime - Host services and path policy.
 * @returns Agent-preset API methods.
 */
export function createAgentPresetsApi(runtime: AgentPresetsApiRuntime): ApiProxy['agentPresets'] {
  const { ctx } = runtime
  const switches = new Map<SessionId, Promise<unknown>>()
  return {
    async list(request) {
      const presets = ctx.get('agentPresets')
      if (presets === undefined) return ok(request, { presets: [], authorable: false, hasDocument: false })
      const defaultId = presets.defaultId
      return ok(request, {
        presets: (await presets.list()).map(preset => ({
          id: preset.id, trust: preset.trust, isDefault: preset.id === defaultId,
          ...preset.name === undefined ? {} : { name: preset.name },
          ...preset.description === undefined ? {} : { description: preset.description },
          ...preset.broken === undefined ? {} : { broken: preset.broken },
        })),
        authorable: presets.authorable,
        hasDocument: runtime.canOpenPaths(),
      })
    },

    async select(request) {
      const { sessionId, agentPreset } = request.payload
      const presets = ctx.get('agentPresets')
      if (presets === undefined) return err(request, noRoster(agentPreset))
      const found = await runtime.agentFor(sessionId)
      if ('error' in found) return err(request, found.error)
      const { agent } = found
      const swap = async (): Promise<RpcResponse<{ agentPreset: string }>> => {
        if (!runtime.sessionBlank(agent)) {
          return err(request, {
            code: 'agent-preset-locked',
            message: `session "${sessionId}" has already started; its agent preset is fixed`,
            details: { sessionId, agentPreset },
          })
        }
        try {
          const preset = await presets.recompose(agent.ctx, agentPreset)
          agent.session.append('agent-preset/selected', { agentPreset: preset.id })
          return ok(request, { agentPreset: preset.id })
        } catch (error: unknown) {
          const refused = presetFailure(request, error)
          return refused ?? err(request, {
            code: 'internal',
            message: `failed to select agent preset "${agentPreset}": ${String(error)}`,
            details: {},
          })
        }
      }
      const queued = switches.get(sessionId) ?? Promise.resolve()
      const turn = queued.then(swap)
      switches.set(sessionId, turn.catch(() => undefined))
      try {
        return await turn
      } finally {
        if (switches.get(sessionId) === turn) switches.delete(sessionId)
      }
    },

    async read(request) {
      const { agentPreset } = request.payload
      const presets = ctx.get('agentPresets')
      if (presets === undefined) return err(request, noRoster(agentPreset))
      try {
        const preset = await presets.resolve(agentPreset)
        return ok(request, {
          agentPreset: preset.id, trust: preset.trust, content: await presets.read(preset.id),
          ...preset.name === undefined ? {} : { name: preset.name },
          ...preset.description === undefined ? {} : { description: preset.description },
        })
      } catch (error: unknown) {
        return err(request, presetError(agentPreset, error))
      }
    },

    async copy(request) {
      const { from, agentPreset, name } = request.payload
      const presets = ctx.get('agentPresets')
      if (presets === undefined) return err(request, noRoster(agentPreset))
      try {
        await presets.copy(from, agentPreset, name)
        return ok(request, { agentPreset })
      } catch (error: unknown) {
        return err(request, presetError(agentPreset, error))
      }
    },

    async openDocument(request, signal) {
      const { agentPreset } = request.payload
      const presets = ctx.get('agentPresets')
      if (presets === undefined) return err(request, noRoster(agentPreset))
      try {
        const preset = await presets.resolve(agentPreset)
        if (preset.trust !== 'user') throw new PresetNotWritableError(preset.id, 'it ships with the deployment')
        const directory = dirname(preset.path)
        if (!runtime.canOpenPaths()) return ok(request, { opened: false as const, path: directory })
        return await runtime.openPath(request, directory, signal)
      } catch (error: unknown) {
        return err(request, presetError(agentPreset, error))
      }
    },

    async remove(request) {
      const { agentPreset } = request.payload
      const presets = ctx.get('agentPresets')
      if (presets === undefined) return err(request, noRoster(agentPreset))
      try {
        await presets.remove(agentPreset)
        return ok(request, {})
      } catch (error: unknown) {
        return err(request, presetError(agentPreset, error))
      }
    },
  }
}
