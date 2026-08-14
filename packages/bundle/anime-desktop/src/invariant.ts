/** Package-owned invariant companion for `@dsh-anime/bundle-desktop`. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@dsh-anime/bundle-desktop'
/** Cordis companion plugin name. */
export const name = 'anime-desktop-bundle-invariant'
/** Service required before ownership registration. */
export const inject = ['invariants']
/**
 * No runtime invariant: this additive profile bundle is a static composition
 * manifest and owns no data or event relationship after its rows are mounted.
 */
const install: InvariantInstaller = () => {}
/** Register bundle ownership. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
