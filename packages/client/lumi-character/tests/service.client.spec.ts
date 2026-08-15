// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { DEFAULT_UI_LUMI_SETTINGS } from '../src/settings.ts'
import { LumiCharacterRuntime } from '../src/client/service.ts'
import { autoSpeechText, speechText } from '../src/client/speech-text.ts'
import {
  LUMI_BOND_FEEDBACK_RETENTION, bondLevel, creditLumiPositiveFeedback, creditLumiTurns,
  localDateKey, migrateLegacyLumiBond,
} from '../src/bond.ts'

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

describe('LumiCharacterRuntime', () => {
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
    const host = stubSettingsScope<typeof DEFAULT_UI_LUMI_SETTINGS>()
    host.publish({ status: 'ready', value: DEFAULT_UI_LUMI_SETTINGS })
    const runtime = new LumiCharacterRuntime(host.scope)
    runtime.observeConversation({ sessionId: 'session-a', baseState: 'idle', completedTurnCount: 1 })
    expect(runtime.getSnapshot().settings.bond.points).toBe(0)

    for (let turn = 1; turn <= 12; turn += 1) {
      runtime.observeConversation({ sessionId: 'session-a', baseState: 'idle', completedTurnCount: turn + 1 })
    }
    expect(runtime.getSnapshot().settings.bond).toMatchObject({
      points: 23,
      dailyTurnCount: 10,
      firstSuccessDay: localDateKey(),
      streak: 1,
    })
    expect(runtime.getSnapshot().state).toBe('success')
    expect(host.set).toHaveBeenLastCalledWith('bond', runtime.getSnapshot().settings.bond)

    vi.advanceTimersByTime(2199)
    expect(runtime.getSnapshot().state).toBe('success')
    vi.advanceTimersByTime(1)
    expect(runtime.getSnapshot().state).toBe('idle')
    runtime.dispose()
    expect(host.listenerCount()).toBe(0)
  })

  it('releases tool state after a delay and clears success when sessions change', () => {
    const host = stubSettingsScope<typeof DEFAULT_UI_LUMI_SETTINGS>()
    host.publish({ status: 'ready', value: DEFAULT_UI_LUMI_SETTINGS })
    const runtime = new LumiCharacterRuntime(host.scope)
    runtime.observeConversation({ sessionId: 'a', baseState: 'tool', completedTurnCount: 0 })
    runtime.observeConversation({ sessionId: 'a', baseState: 'idle', completedTurnCount: 0 })
    expect(runtime.getSnapshot().state).toBe('tool')
    vi.advanceTimersByTime(239)
    expect(runtime.getSnapshot().state).toBe('tool')
    vi.advanceTimersByTime(1)
    expect(runtime.getSnapshot().state).toBe('idle')
    runtime.observeConversation({ sessionId: 'a', baseState: 'idle', completedTurnCount: 1 })
    expect(runtime.getSnapshot().state).toBe('success')
    runtime.observeConversation({ sessionId: 'b', baseState: 'idle', completedTurnCount: 1 })
    expect(runtime.getSnapshot().state).toBe('idle')
    expect(runtime.getSnapshot().settings.bond.points).toBe(5)
    runtime.dispose()
  })

  it('credits feedback once per identity and once per calendar day', () => {
    const host = stubSettingsScope<typeof DEFAULT_UI_LUMI_SETTINGS>()
    host.publish({ status: 'ready', value: DEFAULT_UI_LUMI_SETTINGS })
    const runtime = new LumiCharacterRuntime(host.scope)
    runtime.creditPositiveFeedback('session-a:message-1')
    runtime.creditPositiveFeedback('session-a:message-1')
    runtime.creditPositiveFeedback('session-a:message-2')
    expect(runtime.getSnapshot().settings.bond).toMatchObject({ points: 5, positiveAwardDay: '2026-08-14' })
    expect(runtime.getSnapshot().settings.bond.creditedPositiveFeedback).toEqual(['session-a:message-1', 'session-a:message-2'])
    vi.setSystemTime(new Date(2026, 7, 15, 10))
    runtime.creditPositiveFeedback('session-a:message-3')
    expect(runtime.getSnapshot().settings.bond.points).toBe(10)
    runtime.dispose()
  })

  it('increments and resets the natural-day streak without subtracting points', () => {
    const host = stubSettingsScope<typeof DEFAULT_UI_LUMI_SETTINGS>()
    host.publish({ status: 'ready', value: DEFAULT_UI_LUMI_SETTINGS })
    const runtime = new LumiCharacterRuntime(host.scope)
    runtime.observeConversation({ sessionId: 'a', baseState: 'idle', completedTurnCount: 0 })
    runtime.observeConversation({ sessionId: 'a', baseState: 'idle', completedTurnCount: 1 })
    vi.setSystemTime(new Date(2026, 7, 15, 10))
    runtime.observeConversation({ sessionId: 'a', baseState: 'idle', completedTurnCount: 2 })
    expect(runtime.getSnapshot().settings.bond).toMatchObject({ points: 10, streak: 2, dailyTurnCount: 1 })
    vi.setSystemTime(new Date(2026, 7, 17, 10))
    runtime.observeConversation({ sessionId: 'a', baseState: 'idle', completedTurnCount: 3 })
    expect(runtime.getSnapshot().settings.bond).toMatchObject({ points: 15, streak: 1, dailyTurnCount: 1 })
    runtime.dispose()
  })

  it('does not read history or reconnect observations and cancels speech on session switch', () => {
    const synthesis = speechFixture()
    const host = stubSettingsScope<typeof DEFAULT_UI_LUMI_SETTINGS>()
    host.publish({ status: 'ready', value: { ...DEFAULT_UI_LUMI_SETTINGS, ttsEnabled: true, ttsAutoRead: true } })
    const runtime = new LumiCharacterRuntime(host.scope)
    runtime.observeConversation({ sessionId: 'a', baseState: 'idle', completedTurnCount: 0, latestAssistant: { id: 'old', text: '历史' } })
    runtime.observeConversation({ sessionId: 'a', baseState: 'idle', completedTurnCount: 0, latestAssistant: { id: 'old', text: '历史' } })
    expect(synthesis.speak).not.toHaveBeenCalled()
    runtime.observeConversation({ sessionId: 'a', baseState: 'idle', completedTurnCount: 0, latestAssistant: { id: 'new', text: '新回复 `code`' } })
    expect(synthesis.speak).toHaveBeenCalledOnce()
    expect((synthesis.speak.mock.calls[0]?.[0] as FakeUtterance).text).toBe('新回复')
    runtime.observeConversation({ sessionId: 'b', baseState: 'idle', completedTurnCount: 0, latestAssistant: { id: 'old-b', text: '另一个历史' } })
    expect(synthesis.cancel).toHaveBeenCalled()
    expect(synthesis.speak).toHaveBeenCalledOnce()
    runtime.dispose()
  })

  it('drives pause, resume, mouth boundaries, completion, and hidden-page cancellation', () => {
    const synthesis = speechFixture()
    const host = stubSettingsScope<typeof DEFAULT_UI_LUMI_SETTINGS>()
    host.publish({ status: 'ready', value: { ...DEFAULT_UI_LUMI_SETTINGS, ttsEnabled: true } })
    const runtime = new LumiCharacterRuntime(host.scope)
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
    const host = stubSettingsScope<typeof DEFAULT_UI_LUMI_SETTINGS>()
    host.publish({ status: 'ready', value: DEFAULT_UI_LUMI_SETTINGS, revision: 4 })
    const runtime = new LumiCharacterRuntime(host.scope)
    expect(runtime.getSnapshot().ttsUnavailableReason).toBe('no-voices')
    runtime.speak('不会进入系统朗读')
    expect(synthesis.speak).not.toHaveBeenCalled()
    runtime.setPreference('layoutMode', 'work')
    expect(runtime.getSnapshot().settings.layoutMode).toBe('work')
    expect(host.set).toHaveBeenCalledWith('layoutMode', 'work')
    host.publish({ status: 'ready', value: DEFAULT_UI_LUMI_SETTINGS, revision: 5 })
    expect(runtime.getSnapshot().settings.layoutMode).toBe('scene')
    runtime.dispose()
  })

  it('atomically migrates and removes the legacy top-level bond fields', async () => {
    const host = stubSettingsScope<typeof DEFAULT_UI_LUMI_SETTINGS>()
    const migratedBond = {
      ...DEFAULT_UI_LUMI_SETTINGS.bond,
      points: 17,
      streak: 3,
      dailyTurnCount: 10,
      creditedPositiveFeedback: ['a', 'b'],
    }
    host.publish({
      status: 'ready',
      value: DEFAULT_UI_LUMI_SETTINGS,
      user: {
        bondPoints: 17,
        bondStreak: 3,
        bondDailyTurnCount: 99,
        bondCreditedFeedback: ['a', 'a', 'b'],
      },
    })
    const runtime = new LumiCharacterRuntime(host.scope)
    host.publish({
      status: 'ready',
      value: { ...DEFAULT_UI_LUMI_SETTINGS, bond: migratedBond },
      user: { bond: migratedBond },
      revision: 2,
    })
    await Promise.resolve()
    expect(runtime.getSnapshot().settings.bond).toMatchObject({
      points: 17,
      streak: 3,
      dailyTurnCount: 10,
      creditedPositiveFeedback: ['a', 'b'],
    })
    expect(host.mutate).toHaveBeenCalledOnce()
    expect(host.mutate.mock.calls[0]?.[0]).toEqual(expect.arrayContaining([
      { op: 'set', field: 'bond', value: runtime.getSnapshot().settings.bond },
      { op: 'unset', field: 'bondPoints' },
      { op: 'unset', field: 'bondCreditedTurns' },
    ]))
    runtime.dispose()
  })

  it('retries one rejected legacy migration with the recovered Host snapshot', async () => {
    const host = stubSettingsScope<typeof DEFAULT_UI_LUMI_SETTINGS>()
    const legacy = { bondPoints: 17, bondStreak: 3 }
    const migratedBond = { ...DEFAULT_UI_LUMI_SETTINGS.bond, points: 17, streak: 3 }
    let rejectFirst!: (error: Error) => void
    const first = new Promise<void>((_resolve, reject) => { rejectFirst = reject })
    host.mutate.mockReturnValueOnce(first)
    host.publish({ status: 'ready', value: DEFAULT_UI_LUMI_SETTINGS, user: legacy, revision: 1 })

    const runtime = new LumiCharacterRuntime(host.scope)
    host.publish({ status: 'ready', value: DEFAULT_UI_LUMI_SETTINGS, user: legacy, revision: 2 })
    rejectFirst(new Error('transient settings conflict'))

    await vi.waitFor(() => { expect(host.mutate).toHaveBeenCalledTimes(2) })
    host.publish({
      value: { ...DEFAULT_UI_LUMI_SETTINGS, bond: migratedBond },
      user: { bond: migratedBond },
      revision: 3,
    })
    expect(runtime.getSnapshot().settings.bond).toMatchObject({ points: 17, streak: 3 })
    runtime.dispose()
  })

  it('bounds refused legacy migration attempts while retaining the migrated view', async () => {
    const host = stubSettingsScope<typeof DEFAULT_UI_LUMI_SETTINGS>()
    host.publish({
      status: 'ready', value: DEFAULT_UI_LUMI_SETTINGS,
      user: { bondPoints: 23, bondStreak: 4 }, revision: 1,
    })

    const runtime = new LumiCharacterRuntime(host.scope)

    await vi.waitFor(() => { expect(host.mutate).toHaveBeenCalledTimes(2) })
    await Promise.resolve()
    expect(host.mutate).toHaveBeenCalledTimes(2)
    expect(runtime.getSnapshot().settings.bond).toMatchObject({ points: 23, streak: 4 })
    runtime.dispose()
  })

  it('does not retry a legacy migration after the runtime is disposed', async () => {
    const host = stubSettingsScope<typeof DEFAULT_UI_LUMI_SETTINGS>()
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    host.mutate.mockReturnValueOnce(pending)
    host.publish({
      status: 'ready', value: DEFAULT_UI_LUMI_SETTINGS,
      user: { bondPoints: 9 }, revision: 1,
    })
    const runtime = new LumiCharacterRuntime(host.scope)
    runtime.dispose()

    release()
    await pending
    await Promise.resolve()

    expect(host.mutate).toHaveBeenCalledOnce()
  })
})

