import { createServer } from 'node:http'
import type { RequestListener } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverDeepSeekModels } from '../src/index.ts'

const servers: ReturnType<typeof createServer>[] = []

async function endpoint(handler: RequestListener): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}/v1`
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) })
  })))
})

describe('Lumi DeepSeek credential verification', () => {
  it('sends the unsaved key to the configured models endpoint', async () => {
    const baseURL = await endpoint((request, response) => {
      expect(request.url).toBe('/v1/models')
      expect(request.headers.authorization).toBe('Bearer typed-key')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ object: 'list', data: [
        { id: 'deepseek-v4-flash', object: 'model', owned_by: 'deepseek' },
        { id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek' },
      ] }))
    })
    await expect(discoverDeepSeekModels({ baseURL, apiKey: ' typed-key ' })).resolves.toEqual([
      { id: 'deepseek-v4-flash' },
      { id: 'deepseek-v4-pro' },
    ])
  })

  it('turns authentication refusal into a key-specific failure', async () => {
    const baseURL = await endpoint((_request, response) => { response.writeHead(401); response.end() })
    await expect(discoverDeepSeekModels({ baseURL, apiKey: 'wrong' })).rejects.toThrow(/401; check the API key/u)
  })

  it('rejects malformed successful responses and missing draft keys', async () => {
    const baseURL = await endpoint((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: '' }] }))
    })
    await expect(discoverDeepSeekModels({ baseURL, apiKey: 'present' })).rejects.toThrow(/invalid or duplicate model id/u)
    await expect(discoverDeepSeekModels({ baseURL })).rejects.toThrow(/Enter the DeepSeek API key/u)
  })
})
