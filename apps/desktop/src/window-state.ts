import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomicSync } from '@deepseek-ai/dsh-atomic-write'

/** Persisted normal window bounds and maximize state. */
export interface DesktopWindowPlacement {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
}

/** Display rectangle needed to validate a restored placement. */
export interface DisplayBounds {
  x: number
  y: number
  width: number
  height: number
}

/** Resolve the desktop-owned placement file under Electron userData. */
export function windowPlacementPath(userData: string): string { return join(userData, 'lumi-window-state.json') }

/** Read and validate a persisted placement without trusting the JSON file. */
export function readWindowPlacement(path: string): DesktopWindowPlacement | undefined {
  if (!existsSync(path)) return undefined
  let value: unknown
  try { value = JSON.parse(readFileSync(path, 'utf8')) } catch { return undefined }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const placement = value as Record<string, unknown>
  if (!Number.isFinite(placement['x']) || !Number.isFinite(placement['y'])
    || !Number.isFinite(placement['width']) || !Number.isFinite(placement['height'])
    || typeof placement['maximized'] !== 'boolean') return undefined
  if ((placement['width'] as number) < 320 || (placement['height'] as number) < 240) return undefined
  return {
    x: Math.round(placement['x'] as number),
    y: Math.round(placement['y'] as number),
    width: Math.round(placement['width'] as number),
    height: Math.round(placement['height'] as number),
    maximized: placement['maximized'],
  }
}

/** True when at least a usable title-bar area intersects one current display. */
export function placementIsVisible(placement: DesktopWindowPlacement, displays: readonly DisplayBounds[]): boolean {
  return displays.some((display) => {
    const width = Math.min(placement.x + placement.width, display.x + display.width) - Math.max(placement.x, display.x)
    const height = Math.min(placement.y + 64, display.y + display.height) - Math.max(placement.y, display.y)
    return width >= 96 && height >= 32
  })
}

/** Center default bounds on the primary display when restoration is unsafe. */
export function resolveWindowPlacement(
  saved: DesktopWindowPlacement | undefined,
  displays: readonly DisplayBounds[],
  primary: DisplayBounds,
  defaults: { width: number; height: number },
): DesktopWindowPlacement {
  if (saved !== undefined && placementIsVisible(saved, displays)) return saved
  const width = Math.min(defaults.width, primary.width)
  const height = Math.min(defaults.height, primary.height)
  return {
    x: Math.round(primary.x + (primary.width - width) / 2),
    y: Math.round(primary.y + (primary.height - height) / 2),
    width,
    height,
    maximized: false,
  }
}

/** Atomically replace the small desktop-owned placement document. */
export function writeWindowPlacement(path: string, placement: DesktopWindowPlacement): void {
  writeFileAtomicSync(path, `${JSON.stringify(placement, undefined, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
}
