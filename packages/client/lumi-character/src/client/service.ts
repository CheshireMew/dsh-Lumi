/** Browser-owned character state, speech, progression, and pack catalog. */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import {
  LEGACY_LUMI_BOND_FIELDS, LUMI_BOND_POINTS_PER_LEVEL, bondLevel,
  creditLumiPositiveFeedback, creditLumiTurns, localDateKey, migrateLegacyLumiBond,
  type LumiBondRecord,
} from '../bond.ts'
import type { LumiPackView, CharacterState } from '../pack-contract.ts'
import {
  BUILTIN_PACK_ID, DEFAULT_UI_LUMI_SETTINGS, UI_LUMI_SETTINGS_NAMESPACE,
  type LumiLayoutMode, type LumiMotionPreference, type UiLumiSettings,
} from '../settings.ts'
import { BUILTIN_PACK, isLumiPackCatalogView } from './catalog-client.ts'
import { BrowserSpeechPlayer, type SpeechPlaybackState } from './speech-player.ts'

/** Compact conversation facts the shell passes to the domain. */
export interface CharacterConversationObservation {
  sessionId: string | undefined
  baseState: Exclude<CharacterState, 'speaking' | 'success'>
  completedTurnCount: number
  latestAssistant?: { id: string; text: string }
}

/** Immutable browser view used by the shell, settings row, and voice actions. */
export interface LumiCharacterSnapshot {
  settingsStatus: 'loading' | 'ready' | 'unavailable'
  settings: UiLumiSettings
  packs: readonly LumiPackView[]
  activePack: LumiPackView
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

const TOOL_RELEASE_DELAY_MS = 240
const LEGACY_BOND_MIGRATION_ATTEMPTS = 2

/** Preference fields writable through the Lumi domain. */
export type LumiPreferenceField =
  | 'layoutMode' | 'characterVisible' | 'selectedPack' | 'motionPreference'
  | 'panelOpacity' | 'backgroundBlur' | 'ttsEnabled' | 'ttsAutoRead'
  | 'ttsVoice' | 'ttsRate' | 'ttsPitch' | 'ttsVolume' | 'ttsMaxAutoChars'

/** Domain orchestrator backing every Lumi surface in one browser runtime. */
export class LumiCharacterRuntime implements HostObservable<LumiCharacterSnapshot> {
  private readonly listeners = new Set<() => void>()
  private settings = DEFAULT_UI_LUMI_SETTINGS
  private settingsStatus: LumiCharacterSnapshot['settingsStatus'] = 'loading'
  private packs: readonly LumiPackView[] = [BUILTIN_PACK]
  private baseState: CharacterConversationObservation['baseState'] = 'idle'
  private success = false
  private hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
  private notice: string | undefined
  private revision = 0
  private snapshot: LumiCharacterSnapshot
  private activeSessionId: string | undefined
  private observedCompletedTurnCount = 0
  private lastAssistantId: string | undefined
  private legacyBondMigrationAttempts = 0
  private legacyBondMigrationInFlight = false
  private successTimer: number | undefined
  private toolReleaseTimer: number | undefined
  private deferredBaseState: CharacterConversationObservation['baseState'] | undefined
  private eventSource: EventSource | undefined
  private disposed = false
  private readonly unsubscribeSettings: () => void
  private readonly speechPlayer: BrowserSpeechPlayer

  /** @param settingsScope - durable Host-backed `ui-lumi` preference namespace. */
  constructor(private readonly settingsScope: SettingsScope<UiLumiSettings>) {
    this.speechPlayer = new BrowserSpeechPlayer(() => { this.publish() })
    this.snapshot = this.buildSnapshot()
    this.unsubscribeSettings = this.settingsScope.subscribe(() => { this.acceptSettings() })
    this.acceptSettings()
    document.addEventListener('visibilitychange', this.handleVisibility)
    void this.refreshPacks()
    if ('EventSource' in window) {
      this.eventSource = new EventSource('/lumi/packs/events')
      this.eventSource.onmessage = () => { void this.refreshPacks() }
    }
  }

  /** Current immutable snapshot. */
  getSnapshot = (): LumiCharacterSnapshot => this.snapshot
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
      this.observedCompletedTurnCount = observation.completedTurnCount
      this.lastAssistantId = observation.latestAssistant?.id
      this.baseState = observation.baseState
      this.publish()
      return
    }

    this.applyBaseState(observation.baseState)
    const sessionId = observation.sessionId
    if (sessionId === undefined) return
    const completed = observation.completedTurnCount > this.observedCompletedTurnCount
    const completedCount = completed ? observation.completedTurnCount - this.observedCompletedTurnCount : 0
    this.observedCompletedTurnCount = observation.completedTurnCount
    if (completedCount > 0) this.creditTurns(completedCount)
    const message = observation.latestAssistant
    if (message !== undefined) {
      const fresh = message.id !== this.lastAssistantId
      this.lastAssistantId = message.id
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
    this.speechPlayer.speak(source, automatic, sourceId, this.settings)
  }

  /** Pause the active utterance. */
  pauseSpeaking(): void { this.speechPlayer.pause() }

