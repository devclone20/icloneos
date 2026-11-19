import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { stubMenuDomApis, stubResizeObserver } from '@/test/jsdom'

import { retractWindow } from './expanded'
import { IcWindow } from './ic-window'
import { resetPanesForTests } from './pane-layout'

const LABELS = { close: 'Close', expand: 'Expand', retract: 'Retract', opacity: 'Opacity' }

// v0.0.9 F6: the column's expand/retract button became the window menu; its Fill option is the old expand. `toggle`
// is now the menu's icon — the control a press lands on — and `fill` chooses Fill the way the case says.
function renderWindow(placement: 'self' | 'under-shell', expanded: boolean) {
  const onToggleExpanded = vi.fn()
  const base = { head: null, labels: LABELS, onClose: vi.fn(), onToggleExpanded }

  const view = (open: boolean) =>
    placement === 'self' ? (
      <IcWindow {...base} expanded={open} id="wallet" label="Wallet" placement="self" />
    ) : (
      <IcWindow {...base} expanded={open} headBand="40px" id="message" placement="under-shell" />
    )

  const { rerender } = render(view(expanded))
  const toggle = screen.getByRole('button', { name: /^Window options for / })

  const fill = (by: 'keyboard' | 'pointer') => {
    if (by === 'keyboard') {
      fireEvent.keyDown(toggle, { key: 'Enter' })
      fireEvent.keyDown(screen.getAllByRole('menuitem')[0], { key: 'ArrowDown' })
      fireEvent.keyDown(screen.getAllByRole('menuitem')[1], { key: 'ArrowDown' })
      fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Fill' }), { key: 'Enter' })
    } else {
      fireEvent.click(toggle, { detail: 1 })

      const item = screen.getByRole('menuitem', { name: 'Fill' })

      press(item)
      fireEvent.pointerUp(item)
      fireEvent.click(item, { detail: 1 })
    }
  }

  // The owner flips `expanded` on toggle; the mock does not, so the test does.
  return { fill, onToggleExpanded, setExpanded: (open: boolean) => rerender(view(open)), toggle }
}

/** Chrome matches :focus-visible on a keyboard-focused control and not on a mouse-focused one; jsdom guesses, so
 *  the test says which. */
function focusVisible(target: HTMLElement, visible: boolean) {
  const matches = target.matches.bind(target)

  Object.defineProperty(target, 'matches', {
    configurable: true,
    value: (selector: string) => (selector === ':focus-visible' ? visible : matches(selector))
  })
}

/** Chrome focuses a control on pointerdown; jsdom does not, so the press does it by hand. */
function press(target: HTMLElement) {
  fireEvent.pointerDown(target, { clientY: 50 })
  target.focus()
}

/** The slider reads its track's box on a press; jsdom lays nothing out, so it gets one. */
function pressSlider(slider: HTMLElement) {
  const track = slider.firstElementChild as HTMLElement
  vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({ height: 100, top: 0 } as DOMRect)
  press(slider)
}

