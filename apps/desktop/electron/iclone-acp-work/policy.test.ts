import { describe, expect, it } from 'vitest'

import type { PolicyRule } from '../../src/iclone-shared/acp-work'

import {
  DEFAULT_POLICY,
  EARN_ONLY,
  earnOnlyArgv,
  evaluateOffer,
  spendAllowed,
  type WorkOffer,
  type WorkPolicy
} from './policy'

const CLIENT = '0x00000000000000000000000000000000000000bb'

const offer = (patch: Partial<WorkOffer> = {}): WorkOffer => ({
  jobId: '7',
  chainId: 8453,
  title: 'research',
  requester: CLIENT,
  priceMicros: 5_000_000,
  token: 'USDC',
  capitalMicros: 0,
  requestBytes: 200,
  ...patch
})

const policy = (patch: Partial<WorkPolicy> = {}): WorkPolicy => ({ ...DEFAULT_POLICY, ...patch })

describe('evaluateOffer', () => {
  it('passes an offer inside the default policy', () => {
    expect(evaluateOffer(offer(), policy(), 0)).toEqual({ ok: true })
  })

  // I4: twelve offers outside the policy, every one refused with its rule named; 0 accepted.
  const outside: Array<[string, WorkOffer, WorkPolicy, number, PolicyRule]> = [
    ['fee under the floor', offer({ priceMicros: 999_999 }), policy(), 0, 'price-floor'],
    ['no fee stated', offer({ priceMicros: null }), policy(), 0, 'price-floor'],
    ['forbidden class', offer({ title: 'Trading' }), policy({ deniedClasses: ['trading'] }), 0, 'class'],
    ['class not on the allow list', offer({ title: 'memes' }), policy({ allowedClasses: ['research'] }), 0, 'class'],
    ['over the open-job cap', offer(), policy({ maxOpenJobs: 2 }), 2, 'open-cap'],
    [
      'unknown requester',
      offer(),
      policy({ requesterAllow: ['0x1111111111111111111111111111111111111111'] }),
      0,
      'requester-unknown'
    ],
    ['no requester at all', offer({ requester: '' }), policy(), 0, 'requester-unknown'],
    ['denied requester', offer(), policy({ requesterDeny: [CLIENT.toUpperCase()] }), 0, 'requester-denied'],
    ['forbidden token', offer({ token: 'VIRTUAL' }), policy(), 0, 'token'],
    ['oversize request', offer({ requestBytes: 16_385 }), policy(), 0, 'oversize'],
    ['asks for working capital', offer({ capitalMicros: 1 }), policy(), 0, 'spend'],
    ['another chain', offer({ chainId: 1 }), policy(), 0, 'chain']
  ]

  it.each(outside)('refuses %s', (_name, input, rules, open, rule) => {
    expect(evaluateOffer(input, rules, open)).toEqual({ ok: false, rule })
  })

  it('refuses 12/12 and accepts none', () => {
    const verdicts = outside.map(([, input, rules, open]) => evaluateOffer(input, rules, open))

    expect(verdicts.filter(verdict => verdict.ok)).toHaveLength(0)
    expect(verdicts).toHaveLength(12)
  })

  it('names the spend rule first when several apply', () => {
    expect(evaluateOffer(offer({ capitalMicros: 5, token: 'X', priceMicros: null }), policy(), 9)).toEqual({
      ok: false,
      rule: 'spend'
    })
  })

  it('negative control: with the checks removed the twelve would pass (I9)', () => {
    const open = policy({
      minPriceMicros: 0,
      maxOpenJobs: 99,
      maxRequestBytes: 1e9,
      allowedTokens: ['USDC', 'VIRTUAL'],
      allowedChains: [8453, 1],
      deniedClasses: []
    })

    const passing = outside
      .map(([, input]) => input)
      .filter(input => input.priceMicros !== null && input.requester && input.capitalMicros === 0)

    expect(passing.length).toBeGreaterThan(0)
    expect(passing.every(input => evaluateOffer(input, open, 0).ok)).toBe(true)
  })
})

