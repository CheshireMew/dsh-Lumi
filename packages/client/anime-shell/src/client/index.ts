/** Browser plugin registering the product frame below the official priority-0 fallback. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@dsh-anime/client-character/client'
import { AnimeFrame } from './AnimeFrame.tsx'
import type { AnimeCharacterInjected } from '@dsh-anime/client-character/client'
import { en, zh } from './locales.ts'

export type { AnimeFrameProps } from './AnimeFrame.tsx'
export type { DshDesktopApi, DesktopWindowState } from './desktop-api.ts'
export { ANIME_LAYOUT_CONFIG, effectiveAnimeLayout } from './layout-config.ts'

/** Layout, character service, and locale dependencies. */
export const inject = ['slots', 'locale', 'animeCharacter']

/** Register the immersive product frame at the reserved takeover priority. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('anime.shell', { zh, en }), 'anime-shell: dictionaries')
  ctx.slots.inject('layout.frame', () => ctx.slots.register({
    name: 'layout.frame',
    priority: -100,
    locale: 'anime.shell',
    inject: (): AnimeCharacterInjected => ({
      hooks: { character: ctx.animeCharacter },
      observeConversation: (observation) => { ctx.animeCharacter.observeConversation(observation) },
      speak: (text, sourceId) => { ctx.animeCharacter.speak(text, false, sourceId) },
      pauseSpeaking: () => { ctx.animeCharacter.pauseSpeaking() },
      resumeSpeaking: () => { ctx.animeCharacter.resumeSpeaking() },
      stopSpeaking: () => { ctx.animeCharacter.stopSpeaking() },
      setPreference: (field, value) => { ctx.animeCharacter.setPreference(field, value) },
      refreshPacks: () => ctx.animeCharacter.refreshPacks(),
    }),
  }, AnimeFrame))
}
