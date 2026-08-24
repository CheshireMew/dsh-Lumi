/** Host loader entry for the browser runtime exported from `./client` and `./loader`. */

import z from '@deepseek-ai/schemastery'
import { DEFAULT_MAX_RESIDENT_SESSIONS } from './runtime-config.ts'

/** Browser runtime deployment configuration. */
export interface Config {
  /** Maximum fully materialized Session scopes retained in the browser. */
  maxResidentSessions?: number
}

/** Browser runtime configuration schema. */
export const Config: z<Config> = z.object({
  maxResidentSessions: z.number().step(1).min(1).default(DEFAULT_MAX_RESIDENT_SESSIONS),
})

/** Host plugin body — no host-side behavior for the runtime plugin. */
export function apply(_ctx: unknown, _config?: Config): void {}
