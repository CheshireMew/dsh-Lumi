/** Lumi desktop profile glue and authenticated DeepSeek endpoint discovery. */
import type { Context } from '@deepseek-ai/cordis'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmDiscoveredModel, LlmModelDiscoveryRequest } from '@deepseek-ai/dsh-llm'

/** Cordis plugin name. */
export const name = 'lumi-desktop'
/** Model discovery is registered only after the LLM service exists. */
export const inject = ['llm']

const DEEPSEEK_SETTINGS_NAMESPACE = 'llm-deepseek'
const DEEPSEEK_PUBLIC_BASE_URL = 'https://api.deepseek.com'
const MAX_MODEL_LIST_BYTES = 256 * 1024

function listingUrl(baseURL: string): string {
  let url: URL
  try {
    url = new URL(baseURL)
  } catch (error) {
    throw new LlmError(`DeepSeek model verification received an invalid API URL: ${baseURL}`, 'DISCOVERY_FAILED', { cause: error })
  }
  url.hash = ''
  url.search = ''
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/models`
  return url.href
}

function parseModels(value: unknown, url: string): readonly LlmDiscoveredModel[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LlmError(`${url} did not return a DeepSeek model list`, 'DISCOVERY_FAILED')
  }
  const data = (value as Record<string, unknown>)['data']
  if (!Array.isArray(data)) throw new LlmError(`${url} did not return a DeepSeek model list`, 'DISCOVERY_FAILED')
  const seen = new Set<string>()
  return data.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new LlmError(`${url} returned an invalid model entry`, 'DISCOVERY_FAILED')
    }
    const id = (entry as Record<string, unknown>)['id']
    if (typeof id !== 'string' || id.trim().length === 0 || seen.has(id)) {
      throw new LlmError(`${url} returned an invalid or duplicate model id`, 'DISCOVERY_FAILED')
    }
    seen.add(id)
    return { id }
  })
}

/**
 * Verify a draft DeepSeek credential against the provider's authenticated model endpoint.
 * @param request unsaved endpoint and API key supplied by the settings form.
 * @returns models advertised by the authenticated endpoint.
 */
export async function discoverDeepSeekModels(
  request: LlmModelDiscoveryRequest,
): Promise<readonly LlmDiscoveredModel[]> {
  const apiKey = request.apiKey?.trim()
  if (apiKey === undefined || apiKey.length === 0) {
    throw new LlmError('Enter the DeepSeek API key to verify it before saving', 'DISCOVERY_FAILED')
  }
  const url = listingUrl(request.baseURL ?? DEEPSEEK_PUBLIC_BASE_URL)
  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
      ...request.signal === undefined ? {} : { signal: request.signal },
    })
  } catch (error) {
    if (request.signal?.aborted === true) {
      throw new LlmError('DeepSeek API key verification was cancelled', 'ABORTED', { cause: error })
    }
    throw new LlmError(`Could not reach ${url}`, 'DISCOVERY_FAILED', { cause: error })
  }
  if (!response.ok) {
    const credentialHint = response.status === 401 || response.status === 403 ? '; check the API key' : ''
    throw new LlmError(`${url} answered ${response.status}${credentialHint}`, 'DISCOVERY_FAILED')
  }
  let bytes: ArrayBuffer
  try {
    bytes = await response.arrayBuffer()
  } catch (error) {
    if (request.signal?.aborted === true) {
      throw new LlmError('DeepSeek API key verification was cancelled', 'ABORTED', { cause: error })
    }
    throw new LlmError(`${url} could not be read`, 'DISCOVERY_FAILED', { cause: error })
  }
  if (bytes.byteLength > MAX_MODEL_LIST_BYTES) {
    throw new LlmError(`${url} returned more than ${MAX_MODEL_LIST_BYTES} bytes`, 'DISCOVERY_FAILED')
  }
  try {
    return parseModels(JSON.parse(new TextDecoder().decode(bytes)), url)
  } catch (error) {
    if (error instanceof LlmError) throw error
    throw new LlmError(`${url} did not return JSON`, 'DISCOVERY_FAILED', { cause: error })
  }
}

/** Register authenticated model discovery for the official DeepSeek settings namespace. */
export function apply(ctx: Context): void {
  ctx.llm.registerModelDiscovery(DEEPSEEK_SETTINGS_NAMESPACE, discoverDeepSeekModels)
}
