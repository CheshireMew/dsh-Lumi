// Modal: controlled full-viewport dialog (create-workspace and similar).
// The overlay portals to this document's body so ancestor stacking contexts
// cannot leave sticky page controls above the mask. This is still an in-page
// WebUI dialog; it never creates or targets another browser/native window.

import { useEffect, useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { IconCloseOutline16 } from './icons/index.tsx'
import css from './Modal.module.css'

type ModalLayer = {
  id: symbol
  root: HTMLDivElement
  dialog: HTMLDivElement
  returnFocus: HTMLElement | null
  close: () => void
}

const modalLayers: ModalLayer[] = []
const originalInert = new Map<HTMLElement, boolean>()
let inertObserver: MutationObserver | undefined

function topModal(): ModalLayer | undefined {
  return modalLayers.at(-1)
}

function restoreBackground(): void {
  for (const [element, inert] of originalInert) element.inert = inert
  originalInert.clear()
  inertObserver?.disconnect()
  inertObserver = undefined
}

function reconcileBackground(): void {
  const top = topModal()
  if (top === undefined) {
    // Passive-effect owners may also restore `#root.inert` during the same
    // commit. Restore after those cleanups so this shared owner remains final.
    queueMicrotask(() => {
      if (topModal() === undefined) restoreBackground()
      else reconcileBackground()
    })
    return
  }
  for (const child of document.body.children) {
    if (!(child instanceof HTMLElement)) continue
    // lib.dom types inert as boolean, while jsdom and older hosts may omit it.
    if (!originalInert.has(child)) originalInert.set(child, child.inert === true)
    child.inert = child !== top.root
  }
  if (inertObserver === undefined) {
    inertObserver = new MutationObserver(() => { reconcileBackground() })
    inertObserver.observe(document.body, { childList: true })
  }
}

const FOCUSABLE = [
  'a[href]',
  'button:not(:disabled)',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function focusableChildren(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter(element => !element.hidden && element.getAttribute('aria-hidden') !== 'true')
    .sort((left, right) => {
      if (left === right) return 0
      return left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    })
}

function focusFirst(dialog: HTMLElement): void {
  const explicit = dialog.querySelector<HTMLElement>('[data-modal-initial-focus]')
  const preferred = explicit ?? Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
    .find(element => element.matches('input, select, textarea, [contenteditable="true"]'))
  const target = preferred ?? focusableChildren(dialog)[0] ?? dialog
  target.focus()
}

function trapTab(event: KeyboardEvent, dialog: HTMLElement): void {
  const focusable = focusableChildren(dialog)
  const [first, ...rest] = focusable
  if (first === undefined) {
    event.preventDefault()
    dialog.focus()
    return
  }
  const last = rest.at(-1) ?? first
  const active = document.activeElement
  if (!dialog.contains(active)) {
    event.preventDefault()
    const fallback = event.shiftKey ? last : first
    fallback.focus()
  } else if (event.shiftKey && active === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && active === last) {
    event.preventDefault()
    first.focus()
  }
}

/**
 * Render a centered modal over a blurred page mask.
 * @param props.open - whether the dialog is showing.
 * @param props.onClose - Escape or mask click.
 * @param props.title - dialog heading (aria-label in every mode).
 * @param props.closeLabel - accessible close-button label.
 * @param props.description - optional supporting sentence under the title.
 * @param props.children - body (inputs, etc.).
 * @param props.footer - action row (Cancel / Create).
 * @param props.contentClassName - optional class for a scrollable content region.
 * @param props.headless - render children directly in the card (no default
 * header/close/body chrome) for dialogs whose figma frame owns its own
 * header structure; mask, card, Escape, and aria-label remain.
 * @param props.headlessDirection - flex direction for headless owner content.
 * @param props.labelledBy - optional visible heading id used instead of aria-label.
 * @param props.closeLabel - close-button aria label; the owner passes
 * localized copy (this package is cordis-free, so copy arrives via props).
 * @returns null when closed; otherwise the overlay tree.
 */
export function Modal({
  open, onClose, title, labelledBy, closeLabel = 'Close', description, children, footer, className, contentClassName, headless = false, headlessDirection = 'column',
}: {
  open: boolean
  onClose: () => void
  title: string
  labelledBy?: string
  closeLabel?: string
  description?: string
  children?: ReactNode
  footer?: ReactNode
  className?: string
  contentClassName?: string
  headless?: boolean
  headlessDirection?: 'row' | 'column'
}) {
  const layerId = useRef(Symbol('dsh-modal-layer'))
  const rootRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const wasOpenRef = useRef(false)
  closeRef.current = onClose
  if (open && !wasOpenRef.current) {
    const active = document.activeElement
    returnFocusRef.current = active instanceof HTMLElement && active !== document.body ? active : null
    wasOpenRef.current = true
  } else if (!open) {
    wasOpenRef.current = false
  }

  useLayoutEffect(() => {
    if (!open || rootRef.current === null || dialogRef.current === null) return
    const layer: ModalLayer = {
      id: layerId.current,
      root: rootRef.current,
      dialog: dialogRef.current,
      returnFocus: returnFocusRef.current,
      close: () => { closeRef.current() },
    }
    modalLayers.push(layer)
    reconcileBackground()
    focusFirst(layer.dialog)
    return () => {
      const index = modalLayers.findIndex(candidate => candidate.id === layer.id)
      if (index !== -1) modalLayers.splice(index, 1)
      reconcileBackground()
      queueMicrotask(() => {
        if (layer.returnFocus?.isConnected === true) layer.returnFocus.focus()
      })
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      const layer = topModal()
      if (layer?.id !== layerId.current) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        layer.close()
      } else if (event.key === 'Tab') {
        trapTab(event, layer.dialog)
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => { document.removeEventListener('keydown', onKeyDown, true) }
  }, [open])

  if (!open) return null

  return createPortal((
    <div ref={rootRef} className={css.root} role="presentation">
      <div
        className={css.mask}
        aria-hidden="true"
        onClick={() => {
          if (topModal()?.id === layerId.current) closeRef.current()
        }}
      />
      <div
        ref={dialogRef}
        className={clsx(css.dialog, className)}
        role="dialog"
        aria-modal="true"
        aria-label={labelledBy === undefined ? title : undefined}
        aria-labelledby={labelledBy}
        tabIndex={-1}
        style={headless ? { flexDirection: headlessDirection, gap: 0, padding: 0 } : undefined}
      >
        {headless
          ? children
          : (
            <>
              <div className={clsx(css.content, contentClassName)}>
                <div className={css.header}>
                  <h2 className={css.title}>{title}</h2>
                  <button type="button" className={css.close} aria-label={closeLabel} onClick={onClose}>
                    <IconCloseOutline16 size={14} />
                  </button>
                </div>
                {description !== undefined && description !== '' && (
                  <p className={css.description}>{description}</p>
                )}
                {children !== undefined && <div className={css.body}>{children}</div>}
              </div>
              {footer !== undefined && <div className={css.footer}>{footer}</div>}
            </>
          )}
      </div>
    </div>
  ), document.body)
}
