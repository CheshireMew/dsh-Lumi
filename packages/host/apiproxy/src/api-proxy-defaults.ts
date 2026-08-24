import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type { SessionLogCompressionLevel } from './session-export.ts'
import type { SessionListingOptions } from './session-listing.ts'

/** Resolved model, project, native-open, and bounded-work defaults for the API proxy. */
export interface ApiProxyDefaults extends SessionListingOptions {
  /** Resolve the current default model for sessions whose log names none. */
  defaultModelSelection: () => ModelSelection
  /** Save a model selection as the deployment default when settings are available. */
  saveDefaultModelSelection?: (selection: ModelSelection) => Promise<void>
  /** Default project directory for new sessions whose create request carries no cwd. */
  cwd: string
  /** Native open-with-default-application implementation. */
  openPath?: (path: string, signal: AbortSignal) => Promise<void>
  /** Native text-editor handoff implementation. */
  openTextFile?: (path: string, signal: AbortSignal) => Promise<void>
  /** Validated DEFLATE level for session-log ZIP entries. */
  sessionExportCompressionLevel?: SessionLogCompressionLevel
  /** Maximum provider calls made by one session search. */
  sessionSearchProviderCallLimit?: number
  /** Maximum undelivered frames retained by each Host event stream. */
  eventQueueCapacity?: number
  /** Report whether native path handoff is available. */
  canOpenPath?: () => boolean
}
