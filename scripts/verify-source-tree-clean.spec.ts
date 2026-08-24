import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findSourceTreeEmits } from './verify-source-tree-clean.ts'

const roots: string[] = []

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-source-tree-clean-'))
  roots.push(root)
  return root
}

function write(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '')
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('findSourceTreeEmits', () => {
  it('finds JavaScript, declarations, and maps emitted beside TypeScript sources', () => {
    const root = fixture()
    write(join(root, 'packages/example/src/index.ts'))
    write(join(root, 'packages/example/src/index.js'))
    write(join(root, 'packages/example/src/index.js.map'))
    write(join(root, 'packages/example/src/index.d.ts'))
    write(join(root, 'packages/example/src/index.d.ts.map'))
    write(join(root, 'packages/example/src/view.tsx'))
    write(join(root, 'packages/example/src/view.js'))
    write(join(root, 'packages/example/src/widget.tsx'))
    write(join(root, 'packages/example/src/widget.jsx'))
    write(join(root, 'scripts/worker.mts'))
    write(join(root, 'scripts/worker.mjs'))
    write(join(root, 'scripts/runner.cts'))
    write(join(root, 'scripts/runner.d.cts'))

    expect(findSourceTreeEmits(root)).toEqual([
      'packages/example/src/index.d.ts',
      'packages/example/src/index.d.ts.map',
      'packages/example/src/index.js',
      'packages/example/src/index.js.map',
      'packages/example/src/view.js',
      'packages/example/src/widget.jsx',
      'scripts/runner.d.cts',
      'scripts/worker.mjs',
    ])
  })

  it('ignores authored files without a TypeScript sibling and generated output roots', () => {
    const root = fixture()
    write(join(root, 'packages/example/src/fixture.js'))
    write(join(root, 'packages/example/src/types.d.ts'))
    write(join(root, 'packages/example/lib/index.ts'))
    write(join(root, 'packages/example/lib/index.js'))
    write(join(root, 'artifacts/capture.ts'))
    write(join(root, 'artifacts/capture.js'))

    expect(findSourceTreeEmits(root)).toEqual([])
  })

  it('does not follow directory symlinks outside the repository', () => {
    const root = fixture()
    const external = fixture()
    write(join(external, 'index.ts'))
    write(join(external, 'index.js'))
    mkdirSync(join(root, 'packages'), { recursive: true })
    symlinkSync(external, join(root, 'packages/external'), process.platform === 'win32' ? 'junction' : 'dir')

    expect(findSourceTreeEmits(root)).toEqual([])
  })
})
