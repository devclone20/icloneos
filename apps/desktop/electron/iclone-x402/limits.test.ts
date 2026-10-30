import { describe, expect, it } from 'vitest'

import { ALLOWLIST_MAX } from '../../src/iclone-shared/payments'

import {
  allowedNetwork,
  allowlistProblem,
  DEFAULTS,
  evaluatePayment,
  normalizeSettings,
  type PaymentSettings,
  type SignedRow,
  signedToday,
  widens
} from './limits'

const PAYEE = '0x1111111111111111111111111111111111111111'
const ORIGIN = 'https://pay.example'
const NOW = new Date('2026-10-21T12:00:00.000Z')

const withList = (over: Partial<PaymentSettings> = {}): PaymentSettings => ({
  ...DEFAULTS,
  payees: [PAYEE],
  origins: [ORIGIN],
  ...over
})

/** The owner's edited set of gate J3: 0.50 / 2.00 / 1.00 USDC, one payee. */
const EDITED = withList({ perTxMicros: 500_000, perDayMicros: 2_000_000, perAgentDayMicros: 1_000_000 })

const attempt = (over: Partial<Parameters<typeof evaluatePayment>[0]> = {}) => ({
  agent: 'inft-7',
  micros: 1_000_000,
  payTo: PAYEE,
  resource: `${ORIGIN}/paid/one`,
  stopFile: false,
  ...over
})

const okLedger = (signed: SignedRow[] = []) => ({ ok: true, signed })
const row = (micros: number, agent = 'inft-7', ts = '2026-10-21T08:00:00.000Z'): SignedRow => ({ ts, agent, micros })

describe('DEFAULTS — the one place the shipped numbers live', () => {
  it('ships 1.00 / 5.00 / 2.00 USDC, nobody allowlisted, stop off, testnet, mainnet off', () => {
    expect(DEFAULTS).toMatchObject({
      perTxMicros: 1_000_000,
      perDayMicros: 5_000_000,
      perAgentDayMicros: 2_000_000,
      payees: [],
      origins: [],
      stop: false,
      network: 'eip155:84532',
      mainnetEnabled: false,
      signer: 'pocket',
      v1Servers: 'refuse',
      mandateStorage: 'local'
    })
    expect(Object.isFrozen(DEFAULTS)).toBe(true)
  })
})

describe('normalizeSettings — a user file in, a sane set out', () => {
  it('keeps a complete edited set', () => {
    expect(normalizeSettings(EDITED)).toEqual(EDITED)
  })

  it('a malformed cap is the DEFAULT for that field, never infinity', () => {
    for (const bad of [Number.POSITIVE_INFINITY, -1, 1.5, '5', null, Number.NaN, 2 ** 53]) {
      expect(normalizeSettings({ perTxMicros: bad, perDayMicros: bad, perAgentDayMicros: bad })).toMatchObject({
        perTxMicros: DEFAULTS.perTxMicros,
        perDayMicros: DEFAULTS.perDayMicros,
        perAgentDayMicros: DEFAULTS.perAgentDayMicros
      })
    }
  })

  it('drops "*", non-addresses and non-origins from the allowlists; lowercases and dedupes', () => {
    const out = normalizeSettings({
      payees: ['*', PAYEE.toUpperCase().replace('0X', '0x'), PAYEE, 'nope'],
      origins: ['*', 'https://pay.example/some/path?x=1', 'pay.example', 'ftp://x', ORIGIN]
    })

    expect(out.payees).toEqual([PAYEE])
    expect(out.origins).toEqual([ORIGIN])
  })

  it('a non-object, an array or garbage is the defaults', () => {
    for (const raw of [null, 'x', [], 42, undefined]) {
      expect(normalizeSettings(raw)).toEqual({ ...DEFAULTS })
    }
  })

  it('booleans must be exactly true; enums must be known', () => {
    expect(normalizeSettings({ stop: 'true', mainnetEnabled: 1 })).toMatchObject({ stop: false, mainnetEnabled: false })
    expect(normalizeSettings({ stop: true, mainnetEnabled: true })).toMatchObject({ stop: true, mainnetEnabled: true })
    expect(
      normalizeSettings({ signer: 'privy', network: 'eip155:1', v1Servers: 'pay', mandateStorage: 'irys' })
    ).toMatchObject({
      signer: 'pocket',
      network: 'eip155:84532',
      v1Servers: 'refuse',
      mandateStorage: 'local'
    })
  })
})

