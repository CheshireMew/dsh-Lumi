import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  healProfilesModuleFallback: vi.fn(),
  loadProfile: vi.fn(),
  initProfile: vi.fn(),
  resolveProfileDir: vi.fn(),
  writeFileSync: vi.fn(),
}))

vi.mock('node:fs', () => ({ writeFileSync: mocks.writeFileSync }))
vi.mock('@deepseek-ai/dsh-app-boot', () => ({
  boot: vi.fn(),
  composeEntries: vi.fn(() => []),
  healProfilesModuleFallback: mocks.healProfilesModuleFallback,
  installFailLoud: vi.fn(),
  initProfile: mocks.initProfile,
  loadOptionalPatches: vi.fn(),
  loadOverlayPatches: vi.fn(),
  loadProfile: mocks.loadProfile,
  PROFILE_PATCH_FILENAME: 'cordis.patch.yml',
  resolveProfileDir: mocks.resolveProfileDir,
  watchUserPatches: vi.fn(),
}))

import { prepareProfile, PROFILE_ROOT_FILENAME } from '../src/profile-boot.ts'

describe('profile boot install anchor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolveProfileDir.mockReturnValue('E:\\profiles\\anime-desktop')
    mocks.loadProfile.mockReturnValue({
      dir: 'E:\\profiles\\anime-desktop',
      patchPath: 'E:\\profiles\\anime-desktop\\cordis.patch.yml',
      patches: [],
      layers: [],
    })
  })

  it('initializes a missing embedded profile from the requested bundle stack', () => {
    const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@dsh-anime/bundle-desktop']
    prepareProfile('anime-desktop', true, 'E:\\apps\\desktop\\package.json', bundles)
    expect(mocks.resolveProfileDir).toHaveBeenCalledWith('anime-desktop')
    expect(mocks.initProfile).toHaveBeenCalledWith('E:\\profiles\\anime-desktop', bundles)
  })

  it('heals and loads bundles from an embedded launcher manifest', () => {
    const anchor = 'E:\\apps\\desktop\\package.json'
    const profile = prepareProfile('anime-desktop', false, anchor)

    expect(mocks.healProfilesModuleFallback).toHaveBeenCalledWith(anchor)
    expect(mocks.loadProfile).toHaveBeenCalledWith(
      'dsh', 'anime-desktop', anchor, undefined, { userLayer: false },
    )
    expect(mocks.writeFileSync).toHaveBeenCalledWith(
      `E:\\profiles\\anime-desktop\\${PROFILE_ROOT_FILENAME}`,
      expect.stringContaining('dsh profile root'),
    )
    expect(profile).toBe(mocks.loadProfile.mock.results[0]!.value)
  })
})
