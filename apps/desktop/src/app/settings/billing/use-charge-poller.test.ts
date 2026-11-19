import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import { createElement, type PropsWithChildren } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BillingResult } from './api'
import { BILLING_COPY } from './copy'
import { resetOpenPurchaseForTests } from './open-purchase'
import type { BillingChargeStatusResponse } from './types'

const apiMocks = vi.hoisted(() => ({
  charge: vi.fn(),
  chargeStatus: vi.fn()
}))

vi.mock('./api', () => ({
  useBillingApi: () => ({
    charge: apiMocks.charge,
    chargeStatus: apiMocks.chargeStatus
  })
}))

import { CHARGE_POLL_CAP_MS, pollChargeSettlement, useChargeFlow } from './use-charge-poller'

/** The keys the flow sent, in order. r3 (eng n1): the flow mints the key itself, before the send, so the first Buy of
 *  an intent already carries one; what matters is which sends share it. */
const sentKeys = () => apiMocks.charge.mock.calls.map(call => call[1] as string)

function expectKeys(pattern: string): void {
  const keys = sentKeys()
  const names = new Map<string, string>()

  expect(keys.every(key => typeof key === 'string' && key.length >= 16)).toBe(true)
  expect(keys.map(key => names.get(key) ?? (names.set(key, String.fromCharCode(97 + names.size)), names.get(key))).join('')).toBe(pattern)
}

const en = BILLING_COPY.en

const status = (overrides: Partial<BillingChargeStatusResponse> = {}): BillingResult<BillingChargeStatusResponse> => ({
  data: {
    ok: true,
    status: 'pending',
    ...overrides
  },
  ok: true
})

const refusal = (
  kind: string,
  overrides: Partial<Extract<BillingResult<BillingChargeStatusResponse>, { ok: false }>['refusal']> = {}
): BillingResult<BillingChargeStatusResponse> => ({
  ok: false,
  refusal: {
    kind,
    message: kind,
    ...overrides
  }
})

function controlledClock() {
  let current = 0
  const waits: number[] = []

  return {
    now: () => current,
    sleep: vi.fn(async (ms: number) => {
      waits.push(ms)
      current += ms
    }),
    waits
  }
}

function wrapper({ children }: PropsWithChildren) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return createElement(QueryClientProvider, { client }, children)
}

