/**
 * K124 (V3-K fix critic r2 m3): the palette's rail-pane rows load lazily (K100 moved the pane registry off the boot
 * path, `use-settings-search.ts` `usePaneSearchRows`). Nothing proved the rows ever reach the palette: a load that
 * never resolves, or a resolve that never sets the rows, left "Sessions & Bots", "Permissions"… missing while the UI
 * suite stayed green. This mounts the real `<CommandPalette/>`, types a pane name that ONLY the lazy rows serve
 * (`sessions-bots` is not in the palette's own settings rows), waits for the row and selects it.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { $commandPaletteOpen, $commandPalettePage, openCommandPalette } from '@/store/command-palette'

import { NON_CONFIG_SETTINGS, SETTINGS_PANE_DESTINATIONS } from './settings-rows'

import { CommandPalette } from './index'

vi.mock(import('@/hermes'), async importOriginal => ({
  ...(await importOriginal()),
  getEnvVars: vi.fn(async () => ({})),
  getHermesConfigRecord: vi.fn(async () => ({})),
  getHermesConfigSchema: vi.fn(async () => ({ fields: {} })),
  listAllProfileSessions: vi.fn(async () => ({ limit: 0, offset: 0, sessions: [], total: 0 }))
}))

const PANE_ID = 'sessions-bots'
const PANE_LABEL = 'Sessions & Bots'

let location = ''
let locationKey = ''
let locationState: unknown = null

function LocationProbe() {
  const current = useLocation()

  location = `${current.pathname}${current.search}`
  locationKey = current.key
  locationState = current.state

  return null
}

/** Whether the navigation carried the Settings arrival marker (settings-arrival.ts). */
const arrived = () => (locationState as { settingsArrival?: unknown } | null)?.settingsArrival === true

const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/']}>
        <CommandPalette />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>
  )

afterEach(() => {
  cleanup()
  $commandPaletteOpen.set(false)
  $commandPalettePage.set(null)
})

const paneOption = () =>
  screen.queryAllByRole('option').find(option => option.textContent?.includes(PANE_LABEL)) ?? null

describe('the palette lists the lazily loaded Settings pane rows (K124)', () => {
  it('the probe pane is served only by the lazy pane rows, never by the palette’s own settings rows', () => {
    const own = new Set([
      ...NON_CONFIG_SETTINGS.map(entry => entry.tab.split('&')[0]),
      ...SETTINGS_PANE_DESTINATIONS.map(entry => entry.tab)
    ])

    // If this ever fails, pick another pane: the test below must not be satisfiable without the lazy load.
    expect(own.has(PANE_ID)).toBe(false)
  })

  it('shows the pane row once the registry chunk resolves, and selecting it opens that pane', async () => {
    mount()
    act(() => openCommandPalette())

    const input = await screen.findByRole('combobox')

    fireEvent.change(input, { target: { value: PANE_LABEL } })

    await waitFor(() => expect(paneOption()).not.toBeNull(), { timeout: 10_000 })

    const option = paneOption()!

    // The row names its rail group too (the detail line), so it is the pane row and not a stray label match.
    expect(option.getAttribute('aria-label')).toMatch(new RegExp(`^${PANE_LABEL}, .+`))

    fireEvent.click(option)

    await waitFor(() => expect(location).toBe(`/settings?tab=${PANE_ID}`))
  })
})

// S-M1 (UI critic, 2026-10-28): a palette row into Settings is an explicit
// arrival — the rail opens that pane's group even when it is the pane already
// on screen. The marker the Settings hook reads travels on THIS navigation, so
// it is proven here, on the real palette, not on a hand-built navigate.
describe('a Settings row chosen in the palette arrives with the marker; any other row never does', () => {
  it('selecting a Settings pane row navigates with location.state.settingsArrival === true', async () => {
    mount()
    act(() => openCommandPalette())

    const input = await screen.findByRole('combobox')

    fireEvent.change(input, { target: { value: PANE_LABEL } })
    await waitFor(() => expect(paneOption()).not.toBeNull(), { timeout: 10_000 })
    fireEvent.click(paneOption()!)

    await waitFor(() => expect(location).toBe(`/settings?tab=${PANE_ID}`))
    expect(arrived()).toBe(true)
  })

  it('selecting a row outside Settings (New session) navigates without the marker', async () => {
    mount()

    const before = locationKey

    act(() => openCommandPalette())

    const input = await screen.findByRole('combobox')

    fireEvent.change(input, { target: { value: 'New session' } })

    const option = await waitFor(
      () => {
        const found = screen.queryAllByRole('option').find(row => row.textContent?.includes('New session'))

        expect(found).toBeDefined()

        return found!
      },
      { timeout: 10_000 }
    )

    fireEvent.click(option)

    await waitFor(() => expect(locationKey).not.toBe(before))
    expect(location.startsWith('/settings')).toBe(false)
    expect(arrived()).toBe(false)
  })
})
