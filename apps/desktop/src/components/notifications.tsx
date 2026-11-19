import './notification-system.css'

import { useStore } from '@nanostores/react'
import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
  type WheelEvent
} from 'react'
import { createPortal } from 'react-dom'

import { IcIconAction } from '@/components/ic/controls'
import { IcAlert, IcPageButton } from '@/components/ic/ic-page'
import { prefersReducedMotion } from '@/hooks/use-media-query'
import { f4Notes } from '@/i18n/en/v009-f4'
import { triggerHaptic } from '@/lib/haptics'
import { X } from '@/lib/icons'
import {
  $notifications,
  $toastOverflow,
  type AppNotification,
  dismissNotification,
  type NotificationKind,
  openNotificationCentre,
  pauseNotification,
  resumeNotification
} from '@/store/notifications'

import { NativeDecisionHost } from './native-decision-host'
import { NotificationCentre } from './notification-centre'
import { accentStyle, SeverityIcon } from './notification-glyph'

/**
 * v0.0.9 F4 — type 1, the toast: one stack at the bottom right, at most three, the rest "+N in Notifications".
 * A toast says what happened (title) and why (message) in at most three lines; "More" — or a click anywhere on it —
 * opens its entry in the notification centre, where nothing is cut. Hover or focus pauses it; ✕ and Esc (with focus
 * inside) and a swipe to the right close it, with a 120 ms exit (0 ms under reduced motion); errors stay until closed
 * (store/notifications.ts).
 */

/** Past this many characters a toast's words may need more than three lines: "More" is always offered. */
export const MORE_THRESHOLD = 150

export function needsMore(notification: Pick<AppNotification, 'detail' | 'message' | 'nextStep'>): boolean {
  return (
    notification.message.length > MORE_THRESHOLD ||
    Boolean(notification.nextStep) ||
    Boolean(notification.detail && notification.detail !== notification.message)
  )
}

/**
 * v0.0.9 F4b — the exit. A toast that leaves the store (✕, Esc, swipe, its timer, the stack cap) stays painted for
 * `--ic-dur-fast` (120 ms) with `data-leaving` so the CSS can play the exit; under reduced motion it goes at once
 * (0 ms). A leaving toast is inert and hidden from assistive tech: it is already gone for everyone but the eye.
 */
export const TOAST_EXIT_MS = 120

/** The exit length right now: the OS setting is read as the exit starts (it can flip mid-session). */
export const toastExitMs = () => (prefersReducedMotion() ? 0 : TOAST_EXIT_MS)

/** A horizontal drag (pointer) or two-finger swipe (trackpad wheel) this far closes the toast. */
export const SWIPE_CLOSE_PX = 72

export function swipeCloses(distancePx: number): boolean {
  return Math.abs(distancePx) >= SWIPE_CLOSE_PX
}

/** The stack's own bottom padding (notification-system.css `.icn-stack`): the toasts' painted edge sits this far up. */
const STACK_PAD_BOTTOM_PX = 24
/** The CSS `bottom` of the stack at rest. */
const STACK_BASE_BOTTOM_PX = 4
/** Air between the lowest toast and the composer's top edge. */
const COMPOSER_GAP_PX = 8

interface RectLike {
  bottom: number
  left: number
  right: number
  top: number
}

/**
 * v0.0.9 critic m4 / design 3: how far the stack lifts so no toast covers a composer. Every visible composer whose
 * columns overlap the stack's columns pushes the lowest toast above its top edge (plus a gap); none = 0 (the corner).
 * Pure; `composers` are viewport rects, `stack` is the stack's own rect, `viewportHeight` is `innerHeight`.
 */
export function stackLiftPx(composers: readonly RectLike[], stack: RectLike, viewportHeight: number): number {
  let lift = 0

  for (const rect of composers) {
    const overlapsColumns = rect.right > stack.left && rect.left < stack.right
    const visible = rect.bottom > 0 && rect.top < viewportHeight && rect.bottom > rect.top

    if (!overlapsColumns || !visible) {
      continue
    }

    const needed = viewportHeight - rect.top + COMPOSER_GAP_PX - STACK_PAD_BOTTOM_PX - STACK_BASE_BOTTOM_PX

    lift = Math.max(lift, Math.ceil(needed))
  }

  return Math.max(0, Math.min(lift, Math.max(0, viewportHeight - 160)))
}

