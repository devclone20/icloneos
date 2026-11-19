/**
 * v0.0.9 F4 (C6 / D-6): the boot-failure card shows the error's whole first paragraph — every line of it — not only
 * its first line; a traceback still waits under "Show recent logs" (RTB-6, boot-failure-overlay.rtb.test.tsx). On the
 * old card `firstLine()` dropped the second and third lines below.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { translateNow } from '@/i18n'
import { $installOverlayOwnsFailure } from '@/store/agent-runtime'
import { $desktopBoot } from '@/store/boot'
import { $desktopOnboarding } from '@/store/onboarding'

import { BootFailureOverlay } from './boot-failure-overlay'

const LINES = [
  'Hermes backend exited before it became ready (1).',
  'ValueError: unexpected key "modelz" in config.yaml at line 12',
  'The configuration file could not be read.'
]

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

describe('the boot-failure card shows the whole error', () => {
  it('every line of the first paragraph is in the callout, line breaks kept', async () => {
    failBoot(`${LINES.join('\n')}\n\nTraceback (most recent call last):\n  File "x"`)
    render(<BootFailureOverlay />)
    await screen.findByText(translateNow('boot.failure.retry'))

    const callout = screen.getByTestId('boot-failure-error')

    for (const line of LINES) {
      expect(callout.textContent).toContain(line)
    }

    expect(callout.textContent).not.toContain('Traceback (most recent call last)')
    expect(callout.className.split(' ')).toEqual(
      expect.arrayContaining(['whitespace-pre-wrap', 'overflow-y-auto', '[overflow-wrap:anywhere]'])
    )
  })
})
