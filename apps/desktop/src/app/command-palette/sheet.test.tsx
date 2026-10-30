import { readFileSync } from 'node:fs'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Palette } from '@/lib/icons'

import { PaletteSheet, type PaletteSheetProps } from './sheet'
import type { PaletteGroup } from './types'

afterEach(cleanup)

const groups: PaletteGroup[] = [
  {
    heading: 'Go to',
    items: [
      { icon: Palette, id: 'one', label: 'Alpha' },
      { icon: Palette, id: 'two', label: 'Beta', action: 'nav.settings' }
    ]
  },
  { heading: 'Commands', items: [{ icon: Palette, id: 'three', label: 'Gamma', to: 'theme' }] }
]

const mount = (overrides: Partial<PaletteSheetProps> = {}) => {
  const props: PaletteSheetProps = {
    bindings: { 'nav.settings': ['mod+,'] },
    groups,
    modHeld: false,
    noResultsLabel: 'Nothing matches',
    onClose: vi.fn(),
    onExited: vi.fn(),
    onSearchChange: vi.fn(),
    onSelect: vi.fn(),
    open: true,
    placeholder: 'Search',
    search: '',
    title: 'Command palette',
    ...overrides
  }

  render(<PaletteSheet {...props} />)

  return props
}

const input = () => screen.getByRole('combobox')
const options = () => screen.getAllByRole('option')

