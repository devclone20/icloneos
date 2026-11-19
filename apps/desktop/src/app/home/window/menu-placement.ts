/**
 * v0.0.9 r3 (design N1): where a popover menu opens next to its anchor — its own placement, never the window menu's.
 * The window menu sits at the right edge and opens to its left; the Dock sits at the LEFT edge (the right in RTL), so
 * its split menu opens INWARD: to the anchor's inline end (right in LTR, left in RTL), flipped to the other side when
 * that side has no room, then clamped into the viewport so no part of it is ever off-screen (504 pt minimum window).
 *
 * Pure: rectangles in, a viewport position out. The component turns it into its offset parent's coordinates.
 */
export interface Box {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

export interface MenuPlacement {
  /** Viewport coordinates of the menu's top-left corner. */
  readonly left: number
  readonly top: number
  /** The side of the anchor it opened on. */
  readonly side: 'left' | 'right'
}

export interface PlaceMenuInput {
  readonly anchor: Box
  readonly menu: { readonly width: number; readonly height: number }
  readonly viewport: { readonly width: number; readonly height: number }
  readonly dir: 'ltr' | 'rtl'
  /** Space between the anchor and the menu. */
  readonly gap?: number
  /** The least distance from any viewport edge. */
  readonly margin?: number
}

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), Math.max(low, high))

export function placeMenu({ anchor, dir, gap = 10, margin = 8, menu, viewport }: PlaceMenuInput): MenuPlacement {
  const rightAt = anchor.left + anchor.width + gap
  const leftAt = anchor.left - gap - menu.width
  const fitsRight = rightAt + menu.width <= viewport.width - margin
  const fitsLeft = leftAt >= margin
  const inward: 'left' | 'right' = dir === 'rtl' ? 'left' : 'right'
  const outward = inward === 'right' ? 'left' : 'right'
  const fits = { left: fitsLeft, right: fitsRight }

  // The inward side when it fits; else the other side when that fits; else the side with more room (then clamped).
  const roomRight = viewport.width - margin - rightAt
  const roomLeft = anchor.left - gap - margin
  const side = fits[inward] ? inward : fits[outward] ? outward : roomRight >= roomLeft ? 'right' : 'left'

  return {
    left: clamp(side === 'right' ? rightAt : leftAt, margin, viewport.width - margin - menu.width),
    top: clamp(anchor.top, margin, viewport.height - margin - menu.height),
    side
  }
}
