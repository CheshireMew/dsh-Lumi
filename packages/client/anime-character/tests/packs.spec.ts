import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CHARACTER_STATES } from '../src/pack-contract.ts'
import { AnimePackCatalog } from '../src/packs.ts'

const animation = { keyframes: [{ at: 0 }, { at: 1, translateY: -3 }], loop: 'alternate', minDurationMs: 1200 }

function manifest(id: string, license: string | null = 'CC-BY-4.0') {
  return {
    schemaVersion: 1,
    id,
    displayName: 'Luna',
    author: 'Fixture Author',
    ...(license === null ? {} : { license }),
    version: '1.0.0',
    canvas: { width: 720, height: 1120, anchor: { x: 360, y: 1080 }, safeMargin: { top: 20, right: 20, bottom: 20, left: 20 } },
    assets: {
      preview: 'preview.webp', background: 'background.webp', body: 'layers/body.svg',
      expressions: { neutral: 'expressions/neutral.svg' },
      mouth: { closed: 'layers/mouth-closed.svg', open: 'layers/mouth-open.svg' },
      effects: { sparkle: 'effects/sparkle.svg' },
    },
    states: Object.fromEntries(CHARACTER_STATES.map(state => [state, { expression: 'neutral', effect: state === 'success' ? 'sparkle' : undefined, fallback: 'idle', animation }])),
    idleActions: { breathe: { animation } },
    bondUnlocks: [{ level: 1, expressions: ['neutral'], idleActions: ['breathe'], bubbles: { zh: ['你好'], en: ['Hello'] } }],
  }
}

function writePack(root: string, id: string, value: unknown): string {
  const dir = join(root, id)
  for (const child of ['layers', 'expressions', 'effects']) mkdirSync(join(dir, child), { recursive: true })
  for (const file of [
    'preview.webp', 'background.webp', 'layers/body.svg', 'layers/mouth-closed.svg',
    'layers/mouth-open.svg', 'expressions/neutral.svg', 'effects/sparkle.svg',
  ]) writeFileSync(join(dir, file), 'asset')
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(value))
  return dir
}

describe('AnimePackCatalog', () => {
  it('publishes complete v1 packs and keeps an unlicensed pack local-only', () => {
    const base = mkdtempSync(join(tmpdir(), 'dsh-anime-pack-'))
    const root = join(base, 'packs')
    const builtins = join(base, 'builtins')
    mkdirSync(builtins, { recursive: true })
    for (const name of [
      'builtin-lumi.svg', 'builtin-library.svg', 'builtin-body.svg', 'builtin-mouth-closed.svg',
      'builtin-mouth-open.svg', 'builtin-expression-neutral.svg', 'builtin-expression-happy.svg',
      'builtin-expression-concerned.svg', 'builtin-expression-focused.svg', 'builtin-effect-sparkle.svg',
    ]) writeFileSync(join(builtins, name), '<svg/>')
    writePack(root, 'luna', manifest('luna', null))
    const warn = vi.fn()
    const catalog = new AnimePackCatalog(root, builtins, { warn })
    try {
      const snapshot = catalog.snapshot()
      expect(snapshot.packs.map(pack => pack.manifest.id)).toEqual(['builtin-lumi', 'luna'])
      expect(snapshot.packs[1]).toMatchObject({
        manifest: { id: 'luna', displayName: 'Luna', version: '1.0.0' },
        publishable: false,
        assets: { body: '/anime/assets/packs/luna/body', mouth: { open: '/anime/assets/packs/luna/mouth%3Aopen' } },
      })
      expect(snapshot.assets.get('/anime/assets/packs/luna/body')).toBe(join(root, 'luna', 'layers', 'body.svg'))
      expect(snapshot.diagnostics).toEqual([])
    } finally {
      catalog.dispose()
    }
  })

  it('rejects missing, incomplete, traversal, and directory-id mismatches with diagnostics', () => {
    const base = mkdtempSync(join(tmpdir(), 'dsh-anime-invalid-pack-'))
    const root = join(base, 'packs')
    const builtins = join(base, 'builtins')
    mkdirSync(builtins, { recursive: true })
    writePack(root, 'missing-state', { ...manifest('missing-state'), states: { idle: manifest('x').states.idle } })
    writePack(root, 'escape', { ...manifest('escape'), assets: { ...manifest('escape').assets, body: 'layers/../preview.webp' } })
    writePack(root, 'wrong-directory', manifest('different-id'))
    const warn = vi.fn()
    const catalog = new AnimePackCatalog(root, builtins, { warn })
    try {
      const snapshot = catalog.snapshot()
      expect(snapshot.packs.map(pack => pack.manifest.id)).toEqual(['builtin-lumi'])
      expect(snapshot.diagnostics.map(item => item.directory)).toEqual(['escape', 'missing-state', 'wrong-directory'])
      expect(warn).toHaveBeenCalledTimes(3)
    } finally {
      catalog.dispose()
    }
  })
})
