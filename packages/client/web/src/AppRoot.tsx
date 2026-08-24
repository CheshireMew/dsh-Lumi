/**
 * Shell root: boot loading page → (boot settled) → real UI in one switch.
 * Pure kernel component with zero plugin dependencies — before settled it may
 * only rely on itself (the fail-loud presentation must not depend on the
 * system whose failure it reports; the status/signal stores are kernel-own,
 * shell self-sufficiency rule); the real UI is produced by the
 * app-shell entry once every entry is active. A failed boot keeps the
 * loading page, lists the per-entry fiber states and the sweep report (fail
 * loud, no partial UI).
 */
import { useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { KernelSignal, LoaderStatus } from './loader-status.ts'
import css from './AppRoot.module.css'

const bootCopy = {
  en: {
    loading: 'Loading plugins…',
    failedTitle: 'Failed to load plugins',
    failedDescription: 'The application could not finish starting. Retry now, or use the recovery actions below.',
    retry: 'Retry',
    restart: 'Restart service',
    logs: 'Open logs',
    copy: 'Copy diagnostics',
    copied: 'Diagnostics copied',
    details: 'Technical details',
    actionFailed: 'That recovery action failed. Try again or open the logs for details.',
  },
  zh: {
    loading: '正在加载插件…',
    failedTitle: '插件加载失败',
    failedDescription: '应用未能完成启动。你可以立即重试，或使用下面的恢复操作。',
    retry: '重试',
    restart: '重启服务',
    logs: '打开日志',
    copy: '复制诊断信息',
    copied: '诊断信息已复制',
    details: '技术详情',
    actionFailed: '恢复操作失败。请重试，或打开日志查看详情。',
  },
} as const

type DesktopRecoveryBridge = {
  app: {
    restartHarness: () => Promise<void>
    openLogsFolder: () => Promise<void>
  }
}

function desktopRecoveryBridge(): DesktopRecoveryBridge | undefined {
  return (window as Window & { dshDesktop?: DesktopRecoveryBridge }).dshDesktop
}

async function copyText(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value)
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = value
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.append(textarea)
    textarea.select()
    // execCommand is the only synchronous fallback when Clipboard API access
    // is rejected on the boot failure surface.
    const copied = document.execCommand('copy')
    textarea.remove()
    if (!copied) throw new Error('clipboard write failed')
  }
}

/** AppRoot props: settled signal, fiber-state projection feed, boot failure report, deferred real-UI factory. */
export interface AppRootProps {
  /** True once the boot chain settled (loader quiesced + all entries ACTIVE); the boot closure flips it. */
  settled: KernelSignal<boolean>
  /** Per-entry fiber-state projection store (drives loading/failed rendering). */
  status: KernelSignal<LoaderStatus>
  /** Boot failure report (the settle rejection message); undefined while loading or after success. */
  error: KernelSignal<string | undefined>
  /** Builds the real UI; called only after settled. */
  renderApp: () => ReactNode
}

/** Boot gate: loading page until the boot settles; failures stay here. */
export function AppRoot(props: AppRootProps) {
  const settled = useSyncExternalStore(props.settled.subscribe, props.settled.getSnapshot)
  const status = useSyncExternalStore(props.status.subscribe, props.status.getSnapshot)
  const error = useSyncExternalStore(props.error.subscribe, props.error.getSnapshot)
  const failed = Object.entries(status).filter(([, s]) => s === 'failed')
  const [busyAction, setBusyAction] = useState<'restart' | 'logs' | 'copy' | undefined>()
  const [actionError, setActionError] = useState(false)
  const [copied, setCopied] = useState(false)

  if (settled) return <>{props.renderApp()}</>

  const loud = error !== undefined || failed.length > 0
  const copy = navigator.language.toLowerCase().startsWith('zh') ? bootCopy.zh : bootCopy.en
  const desktop = desktopRecoveryBridge()
  const diagnostics = [
    ...failed.map(([id]) => `plugin: ${id}`),
    ...(error === undefined ? [] : [error]),
  ].join('\n')

  const recover = async (action: 'restart' | 'logs' | 'copy', operation: () => Promise<void>): Promise<void> => {
    setBusyAction(action)
    setActionError(false)
    try {
      await operation()
      if (action === 'copy') setCopied(true)
    } catch {
      setActionError(true)
    } finally {
      setBusyAction(undefined)
    }
  }

  return (
    <div className={css.boot}>
      <div className={css.card}>
        <div className={css.wordmark}>HARNESS</div>
        {!loud
          ? (
            <>
              <div className={css.spinner} />
              <div className={css.hint}>{copy.loading}</div>
            </>
          )
          : (
            <div className={css.failed}>
              <div className={css.failedTitle}>{copy.failedTitle}</div>
              <p className={css.failedDescription}>{copy.failedDescription}</p>
              <div className={css.actions}>
                <button type="button" className={css.primaryAction} onClick={() => { window.location.reload() }}>{copy.retry}</button>
                {desktop === undefined ? null : (
                  <button type="button" disabled={busyAction !== undefined} onClick={() => { void recover('restart', desktop.app.restartHarness) }}>
                    {copy.restart}
                  </button>
                )}
                {desktop === undefined ? null : (
                  <button type="button" disabled={busyAction !== undefined} onClick={() => { void recover('logs', desktop.app.openLogsFolder) }}>
                    {copy.logs}
                  </button>
                )}
                <button type="button" disabled={busyAction !== undefined} onClick={() => { void recover('copy', () => copyText(diagnostics)) }}>
                  {copied ? copy.copied : copy.copy}
                </button>
              </div>
              {actionError && <p className={css.actionError} role="alert">{copy.actionFailed}</p>}
              <details className={css.details}>
                <summary>{copy.details}</summary>
                <pre className={css.failedItem}>{diagnostics}</pre>
              </details>
            </div>
          )}
      </div>
    </div>
  )
}
