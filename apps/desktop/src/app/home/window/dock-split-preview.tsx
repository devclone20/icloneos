/**
 * v0.0.9 F6 · owner addition — the live split preview while a Dock icon is dragged over the window (dock-split.ts).
 *
 * One fixed layer on the frame, mounted for as long as the drag lasts and drawn only from `$dockDrop`:
 * - two halves at the exact widths the drop will give (the pair's remembered divider, else half and half), the one
 *   the new pane takes lit, the other dimmed — or one plate saying "replaces" / "opens as a tab";
 * - a small chip with the pane's name under the pointer.
 * It never takes part in the layout: every piece is `position: fixed` / absolute inside it, it appears and changes
 * with opacity and transforms only (ic-window.css), so nothing in the app reflows when it comes, moves or goes.
 * Reduced motion: no transitions, the same states.
 */
import { useStore } from '@nanostores/react'
import { type CSSProperties, useLayoutEffect, useRef, useState } from 'react'

import { f6PaneNames, f6Split } from '@/i18n/en/v009-f6'

import { $dockDrag, $dockDrop, type DropPlan, type FrameRect, incomingWords, wholeWords } from './dock-split'
import type { IcWindowId } from './ic-window'
import { type Box, clearLabelTop, LABEL_OBSTACLES } from './label-clearance'
import { PANE_DIVIDER_PX, type PaneWidths } from './pane-layout'

const nameOf = (id: string): string => f6PaneNames[id as IcWindowId] ?? id

interface Half {
  side: 'left' | 'right'
  role: 'incoming' | 'keep'
  label: string
}

function halvesOf(plan: DropPlan): Half[] | null {
  if (plan.kind !== 'split' && plan.kind !== 'move') {
    return null
  }

  const other = plan.side === 'left' ? 'right' : 'left'
  const keep = plan.kind === 'split' ? f6Split.stays(nameOf(plan.keep)) : ''

  return [
    { side: plan.side, role: 'incoming', label: incomingWords(plan) },
    { side: other, role: 'keep', label: keep }
  ]
}

// The positioning is inline (not only in ic-window.css) so the layer can never fall into the flow: a fixed box over
// the frame, absolute halves inside it, hit-transparent. Looks (colours, motion) stay in the stylesheet.
function halfStyle(side: 'left' | 'right', widths: PaneWidths): CSSProperties {
  const box: CSSProperties = { position: 'absolute', top: 0, bottom: 0 }

  return side === 'left'
    ? { ...box, left: 0, width: `${widths.left}px` }
    : { ...box, left: `${widths.left + PANE_DIVIDER_PX}px`, width: `${widths.right}px` }
}

function frameStyle(frame: FrameRect): CSSProperties {
  return {
    position: 'fixed',
    pointerEvents: 'none',
    left: `${frame.left}px`,
    top: `${frame.top}px`,
    width: `${frame.width}px`,
    height: `${frame.height}px`
  }
}

const boxOf = (el: Element): Box => {
  const r = el.getBoundingClientRect()

  return { left: r.left, top: r.top, width: r.width, height: r.height }
}

/**
 * A half's words, placed in the clear space of that half (critic-G 02): measured once per plan (side, kind, widths),
 * never per pointer move, against the live controls under the half (label-clearance.ts). Laid out before paint, so the
 * centred first frame is never seen.
 */
function ClearLabel({ placement, text }: { placement: string; text: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [top, setTop] = useState<number | null>(null)

  useLayoutEffect(() => {
    const label = ref.current
    const half = label?.parentElement

    if (!label || !half) {
      return
    }

    const area = boxOf(half)
    const obstacles = [...document.querySelectorAll(LABEL_OBSTACLES)]
      .filter(el => !el.closest('[data-ic-split-preview]'))
      .map(boxOf)

    const size = { width: label.offsetWidth, height: label.offsetHeight }

    setTop(clearLabelTop(area, size, obstacles) - area.top)
  }, [placement, text])

  return (
    <span
      className="ic-split-preview__label"
      data-label-placed={top === null ? undefined : ''}
      ref={ref}
      style={top === null ? undefined : { position: 'absolute', left: '50%', top: `${top}px`, translate: '-50% 0' }}
    >
      {text}
    </span>
  )
}

export function DockSplitPreview() {
  const drag = useStore($dockDrag)
  const plan = useStore($dockDrop)

  if (drag === null || plan === null) {
    return null
  }

  const halves = halvesOf(plan)
  const widths = plan.kind === 'split' || plan.kind === 'move' ? plan.widths : null
  const whole = halves === null ? wholeWords(plan, drag.pane) : ''
  // What a label's place depends on: the plan and the frame, never the pointer.
  const placement = [
    plan.kind,
    plan.kind === 'split' || plan.kind === 'move' ? plan.side : '',
    widths ? `${widths.left}:${widths.right}` : '',
    `${drag.frame.left},${drag.frame.top},${drag.frame.width},${drag.frame.height}`
  ].join('|')

  // Seen, not read: the live region of the pane layer says the same words, once per change (pane-announce.ts).
  return (
    <div
      aria-hidden
      className="ic-split-preview"
      data-ic-split-preview=""
      data-plan={plan.kind}
      data-reason={plan.kind === 'outside' ? plan.reason : undefined}
      data-side={plan.kind === 'split' || plan.kind === 'move' ? plan.side : undefined}
      style={frameStyle(drag.frame)}
    >
      {halves !== null && widths !== null
        ? halves.map(half => (
            <div
              className="ic-split-preview__half"
              data-role={half.role}
              data-split-half={half.side}
              key={half.side}
              style={halfStyle(half.side, widths)}
            >
              {half.label ? <ClearLabel placement={placement} text={half.label} /> : null}
            </div>
          ))
        : null}
      {whole ? (
        <div
          className="ic-split-preview__half ic-split-preview__whole"
          data-role={plan.kind === 'outside' ? 'keep' : 'incoming'}
          data-split-half="whole"
          style={{ position: 'absolute', inset: 0 }}
        >
          <ClearLabel placement={placement} text={whole} />
        </div>
      ) : null}
      <span
        aria-hidden
        className="ic-split-preview__chip"
        style={{
          position: 'absolute',
          transform: `translate3d(${drag.x - drag.frame.left}px, ${drag.y - drag.frame.top}px, 0)`
        }}
      >
        {nameOf(drag.pane)}
      </span>
    </div>
  )
}
