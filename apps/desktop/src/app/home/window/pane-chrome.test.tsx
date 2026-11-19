/**
 * v0.0.9 design 4, 5, 6, 9 (critic r1): the F6/F5 chrome rules, read from the CSS the app ships.
 *  - side by side, the Message column sits inside its card at the self windows' 14px inset (it floated in the margin);
 *  - folded tabs have one place, the titlebar band (they straddled the pane's top edge when it was not filled);
 *  - every 26px control has a hit area of at least 32px (window controls, window menu trigger, pane tabs, plate buttons).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

const css = (file: string) =>
  readFileSync(path.join(process.cwd(), 'src/app/home', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

const WINDOW_CSS = css('window/ic-window.css')
const COLLECTIONS_CSS = css('collections.css')

/** Every rule whose selector list ends in `selector` (a grouped rule's last line counts), joined. */
function block(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  return [...source.matchAll(new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`, 'g'))].map(m => m[1]).join('\n')
}

const px = (value: null | string | undefined) => Number(String(value ?? 'NaN').replace('px', ''))

afterEach(() => {
  cleanup()
  delete window.document.documentElement.dataset.icPanes
})

describe('design 4 · symmetric pane chrome', () => {
  it('split: the Message column is inside its card, 14px from its top and end edges, like a self window', () => {
    const split = block(WINDOW_CSS, ":root[data-ic-panes='split'] .ic-win__controls:not(.ic-win > *)")
    const self = block(WINDOW_CSS, '.ic-win > .ic-win__controls')

    expect(split).toContain('top: calc(var(--iwin-outer-top, var(--ic-frame-top)) + 14px);')
    expect(split).toContain('right: calc(var(--iwin-outer-right, var(--ic-frame-right)) + 14px);')
    expect(self).toContain('top: 14px;')
    expect(self).toContain('right: 14px;')
    expect(block(WINDOW_CSS, ":root[dir='rtl'][data-ic-panes='split'] .ic-win__controls:not(.ic-win > *)")).toContain(
      'left: calc(var(--iwin-outer-left, var(--ic-frame-left)) + 14px);'
    )
  })

  it('the pane layer publishes the arrangement on the root (the CSS hook), and takes it away on unmount', async () => {
    const { PaneLayer } = await import('./pane-layer')
    const view = render(<PaneLayer />)

    expect(window.document.documentElement.dataset.icPanes).toBeDefined()
    view.unmount()
    expect(window.document.documentElement.dataset.icPanes).toBeUndefined()
  })
})

describe('design 5 · folded tabs have one place', () => {
  it('the tabs sit in the titlebar band, filled or not (no second placement on the frame edge)', () => {
    expect(block(WINDOW_CSS, '.ihome .ic-pane-tabs')).toContain('top: 10px;')
    expect(WINDOW_CSS).not.toMatch(/ic-pane-tabs \{[^}]*var\(--ic-frame-top\) - 15px/)
    expect(WINDOW_CSS).not.toMatch(/data-ic-pane-filled/)
  })
})

describe('design 6 / 9 · hit targets ≥ 32px', () => {
  it('the 26px chips (window controls, window menu trigger) carry a hit ring that reaches 32px or more', () => {
    for (const chip of ['.ic-win__controls > button', '.ic-wmenu__trigger']) {
      expect(px(/width: (\d+)px/.exec(block(WINDOW_CSS, chip))?.[1])).toBe(26)
    }

    const ring = block(WINDOW_CSS, '.ic-win__controls > button::before,\n.ic-wmenu__trigger::before')
    const inset = Math.abs(px(/inset: (-?\d+)px/.exec(ring)?.[1]))

    expect(ring).toContain("content: '';")
    expect(26 + 2 * inset).toBeGreaterThanOrEqual(32)
    expect(block(WINDOW_CSS, '.ic-win__controls > button,\n.ic-wmenu__trigger')).toContain('position: relative;')
  })

  it('pane tabs and the Collection plate buttons are at least 32px tall', () => {
    expect(px(/min-height: (\d+)px/.exec(block(WINDOW_CSS, '.ihome .ic-pane-tab'))?.[1])).toBeGreaterThanOrEqual(32)

    const plate = block(COLLECTIONS_CSS, '.inft-card__plate-btn')

    expect(px(/min-height: (\d+)px/.exec(plate)?.[1])).toBeGreaterThanOrEqual(32)
    expect(plate).not.toMatch(/(?:^|\n)\s*height: 26px/)
  })
})
