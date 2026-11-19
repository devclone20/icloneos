/**
 * v0.0.9 r4 (design r3 N3): the boot card's residue. "Agent settings", never "Gateway settings", on the local card; the
 * stopped sentence that repeated the title is gone (the "several tries" line stays: it says what to do next); Details
 * says the error once, in its callout, and the log region starts at the log tail. Each case is red on 5470b2b185.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { f2Restart } from '@/i18n/en/v009-f2'
import { f3Card } from '@/i18n/en/v009-f3'
import { $agentStopped } from '@/store/agent-stopped'
import { applyBackendRestartProgress, resetBackendRestartForTests } from '@/store/backend-restart'
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

beforeEach(() => {
  vi.clearAllMocks()
  resetBackendRestartForTests()
  $agentStopped.set(null)
  $desktopOnboarding.set({ configured: true, flow: { status: 'idle' }, mode: 'oauth', providers: null } as never)
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: desktop })
})

afterEach(() => cleanup())

const FASTAPI = { bootCause: { code: 'python-import', line: "Details: No module named 'fastapi'" } }

describe('boot card residue (design r3 N3)', () => {
  it('the local card offers "Agent settings", not "Gateway settings"', async () => {
    failBoot(RAW, FASTAPI)
    render(<BootFailureOverlay />)
    const dialog = await screen.findByRole('dialog')

    expect(within(dialog).getByRole('button', { name: f3Card.agentSettings })).toBeTruthy()
    expect(dialog.textContent).not.toMatch(/gateway settings/i)
  })

  it('drops "The agent cannot start until the problem shown is fixed." under the cause', async () => {
    applyBackendRestartProgress({ restart: { attempt: 0, maxAttempts: 5, phase: 'stopped', stoppedBecause: 'deterministic' } })
    failBoot(RAW, FASTAPI)
    render(<BootFailureOverlay />)
    const dialog = await screen.findByRole('dialog')

    expect(screen.getByTestId('boot-failure-cause')).toBeTruthy()
    expect(dialog.textContent).not.toContain(f2Restart.stoppedDeterministic)
    expect(screen.queryByTestId('boot-failure-restart')).toBeNull()
  })

  it('keeps the "several tries" line: it is the next step, not a repeat', async () => {
    applyBackendRestartProgress({ restart: { attempt: 5, maxAttempts: 5, phase: 'stopped', stoppedBecause: 'limit' } })
    failBoot(RAW, FASTAPI)
    render(<BootFailureOverlay />)
    await screen.findByRole('dialog')

    expect(screen.getByTestId('boot-failure-restart').textContent).toBe(f2Restart.stoppedLimit)
  })

  it('Details says the error once; the log starts at the log tail', async () => {
    failBoot(RAW, FASTAPI)
    render(<BootFailureOverlay />)
    const dialog = await screen.findByRole('dialog')

    fireEvent.click(within(dialog).getByRole('button', { name: f3Card.details }))
    const log = await screen.findByTestId('boot-failure-log')

    expect(log.textContent).toBe('line one\nline two\n')
    expect(dialog.textContent?.split('Hermes backend exited before it became ready').length).toBe(2)
  })
})

// r4d (design r4 F3-1): one text axis on the card. Red on 52cae17554: the body sat at the card edge (px-6) and Details
// was centred (align-self only, in a grid column).
describe('the boot card has one text axis', () => {
  it('the body starts under the cause text, and Details is left on that axis', async () => {
    failBoot(RAW, FASTAPI)
    render(<BootFailureOverlay />)
    await screen.findByRole('dialog')

    const body = screen.getByTestId('boot-failure-body')
    const details = screen.getByTestId('boot-failure-details')

    // Header: pl-6 (24px) + glyph 1.25rem (20px) + gap-3.5 (14px) = 58px = 3.625rem.
    expect(body.className).toContain('pl-[3.625rem]')
    expect(body.className).not.toMatch(/\bpx-6\b/)
    expect(details.className).toContain('justify-self-start')
    expect(document.querySelector('.ic-sys-card .flex.items-start.gap-3\\.5.pl-6')).not.toBeNull()
  })
})
