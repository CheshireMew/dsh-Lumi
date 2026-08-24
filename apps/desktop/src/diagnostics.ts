import {
  readdirSync, rmSync, statSync,
} from 'node:fs'
import { open, rename, rm, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { finished } from 'node:stream/promises'
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

/** Writable that keeps one bounded current file and one full predecessor. */
class RotatingLogStream extends Writable {
  private handle: FileHandle | undefined
  private size = 0

  /** @param path - Current log file. @param maxBytes - Byte ceiling before rotation. */
  constructor(private readonly path: string, private readonly maxBytes: number) {
    super()
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new RangeError('log byte limit must be a positive safe integer')
    }
  }

  override _construct(callback: (error?: Error | null) => void): void {
    void this.openCurrent().then(() => { callback() }, (error: unknown) => { callback(asError(error)) })
  }

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    void this.append(chunk, encoding).then(() => { callback() }, (error: unknown) => { callback(asError(error)) })
  }

  override _final(callback: (error?: Error | null) => void): void {
    void this.closeCurrent().then(() => { callback() }, (error: unknown) => { callback(asError(error)) })
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    void this.closeCurrent().then(() => { callback(error) }, (closeError: unknown) => { callback(asError(closeError)) })
  }

  /** Open the append handle and seed its exact byte position. */
  private async openCurrent(): Promise<void> {
    this.handle = await open(this.path, 'a')
    this.size = (await this.handle.stat()).size
  }

  /** Append one retained chunk, rotating only after the previous handle has closed. */
  private async append(chunk: Buffer | string, encoding: BufferEncoding): Promise<void> {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)
    const retained = bytes.byteLength > this.maxBytes
      ? bytes.subarray(bytes.byteLength - this.maxBytes)
      : bytes
    if (this.size + retained.byteLength > this.maxBytes) await this.rotate()
    await this.requireHandle().writeFile(retained)
    this.size += retained.byteLength
  }

  /** Replace the predecessor only after Windows releases the current file handle. */
  private async rotate(): Promise<void> {
    await this.closeCurrent()
    const previous = `${this.path}.previous`
    await rm(previous, { force: true })
    try {
      await rename(this.path, previous)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await this.openCurrent()
  }

  /** Close the owned file handle exactly once. */
  private async closeCurrent(): Promise<void> {
    const handle = this.handle
    this.handle = undefined
    if (handle !== undefined) await handle.close()
  }

  private requireHandle(): FileHandle {
    if (this.handle === undefined) throw new Error('desktop log stream is closed')
    return this.handle
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** Append one payload and close after all asynchronous filesystem work settles. */
export async function appendBoundedLog(
  path: string,
  payload: string | Uint8Array,
  maxBytes: number,
): Promise<void> {
  const stream = new RotatingLogStream(path, maxBytes)
  stream.end(payload)
  await finished(stream)
}

/** Backpressure-aware sink that bounds Harness stdout/stderr without blocking Electron's main thread. */
export function createDesktopLogStream(logs: string, maxBytes: number): Writable {
  return new RotatingLogStream(dailyLogPath(logs, 'harness'), maxBytes)
}

/** Backpressure-aware sink for the Electron main-process diagnostic log. */
export function createMainLogStream(logs: string, maxBytes: number): Writable {
  return new RotatingLogStream(dailyLogPath(logs, 'main'), maxBytes)
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
