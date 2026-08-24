import { describe, expect, it, vi } from 'vitest'
import { FrameQueue, FrameQueueOverflowError } from '../src/frame-queue.ts'

describe('FrameQueue', () => {
  it('drains a large wrapped FIFO without Array.shift', async () => {
    const queue = new FrameQueue<number>(20_000)
    const shifted = vi.spyOn(Array.prototype, 'shift')
    try {
      for (let value = 0; value < 20_000; value += 1) queue.push(value)
      queue.end()
      const values: number[] = []
      for await (const value of queue.iterate(new AbortController().signal, () => {})) values.push(value)
      expect(values).toHaveLength(20_000)
      expect(values[0]).toBe(0)
      expect(values.at(-1)).toBe(19_999)
      expect(shifted).not.toHaveBeenCalled()
    } finally {
      shifted.mockRestore()
    }
  })

  it('fails the carrier and releases retained frames when capacity is exceeded', async () => {
    const cleanup = vi.fn()
    const queue = new FrameQueue<number>(2)
    queue.push(1)
    queue.push(2)
    queue.push(3)
    const iterator = queue.iterate(new AbortController().signal, cleanup)[Symbol.asyncIterator]()

    await expect(iterator.next()).rejects.toBeInstanceOf(FrameQueueOverflowError)
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('validates the deployment capacity', () => {
    expect(() => new FrameQueue(0)).toThrow(RangeError)
    expect(() => new FrameQueue(1.5)).toThrow(RangeError)
  })
})
