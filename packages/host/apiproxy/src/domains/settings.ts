import type {
  ApiProxy, RpcError, RpcRequest, RpcResponse, SettingsNamespaceView,
} from '@deepseek-ai/dsh-api-protocol/api'
import {
  SettingsConflictError, settingsNamespace,
  type SettingsDescriptor, type SettingsNamespace, type SettingsPathOp, type SettingsProvider,
} from '@deepseek-ai/dsh-settings'
import { err, ok } from '../rpc-result.ts'

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

/** Settings provider, exposure policy, and native document opener. */
export interface SettingsApiRuntime {
  readonly settings: SettingsProvider | undefined
  /** @returns namespaces declared by configurable model providers. */
  modelProviderNamespaces(): Iterable<string>
  /** @param request - correlated request. @param path - document path. @param signal - caller lifetime. */
  openTextFile(request: RpcRequest<unknown>, path: string, signal: AbortSignal):
  Promise<RpcResponse<{ opened: true }>>
}

function settingsAbsent(): RpcError {
  return {
    code: 'internal',
    message: 'settings service is absent: this deployment does not mount a settings provider (e.g. @deepseek-ai/dsh-settings-file) in its composition',
    details: {},
  }
}

function namespaceView(descriptor: SettingsDescriptor): SettingsNamespaceView {
  return {
    ns: String(descriptor.ns), schema: descriptor.schema, value: descriptor.value,
    ...descriptor.base === undefined ? {} : { base: descriptor.base },
    ...descriptor.user === undefined ? {} : { user: descriptor.user },
    applies: descriptor.applies,
    secrets: (descriptor.secrets ?? []).map(secret => ({ path: [...secret.path], set: secret.set })),
    revision: descriptor.revision,
  }
}

function exposedNamespaces(runtime: SettingsApiRuntime): Set<string> {
  const exposed = new Set(runtime.modelProviderNamespaces())
  for (const ns of runtime.settings?.namespacesFor('configuration-client') ?? []) exposed.add(ns)
  return exposed
}

function notExposed(request: RpcRequest<unknown>, ns: string): RpcResponse<SettingsNamespaceView> {
  return err(request, {
    code: 'settings-not-exposed',
    message: `settings namespace "${ns}" is not exposed to configuration clients`,
    details: { ns },
  })
}

async function settingsWrite(
  runtime: SettingsApiRuntime,
  request: RpcRequest<unknown>,
  ns: string,
  mode: 'update' | 'replace' | 'mutate',
  section: object,
  expectedRevision?: number,
): Promise<RpcResponse<SettingsNamespaceView>> {
  const { settings } = runtime
  if (settings === undefined) return err(request, settingsAbsent())
  const rejected = (error: unknown): RpcResponse<SettingsNamespaceView> => {
    if (error instanceof SettingsConflictError) {
      return err(request, {
        code: 'settings-conflict', message: error.message,
        details: { ns, expected: error.expected, actual: error.actual },
      })
    }
    return err(request, {
      code: 'settings-rejected',
      message: `settings ${mode} for "${ns}" was rejected; check the submitted fields`,
      details: { ns },
    })
  }
  let branded: SettingsNamespace
  try {
    branded = settingsNamespace(ns)
  } catch (error: unknown) {
    return rejected(error)
  }
  if (!exposedNamespaces(runtime).has(ns)) return notExposed(request, ns)
  try {
    if (mode === 'update') await settings.update(branded, section, expectedRevision)
    else if (mode === 'replace') await settings.replace(branded, section, expectedRevision)
    else await settings.mutate(branded, section as SettingsPathOp[], expectedRevision)
  } catch (error: unknown) {
    return rejected(error)
  }
  const descriptor = settings.describeForWire().find(candidate => candidate.ns === branded)
  if (descriptor === undefined) {
    return err(request, {
      code: 'internal', message: `settings namespace "${ns}" was disposed after the ${mode}`, details: {},
    })
  }
  return ok(request, namespaceView(descriptor))
}

/**
 * Build settings API methods over the provider and host exposure policy.
 * @param runtime - Settings provider and host policy.
 * @returns Settings API methods.
 */
export function createSettingsApi(runtime: SettingsApiRuntime): ApiProxy['settings'] {
  return {
    describe(request) {
      const { settings } = runtime
      if (settings === undefined) return Promise.resolve(err(request, settingsAbsent()))
      const exposed = exposedNamespaces(runtime)
      return Promise.resolve(ok(request, {
        writable: settings.writable,
        hasDocument: settings.documentPath !== undefined,
        namespaces: settings.describeForWire()
          .filter(descriptor => exposed.has(String(descriptor.ns))).map(namespaceView),
      }))
    },
    async openDocument(request, signal) {
      const { settings } = runtime
      if (settings === undefined) return err(request, settingsAbsent())
      if (isAborted(signal)) {
        return err(request, { code: 'cancelled', message: 'settings document open was aborted', details: {} })
      }
      let path: string | undefined
      try {
        path = await settings.prepareDocument()
      } catch (error: unknown) {
        if (isAborted(signal)) {
          return err(request, {
            code: 'cancelled', message: 'settings document preparation was aborted', details: {},
          })
        }
        return err(request, {
          code: 'internal',
          message: `settings document preparation failed: ${error instanceof Error ? error.message : String(error)}`,
          details: {},
        })
      }
      if (path === undefined) {
        return err(request, {
          code: 'internal', message: 'settings provider has no local document to open', details: {},
        })
      }
      if (isAborted(signal)) {
        return err(request, { code: 'cancelled', message: 'settings document open was aborted', details: {} })
      }
      return runtime.openTextFile(request, path, signal)
    },
    update: request => settingsWrite(
      runtime, request, request.payload.ns, 'update', request.payload.patch, request.payload.expectedRevision),
    replace: request => settingsWrite(
      runtime, request, request.payload.ns, 'replace', request.payload.section, request.payload.expectedRevision),
    mutate: request => settingsWrite(
      runtime, request, request.payload.ns, 'mutate', request.payload.ops, request.payload.expectedRevision),
  }
}
