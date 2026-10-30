/**
 * Email — the message list: day groups, one calm row per message, honest
 * empty and error states, and paging (a sentinel near the end loads the next
 * page; the button stays as the fallback and the retry).
 *
 * Each row carries a checkbox in the gutter to its left — shown on hover, on
 * focus, and on every row while a selection exists — so selecting never moves
 * the row. Shift-click (box or row) selects a range; ⌘/Ctrl-click a row
 * toggles it.
 *
 * Rows are memoised and fed stable handlers, so a refresh that changed one
 * message renders one row, and a selection move renders two. Today's and
 * yesterday's rows read as an age ("3 min ago"): a minute clock in the list
 * renders those rows, and only those, once a minute.
 */
import { Archive, Check, Copy, Inbox, Paperclip, Search, Send, ShieldCheck, Sparkles, Trash2 } from 'lucide-react'
import { memo, type MouseEvent, type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from 'react'

import { Tip } from '@/components/ui/tooltip'

import type { AcpFailure } from '../cli'
import { when } from '../format'
import { Action, Empty, Note, Rows, SectionTitle, SkeletonRows } from '../ui'

import { CheckBox, ConfirmButton } from './email-controls'
import {
  addressLabel,
  describeFailure,
  groupByDay,
  isRecent,
  type MailMessage,
  rowTime,
  startOfDay
} from './email-data'
import { isUnread, type MailFolder } from './email-state'

/** A checkbox (or row) press: `range` extends from the last one checked. */
export type CheckMode = 'range' | 'toggle'

export interface ListView {
  folder: MailFolder
  /** The visible rows, in display order. */
  messages: readonly MailMessage[]
  /** Nothing to show yet and the first read is in flight. */
  loading: boolean
  error: AcpFailure | null
  /** Set while showing server search results. */
  query: null | string
  canLoadMore: boolean
  loadingMore: boolean
  moreError: null | string
  /** Loaded rows this folder hides because they were deleted forever here. */
  purged: number
  /** Rows loaded in the list this view filters — what "newest N" refers to. */
  scanned: number
}

export interface ListActions {
  onAskIntro: () => void
  onCheck: (message: MailMessage, mode: CheckMode) => void
  onClearSearch: () => void
  onCompose: () => void
  onEmptyTrash: () => void
  onLoadMore: () => void
  /** The end of the list scrolled within reach — pages unless a page failed. */
  onNearEnd: () => void
  onOpen: (message: MailMessage) => void
  /** Brings this folder's mail deleted forever back from the service's copy. */
  onRecover: () => void
  onRetry: () => void
  onSetup: () => void
}

// The paging sentinel fires this far before the end comes into view.
const PREFETCH_MARGIN = '0px 0px 200px 0px'
const MINUTE_MS = 60_000

/** Now, to the minute, while the window is visible — and at once when it
 *  shows again, so an age read after an hour away is right on sight. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible') {
        setNow(Date.now())
      }
    }

    const timer = window.setInterval(tick, MINUTE_MS)

    document.addEventListener('visibilitychange', tick)

    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [])

  return now
}

/** What a row's time is read against: the minute for mail that shows an
 *  age, the day for the rest — so a tick renders only rows whose label moved. */
function rowClock(at: number, now: number): number {
  return isRecent(at, now) ? now : startOfDay(now)
}

// ── one row ─────────────────────────────────────────────────────────────────

interface RowText {
  sender: string
  /** Recipients beyond the first, for outbound mail. */
  more: number
  full: string
}

// Formatted once per message object (the parts that do not move with the
// clock); the list keeps those objects across refreshes that did not change them.
const rowTexts = new WeakMap<MailMessage, RowText>()

function textOf(message: MailMessage): RowText {
  const known = rowTexts.get(message)

  if (known) {
    return known
  }

  const outbound = message.direction === 'outbound'
  const [first] = message.to

  const text: RowText = {
    sender: outbound ? (first ? addressLabel(first) : 'unknown recipient') : addressLabel(message.from),
    more: outbound ? Math.max(0, message.to.length - 1) : 0,
    full: when(message.receivedAt)
  }

  rowTexts.set(message, text)

  return text
}

function rowClass(active: boolean, unread: boolean): string {
  return ['e-row', 'e-row--click', active ? 'e-row--on' : '', unread ? 'e-row--unread' : ''].join(' ').trim()
}

const MailRow = memo(function MailRow({
  active,
  checked,
  grouped,
  message,
  now,
  onCheck,
  onOpen
}: {
  /** The cursor / open row. */
  active: boolean
  checked: boolean
  grouped: boolean
  message: MailMessage
  /** From `rowClock`: moves every minute only for rows that show an age. */
  now: number
  onCheck: (message: MailMessage, mode: CheckMode) => void
  onOpen: (message: MailMessage) => void
}) {
  const unread = isUnread(message)
  const text = textOf(message)

  const click = (event: MouseEvent<HTMLButtonElement>) => {
    if (event.shiftKey) {
      onCheck(message, 'range')
    } else if (event.metaKey || event.ctrlKey) {
      onCheck(message, 'toggle')
    } else {
      onOpen(message)
    }
  }

  return (
    <div className={checked ? 'em-item em-item--checked' : 'em-item'} data-mail-item={message.id}>
      <CheckBox
        checked={checked}
        label={`Select “${message.subject || '(no subject)'}” from ${text.sender}`}
        onToggle={event => onCheck(message, event.shiftKey ? 'range' : 'toggle')}
        tabbable={false}
        title="Select · X · Shift-click for a range"
      />
      <button
        aria-current={active ? 'true' : undefined}
        className={rowClass(active, unread)}
        onClick={click}
        type="button"
      >
        <Tip label={text.full}>
          <span className="em-row" data-mail-id={message.id}>
            <span aria-hidden="true" className={unread ? 'em-row__dot em-row__dot--on' : 'em-row__dot'} />
            {unread ? <span className="em-sr">Unread. </span> : null}
            <span className="em-row__from">
              {message.direction === 'outbound' ? <span className="em-row__to">to</span> : null}
              {text.sender}
              {text.more > 0 ? <span className="em-row__more">+{text.more}</span> : null}
            </span>
            <span className="em-row__text">
              <span className="em-row__subject">{message.subject || '(no subject)'}</span>
              {message.preview ? <span className="em-row__preview">{message.preview}</span> : null}
            </span>
            <span className="em-row__meta">
              {message.attachments > 0 ? (
                <Paperclip aria-label={`${message.attachments} attachments`} size={12} strokeWidth={1.8} />
              ) : null}
              <time dateTime={message.receivedAt}>{rowTime(message.at, grouped, now)}</time>
            </span>
          </span>
        </Tip>
      </button>
    </div>
  )
})

// ── states ──────────────────────────────────────────────────────────────────

function CopyAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) {
      return
    }

    const timer = window.setTimeout(() => setCopied(false), 1400)

    return () => window.clearTimeout(timer)
  }, [copied])

  const copy = () => {
    navigator.clipboard
      .writeText(address)
      .then(() => setCopied(true))
      .catch(() => undefined)
  }

  return (
    <Action kind="primary" onClick={copy}>
      {copied ? <Check size={13} strokeWidth={2} /> : <Copy size={13} strokeWidth={1.8} />}
      {copied ? 'Copied' : 'Copy address'}
    </Action>
  )
}

