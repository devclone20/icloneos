import { beforeEach, describe, expect, it, vi } from 'vitest'

import { $acpConfigMap } from '../../acp-setup'
import { $econBadges, clearEconBadges } from '../badges'
import { type AcpFailure, acpJson, type AcpResult, invalidateAcp } from '../cli'

import {
  cli3ds,
  CLI_LIMIT,
  CLI_LIST,
  CLI_NOT_SIGNED_UP,
  CLI_PROFILE,
  CLI_REAUTH,
  CLI_WHOAMI,
  CLI_WHOAMI_UNVERIFIED
} from './bank-cli-fixtures'
import { type BankSnapshot, type CardState, NO_LIMIT, shapeLimit, WHOAMI_ARGV } from './bank-data'
import { type BankNotice, type BankSink, forgetCard, loadBank, sameNotice } from './bank-loaders'

vi.mock('../cli', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()

  return { ...actual, acpJson: vi.fn(), invalidateAcp: vi.fn() }
})

const acpJsonMock = vi.mocked(acpJson)
const invalidateMock = vi.mocked(invalidateAcp)
const INFT = 'base:0xabc:7'
const AT = 1_700_000_000_000

const WHOAMI = 'card whoami --json'
const LIST = 'card list --json'
const THREE_DS = 'card 3ds --json'
const LIMIT = 'card limit --json'
const PROFILE = 'card profile --json'

interface Failure {
  fail: AcpFailure['kind']
  error: string
}

type Answer = Failure | { raw: unknown }

/** What the CLI prints now (`live`) and what cli.ts would serve from memory
 *  to a non-forced read (`cached`). */
let live: Record<string, Answer> = {}
let cached: Record<string, Answer> = {}

function failure(kind: AcpFailure['kind'], error: string): Failure {
  return { error, fail: kind }
}

function answerOf<T>(answer: Answer | undefined, shape: (raw: unknown) => T): AcpResult<T> {
  if (!answer) {
    return { error: 'unexpected command', kind: 'cli', ok: false }
  }

  if ('fail' in answer) {
    const reauthState = /REAUTH:([0-9a-f-]+)/i.exec(answer.error)?.[1]

    return { error: answer.error, kind: answer.fail, ok: false, ...(reauthState ? { reauthState } : {}) }
  }

  return { at: AT, data: shape(answer.raw), ok: true }
}

function commands(): string[] {
  return acpJsonMock.mock.calls.map(call => `${call[2].join(' ')}${call[4]?.force ? ' (forced)' : ''}`)
}

let slugSeq = 0
let slug = ''

function nextSlug(): string {
  slugSeq += 1

  return `bank-loader-${slugSeq}`
}

function probe(cardState: 'none' | 'ready' | 'signin-pending', checkedAt: number) {
  $acpConfigMap.set({
    [slug]: {
      authenticated: true,
      cardReady: cardState === 'ready',
      cardState,
      checkedAt,
      cli: true,
      configured: true,
      slug
    }
  })
}

interface Recorded {
  events: string[]
  states: CardState[]
  notices: (BankNotice | null)[]
  persisted: { snapshot: BankSnapshot; at: number }[]
  sink: BankSink
}

function recorder(): Recorded {
  const recorded: Omit<Recorded, 'sink'> = { events: [], notices: [], persisted: [], states: [] }

  const sink: BankSink = {
    clearSnapshot: () => recorded.events.push('clear-snapshot'),
    codes: list => recorded.events.push(`codes:${list.length}`),
    limit: limit => recorded.events.push(`limit:${limit.limitCents}`),
    notice: notice => {
      recorded.notices.push(notice)
      recorded.events.push(notice ? `notice:${notice.setup ? 'setup' : 'retry'}` : 'notice:none')
    },
    listUpdatedAt: at => recorded.events.push(at === null ? 'list:fresh' : `list:stale@${at}`),
    persist: (snapshot, at) => {
      recorded.persisted.push({ at, snapshot })
      recorded.events.push('persist')
    },
    profile: result => recorded.events.push(`profile:${result.ok ? 'ok' : result.kind}`),
    requests: list => recorded.events.push(`requests:${list.length}`),
    resetReady: keepLimit => recorded.events.push(keepLimit ? 'reset:keep-limit' : 'reset'),
    state: next => {
      recorded.states.push(next)
      recorded.events.push(`state:${next.kind}`)
    }
  }

  return { ...recorded, sink }
}

