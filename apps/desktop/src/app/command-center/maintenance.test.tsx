import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getActionStatus, runDoctor, setCuratorPaused } from '@/hermes'
import type * as HermesApi from '@/hermes'
import { en } from '@/i18n/en'
import { confirm } from '@/store/confirm'
import { notifyError } from '@/store/notifications'

import { MaintenancePanel } from './maintenance'

type HermesModule = typeof HermesApi

// The ops pane on OUR primitives: real i18n, stubbed backend. Pinned here are
// the things a user would notice if the rewrite drifted — every op is offered,
// a launch tails its log, the curator's state reads correctly, a reset asks
// first, and a failure is shown instead of swallowed.

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<HermesModule>()),
  getActionStatus: vi.fn(async () => ({
    exit_code: null,
    lines: ['doctor: checking', 'doctor: ok'],
    name: 'doctor',
    pid: 11,
    running: false
  })),
  getCuratorStatus: vi.fn(async () => ({ enabled: true, last_run_at: null, paused: true })),
  getMemoryStatus: vi.fn(async () => ({ active: '', builtin_files: { memory: 2048, user: 0 } })),
  resetMemory: vi.fn(async () => ({ deleted: ['memory'] })),
  runBackup: vi.fn(async () => ({ name: 'backup', pid: 3 })),
  runCurator: vi.fn(async () => ({ name: 'curator', pid: 4 })),
  runDoctor: vi.fn(async () => ({ name: 'doctor', pid: 11 })),
  runSecurityAudit: vi.fn(async () => ({ name: 'audit', pid: 12 })),
  setCuratorPaused: vi.fn(async () => undefined)
}))

vi.mock('@/store/activity', () => ({ upsertDesktopActionTask: vi.fn() }))
vi.mock('@/store/notifications', () => ({ notify: vi.fn(), notifyError: vi.fn() }))
vi.mock('@/store/confirm', () => ({ confirm: vi.fn(async () => false) }))

const mm = en.commandCenter.maintenance

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(cleanup)

describe('MaintenancePanel', () => {
  it('offers every op as one of our rows', async () => {
    render(<MaintenancePanel />)

    for (const label of [mm.doctor, mm.securityAudit, mm.backup, mm.diagnosticsReport]) {
      expect(await screen.findByRole('button', { name: label })).toBeTruthy()
    }

    expect(globalThis.document.querySelectorAll('[class*="icui-row"]').length).toBeGreaterThan(3)
  })

  it('launches an op and tails its log in our mono pane', async () => {
    render(<MaintenancePanel />)

    fireEvent.click(await screen.findByRole('button', { name: mm.doctor }))

    await waitFor(() => expect(vi.mocked(runDoctor)).toHaveBeenCalled())
    await waitFor(() => expect(vi.mocked(getActionStatus)).toHaveBeenCalledWith('doctor', 200))
    expect(await screen.findByText(/doctor: ok/)).toBeTruthy()
  })

  it('reads the curator as paused and resumes it', async () => {
    render(<MaintenancePanel />)

    expect(await screen.findByText(mm.curatorPaused)).toBeTruthy()

    fireEvent.click(await screen.findByRole('button', { name: mm.resume }))

    await waitFor(() => expect(vi.mocked(setCuratorPaused)).toHaveBeenCalledWith(false))
  })

  it('sizes the memory files and never resets one without asking', async () => {
    render(<MaintenancePanel />)

    expect(await screen.findByText('2.0 KB')).toBeTruthy()
    // An empty file cannot be reset at all, so the user file's button is off.
    fireEvent.click(await screen.findByRole('button', { name: mm.resetMemory }))

    await waitFor(() => expect(vi.mocked(confirm)).toHaveBeenCalled())
  })

  it('shows a failed launch inline instead of a blank pane', async () => {
    const { runSecurityAudit } = await import('@/hermes')

    vi.mocked(runSecurityAudit).mockRejectedValueOnce(new Error('audit binary missing'))
    render(<MaintenancePanel />)

    fireEvent.click(await screen.findByRole('button', { name: mm.securityAudit }))

    expect(await screen.findByText('audit binary missing')).toBeTruthy()
    expect(vi.mocked(notifyError)).toHaveBeenCalled()
  })
})
