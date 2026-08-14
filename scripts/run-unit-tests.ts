/**
 * Run the unit-test inventory through bounded Windows Vitest processes.
 * Other platforms retain one canonical Vitest invocation; explicit test
 * filters also stay single-invocation so Vitest owns their ordinary CLI
 * semantics.
 */
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const WINDOWS_SHARD_COUNT = 8

/**
 * Build the pnpm argument lists used for one public `pnpm test` invocation.
 * @param platform - host platform selecting the Windows sharded path.
 * @param forwarded - explicit Vitest arguments supplied after `pnpm test`.
 * @returns ordered pnpm argument lists; Windows's default run has eight shards.
 */
export function unitTestInvocations(platform: NodeJS.Platform, forwarded: readonly string[]): string[][] {
  const base = ['exec', 'vitest', 'run']
  if (platform !== 'win32' || forwarded.length > 0) return [[...base, ...forwarded]]
  return Array.from({ length: WINDOWS_SHARD_COUNT }, (_, index) => [
    ...base,
    `--shard=${index + 1}/${WINDOWS_SHARD_COUNT}`,
  ])
}

function runUnitTests(): void {
  const pnpmEntry = process.env.npm_execpath
  if (pnpmEntry === undefined || pnpmEntry === '') {
    throw new Error('run-unit-tests: npm_execpath is unavailable; invoke through pnpm test')
  }
  for (const args of unitTestInvocations(process.platform, process.argv.slice(2))) {
    const result = spawnSync(process.execPath, [pnpmEntry, ...args], {
      cwd: resolve(import.meta.dirname, '..'),
      env: process.env,
      shell: false,
      stdio: 'inherit',
    })
    if (result.error !== undefined) throw result.error
    if (result.status !== 0) process.exit(result.status ?? 1)
  }
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) runUnitTests()
