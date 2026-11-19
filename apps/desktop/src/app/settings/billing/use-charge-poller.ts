import { BILLING_REFUSAL_POLICY, refusalPolicy } from '@hermes/shared/billing-policy'
import {
  driveChargeSettlement,
  SETTLEMENT_POLL_CAP_MS,
  SETTLEMENT_POLL_INTERVAL_MS
} from '@hermes/shared/charge-settlement'
import { useStore } from '@nanostores/react'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useRef, useState } from 'react'

import { sleep as defaultSleep } from '@/iclone-shared/async'
import { isRecord } from '@/iclone-shared/guards'

import type { BillingApi, BillingRefusal } from './api'
import { useBillingApi } from './api'
import { formatMoney } from './billing-amounts'
import { type BillingCopy, useBillingCopy } from './copy'
import { resolveRefusal } from './errors'
import {
  $lapsedPurchase,
  $openPurchase,
  closePurchase,
  currentOpenPurchase,
  isPurchaseLive,
  isSamePurchase,
  type OpenPurchase,
  openPurchase,
  takeLapsedPurchase
} from './open-purchase'
import { OWNER_CONFIRM_REFUSAL } from './owner-confirm'
import type { BillingChargeStatusResponse } from './types'

const CHARGE_POLL_INTERVAL_MS = SETTLEMENT_POLL_INTERVAL_MS
export const CHARGE_POLL_CAP_MS = SETTLEMENT_POLL_CAP_MS

type ChargeFlowPhase = 'charging' | 'done' | 'idle' | 'polling'

type ChargeFlowOutcome =
  | {
      amountUsd?: string | null
      kind: 'success'
      message: string
    }
  | {
      action?: { type: 'portal'; url?: string } | { type: 'retry' } | { type: 'step_up' }
      kind: 'failure'
      message: string
      /** Try again buys THIS amount (the open purchase), not what the field shows now. */
      retryAmountUsd?: string
      retryFreshKey: boolean
      title: string
    }
  | {
      kind: 'ambiguous'
      message: string
      portalUrl?: string
      title: string
    }

