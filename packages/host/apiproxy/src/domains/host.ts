import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type { ApiProxy, RpcRequest, RpcResponse } from '@deepseek-ai/dsh-api-protocol/api'
import { PRODUCT_VERSION } from '@deepseek-ai/dsh-product-identity'
import {
  DirectoryPickerError,
  type DirectoryPickerCapability,
} from '@deepseek-ai/dsh-host-directory-picker'
import { err, ok } from '../rpc-result.ts'

/** Host services and policy closures used by the host API domain. */
export interface HostApiRuntime {
  /** Project directory used when a create request omits one. */
  readonly cwd: string
  /** @returns The model selection applied to the next unpinned session. */
  defaultModelSelection(): ModelSelection
  /** @returns Number of live attached agents. */
  attachedSessionCount(): number
  /** @returns Current directory-picking capability. */
  directoryPickerCapability(): DirectoryPickerCapability
  /** @returns Whether native path opening is available. */
  canOpenPaths(): boolean
  /**
   * Open a host-resolved path.
   * @param request - correlated RPC request.
   * @param path - host path to open.
   * @param signal - caller lifetime.
   * @returns correlated RPC response.
   */
  openPath(
    request: RpcRequest<unknown>,
    path: string,
    signal: AbortSignal,
  ): Promise<RpcResponse<{ opened: true }>>
}

/** Map a browse failure to the API error vocabulary. */
function directoryError(error: unknown) {
  if (error instanceof DirectoryPickerError) {
    return { code: error.code, message: error.message, details: { path: error.path } } as const
  }
  return {
    code: 'internal' as const,
    message: error instanceof Error ? error.message : String(error),
    details: {},
  }
}

/**
 * Build host description, directory selection, and path-opening methods.
 * @param runtime - host services and resolved policy.
 * @returns the host API domain.
 */
export function createHostApi(runtime: HostApiRuntime): ApiProxy['host'] {
  return {
    describe(request) {
      const selection = runtime.defaultModelSelection()
      return Promise.resolve(ok(request, {
        version: PRODUCT_VERSION,
        cwd: runtime.cwd,
        provider: selection.provider,
        model: selection.model,
        attachedSessions: runtime.attachedSessionCount(),
        canOpenPath: runtime.canOpenPaths(),
      }))
    },

    async pickDirectory(request, signal) {
      const capability = runtime.directoryPickerCapability()
      if (capability.kind !== 'native') {
        return err(request, {
          code: 'directory-picker-unavailable',
          message: `host.pickDirectory needs the native capability; the composed picker serves "${capability.kind}"`,
          details: { capability: capability.kind },
        })
      }
      try {
        return ok(request, { path: await capability.pick(signal) })
      } catch (error: unknown) {
        if (signal.aborted) {
          return err(request, { code: 'cancelled', message: 'directory picker was aborted', details: {} })
        }
        return err(request, {
          code: 'internal',
          message: `directory picker failed: ${error instanceof Error ? error.message : String(error)}`,
          details: {},
        })
      }
    },

    async listDirectory(request, signal) {
      const capability = runtime.directoryPickerCapability()
      if (capability.kind !== 'browse') {
        return err(request, {
          code: 'directory-picker-unavailable',
          message: `host.listDirectory needs the browse capability; the composed picker serves "${capability.kind}"`,
          details: { capability: capability.kind },
        })
      }
      try {
        return ok(request, await capability.list(request.payload.path, signal))
      } catch (error: unknown) {
        if (signal.aborted) {
          return err(request, { code: 'cancelled', message: 'directory listing was aborted', details: {} })
        }
        return err(request, directoryError(error))
      }
    },

    async createDirectory(request) {
      const capability = runtime.directoryPickerCapability()
      if (capability.kind !== 'browse') {
        return err(request, {
          code: 'directory-picker-unavailable',
          message: `host.createDirectory needs the browse capability; the composed picker serves "${capability.kind}"`,
          details: { capability: capability.kind },
        })
      }
      try {
        const path = await capability.createDirectory(request.payload.path, request.payload.name)
        return ok(request, { path })
      } catch (error: unknown) {
        return err(request, directoryError(error))
      }
    },

    openPath(request, signal) {
      return runtime.openPath(request, request.payload.path, signal)
    },
  }
}
