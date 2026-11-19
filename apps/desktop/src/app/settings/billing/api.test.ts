import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BillingChargeResponse, BillingStateResponse } from './types'

const requestGatewayMock = vi.hoisted(() => vi.fn())

vi.mock('@/app/gateway/hooks/use-gateway-request', () => ({
  useGatewayRequest: () => ({ requestGateway: requestGatewayMock })
}))

import { createBillingApi, useBillingApi } from './api'

const CONFIRM_A = 'a'.repeat(64)
const CONFIRM_B = 'b'.repeat(64)

/** F1-S: the preload's `billingCharge` bridge, as the app window has it. */
function withBillingBridge(
  authorize: (amountUsd: string, idempotencyKey: string) => Promise<unknown>,
  authorizeAction?: (action: string, subject: string, idempotencyKey: string) => Promise<unknown>
) {
  ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = {
    billingCharge: { authorize, ...(authorizeAction ? { authorizeAction } : {}) }
  }
}

/** v0.0.9 Q: the bridge for the non-Buy writes; answers a valid confirm. */
function withActionBridge() {
  const authorizeAction = vi.fn().mockResolvedValue({ ok: true, ownerConfirm: CONFIRM_A })

  withBillingBridge(vi.fn(), authorizeAction)

  return authorizeAction
}

afterEach(() => {
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
})