beforeEach(() => {
  resetOpenPurchaseForTests()
  apiMocks.charge.mockReset()
  apiMocks.chargeStatus.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('pollChargeSettlement', () => {
  it('settles after pending polls', async () => {
    const clock = controlledClock()

    const api = {
      chargeStatus: vi
        .fn()
        .mockResolvedValueOnce(status())
        .mockResolvedValueOnce(status())
        .mockResolvedValueOnce(status({ amount_usd: '25', status: 'settled' }))
    }

    const outcome = await pollChargeSettlement(api, 'ch_123', { ...clock, copy: en })

    expect(outcome).toMatchObject({ amountUsd: '25', kind: 'success' })
    expect(api.chargeStatus).toHaveBeenCalledTimes(3)
    expect(clock.waits).toEqual([2000, 2000])
  })

  it('returns a failed outcome with the charge failure reason', async () => {
    const clock = controlledClock()

    const api = {
      chargeStatus: vi.fn().mockResolvedValue(status({ reason: 'card_declined', status: 'failed' }))
    }

    const outcome = await pollChargeSettlement(api, 'ch_123', { ...clock, copy: en })

    expect(outcome).toMatchObject({
      kind: 'failure',
      message: en.charge.declined,
      title: en.charge.failedTitle
    })
    expect(clock.waits).toEqual([])
  })

  it('backs off on rate limits, honors retryAfter, and keeps polling', async () => {
    const clock = controlledClock()

    const api = {
      chargeStatus: vi
        .fn()
        .mockResolvedValueOnce(refusal('rate_limited', { retryAfter: 7 }))
        .mockResolvedValueOnce(status({ amount_usd: '50', status: 'settled' }))
    }

    const outcome = await pollChargeSettlement(api, 'ch_123', { ...clock, copy: en })

    expect(outcome).toMatchObject({ amountUsd: '50', kind: 'success' })
    expect(clock.waits).toEqual([7000])
  })

  it('backs off when Stripe is unavailable and keeps polling', async () => {
    const clock = controlledClock()

    const api = {
      chargeStatus: vi
        .fn()
        .mockResolvedValueOnce(refusal('stripe_unavailable', { retryAfter: 3 }))
        .mockResolvedValueOnce(status({ amount_usd: '50', status: 'settled' }))
    }

    const outcome = await pollChargeSettlement(api, 'ch_123', { ...clock, copy: en })

    expect(outcome).toMatchObject({ amountUsd: '50', kind: 'success' })
    expect(clock.waits).toEqual([3000])
  })

  it('caps pending polling at 5 minutes as an ambiguous outcome', async () => {
    const clock = controlledClock()

    const api = {
      chargeStatus: vi.fn().mockResolvedValue(status())
    }

    const outcome = await pollChargeSettlement(api, 'ch_123', {
      ...clock,
      copy: en,
      portalUrl: 'https://portal.nousresearch.com/billing'
    })

    expect(outcome).toEqual({
      kind: 'ambiguous',
      message: en.charge.slowMessage,
      portalUrl: 'https://portal.nousresearch.com/billing',
      title: en.charge.slowTitle
    })
    expect(clock.waits.reduce((total, ms) => total + ms, 0)).toBe(CHARGE_POLL_CAP_MS)
  })

  it('treats auth revocation while polling as ambiguous', async () => {
    const clock = controlledClock()

    const api = {
      chargeStatus: vi.fn().mockResolvedValue(
        refusal('session_revoked', {
          message: 'Your session was logged out.',
          portalUrl: 'https://portal.nousresearch.com/billing'
        })
      )
    }

    const outcome = await pollChargeSettlement(api, 'ch_123', { ...clock, copy: en })

    expect(outcome).toMatchObject({
      kind: 'ambiguous',
      portalUrl: 'https://portal.nousresearch.com/billing',
      title: en.charge.unconfirmedTitle
    })
  })
})

describe('useChargeFlow', () => {
  it('turns a charge refusal into an immediate outcome without polling', async () => {
    apiMocks.charge.mockResolvedValue({
      idempotencyKey: 'key-1',
      ok: false,
      refusal: {
        kind: 'no_payment_method',
        message: 'No saved card.',
        portalUrl: 'https://portal.nousresearch.com/billing'
      }
    })

    const { result } = renderHook(() => useChargeFlow(), { wrapper })

    await act(async () => {
      await result.current.start('25')
    })

    expect(result.current.phase).toBe('done')
    expect(result.current.outcome).toMatchObject({
      kind: 'failure',
      title: en.refusal.noCardTitle
    })
    expect(apiMocks.chargeStatus).not.toHaveBeenCalled()
  })

  it('reuses one idempotency key when retrying a failed-to-send charge', async () => {
    apiMocks.charge.mockResolvedValue({
      idempotencyKey: 'key-1',
      ok: false,
      refusal: {
        kind: 'transport',
        message: 'connection closed'
      }
    })

    const { result } = renderHook(() => useChargeFlow(), { wrapper })

    await act(async () => {
      await result.current.start('25')
    })
    await act(async () => {
      await result.current.start('25')
    })

    expect(apiMocks.charge.mock.calls.map(call => call[0])).toEqual(['25', '25'])
    expectKeys('aa')
  })

  describe('m-r2-1: one purchase intent = one idempotency key until a definite answer', () => {
    const lost = (kind: string, idempotencyKey = 'key-1') => ({
      idempotencyKey,
      ok: false,
      refusal: { kind, message: kind }
    })

    // stripe_unavailable is what the runtime makes of a portal 503 (the r2 proof); the rest are lost/unclear answers.
    for (const kind of [
      'stripe_unavailable',
      'temporarily_unavailable',
      'network_error',
      'internal_error',
      'endpoint_unavailable',
      'rate_limited',
      'timeout',
      'transport',
      'error',
      'some_new_server_code'
    ]) {
      it(`${kind}: Retry sends the ORIGINAL key (a lost first charge collapses into one at the portal)`, async () => {
        apiMocks.charge.mockResolvedValueOnce(lost(kind)).mockResolvedValueOnce(lost(kind)).mockResolvedValue(lost(kind))

        const { result } = renderHook(() => useChargeFlow(), { wrapper })

        await act(async () => {
          await result.current.start('10')
        })
        expect(result.current.outcome).toMatchObject({ kind: 'failure' })
        await act(async () => {
          await result.current.start('10')
        })
        await act(async () => {
          await result.current.start('10')
        })

        expect(apiMocks.charge.mock.calls.map(call => call[0])).toEqual(['10', '10', '10'])
        expectKeys('aaa')
      })
    }

    it('a refused owner confirm in between (nothing sent) keeps the original key for the next Retry', async () => {
      apiMocks.charge
        .mockResolvedValueOnce(lost('stripe_unavailable'))
        .mockResolvedValueOnce(lost('owner_confirm'))
        .mockResolvedValueOnce(lost('stripe_unavailable'))

      const { result } = renderHook(() => useChargeFlow(), { wrapper })

      for (let i = 0; i < 3; i += 1) {
        await act(async () => {
          await result.current.start('10')
        })
      }

      expectKeys('aaa')
    })

    it('a definite refusal ends the intent: the next Buy mints a NEW key', async () => {
      apiMocks.charge
        .mockResolvedValueOnce(lost('stripe_unavailable'))
        .mockResolvedValueOnce(lost('no_payment_method'))
        .mockResolvedValueOnce(lost('stripe_unavailable', 'key-2'))

      const { result } = renderHook(() => useChargeFlow(), { wrapper })

      for (let i = 0; i < 3; i += 1) {
        await act(async () => {
          await result.current.start('10')
        })
      }

      expectKeys('aab')
    })

    it('an accepted charge ends the intent: the next Buy mints a NEW key', async () => {
      apiMocks.charge
        .mockResolvedValueOnce(lost('stripe_unavailable'))
        .mockResolvedValueOnce({ data: { charge_id: 'ch_1', ok: true }, idempotencyKey: 'key-1', ok: true })
        .mockResolvedValueOnce(lost('transport', 'key-2'))
      apiMocks.chargeStatus.mockResolvedValue(status({ amount_usd: '10', status: 'settled' }))

      const { result } = renderHook(() => useChargeFlow(), { wrapper })

      for (let i = 0; i < 3; i += 1) {
        await act(async () => {
          await result.current.start('10')
        })
      }

      expectKeys('aab')
    })

    // r3 (eng n1): stricter than r2. Another amount while a purchase may already be charged used to send at once under
    // a new key (two charges if the first went through); now nothing is sent and Try again finishes the open purchase.
    // Never the same key across amounts still holds (idempotency_conflict): the second amount is simply not sent.
    it('another amount while a purchase is open is held, never sent under any key', async () => {
      apiMocks.charge.mockResolvedValue(lost('stripe_unavailable'))

      const { result } = renderHook(() => useChargeFlow(), { wrapper })

      await act(async () => {
        await result.current.start('10')
      })
      await act(async () => {
        await result.current.start('25')
      })

      expect(apiMocks.charge.mock.calls.map(call => call[0])).toEqual(['10'])
      expect(result.current.outcome).toMatchObject({ kind: 'failure', retryAmountUsd: '10' })
    })
  })
})
