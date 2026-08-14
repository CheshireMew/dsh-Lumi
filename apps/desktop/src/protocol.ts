/** Structured lifecycle events sent from the Harness utility process. */
export type HarnessWorkerEvent =
  | { type: 'starting' }
  | { type: 'ready'; url: string; port: number }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'fatal'; stage: string; message: string; stack?: string }
  | { type: 'stopped'; code: number }

/** Structured commands sent from Electron to the Harness utility process. */
export type HarnessWorkerCommand =
  | { type: 'shutdown' }
  | { type: 'restart' }

/** JSON object guard for the process-message boundary. */
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** True when an unknown message is a valid lifecycle event. */
export function isHarnessWorkerEvent(value: unknown): value is HarnessWorkerEvent {
  if (!record(value) || typeof value['type'] !== 'string') return false
  switch (value['type']) {
    case 'starting':
      return true
    case 'ready':
      return typeof value['url'] === 'string'
        && typeof value['port'] === 'number'
        && Number.isInteger(value['port'])
        && value['port'] > 0
        && value['port'] <= 65_535
        && value['url'] === `http://127.0.0.1:${value['port']}`
    case 'log':
      return (value['level'] === 'info' || value['level'] === 'warn' || value['level'] === 'error')
        && typeof value['message'] === 'string'
    case 'fatal':
      return typeof value['stage'] === 'string'
        && typeof value['message'] === 'string'
        && (value['stack'] === undefined || typeof value['stack'] === 'string')
    case 'stopped':
      return typeof value['code'] === 'number' && Number.isInteger(value['code'])
    default:
      return false
  }
}

/** True when an unknown parent message is a declared worker command. */
export function isHarnessWorkerCommand(value: unknown): value is HarnessWorkerCommand {
  return record(value) && (value['type'] === 'shutdown' || value['type'] === 'restart')
}

/** True when an unknown message is the worker's successful startup notice. */
export function isReadyMessage(value: unknown): value is Extract<HarnessWorkerEvent, { type: 'ready' }> {
  return isHarnessWorkerEvent(value) && value.type === 'ready'
}

/** True when an unknown message reports a fatal worker failure. */
export function isFatalMessage(value: unknown): value is Extract<HarnessWorkerEvent, { type: 'fatal' }> {
  return isHarnessWorkerEvent(value) && value.type === 'fatal'
}

/** True when an unknown parent message asks the worker to stop. */
export function isShutdownCommand(value: unknown): value is Extract<HarnessWorkerCommand, { type: 'shutdown' }> {
  return isHarnessWorkerCommand(value) && value.type === 'shutdown'
}
