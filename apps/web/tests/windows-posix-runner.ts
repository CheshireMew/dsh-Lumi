/**
 * Test-only pass-through runner for POSIX-recorded Web fixtures on Windows.
 * The scaffold owns a fresh temporary workspace and fixed replay commands;
 * native Windows acceptance keeps the shipped ACL runner and PowerShell.
 * @module apps/web/tests/windows-posix-runner
 */

import { execFileSync, spawn } from 'node:child_process'
import { basename } from 'node:path'

const divider = process.argv.indexOf('--', 2)
const argv = divider < 0 ? [] : process.argv.slice(divider + 1)
const program = argv[0]
const posixTmpOption = process.argv.indexOf('--posix-tmp', 2)
const posixTmp = posixTmpOption < 0 || posixTmpOption >= divider - 1
  ? undefined
  : process.argv[posixTmpOption + 1]?.replaceAll('\\', '/')

/** Let POSIX-recorded fixtures use their `python3` spelling with Windows Python. */
function windowsBashArgs(args: string[]): string[] {
  if (program === undefined || basename(program).toLowerCase().replace(/\.exe$/u, '') !== 'bash') return args
  const commandIndex = args.indexOf('-c') + 1
  if (commandIndex === 0 || args[commandIndex] === undefined) return args
  let python: string | undefined
  try {
    python = execFileSync('where.exe', ['python'], { encoding: 'utf8' })
      .split(/\r?\n/)
      .find(Boolean)
  } catch {
    // A fixture that does not call python3 remains runnable; one that does
    // receives Bash's ordinary command-not-found result.
  }
  if (python === undefined) return args
  const quotedPython = python.replaceAll('\\', '/').replaceAll("'", "'\\''")
  const patched = [...args]
  const command = posixTmp === undefined
    ? args[commandIndex]
    : args[commandIndex].replaceAll('/tmp/', `${posixTmp}/`)
  patched[commandIndex] = `python3() { '${quotedPython}' "$@"; }\n${command}`
  return patched
}

if (program === undefined) {
  console.error('web-e2e-posix-runner: missing command after --')
  process.exitCode = 125
} else {
  const child = spawn(program, windowsBashArgs(argv.slice(1)), {
    stdio: 'inherit',
    windowsHide: true,
  })
  const forward = (signal: NodeJS.Signals): void => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal)
  }
  process.once('SIGINT', () => { forward('SIGINT') })
  process.once('SIGTERM', () => { forward('SIGTERM') })
  child.once('error', (error) => {
    console.error(`web-e2e-posix-runner: ${error.message}`)
    process.exitCode = 125
  })
  child.once('exit', (code) => {
    process.exitCode = code ?? 1
  })
}
