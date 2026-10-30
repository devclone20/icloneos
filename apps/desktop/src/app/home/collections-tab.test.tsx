import { readFileSync } from 'node:fs'
import path from 'node:path'

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CollectionsTab } from './collections-tab'
import { EDGE_HIDE_MARGIN_PX } from './window/edge-autohide'
import { $expandedWindows, setWindowExpanded } from './window/expanded'

vi.mock('./ownership-dialog', () => ({ OwnershipDialogHost: () => null }))

const css = readFileSync(path.join(__dirname, 'collections.css'), 'utf8')

const WIDTH = 1200
// jsdom lays nothing out: the pill's resting box at the right edge of a 1200 px app (right: 12px).
const PILL = { left: 1162, top: 470, width: 26, height: 60 }
const MID_Y = PILL.top + PILL.height / 2

function renderTab(open = false, onToggle = () => {}) {
  const view = render(<CollectionsTab onToggle={onToggle} open={open} />)
  const tab = screen.getByRole('button', { name: 'iNFT collection' })

  Object.defineProperties(tab, {
    offsetLeft: { configurable: true, value: PILL.left },
    offsetTop: { configurable: true, value: PILL.top },
    offsetWidth: { configurable: true, value: PILL.width },
    offsetHeight: { configurable: true, value: PILL.height }
  })

  return { ...view, tab }
}

const move = (clientX: number, clientY: number) =>
  act(() => void window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX, clientY })))

/** The declarations of the first rule whose selector list is exactly `selector`, scoped to `source`. */
function rule(source: string, selector: string): string {
  const at = source.indexOf(`${selector} {`)

  expect(at, `no rule for ${selector}`).toBeGreaterThanOrEqual(0)

  return source.slice(at, source.indexOf('}', at))
}

