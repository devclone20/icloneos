import { createContext, useContext, useMemo } from 'react'

import { useGatewayRequest } from '@/app/gateway/hooks/use-gateway-request'
import { isRecord } from '@/iclone-shared/guards'

import { authorizeAction, authorizeCharge, OWNER_CONFIRM_REFUSAL } from './owner-confirm'
import type {
  BillingChargeResponse,
  BillingChargeStatusResponse,
  BillingErrorPayload,
  BillingMutationResponse,
  BillingRefusalCode,
  BillingStateResponse,
  SubscriptionPreviewResponse,
  SubscriptionStateResponse
} from './types'

type BillingErrorKind = BillingRefusalCode

export interface BillingRefusal {
  actor?: string
  code?: string
  kind: BillingErrorKind | 'timeout' | 'transport'
  message: string
  payload?: BillingErrorPayload
  portalUrl?: string
  raw?: unknown
  recovery?: string
  retryAfter?: number
}

export type BillingResult<T> = { data: T; ok: true } | { ok: false; refusal: BillingRefusal }

type BillingChargeResult = BillingResult<BillingChargeResponse> & { idempotencyKey: string }

interface UpdateAutoReloadInput {
  enabled: boolean
  reload_to_usd?: string
  threshold_usd?: string
}

type BillingRequestGateway = <T>(
  method: string,
  params?: Record<string, unknown>,
  timeoutMs?: number,
  signal?: AbortSignal
) => Promise<T>

export interface BillingApi {
  charge: (amountUsd: string, idempotencyKey?: string) => Promise<BillingChargeResult>
  chargeStatus: (chargeId: string) => Promise<BillingResult<BillingChargeStatusResponse>>
  fetchBillingState: () => Promise<BillingResult<BillingStateResponse>>
  fetchSubscriptionState: () => Promise<BillingResult<SubscriptionStateResponse>>
  /** Chargeless quote for a plan change (POST /subscription/preview). */
  previewSubscriptionChange: (tierId: string) => Promise<BillingResult<SubscriptionPreviewResponse>>
  /** Clear a scheduled downgrade / cancellation — the undo (DELETE pending-change). */
  resumeSubscription: () => Promise<BillingResult<BillingMutationResponse>>
  /** Schedule a chargeless downgrade at period end (PUT pending-change). */
  scheduleSubscriptionChange: (tierId: string) => Promise<BillingResult<BillingMutationResponse>>
  stepUp: (sessionId?: string) => Promise<BillingResult<BillingMutationResponse>>
  updateAutoReload: (input: UpdateAutoReloadInput) => Promise<BillingResult<BillingMutationResponse>>
}

interface RefusalRecord {
  actor?: unknown
  code?: unknown
  error?: unknown
  kind?: unknown
  message?: unknown
  payload?: unknown
  portal_url?: unknown
  recovery?: unknown
  retry_after?: unknown
}

const asOptionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

const asOptionalNumber = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined)

const asPayload = (value: unknown): BillingErrorPayload | undefined =>
  isRecord(value) ? (value as BillingErrorPayload) : undefined

const getMessage = (value: unknown): string => {
  if (value instanceof Error && value.message) {
    return value.message
  }

  if (typeof value === 'string' && value.length > 0) {
    return value
  }

  return String(value || 'Billing request failed.')
}

const normalizeRefusal = (raw: Record<string, unknown>): BillingRefusal => {
  const rawError = raw.error
  const error = isRecord(rawError) ? (rawError as RefusalRecord) : undefined
  const kind = asOptionalString(error?.kind) ?? asOptionalString(error?.error) ?? asOptionalString(rawError) ?? 'error'
  const message = asOptionalString(error?.message) ?? asOptionalString(raw.message) ?? kind

  return {
    actor: asOptionalString(error?.actor) ?? asOptionalString(raw.actor),
    code: asOptionalString(error?.code) ?? asOptionalString(raw.code),
    kind,
    message,
    payload: asPayload(error?.payload) ?? asPayload(raw.payload),
    portalUrl: asOptionalString(error?.portal_url) ?? asOptionalString(raw.portal_url),
    raw,
    recovery: asOptionalString(error?.recovery) ?? asOptionalString(raw.recovery),
    retryAfter: asOptionalNumber(error?.retry_after) ?? asOptionalNumber(raw.retry_after)
  }
}

const normalizeThrown = (error: unknown): BillingRefusal => {
  const message = getMessage(error)
  const name = error instanceof Error ? error.name : ''

  return {
    kind: name === 'TimeoutError' || /timed?\s*out|timeout/i.test(message) ? 'timeout' : 'transport',
    message,
    raw: error
  }
}

const normalizeRpcResult = <T>(response: T): BillingResult<T> => {
  if (isRecord(response) && response.ok === false) {
    return { ok: false, refusal: normalizeRefusal(response) }
  }

  return { data: response, ok: true }
}

