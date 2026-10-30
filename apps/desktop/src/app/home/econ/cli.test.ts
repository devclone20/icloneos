import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as setup from '../acp-setup'

import {
  type AcpCallOptions,
  acpJson,
  acpWrite,
  asRecord,
  BLOCKED_COOLDOWN_MS,
  classifyAcpError,
  FAILURE_TTL_MS,
  humanizeAcpError,
  invalidateAcp,
  isCardNotSetUp,
  listAt,
  needsSetup,
  num,
  parseCliJson,
  RATE_LIMIT_COOLDOWN_MS,
  setupNotice,
  str
} from './cli'

const INFT = 'robinhood:0x4dfb27e4e6ade6afc8a21ab14751ee8b7ac75631:6'
const SLUG = 'robinhood-0x4dfb27e4e6ade6afc8a21ab14751ee8b7ac75631-6'

function ok(stdout: string) {
  return { ok: true, code: 0, stdout, stderr: '' }
}

describe('parseCliJson', () => {
  it('reads an object, a bare array, and a payload after a human line', () => {
    expect(parseCliJson('{"a":1}')).toEqual({ a: 1 })
    expect(parseCliJson('[]')).toEqual([])
    expect(parseCliJson('Fetching…\n[{"id":"x"}]')).toEqual([{ id: 'x' }])
    expect(parseCliJson('')).toBeUndefined()
    expect(parseCliJson('not json')).toBeUndefined()
  })
})

describe('tolerant readers', () => {
  it('never throw on the wrong shape', () => {
    expect(asRecord([])).toBeNull()
    expect(str(null, 'x', 'fallback')).toBe('fallback')
    expect(str({ n: 12 }, 'n')).toBe('12')
    expect(num({ v: '2693.86' }, 'v')).toBeCloseTo(2693.86)
    expect(num({ v: 'nope' }, 'v', 7)).toBe(7)
    expect(listAt([{ a: 1 }, 'junk', null], ['x'])).toEqual([{ a: 1 }])
    expect(listAt({ messages: [{ id: 1 }], other: 2 }, ['threads', 'messages'])).toEqual([{ id: 1 }])
    expect(listAt({ messages: 'no' }, ['messages'])).toEqual([])
  })
})

describe('humanizeAcpError', () => {
  it('unwraps the service envelope and names a re-auth plainly', () => {
    expect(
      humanizeAcpError(
        'HTTP 400: {"message":"AgentCard not set up for this agent. Call card signup first.","statusCode":400}'
      )
    ).toBe('AgentCard not set up for this agent. Call card signup first.')
    expect(
      humanizeAcpError('HTTP 401: {"message":"REAUTH:2159a9e9-c5fb:agent-6@example.com","error":"Unauthorized"}')
    ).toBe('Sign-in required')
    expect(humanizeAcpError('timed out after 60s')).toBe('timed out after 60s')
  })
})