function readyCard(receivedAt = new Date(Date.now() - 60_000).toISOString()) {
  live = {
    [LIMIT]: { raw: CLI_LIMIT },
    [LIST]: { raw: CLI_LIST },
    [PROFILE]: { raw: CLI_PROFILE },
    [THREE_DS]: { raw: cli3ds(receivedAt) },
    [WHOAMI]: { raw: CLI_WHOAMI }
  }
}

beforeEach(() => {
  acpJsonMock.mockReset()
  invalidateMock.mockReset()
  clearEconBadges()
  $acpConfigMap.set({})
  slug = nextSlug()
  live = {}
  cached = {}

  acpJsonMock.mockImplementation(async (_inftId, _slug, argv, shape, options) => {
    const key = argv.join(' ')
    const answer = !options?.force && key in cached ? cached[key] : live[key]

    // Like cli.ts: answers and STATES are remembered, transient failures never.
    if (
      answer &&
      (!('fail' in answer) ||
        answer.fail === 'reauth' ||
        answer.fail === 'reauth-acp' ||
        answer.fail === 'not-provisioned')
    ) {
      cached[key] = answer
    }

    return answerOf(answer, shape)
  })
})

describe('loadBank — a ready card', () => {
  it('paints the state first, then list → 3DS → limit → profile, then persists and clears the notice', async () => {
    readyCard()

    const recorded = recorder()

    await loadBank(INFT, slug, { force: false }, recorded.sink)

    expect(commands()).toEqual([WHOAMI, LIST, THREE_DS, LIMIT, PROFILE])
    expect(recorded.events).toEqual([
      'state:ready',
      'requests:2',
      'list:fresh',
      'codes:1',
      'limit:5000',
      'profile:ok',
      'persist',
      'notice:none'
    ])
    expect(recorded.states[0]).toEqual({ email: 'pat@example.com', kind: 'ready' })
  })

  it('persists the ready card at the whoami time, with the CLI limit and rows, never the codes', async () => {
    readyCard()

    const recorded = recorder()

    await loadBank(INFT, slug, { force: false }, recorded.sink)

    const [{ at, snapshot }] = recorded.persisted

    expect(at).toBe(AT)
    expect(snapshot.state).toEqual({ email: 'pat@example.com', hint: undefined, kind: 'ready' })
    expect(snapshot.limit).toEqual({ limitCents: 5000, remainingCents: 3800, spentCents: 1200 })
    expect(snapshot.requests.map(row => row.id)).toEqual(['sr_8f2c41d09a7e', 'sr_1b9e77c2f310'])
    expect(JSON.stringify(snapshot)).not.toMatch(/482913|codes/)
  })

  it('badges open requests plus live 3DS codes', async () => {
    readyCard()

    await loadBank(INFT, slug, { force: false }, recorder().sink)

    // One issued (open) request + one code received a minute ago.
    expect($econBadges.get()[slug]?.bank).toBe(2)
  })

  it('forwards force to every read on the header refresh', async () => {
    readyCard()

    await loadBank(INFT, slug, { force: true }, recorder().sink)

    expect(commands()).toEqual([WHOAMI, LIST, THREE_DS, LIMIT, PROFILE].map(command => `${command} (forced)`))
  })

  it('a forced load drops cached request details before its first read, so the open detail re-reads too', async () => {
    readyCard()

    await loadBank(INFT, slug, { force: true }, recorder().sink)

    expect(invalidateMock).toHaveBeenCalledWith(slug, ['card', 'get'])
    expect(invalidateMock.mock.invocationCallOrder[0]).toBeLessThan(acpJsonMock.mock.invocationCallOrder[0])

    invalidateMock.mockClear()
    await loadBank(INFT, slug, { force: false }, recorder().sink)

    expect(invalidateMock).not.toHaveBeenCalled()
  })

  it('reads a limit that is not set as a value, never a failure', async () => {
    readyCard()
    live[LIMIT] = failure('not-provisioned', 'HTTP 404: {"message":"No spend limit set. Not set up yet."}')

    const recorded = recorder()

    await loadBank(INFT, slug, { force: false }, recorded.sink)

    expect(recorded.events).toContain('limit:null')
    expect(recorded.notices.at(-1)).toBeNull()
    expect(recorded.persisted[0].snapshot.limit).toEqual(NO_LIMIT)
  })

  it('keeps the limit already on screen when a transient failure hides it, and offers a retry', async () => {
    readyCard()
    live[LIMIT] = failure('busy', 'busy: another call is in flight')

    const known = shapeLimit(CLI_LIMIT)
    const recorded = recorder()

    await loadBank(INFT, slug, { force: false, knownLimit: known }, recorded.sink)

    expect(recorded.events.some(event => event.startsWith('limit:'))).toBe(false)
    expect(recorded.persisted[0].snapshot.limit).toBe(known)
    expect(recorded.notices.at(-1)).toEqual({ message: 'busy: another call is in flight', setup: false })
  })

  it('re-asks whoami on the next tick when a list says the card is not set up', async () => {
    readyCard()
    live[LIST] = failure('not-provisioned', CLI_NOT_SIGNED_UP)

    const recorded = recorder()

    await loadBank(INFT, slug, { force: false }, recorded.sink)

    expect(invalidateMock).toHaveBeenCalledWith(slug, WHOAMI_ARGV)
    expect(recorded.persisted).toEqual([])
    expect(recorded.notices.at(-1)).toEqual({ message: 'Call card signup first.', setup: true })
  })
})

