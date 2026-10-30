/**
 * V3-J — the x402 v2 shapes the client and the server speak, pinned to `coinbase/x402` main @ 0e6e8c5
 * (`specs/x402-specification-v2.md`, `specs/transports-v2/http.md`, `specs/schemes/exact/scheme_exact_evm.md`).
 * Amounts are integer micro-USDC (the token's atomic unit: USDC has 6 decimals), never floats. Only the `exact`
 * scheme on an EVM network is implemented; Permit2 and `upto` are out of scope at v0.0.3 (contract §0.1).
 *
 * Nothing here touches the network or a key: this file is the vocabulary the pure modules share.
 */

/** CAIP-2 networks the app knows. Mainnet exists in the vocabulary so a setting can name it; the lab never pays on it. */
const NETWORKS = ['eip155:84532', 'eip155:8453'] as const
export type Network = (typeof NETWORKS)[number]

export const isNetwork = (value: unknown): value is Network => (NETWORKS as readonly unknown[]).includes(value)

/**
 * Identity fields are compared by equality (the per-agent-day cap folds `signed` rows by `agent`; a mandate's budget
 * and single use fold `mandate_use` rows by `mandate` and `transactionId`), so they are validated where they enter and
 * stored raw — never passed through a secret redactor, which rewrites legal values (a slug like `sk-trader-bot-alpha`
 * or a Luhn-valid `4111111111111111`) and would let that agent escape its own cap.
 * An agent is an iNFT profile slug: the app's `PROFILE_NAME_RE` (`electron/main/env.ts`), which also names its key file.
 */
const AGENT_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
export const isAgentSlug = (value: unknown): value is string => typeof value === 'string' && AGENT_SLUG_RE.test(value)

/** An open mandate's `jti` and a closed one's `transaction_id`: 16 random bytes, lowercase hex. */
const ID_HEX_RE = /^[0-9a-f]{32}$/
export const isMandateId = (value: unknown): value is string => typeof value === 'string' && ID_HEX_RE.test(value)

interface NetworkInfo {
  chainId: number
  /** The USDC contract on that network (lowercase). */
  usdc: string
  /**
   * The token's EIP-712 domain the earn server puts on the wire as `extra.name` / `extra.version` — the contract's own
   * `name()` / `version()`: Base Sepolia USDC is "USDC" / "2", Base mainnet USDC is "USD Coin" / "2" (the SDK's table).
   */
  eip712: { name: string; version: string }
  label: string
}

export const NETWORK_INFO: Record<Network, NetworkInfo> = {
  'eip155:84532': {
    chainId: 84532,
    usdc: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
    eip712: { name: 'USDC', version: '2' },
    label: 'Base Sepolia'
  },
  'eip155:8453': {
    chainId: 8453,
    usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    eip712: { name: 'USD Coin', version: '2' },
    label: 'Base'
  }
}

/** Transport headers (`specs/transports-v2/http.md`). The v1 header is named so the client can refuse it by name. */
export const HEADER_PAYMENT_REQUIRED = 'payment-required'
export const HEADER_PAYMENT_SIGNATURE = 'payment-signature'
export const HEADER_PAYMENT_RESPONSE = 'payment-response'
export const HEADER_V1_PAYMENT = 'x-payment'

export const X402_VERSION = 2

export interface PaymentRequirements {
  scheme: string
  network: string
  /** Atomic units as a decimal string. */
  amount: string
  asset: string
  payTo: string
  maxTimeoutSeconds: number
  extra?: Record<string, unknown>
}

export interface PaymentRequired {
  x402Version: number
  error?: string
  resource: { url: string; description?: string; mimeType?: string }
  accepts: PaymentRequirements[]
  extensions?: Record<string, unknown>
}

export interface ExactEvmAuthorization {
  from: string
  to: string
  /** Atomic units as a decimal string. */
  value: string
  validAfter: string
  validBefore: string
  /** 32 bytes, 0x-hex. */
  nonce: string
}

interface ExactEvmPayload {
  signature: string
  authorization: ExactEvmAuthorization
}

export interface PaymentPayload {
  x402Version: number
  resource?: { url: string }
  accepted: PaymentRequirements
  payload: ExactEvmPayload
  extensions?: Record<string, unknown>
}