describe('the control column', () => {
  beforeAll(() => {
    stubResizeObserver()
    stubMenuDomApis()
  })
  afterEach(() => {
    cleanup()
    resetPanesForTests()
  })

  describe.each(['self', 'under-shell'] as const)('placement %s', placement => {
    it('retracted: a pointer press + release on the opacity slider keeps its focus, so the arrow keys fine-tune it', () => {
      renderWindow(placement, false)
      const slider = screen.getByRole('slider')
      const doc = slider.ownerDocument

      pressSlider(slider)
      fireEvent.pointerUp(slider)

      expect(doc.activeElement).toBe(slider)

      const before = Number(slider.getAttribute('aria-valuenow'))

      fireEvent.keyDown(doc.activeElement as HTMLElement, { key: 'ArrowDown' })

      expect(Number(slider.getAttribute('aria-valuenow'))).toBeLessThan(before)
    })

    it('retracted: a press on × released outside the column keeps its focus', () => {
      renderWindow(placement, false)
      const close = screen.getByRole('button', { name: LABELS.close })

      press(close)
      fireEvent.pointerUp(close.ownerDocument.body)

      expect(close.ownerDocument.activeElement).toBe(close)
    })

    it('the column has no expand/retract button any more: the window menu replaced it (F6)', () => {
      renderWindow(placement, false)

      expect(screen.queryByRole('button', { name: LABELS.expand })).toBeNull()
      expect(screen.queryByRole('button', { name: LABELS.retract })).toBeNull()
      expect(screen.getByRole('button', { name: /^Window options for / }).getAttribute('aria-haspopup')).toBe('menu')
    })

    it('a pointer choice of Fill expands and lets go of focus, so a later key press cannot pin the hidden column', () => {
      const { fill, onToggleExpanded, setExpanded, toggle } = renderWindow(placement, false)
      const doc = toggle.ownerDocument
      const column = toggle.closest('.ic-win__controls')!

      press(toggle)
      fireEvent.pointerUp(toggle)
      fill('pointer')

      expect(onToggleExpanded).toHaveBeenCalledTimes(1)

      setExpanded(true)

      expect(column.contains(doc.activeElement)).toBe(false)
    })

    it('Fill chosen from the keyboard keeps focus on the menu icon through the expansion, for Tab users', () => {
      const { fill, onToggleExpanded, setExpanded, toggle } = renderWindow(placement, false)

      toggle.focus()
      focusVisible(toggle, true)
      fill('keyboard')
      setExpanded(true)

      expect(onToggleExpanded).toHaveBeenCalledTimes(1)
      expect(toggle.ownerDocument.activeElement).toBe(toggle)

      // Filled, the menu says so: Fill is the active option.
      fireEvent.keyDown(toggle, { key: 'Enter' })
      expect(screen.getByRole('menuitem', { name: 'Fill' }).dataset.active).toBe('true')
    })

    it('expanded: a pointer choice of Fill brings it back and lets go of focus', () => {
      const { fill, onToggleExpanded, toggle } = renderWindow(placement, true)

      fill('pointer')

      expect(onToggleExpanded).toHaveBeenCalledTimes(1)
      expect(toggle.ownerDocument.activeElement).toBe(toggle.ownerDocument.body)
    })

    it('expanded: Fill from the keyboard brings it back and keeps focus for Tab users', () => {
      const { fill, onToggleExpanded, toggle } = renderWindow(placement, true)

      toggle.focus()
      focusVisible(toggle, true)
      fill('keyboard')

      expect(onToggleExpanded).toHaveBeenCalledTimes(1)
      expect(toggle.ownerDocument.activeElement).toBe(toggle)
    })

    it('expanded: a pointer press + release on the opacity slider leaves no focus behind', () => {
      renderWindow(placement, true)
      const slider = screen.getByRole('slider')

      pressSlider(slider)
      expect(slider.ownerDocument.activeElement).toBe(slider)

      fireEvent.pointerUp(slider)

      expect(slider.ownerDocument.activeElement).toBe(slider.ownerDocument.body)
    })

    it('expanded: keyboard focus on the opacity slider stays through key presses', () => {
      renderWindow(placement, true)
      const slider = screen.getByRole('slider')

      slider.focus()
      fireEvent.keyDown(slider, { key: 'ArrowUp' })

      expect(slider.ownerDocument.activeElement).toBe(slider)
    })

    it('expanded: a press that began on a control and is released outside the column still drops its focus', () => {
      renderWindow(placement, true)
      const close = screen.getByRole('button', { name: LABELS.close })

      press(close)
      fireEvent.pointerUp(close.ownerDocument.body)

      expect(close.ownerDocument.activeElement).toBe(close.ownerDocument.body)
    })

    it('a press outside the column never touches focus elsewhere', () => {
      const { toggle } = renderWindow(placement, true)
      const doc = toggle.ownerDocument
      const outside = doc.createElement('button')
      doc.body.append(outside)

      outside.focus()
      fireEvent.pointerDown(outside)
      fireEvent.pointerUp(outside)

      expect(doc.activeElement).toBe(outside)
      outside.remove()
    })
  })

  it.each(['self', 'under-shell'] as const)(
    '%s: an expanded window leaves its toggle as the retract for the Escape routers (W-1)',
    placement => {
      const { onToggleExpanded, setExpanded } = renderWindow(placement, true)

      expect(retractWindow(placement === 'self' ? 'wallet' : 'message')).toBe(true)
      expect(onToggleExpanded).toHaveBeenCalledTimes(1)

      setExpanded(false)
      expect(retractWindow(placement === 'self' ? 'wallet' : 'message')).toBe(false)
      expect(onToggleExpanded).toHaveBeenCalledTimes(1)
    }
  )

  it('only an expanded window marks its control column for auto-hide', () => {
    const { toggle } = renderWindow('self', true)

    expect(toggle.closest<HTMLElement>('.ic-win__controls')?.dataset.autohide).toBe('true')
    cleanup()

    const collapsed = renderWindow('self', false)

    expect(collapsed.toggle.closest<HTMLElement>('.ic-win__controls')?.dataset.autohide).toBeUndefined()
  })
})

describe('opening filled takes the focus off the Dock (Dock windows open maximized)', () => {
  beforeAll(() => {
    stubResizeObserver()
    stubMenuDomApis()
  })
  afterEach(() => {
    cleanup()
    resetPanesForTests()
  })

  function dockTile() {
    const nav = window.document.createElement('nav')
    const tile = window.document.createElement('button')

    nav.className = 'dock'
    nav.append(tile)
    window.document.body.append(nav)
    tile.focus()

    return { nav, tile }
  }

  it('an under-shell window that opens expanded releases a focus a Dock tile holds', () => {
    const { nav, tile } = dockTile()

    expect(window.document.activeElement).toBe(tile)
    renderWindow('under-shell', true)
    expect(window.document.activeElement).not.toBe(tile)
    expect(nav.contains(window.document.activeElement)).toBe(false)
    nav.remove()
  })

  it('opening at its usual size leaves the tile focused, as before', () => {
    const { nav, tile } = dockTile()

    renderWindow('under-shell', false)
    expect(window.document.activeElement).toBe(tile)
    nav.remove()
  })

  it('a focus outside the Dock is never taken', () => {
    const field = window.document.createElement('input')

    window.document.body.append(field)
    field.focus()
    renderWindow('under-shell', true)
    expect(window.document.activeElement).toBe(field)
    field.remove()
  })
})