describe('PaletteSheet', () => {
  it('is a modal dialog whose only focus stops are its own controls', () => {
    mount()

    const dialog = screen.getByRole('dialog')

    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-label')).toBe('Command palette')
    // Gate G5 (tester U5-T3): a row is never a focusable element, so the sheet
    // cannot add a control that is invisible yet tabbable.
    expect(dialog.querySelectorAll('[data-icp-focus]')).toHaveLength(1)
    expect(
      dialog.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
    ).toHaveLength(1)

    for (const option of options()) {
      expect(option.hasAttribute('tabindex')).toBe(false)
    }
  })

  it('highlights the best match and addresses it with aria-activedescendant', () => {
    mount()

    expect(options()[0].getAttribute('aria-selected')).toBe('true')
    expect(input().getAttribute('aria-activedescendant')).toBe(options()[0].id)
  })

  it('walks the flat list with the arrows and loops at both ends', () => {
    mount()

    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    expect(options()[1].getAttribute('aria-selected')).toBe('true')

    // Across the group boundary, then past the end back to the top.
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    expect(options()[2].getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    expect(options()[0].getAttribute('aria-selected')).toBe('true')

    fireEvent.keyDown(input(), { key: 'ArrowUp' })
    expect(options()[2].getAttribute('aria-selected')).toBe('true')

    fireEvent.keyDown(input(), { key: 'Home' })
    expect(options()[0].getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(input(), { key: 'End' })
    expect(options()[2].getAttribute('aria-selected')).toBe('true')
  })

  it('hands the selecting modifiers to onSelect, from Enter and from a click', () => {
    const props = mount()

    fireEvent.keyDown(input(), { key: 'Enter', metaKey: true })
    expect(props.onSelect).toHaveBeenCalledWith(groups[0].items[0], {
      ctrlKey: false,
      metaKey: true,
      shiftKey: false
    })

    fireEvent.click(options()[2], { shiftKey: true })
    expect(props.onSelect).toHaveBeenLastCalledWith(groups[1].items[0], {
      ctrlKey: false,
      metaKey: false,
      shiftKey: true
    })
  })

  it('reports the highlighted row so a picker can preview it', () => {
    const onHighlight = vi.fn()

    mount({ onHighlight })
    expect(onHighlight).toHaveBeenLastCalledWith(groups[0].items[0])

    fireEvent.mouseMove(options()[1])
    expect(onHighlight).toHaveBeenLastCalledWith(groups[0].items[1])
  })

  it('closes on Escape at the root, and steps out of a sub-page instead', () => {
    const props = mount()

    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(props.onClose).toHaveBeenCalledTimes(1)

    cleanup()

    const paged = mount({ onBack: vi.fn(), pageTitle: 'Themes' })

    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' })
    expect(paged.onBack).toHaveBeenCalledTimes(1)
    expect(paged.onClose).not.toHaveBeenCalled()

    // Empty-input Backspace is the same step out; with text typed it is editing.
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Backspace' })
    expect(paged.onBack).toHaveBeenCalledTimes(2)
  })

  it('keeps Backspace as editing while something is typed', () => {
    const props = mount({ onBack: vi.fn(), pageTitle: 'Themes', search: 'ab' })

    fireEvent.keyDown(input(), { key: 'Backspace' })
    expect(props.onBack).not.toHaveBeenCalled()
  })

  it('traps Tab inside the sheet', () => {
    mount({ onBack: vi.fn(), pageTitle: 'Themes' })

    const stops = screen.getByRole('dialog').querySelectorAll('[data-icp-focus]')

    expect(stops).toHaveLength(2)

    fireEvent.keyDown(input(), { key: 'Tab' })
    expect(screen.getByRole('dialog').ownerDocument.activeElement).toBe(stops[0])
  })

  it('says nothing matched only when the list is really empty', () => {
    mount({ groups: [] })

    expect(screen.getByText('Nothing matches')).toBeTruthy()
    expect(screen.queryAllByRole('option')).toHaveLength(0)
  })

  it('renders a sub-page status in place of the rows, and points at nothing while it shows', () => {
    // Non-empty groups on purpose: the rows exist in the data and are NOT on
    // screen, so the sheet must not name one in `aria-activedescendant` nor
    // run one on Enter (gate G5 — an invisible command is not activatable).
    const props = mount({ groups, status: <p>Loading themes…</p> })

    expect(screen.getByText('Loading themes…')).toBeTruthy()
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(input().getAttribute('aria-activedescendant')).toBe(null)

    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(props.onSelect).not.toHaveBeenCalled()
  })

  it('tabs to the stop that can take focus, skipping a disabled sibling', () => {
    // A Marketplace row greys out while another installs: the disabled rows
    // stay in the DOM, so a Tab cycle that counted them no-op'd on the one
    // stop the user needs (the busy row).
    mount({
      status: (
        <div>
          <button data-icp-focus disabled type="button">
            Idle
          </button>
          <button data-icp-focus type="button">
            Installing
          </button>
        </div>
      )
    })

    fireEvent.keyDown(input(), { key: 'Tab' })

    const busy = screen.getByRole('button', { name: 'Installing' })

    expect(busy.ownerDocument.activeElement).toBe(busy)
  })

  it('shows the live combo of a row that has a keybind action', () => {
    mount()

    expect(screen.getByRole('dialog').querySelectorAll('.icp-key').length).toBeGreaterThan(0)
  })

  it('retires only when the CLOSE animation of the card itself ends', () => {
    const props = mount({ open: false })
    const card = screen.getByRole('dialog')

    fireEvent.animationEnd(options()[0])
    expect(props.onExited).not.toHaveBeenCalled()

    fireEvent.animationEnd(card)
    expect(props.onExited).toHaveBeenCalledTimes(1)
  })
})

// jsdom loads no stylesheet, so the only place this invariant can be asserted
// is the stylesheet itself.
describe('sheet.css', () => {
  const css = readFileSync('src/app/command-palette/sheet.css', 'utf8')

  it('claims pointer events back on the open state, which a modal Radix layer takes from the body', () => {
    // @radix-ui/react-dismissable-layer sets body { pointer-events: none } for
    // a modal layer's whole lifetime; we portal to document.body, so without
    // this the rows and the scrim are dead to the mouse while the keyboard
    // still works.
    expect(css).toMatch(/\.icp-root\[data-state='open'\]\s*\{[^}]*pointer-events:\s*auto/)
  })

  it('still lets a click through the exit animation', () => {
    expect(css).toMatch(/\.icp-root\[data-state='closed'\]\s*\{[^}]*pointer-events:\s*none/)
  })
})
