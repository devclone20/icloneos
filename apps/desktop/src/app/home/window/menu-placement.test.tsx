/**
 * v0.0.9 r3 (design N1): the Dock split menu opened off-screen — it reused the window menu's `right: calc(100% + 10px)`
 * (to the LEFT of its anchor), and the Dock sits at the left edge, so only a ~10 px sliver showed. Red on fb85ac6be6:
 * there was no placement at all (the panel kept the window menu's rule and no left/top was ever written).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { stubMenuDomApis, stubResizeObserver } from '@/test/jsdom'

import { Dock } from '../dock'

import { type Box, placeMenu } from './menu-placement'
import { $paneArea, registerPane, resetPanesForTests } from './pane-layout'

const MENU = { width: 236, height: 92 }
// The Dock's tile: 12 px from the edge, 44 px wide.
const tileAt = (left: number, top = 300): Box => ({ left, top, width: 44, height: 44 })
const inside = (at: { left: number; top: number }, vw: number, vh: number) => {
  expect(at.left).toBeGreaterThanOrEqual(8)
  expect(at.top).toBeGreaterThanOrEqual(8)
  expect(at.left + MENU.width).toBeLessThanOrEqual(vw - 8)
  expect(at.top + MENU.height).toBeLessThanOrEqual(vh - 8)
}

describe('placeMenu', () => {
  it('left edge (the Dock, LTR): opens inward, to the right of the tile', () => {
    const at = placeMenu({ anchor: tileAt(12), dir: 'ltr', menu: MENU, viewport: { width: 1280, height: 800 } })

    expect(at).toEqual({ left: 12 + 44 + 10, top: 300, side: 'right' })
    inside(at, 1280, 800)
  })

  it('right edge (the Dock in RTL): opens inward, to the left of the tile', () => {
    const at = placeMenu({ anchor: tileAt(1280 - 56), dir: 'rtl', menu: MENU, viewport: { width: 1280, height: 800 } })

    expect(at.side).toBe('left')
    expect(at.left).toBe(1280 - 56 - 10 - MENU.width)
    inside(at, 1280, 800)
  })

  it('right edge in LTR (no room on the inward side): flips to the left, never off-screen', () => {
    const at = placeMenu({ anchor: tileAt(1280 - 56), dir: 'ltr', menu: MENU, viewport: { width: 1280, height: 800 } })

    expect(at.side).toBe('left')
    inside(at, 1280, 800)
  })

  it('left edge in RTL (no room inward): flips to the right', () => {
    const at = placeMenu({ anchor: tileAt(12), dir: 'rtl', menu: MENU, viewport: { width: 1280, height: 800 } })

    expect(at.side).toBe('right')
    inside(at, 1280, 800)
  })

  it('504 pt minimum window: inside the viewport on every tile, top and bottom tiles clamped vertically', () => {
    for (const top of [-20, 8, 200, 470, 520]) {
      for (const dir of ['ltr', 'rtl'] as const) {
        const left = dir === 'ltr' ? 12 : 504 - 56
        const at = placeMenu({ anchor: tileAt(left, top), dir, menu: MENU, viewport: { width: 504, height: 560 } })

        inside(at, 504, 560)
      }
    }
  })

  it('a menu wider than the room on both sides is clamped, never past either edge', () => {
    const at = placeMenu({
      anchor: tileAt(140),
      dir: 'ltr',
      menu: { width: 300, height: 92 },
      viewport: { width: 420, height: 560 }
    })

    expect(at.left).toBeGreaterThanOrEqual(8)
    expect(at.left + 300).toBeLessThanOrEqual(420 - 8)
  })
})

describe('the Dock split menu writes its own placement', () => {
  beforeAll(() => {
    stubMenuDomApis()
    stubResizeObserver()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    resetPanesForTests()
  })

  it('opens to the right of a left-edge tile, in the offset parent\'s coordinates', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return (this.classList.contains('dock__item')
        ? { left: 12, top: 300, width: 44, height: 44, right: 56, bottom: 344, x: 12, y: 300 }
        : { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0 }) as DOMRect
    })
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(MENU.width)
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(MENU.height)
    vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockImplementation(function (this: HTMLElement) {
      return this.parentElement
    })

    resetPanesForTests()
    $paneArea.set(1000)
    registerPane('message')
    render(
      <Dock items={[{ id: 'email', label: 'Email', icon: 'e', onSelect: () => undefined, split: { pane: 'email', onDrop: vi.fn() } }]} />
    )
    const tile = screen.getByRole('button', { name: 'Email' })

    tile.focus()
    fireEvent.keyDown(tile, { key: 'Enter', shiftKey: true })
    const menu = screen.getByRole('menu')

    expect(menu.dataset.side).toBe('right')
    // Viewport x 66 = tile right 56 + 10 gap; the offset parent (the tile's item box) starts at 12.
    expect(menu.style.left).toBe('54px')
    expect(menu.style.top).toBe('0px')
    expect(menu.style.right).toBe('auto')
  })
})
