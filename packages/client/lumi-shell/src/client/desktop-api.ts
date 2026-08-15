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
  }
}

declare global {
  interface Window {
    dshDesktop?: DshDesktopApi
  }
}
