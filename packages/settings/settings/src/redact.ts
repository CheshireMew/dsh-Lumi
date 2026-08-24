/**
 * Structural secret redaction for settings values. `role('secret')` fields are
 * removed from a value before it crosses a wire boundary; a sidecar records
 * each schema-declared secret position and whether it currently holds a value,
 * so a configuration surface can render a write-only input without ever
 * receiving the secret itself.
 * @module @deepseek-ai/dsh-settings/redact
 */

import type z from '@deepseek-ai/schemastery'

/**
 * Minimal structural view of a live schemastery node. Only the relations the
 * redactor walks are named; everything else on the instance is ignored.
 */
interface SchemaNode {
  uid: number
  type?: string
  meta?: { role?: unknown; default?: unknown; [key: string]: unknown }
  /** `object` properties, keyed by property name. */
  dict?: Record<string, SchemaNode>
  /** `dict`/`array` element schema. */
  inner?: SchemaNode
  /** `tuple`/`union`/`intersect` member schemas. */
  list?: SchemaNode[]
}

const OMIT = Symbol('settings-wire-omit')
type WalkResult = unknown

const LEAF_TYPES = new Set([
  'any', 'const', 'string', 'number', 'boolean', 'bitset', 'function', 'is',
])

/** One schema-declared secret position inside a redacted value. */
export interface RedactedSecret {
  /** Path from the section root to the removed field (concrete dict keys and array indexes included). */
  path: string[]
  /** Whether the field held a value before redaction. */
  set: boolean
}

/** A value with every `role('secret')` field removed, plus the removal record. */
export interface RedactedValue {
  /** Detached copy of the input with secret fields absent. */
  value: unknown
  /**
   * Every reachable secret position: object properties always (even unset, so
   * a form knows the slot exists), dict entries and array items only where the
   * value has them.
   */
  secrets: RedactedSecret[]
}

/** Whether a value is a plain data object the walker may recurse into. */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Add one opaque wire slot without duplicating an already-recorded path. */
function addSecret(secrets: RedactedSecret[], path: string[], set: boolean): void {
  if (secrets.some(secret => secret.path.length === path.length && secret.path.every((part, index) => part === path[index]))) {
    return
  }
  secrets.push({ path, set })
}

/** Clone JSON-compatible data with property-safe objects; reject every other runtime value. */
function cloneWireValue(value: unknown): WalkResult {
  if (value === undefined) return OMIT
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : OMIT
  if (Array.isArray(value)) {
    const output: unknown[] = []
    for (const entry of value) {
      const cloned = cloneWireValue(entry)
      if (cloned === OMIT) return OMIT
      output.push(cloned)
    }
    return output
  }
  if (!isRecord(value)) return OMIT
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const [key, entry] of Object.entries(value)) {
    const cloned = cloneWireValue(entry)
    if (cloned === OMIT) return OMIT
    Object.defineProperty(output, key, { value: cloned, enumerable: true, configurable: true, writable: true })
  }
  return output
}

/** Select the same first successful branch Schemastery uses for a union. */
function matchingUnionBranch(node: SchemaNode, value: unknown): SchemaNode | undefined {
  for (const branch of node.list ?? []) {
    try {
      ;(branch as unknown as z<unknown>)(structuredClone(value))
      return branch
    } catch {
      // A union branch owns its validation failure; the next branch gets the value.
    }
  }
  return undefined
}

