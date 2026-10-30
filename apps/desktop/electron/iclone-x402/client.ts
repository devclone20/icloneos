/**
 * V3-J — the pay side, behind ONE interface (`pay`), main-process only. The order is the contract's (§1.1) and every
 * step fails closed:
 *   origin allowlist (before any network call) → GET with redirects refused → a 402 must carry `PAYMENT-REQUIRED`
 *   (RFC 9110 reserves the code: a bare 402 is not x402) → x402 v2 only (a v1 `X-PAYMENT` server is audited
 *   `unsupported_version` and never paid, D5) → the `accepts` entry on the user's network and USDC → the limits
 *   (`limits.ts`, folded from the ledger) → the mandate (closed with the iNFT's cnf key and verified, `mandates.ts`)
 *   → V3-F's `$` door (injected; no door ⇒ refuse) → the pocket signer → `signed` row BEFORE the signature leaves
 *   (the spend that counts) → retry with `PAYMENT-SIGNATURE` → `PAYMENT-RESPONSE` → `settled` / `pending` / `failed`.
 * The ceilings are atomic across the door: evaluate → door → `signed` runs under one in-process queue per (agent,
 * UTC day), and after the door answers every ceiling, the mandate budget, STOP and the signer setting are checked
 * AGAIN against the ledger in the same synchronous step that writes the `signed` row (no await in between), so a
 * concurrent request — same agent (queued behind it) or another agent (its own sheet) — sees the pending spend.
 * There is no retry loop: one request, one signature, one retry. A second 402 on the retry is `failed`, not paid
 * again (J7); a timeout after the signature is `pending` with the nonce for the reconciler, never re-signed.
 *
 * STOP is level- AND edge-triggered: while it is on everything is refused, and a request that was in flight when a
 * stop was pulled (a `stop` row after the ledger mark it took when it began) is refused even if the owner cleared the
 * stop before its sheet answered — the stop applies to everything that was moving when it was pulled.
 *
 * Every refusal is a ledger row with the rule and goes to the injected audit sink (`recordPayment` at the merge,
 * `src:"payment"`), so J2 / J3 count rows, not log lines. `pay()` never rejects: a ledger that throws is a failed
 * write or an unreadable total (refused `ledger`, audited even when no row can be written), anything else that throws
 * before the signature is refused `internal`, and after the `signed` row the honest outcome stands and a row the
 * ledger cannot take is an audited `gap` (I1).
 */
import type { Facilitator } from './facilitator'
import { nonceHex } from './keys'
import type { PaymentLedger, RefuseReason } from './ledger'
import { allowedNetwork, evaluatePayment, type LimitsLedgerView, type PaymentSettings } from './limits'
import type { MandateStore, MandateUsage, VerifiedMandate } from './mandates'
import type { Eip712Domain } from './signer'
import { domainFor, type PaymentSigner } from './signer'
import {
  base64Json,
  canonicalUrl,
  type ExactEvmAuthorization,
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  HEADER_V1_PAYMENT,
  isAgentSlug,
  isMandateId,
  isPaymentRequired,
  isSettleResponse,
  microsOf,
  type Network,
  NETWORK_INFO,
  normalizeAddress,
  originOf,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  X402_VERSION
} from './types'

/** V3-F's audit, one function: `recordPayment(entry)` at the merge. `use` = money moved; `refuse` = a rule said no. */
export interface PaymentAuditEntry {
  kind: 'gap' | 'refuse' | 'timeout' | 'use'
  reason: string
  agent: string
}

export interface PaymentAuditSink {
  record: (entry: PaymentAuditEntry) => unknown
}

/** V3-F's `$` door (floor 5: always a question). The sheet gets the mandate in plain words; `true` only on a trusted gesture. */
interface SpendDoorRequest {
  agent: string
  resource: string
  payTo: string
  micros: number
  network: string
  mandate: VerifiedMandate
  /** micro-USDC this open mandate already closed before this payment (the sheet shows the budget left). */
  usedMicros: number
}

export type SpendDoor = (request: SpendDoorRequest) => Promise<boolean>

interface PayRequest {
  url: string
  agent: string
  /** The open mandate's `jti`. None ⇒ refused `no_mandate`. */
  mandate: string | null
  /** The agent's own cap for this call (`--max`): refused above it, never widened by it. */
  maxMicros?: number
}

/** `x402-pay send <payee> <usdc>`: a person-to-person transfer to an allowlisted payee, under a mandate. */
interface SendRequest {
  agent: string
  payTo: string
  micros: number
  mandate: string | null
}

