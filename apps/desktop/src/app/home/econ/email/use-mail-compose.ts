import type { Dispatch, RefObject, SetStateAction } from 'react'

import { number } from '../format'

import { type Flash } from './email-controls'
import {
  describeSendFailure,
  type Draft,
  EMPTY_DRAFT,
  findSent,
  hasDraft,
  mail,
  type Mailbox,
  type MailMessage,
  type MailScope,
  threadBrief
} from './email-data'
import { type PaneState } from './email-pane'
import {
  emptyTrash as emptyTrashMarks,
  type MailFolder,
  type MailMove,
  type MailState,
  moveMail,
  revertMarks,
  setRead
} from './email-state'
import { type ListState, type MailSession, type MarksChange, type SearchState } from './mail-shared'

const MOVED: Record<MailMove, string> = {
  archive: 'archived.',
  inbox: 'moved to Inbox.',
  purge: 'deleted forever.',
  recover: 'brought back.',
  restore: 'restored.',
  trash: 'moved to Trash.'
}

function messagesCopy(count: number): string {
  return count === 1 ? 'Message' : `${number(count)} messages`
}

export function useMailCompose({
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
}: {
  commit: (update: (state: MailState) => MailState) => MarksChange | null
  moveCursor: (id: null | string) => void
  requestFocus: (id: null | string) => void
  setFlash: Dispatch<SetStateAction<Flash | null>>
  session: RefObject<MailSession>
  serviceRows: (match: (row: MailMessage) => boolean) => MailMessage[]
  settle: (after: MailState, ids: readonly string[]) => void
  base: ListState
  spam: ListState
  setAdopted: Dispatch<SetStateAction<MailMessage[]>>
  say: (text: string, undo?: (() => void) | null) => void
  pane: PaneState | null
  visible: MailMessage[]
  closePane: (refocus?: boolean) => void
  picked: MailMessage[]
  selected: () => MailMessage | undefined
  search: SearchState | null
  folder: MailFolder
  setComposing: Dispatch<SetStateAction<boolean>>
  setDraft: Dispatch<SetStateAction<Draft>>
  selectedId: string | null
  scope: MailScope
  showFolder: (next: MailFolder) => void
  reload: (force?: boolean) => Promise<void>
  openMessage: (message: MailMessage, focusReply?: boolean) => void
  focusRoot: () => void
  ask: (brief: string) => void
  mailbox: Mailbox | null
}) {
  function undoMarks(before: MailState, ids: readonly string[]) {
    if (commit(state => revertMarks(state, before, ids))) {
      moveCursor(ids[0])
      requestFocus(ids[0])
    }

    setFlash(null)
  }

  function markRows(rows: readonly MailMessage[], read: boolean) {
    const ids = rows.map(row => row.id)
    const wanted = new Set(ids)
    const { opened } = session.current
    const service = serviceRows(row => wanted.has(row.id) && row.direction === 'inbound')

    // Asking for a thread reads it at the service, whether or not the answer
    // has landed (or was dropped when the pane moved on): an unread mark on it
    // is weighed against that, so the service's catching up never undoes it.
    const weighed = read
      ? service
      : service.map(row => (!row.isRead && opened.has(row.threadId) ? { ...row, isRead: true } : row))

    const change = commit(state => setRead(state, weighed, read, Date.now()))

    if (change) {
      // Mark read in Unread takes the rows out of it.
      settle(change.after, ids)
    }
  }

  function moveRows(move: MailMove, rows: readonly MailMessage[]) {
    const ids = rows.map(row => row.id)
    const change = ids.length > 0 ? commit(state => moveMail(state, move, ids, Date.now())) : null

    if (!change) {
      return
    }

    // A search result on no loaded page stays reachable in Archive and Trash.
    const onPages = new Set([...base.page.messages, ...spam.page.messages].map(message => message.id))
    const wanted = new Set(ids)
    const strays = serviceRows(row => wanted.has(row.id) && !onPages.has(row.id))

    if (strays.length > 0) {
      setAdopted(known => [...known.filter(row => !wanted.has(row.id)), ...strays])
    }

    settle(change.after, ids)

    const undo = move === 'purge' ? null : () => undoMarks(change.before, ids)

    say(`${messagesCopy(ids.length)} ${MOVED[move]}`, undo)
  }

  function emptyTrash() {
    const change = commit(state => emptyTrashMarks(state, Date.now()))

    if (change) {
      settle(change.after, [...change.before.trashed.keys()])
      say('Trash emptied.')
    }
  }

  /** The open thread's rows in this view (the message opened among them). */
  function paneRows(): MailMessage[] {
    const seed = pane?.seed

    if (!seed) {
      return []
    }

    const thread = visible.filter(message => message.threadId === seed.threadId)

    return thread.some(message => message.id === seed.id) ? thread : [seed, ...thread]
  }

  function paneMarkUnread() {
    const seed = pane?.seed

    if (seed) {
      markRows([seed], false)
      closePane()
    }
  }

  /** What E, #, ⇧I and ⇧U act on: the selection, else the open thread, else
   *  the row under the cursor. */
  function keyTargets(): MailMessage[] {
    if (picked.length > 0) {
      return picked
    }

    if (pane?.seed) {
      return paneRows()
    }

    const message = selected()

    return message ? [message] : []
  }

  function moveKey(move: MailMove) {
    // Trash has its own two moves, on the bar and in the pane.
    if (!search && folder === 'trash') {
      return
    }

    moveRows(move, keyTargets())
  }

  function markKey(read: boolean) {
    if (!read && picked.length === 0 && pane?.seed) {
      paneMarkUnread()

      return
    }

    markRows(keyTargets(), read)
  }

  // ── writes ────────────────────────────────────────────────────────────────

  function compose() {
    setComposing(true)
  }

  /** Write to someone from the thread: the draft's words are kept, the
   *  recipient becomes the person asked for. */
  function composeTo(address: string) {
    setDraft(current => ({ ...(hasDraft(current) ? current : EMPTY_DRAFT), to: address }))
    setComposing(true)
  }

  function closeCompose() {
    setComposing(false)
    requestFocus(selectedId)
  }

  function discardDraft() {
    setDraft(EMPTY_DRAFT)
    closeCompose()
  }

  async function sendDraft(sending: Draft): Promise<null | string> {
    const result = await mail.compose(scope, sending)

    if (!result.ok) {
      return describeSendFailure(result)
    }

    setDraft(EMPTY_DRAFT)
    setComposing(false)
    showFolder('sent')
    say(`Sent to ${sending.to.trim()}.`)

    await reload()

    const pageOne = session.current.pageOne?.page
    const sent = pageOne ? findSent(pageOne.messages, result.data, sending) : null

    if (sent) {
      openMessage(sent)
    } else {
      focusRoot()
    }

    return null
  }

  async function sendReply(threadId: string, body: string): Promise<null | string> {
    const result = await mail.reply(scope, threadId, body)

    if (!result.ok) {
      return describeSendFailure(result)
    }

    await reload()

    return null
  }

  // ── hand-offs ─────────────────────────────────────────────────────────────

  function askAboutThread({ id, subject }: { id: string; subject: string }) {
    const brief = threadBrief(id, subject)

    if (!brief) {
      say('This thread’s id can’t be handed to the agent.')

      return
    }

    ask(brief)
  }

  function askIntro() {
    ask(
      `introduce yourself by email. Draft a short introduction from ${mailbox?.address ?? 'your agent address'}, suggest who it should go to and why, ` +
        'and wait for my go-ahead before sending it with `acp email compose --to <address> --subject <subject> --body <text> --json`.'
    )
  }

  return {
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
  }
}
