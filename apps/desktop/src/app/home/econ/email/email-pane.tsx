/**
 * Email — the reading pane: one thread, its messages in order, and the reply
 * box. Bodies are rendered as text only — `htmlBody` never reaches the DOM as
 * markup — and links open only in mail the scanner marked clean. People in the
 * thread are menus: write to them, or copy their address.
 *
 * The header acts on the open message as the bar acts on a selection: mark
 * unread, Archive / Move to inbox, Trash — and in Trash, Restore and Delete
 * forever.
 */
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Mail,
  PanelRightClose,
  Paperclip,
  Reply,
  Sparkles,
  Trash2,
  Undo2
} from 'lucide-react'
import { type CSSProperties, Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Tip } from '@/components/ui/tooltip'

import type { AcpFailure } from '../cli'
import { ago, when } from '../format'
import { Action, Avatar, Empty, IconAction, Link, Note, Pill, SkeletonRows } from '../ui'

import { ConfirmButton } from './email-controls'
import {
  addressLabel,
  describeFailure,
  type MailAddress,
  type MailMessage,
  type MailSafety,
  type MailThread,
  type ThreadMessage,
  validateReply
} from './email-data'
import { PersonButton } from './email-person'
import type { MailMove, MailPlace } from './email-state'
import { type BodyBlock, cleanPreview, displayUrl, splitLinks } from './email-text'
import { parsedBody } from './parsed-bodies'

export interface PaneState {
  threadId: string
  /** The list row that opened the pane — shown while the thread loads. */
  seed: MailMessage | null
  thread: MailThread | null
  error: AcpFailure | null
  loading: boolean
}

/** Everything the pane asks of the client — one stable object. */
export interface PaneActions {
  onAsk: (thread: { id: string; subject: string }) => void
  onClose: () => void
  onComposeTo: (address: string) => void
  /** Marks the open message unread and goes back to the list. */
  onMarkUnread: () => void
  onMove: (move: MailMove) => void
  onReply: (threadId: string, body: string) => Promise<null | string>
  onReplyFocused: () => void
  onRetry: (threadId: string) => void
  onSetup: () => void
}

const MOD_KEY = typeof navigator !== 'undefined' && /mac/i.test(navigator.userAgent) ? '⌘' : 'Ctrl'

const SAFETY_NOTE: Record<Exclude<MailSafety, 'clean'>, string> = {
  flagged: 'The scanner flagged this message — links are shown as plain text.',
  spam: 'Marked as spam — links are shown as plain text.',
  unscanned: 'Not scanned yet — links are shown as plain text.'
}

// ── body ────────────────────────────────────────────────────────────────────

function Linkified({ links, text }: { links: boolean; text: string }) {
  const pieces = useMemo(() => splitLinks(text), [text])

  return (
    <>
      {pieces.map((piece, index) => {
        if (piece.kind === 'text') {
          return <Fragment key={index}>{piece.value}</Fragment>
        }

        return links ? (
          <Link href={piece.value} key={index}>
            {displayUrl(piece.value)}
          </Link>
        ) : (
          <span className="em-url-off" key={index}>
            {piece.value}
          </span>
        )
      })}
    </>
  )
}

function Block({ block, links }: { block: BodyBlock; links: boolean }) {
  if (block.depth === 0) {
    return (
      <p className="em-body__p">
        <Linkified links={links} text={block.text} />
      </p>
    )
  }

  return (
    <blockquote className="em-body__quote" style={{ '--em-depth': Math.min(block.depth, 4) } as CSSProperties}>
      <Linkified links={links} text={block.text} />
    </blockquote>
  )
}

