/** Host-owned character-pack discovery and same-origin asset serving. */
import {
  existsSync, mkdirSync, readFileSync, readdirSync, statSync, watch,
  type FSWatcher,
} from 'node:fs'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ServerResponse } from 'node:http'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { createBuiltinManifest } from './builtin.ts'
import {
  CHARACTER_STATES, type LumiAnimationDefinition, type LumiAnimationKeyframe,
  type LumiBondUnlock, type LumiCharacterStateDefinition, type LumiPackCatalogView,
  type LumiPackManifest, type LumiPackView, type CharacterState,
} from './pack-contract.ts'
import { BUILTIN_PACK_ID } from './settings.ts'

const PACK_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
}
const LOOPS = new Set(['none', 'repeat', 'alternate'])
const STATE_SET = new Set<string>(CHARACTER_STATES)

interface LoadedPack {
  manifest: LumiPackManifest
  resolved: ReadonlyMap<string, string>
}

interface CatalogSnapshot extends LumiPackCatalogView {
  assets: ReadonlyMap<string, string>
}

interface PackLogger {
  warn: (value: string | Error) => void
}

/** JSON object guard. */
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Non-empty string guard. */
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/** Finite number guard with inclusive bounds. */
function numberIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

/** Resolve a declared asset under its required directory; traversal and non-files fail closed. */
function assetPath(root: string, declared: unknown, prefix?: 'layers' | 'expressions' | 'effects'): string | undefined {
  if (!text(declared) || isAbsolute(declared) || declared.includes('\\') || declared.split('/').some(part => part === '..' || part === '.')) return undefined
  if (prefix !== undefined && !declared.startsWith(`${prefix}/`)) return undefined
  const path = resolve(root, declared)
  const rel = relative(root, path)
  /* v8 ignore next -- absolute paths and dot segments are rejected above, so resolve cannot escape root. */
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) return undefined
  if (!existsSync(path) || !statSync(path).isFile()) return undefined
  if (CONTENT_TYPES[extname(path).toLowerCase()] === undefined) return undefined
  return path
}

/** Parse one animation definition at the durable JSON boundary. */
function animation(value: unknown): LumiAnimationDefinition | undefined {
  if (!record(value) || !Array.isArray(value['keyframes']) || value['keyframes'].length < 2) return undefined
  if (!LOOPS.has(String(value['loop'])) || !numberIn(value['minDurationMs'], 0, 60_000)) return undefined
  const keyframes: LumiAnimationKeyframe[] = []
  let previous = -1
  for (const candidate of value['keyframes']) {
    if (!record(candidate) || !numberIn(candidate['at'], 0, 1) || candidate['at'] < previous) return undefined
    const frame: LumiAnimationKeyframe = { at: candidate['at'] }
    for (const key of ['translateX', 'translateY', 'rotate'] as const) {
      const field = candidate[key]
      if (field !== undefined && !numberIn(field, -10_000, 10_000)) return undefined
      if (typeof field === 'number') frame[key] = field
    }
    if (candidate['scale'] !== undefined && !numberIn(candidate['scale'], 0.01, 20)) return undefined
    if (typeof candidate['scale'] === 'number') frame.scale = candidate['scale']
    if (candidate['opacity'] !== undefined && !numberIn(candidate['opacity'], 0, 1)) return undefined
    if (typeof candidate['opacity'] === 'number') frame.opacity = candidate['opacity']
    if (candidate['mouth'] !== undefined && candidate['mouth'] !== 'open' && candidate['mouth'] !== 'closed') return undefined
    if (candidate['mouth'] === 'open' || candidate['mouth'] === 'closed') frame.mouth = candidate['mouth']
    keyframes.push(frame)
    previous = candidate['at']
  }
  if (keyframes[0]?.at !== 0 || keyframes.at(-1)?.at !== 1) return undefined
  return {
    keyframes,
    loop: value['loop'] as LumiAnimationDefinition['loop'],
    minDurationMs: value['minDurationMs'],
  }
}

/** Parse a string array with no empty members. */
function stringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every(text) ? value : undefined
}