describe('acpJson', () => {
  let run: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    run = vi.spyOn(setup, 'runAcp')
    invalidateAcp(SLUG)
  })

  afterEach(() => {
    run.mockRestore()
  })

  it('classifies the CLI states the apps render', async () => {
    run.mockResolvedValueOnce(ok('{"error":"HTTP 401: {\\"message\\":\\"REAUTH:abc-123:x@example.com\\"}"}'))
    const reauth = await acpJson(INFT, SLUG, ['card', 'whoami', '--json'], raw => raw)

    expect(reauth.ok).toBe(false)
    expect(reauth.ok ? null : reauth.kind).toBe('reauth')
    expect(reauth.ok ? null : reauth.reauthState).toBe('abc-123')

    run.mockResolvedValueOnce(
      ok('{"error":"HTTP 400: {\\"message\\":\\"AgentCard not set up for this agent. Call card signup first.\\"}"}')
    )
    const none = await acpJson(INFT, SLUG, ['card', 'limit', '--json'], raw => raw)

    expect(none.ok ? null : none.kind).toBe('not-provisioned')

    run.mockResolvedValueOnce({ ok: false, code: null, stdout: '', stderr: '', error: 'timed out after 60s' })
    const slow = await acpJson(INFT, SLUG, ['wallet', 'balance', '--json'], raw => raw)

    expect(slow.ok ? null : slow.kind).toBe('timeout')
  })

  it('puts each CLI read on the User Timing timeline with its lane wait', async () => {
    run.mockResolvedValueOnce(ok('{}'))
    performance.clearMeasures('acp:read')
    await acpJson(INFT, SLUG, ['email', 'thread', '--thread-id', 't-1', '--json'], raw => raw, { urgent: true })

    const [entry] = performance.getEntriesByName('acp:read') as PerformanceMeasure[]

    expect(entry?.detail).toMatchObject({ cmd: 'email thread', mode: 'urgent', threadId: 't-1' })
    expect(entry?.detail.queuedMs).toBeGreaterThanOrEqual(0)
  })

  it('runs calls for one iNFT strictly one after another', async () => {
    const order: string[] = []

    run.mockImplementation(async (_id: string, argv: string[]) => {
      order.push(`start ${argv[0]}`)
      await new Promise(resolve => setTimeout(resolve, argv[0] === 'wallet' ? 20 : 1))
      order.push(`end ${argv[0]}`)

      return ok('{}')
    })

    await Promise.all([
      acpJson(INFT, SLUG, ['wallet', 'balance', '--json'], raw => raw),
      acpJson(INFT, SLUG, ['email', 'inbox', '--json'], raw => raw),
      acpJson(INFT, SLUG, ['card', 'list', '--json'], raw => raw)
    ])

    expect(order).toEqual(['start wallet', 'end wallet', 'start email', 'end email', 'start card', 'end card'])
  })

  it('an urgent read starts at once beside a running background read, ahead of the queue — F3', async () => {
    const order: string[] = []

    run.mockImplementation(async (_id: string, argv: string[]) => {
      order.push(`start ${argv[1]}`)
      await new Promise(resolve => setTimeout(resolve, argv[1] === 'balance' ? 20 : 2))
      order.push(`end ${argv[1]}`)

      return ok('{}')
    })

    const background = acpJson(INFT, SLUG, ['wallet', 'balance', '--json'], raw => raw)
    const queued = acpJson(INFT, SLUG, ['card', 'list', '--json'], raw => raw)
    // A background read already queued is promoted when the owner joins it.
    const prefetched = acpJson(INFT, SLUG, ['email', 'whoami', '--json'], raw => raw)
    const opened = acpJson(INFT, SLUG, ['email', 'thread', '--json'], raw => raw, { urgent: true })
    const joined = acpJson(INFT, SLUG, ['email', 'whoami', '--json'], raw => raw, { urgent: true })

    await Promise.all([background, queued, prefetched, opened, joined])
    expect(run.mock.calls.map((call: unknown[]) => (call[1] as string[])[1])).toEqual([
      'balance',
      'thread',
      'whoami',
      'list'
    ])
    // The owner's two reads ran while the long background read was still running; the queued
    // background read waited for the background slot.
    expect(order.indexOf('start thread')).toBeLessThan(order.indexOf('end balance'))
    expect(order.indexOf('start whoami')).toBeLessThan(order.indexOf('end balance'))
    expect(order.indexOf('start list')).toBeGreaterThan(order.indexOf('end balance'))
  })

  it('a read-ahead takes the background slot ahead of the queued warm-ups; an open promotes the next — F3', async () => {
    run.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 5))

      return ok('{}')
    })

    const running = acpJson(INFT, SLUG, ['wallet', 'balance', '--json'], raw => raw)
    const warm = acpJson(INFT, SLUG, ['card', 'list', '--json'], raw => raw)
    const ahead = acpJson(INFT, SLUG, ['email', 'thread', '--thread-id', 't1', '--json'], raw => raw, { ahead: true })
    const second = acpJson(INFT, SLUG, ['email', 'thread', '--thread-id', 't2', '--json'], raw => raw, { ahead: true })
    const opened = acpJson(INFT, SLUG, ['email', 'thread', '--thread-id', 't2', '--json'], raw => raw, { urgent: true })

    await Promise.all([running, warm, ahead, second, opened])
    expect(run.mock.calls.map((call: unknown[]) => (call[1] as string[]).slice(0, 4).join(' '))).toEqual([
      'wallet balance --json',
      'email thread --thread-id t2',
      'email thread --thread-id t1',
      'card list --json'
    ])
  })

  it('boot warm-ups (3.5 s each) never delay the newest threads; an open starts at its click', async () => {
    vi.useFakeTimers()

    try {
      const started: Record<string, number> = {}

      run.mockImplementation(async (_id: string, argv: string[]) => {
        started[argv.includes('--thread-id') ? argv[3] : argv.slice(0, 2).join(' ')] = Date.now()
        await new Promise(resolve => setTimeout(resolve, 3_500))

        return ok('{}')
      })

      const t0 = Date.now()

      // Stage: the identity and three dock warm-ups queue first, then the email warm pins the newest two threads
      // (the prefetcher reads them one at a time).
      const boot = ['agent whoami', 'wallet balance', 'card list', 'market list'].map(cmd =>
        acpJson(INFT, SLUG, [...cmd.split(' '), '--json'], raw => raw)
      )

      const thread = (id: string, options: AcpCallOptions) =>
        acpJson(INFT, SLUG, ['email', 'thread', '--thread-id', id, '--json'], raw => raw, options)

      const warmed = thread('t1', { ahead: true }).then(() => thread('t2', { ahead: true }))

      await vi.advanceTimersByTimeAsync(5_000)
      // The owner opens another thread while t1 holds the background slot: the urgent slot is free for it.
      const other = thread('t3', { urgent: true })

      await vi.advanceTimersByTimeAsync(30_000)
      await Promise.all([...boot, warmed, other])

      // t1 queued ahead of every warm-up; t2, asked once t1 answered, takes the background slot's next turn.
      expect(started['agent whoami'] - t0).toBe(0)
      expect(started.t1 - t0).toBe(3_500)
      expect(started.t3 - t0).toBe(5_000)
      expect(started['wallet balance'] - t0).toBe(7_000)
      expect(started.t2 - t0).toBe(10_500)
      expect(started['market list'] - t0).toBe(17_500)
    } finally {
      vi.useRealTimers()
    }
  })

  it('main hands an unconfirmed expiry back as "busy" (retried on its own), never as a sign-in', () => {
    // The words of electron/iclone-acp.ts unconfirmedExpiry().
    expect(classifyAcpError('busy: the Virtuals session was refreshing during this read')).toEqual({ kind: 'busy' })
  })

  it('never runs more than two reads at once, and a write alone', async () => {
    let running = 0
    let peak = 0
    const events: string[] = []

    run.mockImplementation(async (_id: string, argv: string[]) => {
      running += 1
      peak = Math.max(peak, running)
      events.push(`start ${argv[1]} ${running}`)
      await new Promise(resolve => setTimeout(resolve, 3))
      running -= 1

      return ok('{}')
    })

    await Promise.all([
      acpJson(INFT, SLUG, ['email', 'inbox', '--json'], raw => raw, { urgent: true }),
      acpJson(INFT, SLUG, ['email', 'thread', '--json'], raw => raw, { urgent: true }),
      acpJson(INFT, SLUG, ['email', 'search', '--json'], raw => raw, { urgent: true }),
      acpWrite(INFT, SLUG, ['email', 'reply', '--json']),
      acpJson(INFT, SLUG, ['wallet', 'balance', '--json'], raw => raw)
    ])
    expect(peak).toBe(2)
    expect(events.find(step => step.startsWith('start reply'))).toBe('start reply 1')
  })

  it('shares one in-flight call and serves a fresh answer from memory', async () => {
    run.mockResolvedValue(ok('{"address":"0x1"}'))

    const [a, b] = await Promise.all([
      acpJson(INFT, SLUG, ['wallet', 'address', '--json'], raw => raw, { ttlMs: 60_000 }),
      acpJson(INFT, SLUG, ['wallet', 'address', '--json'], raw => raw, { ttlMs: 60_000 })
    ])

    expect(a.ok && b.ok).toBe(true)
    expect(run).toHaveBeenCalledTimes(1)

    await acpJson(INFT, SLUG, ['wallet', 'address', '--json'], raw => raw, { ttlMs: 60_000 })
    expect(run).toHaveBeenCalledTimes(1)

    await acpJson(INFT, SLUG, ['wallet', 'address', '--json'], raw => raw, { ttlMs: 60_000, force: true })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('forgets a cached answer after a write invalidates its prefix', async () => {
    run.mockResolvedValue(ok('{"messages":[]}'))

    await acpJson(INFT, SLUG, ['email', 'inbox', '--json'], raw => raw, { ttlMs: 60_000 })
    await acpWrite(INFT, SLUG, ['email', 'compose', '--to', 'a@b.co', '--subject', 's', '--body', 'b', '--json'])
    invalidateAcp(SLUG, ['email'])
    await acpJson(INFT, SLUG, ['email', 'inbox', '--json'], raw => raw, { ttlMs: 60_000 })

    expect(run).toHaveBeenCalledTimes(3)
  })

  it('stamps a cached answer with the time it was REQUESTED, shared by every joiner', async () => {
    const now = vi.spyOn(Date, 'now')
    // Built up front: the executor runs now, so `settle` is the real resolver
    // before the queued task ever asks for the promise.
    let settle: (value: ReturnType<typeof ok>) => void = () => undefined

    const slow = new Promise<ReturnType<typeof ok>>(resolve => {
      settle = resolve
    })

    try {
      now.mockReturnValue(1_000)
      run.mockImplementationOnce(() => slow)

      const first = acpJson(INFT, SLUG, ['wallet', 'balance', '--json'], raw => raw, { ttlMs: 60_000 })

      // A second reader joins the same in-flight read two seconds later.
      now.mockReturnValue(3_000)

      const joiner = acpJson(INFT, SLUG, ['wallet', 'balance', '--json'], raw => raw, { ttlMs: 60_000 })

      // The answer lands five seconds after the request.
      now.mockReturnValue(6_000)
      settle(ok('{"slow":true}'))

      const [a, b] = await Promise.all([first, joiner])

      expect(run).toHaveBeenCalledTimes(1)
      expect(a.ok && a.at).toBe(1_000)
      expect(b.ok && b.at).toBe(1_000)

      // Fifty-nine seconds after the REQUEST it is still fresh…
      now.mockReturnValue(1_000 + 59_000)
      run.mockResolvedValue(ok('{"fresh":true}'))
      await acpJson(INFT, SLUG, ['wallet', 'balance', '--json'], raw => raw, { ttlMs: 60_000 })
      expect(run).toHaveBeenCalledTimes(1)

      // …and one period after the request it has expired, whatever the latency was.
      now.mockReturnValue(1_000 + 60_000)
      await acpJson(INFT, SLUG, ['wallet', 'balance', '--json'], raw => raw, { ttlMs: 60_000 })
      expect(run).toHaveBeenCalledTimes(2)
    } finally {
      now.mockRestore()
    }
  })

  it('does not remember transient failures', async () => {
    run.mockResolvedValueOnce({
      ok: false,
      code: null,
      stdout: '',
      stderr: '',
      error: 'busy — a CLI call for this iNFT is still running'
    })
    run.mockResolvedValueOnce(ok('{"ok":true}'))

    const first = await acpJson(INFT, SLUG, ['agent', 'whoami', '--json'], raw => raw, { ttlMs: 60_000 })
    const second = await acpJson(INFT, SLUG, ['agent', 'whoami', '--json'], raw => raw, { ttlMs: 60_000 })

    expect(first.ok).toBe(false)
    expect(second.ok).toBe(true)
  })
})

