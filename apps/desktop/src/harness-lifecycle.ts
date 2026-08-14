import type { DesktopRuntimeConfig } from './config.ts'
import { isHarnessWorkerEvent, type HarnessWorkerCommand } from './protocol.ts'

/** Minimal utility-process operations owned by the desktop lifecycle controller. */
export interface HarnessProcess {
  postMessage(command: HarnessWorkerCommand): void
  kill(): void
  onMessage(listener: (value: unknown) => void): void
  onError(listener: (type: unknown, location: string) => void): void
  onExit(listener: (code: number) => void): void
}

/** Electron-facing effects emitted by the Harness lifecycle controller. */
export interface HarnessLifecycleEffects {
  spawn(): HarnessProcess
  onSpawn(process: HarnessProcess): void
  onReady(url: string, port: number): void
  onLog(level: 'info' | 'warn' | 'error', message: string): void
  onLoading(message: string): void
  onFailure(stage: string, message: string, stack?: string): void
  onExit(code: number): void
}

/** Scheduler seam used by lifecycle tests and the Electron main process. */
export interface HarnessLifecycleScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(timer: unknown): void
}

const systemScheduler: HarnessLifecycleScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) =>{  clearTimeout(timer as ReturnType<typeof setTimeout>) },
}

/**
 * Owns one Harness process, startup and shutdown deadlines, retries, and restarts.
 *
 * @param config Desktop lifecycle timing and retry values.
 * @param effects Process factory and presentation effects.
 * @param scheduler Optional deterministic scheduler for tests.
 */
export class HarnessLifecycleController {
  readonly #config: DesktopRuntimeConfig
  readonly #effects: HarnessLifecycleEffects
  readonly #scheduler: HarnessLifecycleScheduler
  #process: HarnessProcess | undefined
  #startupTimer: unknown
  #retryTimer: unknown
  #retryResetTimer: unknown
  #stopPromise: Promise<void> | undefined
  #resolveStop: (() => void) | undefined
  #shutdownTimer: unknown
  #quitting = false
  #restarting = false
  #workerReportedFatal = false
  #disconnectRetries = 0

  constructor(
    config: DesktopRuntimeConfig,
    effects: HarnessLifecycleEffects,
    scheduler: HarnessLifecycleScheduler = systemScheduler,
  ) {
    this.#config = config
    this.#effects = effects
    this.#scheduler = scheduler
  }

