import { useCallback, useEffect, useRef, useState } from 'react'
import type { DirectoryEntry, DirectoryListing } from '@deepseek-ai/dsh-client-runtime/client'
import { DirectoryBrowseError } from '@deepseek-ai/dsh-client-runtime/client'
import type { Translate } from '@deepseek-ai/dsh-client-locale/client'

/** Owner-supplied browser props: browse calls, pick semantics, and copy. */
export interface DirectoryBrowserProps {
  /** Dialog visibility (owner-local; closed unmounts nothing but resets on reopen). */
  open: boolean
  /** List one directory level (absent path = the Host home directory); the signal aborts a superseded scan on the wire. */
  listDirectory: (path?: string, signal?: AbortSignal) => Promise<DirectoryListing>
  /** Create one child directory under an existing parent. */
  createDirectory: (path: string, name: string) => Promise<string>
  /** The operator confirmed a directory (the selection, else the listed level). */
  onOpen: (path: string) => void
  /** Close without picking (mask, Escape, Cancel). */
  onClose: () => void
  /** The owner's confirm is in flight: Open disables, the view freezes. */
  busy: boolean
  /** Localized copy. */
  t: Translate
}

/** Failure text: the Host business message when typed, else the throw's text. */
function failureText(error: unknown): string {
  if (error instanceof DirectoryBrowseError) return error.rpcError.message
  return error instanceof Error ? error.message : String(error)
}

/**
 * How long a scan may stay visually silent before the floating "Loading…"
 * pill appears. The stale view keeps rendering while a scan is in flight, so
 * a listing that settles inside this window swaps the panes with no
 * intermediate frame at all; only a genuinely slow host (a network mount, a
 * cold disk) surfaces the indicator.
 */
const SLOW_SCAN_DELAY_MS = 300

/**
 * How long a navigation landing waits for its parent leg before committing
 * the target alone. Inside the window both legs land as ONE two-pane frame —
 * no single-pane flash between them; past it the target commits single-pane
 * at once (an Enter-submitted navigation is never held hostage by a stalled
 * parent) and the late parent leg upgrades the landing in place.
 */
const PARENT_LEG_WAIT_MS = 200

/**
 * How long a typed draft rests before the panes follow it to a directory no
 * pane lists. The window absorbs the keystrokes that walk through
 * intermediate directory parts (every character of `/usr/lo` past the
 * separator would otherwise be its own scan) while staying short enough that
 * a pause reads as "the list moved with me".
 */
const DRAFT_PREVIEW_DEBOUNCE_MS = 250

/**
 * Breadcrumb rows for display: inside the home subtree the chain starts at a
 * localized Home crumb; outside it the full ancestry shows, the root labeled
 * by its own path.
 */
function displayCrumbs(listing: DirectoryListing, homeLabel: string): DirectoryEntry[] {
  const homeIndex = listing.crumbs.findIndex(crumb => crumb.path === listing.home)
  if (homeIndex === -1) return listing.crumbs
  const tail = listing.crumbs.slice(homeIndex + 1)
  return [{ name: homeLabel, path: listing.home, hidden: false }, ...tail]
}

/**
 * The listing's platform separator, inferred from the home path the host
 * stamped — never from typed text or entry paths, where a backslash is a
 * legal POSIX name character. Still a heuristic at the last step: a POSIX
 * home directory whose own name contains a backslash would misread.
 * TODO: replace with a host-stamped `separator` field on the wire
 * DirectoryListing so the platform fact travels verbatim (the trade-off is
 * recorded in the directory-picker capability seam Agent Note).
 * @param listing - Host listing whose home path identifies the platform convention.
 * @returns The separator used to join paths in this listing.
 */
export function separatorOf(listing: DirectoryListing): '\\' | '/' {
  return listing.home.includes('\\') ? '\\' : '/'
}

/** The listed level as a directory part: its own path, separator-terminated (the root already is). */
function levelDirectory(listing: DirectoryListing): string {
  const sep = separatorOf(listing)
  return listing.path.endsWith(sep) ? listing.path : `${listing.path}${sep}`
}

/** The directory text a draft-following scan last sent, with the level path the host answered it with. */
interface ScannedDirectory {
  /** The draft's directory part, verbatim as it went to the host. */
  readonly directory: string
  /** `path` of the listing that came back. */
  readonly landed: string
}

