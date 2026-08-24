import { existsSync, readdirSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const SKIPPED_DIRECTORIES = new Set([
  '.artifacts', '.archive', '.cache', '.git', '.pnpm-store', '.sessions', '.storages',
  '.worktrees', 'artifacts', 'coverage', 'dist', 'dist-exe', 'lib', 'node_modules',
  'tmp', 'worktrees',
])

const SKIPPED_PREFIXES = ['.doc-typecheck-', '.node-next-types-', '.oxlint-contract-', '.typert-']

interface EmitPattern {
  readonly suffix: string
  readonly sourceExtensions: readonly string[]
}

const EMIT_PATTERNS: readonly EmitPattern[] = [
  { suffix: '.d.ts.map', sourceExtensions: ['.ts', '.tsx'] },
  { suffix: '.d.mts.map', sourceExtensions: ['.mts'] },
  { suffix: '.d.cts.map', sourceExtensions: ['.cts'] },
  { suffix: '.js.map', sourceExtensions: ['.ts', '.tsx'] },
  { suffix: '.jsx.map', sourceExtensions: ['.tsx'] },
  { suffix: '.mjs.map', sourceExtensions: ['.mts'] },
  { suffix: '.cjs.map', sourceExtensions: ['.cts'] },
  { suffix: '.d.ts', sourceExtensions: ['.ts', '.tsx'] },
  { suffix: '.d.mts', sourceExtensions: ['.mts'] },
  { suffix: '.d.cts', sourceExtensions: ['.cts'] },
  { suffix: '.js', sourceExtensions: ['.ts', '.tsx'] },
  { suffix: '.jsx', sourceExtensions: ['.tsx'] },
  { suffix: '.mjs', sourceExtensions: ['.mts'] },
  { suffix: '.cjs', sourceExtensions: ['.cts'] },
]

function repositoryPath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}

function isSkippedDirectory(name: string): boolean {
  return SKIPPED_DIRECTORIES.has(name) || SKIPPED_PREFIXES.some(prefix => name.startsWith(prefix))
}

function matchingSource(path: string): string | undefined {
  const pattern = EMIT_PATTERNS.find(candidate => path.endsWith(candidate.suffix))
  if (pattern === undefined) return undefined
  const stem = path.slice(0, -pattern.suffix.length)
  return pattern.sourceExtensions.map(extension => `${stem}${extension}`).find(existsSync)
}

/**
 * Find TypeScript outputs written beside their owning source files.
 * @param root Repository root to inspect.
 * @returns Repository-relative generated file paths.
 */
export function findSourceTreeEmits(root: string): string[] {
  const absoluteRoot = resolve(root)
  const found: string[] = []
  const pending = [absoluteRoot]
  while (pending.length > 0) {
    const directory = pending.pop()
    if (directory === undefined) break
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (!isSkippedDirectory(entry.name)) pending.push(path)
        continue
      }
      if (entry.isFile() && matchingSource(path) !== undefined) found.push(repositoryPath(absoluteRoot, path))
    }
  }
  return found.sort()
}

const scriptPath = fileURLToPath(import.meta.url)
if (process.argv[1] !== undefined && resolve(process.argv[1]) === scriptPath) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const outputs = findSourceTreeEmits(root)
  if (outputs.length === 0) {
    console.log('verify-source-tree-clean: no TypeScript output is adjacent to its source file.')
  } else {
    console.error([
      'verify-source-tree-clean: TypeScript output was written beside source files:',
      ...outputs.map(path => `  ${path}`),
      'Use the repository build or typecheck scripts; do not run tsc against individual source files.',
    ].join('\n'))
    process.exitCode = 1
  }
}
