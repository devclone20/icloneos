/**
 * The Message window's head band — ONE band, BOTH views.
 *
 * OWNER DECISION(RESUME/contracts/M1_message_head_band.md):
 * "This top devision you have here in the message subsection with the name
 * 'iclone os', you have to put this top devision design also in the iT pane
 * also, aso we can have smooth transiction and others futures button there on
 * thet top". Until then the band was rendered in the chat view ONLY, and that
 * was deliberate: a fixed band over a terminal that starts at the window's top
 * edge covers the shell's first lines. The reason still holds, so the band is
 * only safe in iT because the terminal now starts at the band's bottom edge
 * (it-terminal.css follows the measured `--iwin-top`, as the sidebar does).
 *
 * The band is `pointer-events: none` (msg-sidebar.css) so the surface under it
 * keeps every click: the context button and its panel carry their own `auto`.
 */
import './msg-head.css'

import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import { useCallback, useEffect, useRef } from 'react'

import { BackgroundTasksPanel } from '@/app/background-tasks/panel'
import { useBackgroundTasksRuntime } from '@/app/background-tasks/runtime'
import { claimBandContextDoor } from '@/app/chat/composer/context-chip'
import { PRIMARY_SESSION_VIEW } from '@/app/chat/session-view'
import { ContextCard } from '@/app/context-panel/context-panel'
import { CONTEXT_PANEL_COPY } from '@/app/context-panel/context-panel.copy'
import { contextHeadline, formatTokens } from '@/app/context-panel/context-rows'
import { useContextUsage } from '@/app/context-panel/use-context-panel'
import { IcDot } from '@/components/ic/feedback'
import { useI18n } from '@/i18n'
import { Activity } from '@/lib/icons'
import { $backgroundBadge } from '@/store/background-tasks'

/** The window's title pill — the same markup as the econ windows' head. */
const HEAD_TITLE = 'iclone os'

/** No usage yet: a dash, the same in every language. */
const NO_USAGE = '—'

/** The ring's geometry: a 14px box, the cap height of the number beside it. */
const RING_RADIUS = 5.5
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

/**
 * The door's own ring. The card's `ContextRing` draws the same arc, but its
 * stylesheet strokes it from the old Hermes theme variables on block K's
 * negative list, which this window's theme does not take: same geometry, our
 * own tokens (msg-head.css). The card itself is mounted as it is — front G3
 * owns that file, so its paint is reported, never rewritten here.
 */
function ContextDoorRing({ percent }: { percent: number }) {
  const bounded = Math.max(0, Math.min(100, percent))

  return (
    <svg aria-hidden className="imsg-head__ctx-ring" height="14" viewBox="0 0 14 14" width="14">
      <circle className="imsg-head__ctx-ring-track" cx="7" cy="7" fill="none" r={RING_RADIUS} strokeWidth="2" />
      <circle
        className="imsg-head__ctx-ring-fill"
        cx="7"
        cy="7"
        fill="none"
        r={RING_RADIUS}
        strokeDasharray={RING_CIRCUMFERENCE}
        strokeDashoffset={RING_CIRCUMFERENCE * (1 - bounded / 100)}
        strokeLinecap="round"
        strokeWidth="2"
      />
    </svg>
  )
}

/** The doors on the band. At most one is open: opening one closes the other (V3-A, G7). */
type BandDoor = 'context' | 'tasks'

const $openBandDoor = atom<BandDoor | null>(null)

/**
 * One door's open/focus/Escape/outside-click contract, shared by every door on the band so a new button cannot
 * answer the keyboard differently from the context door it stands beside.
 */
function useBandDoor(name: BandDoor) {
  const open = useStore($openBandDoor) === name
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)

  const shut = useCallback(() => {
    if ($openBandDoor.get() === name) {
      $openBandDoor.set(null)
    }
  }, [name])

  // An unmounted door leaves nothing open behind it (a view switch, a test's cleanup).
  useEffect(() => shut, [shut])

  const close = useCallback(() => {
    shut()
    button.current?.focus()
  }, [shut])

  // A `role="dialog"` that never receives focus leaves a screen reader on the
  // button, reading nothing of what opened (r1 critic). The panel takes the
  // focus when it opens; Escape hands it back to the button, and an outside
  // click hands it back only when it was still INSIDE the panel (otherwise the
  // pointer already chose where focus goes, and stealing it back is worse).
  //
  // No `aria-modal`: nothing here is modal — the band is `pointer-events: none`
  // and the chat under it keeps every click, so claiming a modal would lie to
  // the screen reader about what is reachable (r2 critic minor, answered).
  useEffect(() => {
    if (open) {
      panel.current?.focus()
    }
  }, [open])

  useEffect(() => {
    if (!open) {
      return
    }

    // Capture phase: Escape and clicks are also the window's and iT's chords,
    // and the open panel is the innermost thing on screen — it answers first.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        close()
      }
    }

    const onPointerDown = (event: Event) => {
      const target = event.target as Node | null

      if (panel.current?.contains(target ?? null) || button.current?.contains(target ?? null)) {
        return
      }

      // The panel is about to be unmounted: a keyboard user parked inside it
      // would be left on a detached node (focus falls to <body>), so the door
      // takes the focus back. A pointer user who clicked elsewhere keeps the
      // focus their click just moved.
      const focusWasInside = !!panel.current?.contains(document.activeElement)

      shut()

      if (focusWasInside) {
        button.current?.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('pointerdown', onPointerDown, true)

    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [close, open, shut])

  const toggle = useCallback(() => (open ? close() : $openBandDoor.set(name)), [close, name, open])

  return { button, open, panel, toggle }
}

