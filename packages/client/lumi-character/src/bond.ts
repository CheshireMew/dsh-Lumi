/** Versioned, bounded local progression state stored as one settings value. */

/** Current durable progression record version. */
export const LUMI_BOND_SCHEMA_VERSION = 1 as const
/** Maximum exact positive-feedback identities retained for duplicate suppression. */
export const LUMI_BOND_FEEDBACK_RETENTION = 256
/** Points required for each unbounded bond level. */
export const LUMI_BOND_POINTS_PER_LEVEL = 30

/** One atomic durable record for Lumi progression. */
export interface LumiBondRecord {
  schemaVersion: typeof LUMI_BOND_SCHEMA_VERSION
  points: number
  lastActiveDay: string
  streak: number
  dailyTurnDay: string
  dailyTurnCount: number
  firstSuccessDay: string
  positiveAwardDay: string
  creditedPositiveFeedback: string[]
}

/** Empty progression state for a new profile. */
export const DEFAULT_LUMI_BOND: LumiBondRecord = Object.freeze({
  schemaVersion: LUMI_BOND_SCHEMA_VERSION,
  points: 0,
  lastActiveDay: '',
  streak: 0,
  dailyTurnDay: '',
  dailyTurnCount: 0,
  firstSuccessDay: '',
  positiveAwardDay: '',
  creditedPositiveFeedback: [],
})

/** Legacy top-level fields removed after the atomic bond record became authoritative. */
export const LEGACY_LUMI_BOND_FIELDS = Object.freeze([
  'bondPoints',
  'bondLastActiveDay',
  'bondStreak',
  'bondDailyTurnDay',
  'bondDailyTurnCount',
  'bondFirstSuccessDay',
  'bondPositiveAwardDay',
  'bondPositiveAwardedToday',
  'bondCreditedTurns',
  'bondCreditedFeedback',
] as const)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function natural(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function retainedFeedback(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const unique = [...new Set(value.filter((item): item is string => typeof item === 'string' && item !== ''))]
  return unique.slice(-LUMI_BOND_FEEDBACK_RETENTION)
}

/**
 * Convert the pre-record user layer once, before removing its top-level fields.
 * Invalid persisted values fall back field-by-field because this is a durable
 * input boundary; the resulting record always satisfies the current schema.
 * @param userLayer - raw namespace user layer supplied by the settings scope.
 * @returns a bounded record when legacy fields are present and `bond` is absent.
 */
export function migrateLegacyLumiBond(userLayer: unknown): LumiBondRecord | undefined {
  if (!isRecord(userLayer) || Object.hasOwn(userLayer, 'bond')) return undefined
  if (!LEGACY_LUMI_BOND_FIELDS.some(field => Object.hasOwn(userLayer, field))) return undefined
  return {
    schemaVersion: LUMI_BOND_SCHEMA_VERSION,
    points: natural(userLayer['bondPoints']),
    lastActiveDay: text(userLayer['bondLastActiveDay']),
    streak: natural(userLayer['bondStreak']),
    dailyTurnDay: text(userLayer['bondDailyTurnDay']),
    dailyTurnCount: Math.min(10, natural(userLayer['bondDailyTurnCount'])),
    firstSuccessDay: text(userLayer['bondFirstSuccessDay']),
    positiveAwardDay: text(userLayer['bondPositiveAwardDay']),
    creditedPositiveFeedback: retainedFeedback(userLayer['bondCreditedFeedback']),
  }
}

/**
 * Resolve the local date used for daily caps and streaks.
 * @param now - date to project in the current system timezone.
 * @returns a local `YYYY-MM-DD` key.
 */
export function localDateKey(now = new Date()): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function consecutive(previous: string, candidate: string): boolean {
  const parse = (value: string): number | undefined => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
    return match === null ? undefined : Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  }
  const a = parse(previous)
  const b = parse(candidate)
  return a !== undefined && b !== undefined && b - a === 86_400_000
}

/**
 * Credit completed turns observed after the current session baseline.
 * @param current - current durable bond record.
 * @param count - number of newly completed turns.
 * @param today - local day key used for caps and streaks.
 * @returns the next record, or the original reference when count is zero.
 */
export function creditLumiTurns(current: LumiBondRecord, count: number, today: string): LumiBondRecord {
  if (!Number.isSafeInteger(count) || count <= 0) return current
  let next = current
  for (let index = 0; index < count; index += 1) {
    const dailyCount = next.dailyTurnDay === today ? next.dailyTurnCount : 0
    const firstToday = next.firstSuccessDay !== today
    const streak = firstToday
      ? next.lastActiveDay === today
        ? next.streak
        : consecutive(next.lastActiveDay, today) ? next.streak + 1 : 1
      : next.streak
    next = {
      ...next,
      points: next.points + (dailyCount < 10 ? 2 : 0) + (firstToday ? 3 : 0),
      lastActiveDay: firstToday ? today : next.lastActiveDay,
      streak,
      dailyTurnDay: today,
      dailyTurnCount: Math.min(10, dailyCount + 1),
      firstSuccessDay: firstToday ? today : next.firstSuccessDay,
    }
  }
  return next
}

/**
 * Record one positive message identity and apply the once-per-day award.
 * @param current - current durable bond record.
 * @param messageId - stable session and message identity.
 * @param today - local day key used for the daily award.
 * @returns the next record, or the original reference for a retained duplicate.
 */
export function creditLumiPositiveFeedback(
  current: LumiBondRecord,
  messageId: string,
  today: string,
): LumiBondRecord {
  if (current.creditedPositiveFeedback.includes(messageId)) return current
  const awarded = current.positiveAwardDay === today
  return {
    ...current,
    points: current.points + (awarded ? 0 : 5),
    positiveAwardDay: awarded ? current.positiveAwardDay : today,
    creditedPositiveFeedback: [
      ...current.creditedPositiveFeedback,
      messageId,
    ].slice(-LUMI_BOND_FEEDBACK_RETENTION),
  }
}

/**
 * Determine the unbounded level from accumulated points.
 * @param points - accumulated local bond points.
 * @returns a one-based bond level.
 */
export function bondLevel(points: number): number {
  return Math.floor(Math.max(0, points) / LUMI_BOND_POINTS_PER_LEVEL) + 1
}