describe('createBillingApi', () => {
  beforeEach(() => {
    requestGatewayMock.mockReset()
    vi.restoreAllMocks()
  })

  it('passes successful RPC results through as data', async () => {
    const state = {
      auto_reload: null,
      balance_display: '$10.00',
      balance_usd: '10',
      can_charge: true,
      card: null,
      charge_presets: ['10'],
      charge_presets_display: ['$10'],
      cli_billing_enabled: true,
      is_admin: true,
      logged_in: true,
      max_usd: '100',
      min_usd: '10',
      monthly_cap: null,
      ok: true,
      org_name: 'Nous',
      portal_url: 'https://portal.nousresearch.com/billing',
      role: 'OWNER'
    } satisfies BillingStateResponse

    requestGatewayMock.mockResolvedValueOnce(state)

    const { result } = renderHook(() => useBillingApi())
    const response = await result.current.fetchBillingState()

    expect(response).toEqual({ data: state, ok: true })
    expect(requestGatewayMock).toHaveBeenCalledWith('billing.state', {})
  })

  it('normalizes object-shaped refusal envelopes', async () => {
    requestGatewayMock.mockResolvedValueOnce({
      error: {
        kind: 'no_payment_method',
        message: 'No saved card.',
        portal_url: 'https://portal.nousresearch.com/billing',
        retry_after: 30
      },
      ok: false
    })

    const api = createBillingApi(requestGatewayMock)
    const response = await api.chargeStatus('ch_123')

    expect(response).toMatchObject({
      ok: false,
      refusal: {
        kind: 'no_payment_method',
        message: 'No saved card.',
        portalUrl: 'https://portal.nousresearch.com/billing',
        retryAfter: 30
      }
    })
    expect(requestGatewayMock).toHaveBeenCalledWith('billing.charge_status', { charge_id: 'ch_123' })
  })

  it('normalizes current string-shaped refusal envelopes', async () => {
    requestGatewayMock.mockResolvedValueOnce({
      error: 'monthly_cap_exceeded',
      message: 'Monthly spend cap reached.',
      ok: false,
      payload: { remainingUsd: '4.50' },
      portal_url: 'https://portal.nousresearch.com/billing'
    })

    vi.spyOn(crypto, 'randomUUID').mockReturnValue('22222222-2222-4222-8222-222222222222')
    withActionBridge()

    const api = createBillingApi(requestGatewayMock)
    const response = await api.updateAutoReload({ enabled: true, reload_to_usd: '100', threshold_usd: '25' })

    expect(response).toMatchObject({
      ok: false,
      refusal: {
        kind: 'monthly_cap_exceeded',
        message: 'Monthly spend cap reached.',
        payload: { remainingUsd: '4.50' },
        portalUrl: 'https://portal.nousresearch.com/billing'
      }
    })
    expect(requestGatewayMock).toHaveBeenCalledWith('billing.auto_reload', {
      enabled: true,
      idempotency_key: '22222222-2222-4222-8222-222222222222',
      owner_confirm: CONFIRM_A,
      threshold: '25',
      top_up_amount: '100'
    })
  })

  it('maps thrown gateway failures to transport refusals', async () => {
    requestGatewayMock.mockRejectedValueOnce(new Error('connection closed'))

    const api = createBillingApi(requestGatewayMock)
    const response = await api.fetchSubscriptionState()

    expect(response).toEqual({
      ok: false,
      refusal: {
        kind: 'transport',
        message: 'connection closed',
        raw: expect.any(Error)
      }
    })
  })

  it('maps thrown timeout failures to timeout refusals', async () => {
    requestGatewayMock.mockRejectedValueOnce(new Error('request timed out after 5000ms'))

    const api = createBillingApi(requestGatewayMock)
    const response = await api.stepUp()

    expect(response).toEqual({
      ok: false,
      refusal: {
        kind: 'timeout',
        message: 'request timed out after 5000ms',
        raw: expect.any(Error)
      }
    })
  })

  it('previews a subscription change with the chosen tier id', async () => {
    requestGatewayMock.mockResolvedValueOnce({ effect: 'scheduled', ok: true, target_tier_name: 'Plus' })

    const api = createBillingApi(requestGatewayMock)
    const response = await api.previewSubscriptionChange('tier_plus')

    expect(response).toEqual({ data: { effect: 'scheduled', ok: true, target_tier_name: 'Plus' }, ok: true })
    expect(requestGatewayMock).toHaveBeenCalledWith('subscription.preview', { subscription_type_id: 'tier_plus' })
  })

  it('schedules a subscription change with the chosen tier id', async () => {
    requestGatewayMock.mockResolvedValueOnce({ message: 'Downgrade scheduled.', ok: true })

    vi.spyOn(crypto, 'randomUUID').mockReturnValue('22222222-2222-4222-8222-222222222222')
    withActionBridge()

    const api = createBillingApi(requestGatewayMock)
    const response = await api.scheduleSubscriptionChange('tier_plus')

    expect(response).toEqual({ data: { message: 'Downgrade scheduled.', ok: true }, ok: true })
    expect(requestGatewayMock).toHaveBeenCalledWith('subscription.change', {
      idempotency_key: '22222222-2222-4222-8222-222222222222',
      owner_confirm: CONFIRM_A,
      subscription_type_id: 'tier_plus'
    })
  })

  it('resumes (undoes) a scheduled change carrying only the key and the owner confirm', async () => {
    requestGatewayMock.mockResolvedValueOnce({ message: 'Change cancelled.', ok: true })
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('22222222-2222-4222-8222-222222222222')
    withActionBridge()

    const api = createBillingApi(requestGatewayMock)
    const response = await api.resumeSubscription()

    expect(response).toEqual({ data: { message: 'Change cancelled.', ok: true }, ok: true })
    expect(requestGatewayMock).toHaveBeenCalledWith('subscription.resume', {
      idempotency_key: '22222222-2222-4222-8222-222222222222',
      owner_confirm: CONFIRM_A
    })
  })

  it('surfaces an insufficient_scope refusal from a subscription preview', async () => {
    requestGatewayMock.mockResolvedValueOnce({
      error: { kind: 'insufficient_scope', message: 'billing:manage required' },
      ok: false
    })

    withActionBridge()

    const api = createBillingApi(requestGatewayMock)
    const response = await api.scheduleSubscriptionChange('tier_plus')

    expect(response).toMatchObject({ ok: false, refusal: { kind: 'insufficient_scope' } })
  })

  it('sends a step-up session id when provided', async () => {
    requestGatewayMock.mockResolvedValueOnce({ granted: true, ok: true })

    const api = createBillingApi(requestGatewayMock)
    await api.stepUp('session-123')

    expect(requestGatewayMock).toHaveBeenCalledWith('billing.step_up', { session_id: 'session-123' })
  })

  it('sends a minted charge idempotency key and reuses it on explicit retry', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('11111111-1111-4111-8111-111111111111')

    // F1-S: main's owner confirm for each charge (the preload bridge; a real click in the app).
    const authorize = vi.fn().mockResolvedValueOnce({ ok: true, ownerConfirm: CONFIRM_A }).mockResolvedValueOnce({
      ok: true,
      ownerConfirm: CONFIRM_B
    })

    withBillingBridge(authorize)

    const submitted = {
      charge_id: 'ch_123',
      idempotency_key: '11111111-1111-4111-8111-111111111111',
      ok: true
    } satisfies BillingChargeResponse

    requestGatewayMock.mockResolvedValue(submitted)

    const api = createBillingApi(requestGatewayMock)
    const first = await api.charge('25')
    const second = await api.charge('25', first.idempotencyKey)

    expect(first).toEqual({ data: submitted, idempotencyKey: '11111111-1111-4111-8111-111111111111', ok: true })
    expect(second).toEqual({ data: submitted, idempotencyKey: '11111111-1111-4111-8111-111111111111', ok: true })
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1)
    expect(authorize).toHaveBeenNthCalledWith(1, '25', '11111111-1111-4111-8111-111111111111')
    expect(authorize).toHaveBeenNthCalledWith(2, '25', '11111111-1111-4111-8111-111111111111')
    expect(requestGatewayMock).toHaveBeenNthCalledWith(1, 'billing.charge', {
      amount_usd: '25',
      idempotency_key: '11111111-1111-4111-8111-111111111111',
      owner_confirm: CONFIRM_A
    })
    expect(requestGatewayMock).toHaveBeenNthCalledWith(2, 'billing.charge', {
      amount_usd: '25',
      idempotency_key: '11111111-1111-4111-8111-111111111111',
      owner_confirm: CONFIRM_B
    })
  })
})

