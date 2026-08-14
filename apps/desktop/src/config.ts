/** Tunable desktop lifecycle and window defaults. */
export interface DesktopRuntimeConfig {
  startupTimeoutMs: number
  shutdownTimeoutMs: number
  disconnectRetryCount: number
  disconnectRetryDelayMs: number
  disconnectRetryResetMs: number
  windowSaveDelayMs: number
  window: {
    width: number
    height: number
    minWidth: number
    minHeight: number
  }
}

/** Product defaults; deployment-varying values have one owner. */
export const DESKTOP_RUNTIME_CONFIG: DesktopRuntimeConfig = Object.freeze({
  startupTimeoutMs: 30_000,
  shutdownTimeoutMs: 8_000,
  disconnectRetryCount: 2,
  disconnectRetryDelayMs: 800,
  disconnectRetryResetMs: 10_000,
  windowSaveDelayMs: 300,
  window: Object.freeze({ width: 1440, height: 920, minWidth: 900, minHeight: 640 }),
})
