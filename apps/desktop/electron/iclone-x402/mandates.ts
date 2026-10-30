/**
 * V3-J — AP2 mandates, AP2-shaped (`google-agentic-commerce/AP2` main @ e1ea56d, `docs/ap2/specification.md` v0.2)
 * and locally verified. The owner signs an OPEN Payment Mandate (`vct` `mandate.payment.open.1`): an SD-JWT whose
 * `constraints[]` elements are selectively disclosable (`_sd_alg` sha-256, `{"...": digest}` placeholders), bound to
 * the agent's P-256 key through `cnf.jwk`, with `iat` and `exp`. Per payment the agent (main, holding the iNFT's cnf
 * key — the agent process never does) CLOSES it: a `mandate.payment.1` JWT (`transaction_id`, `payee`,
 * `payment_amount`, `payment_instrument`) plus a key-binding JWT (`kb+sd-jwt`: `aud`, `nonce`, `iat`, `sd_hash`),
 * both signed with the cnf key. `verify` checks, in order: the open signature (owner key), the `vct`, `iat`/`exp`,
 * every disclosure's digest, the cnf key, the closed and KB signatures, the two `sd_hash` links, the single use of the
 * closed `transaction_id` (from the ledger, never a counter), revocation, then every constraint — an unknown
 * constraint type fails the evaluation (spec §constraints). Nothing passes on a missing piece.
 *
 * AP2 v0.2 does not mention x402 (contract R3): the closed mandate's `payment_instrument.type` is our own
 * `x402:exact:evm` and `payee.id` is the `payTo` address. The crypto bridge (`a2a-x402` v0.1) is not implemented.
 *
 * Storage: `userData/payments/mandates/<jti>.sdjwt` (0600, the open SD-JWT with its disclosures) and
 * `<jti>.revoked` as the revocation marker. One byte changed anywhere ⇒ invalid.
 */
import { createHash, type KeyObject, randomBytes, sign as signRaw, verify as verifyRaw } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { writeFileAtomicSync } from '../lib/atomic-write'

import type { P256Key } from './keys'
import type { PaymentLedger } from './ledger'
import { isMandateId, normalizeAddress, originOf } from './types'

export const VCT_OPEN = 'mandate.payment.open.1'
const VCT_CLOSED = 'mandate.payment.1'
const INSTRUMENT_TYPE = 'x402:exact:evm'
const CURRENCY = 'USDC'

/** v0.2 constraint types. Anything else fails. */
export type Constraint =
  | { type: 'payment.allowed_payees'; payees: string[] }
  | { type: 'payment.allowed_payment_instruments'; instruments: string[] }
  | { type: 'payment.amount_range'; min: string; max: string; currency: string }
  | { type: 'payment.budget'; amount: string; currency: string }
  | { type: 'payment.execution_date'; not_before: string; not_after: string }
  | { type: 'payment.reference'; value: string }

interface OpenMandateInput {
  /** The iNFT (agent) this mandate is for; names its cnf key. */
  agent: string
  constraints: Constraint[]
  /** Seconds the mandate lives… */
  ttlSeconds?: number
  /** …or the instant (epoch seconds) it expires, exactly as the owner set it (Settings › Economy › Payments). */
  expiresAt?: number
}

interface ClosedMandateInput {
  payTo: string
  micros: number
  /** The resource origin: the KB-JWT's `aud`. */
  origin: string
  /** The pocket address: `payment_instrument.id`. */
  instrument: string
  payeeName?: string
  reference?: string
}

interface MandateRecord {
  jti: string
  agent: string
  iat: number
  exp: number
  constraints: Constraint[]
  revoked: boolean
}

/** What a verified presentation says, for the limits, the door sheet and the ledger. */
export interface VerifiedMandate {
  jti: string
  agent: string
  exp: number
  transactionId: string
  payTo: string
  micros: number
  origin: string
  instrument: string
  constraints: Constraint[]
}

type MandateVerdict = { ok: true; mandate: VerifiedMandate } | { ok: false; reason: string }

export interface MandateUsage {
  /** micro-USDC already closed under this open mandate (ledger `mandate_use` rows). */
  usedMicros: number
  /** closed `transaction_id`s already used (any mandate). */
  usedTransactionIds: ReadonlySet<string>
}