// ── F1-S: Buy credits needs main's owner confirm (electron/gesture-locks-billing.ts) ─────────────────────────────

describe('F1-S: billing.charge is never sent without the owner confirm', () => {
  beforeEach(() => {
    requestGatewayMock.mockReset()
    requestGatewayMock.mockResolvedValue({ charge_id: 'ch_1', ok: true })
  })

  it('asks main synchronously, before the charge call returns its promise (inside the Buy click)', () => {
    const authorize = vi.fn(() => new Promise(() => undefined))

    withBillingBridge(authorize)
    void createBillingApi(requestGatewayMock).charge('25', 'key-0000-0001')

    // Not after an await: the preload's lock is taken while the click is still being handled.
    expect(authorize).toHaveBeenCalledTimes(1)
    expect(authorize).toHaveBeenCalledWith('25', 'key-0000-0001')
    expect(requestGatewayMock).not.toHaveBeenCalled()
  })

  it('a refused confirm (a script, a synthetic click, the agent) sends no charge and says why', async () => {
    withBillingBridge(() =>
      Promise.resolve({ ok: false, error: '[billing-charge:gesture] a charge needs your own click on Buy' })
    )

    const result = await createBillingApi(requestGatewayMock).charge('25', 'key-0000-0002')

    expect(result).toMatchObject({ ok: false, idempotencyKey: 'key-0000-0002', refusal: { kind: 'owner_confirm' } })
    expect(requestGatewayMock).not.toHaveBeenCalled()
  })

  it('a sender main refuses (null), a malformed answer or a rejected IPC sends no charge', async () => {
    for (const answer of [
      () => Promise.resolve(null),
      () => Promise.resolve({ ok: true }),
      () => Promise.resolve({ ok: true, ownerConfirm: 'not-a-token' }),
      () => Promise.reject(new Error('no handler for iclone:billing:authorize-charge'))
    ]) {
      withBillingBridge(answer)

      const result = await createBillingApi(requestGatewayMock).charge('25', 'key-0000-0003')

      expect(result.ok).toBe(false)
    }

    expect(requestGatewayMock).not.toHaveBeenCalled()
  })

  it('without the bridge (the web app, an old preload) nothing is charged', async () => {
    const result = await createBillingApi(requestGatewayMock).charge('25', 'key-0000-0004')

    expect(result).toMatchObject({ ok: false, refusal: { kind: 'owner_confirm' } })
    expect(requestGatewayMock).not.toHaveBeenCalled()
  })
})

