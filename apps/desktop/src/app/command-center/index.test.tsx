import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getStatus, getUsageAnalytics } from '@/hermes'
import type * as HermesApi from '@/hermes'
import { exportSession } from '@/lib/session-export'
import { pinSession } from '@/store/layout'
import type * as LayoutStore from '@/store/layout'
import { $sessions } from '@/store/session'
import type { SessionInfo } from '@/types/hermes'

import { CommandCenterView } from './index'

type HermesModule = typeof HermesApi
type LayoutModule = typeof LayoutStore

// Real i18n and the real $sessions store; the gateway and the maintenance pane
// are stubbed. What is pinned here is the user's work surviving the page: the
// list order, the search, every row action, the System fetch and its error, and
// the Usage retry.

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<HermesModule>()),
  getActionStatus: vi.fn(async () => ({ exit_code: 0, lines: [], name: 'restart', pid: 1, running: false })),
  getLogs: vi.fn(async () => ({ lines: ['INFO ready', 'ERROR broke'] })),
  getStatus: vi.fn(async () => ({ active_sessions: 2, gateway_running: true, version: '1.2.3' })),
  getUsageAnalytics: vi.fn(async () => ({ by_model: [], daily: [], skills: { top_skills: [] }, totals: null })),
  restartGateway: vi.fn(async () => ({ name: 'restart', pid: 1 })),
  updateHermes: vi.fn(async () => ({ name: 'update', pid: 2 }))
}))

vi.mock('@/lib/session-export', () => ({ exportSession: vi.fn(async () => undefined) }))

vi.mock('@/store/layout', async importOriginal => {
  const actual = await importOriginal<LayoutModule>()

  return { ...actual, pinSession: vi.fn(), unpinSession: vi.fn() }
})

vi.mock('@/store/activity', () => ({ upsertDesktopActionTask: vi.fn() }))

vi.mock('./maintenance', () => ({ MaintenancePanel: () => <p>maintenance stub</p> }))

const session = (id: string, lastActive: number): SessionInfo =>
  ({ id, last_active: lastActive, started_at: lastActive, title: id }) as SessionInfo

// The section comes off the URL, never a prop: Command Center is a Settings
// pane since front K5 and `?section=` is how a rail row deep-links one.
function open(initialSection?: 'maintenance' | 'sessions' | 'system' | 'usage') {
  const onDeleteSession = vi.fn(async () => undefined)
  const onOpenSession = vi.fn()

  render(
    <MemoryRouter initialEntries={[initialSection ? `/?section=${initialSection}` : '/']}>
      <CommandCenterView onDeleteSession={onDeleteSession} onOpenSession={onOpenSession} />
    </MemoryRouter>
  )

  return { onDeleteSession, onOpenSession }
}

beforeEach(() => {
  $sessions.set([session('older', 100), session('newest', 900)])
})

afterEach(() => {
  cleanup()
  $sessions.set([])
  vi.clearAllMocks()
})

describe('CommandCenterView · sessions', () => {
  it('lists sessions newest first and opens one', () => {
    const { onOpenSession } = open()
    const titles = [...globalThis.document.querySelectorAll('.icui-row__title')].map(node => node.textContent)

    expect(titles).toEqual(['newest', 'older'])

    fireEvent.click(screen.getByRole('button', { name: /newest/ }))
    expect(onOpenSession).toHaveBeenCalledWith('newest')
  })

  it('filters by the debounced search and says so when nothing matches', async () => {
    open()
    fireEvent.change(screen.getByRole('searchbox', { name: /Search sessions/ }), { target: { value: 'zzz' } })

    await waitFor(() => expect(globalThis.document.querySelectorAll('.icui-row__title')).toHaveLength(0))
    expect(screen.getByText('No matching results found.')).toBeTruthy()
  })

  it('pins, exports and deletes a row through its own actions', () => {
    const { onDeleteSession } = open()

    fireEvent.click(screen.getAllByRole('button', { name: /pin/i })[0]!)
    expect(pinSession).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getAllByRole('button', { name: /export/i })[0]!)
    expect(exportSession).toHaveBeenCalledWith('newest', expect.objectContaining({ title: 'newest' }))

    fireEvent.click(screen.getAllByRole('button', { name: /delete/i })[0]!)
    expect(onDeleteSession).toHaveBeenCalledWith('newest')
  })

  it('shows the empty state with no sessions at all', () => {
    $sessions.set([])
    open()
    expect(globalThis.document.querySelectorAll('.icui-row__title')).toHaveLength(0)
  })
})

describe('CommandCenterView · system and usage', () => {
  it('reads the gateway status and the log tail, and filters the tail', async () => {
    open('system')

    expect(await screen.findByText(/Gateway running|running/i)).toBeTruthy()
    await waitFor(() => expect(globalThis.document.querySelector('.icui-mono')?.textContent).toContain('ERROR broke'))

    fireEvent.change(screen.getByRole('searchbox', { name: /filter|search/i }), { target: { value: 'INFO' } })
    expect(globalThis.document.querySelector('.icui-mono')?.textContent).toBe('INFO ready')
  })

  it('surfaces a gateway failure as an alert instead of an empty pane', async () => {
    vi.mocked(getStatus).mockRejectedValueOnce(new Error('gateway down'))
    open('system')

    expect((await screen.findByRole('alert')).textContent).toContain('gateway down')
  })

  it('offers a retry when there is no usage yet', async () => {
    open('usage')

    const retry = await screen.findByRole('button', { name: /retry/i })

    expect(vi.mocked(getUsageAnalytics)).toHaveBeenCalledTimes(1)
    fireEvent.click(retry)
    await waitFor(() => expect(vi.mocked(getUsageAnalytics)).toHaveBeenCalledTimes(2))
  })

  it('keeps the maintenance pane on its own section and draws no close control of its own', () => {
    open('maintenance')

    expect(screen.getByText('maintenance stub')).toBeTruthy()
    // Front K5: the page lives in the Settings body, which owns the ✕ and Esc.
    expect(screen.queryByRole('button', { name: /close command center/i })).toBeNull()
  })
})

describe('CommandCenterView · the delete control follows its handler', () => {
  it('shows no delete affordance at all while the controller has not published one', async () => {
    render(
      <MemoryRouter>
        <CommandCenterView onOpenSession={vi.fn()} />
      </MemoryRouter>
    )

    // The rows are there …
    expect((await screen.findAllByRole('button', { name: /export/i })).length).toBeGreaterThan(0)
    // … and the one verb that needs the controller is absent, not inert.
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull()
  })
})