const callBilling = async <T>(
  requestGateway: BillingRequestGateway,
  method: string,
  params: Record<string, unknown> = {}
): Promise<BillingResult<T>> => {
  try {
    return normalizeRpcResult(await requestGateway<T>(method, params))
  } catch (error) {
    return { ok: false, refusal: normalizeThrown(error) }
  }
}

/**
 * A billing write that charges or arms a charge: the confirm is requested synchronously (before any await), bound to
 * (action, subject, key); the RPC carries `idempotency_key` + `owner_confirm`, and is never sent without the confirm.
 */
const confirmedBilling = async (
  requestGateway: BillingRequestGateway,
  action: string,
  subject: string,
  method: string,
  params: () => Record<string, unknown>
): Promise<BillingResult<BillingMutationResponse>> => {
  const idempotencyKey = crypto.randomUUID()
  const confirm = await authorizeAction(action, subject, idempotencyKey)

  if (!confirm.ok) {
    return { ok: false, refusal: { kind: OWNER_CONFIRM_REFUSAL, message: confirm.error } }
  }

  return callBilling<BillingMutationResponse>(requestGateway, method, {
    ...params(),
    idempotency_key: idempotencyKey,
    owner_confirm: confirm.ownerConfirm
  })
}

export const createBillingApi = (requestGateway: BillingRequestGateway): BillingApi => ({
  charge: async (amountUsd, idempotencyKey = crypto.randomUUID()) => {
    // F1-S: asked before the first await, so still inside the Buy / Retry click (useChargeFlow.start reaches here
    // synchronously). No owner confirm from main = no charge request at all.
    const confirm = await authorizeCharge(amountUsd, idempotencyKey)

    if (!confirm.ok) {
      return { ok: false, refusal: { kind: OWNER_CONFIRM_REFUSAL, message: confirm.error }, idempotencyKey }
    }

    const result = await callBilling<BillingChargeResponse>(requestGateway, 'billing.charge', {
      amount_usd: amountUsd,
      idempotency_key: idempotencyKey,
      // The runtime's check: main's single-use confirm for exactly this amount and key (gesture-locks-billing.ts).
      owner_confirm: confirm.ownerConfirm
    })

    return { ...result, idempotencyKey }
  },
  chargeStatus: chargeId =>
    callBilling<BillingChargeStatusResponse>(requestGateway, 'billing.charge_status', { charge_id: chargeId }),
  fetchBillingState: () => callBilling<BillingStateResponse>(requestGateway, 'billing.state'),
  fetchSubscriptionState: () => callBilling<SubscriptionStateResponse>(requestGateway, 'subscription.state'),
  previewSubscriptionChange: tierId =>
    callBilling<SubscriptionPreviewResponse>(requestGateway, 'subscription.preview', {
      subscription_type_id: tierId
    }),
  // v0.0.9 Q: each of these asks main for the owner confirm FIRST, synchronously (the caller is inside the click of a
  // `data-billing-charge-confirm` control); no confirm = no RPC.
  resumeSubscription: () =>
    confirmedBilling(requestGateway, 'subscription-resume', 'resume', 'subscription.resume', () => ({})),
  scheduleSubscriptionChange: tierId =>
    confirmedBilling(requestGateway, 'subscription-change', tierId, 'subscription.change', () => ({
      subscription_type_id: tierId
    })),
  stepUp: sessionId =>
    callBilling<BillingMutationResponse>(requestGateway, 'billing.step_up', {
      ...(sessionId !== undefined ? { session_id: sessionId } : {})
    }),
  updateAutoReload: input => {
    const params = {
      enabled: input.enabled,
      ...(input.threshold_usd !== undefined ? { threshold: input.threshold_usd } : {}),
      ...(input.reload_to_usd !== undefined ? { top_up_amount: input.reload_to_usd } : {})
    }

    // Turning it off charges nothing and needs no confirm.
    if (!input.enabled) {
      return callBilling<BillingMutationResponse>(requestGateway, 'billing.auto_reload', params)
    }

    return confirmedBilling(
      requestGateway,
      'auto-reload',
      `on|${input.threshold_usd}|${input.reload_to_usd}`,
      'billing.auto_reload',
      () => params
    )
  }
})

// An override for the gateway-backed api — DEV fixtures provide a simulated
// implementation here so every consumer (hooks, rows) transparently runs against it
// with no fixture awareness of their own. `null` (the default) = the real gateway api.
const BillingApiContext = createContext<BillingApi | null>(null)

export const BillingApiProvider = BillingApiContext.Provider

export function useBillingApi(): BillingApi {
  const override = useContext(BillingApiContext)
  const { requestGateway } = useGatewayRequest()
  const real = useMemo(() => createBillingApi(requestGateway), [requestGateway])

  return override ?? real
}
