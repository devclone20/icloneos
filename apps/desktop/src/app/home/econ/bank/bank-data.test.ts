import { beforeEach, describe, expect, it, vi } from 'vitest'

import { $acpConfigMap } from '../../acp-setup'
import { $econBadges, clearEconBadges } from '../badges'
import { type AcpFailure, acpJson, type AcpResult } from '../cli'
import { prefetchesSettled } from '../live'
import { clearSnapshot, readSnapshot, writeSnapshot } from '../snapshot'

import {
  cli3ds,
  CLI_LIMIT,
  CLI_NOT_SIGNED_UP,
  CLI_PROFILE,
  CLI_REQUEST_CAPTURED,
  CLI_REQUEST_OPEN,
  CLI_WHOAMI,
  CLI_WHOAMI_UNVERIFIED
} from './bank-cli-fixtures'
import {
  BANK_SNAPSHOT_VERSION,
  BANK_TTL_MS,
  bankBadgeCount,
  type CardLimit,
  centsToUsd,
  codeAmountLabel,
  codeExpiresAt,
  countActiveCodes,
  deriveCardState,
  formatCountdown,
  hintFromStatus,
  isCodeActive,
  isOpenStatus,
  limitLeftLabel,
  nextExpiryMs,
  NO_LIMIT,
  openRequests,
  paymentMethodLabel,
  pickSelectedRequest,
  prefetch,
  readBankSnapshot,
  readCardState,
  readLimit,
  readProfile,
  readRequestDetail,
  readRequests,
  sameCardState,
  sameLimit,
  seedBank,
  shape3dsCode,
  shapeLimit,
  shapeProfile,
  shapeSpendRequest,
  shapeWhoami,
  shortRequestId,
  SNAPSHOT_MAX_REQUESTS,
  sortRequests,
  type SpendRequest,
  THREE_DS_WINDOW_MS,
  type ThreeDsCode,
  toBankSnapshot,
  WHOAMI_ARGV
} from './bank-data'

vi.mock('../cli', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()

  return { ...actual, acpJson: vi.fn() }
})

const acpJsonMock = vi.mocked(acpJson)
const SLUG = 'base-0xabc-7'
const INFT = 'base:0xabc:7'

function ok<T>(data: T, at = 1_700_000_000_000): AcpResult<T> {
  return { at, data, ok: true }
}

function fail(kind: AcpFailure['kind'], error: string, reauthState?: string): AcpFailure {
  return reauthState ? { error, kind, ok: false, reauthState } : { error, kind, ok: false }
}

function request(overrides: Partial<SpendRequest> = {}): SpendRequest {
  return {
    amountUsd: 12,
    capturedAmountUsd: null,
    capturedAt: '',
    createdAt: '2026-09-26T00:00:00Z',
    expiresAt: '',
    id: 'r1',
    issuedAt: '',
    last4: null,
    status: 'pending',
    ...overrides
  }
}

function code(receivedAt: string, value = '123456'): ThreeDsCode {
  return { amountUsd: 12, code: value, receivedAt }
}

function probe(cardState: 'none' | 'ready' | 'signin-pending', checkedAt: number, stale?: boolean) {
  $acpConfigMap.set({
    [SLUG]: {
      cli: true,
      authenticated: true,
      cardReady: cardState === 'ready',
      cardState,
      email: 'agent@example.com',
      configured: true,
      checkedAt,
      slug: SLUG,
      ...(stale ? { stale } : {})
    }
  })
}

beforeEach(() => {
  acpJsonMock.mockReset()
  clearEconBadges()
  clearSnapshot('bank', SLUG)
  $acpConfigMap.set({})
})

// ── whoami → state ────────────────────────────────────────────────────────

describe('shapeWhoami', () => {
  it('reads the CLI whoami answer', () => {
    expect(shapeWhoami(CLI_WHOAMI)).toEqual({ email: 'pat@example.com', verified: true, hint: undefined })
    expect(shapeWhoami(CLI_WHOAMI_UNVERIFIED)).toEqual({
      email: 'pat@example.com',
      verified: false,
      hint: 'Magic link sent but not clicked'
    })
  })

  it('is total on a bare or malformed payload', () => {
    expect(shapeWhoami({})).toEqual({ email: '', verified: undefined, hint: undefined })
    expect(shapeWhoami(null)).toEqual({ email: '', verified: undefined, hint: undefined })
    expect(shapeWhoami('not an object')).toEqual({ email: '', verified: undefined, hint: undefined })
  })
})