describe('acpJson failure states (R3)', () => {
  let run: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    run = vi.spyOn(setup, 'runAcp')
    invalidateAcp(SLUG)
  })

  afterEach(() => {
    run.mockRestore()
  })

  it('expires a remembered reauth before the data TTL, so a transient 401 heals', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)

    try {
      const ttlMs = 10 * 60_000

      expect(FAILURE_TTL_MS).toBeLessThan(ttlMs)
      run.mockResolvedValueOnce(ok('{"error":"HTTP 401: {\\"message\\":\\"Unauthorized\\"}"}'))
      const first = await acpJson(INFT, SLUG, ['card', 'whoami', '--json'], raw => raw, { ttlMs })

      expect(first.ok ? null : first.kind).toBe('reauth')

      // Inside the failure life it is still the remembered state…
      now.mockReturnValue(1_000 + FAILURE_TTL_MS - 1)
      await acpJson(INFT, SLUG, ['card', 'whoami', '--json'], raw => raw, { ttlMs })
      expect(run).toHaveBeenCalledTimes(1)

      // …and past it the CLI is asked again, long before the 10-minute data TTL.
      now.mockReturnValue(1_000 + FAILURE_TTL_MS)
      run.mockResolvedValueOnce(ok('{"name":"agent"}'))
      const healed = await acpJson(INFT, SLUG, ['card', 'whoami', '--json'], raw => raw, { ttlMs })

      expect(run).toHaveBeenCalledTimes(2)
      expect(healed.ok).toBe(true)

      // A good answer keeps the full data TTL.
      now.mockReturnValue(1_000 + FAILURE_TTL_MS + ttlMs - 1)
      await acpJson(INFT, SLUG, ['card', 'whoami', '--json'], raw => raw, { ttlMs })
      expect(run).toHaveBeenCalledTimes(2)
    } finally {
      now.mockRestore()
    }
  })

  it('classifies the service "no agents found" as an ordinary failure, not "not provisioned"', async () => {
    for (const text of [
      'HTTP 404: {\\"message\\":\\"no agents found\\"}',
      'HTTP 404: {\\"message\\":\\"No agents found for this query\\",\\"statusCode\\":404}'
    ]) {
      invalidateAcp(SLUG)
      run.mockResolvedValueOnce(ok(`{"error":"${text}"}`))
      const result = await acpJson(INFT, SLUG, ['agent', 'list', '--json'], raw => raw)

      expect(result.ok ? null : result.kind).toBe('cli')
    }

    run.mockResolvedValueOnce(ok('{"error":"no active agent — run acp configure"}'))
    invalidateAcp(SLUG)
    const none = await acpJson(INFT, SLUG, ['agent', 'whoami', '--json'], raw => raw)

    expect(none.ok ? null : none.kind).toBe('not-provisioned')
  })

  it('never caches a timeout', async () => {
    run.mockResolvedValue({ ok: false, code: null, stdout: '', stderr: '', error: 'timed out after 60s' })
    await acpJson(INFT, SLUG, ['wallet', 'balance', '--json'], raw => raw, { ttlMs: 60_000 })
    await acpJson(INFT, SLUG, ['wallet', 'balance', '--json'], raw => raw, { ttlMs: 60_000 })
    expect(run).toHaveBeenCalledTimes(2)
  })
})

