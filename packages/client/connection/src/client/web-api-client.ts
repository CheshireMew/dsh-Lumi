/** Browser API carrier: HTTP upstream plus one WebSocket per downstream event stream. */

import type { ApiProxy, HostFrame, MuxFrame, RpcRequest, ServerRequest } from './api.ts'
import { AbstractApiClient } from './api.ts'
import { hostFrameSchema, muxFrameSchema } from '@deepseek-ai/dsh-api-protocol/api/events.schema'
import { serverRequestSchema } from '@deepseek-ai/dsh-api-protocol/api/rpc.schema'
import { HOST_EVENTS_PATH, MUX_EVENTS_PATH } from '../api-path.ts'
import { DEFAULT_WEBSOCKET_INBOX_CAPACITY } from '../limits.ts'
import { SocketInbox } from './socket-inbox.ts'

type Parser<F> = { parse(value: unknown): F }

/** Browser platform subclass: unary/respond use fetch; mux/host use downlink-only WebSockets. */
export class WebApiClient extends AbstractApiClient {
  /** @param websocketInboxCapacity - Maximum decoded frames retained before reconnect. */
  constructor(
    private readonly websocketInboxCapacity = DEFAULT_WEBSOCKET_INBOX_CAPACITY,
  ) {
    super()
  }

  protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
    return globalThis.fetch(input, init)
  }

  protected override openMux(
    _payload: Parameters<ApiProxy['events']['mux']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<MuxFrame>> {
    return this.readWebSocket(MUX_EVENTS_PATH, signal, muxFrameSchema, onOpen)
  }

  protected override openHost(
    _payload: Parameters<ApiProxy['events']['host']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<HostFrame>> {
    return this.readWebSocket(HOST_EVENTS_PATH, signal, hostFrameSchema, onOpen)
  }

  private async *readWebSocket<F extends MuxFrame | HostFrame>(
    path: string,
    signal: AbortSignal,
    frameSchema: Parser<F>,
    onOpen?: () => void,
  ): AsyncGenerator<RpcRequest<F>> {
    const url = new URL(path, this.resolveBase())
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url)
    const inbox = new SocketInbox<RpcRequest<F>>(this.websocketInboxCapacity)
    let wake: (() => void) | undefined
    let ended = false
    let failure: Error | undefined
    const signalConsumer = (): void => {
      wake?.()
      wake = undefined
    }
    const handleOpen = (): void => { onOpen?.() }
    const hasEnded = (): boolean => ended
    const handleMessage = (event: MessageEvent): void => {
      if (failure !== undefined) return
      let full: ServerRequest
      let frame: F
      try {
        if (typeof event.data !== 'string') throw new Error('binary WebSocket frame')
        full = serverRequestSchema.parse(JSON.parse(event.data))
        frame = frameSchema.parse(full.payload)
      } catch (error) {
        console.error(`[client-connection] dropping malformed WebSocket frame on ${path}:`, error)
        return
      }
      this.onEnvelope(full)
      if (!inbox.push({ rpcId: full.rpcId, payload: frame })) {
        failure = new Error(
          `WebSocket inbox on ${path} exceeded its ${this.websocketInboxCapacity} frame capacity`,
        )
        inbox.clear()
        if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
          socket.close(1013, 'client inbox overflow')
        }
      }
      signalConsumer()
    }
    const handleClose = (): void => { ended = true; signalConsumer() }
    const handleAbort = (): void => {
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close()
    }
    socket.addEventListener('open', handleOpen)
    socket.addEventListener('message', handleMessage)
    socket.addEventListener('close', handleClose, { once: true })
    signal.addEventListener('abort', handleAbort, { once: true })
    if (signal.aborted) handleAbort()
    try {
      while (true) {
        let item = inbox.shift()
        while (item !== undefined) {
          yield item.value
          item = inbox.shift()
        }
        if (failure !== undefined) throw failure
        if (hasEnded()) return
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      signal.removeEventListener('abort', handleAbort)
      socket.removeEventListener('open', handleOpen)
      socket.removeEventListener('message', handleMessage)
      socket.removeEventListener('close', handleClose)
      handleAbort()
    }
  }
}