describe('deriveCardState', () => {
  it('maps a successful whoami to ready, carrying the email through', () => {
    expect(deriveCardState(ok({ email: 'agent@example.com' }))).toEqual({ email: 'agent@example.com', kind: 'ready' })
  })

  it('is the waiting state, not ready, when whoami answers verified:false', () => {
    expect(deriveCardState(ok(shapeWhoami(CLI_WHOAMI_UNVERIFIED)))).toEqual({
      email: 'pat@example.com',
      hint: 'Magic link sent but not clicked',
      kind: 'signin-pending'
    })
  })

  it('maps reauth to signin-pending, parsing the email out of the REAUTH message', () => {
    const failure = fail('reauth', 'HTTP 401: {"message":"REAUTH:abc-123:owner@example.com"}', 'abc-123')

    expect(deriveCardState(failure)).toEqual({
      email: 'owner@example.com',
      kind: 'signin-pending',
      reauthState: 'abc-123'
    })
  })

  it('tolerates a reauth message with no parseable email', () => {
    const state = deriveCardState(fail('reauth', 'HTTP 401: {"message":"REAUTH:abc-123"}', 'abc-123'))

    expect(state.email).toBeUndefined()
    expect(state.kind).toBe('signin-pending')
  })

  it('maps not-provisioned to none', () => {
    expect(deriveCardState(fail('not-provisioned', 'HTTP 400: {"message":"Call card signup first."}'))).toEqual({
      kind: 'none'
    })
  })

  // R16: a failure that is not the service's own 400 never reads as "no card".
  it('a busy read with nothing known is unknown, never none', () => {
    expect(deriveCardState(fail('busy', 'busy: another call is in flight'))).toEqual({ kind: 'unknown' })
  })

  it('R16.unit.expired_session_keeps_card: "Not authenticated" keeps the card as session-expired', () => {
    const ready = { email: 'agent@example.com', kind: 'ready' } as const
    const expired = fail('reauth-acp', 'Not authenticated.')

    expect(deriveCardState(expired, ready)).toEqual({
      cardKnown: true,
      email: 'agent@example.com',
      kind: 'session-expired'
    })
    expect(deriveCardState(expired)).toEqual({ kind: 'session-expired' })
    // Nothing on screen: the main process's persisted card still names the email.
    expect(deriveCardState(expired, null, { ...BASE_STATUS, cardState: 'ready', email: 'p@example.com' })).toEqual({
      cardKnown: true,
      email: 'p@example.com',
      kind: 'session-expired'
    })
    // ready → expired → ready again
    expect(
      deriveCardState(ok({ email: 'agent@example.com', verified: true }), deriveCardState(expired, ready))
    ).toEqual(ready)
  })

  it('R16.unit.busy_timeout_keep_card: busy / timeout / unavailable / parse / cli / a missing agent keep the last card, stale', () => {
    const ready = { email: 'agent@example.com', kind: 'ready' } as const

    const failures = [
      fail('busy', 'busy: another call is in flight'),
      fail('timeout', 'acp timed out after 30s'),
      fail('unavailable', 'bridge unavailable'),
      fail('parse', 'the CLI returned no JSON'),
      fail('cli', 'something odd'),
      fail('not-provisioned', 'no active agent — run acp configure')
    ]

    for (const failure of failures) {
      expect(deriveCardState(failure, ready)).toEqual({ ...ready, stale: true })
      expect(deriveCardState(failure, null, { ...BASE_STATUS, cardState: 'ready' })).toMatchObject({
        kind: 'ready',
        stale: true
      })
      expect(deriveCardState(failure, { kind: 'unknown' })).toEqual({ kind: 'unknown' })
    }
  })

  it('R16.unit.authoritative_none_only: only the card service 400 "not set up" is none', () => {
    const ready = { email: 'agent@example.com', kind: 'ready' } as const

    expect(deriveCardState(fail('not-provisioned', CLI_NOT_SIGNED_UP), ready)).toEqual({ kind: 'none' })
    expect(
      deriveCardState(
        fail('not-provisioned', 'HTTP 400: AgentCard not set up for this agent. Call card signup first.'),
        ready
      )
    ).toEqual({ kind: 'none' })

    for (const message of ['Not authenticated.', 'no active agent', 'not configured', 'not provisioned']) {
      expect(deriveCardState(fail('not-provisioned', message), ready).kind).not.toBe('none')
      expect(deriveCardState(fail('reauth-acp', message), ready).kind).not.toBe('none')
    }
  })
})

const BASE_STATUS = { authenticated: true, cardReady: false, checkedAt: 1, cli: true, configured: true, slug: 'x' }

describe('sameCardState / sameLimit', () => {
  it('compare content, so a setter can keep the previous object', () => {
    expect(sameCardState({ email: 'a', kind: 'ready' }, { email: 'a', kind: 'ready' })).toBe(true)
    expect(sameCardState({ email: 'a', kind: 'ready' }, { email: 'b', kind: 'ready' })).toBe(false)
    expect(sameCardState(null, { kind: 'none' })).toBe(false)
    expect(sameCardState({ kind: 'signin-pending', reauthState: 'x' }, { kind: 'signin-pending' })).toBe(false)

    expect(sameLimit(shapeLimit(CLI_LIMIT), shapeLimit({ ...CLI_LIMIT }))).toBe(true)
    expect(sameLimit(undefined, NO_LIMIT)).toBe(false)
    expect(sameLimit(NO_LIMIT, shapeLimit(CLI_LIMIT))).toBe(false)
  })
})

