import { createHash, randomBytes, sign } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { EARN_WALLET, fakeSealer, OTHER_WALLET, tmpProfile } from './harness.test-helpers'
import { loadAgentKey, loadOwnerMandateKey, type P256Key } from './keys'
import { createLedger } from './ledger'
import {
  type Constraint,
  createMandateStore,
  evaluateConstraints,
  type MandateStore,
  type MandateUsage,
  microsOfDecimal,
  parseConstraint,
  VCT_OPEN
} from './mandates'

const dirs: string[] = []
const NOW = new Date('2026-10-21T12:00:00.000Z')
const NO_USE: MandateUsage = { usedMicros: 0, usedTransactionIds: new Set() }
const ORIGIN = 'https://pay.example'
const POCKET = '0x3333333333333333333333333333333333333333'

interface Lab {
  store: MandateStore
  owner: P256Key
  agentKey: (slug: string) => P256Key
  dir: string
}

function lab(options: { sealer?: ReturnType<typeof fakeSealer> | null; now?: () => Date } = {}): Lab {
  const dir = tmpProfile()
  const sealer = options.sealer === undefined ? fakeSealer() : options.sealer
  const keys = path.join(dir, 'keys')
  const owner = loadOwnerMandateKey(keys, sealer)
  const agentKey = (slug: string) => loadAgentKey(keys, sealer, slug)

  dirs.push(dir)

  return {
    dir,
    owner,
    agentKey,
    store: createMandateStore({
      dir: path.join(dir, 'mandates'),
      ownerKey: owner,
      agentKey,
      ledger: createLedger({ file: path.join(dir, 'ledger.jsonl'), now: options.now ?? (() => NOW) })
    })
  }
}

const CONSTRAINTS: Constraint[] = [
  { type: 'payment.budget', amount: '2.00', currency: 'USDC' },
  { type: 'payment.amount_range', min: '0.10', max: '1.00', currency: 'USDC' },
  { type: 'payment.allowed_payees', payees: [EARN_WALLET] },
  { type: 'payment.execution_date', not_before: '2026-10-21T00:00:00Z', not_after: '2026-10-22T00:00:00Z' }
]

const closeInput = (over: Partial<Parameters<MandateStore['close']>[1]> = {}) => ({
  payTo: EARN_WALLET,
  micros: 1_000_000,
  origin: ORIGIN,
  instrument: POCKET,
  ...over
})

const issue = (l: Lab, constraints = CONSTRAINTS, ttlSeconds = 3600, agent = 'inft-7') => {
  const result = l.store.issue({ agent, constraints, ttlSeconds })

  if (!result.ok) {
    throw new Error(result.reason)
  }

  return result
}

