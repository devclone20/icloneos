import './dock.css'

import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState
} from 'react'

import { useMediaQuery } from '@/hooks/use-media-query'
import { useI18n } from '@/i18n'

import { useDockAutoHide } from './dock-autohide'

export interface DockItem {
  id: string
  /** Tooltip text, e.g. 'Settings'. Also doubles as the button's aria-label. */
  label: string
  /** A lucide icon element (or any glyph) sized by the caller to fit 20–22px. */
  icon: ReactNode
  onSelect: () => void
  active?: boolean
  /** A small count on the tile's corner — unread mail, open jobs, codes waiting. */
  badge?: number | string
  /** The keyboard chord that opens it, already formatted for display (⌘⇧2). */
  hint?: string
  /** Optional brand tone (`ic-tone--<tone>`, ic-tokens.css): a toned TILE wears it as frosted material glass with a
   *  glow; untoned tiles are the dock's plain frosted glass. Every symbol is heavy night ink (owner design). */
  tone?: string
}

interface DockProps {
  items: DockItem[]
}

// Geometry — mirrors the rail's own CSS (dock.css) so JS-measured centers
// line up with painted icon positions without a DOM read per icon.
const ICON_SIZE = 44
const GAP = 8
const RAIL_PADDING = 10

// Raised-cosine magnification (macOS Dock model): influence radius and peak scale.
//
// The radius is NOT a free taste knob. A raised cosine of full width 2R sampled on a lattice of pitch d sums to a
// CONSTANT when 2R is a whole multiple (>= 2) of d (its spectrum is zero at every k/d), so with R = 3 pitches the
// row's total growth never changes as the pointer moves inside it: icons only redistribute around the pointer, as on
// macOS. That constancy is what decouples the slide (whose anchor carries grown/2) from the lagging scale springs.
// Measured A/B on the live dock: R = 140 (growth ripple only 0.6 px statically, but coupled through the springs)
// gave rail jerk up to 16 px/frame² on sweeps — the owner's "vibrations and jumps"; R = 156 gives ~2.
const INFLUENCE_RADIUS = 3 * (ICON_SIZE + GAP)
const MAX_SCALE = 1.7

// A press may release this far outside the tile's live box and still count —
// the finger drifts a few px between down and up, and a magnified tile is
// still animating under it.
const PRESS_SLACK_PX = 10

// The settle. This USED to hand-integrate a mass-spring (mass 0.1, stiffness
// 170, damping 12) with semi-implicit Euler, which is only stable while
// dt < 2m/c = 16.7 ms: it sits exactly ON the boundary at 60 Hz and diverges
// below it. Measured on that integrator — 60 Hz: velocity multiplier -1.0, a
// displaced tile reaches 4e39; 30 Hz (this file's own MAX_DT): 3e262. On screen
// that is a tile scaled to -91 and a rail thousands of pixels wide after one
// long frame, which is exactly what a backgrounded window hands it.
//
// This is the analytic solution of a critically damped spring: exact at any
// step, unconditionally stable, frame-rate independent. OMEGA is tuned to the
// same feel (~250 ms to rest, zero overshoot).
const SPRING_OMEGA = 26
const MAX_DT_SECONDS = 1 / 12
const SETTLE_EPSILON = 0.002
// The SLIDE rides its own critically damped spring (owner: "fast passes look crispy and jump"). Its target follows
// the pointer instantly, so it used to step whole pixels per event on a fast pass and snap to 0 on exit while the
// row was still shrinking. Slightly stiffer than the scale spring so the hovered icon stays under the pointer.
const SHIFT_OMEGA = 34
const SHIFT_EPSILON = 0.05

interface SpringAxis {
  value: number
  velocity: number
}

interface IconPhysics {
  scale: SpringAxis
}

function createPhysics(): IconPhysics {
  return {
    scale: { value: 1, velocity: 0 }
  }
}

/**
 * One EXACT step of a critically damped spring toward `target`. Mutates `axis`
 * in place (called once per icon per frame; allocating here would be
 * 2 * items.length garbage every 16ms while the pointer is inside the dock).
 * Returns true once this axis has arrived.
 */