  /** Continue a paused utterance. */
  resumeSpeaking(): void { this.speechPlayer.resume() }

  /** Stop the active utterance. */
  stopSpeaking(): void { this.speechPlayer.cancel() }

  /**
   * Record the first accepted positive rating per message and per day.
   * @param messageId Stable session and message identity.
   */
  creditPositiveFeedback(messageId: string): void {
    const next = creditLumiPositiveFeedback(this.settings.bond, messageId, localDateKey())
    if (next !== this.settings.bond) this.persistBond(next)
  }

  /**
   * Persist one validated scalar preference through the owning settings namespace.
   * @param field Preference field to update.
   * @param value Candidate value validated by the field-specific rules.
   */
  setPreference(field: LumiPreferenceField, value: unknown): void {
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
        accepted = typeof value === 'string' && (value === '' || this.speechPlayer.snapshot().voices.includes(value))
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
    if (field === 'ttsEnabled' && value === false) this.speechPlayer.cancel(false)
    this.publish()
    void this.settingsScope.set(field, value)
  }

  /** Re-read local character packs and surface fallback diagnostics non-blockingly. */
  async refreshPacks(): Promise<void> {
    try {
      const response = await fetch('/lumi/packs', { cache: 'no-store' })
      if (!response.ok) return
      const data: unknown = await response.json()
      if (!isLumiPackCatalogView(data) || data.packs.length === 0) return
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
    this.eventSource?.close()
    document.removeEventListener('visibilitychange', this.handleVisibility)
    this.speechPlayer.dispose()
    this.listeners.clear()
  }

  private readonly handleVisibility = (): void => {
    this.hidden = document.visibilityState === 'hidden'
    if (this.hidden) this.speechPlayer.cancel(false)
    this.publish()
  }

  private acceptSettings(): void {
    const snapshot = this.settingsScope.getSnapshot()
    this.settingsStatus = snapshot.status
    if (snapshot.value !== undefined) {
      this.settings = snapshot.value
      const migrated = migrateLegacyLumiBond(snapshot.user)
      if (migrated !== undefined) {
        this.settings = { ...this.settings, bond: migrated }
        this.startLegacyBondMigration(migrated)
      }
    }
    this.publish()
  }

  private startLegacyBondMigration(migrated: LumiBondRecord): void {
    if (this.legacyBondMigrationInFlight
      || this.legacyBondMigrationAttempts >= LEGACY_BOND_MIGRATION_ATTEMPTS) return
    this.legacyBondMigrationInFlight = true
    this.legacyBondMigrationAttempts += 1
    const settle = (): void => {
      this.legacyBondMigrationInFlight = false
      if (this.disposed) return
      const retry = migrateLegacyLumiBond(this.settingsScope.getSnapshot().user)
      if (retry === undefined) return
      this.settings = { ...this.settings, bond: retry }
      this.publish()
      this.startLegacyBondMigration(retry)
    }
    void this.settingsScope.mutate([
      { op: 'set', field: 'bond', value: migrated },
      ...LEGACY_LUMI_BOND_FIELDS.map(field => ({ op: 'unset' as const, field })),
    ]).then(settle, settle)
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

  private creditTurns(count: number): void {
    this.persistBond(creditLumiTurns(this.settings.bond, count, localDateKey()))
  }

  private persistBond(bond: LumiBondRecord): void {
    this.settings = { ...this.settings, bond }
    this.publish()
    void this.settingsScope.set('bond', bond)
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

  private resolvedState(): CharacterState {
    const speech = this.speechPlayer.snapshot().playback
    if (this.baseState === 'waiting' || this.baseState === 'error') return this.baseState
    if (speech !== 'idle') return 'speaking'
    if (this.baseState === 'tool' || this.baseState === 'thinking' || this.baseState === 'listening') return this.baseState
    if (this.success) return 'success'
    return 'idle'
  }

  private activePack(): LumiPackView {
    return this.packs.find(pack => pack.manifest.id === this.settings.selectedPack) ?? BUILTIN_PACK
  }

  private buildSnapshot(): LumiCharacterSnapshot {
    const level = bondLevel(this.settings.bond.points)
    const activePack = this.activePack()
    const speech = this.speechPlayer.snapshot()
    const unlocks = activePack.manifest.bondUnlocks.filter(unlock => unlock.level <= level)
    return Object.freeze({
      settingsStatus: this.settingsStatus,
      settings: this.settings,
      packs: this.packs,
      activePack,
      voices: speech.voices,
      ttsUnavailableReason: speech.unavailableReason,
      state: this.resolvedState(),
      speech: speech.playback,
      speechMessageId: speech.messageId,
      mouthOpen: speech.mouthOpen,
      animationsPaused: this.hidden,
      notice: this.notice,
      bondLevel: level,
      bondLevelProgress: (this.settings.bond.points % LUMI_BOND_POINTS_PER_LEVEL) / LUMI_BOND_POINTS_PER_LEVEL,
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
export const SETTINGS_NAMESPACE = UI_LUMI_SETTINGS_NAMESPACE

/** Layout-mode values are re-exported for typed UI controls. */
export type { LumiLayoutMode, LumiMotionPreference }