describe('hintFromStatus — the boot probe', () => {
  it('is nothing when the probe has not run', () => {
    expect(hintFromStatus(undefined)).toBeNull()
    expect(
      hintFromStatus({ cli: true, authenticated: true, cardReady: false, configured: true, checkedAt: 0, slug: SLUG })
    ).toBeNull()
  })

  it('maps the three probe states one to one, with the inbox for the gates', () => {
    const base = { cli: true, authenticated: true, cardReady: false, configured: true, checkedAt: 0, slug: SLUG }

    expect(hintFromStatus({ ...base, cardState: 'none' })).toEqual({ kind: 'none' })
    expect(hintFromStatus({ ...base, cardState: 'signin-pending', email: 'a@b.c' })).toEqual({
      email: 'a@b.c',
      kind: 'signin-pending'
    })
    expect(hintFromStatus({ ...base, cardState: 'ready', cardReady: true })).toEqual({
      email: undefined,
      kind: 'ready'
    })
  })

  // #6's status.json predates `cardState`: {cardReady:true, configured:true}.
  it('R16.c1.legacy_cardready_is_known_card: a legacy cardReady status is a known ready card', () => {
    const legacy = {
      cli: true,
      authenticated: true,
      cardReady: true,
      configured: true,
      checkedAt: 0,
      slug: SLUG,
      email: 'agent@example.test'
    }

    expect(hintFromStatus(legacy)).toEqual({ email: 'agent@example.test', kind: 'ready' })
    expect(deriveCardState({ error: 'timed out', kind: 'timeout', ok: false }, null, legacy)).toMatchObject({
      kind: 'ready',
      stale: true
    })
    expect(deriveCardState({ error: 'Not authenticated.', kind: 'reauth-acp', ok: false }, null, legacy)).toEqual({
      cardKnown: true,
      email: 'agent@example.test',
      kind: 'session-expired'
    })
    // An explicit cardState still wins over the legacy bit.
    expect(hintFromStatus({ ...legacy, cardState: 'signin-pending' })?.kind).toBe('signin-pending')
  })
})

// ── the reads: argv, TTL, shaper identity ────────────────────────────────

describe('readCardState', () => {
  it('is whoami alone — argv byte-identical to the prefetch, --json last, 5 min TTL', async () => {
    acpJsonMock.mockResolvedValueOnce(ok({ email: 'agent@example.com' }, 42))

    const result = await readCardState(INFT, SLUG)

    expect(acpJsonMock).toHaveBeenCalledTimes(1)

    const [inftId, slug, argv, , options] = acpJsonMock.mock.calls[0]

    expect(inftId).toBe(INFT)
    expect(slug).toBe(SLUG)
    expect(argv).toBe(WHOAMI_ARGV)
    expect(argv.join(' ')).toBe('card whoami --json')
    expect(options).toEqual({ force: false, ttlMs: BANK_TTL_MS.whoami })
    expect(result).toEqual({ at: 42, data: { email: 'agent@example.com', kind: 'ready' }, ok: true })
  })

  it('turns the two state-like failures into states and passes a transient one through', async () => {
    acpJsonMock.mockResolvedValueOnce(fail('reauth', 'HTTP 401: {"message":"REAUTH:abc-123:a@b.c"}', 'abc-123'))

    const pending = await readCardState(INFT, SLUG)

    expect(pending.ok && pending.data).toEqual({ email: 'a@b.c', kind: 'signin-pending', reauthState: 'abc-123' })

    acpJsonMock.mockResolvedValueOnce(fail('busy', 'busy: another call is in flight'))

    const busy = await readCardState(INFT, SLUG)

    expect(busy).toEqual(fail('busy', 'busy: another call is in flight'))
  })

  it('forwards force for the header refresh only', async () => {
    acpJsonMock.mockResolvedValueOnce(ok({ email: 'x' }))
    await readCardState(INFT, SLUG, true)

    expect(acpJsonMock.mock.calls[0][4]).toEqual({ force: true, ttlMs: BANK_TTL_MS.whoami })
  })
})

describe('the secondary reads', () => {
  it('each has its own argv (--json last) and TTL, and forwards force where the load forces', async () => {
    acpJsonMock.mockResolvedValue(ok(null))

    await readLimit(INFT, SLUG)
    await readRequests(INFT, SLUG)
    await readRequestDetail(INFT, SLUG, 'req-9')
    await readProfile(INFT, SLUG)

    const calls = acpJsonMock.mock.calls.map(call => [call[2].join(' '), call[4]?.ttlMs, call[4]?.force])

    expect(calls).toEqual([
      ['card limit --json', 600_000, false],
      ['card list --json', 30_000, false],
      ['card get --request-id req-9 --json', 60_000, undefined],
      ['card profile --json', 300_000, false]
    ])
  })

  it('passes the same shaper function on every call, so a cache hit keeps the list identity', async () => {
    acpJsonMock.mockResolvedValue(ok([]))

    await readRequests(INFT, SLUG)
    await readRequests(INFT, SLUG)

    expect(acpJsonMock.mock.calls[0][3]).toBe(acpJsonMock.mock.calls[1][3])
  })

  it('never reads card payment-method — that starts a Stripe session', async () => {
    acpJsonMock.mockResolvedValue(ok({ email: 'agent@example.com' }))

    await Promise.all([
      readCardState(INFT, SLUG),
      readLimit(INFT, SLUG),
      readRequests(INFT, SLUG),
      readProfile(INFT, SLUG),
      prefetch(INFT, SLUG)
    ])

    for (const call of acpJsonMock.mock.calls) {
      expect(call[2].join(' ')).not.toMatch(/payment-method/)
    }
  })
})

