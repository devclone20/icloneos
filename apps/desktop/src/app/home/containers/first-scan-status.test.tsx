import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { $confinement } from '@/store/confinement'

import { fixtureState } from './containers-fixtures'
import { FirstScanStatus } from './first-scan-status'

const withScan = (firstScan: { root: string; dirs: number; startedAt: number } | null) =>
  act(() => {
    $confinement.set({ status: 'ready', state: { ...fixtureState(), firstScan } as never, error: null })
  })

afterEach(() => {
  cleanup()
  $confinement.set({ status: 'loading', state: null, error: null })
})

describe('FirstScanStatus', () => {
  it('says, calmly and as a status, that the project folder is being checked, with the folders counted', () => {
    render(<FirstScanStatus />)
    withScan({ root: '/p', dirs: 12345, startedAt: 1 })

    const line = screen.getByRole('status')

    expect(line.textContent).toBe('Checking the project folder… 12,345 folders')
    expect(line.className).not.toMatch(/warning|danger/)
  })

  it('counts one folder in the singular and follows the count as it grows', () => {
    render(<FirstScanStatus />)
    withScan({ root: '/p', dirs: 1, startedAt: 1 })
    expect(screen.getByRole('status').textContent).toBe('Checking the project folder… 1 folder')
    withScan({ root: '/p', dirs: 40, startedAt: 1 })
    expect(screen.getByRole('status').textContent).toBe('Checking the project folder… 40 folders')
  })

  it('renders nothing when no scan is running, or when the state has no such field', () => {
    render(<FirstScanStatus />)
    withScan(null)
    expect(screen.queryByRole('status')).toBeNull()
    act(() => {
      $confinement.set({ status: 'ready', state: fixtureState(), error: null })
    })
    expect(screen.queryByRole('status')).toBeNull()
  })
})