describe('loadBank — a reauth from any secondary read', () => {
  it.each([LIST, THREE_DS, LIMIT, PROFILE])(
    '%s: flips to sign-in, forgets the cached answers, keeps the known card snapshot, zeroes the badge',
    async command => {
      readyCard()
      live[command] = failure('reauth', CLI_REAUTH)
      $econBadges.set({ [slug]: { bank: 3 } })

      const recorded = recorder()

      await loadBank(INFT, slug, { force: false }, recorded.sink)

      const order = [WHOAMI, LIST, THREE_DS, LIMIT, PROFILE]

      expect(commands()).toEqual(order.slice(0, order.indexOf(command) + 1))
      // The card was ready a moment ago: the waiting link keeps it on screen as a known card.
      expect(recorded.states.at(-1)).toEqual({
        cardKnown: true,
        email: 'pat@example.com',
        kind: 'signin-pending',
        reauthState: 'abc-123'
      })
      expect(recorded.events.slice(-3)).toEqual(['state:signin-pending', 'reset:keep-limit', 'notice:none'])
      expect(recorded.events).not.toContain('clear-snapshot')
      expect(recorded.persisted).toEqual([])
      expect(invalidateMock).toHaveBeenCalledWith(slug, ['card'])
      expect($econBadges.get()[slug]?.bank).toBe(0)
    }
  )
})

describe('loadBank — gates and failures', () => {
  it('a card that is not set up paints the gate, resets, clears the snapshot and zeroes the badge — no other read', async () => {
    live = { [WHOAMI]: failure('not-provisioned', CLI_NOT_SIGNED_UP) }

    const recorded = recorder()

    await loadBank(INFT, slug, { force: false }, recorded.sink)

    expect(commands()).toEqual([WHOAMI])
    expect(recorded.events).toEqual(['state:none', 'reset', 'notice:none', 'clear-snapshot'])
    expect($econBadges.get()[slug]?.bank).toBe(0)
  })

  it('an unverified account is the sign-in gate', async () => {
    live = { [WHOAMI]: { raw: CLI_WHOAMI_UNVERIFIED } }

    const recorded = recorder()

    await loadBank(INFT, slug, { force: false }, recorded.sink)

    expect(recorded.states).toEqual([
      { email: 'pat@example.com', hint: 'Magic link sent but not clicked', kind: 'signin-pending' }
    ])
  })

  it('a transient whoami failure with nothing known hands over a retry notice, paints unknown (never none) and throws', async () => {
    live = { [WHOAMI]: failure('timeout', 'acp timed out after 30s') }

    const recorded = recorder()

    await expect(loadBank(INFT, slug, { force: false }, recorded.sink)).rejects.toThrow('acp timed out after 30s')
    expect(recorded.events).toEqual(['state:unknown', 'notice:retry'])
    expect(recorded.states).toEqual([{ kind: 'unknown' }])
  })
})

