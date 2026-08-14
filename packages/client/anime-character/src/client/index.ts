/** Browser half: character service, settings row, voice action, and feedback rewards. */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { MessageId } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-general/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-message-feedback/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { AnimeCharacterRuntime, SETTINGS_NAMESPACE } from './service.ts'
import { AnimeSettingsRow } from './AnimeSettingsRow.tsx'
import { AnimeVoiceAction } from './AnimeVoiceAction.tsx'
import type { AnimeCharacterInjected } from './slots.ts'
import { en, zh } from './locales.ts'
import type { AnimeCharacterSettings } from '../settings.ts'

export type { AnimeCharacterInjected, AnimeSettingsRowProps, AnimeVoiceActionProps } from './slots.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    animeCharacter: AnimeCharacterRuntime
  }
}

/** Settings transport, registry, locale, and feedback event dependencies. */
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

/** Mount the browser character domain and its two additive UI entries. */
export function apply(ctx: ClientContext): void {
  const scope = ctx.settingsScope.bind<AnimeCharacterSettings>({ namespace: SETTINGS_NAMESPACE })
  const character = new AnimeCharacterRuntime(scope)
  ctx.provide('animeCharacter', character)
  ctx.effect(() => () => { character.dispose() }, 'anime-character: browser runtime')
  ctx.effect(() => ctx.locale.register('anime.character', { zh, en }), 'anime-character: dictionaries')

  ctx.on('message-feedback/change', (change: {
    sessionId: SessionId
    messageId: MessageId
    before: 'positive' | 'negative' | undefined
    after: 'positive' | 'negative' | undefined
  }) => {
    if (change.after === 'positive' && change.before !== 'positive') {
      character.creditPositiveFeedback(`${String(change.sessionId)}:${String(change.messageId)}`)
    }
  })

  const injected = (): AnimeCharacterInjected => ({
    hooks: { character },
    observeConversation: (observation) => { character.observeConversation(observation) },
    speak: (text, sourceId) => { character.speak(text, false, sourceId) },
    pauseSpeaking: () => { character.pauseSpeaking() },
    resumeSpeaking: () => { character.resumeSpeaking() },
    stopSpeaking: () => { character.stopSpeaking() },
    setPreference: (field, value) => { character.setPreference(field, value) },
    refreshPacks: () => character.refreshPacks(),
  })

  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'anime-character',
    order: 30,
    locale: 'anime.character',
    inject: injected,
  }, AnimeSettingsRow))

  ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
    name: 'conversation.chat.assistant-actions',
    id: 'anime-voice',
    order: 5,
    locale: 'anime.character',
    inject: injected,
  }, AnimeVoiceAction))
}
