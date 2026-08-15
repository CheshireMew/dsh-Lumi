/** Browser plugin registering the product frame below the official priority-0 fallback. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@dsh-lumi/client-character/client'
import { LumiFrame } from './LumiFrame.tsx'
import type { LumiCharacterInjected } from '@dsh-lumi/client-character/client'
import { en, zh } from './locales.ts'

export type { LumiFrameProps } from './LumiFrame.tsx'
export type { DshDesktopApi, DesktopWindowState } from './desktop-api.ts'
export { LUMI_LAYOUT_CONFIG, effectiveLumiLayout } from './layout-config.ts'

/** Layout, character service, and locale dependencies. */
export const inject = ['slots', 'locale', 'lumiCharacter']

/** Register the immersive product frame at the reserved takeover priority. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('lumi.shell', { zh, en }), 'lumi-shell: dictionaries')
  ctx.slots.inject('layout.frame', () => ctx.slots.register({
    name: 'layout.frame',
    priority: -100,
    locale: 'lumi.shell',
    inject: (): LumiCharacterInjected => ({
      hooks: { character: ctx.lumiCharacter },
      observeConversation: (observation) => { ctx.lumiCharacter.observeConversation(observation) },
      speak: (text, sourceId) => { ctx.lumiCharacter.speak(text, false, sourceId) },
      pauseSpeaking: () => { ctx.lumiCharacter.pauseSpeaking() },
      resumeSpeaking: () => { ctx.lumiCharacter.resumeSpeaking() },
      stopSpeaking: () => { ctx.lumiCharacter.stopSpeaking() },
      setPreference: (field, value) => { ctx.lumiCharacter.setPreference(field, value) },
      refreshPacks: () => ctx.lumiCharacter.refreshPacks(),
    }),
  }, LumiFrame))
}