// ── limit ─────────────────────────────────────────────────────────────────

describe('shapeLimit', () => {
  it('reads the CLI answer: spendLimitCents, spentCents, remainingCents', () => {
    expect(shapeLimit(CLI_LIMIT)).toEqual({ limitCents: 5000, remainingCents: 3800, spentCents: 1200 })
  })

  it('derives what is left when the service omits it', () => {
    expect(shapeLimit({ spendLimitCents: 5000, spentCents: 1200 })).toEqual({
      limitCents: 5000,
      remainingCents: 3800,
      spentCents: 1200
    })
  })

  it('tolerates the older limitCents/limit names, still in cents', () => {
    expect(shapeLimit({ limitCents: 2500 }).limitCents).toBe(2500)
    expect(shapeLimit({ limit: '2500' }).limitCents).toBe(2500)
    expect(shapeLimit({ limit: 100, spendLimitCents: 5000 }).limitCents).toBe(5000)
  })

  it('is all-null when nothing parses', () => {
    expect(shapeLimit({})).toEqual(NO_LIMIT)
    expect(shapeLimit(null)).toEqual(NO_LIMIT)
    expect(shapeLimit({ spendLimitCents: null })).toEqual(NO_LIMIT)
  })
})

describe('limitLeftLabel', () => {
  it('says what is left of the limit once both are known', () => {
    expect(limitLeftLabel(shapeLimit(CLI_LIMIT))).toBe('$38.00 of $50.00 left')
  })

  it('is null while unknown or unset', () => {
    expect(limitLeftLabel(undefined)).toBeNull()
    expect(limitLeftLabel(NO_LIMIT)).toBeNull()
    expect(limitLeftLabel({ limitCents: 5000, remainingCents: null, spentCents: null })).toBeNull()
  })
})

describe('centsToUsd', () => {
  it('divides cents into dollars and passes null through', () => {
    expect(centsToUsd(5000)).toBe(50)
    expect(centsToUsd(150)).toBe(1.5)
    expect(centsToUsd(null)).toBeNull()
  })
})

// ── profile ───────────────────────────────────────────────────────────────

describe('shapeProfile', () => {
  it('reads the CLI profile: name from first + last, E.164 phone, funding and lock', () => {
    expect(shapeProfile(CLI_PROFILE)).toEqual({
      email: 'pat@example.com',
      locked: false,
      name: 'Pat One',
      paymentMethod: { brand: 'visa', last4: '4242' },
      phone: '+14155551234'
    })
    expect(shapeProfile({ ...CLI_PROFILE, locked: true }).locked).toBe(true)
  })

  it('reads an unset profile as empty, not as someone', () => {
    expect(shapeProfile({ email: 'a@b.c', firstName: null, lastName: null, paymentMethod: null })).toEqual({
      email: 'a@b.c',
      locked: false,
      name: '',
      paymentMethod: null,
      phone: ''
    })
  })

  it('never renders more than four digits of the funding card', () => {
    expect(shapeProfile({ paymentMethod: { brand: 'visa', last4: '4242424242424242' } }).paymentMethod).toEqual({
      brand: 'visa',
      last4: '4242'
    })
  })

  it('is total on a malformed payload', () => {
    expect(shapeProfile(null)).toEqual({ email: '', locked: false, name: '', paymentMethod: null, phone: '' })
    expect(shapeProfile('nope').name).toBe('')
  })
})

describe('paymentMethodLabel', () => {
  it('joins brand and last four', () => {
    expect(paymentMethodLabel({ brand: 'visa', last4: '4242' })).toBe('visa •••• 4242')
    expect(paymentMethodLabel({ brand: '', last4: '4242' })).toBe('•••• 4242')
    expect(paymentMethodLabel(null)).toBeNull()
  })
})

// ── spend requests ────────────────────────────────────────────────────────

describe('isOpenStatus', () => {
  it('treats pending/issued/unknown statuses as open', () => {
    expect(isOpenStatus('pending')).toBe(true)
    expect(isOpenStatus('issued')).toBe(true)
    expect(isOpenStatus('awaiting_review')).toBe(true)
    expect(isOpenStatus('')).toBe(true)
  })

  it('treats terminal statuses as closed, case-insensitively', () => {
    for (const status of ['approved', 'Declined', 'COMPLETED', 'cancelled', 'canceled', 'expired', 'captured']) {
      expect(isOpenStatus(status)).toBe(false)
    }
  })
})

