/** Package-owned invariant companion for `@deepseek-ai/dsh-api-protocol`. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-api-protocol'

/** Cordis companion plugin name. */
export const name = 'api-protocol-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * The package owns immutable protocol declarations and carrier parsing. Runtime
 * relationships are asserted by the host implementation and connection packages.
 */
const install: InvariantInstaller = () => {
  // No runtime invariant: protocol declarations and carrier parsing own no mutable relationship.
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns The registration disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