const close = (l: Lab, jti: string, over: Partial<Parameters<MandateStore['close']>[1]> = {}) => {
  const result = l.store.close(jti, closeInput(over))

  if (!result.ok) {
    throw new Error(result.reason)
  }

  return result
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('issue → close → verify (AP2 v0.2 shape)', () => {
  it('issues an open Payment Mandate as an SD-JWT with disclosable constraints, cnf = the agent key, stored 0600', () => {
    const l = lab()
    const { record, sdjwt } = issue(l)
    const [jws, ...rest] = sdjwt.split('~')
    const header = JSON.parse(Buffer.from(jws.split('.')[0], 'base64url').toString())
    const payload = JSON.parse(Buffer.from(jws.split('.')[1], 'base64url').toString())

    expect(header).toEqual({ alg: 'ES256', typ: 'dc+sd-jwt' })
    expect(payload).toMatchObject({
      vct: VCT_OPEN,
      sub: 'inft-7',
      jti: record.jti,
      _sd_alg: 'sha-256',
      cnf: { jwk: l.agentKey('inft-7').jwk }
    })
    expect(payload.exp - payload.iat).toBe(3600)
    expect(payload.constraints).toHaveLength(4)
    expect(payload.constraints.every((entry: Record<string, string>) => typeof entry['...'] === 'string')).toBe(true)
    expect(rest).toHaveLength(5)
    expect(rest[4]).toBe('')
    expect(JSON.stringify(payload)).not.toContain('payment.budget')

    const file = path.join(l.dir, 'mandates', `${record.jti}.sdjwt`)

    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(l.store.list()).toEqual([{ ...record, revoked: false }])
  })

  it('closes with the agent key: a mandate.payment.1 JWT and a kb+sd-jwt bound by sd_hash; verify says what was paid', () => {
    const l = lab()
    const { record } = issue(l)
    const { presentation, closed } = close(l, record.jti)
    const verdict = l.store.verify(presentation, closed, NO_USE)

    expect(verdict.ok).toBe(true)

    if (verdict.ok) {
      expect(verdict.mandate).toMatchObject({
        jti: record.jti,
        agent: 'inft-7',
        payTo: EARN_WALLET,
        micros: 1_000_000,
        origin: ORIGIN,
        instrument: POCKET
      })
      expect(verdict.mandate.transactionId).toMatch(/^[0-9a-f]{32}$/)
    }

    const closedPayload = JSON.parse(Buffer.from(closed.split('.')[1], 'base64url').toString())

    expect(closedPayload).toMatchObject({
      vct: 'mandate.payment.1',
      payee: { id: EARN_WALLET, website: ORIGIN },
      payment_amount: { amount: '1.000000', currency: 'USDC' },
      payment_instrument: { id: POCKET, type: 'x402:exact:evm' },
      open_mandate: record.jti
    })
    expect(presentation.endsWith('~')).toBe(false)
  })

  it('m5 the KB-JWT is bound to ITS open mandate by sd_hash: another mandate’s KB (same agent, valid signature) on this one ⇒ key binding invalid', () => {
    const l = lab()
    const a = issue(l).record
    const b = issue(l).record
    const closedA = close(l, a.jti)
    const closedB = close(l, b.jti)
    const openA = l.store.get(a.jti) as string
    const openB = l.store.get(b.jti) as string
    const kbA = closedA.presentation.slice(openA.length)

    expect(closedA.presentation.startsWith(openA)).toBe(true)
    expect(l.store.verify(`${openB}${closedB.presentation.slice(openB.length)}`, closedB.closed, NO_USE).ok).toBe(true)
    expect(l.store.verify(`${openB}${kbA}`, closedB.closed, NO_USE)).toEqual({
      ok: false,
      reason: 'key binding invalid'
    })
  })

  it('m6 issue and revoke are written to the ledger (mandate_issue with agent, jti, budget; mandate_revoke); an unrecordable issue does not exist', () => {
    const l = lab()
    const ledger = createLedger({ file: path.join(l.dir, 'm2-ledger.jsonl'), now: () => NOW })

    const store = createMandateStore({
      dir: path.join(l.dir, 'm2'),
      ownerKey: l.owner,
      agentKey: l.agentKey,
      ledger
    })

    const issued = store.issue({ agent: 'inft-7', constraints: CONSTRAINTS, ttlSeconds: 3600 })

    if (!issued.ok) {
      throw new Error(issued.reason)
    }

    expect(store.revoke(issued.record.jti)).toBe(true)
    expect(ledger.read().records.map(row => [row.kind, row.agent, row.mandate, row.micros])).toEqual([
      ['mandate_issue', 'inft-7', issued.record.jti, 2_000_000],
      ['mandate_revoke', null, issued.record.jti, null]
    ])
    expect(ledger.read().records[0].note).toBe(
      'exp 2026-10-21T13:00:00.000Z; payment.budget, payment.amount_range, payment.allowed_payees, payment.execution_date'
    )

    fs.writeFileSync(ledger.file, fs.readFileSync(ledger.file, 'utf8').replace('mandate_revoke', 'mandate_revokE'))
    expect(store.issue({ agent: 'inft-7', constraints: CONSTRAINTS, ttlSeconds: 3600 })).toEqual({
      ok: false,
      reason: 'ledger write failed'
    })
    expect(store.list().map(record => record.jti)).toEqual([issued.record.jti])
  })

  it('one byte changed anywhere in the presentation ⇒ invalid', () => {
    const l = lab()
    const { record } = issue(l)
    const { presentation, closed } = close(l, record.jti)

    const flip = (text: string, at: number) => {
      const char = text[at] === 'A' ? 'B' : 'A'

      return text.slice(0, at) + char + text.slice(at + 1)
    }

    const jws = presentation.split('~')[0]
    const [h, p, s] = jws.split('.')
    const positions = [h.length + 1 + 3, h.length + 1 + p.length + 1 + 5, jws.length + 1 + 4, presentation.length - 10]

    for (const at of positions) {
      expect(l.store.verify(flip(presentation, at), closed, NO_USE).ok).toBe(false)
    }

    expect(l.store.verify(presentation, flip(closed, closed.length - 4), NO_USE).ok).toBe(false)
    expect(l.store.verify(presentation, flip(closed, h.length + 2), NO_USE).ok).toBe(false)
    expect(s.length).toBeGreaterThan(0)
  })

  it('a byte changed in the STORED file ⇒ invalid (the presentation must be the stored mandate)', () => {
    const l = lab()
    const { record } = issue(l)
    const { presentation, closed } = close(l, record.jti)
    const file = path.join(l.dir, 'mandates', `${record.jti}.sdjwt`)
    const text = fs.readFileSync(file, 'utf8')

    fs.writeFileSync(
      file,
      text.replace(/~([A-Za-z0-9_-])/, (_, c: string) => `~${c === 'A' ? 'B' : 'A'}`)
    )
    expect(l.store.verify(presentation, closed, NO_USE)).toMatchObject({ ok: false })
    expect(l.store.close(record.jti, closeInput())).toMatchObject({ ok: false, reason: 'no such mandate' })
  })

  it('expired ⇒ invalid; not yet valid (iat in the future beyond skew) ⇒ invalid', () => {
    const l = lab()
    const { record } = issue(l, CONSTRAINTS, 60)
    const { presentation, closed } = close(l, record.jti)

    expect(l.store.verify(presentation, closed, NO_USE, new Date(NOW.getTime() + 61_000))).toMatchObject({
      ok: false,
      reason: 'open mandate expired'
    })
    expect(l.store.verify(presentation, closed, NO_USE, new Date(NOW.getTime() - 120_000))).toMatchObject({
      ok: false,
      reason: 'open mandate not yet valid'
    })
    expect(l.store.verify(presentation, closed, NO_USE, new Date(NOW.getTime() + 59_000)).ok).toBe(true)
  })

  it('revoked ⇒ invalid, and revoke is idempotent on a stored mandate only', () => {
    const l = lab()
    const { record } = issue(l)
    const { presentation, closed } = close(l, record.jti)

    expect(l.store.revoke(record.jti)).toBe(true)
    expect(l.store.verify(presentation, closed, NO_USE)).toMatchObject({ ok: false, reason: 'open mandate revoked' })
    expect(l.store.list()[0].revoked).toBe(true)
    expect(l.store.revoke('0'.repeat(32))).toBe(false)
    expect(l.store.revoke('../etc/passwd')).toBe(false)
  })

  it('a closed mandate is single use: its transaction_id in the ledger’s used set ⇒ invalid', () => {
    const l = lab()
    const { record } = issue(l)
    const { presentation, closed } = close(l, record.jti)
    const first = l.store.verify(presentation, closed, NO_USE)

    expect(first.ok).toBe(true)

    const used = first.ok ? new Set([first.mandate.transactionId]) : new Set<string>()

    expect(l.store.verify(presentation, closed, { usedMicros: 0, usedTransactionIds: used })).toMatchObject({
      ok: false,
      reason: 'closed mandate already used'
    })
  })

  it('a closed mandate signed by ANOTHER agent’s key (cnf mismatch) ⇒ invalid', () => {
    const l = lab()
    const { record } = issue(l, CONSTRAINTS, 3600, 'inft-7')
    const other = issue(l, CONSTRAINTS, 3600, 'inft-8')
    const mine = close(l, record.jti)
    const theirs = close(l, other.record.jti)

    expect(l.store.verify(mine.presentation, theirs.closed, NO_USE).ok).toBe(false)
    expect(l.store.verify(theirs.presentation, mine.closed, NO_USE).ok).toBe(false)
  })

  it('constraints: budget exhausted, amount outside range, payee outside, outside execution window ⇒ invalid', () => {
    const l = lab()
    const { record } = issue(l)

    const budget = close(l, record.jti)

    expect(
      l.store.verify(budget.presentation, budget.closed, { usedMicros: 1_500_000, usedTransactionIds: new Set() })
    ).toMatchObject({
      ok: false,
      reason: 'mandate budget exhausted'
    })

    const high = close(l, record.jti, { micros: 1_000_001 })

    expect(l.store.verify(high.presentation, high.closed, NO_USE)).toMatchObject({
      ok: false,
      reason: 'amount outside mandate range'
    })

    const low = close(l, record.jti, { micros: 99_999 })

    expect(l.store.verify(low.presentation, low.closed, NO_USE)).toMatchObject({
      ok: false,
      reason: 'amount outside mandate range'
    })

    const payee = close(l, record.jti, { payTo: OTHER_WALLET })

    expect(l.store.verify(payee.presentation, payee.closed, NO_USE)).toMatchObject({
      ok: false,
      reason: 'payee not in mandate'
    })

    const ok = close(l, record.jti)

    expect(l.store.verify(ok.presentation, ok.closed, NO_USE, new Date('2026-10-23T00:00:00Z'))).toMatchObject({
      ok: false,
      reason: 'open mandate expired'
    })

    const longer = issue(l, CONSTRAINTS, 7 * 86_400)
    const late = close(l, longer.record.jti)

    expect(l.store.verify(late.presentation, late.closed, NO_USE, new Date('2026-10-23T00:00:00Z'))).toMatchObject({
      ok: false,
      reason: 'outside mandate execution window'
    })
  })

  it('payment.reference and payment.allowed_payment_instruments bind the closed mandate', () => {
    const l = lab()

    const ref = issue(l, [
      { type: 'payment.reference', value: 'job-42' },
      { type: 'payment.allowed_payment_instruments', instruments: [POCKET] }
    ])

    const good = close(l, ref.record.jti, { reference: 'job-42' })
    const bad = close(l, ref.record.jti, { reference: 'job-43' })
    const wrongInstrument = close(l, ref.record.jti, { reference: 'job-42', instrument: OTHER_WALLET })

    expect(l.store.verify(good.presentation, good.closed, NO_USE).ok).toBe(true)
    expect(l.store.verify(bad.presentation, bad.closed, NO_USE)).toMatchObject({
      ok: false,
      reason: 'reference mismatch'
    })
    expect(l.store.verify(wrongInstrument.presentation, wrongInstrument.closed, NO_USE)).toMatchObject({
      ok: false,
      reason: 'instrument not in mandate'
    })
  })

  it('an unknown or malformed constraint is refused at issue', () => {
    const l = lab()

    expect(
      l.store.issue({
        agent: 'inft-7',
        ttlSeconds: 60,
        constraints: [{ type: 'payment.magic' } as unknown as Constraint]
      })
    ).toMatchObject({ ok: false })
    expect(l.store.issue({ agent: 'inft-7', ttlSeconds: 60, constraints: [] })).toMatchObject({ ok: false })
    expect(
      l.store.issue({
        agent: 'inft-7',
        ttlSeconds: 60,
        constraints: [{ type: 'payment.budget', amount: '1e3', currency: 'USDC' }]
      })
    ).toMatchObject({ ok: false })
    expect(l.store.issue({ agent: 'inft-7', ttlSeconds: 0, constraints: CONSTRAINTS })).toMatchObject({ ok: false })
    expect(l.store.issue({ agent: 'inft-7', ttlSeconds: 91 * 86_400, constraints: CONSTRAINTS })).toMatchObject({
      ok: false
    })
  })

  it('mandate-issue: an exact expiry instant is kept to the second; a lifetime given twice, or not at all, is refused', () => {
    const l = lab()
    const iat = Math.floor(NOW.getTime() / 1000)
    const issued = l.store.issue({ agent: 'inft-7', expiresAt: iat + 3_600, constraints: CONSTRAINTS })

    expect(issued).toMatchObject({ ok: true, record: { iat, exp: iat + 3_600 } })
    expect(l.store.issue({ agent: 'inft-7', expiresAt: iat, constraints: CONSTRAINTS })).toMatchObject({ ok: false })
    expect(l.store.issue({ agent: 'inft-7', expiresAt: iat + 91 * 86_400, constraints: CONSTRAINTS })).toMatchObject({
      ok: false
    })
    expect(
      l.store.issue({ agent: 'inft-7', expiresAt: iat + 60, ttlSeconds: 60, constraints: CONSTRAINTS })
    ).toMatchObject({ ok: false })
    expect(l.store.issue({ agent: 'inft-7', constraints: CONSTRAINTS })).toMatchObject({ ok: false })
  })

  it('an unknown constraint inside a correctly SIGNED open mandate fails verification (spec: unknown ⇒ fail)', () => {
    const l = lab()
    const agent = l.agentKey('inft-7')
    const b64u = (data: Buffer | string) => Buffer.from(data).toString('base64url')
    const disclose = (value: unknown) => b64u(JSON.stringify([randomBytes(16).toString('base64url'), value]))
    const digest = (text: string) => b64u(createHash('sha256').update(text).digest())

    const jws = (header: unknown, payload: unknown, key: NonNullable<P256Key['privateKey']>) => {
      const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`

      return `${input}.${b64u(sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }))}`
    }

    const jti = randomBytes(16).toString('hex')
    const iat = Math.floor(NOW.getTime() / 1000)

    const disclosures = [
      disclose({ type: 'payment.budget', amount: '2.00', currency: 'USDC' }),
      disclose({ type: 'payment.anything_goes' })
    ]

    const open = `${jws(
      { alg: 'ES256', typ: 'dc+sd-jwt' },
      {
        vct: VCT_OPEN,
        iss: 'icloneos:owner',
        sub: 'inft-7',
        jti,
        iat,
        exp: iat + 600,
        cnf: { jwk: agent.jwk },
        constraints: disclosures.map(d => ({ '...': digest(d) })),
        _sd_alg: 'sha-256'
      },
      l.owner.privateKey as NonNullable<P256Key['privateKey']>
    )}~${disclosures.join('~')}~`

    fs.mkdirSync(path.join(l.dir, 'mandates'), { recursive: true })
    fs.writeFileSync(path.join(l.dir, 'mandates', `${jti}.sdjwt`), `${open}\n`)

    expect(l.store.list()).toEqual([])
    expect(l.store.close(jti, closeInput())).toMatchObject({ ok: false, reason: 'no such mandate' })

    const sdHash = digest(open)
    const key = agent.privateKey as NonNullable<P256Key['privateKey']>

    const closed = jws(
      { alg: 'ES256', typ: 'mandate.payment.1' },
      {
        vct: 'mandate.payment.1',
        iss: 'icloneos:agent:inft-7',
        jti: 'a'.repeat(32),
        iat,
        transaction_id: 'a'.repeat(32),
        payee: { id: EARN_WALLET },
        payment_amount: { amount: '1.00', currency: 'USDC' },
        payment_instrument: { id: POCKET, type: 'x402:exact:evm' },
        open_mandate: jti,
        sd_hash: sdHash
      },
      key
    )

    const kb = jws({ alg: 'ES256', typ: 'kb+sd-jwt' }, { iat, aud: ORIGIN, nonce: 'n', sd_hash: sdHash }, key)

    expect(l.store.verify(`${open}${kb}`, closed, NO_USE)).toMatchObject({
      ok: false,
      reason: 'open mandate signature or disclosures invalid'
    })
  })

  it('an open mandate whose cnf is NOT this agent’s key (correctly owner-signed) cannot be closed by the agent: cnf mismatch ⇒ invalid', () => {
    const l = lab()
    const stranger = l.agentKey('inft-stranger')
    const b64u = (data: Buffer | string) => Buffer.from(data).toString('base64url')
    const disclose = (value: unknown) => b64u(JSON.stringify([randomBytes(16).toString('base64url'), value]))
    const digest = (text: string) => b64u(createHash('sha256').update(text).digest())

    const jws = (header: unknown, payload: unknown, key: NonNullable<P256Key['privateKey']>) => {
      const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`

      return `${input}.${b64u(sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }))}`
    }

    const jti = randomBytes(16).toString('hex')
    const iat = Math.floor(NOW.getTime() / 1000)
    const disclosures = [disclose({ type: 'payment.budget', amount: '2.00', currency: 'USDC' })]

    const open = `${jws(
      { alg: 'ES256', typ: 'dc+sd-jwt' },
      {
        vct: VCT_OPEN,
        iss: 'icloneos:owner',
        sub: 'inft-7',
        jti,
        iat,
        exp: iat + 600,
        cnf: { jwk: stranger.jwk },
        constraints: disclosures.map(d => ({ '...': digest(d) })),
        _sd_alg: 'sha-256'
      },
      l.owner.privateKey as NonNullable<P256Key['privateKey']>
    )}~${disclosures.join('~')}~`

    fs.mkdirSync(path.join(l.dir, 'mandates'), { recursive: true })
    fs.writeFileSync(path.join(l.dir, 'mandates', `${jti}.sdjwt`), `${open}\n`)
    expect(l.store.list()).toHaveLength(1)

    const closed = close(l, jti)

    expect(l.store.verify(closed.presentation, closed.closed, NO_USE)).toEqual({
      ok: false,
      reason: 'cnf key is not this agent’s key'
    })
  })

  it('a presentation without a key-binding JWT, or with a disclosure missing, ⇒ invalid', () => {
    const l = lab()
    const { record, sdjwt } = issue(l)
    const { presentation, closed } = close(l, record.jti)

    expect(l.store.verify(sdjwt, closed, NO_USE)).toMatchObject({ ok: false, reason: 'presentation malformed' })

    const parts = presentation.split('~')
    const missing = [parts[0], ...parts.slice(2)].join('~')

    expect(l.store.verify(missing, closed, NO_USE).ok).toBe(false)
  })

  it('no sealer ⇒ no keys ⇒ issue and close refuse with the reason; nothing is written', () => {
    const l = lab({ sealer: null })

    expect(l.store.issue({ agent: 'inft-7', ttlSeconds: 60, constraints: CONSTRAINTS })).toEqual({
      ok: false,
      reason: 'OS sealing unavailable (Keychain setting off)'
    })
    expect(fs.existsSync(path.join(l.dir, 'keys'))).toBe(false)
    expect(fs.existsSync(path.join(l.dir, 'mandates'))).toBe(false)
  })

  it('an agent slug that is not a name cannot name a key file', () => {
    const l = lab()

    expect(l.store.issue({ agent: '../owner', ttlSeconds: 60, constraints: CONSTRAINTS })).toMatchObject({
      ok: false,
      reason: 'agent slug is not a name'
    })
    expect(l.store.get('../../x')).toBeNull()
  })
})

