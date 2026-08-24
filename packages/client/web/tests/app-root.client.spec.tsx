// @vitest-environment jsdom
/**
 * AppRoot boot-gate smoke: loading page until the settled signal flips (status
 * alone never opens the gate), fail-loud entry list + boot failure report,
 * one-pass switch to the real UI. The full browser chain (real module system
 * + vendored Loader + bundles) is the e2e's job; this pins the shell-owned
 * gate semantics. Stores are the kernel-own signals production boot uses
 * (shell self-sufficiency: the loading page depends on no plugin package).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'

afterEach(() => {
  cleanup()
  delete (window as Window & { dshDesktop?: unknown }).dshDesktop
})
import { AppRoot } from '@deepseek-ai/dsh-client-web/src/AppRoot.tsx'
import { createLoaderStatusStore, createSignal } from '@deepseek-ai/dsh-client-web/src/loader-status.ts'

function mount() {
  const settled = createSignal(false)
  const error = createSignal<string | undefined>(undefined)
  const status = createLoaderStatusStore()
  let renders = 0
  const utils = render(
    <AppRoot
      settled={settled}
      status={status}
      error={error}
      renderApp={() => { renders += 1; return <div data-testid="real-ui" /> }}
    />,
  )
  return { settled, status, error, counts: () => renders, ...utils }
}

describe('AppRoot', () => {
  it('shows the loading page and never calls renderApp before settled', () => {
    const { queryByTestId, counts, getByText } = mount()
    expect(getByText('HARNESS')).toBeTruthy()
    expect(queryByTestId('real-ui')).toBeNull()
    expect(counts()).toBe(0)
  })

  it('all-active status alone does not open the gate (settled signal is the only key)', () => {
    const { status, queryByTestId } = mount()
    act(() => {
      status.set('a', 'active')
      status.set('b', 'active')
    })
    expect(queryByTestId('real-ui')).toBeNull()
  })

  it('lists failed entries and stays on the loading page', () => {
    const { status, getByText, queryByTestId } = mount()
    act(() => {
      status.set('@deepseek-ai/dsh-client-ui-layout', 'failed')
      status.set('ok', 'active')
    })
    expect(getByText('Failed to load plugins')).toBeTruthy()
    expect(getByText(/@deepseek-ai\/dsh-client-ui-layout/)).toBeTruthy()
    expect(queryByTestId('real-ui')).toBeNull()
  })

  it('renders the boot failure report even when no entry projected failed', () => {
    const { error, getByText, queryByTestId } = mount()
    act(() => { error.set('web boot: 1 entry did not activate\nx: pending (waiting for service: y)') })
    expect(getByText('Failed to load plugins')).toBeTruthy()
    expect(getByText(/waiting for service/)).toBeTruthy()
    expect(queryByTestId('real-ui')).toBeNull()
  })

  it('offers desktop restart, logs, and diagnostic copy recovery actions', async () => {
    const restartHarness = vi.fn(() => Promise.resolve())
    const openLogsFolder = vi.fn(() => Promise.resolve())
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    Object.defineProperty(window, 'dshDesktop', {
      configurable: true,
      value: { app: { restartHarness, openLogsFolder } },
    })
    const { error, getByRole } = mount()
    act(() => { error.set('web boot: plugin activation failed') })
    fireEvent.click(getByRole('button', { name: 'Restart service' }))
    await act(async () => { await Promise.resolve() })
    expect(restartHarness).toHaveBeenCalledTimes(1)
    fireEvent.click(getByRole('button', { name: 'Open logs' }))
    await act(async () => { await Promise.resolve() })
    expect(openLogsFolder).toHaveBeenCalledTimes(1)
    fireEvent.click(getByRole('button', { name: 'Copy diagnostics' }))
    await act(async () => { await Promise.resolve() })
    expect(writeText).toHaveBeenCalledWith('web boot: plugin activation failed')
    expect(getByRole('button', { name: 'Diagnostics copied' })).toBeTruthy()
  })

  it('flipping settled switches to the real UI in one pass', () => {
    const { settled, getByTestId, queryByText, counts } = mount()
    act(() => { settled.set(true) })
    expect(getByTestId('real-ui')).toBeTruthy()
    expect(queryByText('HARNESS')).toBeNull()
    expect(counts()).toBe(1)
  })
})