describe('earnOnlyArgv — the one door a watchdog write goes through', () => {
  it('admits a quote and a delivery', () => {
    expect(
      earnOnlyArgv(['provider', 'set-budget', '--job-id', '7', '--amount', '5', '--chain-id', '8453'])
    ).not.toBeNull()
    expect(
      earnOnlyArgv(['provider', 'submit', '--job-id', '7', '--deliverable', 'https://x', '--chain-id', '8453'])
    ).not.toBeNull()
  })

  // Every verb that moves this iNFT's value, hires or pays: 0 admitted (I5, D2).
  const spends = [
    ['client', 'fund', '--job-id', '7'],
    ['client', 'create-job', '--provider', '0xabc', '--offering', 'x'],
    ['client', 'create-custom-job', '--provider', '0xabc'],
    ['client', 'complete', '--job-id', '7'],
    ['client', 'reject', '--job-id', '7'],
    ['provider', 'set-budget-with-fund-request', '--job-id', '7', '--amount', '5', '--chain-id', '8453'],
    ['wallet', 'send-transaction', '--to', '0xabc'],
    ['wallet', 'topup'],
    ['trade', '--swap'],
    ['subscription', 'create', '--name', 'x'],
    ['card', 'create'],
    ['provider', 'submit', '--job-id', '7', '--deliverable', 'x', '--transfer-amount', '5'],
    ['provider', 'submit', '--job-id', '7', '--deliverable', 'x', '--chain-id', '8453', '--transfer-token', '0xabc'],
    ['provider', 'set-budget', '--job-id', '7', '--amount', '5', '--chain-id', '--dry-run']
  ]

  it.each(spends.map(argv => [argv.slice(0, 2).join(' '), argv]))('refuses %s', (_name, argv) => {
    expect(earnOnlyArgv(argv as string[])).toBeNull()
  })

  it('refuses malformed earn verbs', () => {
    expect(earnOnlyArgv(['provider', 'set-budget', '--job-id', '7', '--amount', '-1', '--chain-id', '8453'])).toBeNull()
    expect(
      earnOnlyArgv(['provider', 'set-budget', '--job-id', '7;rm', '--amount', '1', '--chain-id', '8453'])
    ).toBeNull()
    expect(earnOnlyArgv(['provider', 'submit', '--job-id', '7', '--deliverable', '', '--chain-id', '8453'])).toBeNull()
    expect(earnOnlyArgv(['provider', 'set-budget', '--job-id', '7', '--amount', '1'])).toBeNull()
  })
})

describe('spendAllowed — D2 caps', () => {
  const facts = { amountMicros: 1, perJobCapMicros: 10, perDayCapMicros: 10, spentTodayMicros: 0, earnOnly: EARN_ONLY }

  it('earn-only is compiled in', () => {
    expect(EARN_ONLY).toBe(true)
  })

  it('blocks any spend above zero under earn-only, whatever the caps', () => {
    expect(spendAllowed(facts)).toBe(false)
    expect(spendAllowed({ ...facts, perJobCapMicros: Infinity, perDayCapMicros: Infinity })).toBe(false)
  })

  it('a zero spend is not a spend', () => {
    expect(spendAllowed({ ...facts, amountMicros: 0 })).toBe(true)
  })

  it('without earn-only the per-job and per-day caps decide', () => {
    const open = { ...facts, earnOnly: false }

    expect(spendAllowed({ ...open, amountMicros: 11 })).toBe(false)
    expect(spendAllowed({ ...open, amountMicros: 5, spentTodayMicros: 6 })).toBe(false)
    expect(spendAllowed({ ...open, amountMicros: 5, spentTodayMicros: 5 })).toBe(true)
  })

  it('negative control: caps widened to infinity with earn-only lifted lets a spend through (I9)', () => {
    expect(
      spendAllowed({
        ...facts,
        earnOnly: false,
        perJobCapMicros: Infinity,
        perDayCapMicros: Infinity,
        amountMicros: 1e12
      })
    ).toBe(true)
  })
})