const b64u = {
  encode: (data: Buffer | string): string => Buffer.from(data).toString('base64url'),
  decodeJson: (text: string): unknown => {
    try {
      return JSON.parse(Buffer.from(text, 'base64url').toString('utf8')) as unknown
    } catch {
      return null
    }
  }
}

const sha256b64u = (text: string): string => b64u.encode(createHash('sha256').update(text).digest())

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isInt = (value: unknown): value is number => Number.isSafeInteger(value)
const MAX_TOKEN = 32 * 1024
const MAX_SKEW_SECONDS = 60

/** Compact ES256 JWS (raw r||s signature, RFC 7515 §A.3). */
function signJws(header: Record<string, unknown>, payload: Record<string, unknown>, key: KeyObject): string {
  const signingInput = `${b64u.encode(JSON.stringify(header))}.${b64u.encode(JSON.stringify(payload))}`
  const signature = signRaw('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' })

  return `${signingInput}.${b64u.encode(signature)}`
}

interface Jws {
  header: Record<string, unknown>
  payload: Record<string, unknown>
}

/** The verified header and payload of a compact ES256 JWS, or null (wrong shape, wrong alg, wrong key, one byte off). */
function verifyJws(token: string, key: KeyObject, typ: string): Jws | null {
  if (typeof token !== 'string' || token.length > MAX_TOKEN) {
    return null
  }

  const parts = token.split('.')

  if (parts.length !== 3 || parts.some(part => part.length === 0)) {
    return null
  }

  const header = b64u.decodeJson(parts[0])
  const payload = b64u.decodeJson(parts[1])

  if (!isObject(header) || header.alg !== 'ES256' || header.typ !== typ || !isObject(payload)) {
    return null
  }

  let valid = false

  try {
    valid = verifyRaw(
      'sha256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(parts[2], 'base64url')
    )
  } catch {
    valid = false
  }

  return valid ? { header, payload } : null
}

const jwkOf = (key: KeyObject): JsonWebKey => {
  const { kty, crv, x, y } = key.export({ format: 'jwk' })

  return { kty, crv, x, y }
}

const sameJwk = (a: JsonWebKey | null | undefined, b: JsonWebKey | null | undefined): boolean =>
  !!a && !!b && a.kty === 'EC' && b.kty === 'EC' && a.crv === 'P-256' && b.crv === 'P-256' && a.x === b.x && a.y === b.y

const DECIMAL_RE = /^(0|[1-9]\d*)(\.\d{1,6})?$/

/** "1.25" → 1_250_000; null for anything that is not a non-negative decimal with ≤ 6 places. */
export function microsOfDecimal(text: unknown): number | null {
  if (typeof text !== 'string' || !DECIMAL_RE.test(text)) {
    return null
  }

  const [whole, frac = ''] = text.split('.')
  const value = Number(whole) * 1_000_000 + Number(frac.padEnd(6, '0'))

  return Number.isSafeInteger(value) ? value : null
}

const decimalOf = (micros: number): string =>
  `${Math.floor(micros / 1_000_000)}.${String(micros % 1_000_000).padStart(6, '0')}`

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every(entry => typeof entry === 'string' && entry.length > 0)

/** The constraint's shape, strictly. Unknown `type` ⇒ null (evaluation fails). */
export function parseConstraint(value: unknown): Constraint | null {
  if (!isObject(value) || typeof value.type !== 'string') {
    return null
  }

  switch (value.type) {
    case 'payment.allowed_payees':
      return isStringList(value.payees) && value.payees.every(entry => normalizeAddress(entry) !== null)
        ? { type: value.type, payees: value.payees.map(entry => entry.toLowerCase()) }
        : null

    case 'payment.allowed_payment_instruments':
      return isStringList(value.instruments) ? { type: value.type, instruments: value.instruments } : null

    case 'payment.amount_range':
      return microsOfDecimal(value.min) !== null &&
        microsOfDecimal(value.max) !== null &&
        value.currency === CURRENCY &&
        (microsOfDecimal(value.min) as number) <= (microsOfDecimal(value.max) as number)
        ? { type: value.type, min: value.min as string, max: value.max as string, currency: CURRENCY }
        : null

    case 'payment.budget':
      return microsOfDecimal(value.amount) !== null && value.currency === CURRENCY
        ? { type: value.type, amount: value.amount as string, currency: CURRENCY }
        : null

    case 'payment.execution_date':
      return typeof value.not_before === 'string' &&
        typeof value.not_after === 'string' &&
        Number.isFinite(Date.parse(value.not_before)) &&
        Number.isFinite(Date.parse(value.not_after))
        ? { type: value.type, not_before: value.not_before, not_after: value.not_after }
        : null

    case 'payment.reference':
      return typeof value.value === 'string' && value.value.length > 0 && value.value.length <= 256
        ? { type: value.type, value: value.value }
        : null

    default:
      return null
  }
}

