/** Desktop update lifecycle independent of Electron's concrete updater. */

/** Release metadata used by the desktop update lifecycle. */
export interface DesktopUpdateInfo { version: string }

/** Event subset implemented by electron-updater's AppUpdater. */
export interface DesktopUpdater {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  on(event: 'checking-for-update' | 'update-not-available', listener: () => void): this
  on(event: 'update-available' | 'update-downloaded', listener: (info: DesktopUpdateInfo) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  checkForUpdates(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

/** Side effects owned by the Electron main process. */
export interface DesktopUpdateEffects {
  log(level: 'INFO' | 'WARN' | 'ERROR', message: string): void
  confirmInstall(version: string): Promise<boolean>
}

/**
 * Register one conservative Windows updater and begin a release check.
 * Development runs never contact the release provider. Downloaded updates are
 * installed only after an explicit user choice or on a later ordinary quit.
 * @param updater Signed-release updater supplied by electron-updater.
 * @param packaged Whether Electron is running an installed application.
 * @param effects Logging and user-confirmation effects.
 * @returns A promise settled after the initial check request is accepted.
 */
export async function startDesktopUpdater(
  updater: DesktopUpdater,
  packaged: boolean,
  effects: DesktopUpdateEffects,
): Promise<void> {
  if (!packaged) {
    effects.log('INFO', 'update check skipped outside a packaged application')
    return
  }
  updater.autoDownload = true
  updater.autoInstallOnAppQuit = true
  updater.on('checking-for-update', () => { effects.log('INFO', 'checking for a Lumi update') })
  updater.on('update-available', (info) => { effects.log('INFO', `Lumi ${info.version} is available; downloading`) })
  updater.on('update-not-available', () => { effects.log('INFO', 'Lumi is up to date') })
  updater.on('error', (error) => { effects.log('WARN', `update check failed: ${error.message}`) })
  updater.on('update-downloaded', (info) => {
    effects.log('INFO', `Lumi ${info.version} is downloaded and signature-verified`)
    void effects.confirmInstall(info.version).then((installNow) => {
      if (installNow) updater.quitAndInstall(false, true)
    }).catch((error: unknown) => {
      effects.log('WARN', `update confirmation failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  })
  try {
    await updater.checkForUpdates()
  } catch (error) {
    effects.log('WARN', `update request failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
