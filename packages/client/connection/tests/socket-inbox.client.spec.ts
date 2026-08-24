import { describe, expect, it, vi } from 'vitest'
import { SocketInbox } from '../src/client/socket-inbox.ts'

describe('SocketInbox', () => {
  it('keeps constant-time FIFO order across ring wrap', () => {
    const inbox = new SocketInbox<number>(4)
    expect(inbox.push(0)).toBe(true)
    expect(inbox.push(1)).toBe(true)
    expect(inbox.shift()?.value).toBe(0)
    expect(inbox.shift()?.value).toBe(1)
    for (const value of [2, 3, 4, 5]) expect(inbox.push(value)).toBe(true)
    expect(inbox.push(6)).toBe(false)
    expect([inbox.shift()?.value, inbox.shift()?.value, inbox.shift()?.value, inbox.shift()?.value])
      .toEqual([2, 3, 4, 5])
    expect(inbox.shift()).toBeUndefined()
  })

  it('drains a large inbox without Array.shift', () => {
    const inbox = new SocketInbox<number>(20_000)
    const shifted = vi.spyOn(Array.prototype, 'shift')
    try {
      for (let value = 0; value < 20_000; value += 1) expect(inbox.push(value)).toBe(true)
      for (let value = 0; value < 20_000; value += 1) expect(inbox.shift()?.value).toBe(value)
      expect(shifted).not.toHaveBeenCalled()
    } finally {
      shifted.mockRestore()
    }
  })
})
