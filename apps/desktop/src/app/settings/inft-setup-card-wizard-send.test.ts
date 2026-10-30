import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as CardResend from './inft-setup-card-resend'

const acp = vi.hoisted(() => ({
  refreshAcpStatus: vi.fn(),
  runAcp: vi.fn(),
  inftKvGet: vi.fn(),
  inftKvSet: vi.fn(),
  inftKvDelete: vi.fn()
}))

const shared = vi.hoisted(() => ({ sendSignInLink: vi.fn() }))

vi.mock('../home/acp-setup', () => acp)
vi.mock('../home/lib/external', () => ({ openExternal: vi.fn() }))

// The real send, observed: a wizard that bypasses it never reaches this spy.
vi.mock('./inft-setup-card-resend', async importOriginal => {
  const actual = await importOriginal<typeof CardResend>()

  shared.sendSignInLink.mockImplementation(actual.sendSignInLink)

  return { ...actual, sendSignInLink: shared.sendSignInLink }
})

const { useCardSteps } = await import('./inft-setup-card')
const { useStepRunner } = await import('./inft-setup-runner')
const { INFT_WIZARD_COPY } = await import('./inft-setup-wizard-copy')

const EMAIL = 'a@agentcard.ai'

const pending = {
  cli: true,
  authenticated: true,
  cardReady: false,
  configured: true,
  checkedAt: 1,
  slug: 's',
  email: EMAIL,
  cardState: 'signin-pending',
  cardReauthState: 'ab-12'
} as const

const ok = (stdout: string) => ({ ok: true, code: 0, stdout, stderr: '' })

const isSignup = (argv: unknown) => Array.isArray(argv) && argv[0] === 'card' && argv[1] === 'signup'

describe('V3-L m1 — the Setup wizard sends a fresh link only through the shared send', () => {
  beforeEach(() => {
    vi.useFakeTimers()

    for (const fn of Object.values(acp)) {
      fn.mockReset()
    }

    shared.sendSignInLink.mockClear()
    acp.refreshAcpStatus.mockResolvedValue(null)
    acp.inftKvGet.mockResolvedValue({ ok: true, value: null })
    acp.inftKvSet.mockResolvedValue({ ok: true, value: {} })
    acp.inftKvDelete.mockResolvedValue({ ok: true, value: null })
    acp.runAcp.mockImplementation(async (_id: string, argv: string[]) =>
      isSignup(argv) ? ok('{"state":"st-9"}') : ok('{"done":false}')
    )
  })
  afterEach(() => vi.useRealTimers())

  it('signin-pending: one click goes through sendSignInLink, which writes the card-signup marker before the CLI runs', async () => {
    const { result } = renderHook(() => {
      const runner = useStepRunner('inft-1')

      return { card: useCardSteps({ runner, status: pending as never, inftId: 'inft-1' }), runner }
    })

    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(result.current.card.gate.gate).toBe('resend')

    await act(() => result.current.card.cardSignup())

    expect(shared.sendSignInLink).toHaveBeenCalledTimes(1)
    expect(shared.sendSignInLink).toHaveBeenCalledWith('inft-1', EMAIL, expect.any(Object))

    const signups = acp.runAcp.mock.calls.flatMap((call, index) =>
      isSignup(call[1]) ? [acp.runAcp.mock.invocationCallOrder[index] ?? 0] : []
    )

    const markers = acp.inftKvSet.mock.calls.flatMap((call, index) =>
      call[1] === 'card-signup' && (call[2] as { phase?: unknown }).phase === 'unconfirmed'
        ? [acp.inftKvSet.mock.invocationCallOrder[index] ?? 0]
        : []
    )

    expect(signups).toHaveLength(1)
    expect(markers).toHaveLength(1)
    expect(markers[0]).toBeLessThan(signups[0] ?? 0)
    expect(acp.runAcp.mock.calls.find(call => isSignup(call[1]))?.[1]).toEqual([
      'card',
      'signup',
      '--email',
      EMAIL,
      '--json'
    ])
    expect(result.current.runner.steps.card?.note).toBe(INFT_WIZARD_COPY.en.card.resent)
  })
})
