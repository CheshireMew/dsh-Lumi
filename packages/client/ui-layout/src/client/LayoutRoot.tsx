/**
 * Stable root owner for the layout extension seam. It keeps the panel store
 * and every shipped child-slot declaration on the official layout plugin,
 * while delegating only presentation to `layout.frame`. A lower-priority
 * frame can therefore replace the shell without taking ownership of session,
 * sidebar, details, or overlay composition; unloading it reveals AppFrame
 * again with the same live store and child registrations.
 */
import { useCallback, useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import type { PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { PanelActions } from './service.ts'
import type { createLayoutStore, LayoutState } from './stores.ts'

/** Presentation-neutral owner share supplied to every `layout.frame` entry. */
export interface LayoutFrameOwnerProps {
  /** Current root layout-store snapshot. Frames read it but mutate through actions only. */
  panels: LayoutState
  /** Bound layout-store actions; their identity is stable for the root entry lifetime. */
  actions: PanelActions
  /** Whether the selected session is non-blank and may expose a details panel. */
  detailsAvailable: boolean
  /** Render the official sidebar seat with frame-resolved column geometry. */
  renderSidebar: (owner: { collapsed: boolean; width: number }) => ReactNode
  /** Render the official current-session-optional conversation seat. */
  renderConversation: () => ReactNode
  /** Render the official strict-session details seat. */
  renderDetails: () => ReactNode
  /** Render additive frame-wide overlays. */
  renderOverlay: () => ReactNode
}

/** Full root-entry props: global standard kit, every declared child, and the panel store. */
export type LayoutRootProps =
  & PropsRuntime<'root'>
  & PropsRenderSlots<'layout.frame' | 'sidebar' | 'conversation' | 'details' | 'shell.overlay'>
  & PropsStore<ReturnType<typeof createLayoutStore>>

/** Own the stable layout state and delegate its visual arrangement to `layout.frame`. */
export function LayoutRoot({ useStore, useSessions, actions, renderSlot }: LayoutRootProps) {
  const panels = useStore(s => s)
  const detailsSession = useSessions((s) => {
    const current = s.current
    return current !== undefined && s.byId[current]?.blank === false ? current : undefined
  })

  // Preserve the shipped details behavior across frame takeovers: switching
  // between usable sessions closes the panel, while temporarily selecting a
  // blank/no session hides it without erasing the stored width preference.
  const lastSession = useRef(detailsSession)
  useLayoutEffect(() => {
    if (detailsSession === undefined) return
    if (lastSession.current !== undefined && lastSession.current !== detailsSession) {
      actions.closeDetails()
    }
    lastSession.current = detailsSession
  }, [actions, detailsSession])

  // Delegation is callback-only: the root keeps the render authority and all
  // child declarations. A frame decides placement, never child ownership.
  const renderSidebar = useCallback((owner: { collapsed: boolean; width: number }) =>
    renderSlot('sidebar', owner), [renderSlot])
  const renderConversation = useCallback(() => renderSlot('conversation', {}), [renderSlot])
  const renderDetails = useCallback(() => renderSlot('details', {}), [renderSlot])
  const renderOverlay = useCallback(() => renderSlot('shell.overlay', {}), [renderSlot])

  return <>{renderSlot('layout.frame', {
    panels,
    actions,
    detailsAvailable: detailsSession !== undefined,
    renderSidebar,
    renderConversation,
    renderDetails,
    renderOverlay,
  })}</>
}