describe('classifyAcpError — 403/429 cooldowns (R6)', () => {
  it('a 429 is rate-limited for a minute, a 403 or a blocked account waits 15 minutes', () => {
    expect(classifyAcpError('HTTP 429: {"message":"slow down"}')).toEqual({
      kind: 'cli',
      limit: 'rate-limited',
      cooldownMs: RATE_LIMIT_COOLDOWN_MS,
      httpStatus: 429
    })
    expect(classifyAcpError('HTTP 403: {"message":"forbidden"}')).toEqual({
      kind: 'cli',
      limit: 'blocked',
      cooldownMs: BLOCKED_COOLDOWN_MS,
      httpStatus: 403
    })
    expect(classifyAcpError('account suspended').limit).toBe('blocked')
    expect(classifyAcpError('wallet unlocked').limit).toBeUndefined()
  })

  it('keeps the REAUTH state first and the old kinds unchanged', () => {
    expect(classifyAcpError('HTTP 401: REAUTH:ab12-cd:agent@x.io')).toEqual({
      kind: 'reauth',
      reauthState: 'ab12-cd',
      httpStatus: 401
    })
    expect(classifyAcpError('Card not set up. Call card signup first.').kind).toBe('not-provisioned')
    expect(classifyAcpError('timed out after 60s').kind).toBe('timeout')
  })
})

