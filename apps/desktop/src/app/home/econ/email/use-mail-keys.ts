import {
  type Dispatch,
  type KeyboardEvent,
  type RefObject,
  type SetStateAction,
  useEffect,
  useMemo,
  useRef
} from 'react'

import { type Flash, type SelectionActions } from './email-controls'
import { type Draft, type MailMessage, stepFrom } from './email-data'
import { type CheckMode, type ListActions, type ListView } from './email-list'
import { type PaneActions, type PaneState } from './email-pane'
import { type MailFolder, type MailMove } from './email-state'
import { type ListState, type MailSession, type SearchState } from './mail-shared'

// Keys some layouts can only type with Option/AltGr (Portuguese and German
// Macs: ⌥8 / ⌥9 for [ and ]; British Macs: ⌥3 for #) — Alt alone must not
// disable them.
const ALT_TYPED = new Set(['[', ']', '#'])

function isTyping(target: HTMLElement): boolean {
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  )
}

export function useMailKeys({
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
}: {
  askAboutThread: ({ id, subject }: { id: string; subject: string }) => void
  askIntro: () => void
  check: (message: MailMessage, mode: CheckMode) => void
  clearChecked: (refocus?: boolean) => void
  clearSearch: (refocus?: boolean) => void
  closeCompose: () => void
  closePane: (refocus?: boolean) => void
  compose: () => void
  composeTo: (address: string) => void
  discardDraft: () => void
  emptyTrash: () => void
  go: (message: MailMessage, open: boolean) => void
  /** Loaded rows this folder hides because they were deleted forever here. */
  hidden: readonly MailMessage[]
  loadMore: (auto?: boolean) => Promise<boolean>
  markRows: (rows: readonly MailMessage[], read: boolean) => void
  moveRows: (move: MailMove, rows: readonly MailMessage[]) => void
  openMessage: (message: MailMessage, focusReply?: boolean) => void
  openSetup: () => void
  pageNearEnd: () => void
  paneMarkUnread: () => void
  paneRows: () => MailMessage[]
  picked: MailMessage[]
  retryList: () => void
  retryThread: (threadId: string) => void
  searchEmptied: () => void
  sendDraft: (sending: Draft) => Promise<null | string>
  sendReply: (threadId: string, body: string) => Promise<null | string>
  showFolder: (next: MailFolder) => void
  submitSearch: (text: string) => void
  toggleAll: () => void
  setReplyFocusFor: Dispatch<SetStateAction<string | null>>
  autoPaging: boolean
  current: ListState
  session: RefObject<MailSession>
  visible: MailMessage[]
  search: SearchState | null
  focusRoot: () => void
  pane: PaneState | null
  composing: boolean
  selecting: boolean
  selected: () => MailMessage | undefined
  step: (delta: number, open: boolean) => void
  replyShortcut: () => void
  focusSearch: () => void
  toggleFocused: (target: HTMLElement) => void
  moveKey: (move: MailMove) => void
  folder: MailFolder
  markKey: (read: boolean) => void
  flash: Flash | null
  canLoadMore: boolean
}) {
  // ── stable handlers ───────────────────────────────────────────────────────
  // Memoised children get these once; each call reaches this render's function.

  // This render's handlers, and the selection the bar acts on.
  const handlers = {
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
    toggleAll
  }

  const latest = useRef(handlers)

  latest.current = handlers

  const stable = useMemo(
    () => ({
      clearChecked: () => latest.current.clearChecked(),
      closeCompose: () => latest.current.closeCompose(),
      compose: () => latest.current.compose(),
      discardDraft: () => latest.current.discardDraft(),
      searchEmptied: () => latest.current.searchEmptied(),
      sendDraft: (sending: Draft) => latest.current.sendDraft(sending),
      showFolder: (next: MailFolder) => latest.current.showFolder(next),
      submitSearch: (text: string) => latest.current.submitSearch(text),
      toggleAll: () => latest.current.toggleAll()
    }),
    []
  )

  const listActions = useMemo<ListActions>(
    () => ({
      onAskIntro: () => latest.current.askIntro(),
      onCheck: (message, mode) => latest.current.check(message, mode),
      onClearSearch: () => latest.current.clearSearch(),
      onCompose: () => latest.current.compose(),
      onEmptyTrash: () => latest.current.emptyTrash(),
      onLoadMore: () => void latest.current.loadMore(),
      onNearEnd: () => latest.current.pageNearEnd(),
      onOpen: message => latest.current.openMessage(message),
      onRecover: () => latest.current.moveRows('recover', latest.current.hidden),
      onRetry: () => latest.current.retryList(),
      onSetup: () => latest.current.openSetup()
    }),
    []
  )

  const paneActions = useMemo<PaneActions>(
    () => ({
      onAsk: thread => latest.current.askAboutThread(thread),
      onClose: () => latest.current.closePane(),
      onComposeTo: address => latest.current.composeTo(address),
      onMarkUnread: () => latest.current.paneMarkUnread(),
      onMove: move => latest.current.moveRows(move, latest.current.paneRows()),
      onReply: (threadId, body) => latest.current.sendReply(threadId, body),
      onReplyFocused: () => setReplyFocusFor(null),
      onRetry: threadId => latest.current.retryThread(threadId),
      onSetup: () => latest.current.openSetup()
    }),
    [setReplyFocusFor]
  )

  const selectionActions = useMemo<SelectionActions>(
    () => ({
      onMark: read => latest.current.markRows(latest.current.picked, read),
      onMove: move => latest.current.moveRows(move, latest.current.picked)
    }),
    []
  )

  // ── paging continuations ──────────────────────────────────────────────────

  // An empty view over older pages looks further back by itself, a few pages
  // per visit; then its empty state offers the next page. Keyed on the page as
  // well: a fast answer can land in the same render that started the load.
  useEffect(() => {
    if (autoPaging) {
      void latest.current.loadMore(true)
    }
  }, [autoPaging, current.page])

  // A step past the last row asked for the next page — take the step once
  // it lands (or drop it when the page failed).
  useEffect(() => {
    const state = session.current
    const pending = state.step

    if (!pending || current.loadingMore) {
      return
    }

    state.step = null
    const target = visible.some(message => message.id === pending.from) ? stepFrom(visible, pending.from, 1) : null

    if (target && !target.edge) {
      latest.current.go(visible[target.index], pending.open)
    }
  }, [current.loadingMore, session, visible])

  // ── keyboard ──────────────────────────────────────────────────────────────

  function escape(target: HTMLElement): boolean {
    if (isTyping(target)) {
      if (target.classList.contains('e-search') && ((target as HTMLInputElement).value || search)) {
        clearSearch(false)

        return true
      }

      target.blur()
      focusRoot()

      return true
    }

    // One Esc, one thing: the sheet, else the selection (unless the keys are
    // in the open thread — then the thread), else the thread, else the search.
    const inPane = pane !== null && target.closest('.e-aside') !== null

    if (composing) {
      closeCompose()
    } else if (selecting && !inPane) {
      clearChecked()
    } else if (pane) {
      closePane()
    } else if (search) {
      clearSearch()
    } else {
      return false
    }

    return true
  }

  function openSelected() {
    const message = selected()

    if (message) {
      openMessage(message)
    }
  }

  function shortcut(key: string, target: HTMLElement): boolean {
    // A focused button already answers Enter with its own click.
    if (key === 'Enter' && target.tagName === 'BUTTON') {
      return false
    }

    const reading = pane !== null

    const run = new Map<string, () => void>([
      ['ArrowDown', () => step(1, reading)],
      ['ArrowUp', () => step(-1, reading)],
      ['j', () => step(1, reading)],
      ['k', () => step(-1, reading)],
      [']', () => step(1, true)],
      ['[', () => step(-1, true)],
      ['u', () => reading && closePane()],
      ['Enter', openSelected],
      ['c', compose],
      ['r', replyShortcut],
      ['/', focusSearch],
      ['x', () => toggleFocused(target)],
      ['e', () => moveKey(!search && folder === 'archive' ? 'inbox' : 'archive')],
      ['#', () => moveKey('trash')],
      ['I', () => markKey(true)],
      ['U', () => markKey(false)],
      ['z', () => flash?.undo?.()]
    ]).get(key)

    run?.()

    return Boolean(run)
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || (event.altKey && !ALT_TYPED.has(event.key))) {
      return
    }

    const target = event.target as HTMLElement

    if (event.key === 'Escape') {
      if (escape(target)) {
        event.preventDefault()
      }

      return
    }

    if (isTyping(target)) {
      if (event.key === 'ArrowDown' && target.classList.contains('e-search')) {
        event.preventDefault()
        step(1, pane !== null)
      }

      return
    }

    if (shortcut(event.key, target)) {
      event.preventDefault()
    }
  }

  // ── render ────────────────────────────────────────────────────────────────

  const view = useMemo<ListView>(
    () => ({
      folder,
      messages: visible,
      loading: search ? search.loading : !current.loaded,
      error: search ? search.error : current.error,
      query: search ? search.query : null,
      canLoadMore,
      loadingMore: current.loadingMore || autoPaging,
      moreError: current.moreError,
      purged: search ? 0 : hidden.length,
      scanned: current.page.messages.length
    }),
    [
      autoPaging,
      canLoadMore,
      current.error,
      current.loaded,
      current.loadingMore,
      current.moreError,
      current.page.messages.length,
      folder,
      hidden.length,
      search,
      visible
    ]
  )

  return { stable, paneActions, onKeyDown, selectionActions, listActions, view }
}
