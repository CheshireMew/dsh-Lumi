import type { ContextPressureProjection } from '@deepseek-ai/dsh-token-meter/client'

/** Context occupancy values displayed by compact and expanded meters. */
export interface ContextOccupancy {
  percent: number
  usedTokens: number
  contextWindow: number
}

/**
 * Format a compact token count.
 * @param count - token count.
 * @returns compact display string.
 */
export function formatTokens(count: number): string {
  const scaled = (value: number): string =>
    value >= 100 ? String(Math.round(value)) : String(Math.round(value * 10) / 10)
  if (count < 1_000) return String(count)
  if (count < 1_000_000) return `${scaled(count / 1_000)}K`
  return `${scaled(count / 1_000_000)}M`
}

/**
 * Resolve approximate context occupancy from the latest pressure projection.
 * @param pressure - session context-pressure projection.
 * @returns occupancy values, or null until numerator and capacity are known.
 */
export function contextOccupancy(
  pressure: ContextPressureProjection | undefined,
): ContextOccupancy | null {
  const usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens
  if (usedTokens === undefined || pressure?.contextWindow === undefined) return null
  return {
    percent: Math.min(100, Math.round(usedTokens / pressure.contextWindow * 100)),
    usedTokens,
    contextWindow: pressure.contextWindow,
  }
}
