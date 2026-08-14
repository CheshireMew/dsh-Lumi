import type {
  HostObservable, InjectFace, PropsLocale, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { AnimeCharacterRuntime, AnimeCharacterSnapshot, CharacterConversationObservation } from './service.ts'

/** Business face injected into the shell, settings row, and message action. */
export interface AnimeCharacterInjected {
  hooks: { character: HostObservable<AnimeCharacterSnapshot> }
  observeConversation: (observation: CharacterConversationObservation) => void
  speak: (text: string, sourceId?: string) => void
  pauseSpeaking: () => void
  resumeSpeaking: () => void
  stopSpeaking: () => void
  setPreference: AnimeCharacterRuntime['setPreference']
  refreshPacks: () => Promise<void>
}

/** General settings row props. */
export type AnimeSettingsRowProps = PropsRuntime<'settings.general.item'>
  & InjectFace<AnimeCharacterInjected> & PropsLocale<'anime.character'>

/** Assistant action props. */
export type AnimeVoiceActionProps = PropsRuntime<'conversation.chat.assistant-actions'>
  & InjectFace<AnimeCharacterInjected> & PropsLocale<'anime.character'>
