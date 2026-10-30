import type { Dispatch, RefObject, SetStateAction } from 'react'

import type { AcpFailure, AcpResult } from '../cli'
import { reportEconStatus, useAutoRefresh } from '../live'

import {
  adoptFresh,
  describeFailure,
  failureSummary,
  forgetThreads,
  mail,
  type Mailbox,
  type MailMessage,
  type MailPage,
  type MailScope,
  mergeOlder,
  mergeRefresh,
  needsSetup,
  nextMailbox,
  reconcileRead,
  sameMessage,
  samePreview,
  SEARCH_MAX,
  type ServerFolder,
  withReadablePreviews
} from './email-data'
import { type PaneState } from './email-pane'
import { type MailFolder } from './email-state'
import { EMPTY_LIST, type ListState, type MailSession, type SearchState, WITH_SPAM } from './mail-shared'

const EMPTY_THREAD: AcpFailure = { ok: false, kind: 'parse', error: 'The service returned an empty thread.' }

function sameFailure(a: AcpFailure | null, b: AcpFailure): boolean {
  return a !== null && a.kind === b.kind && a.error === b.error
}

/** Page one landing on a list: merged into what is loaded, or — right after a
 *  snapshot paint — taken as the truth. An unchanged answer keeps the state.
 *
 *  A failure never empties the list unless the owner asked (`force`, the
 *  header's refresh): the mount run and the timer keep the rows and the warn
 *  note with its "Open Setup" says why. Exported for the tests. */
export function withPageOne(state: ListState, result: AcpResult<MailPage>, force: boolean): ListState {
  if (!result.ok) {
    // A forced read that lands on a sign-in or provisioning state: rows from
    // disk must not sit over it — the list gives way so its Setup action shows.
    if (force && state.hydrated && needsSetup(result)) {
      return { ...EMPTY_LIST, loaded: true, error: result }
    }

    return state.loaded && sameFailure(state.error, result) ? state : { ...state, loaded: true, error: result }
  }

  const page = state.hydrated ? adoptFresh(state.page, result.data) : mergeRefresh(state.page, result.data)

  if (page === state.page && state.loaded && !state.hydrated && !state.error) {
    return state
  }

  return { ...state, page, loaded: true, hydrated: false, error: null }
}

function threadRows(page: MailPage, threadId: string): MailMessage[] {
  return page.messages.filter(message => message.threadId === threadId)
}

/** True when the fresh page holds a row of the thread that the previous one
 *  did not hold as it is — new (a reply) or changed in what the thread shows.
 *  Read state is not content: opening a thread marks its row read locally
 *  (`reconcileRead`) and a service that keeps it unread must not turn every
 *  tick into a thread read, nor may a preview rebuilt from the read body. */
export function threadChanged(before: MailMessage[], after: MailMessage[]): boolean {
  const known = new Map(before.map(message => [message.id, message]))

  return after.some(message => {
    const previous = known.get(message.id)

    if (!previous) {
      return true
    }

    // A preview rebuilt from the read body is the same row as the flattened one a refresh brings.
    const preview = samePreview(previous.preview, message.preview) ? message.preview : previous.preview

    return !sameMessage({ ...previous, isRead: message.isRead, preview }, message)
  })
}

