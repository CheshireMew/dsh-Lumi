/** Renderer-safe window state returned by Electron. */
export interface DesktopWindowState {
  maximized: boolean
  fullscreen: boolean
}

/** Narrow renderer bridge exposed by Electron preload. */
export interface DshDesktopApi {
  platform: 'win32' | 'darwin' | 'linux'
  appVersion: string
  window: {
    minimize: () => Promise<void>
    toggleMaximize: () => Promise<void>
    close: () => Promise<void>
    getState: () => Promise<DesktopWindowState>
    onStateChanged: (listener: (state: DesktopWindowState) => void) => () => void
  }
  app: {
    restartHarness: () => Promise<void>
    openLogsFolder: () => Promise<void>
    openCharacterPacksFolder: () => Promise<void>
    importCharacterPack: () => Promise<CharacterPackImportResult>
  }
}

/** Result of selecting, validating, and atomically installing one local character pack. */
export type CharacterPackImportResult =
  | { kind: 'cancelled' }
  | { kind: 'installed'; id: string; displayName: string; author: string; version: string; license?: string }
  | { kind: 'error'; code: 'invalid' | 'exists' | 'copy-failed'; detail: string }

declare global {
  interface Window {
    dshDesktop?: DshDesktopApi
  }
}