/** Parse all pack assets and return logical-key to filesystem-path mappings. */
function assets(root: string, value: unknown): { manifest: LumiPackManifest['assets']; resolved: Map<string, string> } | undefined {
  if (!record(value)
    || value['preview'] !== 'preview.webp'
    || value['background'] !== 'background.webp'
    || !record(value['expressions'])
    || !record(value['mouth'])
    || !record(value['effects'])) return undefined
  const resolved = new Map<string, string>()
  const add = (key: string, declared: unknown, prefix?: 'layers' | 'expressions' | 'effects'): string | undefined => {
    const path = assetPath(root, declared, prefix)
    if (path !== undefined) resolved.set(key, path)
    return path
  }
  if (add('preview', value['preview']) === undefined || add('background', value['background']) === undefined) return undefined
  if (add('body', value['body'], 'layers') === undefined) return undefined

  const expressions: Record<string, string> = {}
  for (const [name, declared] of Object.entries(value['expressions'])) {
    if (!text(name) || add(`expression:${name}`, declared, 'expressions') === undefined) return undefined
    expressions[name] = declared as string
  }
  if (Object.keys(expressions).length === 0) return undefined
  const closed = value['mouth']['closed']
  const open = value['mouth']['open']
  if (add('mouth:closed', closed, 'layers') === undefined || add('mouth:open', open, 'layers') === undefined) return undefined
  const effects: Record<string, string> = {}
  for (const [name, declared] of Object.entries(value['effects'])) {
    if (!text(name) || add(`effect:${name}`, declared, 'effects') === undefined) return undefined
    effects[name] = declared as string
  }
  return {
    manifest: {
      preview: 'preview.webp',
      background: 'background.webp',
      body: value['body'] as string,
      expressions,
      mouth: { closed: closed as string, open: open as string },
      effects,
    },
    resolved,
  }
}

/** Parse every required state and ensure logical layer references exist. */
function states(
  value: unknown,
  packAssets: LumiPackManifest['assets'],
): Readonly<Record<CharacterState, LumiCharacterStateDefinition>> | undefined {
  if (!record(value)) return undefined
  const parsed = {} as Record<CharacterState, LumiCharacterStateDefinition>
  for (const state of CHARACTER_STATES) {
    const candidate = value[state]
    if (!record(candidate) || !text(candidate['expression']) || packAssets.expressions[candidate['expression']] === undefined) return undefined
    if (!text(candidate['fallback']) || !STATE_SET.has(candidate['fallback'])) return undefined
    const effect = candidate['effect']
    if (effect !== undefined && (!text(effect) || packAssets.effects[effect] === undefined)) return undefined
    const parsedAnimation = animation(candidate['animation'])
    if (parsedAnimation === undefined) return undefined
    parsed[state] = {
      expression: candidate['expression'],
      fallback: candidate['fallback'] as CharacterState,
      animation: parsedAnimation,
      ...(typeof effect === 'string' ? { effect } : {}),
    }
  }
  return parsed
}

/** Parse named idle actions referenced by bond unlocks. */
function idleActions(
  value: unknown,
  packAssets: LumiPackManifest['assets'],
): LumiPackManifest['idleActions'] | undefined {
  if (!record(value)) return undefined
  const parsed: Record<string, { effect?: string; animation: LumiAnimationDefinition }> = {}
  for (const [name, candidate] of Object.entries(value)) {
    if (!text(name) || !record(candidate)) return undefined
    const effect = candidate['effect']
    if (effect !== undefined && (!text(effect) || packAssets.effects[effect] === undefined)) return undefined
    const parsedAnimation = animation(candidate['animation'])
    if (parsedAnimation === undefined) return undefined
    parsed[name] = { animation: parsedAnimation, ...(typeof effect === 'string' ? { effect } : {}) }
  }
  return parsed
}

/** Parse local bond unlock declarations and validate their references. */
function bondUnlocks(
  value: unknown,
  packAssets: LumiPackManifest['assets'],
  actions: LumiPackManifest['idleActions'],
): readonly LumiBondUnlock[] | undefined {
  if (!Array.isArray(value)) return undefined
  const parsed: LumiBondUnlock[] = []
  let lastLevel = 0
  for (const candidate of value) {
    if (!record(candidate)
      || !Number.isSafeInteger(candidate['level'])
      || !numberIn(candidate['level'], 1, Number.MAX_SAFE_INTEGER)) return undefined
    if (candidate['level'] <= lastLevel || !record(candidate['bubbles'])) return undefined
    const expressions = stringArray(candidate['expressions'])
    const actionNames = stringArray(candidate['idleActions'])
    const zh = stringArray(candidate['bubbles']['zh'])
    const en = stringArray(candidate['bubbles']['en'])
    if (expressions === undefined || actionNames === undefined || zh === undefined || en === undefined) return undefined
    if (expressions.some(name => packAssets.expressions[name] === undefined)
      || actionNames.some(name => actions[name] === undefined)) return undefined
    parsed.push({ level: candidate['level'], expressions, idleActions: actionNames, bubbles: { zh, en } })
    lastLevel = candidate['level']
  }
  return parsed
}

