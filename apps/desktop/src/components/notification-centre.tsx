import { useStore } from '@nanostores/react'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { claimRightEdge, watchRightEdge } from '@/app/home/right-edge'
import { IcIconAction } from '@/components/ic/controls'
import { IcHiddenLabel, IcPageButton } from '@/components/ic/ic-page'
import { IcTip } from '@/components/ic/ic-system'
import { IcCopyButton } from '@/components/onboarding/ic-system'
import { f4Centre } from '@/i18n/en/v009-f4'
import { f4bCentre } from '@/i18n/en/v009-f4b'
import { ESCAPE_PRIORITY, isTopEscapeLayer, pushEscapeLayer } from '@/lib/escape-layers'
import { Info, X } from '@/lib/icons'
import {
  $notificationCentre,
  $notificationHistory,
  clearNotificationHistory,
  closeNotificationCentre,
  type NotificationRecord,
  removeNotificationRecord,
  runNotificationAction
} from '@/store/notifications'

import { SeverityIcon } from './notification-glyph'

/**
 * v0.0.9 F4 — type 5, the notification centre: the right-edge island the titlebar bell opens (claimRightEdge, like
 * FILES and the iNFT collection). The last 200 entries, grouped Today / Yesterday / Earlier; each says what happened,
 * why, what to do, when, with its action and its raw detail (whole, scrollable, copyable). ✕, Esc and a click outside
 * close it. A toast click or "More" opens it on that toast's entry.
 */

/** The edge string the island publishes — the same expression `.icn-centre` resolves (--ic-note-centre-w). */
export const CENTRE_WIDTH_CSS = 'min(400px, calc(100vw - 24px))'
const EDGE_OWNER = 'notifications'
const BELL_SELECTOR = '[data-ic-frame-tool="iclone-notifications"]'
/** A pointer down on these never closes the centre: the bell toggles it, a toast opens it, a dialog sits above it. */
const KEEPS_OPEN = `${BELL_SELECTOR}, .icn-stack, [role="dialog"], [role="alertdialog"]`
// One rung above a panel inside an econ window: the centre floats over every home surface and closes first.
const CENTRE_ESCAPE_PRIORITY = ESCAPE_PRIORITY.econPanel + 1

type Group = 'earlier' | 'today' | 'yesterday'

export function groupOf(createdAt: number, now = Date.now()): Group {
  const start = new Date(now)

  start.setHours(0, 0, 0, 0)

  if (createdAt >= start.getTime()) {
    return 'today'
  }

  return createdAt >= start.getTime() - 86_400_000 ? 'yesterday' : 'earlier'
}

export function groupEntries(entries: readonly NotificationRecord[], now = Date.now()) {
  const groups: { entries: NotificationRecord[]; key: Group }[] = []

  for (const entry of entries) {
    const key = groupOf(entry.createdAt, now)
    const last = groups.at(-1)

    if (last?.key === key) {
      last.entries.push(entry)
    } else {
      groups.push({ entries: [entry], key })
    }
  }

  return groups
}

// r4d (design r4 F4-1): the locale's own time, no leading zero ("4:45 PM", not "04:45 PM").
const timeOf = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

function returnFocusToBell() {
  globalThis.document.querySelector<HTMLElement>(BELL_SELECTOR)?.focus({ preventScroll: true })
}

export function NotificationCentre() {
  const { focusId, open } = useStore($notificationCentre)

  if (!open) {
    return null
  }

  return createPortal(<CentrePanel focusId={focusId} />, document.body)
}