function stepSpring(
  axis: SpringAxis,
  target: number,
  dt: number,
  omega = SPRING_OMEGA,
  epsilon = SETTLE_EPSILON
): boolean {
  const decay = Math.exp(-omega * dt)
  const delta = axis.value - target
  const term = (axis.velocity + omega * delta) * dt

  axis.value = target + (delta + term) * decay
  axis.velocity = (axis.velocity - omega * term) * decay

  if (Math.abs(axis.value - target) < epsilon && Math.abs(axis.velocity) < epsilon) {
    axis.value = target
    axis.velocity = 0

    return true
  }

  return false
}

// THE ZONE. Tracking used to follow the rail's own pointerenter/leave, but the
// rail's box is the OUTPUT of the magnification: approach from below, the row
// grows and the slide lifts the bottom edge past the pointer, `pointerleave`
// drops every target, the row shrinks back under the pointer, `pointerenter`
// fires — the whole dock vibrated at frame rate on its edges. macOS decides
// "in the dock" from the UNDEFORMED dock, with a release margin. So does this:
// the zone is the rest rail (its centre is pinned by CSS), entered at its
// edge and left only HYSTERESIS_PX beyond it (plus the pop-out reach to the
// right while active), so no frame of magnification can move the decision.
const HYSTERESIS_PX = 14

interface DockZone {
  bottom: number
  left: number
  right: number
  top: number
}

/** The rest rail's box: left edge as laid out, centre pinned at mid-viewport. */
export function restDockZone(left: number, viewportHeight: number, count: number): DockZone {
  const height = count * ICON_SIZE + Math.max(0, count - 1) * GAP + 2 * RAIL_PADDING
  const top = viewportHeight / 2 - height / 2

  return { bottom: top + height, left, right: left + ICON_SIZE + 2 * RAIL_PADDING, top }
}

/** Enter at the zone's edge; once active, leave only past the hysteresis (and the magnified pop-out to the right). */
export function dockZoneContains(zone: DockZone, x: number, y: number, active: boolean): boolean {
  const margin = active ? HYSTERESIS_PX : 0
  const reach = active ? (MAX_SCALE - 1) * ICON_SIZE : 0

  return (
    x >= zone.left - margin && x <= zone.right + reach + margin && y >= zone.top - margin && y <= zone.bottom + margin
  )
}

/** u = clamp(|d|/R, 0, 1); scale = 1 + (M-1)*0.5*(1+cos(pi*u)) -> M at d=0, 1 at |d|>=R. */
function targetScaleForDistance(distance: number): number {
  const u = Math.min(Math.abs(distance) / INFLUENCE_RADIUS, 1)

  return 1 + (MAX_SCALE - 1) * 0.5 * (1 + Math.cos(Math.PI * u))
}

/** Total row growth in px for a pointer at rest offset `y` over `count` icons (tests the no-breathing property). */
export function totalGrowthForTest(count: number, y: number): number {
  let sum = 0

  for (let i = 0; i < count; i++) {
    sum += (targetScaleForDistance(y - (i * (ICON_SIZE + GAP) + ICON_SIZE / 2)) - 1) * ICON_SIZE
  }

  return sum
}

/**
 * Hands keyboard focus back to the tile that opened a window once the window
 * has left the DOM: a focused Close control unmounts with it and the browser
 * drops focus to <body>, while the tile is still here. Next frame, because the
 * close is a state or route change and the window must unmount first.
 */
export function focusDockTile(id: string): void {
  requestAnimationFrame(() => {
    document.querySelector<HTMLElement>(`.dock__icon[data-dock="${id}"]`)?.focus({ preventScroll: true })
  })
}

/**
 * Lets go of a focus a Dock tile still holds. The Dock tucks away only without keyboard focus within (dock.css), and
 * a tile keeps it across a press (the focus moves to the pressed tile) or after a window closed (focusDockTile): a
 * window that opens filling the app must take it, or the Dock stays over the window. A focus anywhere else (a
 * field's caret, a window's own controls) is never touched.
 */
