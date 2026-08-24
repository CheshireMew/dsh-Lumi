/** Verify the maintained downstream patch inventory against the recorded official tree. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = resolve(root, '.upstream-patches.json')

/** One explicit downstream patch retained over official DeepSeek Harness. */
export interface UpstreamPatch {
  readonly id: string
  readonly title: string
  readonly reason: string
  readonly paths: readonly string[]
  readonly validation: readonly string[]
  readonly retirement: string
  readonly reviewedThrough: string
  readonly lastOutcome: 'retain' | 'reapply' | 'refactor' | 'retire'
  readonly reviewNote: string
}

/** One exact pre-policy file state preserved until it receives a semantic patch entry. */
export interface LegacyUpstreamBaselineEntry {
  readonly path: string
  readonly sha256: string
}

/** Root manifest for explicit patches and frozen pre-policy differences. */
export interface UpstreamPatchManifest {
  readonly schemaVersion: 1
  readonly upstreamBase: string
  readonly patches: readonly UpstreamPatch[]
  readonly legacyBaseline: readonly LegacyUpstreamBaselineEntry[]
}

function normalized(path: string): string {
  return path.replaceAll('\\', '/')
}

function git(args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
  }).trim()
}

function gitPaths(args: readonly string[]): string[] {
  const output = execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
  })
  return output.split('\0').filter(Boolean).map(normalized)
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`verify-upstream-patches: ${field} must be a non-empty string array`)
  }
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item === '') {
      throw new Error(`verify-upstream-patches: ${field} must be a non-empty string array`)
    }
    result.push(item)
  }
  return result
}

/**
 * Match one exact path or directory selector ending in `/**`.
 * @param path - Repository-relative normalized path.
 * @param selector - Exact path or directory prefix selector.
 * @returns Whether the selector owns the path.
 */
export function matchesUpstreamPatchPath(path: string, selector: string): boolean {
  if (selector.endsWith('/**')) return path.startsWith(selector.slice(0, -2))
  return path === selector
}

/**
 * Return patch ids whose owned paths changed in an official commit range.
 * @param patches - Maintained downstream patches.
 * @param upstreamPaths - Paths changed by the official repository.
 * @returns Stable patch ids in manifest order.
 */
export function touchedUpstreamPatchIds(
  patches: readonly UpstreamPatch[],
  upstreamPaths: readonly string[],
): string[] {
  return patches
    .filter(patch => upstreamPaths.some(path => patch.paths.some(selector => matchesUpstreamPatchPath(path, selector))))
    .map(patch => patch.id)
}

/**
 * Parse and validate the downstream patch manifest.
 * @param path - Manifest path, defaulting to the repository root manifest.
 * @returns Validated manifest data.
 */