export function useMailbox({
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
}: {
  scope: MailScope
  setList: (target: ServerFolder, update: (state: ListState) => ListState) => void
  session: RefObject<MailSession>
  persistNow: () => void
  clear: () => void
  setMailbox: Dispatch<SetStateAction<Mailbox | null>>
  setMailboxNote: Dispatch<SetStateAction<string | null>>
  paneIdRef: RefObject<string | null>
  setPane: Dispatch<SetStateAction<PaneState | null>>
  setBase: Dispatch<SetStateAction<ListState>>
  searchSeqRef: RefObject<number>
  setSearch: Dispatch<SetStateAction<SearchState | null>>
  slug: string
  inftId: string
  refreshKey: number
  search: SearchState | null
  folder: MailFolder
  spam: ListState
  base: ListState
  current: ListState
  rootRef: RefObject<HTMLDivElement | null>
}) {
  async function fetchList(target: ServerFolder, force: boolean): Promise<AcpResult<MailPage>> {
    const result = await mail.inbox(scope, target, null, { force })

    setList(target, state => withPageOne(state, result, force))

    if (target !== 'inbox') {
      return result
    }

    if (result.ok) {
      // "new mail Ns ago": a live page that brings an id the live page on
      // screen does not hold (rows from disk are no baseline).
      if (base.loaded && !base.hydrated) {
        const known = new Set(base.page.messages.map(message => message.id))

        if (result.data.messages.some(message => !known.has(message.id))) {
          reportEconStatus('email', slug, { changedAt: Date.now() })
        }
      }

      const previous = session.current.pageOne

      if (previous?.answer !== result.data) {
        // A new answer carries the flattened previews again: the ones a thread read rebuilt stay on disk.
        const known = previous ? previous.page.messages : base.page.messages

        session.current.pageOne = { answer: result.data, page: withReadablePreviews(result.data, known), at: result.at }
        persistNow()
      }
    } else if (force && needsSetup(result)) {
      // Signed out or deprovisioned, as a read the owner asked for says:
      // nothing of this mailbox repaints from disk. A timer tick's state may
      // be a transient 401 — the saved mail survives it.
      session.current.pageOne = null
      forgetThreads(slug)
      clear()
    }

    return result
  }

  async function loadMailbox(force: boolean): Promise<void> {
    const known = session.current.mailbox
    // The address never changes under an agent: a manual refresh re-asks only
    // while there is none to show.
    const result = await mail.whoami(scope, { force: force && !known })
    const next = nextMailbox(result, session.current.mailbox)

    session.current.mailbox = next.mailbox
    session.current.note = next.note
    setMailbox(next.mailbox)
    setMailboxNote(next.note)

    if (result.ok && next.mailbox !== known) {
      persistNow()
    }
  }

  /** `urgent`: the owner opened it — the read goes ahead of the queued ticks. */
  async function fetchThread(threadId: string, force: boolean, urgent = false): Promise<void> {
    const result = await mail.thread(scope, threadId, { force, urgent })

    if (paneIdRef.current !== threadId) {
      return
    }

    const thread = result.ok ? result.data : null
    const error = result.ok ? (thread ? null : EMPTY_THREAD) : result

    // The memo keeps an equal answer's object (data/calls.ts): a reconcile that changed nothing renders nothing.
    setPane(current => {
      if (current?.threadId !== threadId) {
        return current
      }

      const next = thread ?? current.thread

      return next === current.thread && error === current.error && !current.loading
        ? current
        : { ...current, thread: next, error, loading: false }
    })

    if (thread) {
      setBase(state => {
        const page = reconcileRead(state.page, thread)

        return page === state.page ? state : { ...state, page }
      })

      // A restart paints the rebuilt previews too: the snapshot stores page one.
      const pageOne = session.current.pageOne
      const stored = pageOne ? reconcileRead(pageOne.page, thread) : null

      if (pageOne && stored && stored !== pageOne.page) {
        session.current.pageOne = { ...pageOne, page: stored }
        persistNow()
      }
    }
  }

  async function runSearch(text: string, force = false): Promise<void> {
    const seq = ++searchSeqRef.current
    const trimmed = text.trim().slice(0, SEARCH_MAX)

    if (!trimmed) {
      session.current.query = null
      setSearch(null)

      return
    }

    session.current.query = trimmed
    session.current.step = null
    setSearch(current => ({
      query: trimmed,
      messages: current?.query === trimmed ? current.messages : [],
      loading: true,
      error: null
    }))
    const result = await mail.search(scope, trimmed, { force })

    if (seq !== searchSeqRef.current) {
      return
    }

    setSearch(current => ({
      query: trimmed,
      messages: result.ok ? result.data : (current?.messages ?? []),
      loading: false,
      error: result.ok ? null : result
    }))
  }

  /** Everything the window shows: the list first (it paints), then the open
   *  thread (what the owner is reading), spam when a folder draws on it, and
   *  the address last — the CLI runs them one at a time, in this order. */
  async function refreshAll(force: boolean): Promise<AcpResult<MailPage>> {
    // The open thread's rows before this read: a timer tick re-reads the
    // thread only when one of them is new or changed (a reply is a new row).
    const openId = paneIdRef.current
    const before = openId ? threadRows(base.page, openId) : []
    const result = await fetchList('inbox', force)
    const following: Array<Promise<unknown>> = []

    if (openId && paneIdRef.current === openId) {
      if (force || (result.ok && threadChanged(before, threadRows(result.data, openId)))) {
        following.push(fetchThread(openId, force))
      }
    }

    if (WITH_SPAM.has(session.current.folder)) {
      following.push(fetchList('spam', force))
    }

    void loadMailbox(force)
    await Promise.all(following)

    return result
  }

  const { reload } = useAutoRefresh(
    'email',
    slug,
    async ({ force }) => {
      const searchSeq = searchSeqRef.current
      const result = await refreshAll(force)
      const query = session.current.query

      // A manual refresh re-asks the open search too (unless the owner changed
      // or cleared it meanwhile); the timer leaves it be.
      if (force && query && searchSeq === searchSeqRef.current) {
        await runSearch(query, true)
      }

      if (!result.ok) {
        throw new Error(failureSummary(result))
      }
    },
    [inftId],
    refreshKey
  )

  /** Retry what failed: the search, or the folder's list (skeleton first
   *  when there is nothing on screen to keep). */
  function retryList() {
    if (search) {
      void runSearch(search.query, true)

      return
    }

    setList(folder === 'spam' ? 'spam' : 'inbox', state =>
      state.page.messages.length > 0 ? state : { ...state, loaded: false, error: null }
    )
    void reload()
  }

  function retryThread(threadId: string) {
    setPane(current => (current?.threadId === threadId ? { ...current, error: null, loading: true } : current))
    void fetchThread(threadId, true, true)
  }

  /** The next older page of the folder's list. `auto` spends the empty
   *  view's paging budget. False when no page was started. */
  async function loadMore(auto = false): Promise<boolean> {
    const target: ServerFolder = session.current.folder === 'spam' ? 'spam' : 'inbox'
    const state = target === 'spam' ? spam : base
    const cursor = state.page.nextCursor
    const { paging } = session.current

    if (!cursor || state.loadingMore || state.hydrated || paging[target]) {
      return false
    }

    paging[target] = true

    if (auto) {
      session.current.autoPaged += 1
    }

    setList(target, current => ({ ...current, loadingMore: true, moreError: null }))
    const result = await mail.inbox(scope, target, cursor)

    paging[target] = false
    setList(target, current =>
      result.ok
        ? { ...current, loadingMore: false, page: mergeOlder(current.page, result.data) }
        : { ...current, loadingMore: false, moreError: describeFailure(result, 'older mail').title }
    )

    return true
  }

  /** The end of the list scrolled within reach. After a failed page only
   *  the owner's "Try again" pages — never the scroll. */
  function pageNearEnd() {
    if (!current.moreError) {
      void loadMore()
    }
  }

  // ── focus ─────────────────────────────────────────────────────────────────

  function requestFocus(id: null | string) {
    session.current.focus = id
  }

  function focusRoot() {
    rootRef.current?.focus({ preventScroll: true })
  }

  function focusSearchBox() {
    const input = rootRef.current?.querySelector<HTMLInputElement>('.e-search')

    input?.focus()
    input?.select()
  }

  return {
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
  }
}
