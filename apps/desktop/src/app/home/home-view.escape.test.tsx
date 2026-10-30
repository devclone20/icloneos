// STAGE tester 1 W-1 on the real HomeView: Dock › Bank Card › Expand › Escape used to CLOSE the window (back to
// Home); doc 07 #7 says Escape retracts. One Escape brings the frame back, the next closes.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { en } from '@/i18n/en'
import { setDockWindowSize } from '@/store/dock-window-size'

import { HomeView } from './home-view'
import { $privySession } from './privy-session'

vi.mock('./stage3d', () => ({
  Stage3D: ({ modelUrl }: { modelUrl: string }) => <div data-model={modelUrl} data-testid="stage3d" />
}))

const copy = en.desktop.home
const bankWindow = () => window.document.querySelector<HTMLElement>('[data-ic-window="bank-card"]')

beforeEach(() => {
  window.localStorage.clear()
  $privySession.set({ status: 'out' })
})

afterEach(() => {
  cleanup()
  setDockWindowSize('maximized')
})

describe('HomeView — Escape on an expanded Dock window', () => {
  it('retracts the Bank window first and closes it only once retracted (W-1)', () => {
    // From the window on its frame: the Settings choice "normal size" (the default has its own case below).
    setDockWindowSize('normal')
    render(
      <MemoryRouter>
        <HomeView mode="stage" onClose={() => undefined} />
      </MemoryRouter>
    )

    fireEvent.click(screen.getByRole('button', { name: copy.tile.bank }))
    expect(bankWindow()).not.toBeNull()

    const title = bankWindow()!.querySelector('h2')?.textContent ?? ''
    fireEvent.click(screen.getByRole('button', { name: copy.expandWindow(title) }))
    expect(bankWindow()!.dataset.expanded).toBe('true')

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(bankWindow()).not.toBeNull()
    expect(bankWindow()!.dataset.expanded).toBeUndefined()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(bankWindow()).toBeNull()
  })

  it('the Dock tile opens the Bank window maximized by default; Escape retracts it, the next Escape closes it', () => {
    render(
      <MemoryRouter>
        <HomeView mode="stage" onClose={() => undefined} />
      </MemoryRouter>
    )

    fireEvent.click(screen.getByRole('button', { name: copy.tile.bank }))
    expect(bankWindow()!.dataset.expanded).toBe('true')

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(bankWindow()!.dataset.expanded).toBeUndefined()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(bankWindow()).toBeNull()
  })
})