/** Parse and validate a manifest plus every referenced asset. */
function readPack(dir: string, directory: string): LoadedPack | undefined {
  for (const fixed of ['layers', 'expressions', 'effects']) {
    const path = join(dir, fixed)
    if (!existsSync(path) || !statSync(path).isDirectory()) return undefined
  }
  const path = join(dir, 'manifest.json')
  if (!existsSync(path)) return undefined
  let raw: unknown
  try { raw = JSON.parse(readFileSync(path, 'utf8')) } catch { return undefined }
  if (!record(raw)
    || raw['schemaVersion'] !== 1
    || !text(raw['id']) || !PACK_ID.test(raw['id']) || raw['id'] !== directory
    || !text(raw['displayName'])
    || !text(raw['author'])
    || (raw['license'] !== undefined && !text(raw['license']))
    || !text(raw['version'])
    || !record(raw['canvas'])
    || !record(raw['canvas']['anchor'])
    || !record(raw['canvas']['safeMargin'])) return undefined
  const canvas = raw['canvas']
  if (!numberIn(canvas['width'], 1, 16_384) || !numberIn(canvas['height'], 1, 16_384)) return undefined
  const anchor = canvas['anchor'] as Record<string, unknown>
  if (!numberIn(anchor['x'], 0, canvas['width']) || !numberIn(anchor['y'], 0, canvas['height'])) return undefined
  const margin = canvas['safeMargin'] as Record<string, unknown>
  const top = margin['top']
  const right = margin['right']
  const bottom = margin['bottom']
  const left = margin['left']
  if (!numberIn(top, 0, 16_384) || !numberIn(right, 0, 16_384)
    || !numberIn(bottom, 0, 16_384) || !numberIn(left, 0, 16_384)) return undefined
  if (left + right >= canvas['width'] || top + bottom >= canvas['height']) return undefined

  const parsedAssets = assets(dir, raw['assets'])
  if (parsedAssets === undefined) return undefined
  const parsedStates = states(raw['states'], parsedAssets.manifest)
  const parsedActions = idleActions(raw['idleActions'], parsedAssets.manifest)
  if (parsedStates === undefined || parsedActions === undefined) return undefined
  const parsedUnlocks = bondUnlocks(raw['bondUnlocks'], parsedAssets.manifest, parsedActions)
  if (parsedUnlocks === undefined) return undefined
  return {
    manifest: {
      schemaVersion: 1,
      id: raw['id'],
      displayName: raw['displayName'],
      author: raw['author'],
      ...(typeof raw['license'] === 'string' ? { license: raw['license'] } : {}),
      version: raw['version'],
      canvas: {
        width: canvas['width'],
        height: canvas['height'],
        anchor: { x: anchor['x'], y: anchor['y'] },
        safeMargin: {
          top, right, bottom, left,
        },
      },
      assets: parsedAssets.manifest,
      states: parsedStates,
      idleActions: parsedActions,
      bondUnlocks: parsedUnlocks,
    },
    resolved: parsedAssets.resolved,
  }
}

/** Encode a path segment without allowing slash semantics. */
function segment(value: string): string { return encodeURIComponent(value) }

/** Write a small JSON response. */
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

/** Convert a validated asset map to renderer-safe same-origin URLs. */
function packView(
  manifest: LumiPackManifest,
  base: string,
  resolved: ReadonlyMap<string, string>,
  assets: Map<string, string>,
): LumiPackView {
  const urlFor = (key: string): string => `${base}/${segment(key)}`
  for (const [key, path] of resolved) assets.set(urlFor(key), path)
  const expressions = Object.fromEntries(Object.keys(manifest.assets.expressions).map(name => [name, urlFor(`expression:${name}`)]))
  const effects = Object.fromEntries(Object.keys(manifest.assets.effects).map(name => [name, urlFor(`effect:${name}`)]))
  return {
    manifest,
    publishable: manifest.license !== undefined,
    assets: {
      preview: urlFor('preview'),
      background: urlFor('background'),
      body: urlFor('body'),
      expressions,
      mouth: { closed: urlFor('mouth:closed'), open: urlFor('mouth:open') },
      effects,
    },
  }
}

/** Local pack catalog, asset route, and filesystem invalidation stream. */
export class LumiPackCatalog {
  private revision = 0
  private watcher: FSWatcher | undefined
  private readonly eventClients = new Set<ServerResponse>()