export function releaseDockFocus(): void {
  const active = document.activeElement

  if (active instanceof HTMLElement && active.closest('.dock')) {
    active.blur()
  }
}

export function Dock({ items }: DockProps) {
  const { t } = useI18n()
  const railRef = useRef<HTMLElement>(null)
  const itemRefs = useRef<Array<HTMLDivElement | null>>([])
  const physicsRef = useRef<IconPhysics[]>([])
  const pointerYRef = useRef<number | null>(null)
  // How far the rail is currently slid, so the next frame can read its anchor
  // without the slide in it.
  const shiftRef = useRef(0)
  const shiftAxisRef = useRef<SpringAxis>({ value: 0, velocity: 0 })
  const rafRef = useRef<number | null>(null)
  const lastFrameTimeRef = useRef(0)
  const [isTracking, setIsTracking] = useState(false)
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const { autoHide, revealed } = useDockAutoHide(railRef)

  // Keep the physics/ref arrays sized to `items`, without resetting entries
  // that survive a re-render (stable id order keeps its spring state). Ref
  // bookkeeping tied to render inputs is done inline during render, not in
  // an effect — it doesn't affect this render's output, and staging it
  // through an effect would leave the physics array one render stale for
  // the very first frame after `items` changes.
  if (physicsRef.current.length !== items.length) {
    physicsRef.current = items.map((_, i) => physicsRef.current[i] ?? createPhysics())
  }

  itemRefs.current.length = items.length

  const writeRestingVars = useCallback(() => {
    for (const p of physicsRef.current) {
      p.scale.value = 1
      p.scale.velocity = 0
    }

    for (const el of itemRefs.current) {
      el?.style.removeProperty('--s')
    }

    shiftAxisRef.current = { value: 0, velocity: 0 }
    shiftRef.current = 0
    railRef.current?.style.removeProperty('--dock-shift')
  }, [])

  const stopLoop = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }

    setIsTracking(false)
  }, [])

  const tick = useCallback(
    (now: number) => {
      const last = lastFrameTimeRef.current || now
      const dt = Math.min((now - last) / 1000, MAX_DT_SECONDS)
      lastFrameTimeRef.current = now

      const rail = railRef.current
      const pointerY = pointerYRef.current
      const physics = physicsRef.current
      const count = physics.length

      if (!rail) {
        stopLoop()

        return
      }

      // Centers come from the REST row, not the live one.
      //
      // Icons grow in LAYOUT here (.dock__item height is scale * 44px), and
      // the rail is centered on the screen (top: 50%; translate: 0 -50%), so
      // reading the current sizes feeds the curve its own output twice over:
      // the hovered item grows and its center slides away from the pointer,
      // while the whole rail creeps upward at the same time. The peak then
      // walks off the icon the pointer is on. macOS has no such drift because
      // the magnification is a function of the pointer's place in the
      // UNDEFORMED dock. So is this one.
      //
      // The rail's CENTER is what the CSS pins, and growth is symmetric about
      // it, so the rest row can be derived exactly with no cached state:
      // one rect read per frame, same as before.
      const rect = rail.getBoundingClientRect()
      const restHeight = count * ICON_SIZE + Math.max(0, count - 1) * GAP + 2 * RAIL_PADDING
      // Undo the slide before reading the anchor: the rail is translated by
      // --dock-shift, so its live box already carries it. Feeding that back in
      // would make the anchor chase its own output.
      const top = rect.top + rect.height / 2 - shiftRef.current - restHeight / 2 + RAIL_PADDING
      const centers = new Array<number>(count)

      for (let i = 0; i < count; i++) {
        centers[i] = top + i * (ICON_SIZE + GAP) + ICON_SIZE / 2
      }

      let allSettled = true

      for (let j = 0; j < count; j++) {
        const target = pointerY == null ? 1 : targetScaleForDistance(pointerY - centers[j])

        if (!stepSpring(physics[j].scale, target, dt)) {
          allSettled = false
        }

        itemRefs.current[j]?.style.setProperty('--s', physics[j].scale.value.toFixed(4))
      }

      // Slide the rail so the icon the pointer is on stays UNDER the pointer.
      // Targets come from the rest row, which is what keeps the peak on the
      // icon you aimed at; without this the row would then grow that icon out
      // from under your cursor. A MacBook dock opens AROUND the cursor, and
      // this is that. Bounded by the row's own growth, so it cannot run away.
      let shiftTarget = 0

      if (pointerY != null) {
        const u = pointerY - top // the pointer, in rest pixels from the first icon's edge
        let rest = 0
        let live = 0
        let shift = 0

        for (let i = 0; i < count; i++) {
          const cell = ICON_SIZE + (i < count - 1 ? GAP : 0)
          const liveCell = physics[i].scale.value * ICON_SIZE + (i < count - 1 ? GAP : 0)

          if (u < rest + cell || i === count - 1) {
            shift = u - (live + (cell > 0 ? (u - rest) / cell : 0) * liveCell)

            break
          }

          rest += cell
          live += liveCell
        }

        const grown = physics.reduce((a, p) => a + p.scale.value * ICON_SIZE, 0) - count * ICON_SIZE

        // The CSS centres the LIVE rail (translate -50%), so growth already moved its top up by grown/2; the
        // anchor must add that back or the hovered icon sits grown/2 (~40 px) off the pointer and slides as
        // the pointer moves — the "jumps". With it, the point under the pointer stays exactly under it:
        // over the first icon the row opens downward, over the last upward, in between around the cursor.
        shiftTarget = Math.max(-grown / 2, Math.min(grown / 2, shift + grown / 2))
      }

      // Away from the pointer the target is 0 and the slide eases home with the shrinking row — no snap.
      if (!stepSpring(shiftAxisRef.current, shiftTarget, dt, SHIFT_OMEGA, SHIFT_EPSILON)) {
        allSettled = false
      }

      shiftRef.current = shiftAxisRef.current.value

      if (shiftRef.current === 0) {
        rail.style.removeProperty('--dock-shift')
      } else {
        rail.style.setProperty('--dock-shift', `${shiftRef.current.toFixed(2)}px`)
      }

      if (!allSettled || pointerY != null) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        stopLoop()
      }
    },
    [stopLoop]
  )

  const startLoop = useCallback(() => {
    if (rafRef.current != null) {
      return
    }

    setIsTracking(true)
    lastFrameTimeRef.current = 0
    rafRef.current = requestAnimationFrame(tick)
  }, [tick])

  // The pointer is read at window level and judged against the rest zone (see THE ZONE), never by the rail's
  // own enter/leave, whose box moves with the magnification.
  const activeRef = useRef(false)

  const handlePointerLeave = useCallback(() => {
    // Targets snap to rest; the loop (already running) keeps ticking until
    // every spring settles, then stops itself — no CSS transition mid-track.
    activeRef.current = false
    pointerYRef.current = null
  }, [])

  const handleWindowPointerMove = useCallback(
    (event: PointerEvent) => {
      const rail = railRef.current

      if (!rail) {
        return
      }

      const zone = restDockZone(rail.offsetLeft, window.innerHeight, physicsRef.current.length)

      if (dockZoneContains(zone, event.clientX, event.clientY, activeRef.current)) {
        activeRef.current = true
        pointerYRef.current = event.clientY
        startLoop()
      } else if (activeRef.current) {
        handlePointerLeave()
      }
    },
    [handlePointerLeave, startLoop]
  )

  // The pointer left the window entirely (no relatedTarget): release.
  const handleWindowPointerOut = useCallback(
    (event: PointerEvent) => {
      if (!event.relatedTarget && activeRef.current) {
        handlePointerLeave()
      }
    },
    [handlePointerLeave]
  )

  useEffect(() => {
    if (reducedMotion) {
      return
    }

    window.addEventListener('pointermove', handleWindowPointerMove, { passive: true })
    document.addEventListener('pointerout', handleWindowPointerOut)

    return () => {
      window.removeEventListener('pointermove', handleWindowPointerMove)
      document.removeEventListener('pointerout', handleWindowPointerOut)
    }
  }, [handleWindowPointerMove, handleWindowPointerOut, reducedMotion])

  // Reduced motion can flip on mid-track (OS setting change); drop straight
  // to rest and stop driving transforms.
  useEffect(() => {
    if (!reducedMotion) {
      return
    }

    handlePointerLeave()
    stopLoop()
    writeRestingVars()
  }, [reducedMotion, handlePointerLeave, stopLoop, writeRestingVars])

  useEffect(() => {
    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current)
      }
    }
  }, [])

  // THE PRESS. A tile is a moving target: the row magnifies and slides under the pointer, and the old CSS `:active`
  // even swapped the tile's transform on mousedown, so the element under the pointer at pointerup was often another
  // one and the browser's `click` (down and up on the SAME element) never fired — the owner measured "four clicks to
  // open". So the tile captures the pointer on down and decides on up: a release inside its live box (plus slack)
  // selects, a drag-off release does not, as in the macOS Dock. `click` stays only for keyboard and programmatic
  // activation (detail 0). Down's `preventDefault` also cancels the focus move, so a focus left on a tile moves to
  // the pressed one (its tooltip and Space follow); focus outside the dock (a field's caret) is never taken.
  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) {
      return
    }

    event.preventDefault()
    const focused = event.currentTarget.ownerDocument.activeElement

    if (railRef.current?.contains(focused)) {
      event.currentTarget.focus({ preventScroll: true })
    }

    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // A synthetic pointer (tests) may refuse capture; the release check still works over the tile.
    }

    event.currentTarget.dataset.pressed = ''
  }, [])

  const handlePointerUp = useCallback(
    (index: number) => (event: ReactPointerEvent<HTMLButtonElement>) => {
      const tile = event.currentTarget

      if (!('pressed' in tile.dataset)) {
        return
      }

      delete tile.dataset.pressed

      try {
        tile.releasePointerCapture(event.pointerId)
      } catch {
        // Already released.
      }

      const box = tile.getBoundingClientRect()

      const inside =
        event.clientX >= box.left - PRESS_SLACK_PX &&
        event.clientX <= box.right + PRESS_SLACK_PX &&
        event.clientY >= box.top - PRESS_SLACK_PX &&
        event.clientY <= box.bottom + PRESS_SLACK_PX

      if (inside) {
        items[index]?.onSelect()
      }
    },
    [items]
  )

  const handlePointerCancel = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    delete event.currentTarget.dataset.pressed
  }, [])

  const handleClick = useCallback(
    (index: number) => (event: ReactMouseEvent<HTMLButtonElement>) => {
      // A pointer click already selected on release; this is Enter/Space or `element.click()` (the `it click` CLI).
      if (event.detail === 0) {
        items[index]?.onSelect()
      }
    },
    [items]
  )

  return (
    <nav
      aria-label={t.desktop.home.dock}
      className="dock"
      data-autohide={autoHide ? 'true' : undefined}
      data-revealed={autoHide && revealed ? 'true' : undefined}
      data-tracking={isTracking ? 'true' : undefined}
      dir="ltr"
      ref={railRef}
    >
      {items.map((item, index) => (
        <div
          className="dock__item"
          key={item.id}
          ref={el => {
            itemRefs.current[index] = el
          }}
        >
          {item.active ? <span aria-hidden="true" className="dock__active-dot" /> : null}
          <button
            aria-label={item.badge ? `${item.label} (${item.badge})` : item.label}
            className={item.tone ? `dock__icon ic-tone ic-tone--${item.tone}` : 'dock__icon'}
            data-dock={item.id}
            onClick={handleClick(index)}
            onPointerCancel={handlePointerCancel}
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp(index)}
            type="button"
          >
            <span aria-hidden="true" className="dock__glyph">
              {item.icon}
            </span>
            {item.badge ? (
              <span aria-hidden="true" className="dock__badge">
                {item.badge}
              </span>
            ) : null}
          </button>
          <span aria-hidden="true" className="dock__tooltip">
            {item.label}
            {item.hint ? <kbd className="dock__hint">{item.hint}</kbd> : null}
          </span>
        </div>
      ))}
    </nav>
  )
}
