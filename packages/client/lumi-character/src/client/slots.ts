import type {
  HostObservable, InjectFace, PropsLocale, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { LumiCharacterRuntime, LumiCharacterSnapshot, CharacterConversationObservation } from './service.ts'

/** Business face injected into the shell, settings row, and message action. */
export interface LumiCharacterInjected {
  hooks: { character: HostObservable<LumiCharacterSnapshot> }
  observeConversation: (observation: CharacterConversationObservation) => void
  speak: (text: string, sourceId?: string) => void
  pauseSpeaking: () => void
  resumeSpeaking: () => void
  stopSpeaking: () => void
  setPreference: LumiCharacterRuntime['setPreference']
  refreshPacks: () => Promise<void>
}

/** General settings row props. */
export type LumiSettingsRowProps = PropsRuntime<'settings.general.item'>
  & InjectFace<LumiCharacterInjected> & PropsLocale<'lumi.character'>

/** Assistant action props. */
export type LumiVoiceActionProps = PropsRuntime<'conversation.chat.assistant-actions'>
  & InjectFace<LumiCharacterInjected> & PropsLocale<'lumi.character'>
