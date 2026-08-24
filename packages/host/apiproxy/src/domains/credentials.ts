import type { ApiProxy, CredentialView, RpcError } from '@deepseek-ai/dsh-api-protocol/api'
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { err, ok } from '../rpc-result.ts'

function credentialsAbsent(): RpcError {
  return {
    code: 'internal',
    message: 'credentials service is absent: this deployment does not mount a credential provider (e.g. @deepseek-ai/dsh-credentials-local) in its composition',
    details: {},
  }
}

/**
 * Build redacted credential inspection and mutation methods.
 * @param credentials - optional configured credential provider.
 * @returns the credentials API domain.
 */
export function createCredentialsApi(credentials: CredentialProvider | undefined): ApiProxy['credentials'] {
  return {
    async describe(request) {
      if (credentials === undefined) return err(request, credentialsAbsent())
      const entries = await Promise.all(request.payload.refs.map(async (ref) => {
        const info = await credentials.describe(credentialRef(ref))
        const view: CredentialView = {
          configured: info.configured,
          ...info.source === undefined ? {} : { source: info.source },
          writable: info.writable,
        }
        return [ref, view] as const
      }))
      return ok(request, { credentials: Object.fromEntries(entries) })
    },

    async set(request) {
      if (credentials === undefined) return err(request, credentialsAbsent())
      const { ref, value } = request.payload
      try {
        await credentials.set(credentialRef(ref), value)
      } catch (error: unknown) {
        return err(request, {
          code: 'credential-rejected',
          message: error instanceof Error ? error.message : String(error),
          details: { ref },
        })
      }
      return ok(request, {})
    },

    async unset(request) {
      if (credentials === undefined) return err(request, credentialsAbsent())
      const { ref } = request.payload
      try {
        await credentials.unset(credentialRef(ref))
      } catch (error: unknown) {
        return err(request, {
          code: 'credential-rejected',
          message: error instanceof Error ? error.message : String(error),
          details: { ref },
        })
      }
      return ok(request, {})
    },
  }
}