describe('evaluatePayment with the DEFAULTS', () => {
  const settings = withList()

  it('allows 1.00 to an allowlisted payee and origin on an empty day', () => {
    expect(evaluatePayment(attempt(), settings, okLedger(), NOW)).toEqual({ ok: true, dayMicros: 0, agentDayMicros: 0 })
  })

  it('per_tx: cap + 0.01 is refused', () => {
    expect(evaluatePayment(attempt({ micros: 1_010_000 }), settings, okLedger(), NOW)).toMatchObject({
      ok: false,
      rule: 'per_tx'
    })
  })

  it('per_tx: zero, negative and non-integer amounts are refused', () => {
    for (const micros of [0, -1, 0.5, Number.NaN]) {
      expect(evaluatePayment(attempt({ micros }), settings, okLedger(), NOW)).toMatchObject({
        ok: false,
        rule: 'per_tx'
      })
    }
  })

  it('payee: a non-allowlisted payTo is refused; the default (empty) allowlist refuses everyone', () => {
    expect(
      evaluatePayment(attempt({ payTo: '0x2222222222222222222222222222222222222222' }), settings, okLedger(), NOW)
    ).toMatchObject({
      ok: false,
      rule: 'payee'
    })
    expect(evaluatePayment(attempt(), { ...settings, payees: [] }, okLedger(), NOW)).toMatchObject({
      ok: false,
      rule: 'payee'
    })
  })

  it('payee: the allowlist compares addresses case-insensitively', () => {
    const checksummed = '0x1111111111111111111111111111111111111111'.replace('0x1111', '0x1111')

    expect(
      evaluatePayment(attempt({ payTo: checksummed.toUpperCase().replace('0X', '0x') }), settings, okLedger(), NOW).ok
    ).toBe(true)
  })

  it('origin: a resource on another origin is refused, including a sibling port and a different scheme', () => {
    for (const resource of [
      'https://evil.example/paid',
      'https://pay.example:8443/paid',
      'http://pay.example/paid',
      'not a url'
    ]) {
      expect(evaluatePayment(attempt({ resource }), settings, okLedger(), NOW)).toMatchObject({
        ok: false,
        rule: 'origin'
      })
    }
  })

  it('x402-pay: a p2p send has no origin rule — only the literal p2p flag skips it; the payee allowlist still binds', () => {
    const p2p = attempt({ resource: 'p2p:0x1111111111111111111111111111111111111111', p2p: true })

    expect(evaluatePayment(p2p, { ...settings, origins: [] }, okLedger(), NOW).ok).toBe(true)
    expect(
      evaluatePayment({ ...p2p, payTo: '0x2222222222222222222222222222222222222222' }, settings, okLedger(), NOW)
    ).toMatchObject({ ok: false, rule: 'payee' })
    expect(evaluatePayment({ ...p2p, micros: 1_010_000 }, settings, okLedger(), NOW)).toMatchObject({
      ok: false,
      rule: 'per_tx'
    })

    for (const flag of [undefined, false, 'true', 1]) {
      expect(
        evaluatePayment({ ...p2p, p2p: flag as unknown as true }, settings, okLedger(), NOW),
        String(flag)
      ).toMatchObject({ ok: false, rule: 'origin' })
    }
  })

  it('per_day: the day is derived from the ledger — the 6th 1.00 of the UTC day crosses 5.00', () => {
    const signed = [
      row(1_000_000, 'a'),
      row(1_000_000, 'a'),
      row(1_000_000, 'b'),
      row(1_000_000, 'b'),
      row(1_000_000, 'c')
    ]

    expect(evaluatePayment(attempt({ agent: 'c' }), settings, okLedger(signed), NOW)).toMatchObject({
      ok: false,
      rule: 'per_day'
    })
  })

  it('per_day: yesterday’s rows do not count (UTC), and 23:59:59Z is still today', () => {
    const yesterday = [row(5_000_000, 'a', '2026-10-20T23:59:59.000Z')]
    const today = [row(5_000_000, 'a', '2026-10-21T00:00:00.000Z')]

    expect(evaluatePayment(attempt({ agent: 'b' }), settings, okLedger(yesterday), NOW).ok).toBe(true)
    expect(evaluatePayment(attempt({ agent: 'b' }), settings, okLedger(today), NOW)).toMatchObject({
      ok: false,
      rule: 'per_day'
    })
  })

  it('per_agent_day: the 3rd 1.00 of one agent crosses 2.00 while the day is still under 5.00', () => {
    const signed = [row(1_000_000), row(1_000_000)]

    expect(evaluatePayment(attempt(), settings, okLedger(signed), NOW)).toMatchObject({
      ok: false,
      rule: 'per_agent_day'
    })
    expect(evaluatePayment(attempt({ agent: 'other' }), settings, okLedger(signed), NOW).ok).toBe(true)
  })

  it('stop: the setting and the STOP file each refuse before anything else is looked at', () => {
    expect(evaluatePayment(attempt({ micros: 5 }), { ...settings, stop: true }, okLedger(), NOW)).toMatchObject({
      ok: false,
      rule: 'stop'
    })
    expect(evaluatePayment(attempt({ stopFile: true }), settings, okLedger(), NOW)).toMatchObject({
      ok: false,
      rule: 'stop'
    })
  })

  it('ledger: a chain that does not verify refuses everything', () => {
    expect(evaluatePayment(attempt(), settings, { ok: false, signed: [] }, NOW)).toMatchObject({
      ok: false,
      rule: 'ledger'
    })
  })

  it('the rules are checked in the documented order: stop before per_tx before payee before origin before the days', () => {
    const everythingWrong = attempt({
      micros: 9_000_000,
      payTo: '0x2222222222222222222222222222222222222222',
      resource: 'https://evil/x'
    })

    expect(evaluatePayment(everythingWrong, { ...settings, stop: true }, okLedger(), NOW)).toMatchObject({
      rule: 'stop'
    })
    expect(evaluatePayment(everythingWrong, settings, okLedger(), NOW)).toMatchObject({ rule: 'per_tx' })
    expect(evaluatePayment({ ...everythingWrong, micros: 1 }, settings, okLedger(), NOW)).toMatchObject({
      rule: 'payee'
    })
    expect(evaluatePayment({ ...everythingWrong, micros: 1, payTo: PAYEE }, settings, okLedger(), NOW)).toMatchObject({
      rule: 'origin'
    })
  })
})

