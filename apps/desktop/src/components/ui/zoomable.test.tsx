import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { Zoomable } from './zoomable'

afterEach(cleanup)

describe('Zoomable', () => {
  it('names the trigger in a tooltip and opens the full-view overlay when it is clicked', async () => {
    render(
      <Zoomable label="Open diagram" overlay={<div data-testid="overlay">Expanded diagram</div>}>
        <div>Inline diagram</div>
      </Zoomable>
    )

    const trigger = screen.getByRole('button', { name: 'Inline diagram' })

    fireEvent.pointerMove(trigger, { pointerType: 'mouse' })
    expect((await screen.findByRole('tooltip')).textContent).toContain('Open diagram')

    expect(screen.queryByTestId('overlay')).toBeNull()
    fireEvent.click(trigger)
    expect(screen.getByTestId('overlay')).toBeTruthy()
  })

  it('gives the full-view stage flex space inside the fixed-height dialog', () => {
    render(
      <Zoomable label="Open diagram" overlay={<div data-testid="overlay">Expanded diagram</div>}>
        <div>Inline diagram</div>
      </Zoomable>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Inline diagram' }))

    const dialog = screen.getByRole('dialog')
    const body = dialog.firstElementChild

    // jsdom does not compute flex layout, so height stays 0 either way. The
    // contract that actually failed in Electron is: the body must grow
    // (`flex-1`) inside the h-[85vh] shell, and the pan/zoom stage must too.
    expect(body?.classList.contains('flex-1')).toBe(true)
    expect(body?.classList.contains('min-h-0')).toBe(true)

    const stage = body?.querySelector('.flex-1.overflow-hidden')

    expect(stage).toBeTruthy()
    expect(stage?.contains(screen.getByTestId('overlay'))).toBe(true)
  })
})
