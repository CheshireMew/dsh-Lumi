import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_LUMI_BOND, LUMI_BOND_FEEDBACK_RETENTION, LUMI_BOND_SCHEMA_VERSION,
  type LumiBondRecord,
} from './bond.ts'

/** Durable settings namespace shared by every Lumi UI surface. */
export const UI_LUMI_SETTINGS_NAMESPACE = 'ui-lumi'
/** Always-available built-in Lumi pack. */
export const BUILTIN_PACK_ID = 'builtin-lumi'

/** User-selected desktop layout. */
export type LumiLayoutMode = 'scene' | 'work'
/** Animation policy independent of the operating-system preference. */
export type LumiMotionPreference = 'system' | 'full' | 'reduced'

/** Preferences and local progression persisted in the Harness settings document. */
export interface UiLumiSettings {
  layoutMode: LumiLayoutMode
  characterVisible: boolean
  selectedPack: string
  motionPreference: LumiMotionPreference
  panelOpacity: number
  backgroundBlur: number
  ttsEnabled: boolean
  ttsAutoRead: boolean
  ttsVoice: string
  ttsRate: number
  ttsPitch: number
  ttsVolume: number
  ttsMaxAutoChars: number
  bond: LumiBondRecord
}

/** Durable defaults. Speech stays opt-in and motion follows the operating system. */
export const DEFAULT_UI_LUMI_SETTINGS: UiLumiSettings = Object.freeze({
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
  bond: DEFAULT_LUMI_BOND,
})

/** Host schema shared with the browser settings scope. */
export const UiLumiSettingsSchema: z<UiLumiSettings> = z.object({
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
  bond: z.object({
    schemaVersion: z.const(LUMI_BOND_SCHEMA_VERSION).default(LUMI_BOND_SCHEMA_VERSION),
    points: z.natural().default(0),
    lastActiveDay: z.string().default(''),
    streak: z.natural().default(0),
    dailyTurnDay: z.string().default(''),
    dailyTurnCount: z.natural().max(10).default(0),
    firstSuccessDay: z.string().default(''),
    positiveAwardDay: z.string().default(''),
    creditedPositiveFeedback: z.array(z.string()).max(LUMI_BOND_FEEDBACK_RETENTION).default([]),
  }).default(DEFAULT_LUMI_BOND),
})

/** Compatibility aliases for source callers while every product surface uses `ui-lumi`. */
export type LumiCharacterSettings = UiLumiSettings
/** Compatibility alias of the current `ui-lumi` defaults. */
export const DEFAULT_LUMI_CHARACTER_SETTINGS = DEFAULT_UI_LUMI_SETTINGS
/** Compatibility alias of the current `ui-lumi` schema. */
export const LumiCharacterSettingsSchema = UiLumiSettingsSchema
/** Compatibility alias of the current `ui-lumi` namespace. */
export const LUMI_CHARACTER_SETTINGS_NAMESPACE = UI_LUMI_SETTINGS_NAMESPACE
