import type { Context } from '@deepseek-ai/cordis'
import { AttachmentError, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { contentHasImage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { PromptContentPart } from '@deepseek-ai/dsh-api-protocol/api'

/** Decode the browser payload while rejecting non-canonical base64 forms. */
function decodeBase64(data: string): Uint8Array {
  const decoded = Buffer.from(data, 'base64')
  if (data.length === 0 || decoded.toString('base64') !== data) {
    throw new AttachmentError('Image upload is not canonical base64.', 'INVALID_IMAGE_BASE64')
  }
  return new Uint8Array(decoded)
}

/**
 * Validate one prompt as a batch before publishing any durable image object.
 * @param ctx - Host context carrying the attachment provider.
 * @param content - Browser prompt parts to validate and persist.
 * @returns Durable model content blocks.
 */
export async function durablePromptContent(
  ctx: Context,
  content: readonly PromptContentPart[],
): Promise<ContentBlock[]> {
  if (content.every(part => part.type === 'text')) {
    return content.map(part => ({ type: 'text', text: part.text }))
  }
  const limits = ctx.attachments.imageLimits
  if (content.filter(part => part.type === 'image').length > limits.maxImagesPerMessage) {
    throw new AttachmentError('Prompt exceeds the configured image-count limit.', 'TOO_MANY_IMAGES')
  }
  const prepared = content.map(part => part.type === 'text'
    ? part
    : { part, data: decodeBase64(part.data) })
  const images = prepared.filter((part): part is Extract<typeof part, { data: Uint8Array }> => 'data' in part)
  const totalBytes = images.reduce((sum, image) => sum + image.data.byteLength, 0)
  if (totalBytes > limits.maxMessageImageBytes) {
    throw new AttachmentError('Prompt exceeds the configured aggregate image-byte limit.', 'IMAGES_TOO_LARGE')
  }
  for (const image of images) {
    await ctx.attachments.validateImage({
      data: image.data,
      mediaType: image.part.mediaType,
      ...image.part.name === undefined ? {} : { name: image.part.name },
    })
  }
  const blocks: ContentBlock[] = []
  for (const item of prepared) {
    if (!('data' in item)) {
      blocks.push({ type: 'text', text: item.text })
      continue
    }
    const attachment = await ctx.attachments.saveImage({
      data: item.data,
      mediaType: item.part.mediaType,
      ...item.part.name === undefined ? {} : { name: item.part.name },
    })
    blocks.push({ type: 'image', attachment })
  }
  return blocks
}

/** Search durable content for an image reference, including nested tool results. */
function imageBlockIn(
  content: unknown,
  match: (ref: ImageAttachmentRef) => boolean,
): ImageAttachmentRef | undefined {
  if (!Array.isArray(content)) return undefined
  for (const value of content) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const block = value as { type?: unknown; attachment?: unknown; content?: unknown }
    if (block.type === 'image' && typeof block.attachment === 'object' && block.attachment !== null) {
      const ref = block.attachment as ImageAttachmentRef
      if (match(ref)) return ref
    }
    if (block.type === 'tool-result') {
      const nested = imageBlockIn(block.content, match)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/** Search every durable event carrier that can own model-visible content. */
function imageInEvent(
  event: SessionEvent,
  match: (ref: ImageAttachmentRef) => boolean,
): ImageAttachmentRef | undefined {
  const data = event.data as {
    content?: unknown
    message?: { content?: unknown }
    inserted?: Array<{ content?: unknown }>
    chunk?: { type?: unknown; block?: unknown }
  }
  const direct = imageBlockIn(data.content, match)
  if (direct !== undefined) return direct
  if (data.message !== undefined) {
    const wrapped = imageBlockIn(data.message.content, match)
    if (wrapped !== undefined) return wrapped
  }
  if (data.inserted !== undefined) {
    for (const message of data.inserted) {
      const inserted = imageBlockIn(message.content, match)
      if (inserted !== undefined) return inserted
    }
  }
  if (event.type === 'assistant/chunk' && data.chunk?.type === 'block-end') {
    return imageBlockIn([data.chunk.block], match)
  }
  return undefined
}

/**
 * Test whether the current model-visible surface contains an image.
 * @param messages - Messages to inspect recursively.
 * @returns Whether any message contains an image.
 */
export function messagesHaveImage(messages: readonly { content: readonly ContentBlock[] }[]): boolean {
  return messages.some(message => contentHasImage(message.content))
}

/**
 * Resolve the first image reference matching one opaque id.
 * @param events - Durable session events to scan.
 * @param attachmentId - Opaque attachment identity to match.
 * @returns The matching image reference, when present.
 */
export function referencedImage(
  events: readonly SessionEvent[],
  attachmentId: string,
): ImageAttachmentRef | undefined {
  for (const event of events) {
    const found = imageInEvent(event, ref => String(ref.attachmentId) === attachmentId)
    if (found !== undefined) return found
  }
  return undefined
}

/** Strict browser-zone profile: UTC or an IANA Area/Location-style identifier. */
const IANA_TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$/

/**
 * Validate and canonicalize one browser-supplied IANA zone at the wire boundary.
 * @param value - Browser-supplied time-zone identifier.
 * @returns Its canonical identifier, or undefined when invalid or unsupported.
 */
export function canonicalClientTimeZone(value: string): string | undefined {
  if (value.length === 0 || value.trim() !== value
    || (value !== 'UTC' && !IANA_TIME_ZONE.test(value))) return undefined
  try {
    const canonical = new Intl.DateTimeFormat('en-US', { timeZone: value })
      .resolvedOptions().timeZone
    /* v8 ignore next -- Intl returns UTC or a canonical IANA Area/Location for accepted input. */
    if (canonical !== 'UTC' && !IANA_TIME_ZONE.test(canonical)) return undefined
    return canonical
  } catch {
    // Intl rejects unsupported zone names; the RPC maps that parser rejection below.
    return undefined
  }
}

/**
 * Read live abort state across awaits without treating it as synchronously immutable.
 * @param signal - Operation lifetime to inspect.
 * @returns Whether cancellation has been requested.
 */
export function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}
