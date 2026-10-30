/**
 * THE in-app drag primitive. One pointer-capture session (`startDragSession`)
 * owns the machinery every in-app drag shares — threshold, rAF-coalesced
 * moves, cursor/user-select chrome, ghost chip, Esc-as-top-escape-layer,
 * hint publishing, teardown — and a per-kind RESOLVER supplies the semantics:
 * what the pointer is over (`resolveMove` → DropHint) and what a release
 * does (`onCommit`). Pane/tab drags (below) are the first resolver; the
 * sidebar session drag (app/chat/session-drag.ts) is the second. Native
 * HTML5 DnD is reserved for true OS boundaries (Finder file drops) — in-app
 * drags never ride it, so no snap-back animation, no hostile-library
 * armor, and Esc aborts synchronously.
 *
 * Pane drags use the FancyZones engine (zones-engine.ts, ported verbatim):
 * sensitivity-radius hit testing, HighlightedZones state machine, Shift =
 * select-many (combined zone range), ClosestCenter primary on drop. The
 * LAYOUT STAYS FIXED and every zone lights up as a whole-region drop target;
 * NOTHING moves until release (tab reorder included — the strip shows an
 * insertion divider, not a live shuffle). Over a zone's TAB STRIP the drop
 * stacks at the divider's slot; elsewhere the radial position picks
 * center/edge.
 *
 * PERFORMANCE CONTRACT: the layout never restructures mid-drag, so every
 * rect a resolver needs is snapshotted once at drag start (zones AND tab
 * strips) and each pointermove is pure math against those caches — no
 * elementsFromPoint, no getBoundingClientRect, no style writes unless a
 * value actually changed. Moves are coalesced to one hit-test per animation
 * frame, with the pending move flushed synchronously on release so the drop
 * commits at the exact final position.
 */

import type { PointerEvent as ReactPointerEvent } from 'react'

import { createDragGhost, type DragGhost } from '@/lib/drag-ghost'
import { ESCAPE_PRIORITY, pushEscapeLayer } from '@/lib/escape-layers'
import { guardGuestPointers } from '@/lib/guest-pointer-guard'
import { reorderStepHaptic } from '@/lib/reorder'

import type { DropPosition } from '../model'
import { $dropHint, $treeDragging, type DropHint } from '../store'
import { type EngineZone, type ZoneRect } from '../zones-engine'

const DRAG_THRESHOLD_PX = 4

/** Normalized radius of the elliptical CENTER region (stack/link). Outside it
 *  the drop targets the dominant-axis edge — the boundary curves with the
 *  zone's aspect ratio instead of snapping at a rigid pixel band, and corners
 *  ease into their nearest edge along the quadrant diagonals. */
const CENTER_RADIUS = 0.62

export function snapshotZones(): EngineZone[] {
  return [...document.querySelectorAll<HTMLElement>('[data-tree-group]')].map(el => {
    const r = el.getBoundingClientRect()

    return { id: el.dataset.treeGroup!, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } }
  })
}

/** Radial drop position within `rect`: inside the center ellipse = the center
 *  action (stack/link); outside, the dominant axis picks the edge (VS Code
 *  dock-preview geometry). `centerRadius` sizes the ellipse — larger = more
 *  center, slimmer curved edge bands. */
function radialPosition(
  rect: { left: number; top: number; right: number; bottom: number },
  x: number,
  y: number,
  centerRadius = CENTER_RADIUS
): DropPosition {
  // Zone-centered coordinates, ±1 at the edge midpoints.
  const dx = ((x - rect.left) / Math.max(1, rect.right - rect.left)) * 2 - 1
  const dy = ((y - rect.top) / Math.max(1, rect.bottom - rect.top)) * 2 - 1

  if (Math.hypot(dx, dy) < centerRadius) {
    return 'center'
  }

  return Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : dy < 0 ? 'top' : 'bottom'
}

/** Sub-zone drop position within the zone `groupId` (radial hit-testing). */
export function subZonePosition(zones: EngineZone[], groupId: string, x: number, y: number): DropPosition {
  const rect = zones.find(zone => zone.id === groupId)?.rect

  return rect ? radialPosition(rect, x, y) : 'center'
}

/** One tab's insertion geometry: its pane id + horizontal midpoint. */
interface StripSlot {
  id: string
  mid: number
}

const stripSlots = (strip: HTMLElement): StripSlot[] =>
  [...strip.querySelectorAll<HTMLElement>('[data-tree-tab]')].map(tab => {
    const r = tab.getBoundingClientRect()

    return { id: tab.dataset.treeTab ?? '', mid: r.left + r.width / 2 }
  })

/** Insertion slot from the pointer x against the OTHER tabs' midpoints:
 *  stack BEFORE the returned pane id (`null` = append). `exclude` is the
 *  dragged tab — or the whole selection on a multi-tab drag, so the block
 *  can't target a slot inside itself. */
export function slotBefore(
  slots: StripSlot[],
  x: number,
  exclude: readonly string[] | string = ''
): { before: null | string } {
  const excluded = typeof exclude === 'string' ? [exclude] : exclude

  for (const slot of slots) {
    if (excluded.includes(slot.id)) {
      continue
    }

    if (x < slot.mid) {
      return { before: slot.id }
    }
  }

  return { before: null }
}

