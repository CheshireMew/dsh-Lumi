/** Package-owned invariant companion for `@deepseek-ai/dsh-client-api-testkit`. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-api-testkit'

/** Cordis companion plugin name. */
export const name = 'client-api-testkit-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']
const install: InvariantInstaller = () => {
  // No runtime invariant: deterministic test doubles own no mutable production relationship.
}

/** @param ctx - Context carrying the invariant service. @returns Registration disposer. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
