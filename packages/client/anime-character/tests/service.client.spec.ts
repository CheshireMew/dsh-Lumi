// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { DEFAULT_UI_ANIME_SETTINGS } from '../src/settings.ts'
import {
  AnimeCharacterRuntime, autoSpeechText, bondLevel, localDateKey, speechText,
} from '../src/client/service.ts'

class FakeUtterance {
  rate = 1
  pitch = 1
  volume = 1
  voice: SpeechSynthesisVoice | null = null
  onstart: (() => void) | null = null
  onend: (() => void) | null = null
  onerror: (() => void) | null = null
  onboundary: (() => void) | null = null
  constructor(readonly text: string) {}
}

function speechFixture() {
  const voice = { name: 'Fixture voice', default: true } as SpeechSynthesisVoice
  const synthesis = {
    addEventListener: vi.fn(), removeEventListener: vi.fn(), cancel: vi.fn(), pause: vi.fn(), resume: vi.fn(),
    getVoices: vi.fn(() => [voice]),
    speak: vi.fn((utterance: FakeUtterance) => { utterance.onstart?.() }),
  }
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance)
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synthesis })
  return synthesis
}

describe('AnimeCharacterRuntime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 14, 10))
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('credits new completed turns, caps daily turn awards, and uses pack success timing', () => {
    const host = stubSettingsScope<typeof DEFAULT_UI_ANIME_SETTINGS>()
    host.publish({ status: 'ready', value: DEFAULT_UI_ANIME_SETTINGS })
    const runtime = new AnimeCharacterRuntime(host.scope)
    runtime.observeConversation({ sessionId: 'session-a', baseState: 'idle', completedTurns: ['initial'] })
    expect(runtime.getSnapshot().settings.bondPoints).toBe(0)

    for (let turn = 1; turn <= 12; turn += 1) {
      runtime.observeConversation({ sessionId: 'session-a', baseState: 'idle', completedTurns: [`turn-${turn}`] })
    }
    expect(runtime.getSnapshot().settings).toMatchObject({
      bondPoints: 23,
      bondDailyTurnCount: 10,
      bondFirstSuccessDay: localDateKey(),
      bondStreak: 1,
    })
    expect(runtime.getSnapshot().state).toBe('success')
    expect(host.set).toHaveBeenCalledWith('bondPoints', 23)

    vi.advanceTimersByTime(2199)
    expect(runtime.getSnapshot().state).toBe('success')
    vi.advanceTimersByTime(1)
    expect(runtime.getSnapshot().state).toBe('idle')
    runtime.dispose()
    expect(host.listenerCount()).toBe(0)
  })

  it('releases tool state after a delay and clears success when sessions change', () => {
    const host = stubSettingsScope<typeof DEFAULT_UI_ANIME_SETTINGS>()
    host.publish({ status: 'ready', value: DEFAULT_UI_ANIME_SETTINGS })
    const runtime = new AnimeCharacterRuntime(host.scope)
    runtime.observeConversation({ sessionId: 'a', baseState: 'tool', completedTurns: [] })
    runtime.observeConversation({ sessionId: 'a', baseState: 'idle', completedTurns: [] })
    expect(runtime.getSnapshot().state).toBe('tool')
    vi.advanceTimersByTime(239)
    expect(runtime.getSnapshot().state).toBe('tool')
    vi.advanceTimersByTime(1)
    expect(runtime.getSnapshot().state).toBe('idle')
    runtime.observeConversation({ sessionId: 'a', baseState: 'idle', completedTurns: ['done'] })
    expect(runtime.getSnapshot().state).toBe('success')
    runtime.observeConversation({ sessionId: 'b', baseState: 'idle', completedTurns: ['history'] })
    expect(runtime.getSnapshot().state).toBe('idle')
    expect(runtime.getSnapshot().settings.bondCreditedTurns).not.toContain('b:history')
    runtime.dispose()
  })

  it('credits feedback once per identity and once per calendar day', () => {
    const host = stubSettingsScope<typeof DEFAULT_UI_ANIME_SETTINGS>()
    host.publish({ status: 'ready', value: DEFAULT_UI_ANIME_SETTINGS })
    const runtime = new AnimeCharacterRuntime(host.scope)
    runtime.creditPositiveFeedback('session-a:message-1')
    runtime.creditPositiveFeedback('session-a:message-1')
    runtime.creditPositiveFeedback('session-a:message-2')
    expect(runtime.getSnapshot().settings).toMatchObject({ bondPoints: 5, bondPositiveAwardedToday: true })
    expect(runtime.getSnapshot().settings.bondCreditedFeedback).toEqual(['session-a:message-1', 'session-a:message-2'])
    vi.setSystemTime(new Date(2026, 7, 15, 10))
    runtime.creditPositiveFeedback('session-a:message-3')
    expect(runtime.getSnapshot().settings.bondPoints).toBe(10)
    runtime.dispose()
  })

  it('increments and resets the natural-day streak without subtracting points', () => {
    const host = stubSettingsScope<typeof DEFAULT_UI_ANIME_SETTINGS>()
    host.publish({ status: 'ready', value: DEFAULT_UI_ANIME_SETTINGS })
    const runtime = new AnimeCharacterRuntime(host.scope)
    runtime.observeConversation({ sessionId: 'a', baseState: 'idle', completedTurns: [] })
    runtime.observeConversation({ sessionId: 'a', baseState: 'idle', completedTurns: ['day-1'] })
    vi.setSystemTime(new Date(2026, 7, 15, 10))
    runtime.observeConversation({ sessionId: 'a', baseState: 'idle', completedTurns: ['day-2'] })
    expect(runtime.getSnapshot().settings).toMatchObject({ bondPoints: 10, bondStreak: 2, bondDailyTurnCount: 1 })
    vi.setSystemTime(new Date(2026, 7, 17, 10))
    runtime.observeConversation({ sessionId: 'a', baseState: 'idle', completedTurns: ['day-4'] })
    expect(runtime.getSnapshot().settings).toMatchObject({ bondPoints: 15, bondStreak: 1, bondDailyTurnCount: 1 })
    runtime.dispose()
  })

  it('does not read history or reconnect observations and cancels speech on session switch', () => {
    const synthesis = speechFixture()
    const host = stubSettingsScope<typeof DEFAULT_UI_ANIME_SETTINGS>()
    host.publish({ status: 'ready', value: { ...DEFAULT_UI_ANIME_SETTINGS, ttsEnabled: true, ttsAutoRead: true } })
    const runtime = new AnimeCharacterRuntime(host.scope)
    runtime.observeConversation({ sessionId: 'a', baseState: 'idle', completedTurns: [], latestAssistant: { id: 'old', text: '历史' } })
    runtime.observeConversation({ sessionId: 'a', baseState: 'idle', completedTurns: [], latestAssistant: { id: 'old', text: '历史' } })
    expect(synthesis.speak).not.toHaveBeenCalled()
    runtime.observeConversation({ sessionId: 'a', baseState: 'idle', completedTurns: [], latestAssistant: { id: 'new', text: '新回复 `code`' } })
    expect(synthesis.speak).toHaveBeenCalledOnce()
    expect((synthesis.speak.mock.calls[0]?.[0] as FakeUtterance).text).toBe('新回复')
    runtime.observeConversation({ sessionId: 'b', baseState: 'idle', completedTurns: [], latestAssistant: { id: 'old-b', text: '另一个历史' } })
    expect(synthesis.cancel).toHaveBeenCalled()
    expect(synthesis.speak).toHaveBeenCalledOnce()
    runtime.dispose()
  })

  it('drives pause, resume, mouth boundaries, completion, and hidden-page cancellation', () => {
    const synthesis = speechFixture()
    const host = stubSettingsScope<typeof DEFAULT_UI_ANIME_SETTINGS>()
    host.publish({ status: 'ready', value: { ...DEFAULT_UI_ANIME_SETTINGS, ttsEnabled: true } })
    const runtime = new AnimeCharacterRuntime(host.scope)
    runtime.speak('可以朗读的最终回复', false, 'message-a')
    const utterance = synthesis.speak.mock.calls[0]?.[0] as FakeUtterance
    expect(runtime.getSnapshot()).toMatchObject({ state: 'speaking', speech: 'speaking', speechMessageId: 'message-a' })

    utterance.onboundary?.()
    expect(runtime.getSnapshot().mouthOpen).toBe(true)
    vi.advanceTimersByTime(110)
    expect(runtime.getSnapshot().mouthOpen).toBe(false)
    runtime.pauseSpeaking()
    expect(synthesis.pause).toHaveBeenCalledOnce()
    expect(runtime.getSnapshot().speech).toBe('paused')
    runtime.resumeSpeaking()
    expect(synthesis.resume).toHaveBeenCalledOnce()
    expect(runtime.getSnapshot().speech).toBe('speaking')
    utterance.onend?.()
    expect(runtime.getSnapshot()).toMatchObject({ state: 'idle', speech: 'idle', speechMessageId: undefined })

    runtime.speak('窗口隐藏时停止', false, 'message-b')
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(synthesis.cancel).toHaveBeenCalled()
    expect(runtime.getSnapshot()).toMatchObject({ speech: 'idle', animationsPaused: true })
    runtime.dispose()
  })

  it('disables speech without voices and converges when the settings scope recovers Host authority', () => {
    const synthesis = speechFixture()
    synthesis.getVoices.mockReturnValue([])
    const host = stubSettingsScope<typeof DEFAULT_UI_ANIME_SETTINGS>()
    host.publish({ status: 'ready', value: DEFAULT_UI_ANIME_SETTINGS, revision: 4 })
    const runtime = new AnimeCharacterRuntime(host.scope)
    expect(runtime.getSnapshot().ttsUnavailableReason).toBe('no-voices')
    runtime.speak('不会进入系统朗读')
    expect(synthesis.speak).not.toHaveBeenCalled()
    runtime.setPreference('layoutMode', 'work')
    expect(runtime.getSnapshot().settings.layoutMode).toBe('work')
    expect(host.set).toHaveBeenCalledWith('layoutMode', 'work')
    host.publish({ status: 'ready', value: DEFAULT_UI_ANIME_SETTINGS, revision: 5 })
    expect(runtime.getSnapshot().settings.layoutMode).toBe('scene')
    runtime.dispose()
  })

  it('resets the compatibility award flag when persisted activity belongs to an earlier day', () => {
    const host = stubSettingsScope<typeof DEFAULT_UI_ANIME_SETTINGS>()
    host.publish({
      status: 'ready',
      value: { ...DEFAULT_UI_ANIME_SETTINGS, bondPositiveAwardDay: '2026-08-13', bondPositiveAwardedToday: true },
    })
    const runtime = new AnimeCharacterRuntime(host.scope)
    expect(runtime.getSnapshot().settings.bondPositiveAwardedToday).toBe(false)
    expect(host.set).toHaveBeenCalledWith('bondPositiveAwardedToday', false)
    runtime.dispose()
  })
})

describe('anime character pure behavior', () => {
  it('strips code, links, Markdown, and table structure before speech', () => {
    expect(speechText('# 你好 **世界**\n| A | B |\n|---|---|\n```ts\nsecret()\n``` [文档](https://example.com) ![图](x.png)'))
      .toBe('你好 世界 文档')
  })

  it('naturally truncates only automatic speech', () => {
    const source = '第一句很短。第二句也完整。第三句会超过限制而不该被读出。'
    expect(autoSpeechText(source, 16)).toBe('第一句很短。第二句也完整。')
    expect(speechText(source)).toBe(source)
  })

  it('uses local dates and leaves bond levels unbounded', () => {
    expect(localDateKey(new Date(2026, 7, 4, 23))).toBe('2026-08-04')
    expect(bondLevel(-10)).toBe(1)
    expect(bondLevel(29)).toBe(1)
    expect(bondLevel(30)).toBe(2)
    expect(bondLevel(9999)).toBe(334)
  })
})
