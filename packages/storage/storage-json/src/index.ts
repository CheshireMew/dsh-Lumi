/**
 * JSON storage backend: one human-readable file per unit under a configured
 * root, published by atomic whole-file rewrite. Registers as backend `json`
 * on the storage hub.
 * @module @deepseek-ai/dsh-storage-json
 */

import { mkdir, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { StorageError, UNIT_NAME_RE, storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import type { KvFacet, KvUnit, KvUnitDescriptor, StorageBackend } from '@deepseek-ai/dsh-storage'
import { openJsonUnit } from './unit.ts'

/** Cordis plugin name. */
export const name = 'storage-json'
/** The hub must exist before the backend can register. */
export const inject = ['storage']

/**
 * Plugin configuration.
 * `root` has NO default on purpose: a `process.cwd()` fallback would scatter
 * unit files wherever the process happens to start; assemblies state the
 * location explicitly.
 */
export interface Config {
  /** Directory holding one `<unit>.json` file per unit; resolved once at backend construction. */
  root: string
}

/** Config schema. */
export const Config: z<Config> = z.object({
  root: z.string().required(),
})

/** JSON backend: owns the file-tree root and serves the `kv` facet. */
export class JsonStorageBackend implements StorageBackend {
  private readonly open = new Map<string, KvUnit>()
  // Reserved synchronously at open() entry so a concurrent open of the same
  // unit fails, and close() can await opens still in flight.
  private readonly opening = new Map<string, Promise<KvUnit>>()
  /** Destructive operations by unit name; close drains them before returning. */
  private readonly destroying = new Map<string, Promise<void>>()
  private closed = false

  private readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
  }

  readonly kv: KvFacet = {
    // The body up to the first await runs synchronously, so the opening-slot
    // reservation below still excludes a concurrent open of the same unit.
    open: async (descriptor: KvUnitDescriptor): Promise<KvUnit> => {
      if (this.closed) throw new StorageError('closed', 'json backend is closed')
      validateDescriptor(descriptor)
      if (this.open.has(descriptor.name) || this.opening.has(descriptor.name) || this.destroying.has(descriptor.name)) {
        // Double-open is a caller bug, not a medium condition.
        throw new Error(`unit '${descriptor.name}' is already open; a unit has exactly one live handle`)
      }
      const opening = this.openUnit(descriptor)
      this.opening.set(descriptor.name, opening)
      return opening.finally(() => this.opening.delete(descriptor.name))
    },
    destroy: descriptor => this.destroyUnit(descriptor),
  }

  private destroyUnit(descriptor: KvUnitDescriptor): Promise<void> {
    if (this.closed) return Promise.reject(new StorageError('closed', 'json backend is closed'))
    try {
      validateDescriptor(descriptor)
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
    if (this.open.has(descriptor.name) || this.opening.has(descriptor.name) || this.destroying.has(descriptor.name)) {
      return Promise.reject(new Error(`unit '${descriptor.name}' is already open; destroy requires a closed unit`))
    }
    const pending = this.removeUnitFile(descriptor)
    this.destroying.set(descriptor.name, pending)
    return pending.finally(() => this.destroying.delete(descriptor.name))
  }

  private async removeUnitFile(descriptor: KvUnitDescriptor): Promise<void> {
    try {
      await unlink(join(this.root, `${descriptor.name}.json`))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  private async openUnit(descriptor: KvUnitDescriptor): Promise<KvUnit> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const path = join(this.root, `${descriptor.name}.json`)
    const unit = await openJsonUnit(descriptor, path, () => this.open.delete(descriptor.name))
    if (this.closed) {
      // The backend closed while this open was in flight: do not hand out a
      // live unit past close().
      await unit.close()
      throw new StorageError('closed', 'json backend is closed')
    }
    this.open.set(descriptor.name, unit)
    return unit
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true
    }
    await Promise.allSettled([...this.opening.values(), ...this.destroying.values()])
    for (const unit of [...this.open.values()]) {
      await unit.close()
    }
  }
}

function validateDescriptor(descriptor: KvUnitDescriptor): void {
  if (!UNIT_NAME_RE.test(descriptor.name)) {
    throw new StorageError('malformed-medium', `invalid unit name '${descriptor.name}'`)
  }
  for (const table of descriptor.tables) {
    if (!UNIT_NAME_RE.test(table)) {
      throw new StorageError('malformed-medium', `invalid table name '${table}' in unit '${descriptor.name}'`)
    }
  }
}

/**
 * Register the `json` backend on the storage hub.
 * @param ctx - Plugin context.
 * @param config - Validated configuration.
 */
export function apply(ctx: Context, config: Config) {
  const backend = new JsonStorageBackend(config.root)
  ctx.effect(() => {
    const unregister = ctx.storage.backend.register('json', backend)
    return async () => {
      unregister()
      await backend.close()
    }
  })
  ctx.provide(storageBackendServiceKey('json'), backend)
}