describe('merge-clocks — the mandate store reads the payments ledger’s clock, never its own', () => {
  it('merge-clocks: `now:` is not a dep (a type error, ignored at runtime); iat, the issue row, the revocation and a verify without `at` all read ledger.now', () => {
    const l = lab()
    let t = NOW.getTime()
    const ledger = createLedger({ file: path.join(l.dir, 'clock-ledger.jsonl'), now: () => new Date(t) })

    const store = createMandateStore({
      dir: path.join(l.dir, 'clock'),
      ownerKey: l.owner,
      agentKey: l.agentKey,
      ledger,
      // @ts-expect-error — the store has no clock of its own (merge round): the only clock is `ledger.now`.
      now: () => new Date('2030-01-01T00:00:00.000Z')
    })

    const issued = store.issue({ agent: 'inft-7', constraints: CONSTRAINTS, ttlSeconds: 3600 })

    if (!issued.ok) {
      throw new Error(issued.reason)
    }

    expect(issued.record.iat).toBe(NOW.getTime() / 1000)
    expect(issued.record.exp).toBe(NOW.getTime() / 1000 + 3600)

    const closed = store.close(issued.record.jti, closeInput())

    if (!closed.ok) {
      throw new Error(closed.reason)
    }

    expect(store.verify(closed.presentation, closed.closed, NO_USE)).toMatchObject({ ok: true })

    // Two hours later on the LEDGER's clock: the same presentation, judged without `at`, is expired.
    t += 2 * 3600 * 1000
    expect(store.verify(closed.presentation, closed.closed, NO_USE)).toEqual({
      ok: false,
      reason: 'open mandate expired'
    })

    expect(store.revoke(issued.record.jti)).toBe(true)

    const later = new Date(t).toISOString()

    expect(fs.readFileSync(path.join(l.dir, 'clock', `${issued.record.jti}.revoked`), 'utf8').trim()).toBe(later)
    expect(ledger.read().records.map(row => [row.kind, row.ts])).toEqual([
      ['mandate_issue', NOW.toISOString()],
      ['mandate_revoke', later]
    ])
  })
})