/** "Look further back" inside an empty view whose list has older pages. */
function OlderMail({ actions, view }: { actions: ListActions; view: ListView }) {
  if (!view.canLoadMore) {
    return null
  }

  return (
    <Action disabled={view.loadingMore} onClick={actions.onLoadMore}>
      {view.loadingMore ? 'Looking further back…' : view.moreError ? 'Try again' : 'Load older mail'}
    </Action>
  )
}

function messageCount(count: number): string {
  return count === 1 ? 'One message' : `${count} messages`
}

/** Mail deleted forever is only hidden here: the service still sends it. */
function purgedNote(count: number): string {
  return `${messageCount(count)} deleted forever on this device. The Virtuals service still has ${count === 1 ? 'it' : 'them'}.`
}

function RecoverAction({ actions, count, kind }: { actions: ListActions; count: number; kind: 'primary' | 'quiet' }) {
  return (
    <Action kind={kind} onClick={actions.onRecover}>
      Recover {count}
    </Action>
  )
}

function newest(view: ListView): string {
  return view.scanned === 1 ? 'the newest message' : `the newest ${view.scanned} messages`
}

function EmptyFolder({
  actions,
  address,
  agentName,
  view
}: {
  actions: ListActions
  address: string
  agentName: string
  view: ListView
}) {
  if (view.query !== null) {
    return (
      <Empty
        action={<Action onClick={actions.onClearSearch}>Clear search</Action>}
        hint="Search matches senders, subjects and message text. Try fewer or different words."
        icon={<Search size={26} strokeWidth={1.4} />}
        title={`No mail matches “${view.query}”`}
      />
    )
  }

  const older = <OlderMail actions={actions} view={view} />
  const failed = view.moreError ? ` ${view.moreError} — older mail didn’t load.` : ''

  if (view.purged > 0) {
    return (
      <Empty
        action={
          <span className="em-actions">
            <RecoverAction actions={actions} count={view.purged} kind="primary" />
            {older}
          </span>
        }
        hint={`${purgedNote(view.purged)}${failed}`}
        icon={<Trash2 size={26} strokeWidth={1.4} />}
        title={view.folder === 'trash' ? 'Trash is empty' : 'Deleted forever on this device'}
      />
    )
  }

  switch (view.folder) {
    case 'unread':
      return view.canLoadMore ? (
        <Empty
          action={older}
          hint={`Nothing unread in ${newest(view)}. Older mail may still hold some.${failed}`}
          icon={<Check size={26} strokeWidth={1.4} />}
          title={view.loadingMore ? 'Looking for unread mail…' : 'Nothing unread so far'}
        />
      ) : (
        <Empty hint="Every message has been read." icon={<Check size={26} strokeWidth={1.4} />} title="All caught up" />
      )

    case 'sent':
      return (
        <Empty
          action={
            <span className="em-actions">
              <Action kind="primary" onClick={actions.onCompose}>
                Compose
              </Action>
              {older}
            </span>
          }
          hint={
            view.canLoadMore
              ? `${agentName} sent nothing in ${newest(view)}. Load older mail, or write one now.${failed}`
              : address
                ? `Mail ${agentName} sends from ${address} appears here.`
                : `Mail ${agentName} sends appears here.`
          }
          icon={<Send size={26} strokeWidth={1.4} />}
          title={view.canLoadMore ? 'Nothing sent recently' : 'Nothing sent yet'}
        />
      )

    case 'spam':
      return (
        <Empty
          action={older}
          hint={`Mail the filter holds back lands here. Nothing so far.${failed}`}
          icon={<ShieldCheck size={26} strokeWidth={1.4} />}
          title="No spam"
        />
      )

    case 'archive':
      return (
        <Empty
          action={older}
          hint={
            view.canLoadMore
              ? `Some archived mail sits in older pages.${failed}`
              : 'Archive takes mail out of the Inbox without deleting it — search still finds it. Select messages and press E.'
          }
          icon={<Archive size={26} strokeWidth={1.4} />}
          title={view.loadingMore ? 'Looking for archived mail…' : 'Nothing archived'}
        />
      )

    case 'trash':
      return (
        <Empty
          action={older}
          hint={
            view.canLoadMore
              ? `Some trashed mail sits in older pages.${failed}`
              : `Trashed mail waits here until you restore it or delete it forever. ${TRASH_TRUTH}`
          }
          icon={<Trash2 size={26} strokeWidth={1.4} />}
          title={view.loadingMore ? 'Looking for trashed mail…' : 'Trash is empty'}
        />
      )

    default:
      return (
        <Empty
          action={
            <span className="em-actions">
              {address ? (
                <>
                  <CopyAddress address={address} />
                  <Action onClick={actions.onAskIntro}>
                    <Sparkles size={13} strokeWidth={1.8} />
                    Ask {agentName} to introduce itself
                  </Action>
                </>
              ) : null}
              {older}
            </span>
          }
          hint={
            address
              ? `Your agent’s address is ${address}. Share it or ask ${agentName} to introduce itself.${failed}`
              : `Mail sent to your agent’s address shows up here.${failed}`
          }
          icon={<Inbox size={26} strokeWidth={1.4} />}
          title="Nothing here yet"
        />
      )
  }
}

