/** The email data module's `merges` section — its public names are re-exported by ../email-data.ts. */
import { newestFirst } from '../email-state'
import { cleanPreview } from '../email-text'

import type { Draft, MailAddress, MailMessage, MailPage, MailThread, SendReceipt } from './types'

// ── paging merges ───────────────────────────────────────────────────────────

function sameMailAddress(a: MailAddress, b: MailAddress): boolean {
  return a.name === b.name && a.address === b.address
}

/** Every field a row shows — equal means the row need not render again. */
export function sameMessage(a: MailMessage, b: MailMessage): boolean {
  return (
    a === b ||
    (a.id === b.id &&
      a.threadId === b.threadId &&
      a.direction === b.direction &&
      a.subject === b.subject &&
      a.preview === b.preview &&
      a.isRead === b.isRead &&
      a.receivedAt === b.receivedAt &&
      a.at === b.at &&
      a.attachments === b.attachments &&
      a.safety === b.safety &&
      sameMailAddress(a.from, b.from) &&
      a.to.length === b.to.length &&
      a.to.every((address, index) => sameMailAddress(address, b.to[index])))
  )
}

/** The fresh rows, each replaced by the loaded object when nothing changed. */
function reuseRows(current: MailMessage[], fresh: MailMessage[]): MailMessage[] {
  if (current.length === 0) {
    return fresh
  }

  const known = new Map(current.map(message => [message.id, message]))

  return fresh.map(message => {
    const loaded = known.get(message.id)

    if (!loaded) {
      return message
    }

    // A refresh carries the flattened preview again: the rebuilt one stays.
    const preview = readablePreview(message.preview, loaded.preview)
    const next = preview === message.preview ? message : { ...message, preview }

    return sameMessage(loaded, next) ? loaded : next
  })
}

function samePage(a: MailPage, b: MailPage): boolean {
  return (
    a.nextCursor === b.nextCursor &&
    a.messages.length === b.messages.length &&
    a.messages.every((message, index) => message === b.messages[index])
  )
}

/** A timer re-read of page one, merged into what is already loaded: fresh
 *  rows win, older pages the owner paged into are kept with their cursor.
 *  An answer that changed nothing returns `current` itself. */
export function mergeRefresh(current: MailPage, fresh: MailPage): MailPage {
  if (current.messages.length === 0 || fresh.messages.length === 0) {
    return fresh
  }

  const rows = reuseRows(current.messages, fresh.messages)
  const ids = new Set(rows.map(message => message.id))
  // Undated rows (at 0) say nothing about where page one ends: one of them
  // must not drop every paged-in row and the cursor with it.
  const dated = rows.filter(message => message.at > 0)
  const cutoff = dated.length > 0 ? Math.min(...dated.map(message => message.at)) : Infinity
  const kept = current.messages.filter(message => !ids.has(message.id) && (message.at < cutoff || message.at === 0))

  const next: MailPage = {
    messages: kept.length > 0 ? newestFirst([...rows, ...kept]) : rows,
    nextCursor: kept.length > 0 ? current.nextCursor : fresh.nextCursor
  }

  return samePage(current, next) ? current : next
}

/** The first live answer after painting from a snapshot: the answer is the
 *  truth (the snapshot's cursor and older rows may be stale), but unchanged
 *  rows keep their objects so they do not render again. */
export function adoptFresh(current: MailPage, fresh: MailPage): MailPage {
  const next: MailPage = { messages: reuseRows(current.messages, fresh.messages), nextCursor: fresh.nextCursor }

  return samePage(current, next) ? current : next
}

/** "Load more": append an older page, dropping rows already on screen. */
export function mergeOlder(current: MailPage, older: MailPage): MailPage {
  const ids = new Set(current.messages.map(message => message.id))

  return {
    messages: newestFirst([...current.messages, ...older.messages.filter(message => !ids.has(message.id))]),
    nextCursor: older.nextCursor
  }
}

/** The provider's `bodyPreview` drops the line breaks between lines ('Pat
 *  RBest Regards'); a preview built from the read body keeps them. The same
 *  words once every separator is ignored are the same preview (a preview cut
 *  at its length ends in an ellipsis: the other need only start with the rest). */
export function samePreview(a: string, b: string): boolean {
  if (a === b) {
    return true
  }

  const left = a.replace(/\s+/g, '')
  const right = b.replace(/\s+/g, '')
  const [short, long] = left.length <= right.length ? [left, right] : [right, left]

  if (short === long) {
    return short.length > 0
  }

  return short.length > 1 && short.endsWith('\u2026') && long.startsWith(short.slice(0, -1))
}

function separators(text: string): number {
  return text.match(/\s/g)?.length ?? 0
}

function readablePreview(current: string, candidate: string): string {
  return candidate !== current && samePreview(current, candidate) && separators(candidate) > separators(current)
    ? candidate
    : current
}

/** Page one as the service sent it, with the previews a thread read rebuilt
 *  (reconcileRead) taken back from `known` — what the snapshot stores, so a
 *  restart paints the readable preview again. `fresh` itself when none applies. */
export function withReadablePreviews(fresh: MailPage, known: readonly MailMessage[]): MailPage {
  if (known.length === 0) {
    return fresh
  }

  const previews = new Map(known.map(message => [message.id, message.preview]))
  let changed = false

  const messages = fresh.messages.map(message => {
    const stored = previews.get(message.id)
    const preview = stored === undefined ? message.preview : readablePreview(message.preview, stored)

    if (preview === message.preview) {
      return message
    }

    changed = true

    return { ...message, preview }
  })

  return changed ? { ...fresh, messages } : fresh
}

/** An opened thread mirrors its read state into the list, and its bodies
 *  rebuild the rows' flattened previews. */
export function reconcileRead(page: MailPage, thread: MailThread): MailPage {
  const read = new Set(thread.messages.filter(message => message.isRead).map(message => message.id))
  const bodies = new Map(thread.messages.filter(message => message.text).map(message => [message.id, message.text]))
  let changed = false

  const messages = page.messages.map(message => {
    const body = bodies.get(message.id)
    const preview = body === undefined ? message.preview : readablePreview(message.preview, cleanPreview(body))
    const isRead = message.isRead || read.has(message.id)

    if (isRead === message.isRead && preview === message.preview) {
      return message
    }

    changed = true

    return { ...message, isRead, preview }
  })

  return changed ? { ...page, messages } : page
}

/** The outbound row a compose just produced: by id, else by thread, else by
 *  recipient + subject — newest wins. */
export function findSent(messages: MailMessage[], receipt: SendReceipt, draft: Draft): MailMessage | null {
  const byId = receipt.messageId ? messages.find(message => message.id === receipt.messageId) : undefined

  if (byId) {
    return byId
  }

  const to = draft.to.trim().toLowerCase()
  const subject = draft.subject.trim()

  const candidates = messages.filter(message => {
    if (message.direction !== 'outbound') {
      return false
    }

    if (receipt.threadId) {
      return message.threadId === receipt.threadId
    }

    return message.subject === subject && message.to.some(address => address.address.toLowerCase() === to)
  })

  return newestFirst(candidates)[0] ?? null
}
