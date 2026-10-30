/**
 * The Message window's session sidebar (owner rule: no top bar — a sidebar,
 * collapsed by default, with its own expand button, the message / iT
 * selector at its top and every session below it, grouped by type).
 *
 * Collapsed it is a slim rail (toggle, the two views, `+`); expanded it is
 * the full list. Every row is the chat sidebar's own `SidebarSessionRow` (the
 * ⋮ menu with rename / pin / archive / delete) under the shared date dividers
 * and branch stems; this list adds only what the shared section cannot carry:
 * a heading per group, a row id, and the one-step delete (✕ or Delete key →
 * the shared `DeleteSessionDialog`). Opening goes through the ONE
 * `openSession` door; delete/archive run through the session-tile delegate
 * (optimistic tombstoning) with the plain API as fallback. What goes in which
 * group is `msg-sidebar-groups.ts` (pure).
 *
 * The list follows the view (contract §12): `chat` lists the message
 * sessions, `iT` only the open iT sessions (msg-sidebar-it.tsx). One view is
 * mounted at a time; every scroller remembers its offset across the switch.
 */
import './msg-sidebar.css'

import { useStore } from '@nanostores/react'
import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual'
import { MessageSquare, PanelLeftClose, PanelLeftOpen, Plus, SquareTerminal, X } from 'lucide-react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, TransitionEvent } from 'react'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'

import { deleteSession, setSessionArchived } from '@/api/sessions'
import { SidebarDateDivider } from '@/app/chat/sidebar/chrome'
import { DeleteSessionDialog } from '@/app/chat/sidebar/session-actions-menu'
import { SidebarSessionRow } from '@/app/chat/sidebar/session-row'
import { VIRTUALIZE_THRESHOLD } from '@/app/chat/sidebar/sessions-section'
import { openSession } from '@/app/open-session'
import { NEW_CHAT_ROUTE } from '@/app/routes'
import { SidebarPanelLabel } from '@/app/shell/sidebar-label'
import { DisclosureCaret } from '@/components/ui/disclosure-caret'
import { Loader } from '@/components/ui/loader'
import type { SessionInfo } from '@/hermes'
import { useI18n } from '@/i18n'
import { sessionTitle } from '@/lib/chat-runtime'
import { flattenSessionsWithBranches } from '@/lib/session-branch-tree'
import { groupEntriesByRecency, type SidebarListRow, toSessionRows } from '@/lib/session-date-groups'
import { sessionBucketLabel } from '@/lib/time'
import { $pinnedSessionIds, pinSession, unpinSession } from '@/store/layout'
import { notifyError } from '@/store/notifications'
import { $removedSessionIds } from '@/store/projects'
import {
  $cronSessions,
  $messagingSessions,
  $selectedStoredSessionId,
  $sessions,
  $sessionsLoading,
  sessionPinId
} from '@/store/session'
import { $unconfirmedPinWrites } from '@/store/session-pin-sync'
import { sessionTileDelegate } from '@/store/session-states'
import { broadcastSessionsChanged } from '@/store/session-sync'
import { markSessionUnread } from '@/store/session-unread-remote'

import { $itClosePrompt, dismissItClose } from './it-keys'
import { addItWorkspace, type setMsgView } from './it-store'
import { groupMsgSessions, hasManyProfiles, type MsgSessionGroup } from './msg-sidebar-groups'
import { ItSessionList, SideButton } from './msg-sidebar-it'

type MsgView = Parameters<typeof setMsgView>[0]

/** The sidebar's words in the display language; 'iT' is a brand mark. */
function useLabels() {
  const { t } = useI18n()

  return useMemo(
    () => ({
      nav: t.desktop.home.conversations,
      show: t.desktop.home.showConversations,
      hide: t.desktop.home.hideConversations,
      views: t.desktop.home.messageViews,
      chat: t.desktop.home.viewMessage,
      it: 'iT',
      newSession: t.desktop.home.newConversation,
      newIt: t.desktop.home.newItSession,
      scheduled: t.desktop.home.scheduledJobs,
      archived: t.desktop.home.archived,
      delete: t.desktop.home.delete
    }),
    [t]
  )
}

/** A collapse the browser never animates (no transition, a hidden tab) still settles. */
const SETTLE_FALLBACK_MS = 600

// A row's open button: the first button of a row that is not one of its
// trailing actions (⋮, rename, ✕) — ↑/↓ walk these.
const ROW = '.row-hover, [data-it-workspace-id]'
const ROW_TARGET = 'button:not([data-row-actions] *)'