function ReadError({ actions, failure, subject }: { actions: ListActions; failure: AcpFailure; subject: string }) {
  const copy = describeFailure(failure, subject)

  const action =
    copy.next === 'setup' ? (
      <Action kind="primary" onClick={actions.onSetup}>
        Open Setup
      </Action>
    ) : copy.next === 'retry' ? (
      <Action onClick={actions.onRetry}>Try again</Action>
    ) : null

  return <Empty action={action} hint={copy.hint} icon={<Inbox size={26} strokeWidth={1.4} />} title={copy.title} />
}

// ── the list ────────────────────────────────────────────────────────────────

interface RowsProps {
  checked: ReadonlySet<string>
  messages: readonly MailMessage[]
  now: number
  onCheck: (message: MailMessage, mode: CheckMode) => void
  onOpen: (message: MailMessage) => void
  selectedId: null | string
}

function MailRows({ checked, grouped, messages, now, onCheck, onOpen, selectedId }: RowsProps & { grouped: boolean }) {
  return (
    <Rows>
      {messages.map(message => (
        <MailRow
          active={message.id === selectedId}
          checked={checked.has(message.id)}
          grouped={grouped}
          key={message.id}
          message={message}
          now={rowClock(message.at, now)}
          onCheck={onCheck}
          onOpen={onOpen}
        />
      ))}
    </Rows>
  )
}