/** Every constraint against one closed mandate. The first miss names itself. */
export function evaluateConstraints(
  constraints: readonly Constraint[],
  closed: { payTo: string; micros: number; instrument: string; reference?: string | undefined },
  usedMicros: number,
  now: Date
): string | null {
  for (const constraint of constraints) {
    switch (constraint.type) {
      case 'payment.allowed_payees':
        if (!constraint.payees.includes(closed.payTo)) {
          return 'payee not in mandate'
        }

        break

      case 'payment.allowed_payment_instruments':
        if (!constraint.instruments.includes(closed.instrument)) {
          return 'instrument not in mandate'
        }

        break
      case 'payment.amount_range': {
        const min = microsOfDecimal(constraint.min) as number
        const max = microsOfDecimal(constraint.max) as number

        if (closed.micros < min || closed.micros > max) {
          return 'amount outside mandate range'
        }

        break
      }

      case 'payment.budget':
        if (usedMicros + closed.micros > (microsOfDecimal(constraint.amount) as number)) {
          return 'mandate budget exhausted'
        }

        break
      case 'payment.execution_date': {
        const t = now.getTime()

        if (t < Date.parse(constraint.not_before) || t > Date.parse(constraint.not_after)) {
          return 'outside mandate execution window'
        }

        break
      }

      case 'payment.reference':
        if (closed.reference !== constraint.value) {
          return 'reference mismatch'
        }

        break

      default:
        return 'unknown constraint'
    }
  }

  return null
}

interface Disclosure {
  salt: string
  value: unknown
  encoded: string
  digest: string
}

const discloseElement = (value: unknown): Disclosure => {
  const salt = randomBytes(16).toString('base64url')
  const encoded = b64u.encode(JSON.stringify([salt, value]))

  return { salt, value, encoded, digest: sha256b64u(encoded) }
}

/** Splits `<jws>~<d1>~…~[<kb>]`. The issuer part, the disclosures, the optional key-binding JWT. */
function splitSdJwt(text: string): { issuer: string; disclosures: string[]; kb: string | null } | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_TOKEN || !text.includes('~')) {
    return null
  }

  const parts = text.split('~')
  const issuer = parts[0]
  const last = parts[parts.length - 1]
  const kb = last.length ? last : null
  const disclosures = parts.slice(1, parts.length - 1)

  return issuer && disclosures.every(part => part.length > 0) ? { issuer, disclosures, kb } : null
}

/** The open mandate's constraints from its payload placeholders and its disclosures. Every placeholder must be met, every disclosure must be used. */
function resolveConstraints(payload: Record<string, unknown>, disclosures: readonly string[]): Constraint[] | null {
  if (payload._sd_alg !== 'sha-256' || !Array.isArray(payload.constraints)) {
    return null
  }

  const byDigest = new Map<string, unknown>()

  for (const encoded of disclosures) {
    const parsed = b64u.decodeJson(encoded)

    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string') {
      return null
    }

    byDigest.set(sha256b64u(encoded), parsed[1])
  }

  const out: Constraint[] = []

  for (const element of payload.constraints) {
    if (!isObject(element) || typeof element['...'] !== 'string' || !byDigest.has(element['...'])) {
      return null
    }

    const constraint = parseConstraint(byDigest.get(element['...']))

    if (!constraint) {
      return null
    }

    out.push(constraint)
    byDigest.delete(element['...'])
  }

  return byDigest.size === 0 && out.length > 0 ? out : null
}

interface MandateStoreDeps {
  dir: string
  ownerKey: P256Key
  agentKey: (slug: string) => P256Key
  /**
   * The payments ledger: where issue and revoke are recorded (`mandate_issue` / `mandate_revoke`), and THE clock. The
   * store has none of its own: `iat`, `exp`, the revocation marker and a verify without `at` all read `ledger.now`,
   * so the store and the client judge one mandate on one clock (merge round), and each row is sealed with the
   * instant its `iat` came from.
   */
  ledger: Pick<PaymentLedger, 'append' | 'now'>
}

