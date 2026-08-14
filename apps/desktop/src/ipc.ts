/** Renderer-to-main actions exposed by the desktop bridge. */
export const DESKTOP_INVOKE_CHANNELS = Object.freeze({
  minimize: 'desktop:window:minimize',
  toggleMaximize: 'desktop:window:toggle-maximize',
  close: 'desktop:window:close',
  getState: 'desktop:window:get-state',
  restartHarness: 'desktop:app:restart-harness',
  openLogs: 'desktop:app:open-logs',
  openPacks: 'desktop:app:open-packs',
})

/** Main-to-renderer notifications exposed by the desktop bridge. */
export const DESKTOP_EVENT_CHANNELS = Object.freeze({
  stateChanged: 'desktop:window:state-changed',
})