  /** Starts the Harness when no process or pending retry owns the lifecycle. */
  start(): void {
    if (this.#process !== undefined || this.#retryTimer !== undefined || this.#quitting) return
    this.#clearStartupTimer()
    this.#workerReportedFatal = false
    const process = this.#effects.spawn()
    this.#process = process
    this.#effects.onSpawn(process)
    process.onMessage((value) => { this.#receive(process, value) })
    process.onError((type, location) => {
      if (process !== this.#process) return
      this.#fail(`utility-process:${location}`, String(type))
    })
    process.onExit((code) => { this.#exited(process, code) })
    this.#startupTimer = this.#scheduler.setTimeout(() => {
      if (process !== this.#process) return
      this.#fail('startup-timeout', `Harness 在 ${this.#config.startupTimeoutMs}ms 内未就绪。`)
      process.kill()
    }, this.#config.startupTimeoutMs)
  }

  /** Stops the current process and allows a bounded graceful shutdown. */
  stop(command: HarnessWorkerCommand = { type: 'shutdown' }): Promise<void> {
    if (this.#stopPromise !== undefined) return this.#stopPromise
    const process = this.#process
    if (process === undefined) return Promise.resolve()
    this.#stopPromise = new Promise<void>((resolve) => { this.#resolveStop = resolve })
    this.#shutdownTimer = this.#scheduler.setTimeout(() => {
      if (process !== this.#process) return
      this.#effects.onLog('warn', 'Harness did not stop within the grace period; terminating utility process')
      process.kill()
    }, this.#config.shutdownTimeoutMs)
    process.postMessage(command)
    return this.#stopPromise
  }

  /** Restarts through the worker's structured restart command. */
  async restart(): Promise<void> {
    if (this.#restarting || this.#quitting) return
    this.#restarting = true
    this.#clearRetryTimer()
    this.#effects.onLoading('正在重新启动 Harness…')
    try {
      await this.stop({ type: 'restart' })
      this.#disconnectRetries = 0
      this.start()
    } finally {
      this.#restarting = false
    }
  }

  /** Prevents retries and gracefully stops the process for application quit. */
  async shutdown(): Promise<void> {
    this.#quitting = true
    this.#clearRetryTimer()
    await this.stop()
  }

  #receive(process: HarnessProcess, value: unknown): void {
    if (process !== this.#process || !isHarnessWorkerEvent(value)) return
    switch (value.type) {
      case 'starting':
        this.#effects.onLog('info', 'Harness worker reported starting')
        break
      case 'ready':
        this.#clearStartupTimer()
        this.#clearRetryResetTimer()
        this.#retryResetTimer = this.#scheduler.setTimeout(() => {
          this.#retryResetTimer = undefined
          this.#disconnectRetries = 0
        }, this.#config.disconnectRetryResetMs)
        this.#effects.onReady(value.url, value.port)
        break
      case 'log':
        this.#effects.onLog(value.level, value.message)
        break
      case 'fatal':
        this.#fail(value.stage, value.message, value.stack)
        break
      case 'stopped':
        this.#effects.onLog(value.code === 0 ? 'info' : 'error', `Harness reported stopped with code ${value.code}`)
        break
    }
  }

  #fail(stage: string, message: string, stack?: string): void {
    this.#workerReportedFatal = true
    this.#clearStartupTimer()
    this.#effects.onFailure(stage, message, stack)
  }

  #exited(process: HarnessProcess, code: number): void {
    if (process !== this.#process) return
    this.#clearStartupTimer()
    this.#clearShutdownTimer()
    this.#clearRetryResetTimer()
    this.#process = undefined
    this.#stopPromise = undefined
    this.#resolveStop?.()
    this.#resolveStop = undefined
    this.#effects.onExit(code)
    if (this.#quitting || this.#restarting) return
    if (!this.#workerReportedFatal && this.#scheduleRetry(code)) return
    if (!this.#workerReportedFatal) this.#fail('worker-exit', `Harness 已退出（代码 ${code}）。`)
  }

  #scheduleRetry(code: number): boolean {
    if (this.#disconnectRetries >= this.#config.disconnectRetryCount) return false
    this.#disconnectRetries += 1
    const message = `Harness 连接中断，正在重试（${this.#disconnectRetries}/${this.#config.disconnectRetryCount}）`
    this.#effects.onLog('warn', `Harness disconnected with code ${code}; retry ${this.#disconnectRetries}/${this.#config.disconnectRetryCount}`)
    this.#effects.onLoading(message)
    this.#retryTimer = this.#scheduler.setTimeout(() => {
      this.#retryTimer = undefined
      this.start()
    }, this.#config.disconnectRetryDelayMs)
    return true
  }

  #clearStartupTimer(): void {
    if (this.#startupTimer !== undefined) this.#scheduler.clearTimeout(this.#startupTimer)
    this.#startupTimer = undefined
  }

  #clearRetryTimer(): void {
    if (this.#retryTimer !== undefined) this.#scheduler.clearTimeout(this.#retryTimer)
    this.#retryTimer = undefined
  }

  #clearShutdownTimer(): void {
    if (this.#shutdownTimer !== undefined) this.#scheduler.clearTimeout(this.#shutdownTimer)
    this.#shutdownTimer = undefined
  }

  #clearRetryResetTimer(): void {
    if (this.#retryResetTimer !== undefined) this.#scheduler.clearTimeout(this.#retryResetTimer)
    this.#retryResetTimer = undefined
  }
}
