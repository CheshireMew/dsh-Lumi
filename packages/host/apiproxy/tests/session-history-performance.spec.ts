import { describe, expect, it, vi } from 'vitest'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { indexToolCallArgs } from '../src/session-history.ts'

describe('tool-call argument indexing', () => {
  it('parses each call once regardless of result count', () => {
    const session = Session.create(SessionId('history-index'))
    for (let index = 0; index < 2_000; index += 1) {
      session.append('tool/call', {
        turn: 1,
        step: 1,
        callId: CallId(`call-${String(index)}`),
        name: 'synthetic',
        arguments: JSON.stringify({ index }),
      })
    }
    const parsed = vi.spyOn(JSON, 'parse')
    try {
      const calls = indexToolCallArgs(session.events)
      expect(calls.size).toBe(2_000)
      expect(calls.get(CallId('call-1999'))).toEqual({ name: 'synthetic', args: { index: 1999 } })
      expect(parsed).toHaveBeenCalledTimes(2_000)
    } finally {
      parsed.mockRestore()
    }
  })

  it('keeps malformed argument JSON presenter-safe', () => {
    const session = Session.create(SessionId('history-index-malformed'))
    session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: CallId('bad-call'),
      name: 'synthetic',
      arguments: '{bad',
    })
    expect(indexToolCallArgs(session.events).get(CallId('bad-call'))).toBeUndefined()
  })
})