/** Drag-start snapshot of one zone's tab strip. Strips never overlap and the
 *  layout never restructures mid-drag, so rect containment replaces a
 *  per-move elementsFromPoint hit test. A drop on a strip STACKS at the
 *  divider's slot — the strip is where tabs live, so it wins over the radial
 *  top-edge band that would otherwise read as "split top". */
export interface StripSnapshot {
  groupId: string
  rect: ZoneRect
  slots: StripSlot[]
}

export function snapshotStrips(): StripSnapshot[] {
  return [...document.querySelectorAll<HTMLElement>('[data-zone-tabstrip]')].map(el => {
    const r = el.getBoundingClientRect()

    return {
      groupId: el.dataset.zoneTabstrip!,
      rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
      slots: stripSlots(el)
    }
  })
}

export const rectContains = (rect: ZoneRect, x: number, y: number, pad = 0) =>
  x >= rect.left - pad && x <= rect.right + pad && y >= rect.top - pad && y <= rect.bottom + pad

const sameHint = (a: DropHint | null, b: DropHint | null) =>
  a?.groupId === b?.groupId &&
  a?.pos === b?.pos &&
  a?.stack?.before === b?.stack?.before &&
  (a?.stack === undefined) === (b?.stack === undefined) &&
  (a?.groupIds?.length ?? 0) === (b?.groupIds?.length ?? 0) &&
  (a?.groupIds ?? []).every((id, i) => b?.groupIds?.[i] === id)

// Drag handles carry NO double-tap. Handles preventDefault pointerdown, so a
// synthesized one is the only way to get it here — and a gesture this machinery
// hands to every handle at once is the wrong home for anything destructive.
// Trackpad double-tap is a separate concern: `@/lib/trackpad-gestures`.

// ---------------------------------------------------------------------------
// The generic drag session (machinery) — resolvers plug in below / elsewhere.
// ---------------------------------------------------------------------------

interface DragSessionSpec {
  /** Movement crossed the drag threshold: snapshot geometry, set the drag
   *  store(s), dim/mark the source. Runs once. */
  onEngage(x: number, y: number): void
  /** Per-frame target resolution — pure math against drag-start snapshots.
   *  Returns the hint to publish; `null` = deny area (no-drop cursor, a
   *  release commits nothing). */
  resolveMove(x: number, y: number, shift: boolean): DropHint | null
  /** Release over the final published hint (already flushed to the exact
   *  release position). Only called for engaged drags. */
  onCommit(hint: DropHint | null): void
  /** Teardown for both commit and abort — undo whatever onEngage marked. */
  onEnd?(): void
  /** Sub-threshold release = a click on the handle. */
  onTap?(): void
  /** Floating chip following the pointer — for drags whose source doesn't
   *  stay visibly "held" (a sidebar row, unlike a dimmed tab). See
   *  `@/lib/drag-ghost`. */
  ghost?: { label: string }
}

/** After an ENGAGED drag, the release still synthesizes a `click` on the
 *  capture element — swallow exactly that one so a drag can never double as
 *  an activation (row resume, tab close). Committed drags see the click in
 *  the same task burst as pointerup; an Esc abort's click arrives with the
 *  eventual release, so the trap disarms right after it. */
function suppressDragClick(committed: boolean) {
  const swallow = (ev: MouseEvent) => {
    ev.preventDefault()
    ev.stopPropagation()
  }

  window.addEventListener('click', swallow, { capture: true, once: true })

  const disarm = () => window.setTimeout(() => window.removeEventListener('click', swallow, true), 0)

  if (committed) {
    disarm()
  } else {
    window.addEventListener('pointerup', disarm, { capture: true, once: true })
    window.addEventListener('pointercancel', disarm, { capture: true, once: true })
  }
}

/**
 * Begin a drag session from a handle's pointerdown. A sub-threshold release
 * is a click (`onTap`); past the threshold the spec's resolver owns targeting
 * and the machinery owns everything else. Esc aborts instantly: the session
 * registers as the TOP escape layer, tears down synchronously, and nothing
 * commits.
 */