function removeViaDelegate(sessionId: string): void {
  const delegate = sessionTileDelegate()

  if (delegate?.deleteSession) {
    void delegate.deleteSession(sessionId)

    return
  }

  void deleteSession(sessionId).then(() => broadcastSessionsChanged())
}

// Unarchive is scoped to the row's profile, as the upstream archive list does.
function setArchivedViaDelegate(session: SessionInfo, archived: boolean): void {
  const delegate = sessionTileDelegate()

  if (archived && delegate?.archiveSession) {
    void delegate.archiveSession(session.id)

    return
  }

  void setSessionArchived(session.id, archived, session.profile).then(() => broadcastSessionsChanged())
}

/**
 * What a scroller keeps while unmounted, by key (`view:<view>`,
 * `group:<key>`): its offset and, for a virtual list, its measured sizes —
 * restored from estimates alone, the virtualizer re-measures and nudges the
 * offset by their error.
 */
interface ScrollMark {
  measurements?: VirtualItem[]
  offset: number
}

type ScrollMemory = { current: Record<string, ScrollMark> }

function rowTargets(list: HTMLElement | null): HTMLElement[] {
  if (!list) {
    return []
  }

  return [...list.querySelectorAll<HTMLElement>(ROW)].flatMap(row => row.querySelector<HTMLElement>(ROW_TARGET) ?? [])
}

interface MsgSidebarProps {
  /** The window fills the app: on iT the rail starts below the titlebar band. */
  expanded: boolean
  open: boolean
  view: MsgView
  onToggle: () => void
  /** Fires once the collapse has finished moving (the window narrows its clip then). */
  onCollapsed: () => void
  onView: (view: MsgView) => void
}

