/** Browser half: character service, settings row, voice action, and feedback rewards. */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { MessageId } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-general/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-message-feedback/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { LumiCharacterRuntime, SETTINGS_NAMESPACE } from './service.ts'
import { LumiSettingsRow } from './LumiSettingsRow.tsx'
import { LumiVoiceAction } from './LumiVoiceAction.tsx'
import type { LumiCharacterInjected } from './slots.ts'
import { en, zh } from './locales.ts'
import type { LumiCharacterSettings } from '../settings.ts'

export type { LumiCharacterInjected, LumiSettingsRowProps, LumiVoiceActionProps } from './slots.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    lumiCharacter: LumiCharacterRuntime
  }
}

/** Settings transport, registry, locale, and feedback event dependencies. */
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

/** Mount the browser character domain and its two additive UI entries. */
export function apply(ctx: ClientContext): void {
  const scope = ctx.settingsScope.bind<LumiCharacterSettings>({ namespace: SETTINGS_NAMESPACE })
  const character = new LumiCharacterRuntime(scope)
  ctx.provide('lumiCharacter', character)
  ctx.effect(() => () => { character.dispose() }, 'lumi-character: browser runtime')
  ctx.effect(() => ctx.locale.register('lumi.character', { zh, en }), 'lumi-character: dictionaries')

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

  const injected = (): LumiCharacterInjected => ({
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
    id: 'lumi-character',
    order: 30,
    locale: 'lumi.character',
    inject: injected,
  }, LumiSettingsRow))

  ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
    name: 'conversation.chat.assistant-actions',
    id: 'lumi-voice',
    order: 5,
    locale: 'lumi.character',
    inject: injected,
  }, LumiVoiceAction))
}
