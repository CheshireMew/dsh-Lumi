import {
  appendFileSync, existsSync, readdirSync, renameSync, rmSync, statSync,
} from 'node:fs'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { dailyLogPath } from './paths.ts'

/** Bounded local-diagnostic retention inputs owned by desktop configuration. */
export interface DesktopDiagnosticLimits {
  maxLogBytes: number
  maxLogFiles: number
  maxLogAgeMs: number
  maxCrashFiles: number
  maxCrashAgeMs: number
}

/** Remove only regular files outside the declared age/count retention. */
export function pruneDiagnosticFiles(directory: string, maxFiles: number, maxAgeMs: number, now = Date.now()): number {
  const candidates = readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map((entry) => {
      const path = join(directory, entry.name)
      return { path, modified: statSync(path).mtimeMs }
    })
    .sort((left, right) => right.modified - left.modified)
  let removed = 0
  for (const [index, candidate] of candidates.entries()) {
    if (index < maxFiles && now - candidate.modified <= maxAgeMs) continue
    try { rmSync(candidate.path); removed += 1 } catch { /* A locked diagnostic remains for the next startup. */ }
  }
  return removed
}

/** Keep at most one full predecessor and one bounded current daily log. */
export function appendBoundedLog(path: string, payload: string | Uint8Array, maxBytes: number): void {
  const bytes = Buffer.from(payload)
  const retained = bytes.byteLength > maxBytes ? bytes.subarray(bytes.byteLength - maxBytes) : bytes
  if (existsSync(path) && statSync(path).size + retained.byteLength > maxBytes) {
    const previous = `${path}.previous`
    rmSync(previous, { force: true })
    renameSync(path, previous)
  }
  appendFileSync(path, retained)
}

/** Writable sink that bounds Harness stdout/stderr without back-pressuring on a file handle. */
export function createDesktopLogStream(logs: string, maxBytes: number): Writable {
  return new Writable({
    write(chunk: Uint8Array, _encoding, callback) {
      try {
        appendBoundedLog(dailyLogPath(logs, 'harness'), chunk, maxBytes)
        callback()
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)))
      }
    },
  })
}

/** Apply bounded retention to local text logs and Crashpad minidumps. */
export function pruneDesktopDiagnostics(
  logs: string,
  crashes: string,
  limits: DesktopDiagnosticLimits,
  now = Date.now(),
): { logs: number; crashes: number } {
  return {
    logs: pruneDiagnosticFiles(logs, limits.maxLogFiles, limits.maxLogAgeMs, now),
    crashes: pruneDiagnosticFiles(crashes, limits.maxCrashFiles, limits.maxCrashAgeMs, now),
  }
}