// ── v0.0.9 Q: every other billing write that charges or arms a charge needs main's owner confirm too ──────────────

describe('v0.0.9 Q: resume, change to a tier and auto-reload ON carry owner_confirm + idempotency_key', () => {
  beforeEach(() => {
    requestGatewayMock.mockReset()
    requestGatewayMock.mockResolvedValue({ ok: true })
    vi.restoreAllMocks()
  })

  const writes: Array<{
    action: string
    call: (api: ReturnType<typeof createBillingApi>) => Promise<unknown>
    method: string
    subject: string
  }> = [
    { action: 'subscription-resume', call: api => api.resumeSubscription(), method: 'subscription.resume', subject: 'resume' },
    {
      action: 'subscription-change',
      call: api => api.scheduleSubscriptionChange('tier_plus'),
      method: 'subscription.change',
      subject: 'tier_plus'
    },
    {
      action: 'auto-reload',
      call: api => api.updateAutoReload({ enabled: true, reload_to_usd: '25.50', threshold_usd: '10' }),
      method: 'billing.auto_reload',
      subject: 'on|10|25.50'
    }
  ]

  for (const { action, call, method, subject } of writes) {
    it(`${method}: asks main synchronously for (${action}, ${subject}, key) and sends the confirm`, async () => {
      vi.spyOn(crypto, 'randomUUID').mockReturnValue('33333333-3333-4333-8333-333333333333')

      const authorizeAction = vi.fn(() => new Promise(() => undefined))

      withBillingBridge(vi.fn(), authorizeAction)
      void call(createBillingApi(requestGatewayMock))

      // Inside the click, before any await; nothing is sent while main has not answered.
      expect(authorizeAction).toHaveBeenCalledWith(action, subject, '33333333-3333-4333-8333-333333333333')
      expect(requestGatewayMock).not.toHaveBeenCalled()
    })

    it(`${method}: sends owner_confirm + idempotency_key, and NO RPC without a confirm`, async () => {
      vi.spyOn(crypto, 'randomUUID').mockReturnValue('33333333-3333-4333-8333-333333333333')
      withActionBridge()
      await call(createBillingApi(requestGatewayMock))

      expect(requestGatewayMock).toHaveBeenCalledTimes(1)
      expect(requestGatewayMock).toHaveBeenCalledWith(
        method,
        expect.objectContaining({ idempotency_key: '33333333-3333-4333-8333-333333333333', owner_confirm: CONFIRM_A })
      )

      requestGatewayMock.mockClear()

      for (const answer of [
        () => Promise.resolve({ ok: false, error: 'gesture' }),
        () => Promise.resolve(null),
        () => Promise.resolve({ ok: true, ownerConfirm: 'nope' }),
        () => Promise.reject(new Error('no handler'))
      ]) {
        withBillingBridge(vi.fn(), answer)
        expect(await call(createBillingApi(requestGatewayMock))).toMatchObject({
          ok: false,
          refusal: { kind: 'owner_confirm' }
        })
      }

      // No bridge at all (web app / old preload).
      delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
      expect(await call(createBillingApi(requestGatewayMock))).toMatchObject({ ok: false })
      expect(requestGatewayMock).not.toHaveBeenCalled()
    })
  }

  it('auto-reload ON sends threshold and top_up_amount as decimal strings', async () => {
    withActionBridge()
    await createBillingApi(requestGatewayMock).updateAutoReload({
      enabled: true,
      reload_to_usd: '25.5',
      threshold_usd: '10'
    })

    expect(requestGatewayMock).toHaveBeenCalledWith('billing.auto_reload', expect.objectContaining({
      enabled: true,
      threshold: '10',
      top_up_amount: '25.5'
    }))
  })

  it('auto-reload OFF needs no confirm: no bridge call, no owner_confirm', async () => {
    const authorizeAction = withActionBridge()

    await createBillingApi(requestGatewayMock).updateAutoReload({
      enabled: false,
      reload_to_usd: '25',
      threshold_usd: '10'
    })

    expect(authorizeAction).not.toHaveBeenCalled()
    expect(requestGatewayMock).toHaveBeenCalledWith('billing.auto_reload', {
      enabled: false,
      threshold: '10',
      top_up_amount: '25'
    })
  })
})
