/** The default composer body: the 'conversation.composer.bar' slot entry.
 * Machine state arrives through the standard provide channel
 * (useInput + inputActions); the keyboard/DOM command face and stop arrive
 * through this entry's own inject, whose hooks compartment binds
 * useNotices/useLexicon; layout-phase inputs (variant, placeholder,
 * region-slot content) ride the owner props. Session facts
 * (running/removed/promptError) are self-selected via useSession. */

import clsx from 'clsx'
import {
  IconPlusOutline16, IconWarningOutline16, Toast, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { AttachmentRail, DropOverlay, ImageLightbox } from '@deepseek-ai/dsh-client-ui-attachment'
import {
  attachmentRailLabels, dropOverlayLabels, imageSizeText, lightboxLabels,
} from '../image-labels.ts'
import { ContextMeter } from './ContextMeter.tsx'
import { useInputBarModel, type InputBarProps } from './use-input-bar-model.tsx'
import css from './InputBar.module.css'

export type { InputBarProps } from './use-input-bar-model.tsx'

/**
 * Render the conversation composer from its state and command integrations.
 * @param props - Composer integrations and layout slots.
 * @returns The composer input surface.
 */
export function InputBar(props: InputBarProps) {
  const model = useInputBarModel(props)
  const {
    accessory,
    backdrop,
    footer,
    leftItems,
    overlay,
    renderSlot,
    rightItems,
    variant,
  } = model.surface
  const {
    accessSelect,
    commandMenuOpen,
    onPrimary,
    onRequestWorkspace,
    onToggleCommandMenu,
    primaryLabel,
    primaryStops,
    stop,
    toggleCommandMenu,
    workspacePickerOpen,
    workspaceTrigger,
  } = model.controls
  const {
    draft,
    empty,
    input,
    inputRef,
    keepFocus,
    mirrorRef,
    onChange,
    onCompositionEnd,
    onCompositionStart,
    onCopyOrCut,
    onKeyDown,
    onPaste,
    onSelect,
    placeholder,
    scrollRef,
    textareaDisabled,
  } = model.inputView
  const {
    canAcceptDrop,
    canSteerQueue,
    cardRef,
    closePreview,
    disabled,
    dismissToast,
    dragActive,
    imageLimits,
    interruptible,
    locked,
    machineBusy,
    modelSeatLocked,
    notice,
    parentOffline,
    planActive,
    preview,
    railItems,
    removeImage,
    setPreview,
    t,
    toast,
    useProjection,
  } = model.status
  return (
    <div className={clsx(css.root, variant === 'hero' && css.hero)}>
      {dragActive && (
        <DropOverlay
          disabled={!canAcceptDrop}
          labels={dropOverlayLabels(t, canAcceptDrop, imageLimits === undefined ? undefined : {
            count: imageLimits.maxImagesPerMessage,
            size: imageSizeText(imageLimits.maxImageBytes),
          })}
        />
      )}
      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          icon={<IconWarningOutline16 />}
          anchor={cardRef.current}
          onDone={dismissToast}
        />
      )}
      {notice !== null && (
        <div className={clsx(css.notice, notice.level === 'error' && css.noticeError)} role="status">
          {notice.text}
        </div>
      )}
      {/* Trigger clicks land on the card, not the textarea: the toolbar row's
          disabled controls swallow clicks otherwise (the CSS state disarms
          their pointer events), so the WHOLE capsule is the pick target.
          pointerdown stops here so the Menu's outside-close cannot race the
          click's reopen (close-then-open flickers the chip's open echo). */}
      <div
        ref={cardRef}
        className={clsx(css.card, workspaceTrigger && css.cardWorkspaceTrigger)}
        data-composer-card
        onClick={workspaceTrigger ? onRequestWorkspace : undefined}
        onPointerDown={workspaceTrigger ? (e) => { e.stopPropagation() } : undefined}
      >
        {overlay !== undefined && <div className={css.overlayAnchor}>{overlay}</div>}
        {accessory !== undefined && <div className={css.accessory}>{accessory}</div>}
        {railItems.length > 0 && (
          <div className={css.attachments}>
            <AttachmentRail
              items={railItems}
              labels={attachmentRailLabels(t)}
              onOpen={(item) => { setPreview(item.attachment) }}
              onRemove={(item) => { removeImage?.(item.attachment.id) }}
            />
          </div>
        )}
        {/* One scrollport, two text layers. The hidden mirror renders draft+'\n' and stretches the
            stack to the draft's FULL height (counting rows by '\n' cannot see soft wraps); the
            absolutely-positioned backdrop and textarea ride that height, and .scroll — capped at 14
            lines in CSS — is the only thing that scrolls. The caret belongs to the textarea and the
            glyphs to the backdrop, so they can only stay together by moving together: one scroll
            offset the browser applies to both layers at once, never a JS mirror between two boxes,
            which a compositor-driven gesture outruns and leaves the words trailing the caret. */}
        <div ref={scrollRef} className={css.scroll} data-input-scroll>
          <div className={css.grow}>
            <div aria-hidden className={css.backdrop} data-input-backdrop>{backdrop}</div>
            <textarea
              ref={inputRef}
              className={css.input}
              value={draft}
              disabled={textareaDisabled}
              readOnly={machineBusy || workspaceTrigger}
              aria-label={workspaceTrigger ? t('hero.chooseWorkspace') : undefined}
              aria-haspopup={workspaceTrigger ? 'menu' : undefined}
              aria-expanded={workspaceTrigger ? workspacePickerOpen : undefined}
              data-phase={input?.phase ?? 'inert'}
              placeholder={placeholder ?? (parentOffline
                ? t('placeholder.parentOffline')
                : disabled
                  ? t('placeholder.unavailable')
                  // The steer hint deliberately outranks the plan placeholder:
                  // while it shows, the whole-queue gesture is genuinely available
                  // (the gate never consults plan mode), so the actionable hint wins.
                  : canSteerQueue
                    ? t('placeholder.steerQueue')
                    : planActive ? t('placeholder.plan') : t('placeholder.default'))}
              rows={2}
              onChange={onChange}
              onKeyDown={onKeyDown}
              onSelect={onSelect}
              onCopy={(e) => { onCopyOrCut(e, false) }}
              onCut={(e) => { onCopyOrCut(e, true) }}
              onPaste={onPaste}
              onCompositionStart={onCompositionStart}
              onCompositionEnd={onCompositionEnd}
            />
            <div ref={mirrorRef} aria-hidden className={css.mirror} data-input-mirror>{`${draft}\n`}</div>
          </div>
        </div>
        <div className={css.row}>
          <div className={css.tools}>
            <Tooltip label={t('input.commands')} side="top" delayMs={500}>
              <button
                type="button"
                className={css.add}
                aria-label={t('input.commands')}
                aria-haspopup="listbox"
                aria-expanded={commandMenuOpen}
                disabled={locked || toggleCommandMenu === undefined}
                onMouseDown={keepFocus}
                onClick={onToggleCommandMenu}
              >
                <IconPlusOutline16 size={14} />
              </button>
            </Tooltip>
            <div className={css.modes}>
              {accessSelect}
              {renderSlot('conversation.input.plan', { locked })}
            </div>
            {leftItems}
          </div>
          <div className={css.trailing}>
            {rightItems}
            {renderSlot('conversation.input.model', { locked: modelSeatLocked })}
            <ContextMeter useProjection={useProjection} t={t} />
            {interruptible && (
              <Tooltip label={t('input.stop')} side="top" delayMs={500}>
                <button
                  type="button"
                  className={css.primary}
                  aria-label={t('input.stop')}
                  disabled={stop === undefined}
                  onMouseDown={keepFocus}
                  onClick={stop}
                >
                  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
                    <rect x="3" y="3" width="10" height="10" rx="3" fill="currentColor" />
                  </svg>
                </button>
              </Tooltip>
            )}
            <Tooltip label={primaryLabel} side="top" delayMs={500}>
              <button
                type="button"
                className={css.primary}
                aria-label={primaryLabel}
                disabled={primaryStops ? stop === undefined : empty || disabled || machineBusy}
                onMouseDown={keepFocus}
                onClick={onPrimary}
              >
                {primaryStops ? (
                  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
                    <rect x="3" y="3" width="10" height="10" rx="3" fill="currentColor" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
                    <path d="M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z" fill="currentColor" />
                  </svg>
                )}
              </button>
            </Tooltip>
          </div>
        </div>
      </div>
      {preview !== null && (
        <ImageLightbox
          src={preview.previewUrl}
          alt={preview.file.name || t('image.original')}
          labels={lightboxLabels(t)}
          onClose={closePreview}
        />
      )}
      {footer}
    </div>
  )
}
