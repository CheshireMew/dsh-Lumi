import { createBuiltinManifest } from '../builtin.ts'
import type { LumiPackCatalogView, LumiPackView } from '../pack-contract.ts'
import { CHARACTER_STATES } from '../pack-contract.ts'

/** Browser fallback used before the first Host catalog response. */
export const BUILTIN_PACK: LumiPackView = Object.freeze({
  manifest: createBuiltinManifest(),
  publishable: true,
  assets: Object.freeze({
    preview: '/lumi/assets/builtin-lumi/preview',
    background: '/lumi/assets/builtin-lumi/background',
    body: '/lumi/assets/builtin-lumi/body',
    expressions: {
      neutral: '/lumi/assets/builtin-lumi/expression%3Aneutral',
      happy: '/lumi/assets/builtin-lumi/expression%3Ahappy',
      concerned: '/lumi/assets/builtin-lumi/expression%3Aconcerned',
      focused: '/lumi/assets/builtin-lumi/expression%3Afocused',
    },
    mouth: {
      closed: '/lumi/assets/builtin-lumi/mouth%3Aclosed',
      open: '/lumi/assets/builtin-lumi/mouth%3Aopen',
    },
    effects: { sparkle: '/lumi/assets/builtin-lumi/effect%3Asparkle' },
  }),
} satisfies LumiPackView)

const CHARACTER_STATE_SET = new Set<string>(CHARACTER_STATES)

/** JSON object guard for the browser/Host transport. */
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate one same-origin asset URL. */
function assetUrl(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/lumi/assets/')
}

/** Validate one resolved pack before it enters browser state. */
function isLumiPackView(value: unknown): value is LumiPackView {
  if (!record(value) || !record(value['manifest']) || !record(value['assets'])) return false
  const manifest = value['manifest']
  const assets = value['assets']
  if (manifest['schemaVersion'] !== 1
    || typeof manifest['id'] !== 'string'
    || typeof manifest['displayName'] !== 'string'
    || typeof manifest['author'] !== 'string'
    || (manifest['license'] !== undefined && typeof manifest['license'] !== 'string')
    || typeof manifest['version'] !== 'string'
    || !record(manifest['states'])
    || !Array.isArray(manifest['bondUnlocks'])
    || typeof value['publishable'] !== 'boolean'
    || !assetUrl(assets['preview'])
    || !assetUrl(assets['background'])
    || !assetUrl(assets['body'])
    || !record(assets['expressions'])
    || !record(assets['mouth'])
    || !assetUrl(assets['mouth']['closed'])
    || !assetUrl(assets['mouth']['open'])
    || !record(assets['effects'])) return false
  const manifestStates = manifest['states']
  return CHARACTER_STATES.every((state) => {
    const definition = manifestStates[state]
    return record(definition)
      && typeof definition['expression'] === 'string'
      && typeof definition['fallback'] === 'string'
      && CHARACTER_STATE_SET.has(definition['fallback'])
      && record(definition['animation'])
      && typeof definition['animation']['minDurationMs'] === 'number'
  })
    && Object.values(assets['expressions']).every(assetUrl)
    && Object.values(assets['effects']).every(assetUrl)
}

/**
 * Validate the complete local same-origin Host response.
 * @param value - untrusted JSON value returned by the Host transport.
 * @returns whether the value is a complete Lumi pack catalog.
 */
export function isLumiPackCatalogView(value: unknown): value is LumiPackCatalogView {
  return record(value)
    && typeof value['revision'] === 'number'
    && Number.isInteger(value['revision'])
    && Array.isArray(value['packs'])
    && value['packs'].every(isLumiPackView)
    && Array.isArray(value['diagnostics'])
    && value['diagnostics'].every(item => record(item) && typeof item['directory'] === 'string' && typeof item['message'] === 'string')
}
