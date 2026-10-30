/**
 * Edge auto-hide — the macOS auto-hide Dock as one primitive. A target tucked against an app edge (the Dock on the
 * left, a window's control column on the right) hides while `active`, slides back when the pointer touches that edge
 * (optionally only level with the target) and tucks away again once the pointer moves well clear of it. No timers:
 * the hysteresis margin is the only delay. Keyboard focus is CSS's job (dock.css, ic-window.css).
 */
import { type RefObject, useEffect, useState } from 'react'
import { flushSync } from 'react-dom'

/** The pointer within this many px of the edge brings the target back. */
export const EDGE_REVEAL_PX = 8
/** This many px past the target's inner side (or above/below its band), a revealed target tucks away again. */
export const EDGE_HIDE_MARGIN_PX = 48

type Edge = 'left' | 'right'

interface EdgePoint {
  x: number
  y: number
}

export interface EdgeZone {
  edge: Edge
  /** The edge's x in client px: 0 on the left, the viewport width (less any right-edge island) on the right. */
  edgeX: number
  /** The target's resting inner side: its right for 'left', its left for 'right'. */
  innerX: number
  /** The target's resting vertical extent; absent, the whole height of the edge is hot. */
  band?: { top: number; bottom: number }
}

export function nextEdgeReveal(revealed: boolean, pointer: EdgePoint, zone: EdgeZone): boolean {
  const { band, edge, edgeX, innerX } = zone

  if (band && (pointer.y < band.top - EDGE_HIDE_MARGIN_PX || pointer.y > band.bottom + EDGE_HIDE_MARGIN_PX)) {
    return false
  }

  const atEdge = edge === 'left' ? pointer.x <= edgeX + EDGE_REVEAL_PX : pointer.x >= edgeX - EDGE_REVEAL_PX

  if (atEdge) {
    return true
  }

  // The hide line runs the margin past whichever of the target and the strip lies further in: a target resting beyond
  // an inset edge (under a right-edge island) keeps the same hysteresis instead of hiding the moment the pointer
  // leaves the strip.
  const inner = edge === 'left' ? Math.max(innerX, edgeX) : Math.min(innerX, edgeX)
  const clear = edge === 'left' ? pointer.x > inner + EDGE_HIDE_MARGIN_PX : pointer.x < inner - EDGE_HIDE_MARGIN_PX

  return revealed && !clear
}

// Layout offsets ignore transforms, so this is where the target RESTS even while it is translated off-screen.
function restingBox(target: HTMLElement): { left: number; right: number; top: number; bottom: number } {
  let left = 0
  let top = 0

  for (let node: Element | null = target; node instanceof HTMLElement; node = node.offsetParent) {
    left += node.offsetLeft
    top += node.offsetTop
  }

  return { left, right: left + target.offsetWidth, top, bottom: top + target.offsetHeight }
}

function zoneOf(edge: Edge, band: boolean, target: HTMLElement | null): EdgeZone {
  const viewportEdge = edge === 'left' ? 0 : window.innerWidth

  if (!target) {
    return { edge, edgeX: viewportEdge, innerX: viewportEdge }
  }

  const box = restingBox(target)
  const style = getComputedStyle(target)
  // CSS owns the inset (e.g. a right-edge island's width) and resolves it to px in scroll-margin-<edge>.
  const inset = Number.parseFloat(edge === 'left' ? style.scrollMarginLeft : style.scrollMarginRight) || 0

  return {
    edge,
    edgeX: edge === 'left' ? inset : viewportEdge - inset,
    innerX: edge === 'left' ? box.right : box.left,
    band: band ? { top: box.top, bottom: box.bottom } : undefined
  }
}

interface EdgeAutoHideOptions {
  edge: Edge
  targetRef: RefObject<HTMLElement | null>
  active: boolean
  /** Reveal only while the pointer is level with the target (± the hide margin), so a drag lower on the same edge
   *  never flashes it. */
  band?: boolean
}

/** Whether the target is revealed. A press that began inside the target (a slider drag under pointer capture)
 *  holds it revealed until the pointer is released, wherever the pointer goes meanwhile. */
export function useEdgeAutoHide({ active, band = false, edge, targetRef }: EdgeAutoHideOptions): boolean {
  const [revealed, setRevealed] = useState(false)

  useEffect(() => {
    // Every (re)activation starts hidden; `shown` mirrors the state inside this activation only.
    setRevealed(false)

    if (!active) {
      return
    }

    let shown = false

    // Commit a change in the same task as the pointer event: a scheduled render costs the reveal a frame or more.
    const show = (next: boolean) => {
      if (next !== shown) {
        shown = next
        flushSync(() => setRevealed(next))
      }
    }

    let held = false
    // A press that began outside the target (a text selection, a scrollbar drag) never reveals it on its way to the edge.
    let pressedOutside = false
    // pointercancel carries no reliable position: a release settles at the last position a move or an up reported.
    let last: EdgePoint | null = null

    const settle = (point: EdgePoint) => {
      const zone = zoneOf(edge, band, targetRef.current)

      show(nextEdgeReveal(shown, point, zone))
    }

    const onMove = (event: PointerEvent) => {
      last = { x: event.clientX, y: event.clientY }

      if (!held && !(pressedOutside && event.buttons !== 0)) {
        settle(last)
      }
    }

    const onDown = (event: PointerEvent) => {
      if (event.target instanceof Node && targetRef.current?.contains(event.target)) {
        held = true
        show(true)
      } else {
        pressedOutside = true
      }
    }

    const onRelease = (event: PointerEvent) => {
      pressedOutside = false

      if (event.type === 'pointerup') {
        last = { x: event.clientX, y: event.clientY }
      }

      if (held) {
        held = false

        if (last) {
          settle(last)
        }
      }
    }

    const onOut = (event: PointerEvent) => {
      if (!event.relatedTarget && !held) {
        show(false)
      }
    }

    window.addEventListener('pointermove', onMove, { passive: true })
    window.addEventListener('pointerdown', onDown, { capture: true, passive: true })
    window.addEventListener('pointerup', onRelease, { capture: true, passive: true })
    window.addEventListener('pointercancel', onRelease, { capture: true, passive: true })
    document.addEventListener('pointerout', onOut)

    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerdown', onDown, { capture: true })
      window.removeEventListener('pointerup', onRelease, { capture: true })
      window.removeEventListener('pointercancel', onRelease, { capture: true })
      document.removeEventListener('pointerout', onOut)
    }
  }, [active, band, edge, targetRef])

  return active && revealed
}
