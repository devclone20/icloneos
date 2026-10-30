/** The email data module's `shapers` section — its public names are re-exported by ../email-data.ts. */
import { asArray, asRecord, bool, type Json, listAt, num, str } from '../../cli'
import { newestFirst } from '../email-state'
import { cleanPreview, htmlToText } from '../email-text'

import { recipients, sender } from './addresses'
import {
  type MailAddress,
  type MailAttachment,
  type Mailbox,
  type MailDirection,
  type MailMessage,
  type MailPage,
  type MailSafety,
  type MailThread,
  type SendReceipt,
  type ThreadMessage,
  UNSCANNED
} from './types'

// ── shapers ─────────────────────────────────────────────────────────────────

function safetyOf(record: Json): MailSafety {
  if (str(record, 'spamLabel').toLowerCase() === 'spam') {
    return 'spam'
  }

  const scan = str(record, 'scanStatus').toLowerCase()

  if (!scan || scan === 'clean') {
    return 'clean'
  }

  return UNSCANNED.has(scan) ? 'unscanned' : 'flagged'
}

function directionOf(record: Json): MailDirection {
  return str(record, 'direction').toLowerCase() === 'outbound' ? 'outbound' : 'inbound'
}

function dateOf(record: Json): { at: number; receivedAt: string } {
  const receivedAt = str(record, 'receivedAt') || str(record, 'sentAt') || str(record, 'createdAt')
  const at = Date.parse(receivedAt)

  return { at: Number.isFinite(at) ? at : 0, receivedAt }
}

export function shapeMessage(raw: unknown): MailMessage | null {
  const record = asRecord(raw)
  const id = str(record, 'id')

  if (!record || !id) {
    return null
  }

  const direction = directionOf(record)
  const counted = num(asRecord(record._count), 'attachments', -1)

  return {
    id,
    threadId: str(record, 'threadId'),
    direction,
    from: sender(record),
    to: recipients(record),
    subject: str(record, 'subject').trim(),
    // A real body when the record carries one: the provider's bodyPreview has lost its line breaks.
    preview: cleanPreview(bodyText(record).text),
    isRead: bool(record, 'isRead', direction === 'outbound'),
    ...dateOf(record),
    attachments: counted >= 0 ? counted : asArray(record.attachments).length,
    safety: safetyOf(record)
  }
}

function shapeList(raw: unknown, keys: string[]): MailMessage[] {
  return listAt(raw, keys)
    .map(shapeMessage)
    .filter((message): message is MailMessage => message !== null)
}

export function shapeInbox(raw: unknown): MailPage {
  const cursor = str(asRecord(raw), 'nextCursor')

  return { messages: newestFirst(shapeList(raw, ['messages', 'items', 'data'])), nextCursor: cursor || null }
}

/** Search results keep the service's relevance order. */
export function shapeSearch(raw: unknown): MailMessage[] {
  return shapeList(raw, ['messages', 'results'])
}

function shapeAttachment(raw: unknown): MailAttachment | null {
  const record = asRecord(raw)

  if (!record) {
    return null
  }

  return {
    name: str(record, 'filename') || str(record, 'fileName') || str(record, 'name') || 'attachment',
    size: num(record, 'size', num(record, 'sizeBytes')),
    type: str(record, 'contentType') || str(record, 'mimeType')
  }
}

/** The body as text: the text part, else text extracted from the HTML part —
 *  never the HTML itself. */
export function bodyText(record: Json): { fromHtml: boolean; text: string } {
  const body = asRecord(record.body)
  const text = str(record, 'textBody') || str(body, 'textBody') || str(body, 'textNormalized')

  if (text.trim()) {
    return { fromHtml: false, text }
  }

  const html = str(record, 'htmlBody') || str(body, 'htmlBody')

  if (html.trim()) {
    return { fromHtml: true, text: htmlToText(html) }
  }

  return { fromHtml: false, text: str(record, 'bodyPreview') || str(record, 'preview') }
}

export function shapeThreadMessage(raw: unknown): ThreadMessage | null {
  const record = asRecord(raw)
  const id = str(record, 'id')

  if (!record || !id) {
    return null
  }

  const direction = directionOf(record)

  const attachments = asArray(record.attachments)
    .map(shapeAttachment)
    .filter((item): item is MailAttachment => item !== null)

  return {
    id,
    direction,
    from: sender(record),
    to: recipients(record),
    subject: str(record, 'subject').trim(),
    ...dateOf(record),
    isRead: bool(record, 'isRead', direction === 'outbound'),
    attachments,
    attachmentCount: Math.max(attachments.length, num(asRecord(record._count), 'attachments')),
    ...bodyText(record),
    safety: safetyOf(record)
  }
}

function uniqueAddresses(addresses: MailAddress[]): MailAddress[] {
  const seen = new Map<string, MailAddress>()

  for (const address of addresses) {
    const key = address.address.toLowerCase()
    const known = seen.get(key)

    if (key && (!known || (!known.name && address.name))) {
      seen.set(key, address)
    }
  }

  return [...seen.values()]
}

export function shapeThread(raw: unknown): MailThread | null {
  const root = asRecord(raw)

  if (!root) {
    return null
  }

  const messages = listAt(root, ['messages'])
    .map(shapeThreadMessage)
    .filter((message): message is ThreadMessage => message !== null)
    .sort((a, b) => a.at - b.at)

  const id = str(root, 'id')

  if (!id && messages.length === 0) {
    return null
  }

  const last = messages.at(-1)

  return {
    id,
    subject: (str(root, 'subject') || str(root, 'subjectNormal') || last?.subject || '').trim(),
    counterpart: str(root, 'externalFrom'),
    participants: uniqueAddresses(messages.flatMap(message => [message.from, ...message.to])),
    messages,
    lastMessageAt: str(root, 'lastMessageAt') || last?.receivedAt || ''
  }
}

export function shapeMailbox(raw: unknown): Mailbox | null {
  const root = asRecord(raw)
  const address = str(root, 'emailAddress') || str(root, 'address')

  return address ? { address, status: str(root, 'status') } : null
}

export function shapeReceipt(raw: unknown): SendReceipt {
  const root = asRecord(raw)
  const message = asRecord(root?.message) ?? asRecord(root?.data)

  return {
    messageId: str(root, 'messageId') || str(message, 'id') || str(root, 'id'),
    threadId: str(root, 'threadId') || str(message, 'threadId') || str(asRecord(root?.thread), 'id')
  }
}