function MessageBody({ links, text }: { links: boolean; text: string }) {
  const body = useMemo(() => parsedBody(text), [text])
  const [showQuoted, setShowQuoted] = useState(false)

  if (body.blocks.length === 0) {
    return <p className="em-body__empty">This message has no text.</p>
  }

  return (
    <div className="e-prose em-body">
      {body.blocks.map((block, index) => (
        <Block block={block} key={index} links={links} />
      ))}
      {body.quoted.length > 0 ? (
        <>
          <Tip label={showQuoted ? 'Hide quoted text' : 'Show quoted text'}>
            <button
              aria-expanded={showQuoted}
              aria-label={showQuoted ? 'Hide quoted text' : 'Show quoted text'}
              className="em-body__fold"
              onClick={() => setShowQuoted(current => !current)}
              type="button"
            >
              •••
            </button>
          </Tip>
          {showQuoted ? (
            <div className="em-body__history">
              {body.quoted.map((block, index) => (
                <Block block={block} key={index} links={links} />
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

// ── one message ─────────────────────────────────────────────────────────────

function senderName(message: ThreadMessage, agentName: string): string {
  return message.direction === 'outbound' ? agentName : addressLabel(message.from)
}

function Recipients({ to }: { to: MailAddress[] }) {
  if (to.length === 0) {
    return null
  }

  return <p className="em-msg__to">to {to.map(address => address.address).join(', ')}</p>
}

function Attachments({ message }: { message: ThreadMessage }) {
  if (message.attachmentCount === 0) {
    return null
  }

  const unnamed = message.attachmentCount - message.attachments.length

  return (
    <Tip label="Attachments can’t be downloaded from the CLI yet">
      <div aria-label="Attachments" className="em-attachments">
        {message.attachments.map((attachment, index) => (
          <span className="em-attachment" key={`${attachment.name}-${index}`}>
            <Paperclip size={11} strokeWidth={1.8} />
            {attachment.name}
          </span>
        ))}
        {unnamed > 0 ? (
          <span className="em-attachment">
            <Paperclip size={11} strokeWidth={1.8} />
            {unnamed} {unnamed === 1 ? 'attachment' : 'attachments'}
          </span>
        ) : null}
      </div>
    </Tip>
  )
}

function isOwn(address: string, mailbox: string): boolean {
  return Boolean(mailbox) && address.toLowerCase() === mailbox.toLowerCase()
}

const MessageCard = memo(function MessageCard({
  agentName,
  mailbox,
  message,
  onComposeTo
}: {
  agentName: string
  mailbox: string
  message: ThreadMessage
  onComposeTo: (address: string) => void
}) {
  const name = senderName(message, agentName)
  const links = message.safety === 'clean'

  return (
    <article className={message.direction === 'outbound' ? 'em-msg em-msg--out' : 'em-msg'}>
      <header className="em-msg__head">
        <Avatar name={name} size={28} />
        <div className="em-msg__who">
          <div className="em-msg__from">
            <b>{name}</b>
            {message.direction === 'outbound' ? <Pill tone="muted">agent</Pill> : null}
            {message.from.address && message.from.address !== name ? (
              <PersonButton
                className="em-msg__addr"
                onComposeTo={onComposeTo}
                own={message.direction === 'outbound' || isOwn(message.from.address, mailbox)}
                person={message.from}
              >
                {message.from.address}
              </PersonButton>
            ) : null}
          </div>
          <Recipients to={message.to} />
        </div>
        <time className="em-msg__time" dateTime={message.receivedAt} title={ago(message.receivedAt)}>
          {when(message.receivedAt)}
        </time>
      </header>
      {message.safety !== 'clean' ? <Note kind="warn">{SAFETY_NOTE[message.safety]}</Note> : null}
      {message.fromHtml ? <p className="em-msg__flag">Shown as plain text</p> : null}
      <MessageBody links={links} text={message.text} />
      <Attachments message={message} />
    </article>
  )
})

function CollapsedMessage({
  agentName,
  message,
  onExpand
}: {
  agentName: string
  message: ThreadMessage
  onExpand: () => void
}) {
  const name = senderName(message, agentName)

  return (
    <button className="em-msg em-msg--folded" onClick={onExpand} type="button">
      <Avatar name={name} size={20} />
      <b className="em-msg__fold-from">{name}</b>
      <span className="em-msg__fold-preview">{cleanPreview(message.text, 140)}</span>
      <time className="em-msg__time" dateTime={message.receivedAt}>
        {ago(message.receivedAt)}
      </time>
    </button>
  )
}

/** Short threads read in full; longer ones fold everything but the latest
 *  message and anything still unread. */
function openByDefault(message: ThreadMessage, index: number, all: ThreadMessage[]): boolean {
  return all.length <= 2 || index === all.length - 1 || (message.direction === 'inbound' && !message.isRead)
}

// ── reply ───────────────────────────────────────────────────────────────────

function ReplyBox({
  counterpart,
  focus,
  onFocused,
  onSend
}: {
  counterpart: string
  focus: boolean
  onFocused: () => void
  onSend: (body: string) => Promise<null | string>
}) {
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<null | string>(null)
  const [sent, setSent] = useState(false)
  const fieldRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (focus) {
      fieldRef.current?.focus()
      onFocused()
    }
  }, [focus, onFocused])

  useEffect(() => {
    if (!sent) {
      return
    }

    const timer = window.setTimeout(() => setSent(false), 2400)

    return () => window.clearTimeout(timer)
  }, [sent])

  const submit = async () => {
    const problem = validateReply(body)

    if (problem) {
      setError(problem)
      fieldRef.current?.focus()

      return
    }

    setSending(true)
    setError(null)
    const failure = await onSend(body)
    setSending(false)

    if (failure) {
      setError(failure)

      return
    }

    setBody('')
    setSent(true)
  }

  return (
    <div className="em-reply">
      <label className="em-reply__to" htmlFor="em-reply-field">
        {sent ? 'Reply sent' : counterpart ? `Reply to ${counterpart}` : 'Reply'}
      </label>
      <textarea
        aria-invalid={error ? true : undefined}
        className="em-reply__field"
        disabled={sending}
        id="em-reply-field"
        onChange={event => {
          setBody(event.target.value)
          setError(null)
        }}
        onKeyDown={event => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            void submit()
          }
        }}
        placeholder="Write a reply…"
        ref={fieldRef}
        rows={2}
        value={body}
      />
      {error ? (
        <p className="em-reply__error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="em-reply__foot">
        <span className="em-hint">{MOD_KEY}↩ to send</span>
        <Action disabled={sending || !body.trim()} kind="primary" onClick={() => void submit()}>
          <Reply size={13} strokeWidth={1.8} />
          {sending ? 'Sending…' : 'Send reply'}
        </Action>
      </div>
    </div>
  )
}

// ── the pane ────────────────────────────────────────────────────────────────

function Participants({
  mailbox,
  onComposeTo,
  people
}: {
  mailbox: string
  onComposeTo: (address: string) => void
  people: MailAddress[]
}) {
  const others = people.filter(person => !isOwn(person.address, mailbox))
  const shown = (others.length > 0 ? others : people).slice(0, 4)
  const hidden = (others.length > 0 ? others : people).length - shown.length

  if (shown.length === 0) {
    return null
  }

  return (
    <div className="em-pane__people">
      {shown.map(person => (
        <PersonButton
          className="em-chip"
          key={person.address}
          onComposeTo={onComposeTo}
          own={isOwn(person.address, mailbox)}
          person={person}
        >
          {addressLabel(person)}
        </PersonButton>
      ))}
      {hidden > 0 ? <span className="em-chip em-chip--more">+{hidden}</span> : null}
    </div>
  )
}

function seedPeople(seed: MailMessage | null): MailAddress[] {
  return seed ? [seed.from, ...seed.to] : []
}

const ICON = { size: 14, strokeWidth: 1.7 } as const

/** The open message's own actions, by where it lives. */
function MessageTools({
  canMarkUnread,
  onMarkUnread,
  onMove,
  place
}: {
  canMarkUnread: boolean
  onMarkUnread: () => void
  onMove: (move: MailMove) => void
  place: MailPlace
}) {
  return (
    <span aria-label="Message actions" className="em-pane__tools" role="group">
      {canMarkUnread ? (
        <IconAction label="Mark unread · ⇧U" onClick={onMarkUnread}>
          <Mail {...ICON} />
        </IconAction>
      ) : null}
      {place === 'trash' ? (
        <>
          <IconAction label="Restore" onClick={() => onMove('restore')}>
            <Undo2 {...ICON} />
          </IconAction>
          <ConfirmButton armedText="Delete forever?" compact label="Delete forever" onConfirm={() => onMove('purge')} />
        </>
      ) : (
        <>
          {place === 'archive' ? (
            <IconAction label="Move to inbox · E" onClick={() => onMove('inbox')}>
              <ArchiveRestore {...ICON} />
            </IconAction>
          ) : (
            <IconAction label="Archive · E" onClick={() => onMove('archive')}>
              <Archive {...ICON} />
            </IconAction>
          )}
          <IconAction label="Trash · #" onClick={() => onMove('trash')}>
            <Trash2 {...ICON} />
          </IconAction>
        </>
      )}
    </span>
  )
}

export const ThreadPane = memo(function ThreadPane({
  actions,
  agentName,
  canMarkUnread,
  focusReply,
  mailbox,
  pane,
  place
}: {
  actions: PaneActions
  agentName: string
  /** The open message is the agent's inbound mail (outbound is never unread). */
  canMarkUnread: boolean
  focusReply: boolean
  mailbox: string
  pane: PaneState
  /** Where the open message lives — which moves the header offers. */
  place: MailPlace
}) {
  const { onAsk, onClose, onComposeTo, onMarkUnread, onMove, onReply, onReplyFocused, onRetry, onSetup } = actions
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [replyFocus, setReplyFocus] = useState(false)
  const { thread } = pane
  const subject = thread?.subject || pane.seed?.subject || '(no subject)'
  const people = thread?.participants ?? seedPeople(pane.seed)
  const count = thread?.messages.length ?? 0

  const counterpart =
    thread?.counterpart || people.find(person => person.address.toLowerCase() !== mailbox.toLowerCase())?.address || ''

  const failure = pane.error && !thread ? describeFailure(pane.error, 'this thread') : null

  const expand = (id: string) => setExpanded(current => new Set(current).add(id))

  const replyFocused = useCallback(() => {
    setReplyFocus(false)
    onReplyFocused()
  }, [onReplyFocused])

  return (
    <div aria-label="Reading pane" className="em-pane" role="region">
      <header className="em-pane__head">
        <div className="em-pane__bar">
          <span className="em-pane__back">
            <IconAction label="Back to the list · U" onClick={onClose}>
              <ArrowLeft size={14} strokeWidth={1.8} />
            </IconAction>
          </span>
          <span className="em-pane__meta">
            {count > 0 ? `${count} ${count === 1 ? 'message' : 'messages'}` : pane.loading ? 'Opening…' : ''}
            {thread?.lastMessageAt ? ` · ${ago(thread.lastMessageAt)}` : ''}
          </span>
          <span className="em-pane__actions">
            <IconAction
              label={`Ask ${agentName} about this thread`}
              onClick={() => onAsk({ id: pane.threadId, subject })}
            >
              <Sparkles size={14} strokeWidth={1.7} />
            </IconAction>
            {thread ? (
              <IconAction label="Reply · R" onClick={() => setReplyFocus(true)}>
                <Reply size={14} strokeWidth={1.7} />
              </IconAction>
            ) : null}
            {pane.seed ? (
              <MessageTools canMarkUnread={canMarkUnread} onMarkUnread={onMarkUnread} onMove={onMove} place={place} />
            ) : null}
            <IconAction label="Close · Esc" onClick={onClose}>
              <PanelRightClose size={14} strokeWidth={1.7} />
            </IconAction>
          </span>
        </div>
        <h3 className="em-pane__subject">{subject}</h3>
        <Participants mailbox={mailbox} onComposeTo={onComposeTo} people={people} />
      </header>

      <div className="e-scroll em-pane__body">
        {thread ? (
          thread.messages.map((message, index, all) =>
            expanded.has(message.id) || openByDefault(message, index, all) ? (
              <MessageCard
                agentName={agentName}
                key={message.id}
                mailbox={mailbox}
                message={message}
                onComposeTo={onComposeTo}
              />
            ) : (
              <CollapsedMessage
                agentName={agentName}
                key={message.id}
                message={message}
                onExpand={() => expand(message.id)}
              />
            )
          )
        ) : failure ? (
          <Empty
            action={
              failure.next === 'setup' ? (
                <Action kind="primary" onClick={onSetup}>
                  Open Setup
                </Action>
              ) : failure.next === 'retry' ? (
                <Action onClick={() => onRetry(pane.threadId)}>Try again</Action>
              ) : null
            }
            hint={failure.hint}
            title={failure.title}
          />
        ) : (
          <SkeletonRows rows={4} />
        )}
      </div>

      {thread && pane.error ? (
        <Note kind="warn">{describeFailure(pane.error, 'this thread').title} — showing the last copy read.</Note>
      ) : null}

      {thread && thread.id ? (
        <ReplyBox
          counterpart={counterpart}
          focus={focusReply || replyFocus}
          key={thread.id}
          onFocused={replyFocused}
          onSend={body => onReply(thread.id, body)}
        />
      ) : null}
    </div>
  )
})