describe('evaluatePayment with the owner’s EDITED set (0.50 / 2.00 / 1.00, one payee)', () => {
  it('allows 0.50, refuses 0.51', () => {
    expect(evaluatePayment(attempt({ micros: 500_000 }), EDITED, okLedger(), NOW).ok).toBe(true)
    expect(evaluatePayment(attempt({ micros: 510_000 }), EDITED, okLedger(), NOW)).toMatchObject({
      ok: false,
      rule: 'per_tx'
    })
  })

  it('per_agent_day 1.00: the third 0.50 of one agent is refused', () => {
    const signed = [row(500_000), row(500_000)]

    expect(evaluatePayment(attempt({ micros: 500_000 }), EDITED, okLedger(signed), NOW)).toMatchObject({
      ok: false,
      rule: 'per_agent_day'
    })
  })

  it('per_day 2.00: the fifth 0.50 across agents is refused', () => {
    const signed = [row(500_000, 'a'), row(500_000, 'a'), row(500_000, 'b'), row(500_000, 'b')]

    expect(evaluatePayment(attempt({ micros: 500_000, agent: 'c' }), EDITED, okLedger(signed), NOW)).toMatchObject({
      ok: false,
      rule: 'per_day'
    })
  })

  it('one payee: the other wallet is refused', () => {
    expect(
      evaluatePayment(
        attempt({ micros: 500_000, payTo: '0x2222222222222222222222222222222222222222' }),
        EDITED,
        okLedger(),
        NOW
      )
    ).toMatchObject({
      ok: false,
      rule: 'payee'
    })
  })

  it('lowering a cap under the day’s spend refuses the next payment immediately', () => {
    const signed = [row(1_000_000), row(1_000_000)]

    expect(evaluatePayment(attempt({ micros: 500_000 }), EDITED, okLedger(signed), NOW)).toMatchObject({
      ok: false,
      rule: 'per_day'
    })
    expect(
      evaluatePayment(attempt({ micros: 500_000 }), { ...EDITED, perDayMicros: 5_000_000 }, okLedger(signed), NOW)
    ).toMatchObject({ ok: false, rule: 'per_agent_day' })
  })
})