/** The composer roots on screen (chat, panes, the HUD): `[data-slot="composer-root"]`. */
const COMPOSER_SELECTOR = '[data-slot="composer-root"]'
/** While a toast is up, the composer can move under it (a pane opens, the thread view mounts): look again this often. */
const COMPOSER_RECHECK_MS = 750

function useComposerLift(active: boolean) {
  const stackRef = useRef<HTMLDivElement | null>(null)
  const [lift, setLift] = useState(0)

  useEffect(() => {
    if (!active) {
      setLift(0)

      return
    }

    const measure = () => {
      const stack = stackRef.current

      if (!stack) {
        return
      }

      const composers = [...document.querySelectorAll<HTMLElement>(COMPOSER_SELECTOR)].map(node =>
        node.getBoundingClientRect()
      )

      setLift(stackLiftPx(composers, stack.getBoundingClientRect(), window.innerHeight))
    }

    measure()
    window.addEventListener('resize', measure)
    const timer = window.setInterval(measure, COMPOSER_RECHECK_MS)

    return () => {
      window.removeEventListener('resize', measure)
      window.clearInterval(timer)
    }
  }, [active])

  return { lift, stackRef }
}

export interface ToastPresence {
  leaving: boolean
  notification: AppNotification
}

/**
 * The painted list: the store's toasts (newest first, as the store orders them) plus, when the exit animates, the
 * ones that just left, kept at the place they held. A leaving toast whose id comes back is live again (same id = one).
 */
export function mergeToastPresence(
  current: readonly AppNotification[],
  previous: readonly ToastPresence[],
  animate: boolean
): ToastPresence[] {
  const out: ToastPresence[] = current.map(notification => ({ leaving: false, notification }))

  if (!animate) {
    return out
  }

  const live = new Set(current.map(n => n.id))

  previous.forEach((entry, index) => {
    if (!live.has(entry.notification.id)) {
      out.splice(Math.min(index, out.length), 0, { leaving: true, notification: entry.notification })
    }
  })

  return out
}

function useToastPresence(notifications: AppNotification[]): ToastPresence[] {
  const [source, setSource] = useState(notifications)
  const [rendered, setRendered] = useState<ToastPresence[]>(() => mergeToastPresence(notifications, [], false))
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  // Derived during render (not in an effect) so a leaving toast never blinks out for a frame before its exit.
  if (source !== notifications) {
    setSource(notifications)
    setRendered(previous => mergeToastPresence(notifications, previous, toastExitMs() > 0))
  }

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (timer bookkeeping)
  useEffect(() => {
    const timers = timersRef.current

    for (const entry of rendered) {
      const id = entry.notification.id

      if (!entry.leaving) {
        // Back from leaving (same id re-notified): its pending removal must not take the live toast.
        const pending = timers.get(id)

        if (pending !== undefined) {
          clearTimeout(pending)
          timers.delete(id)
        }

        continue
      }

      if (!timers.has(id)) {
        timers.set(
          id,
          setTimeout(() => {
            timers.delete(id)
            setRendered(list => list.filter(e => !(e.leaving && e.notification.id === id)))
          }, TOAST_EXIT_MS)
        )
      }
    }
  }, [rendered])

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref read on unmount
  useEffect(() => {
    const timers = timersRef.current

    return () => {
      for (const timer of timers.values()) {
        clearTimeout(timer)
      }

      timers.clear()
    }
  }, [])

  return rendered
}