describe('shapeSpendRequest', () => {
  it('shapes the CLI row field for field, cents to dollars', () => {
    expect(shapeSpendRequest(CLI_REQUEST_CAPTURED)).toEqual({
      amountUsd: 12,
      capturedAmountUsd: 11.4,
      capturedAt: '2026-09-25T10:03:00.000Z',
      createdAt: '2026-09-25T10:00:00.000Z',
      expiresAt: '2026-09-25T11:00:00.000Z',
      id: 'sr_8f2c41d09a7e',
      issuedAt: '2026-09-25T10:00:05.000Z',
      last4: '4242',
      status: 'captured'
    })
    expect(shapeSpendRequest(CLI_REQUEST_OPEN).capturedAmountUsd).toBeNull()
    expect(shapeSpendRequest(CLI_REQUEST_OPEN).capturedAt).toBe('')
  })

  it('carries no merchant or description — the CLI has neither', () => {
    expect(Object.keys(shapeSpendRequest(CLI_REQUEST_OPEN))).not.toContain('merchant')
    expect(Object.keys(shapeSpendRequest(CLI_REQUEST_OPEN))).not.toContain('description')
  })

  it('is null when no amount parses, and defaults status to pending', () => {
    expect(shapeSpendRequest({}).amountUsd).toBeNull()
    expect(shapeSpendRequest({}).status).toBe('pending')
  })

  it('never renders more than the last 4 characters of last4, however long the field is', () => {
    expect(shapeSpendRequest({ last4: '4242' }).last4).toBe('4242')
    expect(shapeSpendRequest({ last4: '4242424242424242' }).last4).toBe('4242')
    expect(shapeSpendRequest({}).last4).toBeNull()
  })

  it('is total on a malformed payload', () => {
    expect(() => shapeSpendRequest(null)).not.toThrow()
    expect(shapeSpendRequest(null).id).toBe('')
  })
})

describe('shortRequestId', () => {
  it('shortens long ids and leaves short ones whole', () => {
    expect(shortRequestId('sr_8f2c41d09a7e')).toBe('sr_8f2c4…')
    expect(shortRequestId('r1')).toBe('r1')
    expect(shortRequestId('')).toBe('—')
  })
})

describe('pickSelectedRequest', () => {
  const a = request({ id: 'a', amountUsd: 1 })
  const b = request({ id: 'b', amountUsd: 2 })
  const detailOfA = { forId: 'a', request: request({ id: 'a', amountUsd: 1, status: 'captured' }) }

  it("prefers the detail fetched for the selected id over the list's row", () => {
    expect(pickSelectedRequest(detailOfA, 'a', [a, b])).toBe(detailOfA.request)
  })

  it("never shows another request's detail under a new selection", () => {
    expect(pickSelectedRequest(detailOfA, 'b', [a, b])).toBe(b)
    expect(pickSelectedRequest(detailOfA, 'gone', [a, b])).toBeNull()
  })

  it('is nothing without a selection', () => {
    expect(pickSelectedRequest(detailOfA, null, [a, b])).toBeNull()
  })
})

describe('sortRequests', () => {
  const older = request({ id: 'old-open', createdAt: '2026-09-20T00:00:00Z' })
  const newer = request({ id: 'new-open', createdAt: '2026-09-25T00:00:00Z' })
  const settledNew = request({ id: 'settled-new', createdAt: '2026-09-26T00:00:00Z', status: 'captured' })
  const settledOld = request({ id: 'settled-old', createdAt: '2026-09-01T00:00:00Z', status: 'declined' })
  const undated = request({ id: 'undated', createdAt: '' })

  it('puts open requests first, newest first within each group, undated last in its group', () => {
    const sorted = sortRequests([settledOld, undated, older, settledNew, newer])

    expect(sorted.map(item => item.id)).toEqual(['new-open', 'old-open', 'undated', 'settled-new', 'settled-old'])
  })

  it('is stable for ties and never mutates the input', () => {
    const a = request({ id: 'a' })
    const b = request({ id: 'b' })
    const input = [a, b]
    const sorted = sortRequests(input)

    expect(sorted.map(item => item.id)).toEqual(['a', 'b'])
    expect(sorted).not.toBe(input)
    expect(input.map(item => item.id)).toEqual(['a', 'b'])
  })

  it('openRequests keeps only what still needs attention', () => {
    expect(openRequests([settledNew, newer, undated]).map(item => item.id)).toEqual(['new-open', 'undated'])
  })
})

// ── 3DS codes ─────────────────────────────────────────────────────────────

describe('shape3dsCode', () => {
  it('shapes the CLI item: code, dollar amount, receivedAt', () => {
    const [item] = cli3ds('2026-09-26T00:09:00.000Z').codes

    expect(shape3dsCode(item)).toEqual({ amountUsd: 12, code: '482913', receivedAt: '2026-09-26T00:09:00.000Z' })
  })

  it('tolerates createdAt for the time, and is total on a malformed payload', () => {
    expect(shape3dsCode({ code: '1', createdAt: '2026-09-26T00:00:00Z' }).receivedAt).toBe('2026-09-26T00:00:00Z')
    expect(shape3dsCode(null)).toEqual({ amountUsd: null, code: '', receivedAt: '' })
  })
})

describe('codeAmountLabel', () => {
  it("reads like the CLI's own line", () => {
    expect(codeAmountLabel(12, 'n/a')).toBe('USD 12.00')
    expect(codeAmountLabel(0.5, 'n/a')).toBe('USD 0.50')
  })

  it("paints the locale's text when the CLI gave no amount", () => {
    expect(codeAmountLabel(null, 'Amount not given')).toBe('Amount not given')
    expect(codeAmountLabel(null, '未提供金额')).toBe('未提供金额')
  })
})

