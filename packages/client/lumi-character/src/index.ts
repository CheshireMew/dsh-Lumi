/** Host half: durable character settings plus local pack discovery and assets. */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { LumiPackCatalog } from './packs.ts'
import {
  LUMI_CHARACTER_SETTINGS_NAMESPACE, LumiCharacterSettingsSchema,
} from './settings.ts'

export * from './pack-contract.ts'
export * from './settings.ts'

const SETTINGS_NAMESPACE = settingsNamespace(LUMI_CHARACTER_SETTINGS_NAMESPACE)
const BUILTIN_ASSETS_ROOT = fileURLToPath(new URL('../assets', import.meta.url))

/** Register optional Host capabilities without forcing non-Web surfaces to provide them. */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(SETTINGS_NAMESPACE, LumiCharacterSettingsSchema)
  })
  ctx.inject(['webServer'], (webCtx) => {
    const catalog = new LumiPackCatalog(
      join(resolveDshHome(), 'lumi', 'packs'),
      BUILTIN_ASSETS_ROOT,
      webCtx.logger,
    )
    webCtx.effect(() => {
      const unregister = catalog.register(webCtx.webServer)
      return () => {
        unregister()
        catalog.dispose()
      }
    }, 'lumi-character: packs and assets')
  })
}