function walk(node: SchemaNode | undefined, value: unknown, path: string[], secrets: RedactedSecret[]): WalkResult {
  if (node === undefined) {
    addSecret(secrets, path, value !== undefined)
    return OMIT
  }
  if (node.meta?.role === 'secret') {
    addSecret(secrets, path, value !== undefined)
    return OMIT
  }
  switch (node.type) {
    case 'object': {
      const properties = node.dict ?? {}
      const source = isRecord(value) ? value : undefined
      if (source === undefined && value !== undefined) return OMIT
      const rebuilt: Record<string, unknown> = Object.create(null) as Record<string, unknown>
      for (const [key, child] of Object.entries(properties)) {
        const stripped = walk(child, source?.[key], [...path, key], secrets)
        if (stripped !== OMIT) {
          Object.defineProperty(rebuilt, key, { value: stripped, enumerable: true, configurable: true, writable: true })
        }
      }
      return source === undefined && Object.keys(rebuilt).length === 0 ? OMIT : rebuilt
    }
    case 'dict': {
      if (!isRecord(value) || node.inner === undefined) return OMIT
      const rebuilt: Record<string, unknown> = Object.create(null) as Record<string, unknown>
      for (const [key, entry] of Object.entries(value)) {
        const stripped = walk(node.inner, entry, [...path, key], secrets)
        if (stripped !== OMIT) {
          Object.defineProperty(rebuilt, key, { value: stripped, enumerable: true, configurable: true, writable: true })
        }
      }
      return rebuilt
    }
    case 'array': {
      if (!Array.isArray(value) || node.inner === undefined) return OMIT
      return value.map((entry, index) => {
        const stripped = walk(node.inner, entry, [...path, String(index)], secrets)
        return stripped === OMIT ? null : stripped
      })
    }
    case 'tuple': {
      if (!Array.isArray(value) || node.list === undefined) return OMIT
      return node.list.map((child, index) => {
        const stripped = walk(child, value[index], [...path, String(index)], secrets)
        return stripped === OMIT ? null : stripped
      })
    }
    case 'union': {
      const branch = matchingUnionBranch(node, value)
      if (branch === undefined) {
        addSecret(secrets, path, value !== undefined)
        return OMIT
      }
      return walk(branch, value, path, secrets)
    }
    case 'intersect': {
      const parts = node.list ?? []
      if (parts.length === 0) return cloneWireValue(value)
      let objectResult: Record<string, unknown> | undefined
      let scalarResult: unknown = OMIT
      for (const child of parts) {
        const stripped = walk(child, value, path, secrets)
        if (stripped === OMIT) return OMIT
        if (isRecord(stripped)) {
          objectResult ??= Object.create(null) as Record<string, unknown>
          for (const [key, entry] of Object.entries(stripped)) {
            Object.defineProperty(objectResult, key, { value: entry, enumerable: true, configurable: true, writable: true })
          }
        } else {
          scalarResult = stripped
        }
      }
      return objectResult ?? scalarResult
    }
    case 'lazy':
      return walk(node.inner, value, path, secrets)
    case 'transform': {
      addSecret(secrets, path, value !== undefined)
      return OMIT
    }
    default:
      if (node.type !== undefined && LEAF_TYPES.has(node.type)) return cloneWireValue(value)
      addSecret(secrets, path, value !== undefined)
      return OMIT
  }
}

/**
 * Remove every `role('secret')` field a schema declares from a value. The
 * walker follows every built-in structural node. It selects the validating
 * union branch, combines intersection branches, and treats transforms or
 * unknown schema types as opaque write-only slots because their output cannot
 * be proven to preserve the inner layout. Undeclared object properties,
 * malformed containers, and non-JSON runtime values are omitted. The input is
 * never mutated.
 * @param schema - live schemastery schema describing the value.
 * @param value - the value to strip; `undefined` yields an empty record with
 *   object-property secret slots still enumerated.
 * @returns the stripped detached value and the ordered secret positions.
 */
export function redactSecrets(schema: z<never>, value: unknown): RedactedValue {
  const secrets: RedactedSecret[] = []
  const stripped = walk(schema as unknown as SchemaNode, value, [], secrets)
  return { value: stripped === OMIT ? undefined : stripped, secrets }
}

/** Whether a serialized schema type can cross the wire without opaque executable semantics. */
function isWireSchemaType(type: unknown): boolean {
  return typeof type === 'string' && (LEAF_TYPES.has(type)
    || type === 'object' || type === 'dict' || type === 'array' || type === 'tuple'
    || type === 'union' || type === 'intersect' || type === 'lazy')
}

/** Collect the live schema graph by uid after `toJSON()` resolves lazy nodes. */
function collectNodes(root: SchemaNode): Map<number, SchemaNode> {
  const nodes = new Map<number, SchemaNode>()
  const visit = (node: SchemaNode | undefined): void => {
    if (node === undefined || nodes.has(node.uid)) return
    nodes.set(node.uid, node)
    visit(node.inner)
    for (const child of node.list ?? []) visit(child)
    for (const child of Object.values(node.dict ?? {})) visit(child)
  }
  visit(root)
  return nodes
}

/**
 * Serialize a settings schema without carrying secret literal values in
 * defaults, const nodes, transform metadata, or unsupported custom nodes.
 * Secret and opaque nodes become rehydratable `any` write-only fields; safe
 * nodes retain their ordinary form metadata.
 * @param schema - live namespace schema.
 * @returns a detached Schemastery envelope safe for an untrusted client.
 */
export function schemaForWire(schema: z<never>): unknown {
  const serialized = schema.toJSON() as unknown
  if (!isRecord(serialized) || !isRecord(serialized['refs'])) {
    return { uid: 1, refs: { 1: { type: 'any', meta: { role: 'secret' } } } }
  }
  const output = structuredClone(serialized)
  const refs = output['refs'] as Record<string, unknown>
  const live = collectNodes(schema as unknown as SchemaNode)
  for (const [uid, raw] of Object.entries(refs)) {
    if (!isRecord(raw)) {
      refs[uid] = { type: 'any', meta: { role: 'secret' } }
      continue
    }
    const node = live.get(Number(uid))
    if (node === undefined || node.meta?.role === 'secret' || !isWireSchemaType(node.type)) {
      refs[uid] = { type: 'any', meta: { role: 'secret' } }
      continue
    }
    const meta = raw['meta']
    if (!isRecord(meta) || !Object.hasOwn(meta, 'default')) continue
    const redacted = redactSecrets(node as unknown as z<never>, meta['default']).value
    if (redacted === undefined) delete meta['default']
    else meta['default'] = redacted
  }
  return output
}