describe('the five-minute window', () => {
  const now = Date.parse('2026-09-26T00:10:00Z')

  it('a code received a minute ago is live and ticks toward its boundary', () => {
    const fresh = shape3dsCode(cli3ds(new Date(now - 60_000).toISOString()).codes[0])

    expect(isCodeActive(fresh.receivedAt, now)).toBe(true)
    expect(countActiveCodes([fresh], now)).toBe(1)
    expect(nextExpiryMs([fresh], now)).toBe(now + 4 * 60_000)
    expect(formatCountdown(codeExpiresAt(fresh.receivedAt) - now)).toBe('4:00')
    expect(formatCountdown(codeExpiresAt(fresh.receivedAt) - (now + 1000))).toBe('3:59')
  })

  it('isCodeActive is inclusive at the boundary and false for an unparseable date', () => {
    expect(isCodeActive('2026-09-26T00:06:00Z', now)).toBe(true)
    expect(isCodeActive('2026-09-26T00:05:00Z', now)).toBe(true)
    expect(isCodeActive('2026-09-26T00:04:59Z', now)).toBe(false)
    expect(isCodeActive('not-a-date', now)).toBe(false)
  })

  it('codeExpiresAt is receivedAt plus the window, NaN when unreadable', () => {
    expect(codeExpiresAt('2026-09-26T00:00:00Z')).toBe(Date.parse('2026-09-26T00:00:00Z') + THREE_DS_WINDOW_MS)
    expect(codeExpiresAt('')).toBeNaN()
  })

  it('countActiveCodes counts only the live ones', () => {
    const codes = [code('2026-09-26T00:09:00Z'), code('2026-09-26T00:01:00Z'), code('garbage')]

    expect(countActiveCodes(codes, now)).toBe(1)
  })

  it('nextExpiryMs is the earliest future boundary, null when nothing is live', () => {
    const codes = [code('2026-09-26T00:09:00Z'), code('2026-09-26T00:07:30Z'), code('2026-09-26T00:01:00Z')]

    expect(nextExpiryMs(codes, now)).toBe(Date.parse('2026-09-26T00:12:30Z'))
    expect(nextExpiryMs([code('2026-09-26T00:01:00Z'), code('bad')], now)).toBeNull()
    expect(nextExpiryMs([], now)).toBeNull()
  })

  it('a code expiring exactly now is still active but no longer a future boundary', () => {
    expect(isCodeActive('2026-09-26T00:05:00Z', now)).toBe(true)
    expect(nextExpiryMs([code('2026-09-26T00:05:00Z')], now)).toBeNull()
  })
})

describe('formatCountdown', () => {
  it('reads m:ss with zero-padded seconds, rounding up so 4:59.2 reads 5:00', () => {
    expect(formatCountdown(299_000)).toBe('4:59')
    expect(formatCountdown(299_200)).toBe('5:00')
    expect(formatCountdown(60_000)).toBe('1:00')
    expect(formatCountdown(5_000)).toBe('0:05')
  })

  it('never goes negative', () => {
    expect(formatCountdown(0)).toBe('0:00')
    expect(formatCountdown(-4_000)).toBe('0:00')
  })
})

// ── badge ─────────────────────────────────────────────────────────────────

describe('bankBadgeCount', () => {
  it('is open requests plus live codes', () => {
    const now = Date.parse('2026-09-26T00:10:00Z')
    const requests = [request({ status: 'pending' }), request({ status: 'captured' }), request({ status: 'weird' })]
    const codes = [code('2026-09-26T00:09:00Z'), code('2026-09-26T00:00:00Z')]

    expect(bankBadgeCount(requests, codes, now)).toBe(3)
    expect(bankBadgeCount([], [], now)).toBe(0)
  })
})

// ── snapshot ──────────────────────────────────────────────────────────────

describe('toBankSnapshot', () => {
  const limit: CardLimit = shapeLimit(CLI_LIMIT)

  it('persists only a ready card, without the sign-in token', () => {
    expect(toBankSnapshot({ kind: 'none' }, NO_LIMIT, [])).toBeNull()
    expect(toBankSnapshot({ kind: 'signin-pending', reauthState: 'abc' }, NO_LIMIT, [])).toBeNull()

    const snapshot = toBankSnapshot({ email: 'a@b.c', kind: 'ready', reauthState: 'never-here' }, limit, [request()])

    expect(snapshot).toEqual({ limit, requests: [request()], state: { email: 'a@b.c', kind: 'ready' } })
    expect(snapshot && 'reauthState' in snapshot.state).toBe(false)
  })

  it('omits the limit while it is unknown and keeps an unset one', () => {
    expect(toBankSnapshot({ kind: 'ready' }, undefined, [])).not.toHaveProperty('limit')
    expect(toBankSnapshot({ kind: 'ready' }, NO_LIMIT, [])).toHaveProperty('limit', NO_LIMIT)
  })

  it('truncates a runaway list so the snapshot stays far under the byte cap', () => {
    const many = Array.from({ length: SNAPSHOT_MAX_REQUESTS + 50 }, (_, index) => request({ id: `r${index}` }))
    const snapshot = toBankSnapshot({ kind: 'ready' }, undefined, many)

    expect(snapshot?.requests).toHaveLength(SNAPSHOT_MAX_REQUESTS)
    expect(snapshot?.requests[0].id).toBe('r0')
  })
})

