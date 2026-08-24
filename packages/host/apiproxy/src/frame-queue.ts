import { randomUUID } from 'node:crypto'
import { isJsonValue, type JsonValue, type Session } from '@deepseek-ai/dsh-session'
import type { JobSnapshot } from '@deepseek-ai/dsh-jobs'
import type { JobView, MuxFrame } from '@deepseek-ai/dsh-api-protocol/api'
import { RpcId, type RpcRequest } from '@deepseek-ai/dsh-api-protocol/api/rpc'

/** Async frame queue whose iterator owns abort and cleanup handling. */
export class FrameQueue<F> {
  private buffer: F[] = []
  private waiter: (() => void) | undefined
  private done = false

  /**
   * Publish one frame unless the queue is closed.
   * @param item - Frame to enqueue.
   */
  push(item: F): void {
    if (this.done) return
    this.buffer.push(item)
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
        while (this.buffer.length > 0) yield this.buffer.shift() as F
        if (this.done || signal.aborted) return
        await new Promise<void>((resolve) => { this.waiter = resolve })
        this.waiter = undefined
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      cleanup()
    }
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
