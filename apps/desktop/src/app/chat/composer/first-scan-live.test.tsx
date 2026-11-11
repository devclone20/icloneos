// @vitest-environment jsdom
/**
 * CF4 (B2-M1): the chat composer's strip (the isolation note and the first-scan line, as composer/index.tsx renders
 * them) with no Containers pane and no poll. The fake main changes its state and sends `changed` only where the real
 * main does (ipc.ts: a first scan's start, count and end): the line appears after mount, its count advances and it
 * goes away when the scan ends.
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fixtureState } from '@/app/home/containers/containers-fixtures'
import { FirstScanStatus } from '@/app/home/containers/first-scan-status'
import { IsolationComposerNote } from '@/components/permissions/isolation-control'
import type { HardlinkFirstScanView } from '@/iclone-shared/confinement'
import { $confinement } from '@/store/confinement'

let scan: HardlinkFirstScanView | null = null
const listeners = new Set<(notice?: unknown) => void>()

const main = {
  state: vi.fn(async () => ({ ...fixtureState(), firstScan: scan })),
  onChanged: vi.fn((callback: (notice?: unknown) => void) => {
    listeners.add(callback)

    return () => listeners.delete(callback)
  })
}

/** What main does at a first scan's start, progress or end: its state moves, then one `changed` notice, which
 *  carries the running scan (ipc.ts, CF5 B3-n5) and nothing at the end. */
async function mainSays(next: HardlinkFirstScanView | null) {
  scan = next
  await act(async () => {
    listeners.forEach(listener => listener(next ? { firstScan: next } : undefined))
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  scan = null
  listeners.clear()
  main.state.mockClear()
  $confinement.set({ status: 'loading', state: null, error: null })
  Object.assign(window, { hermesDesktop: { icloneConfinement: main } })
})

afterEach(cleanup)

describe("B2-M1: the chat's first-scan line follows main live", () => {
  it('appears for a scan that starts after mount, counts up, and goes away at the end', async () => {
    await act(async () => {
      render(
        <div>
          <IsolationComposerNote />
          <FirstScanStatus />
        </div>
      )
    })
    expect(screen.queryByRole('status')).toBeNull()

    await mainSays({ root: '/p', dirs: 0, startedAt: 1 })
    expect(screen.getByRole('status').textContent).toBe('Checking the project folder… 0 folders')

    await mainSays({ root: '/p', dirs: 52_000, startedAt: 1 })
    expect(screen.getByRole('status').textContent).toBe('Checking the project folder… 52,000 folders')

    await mainSays(null)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('CF5 B3-n5: a first scan that counts 40 times costs each window no state read beyond the mount and the end', async () => {
    await act(async () => {
      render(
        <div>
          <IsolationComposerNote />
          <FirstScanStatus />
        </div>
      )
    })

    const atMount = main.state.mock.calls.length

    for (let dirs = 0; dirs < 40_000; dirs += 1_000) {
      await mainSays({ root: '/p', dirs, startedAt: 1 })
    }

    expect(screen.getByRole('status').textContent).toBe('Checking the project folder… 39,000 folders')
    expect(main.state.mock.calls.length - atMount).toBe(0)

    await mainSays(null)
    expect(screen.queryByRole('status')).toBeNull()
    expect(main.state.mock.calls.length - atMount).toBe(1)
  })
})