export function readUpstreamPatchManifest(path = manifestPath): UpstreamPatchManifest {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  if (raw.schemaVersion !== 1) throw new Error('verify-upstream-patches: schemaVersion must be 1')
  if (typeof raw.upstreamBase !== 'string' || raw.upstreamBase === '') {
    throw new Error('verify-upstream-patches: upstreamBase must be a non-empty string')
  }
  if (!Array.isArray(raw.patches) || !Array.isArray(raw.legacyBaseline)) {
    throw new Error('verify-upstream-patches: patches and legacyBaseline must be arrays')
  }
  const ids = new Set<string>()
  const patches = raw.patches.map((value, index): UpstreamPatch => {
    if (typeof value !== 'object' || value === null) throw new Error(`verify-upstream-patches: patches[${index}] must be an object`)
    const patch = value as Record<string, unknown>
    const id = patch.id
    if (typeof id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id)) {
      throw new Error(`verify-upstream-patches: patches[${index}].id must be kebab-case`)
    }
    if (ids.has(id)) throw new Error(`verify-upstream-patches: duplicate patch id ${id}`)
    ids.add(id)
    const scalarFields = ['title', 'reason', 'retirement', 'reviewedThrough', 'reviewNote'] as const
    for (const field of scalarFields) {
      if (typeof patch[field] !== 'string' || patch[field] === '') {
        throw new Error(`verify-upstream-patches: patch ${id}.${field} must be a non-empty string`)
      }
    }
    if (!['retain', 'reapply', 'refactor', 'retire'].includes(String(patch.lastOutcome))) {
      throw new Error(`verify-upstream-patches: patch ${id}.lastOutcome is invalid`)
    }
    const paths = stringArray(patch.paths, `patch ${id}.paths`)
    for (const selector of paths) {
      if (selector.includes('*') && !selector.endsWith('/**')) {
        throw new Error(`verify-upstream-patches: patch ${id} selector ${selector} must be exact or end in /**`)
      }
      if (selector.startsWith('vendor/')) {
        throw new Error(`verify-upstream-patches: patch ${id} cannot own vendored path ${selector}`)
      }
    }
    return {
      id,
      title: patch.title as string,
      reason: patch.reason as string,
      paths,
      validation: stringArray(patch.validation, `patch ${id}.validation`),
      retirement: patch.retirement as string,
      reviewedThrough: patch.reviewedThrough as string,
      lastOutcome: patch.lastOutcome as UpstreamPatch['lastOutcome'],
      reviewNote: patch.reviewNote as string,
    }
  })
  const legacyPaths = new Set<string>()
  const legacyBaseline = raw.legacyBaseline.map((value, index): LegacyUpstreamBaselineEntry => {
    if (typeof value !== 'object' || value === null) {
      throw new Error(`verify-upstream-patches: legacyBaseline[${index}] must be an object`)
    }
    const entry = value as Record<string, unknown>
    if (typeof entry.path !== 'string' || entry.path === '' || entry.path.startsWith('vendor/')) {
      throw new Error(`verify-upstream-patches: legacyBaseline[${index}].path is invalid`)
    }
    if (typeof entry.sha256 !== 'string' || !/^(?:deleted|[0-9a-f]{64})$/u.test(entry.sha256)) {
      throw new Error(`verify-upstream-patches: legacyBaseline[${index}].sha256 is invalid`)
    }
    if (legacyPaths.has(entry.path)) throw new Error(`verify-upstream-patches: duplicate legacy path ${entry.path}`)
    legacyPaths.add(entry.path)
    return { path: entry.path, sha256: entry.sha256 }
  })
  return {
    schemaVersion: 1,
    upstreamBase: raw.upstreamBase,
    patches,
    legacyBaseline,
  }
}

function fileHash(path: string): string {
  const absolute = resolve(root, path)
  if (!existsSync(absolute)) return 'deleted'
  return createHash('sha256').update(readFileSync(absolute)).digest('hex')
}

function currentDeviationPaths(base: string): string[] {
  return [...new Set([
    ...gitPaths(['diff', '--name-only', '-z', `${base}...HEAD`]),
    ...gitPaths(['diff', '--name-only', '-z', 'HEAD']),
    ...gitPaths(['ls-files', '--others', '--exclude-standard', '-z']),
  ])].sort()
}

function upstreamOwnedPackageRoots(basePaths: ReadonlySet<string>): string[] {
  return [...basePaths]
    .filter(path => /^packages\/[^/]+\/[^/]+\/package\.json$/u.test(path))
    .map(path => path.slice(0, -'package.json'.length))
}

function downstreamDshPackageRoots(): string[] {
  return gitPaths(['ls-files', '-co', '--exclude-standard', '-z', 'packages/*/*/package.json'])
    .filter((path) => {
      if (!existsSync(resolve(root, path))) return false
      const manifest = JSON.parse(readFileSync(resolve(root, path), 'utf8')) as { name?: string }
      return manifest.name?.startsWith('@deepseek-ai/dsh-') === true
    })
    .map(path => path.slice(0, -'package.json'.length))
}

