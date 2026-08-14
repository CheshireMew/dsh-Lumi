/** Character states resolved by the shell in strict priority order. */
export const CHARACTER_STATES = [
  'idle', 'listening', 'thinking', 'tool', 'speaking', 'success', 'error', 'waiting',
] as const

/** One visual state supported by every character pack. */
export type CharacterState = typeof CHARACTER_STATES[number]

/** One normalized animation keyframe; `at` ranges from zero to one. */
export interface AnimeAnimationKeyframe {
  at: number
  translateX?: number
  translateY?: number
  scale?: number
  rotate?: number
  opacity?: number
  mouth?: 'open' | 'closed'
}

/** State timing and fallback behavior declared by a pack. */
export interface AnimeAnimationDefinition {
  keyframes: readonly AnimeAnimationKeyframe[]
  loop: 'none' | 'repeat' | 'alternate'
  minDurationMs: number
}

/** State timing and fallback behavior declared by a pack. */
export interface AnimeCharacterStateDefinition {
  expression: string
  effect?: string
  fallback: CharacterState
  animation: AnimeAnimationDefinition
}

/** Local-only content unlocked when the accumulated bond level is reached. */
export interface AnimeBondUnlock {
  level: number
  expressions: readonly string[]
  idleActions: readonly string[]
  bubbles: {
    zh: readonly string[]
    en: readonly string[]
  }
}

/** Validated character-pack v1 manifest. */
export interface AnimePackManifest {
  schemaVersion: 1
  id: string
  displayName: string
  author: string
  license?: string
  version: string
  canvas: {
    width: number
    height: number
    anchor: { x: number; y: number }
    safeMargin: { top: number; right: number; bottom: number; left: number }
  }
  assets: {
    preview: 'preview.webp'
    background: 'background.webp'
    body: string
    expressions: Readonly<Record<string, string>>
    mouth: { closed: string; open: string }
    effects: Readonly<Record<string, string>>
  }
  states: Readonly<Record<CharacterState, AnimeCharacterStateDefinition>>
  idleActions: Readonly<Record<string, { effect?: string; animation: AnimeAnimationDefinition }>>
  bondUnlocks: readonly AnimeBondUnlock[]
}

/** Same-origin URLs resolved by the Host for one validated manifest. */
export interface AnimePackAssetUrls {
  preview: string
  background: string
  body: string
  expressions: Readonly<Record<string, string>>
  mouth: { closed: string; open: string }
  effects: Readonly<Record<string, string>>
}

/** Browser-safe pack view; no filesystem path crosses into the renderer. */
export interface AnimePackView {
  manifest: AnimePackManifest
  assets: AnimePackAssetUrls
  /** False when the pack omits a license and therefore remains local-only. */
  publishable: boolean
}

/** One rejected directory shown as a non-blocking catalog notice. */
export interface AnimePackDiagnostic {
  directory: string
  message: string
}

/** Host response for one pack catalog read. */
export interface AnimePackCatalogView {
  revision: number
  packs: readonly AnimePackView[]
  diagnostics: readonly AnimePackDiagnostic[]
}
