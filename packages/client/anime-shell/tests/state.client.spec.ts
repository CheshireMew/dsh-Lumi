import { describe, expect, it } from 'vitest'
import { conversationCharacterState, resolvePackState } from '../src/client/AnimeFrame.tsx'
import { effectiveAnimeLayout } from '../src/client/layout-config.ts'

describe('anime shell character state', () => {
  it('uses the declared user-attention and activity priority', () => {
    expect(conversationCharacterState({ pending: 1, error: true, runningCalls: 1, running: true, engaging: true })).toBe('waiting')
    expect(conversationCharacterState({ pending: 0, error: true, runningCalls: 1, running: true, engaging: true })).toBe('error')
    expect(conversationCharacterState({ pending: 0, error: false, runningCalls: 1, running: true, engaging: true })).toBe('tool')
    expect(conversationCharacterState({ pending: 0, error: false, runningCalls: 0, running: true, engaging: true })).toBe('thinking')
    expect(conversationCharacterState({ pending: 0, error: false, runningCalls: 0, running: false, engaging: true })).toBe('listening')
    expect(conversationCharacterState({ pending: 0, error: false, runningCalls: 0, running: false, engaging: false })).toBe('idle')
  })

  it('forces work layout below 1100px and otherwise preserves the setting', () => {
    expect(effectiveAnimeLayout(1099, 'scene')).toBe('work')
    expect(effectiveAnimeLayout(1100, 'scene')).toBe('scene')
    expect(effectiveAnimeLayout(1440, 'work')).toBe('work')
  })

  it('falls back to idle when a requested pack state is absent', () => {
    const idle = {
      expression: 'neutral', fallback: 'idle' as const,
      animation: { keyframes: [{ at: 0 }, { at: 1 }], loop: 'repeat' as const, minDurationMs: 1000 },
    }
    expect(resolvePackState({ idle }, 'thinking')).toBe(idle)
    expect(resolvePackState({}, 'thinking')).toBeUndefined()
  })
})