describe('signedToday', () => {
  it('sums one UTC day, optionally one agent', () => {
    const signed = [row(1, 'a'), row(2, 'b'), row(4, 'a', '2026-10-20T12:00:00.000Z')]

    expect(signedToday(signed, NOW)).toBe(3)
    expect(signedToday(signed, NOW, 'a')).toBe(1)
    expect(signedToday(signed, new Date('2026-10-20T00:00:00Z'), 'a')).toBe(4)
  })
})

describe('allowedNetwork and widens', () => {
  it('mainnet is refused until the user flips its switch', () => {
    expect(allowedNetwork(withList({ network: 'eip155:8453' }))).toBeNull()
    expect(allowedNetwork(withList({ network: 'eip155:8453', mainnetEnabled: true }))).toBe('eip155:8453')
    expect(allowedNetwork(withList())).toBe('eip155:84532')
  })

  it('raising a cap, widening a list, enabling mainnet or clearing the stop is a widening (floor 5 asks); lowering is not', () => {
    const base = withList()

    expect(widens(base, withList({ perTxMicros: 1_000_001 })).widens).toBe(true)
    expect(widens(base, withList({ perDayMicros: 5_000_001 })).widens).toBe(true)
    expect(widens(base, withList({ perAgentDayMicros: 2_000_001 })).widens).toBe(true)
    expect(widens(base, withList({ payees: [PAYEE, '0x2222222222222222222222222222222222222222'] })).widens).toBe(true)
    expect(widens(base, withList({ origins: [ORIGIN, 'https://other.example'] })).widens).toBe(true)
    expect(widens(base, withList({ mainnetEnabled: true })).widens).toBe(true)
    expect(widens(base, withList({ v1Servers: 'agentcard' })).widens).toBe(true)
    expect(widens(withList({ stop: true }), base).widens).toBe(true)
    expect(widens(base, withList({ signer: 'agentcard' })).widens).toBe(true)
    expect(widens(base, withList({ mandateStorage: 'local+irys' })).widens).toBe(true)
    expect(widens(base, EDITED).widens).toBe(false)
    expect(widens(base, withList({ payees: [] })).widens).toBe(false)
    expect(widens(base, withList({ stop: true })).widens).toBe(false)
    expect(widens(base, base)).toEqual({ widens: false, changes: [] })
  })

  it('m6 widens() is a per-axis diff for the sheet: every changed axis old → new, each flagged, lists with added / removed', () => {
    const base = withList()
    const OTHER = '0x2222222222222222222222222222222222222222'

    const diff = widens(base, {
      ...base,
      perTxMicros: 500_000,
      perDayMicros: 9_000_000,
      payees: [OTHER],
      mainnetEnabled: true,
      stop: true
    })

    expect(diff.widens).toBe(true)
    expect(diff.changes).toEqual([
      { axis: 'mainnetEnabled', from: false, to: true, widens: true },
      { axis: 'perTxMicros', from: 1_000_000, to: 500_000, widens: false },
      { axis: 'perDayMicros', from: 5_000_000, to: 9_000_000, widens: true },
      { axis: 'payees', from: [PAYEE], to: [OTHER], widens: true, added: [OTHER], removed: [PAYEE] },
      { axis: 'stop', from: false, to: true, widens: false }
    ])

    // The owner's edited set from the defaults: three lowered caps, nothing widening — applied at once.
    expect(widens(base, EDITED).changes.map(change => [change.axis, change.widens])).toEqual([
      ['perTxMicros', false],
      ['perDayMicros', false],
      ['perAgentDayMicros', false]
    ])
  })
})