describe('classifyAcpError — the ACP tools refusal (REL-6, critic m4)', () => {
  it('reads main’s machine prefix, not its words', () => {
    for (const message of [
      '[acp-tools:absent] ACP tools are not installed: install them from ACP Market (downloads from npm)',
      '[acp-tools:unverified:file-changed] anything at all',
      '[acp-tools:unavailable:unsealable] whatever the log says',
      '[acp-tools:installing] ACP tools are being installed'
    ]) {
      expect(classifyAcpError(message).kind).toBe('unavailable')
    }
  })

  it('the old English sentence alone is not a tools refusal any more', () => {
    expect(classifyAcpError('ACP tools could not be verified (x)').kind).not.toBe('unavailable')
  })
})

describe('acpJson honours the classifier cooldowns (R6 r2)', () => {
  let run: ReturnType<typeof vi.spyOn>
  const WHOAMI = ['card', 'whoami', '--json']
  const TTL = 10 * 60_000

  beforeEach(() => {
    run = vi.spyOn(setup, 'runAcp')
    invalidateAcp(SLUG)
  })

  afterEach(() => {
    run.mockRestore()
  })

  async function hourOfTicks(stdout: string): Promise<number> {
    const now = vi.spyOn(Date, 'now')

    try {
      run.mockResolvedValue({ ok: false, code: 1, stdout, stderr: '' })

      for (let t = 0; t < 3_600_000; t += 60_000) {
        now.mockReturnValue(1_000 + t)
        await acpJson(INFT, SLUG, WHOAMI, raw => raw, { ttlMs: TTL })
      }

      return run.mock.calls.length
    } finally {
      now.mockRestore()
    }
  }

  it('a pending sign-in (REAUTH with a state) lives the whole read TTL: ≤ 6 whoami per hour at 60 s', async () => {
    expect(await hourOfTicks('{"error":"HTTP 401: REAUTH:0123abcd-4567:agent@mail.acp.virtuals.io"}')).toBe(6)
  })

  it('a 429 waits at least the read TTL and a 403 its 15-minute cooldown', async () => {
    expect(await hourOfTicks('{"error":"HTTP 429: Too Many Requests"}')).toBe(6)
    invalidateAcp(SLUG)
    run.mockReset()
    expect(await hourOfTicks('{"error":"HTTP 403: Forbidden — account blocked"}')).toBe(4)
  })

  it('a forced or uncached read still waits out a service limit, but not a plain failure', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(5_000)

    try {
      run.mockResolvedValue({ ok: false, code: 1, stdout: '{"error":"HTTP 429: slow down"}', stderr: '' })
      await acpJson(INFT, SLUG, WHOAMI, raw => raw)
      const again = await acpJson(INFT, SLUG, WHOAMI, raw => raw, { force: true })

      expect(run).toHaveBeenCalledTimes(1)
      expect(again.ok ? null : again.limit).toBe('rate-limited')

      now.mockReturnValue(5_000 + RATE_LIMIT_COOLDOWN_MS)
      await acpJson(INFT, SLUG, WHOAMI, raw => raw, { force: true })
      expect(run).toHaveBeenCalledTimes(2)
    } finally {
      now.mockRestore()
    }
  })
})

