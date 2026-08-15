import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Desktop-owned writable directories under the same Harness home as the CLI. */
export interface DesktopPaths {
  home: string
  logs: string
  crashes: string
  characterPacks: string
}

/** Resolve and materialize the desktop-owned directories without touching user content. */
export function ensureDesktopPaths(): DesktopPaths {
  const home = resolveDshHome()
  const logs = join(home, 'logs', 'lumi-desktop')
  const crashes = join(home, 'crashes', 'lumi-desktop')
  const characterPacks = join(home, 'lumi', 'packs')
  mkdirSync(logs, { recursive: true })
  mkdirSync(crashes, { recursive: true })
  mkdirSync(characterPacks, { recursive: true })
  return { home, logs, crashes, characterPacks }
}

/** Log filename for one process and local calendar day. */
export function dailyLogPath(logs: string, processName: 'main' | 'harness', date = new Date()): string {
  const year = String(date.getFullYear())
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return join(logs, `${processName}-${year}-${month}-${day}.log`)
}
