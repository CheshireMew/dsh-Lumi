/** Test-only plugin that keeps a profile Host alive until its process stops. */

/**
 * Announce activation and keep the event loop alive for cross-process ownership tests.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Loader-mounted plugin context.
 */
export function apply(ctx) {
  const keepAlive = setInterval(() => {}, 60_000)
  process.stderr.write('dsh-test: home lease ready\n')
  ctx.effect(() => () => { clearInterval(keepAlive) })
}
