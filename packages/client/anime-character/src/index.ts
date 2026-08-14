/** Host half: durable character settings plus local pack discovery and assets. */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { AnimePackCatalog } from './packs.ts'
import {
  ANIME_CHARACTER_SETTINGS_NAMESPACE, AnimeCharacterSettingsSchema,
} from './settings.ts'

export * from './pack-contract.ts'
export * from './settings.ts'

const SETTINGS_NAMESPACE = settingsNamespace(ANIME_CHARACTER_SETTINGS_NAMESPACE)
const BUILTIN_ASSETS_ROOT = fileURLToPath(new URL('../assets', import.meta.url))

/** Register optional Host capabilities without forcing non-Web surfaces to provide them. */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(SETTINGS_NAMESPACE, AnimeCharacterSettingsSchema)
  })
  ctx.inject(['webServer'], (webCtx) => {
    const catalog = new AnimePackCatalog(
      join(resolveDshHome(), 'anime', 'packs'),
      BUILTIN_ASSETS_ROOT,
      webCtx.logger,
    )
    webCtx.effect(() => {
      const unregister = catalog.register(webCtx.webServer)
      return () => {
        unregister()
        catalog.dispose()
      }
    }, 'anime-character: packs and assets')
  })
}