function governedDeviationPaths(manifest: UpstreamPatchManifest): string[] {
  const basePaths = new Set(gitPaths(['ls-tree', '-r', '--name-only', '-z', manifest.upstreamBase]))
  const upstreamPackageRoots = upstreamOwnedPackageRoots(basePaths)
  const dshPackageRoots = downstreamDshPackageRoots()
  const legacyPaths = new Set(manifest.legacyBaseline.map(entry => entry.path))
  return currentDeviationPaths(manifest.upstreamBase).filter((path) => {
    if (path.startsWith('vendor/')) return false
    return basePaths.has(path)
      || upstreamPackageRoots.some(prefix => path.startsWith(prefix))
      || dshPackageRoots.some(prefix => path.startsWith(prefix))
      || manifest.patches.some(patch => patch.paths.some(selector => matchesUpstreamPatchPath(path, selector)))
      || legacyPaths.has(path)
  })
}

function writeLegacyBaseline(manifest: UpstreamPatchManifest): void {
  const entries = governedDeviationPaths(manifest)
    .filter(path => !manifest.patches.some(patch => patch.paths.some(selector => matchesUpstreamPatchPath(path, selector))))
    .map(path => ({ path, sha256: fileHash(path) }))
  const updated: UpstreamPatchManifest = { ...manifest, legacyBaseline: entries }
  writeFileSync(manifestPath, `${JSON.stringify(updated, undefined, 2)}\n`, 'utf8')
  console.log(`verify-upstream-patches: recorded ${entries.length} frozen legacy path(s).`)
}

function reviewViolations(manifest: UpstreamPatchManifest, currentBase: string): string[] {
  const violations: string[] = []
  for (const patch of manifest.patches) {
    git(['cat-file', '-e', `${patch.reviewedThrough}^{commit}`])
    const changed = patch.reviewedThrough === currentBase
      ? []
      : gitPaths(['diff', '--name-only', '-z', `${patch.reviewedThrough}..${currentBase}`])
    if (changed.some(path => patch.paths.some(selector => matchesUpstreamPatchPath(path, selector)))) {
      violations.push(`patch ${patch.id} was touched upstream after ${patch.reviewedThrough}; record its ${currentBase} review outcome`)
    }
  }
  return violations
}

function verifyManifest(manifest: UpstreamPatchManifest): string[] {
  const violations: string[] = []
  const currentBase = git(['rev-parse', manifest.upstreamBase])
  violations.push(...reviewViolations(manifest, currentBase))
  const deviations = new Set(governedDeviationPaths(manifest))
  const active = new Set<string>()
  for (const path of deviations) {
    if (manifest.patches.some(patch => patch.paths.some(selector => matchesUpstreamPatchPath(path, selector)))) {
      active.add(path)
    }
  }
  const baseline = new Map(manifest.legacyBaseline.map(entry => [entry.path, entry.sha256]))
  for (const path of deviations) {
    if (active.has(path)) continue
    const expected = baseline.get(path)
    if (expected === undefined) violations.push(`${path}: unregistered upstream-owned change`)
    else if (fileHash(path) !== expected) violations.push(`${path}: frozen legacy content changed; promote it to an active patch or refresh after review`)
  }
  for (const [path] of baseline) {
    if (!deviations.has(path)) violations.push(`${path}: stale legacy baseline entry; upstream or local cleanup removed the difference`)
    if (active.has(path)) violations.push(`${path}: active patch path must not remain in legacyBaseline`)
  }
  for (const patch of manifest.patches) {
    if (![...deviations].some(path => patch.paths.some(selector => matchesUpstreamPatchPath(path, selector)))) {
      violations.push(`patch ${patch.id}: no current downstream difference matches its owned paths`)
    }
  }
  return violations
}

function main(argv: readonly string[]): void {
  const supported = new Set(['--write-baseline'])
  for (const arg of argv) if (!supported.has(arg)) throw new Error(`verify-upstream-patches: unknown argument ${arg}`)
  const manifest = readUpstreamPatchManifest()
  if (argv.includes('--write-baseline')) {
    writeLegacyBaseline(manifest)
    return
  }
  const violations = verifyManifest(manifest)
  if (violations.length > 0) {
    console.error(`verify-upstream-patches: ${violations.length} violation(s):`)
    for (const violation of violations) console.error(`  ${violation}`)
    process.exitCode = 1
    return
  }
  console.log(`verify-upstream-patches: ${manifest.patches.length} active patch(es) and ${manifest.legacyBaseline.length} frozen legacy path(s) accounted for.`)
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main(process.argv.slice(2))
