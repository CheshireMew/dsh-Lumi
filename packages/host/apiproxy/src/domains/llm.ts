import type {
  ApiProxy,
  ConfigurableProviderView,
  ModelCatalogFailure,
  ModelProviderGroup,
  ModelReasoning,
} from '@deepseek-ai/dsh-api-protocol/api'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { err, ok } from '../rpc-result.ts'

/**
 * Build the model catalog while preserving per-provider failures.
 * @param llm - Current provider and model registry.
 * @returns Successful provider groups and isolated provider failures.
 */
export async function buildModelCatalog(llm: LlmRuntime): Promise<{
  groups: ModelProviderGroup[]
  failures: ModelCatalogFailure[]
}> {
  const catalog = await Promise.all(llm.listProviders().map(async (provider) => {
    try {
      const models = await llm.listModels(provider.id)
      const entries = await Promise.all(models.map(async (model) => {
        const resolved = await llm.resolveModelInfo(provider.id, model.id)
        const reasoning: ModelReasoning | undefined = resolved.reasoning === undefined
          ? undefined
          : {
            efforts: resolved.reasoning.efforts.map(effort => ({
              id: effort.id,
              name: effort.name,
              ...effort.description === undefined ? {} : { description: effort.description },
            })),
            ...resolved.reasoning.defaultEffort === undefined
              ? {}
              : { defaultEffort: resolved.reasoning.defaultEffort },
          }
        return {
          id: model.id,
          name: model.name,
          ...model.description === undefined ? {} : { description: model.description },
          ...reasoning === undefined ? {} : { reasoning },
        }
      }))
      const group: ModelProviderGroup = { id: provider.id, name: provider.name, models: entries }
      return { kind: 'group' as const, group }
    } catch (error: unknown) {
      const failure: ModelCatalogFailure = {
        id: provider.id,
        name: provider.name,
        message: error instanceof Error ? error.message : String(error),
      }
      return { kind: 'failure' as const, failure }
    }
  }))
  return {
    groups: catalog.flatMap(item => item.kind === 'group' ? [item.group] : [])
      .filter(group => group.models.length > 0),
    failures: catalog.flatMap(item => item.kind === 'failure' ? [item.failure] : []),
  }
}

/**
 * Build provider and model API methods over a lazily resolved registry.
 * @param llmForCall - Resolve the route registry only when an LLM operation runs.
 * @returns Provider and model API methods.
 */
export function createLlmApi(llmForCall: () => LlmRuntime): ApiProxy['llm'] {
  return {
    providers(request) {
      const llm = llmForCall()
      const registered = llm.listProviders()
      const active = new Set(registered.map(provider => provider.id))
      const directory = llm.listConfigurableProviders()
      const declared = new Set(directory.map(entry => entry.provider))
      const views: ConfigurableProviderView[] = directory.map(entry => ({
        provider: entry.provider,
        displayName: entry.displayName,
        settingsNs: entry.settingsNs,
        settingsPath: [...entry.settingsPath],
        active: active.has(entry.provider),
        ...entry.declared === undefined ? {} : { declared: entry.declared },
      }))
      for (const provider of registered) {
        if (declared.has(provider.id)) continue
        views.push({
          provider: provider.id,
          displayName: provider.name,
          settingsNs: '',
          settingsPath: [],
          active: true,
        })
      }
      return Promise.resolve(ok(request, { providers: views }))
    },

    async models(request) {
      return ok(request, await buildModelCatalog(llmForCall()))
    },

    async discoverModels(request, signal) {
      const llm = llmForCall()
      const { settingsNs, provider, baseURL, api, apiKey } = request.payload
      try {
        const models = await llm.discoverModels(settingsNs, {
          ...provider === undefined ? {} : { provider },
          ...baseURL === undefined ? {} : { baseURL },
          ...api === undefined ? {} : { api },
          ...apiKey === undefined ? {} : { apiKey },
          ...signal === undefined ? {} : { signal },
        })
        return ok(request, { models })
      } catch (error: unknown) {
        return err(request, {
          code: 'model-discovery-failed',
          message: error instanceof Error ? error.message : String(error),
          details: { settingsNs, ...baseURL === undefined ? {} : { baseURL } },
        })
      }
    },
  }
}