export interface MandateStore {
  /** Owner-side (after the door sheet, with the gesture): the open SD-JWT, stored. */
  issue: (input: OpenMandateInput) => { ok: true; record: MandateRecord; sdjwt: string } | { ok: false; reason: string }
  list: () => MandateRecord[]
  get: (jti: string) => string | null
  revoke: (jti: string) => boolean
  /** Agent-side (main, the iNFT's cnf key): the presentation `<open>~<kb>` and the closed JWT, for one payment. */
  close: (
    jti: string,
    input: ClosedMandateInput
  ) => { ok: true; presentation: string; closed: string } | { ok: false; reason: string }
  /** Main-side: everything, against the ledger's usage. */
  verify: (presentation: string, closed: string, usage: MandateUsage, at?: Date) => MandateVerdict
}

export function createMandateStore(deps: MandateStoreDeps): MandateStore {
  const now = () => deps.ledger.now()
  const fileOf = (jti: string) => path.join(deps.dir, `${jti}.sdjwt`)
  const revokedOf = (jti: string) => path.join(deps.dir, `${jti}.revoked`)
  const isRevoked = (jti: string) => fs.existsSync(revokedOf(jti))

  const readOpen = (text: string): { payload: Record<string, unknown>; constraints: Constraint[] } | null => {
    const split = splitSdJwt(text)

    if (!split || !deps.ownerKey.publicKey) {
      return null
    }

    const jws = verifyJws(split.issuer, deps.ownerKey.publicKey, 'dc+sd-jwt')

    if (!jws || jws.payload.vct !== VCT_OPEN) {
      return null
    }

    const constraints = resolveConstraints(jws.payload, split.disclosures)

    return constraints ? { payload: jws.payload, constraints } : null
  }

  const recordOf = (text: string, jti: string): MandateRecord | null => {
    const open = readOpen(text)

    if (!open || open.payload.jti !== jti || !isInt(open.payload.iat) || !isInt(open.payload.exp)) {
      return null
    }

    return {
      jti,
      agent: typeof open.payload.sub === 'string' ? open.payload.sub : '',
      iat: open.payload.iat,
      exp: open.payload.exp,
      constraints: open.constraints,
      revoked: isRevoked(jti)
    }
  }

  const get = (jti: string): string | null => {
    if (!isMandateId(jti)) {
      return null
    }

    try {
      return fs.readFileSync(fileOf(jti), 'utf8').trim()
    } catch {
      return null
    }
  }

  const issue: MandateStore['issue'] = input => {
    if (!deps.ownerKey.privateKey) {
      return { ok: false, reason: deps.ownerKey.reason ?? 'owner key unavailable' }
    }

    const agentKey = deps.agentKey(input.agent)

    if (!agentKey.jwk) {
      return { ok: false, reason: agentKey.reason ?? 'agent key unavailable' }
    }

    const constraints = input.constraints.map(parseConstraint)

    if (constraints.length === 0 || constraints.some(constraint => constraint === null)) {
      return { ok: false, reason: 'a constraint is malformed or unknown' }
    }

    // One instant: `iat`, the lifetime check and the `mandate_issue` row all read it.
    const at = now()
    const iat = Math.floor(at.getTime() / 1000)
    const ttlSeconds = input.expiresAt !== undefined ? input.expiresAt - iat : input.ttlSeconds

    if (
      (input.expiresAt !== undefined) === (input.ttlSeconds !== undefined) ||
      !isInt(ttlSeconds) ||
      ttlSeconds <= 0 ||
      ttlSeconds > 90 * 86_400
    ) {
      return { ok: false, reason: 'ttl must be 1 s … 90 d' }
    }

    const jti = randomBytes(16).toString('hex')
    const disclosures = (constraints as Constraint[]).map(discloseElement)

    const payload = {
      vct: VCT_OPEN,
      iss: 'icloneos:owner',
      sub: input.agent,
      jti,
      iat,
      exp: iat + ttlSeconds,
      cnf: { jwk: agentKey.jwk },
      constraints: disclosures.map(disclosure => ({ '...': disclosure.digest })),
      _sd_alg: 'sha-256'
    }

    const sdjwt = `${signJws({ alg: 'ES256', typ: 'dc+sd-jwt' }, payload, deps.ownerKey.privateKey)}~${disclosures
      .map(disclosure => disclosure.encoded)
      .join('~')}~`

    writeFileAtomicSync(fileOf(jti), `${sdjwt}\n`, { mode: 0o600, dirMode: 0o700 })

    const budget = (constraints as Constraint[]).find(constraint => constraint.type === 'payment.budget')

    let issued: ReturnType<PaymentLedger['append']> = null

    try {
      issued = deps.ledger.append(
        {
          kind: 'mandate_issue',
          agent: input.agent,
          mandate: jti,
          micros: budget?.type === 'payment.budget' ? microsOfDecimal(budget.amount) : null,
          note: `exp ${new Date((iat + ttlSeconds) * 1000).toISOString()}; ${(constraints as Constraint[])
            .map(constraint => constraint.type)
            .join(', ')}`
        },
        at
      )
    } catch {
      issued = null
    }

    if (!issued) {
      // An open mandate the ledger does not know about does not exist.
      fs.rmSync(fileOf(jti), { force: true })

      return { ok: false, reason: 'ledger write failed' }
    }

    return {
      ok: true,
      sdjwt,
      record: {
        jti,
        agent: input.agent,
        iat,
        exp: iat + ttlSeconds,
        constraints: constraints as Constraint[],
        revoked: false
      }
    }
  }

  const list = (): MandateRecord[] => {
    let names: string[] = []

    try {
      names = fs.readdirSync(deps.dir)
    } catch {
      names = []
    }

    const out: MandateRecord[] = []

    for (const name of names.sort()) {
      const jti = name.endsWith('.sdjwt') ? name.slice(0, -'.sdjwt'.length) : null
      const text = jti && isMandateId(jti) ? get(jti) : null
      const record = text ? recordOf(text, jti as string) : null

      if (record) {
        out.push(record)
      }
    }

    return out
  }

  const revoke = (jti: string): boolean => {
    if (!isMandateId(jti) || !fs.existsSync(fileOf(jti))) {
      return false
    }

    const at = now()

    writeFileAtomicSync(revokedOf(jti), `${at.toISOString()}\n`, { mode: 0o600, dirMode: 0o700 })

    // The marker is the revocation (it narrows: never blocked); the row records it, and a ledger that throws does not
    // undo it.
    try {
      deps.ledger.append({ kind: 'mandate_revoke', mandate: jti }, at)
    } catch {
      // the marker stands
    }

    return true
  }

  const close: MandateStore['close'] = (jti, input) => {
    const text = get(jti)
    const record = text ? recordOf(text, jti) : null

    if (!text || !record) {
      return { ok: false, reason: 'no such mandate' }
    }

    const agentKey = deps.agentKey(record.agent)

    if (!agentKey.privateKey) {
      return { ok: false, reason: agentKey.reason ?? 'agent key unavailable' }
    }

    const payTo = normalizeAddress(input.payTo)
    const origin = originOf(input.origin)

    if (!payTo || !origin || !isInt(input.micros) || input.micros <= 0) {
      return { ok: false, reason: 'closed mandate input malformed' }
    }

    const iat = Math.floor(now().getTime() / 1000)
    const transactionId = randomBytes(16).toString('hex')
    const sdHash = sha256b64u(text)

    const closedPayload: Record<string, unknown> = {
      vct: VCT_CLOSED,
      iss: `icloneos:agent:${record.agent}`,
      jti: transactionId,
      iat,
      transaction_id: transactionId,
      payee: { id: payTo, name: input.payeeName ?? origin, website: origin },
      payment_amount: { amount: decimalOf(input.micros), currency: CURRENCY },
      payment_instrument: { id: input.instrument, type: INSTRUMENT_TYPE, description: 'x402 exact / EIP-3009' },
      open_mandate: jti,
      sd_hash: sdHash
    }

    if (input.reference !== undefined) {
      closedPayload.reference = input.reference
    }

    const closed = signJws({ alg: 'ES256', typ: VCT_CLOSED }, closedPayload, agentKey.privateKey)

    const kb = signJws(
      { alg: 'ES256', typ: 'kb+sd-jwt' },
      { iat, aud: origin, nonce: randomBytes(16).toString('base64url'), sd_hash: sdHash },
      agentKey.privateKey
    )

    return { ok: true, presentation: `${text}${kb}`, closed }
  }

  const verify: MandateStore['verify'] = (presentation, closed, usage, at) => {
    const t = at ?? now()
    const split = splitSdJwt(presentation)

    if (!split || !split.kb) {
      return { ok: false, reason: 'presentation malformed' }
    }

    const openText = presentation.slice(0, presentation.length - split.kb.length)
    const open = readOpen(openText)

    if (!open) {
      return { ok: false, reason: 'open mandate signature or disclosures invalid' }
    }

    const { payload } = open
    const jti = typeof payload.jti === 'string' && isMandateId(payload.jti) ? payload.jti : null
    const agent = typeof payload.sub === 'string' ? payload.sub : null
    const seconds = Math.floor(t.getTime() / 1000)

    if (!jti || !agent || !isInt(payload.iat) || !isInt(payload.exp)) {
      return { ok: false, reason: 'open mandate claims malformed' }
    }

    if (payload.iat > seconds + MAX_SKEW_SECONDS) {
      return { ok: false, reason: 'open mandate not yet valid' }
    }

    if (payload.exp <= seconds) {
      return { ok: false, reason: 'open mandate expired' }
    }

    const stored = get(jti)

    if (stored !== openText) {
      return { ok: false, reason: 'open mandate is not the stored one' }
    }

    if (isRevoked(jti)) {
      return { ok: false, reason: 'open mandate revoked' }
    }

    const cnf = isObject(payload.cnf) && isObject(payload.cnf.jwk) ? (payload.cnf.jwk as JsonWebKey) : null
    const agentKey = deps.agentKey(agent)

    if (!cnf || !agentKey.publicKey || !sameJwk(cnf, jwkOf(agentKey.publicKey))) {
      return { ok: false, reason: 'cnf key is not this agent’s key' }
    }

    const kb = verifyJws(split.kb, agentKey.publicKey, 'kb+sd-jwt')
    const sdHash = sha256b64u(openText)

    if (
      !kb ||
      kb.payload.sd_hash !== sdHash ||
      typeof kb.payload.aud !== 'string' ||
      typeof kb.payload.nonce !== 'string'
    ) {
      return { ok: false, reason: 'key binding invalid' }
    }

    const closedJws = verifyJws(closed, agentKey.publicKey, VCT_CLOSED)

    if (
      !closedJws ||
      closedJws.payload.vct !== VCT_CLOSED ||
      closedJws.payload.sd_hash !== sdHash ||
      closedJws.payload.open_mandate !== jti
    ) {
      return { ok: false, reason: 'closed mandate invalid' }
    }

    const c = closedJws.payload

    const transactionId =
      typeof c.transaction_id === 'string' && isMandateId(c.transaction_id) ? c.transaction_id : null

    const payee = isObject(c.payee) ? normalizeAddress(c.payee.id) : null

    const amount =
      isObject(c.payment_amount) && c.payment_amount.currency === CURRENCY
        ? microsOfDecimal(c.payment_amount.amount)
        : null

    const instrument =
      isObject(c.payment_instrument) &&
      c.payment_instrument.type === INSTRUMENT_TYPE &&
      typeof c.payment_instrument.id === 'string'
        ? c.payment_instrument.id
        : null

    const origin = originOf(kb.payload.aud)

    if (
      !transactionId ||
      !payee ||
      amount === null ||
      amount <= 0 ||
      !instrument ||
      !origin ||
      c.jti !== transactionId
    ) {
      return { ok: false, reason: 'closed mandate claims malformed' }
    }

    if (!isInt(c.iat) || c.iat > seconds + MAX_SKEW_SECONDS || c.iat < payload.iat) {
      return { ok: false, reason: 'closed mandate time invalid' }
    }

    if (usage.usedTransactionIds.has(transactionId)) {
      return { ok: false, reason: 'closed mandate already used' }
    }

    const miss = evaluateConstraints(
      open.constraints,
      {
        payTo: payee,
        micros: amount,
        instrument,
        reference: typeof c.reference === 'string' ? c.reference : undefined
      },
      usage.usedMicros,
      t
    )

    if (miss) {
      return { ok: false, reason: miss }
    }

    return {
      ok: true,
      mandate: {
        jti,
        agent,
        exp: payload.exp,
        transactionId,
        payTo: payee,
        micros: amount,
        origin,
        instrument,
        constraints: open.constraints
      }
    }
  }

  return { issue, list, get, revoke, close, verify }
}
