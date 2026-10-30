import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Activity } from '@/lib/icons'

import { PageFrame } from './page-frame'

// The frame is the one window shape our pages wear, so these pin the contract
// every page inherits: our markup (no upstream card), a close control, Esc,
// a scrim that only dismisses a press that started on it, and a rail that says
// which section is current.
//
// `frame="bare"` (front K5) is the same page inside a shell that already drew
// the card — the Settings body. The LAST describe pins what must NOT be there,
// by count: a second card, a second ✕, a second focus trap and a second
// overlay marker are each a defect you only see by looking for absence.

afterEach(cleanup)

const sections = [
  { icon: Activity, id: 'one', label: 'One' },
  { icon: Activity, id: 'two', label: 'Two' }
] as const

function setup(onClose = vi.fn(), onSelectSection = vi.fn()) {
  const view = render(
    <PageFrame
      closeLabel="Close"
      hint="One sentence."
      onClose={onClose}
      onSelectSection={onSelectSection}
      section="one"
      sections={sections}
      title="Title"
      tools={<button type="button">Tool</button>}
    >
      <p>Body</p>
    </PageFrame>
  )

  return { onClose, onSelectSection, view }
}

describe('PageFrame', () => {
  it('renders head, tools, rail and body on our own markup', () => {
    setup()

    expect(screen.getByRole('heading', { level: 2, name: 'Title' })).toBeTruthy()
    expect(screen.getByText('One sentence.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Tool' })).toBeTruthy()
    expect(screen.getByText('Body')).toBeTruthy()

    const frame = globalThis.document.querySelector('.icpage__frame')

    expect(frame).toBeTruthy()
    // The overlay marker is what tells the composer it is covered.
    expect(globalThis.document.querySelector('[data-overlay-surface]')).toBeTruthy()
    expect(frame?.getAttribute('data-glass-raised')).toBe('')
  })

  it('marks the current rail item and reports a selection', () => {
    const { onSelectSection } = setup()

    expect(screen.getByRole('button', { name: 'One' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('button', { name: 'Two' }).getAttribute('aria-current')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Two' }))
    expect(onSelectSection).toHaveBeenCalledWith('two')
  })

  it('closes on the control and on Escape', () => {
    const { onClose } = setup()

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(globalThis.document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('closes on a scrim press, but not on a drag that began inside', () => {
    const { onClose } = setup()
    const scrim = globalThis.document.querySelector('.icpage')!

    fireEvent.pointerDown(screen.getByText('Body'))
    fireEvent.click(scrim)
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.pointerDown(scrim)
    fireEvent.click(scrim)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('takes focus on mount and needs no rail at all', () => {
    const onClose = vi.fn()

    cleanup()
    render(
      <PageFrame closeLabel="Close" onClose={onClose} title="Bare">
        <p>Only</p>
      </PageFrame>
    )

    expect(globalThis.document.querySelector('.icpage__rail')).toBeNull()
    expect(globalThis.document.activeElement).toBe(globalThis.document.querySelector('.icpage__frame'))
  })
})

describe('PageFrame · frame="bare" (inside the Settings body)', () => {
  function setupBare(onSelectSection = vi.fn()) {
    render(
      <PageFrame
        frame="bare"
        hint="One sentence."
        onSelectSection={onSelectSection}
        section="one"
        sections={sections}
        title="Title"
        tools={<button type="button">Tool</button>}
      >
        <p>Body</p>
      </PageFrame>
    )

    return { onSelectSection }
  }

  it('renders the same head, tools, rail and body', () => {
    const { onSelectSection } = setupBare()

    expect(screen.getByRole('heading', { level: 2, name: 'Title' })).toBeTruthy()
    expect(screen.getByText('One sentence.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Tool' })).toBeTruthy()
    expect(screen.getByText('Body')).toBeTruthy()
    expect(globalThis.document.querySelector('.icpage-embed')).toBeTruthy()

    expect(screen.getByRole('button', { name: 'One' }).getAttribute('aria-current')).toBe('page')
    fireEvent.click(screen.getByRole('button', { name: 'Two' }))
    expect(onSelectSection).toHaveBeenCalledWith('two')
  })

  it('draws no second card, no second close control and no second focus trap', () => {
    const active = globalThis.document.activeElement

    setupBare()

    expect(globalThis.document.querySelectorAll('.icpage')).toHaveLength(0)
    expect(globalThis.document.querySelectorAll('.icpage__frame')).toHaveLength(0)
    expect(globalThis.document.querySelectorAll('.icpage__drag')).toHaveLength(0)
    expect(globalThis.document.querySelectorAll('[data-overlay-surface]')).toHaveLength(0)
    // Two controls in the head's own tools, and no ✕ among them.
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
    // The Settings shell owns focus: a bare page must not move it on mount.
    expect(globalThis.document.activeElement).toBe(active)
  })

  it('leaves Escape to the shell', () => {
    setupBare()

    // Nothing to assert a call against — the point is that no listener exists.
    // A throw here would be the regression (the card path reads `onClose`).
    fireEvent.keyDown(globalThis.document, { key: 'Escape' })
    expect(screen.getByText('Body')).toBeTruthy()
  })
})
