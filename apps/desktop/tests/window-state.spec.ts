import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  placementIsVisible, readWindowPlacement, resolveWindowPlacement, writeWindowPlacement,
} from '../src/window-state.ts'

describe('desktop window placement', () => {
  const primary = { x: 0, y: 0, width: 1920, height: 1040 }

  it('restores visible bounds and rejects off-screen or malformed state', () => {
    const visible = { x: 100, y: 80, width: 1200, height: 800, maximized: true }
    expect(placementIsVisible(visible, [primary])).toBe(true)
    expect(resolveWindowPlacement(visible, [primary], primary, { width: 1440, height: 920 })).toEqual(visible)
    expect(resolveWindowPlacement({ ...visible, x: 4000 }, [primary], primary, { width: 1440, height: 920 }))
      .toEqual({ x: 240, y: 60, width: 1440, height: 920, maximized: false })
  })

  it('reads and atomically replaces the desktop-owned JSON document', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'dsh-lumi-window-')), 'state.json')
    const first = { x: 12, y: 34, width: 900, height: 640, maximized: false }
    const second = { ...first, width: 1200, maximized: true }
    writeWindowPlacement(path, first)
    expect(readWindowPlacement(path)).toEqual(first)
    writeWindowPlacement(path, second)
    expect(readWindowPlacement(path)).toEqual(second)
    expect(readFileSync(path, 'utf8')).toContain('"maximized": true')
    writeFileSync(path, '{broken')
    expect(readWindowPlacement(path)).toBeUndefined()
  })
})
