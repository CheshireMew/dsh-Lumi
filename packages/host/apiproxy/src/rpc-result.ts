import type { RpcError, RpcRequest, RpcResponse } from '@deepseek-ai/dsh-api-protocol/api'

/**
 * Wrap a successful value while echoing the request identity.
 * @param request - request being answered.
 * @param value - successful response value.
 * @returns A successful narrow RPC response.
 */
export function ok<T>(request: RpcRequest<unknown>, value: T): RpcResponse<T> {
  return { rpcId: request.rpcId, result: { ok: true, value } }
}

/**
 * Wrap a protocol error while echoing the request identity.
 * @param request - request being answered.
 * @param error - protocol failure.
 * @returns A failed narrow RPC response.
 */
export function err<T>(request: RpcRequest<unknown>, error: RpcError): RpcResponse<T> {
  return { rpcId: request.rpcId, result: { ok: false, error } }
}
