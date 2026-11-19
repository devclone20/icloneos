/**
 * v0.0.9 F4 — type 2, the status banner: one at a time by priority, no ✕ while the state lasts (it collapses), the
 * cause wrapped whole; the agent-stopped banner (F3) renders through it. Fails on the old banner, which drew its own
 * card with `truncate` on the cause and had no arbitration.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useLayoutEffect, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { f3Banner } from '@/i18n/en/v009-f3'
import { f4Banner } from '@/i18n/en/v009-f4'

import { AgentStoppedBanner } from './agent-stopped-banner'
import { holdsBand, IcStatusBanner } from './status-banner'

afterEach(cleanup)

const LONG_CAUSE =
  'The agent could not write its install record: an older record of this runtime sits in ~/.hermes/installs, a folder the sandbox never lets the agent write.'

describe('holdsBand', () => {
  it('gives the band to the highest priority; the first one keeps a tie', () => {
    const claims = [
      { key: 'a', priority: 1 },
      { key: 'b', priority: 5 },
      { key: 'c', priority: 5 }
    ]

    expect(holdsBand(claims, 'b')).toBe(true)
    expect(holdsBand(claims, 'a')).toBe(false)
    expect(holdsBand(claims, 'c')).toBe(false)
  })
})

describe('IcStatusBanner', () => {
  it('shows one banner at a time, by priority, and the next one when it leaves', () => {
    let hideHigh: () => void = () => undefined

    function Both() {
      const [high, setHigh] = useState(true)

      hideHigh = () => setHigh(false)

      return (
        <>
          <IcStatusBanner testId="low" title="Credits are low" tone="warning" />
          {high ? <IcStatusBanner priority={100} testId="high" title="The agent is not running" /> : null}
        </>
      )
    }

    render(<Both />)

    expect(screen.getByTestId('high')).toBeTruthy()
    expect(screen.queryByTestId('low')).toBeNull()

    act(() => hideHigh())

    expect(screen.queryByTestId('high')).toBeNull()
    expect(screen.getByTestId('low')).toBeTruthy()
  })

  it('two banners mounting in one commit: no frame ever holds both, and the winner paints (Q renderer 7)', () => {
    const seen: number[] = []

    // Runs its layout effect in every commit, after the banners' own (it is mounted after them): what it counts is
    // what that commit would paint.
    function Probe() {
      useLayoutEffect(() => {
        seen.push(globalThis.document.querySelectorAll('[data-slot="ic-banner"]').length)
      })

      return null
    }

    function Both() {
      const [tick, setTick] = useState(0)

      useLayoutEffect(() => {
        if (tick === 0) {
          setTick(1)
        }
      }, [tick])

      return (
        <>
          <IcStatusBanner priority={100} title="Agent not running" />
          <IcStatusBanner priority={70} title="Credits are out" />
          <Probe key={tick} />
        </>
      )
    }

    render(<Both />)

    expect(seen.length).toBeGreaterThan(0)
    expect(Math.max(...seen)).toBeLessThanOrEqual(1)
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(screen.getByText('Agent not running')).toBeTruthy()
    expect(screen.queryByText('Credits are out')).toBeNull()
  })

  it('has no close; it collapses to its title and expands again', () => {
    render(<IcStatusBanner cause={LONG_CAUSE} testId="b" title="The agent is not running" />)

    expect(screen.queryByRole('button', { name: /close|dismiss/i })).toBeNull()
    expect(screen.getByTestId('b').textContent).toContain(LONG_CAUSE)

    fireEvent.click(screen.getByRole('button', { name: f4Banner.collapse }))
    expect(screen.getByTestId('b').textContent).not.toContain(LONG_CAUSE)
    expect(screen.getByTestId('b').textContent).toContain('The agent is not running')

    fireEvent.click(screen.getByRole('button', { name: f4Banner.expand }))
    expect(screen.getByTestId('b').textContent).toContain(LONG_CAUSE)
  })
})

describe('AgentStoppedBanner through the status banner', () => {
  it('renders on the banner primitive, with the whole cause and no truncation', () => {
    render(<AgentStoppedBanner cause={LONG_CAUSE} onRetry={vi.fn()} onShowDetails={vi.fn()} />)

    const banner = screen.getByTestId('agent-stopped-banner')

    expect(banner.querySelector('[data-slot="ic-banner"]')).not.toBeNull()
    expect(banner.textContent).toContain(LONG_CAUSE)
    expect(banner.querySelector('.truncate')).toBeNull()
  })

  it('keeps Retry and Show details by their F3 names', () => {
    const onRetry = vi.fn()
    const onShowDetails = vi.fn()

    render(<AgentStoppedBanner cause={null} onRetry={onRetry} onShowDetails={onShowDetails} />)

    fireEvent.click(screen.getByRole('button', { name: f3Banner.retry }))
    fireEvent.click(screen.getByRole('button', { name: f3Banner.details }))

    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onShowDetails).toHaveBeenCalledTimes(1)
  })
})
