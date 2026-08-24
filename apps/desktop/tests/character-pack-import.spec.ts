import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CHARACTER_STATES } from '@dsh-lumi/client-character'
import { installCharacterPack } from '../src/character-pack-import.ts'

const animation = { keyframes: [{ at: 0 }, { at: 1, translateY: -3 }], loop: 'alternate', minDurationMs: 1200 }

function writePack(parent: string, id = 'luna'): string {
  const root = join(parent, id)
  for (const child of ['layers', 'expressions', 'effects']) mkdirSync(join(root, child), { recursive: true })
  for (const file of [
    'preview.webp', 'background.webp', 'layers/body.svg', 'layers/mouth-closed.svg',
    'layers/mouth-open.svg', 'expressions/neutral.svg', 'effects/sparkle.svg',
  ]) writeFileSync(join(root, file), 'asset')
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    id,
    displayName: 'Luna',
    author: 'Fixture Author',
    license: 'CC-BY-4.0',
    version: '1.0.0',
    canvas: { width: 720, height: 1120, anchor: { x: 360, y: 1080 }, safeMargin: { top: 20, right: 20, bottom: 20, left: 20 } },
    assets: {
      preview: 'preview.webp', background: 'background.webp', body: 'layers/body.svg',
      expressions: { neutral: 'expressions/neutral.svg' },
      mouth: { closed: 'layers/mouth-closed.svg', open: 'layers/mouth-open.svg' },
      effects: { sparkle: 'effects/sparkle.svg' },
    },
    states: Object.fromEntries(CHARACTER_STATES.map(state => [state, { expression: 'neutral', fallback: 'idle', animation }])),
    idleActions: { breathe: { animation } },
    bondUnlocks: [{ level: 1, expressions: ['neutral'], idleActions: ['breathe'], bubbles: { zh: ['你好'], en: ['Hello'] } }],
  }))
  return root
}

function fixture(name: string) {
  const home = mkdtempSync(join(tmpdir(), `dsh-lumi-${name}-`))
  const sourceRoot = join(home, 'source')
  const characterPacks = join(home, 'packs')
  mkdirSync(sourceRoot, { recursive: true })
  mkdirSync(characterPacks, { recursive: true })
  return { home, source: writePack(sourceRoot), characterPacks }
}

describe('desktop character-pack installer', () => {
  it('publishes a validated staging copy without overwriting another pack', async () => {
    const first = fixture('install')
    const result = await installCharacterPack(first.source, first, {
      createStagingId: () => 'stable-stage',
      logFailure: vi.fn(),
    })
    expect(result).toMatchObject({ kind: 'installed', id: 'luna', displayName: 'Luna' })
    expect(existsSync(join(first.characterPacks, 'luna', 'manifest.json'))).toBe(true)

    const duplicateSource = fixture('duplicate-source').source
    writeFileSync(join(first.characterPacks, 'luna', 'sentinel.txt'), 'keep')
    await expect(installCharacterPack(duplicateSource, first)).resolves.toMatchObject({ kind: 'error', code: 'exists' })
    expect(readFileSync(join(first.characterPacks, 'luna', 'sentinel.txt'), 'utf8')).toBe('keep')
  })

  it('retains a copied staging directory when publication fails', async () => {
    const value = fixture('retained-stage')
    const blockedDestination = join(value.home, 'packs-file')
    writeFileSync(blockedDestination, 'not a directory')
    const logFailure = vi.fn()
    await expect(installCharacterPack(value.source, {
      home: value.home,
      characterPacks: blockedDestination,
    }, {
      createStagingId: () => 'retained-stage',
      logFailure,
    })).resolves.toMatchObject({ kind: 'error', code: 'copy-failed' })
    const staging = join(value.home, 'lumi', 'import-staging', 'retained-stage')
    expect(readdirSync(staging)).toContain('manifest.json')
    expect(logFailure).toHaveBeenCalledWith(expect.stringContaining(staging))
  })

  it('rejects an invalid source before creating staging data', async () => {
    const value = fixture('invalid')
    writeFileSync(join(value.source, 'manifest.json'), '{')
    await expect(installCharacterPack(value.source, value)).resolves.toMatchObject({ kind: 'error', code: 'invalid' })
    expect(existsSync(join(value.home, 'lumi', 'import-staging'))).toBe(false)
  })
})
