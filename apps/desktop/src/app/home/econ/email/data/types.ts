/** The email data module's `types` section — its public names are re-exported by ../email-data.ts. */
// ── types ───────────────────────────────────────────────────────────────────

export type ServerFolder = 'inbox' | 'spam'
export type MailDirection = 'inbound' | 'outbound'
/** `clean` is the only state whose links open; everything else shows them as text. */
export type MailSafety = 'clean' | 'flagged' | 'spam' | 'unscanned'

export interface MailAddress {
  name: string
  address: string
}

export interface MailMessage {
  id: string
  threadId: string
  direction: MailDirection
  from: MailAddress
  to: MailAddress[]
  subject: string
  preview: string
  isRead: boolean
  receivedAt: string
  /** Epoch ms of `receivedAt`; 0 when the service sent no usable date. */
  at: number
  attachments: number
  safety: MailSafety
}

export interface MailPage {
  messages: MailMessage[]
  nextCursor: null | string
}

export interface MailAttachment {
  name: string
  size: number
  type: string
}

export interface ThreadMessage {
  id: string
  direction: MailDirection
  from: MailAddress
  to: MailAddress[]
  subject: string
  receivedAt: string
  at: number
  isRead: boolean
  attachments: MailAttachment[]
  attachmentCount: number
  /** Always plain text. */
  text: string
  /** The text was extracted from `htmlBody` because no text part existed. */
  fromHtml: boolean
  safety: MailSafety
}

export interface MailThread {
  id: string
  subject: string
  /** The outside party (`externalFrom`), when the service names one. */
  counterpart: string
  participants: MailAddress[]
  messages: ThreadMessage[]
  lastMessageAt: string
}

export interface Mailbox {
  address: string
  status: string
}

export interface SendReceipt {
  messageId: string
  threadId: string
}

export interface DayGroup {
  key: string
  label: string
  messages: MailMessage[]
}

export interface Draft {
  to: string
  subject: string
  body: string
}

export type DraftErrors = Partial<Record<keyof Draft, string>>

export const EMPTY_DRAFT: Draft = { to: '', subject: '', body: '' }
export const EMPTY_PAGE: MailPage = { messages: [], nextCursor: null }
export const PAGE_SIZE = 50

export const SUBJECT_MAX = 300
// The bridge (electron/iclone-acp.ts) refuses a longer `--body` / `--query`
// outright, with no field named — the sheet must stop there first.
export const BODY_MAX = 20_000
export const SEARCH_MAX = 500
export const EMAIL_MAX = 254
// The bridge's `email` shape (64-char local part, alphabetic TLD), minus what
// only an address-with-a-name would carry.
export const EMAIL = /^[^\s@<>()[\],;:"]{1,64}@[^\s@<>()[\],;:"]{1,190}\.[A-Za-z]{2,24}$/
export const THREAD_ID = /^[A-Za-z0-9_.:-]{1,120}$/
export const UNSCANNED = new Set(['pending', 'queued', 'scanning', 'unscanned'])
