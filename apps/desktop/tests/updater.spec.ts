import { describe, expect, it, vi } from 'vitest'
import {
  startDesktopUpdater, type DesktopUpdateInfo, type DesktopUpdater,
} from '../src/updater.ts'

class FakeUpdater implements DesktopUpdater {
  autoDownload = false
  autoInstallOnAppQuit = false
  readonly listeners = new Map<string, (...args: never[]) => void>()
  readonly checkForUpdates = vi.fn(async () => undefined)
  readonly quitAndInstall = vi.fn()

  on(event: string, listener: (...args: never[]) => void): this {
    this.listeners.set(event, listener)
    return this
  }

  emit(event: string, info?: DesktopUpdateInfo): void {
    this.listeners.get(event)?.(info as never)
  }
}

describe('desktop updater', () => {
  it('does not contact the release provider during source development', async () => {
    const updater = new FakeUpdater()
    const log = vi.fn()
    await startDesktopUpdater(updater, false, { log, confirmInstall: vi.fn() })
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('INFO', expect.stringContaining('skipped'))
  })

  it('downloads signed releases and installs only after confirmation', async () => {
    const updater = new FakeUpdater()
    const confirmInstall = vi.fn(async () => true)
    await startDesktopUpdater(updater, true, { log: vi.fn(), confirmInstall })
    expect(updater.autoDownload).toBe(true)
    expect(updater.autoInstallOnAppQuit).toBe(true)
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
    updater.emit('update-downloaded', { version: '1.2.3' })
    await vi.waitFor(() => { expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true) })
    expect(confirmInstall).toHaveBeenCalledWith('1.2.3')
  })

  it('keeps update-provider failures non-fatal and visible in logs', async () => {
    const updater = new FakeUpdater()
    updater.checkForUpdates.mockRejectedValueOnce(new Error('offline'))
    const log = vi.fn()
    await startDesktopUpdater(updater, true, { log, confirmInstall: vi.fn() })
    expect(log).toHaveBeenCalledWith('WARN', 'update request failed: offline')
  })
})
