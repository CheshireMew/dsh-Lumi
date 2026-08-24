/**
 * The in-app workspace-directory browser (figma Harness 813-23126 family): a
 * 680×500 dialog (clamped to short/narrow viewports — the Miller row scrolls
 * sideways, the columns scroll down) whose header carries the title, the selection-path
 * breadcrumb, and a click-to-edit path zone; below it a Miller view — one
 * full-width level until a row is selected, then two columns splitting the
 * row evenly (256px floor; level | selected folder's children) around a
 * hairline divider. Navigations land selection-anchored and quiet: the
 * previous view keeps rendering while a crumb jump or a submitted path is
 * scanned, then target and parent legs land as one two-pane frame (a slow
 * parent leg falls back to landing the target alone and upgrading in
 * place), so stepping back keeps two panes away from the display root and
 * navigation never flashes an intermediate frame. Selecting in the
 * right column shifts the view one level deeper. "New folder" opens a nested
 * create dialog targeting the selected folder (or the level itself) and
 * selects the created folder. Open adopts the selected folder, falling back
 * to the listed level. Pure consumer of the injected browse calls — the
 * owning flow decides what "Open" means and owns the workspace-creation
 * error surface. Hidden entries are host-flagged and hidden by default; the
 * footer's fixed-label "Show hidden files" toggle (aria-pressed, check when
 * on) reveals them (client-side only). The path editor announces itself with
 * a pencil glyph and a bar-wide hover-lit outline, opens seeded with a
 * trailing separator, and keeps the panes under the draft: the final segment
 * prefix-filters the LAST pane while that pane's level is the one the draft's
 * directory part names (a dot-led prefix also reveals the hidden entries it
 * names, and a prefix nobody matches releases the filter), while any other
 * directory part is scanned after a short debounce and lands like any other
 * navigation — selection-anchored and two-pane away from the display root,
 * both legs waited out so one keystroke moves the view once. The pane arity
 * holds throughout: the last pane is the level the path names and the one
 * beside it is its parent, so typing deeper descends and erasing segments
 * walks back up, moving the Miller view without leaving the editor. Panes the
 * draft walked to stay put when the editor closes (cancellation included):
 * the crumbs name where the walk ended, and Open's fallback target follows
 * them.
 */
