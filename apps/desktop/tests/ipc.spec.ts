import { describe, expect, it } from 'vitest'
import { DESKTOP_EVENT_CHANNELS, DESKTOP_INVOKE_CHANNELS } from '../src/ipc.ts'

describe('desktop preload IPC allowlist', () => {
  it('contains only the bridge actions and one state event', () => {
    expect(Object.values(DESKTOP_INVOKE_CHANNELS).sort()).toEqual([
      'desktop:app:open-logs',
      'desktop:app:open-packs',
      'desktop:app:restart-harness',
      'desktop:window:close',
      'desktop:window:get-state',
      'desktop:window:minimize',
      'desktop:window:toggle-maximize',
    ])
    expect(Object.values(DESKTOP_EVENT_CHANNELS)).toEqual(['desktop:window:state-changed'])
  })
})
