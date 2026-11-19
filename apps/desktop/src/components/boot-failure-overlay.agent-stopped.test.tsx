/**
 * v0.0.9 F3 (point B, owner's order of 14 Nov 2026): the boot-failure card closes with X and Esc into "agent stopped"
 * mode — and closing NEVER starts the agent: no reset, no repair, no connection request reaches main. A banner stays
 * with Retry (clears the latch and reloads: the next start goes through the gate) and Show details (the card again).
 * Also: the 14 Nov failure is no longer shown as "the permission gate is not in place"; it names its real cause.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { translateNow } from '@/i18n'
import { f3Banner, f3Card, f3Causes } from '@/i18n/en/v009-f3'
import { ESCAPE_PRIORITY, isTopEscapeLayer, pushEscapeLayer } from '@/lib/escape-layers'
import { $agentStopped } from '@/store/agent-stopped'
import { $desktopBoot } from '@/store/boot'
import { $desktopOnboarding } from '@/store/onboarding'

import { BootFailureOverlay } from './boot-failure-overlay'

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

const reload = vi.fn()

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
  $agentStopped.set(null)
  $desktopOnboarding.set({ configured: true, flow: { status: 'idle' }, mode: 'oauth', providers: null } as never)
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: desktop })
  Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, reload } })
  failBoot(FOURTEEN_NOV)
})

afterEach(() => cleanup())

/** Nothing that could start (or restart) an agent was asked of main. */
function expectNothingStarted() {
  expect(desktop.resetBootstrap).not.toHaveBeenCalled()
  expect(desktop.repairBootstrap).not.toHaveBeenCalled()
  expect(desktop.getConnection).not.toHaveBeenCalled()
  expect(desktop.restartBackend).not.toHaveBeenCalled()
  expect(reload).not.toHaveBeenCalled()
}

describe('the 14 Nov card names the real cause', () => {
  it('is not the gate card, and says what failed and what fixes it', async () => {
    render(<BootFailureOverlay />)

    expect((await screen.findByTestId('boot-failure-cause')).textContent).toContain(
      f3Causes['install-state-not-writable']!.cause
    )
    expect(screen.queryByText(translateNow('boot.failure.gateTitle'))).toBeNull()
    expect(screen.getByText(f3Causes['install-state-not-writable']!.remedy)).toBeTruthy()
  })

  it('a structured bootCause from main wins over the text', async () => {
    failBoot('Hermes backend exited before it became ready (1).', { bootCause: { code: 'port-in-use' } })
    render(<BootFailureOverlay />)

    expect((await screen.findByTestId('boot-failure-cause')).textContent).toContain(f3Causes['port-in-use']!.cause)
  })

  it('Repair install carries the owner-click marker the preload lock looks for', async () => {
    render(<BootFailureOverlay />)

    const repair = await screen.findByRole('button', { name: translateNow('boot.failure.repairInstall') })
    expect(repair.hasAttribute('data-repair-kit-confirm')).toBe(true)
  })
})

describe('point B: the card closes into "agent stopped"', () => {
  it('X closes it: the banner appears, nothing is started', async () => {
    render(<BootFailureOverlay />)

    fireEvent.click(await screen.findByRole('button', { name: f3Card.close }))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByTestId('agent-stopped-banner').textContent).toContain(f3Banner.title)
    expect($desktopBoot.get().error).toBe(FOURTEEN_NOV) // the failure stays latched: no agent without Retry
    expectNothingStarted()
  })

  it('Esc closes it the same way', async () => {
    render(<BootFailureOverlay />)
    await screen.findByRole('dialog')

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByTestId('agent-stopped-banner')).toBeTruthy()
    expectNothingStarted()
  })

  it('Show details brings the card back', async () => {
    render(<BootFailureOverlay />)
    fireEvent.click(await screen.findByRole('button', { name: f3Card.close }))

    fireEvent.click(screen.getByRole('button', { name: f3Banner.details }))

    expect(await screen.findByRole('dialog')).toBeTruthy()
    expectNothingStarted()
  })

  it('Retry clears the latch in main and reloads (the next start goes through the gate)', async () => {
    render(<BootFailureOverlay />)
    fireEvent.click(await screen.findByRole('button', { name: f3Card.close }))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: f3Banner.retry }))
    })

    expect(desktop.resetBootstrap).toHaveBeenCalledOnce()
    expect(reload).toHaveBeenCalledOnce()
    expect(desktop.repairBootstrap).not.toHaveBeenCalled()
  })

  it('once the agent is up again (no error), the banner goes away by itself', async () => {
    render(<BootFailureOverlay />)
    fireEvent.click(await screen.findByRole('button', { name: f3Card.close }))

    act(() => {
      $desktopBoot.set({ ...$desktopBoot.get(), error: null, progress: 100, visible: false })
    })

    expect(screen.queryByTestId('agent-stopped-banner')).toBeNull()
    expect($agentStopped.get()).toBeNull()
  })
})

