import type { UiLumiSettings } from '../settings.ts'
import { autoSpeechText, speechText } from './speech-text.ts'

/** Speech playback state exposed to every message action. */
export type SpeechPlaybackState = 'idle' | 'speaking' | 'paused'

/** Immutable speech view consumed by the character snapshot. */
export interface BrowserSpeechSnapshot {
  voices: readonly string[]
  unavailableReason: 'unsupported' | 'no-voices' | undefined
  playback: SpeechPlaybackState
  messageId: string | undefined
  mouthOpen: boolean
}

/** Owns Web Speech resources, playback transitions, and mouth timing. */
export class BrowserSpeechPlayer {
  private voices: readonly string[] = []
  private playback: SpeechPlaybackState = 'idle'
  private messageId: string | undefined
  private mouthOpen = false
  private mouthTimer: number | undefined
  private disposed = false

  /** @param onChange Called after visible playback state changes. */
  constructor(private readonly onChange: () => void) {
    this.voices = Object.freeze(this.readVoices())
    if ('speechSynthesis' in window) window.speechSynthesis.addEventListener('voiceschanged', this.refreshVoices)
  }

  /**
   * Read the current immutable playback view.
   * @returns the current immutable playback view.
   */
  snapshot(): BrowserSpeechSnapshot {
    return Object.freeze({
      voices: this.voices,
      unavailableReason: !('speechSynthesis' in window) ? 'unsupported' : this.voices.length === 0 ? 'no-voices' : undefined,
      playback: this.playback,
      messageId: this.messageId,
      mouthOpen: this.mouthOpen,
    })
  }

  /**
   * Read final text with the current system voice settings.
   * @param source - model-visible message text to normalize for speech.
   * @param automatic - whether automatic-read length limits apply.
   * @param sourceId - message identity shown in playback controls.
   * @param settings - current user speech preferences.
   */
  speak(source: string, automatic: boolean, sourceId: string | undefined, settings: UiLumiSettings): void {
    if (!settings.ttsEnabled || !('speechSynthesis' in window) || this.voices.length === 0) return
    const text = automatic ? autoSpeechText(source, settings.ttsMaxAutoChars) : speechText(source)
    if (text === '') return
    this.cancel(false)
    this.messageId = sourceId
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.rate = settings.ttsRate
    utterance.pitch = settings.ttsPitch
    utterance.volume = settings.ttsVolume
    const candidates = window.speechSynthesis.getVoices()
    const voice = candidates.find(candidate => candidate.name === settings.ttsVoice)
      ?? candidates.find(candidate => candidate.default)
      ?? candidates[0]
    if (voice !== undefined) utterance.voice = voice
    const settle = (): void => {
      if (this.disposed) return
      this.playback = 'idle'
      this.messageId = undefined
      this.closeMouth()
      this.onChange()
    }
    utterance.onstart = () => {
      if (this.disposed) return
      this.playback = 'speaking'
      this.onChange()
    }
    utterance.onboundary = () => {
      if (this.disposed) return
      this.mouthOpen = !this.mouthOpen
      if (this.mouthTimer !== undefined) window.clearTimeout(this.mouthTimer)
      this.mouthTimer = window.setTimeout(() => { this.mouthTimer = undefined; this.closeMouth(); this.onChange() }, 110)
      this.onChange()
    }
    utterance.onend = settle
    utterance.onerror = settle
    window.speechSynthesis.speak(utterance)
  }

  /** Pause the active utterance. */
  pause(): void {
    if (this.playback !== 'speaking' || !('speechSynthesis' in window)) return
    window.speechSynthesis.pause()
    this.playback = 'paused'
    this.closeMouth()
    this.onChange()
  }

  /** Continue a paused utterance. */
  resume(): void {
    if (this.playback !== 'paused' || !('speechSynthesis' in window)) return
    window.speechSynthesis.resume()
    this.playback = 'speaking'
    this.onChange()
  }

  /**
   * Cancel playback and optionally announce the state change.
   * @param notify - whether to announce a visible playback state change.
   */
  cancel(notify = true): void {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel()
    const changed = this.playback !== 'idle' || this.mouthOpen
    this.playback = 'idle'
    this.messageId = undefined
    this.closeMouth()
    if (notify && changed) this.onChange()
  }

  /** Release voice listeners, timers, and playback. */
  dispose(): void {
    this.disposed = true
    if ('speechSynthesis' in window) {
      window.speechSynthesis.removeEventListener('voiceschanged', this.refreshVoices)
      window.speechSynthesis.cancel()
    }
    this.closeMouth()
  }

  private readonly refreshVoices = (): void => {
    const next = this.readVoices()
    if (next.length === this.voices.length && next.every((name, index) => name === this.voices[index])) return
    this.voices = Object.freeze(next)
    this.onChange()
  }

  private readVoices(): string[] {
    return 'speechSynthesis' in window ? window.speechSynthesis.getVoices().map(voice => voice.name) : []
  }

  private closeMouth(): void {
    this.mouthOpen = false
    if (this.mouthTimer !== undefined) window.clearTimeout(this.mouthTimer)
    this.mouthTimer = undefined
  }
}