const reducedMotion = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce) {\n  .inft-tab {'))

beforeEach(() => {
  window.innerWidth = WIDTH
})

afterEach(() => {
  cleanup()
  $expandedWindows.set([])
})

describe('CollectionsTab auto-hide', () => {
  it('rests in place while no window is expanded, whatever the pointer does', () => {
    const { tab } = renderTab()

    expect(tab.dataset.autohide).toBeUndefined()
    move(WIDTH - 2, MID_Y)
    expect(tab.dataset.revealed).toBeUndefined()
  })

  it('tucks away while any window is expanded and returns when the last one retracts', () => {
    const { tab } = renderTab()

    act(() => setWindowExpanded('message', true))
    expect(tab.dataset.autohide).toBe('true')
    expect(tab.dataset.revealed).toBeUndefined()

    act(() => setWindowExpanded('econ', true))
    act(() => setWindowExpanded('message', false))
    expect(tab.dataset.autohide).toBe('true')

    act(() => setWindowExpanded('econ', false))
    expect(tab.dataset.autohide).toBeUndefined()
  })

  it('the right edge level with the pill reveals it; well clear of it hides it again', () => {
    const { tab } = renderTab()

    act(() => setWindowExpanded('settings', true))
    move(WIDTH - 4, MID_Y)
    expect(tab.dataset.revealed).toBe('true')

    move(PILL.left - EDGE_HIDE_MARGIN_PX, MID_Y)
    expect(tab.dataset.revealed).toBe('true')

    move(PILL.left - EDGE_HIDE_MARGIN_PX - 1, MID_Y)
    expect(tab.dataset.revealed).toBeUndefined()
  })

  it('the right edge above or below its band never reveals it (the window column, a scrollbar drag)', () => {
    const { tab } = renderTab()

    act(() => setWindowExpanded('message', true))
    move(WIDTH - 4, PILL.top - 120)
    expect(tab.dataset.revealed).toBeUndefined()
    move(WIDTH - 4, PILL.top + PILL.height + 120)
    expect(tab.dataset.revealed).toBeUndefined()
  })

  it('retracting the window drops a reveal with it', () => {
    const { tab } = renderTab()

    act(() => setWindowExpanded('message', true))
    move(WIDTH - 1, MID_Y)
    expect(tab.dataset.revealed).toBe('true')

    act(() => setWindowExpanded('message', false))
    expect(tab.dataset.revealed).toBeUndefined()
    expect(tab.dataset.autohide).toBeUndefined()
  })

  it('never reveals over its own open panel', () => {
    const { tab } = renderTab(true)

    act(() => setWindowExpanded('message', true))
    move(WIDTH - 1, MID_Y)
    expect(tab.dataset.open).toBe('true')
    expect(tab.dataset.revealed).toBeUndefined()
  })

  it('a revealed pill is still the button that opens the collection', () => {
    const onToggle = vi.fn()
    const { tab } = renderTab(false, onToggle)

    act(() => setWindowExpanded('message', true))
    move(WIDTH - 1, MID_Y)
    fireEvent.click(tab)
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(tab.getAttribute('aria-expanded')).toBe('false')
  })
})

describe('CollectionsTab focus when its panel closes', () => {
  it('takes focus back when the panel closes with focus left on the page body', () => {
    const { rerender, tab } = renderTab(true)

    expect(window.document.activeElement).toBe(window.document.body)
    rerender(<CollectionsTab onToggle={() => {}} open={false} />)
    expect(window.document.activeElement).toBe(tab)
  })

  it('never takes focus on mount, or while its panel stays closed', () => {
    const { rerender } = renderTab()

    rerender(<CollectionsTab onToggle={() => {}} open={false} />)
    expect(window.document.activeElement).toBe(window.document.body)
  })

  it('leaves focus that moved elsewhere where it is', () => {
    const { rerender } = renderTab(true)
    const other = window.document.createElement('button')

    window.document.body.append(other)
    other.focus()
    rerender(<CollectionsTab onToggle={() => {}} open={false} />)
    expect(window.document.activeElement).toBe(other)
    other.remove()
  })

  it('takes focus back while auto-hiding too (a focused pill is shown, collections.css)', () => {
    setWindowExpanded('message', true)

    const { rerender, tab } = renderTab(true)

    rerender(<CollectionsTab onToggle={() => {}} open={false} />)
    expect(window.document.activeElement).toBe(tab)
    expect(tab.hasAttribute('data-autohide')).toBe(true)
  })
})

describe('collections.css pill contract', () => {
  it('centres the pill without a transform, so its layout offsets are where it rests', () => {
    const base = rule(css, '.inft-tab')

    expect(base).not.toMatch(/\btranslate\s*:/)
    expect(base).not.toMatch(/\btop\s*:\s*50%/)
    expect(base).toMatch(/inset-block:\s*0;/)
    expect(base).toMatch(/margin-block:\s*auto;/)
  })

  it('hides only while auto-hiding, unrevealed and not keyboard-focused, and then catches nothing', () => {
    const hidden = rule(css, '.inft-tab[data-autohide]:not([data-revealed]):not(:focus-visible)')

    expect(hidden).toMatch(/opacity:\s*0;/)
    expect(hidden).toMatch(/pointer-events:\s*none;/)
    expect(hidden).toMatch(/transform:\s*translateX\(calc\(100% \+ 12px\)\);/)
  })

  it('animates the tuck on the Dock timing: transform slow spring, opacity base', () => {
    const motion = rule(css, '.inft-tab[data-autohide]')

    expect(motion).toMatch(/transform var\(--ic-dur-slow\) var\(--ic-ease-spring\)/)
    expect(motion).toMatch(/opacity var\(--ic-dur-base\) var\(--ic-ease-std\)/)
  })

  it('under reduced motion only fades, in place, on the fast duration', () => {
    const motion = rule(reducedMotion, '  .inft-tab[data-autohide]')
    const hidden = rule(reducedMotion, '  .inft-tab[data-autohide]:not([data-revealed]):not(:focus-visible)')

    expect(motion).not.toMatch(/transform/)
    expect(motion).toMatch(/opacity var\(--ic-dur-fast\)/)
    expect(hidden).toMatch(/transform:\s*none;/)
  })
})