import clsx from 'clsx'
import {
  Button, IconCheckOutline16, IconChevronRightOutline14, IconEditOutline16, IconFolderClose16, IconFolderOpen16,
  IconPlusOutline16, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { DirectoryEntry } from '@deepseek-ai/dsh-client-runtime/client'
import {
  separatorOf,
  useDirectoryBrowserModel,
  visibleEntries,
  type DirectoryBrowserProps,
} from './directory-browser-model.ts'
import css from './DirectoryBrowser.module.css'

export type { DirectoryBrowserProps } from './directory-browser-model.ts'

/** One column of folder rows (the Miller view renders one or two of these). */
function LevelColumn({ entries, selectedPath, busy, onPick, showHidden, filterPrefix, pathEditing }: {
  entries: readonly DirectoryEntry[]
  selectedPath: string | null
  busy: boolean
  onPick: (entry: DirectoryEntry) => void
  showHidden: boolean
  filterPrefix: string | null
  pathEditing: boolean
}) {
  const visible = visibleEntries(entries, selectedPath, showHidden, filterPrefix)
  return (
    <div className={css.column} role="list">
      {visible.map((entry) => {
        const selected = entry.path === selectedPath
        return (
          // The wrapper carries the list semantics; the row keeps its NATIVE
          // button role so assistive technology exposes an actionable control.
          <span key={entry.path} role="listitem" className={css.rowSeat}>
            <button
              type="button"
              aria-current={selected || undefined}
              className={clsx(css.row, selected && css.rowSelected)}
              disabled={busy}
              // While the path editor is open, keep focus in it: a focus
              // steal on mousedown would blur the editor and (in engines
              // where the blur lands before our guards) drop this click.
              // Outside editing, rows keep native focus behavior.
              onMouseDown={pathEditing ? (event) => { event.preventDefault() } : undefined}
              // Editing-time focus parking happens after commit (the
              // DirectoryBrowser refocus effect): a right-pane pick replaces
              // this very column, so focusing the clicked node here would
              // still fall to body.
              onClick={() => { onPick(entry) }}
            >
              {selected
                ? <IconFolderOpen16 size={16} className={css.rowIconSelected} />
                : <IconFolderClose16 size={16} className={css.rowIcon} />}
              <span className={css.rowName}>{entry.name}</span>
              <IconChevronRightOutline14 size={12} className={css.rowChevron} />
            </button>
          </span>
        )
      })}
    </div>
  )
}

/**
 * Render the directory-browser dialog.
 * @param props - owner-controlled browser props.
 * @returns the dialog element (null while closed, via Modal).
 */
export function DirectoryBrowser(props: DirectoryBrowserProps) {
  const model = useDirectoryBrowserModel(props)
  if (model === null) return null
  const {
    advance,
    busy,
    cancelPathEdit,
    child,
    composingRef,
    compositionGuard,
    confirmCreate,
    createError,
    creatingFolder,
    crumbTrailRef,
    crumbs,
    draftPending,
    editZoneRef,
    error,
    folderDraft,
    loading,
    millerRowRef,
    navigate,
    onClose,
    onOpen,
    open,
    parent,
    parentInert,
    pathDraft,
    pathInputRef,
    previewSuspended,
    refocusEditZone,
    select,
    selected,
    setCreateError,
    setFolderDraft,
    setLoading,
    setPathDraft,
    setShowHidden,
    showHidden,
    slowScan,
    supersede,
    t,
    targetName,
    targetPath,
    twoPane,
    typedPrefix,
  } = model
  return (
    <Modal
      open={open}
      // Escape and mask reach every mounted Modal's document listener; while
      // the nested create dialog is up only that topmost dialog may close
      // (its own guard keeps an in-flight creation open), and an in-flight
      // adoption pins the flow — dismissing it would leave the owner's
      // createWorkspace to land after an apparent cancel.
      onClose={() => { if (folderDraft === null && !busy) onClose() }}
      title={t('browser.title')}
      className={clsx(css.dialog)}
      headless
    >
      {/* Path-edit cancellation is observed at the card scope, not the
        * input: once Tab parks focus on a filtered row the input is off the
        * event path, yet Escape must still collapse the editor (not the
        * dialog) and a further focus move out of the card must still
        * cancel. display:contents keeps header/content/footer as direct
        * flex children of the Modal card. */}
      <div
        className={css.editorScope}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || pathDraft === null) return
          // stopPropagation keeps the card-scope Escape from the Modal's
          // document listener.
          event.stopPropagation()
          // Escape while the input holds focus is about to unmount it; with
          // focus already parked on a row, that row survives the cancel and
          // keeps focus naturally. Assignment (not a conditional set) also
          // retires a stale flag a failed or still-upgrading Enter left.
          refocusEditZone.current = document.activeElement === pathInputRef.current
          cancelPathEdit()
        }}
        // Focus leaving THIS dialog card while editing cancels like Escape.
        // Guarded non-cancel paths: window/tab focus loss (document no
        // longer focused); a focus move that stays inside the card (Tab
        // onto the filtered rows or the footer toggle); and pointer paths,
        // where rows and the toggle suppress focus steal on mousedown while
        // editing so their click lands first. Enter keeps focus in the
        // input while its navigation is in flight, so a submitted path is
        // never withdrawn here. Anchored to this card via closest, not any
        // [role="dialog"], so focus escaping into a sibling overlay cancels.
        onBlur={(event) => {
          if (pathDraft === null) return
          if (!document.hasFocus()) return
          const card = event.currentTarget.closest('[role="dialog"]')
          /* v8 ignore next -- narrowing guard: this scope always renders inside the Modal card. */
          if (card === null) return
          if (event.relatedTarget instanceof Node && card.contains(event.relatedTarget)) return
          // The user moved focus out of the card themselves: cancel without
          // re-parking (a lingering Enter-failure flag must not yank focus
          // back either).
          refocusEditZone.current = false
          cancelPathEdit()
        }}
      >
        <div className={css.header}>
          <h2 className={css.title}>{t('browser.title')}</h2>
          <div className={css.crumbBar}>
            {pathDraft === null
              ? (
                <>
                  <span className={css.crumbTrail} role="navigation" ref={crumbTrailRef}>
                    {crumbs.map((crumb, index) => (
                      <span key={crumb.path} className={css.crumbSeat}>
                        {index > 0 && <IconChevronRightOutline14 size={12} className={css.crumbChevron} />}
                        <button
                          type="button"
                          className={css.crumb}
                          disabled={parentInert}
                          onClick={() => { navigate(crumb.path) }}
                        >
                          {crumb.name}
                        </button>
                      </span>
                    ))}
                  </span>
                  {/* The empty zone right of the crumbs is the path-edit
                    * affordance: the whole remainder of the bar clicks into
                    * the editor, and the pencil glyph parked at its right
                    * edge (with the same tooltip) is what says so — an
                    * invisible target the operator must guess at is the one
                    * way into typing a path. */}
                  <button
                    type="button"
                    className={css.crumbEditZone}
                    aria-label={t('browser.editPath')}
                    title={t('browser.editPath')}
                    // Stays available with no listed level: when the home
                    // listing itself fails, typing an absolute path is the one
                    // remaining way forward.
                    disabled={parentInert}
                    ref={editZoneRef}
                    onClick={() => {
                    // Opening the editor supersedes any pending listing: a
                    // settlement landing before the first keystroke would
                    // otherwise close the editor via navigate's draft reset.
                      supersede()
                      setLoading(false)
                      previewSuspended.current = false
                      // Seed with a trailing separator so typing immediately
                      // continues into child names (and prefix-filters below).
                      // No listed level means nothing to seed from (the editor
                      // is the recovery path for a failed home listing).
                      if (parent === null) {
                        setPathDraft('')
                        return
                      }
                      const base = selected?.path ?? parent.path
                      const sep = separatorOf(parent)
                      setPathDraft(base.endsWith(sep) ? base : `${base}${sep}`)
                    }}
                  >
                    <IconEditOutline16 size={14} className={css.crumbEditGlyph} />
                  </button>
                </>
              )
              : (
                <input
                  className={css.pathInput}
                  value={pathDraft}
                  aria-label={t('browser.editPath')}
                  autoFocus
                  ref={pathInputRef}
                  disabled={parentInert}
                  onChange={(event) => {
                  // Editing the draft supersedes any in-flight navigation:
                  // its completion must neither clear the newer text nor
                  // repopulate the view with the older path.
                    supersede()
                    setLoading(false)
                    // A fresh edit releases the submission hold: the panes
                    // may follow the new text wherever it points.
                    previewSuspended.current = false
                    setPathDraft(event.target.value)
                  }}
                  {...compositionGuard}
                  // Escape and focus-leave cancellation live on the card-scope
                  // wrapper above (they must work after focus Tabs onto the
                  // rows); this handler owns only submission.
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !composingRef.current) {
                      event.preventDefault()
                      // Trim only detects a blank draft; the Host gets the
                      // original text — a real directory name may end in
                      // whitespace, and trimming would list its sibling.
                      if (pathDraft.trim() !== '') {
                        // Success will unmount the still-focused input; park
                        // focus on the returning crumb edit zone (a failure
                        // keeps the editor, so the flag waits until close).
                        refocusEditZone.current = true
                        // The submitted path owns the view now: a debounce
                        // timer still pending from these keystrokes would
                        // otherwise supersede this navigation and land the
                        // draft's parent directory instead.
                        previewSuspended.current = true
                        navigate(pathDraft)
                      }
                    }
                  }}
                />
              )}
          </div>
        </div>
        <div className={css.content}>
          <div className={css.millerRow} ref={millerRowRef}>
            {parent !== null && (
              <LevelColumn
                entries={parent.entries}
                selectedPath={selected?.path ?? null}
                busy={parentInert}
                onPick={select}
                showHidden={showHidden}
                filterPrefix={child === null ? typedPrefix : null}
                pathEditing={draftPending}
              />
            )}
            {twoPane && <span className={css.divider} />}
            {twoPane && child !== null && (
              <LevelColumn
                entries={child.entries}
                selectedPath={null}
                busy={parentInert}
                onPick={advance}
                showHidden={showHidden}
                filterPrefix={typedPrefix}
                pathEditing={draftPending}
              />
            )}
          </div>
          {loading && slowScan
          && <div className={clsx(css.status, css.loadingFloat)} role="status">{t('browser.loading')}</div>}
          {/* The backend bounds a level at its complete-result limit; say so
          * whenever a visible pane was cut instead of letting the tail of a
          * huge directory go silently missing. The note describes the panes
          * on screen, so an in-flight scan leaves it alone — hiding it while
          * the stale view still shows the cut level would shift the columns
          * on every navigation away from it. */}
          {(parent?.truncated === true || child?.truncated === true)
          && <div className={css.status} role="status">{t('browser.truncated')}</div>}
          {error !== null && <div className={css.error} role="alert">{error}</div>}
        </div>
        <div className={css.footerBar}>
          <Button
            variant="outline"
            icon={<IconPlusOutline16 size={14} />}
            disabled={parent === null || loading || parentInert || draftPending}
            onClick={() => {
              setFolderDraft('')
              setCreateError(null)
            }}
          >
            {t('browser.newFolder')}
          </Button>
          <button
            type="button"
            className={clsx(css.showHiddenToggle, showHidden && css.showHiddenToggleActive)}
            aria-pressed={showHidden}
            disabled={parentInert}
            // The toggle composes with the path editor (dot-led prefixes and
            // this filter interleave): while editing, don't steal focus, so
            // toggling never blur-cancels a draft mid-thought. Outside editing
            // it keeps native focus behavior.
            onMouseDown={draftPending ? (event) => { event.preventDefault() } : undefined}
            onClick={() => { setShowHidden(prev => !prev) }}
          >
            {t('browser.showHidden')}
            {/* Trailing check (Menu's selected vocabulary): the label never
              * shifts when the pressed state toggles. */}
            {showHidden && <IconCheckOutline16 size={14} />}
          </button>
          <span className={css.footerGap} />
          <Button variant="outline" className={clsx(css.footerAction)} disabled={parentInert} onClick={onClose}>{t('browser.cancel')}</Button>
          <Button
            variant="primary"
            className={clsx(css.footerAction)}
            disabled={targetPath === null || loading || parentInert || draftPending}
            /* v8 ignore next -- narrowing guard: Open disables while no target exists. */
            onClick={() => { if (targetPath !== null) onOpen(targetPath) }}
          >
            {t('browser.open')}
          </Button>
        </div>
      </div>
      {/* Nested create dialog (figma 813:23278): names one folder inside the target. */}
      <Modal
        open={folderDraft !== null}
        onClose={() => { if (!creatingFolder) setFolderDraft(null) }}
        title={t('browser.newFolder')}
        className={clsx(css.createDialog)}
        headless
      >
        <div className={css.createBody}>
          <h3 className={css.createTitle}>{t('browser.newFolder')}</h3>
          <p className={css.createIn}>{t('browser.createIn', { name: targetName })}</p>
          <input
            className={css.createInput}
            value={folderDraft ?? ''}
            aria-label={t('browser.folderName')}
            placeholder={t('browser.untitledFolder')}
            autoFocus
            disabled={creatingFolder}
            onChange={(event) => { setFolderDraft(event.target.value) }}
            {...compositionGuard}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !composingRef.current) {
                event.preventDefault()
                confirmCreate()
              }
              if (event.key === 'Escape') {
                event.stopPropagation()
                if (!creatingFolder) setFolderDraft(null)
              }
            }}
          />
          {createError !== null && <div className={css.error} role="alert">{createError}</div>}
          <div className={css.createActions}>
            <Button variant="outline" disabled={creatingFolder} onClick={() => { setFolderDraft(null) }}>{t('browser.cancel')}</Button>
            <Button
              variant="primary"
              disabled={creatingFolder || folderDraft === null || folderDraft.trim() === ''}
              onClick={confirmCreate}
            >
              {t('browser.create')}
            </Button>
          </div>
        </div>
      </Modal>
    </Modal>
  )
}