export function MsgSidebar({ expanded, open, view, onToggle, onCollapsed, onView }: MsgSidebarProps) {
  const LABELS = useLabels()
  const panelId = useId()
  const navigate = useNavigate()
  const listRef = useRef<HTMLDivElement>(null)
  const railToggleRef = useRef<HTMLButtonElement>(null)
  const panelToggleRef = useRef<HTMLButtonElement>(null)

  // `+` belongs to the view on screen: a conversation, or an iT session that
  // opens beside the others without leaving iT.
  const startNew = useCallback(() => {
    if (view === 'it') {
      addItWorkspace()

      return
    }

    onView('chat')
    navigate(NEW_CHAT_ROUTE)
  }, [navigate, onView, view])

  const newLabel = view === 'it' ? LABELS.newIt : LABELS.newSession

  // Group disclosures and every scroller's offset outlive the list's unmounts
  // (collapse, view switch): the list per view, a long group by its key.
  const [openByKey, setOpenByKey] = useState<Record<string, boolean>>({})
  const scrolls = useRef<Record<string, ScrollMark>>({})

  // Focus follows the toggle across the swap (rail ↔ panel header): the
  // other one is inert until React commits, so it is focused a frame later.
  const toggle = useCallback(() => {
    const next = open ? railToggleRef : panelToggleRef

    onToggle()
    requestAnimationFrame(() => next.current?.focus({ preventScroll: true }))
  }, [onToggle, open])

  // The list leaves WITH the slide: mounted on open, dropped once the
  // collapse has settled.
  const [listMounted, setListMounted] = useState(open)

  if (open && !listMounted) {
    setListMounted(true)
  }

  // transitionend and the fallback timer both end a collapse; only the first
  // counts — the list it unmounts is the flag (a new settle re-arms the timer).
  const settle = useCallback(() => {
    if (!listMounted) {
      return
    }

    setListMounted(false)
    onCollapsed()
  }, [listMounted, onCollapsed])

  useEffect(() => {
    if (open) {
      return
    }

    const timer = window.setTimeout(settle, SETTLE_FALLBACK_MS)

    return () => window.clearTimeout(timer)
  }, [settle, open])

  useLayoutEffect(() => {
    if (listMounted && listRef.current) {
      listRef.current.scrollTop = scrolls.current[`view:${view}`]?.offset ?? 0
    }
  }, [listMounted, view])

  const onPanelTransitionEnd = (event: TransitionEvent<HTMLDivElement>) => {
    if (!open && event.target === event.currentTarget && event.propertyName === 'opacity') {
      settle()
    }
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    // Keys from the row menus and dialogs (portals) bubble here through the
    // React tree; they are theirs.
    if (event.defaultPrevented || !event.currentTarget.contains(event.target as Node)) {
      return
    }

    if (event.key === 'Escape' && open) {
      event.preventDefault()

      // One thing per Escape: a pending busy-close prompt goes first.
      if ($itClosePrompt.get()) {
        dismissItClose()
      } else {
        toggle()
      }

      return
    }

    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      return
    }

    const rows = rowTargets(listRef.current)
    const at = rows.indexOf(event.target as HTMLElement)

    if (at < 0) {
      return
    }

    event.preventDefault()
    rows[Math.max(0, Math.min(rows.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus()
  }

  return (
    <nav
      aria-label={LABELS.nav}
      className="imsg-side"
      data-expanded={expanded ? '' : undefined}
      data-open={open ? '' : undefined}
      dir="ltr"
      onKeyDown={onKeyDown}
    >
      {/* The rail and the panel swap wholesale: whichever is not live is inert. */}
      <div className="imsg-side__rail" inert={open}>
        <SideButton
          aria-controls={panelId}
          aria-expanded={false}
          label={LABELS.show}
          onClick={toggle}
          ref={railToggleRef}
        >
          <PanelLeftOpen size={16} strokeWidth={1.75} />
        </SideButton>
        <div aria-label={LABELS.views} className="imsg-side__views" role="group">
          <SideButton aria-pressed={view === 'chat'} label={LABELS.chat} onClick={() => onView('chat')}>
            <MessageSquare size={15} strokeWidth={1.75} />
          </SideButton>
          <SideButton aria-pressed={view === 'it'} label={LABELS.it} onClick={() => onView('it')}>
            <SquareTerminal size={15} strokeWidth={1.75} />
          </SideButton>
        </div>
        <SideButton label={newLabel} onClick={startNew}>
          <Plus size={16} strokeWidth={1.75} />
        </SideButton>
      </div>

      <div className="imsg-side__panel" id={panelId} inert={!open} onTransitionEnd={onPanelTransitionEnd}>
        <div className="imsg-side__head">
          <SideButton aria-controls={panelId} aria-expanded label={LABELS.hide} onClick={toggle} ref={panelToggleRef}>
            <PanelLeftClose size={16} strokeWidth={1.75} />
          </SideButton>
          <div aria-label={LABELS.views} className="imsg-side__seg" role="group">
            {(['chat', 'it'] as const).map(id => (
              <button aria-pressed={view === id} key={id} onClick={() => onView(id)} type="button">
                {LABELS[id]}
              </button>
            ))}
          </div>
          <SideButton label={newLabel} onClick={startNew}>
            <Plus size={16} strokeWidth={1.75} />
          </SideButton>
        </div>
        <div
          className="imsg-side__list"
          data-view={view}
          onScroll={event => (scrolls.current[`view:${view}`] = { offset: event.currentTarget.scrollTop })}
          ref={listRef}
        >
          {listMounted && view === 'it' && <ItSessionList />}
          {listMounted && view === 'chat' && (
            <MsgSessionGroups onNew={startNew} openByKey={openByKey} scrolls={scrolls} setOpenByKey={setOpenByKey} />
          )}
        </div>
      </div>
    </nav>
  )
}

/**
 * The grouped list. It stays mounted through the collapse slide (the panel is
 * inert by then) and unmounts once the collapse settles, so a collapsed window
 * renders no rows at all.
 */
interface MsgSessionGroupsProps {
  onNew: () => void
  openByKey: Record<string, boolean>
  scrolls: ScrollMemory
  setOpenByKey: (update: (current: Record<string, boolean>) => Record<string, boolean>) => void
}

function MsgSessionGroups({ onNew, openByKey, scrolls, setOpenByKey }: MsgSessionGroupsProps) {
  const LABELS = useLabels()
  const { t } = useI18n()
  const navigate = useNavigate()
  const sessions = useStore($sessions)
  const messaging = useStore($messagingSessions)
  const cron = useStore($cronSessions)
  const pinnedIds = useStore($pinnedSessionIds)
  const unconfirmedPinWrites = useStore($unconfirmedPinWrites)
  const removedIds = useStore($removedSessionIds)
  const loading = useStore($sessionsLoading)
  const selected = useStore($selectedStoredSessionId)
  // The row kept after the confirm closes, so the dialog's text holds while it fades.
  const [doomed, setDoomed] = useState<SessionInfo | null>(null)
  const [confirming, setConfirming] = useState(false)

  const groups = useMemo(
    () => groupMsgSessions({ cron, messaging, pinnedIds, removedIds, sessions, unconfirmedPinWrites }),
    [cron, messaging, pinnedIds, removedIds, sessions, unconfirmedPinWrites]
  )

  const showProfiles = useMemo(() => hasManyProfiles(groups), [groups])

  const resume = useCallback((id: string) => openSession(id, navigate, 'in-place'), [navigate])

  const askDelete = useCallback((session: SessionInfo) => {
    setDoomed(session)
    setConfirming(true)
  }, [])

  const toggleUnread = useCallback(
    (id: string) => {
      const row = groups.flatMap(group => group.sessions).find(session => session.id === id)

      if (row) {
        markSessionUnread(id, row.unread !== true).catch(err => notifyError(err, t.sidebar.row.unreadFailed))
      }
    },
    [groups, t]
  )

  if (!groups.length) {
    return loading ? (
      <div className="imsg-side__state">
        <Loader className="imsg-side__loader" label={t.sidebar.loading} />
      </div>
    ) : (
      <div className="imsg-side__state">
        <p>{t.sidebar.noSessions}</p>
        <button className="imsg-side__start" onClick={onNew} type="button">
          <Plus size={14} strokeWidth={1.75} />
          {LABELS.newSession}
        </button>
      </div>
    )
  }

  const labelOf = (group: MsgSessionGroup) => {
    switch (group.kind) {
      case 'pinned':
        return t.sidebar.pinned

      case 'sessions':
        return t.sidebar.sessions

      case 'scheduled':
        return LABELS.scheduled

      case 'archived':
        return `${LABELS.archived} (${group.sessions.length})`

      default:
        return group.label ?? ''
    }
  }

  const renderRow = (kind: MsgSessionGroup['kind'], row: SidebarListRow) => {
    if (row.kind !== 'session') {
      return (
        <SidebarDateDivider
          key={row.key}
          label={'label' in row ? row.label : sessionBucketLabel(row.bucket, t.sidebar.dateDivider)}
        />
      )
    }

    const { branchStem, session } = row.entry

    return (
      <MsgRow
        branchStem={branchStem}
        key={rowKey(row)}
        kind={kind}
        onDelete={askDelete}
        onResume={resume}
        onToggleUnread={toggleUnread}
        selected={session.id === selected}
        session={session}
        showProfile={showProfiles}
      />
    )
  }

  return (
    <>
      {groups.map(group => {
        const isOpen = openByKey[group.key] ?? group.kind !== 'archived'

        return (
          <MsgGroup
            group={group}
            key={group.key}
            label={labelOf(group)}
            onToggle={() => setOpenByKey(current => ({ ...current, [group.key]: !isOpen }))}
            open={isOpen}
            renderRow={row => renderRow(group.kind, row)}
            scrolls={scrolls}
          />
        )
      })}
      <DeleteSessionDialog
        onConfirm={() => doomed && removeViaDelegate(doomed.id)}
        onOpenChange={setConfirming}
        open={confirming}
        sessionTitle={doomed ? sessionTitle(doomed) : ''}
      />
    </>
  )
}

function rowKey(row: SidebarListRow): string {
  // (profile, id): twins with one stored id in two profiles are distinct rows.
  return row.kind === 'session' ? `${row.entry.session.profile ?? ''}::${row.entry.session.id}` : row.key
}

interface MsgGroupProps {
  group: MsgSessionGroup
  label: string
  open: boolean
  onToggle: () => void
  renderRow: (row: SidebarListRow) => ReactNode
  scrolls: ScrollMemory
}

/** One group: a real heading (its disclosure inside it), then its rows — dated and branch-nested for Sessions. */
function MsgGroup({ group, label, open, onToggle, renderRow, scrolls }: MsgGroupProps) {
  const headingId = useId()
  const bodyId = useId()

  const rows = useMemo(() => {
    const entries = flattenSessionsWithBranches(group.sessions, { preserveOrder: group.kind === 'pinned' })

    return group.kind === 'sessions' ? groupEntriesByRecency(entries) : toSessionRows(entries)
  }, [group])

  const long = rows.length >= VIRTUALIZE_THRESHOLD

  return (
    <div
      aria-labelledby={headingId}
      className="imsg-side__group"
      data-group={group.kind}
      data-long={open && long ? '' : undefined}
      role="group"
    >
      <h3 className="imsg-side__heading" id={headingId}>
        <button aria-controls={bodyId} aria-expanded={open} onClick={onToggle} type="button">
          <SidebarPanelLabel>{label}</SidebarPanelLabel>
          <DisclosureCaret aria-hidden className="imsg-side__caret" open={open} />
        </button>
      </h3>
      <div className="imsg-side__rows" hidden={!open} id={bodyId}>
        {open &&
          (long ? (
            <MsgVirtualRows renderRow={renderRow} rows={rows} scrollKey={`group:${group.key}`} scrolls={scrolls} />
          ) : (
            rows.map(renderRow)
          ))}
      </div>
    </div>
  )
}

const ROW_ESTIMATE_PX = 32
const DIVIDER_ESTIMATE_PX = 28
const OVERSCAN_ROWS = 6

/** A long group renders only the rows its own bounded scroller shows. */
function MsgVirtualRows({
  rows,
  renderRow,
  scrollKey,
  scrolls
}: {
  rows: SidebarListRow[]
  renderRow: (row: SidebarListRow) => ReactNode
  scrollKey: string
  scrolls: ScrollMemory
}) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const remembered = scrolls.current[scrollKey]
  const offset = remembered?.offset ?? 0

  // Restores the offset before the virtualizer's first read of it (hook
  // order), so the remembered rows are the ones painted — not row 0's.
  useLayoutEffect(() => {
    if (scrollerRef.current) {
      scrollerRef.current.scrollTop = offset
    }
  }, [offset])

  const virtualizer = useVirtualizer({
    count: rows.length,
    estimateSize: index => (rows[index]?.kind === 'session' ? ROW_ESTIMATE_PX : DIVIDER_ESTIMATE_PX),
    getItemKey: index => (rows[index] ? rowKey(rows[index]) : index),
    getScrollElement: () => scrollerRef.current,
    initialMeasurementsCache: remembered?.measurements,
    initialOffset: offset,
    overscan: OVERSCAN_ROWS
  })

  // The sizes measured so far leave with the list (the scroll handler keeps
  // the offset current).
  useLayoutEffect(
    () => () => {
      scrolls.current[scrollKey] = {
        measurements: virtualizer.measurementsCache,
        offset: scrolls.current[scrollKey]?.offset ?? offset
      }
    },
    [offset, scrollKey, scrolls, virtualizer]
  )

  return (
    <div
      className="imsg-side__scroller"
      onScroll={event =>
        (scrolls.current[scrollKey] = { ...scrolls.current[scrollKey], offset: event.currentTarget.scrollTop })
      }
      ref={scrollerRef}
    >
      <div className="imsg-side__track" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {virtualizer.getVirtualItems().map(item => (
          <div
            className="imsg-side__slot"
            data-index={item.index}
            key={item.key}
            ref={virtualizer.measureElement}
            style={{ transform: `translateY(${item.start}px)` }}
          >
            {rows[item.index] && renderRow(rows[item.index])}
          </div>
        ))}
      </div>
    </div>
  )
}

interface MsgRowProps {
  session: SessionInfo
  branchStem?: string
  kind: MsgSessionGroup['kind']
  selected: boolean
  showProfile: boolean
  onDelete: (session: SessionInfo) => void
  onResume: (id: string) => void
  onToggleUnread: (id: string) => void
}

/**
 * The shared row plus the one-step delete the removed chip strip had: a ✕ on
 * hover/focus, or Delete/Backspace on the row — both into the same confirm.
 */
function MsgRow({ session, branchStem, kind, selected, showProfile, onDelete, onResume, onToggleUnread }: MsgRowProps) {
  const LABELS = useLabels()
  const pinned = kind === 'pinned'
  const archived = kind === 'archived'
  const label = `${LABELS.delete} ${sessionTitle(session)}`

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if ((event.key !== 'Delete' && event.key !== 'Backspace') || event.defaultPrevented) {
      return
    }

    const target = event.target as HTMLElement

    // Only the row's own controls: keys from its menus and dialogs (portals)
    // bubble here through the React tree, and a field types its own Backspace.
    if (!event.currentTarget.contains(target) || target.closest('[data-row-actions], input, textarea')) {
      return
    }

    event.preventDefault()
    onDelete(session)
  }

  return (
    <div className="imsg-row" data-session-id={session.id} onKeyDown={onKeyDown}>
      <SidebarSessionRow
        branchStem={branchStem}
        isPinned={pinned}
        isSelected={selected}
        onArchive={() => setArchivedViaDelegate(session, !archived)}
        onDelete={() => removeViaDelegate(session.id)}
        onPin={() => (pinned ? unpinSession : pinSession)(sessionPinId(session))}
        onResume={() => onResume(session.id)}
        onToggleUnread={() => onToggleUnread(session.id)}
        session={session}
        showProfile={showProfile}
        unread={session.unread === true}
      />
      <button aria-label={label} className="imsg-row__delete" onClick={() => onDelete(session)} type="button">
        <X size={13} strokeWidth={1.75} />
      </button>
    </div>
  )
}
