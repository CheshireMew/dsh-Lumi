/** Package-owned invariant companion for `@dsh-lumi/client-shell`. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@dsh-lumi/client-shell'
/** Cordis companion plugin name. */
export const name = 'lumi-shell-invariant'
/** Service required before ownership registration. */
export const inject = ['invariants']
/**
 * No runtime invariant: this presentation-only frame owns no durable state or
 * event relationship beyond the layout slots and browser stores it consumes.
 */
const install: InvariantInstaller = () => {}
/** Register the package ownership companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