// R16 — an expired Virtuals session is never "no card" and never "setup needed".
describe('classifyAcpError — the kind split (R16.unit.kinds_split)', () => {
  const kindOf = (message: string) => classifyAcpError(message).kind
  const failureOf = (message: string) => ({ error: message, ok: false as const, ...classifyAcpError(message) })

  it('"Not authenticated" (expired ACP session) is reauth-acp, even with "Run `acp configure`" in the recovery', () => {
    for (const message of [
      'Not authenticated.',
      'Error: Not authenticated.',
      '{"error":"Not authenticated.","code":"NOT_AUTHENTICATED","recovery":"Run `acp configure` to authenticate."}',
      'session expired — sign in again',
      'not logged in',
      'login required'
    ]) {
      expect(kindOf(message)).toBe('reauth-acp')
      expect(isCardNotSetUp(failureOf(message))).toBe(false)
    }
  })

  it('only "not set up" / "call card signup" is the card\'s authoritative not-provisioned', () => {
    for (const message of [
      'HTTP 400: {"message":"Call card signup first."}',
      'HTTP 400: AgentCard not set up for this agent. Call card signup first.'
    ]) {
      expect(kindOf(message)).toBe('not-provisioned')
      expect(isCardNotSetUp(failureOf(message))).toBe(true)
    }

    // Main parity (R16 r4): a 5xx / 404 / no-status "not set up", or another service's noun, is NOT the card's none.
    for (const message of [
      'HTTP 503: profile service not set up yet, retry later',
      'HTTP 404: card not set up — call card signup',
      'card not set up',
      'HTTP 400: Agent wallet not set up',
      'HTTP 400: {"message":"Signer policy not set up"}',
      'HTTP 400: email inbox not set up yet'
    ]) {
      expect(isCardNotSetUp(failureOf(message))).toBe(false)
    }
  })

  it('a missing or unconfigured AGENT is not-provisioned, but never the card\'s "none"', () => {
    for (const message of ['no active agent', 'agent not configured', 'run `acp configure` first', 'not provisioned']) {
      expect(kindOf(message)).toBe('not-provisioned')
      expect(isCardNotSetUp(failureOf(message))).toBe(false)
    }
  })

  it('REAUTH stays the card sign-in; reauth-acp is a setup-only state whose line is "Sign in again"', () => {
    expect(kindOf('HTTP 401: {"message":"REAUTH:abc-123:a@b.c"}')).toBe('reauth')
    expect(needsSetup(failureOf('Not authenticated.'))).toBe(true)
    expect(setupNotice(failureOf('Not authenticated.'))).toBe('Sign in again')
    expect(setupNotice(failureOf('no active agent'))).toBe('Setup needed')
  })

  it('reauth-acp is remembered like the other states (one CLI call for two reads)', async () => {
    const run = vi.spyOn(setup, 'runAcp').mockResolvedValue({
      code: 1,
      error: undefined,
      ok: true,
      stderr: '',
      stdout: '{"error":"Not authenticated.","code":"NOT_AUTHENTICATED"}'
    })

    invalidateAcp('kinds-split')
    const first = await acpJson('i', 'kinds-split', ['card', 'whoami', '--json'], raw => raw, { ttlMs: 60_000 })
    const second = await acpJson('i', 'kinds-split', ['card', 'whoami', '--json'], raw => raw, { ttlMs: 60_000 })

    expect(first.ok ? null : first.kind).toBe('reauth-acp')
    expect(second.ok ? null : second.kind).toBe('reauth-acp')
    expect(run).toHaveBeenCalledTimes(1)
    run.mockRestore()
  })
})