/**
 * The draft's directory part — everything through its last separator — or
 * null while no separator has been typed at all (nothing addresses a
 * directory yet). The platform comes from `listing`: on Windows a forward
 * slash separates too (the host's `resolve` accepts either), while on POSIX a
 * backslash is a legal name character and never separates.
 */
function draftDirectory(listing: DirectoryListing, draft: string): string | null {
  const cut = separatorOf(listing) === '\\'
    ? Math.max(draft.lastIndexOf('\\'), draft.lastIndexOf('/'))
    : draft.lastIndexOf('/')
  return cut === -1 ? null : draft.slice(0, cut + 1)
}

/**
 * How the draft reads against one level: the directory part it names, and —
 * when `listing` is the level that directory part addresses — the final
 * segment that prefix-filters it while the user types (case-insensitively,
 * downstream). A level answers a directory part when its own path is that
 * part, or when it is the level that very text just produced (`scanned`): the
 * host resolves what it is given, so `..` segments and Windows forward
 * slashes reach a level whose path spells the request differently.
 * @param listing - the level to read the draft against.
 * @param draft - the current path draft.
 * @param scanned - the last draft-following scan's directory and landing.
 * @returns the draft's directory part (null with no separator typed) and its
 * filtering tail (null when this level does not answer that directory).
 */
function readDraft(
  listing: DirectoryListing,
  draft: string,
  scanned: ScannedDirectory | null,
): { directory: string | null; tail: string | null } {
  const directory = draftDirectory(listing, draft)
  if (directory === null) return { directory: null, tail: null }
  const answers = directory === levelDirectory(listing)
    || (scanned !== null && scanned.directory === directory && scanned.landed === listing.path)
  return { directory, tail: answers ? draft.slice(directory.length) : null }
}

/**
 * The rows one column renders. The selection is exempt from every filter: it
 * anchors the two-pane view (crumbs and the child pane point at it), so
 * neither the hidden filter after a dot-reveal pick nor a prefix miss may
 * orphan it. A prefix narrows the level only while some row it would actually
 * show matches — a tail nobody matches is a name being spelled, not a demand
 * for an empty pane, so the level shows whole and its hidden rows return to
 * obeying the toggle. Counting only displayable rows is what keeps that true:
 * were a hidden row ever to match a prefix that does not reveal it (today
 * `hidden` means dot-prefixed, so it cannot), the level would narrow to
 * nothing.
 * @param entries - Rows returned for the current directory level.
 * @param selectedPath - Selected row path that must remain visible.
 * @param showHidden - Whether ordinary hidden rows are visible.
 * @param filterPrefix - Case-insensitive name prefix, or null when inactive.
 * @returns Rows visible in the current column.
 */
export function visibleEntries(
  entries: readonly DirectoryEntry[],
  selectedPath: string | null,
  showHidden: boolean,
  filterPrefix: string | null,
): readonly DirectoryEntry[] {
  const needle = filterPrefix === null ? '' : filterPrefix.toLowerCase()
  // A dot-led prefix names hidden entries explicitly, so matching ones
  // surface even while the toggle keeps the rest hidden.
  const displayable = (entry: DirectoryEntry): boolean => showHidden || !entry.hidden || needle.startsWith('.')
  const matches = (entry: DirectoryEntry): boolean => displayable(entry) && entry.name.toLowerCase().startsWith(needle)
  const narrowing = needle !== '' && entries.some(matches)
  return entries.filter((entry) => {
    if (entry.path === selectedPath) return true
    if (narrowing) return matches(entry)
    return showHidden || !entry.hidden
  })
}

