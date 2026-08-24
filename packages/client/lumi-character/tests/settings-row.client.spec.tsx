// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DEFAULT_UI_LUMI_SETTINGS } from '../src/settings.ts'
import { BUILTIN_PACK } from '../src/client/catalog-client.ts'
import { LumiSettingsRow } from '../src/client/LumiSettingsRow.tsx'
import type { LumiCharacterSnapshot } from '../src/client/service.ts'
import type { LumiSettingsRowProps } from '../src/client/slots.ts'

const copy: Readonly<Record<string, string>> = {
  'settings.title': 'Character',
  'settings.managePacks': 'Manage character packs',
  'settings.refreshPacks': 'Refresh character packs',
  'settings.packFailed': 'Character packs could not be loaded.',
  'settings.packDiagnostics': 'Pack diagnostics',
  'settings.saveFailed': 'The preference was not saved.',
  'settings.retry': 'Retry',
  'settings.narrowHint': 'Narrow windows use work mode.',
  'settings.layoutMode': 'Layout',
  'settings.scene': 'Scene',
  'settings.work': 'Work',
  'settings.characterVisible': 'Show character',
  'settings.motion': 'Motion',
  'settings.motionSystem': 'System',
  'settings.motionFull': 'Full',
  'settings.motionReduced': 'Reduced',
  'settings.panelOpacity': 'Panel opacity',
  'settings.backgroundBlur': 'Background blur',
  'settings.pack': 'Character pack',
  'settings.tts': 'Text to speech',
  'settings.autoRead': 'Read replies automatically',
  'settings.voice': 'Voice',
  'settings.defaultVoice': 'System default',
  'settings.rate': 'Rate',
  'settings.pitch': 'Pitch',
  'settings.volume': 'Volume',
  'settings.autoLimit': 'Automatic reading limit',
  'settings.noVoices': 'No system voice is available.',
  'settings.managerTitle': 'Character packs',
  'settings.managerDescription': 'Review and import local character packs.',
  'settings.closeManager': 'Close character packs',
  'settings.openPackFolder': 'Open pack folder',
  'settings.importPack': 'Import pack',
  'settings.importingPack': 'Importing…',
  'settings.author': 'Author',
  'settings.version': 'Version',
  'settings.license': 'License',
  'settings.selected': 'Selected',
  'settings.usePack': 'Use pack',
  'settings.localOnly': 'Local only',
  'settings.importInvalid': 'The selected folder is not a valid pack.',
  'settings.importExists': 'That pack is already installed.',
  'settings.importFailed': 'The pack could not be copied.',
}

function snapshot(overrides: Partial<LumiCharacterSnapshot> = {}): LumiCharacterSnapshot {
  return {
    settingsStatus: 'ready',
    settingsWritable: true,
    preferenceStatus: 'idle',
    preferenceFailure: undefined,
    settings: DEFAULT_UI_LUMI_SETTINGS,
    packStatus: 'ready',
    packError: undefined,
    packFallback: false,
    packDiagnostics: [],
    packs: [BUILTIN_PACK],
    activePack: BUILTIN_PACK,
    voices: [],
    ttsUnavailableReason: 'no-voices',
    state: 'idle',
    speech: 'idle',
    speechMessageId: undefined,
    mouthOpen: false,
    animationsPaused: false,
    bondLevel: 1,
    bondLevelProgress: 0,
    unlockedExpressions: ['neutral'],
    unlockedIdleActions: ['breathe'],
    unlockedBubbles: { zh: [], en: [] },
    revision: 1,
    ...overrides,
  }
}

function props(value: LumiCharacterSnapshot, actions: {
  retryPreference?: () => void
  refreshPacks?: () => Promise<void>
} = {}): LumiSettingsRowProps {
  return {
    useCharacter: <Selected,>(selector: (current: LumiCharacterSnapshot) => Selected) => selector(value),
    setPreference: vi.fn(),
    retryPreference: actions.retryPreference ?? vi.fn(),
    refreshPacks: actions.refreshPacks ?? vi.fn(async () => {}),
    t: (key: string, params?: Readonly<Record<string, unknown>>) => {
      if (key === 'settings.installedPack') return `Installed ${String(params?.['name'])}.`
      return copy[key] ?? key
    },
  } as unknown as LumiSettingsRowProps
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'dshDesktop')
})

describe('LumiSettingsRow', () => {
  it('keeps persistence and pack failures visible with their own recovery actions', () => {
    const retryPreference = vi.fn()
    const refreshPacks = vi.fn(async () => {})
    render(<LumiSettingsRow {...props(snapshot({
      preferenceStatus: 'error',
      preferenceFailure: { kind: 'persistence', field: 'layoutMode' },
      packStatus: 'error',
      packError: 'catalog request failed',
      packDiagnostics: [{ directory: 'broken-pack', message: 'manifest is not valid JSON' }],
    }), { retryPreference, refreshPacks })} />)

    const alerts = screen.getAllByRole('alert')
    fireEvent.click(alerts[0]!.querySelector('button')!)
    fireEvent.click(alerts[1]!.querySelector('button')!)
    expect(retryPreference).toHaveBeenCalledOnce()
    expect(refreshPacks).toHaveBeenCalledOnce()
    expect(screen.getByText('catalog request failed')).toBeDefined()
    fireEvent.click(screen.getByText('Pack diagnostics'))
    expect(screen.getByText(/broken-pack/u)).toBeDefined()
  })

  it('shows pack metadata and refreshes the catalog after a desktop import', async () => {
    const refreshPacks = vi.fn(async () => {})
    const importCharacterPack = vi.fn(async () => ({
      kind: 'installed' as const,
      id: 'luna',
      displayName: 'Luna',
      author: 'Fixture Author',
      version: '1.0.0',
      license: 'CC-BY-4.0',
    }))
    Object.defineProperty(window, 'dshDesktop', {
      configurable: true,
      value: { app: { importCharacterPack, openCharacterPacksFolder: vi.fn(async () => {}) } },
    })
    render(<LumiSettingsRow {...props(snapshot(), { refreshPacks })} />)

    fireEvent.click(screen.getByRole('button', { name: 'Manage character packs' }))
    expect(screen.getByRole('dialog', { name: 'Character packs' })).toBeDefined()
    expect(screen.getByText(/Author: DeepSeek Harness Lumi/u)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Import pack' }))
    await waitFor(() => { expect(refreshPacks).toHaveBeenCalledOnce() })
    expect(screen.getByText('Installed Luna.')).toBeDefined()
  })
})
