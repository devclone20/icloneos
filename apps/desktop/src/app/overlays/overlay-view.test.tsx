import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { OverlayView } from './overlay-view'

function renderOverlay() {
  const onClose = vi.fn()

  const { container } = render(
    <OverlayView closeLabel="Close" onClose={onClose}>
      <button type="button">Row</button>
    </OverlayView>
  )

  const backdrop = container.querySelector<HTMLElement>('[data-overlay-surface]')

  if (!backdrop) {
    throw new Error('backdrop not rendered')
  }

  return { backdrop, onClose, row: screen.getByRole('button', { name: 'Row' }) }
}

describe('OverlayView backdrop dismissal', () => {
  afterEach(() => {
    cleanup()
  })

  it('closes when the press and the click both land on the backdrop', () => {
    const { backdrop, onClose } = renderOverlay()

    fireEvent.pointerDown(backdrop)
    fireEvent.click(backdrop)

    expect(onClose).toHaveBeenCalledOnce()
  })

  it('stays open when a press inside the card is released on the backdrop', () => {
    const { backdrop, onClose, row } = renderOverlay()

    // Chrome dispatches the click on the common ancestor (the backdrop) when the
    // pointer goes down on a row and comes up just past the card edge.
    fireEvent.pointerDown(row)
    fireEvent.click(backdrop)

    expect(onClose).not.toHaveBeenCalled()
  })

  it('stays open for a click on a row inside the card', () => {
    const { onClose, row } = renderOverlay()

    fireEvent.pointerDown(row)
    fireEvent.click(row)

    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not carry a stale backdrop press into a later drag-out', () => {
    const { backdrop, onClose, row } = renderOverlay()

    fireEvent.pointerDown(backdrop)
    fireEvent.pointerDown(row)
    fireEvent.click(backdrop)

    expect(onClose).not.toHaveBeenCalled()
  })

  it('still closes from the close button', () => {
    const { onClose } = renderOverlay()

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    expect(onClose).toHaveBeenCalledOnce()
  })
})
