/**
 * v0.0.9 r3 (design N6, eng n5): the boot card leads with one human sentence, keeps the engine text behind ONE
 * keyboard-reachable "Details" disclosure (which also holds the recent log and the log folder: "Open logs" and "Show
 * recent logs" are merged), has one primary action (Repair) and says "the agent", never "gateway"/"Hermes". Once main's
 * breaker stopped, no "attempt 5 of 5" is left anywhere on it. Every case is red on fb85ac6be6.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { translateNow } from '@/i18n'
import { f2Restart } from '@/i18n/en/v009-f2'
import { f3Card } from '@/i18n/en/v009-f3'
import { $agentStopped } from '@/store/agent-stopped'
import {
  applyBackendRestartProgress,
  type BackendRestartView,
  honestRestartText,
  resetBackendRestartForTests
} from '@/store/backend-restart'
import { $desktopBoot } from '@/store/boot'
import { $desktopOnboarding } from '@/store/onboarding'

import { BootFailureOverlay } from './boot-failure-overlay'

const RAW = 'Hermes backend exited before it became ready (1). Log: /Users/owner/.hermes/logs/desktop.log'

const desktop = {
  getConnection: vi.fn(async () => ({})),
  getConnectionConfig: vi.fn(async () => ({ mode: 'local' })),
  getRecentLogs: vi.fn(async () => ({ lines: ['line one\n', 'line two\n'] })),
  repairBootstrap: vi.fn(async () => ({ ok: true })),
  resetBootstrap: vi.fn(async () => ({ ok: true })),
  restartBackend: vi.fn(async () => ({ ok: true })),
  revealLogs: vi.fn(async () => undefined)
}

function failBoot(error: string, extra: Record<string, unknown> = {}) {
  $desktopBoot.set({
    error,
    fakeMode: false,
    message: 'boot failed',
    phase: 'backend.error',
    progress: 40,
    running: false,
    timestamp: Date.now(),
    visible: true,
    ...extra
  })
}

const view = (partial: Partial<BackendRestartView>): BackendRestartView => ({
  attempt: 0,
  maxAttempts: 5,
  nextAttemptAt: null,
  phase: 'idle',
  stoppedBecause: null,
  ...partial
})

beforeEach(() => {
  vi.clearAllMocks()
  resetBackendRestartForTests()
  $agentStopped.set(null)
  $desktopOnboarding.set({ configured: true, flow: { status: 'idle' }, mode: 'oauth', providers: null } as never)
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: desktop })
})

afterEach(() => cleanup())

describe('the boot card leads with the cause', () => {
  it('the header sentence is the cause; the engine text sits in a closed Details region', async () => {
    failBoot(RAW, { bootCause: { code: 'python-import', line: "Details: No module named 'fastapi'" } })
    render(<BootFailureOverlay />)
    const dialog = await screen.findByRole('dialog')
    const cause = screen.getByTestId('boot-failure-cause')

    // In the header, beside the title — not a paragraph under a red callout.
    expect(cause.closest('div')?.querySelector('#boot-failure-title')).not.toBeNull()
    expect(cause.textContent).toBe('A part of the agent is missing (fastapi). Repair reinstalls it.')

    const details = within(dialog).getByRole('button', { name: f3Card.details })
    const region = document.getElementById(details.getAttribute('aria-controls') ?? '')!

    expect(details.tagName).toBe('BUTTON') // Enter / Space toggle it natively.
    expect(details.getAttribute('aria-expanded')).toBe('false')
    expect(region.hidden).toBe(true)
    expect(region.className).toContain('hidden')
    expect(region.contains(screen.getByTestId('boot-failure-error'))).toBe(true)

    fireEvent.click(details)
    expect(details.getAttribute('aria-expanded')).toBe('true')
    expect(region.hidden).toBe(false)
    expect(within(region).getByRole('button', { name: f3Card.openLogFolder })).toBeTruthy()
    expect(details.textContent).toContain(f3Card.hideDetails)
  })

  it('one primary (Repair); "Open logs" and "Show recent logs" are merged into Details', async () => {
    failBoot(RAW, { bootCause: { code: 'python-import', line: "Details: No module named 'fastapi'" } })
    render(<BootFailureOverlay />)
    await screen.findByRole('dialog')
    const primaries = [...document.querySelectorAll('[data-variant="default"]')]

    expect(primaries.map(p => p.textContent)).toEqual([translateNow('boot.failure.repairInstall')])
    expect(screen.queryByRole('button', { name: translateNow('boot.failure.openLogs') })).toBeNull()
    expect(screen.queryByRole('button', { name: translateNow('boot.failure.showRecentLogs') })).toBeNull()
    expect(screen.getAllByRole('button', { name: f3Card.openLogFolder, hidden: true })).toHaveLength(1)
  })

  it('a failure the app cannot explain opens Details by itself, under a sentence that says "the agent"', async () => {
    failBoot('Something odd: 0xdeadbeef')
    render(<BootFailureOverlay />)
    await screen.findByRole('dialog')

    expect(screen.getByRole('button', { name: f3Card.hideDetails }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(f3Card.description)).toBeTruthy()
    expect(f3Card.description).not.toMatch(/gateway|hermes/i)
  })
})

describe('no "attempt n of m" once main stopped (eng n5, m-r2-6)', () => {
  it('honestRestartText turns a latched progress line into the stopped copy, once', () => {
    const latched = 'The agent stopped unexpectedly. Restarting the agent (attempt 5 of 5)…'

    expect(honestRestartText(latched, view({ phase: 'stopped', stoppedBecause: 'limit', attempt: 5 }))).toBe(
      `The agent stopped unexpectedly. ${f2Restart.stoppedLimit}`
    )
    expect(honestRestartText(latched, view({ phase: 'idle' }))).toBe('The agent stopped unexpectedly.')
    expect(honestRestartText(latched, view({ phase: 'restarting', attempt: 5 }))).toBe(latched)
    // The pattern follows the copy it guards.
    expect(f2Restart.restarting(5, 5)).toBe('Restarting the agent (attempt 5 of 5)…')
  })

  it('the card after the breaker tripped carries the stopped line only, never the attempt', async () => {
    applyBackendRestartProgress({ restart: { attempt: 5, maxAttempts: 5, phase: 'stopped', stoppedBecause: 'limit' } })
    failBoot('The agent stopped unexpectedly (SIGKILL). Restarting the agent (attempt 5 of 5)…')
    render(<BootFailureOverlay />)
    const dialog = await screen.findByRole('dialog')

    expect(dialog.textContent).not.toMatch(/attempt \d+ of \d+/)
    expect(dialog.textContent?.split(f2Restart.stoppedLimit).length).toBe(2) // said once
  })
})
