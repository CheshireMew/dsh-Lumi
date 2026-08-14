import { contextBridge, ipcRenderer } from 'electron'
import { DESKTOP_EVENT_CHANNELS, DESKTOP_INVOKE_CHANNELS } from './ipc.ts'

interface DesktopWindowState {
  maximized: boolean
  fullscreen: boolean
}

const platform = process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux'

contextBridge.exposeInMainWorld('dshDesktop', {
  platform,
  appVersion: process.env.DSH_ANIME_APP_VERSION ?? '0.0.0',
  window: {
    minimize: () => ipcRenderer.invoke(DESKTOP_INVOKE_CHANNELS.minimize) as Promise<void>,
    toggleMaximize: () => ipcRenderer.invoke(DESKTOP_INVOKE_CHANNELS.toggleMaximize) as Promise<void>,
    close: () => ipcRenderer.invoke(DESKTOP_INVOKE_CHANNELS.close) as Promise<void>,
    getState: () => ipcRenderer.invoke(DESKTOP_INVOKE_CHANNELS.getState) as Promise<DesktopWindowState>,
    onStateChanged: (listener: (state: DesktopWindowState) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, state: DesktopWindowState): void => { listener(state) }
      ipcRenderer.on(DESKTOP_EVENT_CHANNELS.stateChanged, wrapped)
      return () => { ipcRenderer.removeListener(DESKTOP_EVENT_CHANNELS.stateChanged, wrapped) }
    },
  },
  app: {
    restartHarness: () => ipcRenderer.invoke(DESKTOP_INVOKE_CHANNELS.restartHarness) as Promise<void>,
    openLogsFolder: () => ipcRenderer.invoke(DESKTOP_INVOKE_CHANNELS.openLogs) as Promise<void>,
    openCharacterPacksFolder: () => ipcRenderer.invoke(DESKTOP_INVOKE_CHANNELS.openPacks) as Promise<void>,
  },
})