// R16 — the card never "disappears" from the Bank.
describe('loadBank — the card is kept across non-answers (R16)', () => {
  const READY: CardState = { email: 'pat@example.com', kind: 'ready' }

  it('ready → "Not authenticated" → session-expired: no reset, no snapshot cleared, no other read', async () => {
    live = { [WHOAMI]: failure('reauth-acp', 'Not authenticated.') }

    const recorded = recorder()

    await loadBank(INFT, slug, { force: false, knownState: READY }, recorded.sink)

    expect(recorded.states).toEqual([{ cardKnown: true, email: 'pat@example.com', kind: 'session-expired' }])
    expect(recorded.events).not.toContain('clear-snapshot')
    expect(recorded.events).not.toContain('reset')
    expect(commands()).toEqual([WHOAMI])
  })

  it('R16.r4.reauth_known_card_keeps_snapshot: a waiting link on a known card keeps its snapshot', async () => {
    live = { [WHOAMI]: failure('reauth', CLI_REAUTH) }

    const known = recorder()

    await loadBank(INFT, slug, { force: true, knownState: READY }, known.sink)
    expect(known.states.at(-1)).toMatchObject({ cardKnown: true, kind: 'signin-pending' })
    // R16.F5 m2: the dimmed card keeps its last limit on screen too.
    expect(known.events).toContain('reset:keep-limit')
    expect(known.events).not.toContain('clear-snapshot')

    // No card ever seen: the plain gate forgets what is on disk and on screen.
    const plain = recorder()

    await loadBank(INFT, slug, { force: true }, plain.sink)
    expect(plain.events).toContain('reset')
    expect(plain.events).toContain('clear-snapshot')
  })

  it('R16.r4.bare_401_secondary_is_not_a_link: a 401 without REAUTH on the list never demotes the card', async () => {
    readyCard()
    live[LIST] = failure('reauth', 'HTTP 401: Unauthorized')

    const recorded = recorder()

    await loadBank(INFT, slug, { force: false }, recorded.sink)
    expect(recorded.states.map(state => state.kind)).not.toContain('signin-pending')
    expect(recorded.events).not.toContain('clear-snapshot')
    expect(invalidateMock).not.toHaveBeenCalledWith(slug, ['card'])
  })

  it('timeout / busy after ready keep the ready card (stale) and never clear it', async () => {
    for (const kind of ['timeout', 'busy', 'unavailable'] as const) {
      live = { [WHOAMI]: failure(kind, `${kind} answer`) }
      const recorded = recorder()

      await expect(loadBank(INFT, slug, { force: false, knownState: READY }, recorded.sink)).rejects.toThrow()
      expect(recorded.states).toEqual([{ ...READY, stale: true }])
      expect(recorded.events).not.toContain('clear-snapshot')
      expect(recorded.events).not.toContain('reset')
    }
  })

  it('a missing agent is a setup notice and keeps the persisted card from the main process', async () => {
    probe('ready', 5)
    live = { [WHOAMI]: failure('not-provisioned', 'no active agent — run acp configure') }
    const recorded = recorder()

    await expect(loadBank(INFT, slug, { force: false }, recorded.sink)).rejects.toThrow()
    expect(recorded.states[0]).toMatchObject({ kind: 'ready', stale: true })
    expect(recorded.notices).toEqual([{ message: 'no active agent — run acp configure', setup: true }])
    expect(recorded.events).not.toContain('clear-snapshot')
  })

  it('a session that lapses under a secondary read keeps the card, the list and the snapshot', async () => {
    readyCard()
    live[THREE_DS] = failure('reauth-acp', 'Not authenticated.')
    const recorded = recorder()

    await loadBank(INFT, slug, { force: false }, recorded.sink)

    expect(recorded.states.at(-1)).toEqual({ cardKnown: true, email: 'pat@example.com', kind: 'session-expired' })
    expect(recorded.events).toContain('requests:2')
    expect(recorded.events).not.toContain('clear-snapshot')
    expect(recorded.events).not.toContain('reset')
  })

  it('R16.unit.card_list_cache_survives_failure: a failed list refresh keeps the list and says when it was read', async () => {
    readyCard()
    const first = recorder()

    await loadBank(INFT, slug, { force: false }, first.sink)
    expect(first.events).toContain('requests:2')
    expect(first.events).toContain('list:fresh')

    live[LIST] = failure('timeout', 'acp timed out after 30s')
    const second = recorder()

    await loadBank(INFT, slug, { force: true, knownState: READY }, second.sink)

    expect(second.events.some(event => event.startsWith('requests:'))).toBe(false)
    expect(second.events.find(event => event.startsWith('list:'))).toMatch(/^list:stale@\d+$/)
    expect(second.events).not.toContain('clear-snapshot')
    expect(second.events).not.toContain('reset')

    // A cold open whose first list read fails dates the list by the snapshot.
    slug = nextSlug()
    const cold = recorder()

    await loadBank(INFT, slug, { force: true, knownListAt: 1234, knownState: READY }, cold.sink)
    expect(cold.events).toContain('list:stale@1234')
  })
})

