import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { inspectLumiPackDirectory } from '@dsh-lumi/client-character'

/** Result of validating and installing one character-pack directory. */
export type CharacterPackInstallResult =
  | { kind: 'installed'; id: string; displayName: string; author: string; version: string; license?: string }
  | { kind: 'error'; code: 'invalid' | 'exists' | 'copy-failed'; detail: string }

/** Writable desktop locations used by the character-pack installer. */
export interface CharacterPackInstallPaths {
  home: string
  characterPacks: string
}

/** Effects supplied by the desktop host for diagnostics and stable tests. */
export interface CharacterPackInstallEffects {
  createStagingId: () => string
  logFailure: (message: string) => void
}

const defaultEffects: CharacterPackInstallEffects = {
  createStagingId: randomUUID,
  logFailure: () => {},
}

/**
 * Validate, stage, revalidate, and atomically publish one character pack.
 * Failed staging directories remain available for diagnosis and recovery.
 * @param source directory selected by the user.
 * @param paths materialized desktop-owned locations.
 * @param effects diagnostics and staging-id effects.
 * @returns a stable renderer-facing installation result.
 */
export async function installCharacterPack(
  source: string,
  paths: CharacterPackInstallPaths,
  effects: CharacterPackInstallEffects = defaultEffects,
): Promise<CharacterPackInstallResult> {
  let inspected: ReturnType<typeof inspectLumiPackDirectory>
  try {
    inspected = inspectLumiPackDirectory(source)
  } catch (error) {
    return { kind: 'error', code: 'invalid', detail: error instanceof Error ? error.message : String(error) }
  }
  if (!inspected.ok) return { kind: 'error', code: 'invalid', detail: inspected.detail }

  const { manifest } = inspected
  const destination = join(paths.characterPacks, manifest.id)
  if (existsSync(destination)) {
    return { kind: 'error', code: 'exists', detail: `character pack "${manifest.id}" is already installed` }
  }

  const stagingRoot = join(paths.home, 'lumi', 'import-staging')
  const staging = join(stagingRoot, effects.createStagingId())
  try {
    await mkdir(stagingRoot, { recursive: true })
    await cp(source, staging, { recursive: true, errorOnExist: true, force: false })
    const copied = inspectLumiPackDirectory(staging, manifest.id)
    if (!copied.ok) return { kind: 'error', code: 'invalid', detail: copied.detail }
    await rename(staging, destination)
    return {
      kind: 'installed',
      id: manifest.id,
      displayName: manifest.displayName,
      author: manifest.author,
      version: manifest.version,
      ...(manifest.license === undefined ? {} : { license: manifest.license }),
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    effects.logFailure(`character pack import failed; staging retained at ${staging}: ${detail}`)
    return { kind: 'error', code: 'copy-failed', detail }
  }
}
