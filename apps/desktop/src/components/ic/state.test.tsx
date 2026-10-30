import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { IcPageState } from './ic-page'
import { IcState } from './state'

afterEach(cleanup)

describe('IcState', () => {
  // The page chassis' old name must stay the same binding, not a copy: a second
  // body is how the three sets of primitives happened in the first place.
  it('is the one the page chassis exports as IcPageState', () => {
    expect(IcPageState).toBe(IcState)
  })

  it('speaks each kind to a screen reader', () => {
    const { container } = render(<IcState kind="loading" title="Loading" />)
    const loading = screen.getByRole('status')

    expect(loading.getAttribute('aria-busy')).toBe('true')
    expect(loading.getAttribute('aria-live')).toBe('polite')
    expect(container.querySelector('.icpg__spinner')).toBeTruthy()

    cleanup()
    render(<IcState kind="error" title="Failed" />)
    const failed = screen.getByRole('alert')

    expect(failed.getAttribute('aria-busy')).toBeNull()
    expect(failed.getAttribute('aria-live')).toBeNull()

    cleanup()
    render(<IcState kind="empty" title="Nothing yet" />)
    expect(screen.getByRole('status').getAttribute('aria-busy')).toBeNull()
  })

  // The two props the merge took from the other shapes (contract IC §3).
  it('renders the icon and keeps a call site class next to ours', () => {
    const { container } = render(
      <IcState className="icpg__state--inline" icon={<svg data-testid="glyph" />} kind="empty" title="No profiles" />
    )

    const state = screen.getByRole('status')

    expect(screen.getByTestId('glyph')).toBeTruthy()
    expect(state.className).toBe('icpg__state icpg__state--empty icpg__state--inline')
    expect(state.getAttribute('data-ic-state')).toBe('empty')
    expect(container.querySelector('.icpg__state-title')?.textContent).toBe('No profiles')
  })
})