  /** @param root - `$DSH_HOME/lumi/packs`. @param builtinAssetsRoot - shipped original Lumi layers. */
  constructor(
    private readonly root: string,
    private readonly builtinAssetsRoot: string,
    private readonly logger: PackLogger,
  ) {
    mkdirSync(root, { recursive: true })
    try {
      this.watcher = watch(root, { recursive: true }, () => { this.invalidate() })
      this.watcher.on('error', (error) => { this.logger.warn(error) })
    } catch (error) {
      this.logger.warn(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /**
   * Read the current validated catalog plus the private URL-to-file asset map.
   * @returns A fresh catalog snapshot and its allowlisted asset map.
   */
  snapshot(): CatalogSnapshot {
    const assets = new Map<string, string>()
    const builtin = createBuiltinManifest()
    const builtinResolved = new Map<string, string>()
    const builtinFiles: Readonly<Record<string, string>> = {
      preview: 'builtin-lumi.svg',
      background: 'builtin-library.svg',
      body: 'builtin-body.svg',
      'mouth:closed': 'builtin-mouth-closed.svg',
      'mouth:open': 'builtin-mouth-open.svg',
      'expression:neutral': 'builtin-expression-neutral.svg',
      'expression:happy': 'builtin-expression-happy.svg',
      'expression:concerned': 'builtin-expression-concerned.svg',
      'expression:focused': 'builtin-expression-focused.svg',
      'effect:sparkle': 'builtin-effect-sparkle.svg',
    }
    for (const [key, filename] of Object.entries(builtinFiles)) builtinResolved.set(key, join(this.builtinAssetsRoot, filename))
    const packs: LumiPackView[] = [packView(builtin, '/lumi/assets/builtin-lumi', builtinResolved, assets)]
    const diagnostics: LumiPackCatalogView['diagnostics'][number][] = []
    const entries = readdirSync(this.root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))
    const ids = new Set([BUILTIN_PACK_ID])
    for (const entry of entries) {
      const loaded = readPack(join(this.root, entry.name), entry.name)
      if (loaded === undefined) {
        const message = 'manifest or referenced assets do not satisfy Character Pack v1'
        diagnostics.push({ directory: entry.name, message })
        this.logger.warn(`lumi-character: ignored invalid pack at ${entry.name}: ${message}`)
        continue
      }
      if (ids.has(loaded.manifest.id)) {
        const message = `duplicate pack id ${loaded.manifest.id}`
        diagnostics.push({ directory: entry.name, message })
        this.logger.warn(`lumi-character: ignored pack at ${entry.name}: ${message}`)
        continue
      }
      ids.add(loaded.manifest.id)
      packs.push(packView(loaded.manifest, `/lumi/assets/packs/${segment(loaded.manifest.id)}`, loaded.resolved, assets))
    }
    return { revision: this.revision, packs, diagnostics, assets }
  }

  /**
   * Register catalog, SSE invalidation, and allowlisted asset routes.
   * @param server Harness Web server registry.
   * @returns A disposer for every registered route.
   */
  register(server: WebServer): () => void {
    const disposers = [
      server.register({
        kind: 'exact', path: '/lumi/packs', handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
          const { assets: _assets, ...view } = this.snapshot()
          if (req.method === 'HEAD') { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(); return }
          json(res, 200, view)
        },
      }),
      server.register({
        kind: 'exact', path: '/lumi/packs/events', handler: (req, res) => {
          if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store',
            connection: 'keep-alive',
          })
          res.write(`data: ${this.revision}\n\n`)
          this.eventClients.add(res)
          res.on('close', () => { this.eventClients.delete(res) })
        },
      }),
      server.register({
        kind: 'prefix', path: '/lumi/assets', handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
          const pathname = new URL(req.url ?? '/', 'http://local').pathname
          const path = this.snapshot().assets.get(pathname)
          if (path === undefined) { res.writeHead(404); res.end(); return }
          /* v8 ignore next -- every path enters the catalog through assetPath's CONTENT_TYPES allowlist. */
          const type = CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
          res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' })
          if (req.method === 'HEAD') { res.end(); return }
          res.end(readFileSync(path))
        },
      }),
    ]
    return () => { for (const dispose of disposers.reverse()) dispose() }
  }

  /** Stop filesystem and network resources. */
  dispose(): void {
    this.watcher?.close()
    this.watcher = undefined
    for (const response of this.eventClients) response.end()
    this.eventClients.clear()
  }

  private invalidate(): void {
    this.revision += 1
    for (const response of this.eventClients) response.write(`data: ${this.revision}\n\n`)
  }
}
