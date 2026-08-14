import { afterEach, describe, expect, it, vi } from 'vitest'
import { type DesktopRuntimeConfig } from '../src/config.ts'
import {
  HarnessLifecycleController, type HarnessLifecycleEffects, type HarnessProcess,
} from '../src/harness-lifecycle.ts'
import type { HarnessWorkerCommand } from '../src/protocol.ts'

class FakeHarnessProcess implements HarnessProcess {
  readonly commands: HarnessWorkerCommand[] = []
  kills = 0
  #messageListener: ((value: unknown) => void) | undefined
  #errorListener: ((type: unknown, location: string) => void) | undefined
  #exitListener: ((code: number) => void) | undefined

  postMessage(command: HarnessWorkerCommand): void { this.commands.push(command) }
  kill(): void { this.kills += 1 }
  onMessage(listener: (value: unknown) => void): void { this.#messageListener = listener }
  onError(listener: (type: unknown, location: string) => void): void { this.#errorListener = listener }
  onExit(listener: (code: number) => void): void { this.#exitListener = listener }
  message(value: unknown): void { this.#messageListener?.(value) }
  error(type: unknown, location: string): void { this.#errorListener?.(type, location) }
  exit(code: number): void { this.#exitListener?.(code) }
}

const config: DesktopRuntimeConfig = {
  startupTimeoutMs: 100,
  shutdownTimeoutMs: 50,
  disconnectRetryCount: 2,
  disconnectRetryDelayMs: 10,
  disconnectRetryResetMs: 1_000,
  windowSaveDelayMs: 1,
  window: { width: 1440, height: 920, minWidth: 900, minHeight: 640 },
}

function fixture(): {
  lifecycle: HarnessLifecycleController
  processes: FakeHarnessProcess[]
  spies: {
    onReady: ReturnType<typeof vi.fn>
    onLoading: ReturnType<typeof vi.fn>
    onFailure: ReturnType<typeof vi.fn>
  }
} {
  const processes: FakeHarnessProcess[] = []
  const onReady = vi.fn()
  const onLoading = vi.fn()
  const onFailure = vi.fn()
  const effects: HarnessLifecycleEffects = {
    spawn: vi.fn(() => {
      const process = new FakeHarnessProcess()
      processes.push(process)
      return process
    }),
    onSpawn: vi.fn(),
    onReady: (url, port) => { onReady(url, port) },
    onLog: vi.fn(),
    onLoading: (message) => { onLoading(message) },
    onFailure: (stage, message, stack) => { onFailure(stage, message, stack) },
    onExit: vi.fn(),
  }
  return {
    lifecycle: new HarnessLifecycleController(config, effects),
    processes,
    spies: { onReady, onLoading, onFailure },
  }
}

afterEach(() => { vi.useRealTimers() })

describe('HarnessLifecycleController', () => {
  it('accepts ready and cancels the startup deadline', () => {
    vi.useFakeTimers()
    const { lifecycle, processes, spies } = fixture()
    lifecycle.start()
    processes[0]?.message({ type: 'ready', url: 'http://127.0.0.1:32123', port: 32_123 })
    vi.advanceTimersByTime(config.startupTimeoutMs)
    expect(spies.onReady).toHaveBeenCalledWith('http://127.0.0.1:32123', 32_123)
    expect(processes[0]?.kills).toBe(0)
    expect(spies.onFailure).not.toHaveBeenCalled()
  })

  it('shows a fatal error without retrying after the worker exits', () => {
    vi.useFakeTimers()
    const { lifecycle, processes, spies } = fixture()
    lifecycle.start()
    processes[0]?.message({ type: 'fatal', stage: 'profile', message: 'broken', stack: 'trace' })
    processes[0]?.exit(1)
    vi.runAllTimers()
    expect(spies.onFailure).toHaveBeenCalledWith('profile', 'broken', 'trace')
    expect(processes).toHaveLength(1)
  })

  it('kills a worker that misses the startup deadline', () => {
    vi.useFakeTimers()
    const { lifecycle, processes, spies } = fixture()
    lifecycle.start()
    vi.advanceTimersByTime(config.startupTimeoutMs)
    expect(processes[0]?.kills).toBe(1)
    expect(spies.onFailure).toHaveBeenCalledWith(
      'startup-timeout', `Harness 在 ${config.startupTimeoutMs}ms 内未就绪。`, undefined,
    )
  })

  it('retries unexpected exits twice before presenting recovery', () => {
    vi.useFakeTimers()
    const { lifecycle, processes, spies } = fixture()
    lifecycle.start()
    processes[0]?.exit(7)
    vi.advanceTimersByTime(config.disconnectRetryDelayMs)
    processes[1]?.exit(8)
    vi.advanceTimersByTime(config.disconnectRetryDelayMs)
    processes[2]?.exit(9)
    vi.runAllTimers()
    expect(processes).toHaveLength(3)
    expect(spies.onLoading).toHaveBeenCalledTimes(2)
    expect(spies.onFailure).toHaveBeenCalledWith('worker-exit', 'Harness 已退出（代码 9）。', undefined)
  })

  it('restarts only after the old worker acknowledges the restart command', async () => {
    vi.useFakeTimers()
    const { lifecycle, processes, spies } = fixture()
    lifecycle.start()
    const restart = lifecycle.restart()
    expect(processes[0]?.commands).toEqual([{ type: 'restart' }])
    expect(processes).toHaveLength(1)
    processes[0]?.exit(0)
    await restart
    expect(processes).toHaveLength(2)
    expect(spies.onLoading).toHaveBeenCalledWith('正在重新启动 Harness…')
  })

  it('waits for graceful shutdown and kills only after its deadline', async () => {
    vi.useFakeTimers()
    const { lifecycle, processes } = fixture()
    lifecycle.start()
    const shutdown = lifecycle.shutdown()
    expect(processes[0]?.commands).toEqual([{ type: 'shutdown' }])
    vi.advanceTimersByTime(config.shutdownTimeoutMs)
    expect(processes[0]?.kills).toBe(1)
    processes[0]?.exit(0)
    await shutdown
    vi.runAllTimers()
    expect(processes).toHaveLength(1)
  })
})