export type PayResult =
  | { kind: 'passthrough'; status: number; body: string }
  | { kind: 'refused'; reason: RefuseReason; detail: string }
  | { kind: 'paid'; status: number; body: string; micros: number; transaction: string }
  | { kind: 'pending'; micros: number; nonce: string; detail: string }
  | { kind: 'failed'; micros: number; nonce: string; detail: string }

interface X402ClientDeps {
  settings: () => PaymentSettings
  stopped: () => boolean
  ledger: PaymentLedger
  mandates: MandateStore
  signer: PaymentSigner
  door: SpendDoor | null
  audit: PaymentAuditSink | null
  fetch: typeof fetch
  timeoutMs?: number
  /** The door's own deadline: no answer by then is a no (V3-F's sheet times out at 2 min; this is the backstop). */
  doorTimeoutMs?: number
  /**
   * The allowlisted facilitator (`facilitator.ts`, one URL per network): a p2p send has no resource server, so the
   * signed EIP-3009 authorization is verified and settled there — the only host a send ever reaches. None ⇒ no send.
   */
  facilitator?: Facilitator | null
  /** A `pending` row's hook: the reconciler reads the chain by nonce; this module never resigns. */
  onPending?: (row: { nonce: string; micros: number; resource: string }) => void
}

export interface X402Client {
  pay: (request: PayRequest) => Promise<PayResult>
  /** p2p: the same gates as `pay` (limits, mandate, `$` door, `signed` row first), settled by the facilitator. */
  send: (request: SendRequest) => Promise<PayResult>
}

const BODY_MAX = 4 * 1024 * 1024
const MAX_VALID_SECONDS = 600
const DOOR_TIMEOUT_MS = 120_000
const SIGNER_UNAVAILABLE = 'the AgentCard signer is not available in this build (Settings › Economy › Payments)'
/** A p2p authorization's life: long enough for the facilitator to settle it, never longer than a paid request's. */
const P2P_VALID_SECONDS = 300
/** The resource a p2p send is recorded under: there is none, so the ledger names the payee. */
const P2P_PREFIX = 'p2p:'

/** One payment between the 402 and the `signed` row: what every gate is checked against, before and after the door. */
interface Attempt {
  request: PayRequest
  origin: string
  requirements: PaymentRequirements
  domain: Eip712Domain
  micros: number
  payTo: string
  network: Network
  row: { micros: number; payTo: string; network: Network }
  /** The ledger's last seq when this request began (null: unreadable). A `stop` row after it refuses (edge). */
  stopMark: number | null
  /** A p2p send: no resource, so no origin rule; `origin` is the facilitator's (the closed mandate's audience). */
  p2p?: true
}

type Refusal = { ok: false; reason: RefuseReason; detail: string; extra: Record<string, unknown> }

/** The request a refusal names before its identity is checked: nobody, no mandate, no resource. */
const ANONYMOUS: PayRequest = Object.freeze({ url: '', agent: '', mandate: null })

const refusal = (reason: RefuseReason, detail: string, extra: Record<string, unknown> = {}): Refusal => ({
  ok: false,
  reason,
  detail,
  extra
})

/** The mandate's usage folded from the ledger, or null when the ledger cannot be read (the caller refuses `ledger`). */
const usageOf = (ledger: PaymentLedger, jti: string): MandateUsage | null => {
  const ids = new Set<string>()
  let usedMicros = 0
  let records: ReturnType<PaymentLedger['read']>['records']

  try {
    records = ledger.read().records
  } catch {
    return null
  }

  for (const row of records) {
    if (row.kind === 'mandate_use' && row.transactionId) {
      ids.add(row.transactionId)

      if (row.mandate === jti && row.micros !== null) {
        usedMicros += row.micros
      }
    }
  }

  return { usedMicros, usedTransactionIds: ids }
}

