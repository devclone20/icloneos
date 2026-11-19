/**
 * v0.0.9 Q (correctness 2/3, renderer side): the boot-failure card says what main's automatic restart is doing in its
 * own words, and never repeats main's latched "restarting it automatically" once the breaker tripped (the error stays
 * latched after `stoppedBecause: 'limit'`, so the old card promised a restart that was never coming).
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { translateNow } from '@/i18n'
import { f2Restart } from '@/i18n/en/v009-f2'
import { $installOverlayOwnsFailure } from '@/store/agent-runtime'
import {
  applyBackendRestartProgress,
  type BackendRestartView,
  honestRestartText,
  resetBackendRestartForTests
} from '@/store/backend-restart'
import { $desktopBoot } from '@/store/boot'
import { $desktopOnboarding } from '@/store/onboarding'

import { BootFailureOverlay } from './boot-failure-overlay'

const CRASH = 'The agent stopped unexpectedly (SIGKILL); restarting it automatically.'

function view(partial: Partial<BackendRestartView>): BackendRestartView {
  return { attempt: 0, maxAttempts: 5, nextAttemptAt: null, phase: 'idle', stoppedBecause: null, ...partial }
}

function failBoot(error: string) {
  $desktopBoot.set({
    error,
    fakeMode: false,
    message: 'boot failed',
    phase: 'renderer.error',
    progress: 40,
    running: false,
    timestamp: Date.now(),
    visible: true
  })
}

beforeEach(() => {
  resetBackendRestartForTests()
  $desktopOnboarding.set({
    configured: true,
    flow: { status: 'idle' },
    firstRunSkipped: false,
    localEndpoint: false,
    manual: false,
    mode: 'oauth',
    providers: null,
    reason: null,
    requested: false
  } as never)
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { getConnectionConfig: async () => ({ mode: 'local' }), getRecentLogs: async () => ({ lines: [] }) }
  })
})

afterEach(() => {
  cleanup()
  resetBackendRestartForTests()
  $installOverlayOwnsFailure.set(false)
})

describe('honestRestartText', () => {
  it('keeps the promise only while an attempt is pending or running', () => {
    expect(honestRestartText(CRASH, view({ phase: 'waiting', attempt: 2 }))).toBe(CRASH)
    expect(honestRestartText(CRASH, view({ phase: 'restarting', attempt: 2 }))).toBe(CRASH)
    expect(honestRestartText(CRASH, view({ phase: 'stopped', stoppedBecause: 'limit' }))).toBe(
      'The agent stopped unexpectedly (SIGKILL).'
    )
    expect(honestRestartText(CRASH, view({ phase: 'idle' }))).toBe('The agent stopped unexpectedly (SIGKILL).')
    expect(honestRestartText(null, view({ phase: 'stopped' }))).toBeNull()
    expect(honestRestartText('Hermes backend exited (1).', view({ phase: 'stopped' }))).toBe('Hermes backend exited (1).')
  })
})

describe('the card and the restart supervisor', () => {
  it('after the breaker tripped: no "restarting automatically", and the card says it gave up', async () => {
    applyBackendRestartProgress({ restart: { attempt: 5, maxAttempts: 5, phase: 'stopped', stoppedBecause: 'limit' } })
    failBoot(CRASH)
    render(<BootFailureOverlay />)
    await screen.findByText(translateNow('boot.failure.retry'))

    expect(screen.getByTestId('boot-failure-error').textContent).toBe('The agent stopped unexpectedly (SIGKILL).')
    expect(screen.getByTestId('boot-failure-restart').textContent).toBe(f2Restart.stoppedLimit)
  })

  it('while main is restarting it: the attempt, in the calm words', async () => {
    applyBackendRestartProgress({ restart: { attempt: 2, maxAttempts: 5, phase: 'restarting', stoppedBecause: null } })
    failBoot(CRASH)
    render(<BootFailureOverlay />)
    await screen.findByText(translateNow('boot.failure.retry'))

    expect(screen.getByTestId('boot-failure-restart').textContent).toBe(f2Restart.restarting(2, 5))
    expect(screen.getByTestId('boot-failure-error').textContent).toBe(CRASH)
  })

  it('no supervisor activity: no restart line at all', async () => {
    failBoot('Hermes backend exited before it became ready (1).')
    render(<BootFailureOverlay />)
    await screen.findByText(translateNow('boot.failure.retry'))

    expect(screen.queryByTestId('boot-failure-restart')).toBeNull()
  })
})
