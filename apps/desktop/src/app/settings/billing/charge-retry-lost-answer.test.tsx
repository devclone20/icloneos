/**
 * v0.0.9 r2 (m-r2-1, lead addition): Buy credits → the answer is LOST → the owner clicks Retry → EXACTLY ONE charge.
 *
 * End to end below the click: the real charge flow (useChargeFlow), the real billing api (createBillingApi), main's real
 * owner-confirm lock (createBillingChargeLock) behind the preload bridge, and a fake runtime + portal that behave like
 * the real ones:
 * - the runtime spends the owner confirm for exactly (amount, key) before it calls the portal
 *   (tui_gateway/methods_session.py `_owner_confirm_refusal`), then POSTs /charge with `Idempotency-Key`;
 * - the portal charges once per key and answers a repeated key with the SAME charge (Stripe-style idempotency);
 * - the first answer is lost between the portal and the runtime: the charge happened, the runtime's read timed out,
 *   and it answers `{ ok: false, error: 'network_error' }` (hermes_cli/nous_billing.py `_request`, TimeoutError).
 *
 * Red on the old code: its own retry list had no `network_error`, so Retry minted a NEW key and the portal charged twice.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import { createElement, type PropsWithChildren } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createBillingChargeLock } from '../../../../electron/gesture-locks-billing'

import { $openPurchase, OPEN_PURCHASE_TTL_MS, resetOpenPurchaseForTests } from './open-purchase'
import { useChargeFlow } from './use-charge-poller'

interface Send {
  amount: string
  key: string
  ownerConfirm: string
  confirmed: boolean
}

const world = vi.hoisted(() => ({
  request: null as null | ((method: string, params?: Record<string, unknown>) => Promise<unknown>)
}))

vi.mock('@/app/gateway/hooks/use-gateway-request', () => ({
  useGatewayRequest: () => ({
    requestGateway: (method: string, params?: Record<string, unknown>) => world.request!(method, params)
  })
}))

function harness(opts: { loseAnswers?: number; refuseFirst?: string } = {}) {
  // Main's lock; every authorize below stands for one trusted owner click (the gesture verdict is main's, tested there).
  const lock = createBillingChargeLock({ audit: () => ({ id: 'r' }), gestureOk: () => true })
  const portalCharges = new Map<string, { amount: string; chargeId: string }>()
  const sends: Send[] = []

  let lostLeft = opts.loseAnswers ?? 1
  let refuseFirst = opts.refuseFirst

  ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = {
    billingCharge: {
      authorize: async (amountUsd: string, idempotencyKey: string) =>
        lock.authorize({}, { amountUsd, idempotencyKey, gesture: true })
    }
  }

  world.request = async (method, params = {}) => {
    if (method === 'billing.charge') {
      const amount = String(params.amount_usd)
      const key = String(params.idempotency_key)
      const ownerConfirm = String(params.owner_confirm)
      const confirmed = lock.consume(ownerConfirm, amount, key)

      sends.push({ amount, confirmed, key, ownerConfirm })

      if (!confirmed) {
        return { error: 'owner_confirm', message: 'no confirm', ok: false }
      }

      // A definite refusal from the portal: nothing charged (e.g. the card was declined before any charge).
      if (refuseFirst) {
        const error = refuseFirst

        refuseFirst = undefined

        return { error, idempotency_key: key, message: 'refused', ok: false }
      }

      // The portal: one charge per Idempotency-Key.
      let charge = portalCharges.get(key)

      if (!charge) {
        charge = { amount, chargeId: `ch_${portalCharges.size + 1}` }
        portalCharges.set(key, charge)
      }

      if (lostLeft > 0) {
        lostLeft -= 1

        // Charged at the portal; the answer never came back.
        return {
          error: 'network_error',
          idempotency_key: key,
          message: 'Could not reach Nous Portal: timed out',
          ok: false
        }
      }

      return { charge_id: charge.chargeId, idempotency_key: key, ok: true }
    }

    if (method === 'billing.charge_status') {
      return { amount_usd: '10', ok: true, status: 'settled' }
    }

    return { ok: true }
  }

  return { lock, portalCharges, sends }
}

function wrapper({ children }: PropsWithChildren) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return createElement(QueryClientProvider, { client }, children)
}

beforeEach(() => {
  world.request = null
  resetOpenPurchaseForTests()
  window.sessionStorage.clear()
})

afterEach(() => {
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
})

describe('m-r2-1: a Retry after a lost answer is the SAME purchase', () => {
  it('Buy charges, the answer is lost, Retry: exactly ONE charge at the portal, one key, two single-use confirms', async () => {
    const { lock, portalCharges, sends } = harness()
    const { result } = renderHook(() => useChargeFlow(), { wrapper })

    // Buy $10.
    await act(async () => {
      await result.current.start('10')
    })

    expect(portalCharges.size).toBe(1)
    // The owner sees a failure with Try again (they cannot know the charge went through).
    expect(result.current.outcome).toMatchObject({ action: { type: 'retry' }, kind: 'failure' })

    // Retry (the outcome's Try again runs the same start for the same amount).
    await act(async () => {
      await result.current.start('10')
    })

    expect(sends).toHaveLength(2)
    expect(sends[1]!.key).toBe(sends[0]!.key)
    expect(sends[1]!.ownerConfirm).not.toBe(sends[0]!.ownerConfirm)
    expect(sends.every(send => send.confirmed)).toBe(true)
    expect(portalCharges.size).toBe(1)
    expect(result.current.outcome).toMatchObject({ kind: 'success' })
    // Both confirms are spent: neither can pay again.
    expect(lock.consume(sends[0]!.ownerConfirm, '10', sends[0]!.key)).toBe(false)
    expect(lock.consume(sends[1]!.ownerConfirm, '10', sends[1]!.key)).toBe(false)
    expect(lock.pendingCount()).toBe(0)
  })

  it('a NEW Buy after that definite success is a new purchase: a new key and a second charge', async () => {
    const { portalCharges, sends } = harness()
    const { result } = renderHook(() => useChargeFlow(), { wrapper })

    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        await result.current.start('10')
      })
    }

    expect(sends.map(send => send.key)).toEqual([sends[0]!.key, sends[0]!.key, expect.any(String)])
    expect(sends[2]!.key).not.toBe(sends[0]!.key)
    expect(portalCharges.size).toBe(2)
  })
})

describe('eng n1 (r3): the open purchase survives leaving Billing and retyping', () => {
  it('lost answer → the Buy row unmounts (Billing left) → a new row → Buy: the SAME key, exactly one charge', async () => {
    const { portalCharges, sends } = harness()
    const first = renderHook(() => useChargeFlow(), { wrapper })

    await act(async () => {
      await first.result.current.start('10')
    })
    first.unmount() // the owner switches tab / closes Settings: the old useRef intent died here

    expect($openPurchase.get()).toMatchObject({ amountUsd: '10', idempotencyKey: sends[0]!.key })

    const second = renderHook(() => useChargeFlow(), { wrapper })

    await act(async () => {
      await second.result.current.start('10')
    })

    expect(sends.map(send => send.key)).toEqual([sends[0]!.key, sends[0]!.key])
    expect(portalCharges.size).toBe(1)
    expect(second.result.current.outcome).toMatchObject({ kind: 'success' })
    expect($openPurchase.get()).toBeNull() // a definite answer closed it
  })

  it('retyping the amount (reset on every keystroke) and "10.00" for "10" keep the purchase and its key', async () => {
    const { portalCharges, sends } = harness()
    const { result } = renderHook(() => useChargeFlow(), { wrapper })

    await act(async () => {
      await result.current.start('10')
    })
    act(() => {
      result.current.reset()
      result.current.reset()
    })
    await act(async () => {
      await result.current.start('10.00')
    })

    expect(sends[1]!.key).toBe(sends[0]!.key)
    expect(sends[1]!.amount).toBe('10') // re-sent exactly as first sent
    expect(portalCharges.size).toBe(1)
  })

  it('another amount while a purchase is open is held: nothing is sent, Try again names the open purchase', async () => {
    const { portalCharges, sends } = harness()
    const { result } = renderHook(() => useChargeFlow(), { wrapper })

    await act(async () => {
      await result.current.start('10')
    })
    await act(async () => {
      await result.current.start('25')
    })

    expect(sends).toHaveLength(1)
    expect(result.current.outcome).toMatchObject({ action: { type: 'retry' }, kind: 'failure', retryAmountUsd: '10' })
    expect(portalCharges.size).toBe(1)
  })

  it('a Buy made while the first is still in flight joins it under the same key', async () => {
    const { portalCharges, sends } = harness({ loseAnswers: 0 })
    const a = renderHook(() => useChargeFlow(), { wrapper })
    const b = renderHook(() => useChargeFlow(), { wrapper })

    await act(async () => {
      await Promise.all([a.result.current.start('10'), b.result.current.start('10')])
    })

    expect(sends[1]!.key).toBe(sends[0]!.key)
    expect(portalCharges.size).toBe(1)
  })

  it('a definite refusal (nothing charged) closes it: the next Buy is a new intent with a new key', async () => {
    const { sends } = harness({ loseAnswers: 0, refuseFirst: 'no_payment_method' })
    const { result } = renderHook(() => useChargeFlow(), { wrapper })

    await act(async () => {
      await result.current.start('10')
    })

    expect($openPurchase.get()).toBeNull()

    await act(async () => {
      await result.current.start('10')
    })

    expect(sends[1]!.key).not.toBe(sends[0]!.key)
  })

  // r3-n7 (stricter than r3): past the window the purchase is not dropped silently. The next Buy is held with "check the
  // portal" (nothing sent); only the Buy after that is a new purchase with a new key.
  it('past the idempotency window the open purchase lapses: one Buy is held with "check the portal", then a new key', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })

    try {
      const { sends } = harness({ loseAnswers: 1 })
      const { result } = renderHook(() => useChargeFlow(), { wrapper })

      await act(async () => {
        await result.current.start('10')
      })
      vi.setSystemTime(Date.now() + OPEN_PURCHASE_TTL_MS)
      await act(async () => {
        await result.current.start('25')
      })

      expect(sends).toHaveLength(1)
      expect(result.current.outcome).toMatchObject({ kind: 'ambiguous', title: 'Your last charge is not confirmed yet' })
      expect(String((result.current.outcome as { message: string }).message)).toMatch(/\$10.*too old.*portal/)

      await act(async () => {
        await result.current.start('25')
      })

      expect(sends).toHaveLength(2)
      expect(sends[1]!.key).not.toBe(sends[0]!.key)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('r3-n4: the doubt is shown again after leaving Billing and coming back', () => {
  // Red on bf42e8eb02: the remounted row showed a plain Buy (outcome null) though $10 might be charged.
  it('lost answer → unmount → a new row shows "not confirmed yet" with Try again for that purchase, before any click', async () => {
    const { sends } = harness()
    const first = renderHook(() => useChargeFlow(), { wrapper })

    await act(async () => {
      await first.result.current.start('10')
    })
    first.unmount()

    const second = renderHook(() => useChargeFlow(), { wrapper })

    expect(sends).toHaveLength(1)
    expect(second.result.current.phase).toBe('idle')
    expect(second.result.current.outcome).toMatchObject({
      action: { type: 'retry' },
      kind: 'failure',
      retryAmountUsd: '10',
      title: 'Your last charge is not confirmed yet'
    })
    expect(String((second.result.current.outcome as { message: string }).message)).toMatch(/\$10.*no clear answer/)

    // Retyping clears what the row showed, never the doubt.
    act(() => second.result.current.reset())
    expect(second.result.current.outcome).toMatchObject({ retryAmountUsd: '10' })

    // Its Try again finishes the same purchase: the same key, one charge.
    await act(async () => {
      await second.result.current.start('10')
    })
    expect(sends[1]!.key).toBe(sends[0]!.key)
    expect(second.result.current.outcome).toMatchObject({ kind: 'success' })
  })

  it('with no purchase open, a fresh row shows nothing', () => {
    harness()

    expect(renderHook(() => useChargeFlow(), { wrapper }).result.current.outcome).toBeNull()
  })

  it('an open purchase that outlived the window shows "check the portal" on mount, with no Try again', () => {
    vi.useFakeTimers({ toFake: ['Date'] })

    try {
      $openPurchase.set({ amountUsd: '10', idempotencyKey: 'fixture-idem-aaaaaaaa', openedAt: Date.now() - OPEN_PURCHASE_TTL_MS })

      const { outcome } = renderHook(() => useChargeFlow(), { wrapper }).result.current

      expect(outcome).toMatchObject({ kind: 'ambiguous' })
      expect(outcome).not.toHaveProperty('action')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('r3-n5: the open purchase survives a renderer reload', () => {
  // Red on bf42e8eb02: the purchase lived only in renderer memory, so a reload (or a crash with auto-reload) between the
  // lost answer and the next Buy minted a NEW key, and the portal charged a second time.
  it('lost answer → the renderer reloads (fresh modules, same window storage) → Buy: the SAME key, exactly one charge', async () => {
    const { portalCharges, sends } = harness()
    const before = renderHook(() => useChargeFlow(), { wrapper })

    await act(async () => {
      await before.result.current.start('10')
    })
    before.unmount()

    vi.resetModules()

    const reloaded = await import('./use-charge-poller')
    const query = await import('@tanstack/react-query')

    const fresh = ({ children }: PropsWithChildren) =>
      createElement(
        query.QueryClientProvider,
        { client: new query.QueryClient({ defaultOptions: { queries: { retry: false } } }) },
        children
      )

    const after = renderHook(() => reloaded.useChargeFlow(), { wrapper: fresh })

    expect(after.result.current.outcome).toMatchObject({ retryAmountUsd: '10' })

    await act(async () => {
      await after.result.current.start('10')
    })

    expect(sends.map(send => send.key)).toEqual([sends[0]!.key, sends[0]!.key])
    expect(portalCharges.size).toBe(1)
    expect(after.result.current.outcome).toMatchObject({ kind: 'success' })
    // The definite answer closed it in storage too: the next reload starts clean.
    expect(window.sessionStorage.getItem('iclone.billing.openPurchase.v1')).toBeNull()
  })

  it('a stored record that is not ours is ignored, never sent', async () => {
    const { parseStoredPurchase } = await import('./open-purchase')

    expect(parseStoredPurchase('{"amountUsd":"10","idempotencyKey":"fixture-idem-aaaaaaaa","openedAt":5}')).toMatchObject({
      amountUsd: '10'
    })
    expect(parseStoredPurchase('{"amountUsd":"10; drop","idempotencyKey":"fixture-idem-aaaaaaaa","openedAt":5}')).toBeNull()
    expect(parseStoredPurchase('{"amountUsd":"10","idempotencyKey":"<script>","openedAt":5}')).toBeNull()
    expect(parseStoredPurchase('{"amountUsd":"10","idempotencyKey":"fixture-idem-aaaaaaaa"}')).toBeNull()
    expect(parseStoredPurchase('not json')).toBeNull()
  })
})
