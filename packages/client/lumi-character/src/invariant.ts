/** Package-owned invariant companion for `@dsh-lumi/client-character`. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@dsh-lumi/client-character'
/** Cordis companion plugin name. */
export const name = 'lumi-character-invariant'
/** Service required before ownership registration. */
export const inject = ['invariants']
/**
 * No runtime invariant: pack validation, settings persistence, and bond-ledger
 * ownership are exercised at their mutation boundaries and have no independent
 * cross-service relationship for the invariant reporter to observe.
 */
const install: InvariantInstaller = () => {}
/** Register the package ownership companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
