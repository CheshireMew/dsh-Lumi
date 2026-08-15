/** Responsive layout constants shared by the frame and its tests. */
export const LUMI_LAYOUT_CONFIG = Object.freeze({
  fullSceneMinWidth: 1440,
  workLayoutMaxWidth: 1099,
  compactSceneMinWidth: 1100,
  sidebarCollapsedWidth: 56,
  sidebarDefaultWidth: 280,
  titleBarHeight: 44,
})

/**
 * Resolve the effective layout at one rendered frame width.
 * @param width Current frame width in CSS pixels.
 * @param preference Persisted user mode.
 * @returns Work mode below the responsive threshold, otherwise the preference.
 */
export function effectiveLumiLayout(width: number, preference: 'scene' | 'work'): 'scene' | 'work' {
  return width <= LUMI_LAYOUT_CONFIG.workLayoutMaxWidth ? 'work' : preference
}