export function NotificationStack() {
  const notifications = useStore($notifications)
  const overflow = useStore($toastOverflow)
  const painted = useToastPresence(notifications)
  const lastNotificationIdRef = useRef<string | null>(null)
  const { lift, stackRef } = useComposerLift(painted.length > 0)

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    const latest = notifications[0]

    if (!latest || latest.id === lastNotificationIdRef.current) {
      return
    }

    lastNotificationIdRef.current = latest.id

    if (latest.kind === 'success') {
      triggerHaptic('success')
    } else if (latest.kind === 'error') {
      triggerHaptic('error')
    } else if (latest.kind === 'warning') {
      triggerHaptic('warning')
    }
  }, [notifications])

  return (
    <>
      {painted.length > 0
        ? createPortal(
            <div
              aria-label={f4Notes.region}
              className="icn-stack"
              data-composer-lift={lift > 0 ? '' : undefined}
              data-testid="toast-stack"
              ref={stackRef}
              role="region"
              style={lift > 0 ? ({ '--icn-stack-lift': `${lift}px` } as CSSProperties) : undefined}
            >
              {overflow > 0 ? (
                <button className="icn-overflow" onClick={() => openNotificationCentre()} type="button">
                  {f4Notes.overflow(overflow)}
                </button>
              ) : null}
              {/* Oldest first, so the newest sits nearest the corner. */}
              {[...painted].reverse().map(({ leaving, notification: n }) => (
                <NotificationItem key={n.id} leaving={leaving} notification={n} />
              ))}
            </div>,
            document.body
          )
        : null}
      <NotificationCentre />
      <NativeDecisionHost />
    </>
  )
}

const isControl = (target: EventTarget | null) =>
  target instanceof Element && target.closest('button, a, input, textarea, select, [role="button"]') !== null

/** The live swipe offset rides a custom property; the CSS turns it into translateX + a fade (tokens only there). */
const swipeStyle = (dx: number): CSSProperties | undefined =>
  dx > 0 ? ({ '--icn-swipe-x': `${Math.round(dx)}px` } as CSSProperties) : undefined

