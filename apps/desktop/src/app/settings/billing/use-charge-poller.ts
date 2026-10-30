import { refusalPolicy } from '@hermes/shared/billing-policy'
import {
  driveChargeSettlement,
  SETTLEMENT_POLL_CAP_MS,
  SETTLEMENT_POLL_INTERVAL_MS
} from '@hermes/shared/charge-settlement'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useRef, useState } from 'react'

import { sleep as defaultSleep } from '@/iclone-shared/async'
import { isRecord } from '@/iclone-shared/guards'

import type { BillingApi, BillingRefusal } from './api'
import { useBillingApi } from './api'
import { formatMoney } from './billing-amounts'
import { type BillingCopy, useBillingCopy } from './copy'
import { resolveRefusal } from './errors'
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

interface PendingChargeIntent {
  amountUsd: string
  idempotencyKey: string
}

const retryableSendKinds = new Set([
  'endpoint_unavailable',
  'rate_limited',
  'temporarily_unavailable',
  'timeout',
  'transport'
])

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
  const retryIntentRef = useRef<PendingChargeIntent | null>(null)

  const setPhaseState = useCallback((next: ChargeFlowPhase) => {
    phaseRef.current = next
    setPhase(next)
  }, [])

  const reset = useCallback(() => {
    retryIntentRef.current = null
    setOutcome(null)
    setPhaseState('idle')
  }, [setPhaseState])

  const start = useCallback(
    async (amountUsd: string) => {
      if (phaseRef.current === 'charging' || phaseRef.current === 'polling') {
        return
      }

      const retryIntent = retryIntentRef.current
      const idempotencyKey = retryIntent?.amountUsd === amountUsd ? retryIntent.idempotencyKey : undefined

      setOutcome(null)
      setPhaseState('charging')

      const chargeResult = await api.charge(amountUsd, idempotencyKey)

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

        retryIntentRef.current = shouldReuseIdempotencyKey(chargeResult.refusal)
          ? { amountUsd, idempotencyKey: chargeResult.idempotencyKey }
          : null
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

      retryIntentRef.current = null

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

  return { outcome, phase, reset, start }
}

function shouldReuseIdempotencyKey(refusal: BillingRefusal): boolean {
  return retryableSendKinds.has(refusal.kind)
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
