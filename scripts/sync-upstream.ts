import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

interface UpstreamConfig {
  repository: string
  remote: string
  branch: string
  validatedCommit: string
  highConflictFiles: string[]
}

interface CheckResult {
  name: string
  command: string
  passed: boolean
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const configPath = resolve(root, '.upstream.json')
const config = JSON.parse(readFileSync(configPath, 'utf8')) as UpstreamConfig
const target = `${config.remote}/${config.branch}`

function git(args: string[], inherit = false): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false, stdio: inherit ? 'inherit' : 'pipe' })
  if (result.status !== 0) {
    const detail = inherit ? '' : `\n${result.stderr.trim()}`
    throw new Error(`git ${args.join(' ')} failed${detail}`)
  }
  return inherit ? '' : result.stdout.trim()
}

function gitSucceeds(args: string[]): boolean {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false, stdio: 'ignore' }).status === 0
}

function assertOfficialRemote(): void {
  const actual = git(['remote', 'get-url', config.remote])
  const normalize = (url: string): string => url.replace(/^git@github\.com:/u, 'https://github.com/').replace(/\/$/u, '')
  if (normalize(actual) !== normalize(config.repository)) throw new Error(`${config.remote} must fetch ${config.repository}; found ${actual}`)
}

function assertClean(): void {
  if (git(['status', '--porcelain=v1', '--untracked-files=all']) !== '') {
    throw new Error('working tree is not clean; commit or archive local work before synchronizing')
  }
}

function assertRebaseReady(): void {
  const branch = git(['branch', '--show-current'])
  if (branch === '' || branch === config.branch) throw new Error(`refusing to rebase detached HEAD or the official ${config.branch} branch`)
  assertClean()
}

function printStatus(): void {
  git(['rev-parse', '--verify', target])
  git(['cat-file', '-e', `${config.validatedCommit}^{commit}`])
  const [ahead = '0', behind = '0'] = git(['rev-list', '--left-right', '--count', `HEAD...${target}`]).split(/\s+/u)
  const unvalidated = git(['rev-list', '--count', `${config.validatedCommit}..${target}`])
  console.log(`official target: ${target}`)
  console.log(`validated base: ${config.validatedCommit}`)
  console.log(`current branch: ${git(['branch', '--show-current']) || '(detached)'}`)
  console.log(`relative to ${target}: ${ahead} ahead, ${behind} behind`)
  console.log(`official commits since validated base: ${unvalidated}`)
  if (unvalidated !== '0') {
    console.log('review these high-conflict files after synchronizing:')
    for (const path of config.highConflictFiles) console.log(`  ${path}`)
  }
}

function localDate(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function runCheck(name: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): CheckResult {
  const command = `pnpm ${args.join(' ')}`
  const pnpmEntry = process.env.npm_execpath
  if (pnpmEntry === undefined || pnpmEntry === '') {
    throw new Error('npm_execpath is unavailable; invoke the synchronization through pnpm sync:upstream')
  }
  const result = spawnSync(process.execPath, [pnpmEntry, ...args], {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    shell: false,
    stdio: 'inherit',
  })
  return { name, command, passed: result.status === 0 }
}

function writeSyncReport(
  date: string,
  branch: string,
  previousBase: string,
  nextBase: string,
  changes: string[],
  touchedSeams: string[],
  checks: readonly CheckResult[],
): string {
  const reports = resolve(root, 'docs', 'upstream-sync')
  mkdirSync(reports, { recursive: true })
  const path = resolve(reports, `${date}.md`)
  const lines = [
    `# Upstream sync ${date}`,
    '',
    `Branch: \`${branch}\``,
    '',
    `Official base: \`${previousBase}\` → \`${nextBase}\``,
    '',
    '## Official changes',
    '',
    ...(changes.length === 0 ? ['- No official commits were added.'] : changes.map(change => `- ${change}`)),
    '',
    '## Extension seams touched upstream',
    '',
    ...(touchedSeams.length === 0 ? ['- None of the monitored files changed upstream.'] : touchedSeams.map(pathname => `- \`${pathname}\``)),
    '',
    '## Automated verification',
    '',
    ...checks.map(check => `- ${check.passed ? 'PASS' : 'FAIL'} — \`${check.command}\` (${check.name})`),
    '',
    '## Manual checks',
    '',
    '- Open the official Web profile without the Anime bundle and compare the default frame.',
    '- Open scene and work modes in the Anime profile and inspect sidebar, conversation, details, and overlays.',
    '- Complete the Windows real-model workflow documented in the Anime desktop user guide.',
    '',
  ]
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')
  return path
}

function writeBaseRecord(commit: string, checks: readonly CheckResult[]): void {
  const rootManifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string }
  const desktopManifest = JSON.parse(readFileSync(resolve(root, 'apps', 'desktop', 'package.json'), 'utf8')) as { devDependencies: { electron: string } }
  const passed = checks.every(check => check.passed)
  const body = [
    '# Upstream base',
    '',
    `- Official repository: ${config.repository}`,
    `- Official commit: \`${commit}\``,
    `- Harness version: \`${rootManifest.version}\``,
    `- Electron version: \`${desktopManifest.devDependencies.electron}\``,
    `- Compatibility checks: ${passed ? 'passed' : 'failed; see the latest docs/upstream-sync report'}`,
    '',
  ]
  writeFileSync(resolve(root, 'UPSTREAM_BASE.md'), body.join('\n'), 'utf8')
}

