// @vitest-environment jsdom
/** LayoutRoot owns state/child authority while frames remain replaceable presentation. */
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useSyncExternalStore } from 'react'
import type { SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import { LayoutRoot } from '@deepseek-ai/dsh-client-ui-layout/src/client/LayoutRoot.tsx'
import type {
  LayoutFrameOwnerProps, LayoutRootProps,
} from '@deepseek-ai/dsh-client-ui-layout/src/client/LayoutRoot.tsx'
import { createLayoutStore } from '@deepseek-ai/dsh-client-ui-layout/src/client/stores.ts'

afterEach(() => { cleanup() })

function hookOf<T>(inst: { subscribe: (fn: () => void) => () => void; getSnapshot: () => T }) {
  return function useSelector<S>(select: (snapshot: T) => S): S {
    return select(useSyncExternalStore(inst.subscribe, inst.getSnapshot))
  }
}

function sessionState(current: string | undefined, blank: boolean): SessionListState {
  const id = current as SessionId | undefined
  return {
    ids: id === undefined ? [] : [id],
    byId: id === undefined ? {} : {
      [id]: { id, displayTitle: 'Test', running: false, blank, updatedAt: 1 },
    },
    current: id,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  }
}

function mountRoot(selection: { current: string | undefined; blank: boolean }) {
  const instance = createLayoutStore().create()
  const calls: Array<{ key: string; owner: object }> = []
  let frameOwner: LayoutFrameOwnerProps | undefined
  const renderSlot = ((key: string, owner: object) => {
    calls.push({ key, owner })
    if (key === 'layout.frame') {
      frameOwner = owner as LayoutFrameOwnerProps
      return <div data-testid="frame">
        {frameOwner.renderSidebar({ collapsed: false, width: 280 })}
        {frameOwner.renderConversation()}
        {frameOwner.renderDetails()}
        {frameOwner.renderOverlay()}
      </div>
    }
    return <span data-child={key} />
  }) as LayoutRootProps['renderSlot']
  const useSessions = ((select: (state: SessionListState) => unknown) =>
    select(sessionState(selection.current, selection.blank))) as LayoutRootProps['useSessions']
  const props = {
    useStore: hookOf(instance),
    actions: instance.actions,
    renderSlot,
    useSessions,
  } as LayoutRootProps
  const view = render(<LayoutRoot {...props} />)
  return {
    ...view,
    instance,
    calls,
    owner: () => {
      if (frameOwner === undefined) throw new Error('frame owner not captured')
      return frameOwner
    },
    rerenderRoot: () => { view.rerender(<LayoutRoot {...props} />) },
  }
}

describe('LayoutRoot', () => {
  it('delegates every official child through a presentation-neutral frame owner', () => {
    const mounted = mountRoot({ current: 's-one', blank: false })
    expect(mounted.getByTestId('frame')).toBeTruthy()
    expect(mounted.calls.map(call => call.key)).toEqual([
      'layout.frame', 'sidebar', 'conversation', 'details', 'shell.overlay',
    ])
    expect(mounted.owner().panels).toEqual({ sidebar: 280, details: 0, narrow: false, narrowExpanded: false })
    expect(mounted.owner().detailsAvailable).toBe(true)
  })

  it('marks blank and absent selections unavailable without closing the saved width', () => {
    const selection = { current: 's-one' as string | undefined, blank: false }
    const mounted = mountRoot(selection)
    act(() => { mounted.instance.actions.openDetails() })
    expect(mounted.owner().panels.details).toBe(360)

    selection.blank = true
    mounted.rerenderRoot()
    expect(mounted.owner().detailsAvailable).toBe(false)
    expect(mounted.instance.getSnapshot().details).toBe(360)

    selection.current = undefined
    mounted.rerenderRoot()
    expect(mounted.owner().detailsAvailable).toBe(false)
    expect(mounted.instance.getSnapshot().details).toBe(360)
  })

  it('closes details when switching between two usable sessions, but not on the first one', () => {
    const selection = { current: undefined as string | undefined, blank: false }
    const mounted = mountRoot(selection)
    act(() => { mounted.instance.actions.openDetails() })

    selection.current = 's-one'
    mounted.rerenderRoot()
    expect(mounted.instance.getSnapshot().details).toBe(360)

    selection.current = 's-two'
    mounted.rerenderRoot()
    expect(mounted.instance.getSnapshot().details).toBe(0)
  })
})