describe('lumi character pure behavior', () => {
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

  it('bounds retained feedback identities while preserving the daily award', () => {
    let bond = DEFAULT_UI_LUMI_SETTINGS.bond
    for (let index = 0; index <= LUMI_BOND_FEEDBACK_RETENTION; index += 1) {
      bond = creditLumiPositiveFeedback(bond, `message-${index}`, '2026-08-14')
    }
    expect(bond.points).toBe(5)
    expect(bond.creditedPositiveFeedback).toHaveLength(LUMI_BOND_FEEDBACK_RETENTION)
    expect(bond.creditedPositiveFeedback[0]).toBe('message-1')
  })

  it('normalizes every legacy bond field and rejects non-legacy layers', () => {
    expect(migrateLegacyLumiBond(null)).toBeUndefined()
    expect(migrateLegacyLumiBond({})).toBeUndefined()
    expect(migrateLegacyLumiBond({ bond: DEFAULT_UI_LUMI_SETTINGS.bond, bondPoints: 9 })).toBeUndefined()
    expect(migrateLegacyLumiBond({
      bondPoints: -1,
      bondLastActiveDay: '2026-08-14',
      bondStreak: 1.5,
      bondDailyTurnDay: '2026-08-14',
      bondDailyTurnCount: 2,
      bondFirstSuccessDay: '2026-08-14',
      bondPositiveAwardDay: '2026-08-14',
      bondCreditedFeedback: ['kept', '', 1, 'kept'],
    })).toMatchObject({
      points: 0,
      lastActiveDay: '2026-08-14',
      streak: 0,
      dailyTurnDay: '2026-08-14',
      dailyTurnCount: 2,
      firstSuccessDay: '2026-08-14',
      positiveAwardDay: '2026-08-14',
      creditedPositiveFeedback: ['kept'],
    })
  })

  it('ignores invalid turn counts and preserves a same-day streak', () => {
    const current = {
      ...DEFAULT_UI_LUMI_SETTINGS.bond,
      lastActiveDay: '2026-08-14',
      streak: 4,
      firstSuccessDay: '2026-08-13',
    }
    expect(creditLumiTurns(current, 0, '2026-08-14')).toBe(current)
    expect(creditLumiTurns(current, 1.5, '2026-08-14')).toBe(current)
    expect(creditLumiTurns(current, 1, '2026-08-14')).toMatchObject({ streak: 4, firstSuccessDay: '2026-08-14' })
  })
})