describe('v0.0.9 r2: the real missing-module failure, and a real Esc beside the home stage', () => {
  it('m-r2-3: the cause sentence names the missing package (the fastapi proof case)', async () => {
    failBoot('Hermes backend exited before it became ready (1). Log: /Users/owner/.hermes/logs/desktop.log', {
      bootCause: { code: 'python-import', line: "Details: No module named 'fastapi'" }
    })
    render(<BootFailureOverlay />)

    expect((await screen.findByTestId('boot-failure-cause')).textContent).toBe(
      'A part of the agent is missing (fastapi). Repair reinstalls it.'
    )
    expect(screen.queryByText(f3Causes['exit-nonzero']!.cause)).toBeNull()
  })

  it('m-r2-3: after ✕ the banner keeps the same specific sentence', async () => {
    failBoot('Hermes backend exited before it became ready (1).', {
      bootCause: { code: 'python-import', line: "Details: No module named 'fastapi'" }
    })
    render(<BootFailureOverlay />)
    fireEvent.click(await screen.findByRole('button', { name: f3Card.close }))

    expect(screen.getByTestId('agent-stopped-banner').textContent).toContain(
      'A part of the agent is missing (fastapi).'
    )
  })

  it('m-r2-2: a broken environment of the app’s own install says so (never the first-run choice)', async () => {
    failBoot("The agent's environment is broken.", { bootCause: { code: 'runtime-env-broken' } })
    render(<BootFailureOverlay />)

    expect((await screen.findByTestId('boot-failure-cause')).textContent).toContain(
      f3Causes['runtime-env-broken']!.cause
    )
    expect(screen.getByRole('button', { name: translateNow('boot.failure.repairInstall') })).toBeTruthy()
  })

  /** The home stage's Escape router (home-view.tsx): an escape-layer citizen on the window, registered FIRST. */
  function mountHomeStageRouter() {
    const release = pushEscapeLayer(ESCAPE_PRIORITY.homeStage)
    const closeStage = vi.fn()

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !isTopEscapeLayer(ESCAPE_PRIORITY.homeStage)) {
        return
      }

      event.preventDefault()
      closeStage()
    }

    window.addEventListener('keydown', onKey)

    return {
      closeStage,
      unmount: () => {
        window.removeEventListener('keydown', onKey)
        release()
      }
    }
  }

  it('m-r2-5: Esc closes the card even with the home stage router listening first; the stage is not closed', async () => {
    const home = mountHomeStageRouter()

    try {
      render(<BootFailureOverlay />)
      await screen.findByRole('dialog')

      fireEvent.keyDown(window.document.body, { key: 'Escape' })

      expect(screen.queryByRole('dialog')).toBeNull()
      expect(screen.getByTestId('agent-stopped-banner')).toBeTruthy()
      expect(home.closeStage).not.toHaveBeenCalled()
      expectNothingStarted()

      // Reopened from Show details: Esc closes it again.
      fireEvent.click(screen.getByRole('button', { name: f3Banner.details }))
      await screen.findByRole('dialog')
      fireEvent.keyDown(window.document.body, { key: 'Escape' })

      expect(screen.queryByRole('dialog')).toBeNull()
      expect(home.closeStage).not.toHaveBeenCalled()

      // With the card closed the stage owns Escape again.
      fireEvent.keyDown(window.document.body, { key: 'Escape' })
      expect(home.closeStage).toHaveBeenCalledOnce()
    } finally {
      home.unmount()
    }
  })
})
