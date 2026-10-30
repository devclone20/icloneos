import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { AcpFailure } from '../cli'

import { failureText } from './data/slots'
import { FailureState } from './market-ui'

const expired: AcpFailure = { error: 'Not authenticated.', kind: 'reauth-acp', ok: false }

describe('Market — an expired Virtuals session says "Sign in again"', () => {
  it('failureText never prints the raw "Not authenticated."', () => {
    expect(failureText(expired)).toBe('Sign in again — the Virtuals session for this iNFT expired.')
    expect(failureText(expired)).not.toMatch(/Not authenticated/)
  })

  it('the pane offers "Sign in again", which opens Setup', () => {
    const onSetup = vi.fn()

    render(
      <FailureState failure={expired} onRetry={() => undefined} onSetup={onSetup} title="Your jobs could not be read" />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }))

    expect(onSetup).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/Not authenticated/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open Setup' })).toBeNull()
  })

  it('a never-configured iNFT keeps "Open Setup"', () => {
    const failure: AcpFailure = { error: 'Agent not configured.', kind: 'not-provisioned', ok: false }

    render(<FailureState failure={failure} onRetry={() => undefined} onSetup={() => undefined} title="x" />)

    expect(screen.getByRole('button', { name: 'Open Setup' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Sign in again' })).toBeNull()
  })
})
