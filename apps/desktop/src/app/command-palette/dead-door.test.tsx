/**
 * A door that names a palette page we do not have must not take the window
 * down with it. The HARD failure for a dead door is `routes-commands.test.ts`,
 * which walks all of `src`; at runtime the palette logs, stays standing and
 * shows the root list. This mounts the real `<CommandPalette/>` under an error
 * boundary, the way `main.tsx` does, and proves the boundary never trips.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { Component, type ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $commandPaletteOpen, $commandPalettePage, openCommandPalettePage } from '@/store/command-palette'

import { CommandPalette } from './index'

vi.mock(import('@/hermes'), async importOriginal => ({
  ...(await importOriginal()),
  getHermesConfigRecord: vi.fn(async () => ({})),
  listAllProfileSessions: vi.fn(async () => ({ limit: 0, offset: 0, sessions: [], total: 0 }))
}))

class Boundary extends Component<{ children: ReactNode }, { crashed: boolean }> {
  state = { crashed: false }

  static getDerivedStateFromError() {
    return { crashed: true }
  }

  render() {
    return this.state.crashed ? <div data-testid="crashed" /> : this.props.children
  }
}

const mount = () =>
  render(
    <Boundary>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <CommandPalette />
        </MemoryRouter>
      </QueryClientProvider>
    </Boundary>
  )

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  $commandPaletteOpen.set(false)
  $commandPalettePage.set(null)
})

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('a palette door into nothing', () => {
  it('logs once, keeps the window up and opens the root list', async () => {
    // The door fires while the app is already up, which is the only way it
    // ever happens: a slash command, a keystroke, a keybind.
    mount()
    act(() => openCommandPalettePage('not-a-page'))

    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())

    expect(screen.queryByTestId('crashed')).toBeNull()
    // Named once, where a developer sees it; the id itself never becomes a
    // user-facing string (the notice line is dev-only).
    const logged = vi.mocked(console.error).mock.calls.filter(call => String(call[0]).includes('no page "not-a-page"'))

    expect(logged).toHaveLength(1)
    // The root list, not a blank sheet: the rows are still there to use.
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0)
    // And the door is consumed, so a reopen does not land on it again.
    expect($commandPalettePage.get()).toBeNull()
  })

  it('opens a declared page instead of the root list', async () => {
    mount()
    act(() => openCommandPalettePage('theme'))

    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())

    expect(screen.queryByTestId('crashed')).toBeNull()
    expect(vi.mocked(console.error).mock.calls.filter(c => String(c[0]).includes('no page'))).toHaveLength(0)
    // A sub-page heads its rows with the Back crumb; the root list has none.
    await waitFor(() => expect(globalThis.document.querySelector('.icp-back')).toBeTruthy())
  })
})
