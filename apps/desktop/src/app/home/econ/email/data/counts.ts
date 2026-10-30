/** The email data module's `counts` section — its public names are re-exported by ../email-data.ts. */
import { setEconBadge } from '../../badges'
import { isUnread } from '../email-state'

import type { MailMessage, MailPage } from './types'

// ── counts ──────────────────────────────────────────────────────────────────
// Which rows each folder shows (with the owner's marks applied) is
// email-state's `folderRows`.

export function unreadCount(messages: readonly MailMessage[]): number {
  return messages.filter(isUnread).length
}

/** A rail count: `7+` when older pages may hold more of the same. */
export function countLabel(count: number, more: boolean): number | string {
  return count > 0 && more ? `${count}+` : count
}

/**
 * The dock tile's number for this iNFT: unread mail in the Inbox view of page
 * one — the CLI's own first page, with the owner's marks applied — whether a
 * prefetch or the open window publishes it, so paging older mail in never
 * moves the tile. The rail counts every loaded row.
 */
export function publishUnread(slug: string, pageOneInbox: readonly MailMessage[]): void {
  setEconBadge(slug, 'email', unreadCount(pageOneInbox))
}

/** The loaded rows that page one holds, as the list has them now (a thread
 *  opened since may have marked some read). */
export function onPageOne(rows: readonly MailMessage[], pageOne: MailPage | null): MailMessage[] {
  if (!pageOne) {
    return []
  }

  const ids = new Set(pageOne.messages.map(message => message.id))

  return rows.filter(message => ids.has(message.id))
}
