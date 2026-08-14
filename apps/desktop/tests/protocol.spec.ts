import { describe, expect, it } from 'vitest'
import {
  isFatalMessage, isHarnessWorkerCommand, isHarnessWorkerEvent, isReadyMessage, isShutdownCommand,
} from '../src/protocol.ts'

describe('desktop worker protocol', () => {
  it('accepts every declared lifecycle event and rejects adjacent values', () => {
    expect(isHarnessWorkerEvent({ type: 'starting' })).toBe(true)
    expect(isHarnessWorkerEvent({ type: 'log', level: 'warn', message: 'slow' })).toBe(true)
    expect(isHarnessWorkerEvent({ type: 'fatal', stage: 'boot', message: 'boom', stack: 'trace' })).toBe(true)
    expect(isHarnessWorkerEvent({ type: 'stopped', code: 0 })).toBe(true)
    expect(isHarnessWorkerEvent({ type: 'log', level: 'debug', message: 'no' })).toBe(false)
    expect(isHarnessWorkerEvent({ type: 'stopped' })).toBe(false)
    expect(isHarnessWorkerEvent({ type: 'fatal', stage: 1, message: 'no' })).toBe(false)
  })

  it('accepts only a matching loopback ready message', () => {
    expect(isReadyMessage({ type: 'ready', port: 31_337, url: 'http://127.0.0.1:31337' })).toBe(true)
    expect(isReadyMessage({ type: 'ready', port: 31_337, url: 'http://localhost:31337' })).toBe(false)
    expect(isReadyMessage({ type: 'ready', port: 0, url: 'http://127.0.0.1:0' })).toBe(false)
    expect(isReadyMessage({ type: 'ready', port: 70_000, url: 'http://127.0.0.1:70000' })).toBe(false)
    expect(isReadyMessage(null)).toBe(false)
  })

  it('narrows fatal, shutdown, and restart messages independently', () => {
    expect(isFatalMessage({ type: 'fatal', stage: 'runtime', message: 'boom' })).toBe(true)
    expect(isFatalMessage({ type: 'fatal', stage: 'runtime', message: 42 })).toBe(false)
    expect(isShutdownCommand({ type: 'shutdown' })).toBe(true)
    expect(isShutdownCommand({ type: 'restart' })).toBe(false)
    expect(isHarnessWorkerCommand({ type: 'restart' })).toBe(true)
    expect(isHarnessWorkerCommand({ type: 'reload' })).toBe(false)
  })
})