function NotificationItem({ leaving, notification }: { leaving: boolean; notification: AppNotification }) {
  const ref = useRef<HTMLDivElement>(null)
  const hoveredRef = useRef(false)
  // Swipe: the pointer drag in flight (start x + pointer id), the live offset, and a latch so the click that ends a
  // drag never opens the entry. The trackpad's two-finger swipe arrives as horizontal wheel deltas instead.
  const dragRef = useRef<{ pointerId: number; startX: number } | null>(null)
  const draggedRef = useRef(false)
  const wheelRef = useRef<{ at: number; dx: number }>({ at: 0, dx: 0 })
  const [swipeX, setSwipeX] = useState(0)
  const [swiped, setSwiped] = useState(false)
  const more = needsMore(notification)
  const id = notification.id

  const close = () => {
    const stack = ref.current?.closest('.icn-stack')
    const focusWasInside = Boolean(ref.current?.contains(globalThis.document.activeElement))

    dismissNotification(id)

    // Esc / ✕ from the keyboard: the reading position moves to the next toast instead of falling to <body>.
    if (focusWasInside) {
      globalThis.requestAnimationFrame?.(() => {
        stack?.querySelector<HTMLElement>('.icn-toast:not([data-leaving])')?.focus({ preventScroll: true })
      })
    }
  }

  const swipeAway = () => {
    setSwiped(true)
    close()
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || isControl(event.target)) {
      return
    }

    dragRef.current = { pointerId: event.pointerId, startX: event.clientX }
    draggedRef.current = false
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current

    if (!drag || drag.pointerId !== event.pointerId) {
      return
    }

    // Only toward the edge the stack sits on (right); a drag back left rests at 0.
    const dx = Math.max(0, event.clientX - drag.startX)

    if (dx > 4 && !draggedRef.current) {
      draggedRef.current = true
      event.currentTarget.setPointerCapture?.(event.pointerId)
    }

    setSwipeX(dx)
  }

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current

    if (!drag || drag.pointerId !== event.pointerId) {
      return
    }

    dragRef.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)

    if (event.type === 'pointerup' && swipeCloses(event.clientX - drag.startX) && event.clientX > drag.startX) {
      swipeAway()

      return
    }

    setSwipeX(0)
  }

  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    // A horizontal two-finger swipe; vertical wheel scrolls the stack as before. Deltas older than 300 ms start over.
    if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) {
      return
    }

    const now = Date.now()
    const acc = now - wheelRef.current.at > 300 ? 0 : wheelRef.current.dx

    wheelRef.current = { at: now, dx: acc + event.deltaX }

    if (swipeCloses(wheelRef.current.dx)) {
      wheelRef.current = { at: 0, dx: 0 }
      swipeAway()
    }
  }

  const openEntry = () => {
    dismissNotification(id)
    openNotificationCentre(id)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()

      return
    }

    if (event.key === 'Enter' && event.target === event.currentTarget) {
      event.preventDefault()
      openEntry()
    }
  }

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    if (draggedRef.current) {
      draggedRef.current = false

      return
    }

    if (!isControl(event.target)) {
      openEntry()
    }
  }

  // Leaving: painted for the exit only — no handlers, no focus, not announced.
  if (leaving) {
    return (
      <div
        aria-hidden="true"
        className="icn-toast"
        data-accent={notification.accentColor ? '' : undefined}
        data-kind={notification.kind}
        data-leaving=""
        data-slot="ic-toast"
        data-swiped={swiped ? '' : undefined}
        data-testid="toast-leaving"
        inert
        style={{ ...accentStyle(notification.accentColor), ...swipeStyle(swipeX) }}
      >
        <SeverityIcon icon={notification.icon} kind={notification.kind} />
        <div className="icn-text">
          {notification.title ? <p className="icn-title">{notification.title}</p> : null}
          <p className="icn-body" data-clamp={more ? '' : undefined}>
            {notification.message}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div
      aria-describedby={`${id}-body`}
      aria-labelledby={notification.title ? `${id}-title` : `${id}-body`}
      className="icn-toast"
      data-accent={notification.accentColor ? '' : undefined}
      data-kind={notification.kind}
      data-slot="ic-toast"
      data-swiping={swipeX > 0 ? '' : undefined}
      data-testid="toast"
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null) && !hoveredRef.current) {
          resumeNotification(id)
        }
      }}
      onClick={onClick}
      onFocus={() => pauseNotification(id)}
      onKeyDown={onKeyDown}
      onMouseEnter={() => {
        hoveredRef.current = true
        pauseNotification(id)
      }}
      onMouseLeave={event => {
        hoveredRef.current = false

        if (!event.currentTarget.contains(globalThis.document.activeElement)) {
          resumeNotification(id)
        }
      }}
      onPointerCancel={endDrag}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onWheel={onWheel}
      ref={ref}
      role={notification.kind === 'error' ? 'alert' : 'status'}
      style={{ ...accentStyle(notification.accentColor), ...swipeStyle(swipeX) }}
      tabIndex={0}
    >
      <SeverityIcon icon={notification.icon} kind={notification.kind} />
      <div className="icn-text">
        {notification.title ? (
          <p className="icn-title" id={`${id}-title`}>
            {notification.title}
          </p>
        ) : null}
        <p className="icn-body" data-clamp={more ? '' : undefined} id={`${id}-body`}>
          {notification.message}
        </p>
        {notification.meta ? <p className="icn-meta">{notification.meta}</p> : null}
        {more || notification.action ? (
          <div className="icn-actions">
            {notification.action ? (
              <IcPageButton
                onClick={() => {
                  notification.action?.onClick()
                  dismissNotification(id)
                }}
                tone="note"
              >
                {notification.action.label}
              </IcPageButton>
            ) : null}
            {more ? (
              <IcPageButton onClick={openEntry} tone="quiet">
                {f4Notes.more}
              </IcPageButton>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="icn-close">
        <IcIconAction label={f4Notes.close} onClick={close}>
          <X aria-hidden="true" size={14} />
        </IcIconAction>
      </div>
    </div>
  )
}

/**
 * Type 3 under its old name: an inline notice is the inline alert (IcAlert). Kept for the model picker's two call
 * sites; new code uses IcAlert directly.
 */
export function InlineNotice({
  kind = 'info',
  title,
  children,
  className
}: {
  kind?: NotificationKind
  title?: string
  children: ReactNode
  className?: string
}) {
  return (
    <IcAlert className={className} title={title} tone={kind}>
      {children}
    </IcAlert>
  )
}
