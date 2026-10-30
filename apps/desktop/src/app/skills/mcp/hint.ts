/**
 * Which side an icon action draws its hint on.
 *
 * `.icsk__iconbtn::after` draws the control's own `aria-label` (native `title`
 * is forbidden by DESIGN.md and no Ic* tooltip exists yet), by default below
 * the control. The MCP server list is its own `overflow-y: auto` scroller —
 * measured on lab 2: clientHeight 640 against scrollHeight 4574 — so a row
 * sitting near that scroller's bottom edge loses the bubble to the clip, and
 * with it the only name the control has.
 *
 * So the side is chosen from the room the control actually has, at the moment
 * the hint is about to show: `pointerenter` and `focus` are exactly the two
 * events the CSS reveals it on, so nothing measures while nobody is pointing at
 * the row. The bubble's reach (its box plus its gap) is declared by the CSS as
 * `--icsk-hint-reach` in px — one source of truth for the rule, this module and
 * the gate that measures it.
 */

/** Used when the custom property is missing (a test's bare element). */
const FALLBACK_REACH_PX = 24

type HintSide = 'down' | 'up'

/** The nearest ancestor that would clip an absolutely positioned bubble. */
function clipper(el: HTMLElement): HTMLElement | null {
  let node = el.parentElement

  while (node && node !== el.ownerDocument.body) {
    const style = getComputedStyle(node)

    if (/auto|scroll|hidden/.test(style.overflowY) || /auto|scroll|hidden/.test(style.overflowX)) {
      return node
    }

    node = node.parentElement
  }

  return null
}

/** How much room below (or above) the bubble needs, in px. */
export function hintReach(el: HTMLElement): number {
  const declared = Number.parseFloat(getComputedStyle(el).getPropertyValue('--icsk-hint-reach'))

  return Number.isFinite(declared) && declared > 0 ? declared : FALLBACK_REACH_PX
}

/**
 * Below unless the bubble would not fit there AND it does fit above: flipping
 * it into a second clipped edge would only move the defect.
 */
export function hintSide(el: HTMLElement): HintSide {
  const box = clipper(el)

  if (!box) {
    return 'down'
  }

  const reach = hintReach(el)
  const rect = el.getBoundingClientRect()
  const clip = box.getBoundingClientRect()

  return clip.bottom - rect.bottom < reach && rect.top - clip.top >= reach ? 'up' : 'down'
}

/** `onFocus` / `onPointerEnter` of an `.icsk__iconbtn`: aim its hint. */
export function aimHint(event: { currentTarget: HTMLElement }): void {
  event.currentTarget.dataset.icHint = hintSide(event.currentTarget)
}