describe('loadBank — the boot probe against the cached whoami', () => {
  it('a probe that disagrees with the cache costs exactly one forced whoami', async () => {
    readyCard()
    cached[WHOAMI] = failure('not-provisioned', CLI_NOT_SIGNED_UP)
    probe('ready', 500)

    const recorded = recorder()

    await loadBank(INFT, slug, { force: false }, recorded.sink)

    expect(commands().filter(command => command.startsWith(WHOAMI))).toEqual([WHOAMI, `${WHOAMI} (forced)`])
    expect(recorded.states).toEqual([{ email: 'pat@example.com', kind: 'ready' }])

    acpJsonMock.mockClear()
    await loadBank(INFT, slug, { force: false }, recorder().sink)

    expect(commands()).not.toContain(`${WHOAMI} (forced)`)
  })

  it('never forces twice for the same probe, even while the two still disagree', async () => {
    readyCard()
    probe('none', 700)

    await loadBank(INFT, slug, { force: false }, recorder().sink)
    await loadBank(INFT, slug, { force: false }, recorder().sink)

    expect(commands().filter(command => command === `${WHOAMI} (forced)`)).toHaveLength(1)

    probe('none', 800)
    await loadBank(INFT, slug, { force: false }, recorder().sink)

    expect(commands().filter(command => command === `${WHOAMI} (forced)`)).toHaveLength(2)
  })

  it('an agreeing probe costs nothing extra', async () => {
    readyCard()
    probe('ready', 900)

    await loadBank(INFT, slug, { force: false }, recorder().sink)

    expect(commands()).toEqual([WHOAMI, LIST, THREE_DS, LIMIT, PROFILE])
  })

  it('keeps the cached answer when the forced re-read fails transiently', async () => {
    readyCard()
    cached[WHOAMI] = { raw: CLI_WHOAMI }
    live[WHOAMI] = failure('busy', 'busy: another call is in flight')
    probe('none', 1000)

    const recorded = recorder()

    await loadBank(INFT, slug, { force: false }, recorded.sink)

    expect(recorded.states[0]).toEqual({ email: 'pat@example.com', kind: 'ready' })
  })
})

describe('forgetCard / sameNotice', () => {
  it('forgetCard drops every cached card answer for the iNFT', () => {
    forgetCard(slug)

    expect(invalidateMock).toHaveBeenCalledWith(slug, ['card'])
  })

  it('sameNotice compares content', () => {
    expect(sameNotice(null, null)).toBe(true)
    expect(sameNotice({ message: 'a', setup: false }, { message: 'a', setup: false })).toBe(true)
    expect(sameNotice({ message: 'a', setup: false }, { message: 'a', setup: true })).toBe(false)
    expect(sameNotice({ message: 'a', setup: false }, null)).toBe(false)
  })
})
