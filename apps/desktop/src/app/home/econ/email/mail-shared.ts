/**
 * EconomyOS — Email. What the mail client and its hooks share: list and
 * search state, the folders read from the spam list, and row focus. The hooks
 * import these from here, never from email-app.
 */
import type { AcpFailure } from '../cli'

import { EMPTY_PAGE, type Mailbox, type MailMessage, type MailPage, type ServerFolder } from './email-data'
import { type MailFolder, type MailState } from './email-state'

export interface ListState {
  page: MailPage
  loaded: boolean
  /** Painted from the snapshot: the first live answer replaces it outright,
   *  and paging waits for it (the stored cursor may have expired). */
  hydrated: boolean
  error: AcpFailure | null
  loadingMore: boolean
  moreError: null | string
}

export interface SearchState {
  query: string
  messages: MailMessage[]
  loading: boolean
  error: AcpFailure | null
}

/** The email app's per-session scratch, written by handlers and read by later async work (email-app.tsx). */
export interface MailSession {
  folder: MailFolder
  query: null | string
  mailbox: Mailbox | null
  note: string | null
  /** The last live page one (`answer`, by identity) and what the snapshot stores of it (`page`: the same rows,
   *  with the previews a thread read rebuilt). */
  pageOne: null | { answer: MailPage; page: MailPage; at: number }
  /** A row (or the root, for null) to focus after the next commit. */
  focus: null | string | undefined
  /** The search box, to focus after the next commit (the bar hid it). */
  focusSearch: boolean
  /** A step past the last row, waiting for the next page to land. */
  step: null | { from: string; open: boolean }
  autoPaged: number
  /** A page in flight, per list: spam paging never blocks the inbox's. */
  paging: Record<ServerFolder, boolean>
  /** Where the cursor row stood, for a step after it left the view. */
  cursorIndex: null | number
  /** The row a shift-click extends from. */
  anchor: null | string
  flashSeq: number
  /** Threads opened this session — the service reads them when asked for. */
  opened: Set<string>
}

export const EMPTY_LIST: ListState = {
  page: EMPTY_PAGE,
  loaded: false,
  hydrated: false,
  error: null,
  loadingMore: false,
  moreError: null
}

// Folders drawn (partly) from the spam list — it is read when one opens.
export const WITH_SPAM = new Set<MailFolder>(['archive', 'spam', 'trash'])
export const NONE: ReadonlySet<string> = new Set()

export interface MarksChange {
  before: MailState
  after: MailState
}

/** Focus a list row (and bring it into view), or the app root when the row
 *  is not on screen — hidden behind the pane in a narrow window, focus on a
 *  row would fall to the page and the keys would stop reaching the app. */
export function focusMailRow(root: HTMLElement | null, id: null | string): void {
  const row = id ? root?.querySelector(`[data-mail-id="${CSS.escape(id)}"]`)?.closest('button') : null

  if (!row || (typeof row.checkVisibility === 'function' && !row.checkVisibility())) {
    root?.focus({ preventScroll: true })

    return
  }

  row.focus({ preventScroll: true })
  row.scrollIntoView({ block: 'nearest' })
}
