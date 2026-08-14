/** Browser-owned character state, speech, progression, and pack catalog. */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import { createBuiltinManifest } from '../builtin.ts'
import type { AnimePackCatalogView, AnimePackView, CharacterState } from '../pack-contract.ts'
import { CHARACTER_STATES } from '../pack-contract.ts'
import {
  BUILTIN_PACK_ID, DEFAULT_UI_ANIME_SETTINGS, UI_ANIME_SETTINGS_NAMESPACE,
  type AnimeLayoutMode, type AnimeMotionPreference, type UiAnimeSettings,
} from '../settings.ts'

/** Compact conversation facts the shell passes to the domain. */
export interface CharacterConversationObservation {
  sessionId: string | undefined
  baseState: Exclude<CharacterState, 'speaking' | 'success'>
  completedTurns: readonly string[]
  latestAssistant?: { id: string; text: string }
}

/** Speech playback state exposed to every message action. */
export type SpeechPlaybackState = 'idle' | 'speaking' | 'paused'

/** Immutable browser view used by the shell, settings row, and voice actions. */
export interface AnimeCharacterSnapshot {
  settingsStatus: 'loading' | 'ready' | 'unavailable'
  settings: UiAnimeSettings
  packs: readonly AnimePackView[]
  activePack: AnimePackView
  voices: readonly string[]
  ttsUnavailableReason: 'unsupported' | 'no-voices' | undefined
  state: CharacterState
  speech: SpeechPlaybackState
  speechMessageId: string | undefined
  mouthOpen: boolean
  animationsPaused: boolean
  notice: string | undefined
  bondLevel: number
  bondLevelProgress: number
  unlockedExpressions: readonly string[]
  unlockedIdleActions: readonly string[]
  unlockedBubbles: { zh: readonly string[]; en: readonly string[] }
  revision: number
}

/** Original built-in view used before the first catalog response. */
const BUILTIN_MANIFEST = createBuiltinManifest()

const BUILTIN_PACK: AnimePackView = Object.freeze({
  manifest: BUILTIN_MANIFEST,
  publishable: true,
  assets: Object.freeze({
    preview: '/anime/assets/builtin-lumi/preview',
    background: '/anime/assets/builtin-lumi/background',
    body: '/anime/assets/builtin-lumi/body',
    expressions: {
      neutral: '/anime/assets/builtin-lumi/expression%3Aneutral',
      happy: '/anime/assets/builtin-lumi/expression%3Ahappy',
      concerned: '/anime/assets/builtin-lumi/expression%3Aconcerned',
      focused: '/anime/assets/builtin-lumi/expression%3Afocused',
    },
    mouth: {
      closed: '/anime/assets/builtin-lumi/mouth%3Aclosed',
      open: '/anime/assets/builtin-lumi/mouth%3Aopen',
    },
    effects: { sparkle: '/anime/assets/builtin-lumi/effect%3Asparkle' },
  }),
} satisfies AnimePackView)

const TOOL_RELEASE_DELAY_MS = 240
const POINTS_PER_LEVEL = 30
const CHARACTER_STATE_SET = new Set<string>(CHARACTER_STATES)

/** JSON object guard for the browser/Host transport boundary. */
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate one same-origin asset URL. */
function assetUrl(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/anime/assets/')
}

/** Validate one resolved pack view before it enters the browser domain. */
function isAnimePackView(value: unknown): value is AnimePackView {
  if (!record(value) || !record(value['manifest']) || !record(value['assets'])) return false
  const manifest = value['manifest']
  const assets = value['assets']
  if (manifest['schemaVersion'] !== 1
    || typeof manifest['id'] !== 'string'
    || typeof manifest['displayName'] !== 'string'
    || typeof manifest['author'] !== 'string'
    || (manifest['license'] !== undefined && typeof manifest['license'] !== 'string')
    || typeof manifest['version'] !== 'string'
    || !record(manifest['states'])
    || !Array.isArray(manifest['bondUnlocks'])
    || typeof value['publishable'] !== 'boolean'
    || !assetUrl(assets['preview'])
    || !assetUrl(assets['background'])
    || !assetUrl(assets['body'])
    || !record(assets['expressions'])
    || !record(assets['mouth'])
    || !assetUrl(assets['mouth']['closed'])
    || !assetUrl(assets['mouth']['open'])
    || !record(assets['effects'])) return false
  const manifestStates = manifest['states']
  return CHARACTER_STATES.every((state) => {
    const definition = manifestStates[state]
    return record(definition)
      && typeof definition['expression'] === 'string'
      && typeof definition['fallback'] === 'string'
      && CHARACTER_STATE_SET.has(definition['fallback'])
      && record(definition['animation'])
      && typeof definition['animation']['minDurationMs'] === 'number'
  })
    && Object.values(assets['expressions']).every(assetUrl)
    && Object.values(assets['effects']).every(assetUrl)
}