describe('readBankSnapshot', () => {
  it('round-trips what was persisted', () => {
    const limit = shapeLimit(CLI_LIMIT)
    const rows = [shapeSpendRequest(CLI_REQUEST_CAPTURED), shapeSpendRequest(CLI_REQUEST_OPEN)]

    writeSnapshot('bank', SLUG, BANK_SNAPSHOT_VERSION, toBankSnapshot({ kind: 'ready' }, limit, rows), 1234)

    expect(readBankSnapshot(SLUG)).toEqual({ at: 1234, data: { limit, requests: rows, state: { kind: 'ready' } } })
  })

  it('rejects a gate, an older schema, and shapes that are not a ready card — without throwing', () => {
    writeSnapshot('bank', SLUG, BANK_SNAPSHOT_VERSION, { requests: [], state: { kind: 'none' } }, 1)
    expect(readBankSnapshot(SLUG)).toBeNull()

    writeSnapshot('bank', SLUG, BANK_SNAPSHOT_VERSION - 1, { requests: [], state: { kind: 'ready' } }, 1)
    expect(readBankSnapshot(SLUG)).toBeNull()

    for (const data of ['x', {}, { state: 'ready' }, { requests: 'no', state: { kind: 'ready' } }, null, 7]) {
      writeSnapshot('bank', SLUG, BANK_SNAPSHOT_VERSION, data, 1)
      expect(() => readBankSnapshot(SLUG)).not.toThrow()
      expect(readBankSnapshot(SLUG)).toBeNull()
    }
  })

  it('drops persisted rows that are not requests instead of crashing on them later', () => {
    writeSnapshot(
      'bank',
      SLUG,
      BANK_SNAPSHOT_VERSION,
      {
        requests: [request({ id: 'kept' }), { id: 'no-status' }, null, 'junk', { status: 'no-id' }],
        state: { kind: 'ready' }
      },
      1
    )

    expect(readBankSnapshot(SLUG)?.data.requests.map(row => row.id)).toEqual(['kept'])
  })
})

describe('seedBank', () => {
  function persistReady(at: number) {
    writeSnapshot('bank', SLUG, BANK_SNAPSHOT_VERSION, { requests: [request()], state: { kind: 'ready' } }, at)
  }

  it('never trusts a probe "ready" on its own — the first frame is a skeleton, not a hero', () => {
    probe('ready', 5)

    expect(seedBank(SLUG)).toEqual({ snapshot: null, state: null })
  })

  it('paints a probe gate when there is no snapshot', () => {
    probe('signin-pending', 5)

    expect(seedBank(SLUG)).toEqual({
      snapshot: null,
      state: { email: 'agent@example.com', kind: 'signin-pending' }
    })
  })

  it('lets a gate newer than the snapshot win, so a lapsed session never paints yesterday’s card', () => {
    persistReady(100)
    probe('none', 200)

    expect(seedBank(SLUG)).toEqual({ snapshot: null, state: { kind: 'none' } })
  })

  it('keeps the snapshot over an older gate, a stale probe, or a ready probe', () => {
    persistReady(100)

    probe('none', 50)
    expect(seedBank(SLUG).state?.kind).toBe('ready')
    expect(seedBank(SLUG).snapshot?.at).toBe(100)

    probe('none', 200, true)
    expect(seedBank(SLUG).state?.kind).toBe('ready')

    probe('ready', 200)
    expect(seedBank(SLUG).state?.kind).toBe('ready')
  })
})

// ── prefetch ──────────────────────────────────────────────────────────────

describe('prefetch', () => {
  it("reads card whoami only, with the window's own argv and TTL", async () => {
    acpJsonMock.mockResolvedValueOnce(ok(shapeWhoami(CLI_WHOAMI)))

    await prefetch(INFT, SLUG)
    await prefetchesSettled()

    expect(acpJsonMock).toHaveBeenCalledTimes(1)
    expect(acpJsonMock.mock.calls[0][2]).toBe(WHOAMI_ARGV)
    expect(acpJsonMock.mock.calls[0][4]).toEqual({ force: false, ttlMs: BANK_TTL_MS.whoami })
  })

  it('publishes zero and drops the ready snapshot for a card that is not ready', async () => {
    writeSnapshot('bank', SLUG, BANK_SNAPSHOT_VERSION, { requests: [request()], state: { kind: 'ready' } }, 1)
    acpJsonMock.mockResolvedValueOnce(fail('not-provisioned', 'HTTP 400: {"message":"Call card signup first."}'))

    await prefetch(INFT, SLUG)
    await prefetchesSettled()

    expect($econBadges.get()[SLUG]?.bank).toBe(0)
    expect(readSnapshot('bank', SLUG, BANK_SNAPSHOT_VERSION)).toBeNull()
  })

  it("publishes the last snapshot's open requests for a ready card", async () => {
    writeSnapshot(
      'bank',
      SLUG,
      BANK_SNAPSHOT_VERSION,
      {
        requests: [
          request({ id: 'a' }),
          request({ id: 'b', status: 'captured' }),
          request({ id: 'c', status: 'weird' })
        ],
        state: { kind: 'ready' }
      },
      1234
    )
    acpJsonMock.mockResolvedValueOnce(ok(shapeWhoami(CLI_WHOAMI)))

    await prefetch(INFT, SLUG)
    await prefetchesSettled()

    expect($econBadges.get()[SLUG]?.bank).toBe(2)
  })

  it('publishes zero for a ready card with no snapshot, and leaves everything alone on a transient failure', async () => {
    acpJsonMock.mockResolvedValueOnce(ok(shapeWhoami(CLI_WHOAMI)))
    await prefetch(INFT, SLUG)
    await prefetchesSettled()

    expect($econBadges.get()[SLUG]?.bank).toBe(0)

    clearEconBadges()
    writeSnapshot('bank', SLUG, BANK_SNAPSHOT_VERSION, { requests: [request()], state: { kind: 'ready' } }, 1)
    acpJsonMock.mockResolvedValueOnce(fail('timeout', 'acp timed out'))
    await prefetch(INFT, SLUG)
    await prefetchesSettled()

    expect($econBadges.get()[SLUG]).toBeUndefined()
    expect(readBankSnapshot(SLUG)).not.toBeNull()
  })
})

