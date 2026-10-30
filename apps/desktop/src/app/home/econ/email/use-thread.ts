import type { Dispatch, RefObject, SetStateAction } from 'react'

import { checkRange, type MailMessage, type MailThread, neighborAfter, stepFrom } from './email-data'
import { type CheckMode } from './email-list'
import { type PaneState } from './email-pane'
import { folderRows, type MailFolder, type MailPools, type MailState, searchRows, setRead } from './email-state'
import { focusMailRow, type ListState, type MailSession, type MarksChange, NONE, type SearchState } from './mail-shared'

export function useThread({
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
  lastThread,
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
}: {
  moveCursor: (id: null | string) => void
  say: (text: string, undo?: (() => void) | null) => void
  serviceRows: (match: (row: MailMessage) => boolean) => MailMessage[]
  commit: (update: (state: MailState) => MailState) => MarksChange | null
  session: RefObject<MailSession>
  setComposing: Dispatch<SetStateAction<boolean>>
  paneIdRef: RefObject<string | null>
  setPane: Dispatch<SetStateAction<PaneState | null>>
  requestFocus: (id: null | string) => void
  setReplyFocusFor: Dispatch<SetStateAction<string | null>>
  fetchThread: (threadId: string, force: boolean, urgent?: boolean) => Promise<void>
  /** The last answer for a thread, however old: a re-open paints it at once. */
  lastThread: (threadId: string) => MailThread | null
  rootRef: RefObject<HTMLDivElement | null>
  visible: MailMessage[]
  selectedId: string | null
  canLoadMore: boolean
  current: ListState
  loadMore: (auto?: boolean) => Promise<boolean>
  pane: PaneState | null
  pickedIds: ReadonlySet<string>
  setChecked: Dispatch<SetStateAction<ReadonlySet<string>>>
  picked: MailMessage[]
  checked: ReadonlySet<string>
  search: SearchState | null
  pools: MailPools<MailMessage>
  folder: MailFolder
  closePane: (refocus?: boolean) => void
  setSelectedId: Dispatch<SetStateAction<string | null>>
}) {
  function openMessage(message: MailMessage, focusReply = false) {
    moveCursor(message.id)

    if (!message.threadId) {
      say('This message has no thread id, so it can’t be opened.')

      return
    }

    // Read now, not when the thread answers: the dot, the counts and the dock
    // tile move in this frame. The whole thread is read — it all shows.
    const thread = serviceRows(
      row => row.id === message.id || (row.threadId === message.threadId && row.direction === 'inbound')
    )

    commit(state => setRead(state, thread, true, Date.now()))
    session.current.opened.add(message.threadId)

    setComposing(false)
    paneIdRef.current = message.threadId
    const remembered = lastThread(message.threadId)

    setPane(current =>
      current?.threadId === message.threadId
        ? { ...current, seed: message }
        : { threadId: message.threadId, seed: message, thread: remembered, error: null, loading: !remembered }
    )
    requestFocus(message.id)

    if (focusReply) {
      setReplyFocusFor(message.threadId)
    }

    void fetchThread(message.threadId, false, true)
  }

  /** Select a row, or — with `open` — read it in the pane. */
  function go(message: MailMessage, open: boolean) {
    if (open) {
      openMessage(message)

      return
    }

    moveCursor(message.id)
    focusMailRow(rootRef.current, message.id)
  }

  function step(delta: number, open: boolean) {
    const target = stepFrom(visible, selectedId, delta, session.current.cursorIndex)

    if (!target) {
      return
    }

    if (!target.edge) {
      go(visible[target.index], open)

      return
    }

    // Past the last row: page in the next one, then take the step — or drop
    // the intent at once when no page starts, so no later change takes it.
    if (delta > 0 && canLoadMore && !current.loadingMore) {
      const pending = { from: visible[target.index].id, open }

      session.current.step = pending
      void loadMore().then(started => {
        if (!started && session.current.step === pending) {
          session.current.step = null
        }
      })
    }
  }

  function selected(): MailMessage | undefined {
    return visible.find(message => message.id === selectedId)
  }

  function replyShortcut() {
    if (pane?.thread) {
      setReplyFocusFor(pane.threadId)

      return
    }

    const message = selected()

    if (message) {
      openMessage(message, true)
    }
  }

  // ── selection ─────────────────────────────────────────────────────────────

  /** A box (or a modified click on a row): toggle one, or check a range from
   *  the last one checked (the cursor when none was). */
  function check(message: MailMessage, mode: CheckMode) {
    const anchor = session.current.anchor ?? selectedId
    const range = mode === 'range' && anchor ? checkRange(visible, anchor, message.id) : null
    // Built from what is in view: nothing checked out of sight rides along.
    const next = new Set(pickedIds)

    if (range) {
      range.forEach(id => next.add(id))
    } else if (next.has(message.id)) {
      next.delete(message.id)
    } else {
      next.add(message.id)
    }

    session.current.anchor = message.id
    setChecked(next.size === 0 ? NONE : next)
  }

  /** X: the row that holds focus, else the cursor row. */
  function toggleFocused(target: HTMLElement) {
    const id = target.closest<HTMLElement>('[data-mail-item]')?.dataset.mailItem ?? selectedId
    const message = visible.find(row => row.id === id)

    if (message) {
      check(message, 'toggle')
    }
  }

  function toggleAll() {
    session.current.anchor = null
    setChecked(picked.length === visible.length ? NONE : new Set(visible.map(message => message.id)))
  }

  function clearChecked(refocus = true) {
    session.current.anchor = null
    setChecked(NONE)

    // The bar that may hold focus is about to go; the keys stay live.
    if (refocus && checked.size > 0) {
      requestFocus(selectedId)
    }
  }

  // ── the owner's marks ─────────────────────────────────────────────────────

  /** After a change, tidy what left the view: its boxes, an open thread of
   *  it, and the cursor — which moves on to the next row that stays. */
  function settle(after: MailState, ids: readonly string[]) {
    const next = search ? searchRows(after, search.messages) : folderRows(after, pools, folder)
    const stays = new Set(next.map(message => message.id))
    const gone = new Set(ids.filter(id => !stays.has(id)))

    if (gone.size === 0) {
      return
    }

    setChecked(current => {
      const kept = [...current].filter(id => !gone.has(id))

      return kept.length === current.size ? current : kept.length === 0 ? NONE : new Set(kept)
    })

    if (pane?.seed && gone.has(pane.seed.id)) {
      closePane(false)
    }

    const cursor = selectedId && stays.has(selectedId) ? selectedId : neighborAfter(visible, gone, selectedId)

    session.current.cursorIndex = cursor ? next.findIndex(message => message.id === cursor) : null
    setSelectedId(cursor)
    // The control pressed may have gone with the rows; the keys stay live.
    requestFocus(cursor)
  }

  return { clearChecked, settle, selected, openMessage, check, go, toggleAll, step, replyShortcut, toggleFocused }
}