function CentrePanel({ focusId }: { focusId: null | string }) {
  const history = useStore($notificationHistory)
  const panelRef = useRef<HTMLElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const titleId = useId()

  // Own the right edge while open. Another island claiming it (FILES, the iNFT collection) closes the centre: one
  // island on the edge at a time.
  useEffect(() => {
    const release = claimRightEdge(EDGE_OWNER, CENTRE_WIDTH_CSS)
    const unwatch = watchRightEdge(EDGE_OWNER, closeNotificationCentre)

    return () => {
      unwatch()
      release()
    }
  }, [])

  // Opened by the owner (the bell, a toast, "More"): the reading position moves in; it goes back to the bell on close.
  // A layout effect, so the cleanup still sees the focus inside the panel before the panel leaves the document.
  useLayoutEffect(() => {
    const panel = panelRef.current

    titleRef.current?.focus({ preventScroll: true })

    return () => {
      if (panel?.contains(globalThis.document.activeElement)) {
        returnFocusToBell()
      }
    }
  }, [])

  // Esc closes (as the top app layer); a pointer down outside closes, except on the bell (it toggles) and the toasts.
  useEffect(() => {
    const release = pushEscapeLayer(CENTRE_ESCAPE_PRIORITY)

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !isTopEscapeLayer(CENTRE_ESCAPE_PRIORITY)) {
        return
      }

      event.preventDefault()
      closeNotificationCentre()
    }

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target

      if (
        target instanceof Node &&
        !panelRef.current?.contains(target) &&
        !(target instanceof Element && target.closest(KEEPS_OPEN))
      ) {
        closeNotificationCentre()
      }
    }

    globalThis.addEventListener('keydown', onKey)
    globalThis.document.addEventListener('pointerdown', onPointerDown, true)

    return () => {
      release()
      globalThis.removeEventListener('keydown', onKey)
      globalThis.document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [])

  const groups = groupEntries(history)
  const memoryId = useId()

  return (
    <aside aria-labelledby={titleId} className="icn-centre" data-testid="notification-centre" ref={panelRef}>
      <header className="icn-centre__head">
        <div>
          <h2 className="icn-centre__title" id={titleId} ref={titleRef} tabIndex={-1}>
            {f4Centre.title}
          </h2>
          {/* v0.0.9 r3 (r1 #8): where the history lives is a Tip on the count line, not two lines above the list. The
              words stay in the tree for assistive tech (the info button is described by them). */}
          <p className="icn-centre__count">
            {f4Centre.count(history.length)}
            <IcTip label={f4bCentre.memoryNote} side="bottom">
              <button
                aria-describedby={memoryId}
                aria-label={f4bCentre.memoryTipLabel}
                className="icn-centre__memory-tip"
                type="button"
              >
                <Info aria-hidden="true" size={13} />
              </button>
            </IcTip>
            <IcHiddenLabel id={memoryId}>
              <span data-testid="notification-centre-memory">{f4bCentre.memoryNote}</span>
            </IcHiddenLabel>
          </p>
        </div>
        <div className="icn-centre__clear">
          <IcPageButton disabled={history.length === 0} onClick={clearNotificationHistory} tone="quiet">
            {f4Centre.clearAll}
          </IcPageButton>
        </div>
        <div className="icn-centre__close">
          <IcIconAction label={f4Centre.close} onClick={closeNotificationCentre}>
            <X aria-hidden="true" size={14} />
          </IcIconAction>
        </div>
      </header>
      {history.length === 0 ? (
        <p className="icn-centre__empty">{f4Centre.empty}</p>
      ) : (
        <div className="icn-centre__list">
          {groups.map(group => (
            <section aria-label={f4Centre[group.key]} key={`${group.key}-${group.entries[0]?.id}`}>
              <h3 className="icn-centre__group">{f4Centre[group.key]}</h3>
              <ul className="m-0 list-none p-0">
                {group.entries.map(entry => (
                  <CentreEntry entry={entry} focused={entry.id === focusId} key={entry.id} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </aside>
  )
}

function CentreEntry({ entry, focused }: { entry: NotificationRecord; focused: boolean }) {
  const ref = useRef<HTMLLIElement>(null)
  const [detailOpen, setDetailOpen] = useState(focused)
  const hasDetail = Boolean(entry.detail && entry.detail !== entry.message)
  const idBase = useId()

  useEffect(() => {
    if (focused) {
      setDetailOpen(true)
      ref.current?.scrollIntoView?.({ block: 'nearest' })
    }
  }, [focused])

  return (
    <li
      aria-labelledby={`${idBase}-what`}
      className="icn-entry"
      data-focus={focused ? '' : undefined}
      data-kind={entry.kind}
      data-testid="notification-entry"
      ref={ref}
    >
      <SeverityIcon kind={entry.kind} />
      <div className="icn-text">
        <p className="icn-entry__time">
          {entry.read ? null : <span aria-hidden="true" className="icn-entry__unread" />}
          <time dateTime={new Date(entry.createdAt).toISOString()}>{timeOf(entry.createdAt)}</time>
          {entry.source === 'native' ? ` · ${f4Centre.fromNative}` : null}
        </p>
        {/* What happened · why · what to do: every word, never clamped (gate N2). */}
        <p className="icn-title" id={`${idBase}-what`}>
          {entry.title ?? entry.message}
          {entry.count && entry.count > 1 ? (
            <span className="icn-entry__count" data-testid="notification-count">
              {f4Centre.repeated(entry.count)}
            </span>
          ) : null}
        </p>
        {entry.title ? <p className="icn-body">{entry.message}</p> : null}
        {entry.meta ? <p className="icn-meta">{entry.meta}</p> : null}
        {entry.nextStep ? (
          <>
            <p className="icn-entry__label">{f4Centre.next}</p>
            <p className="icn-body">{entry.nextStep}</p>
          </>
        ) : null}
        {entry.action || hasDetail ? (
          <div className="icn-actions">
            {entry.action ? (
              <IcPageButton onClick={() => runNotificationAction(entry.id)} tone="note">
                {entry.action.label}
              </IcPageButton>
            ) : null}
            {hasDetail ? (
              <IcPageButton onClick={() => setDetailOpen(v => !v)} tone="quiet">
                {f4Centre.detail}
              </IcPageButton>
            ) : null}
          </div>
        ) : null}
        {hasDetail && detailOpen ? (
          <>
            <pre className="icn-detail" data-selectable-text="true" data-testid="notification-detail">
              {entry.detail}
            </pre>
            <div>
              <IcCopyButton
                errorMessage={f4Centre.copyDetailFailed}
                iconClassName="size-3"
                label={f4Centre.copyDetail}
                text={entry.detail ?? ''}
              >
                {f4Centre.copyDetail}
              </IcCopyButton>
            </div>
          </>
        ) : null}
      </div>
      <div className="icn-entry__remove">
        <IcIconAction label={f4Centre.remove} onClick={() => removeNotificationRecord(entry.id)}>
          <X aria-hidden="true" size={14} />
        </IcIconAction>
      </div>
    </li>
  )
}
