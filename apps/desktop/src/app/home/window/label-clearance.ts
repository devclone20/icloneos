/**
 * v0.0.9 pass 4 (critic-G 02): where the split preview puts its words. Centred in the half, "Email replaces
 * Settings" sat on the Settings › Machine row in both skins: a label over a live control reads as part of it. The
 * label goes into the clear space of its half instead, measured against the controls of the pane under it, and
 * only when the half has no clear space at all does it fall back to the band nearest the centre.
 *
 * Pure geometry, so the rule is unit-tested without a layout engine (label-clearance.test.ts).
 */

export interface Box {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/** The interactive things a label must not sit on: the rows and controls a user reads and clicks. */
export const LABEL_OBSTACLES = [
  'button',
  'a[href]',
  'input',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="link"]',
  '[role="row"]',
  '[role="option"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[role="treeitem"]',
  '[role="slider"]'
].join(', ')

/** Breathing room between the label and anything around it, and from the half's own edge. */
export const LABEL_GAP = 12

const overlaps = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 && b0 < a1

/** True when two boxes share any area. */
export function intersects(a: Box, b: Box): boolean {
  return overlaps(a.left, a.left + a.width, b.left, b.left + b.width) && overlaps(a.top, a.top + a.height, b.top, b.top + b.height)
}

/**
 * The top (in the same coordinates as `area`) for a label of `label` size, centred across `area`, so that its box,
 * grown by `gap` on every side, meets none of `obstacles`. Among the clear bands it takes the one nearest the
 * vertical centre of the area, and within that band the position nearest the centre. With no clear band it returns
 * the centred top (the old placement): nothing better exists, and the veil under the label still separates it.
 */
export function clearLabelTop(area: Box, label: { width: number; height: number }, obstacles: readonly Box[], gap = LABEL_GAP): number {
  const centredTop = area.top + (area.height - label.height) / 2
  const left = area.left + (area.width - label.width) / 2
  const right = left + label.width
  const lo = area.top + gap
  const hi = area.top + area.height - gap

  // The vertical spans of the obstacles in the label's column, grown by the gap, merged.
  const spans = obstacles
    .filter(o => o.width > 0 && o.height > 0 && overlaps(o.left, o.left + o.width, left - gap, right + gap))
    .map(o => [o.top - gap, o.top + o.height + gap] as const)
    .filter(([s0, s1]) => overlaps(s0, s1, lo, hi))
    .sort((a, b) => a[0] - b[0])

  const merged: Array<[number, number]> = []

  for (const [s0, s1] of spans) {
    const last = merged.at(-1)

    if (last && s0 <= last[1]) {
      last[1] = Math.max(last[1], s1)
    } else {
      merged.push([s0, s1])
    }
  }

  // The free bands between them.
  const free: Array<[number, number]> = []
  let cursor = lo

  for (const [s0, s1] of merged) {
    if (s0 > cursor) {
      free.push([cursor, s0])
    }

    cursor = Math.max(cursor, s1)
  }

  if (cursor < hi) {
    free.push([cursor, hi])
  }

  let best: number | null = null

  for (const [f0, f1] of free) {
    if (f1 - f0 < label.height) {
      continue
    }

    const top = Math.min(Math.max(centredTop, f0), f1 - label.height)

    if (best === null || Math.abs(top - centredTop) < Math.abs(best - centredTop)) {
      best = top
    }
  }

  return best ?? centredTop
}
