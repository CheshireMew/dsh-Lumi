import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CHARACTER_STATES } from '../src/pack-contract.ts'
import { LumiPackCatalog } from '../src/packs.ts'

const animation = { keyframes: [{ at: 0 }, { at: 1, translateY: -3 }], loop: 'alternate', minDurationMs: 1200 }
const richAnimation = {
  keyframes: [
    { at: 0, translateX: 0, translateY: 0, rotate: 0, scale: 1, opacity: 1, mouth: 'closed' },
    { at: 1, translateX: 2, translateY: -3, rotate: 1, scale: 1.02, opacity: 0.9, mouth: 'open' },
  ],
  loop: 'repeat',
  minDurationMs: 900,
}

const watchControl = vi.hoisted(() => ({
  throws: false,
  failure: undefined as unknown,
  watchers: [] as import('node:fs').FSWatcher[],
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    watch: (...args: unknown[]) => {
      if (watchControl.throws) throw watchControl.failure
      const watcher = Reflect.apply(actual.watch, actual, args) as import('node:fs').FSWatcher
      watchControl.watchers.push(watcher)
      return watcher
    },
  }
})

function manifest(id: string, license: string | null = 'CC-BY-4.0') {
  return {
    schemaVersion: 1,
    id,
    displayName: 'Luna',
    author: 'Fixture Author',
    ...(license === null ? {} : { license }),
    version: '1.0.0',
    canvas: { width: 720, height: 1120, anchor: { x: 360, y: 1080 }, safeMargin: { top: 20, right: 20, bottom: 20, left: 20 } },
    assets: {
      preview: 'preview.webp', background: 'background.webp', body: 'layers/body.svg',
      expressions: { neutral: 'expressions/neutral.svg' },
      mouth: { closed: 'layers/mouth-closed.svg', open: 'layers/mouth-open.svg' },
      effects: { sparkle: 'effects/sparkle.svg' },
    },
    states: Object.fromEntries(CHARACTER_STATES.map(state => [state, { expression: 'neutral', effect: state === 'success' ? 'sparkle' : undefined, fallback: 'idle', animation }])),
    idleActions: { breathe: { animation }, sparkle: { effect: 'sparkle', animation: richAnimation } },
    bondUnlocks: [{ level: 1, expressions: ['neutral'], idleActions: ['breathe'], bubbles: { zh: ['你好'], en: ['Hello'] } }],
  }
}

type JsonRecord = Record<string, unknown>

function setPath(root: JsonRecord, path: readonly string[], value: unknown): JsonRecord {
  let cursor = root
  for (const key of path.slice(0, -1)) cursor = cursor[key] as JsonRecord
  cursor[path.at(-1)!] = value
  return root
}

function getPath(root: JsonRecord, path: readonly string[]): unknown {
  let cursor: unknown = root
  for (const key of path) cursor = (cursor as JsonRecord)[key]
  return cursor
}

function packRoots(prefix: string): { root: string; builtins: string } {
  const base = mkdtempSync(join(tmpdir(), prefix))
  const root = join(base, 'packs')
  const builtins = join(base, 'builtins')
  mkdirSync(builtins, { recursive: true })
  for (const name of [
    'builtin-lumi.svg', 'builtin-library.svg', 'builtin-body.svg', 'builtin-mouth-closed.svg',
    'builtin-mouth-open.svg', 'builtin-expression-neutral.svg', 'builtin-expression-happy.svg',
    'builtin-expression-concerned.svg', 'builtin-expression-focused.svg', 'builtin-effect-sparkle.svg',
  ]) writeFileSync(join(builtins, name), '<svg/>')
  return { root, builtins }
}

interface FakeResponse {
  writeHead: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
  write: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  close?: () => void
}

function response(): FakeResponse {
  const value: FakeResponse = {
    writeHead: vi.fn(),
    end: vi.fn(),
    write: vi.fn(),
    on: vi.fn((event: string, listener: () => void) => {
      if (event === 'close') value.close = listener
      return value
    }),
  }
  return value
}

