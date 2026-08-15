import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { initProfile, loadProfile, resolveProfileDir } from '@deepseek-ai/dsh-app-boot'

const BASE = '@deepseek-ai/dsh-base'
const WEB = '@deepseek-ai/dsh-web-app'
const LUMI = '@dsh-lumi/bundle-desktop'

describe('profile boot real install anchors', () => {
  it('resolves the official Web bundle stack from the CLI installation anchor', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-cli-anchor-'))
    const anchor = resolve('apps/cli/package.json')
    initProfile(resolveProfileDir('fixture-web', home), [BASE, WEB])
    const profile = loadProfile('dsh', 'fixture-web', anchor, home)
    expect(profile.layers.map(layer => layer.packageName)).toEqual([BASE, WEB])
    expect(profile.layers.every(layer => layer.patches.length > 0)).toBe(true)
  })

  it('resolves base, Web, and the custom desktop bundle from the Electron anchor', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-anchor-'))
    const anchor = resolve('apps/desktop/package.json')
    initProfile(resolveProfileDir('lumi-desktop', home), [BASE, WEB, LUMI])
    const profile = loadProfile('dsh', 'lumi-desktop', anchor, home)
    expect(profile.layers.map(layer => layer.packageName)).toEqual([BASE, WEB, LUMI])
    expect(profile.layers.map(layer => basename(layer.patchPath))).toEqual([
      'cordis.patch.yml',
      'cordis.patch.yml',
      'cordis.patch.yml',
    ])
    expect(profile.layers.every(layer => layer.patchPath.startsWith(dirname(anchor)))).toBe(true)
  })
})
