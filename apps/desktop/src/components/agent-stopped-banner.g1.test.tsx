/**
 * v0.0.9 G-1 (design G verdict): the stopped banner never names an action it does not render. Red on 0d197361ab: on a
 * missing package the banner said "A part of the agent is missing (fastapi). Repair reinstalls it." and offered only
 * "Restart agent", which restarts the same broken environment and fails again.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { translateNow } from '@/i18n'
import { f3Banner, f3Card } from '@/i18n/en/v009-f3'
import { $agentStopped, stopAgentForNow } from '@/store/agent-stopped'
import { $desktopBoot } from '@/store/boot'
import { $desktopOnboarding } from '@/store/onboarding'

import { BootFailureOverlay } from './boot-failure-overlay'

const REPAIR = translateNow('boot.failure.repairInstall')

const desktop = {
  getConnection: vi.fn(async () => ({})),
  getConnectionConfig: vi.fn(async () => ({ mode: 'local' }) as Record<string, unknown>),
  getRecentLogs: vi.fn(async () => ({ lines: [] as string[] })),
  repairBootstrap: vi.fn(async () => ({ ok: true })),
  resetBootstrap: vi.fn(async () => ({ ok: true })),
  restartBackend: vi.fn(async () => ({ ok: true }))
}

const reload = vi.fn()

const FASTAPI = { code: 'python-import', line: "ModuleNotFoundError: No module named 'fastapi.routing'" }

function failBoot(bootCause: Record<string, unknown>) {
  $desktopBoot.set({
    bootCause,
    error: 'Hermes backend exited before it became ready (1).',
    fakeMode: false,
    message: 'boot failed',
    phase: 'backend.error',
    progress: 40,
    running: false,
    timestamp: Date.now(),
    visible: true
  } as never)
}

/** Render, close the card, and return the banner. */
async function stoppedBanner() {
  render(<BootFailureOverlay />)
  fireEvent.click(await screen.findByRole('button', { name: f3Card.close }))

  return screen.getByTestId('agent-stopped-banner')
}

/** Every action verb the banner's words name is one of its own buttons. */
function expectVerbsRendered(banner: HTMLElement) {
  const buttons = [...banner.querySelectorAll('button')].map(button => button.textContent ?? '')

  const words = (banner.textContent ?? '').replace(
    new RegExp(buttons.map(b => b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g'),
    ''
  )

  for (const verb of ['Repair', 'Restart', 'Retry', 'Reinstall']) {
    if (new RegExp(`\\b${verb}`, 'i').test(words)) {
      expect(
        buttons.some(label => label.toLowerCase().includes(verb.toLowerCase())),
        `${verb} is named, not rendered`
      ).toBe(true)
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  $agentStopped.set(null)
  $desktopOnboarding.set({ configured: true, flow: { status: 'idle' }, mode: 'oauth', providers: null } as never)
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: desktop })
  Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, reload } })
})

afterEach(() => cleanup())

describe('G-1: the stopped banner names only what it renders', () => {
  it.each([
    ['a missing package', FASTAPI],
    ['a broken runtime', { code: 'python-import', line: 'ImportError: bad magic number' }],
    ['an unwritable install record', { code: 'install-state-not-writable' }],
    ['a held port', { code: 'port-in-use' }],
    ['an exit', { code: 'exit-nonzero' }],
    ['a timeout', { code: 'timeout' }]
  ])('%s: every verb in the banner is one of its buttons', async (_name, bootCause) => {
    failBoot(bootCause)

    expectVerbsRendered(await stoppedBanner())
  })

  it('a missing package: Repair install leads, carries the owner-click marker, and Restart stays beside it', async () => {
    failBoot(FASTAPI)
    const banner = await stoppedBanner()

    expect(banner.textContent).toContain('A part of the agent is missing (fastapi).')
    const buttons = [...banner.querySelectorAll('button')]
    const repair = screen.getByRole('button', { name: REPAIR })

    expect(buttons[0]).toBe(repair)
    expect(repair.hasAttribute('data-repair-kit-confirm')).toBe(true)
    expect(repair.className).toContain('icpg__btn--note')
    expect(screen.getByRole('button', { name: f3Banner.retry }).className).toContain('icpg__btn--quiet')
  })

  it('Repair install on the banner runs the same repair call as the card, then reloads', async () => {
    failBoot(FASTAPI)
    await stoppedBanner()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: REPAIR }))
    })

    expect(desktop.repairBootstrap).toHaveBeenCalledOnce()
    expect(desktop.resetBootstrap).not.toHaveBeenCalled()
    expect(reload).toHaveBeenCalledOnce()
  })

  it('an exit (Restart is the fix) keeps Restart agent as the one primary, no Repair', async () => {
    failBoot({ code: 'exit-nonzero' })
    await stoppedBanner()

    expect(screen.queryByRole('button', { name: REPAIR })).toBeNull()
    expect(screen.getByRole('button', { name: f3Banner.retry }).className).toContain('icpg__btn--note')
  })

  it('a remote agent never gets the local Repair on its banner', async () => {
    desktop.getConnectionConfig.mockResolvedValue({ mode: 'remote', remoteUrl: 'https://agent.example.test' })
    failBoot(FASTAPI)
    render(<BootFailureOverlay />)
    await act(async () => {})
    act(() => stopAgentForNow('Hermes backend exited before it became ready (1).'))

    expect(screen.getByTestId('agent-stopped-banner')).toBeTruthy()
    expect(screen.queryByRole('button', { name: REPAIR })).toBeNull()
    desktop.getConnectionConfig.mockResolvedValue({ mode: 'local' })
  })
})
