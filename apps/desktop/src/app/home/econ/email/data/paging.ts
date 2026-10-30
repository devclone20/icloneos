/** The email data module's `paging` section — its public names are re-exported by ../email-data.ts. */
import type { MailMessage } from './types'

// ── keyboard + paging ───────────────────────────────────────────────────────

/** Where a step of `delta` rows lands from the selected message. `edge` means
 *  the selection is already at that end (a step down may page in more).
 *  `formerIndex` is where the selected row stood when it left the view (read
 *  in Unread, moved to Archive): the step goes on from that slot, not from
 *  the top. */
export function stepFrom(
  messages: readonly MailMessage[],
  selectedId: null | string,
  delta: number,
  formerIndex: null | number = null
): { edge: boolean; index: number } | null {
  if (messages.length === 0) {
    return null
  }

  const index = selectedId ? messages.findIndex(message => message.id === selectedId) : -1

  if (index < 0 && selectedId && formerIndex !== null && formerIndex >= 0) {
    // The row that slid into the slot is the next one down.
    if (delta > 0) {
      return formerIndex < messages.length
        ? { index: formerIndex, edge: false }
        : { index: messages.length - 1, edge: true }
    }

    return { index: Math.min(Math.max(formerIndex - 1, 0), messages.length - 1), edge: false }
  }

  if (index < 0) {
    return { index: delta > 0 ? 0 : messages.length - 1, edge: false }
  }

  const next = index + delta

  return next < 0 || next >= messages.length ? { index, edge: true } : { index: next, edge: false }
}

/** The ids from `anchorId` to `targetId` inclusive, in view order — a
 *  shift-click's range — or null when either is not in view. */
export function checkRange(messages: readonly MailMessage[], anchorId: string, targetId: string): null | string[] {
  const from = messages.findIndex(message => message.id === anchorId)
  const to = messages.findIndex(message => message.id === targetId)

  if (from < 0 || to < 0) {
    return null
  }

  return messages.slice(Math.min(from, to), Math.max(from, to) + 1).map(message => message.id)
}

/** Where the cursor lands when `gone` leave the view: the first row after
 *  the cursor that stays, else the nearest one before it. */
export function neighborAfter(
  messages: readonly MailMessage[],
  gone: ReadonlySet<string>,
  cursorId: null | string
): null | string {
  const cursor = cursorId ? messages.findIndex(message => message.id === cursorId) : -1
  const start = cursor >= 0 ? cursor : messages.findIndex(message => gone.has(message.id))

  if (start < 0) {
    return null
  }

  const after = messages.slice(start).find(message => !gone.has(message.id))

  const before = messages
    .slice(0, start)
    .reverse()
    .find(message => !gone.has(message.id))

  return (after ?? before)?.id ?? null
}

/** Pages an empty view may fetch on its own before it asks the owner. */
export const AUTO_PAGE_LIMIT = 3

/** An empty view (Unread, Sent…) over a list with older pages looks further
 *  back by itself — a few pages, never after a failure, never while searching. */
export function shouldAutoPage(state: {
  visible: number
  searching: boolean
  canLoadMore: boolean
  loadingMore: boolean
  failed: boolean
  paged: number
}): boolean {
  return (
    state.visible === 0 &&
    !state.searching &&
    state.canLoadMore &&
    !state.loadingMore &&
    !state.failed &&
    state.paged < AUTO_PAGE_LIMIT
  )
}
