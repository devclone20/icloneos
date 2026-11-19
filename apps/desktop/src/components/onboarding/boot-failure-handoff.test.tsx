/**
 * v0.0.9 critic M2 (code part): a boot that fails while the first-run card still says "Starting the agent…" is shown
 * by the closable failure surface F3 built — the cause sentence, ✕ and Esc into "agent stopped" mode, the stopped
 * banner — never as the raw error under the onboarding progress bar (proofs-w2 §4, shots/f3-errorcard.png). Red on the
 * old card: it painted `boot.error` verbatim, had no ✕, and Esc did nothing.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { translateNow } from '@/i18n'
import { f3Banner, f3Card, f3Causes } from '@/i18n/en/v009-f3'
import { $agentStopped } from '@/store/agent-stopped'
import { $desktopBoot } from '@/store/boot'
import { $desktopOnboarding } from '@/store/onboarding'

import { BootFailureOverlay } from '../boot-failure-overlay'

import { DesktopOnboardingOverlay } from '.'

const FOURTEEN_NOV =
  'Hermes backend exited before it became ready (1). Log: /Users/owner/.hermes/logs/desktop.log\n' +
  '[iclone-gate] loaded by Hermes at /runtime: iclone-permissions, iclone-consent, iclone-confinement (1134 ms)\n' +
  'hermes: install state is not writable by this user (/Users/owner/.hermes/installs/f3cca8023c228495/environments/' +
  'd2a0574ad8364ad4a87cee896f2a3bea/.leases/7f1c); run as the install owner or grant write access'

const desktop = {
  getConnection: vi.fn(async () => ({})),
  getConnectionConfig: vi.fn(async () => ({ mode: 'local' })),
  getRecentLogs: vi.fn(async () => ({ lines: [] as string[] })),
  repairBootstrap: vi.fn(async () => ({ ok: true })),
  resetBootstrap: vi.fn(async () => ({ ok: true })),
  restartBackend: vi.fn(async () => ({ ok: true }))
}

function boot(state: { error: null | string; running: boolean }) {
  $desktopBoot.set({
    error: state.error,
    fakeMode: false,
    message: state.running ? 'Resolving Hermes backend' : 'boot failed',
    phase: state.running ? 'backend.resolve' : 'backend.error',
    progress: 40,
    running: state.running,
    timestamp: Date.now(),
    visible: true
  })
}

function mountFirstRun() {
  return render(
    <>
      <DesktopOnboardingOverlay enabled={false} profile="default" requestGateway={async () => undefined as never} />
      <BootFailureOverlay />
    </>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  $agentStopped.set(null)
  // First run, the provider check not answered yet: the card is in its "Starting the agent…" state.
  $desktopOnboarding.set({
    configured: null,
    firstRunSkipped: false,
    flow: { status: 'idle' },
    localEndpoint: false,
    manual: false,
    mode: 'oauth',
    providers: null,
    reason: null,
    requested: false
  })
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: desktop })
})

afterEach(() => cleanup())

describe('critic M2: a failure under "Starting the agent…" goes to the closable failure card', () => {
  it('while starting, the first-run card is up and shows no error', () => {
    boot({ error: null, running: true })
    mountFirstRun()

    expect(screen.getAllByText(translateNow('onboarding.starting')).length).toBeGreaterThan(0)
  })

  it('on the failure: the first-run card steps aside; the failure card names the cause and has ✕', async () => {
    boot({ error: null, running: true })
    mountFirstRun()
    boot({ error: FOURTEEN_NOV, running: false })

    expect((await screen.findByTestId('boot-failure-cause')).textContent).toContain(
      f3Causes['install-state-not-writable']!.cause
    )
    expect(screen.queryByText(translateNow('onboarding.starting'))).toBeNull()
    expect(screen.queryByRole('progressbar', { name: translateNow('onboarding.starting') })).toBeNull()
    expect(screen.getByRole('button', { name: f3Card.close })).toBeTruthy()
  })

  it('Esc closes it into "agent stopped": the banner shows and the first-run card does not come back over it', async () => {
    boot({ error: FOURTEEN_NOV, running: false })
    mountFirstRun()
    await screen.findByRole('dialog')

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByTestId('agent-stopped-banner').textContent).toContain(f3Banner.title)
    expect(screen.queryByText(translateNow('onboarding.starting'))).toBeNull()
    expect(desktop.resetBootstrap).not.toHaveBeenCalled()
    expect(desktop.repairBootstrap).not.toHaveBeenCalled()
  })

  it('an error main reports while its boot still runs is said as a cause sentence, never the raw text', () => {
    boot({ error: FOURTEEN_NOV, running: true })
    mountFirstRun()

    expect(screen.getByTestId('onboarding-boot-cause').textContent).toBe(f3Causes['install-state-not-writable']!.cause)
    expect(screen.queryByText(/run as the install owner or grant write access/)).toBeNull()
  })
})