export function createX402Client(deps: X402ClientDeps): X402Client {
  // ONE clock: the ledger's. The client cannot be given another, so a check and its row never read two clocks.
  const now = () => deps.ledger.now()

  /** The audit sink is injected: a throw there never decides a payment (the ledger row is the record). */
  const audit = (entry: PaymentAuditEntry): void => {
    try {
      deps.audit?.record(entry)
    } catch {
      // nothing to do: the sink's own failure is not the payment's
    }
  }

  /**
   * The ledger is injected (the merge bridges it into V3-I's WORK ledger): a throw is a failed write — null, which every
   * caller before the signature already turns into a refusal — and never a rejection of `pay()` (I1).
   */
  const write = (entry: Parameters<PaymentLedger['append']>[0], at?: Date) => {
    try {
      return deps.ledger.append(entry, at)
    } catch {
      return null
    }
  }

  /** A row after the signature: the outcome stands (money may have moved); a row the ledger cannot take is an audited gap. */
  const outcome = (entry: Parameters<PaymentLedger['append']>[0], agent: string): void => {
    if (!write(entry)) {
      audit({ kind: 'gap', reason: 'ledger_write_failed', agent })
    }
  }

  const timeoutMs = deps.timeoutMs ?? 30_000
  const doorTimeoutMs = deps.doorTimeoutMs ?? DOOR_TIMEOUT_MS
  const inFlight = new Set<string>()
  const queues = new Map<string, Promise<void>>()

  /** One at a time per key: the next task starts when the previous one wrote its `signed` row or refused. */
  const serialized = async <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const previous = queues.get(key) ?? Promise.resolve()

    let release = () => {}

    const current = new Promise<void>(resolve => {
      release = resolve
    })

    const tail = previous.then(() => current)

    queues.set(key, tail)
    await previous

    try {
      return await task()
    } finally {
      release()

      if (queues.get(key) === tail) {
        queues.delete(key)
      }
    }
  }

  const askDoor = async (door: SpendDoor, request: SpendDoorRequest): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined

    const deadline = new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(false), doorTimeoutMs)
      timer.unref?.()
    })

    try {
      return await Promise.race([door(request).then(answer => answer === true), deadline])
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  const refuse = (
    request: PayRequest,
    reason: RefuseReason,
    detail: string,
    extra: Record<string, unknown> = {}
  ): PayResult => {
    // The row when the ledger can take it; the audit sink always (a refusal is never silent).
    write({
      kind: 'refuse',
      agent: request.agent || null,
      resource: request.url,
      rule: reason,
      note: detail,
      ...extra
    })
    audit({ kind: 'refuse', reason, agent: request.agent })

    return { kind: 'refused', reason, detail }
  }

  const get = async (url: string, headers: Record<string, string>): Promise<Response | 'timeout' | 'error'> => {
    try {
      return await deps.fetch(url, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch (error) {
      return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
        ? 'timeout'
        : 'error'
    }
  }

  const bodyOf = async (response: Response): Promise<string> => {
    try {
      const text = await response.text()

      return text.length > BODY_MAX ? text.slice(0, BODY_MAX) : text
    } catch {
      return ''
    }
  }

  const pick = (required: PaymentRequired, settings: PaymentSettings): PaymentRequirements | null => {
    const network = allowedNetwork(settings)

    if (!network) {
      return null
    }

    const usdc = NETWORK_INFO[network].usdc

    return (
      required.accepts.find(
        entry => entry.scheme === 'exact' && entry.network === network && normalizeAddress(entry.asset) === usdc
      ) ?? null
    )
  }

  const pay = async (request: PayRequest): Promise<PayResult> => {
    // Until the identity is checked, a refusal names nobody: no agent, no mandate, no resource (r3 n2).
    let named: PayRequest = ANONYMOUS

    // Everything, the entry checks included, sits behind the backstop: `pay(null)`, a request whose fields throw on
    // read, or any other throw before the signature is a refusal with a row and an audit entry — `pay()` never
    // rejects. Every ledger read and write below is guarded, and `send` (after the signature) catches its own.
    try {
      // One read of each field, into a plain object: a getter cannot answer one value to a check and another later.
      const raw: Partial<Record<keyof PayRequest, unknown>> =
        typeof request === 'object' && request !== null ? request : {}

      const snapshot = { url: raw.url, agent: raw.agent, mandate: raw.mandate, maxMicros: raw.maxMicros }
      // The canonical URL from here on (fix JM3): what the sheet shows is the string that is fetched and recorded, so a
      // line break or a control character the agent put in its argument can never become a line of the owner's sheet.
      const url = typeof snapshot.url === 'string' ? canonicalUrl(snapshot.url) : ''

      // A `--max` that is not a number stays not-a-number, so the per-call cap refuses it (never read as "no cap").
      const maxMicros =
        snapshot.maxMicros === undefined ? undefined : typeof snapshot.maxMicros === 'number' ? snapshot.maxMicros : NaN

      // Identity first: every row below carries the agent and the mandate id raw, and the caps compare them by
      // equality. A name that is not a profile slug is refused here, with neither field written (they are not names).
      if (!isAgentSlug(snapshot.agent)) {
        return refuse({ ...ANONYMOUS, url }, 'agent', 'agent is not a profile slug')
      }

      if (snapshot.mandate !== null && !isMandateId(snapshot.mandate)) {
        return refuse({ ...ANONYMOUS, url, agent: snapshot.agent }, 'mandate_invalid', 'mandate id is not an id')
      }

      named = { url, agent: snapshot.agent, mandate: snapshot.mandate, maxMicros }

      return await payChecked(named)
    } catch {
      return refuse(named, 'internal', 'internal error before any signature')
    }
  }

  const payChecked = async (request: PayRequest): Promise<PayResult> => {
    // STOP is edge-triggered (merge round, critic I3): a stop pulled at any moment after this request began refuses
    // it, even when the owner cleared the stop again before the sheet answered. The mark is read before the level check.
    const stopMark = lastSeq()
    const settings = deps.settings()
    const origin = originOf(request.url)
    const key = `${request.agent}\n${request.url}`

    if (settings.stop || deps.stopped()) {
      return refuse(request, 'stop', 'hard stop')
    }

    // D1 is a per-user setting, but only the pocket signs in this build: another choice is refused before any
    // network, never silently pocket-signed.
    if (settings.signer !== 'pocket') {
      return refuse(request, 'signer_unavailable', SIGNER_UNAVAILABLE)
    }

    if (!origin || !settings.origins.includes(origin)) {
      return refuse(request, 'origin', `${origin ?? 'not a URL'} not allowlisted`)
    }

    if (inFlight.has(key)) {
      return refuse(request, 'duplicate', 'a payment for this resource is in flight')
    }

    inFlight.add(key)

    try {
      return await payOnce(request, settings, origin, stopMark)
    } finally {
      inFlight.delete(key)
    }
  }

  const payOnce = async (
    request: PayRequest,
    settings: PaymentSettings,
    origin: string,
    stopMark: number | null
  ): Promise<PayResult> => {
    const first = await get(request.url, { accept: '*/*' })

    if (first === 'timeout' || first === 'error') {
      return { kind: 'passthrough', status: 0, body: '' }
    }

    if (first.status >= 300 && first.status < 400) {
      return refuse(request, 'cross_origin_redirect', `redirect ${first.status} refused`)
    }

    if (first.status !== 402) {
      return { kind: 'passthrough', status: first.status, body: await bodyOf(first) }
    }

    const header = first.headers.get(HEADER_PAYMENT_REQUIRED)

    if (!header) {
      return refuse(
        request,
        'not_x402',
        first.headers.has(HEADER_V1_PAYMENT) ? 'v1 header' : 'bare 402 without PAYMENT-REQUIRED'
      )
    }

    const required = base64Json.decode(header)

    if (!isPaymentRequired(required)) {
      return refuse(request, 'payload', 'PAYMENT-REQUIRED malformed')
    }

    if (required.x402Version !== X402_VERSION) {
      const handoff = settings.v1Servers === 'agentcard' ? '; hand-off: agentcard wallet fetch' : ''

      return refuse(request, 'unsupported_version', `x402Version ${required.x402Version}${handoff}`)
    }

    if (originOf(required.resource.url) !== origin) {
      return refuse(request, 'cross_origin_redirect', 'resource.url is on another origin')
    }

    const requirements = pick(required, settings)

    if (!requirements) {
      return refuse(request, 'network', `no exact/USDC entry on ${allowedNetwork(settings) ?? 'no allowed network'}`)
    }

    const micros = microsOf(requirements.amount) as number
    const payTo = normalizeAddress(requirements.payTo) as string
    const network = requirements.network as Network
    const row = { micros, payTo, network }
    const domain = domainFor(network, requirements)

    if (!domain) {
      return refuse(request, 'payload', 'EIP-712 domain missing (extra.name / extra.version)', row)
    }

    if (request.maxMicros !== undefined && (!Number.isSafeInteger(request.maxMicros) || micros > request.maxMicros)) {
      return refuse(request, 'per_tx', `${micros} above the call’s max ${String(request.maxMicros)}`, row)
    }

    const attempt: Attempt = { request, origin, requirements, domain, micros, payTo, network, row, stopMark }

    // evaluate → door → `signed`, one at a time per (agent, UTC day); the next waits for this one's row or refusal.
    const admitted = await serialized(`${request.agent}\n${now().toISOString().slice(0, 10)}`, () => admit(attempt))

    if (!admitted.ok) {
      return refuse(request, admitted.reason, admitted.detail, admitted.extra)
    }

    try {
      return await send(attempt, admitted.mandate, admitted.nonce, admitted.authorization, required)
    } catch {
      // The `signed` row exists and a signature may have left: never a refusal, never re-signed.
      const detail = 'internal error after the signed row'

      outcome(
        {
          kind: 'failed',
          agent: request.agent,
          resource: request.url,
          ...attempt.row,
          nonce: admitted.nonce,
          note: detail
        },
        request.agent
      )
      audit({ kind: 'gap', reason: 'internal', agent: request.agent })

      return { kind: 'failed', micros: attempt.micros, nonce: admitted.nonce, detail }
    }
  }

  /** The seq of the ledger's last row (0 when empty), or null when it cannot be read. */
  const lastSeq = (): number | null => {
    try {
      return deps.ledger.read().records.length
    } catch {
      return null
    }
  }

  /**
   * Was a `stop` row (on, or the owner's off — every release is recorded first) written after `mark`? Null when the
   * mark or the ledger cannot be read: the caller refuses `ledger`.
   */
  const stopPulledSince = (mark: number | null): boolean | null => {
    if (mark === null) {
      return null
    }

    try {
      return deps.ledger
        .read()
        .records.slice(mark)
        .some(row => row.kind === 'stop')
    } catch {
      return null
    }
  }

  /** The ledger's totals, or a view that is not ok (rule `ledger`) when the ledger cannot be read. */
  const ledgerView = (): LimitsLedgerView => {
    try {
      return deps.ledger.limitsView()
    } catch {
      return { ok: false, signed: [] }
    }
  }

  /** The ceilings, read fresh at `at`: the user's settings (signer, network, caps, allowlists, stop) against the ledger. */
  const limitsGate = (attempt: Attempt, at: Date): Refusal | null => {
    const settings = deps.settings()

    if (settings.stop || deps.stopped()) {
      return refusal('stop', 'hard stop', attempt.row)
    }

    const pulled = stopPulledSince(attempt.stopMark)

    if (pulled === null) {
      return refusal('ledger', 'ledger unreadable', attempt.row)
    }

    if (pulled) {
      return refusal('stop', 'hard stop pulled while this payment was in flight', attempt.row)
    }

    if (settings.signer !== 'pocket') {
      return refusal('signer_unavailable', SIGNER_UNAVAILABLE, attempt.row)
    }

    if (allowedNetwork(settings) !== attempt.network) {
      return refusal('network', `${attempt.network} is not the allowed network`, attempt.row)
    }

    const decision = evaluatePayment(
      {
        agent: attempt.request.agent,
        micros: attempt.micros,
        payTo: attempt.payTo,
        resource: attempt.request.url,
        ...(attempt.p2p === true ? { p2p: true as const } : {}),
        stopFile: deps.stopped()
      },
      settings,
      ledgerView(),
      at
    )

    return decision.ok ? null : refusal(decision.rule, decision.detail, attempt.row)
  }

  /** The closed mandate against the ledger's usage now (budget, single use, revocation, expiry) and this payment. */
  const mandateGate = (
    attempt: Attempt,
    jti: string,
    closed: { presentation: string; closed: string },
    at: Date
  ): { ok: true; mandate: VerifiedMandate; usedMicros: number } | Refusal => {
    const usage = usageOf(deps.ledger, jti)

    if (!usage) {
      return refusal('ledger', 'ledger unreadable', { ...attempt.row, mandate: jti })
    }

    const verdict = deps.mandates.verify(closed.presentation, closed.closed, usage, at)

    if (!verdict.ok) {
      return refusal('mandate_invalid', verdict.reason, { ...attempt.row, mandate: jti })
    }

    const mandate = verdict.mandate

    if (
      mandate.jti !== jti ||
      mandate.agent !== attempt.request.agent ||
      mandate.payTo !== attempt.payTo ||
      mandate.micros !== attempt.micros ||
      mandate.origin !== attempt.origin
    ) {
      return refusal('mandate_invalid', 'closed mandate does not name this payment', {
        ...attempt.row,
        mandate: mandate.jti
      })
    }

    return { ok: true, mandate, usedMicros: usage.usedMicros }
  }

  type Admitted = { ok: true; mandate: VerifiedMandate; nonce: string; authorization: ExactEvmAuthorization } | Refusal

  /** Inside the queue: gates → door → the SAME gates again → `signed` + `mandate_use`, with no await after the door. */
  const admit = async (attempt: Attempt): Promise<Admitted> => {
    const { request } = attempt
    const before = limitsGate(attempt, now())

    if (before) {
      return before
    }

    if (!request.mandate) {
      return refusal('no_mandate', 'no open mandate named', attempt.row)
    }

    const closed = deps.mandates.close(request.mandate, {
      payTo: attempt.payTo,
      micros: attempt.micros,
      origin: attempt.origin,
      instrument: deps.signer.address ?? 'unavailable'
    })

    if (!closed.ok) {
      return refusal('mandate_invalid', closed.reason, { ...attempt.row, mandate: request.mandate })
    }

    const first = mandateGate(attempt, request.mandate, closed, now())

    if (!first.ok) {
      return first
    }

    const withMandate = { ...attempt.row, mandate: first.mandate.jti }

    if (!deps.door) {
      return refusal('no_door', 'no permission door', withMandate)
    }

    const allowed = await askDoor(deps.door, {
      agent: request.agent,
      resource: request.url,
      payTo: attempt.payTo,
      micros: attempt.micros,
      network: attempt.network,
      mandate: first.mandate,
      usedMicros: first.usedMicros
    })

    if (!allowed) {
      return refusal('door_denied', 'door said no', withMandate)
    }

    // The sheet was open for seconds: STOP, the settings, the day, the agent's day and the mandate budget may all
    // have moved. Everything is checked again, and the `signed` row lands in the same synchronous step. ONE instant
    // is read: every gate is evaluated at it and both rows are sealed with it, so a row is counted in the UTC day it
    // was checked against, even when the clock crosses midnight between the check and the write.
    const at = now()
    const after = limitsGate(attempt, at)

    if (after) {
      return { ...after, extra: withMandate }
    }

    const again = mandateGate(attempt, request.mandate, closed, at)

    if (!again.ok) {
      return again
    }

    const mandate = again.mandate

    if (!deps.signer.address) {
      return refusal('signer_unavailable', deps.signer.reason ?? 'unavailable', withMandate)
    }

    const seconds = Math.floor(at.getTime() / 1000)
    const nonce = `0x${nonceHex()}`

    const authorization: ExactEvmAuthorization = {
      from: deps.signer.address,
      to: attempt.payTo,
      value: String(attempt.micros),
      validAfter: '0',
      validBefore: String(seconds + Math.min(attempt.requirements.maxTimeoutSeconds, MAX_VALID_SECONDS)),
      nonce
    }

    // The spend that counts, written before the signature exists: a crash between the two costs nothing.
    const signedRow = write(
      {
        kind: 'signed',
        agent: request.agent,
        resource: request.url,
        ...withMandate,
        transactionId: mandate.transactionId,
        nonce
      },
      at
    )

    if (!signedRow) {
      return refusal('ledger', 'ledger write failed', withMandate)
    }

    const useRow = write(
      {
        kind: 'mandate_use',
        agent: request.agent,
        resource: request.url,
        ...withMandate,
        transactionId: mandate.transactionId
      },
      at
    )

    if (!useRow) {
      // The `signed` row already counts against the day; without the budget debit nothing is signed.
      return refusal('ledger', 'ledger write failed (mandate use)', withMandate)
    }

    return { ok: true, mandate, nonce, authorization }
  }

  /** After the queue: one signature, one retry, the server's answer. Never re-signed. */
  const send = async (
    attempt: Attempt,
    mandate: VerifiedMandate,
    nonce: string,
    authorization: ExactEvmAuthorization,
    required: PaymentRequired
  ): Promise<PayResult> => {
    const { request, requirements, micros, row } = attempt

    let signature: `0x${string}`

    try {
      signature = await deps.signer.signAuthorization(authorization, attempt.domain)
    } catch {
      // A fixed string: whatever the signer threw is never copied into a note or a result.
      const detail = 'sign failed'

      outcome(
        { kind: 'failed', agent: request.agent, resource: request.url, ...row, nonce, note: detail },
        request.agent
      )
      audit({ kind: 'gap', reason: 'sign_failed', agent: request.agent })

      return { kind: 'failed', micros, nonce, detail }
    }

    const payload: PaymentPayload = {
      x402Version: X402_VERSION,
      resource: { url: required.resource.url },
      accepted: requirements,
      payload: { signature, authorization }
    }

    const second = await get(request.url, { accept: '*/*', [HEADER_PAYMENT_SIGNATURE]: base64Json.encode(payload) })

    const pendingResult = (detail: string): PayResult => {
      outcome(
        { kind: 'pending', agent: request.agent, resource: request.url, ...row, nonce, note: detail },
        request.agent
      )
      audit({ kind: 'timeout', reason: 'settlement_pending', agent: request.agent })

      try {
        deps.onPending?.({ nonce, micros, resource: request.url })
      } catch {
        // the reconciler's hook failing leaves the `pending` row, which it reads anyway
      }

      return { kind: 'pending', micros, nonce, detail }
    }

    if (second === 'timeout' || second === 'error') {
      return pendingResult(`retry ${second}: the server holds a signature`)
    }

    const settlement = base64Json.decode(second.headers.get(HEADER_PAYMENT_RESPONSE))

    if (second.status === 402 || !isSettleResponse(settlement)) {
      const detail =
        second.status === 402
          ? 'paid request answered 402 again (not retried)'
          : `no PAYMENT-RESPONSE on ${second.status}`

      outcome(
        { kind: 'failed', agent: request.agent, resource: request.url, ...row, nonce, note: detail },
        request.agent
      )
      audit({ kind: 'gap', reason: 'settlement_unknown', agent: request.agent })

      return { kind: 'failed', micros, nonce, detail }
    }

    if (!settlement.success && settlement.errorReason === 'settlement_pending') {
      return pendingResult('facilitator: settlement_pending')
    }

    if (!settlement.success) {
      const detail = `settlement failed: ${settlement.errorReason ?? 'unknown'}`

      outcome(
        { kind: 'failed', agent: request.agent, resource: request.url, ...row, nonce, note: detail },
        request.agent
      )
      audit({ kind: 'gap', reason: 'settlement_failed', agent: request.agent })

      return { kind: 'failed', micros, nonce, detail }
    }

    outcome(
      {
        kind: 'settled',
        agent: request.agent,
        resource: request.url,
        ...row,
        mandate: mandate.jti,
        transactionId: mandate.transactionId,
        nonce,
        transaction: settlement.transaction
      },
      request.agent
    )
    audit({ kind: 'use', reason: 'settled', agent: request.agent })

    return {
      kind: 'paid',
      status: second.status,
      body: await bodyOf(second),
      micros,
      transaction: settlement.transaction
    }
  }

  /** p2p, after the queue: one signature, verified then settled by the allowlisted facilitator. Never re-signed. */
  const settleP2p = async (
    attempt: Attempt,
    facilitator: Facilitator,
    mandate: VerifiedMandate,
    nonce: string,
    authorization: ExactEvmAuthorization
  ): Promise<PayResult> => {
    const { request, requirements, micros, row } = attempt

    const failed = (detail: string, reason: string): PayResult => {
      outcome(
        { kind: 'failed', agent: request.agent, resource: request.url, ...row, nonce, note: detail },
        request.agent
      )
      audit({ kind: 'gap', reason, agent: request.agent })

      return { kind: 'failed', micros, nonce, detail }
    }

    const pending = (detail: string): PayResult => {
      outcome(
        { kind: 'pending', agent: request.agent, resource: request.url, ...row, nonce, note: detail },
        request.agent
      )
      audit({ kind: 'timeout', reason: 'settlement_pending', agent: request.agent })

      try {
        deps.onPending?.({ nonce, micros, resource: request.url })
      } catch {
        // the reconciler reads the `pending` row anyway
      }

      return { kind: 'pending', micros, nonce, detail }
    }

    let signature: `0x${string}`

    try {
      signature = await deps.signer.signAuthorization(authorization, attempt.domain)
    } catch {
      return failed('sign failed', 'sign_failed')
    }

    const payload: PaymentPayload = {
      x402Version: X402_VERSION,
      accepted: requirements,
      payload: { signature, authorization }
    }

    const verified = await facilitator.verify(payload, requirements)

    if (!verified.ok) {
      // The facilitator may hold the signature (a timeout): reconcile by nonce, never sign again.
      return verified.error === 'timeout'
        ? pending('facilitator verify timed out')
        : failed(`facilitator verify: ${verified.error}`, 'settlement_unknown')
    }

    if (!verified.value.isValid) {
      return failed(`facilitator verify: ${verified.value.invalidReason ?? 'invalid'}`, 'settlement_failed')
    }

    const settled = await facilitator.settle(payload, requirements)

    if (!settled.ok) {
      return settled.error === 'timeout'
        ? pending('facilitator settle timed out')
        : failed(`facilitator settle: ${settled.error}`, 'settlement_unknown')
    }

    if (!settled.value.success && settled.value.errorReason === 'settlement_pending') {
      return pending('facilitator: settlement_pending')
    }

    if (!settled.value.success) {
      return failed(`settlement failed: ${settled.value.errorReason ?? 'unknown'}`, 'settlement_failed')
    }

    outcome(
      {
        kind: 'settled',
        agent: request.agent,
        resource: request.url,
        ...row,
        mandate: mandate.jti,
        transactionId: mandate.transactionId,
        nonce,
        transaction: settled.value.transaction
      },
      request.agent
    )
    audit({ kind: 'use', reason: 'settled', agent: request.agent })

    return { kind: 'paid', status: 200, body: '', micros, transaction: settled.value.transaction }
  }

  const sendChecked = async (request: PayRequest, payTo: string, micros: number): Promise<PayResult> => {
    const stopMark = lastSeq()
    const settings = deps.settings()
    const key = `${request.agent}\n${request.url}`

    if (settings.stop || deps.stopped()) {
      return refuse(request, 'stop', 'hard stop')
    }

    if (settings.signer !== 'pocket') {
      return refuse(request, 'signer_unavailable', SIGNER_UNAVAILABLE)
    }

    const network = allowedNetwork(settings)

    if (!network) {
      return refuse(request, 'network', 'no allowed network')
    }

    const facilitator = deps.facilitator ?? null
    const origin = facilitator ? originOf(facilitator.urlFor(network)) : null

    if (!facilitator || !origin) {
      return refuse(request, 'facilitator', `no facilitator for ${network}`)
    }

    if (inFlight.has(key)) {
      return refuse(request, 'duplicate', 'a send to this payee is in flight')
    }

    const info = NETWORK_INFO[network]

    const requirements: PaymentRequirements = {
      scheme: 'exact',
      network,
      amount: String(micros),
      asset: info.usdc,
      payTo,
      maxTimeoutSeconds: P2P_VALID_SECONDS,
      extra: { name: info.eip712.name, version: info.eip712.version }
    }

    const domain = domainFor(network, requirements)
    const row = { micros, payTo, network }

    if (!domain) {
      return refuse(request, 'payload', 'EIP-712 domain missing', row)
    }

    const attempt: Attempt = { request, origin, requirements, domain, micros, payTo, network, row, stopMark, p2p: true }

    inFlight.add(key)

    try {
      const admitted = await serialized(`${request.agent}\n${now().toISOString().slice(0, 10)}`, () => admit(attempt))

      if (!admitted.ok) {
        return refuse(request, admitted.reason, admitted.detail, admitted.extra)
      }

      try {
        return await settleP2p(attempt, facilitator, admitted.mandate, admitted.nonce, admitted.authorization)
      } catch {
        const detail = 'internal error after the signed row'

        outcome(
          { kind: 'failed', agent: request.agent, resource: request.url, ...row, nonce: admitted.nonce, note: detail },
          request.agent
        )
        audit({ kind: 'gap', reason: 'internal', agent: request.agent })

        return { kind: 'failed', micros, nonce: admitted.nonce, detail }
      }
    } finally {
      inFlight.delete(key)
    }
  }

  const sendP2p = async (request: SendRequest): Promise<PayResult> => {
    let named: PayRequest = ANONYMOUS

    // The same backstop as `pay`: one read per field, identity first, and `send()` never rejects.
    try {
      const raw: Partial<Record<keyof SendRequest, unknown>> =
        typeof request === 'object' && request !== null ? request : {}

      const snapshot = { agent: raw.agent, payTo: raw.payTo, micros: raw.micros, mandate: raw.mandate }
      const payTo = normalizeAddress(snapshot.payTo)
      const url = payTo ? `${P2P_PREFIX}${payTo}` : P2P_PREFIX

      if (!isAgentSlug(snapshot.agent)) {
        return refuse({ ...ANONYMOUS, url }, 'agent', 'agent is not a profile slug')
      }

      if (snapshot.mandate !== null && !isMandateId(snapshot.mandate)) {
        return refuse({ ...ANONYMOUS, url, agent: snapshot.agent }, 'mandate_invalid', 'mandate id is not an id')
      }

      named = { url, agent: snapshot.agent, mandate: snapshot.mandate }

      if (!payTo) {
        return refuse(named, 'payee', 'not an address')
      }

      if (typeof snapshot.micros !== 'number' || !Number.isSafeInteger(snapshot.micros) || snapshot.micros <= 0) {
        return refuse(named, 'per_tx', 'amount is not a positive number of micro-USDC')
      }

      return await sendChecked(named, payTo, snapshot.micros)
    } catch {
      return refuse(named, 'internal', 'internal error before any signature')
    }
  }

  return { pay, send: sendP2p }
}
