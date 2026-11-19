/**
 * v0.0.9 Q (proofs F2-b): when main's automatic restart stops (5 attempts in 10 min, or a cause a restart cannot cure)
 * after the app is up, the app shows ONE status banner with the cause and a Retry that runs the manual restart, and the
 * composer says the agent is not running (not "Reconnecting…"). On the old code nothing read `$backendRestart`'s
 * `stopped` outside the iNFT pill: no banner, no Retry, the composer kept saying it was reconnecting.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { f2Restart } from '@/i18n/en/v009-f2'
import { f3Banner } from '@/i18n/en/v009-f3'
import {
  applyBackendRestartProgress,
  IDLE_BACKEND_RESTART,
  isRestartStopped,
  resetBackendRestartForTests
} from '@/store/backend-restart'
import { $desktopBoot } from '@/store/boot'
import { $notifications, clearNotifications } from '@/store/notifications'
import { $gatewayState } from '@/store/session'

import { AgentRestartStoppedBanner, RESTART_FAILED_TITLE } from './agent-restart-stopped-banner'

const STOPPED = { restart: { attempt: 5, maxAttempts: 5, phase: 'stopped', stoppedBecause: 'limit' } }

let restartBackend: ReturnType<typeof vi.fn>

beforeEach(() => {
  resetBackendRestartForTests()
  clearNotifications()
  $gatewayState.set('closed')
  $desktopBoot.set({
    error: null,
    fakeMode: false,
    message: '',
    phase: 'ready',
    progress: 100,
    running: true,
    timestamp: Date.now(),
    visible: false
  })
  restartBackend = vi.fn(async () => ({ ok: true }))
  ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = { restartBackend }
})

afterEach(() => {
  cleanup()
  resetBackendRestartForTests()
  clearNotifications()
  $gatewayState.set('idle')
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
})

describe('isRestartStopped', () => {
  it('only a stopped supervisor with the gateway not open', () => {
    const stopped = { ...IDLE_BACKEND_RESTART, phase: 'stopped' as const, stoppedBecause: 'limit' as const }

    expect(isRestartStopped(stopped, 'closed')).toBe(true)
    expect(isRestartStopped(stopped, 'error')).toBe(true)
    expect(isRestartStopped(stopped, 'open')).toBe(false)
    expect(isRestartStopped({ ...stopped, phase: 'restarting' }, 'closed')).toBe(false)
    expect(isRestartStopped(IDLE_BACKEND_RESTART, 'closed')).toBe(false)
  })
})

describe('the stopped banner', () => {
  it('nothing while main is still restarting it', () => {
    applyBackendRestartProgress({ restart: { attempt: 2, maxAttempts: 5, phase: 'waiting' } })
    render(<AgentRestartStoppedBanner />)

    expect(screen.queryByTestId('agent-stopped-banner')).toBeNull()
  })

  it('after the breaker: one banner with the cause, and Retry runs the manual restart', async () => {
    applyBackendRestartProgress(STOPPED)
    render(<AgentRestartStoppedBanner />)

    const banner = screen.getByTestId('agent-stopped-banner')

    expect(banner.textContent).toContain(f3Banner.title)
    expect(banner.textContent).toContain(f2Restart.stoppedLimit)
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: f3Banner.retry })))
    expect(restartBackend).toHaveBeenCalledTimes(1)
    expect($notifications.get()).toHaveLength(0)
  })

  it('a refused restart says so and the banner stays', async () => {
    restartBackend.mockResolvedValueOnce({ ok: false, error: 'The permission gate refused the start.' })
    applyBackendRestartProgress(STOPPED)
    render(<AgentRestartStoppedBanner />)

    await act(async () => void fireEvent.click(screen.getByRole('button', { name: f3Banner.retry })))
    expect($notifications.get()[0]).toMatchObject({
      kind: 'error',
      title: RESTART_FAILED_TITLE,
      message: 'The permission gate refused the start.'
    })
    expect(screen.getByTestId('agent-stopped-banner')).toBeTruthy()
  })

  it('leaves when the gateway is open again', () => {
    applyBackendRestartProgress(STOPPED)
    render(<AgentRestartStoppedBanner />)
    expect(screen.getByTestId('agent-stopped-banner')).toBeTruthy()

    act(() => $gatewayState.set('open'))
    expect(screen.queryByTestId('agent-stopped-banner')).toBeNull()
  })

  it('a boot failure keeps its own card: no second banner', () => {
    applyBackendRestartProgress(STOPPED)
    $desktopBoot.set({ ...$desktopBoot.get(), error: 'Hermes backend exited (1).', running: false })
    render(<AgentRestartStoppedBanner />)

    expect(screen.queryByTestId('agent-stopped-banner')).toBeNull()
  })

  it('is mounted app-wide, beside the boot card', () => {
    const wiring = readFileSync(resolve(__dirname, '../app/contrib/wiring.tsx'), 'utf8')

    expect(wiring).toMatch(/<BootFailureOverlay \/>\s*<AgentRestartStoppedBanner \/>/)
  })
})

describe('the composer in that state', () => {
  it('reads the stopped supervisor into its stopped mode (disabled, "not running", no held sends)', () => {
    const composer = readFileSync(resolve(__dirname, '../app/chat/composer/index.tsx'), 'utf8')

    expect(composer).toMatch(/const restartStopped = isRestartStopped\(useStore\(\$backendRestart\), gatewayState\)/)
    expect(composer).toMatch(/const agentStopped = useStore\(\$agentStopped\) !== null \|\| restartStopped/)
    expect(composer).toMatch(/const placeholder = agentStopped \? f3Banner\.composerReason/)
  })
})