export function startDragSession(e: ReactPointerEvent<HTMLElement>, spec: DragSessionSpec) {
  if (e.button !== 0) {
    return
  }

  const handle = e.currentTarget
  const { pointerId } = e
  const sx = e.clientX
  const sy = e.clientY
  const restoreCursor = document.body.style.cursor
  const restoreSelect = document.body.style.userSelect
  let engaged = false
  let releaseEscapeLayer: (() => void) | null = null
  let releaseGuests: (() => void) | null = null
  let ghost: DragGhost | null = null
  let cursor: string | null = null
  // rAF-coalesced move processing: the raw handler only records the latest
  // point; all hit testing happens at most once per frame.
  let pending: { x: number; y: number; shift: boolean } | null = null
  let raf = 0

  // Cursor writes are per-frame; only touch the style when the value changes.
  const setCursor = (value: string) => {
    if (cursor !== value) {
      cursor = value
      document.body.style.cursor = value
    }
  }

  const publishHint = (next: DropHint | null) => {
    if (!sameHint($dropHint.get(), next)) {
      if (next?.stack !== undefined && $dropHint.get()?.stack?.before !== next.stack.before) {
        reorderStepHaptic()
      }

      $dropHint.set(next)
    }
  }

  const engage = (x: number, y: number) => {
    engaged = true

    // Capture only once ENGAGED: pre-threshold pointer events must stay
    // untouched so a plain click on the handle (and its children — a row
    // body's own onClick) keeps working. Window-level listeners track the
    // gesture either way.
    try {
      handle.setPointerCapture?.(pointerId)
    } catch {
      // Synthetic events (automation) have no active pointer.
    }

    setCursor('grabbing')
    document.body.style.userSelect = 'none'
    // Webview/iframe guests hit-test in their own process — dragging a tab
    // across the in-app browser would go silent without this.
    releaseGuests = guardGuestPointers()
    // While dragging, Esc belongs to the drag ALONE — lower layers (edit
    // mode, overlays) must not also fire on the same press.
    releaseEscapeLayer = pushEscapeLayer(ESCAPE_PRIORITY.drag)

    if (spec.ghost) {
      ghost = createDragGhost(spec.ghost.label)
    }

    spec.onEngage(x, y)
  }

  const processMove = (x: number, y: number, shift: boolean) => {
    if (!engaged) {
      if (Math.hypot(x - sx, y - sy) < DRAG_THRESHOLD_PX) {
        return
      }

      engage(x, y)
    }

    ghost?.moveTo(x, y)

    const hint = spec.resolveMove(x, y, shift)

    // Over a deny area (no target — titlebar / statusbar / gutters /
    // off-window) the release cancels; the cursor says so up front.
    setCursor(hint ? 'grabbing' : 'no-drop')
    publishHint(hint)
  }

  const flushMove = () => {
    raf = 0

    if (pending) {
      const { shift, x, y } = pending
      pending = null
      processMove(x, y, shift)
    }
  }

  const onMove = (ev: PointerEvent) => {
    pending = { shift: ev.shiftKey, x: ev.clientX, y: ev.clientY }
    raf ||= requestAnimationFrame(flushMove)
  }

  const finish = (commit: boolean) => {
    if (raf) {
      cancelAnimationFrame(raf)
      raf = 0
    }

    // The drop must land at the FINAL pointer position, not the last painted
    // frame's — flush the pending move before reading the hint. An abort
    // (Esc / pointercancel) skips it: everything is discarded anyway.
    //
    // Guarded: flushMove re-enters spec.resolveMove, and a resolver that
    // throws here used to throw on EVERY later pointerup too — teardown never
    // ran, so the grabbing cursor, the escape layer and the guest-pointer
    // lock all leaked for the rest of the session. One bad resolver must
    // cost one drop, not the machine.
    if (commit) {
      try {
        flushMove()
      } catch (error) {
        console.error(
          '[drag] resolveMove threw during the final flush — dropping the move, tearing down anyway:',
          error
        )
      }
    }

    document.body.style.cursor = restoreCursor
    document.body.style.userSelect = restoreSelect
    ghost?.destroy()
    ghost = null
    releaseEscapeLayer?.()
    releaseEscapeLayer = null
    releaseGuests?.()
    releaseGuests = null

    try {
      handle.releasePointerCapture?.(pointerId)
    } catch {
      // Mirror of the capture guard.
    }

    window.removeEventListener('pointermove', onMove, true)
    window.removeEventListener('pointerup', onUp, true)
    window.removeEventListener('pointercancel', onCancel, true)
    window.removeEventListener('keydown', onKey, true)

    if (engaged) {
      suppressDragClick(commit)

      if (commit) {
        spec.onCommit($dropHint.get())
      }
    } else if (commit) {
      spec.onTap?.()
    }

    spec.onEnd?.()
    $dropHint.set(null)
    $treeDragging.set(null)
  }

  const onUp = () => finish(true)
  const onCancel = () => finish(false)

  // Esc aborts the drag — the target selection vanishes and nothing moves,
  // the universal "never mind" for an in-flight drag. Capture-phase + stop so
  // it doesn't also close a pane/overlay behind the drag (the escape layer
  // covers contract-following handlers; the stop covers the rest).
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      ev.preventDefault()
      ev.stopPropagation()
      finish(false)
    }
  }

  window.addEventListener('pointermove', onMove, true)
  window.addEventListener('pointerup', onUp, true)
  window.addEventListener('pointercancel', onCancel, true)
  window.addEventListener('keydown', onKey, true)
}

// ---------------------------------------------------------------------------
// Pane drag — the tree's resolver over the generic session.
// ---------------------------------------------------------------------------

interface ReorderContext {
  groupId: string
  /** The tab-strip element; tabs carry `data-tree-tab={paneId}`. */
  strip: HTMLElement
}

/** How far (px) the pointer may stray from the strip before a tab drag stops
 *  being a reorder and becomes a zone move (browser-tab tear-off feel). */
const TEAR_OFF_SLACK_PX = 18