export interface VerifyResponse {
  isValid: boolean
  invalidReason?: string
  payer?: string
}

export interface SettleResponse {
  success: boolean
  errorReason?: string
  payer?: string
  transaction: string
  network: string
  amount?: string
}

const MICROS_RE = /^(0|[1-9]\d*)$/

/** A decimal atomic-unit string → micro-USDC, or null for anything that is not a safe non-negative integer. */
export function microsOf(atomic: unknown): number | null {
  if (typeof atomic !== 'string' || !MICROS_RE.test(atomic)) {
    return null
  }

  const value = Number(atomic)

  return Number.isSafeInteger(value) ? value : null
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

/** An EVM address in its comparable form (lowercase), or null. Checksum casing is a display matter, not identity. */
export function normalizeAddress(value: unknown): string | null {
  return typeof value === 'string' && ADDRESS_RE.test(value) ? value.toLowerCase() : null
}

/**
 * The URL exactly as it is fetched (WHATWG: tabs and line breaks stripped, the path percent-encoded, the host
 * lowercased / punycoded): the one string the ledger records, the sheet shows and `fetch` asks for (fix JM3). Input
 * that does not parse is returned as given; it is refused as `origin` before any sheet.
 */
export function canonicalUrl(value: string): string {
  try {
    return new URL(value).href
  } catch {
    return value
  }
}

/** A URL's origin (`scheme://host[:port]`), or null for anything that is not an absolute http(s) URL. */
export function originOf(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  try {
    const url = new URL(value)

    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null
  } catch {
    return null
  }
}

export const base64Json = {
  encode: (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64'),
  decode: (text: unknown, maxBytes = 64 * 1024): unknown => {
    if (typeof text !== 'string' || text.length === 0 || text.length > maxBytes * 2) {
      return null
    }

    try {
      const bytes = Buffer.from(text, 'base64')

      return bytes.length > maxBytes ? null : (JSON.parse(bytes.toString('utf8')) as unknown)
    } catch {
      return null
    }
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0

export function isPaymentRequirements(value: unknown): value is PaymentRequirements {
  return (
    isObject(value) &&
    isString(value.scheme) &&
    isString(value.network) &&
    microsOf(value.amount) !== null &&
    normalizeAddress(value.asset) !== null &&
    normalizeAddress(value.payTo) !== null &&
    Number.isSafeInteger(value.maxTimeoutSeconds) &&
    (value.maxTimeoutSeconds as number) > 0 &&
    (value.extra === undefined || isObject(value.extra))
  )
}

export function isPaymentRequired(value: unknown): value is PaymentRequired {
  return (
    isObject(value) &&
    Number.isSafeInteger(value.x402Version) &&
    isObject(value.resource) &&
    isString(value.resource.url) &&
    Array.isArray(value.accepts) &&
    value.accepts.every(isPaymentRequirements)
  )
}

function isExactEvmPayload(value: unknown): value is ExactEvmPayload {
  if (!isObject(value) || !isString(value.signature) || !isObject(value.authorization)) {
    return false
  }

  const auth = value.authorization

  return (
    normalizeAddress(auth.from) !== null &&
    normalizeAddress(auth.to) !== null &&
    microsOf(auth.value) !== null &&
    typeof auth.validAfter === 'string' &&
    /^\d+$/.test(auth.validAfter) &&
    typeof auth.validBefore === 'string' &&
    /^\d+$/.test(auth.validBefore) &&
    typeof auth.nonce === 'string' &&
    /^0x[0-9a-fA-F]{64}$/.test(auth.nonce)
  )
}

export function isPaymentPayload(value: unknown): value is PaymentPayload {
  return (
    isObject(value) &&
    Number.isSafeInteger(value.x402Version) &&
    isPaymentRequirements(value.accepted) &&
    isExactEvmPayload(value.payload) &&
    (value.resource === undefined || (isObject(value.resource) && isString(value.resource.url)))
  )
}

export function isSettleResponse(value: unknown): value is SettleResponse {
  return (
    isObject(value) &&
    typeof value.success === 'boolean' &&
    typeof value.transaction === 'string' &&
    typeof value.network === 'string'
  )
}

export function isVerifyResponse(value: unknown): value is VerifyResponse {
  return isObject(value) && typeof value.isValid === 'boolean'
}