/** Validate the entire pack catalog returned by the local same-origin Host. */
function isAnimePackCatalogView(value: unknown): value is AnimePackCatalogView {
  return record(value)
    && typeof value['revision'] === 'number'
    && Number.isInteger(value['revision'])
    && Array.isArray(value['packs'])
    && value['packs'].every(isAnimePackView)
    && Array.isArray(value['diagnostics'])
    && value['diagnostics'].every(item => record(item) && typeof item['directory'] === 'string' && typeof item['message'] === 'string')
}

/**
 * Resolve the local date used for daily caps and streaks.
 * @param now Date to project in the current system timezone.
 * @returns A local `YYYY-MM-DD` key.
 */
export function localDateKey(now = new Date()): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Whether `candidate` is the calendar day after `previous`, independent of DST. */
function consecutive(previous: string, candidate: string): boolean {
  const parse = (value: string): number | undefined => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
    return match === null ? undefined : Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  }
  const a = parse(previous)
  const b = parse(candidate)
  return a !== undefined && b !== undefined && b - a === 86_400_000
}

/**
 * Remove non-final Markdown structures before speech.
 * @param source Final assistant text.
 * @returns Clean prose without code, URLs, tables, or Markdown structure.
 */
export function speechText(source: string): string {
  return source
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/`[^`]*`/gu, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/https?:\/\/\S+/gu, ' ')
    .replace(/^\s*\|.*\|\s*$/gmu, ' ')
    .replace(/^\s*[-:| ]{3,}\s*$/gmu, ' ')
    .replace(/^[#>*+-]+\s*/gmu, '')
    .replace(/[*_~]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * Truncate automatic speech at a natural sentence boundary when possible.
 * @param source Final assistant text.
 * @param maxChars Maximum cleaned characters considered for automatic speech.
 * @returns Clean automatic-speech text within the configured bound.
 */
export function autoSpeechText(source: string, maxChars: number): string {
  const clean = speechText(source)
  if (clean.length <= maxChars) return clean
  const prefix = clean.slice(0, maxChars + 1)
  const minimum = Math.floor(maxChars * 0.55)
  let boundary = -1
  for (const match of prefix.matchAll(/[。！？.!?]/gu)) {
    if (match.index >= minimum) boundary = match.index + 1
  }
  return clean.slice(0, boundary > 0 ? boundary : maxChars).trim()
}

/**
 * Determine the unbounded level from accumulated points.
 * @param points Accumulated local bond points.
 * @returns A one-based bond level.
 */
export function bondLevel(points: number): number {
  return Math.floor(Math.max(0, points) / POINTS_PER_LEVEL) + 1
}

/** Preference fields writable through the Anime domain. */
export type AnimePreferenceField =
  | 'layoutMode' | 'characterVisible' | 'selectedPack' | 'motionPreference'
  | 'panelOpacity' | 'backgroundBlur' | 'ttsEnabled' | 'ttsAutoRead'
  | 'ttsVoice' | 'ttsRate' | 'ttsPitch' | 'ttsVolume' | 'ttsMaxAutoChars'

/** Domain object backing every anime surface in one browser runtime. */
export class AnimeCharacterRuntime implements HostObservable<AnimeCharacterSnapshot> {
  private readonly listeners = new Set<() => void>()
  private settings = DEFAULT_UI_ANIME_SETTINGS
  private settingsStatus: AnimeCharacterSnapshot['settingsStatus'] = 'loading'
  private packs: readonly AnimePackView[] = [BUILTIN_PACK]
  private voices: readonly string[] = []
  private baseState: CharacterConversationObservation['baseState'] = 'idle'
  private speech: SpeechPlaybackState = 'idle'
  private speechMessageId: string | undefined
  private mouthOpen = false
  private success = false
  private hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
  private notice: string | undefined
  private revision = 0
  private snapshot = this.buildSnapshot()
  private activeSessionId: string | undefined
  private readonly seenTurns = new Set<string>()
  private readonly seenMessages = new Set<string>()
  private successTimer: number | undefined
  private toolReleaseTimer: number | undefined
  private deferredBaseState: CharacterConversationObservation['baseState'] | undefined
  private mouthTimer: number | undefined
  private eventSource: EventSource | undefined
  private disposed = false
  private readonly unsubscribeSettings: () => void

  /** @param settingsScope - durable Host-backed `ui-anime` preference namespace. */
  constructor(private readonly settingsScope: SettingsScope<UiAnimeSettings>) {
    this.unsubscribeSettings = this.settingsScope.subscribe(() => { this.acceptSettings() })
    this.acceptSettings()
    this.refreshVoices()
    if ('speechSynthesis' in window) window.speechSynthesis.addEventListener('voiceschanged', this.refreshVoices)
    document.addEventListener('visibilitychange', this.handleVisibility)
    void this.refreshPacks()
    if ('EventSource' in window) {
      this.eventSource = new EventSource('/anime/packs/events')
      this.eventSource.onmessage = () => { void this.refreshPacks() }
    }
  }

  /** Current immutable snapshot. */
  getSnapshot = (): AnimeCharacterSnapshot => this.snapshot
  /** Subscribe to snapshot replacement. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Apply current conversation facts, crediting only post-observation completions.
   * @param observation Current visible-session facts.
   */
  observeConversation(observation: CharacterConversationObservation): void {
    const changedSession = observation.sessionId !== this.activeSessionId
    if (changedSession) {
      this.activeSessionId = observation.sessionId
      this.clearSuccess()
      this.clearToolRelease()
      this.stopSpeaking()
      for (const turn of observation.completedTurns) if (observation.sessionId !== undefined) this.seenTurns.add(`${observation.sessionId}:${turn}`)
      if (observation.latestAssistant !== undefined && observation.sessionId !== undefined) {
        this.seenMessages.add(`${observation.sessionId}:${observation.latestAssistant.id}`)
      }
      this.baseState = observation.baseState
      this.publish()
      return
    }

    this.applyBaseState(observation.baseState)
    const sessionId = observation.sessionId
    if (sessionId === undefined) return
    let completed = false
    for (const localKey of observation.completedTurns) {
      const key = `${sessionId}:${localKey}`
      if (this.seenTurns.has(key)) continue
      this.seenTurns.add(key)
      this.creditTurn(key)
      completed = true
    }
    const message = observation.latestAssistant
    if (message !== undefined) {
      const key = `${sessionId}:${message.id}`
      const fresh = !this.seenMessages.has(key)
      this.seenMessages.add(key)
      if (fresh && this.settings.ttsEnabled && this.settings.ttsAutoRead) this.speak(message.text, true, message.id)
    }
    if (completed && this.baseState !== 'waiting' && this.baseState !== 'error') this.pulseSuccess()
    else this.publish()
  }

  /**
   * Read one finalized assistant message; automatic reads honor the configured bound.
   * @param source Final assistant text.
   * @param automatic Whether to apply the automatic-reading length bound.
   * @param sourceId Optional message identity exposed through the playback snapshot.
   */
  speak(source: string, automatic = false, sourceId?: string): void {
    if (!this.settings.ttsEnabled || !('speechSynthesis' in window) || this.voices.length === 0) return
    const text = automatic ? autoSpeechText(source, this.settings.ttsMaxAutoChars) : speechText(source)
    if (text === '') return
    this.cancelSpeech(false)
    this.speechMessageId = sourceId
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.rate = this.settings.ttsRate
    utterance.pitch = this.settings.ttsPitch
    utterance.volume = this.settings.ttsVolume
    const voice = window.speechSynthesis.getVoices().find(candidate => candidate.name === this.settings.ttsVoice)
      ?? window.speechSynthesis.getVoices().find(candidate => candidate.default)
      ?? window.speechSynthesis.getVoices()[0]
    if (voice !== undefined) utterance.voice = voice
    const settle = (): void => {
      if (this.disposed) return
      this.speech = 'idle'
      this.speechMessageId = undefined
      this.closeMouth()
      this.publish()
    }
    utterance.onstart = () => {
      if (this.disposed) return
      this.speech = 'speaking'
      this.publish()
    }
    utterance.onboundary = () => {
      if (this.disposed) return
      this.mouthOpen = !this.mouthOpen
      if (this.mouthTimer !== undefined) window.clearTimeout(this.mouthTimer)
      this.mouthTimer = window.setTimeout(() => { this.mouthTimer = undefined; this.closeMouth(); this.publish() }, 110)
      this.publish()
    }
    utterance.onend = settle
    utterance.onerror = settle
    window.speechSynthesis.speak(utterance)
  }

  /** Pause the active utterance. */
  pauseSpeaking(): void {
    if (this.speech !== 'speaking' || !('speechSynthesis' in window)) return
    window.speechSynthesis.pause()
    this.speech = 'paused'
    this.closeMouth()
    this.publish()
  }

  /** Continue a paused utterance. */
  resumeSpeaking(): void {
    if (this.speech !== 'paused' || !('speechSynthesis' in window)) return
    window.speechSynthesis.resume()
    this.speech = 'speaking'
    this.publish()
  }

  /** Stop the active utterance. */
  stopSpeaking(): void { this.cancelSpeech(true) }

  /**
   * Record the first accepted positive rating per message and per day.
   * @param messageId Stable session and message identity.
   */
  creditPositiveFeedback(messageId: string): void {
    if (this.settings.bondCreditedFeedback.includes(messageId)) return
    const today = localDateKey()
    const awarded = this.settings.bondPositiveAwardDay === today
    this.updateBond({
      bondCreditedFeedback: [...this.settings.bondCreditedFeedback, messageId],
      bondPositiveAwardDay: awarded ? this.settings.bondPositiveAwardDay : today,
      bondPositiveAwardedToday: true,
      bondPoints: this.settings.bondPoints + (awarded ? 0 : 5),
    })
  }

  /**
   * Persist one validated scalar preference through the owning settings namespace.
   * @param field Preference field to update.
   * @param value Candidate value validated by the field-specific rules.
   */
  setPreference(field: AnimePreferenceField, value: unknown): void {
    let accepted = false
    switch (field) {
      case 'layoutMode':
        accepted = value === 'scene' || value === 'work'
        break
      case 'motionPreference':
        accepted = value === 'system' || value === 'full' || value === 'reduced'
        break
      case 'characterVisible':
      case 'ttsEnabled':
      case 'ttsAutoRead':
        accepted = typeof value === 'boolean'
        break
      case 'selectedPack':
        accepted = typeof value === 'string' && this.packs.some(pack => pack.manifest.id === value)
        break
      case 'ttsVoice':
        accepted = typeof value === 'string' && (value === '' || this.voices.includes(value))
        break
      case 'panelOpacity':
        accepted = typeof value === 'number' && Number.isFinite(value) && value >= 0.65 && value <= 1
        break
      case 'backgroundBlur':
        accepted = typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 48
        break
      case 'ttsRate':
      case 'ttsPitch':
        accepted = typeof value === 'number' && Number.isFinite(value) && value >= 0.5 && value <= 2
        break
      case 'ttsVolume':
        accepted = typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
        break
      case 'ttsMaxAutoChars':
        accepted = typeof value === 'number' && Number.isSafeInteger(value) && value >= 80 && value <= 20_000
        break
    }
    if (!accepted) return
    this.settings = { ...this.settings, [field]: value }
    if (field === 'ttsEnabled' && value === false) this.cancelSpeech(false)
    this.publish()
    void this.settingsScope.set(field, value)
  }

  /** Re-read local character packs and surface fallback diagnostics non-blockingly. */
  async refreshPacks(): Promise<void> {
    try {
      const response = await fetch('/anime/packs', { cache: 'no-store' })
      if (!response.ok) return
      const data: unknown = await response.json()
      if (!isAnimePackCatalogView(data) || data.packs.length === 0) return
      this.packs = Object.freeze([...data.packs])
      const selectedMissing = !this.packs.some(pack => pack.manifest.id === this.settings.selectedPack)
      if (selectedMissing) {
        this.settings = { ...this.settings, selectedPack: BUILTIN_PACK_ID }
        void this.settingsScope.set('selectedPack', BUILTIN_PACK_ID)
      }
      const firstDiagnostic = data.diagnostics[0]
      this.notice = selectedMissing
        ? '所选角色包缺失或损坏，已回退到内置角色。'
        : firstDiagnostic === undefined ? undefined : `${firstDiagnostic.directory}: ${firstDiagnostic.message}`
      this.publish()
    } catch {
      // The built-in pack remains usable while Host startup or reconnect settles.
    }
  }

  /** Release browser resources and subscribers. */
  dispose(): void {
    this.disposed = true
    this.unsubscribeSettings()
    this.clearSuccess()
    this.clearToolRelease()
    if (this.mouthTimer !== undefined) window.clearTimeout(this.mouthTimer)
    this.eventSource?.close()
    document.removeEventListener('visibilitychange', this.handleVisibility)
    if ('speechSynthesis' in window) {
      window.speechSynthesis.removeEventListener('voiceschanged', this.refreshVoices)
      window.speechSynthesis.cancel()
    }
    this.listeners.clear()
  }

  private readonly refreshVoices = (): void => {
    if (!('speechSynthesis' in window)) return
    const next = window.speechSynthesis.getVoices().map(voice => voice.name)
    if (next.length === this.voices.length && next.every((name, index) => name === this.voices[index])) return
    this.voices = Object.freeze(next)
    this.publish()
  }

  private readonly handleVisibility = (): void => {
    this.hidden = document.visibilityState === 'hidden'
    if (this.hidden) this.cancelSpeech(false)
    this.publish()
  }

  private acceptSettings(): void {
    const snapshot = this.settingsScope.getSnapshot()
    this.settingsStatus = snapshot.status
    if (snapshot.value !== undefined) {
      const positiveToday = snapshot.value.bondPositiveAwardDay === localDateKey()
      this.settings = snapshot.value.bondPositiveAwardedToday === positiveToday
        ? snapshot.value
        : { ...snapshot.value, bondPositiveAwardedToday: positiveToday }
      if (snapshot.value.bondPositiveAwardedToday !== positiveToday) {
        void this.settingsScope.set('bondPositiveAwardedToday', positiveToday)
      }
    }
    this.publish()
  }

  private applyBaseState(next: CharacterConversationObservation['baseState']): void {
    if (next === 'waiting' || next === 'error' || next === 'tool' || this.baseState !== 'tool') {
      this.clearToolRelease()
      this.baseState = next
      return
    }
    this.deferredBaseState = next
    if (this.toolReleaseTimer !== undefined) return
    this.toolReleaseTimer = window.setTimeout(() => {
      this.toolReleaseTimer = undefined
      this.baseState = this.deferredBaseState ?? 'idle'
      this.deferredBaseState = undefined
      this.publish()
    }, TOOL_RELEASE_DELAY_MS)
  }

  private creditTurn(key: string): void {
    if (this.settings.bondCreditedTurns.includes(key)) return
    const today = localDateKey()
    const count = this.settings.bondDailyTurnDay === today ? this.settings.bondDailyTurnCount : 0
    const firstToday = this.settings.bondFirstSuccessDay !== today
    const streak = firstToday
      ? this.settings.bondLastActiveDay === today
        ? this.settings.bondStreak
        : consecutive(this.settings.bondLastActiveDay, today) ? this.settings.bondStreak + 1 : 1
      : this.settings.bondStreak
    this.updateBond({
      bondPoints: this.settings.bondPoints + (count < 10 ? 2 : 0) + (firstToday ? 3 : 0),
      bondLastActiveDay: firstToday ? today : this.settings.bondLastActiveDay,
      bondStreak: streak,
      bondDailyTurnDay: today,
      bondDailyTurnCount: Math.min(10, count + 1),
      bondFirstSuccessDay: firstToday ? today : this.settings.bondFirstSuccessDay,
      bondPositiveAwardedToday: this.settings.bondPositiveAwardDay === today,
      bondCreditedTurns: [...this.settings.bondCreditedTurns, key],
    })
  }

  private updateBond(fields: Partial<Pick<UiAnimeSettings,
    'bondPoints' | 'bondLastActiveDay' | 'bondStreak' | 'bondDailyTurnDay'
    | 'bondDailyTurnCount' | 'bondFirstSuccessDay' | 'bondPositiveAwardDay'
    | 'bondPositiveAwardedToday' | 'bondCreditedTurns' | 'bondCreditedFeedback'>>): void {
    this.settings = { ...this.settings, ...fields }
    this.publish()
    for (const [field, value] of Object.entries(fields)) void this.settingsScope.set(field, value)
  }

  private pulseSuccess(): void {
    this.success = true
    if (this.successTimer !== undefined) window.clearTimeout(this.successTimer)
    const duration = this.activePack().manifest.states.success.animation.minDurationMs
    this.successTimer = window.setTimeout(() => {
      this.successTimer = undefined
      this.success = false
      this.publish()
    }, duration)
    this.publish()
  }

  private clearSuccess(): void {
    if (this.successTimer !== undefined) window.clearTimeout(this.successTimer)
    this.successTimer = undefined
    this.success = false
  }

  private clearToolRelease(): void {
    if (this.toolReleaseTimer !== undefined) window.clearTimeout(this.toolReleaseTimer)
    this.toolReleaseTimer = undefined
    this.deferredBaseState = undefined
  }

  private cancelSpeech(publish: boolean): void {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel()
    const changed = this.speech !== 'idle' || this.mouthOpen
    this.speech = 'idle'
    this.speechMessageId = undefined
    this.closeMouth()
    if (publish && changed) this.publish()
  }

  private closeMouth(): void {
    this.mouthOpen = false
    if (this.mouthTimer !== undefined) window.clearTimeout(this.mouthTimer)
    this.mouthTimer = undefined
  }

  private resolvedState(): CharacterState {
    if (this.baseState === 'waiting' || this.baseState === 'error') return this.baseState
    if (this.speech !== 'idle') return 'speaking'
    if (this.baseState === 'tool' || this.baseState === 'thinking' || this.baseState === 'listening') return this.baseState
    if (this.success) return 'success'
    return 'idle'
  }

  private activePack(): AnimePackView {
    return this.packs.find(pack => pack.manifest.id === this.settings.selectedPack) ?? BUILTIN_PACK
  }

  private buildSnapshot(): AnimeCharacterSnapshot {
    const level = bondLevel(this.settings.bondPoints)
    const activePack = this.activePack()
    const unlocks = activePack.manifest.bondUnlocks.filter(unlock => unlock.level <= level)
    return Object.freeze({
      settingsStatus: this.settingsStatus,
      settings: this.settings,
      packs: this.packs,
      activePack,
      voices: this.voices,
      ttsUnavailableReason: !('speechSynthesis' in window) ? 'unsupported' : this.voices.length === 0 ? 'no-voices' : undefined,
      state: this.resolvedState(),
      speech: this.speech,
      speechMessageId: this.speechMessageId,
      mouthOpen: this.mouthOpen,
      animationsPaused: this.hidden,
      notice: this.notice,
      bondLevel: level,
      bondLevelProgress: (this.settings.bondPoints % POINTS_PER_LEVEL) / POINTS_PER_LEVEL,
      unlockedExpressions: Object.freeze([...new Set(unlocks.flatMap(unlock => unlock.expressions))]),
      unlockedIdleActions: Object.freeze([...new Set(unlocks.flatMap(unlock => unlock.idleActions))]),
      unlockedBubbles: Object.freeze({
        zh: Object.freeze(unlocks.flatMap(unlock => unlock.bubbles.zh)),
        en: Object.freeze(unlocks.flatMap(unlock => unlock.bubbles.en)),
      }),
      revision: this.revision,
    })
  }

  private publish(): void {
    if (this.disposed) return
    this.revision += 1
    this.snapshot = this.buildSnapshot()
    for (const listener of this.listeners) listener()
  }
}

/** Namespace exported for settings-scope callers and diagnostics. */
export const SETTINGS_NAMESPACE = UI_ANIME_SETTINGS_NAMESPACE

/** Layout-mode values are re-exported for typed UI controls. */
export type { AnimeLayoutMode, AnimeMotionPreference }
