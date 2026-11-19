// v0.0.9 design 3 / 10: one surface for the "agent stopped" state, and the crash cause from the exit main reported.
import { describe, expect, it } from 'vitest'

import { backendExitCause, backendExitDetail, backendStoppedSurface, IDLE_BACKEND_RESTART } from './backend-restart'

const stopped = { ...IDLE_BACKEND_RESTART, phase: 'stopped' as const, stoppedBecause: 'limit' as const }

describe('backendStoppedSurface', () => {
  it('the boot card owns a failed boot; the stopped banner owns a stop with the gateway down; else one toast', () => {
    expect(backendStoppedSurface({ bootError: 'x', bootRunning: false, gatewayState: 'closed', restart: stopped })).toBe(
      'boot-card'
    )
    expect(backendStoppedSurface({ bootError: null, bootRunning: false, gatewayState: 'closed', restart: stopped })).toBe(
      'banner'
    )
    expect(backendStoppedSurface({ bootError: null, bootRunning: false, gatewayState: 'open', restart: stopped })).toBe(
      'toast'
    )
    expect(
      backendStoppedSurface({ bootError: null, bootRunning: false, gatewayState: 'closed', restart: IDLE_BACKEND_RESTART })
    ).toBe('toast')
    // A boot still running has no card yet: the toast says it.
    expect(backendStoppedSurface({ bootError: 'x', bootRunning: true, gatewayState: 'closed', restart: stopped })).toBe(
      'banner'
    )
  })
})

describe('backendExitCause', () => {
  it('names a signal, an error code or a clean quit; malformed input is a plain quit', () => {
    // r4d (design r4 F2-1): a signal reads as the system ending the process; its name is in Details (backendExitDetail).
    expect(backendExitCause({ code: null, signal: 'SIGKILL' })).toBe(
      'The system ended its background process. This usually means the Mac was short of memory.'
    )
    expect(backendExitDetail({ code: null, signal: 'SIGKILL' })).toBe('Exit signal: SIGKILL')
    expect(backendExitDetail({ code: 'x', signal: '<script>' })).toBe('No exit status was reported.')
    expect(backendExitCause({ code: 3, signal: null })).toBe('Its background process quit with error code 3.')
    expect(backendExitCause({ code: 0, signal: null })).toBe('Its background process quit on its own.')
    expect(backendExitCause({ code: 'x', signal: '<script>' })).toBe('Its background process quit.')
    expect(backendExitCause(undefined)).toBe('Its background process quit.')
  })
})