function writePack(root: string, id: string, value: unknown): string {
  const dir = join(root, id)
  for (const child of ['layers', 'expressions', 'effects']) mkdirSync(join(dir, child), { recursive: true })
  for (const file of [
    'preview.webp', 'background.webp', 'layers/body.svg', 'layers/mouth-closed.svg',
    'layers/mouth-open.svg', 'expressions/neutral.svg', 'effects/sparkle.svg',
  ]) writeFileSync(join(dir, file), 'asset')
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(value))
  return dir
}

describe('LumiPackCatalog', () => {
  beforeEach(() => {
    watchControl.throws = false
    watchControl.failure = undefined
    watchControl.watchers = []
  })

  it('publishes complete v1 packs and keeps an unlicensed pack local-only', () => {
    const { root, builtins } = packRoots('dsh-lumi-pack-')
    writePack(root, 'luna', manifest('luna', null))
    const warn = vi.fn()
    const catalog = new LumiPackCatalog(root, builtins, { warn })
    try {
      const snapshot = catalog.snapshot()
      expect(snapshot.packs.map(pack => pack.manifest.id)).toEqual(['builtin-lumi', 'luna'])
      expect(snapshot.packs[1]).toMatchObject({
        manifest: { id: 'luna', displayName: 'Luna', version: '1.0.0' },
        publishable: false,
        assets: { body: '/lumi/assets/packs/luna/body', mouth: { open: '/lumi/assets/packs/luna/mouth%3Aopen' } },
      })
      expect(snapshot.assets.get('/lumi/assets/packs/luna/body')).toBe(join(root, 'luna', 'layers', 'body.svg'))
      expect(snapshot.diagnostics).toEqual([])
    } finally {
      catalog.dispose()
    }
  })

  it('rejects missing, incomplete, traversal, and directory-id mismatches with diagnostics', () => {
    const { root, builtins } = packRoots('dsh-lumi-invalid-pack-')
    writePack(root, 'missing-state', { ...manifest('missing-state'), states: { idle: manifest('x').states.idle } })
    writePack(root, 'escape', { ...manifest('escape'), assets: { ...manifest('escape').assets, body: 'layers/../preview.webp' } })
    writePack(root, 'wrong-directory', manifest('different-id'))
    const warn = vi.fn()
    const catalog = new LumiPackCatalog(root, builtins, { warn })
    try {
      const snapshot = catalog.snapshot()
      expect(snapshot.packs.map(pack => pack.manifest.id)).toEqual(['builtin-lumi'])
      expect(snapshot.diagnostics.map(item => item.directory)).toEqual(['escape', 'missing-state', 'wrong-directory'])
      expect(warn).toHaveBeenCalledTimes(3)
    } finally {
      catalog.dispose()
    }
  })

  it('rejects every invalid manifest field and asset reference independently', () => {
    const { root, builtins } = packRoots('dsh-lumi-invalid-matrix-')
    const mutations: readonly ((raw: JsonRecord, dir: string) => void)[] = [
      raw => setPath(raw, ['schemaVersion'], 2),
      raw => setPath(raw, ['id'], ''),
      raw => setPath(raw, ['id'], 'Invalid ID'),
      raw => setPath(raw, ['id'], 'x'.repeat(65)),
      raw => setPath(raw, ['id'], 'different'),
      raw => setPath(raw, ['displayName'], ' '),
      raw => setPath(raw, ['author'], 1),
      raw => setPath(raw, ['license'], ''),
      raw => setPath(raw, ['version'], null),
      raw => setPath(raw, ['canvas'], []),
      raw => setPath(raw, ['canvas', 'anchor'], null),
      raw => setPath(raw, ['canvas', 'safeMargin'], null),
      raw => setPath(raw, ['canvas', 'width'], 0),
      raw => setPath(raw, ['canvas', 'width'], 20_000),
      raw => setPath(raw, ['canvas', 'height'], Number.NaN),
      raw => setPath(raw, ['canvas', 'anchor', 'x'], -1),
      raw => setPath(raw, ['canvas', 'anchor', 'y'], 2_000),
      raw => setPath(raw, ['canvas', 'safeMargin', 'top'], -1),
      raw => setPath(raw, ['canvas', 'safeMargin', 'right'], '20'),
      raw => setPath(raw, ['canvas', 'safeMargin', 'bottom'], 20_000),
      raw => setPath(raw, ['canvas', 'safeMargin', 'left'], Number.POSITIVE_INFINITY),
      raw => setPath(raw, ['canvas', 'safeMargin', 'left'], 700),
      raw => setPath(raw, ['canvas', 'safeMargin', 'top'], 1_100),
      raw => setPath(raw, ['assets'], null),
      raw => setPath(raw, ['assets', 'preview'], 'other.webp'),
      raw => setPath(raw, ['assets', 'background'], 'other.webp'),
      raw => setPath(raw, ['assets', 'expressions'], []),
      raw => setPath(raw, ['assets', 'mouth'], null),
      raw => setPath(raw, ['assets', 'effects'], []),
      raw => setPath(raw, ['assets', 'body'], 1),
      raw => setPath(raw, ['assets', 'body'], isAbsolute(root) ? root : join(root, 'absolute.svg')),
      raw => setPath(raw, ['assets', 'body'], 'layers\\body.svg'),
      raw => setPath(raw, ['assets', 'body'], 'layers/../preview.webp'),
      raw => setPath(raw, ['assets', 'body'], 'body.svg'),
      raw => setPath(raw, ['assets', 'body'], 'layers/missing.svg'),
      (raw, dir) => { setPath(raw, ['assets', 'body'], 'layers/directory.svg'); mkdirSync(join(dir, 'layers', 'directory.svg')) },
      (raw, dir) => { setPath(raw, ['assets', 'body'], 'layers/body.txt'); writeFileSync(join(dir, 'layers', 'body.txt'), 'asset') },
      raw => setPath(raw, ['assets', 'preview'], 'missing.webp'),
      raw => setPath(raw, ['assets', 'background'], 'missing.webp'),
      raw => setPath(raw, ['assets', 'expressions'], {}),
      raw => setPath(raw, ['assets', 'expressions'], { '': 'expressions/neutral.svg' }),
      raw => setPath(raw, ['assets', 'expressions'], { neutral: 'expressions/missing.svg' }),
      raw => setPath(raw, ['assets', 'mouth', 'closed'], 'layers/missing.svg'),
      raw => setPath(raw, ['assets', 'mouth', 'open'], 'layers/missing.svg'),
      raw => setPath(raw, ['assets', 'effects'], { '': 'effects/sparkle.svg' }),
      raw => setPath(raw, ['assets', 'effects'], { sparkle: 'effects/missing.svg' }),
      raw => setPath(raw, ['states'], null),
      raw => setPath(raw, ['states', 'idle'], null),
      raw => setPath(raw, ['states', 'idle', 'expression'], ''),
      raw => setPath(raw, ['states', 'idle', 'expression'], 'missing'),
      raw => setPath(raw, ['states', 'idle', 'fallback'], ''),
      raw => setPath(raw, ['states', 'idle', 'fallback'], 'missing'),
      raw => setPath(raw, ['states', 'idle', 'effect'], ''),
      raw => setPath(raw, ['states', 'idle', 'effect'], 'missing'),
      raw => setPath(raw, ['states', 'idle', 'animation'], null),
      raw => setPath(raw, ['states', 'idle', 'animation', 'keyframes'], null),
      raw => setPath(raw, ['states', 'idle', 'animation', 'keyframes'], [{ at: 0 }]),
      raw => setPath(raw, ['states', 'idle', 'animation', 'loop'], 'forever'),
      raw => setPath(raw, ['states', 'idle', 'animation', 'minDurationMs'], -1),
      raw => setPath(raw, ['states', 'idle', 'animation', 'keyframes', '0'], null),
      raw => setPath(raw, ['states', 'idle', 'animation', 'keyframes', '0', 'at'], '0'),
      raw => setPath(raw, ['states', 'idle', 'animation', 'keyframes'], [{ at: 0.5 }, { at: 0.4 }]),
      raw => setPath(raw, ['states', 'idle', 'animation', 'keyframes', '0', 'translateX'], 20_000),
      raw => setPath(raw, ['states', 'idle', 'animation', 'keyframes', '0', 'scale'], 0),
      raw => setPath(raw, ['states', 'idle', 'animation', 'keyframes', '0', 'opacity'], 2),
      raw => setPath(raw, ['states', 'idle', 'animation', 'keyframes', '0', 'mouth'], 'wide'),
      raw => setPath(raw, ['states', 'idle', 'animation', 'keyframes', '0', 'at'], 0.1),
      raw => setPath(raw, ['states', 'idle', 'animation', 'keyframes', '1', 'at'], 0.9),
      raw => setPath(raw, ['idleActions'], null),
      raw => setPath(raw, ['idleActions'], { '': { animation } }),
      raw => setPath(raw, ['idleActions'], { breathe: null }),
      raw => setPath(raw, ['idleActions', 'breathe', 'effect'], ''),
      raw => setPath(raw, ['idleActions', 'breathe', 'effect'], 'missing'),
      raw => setPath(raw, ['idleActions', 'breathe', 'animation'], null),
      raw => setPath(raw, ['bondUnlocks'], null),
      raw => setPath(raw, ['bondUnlocks'], [null]),
      raw => setPath(raw, ['bondUnlocks', '0', 'level'], 1.5),
      raw => setPath(raw, ['bondUnlocks', '0', 'level'], 0),
      raw => setPath(raw, ['bondUnlocks'], [getPath(raw, ['bondUnlocks', '0']), getPath(raw, ['bondUnlocks', '0'])]),
      raw => setPath(raw, ['bondUnlocks', '0', 'bubbles'], null),
      raw => setPath(raw, ['bondUnlocks', '0', 'expressions'], null),
      raw => setPath(raw, ['bondUnlocks', '0', 'idleActions'], ['']),
      raw => setPath(raw, ['bondUnlocks', '0', 'bubbles', 'zh'], null),
      raw => setPath(raw, ['bondUnlocks', '0', 'bubbles', 'en'], [1]),
      raw => setPath(raw, ['bondUnlocks', '0', 'expressions'], ['missing']),
      raw => setPath(raw, ['bondUnlocks', '0', 'idleActions'], ['missing']),
    ]
    const invalidDirectories: string[] = []
    for (const [index, mutate] of mutations.entries()) {
      const id = `invalid-${String(index).padStart(2, '0')}`
      const raw = structuredClone(manifest(id)) as unknown as JsonRecord
      const dir = writePack(root, id, raw)
      mutate(raw, dir)
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify(raw))
      invalidDirectories.push(id)
    }
    for (const id of ['missing-layers', 'layers-is-file', 'missing-manifest', 'invalid-json', 'array-json']) {
      const dir = join(root, id)
      mkdirSync(dir, { recursive: true })
      if (id === 'layers-is-file') writeFileSync(join(dir, 'layers'), 'not a directory')
      else if (id !== 'missing-layers') mkdirSync(join(dir, 'layers'))
      mkdirSync(join(dir, 'expressions'))
      mkdirSync(join(dir, 'effects'))
      if (id === 'invalid-json') writeFileSync(join(dir, 'manifest.json'), '{')
      else if (id === 'array-json') writeFileSync(join(dir, 'manifest.json'), '[]')
      else if (id !== 'missing-manifest') writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest(id)))
      invalidDirectories.push(id)
    }
    for (const missing of ['preview.webp', 'background.webp']) {
      const id = `missing-${missing.slice(0, -5)}`
      const dir = join(root, id)
      for (const child of ['layers', 'expressions', 'effects']) mkdirSync(join(dir, child), { recursive: true })
      for (const file of [
        'preview.webp', 'background.webp', 'layers/body.svg', 'layers/mouth-closed.svg',
        'layers/mouth-open.svg', 'expressions/neutral.svg', 'effects/sparkle.svg',
      ]) {
        if (file !== missing) writeFileSync(join(dir, file), 'asset')
      }
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest(id)))
      invalidDirectories.push(id)
    }
    writePack(root, 'builtin-lumi', manifest('builtin-lumi'))
    const warn = vi.fn()
    const catalog = new LumiPackCatalog(root, builtins, { warn })
    try {
      const snapshot = catalog.snapshot()
      expect(snapshot.packs.map(pack => pack.manifest.id)).toEqual(['builtin-lumi'])
      expect(snapshot.diagnostics.map(item => item.directory)).toEqual([...invalidDirectories, 'builtin-lumi'].sort())
      expect(warn).toHaveBeenCalledTimes(invalidDirectories.length + 1)
    } finally {
      catalog.dispose()
    }
  })

  it('serves catalog, events, and allowlisted assets with exact method behavior', () => {
    const { root, builtins } = packRoots('dsh-lumi-routes-')
    const warn = vi.fn()
    const catalog = new LumiPackCatalog(root, builtins, { warn })
    const routes: Array<{ path: string; handler: (req: { method?: string; url?: string }, res: FakeResponse) => void }> = []
    const disposeOrder: string[] = []
    const server = {
      register: vi.fn((route: { path: string; handler: (req: { method?: string; url?: string }, res: FakeResponse) => void }) => {
        routes.push(route)
        return () => { disposeOrder.push(route.path) }
      }),
    }
    const disposeRoutes = catalog.register(server as never)
    const route = (path: string) => routes.find(item => item.path === path)!.handler
    try {
      const packs = route('/lumi/packs')
      for (const method of ['POST', 'HEAD', 'GET']) {
        const res = response()
        packs({ method }, res)
        if (method === 'POST') expect(res.writeHead).toHaveBeenCalledWith(405)
        else expect(res.writeHead).toHaveBeenCalledWith(200, expect.anything())
        expect(res.end).toHaveBeenCalled()
      }

      const events = route('/lumi/packs/events')
      const rejected = response()
      events({ method: 'HEAD' }, rejected)
      expect(rejected.writeHead).toHaveBeenCalledWith(405)
      const stream = response()
      events({ method: 'GET' }, stream)
      expect(stream.write).toHaveBeenCalledWith('data: 0\n\n')
      watchControl.watchers.at(-1)!.emit('change', 'rename', 'fixture')
      expect(stream.write).toHaveBeenLastCalledWith('data: 1\n\n')
      stream.close!()
      watchControl.watchers.at(-1)!.emit('error', new Error('watch failed'))
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ message: 'watch failed' }))

      const assets = route('/lumi/assets')
      const methodRejected = response()
      assets({ method: 'POST' }, methodRejected)
      expect(methodRejected.writeHead).toHaveBeenCalledWith(405)
      const absent = response()
      assets({ method: 'GET' }, absent)
      expect(absent.writeHead).toHaveBeenCalledWith(404)
      const head = response()
      assets({ method: 'HEAD', url: '/lumi/assets/builtin-lumi/preview' }, head)
      expect(head.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ 'content-type': 'image/svg+xml; charset=utf-8' }))
      expect(head.end).toHaveBeenCalledWith()
      const get = response()
      assets({ method: 'GET', url: '/lumi/assets/builtin-lumi/preview' }, get)
      expect(get.end).toHaveBeenCalledWith(expect.any(Buffer))

      const openStream = response()
      events({ method: 'GET' }, openStream)
      catalog.dispose()
      expect(openStream.end).toHaveBeenCalled()
    } finally {
      disposeRoutes()
      catalog.dispose()
    }
    expect(disposeOrder).toEqual(['/lumi/assets', '/lumi/packs/events', '/lumi/packs'])
  })

  it.each([
    new Error('watch constructor failed'),
    'non-error watch failure',
  ])('degrades when recursive watching cannot start: %p', (failure) => {
    const { root, builtins } = packRoots('dsh-lumi-watch-failure-')
    watchControl.throws = true
    watchControl.failure = failure
    const warn = vi.fn()
    const catalog = new LumiPackCatalog(root, builtins, { warn })
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ message: failure instanceof Error ? failure.message : failure }))
    catalog.dispose()
  })
})
