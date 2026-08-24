/**
 * Prevent package cycles, oversized source regressions, oversized repaired
 * symbols, scattered product versions, and client colors outside ui-theme.
 */
import { globSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')
const GENERAL_SOURCE_LINE_LIMIT = 1_000

interface SourceBudgetException {
  readonly maxLines: number
  readonly reason: string
}

/** Existing cohesive or data-heavy modules whose ownership does not improve by arbitrary splitting. */
const SOURCE_BUDGET_EXCEPTIONS = new Map<string, SourceBudgetException>([
  ['packages/client/connection/src/client/fixture.ts', { maxLines: 3_500, reason: 'deterministic standalone UI fixture data' }],
  ['packages/core/tools/src/index.ts', { maxLines: 2_100, reason: 'single tool execution pipeline service definition' }],
  ['packages/subagent/subagent/src/continuation.ts', { maxLines: 1_600, reason: 'single continuable-subagent lifecycle manager' }],
  ['packages/session/session-persistence/src/coordinator.ts', { maxLines: 1_600, reason: 'single persistence lifecycle coordinator' }],
  ['packages/extensions/cordis-host-runner/src/index.ts', { maxLines: 1_500, reason: 'single dynamic plugin lifecycle service' }],
  ['packages/client/ui-slots/src/index.ts', { maxLines: 1_300, reason: 'single slot registry core and its public declarations' }],
  ['packages/client/runtime/src/client/sessions/manager.ts', { maxLines: 1_300, reason: 'single client session manager' }],
  ['packages/core/session/src/index.ts', { maxLines: 1_200, reason: 'single event-sourced session service definition' }],
  ['packages/client/ui-trajectory/src/client/layout.ts', { maxLines: 1_200, reason: 'single trajectory fold and layout projection' }],
  ['packages/session/session-persistence-jsonl/src/index.ts', { maxLines: 1_200, reason: 'single JSONL persistence provider' }],
  ['packages/session-query/session-query-sqlite/src/index.ts', { maxLines: 1_200, reason: 'single SQLite query provider' }],
  ['packages/typert/generator/src/cordis-catalog.ts', { maxLines: 1_200, reason: 'single Cordis catalog projection' }],
  ['packages/skill/skill-filesystem/src/index.ts', { maxLines: 1_100, reason: 'single filesystem skill provider' }],
])

interface SymbolBudget {
  readonly file: string
  readonly name: string
  readonly kind: 'class' | 'function'
  readonly maxLines: number
}

/** Repaired hotspots retain a tighter budget than the general source ceiling. */
const SYMBOL_BUDGETS: readonly SymbolBudget[] = [
  { file: 'packages/host/apiproxy/src/api-proxy.ts', name: 'createApiProxy', kind: 'function', maxLines: 350 },
  { file: 'packages/typert/generator/src/analyzer.ts', name: 'FaceAnalyzer', kind: 'class', maxLines: 450 },
  { file: 'packages/client/ui-trajectory/src/client/TrajectoryTable.tsx', name: 'TrajectoryTable', kind: 'function', maxLines: 500 },
  { file: 'packages/client/ui-directory-picker-browse/src/client/DirectoryBrowser.tsx', name: 'DirectoryBrowser', kind: 'function', maxLines: 500 },
  { file: 'packages/client/ui-conversation/src/client/skeleton/InputBar.tsx', name: 'InputBar', kind: 'function', maxLines: 400 },
  { file: 'packages/client/ui-workspace/src/client/WorkspaceBrowser.tsx', name: 'WorkspaceBrowser', kind: 'function', maxLines: 700 },
]

/** ANSI rendering intentionally converts protocol RGB triplets to CSS colors at runtime. */
const COLOR_LITERAL_EXCEPTIONS = new Set([
  'packages/client/ui-primitives/src/ansi.ts',
])

export interface PackageManifestInput {
  readonly name: string
  readonly dependencies?: Readonly<Record<string, string>>
  readonly optionalDependencies?: Readonly<Record<string, string>>
}

/**
 * Find cycles across production workspace dependency edges.
 * @param manifests - Workspace manifests keyed by package name.
 * @returns One closed package-name path for every discovered back edge.
 */
export function findDependencyCycles(
  manifests: ReadonlyMap<string, PackageManifestInput>,
): string[][] {
  const state = new Map<string, 'visiting' | 'visited'>()
  const stack: string[] = []
  const cycles: string[][] = []
  const seen = new Set<string>()
  const visit = (name: string): void => {
    if (state.get(name) === 'visited') return
    if (state.get(name) === 'visiting') return
    state.set(name, 'visiting')
    stack.push(name)
    const manifest = manifests.get(name)
    const edges = new Set([
      ...Object.keys(manifest?.dependencies ?? {}),
      ...Object.keys(manifest?.optionalDependencies ?? {}),
    ])
    for (const dependency of edges) {
      if (!manifests.has(dependency)) continue
      if (state.get(dependency) === 'visiting') {
        const start = stack.indexOf(dependency)
        const cycle = [...stack.slice(start), dependency]
        const members = cycle.slice(0, -1).sort().join('\0')
        if (!seen.has(members)) {
          seen.add(members)
          cycles.push(cycle)
        }
      } else visit(dependency)
    }
    stack.pop()
    state.set(name, 'visited')
  }
  for (const name of manifests.keys()) visit(name)
  return cycles
}

/**
 * Return literal color tokens after removing prose comments.
 * @param source - TypeScript, TSX, or CSS source.
 * @returns Literal colors that should be owned by ui-theme instead.
 */
export function literalColors(source: string): string[] {
  const uncommented = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  return [...uncommented.matchAll(/#[0-9a-f]{3,8}\b|(?:rgb|hsl)a?\s*\(/gi)]
    .map(match => match[0])
}

/**
 * Measure a named top-level class or function.
 * @param source - TypeScript or TSX source.
 * @param name - Declaration name.
 * @param kind - Expected declaration kind.
 * @param tsx - Whether JSX parsing is enabled.
 * @returns Inclusive declaration line count, or undefined when absent.
 */
export function symbolLineCount(
  source: string,
  name: string,
  kind: SymbolBudget['kind'],
  tsx = false,
): number | undefined {
  const file = ts.createSourceFile(
    tsx ? 'source.tsx' : 'source.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const declaration = file.statements.find((statement) => {
    if (kind === 'class') return ts.isClassDeclaration(statement) && statement.name?.text === name
    return ts.isFunctionDeclaration(statement) && statement.name?.text === name
  })
  if (declaration === undefined) return undefined
  const start = file.getLineAndCharacterOfPosition(declaration.getStart(file)).line
  const end = file.getLineAndCharacterOfPosition(declaration.end).line
  return end - start + 1
}

function normalized(path: string): string {
  return path.split(sep).join('/')
}

function sourceLines(source: string): number {
  return source === '' ? 0 : source.split(/\r?\n/).length
}

function architectureViolations(): string[] {
  const violations: string[] = []
  const manifests = new Map<string, PackageManifestInput>()
  for (const path of globSync('packages/*/*/package.json', { cwd: root })) {
    const manifest = JSON.parse(readFileSync(resolve(root, path), 'utf8')) as PackageManifestInput
    manifests.set(manifest.name, manifest)
  }
  for (const cycle of findDependencyCycles(manifests)) {
    violations.push(`workspace dependency cycle: ${cycle.join(' -> ')}`)
  }

  for (const rawPath of globSync('packages/*/*/src/**/*.{ts,tsx}', { cwd: root })) {
    const path = normalized(rawPath)
    if (path.startsWith('packages/test-support/')) continue
    const source = readFileSync(resolve(root, rawPath), 'utf8')
    if (/Generated by scripts\//.test(source.slice(0, 300))) continue
    const budget = SOURCE_BUDGET_EXCEPTIONS.get(path)
    const limit = budget?.maxLines ?? GENERAL_SOURCE_LINE_LIMIT
    const lines = sourceLines(source)
    if (lines > limit) {
      violations.push(`${path}: ${lines} lines exceeds ${limit}${budget === undefined ? '' : ` (${budget.reason})`}`)
    }
    if (/['"]0\.0\.1['"]/.test(source)) {
      violations.push(`${path}: hardcoded product version 0.0.1; import @deepseek-ai/dsh-product-identity`)
    }
  }

  for (const budget of SYMBOL_BUDGETS) {
    const source = readFileSync(resolve(root, budget.file), 'utf8')
    const lines = symbolLineCount(source, budget.name, budget.kind, budget.file.endsWith('.tsx'))
    if (lines === undefined) violations.push(`${budget.file}: missing governed ${budget.kind} ${budget.name}`)
    else if (lines > budget.maxLines) {
      violations.push(`${budget.file}: ${budget.kind} ${budget.name} is ${lines} lines; limit ${budget.maxLines}`)
    }
  }

  for (const rawPath of globSync('packages/client/*/src/**/*.{ts,tsx,css}', { cwd: root })) {
    const path = normalized(rawPath)
    if (path.startsWith('packages/client/ui-theme/') || COLOR_LITERAL_EXCEPTIONS.has(path)) continue
    const colors = literalColors(readFileSync(resolve(root, rawPath), 'utf8'))
    if (colors.length > 0) violations.push(`${path}: literal client colors ${[...new Set(colors)].join(', ')}`)
  }
  return violations
}

if (import.meta.main) {
  const violations = architectureViolations()
  if (violations.length > 0) {
    console.error(`verify-architecture-governance: ${violations.length} violation(s):`)
    for (const violation of violations) console.error(`  ${violation}`)
    process.exitCode = 1
  } else {
    console.log('verify-architecture-governance: package graph, source budgets, product identity, and client colors are governed.')
  }
}