function synchronize(): void {
  assertClean()
  git(['fetch', '--prune', '--tags', config.remote, config.branch], true)
  const previousBase = git(['rev-parse', 'upstream-base'])
  if (!gitSucceeds(['merge-base', '--is-ancestor', 'upstream-base', target])) {
    throw new Error(`upstream-base cannot fast-forward to ${target}; inspect the protected branch`)
  }
  git(['switch', 'upstream-base'], true)
  git(['merge', '--ff-only', target], true)
  const nextBase = git(['rev-parse', target])
  const date = localDate()
  const branch = `codex/sync-${date.replaceAll('-', '')}-${nextBase.slice(0, 8)}`
  if (gitSucceeds(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])) throw new Error(`sync branch already exists: ${branch}`)
  git(['switch', 'main'], true)
  git(['switch', '-c', branch], true)
  const merge = spawnSync('git', ['merge', '--no-edit', 'upstream-base'], { cwd: root, encoding: 'utf8', shell: false, stdio: 'inherit' })
  if (merge.status !== 0) {
    console.error(`Merge stopped on ${branch}. Resolve conflicts and keep the branch; the script does not reset or delete the merge state.`)
    process.exit(merge.status ?? 1)
  }

  const changes = previousBase === nextBase ? [] : git(['log', '--format=%h %s', `${previousBase}..${nextBase}`]).split('\n').filter(Boolean)
  const upstreamFiles = previousBase === nextBase ? [] : git(['diff', '--name-only', `${previousBase}..${nextBase}`]).split('\n').filter(Boolean)
  const touchedSeams = config.highConflictFiles.filter(path => upstreamFiles.includes(path))
  const checks = [
    runCheck('Anime extension contracts', ['run', 'compat:anime']),
    runCheck('Anime source build', ['run', 'build:anime']),
    runCheck('Official GUI suite', ['run', 'test:gui']),
    runCheck('Official Web replay', ['run', 'test:web'], { DSH_SNAPSHOT: 'replay' }),
    runCheck('Official repository checks', ['run', 'check:all']),
    runCheck('Electron smoke', ['--filter', '@dsh-anime/desktop', 'run', 'test:e2e:built']),
  ]
  const report = writeSyncReport(date, branch, previousBase, nextBase, changes, touchedSeams, checks)
  writeBaseRecord(nextBase, checks)
  if (checks.every(check => check.passed)) {
    writeFileSync(configPath, `${JSON.stringify({ ...config, validatedCommit: nextBase }, undefined, 2)}\n`, 'utf8')
    console.log(`Synchronization passed. Report: ${report}`)
    return
  }
  console.error(`Synchronization checks failed on ${branch}. The branch, report, and working tree are preserved: ${report}`)
  process.exit(1)
}

const args = new Set(process.argv.slice(2))
const supported = new Set(['--fetch', '--rebase', '--sync', '--help'])
for (const arg of args) if (!supported.has(arg)) throw new Error(`unknown argument: ${arg}`)
if (args.has('--help')) {
  console.log('Usage: pnpm run upstream:status | upstream:fetch | upstream:rebase | sync:upstream')
  process.exit(0)
}
if ([...args].filter(arg => arg !== '--help').length > 1) throw new Error('choose only one synchronization operation')

assertOfficialRemote()
if (args.has('--sync')) synchronize()
else {
  if (args.has('--rebase')) assertRebaseReady()
  if (args.has('--fetch') || args.has('--rebase')) git(['fetch', '--prune', '--tags', config.remote, config.branch], true)
  if (args.has('--rebase')) {
    const result = spawnSync('git', ['rebase', target], { cwd: root, encoding: 'utf8', shell: false, stdio: 'inherit' })
    if (result.status !== 0) {
      console.error('Rebase stopped. Resolve conflicts, run focused checks, then continue or abort the rebase explicitly.')
      process.exit(result.status ?? 1)
    }
  }
  printStatus()
}
