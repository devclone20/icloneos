import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { translateNow } from '@/i18n'
import { $installOverlayOwnsFailure } from '@/store/agent-runtime'
import { $desktopBoot } from '@/store/boot'
import { $desktopOnboarding } from '@/store/onboarding'

import { BootFailureOverlay } from './boot-failure-overlay'

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
  $installOverlayOwnsFailure.set(false)
})

describe('the post-install failure card (RTB-6)', () => {
  it('stays down while the install overlay owns an install failure', () => {
    $installOverlayOwnsFailure.set(true)
    failBoot("Hermes bootstrap failed at stage 'python-deps': exit code 1")
    render(<BootFailureOverlay />)
    expect(screen.queryByText(translateNow('boot.failure.retry'))).toBeNull()
  })

  it('leads with the diagnosis and keeps the traceback below the fold', async () => {
    failBoot(
      'Hermes backend exited before it became ready (1). Log: /x/desktop.log\nTraceback (most recent call last):\n  File "x"'
    )
    render(<BootFailureOverlay />)
    await screen.findByText(translateNow('boot.failure.retry'))
    expect(window.document.body.textContent).not.toContain('Traceback (most recent call last)')
  })

  it('a network-class backend death is said in plain words', async () => {
    failBoot('getaddrinfo ENOTFOUND files.pythonhosted.org')
    render(<BootFailureOverlay />)
    await screen.findByText(translateNow('install.recovery.diagnosis.network'))
  })
})
