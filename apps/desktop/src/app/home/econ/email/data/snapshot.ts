/** The email data module's `snapshot` section — its public names are re-exported by ../email-data.ts. */
import { asRecord } from '../../cli'
import { readSnapshot, type Snapshot } from '../../snapshot'
import { newestFirst } from '../email-state'

import { NO_ADDRESS } from './mailbox'
import {
  type MailAddress,
  type Mailbox,
  type MailDirection,
  type MailMessage,
  type MailPage,
  type MailSafety,
  PAGE_SIZE
} from './types'

// ── snapshot ────────────────────────────────────────────────────────────────

/** Bump when `EmailSnapshot` (or `MailMessage`) changes shape. */
export const EMAIL_SNAPSHOT_VERSION = 1

/** Page one as the list shows it — previews only, never a body, a draft, a
 *  search or spam. */
export interface EmailSnapshot {
  base: MailPage
  mailbox: Mailbox | null
  mailboxNote: null | string
}

// A 4–8 digit run is how one-time codes (sign-in, 3DS) arrive; they live
// minutes and must never reach disk. Years and order numbers go with them —
// the live answer replaces the snapshot within seconds anyway.
const CODE_RUN = /(?<!\d)\d{4,8}(?!\d)/g
const CODE_MASK = '••••'

export function redactCodes(text: string): string {
  return text.replace(CODE_RUN, CODE_MASK)
}

function storable(message: MailMessage): MailMessage {
  return { ...message, subject: redactCodes(message.subject), preview: redactCodes(message.preview) }
}

export function snapshotOf(page: MailPage, mailbox: Mailbox | null, note: null | string): EmailSnapshot {
  return {
    base: { messages: page.messages.slice(0, PAGE_SIZE).map(storable), nextCursor: page.nextCursor },
    mailbox,
    // Only the lasting state is restored — a failure note would be stale.
    mailboxNote: !mailbox && note === NO_ADDRESS ? note : null
  }
}

const DIRECTIONS = new Set<string>(['inbound', 'outbound'])
const SAFETIES = new Set<string>(['clean', 'flagged', 'spam', 'unscanned'])

function storedAddress(value: unknown): MailAddress | null {
  const record = asRecord(value)

  return record && typeof record.name === 'string' && typeof record.address === 'string'
    ? { name: record.name, address: record.address }
    : null
}

/** One stored row, rebuilt field by field — storage is outside the app, so
 *  nothing but a well-formed row gets back in. */
function storedMessage(value: unknown): MailMessage | null {
  const record = asRecord(value)
  const from = storedAddress(record?.from)
  const to = Array.isArray(record?.to) ? record.to.map(storedAddress) : null

  if (
    !record ||
    !from ||
    !to ||
    to.some(address => address === null) ||
    typeof record.id !== 'string' ||
    !record.id ||
    typeof record.threadId !== 'string' ||
    !DIRECTIONS.has(String(record.direction)) ||
    typeof record.subject !== 'string' ||
    typeof record.preview !== 'string' ||
    typeof record.isRead !== 'boolean' ||
    typeof record.receivedAt !== 'string' ||
    typeof record.at !== 'number' ||
    !Number.isFinite(record.at) ||
    typeof record.attachments !== 'number' ||
    !SAFETIES.has(String(record.safety))
  ) {
    return null
  }

  return {
    id: record.id,
    threadId: record.threadId,
    direction: record.direction as MailDirection,
    from,
    to: to as MailAddress[],
    subject: record.subject,
    preview: record.preview,
    isRead: record.isRead,
    receivedAt: record.receivedAt,
    at: record.at,
    attachments: record.attachments,
    safety: record.safety as MailSafety
  }
}

/** A stored snapshot back into app state, or null when it is not one. */
export function restoreSnapshot(raw: unknown): EmailSnapshot | null {
  const root = asRecord(raw)
  const base = asRecord(root?.base)

  if (!root || !base || !Array.isArray(base.messages)) {
    return null
  }

  const messages = base.messages
    .map(storedMessage)
    .filter((message): message is MailMessage => message !== null)
    .slice(0, PAGE_SIZE)

  const mailbox = asRecord(root.mailbox)
  const address = typeof mailbox?.address === 'string' ? mailbox.address : ''

  return {
    base: {
      messages: newestFirst(messages),
      nextCursor: typeof base.nextCursor === 'string' && base.nextCursor ? base.nextCursor : null
    },
    mailbox: address ? { address, status: typeof mailbox?.status === 'string' ? mailbox.status : '' } : null,
    mailboxNote: !address && root.mailboxNote === NO_ADDRESS ? NO_ADDRESS : null
  }
}

/** The stored snapshot, rebuilt, with the time of the load it came from. */
export function readMailSnapshot(slug: string): Snapshot<EmailSnapshot> | null {
  const stored = readSnapshot<unknown>('email', slug, EMAIL_SNAPSHOT_VERSION)
  const data = stored ? restoreSnapshot(stored.data) : null

  return stored && data ? { data, at: stored.at } : null
}