function useDirectoryBrowserModelInternal(
  { open, listDirectory, createDirectory, onOpen, onClose, busy, t }: DirectoryBrowserProps,
) {
  // Miller state: the listed level, the selected row in it, and the selected
  // folder's own listing (the right column; null while nothing is selected).
  const [parent, setParent] = useState<DirectoryListing | null>(null)
  const [selected, setSelected] = useState<DirectoryEntry | null>(null)
  const [child, setChild] = useState<DirectoryListing | null>(null)
  const [loading, setLoading] = useState(false)
  // Derived from `loading` and `scanWindow` by the slow-scan effect below:
  // true only once the current listing call has been in flight for
  // SLOW_SCAN_DELAY_MS, so fast listings never render the indicator at all.
  const [slowScan, setSlowScan] = useState(false)
  // Every listing call owns a fresh silence window. `loading` may stay true
  // across a superseding row pick or across a navigation's target and parent
  // legs, so its boolean edge cannot identify the start of each scan.
  const [scanWindow, setScanWindow] = useState(0)
  const [error, setError] = useState<string | null>(null)
  // Path-edit state: null = breadcrumb mode; a string = the draft being typed.
  const [pathDraft, setPathDraft] = useState<string | null>(null)
  // Show-hidden toggle state (pure client-side filter, reset on each open).
  const [showHidden, setShowHidden] = useState(false)
  // Create-folder state: null = closed; a string = the nested dialog's draft.
  const [folderDraft, setFolderDraft] = useState<string | null>(null)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const requestSeq = useRef(0)
  // The in-flight listing's controller: superseding intent aborts the wire
  // request too — the Host stops scanning — instead of only discarding the
  // eventual result while the scan keeps consuming host resources.
  const scanController = useRef<AbortController | null>(null)
  // Bumped on every open/close edge: settlements from a previous open (a
  // pending creation included) must never mutate a reopened dialog.
  const openGeneration = useRef(0)
  // Deep ancestry overflows the trail; keep its tail (the current directory
  // and the edit zone beside it) in view whenever the chain changes.
  const crumbTrailRef = useRef<HTMLSpanElement | null>(null)
  // IME confirmation (Enter selecting a candidate) must not submit either
  // text input; the same guard the workspace-name inputs carry, shared by
  // the path editor and the folder-name input.
  const composingRef = useRef(false)
  // HMR/unmount invalidation: a completion from a disposed flow must not
  // update state or issue follow-up requests from a dead component.
  useEffect(() => () => {
    requestSeq.current += 1
    openGeneration.current += 1
    scanController.current?.abort()
  }, [])
  const compositionGuard = {
    onCompositionStart: () => { composingRef.current = true },
    onCompositionEnd: () => { composingRef.current = false },
  }

  /** Newer intent wins: invalidate the pending listing's settlement AND abort its wire request. */
  const supersede = useCallback((): number => {
    scanController.current?.abort()
    scanController.current = null
    return ++requestSeq.current
  }, [])

  /** Hide any prior indicator and start a fresh silence window for one listing call. */
  const restartSlowScanWindow = useCallback((): void => {
    setSlowScan(false)
    setScanWindow(value => value + 1)
  }, [])

  /** Launch one listing under a fresh controller so a later supersession can abort it. */
  const launchListing = useCallback((path: string | undefined): { seq: number; scan: Promise<DirectoryListing> } => {
    const seq = supersede()
    const controller = new AbortController()
    scanController.current = controller
    restartSlowScanWindow()
    return { seq, scan: listDirectory(path, controller.signal) }
  }, [supersede, restartSlowScanWindow, listDirectory])

  /**
   * Launch a follow-up listing under the CURRENT supersession seq: a newer
   * intent aborts it like the leg it continues, and it supersedes nothing.
   */
  const continueScan = useCallback((path: string): Promise<DirectoryListing> => {
    const controller = new AbortController()
    scanController.current = controller
    restartSlowScanWindow()
    return listDirectory(path, controller.signal)
  }, [restartSlowScanWindow, listDirectory])

  /**
   * Enter owns the view from submission until its navigation lands, so the
   * debounce timer the same keystrokes armed must not supersede it. Cleared
   * by the next edit (and by opening the editor); a failed submission leaves
   * it set until the operator edits again, so the rejected path is not
   * immediately re-scanned as a preview.
   */
  const previewSuspended = useRef(false)

  // The panes as the draft-following scan must read them when its wait
  // fires: current, but NOT a dependency of the wait (see the effect below).
  const viewRef = useRef<{ parent: DirectoryListing | null; child: DirectoryListing | null }>({ parent: null, child: null })
  useEffect(() => { viewRef.current = { parent, child } }, [parent, child])

  // What the last draft-following scan asked for and what came back, so a
  // level still answers the text that produced it after the host respelled
  // it. Stale entries are harmless: a match needs both the directory text and
  // that level's own path, which together already mean the same directory.
  const scanned = useRef<ScannedDirectory | null>(null)

  /**
   * A landed preview replaced the pane a keyboard operator may have Tabbed
   * onto, so the focus it drops is re-parked on the still-open editor (the
   * Modal has no focus trap). Consumed by the refocus effect below.
   */
  const refocusPathInput = useRef(false)

  /**
   * Replace the whole view with a freshly scanned level. Away from the
   * display root — the same collapse the crumb header renders, so crumbs and
   * pane shape never disagree — the landing is two-pane: the target's ACTUAL
   * parent-level entry re-selected (left pane = parent, right pane = the
   * target), so a crumb jump reads as stepping back one pane. Both legs land
   * as one frame when the parent leg settles within
   * {@link PARENT_LEG_WAIT_MS}; past that bound (or at the display root) the
   * target commits alone — single wide level, loading ends — and a late
   * parent leg still upgrades the landing in place. A failed parent leg, or a
   * truncated parent window that lacks the target, leaves the single-pane
   * landing — the upgrade must never orphan the selection it exists to
   * anchor. Until whichever commit comes first, the previous view keeps
   * rendering: a landing swaps the panes, it never blanks them.
   *
   * Two callers, one landing shape. A submitted path (Enter, a crumb) closes
   * the editor on arrival, announces its failure, and takes the wait bound —
   * it is answering a gesture, so it may not hang on a stalled parent. The
   * editor's own draft-following scan keeps all three to itself: it is
   * speculative, nothing waits on it, and the stale view keeps rendering, so
   * it waits for BOTH legs rather than flashing a single pane it would then
   * upgrade — one keystroke must move the view once. A failure leaves the
   * last readable panes standing and says nothing, while an arrival clears
   * the stale message and re-parks focus the swap dropped.
   * @param path - the level to list; absent lists the Host home directory.
   * @param options - `closeEditor` retires the path draft on arrival and
   * bounds the wait for the parent leg; `announce` surfaces a failure as the
   * dialog's alert.
   */
  const land = useCallback((path: string | undefined, options: { closeEditor: boolean; announce: boolean }) => {
    const { seq, scan } = launchListing(path)
    setLoading(true)
    if (options.announce) setError(null)
    // What every landing does once its panes are committed, whichever shape
    // committed them.
    const settle = (): void => {
      setLoading(false)
      if (options.closeEditor) {
        setPathDraft(null)
        return
      }
      setError(null)
      refocusPathInput.current = true
    }
    scan.then((target) => {
      if (seq !== requestSeq.current) return
      // The level the panes will present as current answers this exact
      // directory text, however the host respelled it (`..`, a Windows
      // forward slash): the tail filters, and the same text asks for no
      // second scan.
      if (!options.closeEditor && path !== undefined) scanned.current = { directory: path, landed: target.path }
      // The single-pane landing; `landed` makes it first-commit-only, while
      // the two-pane commit below may still upgrade an already-landed view.
      let landed = false
      const landSingle = (): void => {
        if (landed || seq !== requestSeq.current) return
        landed = true
        setParent(target)
        setSelected(null)
        setChild(null)
        settle()
      }
      // Arity is label-independent: only the collapsed chain's depth decides.
      if (displayCrumbs(target, '').length < 2) { landSingle(); return }
      const parentCrumb = target.crumbs.at(-2)
      /* v8 ignore next -- narrowing: a two-deep display chain implies a parent crumb (root-to-target inclusive). */
      if (parentCrumb === undefined) { landSingle(); return }
      continueScan(parentCrumb.path).then((parentLevel) => {
        if (seq !== requestSeq.current) return
        // Windows resolves a typed path preserving its case; anchor on the
        // parent level's actual entry so selection comparisons hold.
        const sep = separatorOf(parentLevel)
        const fold = (value: string): string => (sep === '\\' ? value.toLowerCase() : value)
        const match = parentLevel.entries.find(entry => fold(entry.path) === fold(target.path))
        if (match === undefined) { landSingle(); return }
        landed = true
        setParent(parentLevel)
        setSelected(match)
        setChild(target)
        // Idempotent on a late upgrade of a timed-out landing: reopening the
        // editor or starting a newer scan supersedes this seq, so reaching
        // here means the settlement is still this landing's own.
        settle()
      }, () => {
        // The parent-leg failure (its abort included) never surfaces: the
        // target listed fine, and nobody asked to see the parent level.
        landSingle()
      })
      // Only a submitted navigation is bounded: the walk waits both legs out
      // (see the contract above), and a keystroke aborts it if the operator
      // moves on first.
      if (options.closeEditor) window.setTimeout(landSingle, PARENT_LEG_WAIT_MS)
    }, (reason: unknown) => {
      if (seq !== requestSeq.current) return
      setLoading(false)
      if (options.announce) setError(failureText(reason))
    })
  }, [launchListing, continueScan])

  /** Commit a submitted path (Enter, a crumb, the initial home listing): the editor closes, failures surface. */
  const navigate = useCallback((path?: string) => {
    land(path, { closeEditor: true, announce: true })
  }, [land])

  // Editor-close focus parking (consumed by the refocus effect below the
  // miller-row ref): a pick parks on the selection's row, Enter and an
  // input-focused Escape park on the crumb edit zone that replaces the
  // input. Pointer-out cancels never set (or clear) these — yanking focus
  // back from wherever the user clicked would be worse than the fall.
  const refocusPick = useRef(false)
  const refocusEditZone = useRef(false)
  const pathInputRef = useRef<HTMLInputElement | null>(null)
  const editZoneRef = useRef<HTMLButtonElement | null>(null)

  /**
   * Select a row of the listed level and preview its children on the right.
   * Deliberately NOT one-frame like navigate(): a pick's first duty is the
   * immediate selected state on the clicked row, and the pane split IS that
   * feedback (aria-current pill, crumbs following the selection) — holding
   * it back for the child listing would make clicks feel dropped. The quiet
   * rule governs whole-view replacement, where nothing acknowledges the
   * click but the swap itself.
   */
  const select = useCallback((entry: DirectoryEntry) => {
    const { seq, scan } = launchListing(entry.path)
    // A pick while the path editor is open adopts the (filtered) row and
    // closes the editor — the draft served its purpose. Focus re-parks on
    // the selection after commit (see the refocus effect below).
    if (pathDraft !== null) refocusPick.current = true
    setPathDraft(null)
    setSelected(entry)
    setChild(null)
    setLoading(true)
    setError(null)
    scan.then((next) => {
      if (seq !== requestSeq.current) return
      setChild(next)
      setLoading(false)
    }, (reason: unknown) => {
      if (seq !== requestSeq.current) return
      setLoading(false)
      setError(failureText(reason))
      // An unreadable selection cannot be the committing target while the
      // breadcrumb still names the level: fall back to the single pane.
      setSelected(null)
      // Clearing the selection can unmount the very row the pick parked
      // focus on (a dot-revealed hidden row re-hides); the refocus effect
      // re-parks on the edit zone only if focus actually fell to body.
      refocusEditZone.current = true
    })
  }, [launchListing, pathDraft])

  /**
   * Walk the panes to the directory the draft addresses, WITHOUT closing the
   * editor. The landing is an ordinary one — selection-anchored and two-pane
   * away from the display root — so typing a path moves the Miller view
   * exactly as a crumb jump does, and the draft's final segment
   * prefix-filters the arrival from the next render on.
   */
  const previewDraftLevel = useCallback((directory: string) => {
    land(directory, { closeEditor: false, announce: false })
  }, [land])

  /** Abandon path editing (Escape or clicking away) and restore the crumb view. */
  const cancelPathEdit = useCallback(() => {
    // Cancel also withdraws a navigation the editor already launched: its
    // late success must not jump to the cancelled path, so the pending
    // request is superseded and the view leaves the loading state.
    supersede()
    setLoading(false)
    setPathDraft(null)
    setError(null)
    // Editing may have superseded the selection's preview request; a
    // selection with no preview would render a half-empty two-pane view, so
    // cancel falls back to the single-pane level.
    if (child === null) setSelected(null)
    // With no level listed yet (the editor superseded the initial home
    // listing), plain cancellation would leave a permanently blank picker:
    // restart the home listing.
    if (parent === null) navigate()
  }, [supersede, child, parent, navigate])

  /** A right-column pick advances the view one level: child becomes the level. */
  const advance = useCallback((entry: DirectoryEntry) => {
    /* v8 ignore next -- narrowing guard: the right column only renders with a child listing. */
    if (child === null) return
    setParent(child)
    select(entry)
  }, [child, select])

  // Every open starts fresh at the Host home directory; closing invalidates
  // any in-flight response so a late arrival cannot repopulate a closed dialog.
  useEffect(() => {
    openGeneration.current += 1
    if (open) {
      setParent(null)
      setSelected(null)
      setChild(null)
      setCreatingFolder(false)
      setShowHidden(false)
      navigate()
      return
    }
    supersede()
    // Closing mid-scan leaves nothing to load: without this edge the
    // slow-scan effect keeps arming while hidden and the reopened dialog
    // would show the indicator on its first frame instead of waiting out a
    // fresh silence window (reopen's navigate() produces no loading edge).
    setLoading(false)
    setError(null)
    setPathDraft(null)
    setFolderDraft(null)
    setCreateError(null)
    // A close mid-flight (failed Enter, then Cancel) may leave refocus
    // flags armed; retire them so a later render cannot consume them.
    refocusPick.current = false
    refocusEditZone.current = false
  }, [open, navigate, supersede])

  /** The folder a create or Open acts on: the selection, else the listed level. */
  const targetPath = selected?.path ?? parent?.path ?? null
  const targetName = selected?.name
    ?? (parent === null ? '' : (displayCrumbs(parent, t('browser.home')).at(-1)?.name ?? parent.path))

  const confirmCreate = (): void => {
    /* v8 ignore next -- reentry fence: the nested dialog only renders with a target and disables while creating. */
    if (targetPath === null || folderDraft === null || creatingFolder) return
    // Trim only rejects an all-whitespace draft; the Host gets the original
    // spelling — the backend accepts any non-blank single segment verbatim,
    // and trimming here would create (and select) a different sibling.
    const name = folderDraft
    if (name.trim() === '') return
    setCreatingFolder(true)
    setCreateError(null)
    const generation = openGeneration.current
    createDirectory(targetPath, name).then((createdPath) => {
      // A settlement from a closed (possibly reopened) flow must not touch
      // the fresh dialog or issue a relist against the stale target.
      if (generation !== openGeneration.current) return
      setCreatingFolder(false)
      setFolderDraft(null)
      // Land like a right-column pick (figma 802:57446 → 813:23278 flow): the
      // create target becomes the listed level and the new folder its selection.
      const { seq, scan } = launchListing(targetPath)
      setLoading(true)
      // Symmetric with navigate/select: a launched scan clears the stale
      // failure text (and keeps the floating indicator's corner the only
      // occupant of the content's right edge while it shows).
      setError(null)
      scan.then((level) => {
        /* v8 ignore next -- same fence as navigate/select; the modal blocks superseding input */
        if (seq !== requestSeq.current) return
        setParent(level)
        setLoading(false)
        select({ name, path: createdPath, hidden: false })
      }, (reason: unknown) => {
        /* v8 ignore next -- same fence as navigate/select; the modal blocks superseding input */
        if (seq !== requestSeq.current) return
        setLoading(false)
        setError(failureText(reason))
      })
    }, (reason: unknown) => {
      if (generation !== openGeneration.current) return
      setCreatingFolder(false)
      setCreateError(failureText(reason))
    })
  }

  // The slow-scan gate for the loading indicator: each listing call restarts
  // the timer even when a superseding scan or a navigation's parent leg keeps
  // `loading` continuously true. A settle inside its own window means the swap
  // happened with nothing shown.
  useEffect(() => {
    if (!loading) {
      setSlowScan(false)
      return
    }
    const timer = window.setTimeout(() => { setSlowScan(true) }, SLOW_SCAN_DELAY_MS)
    return () => { window.clearTimeout(timer) }
  }, [loading, scanWindow])

  // The panes follow the draft: EVERY keystroke replaces the pending timer,
  // and the target is decided when it fires, off the panes as they stand
  // then. Keying the wait on the draft (not on the directory part it names)
  // is what makes a keystroke that superseded an in-flight scan re-arm one,
  // and what lets an edit after a rejected submission release the hold the
  // submission took. The panes are read through a ref for the converse
  // reason: were they dependencies, the landing this commits would re-arm the
  // wait, and a host answering with a differently spelled path would scan
  // forever.
  useEffect(() => {
    if (pathDraft === null) return
    const timer = window.setTimeout(() => {
      if (previewSuspended.current) return
      // The level the panes present as current: it alone may answer the
      // draft, so anything else it names is a level to walk to.
      const current = viewRef.current.child ?? viewRef.current.parent
      if (current === null) return
      const { directory, tail } = readDraft(current, pathDraft, scanned.current)
      if (directory === null || tail !== null) return
      previewDraftLevel(directory)
    }, DRAFT_PREVIEW_DEBOUNCE_MS)
    return () => { window.clearTimeout(timer) }
  }, [pathDraft, previewDraftLevel])

  // After the hooks: a closed dialog renders nothing and evaluates no copy.
  const crumbSource = child ?? parent
  // The draft's tail filters the level it names, which by the pane invariant
  // is the LAST pane — never a pane the draft has already walked away from.
  // Narrowing that stale pane would move the view twice for one keystroke:
  // once as it narrows, again as its landing replaces it. It holds still
  // instead, and the filter arrives with the level it belongs to.
  const typedPrefix = crumbSource === null || pathDraft === null
    ? null
    : readDraft(crumbSource, pathDraft, scanned.current).tail
  const crumbs = crumbSource === null ? [] : displayCrumbs(crumbSource, t('browser.home'))
  const crumbTail = crumbs.at(-1)?.path
  useEffect(() => {
    const trail = crumbTrailRef.current
    if (trail !== null) trail.scrollLeft = trail.scrollWidth
  }, [crumbTail])
  // On viewports too narrow for both fixed panes the Miller row scrolls;
  // whenever a child preview lands, pin it into view the way the crumb tail
  // pins — otherwise descent is unreachable on a phone-width window.
  const millerRowRef = useRef<HTMLDivElement | null>(null)
  const childPath = child?.path
  useEffect(() => {
    const row = millerRowRef.current
    if (row !== null && childPath !== undefined) row.scrollLeft = row.scrollWidth
  }, [childPath])
  // Every editor exit that would drop focus to body re-parks it after
  // commit, so keyboard traversal stays inside the dialog (the Modal has no
  // focus trap): a pick lands on the selection's row — aria-current in the
  // freshly rendered left pane, which survives even a right-pane advance
  // replacing the picked button's column — while Enter and an input-focused
  // Escape land on the crumb edit zone that replaces the input.
  useEffect(() => {
    if (refocusPathInput.current) {
      refocusPathInput.current = false
      // Only when the swap actually dropped focus to body: focus the operator
      // still holds (the input itself, a surviving row) stays theirs.
      if (document.activeElement === document.body) pathInputRef.current?.focus()
    }
    if (pathDraft !== null) return
    if (refocusPick.current) {
      refocusPick.current = false
      refocusEditZone.current = false
      const rowHost = millerRowRef.current
      /* v8 ignore next -- narrowing guard: the miller row is mounted whenever a pick just committed. */
      if (rowHost === null) return
      const row = rowHost.querySelector<HTMLButtonElement>('button[aria-current="true"]')
      /* v8 ignore next -- narrowing guard: the pick that set the flag just rendered its aria-current row. */
      if (row === null) return
      row.focus()
      return
    }
    if (refocusEditZone.current) {
      refocusEditZone.current = false
      // Re-park only when the close actually dropped focus to body; focus
      // the user parked elsewhere (a surviving row) stays theirs.
      if (document.activeElement !== document.body) return
      const zone = editZoneRef.current
      /* v8 ignore next -- narrowing guard: crumb mode renders the edit zone whenever the editor just closed. */
      if (zone === null) return
      zone.focus()
    }
  })

  if (!open) return null
  const twoPane = selected !== null
  // The nested create dialog owns the interaction while open: Modal has no
  // focus trap, so every parent control goes inert (Shift-Tab or AT must not
  // close, adopt, or retarget underneath the child).
  const parentInert = busy || folderDraft !== null
  // An uncommitted path draft makes targetPath stale relative to the header:
  // committing actions must not act on the previous selection/listing while
  // a different path is displayed.
  const draftPending = pathDraft !== null

  return {
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
  }
}

/** State and callbacks consumed by the directory browser dialog. */
export type DirectoryBrowserModel = ReturnType<typeof useDirectoryBrowserModelInternal>

/**
 * Build the directory browser's navigation and editing state.
 * @param props - Owner-controlled browse operations and dialog state.
 * @returns The view model consumed by the browser dialog.
 */
export function useDirectoryBrowserModel(props: DirectoryBrowserProps): DirectoryBrowserModel {
  return useDirectoryBrowserModelInternal(props)
}
