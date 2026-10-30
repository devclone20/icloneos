/**
 * Slot geometry for the iT shell hosts — pure, so it is testable without a
 * layout engine. A host parks one shell over each `[data-it-slot]`; a GLOBAL
 * host positions in viewport pixels, a WINDOW host relative to its window
 * body (`origin`), which is its containing block.
 */
export interface SlotRect {
  height: number
  left: number
  top: number
  width: number
}

const SLOT_ATTR = 'data-it-slot'

interface Measurable {
  getAttribute: (name: string) => null | string
  getBoundingClientRect: () => {
    bottom: number
    height: number
    left: number
    right: number
    top: number
    width: number
  }
}

/** Rects of the slots, keyed by terminal id. Zero-size slots are ignored. */
export function measureSlots(
  nodes: Iterable<Measurable>,
  origin: { left: number; top: number } = { left: 0, top: 0 }
): Record<string, SlotRect> {
  const out: Record<string, SlotRect> = {}

  for (const el of nodes) {
    const id = el.getAttribute(SLOT_ATTR)

    if (!id) {
      continue
    }

    const r = el.getBoundingClientRect()

    if (r.width <= 0 || r.height <= 0) {
      continue
    }

    // Floor the origin and ceil the far edge so the overlay always covers the
    // slot's full pixel footprint — a half-pixel rect leaks the stage through.
    const top = Math.floor(r.top - origin.top)
    const left = Math.floor(r.left - origin.left)

    out[id] = {
      height: Math.ceil(r.bottom - origin.top) - top,
      left,
      top,
      width: Math.ceil(r.right - origin.left) - left
    }
  }

  return out
}

/** Slots under `root` only — a window host never reads another window's slots. */
export function readSlotsIn(root: ParentNode, origin?: { left: number; top: number }): Record<string, SlotRect> {
  return measureSlots(root.querySelectorAll<HTMLElement>(`[${SLOT_ATTR}]`), origin)
}

export function sameSlots(a: Record<string, SlotRect>, b: Record<string, SlotRect>): boolean {
  const keys = Object.keys(a)

  if (keys.length !== Object.keys(b).length) {
    return false
  }

  for (const key of keys) {
    const x = a[key]
    const y = b[key]

    if (!y || x.top !== y.top || x.left !== y.left || x.width !== y.width || x.height !== y.height) {
      return false
    }
  }

  return true
}

/** The box the active workspace's slots fill together — the iT body. */
export function slotsBounds(rects: Record<string, SlotRect>): null | { height: number; width: number } {
  const all = Object.values(rects)

  if (all.length === 0) {
    return null
  }

  const left = Math.min(...all.map(r => r.left))
  const top = Math.min(...all.map(r => r.top))
  const right = Math.max(...all.map(r => r.left + r.width))
  const bottom = Math.max(...all.map(r => r.top + r.height))

  return { height: bottom - top, width: right - left }
}

/**
 * The smallest pane a split may create: about 20 columns × 4 rows of the iT
 * font (11 px mono, line height 1.12) plus the pane's padding. Below it the
 * prompt wraps on every keystroke and xterm's renderer can end up with no
 * rows at all — a pane that exists but never paints.
 */
export const IT_MIN_PANE_PX = { height: 64, width: 150 } as const

/** Until the host has measured the body once (iT never shown yet). */
export const IT_DEFAULT_BODY_PX = { height: 360, width: 640 } as const

/** The 1px rule a divider leaves between two panes. */
const DIVIDER_PX = 1

/** Only what the geometry needs from a pane tree (it-store's ItPaneNode). */
type RectNode =
  { a: RectNode; b: RectNode; dir: 'h' | 'v'; ratio: number; type: 'split' } | { terminalId: string; type: 'leaf' }

/** The sizes of a split's two children inside `size`, the divider taken out. */
function childSizes(
  node: Extract<RectNode, { type: 'split' }>,
  size: { height: number; width: number }
): [{ height: number; width: number }, { height: number; width: number }] {
  const along = node.dir === 'h' ? size.width : size.height
  const first = Math.max(0, along * node.ratio - DIVIDER_PX / 2)
  const second = Math.max(0, along - first - DIVIDER_PX)

  return node.dir === 'h'
    ? [
        { ...size, width: first },
        { ...size, width: second }
      ]
    : [
        { ...size, height: first },
        { ...size, height: second }
      ]
}

/** A leaf's size inside `size`, by the split ratios — null when it is not in the tree. */
export function leafSize(
  node: RectNode,
  terminalId: string,
  size: { height: number; width: number }
): null | { height: number; width: number } {
  if (node.type === 'leaf') {
    return node.terminalId === terminalId ? size : null
  }

  const [sizeA, sizeB] = childSizes(node, size)

  return leafSize(node.a, terminalId, sizeA) ?? leafSize(node.b, terminalId, sizeB)
}

/** Would halving this pane along `dir` leave both halves at least IT_MIN_PANE_PX? */
export function splitFits(
  layout: RectNode,
  terminalId: string,
  dir: 'h' | 'v',
  body: { height: number; width: number }
): boolean {
  const size = leafSize(layout, terminalId, body)

  if (!size) {
    return false
  }

  const half = (dir === 'h' ? size.width : size.height) / 2 - DIVIDER_PX

  return dir === 'h'
    ? half >= IT_MIN_PANE_PX.width && size.height >= IT_MIN_PANE_PX.height
    : half >= IT_MIN_PANE_PX.height && size.width >= IT_MIN_PANE_PX.width
}

/** The smallest extent along `axis` at which every leaf of `node` keeps IT_MIN_PANE_PX. */
function minExtent(node: RectNode, axis: 'h' | 'v'): number {
  if (node.type === 'leaf') {
    return axis === 'h' ? IT_MIN_PANE_PX.width : IT_MIN_PANE_PX.height
  }

  const a = minExtent(node.a, axis)
  const b = minExtent(node.b, axis)

  if (node.dir !== axis) {
    return Math.max(a, b)
  }

  return Math.max((a + DIVIDER_PX / 2) / node.ratio, (b + DIVIDER_PX / 2) / (1 - node.ratio))
}

/** The size of `target` (a node of `node`, by identity) inside `size`. */
function nodeSize(
  node: RectNode,
  target: RectNode,
  size: { height: number; width: number }
): null | { height: number; width: number } {
  if (node === target) {
    return size
  }

  if (node.type === 'leaf') {
    return null
  }

  const [sizeA, sizeB] = childSizes(node, size)

  return nodeSize(node.a, target, sizeA) ?? nodeSize(node.b, target, sizeB)
}

/**
 * The ratios `split` (a split node of `layout`) may take in a `body`-sized
 * iT so every pane on both sides keeps IT_MIN_PANE_PX — null when it is not
 * in the tree or no ratio fits (the divider then stays where it is).
 */
export function ratioBounds(
  layout: RectNode,
  split: RectNode,
  body: { height: number; width: number }
): null | { max: number; min: number } {
  const size = split.type === 'split' ? nodeSize(layout, split, body) : null

  if (!size || split.type !== 'split') {
    return null
  }

  const along = split.dir === 'h' ? size.width : size.height
  const min = (minExtent(split.a, split.dir) + DIVIDER_PX / 2) / along
  const max = 1 - (minExtent(split.b, split.dir) + DIVIDER_PX / 2) / along

  return along > 0 && min <= max ? { max, min } : null
}
