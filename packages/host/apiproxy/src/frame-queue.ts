import { randomUUID } from 'node:crypto'
import { isJsonValue, type JsonValue, type Session } from '@deepseek-ai/dsh-session'
import type { JobSnapshot } from '@deepseek-ai/dsh-jobs'
import type { JobView, MuxFrame } from '@deepseek-ai/dsh-api-protocol/api'
import { RpcId, type RpcRequest } from '@deepseek-ai/dsh-api-protocol/api/rpc'

const EMPTY_QUEUE_SLOT = Symbol('empty frame queue slot')

/** Queue overflow reported to the stream carrier so reconnect can rebuild from authoritative state. */
export class FrameQueueOverflowError extends Error {
  constructor(capacity: number) {
    super(`event stream queue exceeded its ${capacity} frame capacity`)
    this.name = 'FrameQueueOverflowError'
  }
}

/** Bounded async frame queue whose iterator owns abort and cleanup handling. */
export class FrameQueue<F> {
  private readonly buffer: Array<F | typeof EMPTY_QUEUE_SLOT>
  private head = 0
  private tail = 0
  private size = 0
  private waiter: (() => void) | undefined
  private done = false
  private failure: Error | undefined

  /** @param capacity - Maximum undelivered frames retained before the stream fails. */
  constructor(private readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError('frame queue capacity must be a positive safe integer')
    }
    this.buffer = new Array<F | typeof EMPTY_QUEUE_SLOT>(capacity).fill(EMPTY_QUEUE_SLOT)
  }

  /**
   * Publish one frame unless the queue is closed.
   * @param item - Frame to enqueue.
   */
  push(item: F): void {
    if (this.done) return
    if (this.size === this.capacity) {
      this.failure = new FrameQueueOverflowError(this.capacity)
      this.done = true
      this.clear()
      this.waiter?.()
      return
    }
    this.buffer[this.tail] = item
    this.tail = (this.tail + 1) % this.capacity
    this.size += 1
    this.waiter?.()
  }

  /** Close the queue and wake its iterator. */
  end(): void {
    this.done = true
    this.waiter?.()
  }

  /**
   * Consume queued frames until abort or explicit close, then run cleanup.
   * @param signal - Consumer lifetime.
   * @param cleanup - Callback invoked after iteration stops.
   * @returns An asynchronous iterator over queued frames.
   */
  async *iterate(signal: AbortSignal, cleanup: () => void): AsyncGenerator<F> {
    const onAbort = (): void => { this.end() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      while (true) {
        while (this.size > 0) yield this.shift()
        if (this.failure !== undefined) throw this.failure
        if (this.done || signal.aborted) return
        await new Promise<void>((resolve) => { this.waiter = resolve })
        this.waiter = undefined
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      cleanup()
    }
  }

  /** Remove one frame in constant time. */
  private shift(): F {
    const item = this.buffer[this.head] as F | typeof EMPTY_QUEUE_SLOT
    /* v8 ignore next -- size is the authoritative occupancy count. */
    if (item === EMPTY_QUEUE_SLOT) throw new Error('frame queue occupancy is inconsistent')
    this.buffer[this.head] = EMPTY_QUEUE_SLOT
    this.head = (this.head + 1) % this.capacity
    this.size -= 1
    return item
  }

  /** Release retained frames after overflow; the reconnect baseline replaces them. */
  private clear(): void {
    this.buffer.fill(EMPTY_QUEUE_SLOT)
    this.head = 0
    this.tail = 0
    this.size = 0
  }
}

/**
 * Mint a transient server frame with a fresh correlation id.
 * @param payload - Frame payload to correlate.
 * @returns The correlated transient request envelope.
 */
export function frame<F>(payload: F): RpcRequest<F> {
  return { rpcId: RpcId(randomUUID()), payload }
}

/**
 * Narrow one allowlisted host event's argument list to lossless JSON values.
 * @param event - forwarded host event name, named in the failure.
 * @param args - the emitter's argument list.
 * @returns the same arguments typed as JSON values.
 */
export function assertJsonArgs(event: string, args: readonly unknown[]): JsonValue[] {
  for (const [index, arg] of args.entries()) {
    if (!isJsonValue(arg)) {
      throw new Error(`forwarded host event "${event}" argument ${index} is not lossless JSON data`)
    }
  }
  return args as JsonValue[]
}

/**
 * Queue the subscription baseline frame.
 * @param queue - Destination event queue.
 * @param session - Session whose current sequence becomes the baseline.
 */
export function subscribeSession(
  queue: FrameQueue<RpcRequest<MuxFrame>>,
  session: Session,
): void {
  queue.push(frame({ type: 'session/subscribed', sessionId: session.id, lastSeq: session.seq - 1 }))
}

/**
 * Project internal job snapshots onto their public wire representation.
 * @param snapshots - Internal job snapshots.
 * @returns Public job views in input order.
 */
export function jobViews(snapshots: readonly JobSnapshot[]): JobView[] {
  return snapshots.map(job => ({
    id: job.id,
    kind: job.kind,
    label: job.label,
    status: job.status,
    ...job.detail === undefined ? {} : { detail: job.detail },
    startedAt: job.startedAt,
    ...job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt },
  }))
}
