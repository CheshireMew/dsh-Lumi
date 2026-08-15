/**
 * Remove non-final Markdown structures before speech.
 * @param source Final assistant text.
 * @returns Clean prose without code, URLs, tables, or Markdown structure.
 */
export function speechText(source: string): string {
  return source
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/`[^`]*`/gu, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/https?:\/\/\S+/gu, ' ')
    .replace(/^\s*\|.*\|\s*$/gmu, ' ')
    .replace(/^\s*[-:| ]{3,}\s*$/gmu, ' ')
    .replace(/^[#>*+-]+\s*/gmu, '')
    .replace(/[*_~]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * Truncate automatic speech at a natural sentence boundary when possible.
 * @param source Final assistant text.
 * @param maxChars Maximum cleaned characters considered for automatic speech.
 * @returns Clean automatic-speech text within the configured bound.
 */
export function autoSpeechText(source: string, maxChars: number): string {
  const clean = speechText(source)
  if (clean.length <= maxChars) return clean
  const prefix = clean.slice(0, maxChars + 1)
  const minimum = Math.floor(maxChars * 0.55)
  let boundary = -1
  for (const match of prefix.matchAll(/[。！？.!?]/gu)) {
    if (match.index >= minimum) boundary = match.index + 1
  }
  return clean.slice(0, boundary > 0 ? boundary : maxChars).trim()
}
