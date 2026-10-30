/**
 * V3-J — the earn side: the iNFT's resource server. It builds a `PaymentRequired` for a resource with `payTo` = the
 * iNFT's wallet (the `acp wallet address`, injected), answers 402 + `PAYMENT-REQUIRED` to a bare request, and on a
 * request with `PAYMENT-SIGNATURE` checks the payload against ITS requirements (scheme, network, asset, payTo,
 * amount, the authorization's `to`/`value`/window), asks the facilitator `/verify`, serves, then `/settle` — exactly
 * once, with no retry loop anywhere in this file (J7): a `settlement_pending` or a timeout is a `pending` ledger
 * row with the transaction for the reconciler, never a second settle. It never signs anything (J8).
 *
 * Replay: an EIP-3009 authorization is single use on chain, but the chain only says so at `/settle`, after the resource
 * was served — and two presentations can race between `/verify` and `/settle`. So the server keeps its own set, in its
 * ledger: a payload whose nonce was already claimed is refused BEFORE `/verify`; after `/verify` answers, the nonce is
 * checked again and a `claim` row written in the same synchronous step, so of two racing presentations exactly one is
 * served and settled. A ledger that cannot take the claim serves nothing.
 *
 * Its clock is its ledger's (`ledger.now`), like the client's and the mandate store's: there is no `now` dep.
 *
 * `handle` never rejects (r3 I8: the host must never see a ledger throw). Before the claim, a ledger that cannot be
 * read or written serves nothing (402 `ledger unavailable`, audited); after `/settle` the honest answer stands and a
 * row the ledger cannot take is an audited `gap`; anything else that throws is a 503 with nothing in the body and an
 * audited `gap` — never a resource served unpaid, never a second settle.
 *
 * Transport-agnostic: `handle` takes `{url, headers}` and returns `{status, headers, body}`; the test harness wraps
 * it in `node:http`. Bodies carry no protocol data (`specs/transports-v2/http.md`).
 */
import type { PaymentAuditEntry } from './client'
import type { Facilitator } from './facilitator'
import type { PaymentLedger } from './ledger'
import {
  base64Json,
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  isPaymentPayload,
  microsOf,
  type Network,
  NETWORK_INFO,
  normalizeAddress,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  X402_VERSION
} from './types'

interface X402ServerDeps {
  network: Network
  /** The iNFT's wallet: `acp wallet address`. */
  payTo: string
  facilitator: Facilitator
  ledger: PaymentLedger
  /** The price of a resource in micro-USDC, or null when it is not for sale (→ 404). */
  priceOf: (url: string) => number | null
  /** The resource itself, once paid for. */
  serve: (url: string) => Promise<{ body: string; mimeType: string }>
  maxTimeoutSeconds?: number
  /** V3-F's audit (`recordPayment` in main): a ledger the server cannot read or write, or a throw, is never silent. */
  audit?: { record: (entry: PaymentAuditEntry) => unknown } | null
}

interface ServerRequest {
  url: string
  headers: Record<string, string | undefined>
}

interface ServerResponse {
  status: number
  headers: Record<string, string>
  body: string
}

export interface X402Server {
  requirementsFor: (url: string) => PaymentRequired | null
  handle: (request: ServerRequest) => Promise<ServerResponse>
}

const MIN_WINDOW_SECONDS = 6