describe('constraint parsing and evaluation', () => {
  it('parseConstraint is strict on shape and currency', () => {
    expect(parseConstraint({ type: 'payment.budget', amount: '1.5', currency: 'USDC' })).toEqual({
      type: 'payment.budget',
      amount: '1.5',
      currency: 'USDC'
    })
    expect(parseConstraint({ type: 'payment.budget', amount: '1.5', currency: 'EUR' })).toBeNull()
    expect(parseConstraint({ type: 'payment.amount_range', min: '2', max: '1', currency: 'USDC' })).toBeNull()
    expect(parseConstraint({ type: 'payment.allowed_payees', payees: ['nope'] })).toBeNull()
    expect(parseConstraint({ type: 'payment.allowed_payees', payees: [] })).toBeNull()
    expect(parseConstraint({ type: 'payment.execution_date', not_before: 'soon', not_after: 'later' })).toBeNull()
    expect(parseConstraint({ type: 'payment.reference', value: '' })).toBeNull()
    expect(parseConstraint({ type: 'payment.unknown' })).toBeNull()
    expect(parseConstraint('payment.budget')).toBeNull()
  })

  it('evaluateConstraints names the first miss and fails on an unknown type', () => {
    const closed = { payTo: EARN_WALLET, micros: 500_000, instrument: POCKET }

    expect(evaluateConstraints(CONSTRAINTS, closed, 0, NOW)).toBeNull()
    expect(evaluateConstraints(CONSTRAINTS, closed, 1_600_000, NOW)).toBe('mandate budget exhausted')
    expect(evaluateConstraints([{ type: 'payment.rocket' } as unknown as Constraint], closed, 0, NOW)).toBe(
      'unknown constraint'
    )
  })

  it('microsOfDecimal accepts ≤ 6 places and nothing else', () => {
    expect(microsOfDecimal('1')).toBe(1_000_000)
    expect(microsOfDecimal('0.000001')).toBe(1)
    expect(microsOfDecimal('1.0000001')).toBeNull()
    expect(microsOfDecimal('-1')).toBeNull()
    expect(microsOfDecimal('1e3')).toBeNull()
    expect(microsOfDecimal(1)).toBeNull()
  })
})
