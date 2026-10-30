/**
 * V3-J — the facilitator: one allowlisted URL per network, nothing else is ever fetched from this module. The
 * testnet facilitator is `https://x402.org/facilitator` (contract §0.1, read 2026-10-21: `exact` on `eip155:84532`);
 * mainnet has NONE at v0.0.3 (a CDP key never lives in the app; self-facilitation is a later decision), so a
 * mainnet payment cannot be verified or settled even if every other switch were on. Tests inject the stub's URL for
 * the testnet entry. `POST /verify` and `POST /settle` carry `{x402Version, paymentPayload, paymentRequirements}`
 * (`specs/x402-specification-v2.md` §facilitator); every call has a timeout and a bounded body.
 */
import {
  isSettleResponse,
  isVerifyResponse,
  type Network,
  type PaymentPayload,
  type PaymentRequirements,
  type SettleResponse,
  type VerifyResponse,
  X402_VERSION
} from './types'

export const FACILITATOR_URLS: Readonly<Partial<Record<Network, string>>> = Object.freeze({
  'eip155:84532': 'https://x402.org/facilitator'
})

const BODY_MAX = 64 * 1024
const DEFAULT_TIMEOUT_MS = 20_000

type FacilitatorError = 'no_facilitator' | 'http' | 'shape' | 'timeout'

type FacilitatorResult<T> = { ok: true; value: T } | { ok: false; error: FacilitatorError; detail: string }

export interface Facilitator {
  urlFor: (network: Network) => string | null
  verify: (payload: PaymentPayload, requirements: PaymentRequirements) => Promise<FacilitatorResult<VerifyResponse>>
  settle: (payload: PaymentPayload, requirements: PaymentRequirements) => Promise<FacilitatorResult<SettleResponse>>
}

interface FacilitatorDeps {
  /** The allowlist. Production passes `FACILITATOR_URLS`; tests the stub's URL. */
  urls: Readonly<Partial<Record<Network, string>>>
  fetch: typeof fetch
  timeoutMs?: number
}

export function createFacilitator(deps: FacilitatorDeps): Facilitator {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const urlFor = (network: Network): string | null => {
    const url = deps.urls[network]

    return typeof url === 'string' && /^https?:\/\//.test(url) ? url.replace(/\/$/, '') : null
  }

  const post = async <T>(
    route: 'verify' | 'settle',
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    guard: (value: unknown) => value is T
  ): Promise<FacilitatorResult<T>> => {
    const base = urlFor(requirements.network as Network)

    if (!base) {
      return { ok: false, error: 'no_facilitator', detail: `no facilitator for ${requirements.network}` }
    }

    let response: Response

    try {
      response = await deps.fetch(`${base}/${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ x402Version: X402_VERSION, paymentPayload: payload, paymentRequirements: requirements }),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')

      return {
        ok: false,
        error: timedOut ? 'timeout' : 'http',
        detail: error instanceof Error ? error.name : 'fetch failed'
      }
    }

    let text = ''

    try {
      text = await response.text()
    } catch {
      return { ok: false, error: 'http', detail: 'unreadable body' }
    }

    if (!response.ok) {
      return { ok: false, error: 'http', detail: `status ${response.status}` }
    }

    if (text.length > BODY_MAX) {
      return { ok: false, error: 'shape', detail: 'body too large' }
    }

    let parsed: unknown = null

    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }

    return guard(parsed)
      ? { ok: true, value: parsed }
      : { ok: false, error: 'shape', detail: `${route} response malformed` }
  }

  return {
    urlFor,
    verify: (payload, requirements) => post('verify', payload, requirements, isVerifyResponse),
    settle: (payload, requirements) => post('settle', payload, requirements, isSettleResponse)
  }
}
