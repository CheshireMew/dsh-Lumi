import z from '@deepseek-ai/schemastery'

/** Durable settings namespace shared by every Anime UI surface. */
export const UI_ANIME_SETTINGS_NAMESPACE = 'ui-anime'
/** Always-available original placeholder pack. */
export const BUILTIN_PACK_ID = 'builtin-lumi'

/** User-selected desktop layout. */
export type AnimeLayoutMode = 'scene' | 'work'
/** Animation policy independent of the operating-system preference. */
export type AnimeMotionPreference = 'system' | 'full' | 'reduced'

/** Preferences and local progression persisted in the Harness settings document. */
export interface UiAnimeSettings {
  layoutMode: AnimeLayoutMode
  characterVisible: boolean
  selectedPack: string
  motionPreference: AnimeMotionPreference
  panelOpacity: number
  backgroundBlur: number
  ttsEnabled: boolean
  ttsAutoRead: boolean
  ttsVoice: string
  ttsRate: number
  ttsPitch: number
  ttsVolume: number
  ttsMaxAutoChars: number
  bondPoints: number
  bondLastActiveDay: string
  bondStreak: number
  bondDailyTurnDay: string
  bondDailyTurnCount: number
  bondFirstSuccessDay: string
  bondPositiveAwardDay: string
  bondPositiveAwardedToday: boolean
  bondCreditedTurns: string[]
  bondCreditedFeedback: string[]
}

/** Durable defaults. Speech stays opt-in and motion follows the operating system. */
export const DEFAULT_UI_ANIME_SETTINGS: UiAnimeSettings = Object.freeze({
  layoutMode: 'scene',
  characterVisible: true,
  selectedPack: BUILTIN_PACK_ID,
  motionPreference: 'system',
  panelOpacity: 0.84,
  backgroundBlur: 24,
  ttsEnabled: false,
  ttsAutoRead: false,
  ttsVoice: '',
  ttsRate: 1,
  ttsPitch: 1,
  ttsVolume: 1,
  ttsMaxAutoChars: 1200,
  bondPoints: 0,
  bondLastActiveDay: '',
  bondStreak: 0,
  bondDailyTurnDay: '',
  bondDailyTurnCount: 0,
  bondFirstSuccessDay: '',
  bondPositiveAwardDay: '',
  bondPositiveAwardedToday: false,
  bondCreditedTurns: [],
  bondCreditedFeedback: [],
})

/** Host schema shared with the browser settings scope. */
export const UiAnimeSettingsSchema: z<UiAnimeSettings> = z.object({
  layoutMode: z.union(['scene', 'work']).default('scene'),
  characterVisible: z.boolean().default(true),
  selectedPack: z.string().default(BUILTIN_PACK_ID),
  motionPreference: z.union(['system', 'full', 'reduced']).default('system'),
  panelOpacity: z.number().min(0.65).max(1).default(0.84),
  backgroundBlur: z.number().min(0).max(48).default(24),
  ttsEnabled: z.boolean().default(false),
  ttsAutoRead: z.boolean().default(false),
  ttsVoice: z.string().default(''),
  ttsRate: z.number().min(0.5).max(2).default(1),
  ttsPitch: z.number().min(0.5).max(2).default(1),
  ttsVolume: z.number().min(0).max(1).default(1),
  ttsMaxAutoChars: z.natural().min(80).max(20_000).default(1200),
  bondPoints: z.natural().default(0),
  bondLastActiveDay: z.string().default(''),
  bondStreak: z.natural().default(0),
  bondDailyTurnDay: z.string().default(''),
  bondDailyTurnCount: z.natural().default(0),
  bondFirstSuccessDay: z.string().default(''),
  bondPositiveAwardDay: z.string().default(''),
  bondPositiveAwardedToday: z.boolean().default(false),
  bondCreditedTurns: z.array(z.string()).default([]),
  bondCreditedFeedback: z.array(z.string()).default([]),
})

/** Compatibility aliases for source callers while every product surface uses `ui-anime`. */
export type AnimeCharacterSettings = UiAnimeSettings
/** Compatibility alias of the current `ui-anime` defaults. */
export const DEFAULT_ANIME_CHARACTER_SETTINGS = DEFAULT_UI_ANIME_SETTINGS
/** Compatibility alias of the current `ui-anime` schema. */
export const AnimeCharacterSettingsSchema = UiAnimeSettingsSchema
/** Compatibility alias of the current `ui-anime` namespace. */
export const ANIME_CHARACTER_SETTINGS_NAMESPACE = UI_ANIME_SETTINGS_NAMESPACE
