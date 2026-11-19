/**
 * v0.0.9 F3 (e2e G-m4, a closable error screen): a boot that fails fast must show the failure card, during onboarding
 * and after the consent. Red on 776b6d9e98: main's late progress snapshot (`running: true`, no error) landed after the
 * renderer's failure, the boot read as running again, the card needs a stopped boot, so it never showed — and the
 * onboarding sheet said "The failure screen shows what happened" over nothing.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $agentStopped } from '@/store/agent-stopped'
import { resetBackendRestartForTests } from '@/store/backend-restart'
import { $desktopBoot, applyMainBootProgress, failDesktopBoot } from '@/store/boot'
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

import { translateNow } from '@/i18n'

const LATE_SNAPSHOT = {
  error: null,
  message: 'Resolving Hermes backend',
  phase: 'backend.resolve',
  progress: 8,
  running: true
} as never

function failFastThenLateSnapshot() {
  $desktopBoot.set({ ...$desktopBoot.get(), error: null, running: true, visible: true, progress: 8 })
  failDesktopBoot('Failed to connect to Hermes backend: connection refused')
  applyMainBootProgress(LATE_SNAPSHOT)
}

describe('a fast boot failure still shows the failure card (F3)', () => {
  it('main\'s late progress never revives a failed boot', () => {
    failFastThenLateSnapshot()

    expect($desktopBoot.get()).toMatchObject({ running: false, error: 'Failed to connect to Hermes backend: connection refused' })
  })

  it('after the consent (onboarding configured, idle): the card is up and can be closed', async () => {
    $desktopOnboarding.set({ configured: true, flow: { status: 'idle' }, mode: 'oauth', providers: null } as never)
    failFastThenLateSnapshot()
    render(<BootFailureOverlay />)

    const dialog = await screen.findByRole('dialog')

    expect(within(dialog).getByRole('heading').textContent).toBe(translateNow('boot.failure.title'))
    fireEvent.click(screen.getByTestId('boot-failure-close'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('during onboarding (no provider yet, flow idle): the card is up too', async () => {
    $desktopOnboarding.set({ configured: false, flow: { status: 'idle' }, mode: 'oauth', providers: null } as never)
    failFastThenLateSnapshot()
    render(<BootFailureOverlay />)

    expect(await screen.findByRole('dialog')).toBeTruthy()
  })

  it('a progress event that carries its own error still applies', () => {
    failDesktopBoot('first')
    applyMainBootProgress({ error: 'second', message: 'x', phase: 'backend.error', progress: 40, running: false } as never)

    expect($desktopBoot.get().error).toBe('second')
  })
})