/**
 * The context-usage door (owner, same instruction): "in that top corner you
 * will put the context usage button, so when we click on it it will show all
 * the information as I ask". It opens the context card this app already has
 * (app/context-panel) — percent, used / max, the breakdown, context files,
 * free space, auto-compact and spend. Our own control and our own panel: the
 * composer's chip is built on Radix and `--ui-*`, which this window's theme
 * does not take.
 *
 * Usage is read from PRIMARY_SESSION_VIEW, never `useSessionView()`: the band
 * renders outside the chat provider tree, where the hook would quietly hand
 * back the default view and the numbers would never move.
 */
function ContextUsageButton() {
  const { t } = useI18n()
  const usage = useContextUsage(PRIMARY_SESSION_VIEW)
  const headline = contextHeadline(usage, null)
  const { button, open, panel, toggle } = useBandDoor('context')

  // One door per SURFACE (LEAD DECISION 2026-10-19 17:10, recorded in
  // gates/L/fronts.json): while this door is on the band, the composer's chip
  // of THAT surface stands down, so the owner never sees two rings on one
  // surface. The claim names the view this band covers — the window's primary
  // chat surface, the one the band is drawn over — so a session tile, which is
  // a second chat surface in the same document with its own view, keeps its
  // own chip: it is the only door to its own numbers (r2 critic, M1-r2-01).
  useEffect(() => claimBandContextDoor(PRIMARY_SESSION_VIEW), [])

  const percent = headline ? Math.round(headline.percent) : null

  const label =
    headline && percent !== null
      ? CONTEXT_PANEL_COPY.chipLabel(
          percent,
          formatTokens(headline.used, headline.estimated),
          formatTokens(headline.max)
        )
      : t.desktop.home.contextUsage

  return (
    <div className="imsg-head__ctx">
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={label}
        className="imsg-head__ctx-button"
        data-open={open ? '' : undefined}
        data-testid="msg-context-button"
        onClick={toggle}
        ref={button}
        type="button"
      >
        <ContextDoorRing percent={headline?.percent ?? 0} />
        <span className="imsg-head__ctx-value" data-testid="msg-context-percent">
          {percent === null ? NO_USAGE : `${percent}%`}
        </span>
      </button>
      {open && (
        <div
          aria-label={CONTEXT_PANEL_COPY.title}
          className="imsg-head__ctx-panel"
          data-testid="msg-context-panel"
          ref={panel}
          role="dialog"
          tabIndex={-1}
        >
          <ContextCard open={open} view={PRIMARY_SESSION_VIEW} />
        </div>
      )}
    </div>
  )
}

/**
 * The Background tasks door (V3-A; owner: "o botão ao lado do botão do contexto … aonde ele mostra atividades em
 * segundo plano"). The number is running + waiting, folded from the live registry — never a counter — and a task
 * that died while nobody looked carries its own mark until the owner opens it. Same pill, same panel chassis and
 * same keyboard contract as the context door beside it.
 */
function BackgroundTasksButton() {
  const copy = useI18n().t.backgroundTasks
  const badge = useStore($backgroundBadge)
  const { button, open, panel, toggle } = useBandDoor('tasks')

  useBackgroundTasksRuntime()

  return (
    <div className="imsg-head__bg">
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={copy.doorLabel(badge.active, badge.diedUnseen)}
        className="imsg-head__ctx-button"
        data-open={open ? '' : undefined}
        data-testid="msg-tasks-button"
        onClick={toggle}
        ref={button}
        type="button"
      >
        <Activity aria-hidden className="imsg-head__bg-glyph" size={14} />
        {badge.active > 0 ? (
          <span className="imsg-head__bg-count" data-testid="msg-tasks-count">
            {badge.active}
          </span>
        ) : null}
        {badge.diedUnseen > 0 ? (
          <span data-testid="msg-tasks-died-mark">
            <IcDot tone="danger" />
          </span>
        ) : null}
      </button>
      {open && (
        <div
          aria-label={copy.title}
          className="imsg-head__ctx-panel"
          data-testid="msg-tasks-panel"
          ref={panel}
          role="dialog"
          tabIndex={-1}
        >
          <BackgroundTasksPanel />
        </div>
      )}
    </div>
  )
}

/**
 * The band itself. `view` only decides what sits ON it — never whether it is
 * there: the band, its classes and its title are identical in chat and iT so
 * the switch is a crossfade of the body alone (owner: "smooth transiction").
 */
export function MsgHead({ expanded, view }: { expanded: boolean; view: 'chat' | 'it' }) {
  return (
    // Expanded, the head starts after the macOS window buttons, as the econ
    // head does (ic-window.css `.ic-win[data-expanded]`).
    <header
      className="ic-win__head iecon__head imsg-head ic-tone--message"
      data-expanded={expanded ? '' : undefined}
      data-view={view}
    >
      <h2>{HEAD_TITLE}</h2>
      {/* The right-hand cluster. Background tasks stands in BOTH views (owner
          decision O1: iT's panes report here too); the context ring is chat
          only — iT has no chat session to report. */}
      <div className="imsg-head__tools">
        <BackgroundTasksButton />
        {view === 'chat' && <ContextUsageButton />}
      </div>
    </header>
  )
}