export function createX402Server(deps: X402ServerDeps): X402Server {
  // ONE clock: the earn ledger's (merge round). The server has none of its own, so the window it checks an
  // authorization against and the rows it writes read the same source.
  const now = () => deps.ledger.now()
  const payTo = normalizeAddress(deps.payTo)
  const info = NETWORK_INFO[deps.network]
  const maxTimeoutSeconds = deps.maxTimeoutSeconds ?? 60

  if (!payTo) {
    throw new Error('x402 server: payTo is not an address')
  }

  const requirementsFor = (url: string): PaymentRequired | null => {
    const price = deps.priceOf(url)

    if (price === null) {
      return null
    }

    return {
      x402Version: X402_VERSION,
      resource: { url },
      accepts: [
        {
          scheme: 'exact',
          network: deps.network,
          amount: String(price),
          asset: info.usdc,
          payTo,
          maxTimeoutSeconds,
          extra: { name: info.eip712.name, version: info.eip712.version }
        }
      ]
    }
  }

  /** The audit sink is injected: its own failure never decides an answer. */
  const audit = (kind: PaymentAuditEntry['kind'], reason: string): void => {
    try {
      deps.audit?.record({ kind, reason, agent: '' })
    } catch {
      // the sink's failure is not the request's
    }
  }

  /** Every ledger write goes through here: a throw is a failed write (null), never a rejection of `handle`. */
  const write = (entry: Parameters<PaymentLedger['append']>[0]) => {
    try {
      return deps.ledger.append(entry)
    } catch {
      return null
    }
  }

  /**
   * The nonces this server already took: `claim` and `earned` rows, and its own (agent-less) pending/failed rows.
   * Null when the ledger cannot be read: the caller serves nothing.
   */
  const claimed = (nonce: string): boolean | null => {
    let records: ReturnType<PaymentLedger['read']>['records']

    try {
      records = deps.ledger.read().records
    } catch {
      return null
    }

    return records.some(
      row =>
        row.nonce !== null &&
        row.nonce.toLowerCase() === nonce &&
        (row.kind === 'claim' ||
          row.kind === 'earned' ||
          ((row.kind === 'pending' || row.kind === 'failed') && row.agent === null))
    )
  }

  const unavailable = (spec: PaymentRequired): ServerResponse => {
    audit('refuse', 'ledger')

    return required(spec, 'ledger unavailable')
  }

  const replayed = (url: string, spec: PaymentRequired): ServerResponse => {
    write({
      kind: 'failed',
      resource: url,
      network: deps.network,
      note: 'earn refused: nonce already used'
    })

    return required(spec, 'nonce already used')
  }

  /** A row after `/settle`: the answer stands (money may have moved); a row the ledger cannot take is an audited gap. */
  const outcome = (entry: Parameters<PaymentLedger['append']>[0]): void => {
    if (!write(entry)) {
      audit('gap', 'ledger_write_failed')
    }
  }

  const required = (required: PaymentRequired, error?: string): ServerResponse => ({
    status: 402,
    headers: { [HEADER_PAYMENT_REQUIRED]: base64Json.encode(error ? { ...required, error } : required) },
    body: ''
  })

  /** The payload against our requirements: what the facilitator does not know to check. */
  const matches = (payload: PaymentPayload, requirements: PaymentRequirements, url: string): string | null => {
    const accepted = payload.accepted
    const auth = payload.payload.authorization
    const seconds = Math.floor(now().getTime() / 1000)

    if (payload.x402Version !== X402_VERSION) {
      return 'unsupported_version'
    }

    if (payload.resource && payload.resource.url !== url) {
      return 'resource mismatch'
    }

    if (accepted.scheme !== requirements.scheme || accepted.network !== requirements.network) {
      return 'scheme or network mismatch'
    }

    if (
      normalizeAddress(accepted.asset) !== requirements.asset ||
      normalizeAddress(accepted.payTo) !== requirements.payTo
    ) {
      return 'asset or payTo mismatch'
    }

    if (normalizeAddress(auth.to) !== requirements.payTo) {
      return 'authorization.to is not payTo'
    }

    const value = microsOf(auth.value)
    const price = microsOf(requirements.amount) as number

    if (value === null || value < price || microsOf(accepted.amount) !== value) {
      return 'amount below price'
    }

    if (Number(auth.validAfter) > seconds || Number(auth.validBefore) < seconds + MIN_WINDOW_SECONDS) {
      return 'authorization window'
    }

    return null
  }

  const handle = async (request: ServerRequest): Promise<ServerResponse> => {
    try {
      return await handleChecked(request)
    } catch {
      // Nothing in the body: a throw before the claim served nothing; one after it (serve, the facilitator) settled
      // nothing that this answer could report. The claim row keeps the nonce from being presented again.
      audit('gap', 'earn_internal')

      return { status: 503, headers: {}, body: '' }
    }
  }

  const handleChecked = async (request: ServerRequest): Promise<ServerResponse> => {
    const header = (name: string) => request.headers[name] ?? request.headers[name.toUpperCase()]
    const spec = requirementsFor(request.url)

    if (!spec) {
      return { status: 404, headers: {}, body: '' }
    }

    const requirements = spec.accepts[0]
    const signature = header(HEADER_PAYMENT_SIGNATURE)

    if (signature === undefined) {
      return required(spec)
    }

    const payload = base64Json.decode(signature)

    if (!isPaymentPayload(payload)) {
      return required(spec, 'payload malformed')
    }

    const mismatch = matches(payload, requirements, request.url)

    if (mismatch) {
      write({
        kind: 'failed',
        resource: request.url,
        network: deps.network,
        note: `earn refused: ${mismatch}`
      })

      return required(spec, mismatch)
    }

    const nonce = payload.payload.authorization.nonce.toLowerCase()

    const seen = claimed(nonce)

    if (seen === null) {
      return unavailable(spec)
    }

    if (seen) {
      return replayed(request.url, spec)
    }

    const verified = await deps.facilitator.verify(payload, requirements)

    if (!verified.ok || !verified.value.isValid) {
      const why = verified.ok ? (verified.value.invalidReason ?? 'invalid') : `${verified.error}: ${verified.detail}`

      write({ kind: 'failed', resource: request.url, network: deps.network, note: `verify: ${why}` })

      return required(spec, why)
    }

    const micros = microsOf(payload.payload.authorization.value)
    const base = { resource: request.url, network: deps.network, micros, nonce }

    // Re-checked after the await, claimed in the same synchronous step: a racing twin sees this row.
    const again = claimed(nonce)

    if (again === null) {
      return unavailable(spec)
    }

    if (again) {
      return replayed(request.url, spec)
    }

    if (!write({ kind: 'claim', ...base })) {
      return unavailable(spec)
    }

    const resource = await deps.serve(request.url)
    const settled = await deps.facilitator.settle(payload, requirements)

    if (!settled.ok) {
      outcome({ kind: 'pending', ...base, note: `settle ${settled.error}: ${settled.detail}` })

      return {
        status: 200,
        headers: {
          'content-type': resource.mimeType,
          [HEADER_PAYMENT_RESPONSE]: base64Json.encode({
            success: false,
            errorReason: 'settlement_pending',
            transaction: '',
            network: deps.network
          })
        },
        body: resource.body
      }
    }

    const settlement = settled.value

    const kind = settlement.success ? 'earned' : settlement.errorReason === 'settlement_pending' ? 'pending' : 'failed'

    outcome({ kind, ...base, transaction: settlement.transaction || null, note: settlement.errorReason ?? null })

    return {
      status: 200,
      headers: { 'content-type': resource.mimeType, [HEADER_PAYMENT_RESPONSE]: base64Json.encode(settlement) },
      body: resource.body
    }
  }

  return { requirementsFor, handle }
}
