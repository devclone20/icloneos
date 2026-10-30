import './email.css'

/**
 * EconomyOS — Email. The agent's own mailbox as a calm desktop mail client:
 * folders · day-grouped list · reading pane · compose sheet, driven from the
 * keyboard: ↑/↓ or j/k move (with a thread open they open the next one),
 * [ / ] previous / next thread, ↩ opens, U back to the list, Esc closes (or
 * clears the selection), C compose, R reply, / search, X selects the row,
 * E archives, # trashes, ⇧I / ⇧U mark read / unread, Z undoes a move.
 *
 * Its first commit is the last snapshot of page one, then it reads
 * `acp email inbox` (usually a cache hit — `prefetch` ran at summon); the
 * open thread, spam and the address follow the list, never gate it. The only
 * writes are `email compose` and `email reply`; after either, the cached
 * list, thread and search reads are dropped and re-read.
 *
 * The CLI has no mark-as-read, delete or move, so read state, Archive and
 * Trash are the owner's own marks — per iNFT, on this computer (email-state)
 * — laid over every list. Opening a message marks it read in the same frame,
 * before its thread is even asked for.
 */
import { SquarePen, X } from 'lucide-react'
import { memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { EconWindowContext, useAskInft, useOpenSetup } from '../handoff'
import { reportEconStatus } from '../live'
import { useSnapshot } from '../snapshot'
import type { EconAppProps } from '../types'
import { Action, AppFrame, IconAction, SearchBox, Toolbar } from '../ui'

import { ComposeSheet } from './email-compose'
import { CheckBox, type Flash, MailFlash, SelectionBar } from './email-controls'
import {
  countLabel,
  type Draft,
  EMAIL_SNAPSHOT_VERSION,
  type EmailSnapshot,
  EMPTY_DRAFT,
  hasDraft,
  mail,
  type Mailbox,
  type MailMessage,
  type MailPage,
  type MailScope,
  onPageOne,
  publishUnread,
  readMailSnapshot,
  restoreSnapshot,
  SEARCH_MAX,
  type ServerFolder,
  shouldAutoPage,
  snapshotOf,
  unreadCount
} from './email-data'
import { MailList } from './email-list'
import { type PaneState, ThreadPane } from './email-pane'
import { type FolderCounts, MailRail } from './email-rail'
import {
  folderRows,
  isUnread,
  type MailFolder,
  type MailPools,
  type MailState,
  mergeMailStates,
  placeOf,
  purgedRows,
  readMailState,
  reconcileMailStateFile,
  searchRows,
  unloadedCount,
  writeMailState
} from './email-state'
import {
  EMPTY_LIST,
  focusMailRow,
  type ListState,
  type MarksChange,
  NONE,
  type SearchState,
  WITH_SPAM
} from './mail-shared'
import { useMailCompose } from './use-mail-compose'
import { useMailKeys } from './use-mail-keys'
import { useMailbox } from './use-mailbox'
import { useThread } from './use-thread'

const FLASH_MS = 4200
const THREAD_PREFETCH_SETTLE_MS = 250
// The newest rows' threads are read once the list has painted, so a first
// open paints from memory; a thread already remembered costs no read.
const THREAD_READ_AHEAD_SETTLE_MS = 300
const UNDO_MS = 6000

/** The owner's marks for one iNFT: read from disk before the first commit,
 *  written back on every change. `commit` answers synchronously with what it
 *  replaced (null when nothing changed), so a handler can offer Undo. */
function useMailMarks(slug: string): {
  commit: (update: (state: MailState) => MailState) => MarksChange | null
  marks: MailState
} {
  const [marks, setMarks] = useState(() => readMailState(slug))
  // Changes chain within one event (open, then step on): each builds on the
  // last one made, not on the last render.
  const latest = useRef(marks)

  const commit = useCallback(
    (update: (state: MailState) => MailState): MarksChange | null => {
      const before = latest.current
      const after = update(before)

      if (after === before) {
        return null
      }

      latest.current = after
      setMarks(after)
      writeMailState(slug, after)

      return { before, after }
    },
    [slug]
  )

  // The file copy in main (email-state.json) outlives a wiped localStorage:
  // union it in once per iNFT, after the first paint from localStorage.
  useEffect(() => {
    let live = true
    const start = latest.current

    void reconcileMailStateFile(slug, start).then(merged => {
      if (live && merged !== start) {
        // A mark made while the file was read is kept: unstamped, both sides union.
        commit(current =>
          current === start
            ? merged
            : mergeMailStates({ state: current, writtenAt: null }, { state: merged, writtenAt: null })
        )
      }
    })

    return () => {
      live = false
    }
  }, [commit, slug])

  return { commit, marks }
}

/** The search field owns its text: a keystroke renders this box, not the
 *  mail client. `resetKey` clears it when the client ends the search. */
// A search runs by itself this long after the last key, from two characters on.
const SEARCH_DEBOUNCE_MS = 300
const SEARCH_MIN = 2

const MailSearch = memo(function MailSearch({
  hidden,
  onEmptied,
  onSubmit,
  resetKey
}: {
  /** Out of sight while the selection bar holds the toolbar — kept mounted,
   *  so the words typed are still there after. */
  hidden: boolean
  onEmptied: () => void
  onSubmit: (text: string) => void
  resetKey: number
}) {
  const [text, setText] = useState('')
  const [seenKey, setSeenKey] = useState(resetKey)
  const pending = useRef<null | ReturnType<typeof setTimeout>>(null)

  const cancelPending = useCallback(() => {
    if (pending.current !== null) {
      clearTimeout(pending.current)
      pending.current = null
    }
  }, [])

  useEffect(() => cancelPending, [cancelPending])

  if (seenKey !== resetKey) {
    setSeenKey(resetKey)
    setText('')
    cancelPending()
  }

  return (
    <div className="em-search" hidden={hidden}>
      <SearchBox
        onChange={value => {
          // The bridge refuses a longer query outright; typing stops here.
          const next = value.slice(0, SEARCH_MAX)

          setText(next)
          cancelPending()

          if (!next.trim()) {
            onEmptied()
          } else if (next.trim().length >= SEARCH_MIN) {
            // Typing searches by itself once the keys pause; Enter only skips the wait.
            pending.current = setTimeout(() => {
              pending.current = null
              onSubmit(next)
            }, SEARCH_DEBOUNCE_MS)
          }
        }}
        onSubmit={() => {
          cancelPending()
          onSubmit(text)
        }}
        placeholder="Search mail"
        value={text}
      />
      <kbd aria-hidden="true" className="em-kbd">
        /
      </kbd>
    </div>
  )
})

export default function EmailApp(props: EconAppProps) {
  // Another iNFT is another mailbox — start it from a clean slate.
  return <EmailClient key={props.slug} {...props} />
}

let mountCount = 0

function EmailClient({ inftId, refreshKey, slug }: EconAppProps) {
  const { agentName } = useContext(EconWindowContext)
  const ask = useAskInft()
  const openSetup = useOpenSetup()
  const scope = useMemo<MailScope>(() => ({ inftId, slug }), [inftId, slug])
  const rootRef = useRef<HTMLDivElement>(null)
  // The thread the pane shows right now — a late answer for another is dropped.
  const paneIdRef = useRef<null | string>(null)
  const searchSeqRef = useRef(0)
  // Page one as last stored, read before the first commit: the first paint
  // is the mail, not a skeleton.
  const [initial] = useState(() => readMailSnapshot(slug))
  const { commit, marks } = useMailMarks(slug)

  // Written by handlers and loads, read by later async work: a load started
  // right after a handler must see what the handler decided, not the last render.
  const session = useRef({
    folder: 'inbox' as MailFolder,
    query: null as null | string,
    mailbox: initial?.data.mailbox ?? null,
    note: initial?.data.mailboxNote ?? null,
    pageOne: null as null | { answer: MailPage; page: MailPage; at: number },
    /** A row (or the root, for null) to focus after the next commit. */
    focus: undefined as null | string | undefined,
    /** The search box, to focus after the next commit (the bar hid it). */
    focusSearch: false,
    /** A step past the last row, waiting for the next page to land. */
    step: null as null | { from: string; open: boolean },
    autoPaged: 0,
    /** A page in flight, per list: spam paging never blocks the inbox's. */
    paging: { inbox: false, spam: false } as Record<ServerFolder, boolean>,
    /** Where the cursor row stood, for a step after it left the view. */
    cursorIndex: null as null | number,
    /** The row a shift-click extends from. */
    anchor: null as null | string,
    flashSeq: 0,
    /** Threads opened this session — the service reads them when asked for. */
    opened: new Set<string>()
  })

  const [folder, setFolder] = useState<MailFolder>('inbox')

  const [base, setBase] = useState<ListState>(() =>
    initial ? { ...EMPTY_LIST, page: initial.data.base, loaded: true, hydrated: true } : EMPTY_LIST
  )

  // When the rows on screen were stored (shown until the live answer lands).
  const [snapshotAt, setSnapshotAt] = useState(initial?.at ?? 0)
  const [spam, setSpam] = useState<ListState>(EMPTY_LIST)
  const [mailbox, setMailbox] = useState<Mailbox | null>(initial?.data.mailbox ?? null)
  // Why there is no address to show (null while the first read is out).
  const [mailboxNote, setMailboxNote] = useState<null | string>(initial?.data.mailboxNote ?? null)
  const [searchResetKey, setSearchResetKey] = useState(0)
  const [search, setSearch] = useState<SearchState | null>(null)
  /** The cursor: the row the keys move and the pane opened. */
  const [selectedId, setSelectedId] = useState<null | string>(null)
  /** The selection: rows checked for a bulk action. */
  const [checked, setChecked] = useState<ReadonlySet<string>>(NONE)
  // Rows moved out of search results that no loaded page holds — Archive and
  // Trash still show them this session.
  const [adopted, setAdopted] = useState<MailMessage[]>([])
  const [pane, setPane] = useState<PaneState | null>(null)
  const [composing, setComposing] = useState(false)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [flash, setFlash] = useState<Flash | null>(null)
  const [replyFocusFor, setReplyFocusFor] = useState<null | string>(null)

  // ── what shows ────────────────────────────────────────────────────────────
  // The lists hold the service's rows; every view lays the owner's marks over them.

  const pools = useMemo<MailPools<MailMessage>>(
    () => ({ base: base.page.messages, spam: spam.page.messages, adopted }),
    [adopted, base.page.messages, spam.page.messages]
  )

  const visible = useMemo(
    () => (search ? searchRows(marks, search.messages) : folderRows(marks, pools, folder)),
    [folder, marks, pools, search]
  )

  const inboxRows = useMemo(() => folderRows(marks, pools, 'inbox'), [marks, pools])
  const hidden = useMemo(() => purgedRows(marks, pools, folder), [folder, marks, pools])

  const unloaded = useMemo(
    () => ({ archive: unloadedCount(marks, pools, 'archive'), trash: unloadedCount(marks, pools, 'trash') }),
    [marks, pools]
  )

  const current = folder === 'spam' ? spam : base
  const moved = folder === 'archive' || folder === 'trash' ? folder : null

  // Archive and Trash look further back only while marks of theirs sit on
  // pages not loaded — an empty Archive never pages for nothing.
  const canLoadMore =
    !search && Boolean(current.page.nextCursor) && !current.hydrated && (moved === null || unloaded[moved] > 0)

  const counts = useMemo<FolderCounts>(() => {
    const older = Boolean(base.page.nextCursor)

    return {
      inbox: countLabel(unreadCount(inboxRows), older),
      archive: countLabel(folderRows(marks, pools, 'archive').length, older && unloaded.archive > 0),
      trash: countLabel(folderRows(marks, pools, 'trash').length, older && unloaded.trash > 0),
      spam: spam.loaded ? countLabel(folderRows(marks, pools, 'spam').length, Boolean(spam.page.nextCursor)) : undefined
    }
  }, [base.page.nextCursor, inboxRows, marks, pools, spam.loaded, spam.page.nextCursor, unloaded])

  const picked = useMemo(
    () => (checked.size === 0 ? [] : visible.filter(message => checked.has(message.id))),
    [checked, visible]
  )

  const pickedIds = useMemo(() => (picked.length === 0 ? NONE : new Set(picked.map(message => message.id))), [picked])

  const selecting = picked.length > 0

  // Between two automatic pages the view still reads as "looking further
  // back", never as a finished empty state for a frame.
  const autoPaging = shouldAutoPage({
    visible: visible.length,
    searching: search !== null,
    canLoadMore,
    loadingMore: current.loadingMore,
    failed: current.moreError !== null,
    paged: session.current.autoPaged
  })

  // ── snapshot ──────────────────────────────────────────────────────────────
  // The state above is seeded from it; the hook reports its age and owns the
  // writes. Declared before the refresh so its effect runs first on mount.

  const { clear, persist } = useSnapshot<EmailSnapshot>('email', slug, EMAIL_SNAPSHOT_VERSION, snapshot => {
    const restored = restoreSnapshot(snapshot.data)

    if (!restored) {
      return
    }

    reportEconStatus('email', slug, { updatedAt: snapshot.at })

    // A newer one (a prefetch that landed since the first render) repaints,
    // unless a live answer is already on screen.
    if (snapshot.at === initial?.at) {
      return
    }

    session.current.mailbox = restored.mailbox
    session.current.note = restored.mailboxNote
    setBase(state =>
      state.loaded && !state.hydrated ? state : { ...EMPTY_LIST, page: restored.base, loaded: true, hydrated: true }
    )
    setSnapshotAt(snapshot.at)
    setMailbox(restored.mailbox)
    setMailboxNote(restored.mailboxNote)
  })

  function persistNow() {
    const { mailbox: known, note, pageOne } = session.current

    if (pageOne) {
      persist(snapshotOf(pageOne.page, known, note), pageOne.at)
    }
  }

  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true })
  }, [])

  // Focus requested by a handler lands once the commit it caused is on screen.
  useLayoutEffect(() => {
    const state = session.current

    if (state.focusSearch) {
      state.focusSearch = false
      state.focus = undefined
      focusSearchBox()

      return
    }

    const target = state.focus

    if (target !== undefined) {
      state.focus = undefined
      focusMailRow(rootRef.current, target)
    }
  })

  useEffect(() => {
    if (!flash) {
      return
    }

    const timer = window.setTimeout(() => setFlash(null), flash.undo ? UNDO_MS : FLASH_MS)

    return () => window.clearTimeout(timer)
  }, [flash])

  // The dock tile counts live answers only — a snapshot's count is older than
  // the one the prefetch already published — and page one only, as the
  // prefetch does. Runs after the commit `fetchList` caused, so `pageOne` is
  // set; and after every change of the owner's marks, so opening a message
  // takes it off the tile in the same frame.
  useEffect(() => {
    if (base.loaded && !base.hydrated) {
      publishUnread(slug, onPageOne(inboxRows, session.current.pageOne?.page ?? null))
    }
  }, [base.hydrated, base.loaded, inboxRows, slug])

  // "Showing mail saved…" is a routine, not an error: the window header says
  // it (fixed width) while the rows on screen still come from disk, so the
  // list never grows or shrinks a line when the live answer lands.
  const savedAt = !search && current.hydrated ? snapshotAt : 0

  useEffect(() => {
    reportEconStatus('email', slug, { snapshotAt: savedAt })
  }, [savedAt, slug])

  useEffect(() => () => reportEconStatus('email', slug, { snapshotAt: 0 }), [slug])

  // Remount probe for the live gates: the number of EmailClient mounts this
  // session, on the root — a silent tick must never move it.
  useEffect(() => {
    mountCount += 1
    rootRef.current?.setAttribute('data-mount', String(mountCount))
  }, [])

  // ── reads ─────────────────────────────────────────────────────────────────

  const setList = (target: ServerFolder, update: (state: ListState) => ListState) =>
    target === 'spam' ? setSpam(update) : setBase(update)

  const {
    focusSearchBox,
    focusRoot,
    runSearch,
    requestFocus,
    fetchList,
    fetchThread,
    loadMore,
    reload,
    pageNearEnd,
    retryList,
    retryThread
  } = useMailbox({
    scope,
    setList,
    session,
    persistNow,
    clear,
    setMailbox,
    setMailboxNote,
    paneIdRef,
    setPane,
    setBase,
    searchSeqRef,
    setSearch,
    slug,
    inftId,
    refreshKey,
    search,
    folder,
    spam,
    base,
    current,
    rootRef
  })

  function focusSearch() {
    // The selection bar holds the toolbar: give the box back, then focus it.
    if (checked.size > 0) {
      clearChecked(false)
      session.current.focusSearch = true

      return
    }

    focusSearchBox()
  }

  /** Move the cursor, remembering where it stands in the view. */
  function moveCursor(id: null | string) {
    session.current.cursorIndex = id ? visible.findIndex(message => message.id === id) : null
    setSelectedId(id)
  }

  function say(text: string, undo: (() => void) | null = null) {
    session.current.flashSeq += 1
    setFlash({ id: session.current.flashSeq, text, undo })
  }

  // ── navigation ────────────────────────────────────────────────────────────

  function clearSearch(refocus = true) {
    searchSeqRef.current += 1
    Object.assign(session.current, { query: null, step: null })
    setSearch(null)
    setSearchResetKey(key => key + 1)
    clearChecked(false)

    if (refocus) {
      focusRoot()
    }
  }

  function submitSearch(text: string) {
    moveCursor(null)
    clearChecked(false)
    void runSearch(text)
  }

  function searchEmptied() {
    if (session.current.query !== null) {
      clearSearch(false)
    }
  }

  function closePane(refocus = true) {
    paneIdRef.current = null
    // Back to the list: a step still waiting on a page must not reopen one.
    session.current.step = null
    setPane(null)

    if (refocus) {
      requestFocus(selectedId)
    }
  }

  function showFolder(next: MailFolder) {
    Object.assign(session.current, { folder: next, step: null, autoPaged: 0 })
    setFolder(next)
    clearSearch(false)
    moveCursor(null)
    closePane(false)

    if (WITH_SPAM.has(next) && !spam.loaded) {
      void fetchList('spam', false)
    }
  }

  /** The service's own rows that match — what a read mark is weighed
   *  against (the view's rows already wear the owner's marks). */
  function serviceRows(match: (row: MailMessage) => boolean): MailMessage[] {
    const seen = new Set<string>()
    const rows: MailMessage[] = []

    for (const list of [base.page.messages, spam.page.messages, search?.messages ?? [], adopted]) {
      for (const row of list) {
        if (!seen.has(row.id) && match(row)) {
          seen.add(row.id)
          rows.push(row)
        }
      }
    }

    return rows
  }

  const { clearChecked, settle, selected, openMessage, check, go, toggleAll, step, replyShortcut, toggleFocused } =
    useThread({
      moveCursor,
      say,
      serviceRows,
      commit,
      session,
      setComposing,
      paneIdRef,
      setPane,
      requestFocus,
      setReplyFocusFor,
      fetchThread,
      lastThread: threadId => mail.lastThread(scope, threadId),
      rootRef,
      visible,
      selectedId,
      canLoadMore,
      current,
      loadMore,
      pane,
      pickedIds,
      setChecked,
      picked,
      checked,
      search,
      pools,
      folder,
      closePane,
      setSelectedId
    })

  // The cursor's thread is read ahead (amendment item 7): a short settle, so
  // j/k across the list spends no read per row it passes; the open then hits
  // the cache (same argv, never forced).
  const cursorThreadId = visible.find(message => message.id === selectedId)?.threadId ?? null
  const openThreadId = pane?.threadId ?? null

  useEffect(() => {
    if (!cursorThreadId || cursorThreadId === openThreadId) {
      return
    }

    const timer = window.setTimeout(() => mail.prefetchThread(scope, cursorThreadId), THREAD_PREFETCH_SETTLE_MS)

    return () => window.clearTimeout(timer)
  }, [cursorThreadId, openThreadId, scope])

  // The newest rows' bodies are read ahead once the list has painted (from
  // the snapshot too), so a first open paints from memory: the selected row
  // first, one speculative read at a time and never in front of an open, the
  // plan dropped when the window closes or the iNFT changes (thread-prefetch.ts).
  const aheadRows = base.loaded && !search ? visible : null
  const leadThreadId = cursorThreadId === openThreadId ? null : cursorThreadId

  useEffect(() => {
    if (!aheadRows?.length) {
      return
    }

    const timer = window.setTimeout(
      () => mail.prefetchThreads(scope, aheadRows, leadThreadId),
      THREAD_READ_AHEAD_SETTLE_MS
    )

    return () => window.clearTimeout(timer)
  }, [aheadRows, leadThreadId, scope])

  useEffect(() => () => mail.cancelThreadPrefetch(scope.slug), [scope])

  const {
    askAboutThread,
    askIntro,
    closeCompose,
    compose,
    composeTo,
    discardDraft,
    emptyTrash,
    markRows,
    moveRows,
    paneMarkUnread,
    paneRows,
    sendDraft,
    sendReply,
    moveKey,
    markKey
  } = useMailCompose({
    commit,
    moveCursor,
    requestFocus,
    setFlash,
    session,
    serviceRows,
    settle,
    base,
    spam,
    setAdopted,
    say,
    pane,
    visible,
    closePane,
    picked,
    selected,
    search,
    folder,
    setComposing,
    setDraft,
    selectedId,
    scope,
    showFolder,
    reload,
    openMessage,
    focusRoot,
    ask,
    mailbox
  })

  // ── stable handlers ───────────────────────────────────────────────────────
  // Memoised children get these once; each call reaches this render's function.

  // This render's handlers, and the selection the bar acts on.
  const { stable, paneActions, onKeyDown, selectionActions, listActions, view } = useMailKeys({
    askAboutThread,
    askIntro,
    check,
    clearChecked,
    clearSearch,
    closeCompose,
    closePane,
    compose,
    composeTo,
    discardDraft,
    emptyTrash,
    go,
    hidden,
    loadMore,
    markRows,
    moveRows,
    openMessage,
    openSetup,
    pageNearEnd,
    paneMarkUnread,
    paneRows,
    picked,
    retryList,
    retryThread,
    searchEmptied,
    sendDraft,
    sendReply,
    showFolder,
    submitSearch,
    toggleAll,
    setReplyFocusFor,
    autoPaging,
    current,
    session,
    visible,
    search,
    focusRoot,
    pane,
    composing,
    selecting,
    selected,
    step,
    replyShortcut,
    focusSearch,
    toggleFocused,
    moveKey,
    folder,
    markKey,
    flash,
    canLoadMore
  })

  const address = mailbox?.address ?? ''
  const allChecked = !selecting ? false : picked.length === visible.length ? true : 'mixed'
  const paneSeed = pane?.seed ?? null

  const aside = composing ? (
    <ComposeSheet
      draft={draft}
      from={address}
      onChange={setDraft}
      onClose={stable.closeCompose}
      onDiscard={stable.discardDraft}
      onSend={stable.sendDraft}
    />
  ) : pane ? (
    <ThreadPane
      actions={paneActions}
      agentName={agentName}
      canMarkUnread={paneSeed?.direction === 'inbound'}
      focusReply={replyFocusFor === pane.threadId}
      key={pane.threadId}
      mailbox={address}
      pane={pane}
      place={paneSeed ? placeOf(marks, paneSeed.id) : 'mailbox'}
    />
  ) : undefined

  return (
    <div className="em" onKeyDown={onKeyDown} ref={rootRef} tabIndex={-1}>
      <AppFrame
        aside={aside}
        className={aside ? 'em-frame em-frame--pane' : 'em-frame'}
        rail={
          <MailRail
            counts={counts}
            folder={folder}
            mailbox={mailbox}
            mailboxNote={mailboxNote}
            onSelect={stable.showFolder}
          />
        }
      >
        <Toolbar
          end={
            selecting ? (
              <IconAction label="Clear selection · Esc" onClick={stable.clearChecked}>
                <X size={14} strokeWidth={1.8} />
              </IconAction>
            ) : (
              <Action kind="primary" onClick={stable.compose} title="Compose · C">
                <SquarePen size={13} strokeWidth={1.8} />
                Compose
                {!composing && hasDraft(draft) ? (
                  <span aria-label="Draft waiting" className="em-draft-dot" role="img" />
                ) : null}
              </Action>
            )
          }
        >
          <CheckBox
            checked={allChecked}
            disabled={visible.length === 0}
            label="Select all"
            onToggle={stable.toggleAll}
            title="Select all shown · X selects one"
          />
          <MailSearch
            hidden={selecting}
            onEmptied={stable.searchEmptied}
            onSubmit={stable.submitSearch}
            resetKey={searchResetKey}
          />
          {selecting ? (
            <SelectionBar
              actions={selectionActions}
              canMarkRead={picked.some(isUnread)}
              canMarkUnread={picked.some(message => message.direction === 'inbound' && message.isRead)}
              count={picked.length}
              folder={search ? null : folder}
            />
          ) : null}
        </Toolbar>

        <MailList
          actions={listActions}
          address={address}
          agentName={agentName}
          checked={pickedIds}
          selectedId={selectedId}
          view={view}
        />

        <MailFlash flash={flash} />
      </AppFrame>
    </div>
  )
}
