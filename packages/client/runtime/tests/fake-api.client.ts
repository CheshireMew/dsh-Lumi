export { FakeApiClient, deferred, err, ok } from '@deepseek-ai/dsh-client-api-testkit'

import type { SessionRemotes } from '../src/client/sessions/remotes.ts'

/**
 * Commands Remote double whose unprogrammed calls return an empty catalog and
 * a successfully handled command.
 * @returns The Remote namespaces used by the session runtime.
 */
export function fakeRemote(): SessionRemotes {
  return {
    commands: {
      list: () => Promise.resolve({ ok: true, value: [] }),
      execute: () => Promise.resolve({ ok: true, value: undefined }),
    },
  }
}
