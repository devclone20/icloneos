/**
 * v0.0.9 pass 4 (critic-G 02): the split preview's words never sit on a live row of the pane under them. Red before:
 * the label was centred in its half, and "Email replaces Settings" covered the Settings › Machine row in both skins.
 */
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { stubMenuDomApis, stubResizeObserver } from '@/test/jsdom'

import { $dockDrag, beginDockDrag, type FrameRect, moveDockDrag } from './dock-split'
import { DockSplitPreview } from './dock-split-preview'
import { type Box, clearLabelTop, intersects, LABEL_GAP } from './label-clearance'
import { $paneArea, $settingsBesideMessage, registerPane, resetPanesForTests } from './pane-layout'

describe('clearLabelTop (geometry)', () => {
  const area: Box = { left: 0, top: 0, width: 400, height: 600 }
  const label = { width: 160, height: 30 }

  it('no obstacle: the centred place', () => {
    expect(clearLabelTop(area, label, [])).toBe(285)
  })

  it('a row on the centre: the nearest clear band, the gap kept', () => {
    const row: Box = { left: 40, top: 270, width: 320, height: 60 }
    const top = clearLabelTop(area, label, [row])
    const box: Box = { left: 120, top, width: 160, height: 30 }

    expect(intersects(box, { ...row, top: row.top - LABEL_GAP, height: row.height + 2 * LABEL_GAP })).toBe(false)
    expect(Math.abs(top + 15 - 300)).toBeLessThanOrEqual(60)
  })

  it('a control outside the label column does not move it', () => {
    expect(clearLabelTop(area, label, [{ left: 0, top: 280, width: 50, height: 40 }])).toBe(285)
  })

  it('no clear band anywhere: the centred place (nothing better exists)', () => {
    expect(clearLabelTop(area, label, [{ left: 0, top: 0, width: 400, height: 600 }])).toBe(285)
  })
})

// ── the preview, measured against a pane's real rows (jsdom: rects stubbed, as the layout would give them) ──

const FRAME: FrameRect = { left: 100, top: 50, width: 1000, height: 700 }
const LABEL = { width: 190, height: 30 }

/** Settings' landing doors in the right half, as on 02: four rows down the middle of the pane. */
const ROWS: Box[] = [0, 1, 2, 3].map(index => ({ left: 640, top: 190 + index * 110, width: 420, height: 90 }))

function boxOf(el: Element): Box {
  const html = el as HTMLElement

  if (html.dataset.rowBox) {
    return JSON.parse(html.dataset.rowBox) as Box
  }

  if (html.dataset.splitHalf) {
    return {
      left: FRAME.left + Number.parseFloat(html.style.left || '0'),
      top: FRAME.top,
      width: Number.parseFloat(html.style.width || `${FRAME.width}`),
      height: FRAME.height
    }
  }

  return { left: 0, top: 0, width: 0, height: 0 }
}

beforeAll(() => {
  stubMenuDomApis()
  stubResizeObserver()
})

beforeEach(() => {
  resetPanesForTests()
  $paneArea.set(FRAME.width)
  $dockDrag.set(null)
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const b = boxOf(this)

    return { ...b, right: b.left + b.width, bottom: b.top + b.height, x: b.left, y: b.top, toJSON: () => b } as DOMRect
  })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('ic-split-preview__label') ? LABEL.width : 0
  })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('ic-split-preview__label') ? LABEL.height : 0
  })
})

afterEach(() => {
  cleanup()
  $dockDrag.set(null)
  $settingsBesideMessage.set(false)
  vi.restoreAllMocks()
})

function placedLabel(side: string): Box {
  const half = document.querySelector<HTMLElement>(`[data-split-half="${side}"]`)!
  const label = half.querySelector<HTMLElement>('.ic-split-preview__label')!
  const area = boxOf(half)

  expect(label.dataset.labelPlaced).toBe('')

  return {
    left: area.left + (area.width - LABEL.width) / 2,
    top: area.top + Number.parseFloat(label.style.top),
    width: LABEL.width,
    height: LABEL.height
  }
}

describe('the split preview label sits in clear space', () => {
  it('"Email replaces Settings" meets none of the Settings rows under it (and centred it would have)', () => {
    // Settings beside Message (02's state): the 50/50 pair, Settings on the right.
    $settingsBesideMessage.set(true)
    registerPane('message')
    registerPane('settings')

    render(
      <>
        <section aria-label="Settings pane">
          {ROWS.map((row, index) => (
            <button data-row-box={JSON.stringify(row)} key={index} type="button">
              row {index}
            </button>
          ))}
        </section>
        <DockSplitPreview />
      </>
    )

    act(() => beginDockDrag('email', FRAME.left + 800, FRAME.top + 300, FRAME))

    const right = document.querySelector<HTMLElement>('[data-split-half="right"]')!

    expect(right.textContent).toBe('Email replaces Settings')

    const label = placedLabel('right')

    for (const row of ROWS) {
      expect(intersects(label, row), `label ${JSON.stringify(label)} over row ${JSON.stringify(row)}`).toBe(false)
    }

    // The old, centred place lands on a row: this is the case the fix exists for.
    const area = boxOf(right)
    const centred: Box = { ...label, top: area.top + (area.height - LABEL.height) / 2 }

    expect(ROWS.some(row => intersects(centred, row))).toBe(true)
  })

  it('placed per plan, not per pointer move: moving inside the half keeps the label where it is', () => {
    // Settings beside Message (02's state): the 50/50 pair, Settings on the right.
    $settingsBesideMessage.set(true)
    registerPane('message')
    registerPane('settings')
    render(
      <>
        {ROWS.map((row, index) => (
          <button data-row-box={JSON.stringify(row)} key={index} type="button">
            row {index}
          </button>
        ))}
        <DockSplitPreview />
      </>
    )

    act(() => beginDockDrag('email', FRAME.left + 800, FRAME.top + 300, FRAME))
    const before = placedLabel('right').top

    act(() => moveDockDrag(FRAME.left + 820, FRAME.top + 420))
    expect(placedLabel('right').top).toBe(before)
  })
})