// R16 r3 — a card once seen ready is still painted while its AgentCard sign-in lapses.
describe('deriveCardState — the known card survives a waiting link', () => {
  const ready = { email: 'agent@example.com', kind: 'ready' } as const
  const reauth = fail('reauth', 'HTTP 401: {"message":"REAUTH:abc-123:agent@example.com"}', 'abc-123')

  it('R16.c2.reauth_after_ready_remembers_card: a REAUTH after ready is signin-pending with cardKnown', () => {
    expect(deriveCardState(reauth, ready)).toEqual({
      cardKnown: true,
      email: 'agent@example.com',
      kind: 'signin-pending',
      reauthState: 'abc-123'
    })
  })

  it('a 200 verified:false after ready keeps cardKnown too', () => {
    expect(deriveCardState(ok(shapeWhoami(CLI_WHOAMI_UNVERIFIED)), ready)).toMatchObject({
      cardKnown: true,
      kind: 'signin-pending'
    })
  })

  it("main's sticky cardKnown and #6's legacy cardReady:true both say the card is known", () => {
    const sticky = { ...BASE_STATUS, cardKnown: true, cardState: 'signin-pending' as const }
    const legacy = { ...BASE_STATUS, cardReady: true }

    expect(hintFromStatus(sticky)).toMatchObject({ cardKnown: true, kind: 'signin-pending' })
    expect(deriveCardState(reauth, null, sticky)).toMatchObject({ cardKnown: true, kind: 'signin-pending' })
    expect(deriveCardState(reauth, null, legacy)).toMatchObject({ cardKnown: true, kind: 'signin-pending' })
    // A pending link that was carried forward stays known on the next read.
    expect(deriveCardState(reauth, deriveCardState(reauth, ready))).toMatchObject({ cardKnown: true })
  })

  it('a waiting link with no card ever seen is the plain gate; the authoritative none forgets the card', () => {
    expect(deriveCardState(reauth).cardKnown).toBeUndefined()
    expect(deriveCardState(reauth, null, { ...BASE_STATUS, cardState: 'signin-pending' }).cardKnown).toBeUndefined()
    expect(deriveCardState(fail('not-provisioned', CLI_NOT_SIGNED_UP), { ...ready, cardKnown: true })).toEqual({
      kind: 'none'
    })
  })

  it('sameCardState tells a known pending card from a plain one', () => {
    const plain = deriveCardState(reauth)

    expect(sameCardState(plain, deriveCardState(reauth, ready))).toBe(false)
  })

  it("R16.r4.status_known_any_state: main's cardKnown reaches the screen whatever cardState it wrote beside it", () => {
    for (const status of [
      { ...BASE_STATUS, cardHttpStatus: 429, cardKnown: true, cardState: 'blocked' as const },
      { ...BASE_STATUS, cardKnown: true, cardStale: true },
      { ...BASE_STATUS, cardKnown: true }
    ]) {
      expect(deriveCardState(reauth, null, status)).toMatchObject({ cardKnown: true, kind: 'signin-pending' })
      expect(deriveCardState(ok(shapeWhoami(CLI_WHOAMI_UNVERIFIED)), null, status)).toMatchObject({ cardKnown: true })
    }

    // A blocked status with no sticky fact is not a known card.
    expect(deriveCardState(reauth, null, { ...BASE_STATUS, cardState: 'blocked' as const }).cardKnown).toBeUndefined()
  })

  it('R16.r4.bare_401_not_a_link: a 401 without REAUTH:<state> keeps the last state stale, never a pending link', () => {
    for (const message of ['HTTP 401: Unauthorized', 'unauthorized']) {
      const bare = fail('reauth', message)

      expect(deriveCardState(bare, ready)).toEqual({ ...ready, stale: true })
      expect(deriveCardState(bare, null, { ...BASE_STATUS, cardState: 'ready', email: 'p@example.com' })).toEqual({
        email: 'p@example.com',
        kind: 'ready',
        stale: true
      })
      expect(deriveCardState(bare)).toEqual({ kind: 'unknown' })
    }

    // The real REAUTH answer is still the waiting link.
    expect(deriveCardState(reauth, ready).kind).toBe('signin-pending')
  })
})
