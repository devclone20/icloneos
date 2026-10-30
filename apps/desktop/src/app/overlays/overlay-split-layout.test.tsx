import { fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { Info } from '@/lib/icons'

import { OverlayNav } from './overlay-split-layout'

// The row model is not exported (nothing outside the rail builds one by name), so the test reads it off the prop.
type OverlayNavRow = ComponentProps<typeof OverlayNav>['groups'][number]

const link = (id: string, active = false) => ({ active, icon: Info, id, label: `Row ${id}`, onSelect: vi.fn() })

describe('OverlayNav headings', () => {
  it('keeps a plain heading a silent label over always-visible rows (every consumer before Settings)', () => {
    const rows: OverlayNavRow[] = [{ id: 'g', kind: 'heading', label: 'Group' }, link('a'), link('b')]
    const { container } = render(<OverlayNav groups={rows} />)

    expect(screen.queryByRole('button', { name: 'Group' })).toBeNull()
    expect(container.querySelector('[inert]')).toBeNull()
    expect(container.querySelector('[data-tour="nav-a"]')).not.toBeNull()
  })

  it('renders an opted-in heading as a disclosure button; collapsed rows stay present but inert', () => {
    const onToggle = vi.fn()

    const rows: OverlayNavRow[] = [
      { disclosure: { expanded: false, onToggle }, id: 'g1', kind: 'heading', label: 'Profile' },
      link('a'),
      { disclosure: { expanded: true, onToggle: vi.fn() }, id: 'g2', kind: 'heading', label: 'Machine' },
      link('b', true)
    ]

    const { container } = render(<OverlayNav groups={rows} />)
    const heading = container.querySelector<HTMLButtonElement>('[data-nav-heading="g1"]')!

    expect(heading.tagName).toBe('BUTTON')
    expect(heading.getAttribute('aria-expanded')).toBe('false')
    expect(heading.getAttribute('aria-controls')).toBe('g1-rows')

    const closedRegion = container.querySelector('[data-nav-rows="g1"]')!

    expect(closedRegion.hasAttribute('inert')).toBe(true)
    expect(closedRegion.querySelector('[data-tour="nav-a"]')).not.toBeNull()
    expect(container.querySelector('[data-nav-rows="g2"]')!.hasAttribute('inert')).toBe(false)

    fireEvent.click(heading)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('names the current row for assistive tech and shows the heading as written', () => {
    const rows: OverlayNavRow[] = [
      { disclosure: { expanded: true, onToggle: vi.fn() }, id: 'g1', kind: 'heading', label: 'Profile' },
      link('a', true),
      link('b')
    ]

    const { container } = render(<OverlayNav groups={rows} />)
    const heading = container.querySelector<HTMLButtonElement>('[data-nav-heading="g1"]')!

    expect(container.querySelector('[data-tour="nav-a"]')!.getAttribute('aria-current')).toBe('page')
    expect(container.querySelector('[data-tour="nav-b"]')!.hasAttribute('aria-current')).toBe(false)
    expect(heading.textContent).toBe('Profile')
    expect(heading.className).not.toMatch(/\buppercase\b|tracking-/)
  })

  it('walks headings and visible rows with the arrow keys, never into a collapsed group', () => {
    const rows: OverlayNavRow[] = [
      { disclosure: { expanded: false, onToggle: vi.fn() }, id: 'g1', kind: 'heading', label: 'Profile' },
      link('a'),
      { disclosure: { expanded: true, onToggle: vi.fn() }, id: 'g2', kind: 'heading', label: 'Machine' },
      link('b')
    ]

    const { container } = render(<OverlayNav groups={rows} />)
    const first = container.querySelector<HTMLButtonElement>('[data-nav-heading="g1"]')!
    const second = container.querySelector<HTMLButtonElement>('[data-nav-heading="g2"]')!
    const rowB = container.querySelector<HTMLButtonElement>('[data-tour="nav-b"]')!

    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(first.ownerDocument.activeElement).toBe(second)

    fireEvent.keyDown(second, { key: 'ArrowDown' })
    expect(first.ownerDocument.activeElement).toBe(rowB)

    fireEvent.keyDown(rowB, { key: 'Home' })
    expect(first.ownerDocument.activeElement).toBe(first)

    fireEvent.keyDown(first, { key: 'End' })
    expect(first.ownerDocument.activeElement).toBe(rowB)
  })
})