interface ChargePollClock {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

interface ChargePollOptions extends ChargePollClock {
  copy: BillingCopy
  portalUrl?: null | string
}

export async function pollChargeSettlement(
  api: Pick<BillingApi, 'chargeStatus'>,
  chargeId: string,
  opts: ChargePollOptions
): Promise<ChargeFlowOutcome> {
  const { copy } = opts
  const sleep = opts.sleep ?? defaultSleep
  const now = opts.now ?? Date.now
  const observed: { refusal?: BillingRefusal; status?: BillingChargeStatusResponse } = {}

  const settlement = await driveChargeSettlement({
    fetchStatus: async () => {
      const result = await api.chargeStatus(chargeId)

      if (result.ok) {
        observed.refusal = undefined
        observed.status = result.data

        return result.data
      }

      observed.refusal = result.refusal
      observed.status = statusFromRefusal(result.refusal)

      return observed.status
    },
    isCancelled: () => false,
    now,
    sleep
  })

  switch (settlement.kind) {
    case 'settled':
      return {
        amountUsd: settlement.status.amount_usd,
        kind: 'success',
        message: settlement.status.amount_usd
          ? copy.charge.added(formatMoney(settlement.status.amount_usd))
          : copy.charge.addedGeneric
      }

    case 'failed':
      return {
        action: { type: 'retry' },
        kind: 'failure',
        message: renderChargeFailed(copy, settlement.status.reason),
        retryFreshKey: true,
        title: copy.charge.failedTitle
      }
    case 'ambiguous': {
      if (settlement.status && refusalPolicy(settlement.error).ambiguousMidPoll) {
        const refusal = observed.refusal ?? refusalFromStatus(settlement.error, settlement.status)
        const resolved = resolveRefusal(refusal, copy)
        const portalUrl = resolved.action.type === 'portal' ? resolved.action.url : refusal.portalUrl

        return {
          kind: 'ambiguous',
          message: `${resolved.message} ${copy.charge.unconfirmed}`,
          portalUrl: portalUrl ?? opts.portalUrl ?? undefined,
          title: copy.charge.unconfirmedTitle
        }
      }

      return {
        kind: 'failure',
        message: copy.charge.unconfirmed,
        retryFreshKey: true,
        title: copy.charge.checkFailedTitle
      }
    }

    case 'refused':
      return {
        kind: 'failure',
        message: copy.charge.unconfirmed,
        retryFreshKey: true,
        title: copy.charge.checkFailedTitle
      }

    case 'cancelled':

    case 'timed_out':
      return timeoutOutcome(copy, observed.status?.ok ? (observed.status.portal_url ?? opts.portalUrl) : opts.portalUrl)
  }
}

function statusFromRefusal(refusal: BillingRefusal): BillingChargeStatusResponse {
  const raw = isRecord(refusal.raw) ? refusal.raw : {}

  return {
    ...raw,
    error: refusal.kind,
    message: refusal.message,
    ok: false,
    ...(refusal.payload !== undefined ? { payload: refusal.payload } : {}),
    ...(refusal.portalUrl !== undefined ? { portal_url: refusal.portalUrl } : {}),
    ...(refusal.retryAfter !== undefined ? { retry_after: refusal.retryAfter } : {})
  } as BillingChargeStatusResponse
}

function refusalFromStatus(error: string, status: BillingChargeStatusResponse): BillingRefusal {
  return {
    kind: error,
    message: status.message || error,
    payload: status.payload,
    portalUrl: status.portal_url ?? undefined,
    retryAfter: status.retry_after ?? undefined
  }
}

export function useChargeFlow() {
  const api = useBillingApi()
  const copy = useBillingCopy()
  const queryClient = useQueryClient()
  const [phase, setPhase] = useState<ChargeFlowPhase>('idle')
  const [outcome, setOutcome] = useState<ChargeFlowOutcome | null>(null)
  const phaseRef = useRef<ChargeFlowPhase>('idle')

  const setPhaseState = useCallback((next: ChargeFlowPhase) => {
    phaseRef.current = next
    setPhase(next)
  }, [])

  // Clears what the row shows, never the open purchase (eng n1): retyping the amount is not a definite answer.
  const reset = useCallback(() => {
    setOutcome(null)
    setPhaseState('idle')
  }, [setPhaseState])

  const start = useCallback(
    async (amountUsd: string) => {
      if (phaseRef.current === 'charging' || phaseRef.current === 'polling') {
        return
      }

      // r3-n7: a purchase that lapsed with no definite answer is never dropped silently: this Buy is held (nothing
      // sent) and says "check the portal"; the next Buy is a new purchase.
      const lapsed = takeLapsedPurchase()

      if (lapsed) {
        setOutcome(lapsedOutcome(copy, lapsed))
        setPhaseState('done')

        return
      }

      // eng n1: the open purchase is a module store (open-purchase.ts) — it outlives this row, Billing and Settings.
      const open = currentOpenPurchase()

      if (open && !isSamePurchase(open, amountUsd)) {
        // Another amount while one purchase may already be charged: nothing is sent. Try again finishes the open one.
        setOutcome(heldOutcome(copy, open))
        setPhaseState('done')

        return
      }

      // The same purchase re-sends the amount exactly as first sent ("10" stays "10" even if the field now says 10.00).
      const sendAmount = open?.amountUsd ?? amountUsd
      const idempotencyKey = open?.idempotencyKey ?? crypto.randomUUID()

      // Open BEFORE the send (synchronous, so the owner's click still counts for the confirm): a Buy made while this one
      // is in flight — from a remounted row, another Billing view — joins it under the same key instead of minting one.
      openPurchase(sendAmount, idempotencyKey)
      setOutcome(null)
      setPhaseState('charging')

      const chargeResult = await api.charge(sendAmount, idempotencyKey)

      if (!chargeResult.ok) {
        const resolved = resolveRefusal(chargeResult.refusal, copy)

        const action =
          resolved.action.type === 'portal'
            ? ({ type: 'portal', url: resolved.action.url } as const)
            : resolved.action.type === 'retry'
              ? ({ type: 'retry' } as const)
              : resolved.action.type === 'step_up'
                ? ({ type: 'step_up' } as const)
                : undefined

        // One purchase intent = one idempotency key until a definite answer: a lost or unclear answer (and a refused
        // owner confirm, where nothing was sent) keeps the key, so a Retry of this buy can only collapse into the
        // first charge at the portal; only a definite refusal ends the intent and the next Buy mints a new key.
        // Only a definite refusal closes it; anything else leaves it open under its key.
        if (isDefiniteRefusal(chargeResult.refusal)) {
          closePurchase(idempotencyKey)
        }

        setOutcome({
          action,
          kind: 'failure',
          message: resolved.message,
          retryFreshKey: false,
          title: resolved.title
        })
        setPhaseState('done')

        return
      }

      // The portal accepted the charge (a definite answer): this purchase is closed; the next Buy is a new one.
      closePurchase(idempotencyKey)

      const chargeId = chargeResult.data.charge_id

      if (!chargeId) {
        setOutcome({
          kind: 'failure',
          message: copy.charge.untrackedMessage,
          retryFreshKey: true,
          title: copy.charge.untrackedTitle
        })
        setPhaseState('done')

        return
      }

      setPhaseState('polling')

      const pollOutcome = await pollChargeSettlement(api, chargeId, {
        copy,
        portalUrl: chargeResult.data.portal_url
      })

      setOutcome(pollOutcome)
      setPhaseState('done')

      if (pollOutcome.kind === 'success') {
        void queryClient.invalidateQueries({ queryKey: ['billing', 'state'] })
      }
    },
    [api, copy, queryClient, setPhaseState]
  )

  // r3-n4: with nothing of its own to show, the row shows the purchase still in doubt — after leaving Billing and coming
  // back, after a reload, after retyping — so the owner is told $10 may be charged, with Try again for that purchase.
  const open = useStore($openPurchase)
  const lapsed = useStore($lapsedPurchase)

  const shown: ChargeFlowOutcome | null =
    outcome ??
    (phase !== 'idle'
      ? null
      : isPurchaseLive(open)
        ? heldOutcome(copy, open)
        : open || lapsed
          ? lapsedOutcome(copy, (open ?? lapsed)!)
          : null)

  return { outcome: shown, phase, reset, start }
}

/** A purchase is open (no definite answer yet): Try again finishes THAT purchase, under its key. */
function heldOutcome(copy: BillingCopy, open: OpenPurchase): ChargeFlowOutcome {
  return {
    action: { type: 'retry' },
    kind: 'failure',
    message: copy.charge.openPurchase(formatMoney(open.amountUsd)),
    retryAmountUsd: open.amountUsd,
    retryFreshKey: false,
    title: copy.charge.unconfirmedTitle
  }
}

/** The open purchase outlived the window: no Try again (its key may no longer protect it), check the portal. */
function lapsedOutcome(copy: BillingCopy, lapsed: OpenPurchase): ChargeFlowOutcome {
  return {
    kind: 'ambiguous',
    message: copy.charge.lapsedPurchase(formatMoney(lapsed.amountUsd)),
    title: copy.charge.unconfirmedTitle
  }
}

/**
 * True when the answer is definite: the portal (or the app) answered a known business refusal that says the charge
 * was not made. A transport error, a timeout, a 5xx-class "try again" code, an unknown code and the owner-confirm
 * refusal (nothing reached the runtime, or the runtime refused before the portal) are NOT definite: the first request
 * may still have been charged (or none was sent), so the same intent keeps its key.
 */
export function isDefiniteRefusal(refusal: BillingRefusal): boolean {
  if (refusal.kind === OWNER_CONFIRM_REFUSAL || !Object.hasOwn(BILLING_REFUSAL_POLICY, refusal.kind)) {
    return false
  }

  const policy = refusalPolicy(refusal.kind)

  return policy.recovery !== 'retry' && policy.reuseIdempotencyKey !== true
}

function timeoutOutcome(copy: BillingCopy, portalUrl?: null | string): ChargeFlowOutcome {
  return {
    kind: 'ambiguous',
    message: copy.charge.slowMessage,
    portalUrl: portalUrl ?? undefined,
    title: copy.charge.slowTitle
  }
}

// The decline reason is a backend code: it picks the sentence and is never shown itself.
function renderChargeFailed(copy: BillingCopy, reason?: null | string): string {
  switch ((reason || '').trim()) {
    case 'authentication_required':
      return copy.charge.bankCheck

    case 'payment_method_expired':
      return copy.charge.expired

    case 'card_declined':
      return copy.charge.declined

    default:
      return copy.charge.failedGeneric
  }
}