const Groups = memo(function Groups({ messages, now, ...rows }: RowsProps) {
  // Grouping depends on the day only: "Today" becomes "Yesterday" at
  // midnight, and not a minute sooner re-groups the list.
  const day = startOfDay(now)
  const groups = useMemo(() => groupByDay(messages, day), [day, messages])

  return (
    <>
      {groups.map(group => (
        <section aria-label={group.label} key={group.key}>
          <SectionTitle end={<span className="em-count">{group.messages.length}</span>}>{group.label}</SectionTitle>
          <MailRows grouped messages={group.messages} now={now} {...rows} />
        </section>
      ))}
    </>
  )
})

const SearchResults = memo(function SearchResults({
  messages,
  onClear,
  query,
  ...rows
}: RowsProps & { onClear: () => void; query: string }) {
  return (
    <section aria-label="Search results">
      <SectionTitle
        end={
          <Action kind="quiet" onClick={onClear}>
            Clear
          </Action>
        }
      >
        {messages.length} {messages.length === 1 ? 'result' : 'results'} for “{query}”
      </SectionTitle>
      <MailRows grouped={false} messages={messages} {...rows} />
    </section>
  )
})

/** The service cannot delete: "forever" is this computer's promise, said so. */
export const TRASH_TRUTH = 'Deleted forever on this device; the Virtuals service keeps its own copy.'

/** Above the Trash list: what Trash is, the way to empty it, and the way back
 *  for loaded mail already deleted forever. */
function TrashHead({ actions, purged }: { actions: ListActions; purged: number }) {
  return (
    <div className="em-listhead">
      <p className="em-listhead__text">{purged > 0 ? purgedNote(purged) : TRASH_TRUTH}</p>
      <span className="em-actions">
        {purged > 0 ? <RecoverAction actions={actions} count={purged} kind="quiet" /> : null}
        <ConfirmButton armedText="Delete all forever?" compact label="Empty trash" onConfirm={actions.onEmptyTrash} />
      </span>
    </div>
  )
}

