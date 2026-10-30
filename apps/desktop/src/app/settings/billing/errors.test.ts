import type { KnownBillingRefusalCode } from '@hermes/shared/billing'
import { describe, expect, it } from 'vitest'

import type { BillingRefusal } from './api'
import { BILLING_COPY } from './copy'
import { resolveRefusal } from './errors'

const en = BILLING_COPY.en

const expectedActions: Record<
  KnownBillingRefusalCode | 'timeout' | 'transport',
  'none' | 'portal' | 'retry' | 'step_up'
> = {
  auto_top_up_disabled_failures: 'none',
  cli_billing_disabled: 'portal',
  consent_required: 'portal',
  endpoint_unavailable: 'retry',
  idempotency_conflict: 'none',
  idempotency_key_required: 'none',
  insufficient_scope: 'step_up',
  internal_error: 'none',
  invalid_charge_id: 'none',
  invalid_request: 'none',
  monthly_cap_exceeded: 'portal',
  network_error: 'none',
  no_payment_method: 'portal',
  org_access_denied: 'none',
  preview_rejected: 'none',
  rate_limited: 'retry',
  remote_spending_disabled: 'portal',
  remote_spending_revoked: 'portal',
  role_required: 'portal',
  session_revoked: 'portal',
  stripe_unavailable: 'retry',
  temporarily_unavailable: 'retry',
  timeout: 'retry',
  transport: 'retry',
  upgrade_cap_exceeded: 'none',
  validation_failed: 'none'
}

describe('resolveRefusal', () => {
  it('maps every known refusal kind to copy and the expected action', () => {
    for (const [kind, actionType] of Object.entries(expectedActions)) {
      const resolved = resolveRefusal(
        {
          kind: kind as BillingRefusal['kind'],
          message: 'Server message.',
          portalUrl: 'https://portal.nousresearch.com/billing',
          retryAfter: 90
        },
        en
      )

      expect(resolved.title, kind).not.toHaveLength(0)
      expect(resolved.message, kind).not.toHaveLength(0)
      expect(resolved.action.type, kind).toBe(actionType)
    }
  })

  it('includes monthly cap headroom when the server sends it', () => {
    const resolved = resolveRefusal(
      {
        kind: 'monthly_cap_exceeded',
        message: 'Monthly spend cap reached.',
        payload: { remainingUsd: '4.50' }
      },
      en
    )

    expect(resolved.message).toContain(en.refusal.capRemaining('$4.50'))
  })

  it('includes the retry timing when the server sends it', () => {
    const resolved = resolveRefusal(
      { kind: 'stripe_unavailable', message: 'Stripe is unavailable.', retryAfter: 120 },
      en
    )

    expect(resolved.message).toContain(en.refusal.retryIn(2))
  })

  it('falls back to catalogue words for unknown refusal kinds, never the backend text', () => {
    const resolved = resolveRefusal({ kind: 'new_billing_code', message: 'Something changed upstream.' }, en)

    expect(resolved).toEqual({
      action: { type: 'none' },
      message: en.refusal.failedMessage,
      title: en.refusal.failedTitle
    })
  })

  it('speaks the app locale', () => {
    const resolved = resolveRefusal({ kind: 'role_required', message: '' }, BILLING_COPY.ja)

    expect(resolved.title).toBe(BILLING_COPY.ja.refusal.roleTitle)
    expect(resolved.title).not.toBe(en.refusal.roleTitle)
  })
})
