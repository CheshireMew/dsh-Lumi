/** Shared original character manifest used by both Host and browser fallback paths. */
import type { AnimeAnimationDefinition, AnimeCharacterStateDefinition, AnimePackManifest } from './pack-contract.ts'
import { BUILTIN_PACK_ID } from './settings.ts'

const STILL: AnimeAnimationDefinition = Object.freeze({
  keyframes: Object.freeze([{ at: 0 }, { at: 1 }]), loop: 'repeat', minDurationMs: 2400,
})

/**
 * Create the complete built-in Lumi manifest.
 * @returns A fresh manifest safe for independent Host and browser ownership.
 */
export function createBuiltinManifest(): AnimePackManifest {
  const state = (expression: string, minDurationMs = 2400): AnimeCharacterStateDefinition => ({
    expression,
    fallback: 'idle',
    animation: { ...STILL, minDurationMs },
  })
  return {
    schemaVersion: 1,
    id: BUILTIN_PACK_ID,
    displayName: 'Lumi',
    author: 'DeepSeek Harness Anime',
    license: 'MIT',
    version: '1.0.0',
    canvas: {
      width: 720,
      height: 1120,
      anchor: { x: 360, y: 1080 },
      safeMargin: { top: 36, right: 36, bottom: 24, left: 36 },
    },
    assets: {
      preview: 'preview.webp',
      background: 'background.webp',
      body: 'layers/body.svg',
      expressions: { neutral: 'expressions/neutral.svg', happy: 'expressions/happy.svg', concerned: 'expressions/concerned.svg', focused: 'expressions/focused.svg' },
      mouth: { closed: 'layers/mouth-closed.svg', open: 'layers/mouth-open.svg' },
      effects: { sparkle: 'effects/sparkle.svg' },
    },
    states: {
      idle: state('neutral'),
      listening: state('neutral'),
      thinking: state('focused'),
      tool: state('focused'),
      speaking: state('happy'),
      success: state('happy', 2200),
      error: state('concerned'),
      waiting: state('concerned'),
    },
    idleActions: { breathe: { animation: STILL }, sparkle: { effect: 'sparkle', animation: STILL } },
    bondUnlocks: [
      { level: 1, expressions: ['neutral'], idleActions: ['breathe'], bubbles: { zh: ['我在这里。'], en: ['I am here.'] } },
      { level: 3, expressions: ['happy'], idleActions: ['sparkle'], bubbles: { zh: ['今天也一起加油。'], en: ["Let's make progress today."] } },
    ],
  }
}