/** Calls `onVisible` when it scrolls within reach of the list's end. Only a
 *  transition into view counts, so a short list pages once, not in a loop.
 *  It stays mounted through a paging error (a remount reports the end in view
 *  at once); `onNearEnd` is what declines to page while the error stands. */
function Sentinel({ onVisible, rootRef }: { onVisible: () => void; rootRef: RefObject<HTMLDivElement | null> }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const target = ref.current

    if (!target || typeof IntersectionObserver === 'undefined') {
      return
    }

    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          onVisible()
        }
      },
      { root: rootRef.current, rootMargin: PREFETCH_MARGIN }
    )

    observer.observe(target)

    return () => observer.disconnect()
  }, [onVisible, rootRef])

  return <div aria-hidden="true" className="em-more__sentinel" ref={ref} />
}

function MoreFooter({
  actions,
  rootRef,
  view
}: {
  actions: ListActions
  rootRef: RefObject<HTMLDivElement | null>
  view: ListView
}) {
  return (
    <div className="em-more">
      {view.moreError ? <Note kind="warn">{view.moreError} — older mail didn’t load.</Note> : null}
      <Sentinel onVisible={actions.onNearEnd} rootRef={rootRef} />
      <Action disabled={view.loadingMore} onClick={actions.onLoadMore}>
        {view.loadingMore ? 'Loading…' : view.moreError ? 'Try again' : 'Load more'}
      </Action>
    </div>
  )
}

export const MailList = memo(function MailList({
  actions,
  address,
  agentName,
  checked,
  selectedId,
  view
}: {
  actions: ListActions
  address: string
  agentName: string
  /** The selected (checked) rows in view — not the cursor, which is `selectedId`. */
  checked: ReadonlySet<string>
  selectedId: null | string
  view: ListView
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const now = useMinuteClock()
  const hasRows = view.messages.length > 0
  const subject = view.query !== null ? 'the search' : view.folder === 'spam' ? 'Spam' : 'the mailbox'
  const staleError = view.error && hasRows ? describeFailure(view.error, subject) : null

  let content: ReactNode

  if (hasRows) {
    const rows: RowsProps = {
      checked,
      messages: view.messages,
      now,
      onCheck: actions.onCheck,
      onOpen: actions.onOpen,
      selectedId
    }

    content =
      view.query !== null ? (
        <SearchResults {...rows} onClear={actions.onClearSearch} query={view.query} />
      ) : (
        <>
          {view.folder === 'trash' ? <TrashHead actions={actions} purged={view.purged} /> : null}
          <Groups {...rows} />
        </>
      )
  } else if (view.loading) {
    // A search can take the mail server seconds: say what is being looked for
    // instead of leaving anonymous skeleton rows where the old list was.
    content = view.query !== null ? <Note>Searching mail for “{view.query}”…</Note> : <SkeletonRows rows={8} />
  } else if (view.error) {
    content = <ReadError actions={actions} failure={view.error} subject={subject} />
  } else {
    content = <EmptyFolder actions={actions} address={address} agentName={agentName} view={view} />
  }

  return (
    <div className={checked.size > 0 ? 'e-scroll em-list em-list--selecting' : 'e-scroll em-list'} ref={scrollRef}>
      {staleError ? (
        <Note kind="warn">
          {staleError.title} — showing the last messages read. {staleError.hint}
          {staleError.next === 'setup' ? (
            <span className="em-note__action">
              <Action kind="quiet" onClick={actions.onSetup}>
                Open Setup
              </Action>
            </span>
          ) : null}
        </Note>
      ) : null}
      {content}
      {hasRows && view.query === null && view.canLoadMore ? (
        <MoreFooter actions={actions} rootRef={scrollRef} view={view} />
      ) : null}
    </div>
  )
})