describe('Jm1: allowlists are bounded, and a malformed change is refused with the entries named', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`)

  it('Jm1: at most 50 entries per list — 50 is fine, 51 or the critic’s 2001 are refused with the count', () => {
    expect(ALLOWLIST_MAX).toBe(50)
    expect(allowlistProblem({ payees: many(50) })).toBeNull()
    expect(allowlistProblem({ payees: many(51) })).toBe('payees: 51 entries, at most 50')
    expect(allowlistProblem({ payees: [PAYEE, ...many(2000)] })).toBe('payees: 2001 entries, at most 50')
    expect(allowlistProblem({ origins: Array.from({ length: 51 }, (_, i) => `https://s${i}.example`) })).toBe(
      'origins: 51 entries, at most 50'
    )
  })

  it('Jm1: the critic’s odd list (duplicate, a name, non-hex, a leading space) is refused naming each, never reduced to 1', () => {
    const problem = allowlistProblem({
      payees: [PAYEE, PAYEE.toUpperCase().replace('0X', '0x'), 'vitalik.eth', `0x${'g'.repeat(40)}`, ` ${PAYEE}`]
    })

    expect(problem).toBe(`payees: "${PAYEE}", "vitalik.eth", "0x${'g'.repeat(40)}", " ${PAYEE}"`)
    // A checksummed (mixed-case) address is an address: accepted, stored lowercase. Its lowercase twin is a repeat.
    const mixed = `0x${'aB'.repeat(20)}`

    expect(allowlistProblem({ payees: [mixed] })).toBeNull()
    expect(allowlistProblem({ payees: [mixed, mixed.toLowerCase()] })).toMatch(/^payees: "0xabab/)
  })

  it('Jm1: an origin must be exactly an origin; not a list, a non-string or six bad entries are named and bounded', () => {
    expect(allowlistProblem({ origins: [ORIGIN] })).toBeNull()
    expect(allowlistProblem({ origins: [`${ORIGIN}/`, `${ORIGIN}/path`, ` ${ORIGIN}`, 'ftp://x.example'] })).toBe(
      `origins: "${ORIGIN}/", "${ORIGIN}/path", " ${ORIGIN}", "ftp://x.example"`
    )
    expect(allowlistProblem({ payees: 'all' })).toBe('payees: not a list')
    expect(allowlistProblem({ payees: [1, null, {}, 'a', 'b', 'c'] })).toBe(
      'payees: (number), (null), (object), "a", "b" (+1 more)'
    )
    expect(allowlistProblem({ payees: [`${'x'.repeat(200)}`] })?.length).toBeLessThan(80)
    // Lists the request does not carry are not checked (a caps-only change), and both lists are reported together.
    expect(allowlistProblem({ perTxMicros: 1 })).toBeNull()
    expect(allowlistProblem({ payees: ['x'], origins: ['y'] })).toBe('payees: "x"; origins: "y"')
  })

  it('Jm1: a stored file holding more than 50 is read back bounded (the backstop; changes never store one)', () => {
    expect(normalizeSettings({ payees: many(80) }).payees).toHaveLength(50)
  })
})
