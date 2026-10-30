import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { composeAskHermes } from './inft-setup-ask'
import {
  cardErrorInfo,
  hydrateSignup,
  IDLE_SIGNUP,
  isSignupDone,
  MAX_POLLS,
  nextDelayMs,
  pickNewestMessageId,
  pickSigninLink,
  reduceSignup,
  serializeSignup,
  shouldFetchLink,
  signupGate
} from './inft-setup-card-signup'

const acp = vi.hoisted(() => ({
  refreshAcpStatus: vi.fn(),
  runAcp: vi.fn(),
  inftKvGet: vi.fn(),
  inftKvSet: vi.fn(),
  inftKvDelete: vi.fn()
}))

const ext = vi.hoisted(() => ({ openExternal: vi.fn() }))
vi.mock('../home/acp-setup', () => acp)
vi.mock('../home/lib/external', () => ext)

import { CONFIRM_WINDOW_MS, useCardSteps } from './inft-setup-card'
import { SIGNUP_IN_FLIGHT_GATE } from './inft-setup-card-flight'
import { useStepRunner } from './inft-setup-runner'
import { cardErrorSentence, cardRefusalSentence, INFT_WIZARD_COPY } from './inft-setup-wizard-copy'

const ok = (stdout: string) => ({ ok: true, code: 0, stdout, stderr: '' })

const status = (extra: object = {}) =>
  ({
    cli: true,
    authenticated: true,
    cardReady: false,
    configured: true,
    checkedAt: 1,
    slug: 's',
    email: 'a@agentcard.ai',
    cardState: 'none',
    ...extra
  }) as never

const T0 = 1_000_000

describe('signup machine', () => {
  it('done only on done === true', () => {
    expect(isSignupDone({ done: true })).toBe(true)

    for (const json of [{ done: false }, { error: 'already done' }, { status: 'complete' }, null]) {
      expect(isSignupDone(json)).toBe(false)
    }
  })

  it('G2: backs off 5/10/20/40/60 s and spends at most 18 polls in 15 min', () => {
    expect([0, 1, 2, 3, 4, 9].map(nextDelayMs)).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000])

    let s = reduceSignup(IDLE_SIGNUP, { type: 'sent', state: 'st1', now: T0, source: 'local' })
    let polls = 0

    while (s.phase === 'polling') {
      s = reduceSignup(s, { type: 'poll', json: { done: false }, now: s.nextPollAt! })
      polls += 1
    }

    expect(s.phase).toBe('expired')
    expect(polls).toBeLessThanOrEqual(MAX_POLLS)
  })

  it('429 → 60 s cooldown, 403 → 15 min; the gate refuses a signup meanwhile', () => {
    const s = reduceSignup(IDLE_SIGNUP, { type: 'sent', state: 'st1', now: T0, source: 'local' })
    const rate = reduceSignup(s, { type: 'poll-error', info: cardErrorInfo(ok('{"error":"HTTP 429: x"}')), now: T0 })
    const block = reduceSignup(s, { type: 'poll-error', info: cardErrorInfo(ok('{"error":"HTTP 403: x"}')), now: T0 })

    expect(rate).toMatchObject({ phase: 'cooldown', cooldownUntil: T0 + 60_000 })
    expect(block).toMatchObject({ phase: 'cooldown', cooldownUntil: T0 + 15 * 60_000 })
    expect(signupGate(block, status(), T0 + 1).gate).toBe('refused')
    expect(reduceSignup(rate, { type: 'tick', now: T0 + 60_000 }).phase).toBe('expired')
  })

  it('gate: blocked / unknown refuse; pending offers only a fresh link — a card with an account is never offered a signup', () => {
    expect(signupGate(IDLE_SIGNUP, status({ cardState: 'blocked' }), T0).gate).toBe('refused')
    expect(signupGate(IDLE_SIGNUP, status({ cardState: undefined }), T0).gate).toBe('refused')
    expect(signupGate(IDLE_SIGNUP, status({ cardStale: true }), T0).gate).toBe('refused')
    expect(signupGate(IDLE_SIGNUP, status({ cardState: 'signin-pending' }), T0).gate).toBe('resend')
    expect(signupGate(IDLE_SIGNUP, status(), T0).gate).toBe('allowed')
    const sent = reduceSignup(IDLE_SIGNUP, { type: 'sent', state: 'st1', now: T0, source: 'local' })
    expect(signupGate(sent, status(), T0 + 1_000).gate).toBe('refused')
  })

  it('hydrates from the server REAUTH state first; a mismatching local token loses', () => {
    const local = { phase: 'polling', state: 'old', sentAt: T0, pollStartedAt: T0, polls: 1, attempt: 1, fetches: 0 }
    const server = hydrateSignup(local, status({ cardState: 'signin-pending', cardReauthState: 'new' }), T0 + 1_000)

    expect(server).toMatchObject({ state: 'new', phase: 'expired', source: 'server' })
    expect(
      hydrateSignup(local, status({ cardState: 'signin-pending', cardReauthState: 'old' }), T0 + 1_000)
    ).toMatchObject({
      state: 'old',
      phase: 'polling'
    })
    // Only a "none" read that started at or after the signup clears it; an older one never saw it.
    expect(hydrateSignup(local, status({ cardCheckedAt: T0 }), T0).phase).toBe('idle')
    expect(hydrateSignup(local, status({ cardCheckedAt: T0 - 1 }), T0 + 1_000).phase).toBe('polling')
    expect(hydrateSignup(local, status({ cardState: undefined }), T0 + 20 * 60_000).phase).toBe('expired')
    expect(hydrateSignup({ phase: 'polling' }, undefined, T0).phase).toBe('idle')
  })

  it('a refused FIRST signup (no token yet) keeps its cooldown across a remount', () => {
    for (const body of ['HTTP 403: Forbidden', 'HTTP 429: Too Many Requests']) {
      const info = cardErrorInfo({ ok: false, code: 1, stdout: JSON.stringify({ error: body }), stderr: '' } as never)
      const live = reduceSignup(IDLE_SIGNUP, { type: 'poll-error', info, now: T0 })
      const persisted = JSON.parse(JSON.stringify(serializeSignup(live)))
      const remounted = hydrateSignup(persisted, status(), T0 + 5_000)

      expect(signupGate(live, status(), T0 + 5_000).gate).toBe('refused')
      expect(remounted).toMatchObject({ phase: 'cooldown', cooldownUntil: live.cooldownUntil })
      expect(remounted.lastError?.limit).toBe(info.limit)
      expect(signupGate(remounted, status(), T0 + 5_000)).toMatchObject({ gate: 'refused' })
      // …and only the cooldown: once it lapses the server's "never signed up" wins again.
      expect(hydrateSignup(persisted, status(), T0 + 16 * 60_000).phase).toBe('idle')
    }
  })

  it('a blocked account never resumes polling on hydrate', () => {
    const polling = reduceSignup(IDLE_SIGNUP, {
      type: 'sent',
      state: 'tok-1',
      email: 'a@b.c',
      now: T0,
      source: 'local'
    })

    const persisted = JSON.parse(JSON.stringify(serializeSignup(polling)))
    const blocked = status({ cardState: 'blocked', cardHttpStatus: 403 })
    const hydrated = hydrateSignup(persisted, blocked, T0 + 60_000)

    expect(hydrated.phase).toBe('expired')
    expect(hydrated.nextPollAt).toBeUndefined()
    expect(hydrateSignup(null, blocked, T0).phase).toBe('idle')
    expect(signupGate(hydrated, blocked, T0 + 60_000).gate).toBe('refused')
  })

  it('a legacy status with cardReady and no cardState reads as ready', () => {
    const legacy = status({ cardState: undefined, cardReady: true })
    const cooled = { phase: 'cooldown', cooldownUntil: T0 + 60_000, attempt: 0, polls: 0, fetches: 0 }

    expect(hydrateSignup(cooled, legacy, T0 + 60_001).phase).toBe('done')
    // A live service cooldown outlives a ready card: the card calls stay held until it ends.
    expect(hydrateSignup(cooled, legacy, T0).phase).toBe('cooldown')
    expect(signupGate(IDLE_SIGNUP, legacy, T0).gate).toBe('refused')
  })

  it('persists a cooldown reason only, validated on read', () => {
    const info = { code: 'blocked' as const, limit: 'blocked' as const, cooldownMs: 900_000 }
    const cooled = reduceSignup(IDLE_SIGNUP, { type: 'poll-error', info, now: T0 })

    expect(serializeSignup(cooled).lastError).toEqual(info)
    expect(serializeSignup({ ...cooled, phase: 'expired' }).lastError).toBeUndefined()
    expect(
      hydrateSignup({ phase: 'cooldown', cooldownUntil: T0 + 1_000, lastError: { code: 'nope' } }, status(), T0)
        .lastError
    ).toBeUndefined()
  })

  it('link hunt: ≤ 3 searches (after polls 2, 4, 8), agentcard hosts only', () => {
    let s = reduceSignup(IDLE_SIGNUP, { type: 'sent', state: 'st1', now: T0, source: 'local' })
    let fetches = 0

    while (s.phase === 'polling') {
      s = reduceSignup(s, { type: 'poll', json: {}, now: s.nextPollAt! })

      if (shouldFetchLink(s)) {
        fetches += 1
        s = reduceSignup(s, { type: 'fetched' })
      }
    }

    expect(fetches).toBe(3)
    expect(
      pickSigninLink({ links: [{ url: 'https://evil.ai/agentcard.ai' }, { url: 'http://agentcard.ai/x' }] })
    ).toBeUndefined()
    expect(pickSigninLink({ links: [{ url: 'https://app.agentcard.ai/login?t=1' }] })).toBe(
      'https://app.agentcard.ai/login?t=1'
    )
    expect(
      pickNewestMessageId({
        messages: [
          { id: 'm1', receivedAt: '2026-01-01' },
          { id: 'm2', receivedAt: '2026-02-01' }
        ]
      })
    ).toBe('m2')
  })

  it('ask Hermes carries notes + the last output, redacted', () => {
    const text = composeAskHermes({
      name: 'iclone',
      topic: 'the card',
      notes: 'used Bearer abcdefghijklmnopqrstuvwxyz0123',
      step: { running: false, error: 'blocked', last: { stdout: '{"ok":1}', stderr: '', at: 1 } }
    })

    expect(text).toContain('My saved notes for this step')
    expect(text).toContain('Last CLI output (redacted):\n{"ok":1}')
    expect(text).toContain('Last error: blocked')
    expect(text).not.toContain('abcdefghijklmnop')
  })
})

describe('useCardSteps — never repeats a signup', () => {
  beforeEach(() => {
    vi.useFakeTimers()

    for (const fn of Object.values(acp)) {
      fn.mockReset()
    }

    ext.openExternal.mockReset()
    acp.refreshAcpStatus.mockResolvedValue(null)
    acp.inftKvGet.mockResolvedValue({ ok: true, value: null })
    acp.inftKvSet.mockResolvedValue({ ok: true, value: {} })
    acp.inftKvDelete.mockResolvedValue({ ok: true, value: null })
  })
  afterEach(() => vi.useRealTimers())

  const setup = (st = status()) =>
    renderHook(
      ({ s }) => {
        const runner = useStepRunner('inft-1')

        return { card: useCardSteps({ runner, status: s, inftId: 'inft-1' }), runner }
      },
      { initialProps: { s: st } }
    )

  const calls = (sub: string) => acp.runAcp.mock.calls.filter(([, argv]) => argv.slice(0, 2).join(' ') === sub).length

  it('G1: one signup per state token; a second click sends nothing; done → kv delete + refresh {card:true}', async () => {
    acp.runAcp.mockImplementation(async (_id: string, argv: string[]) => {
      const sub = argv.slice(0, 2).join(' ')

      if (sub === 'card signup') {
        return ok('{"state":"st-1"}')
      }

      if (sub === 'card signup-poll') {
        return ok(calls('card signup-poll') >= 3 ? '{"done":true}' : '{"done":false}')
      }

      if (sub === 'email search') {
        return ok('{"messages":[{"id":"m9","receivedAt":"2026-10-16"}]}')
      }

      if (sub === 'email extract-links') {
        return ok('{"links":[{"url":"https://agentcard.ai/auth?x=1"}]}')
      }

      return ok('{}')
    })

    const { result } = setup()

    await act(() => vi.advanceTimersByTimeAsync(0))
    await act(() => result.current.card.cardSignup())
    await act(() => result.current.card.cardSignup())
    await act(() => vi.advanceTimersByTimeAsync(5_000 + 10_000 + 20_000 + 1))

    expect(calls('card signup')).toBe(1)
    expect(calls('card signup-poll')).toBe(3)
    expect(acp.runAcp).toHaveBeenCalledWith('inft-1', ['email', 'extract-links', '--message-id', 'm9', '--json'])
    expect(ext.openExternal).toHaveBeenCalledTimes(1)
    expect(result.current.card.signup.phase).toBe('done')
    expect(acp.inftKvDelete).toHaveBeenLastCalledWith('inft-1', 'card-signup')
    expect(acp.refreshAcpStatus).toHaveBeenLastCalledWith('inft-1', { card: true })
  })

  it('a waiting server link resumes with 0 signups; Resend sends one fresh link, never "send a new link"', async () => {
    acp.runAcp.mockResolvedValue(ok('{"done":false}'))

    const { result } = setup(status({ cardState: 'signin-pending', cardReauthState: 'ab-12' }))

    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(result.current.card.signup).toMatchObject({ phase: 'expired', state: 'ab-12' })
    act(() => result.current.card.resumeSignup())
    await act(() => vi.advanceTimersByTimeAsync(5_001))
    expect(calls('card signup-poll')).toBe(1)
    expect(calls('card signup')).toBe(0)
    expect(result.current.card.gate.gate).toBe('resend')
    await act(() => result.current.card.cardSignup())
    expect(result.current.card.confirmArmed).toBe(false)
    expect(calls('card signup')).toBe(1)
  })

  it('a blocked account is never offered a signup', async () => {
    const { result } = setup(status({ cardState: 'blocked' }))

    await act(() => result.current.card.cardSignup())
    expect(result.current.card.gate.gate).toBe('refused')
    expect(calls('card signup')).toBe(0)
  })
})

describe('useStepRunner.pollUntil — timeouts ask to resume', () => {
  afterEach(() => vi.useRealTimers())

  it('stalls after maxTicks with a resume, never "retry the step"', async () => {
    vi.useFakeTimers()
    acp.runAcp.mockReset().mockResolvedValue(ok('{"status":"pending"}'))
    acp.refreshAcpStatus.mockResolvedValue(null)

    const { result } = renderHook(() => useStepRunner('inft-1'))

    act(() =>
      result.current.pollUntil('signer', ['agent', 'signer-status'], () => false, vi.fn(), {
        maxTicks: 2,
        delayMs: () => 100
      })
    )
    await act(() => vi.advanceTimersByTimeAsync(250))
    expect(acp.runAcp).toHaveBeenCalledTimes(2)
    expect(result.current.steps.signer).toMatchObject({ stalled: true })
    expect(result.current.steps.signer?.note).toMatch(/resume/)
    act(() => result.current.resumePoll('signer'))
    await act(() => vi.advanceTimersByTimeAsync(250))
    expect(acp.runAcp).toHaveBeenCalledTimes(4)
  })
})

describe('R6 r3 — an ambiguous signup never re-opens the gate', () => {
  const REAUTH = '{"error":"HTTP 401: REAUTH:0123abcd-4567-89ef-0123-456789abcdef:agent@mail.acp.virtuals.io"}'

  const answers = {
    timeout: { ok: false, code: null, stdout: '', stderr: '', error: 'timed out after 90s' },
    '5xx': { ok: false, code: 1, stdout: '{"error":"HTTP 502: Bad Gateway"}', stderr: '' },
    reauth: { ok: false, code: 1, stdout: REAUTH, stderr: '' },
    no_state: ok('{"message":"Magic link sent"}')
  }

  it('timeout / 5xx / no state → unconfirmed; REAUTH → the server token, polling', () => {
    for (const [name, result] of Object.entries(answers)) {
      const info = cardErrorInfo(result as never)
      const s = reduceSignup(IDLE_SIGNUP, { type: 'poll-error', info, now: T0 })

      expect(signupGate(s, status(), T0 + 2_000).gate, name).not.toBe('allowed')
      expect(info.code).not.toBe('held')

      if (name === 'reauth') {
        expect(s).toMatchObject({
          phase: 'polling',
          state: '0123abcd-4567-89ef-0123-456789abcdef',
          email: 'agent@mail.acp.virtuals.io',
          source: 'server'
        })
      } else {
        expect(s).toMatchObject({ phase: 'unconfirmed', sentAt: T0 })
      }
    }
  })

  it('a clean refusal (400) keeps the gate open', () => {
    const info = cardErrorInfo({
      ok: false,
      code: 1,
      stdout: '{"error":"HTTP 400: invalid email"}',
      stderr: ''
    } as never)

    const s = reduceSignup(IDLE_SIGNUP, { type: 'poll-error', info, now: T0 })

    expect(s.phase).toBe('idle')
    expect(signupGate(s, status(), T0 + 1).gate).toBe('allowed')
  })

  it('only a card re-read newer than the signup ends it; the server token wins', () => {
    const info = cardErrorInfo(answers['5xx'] as never)
    const s = reduceSignup(IDLE_SIGNUP, { type: 'poll-error', info, now: T0 })
    const reread = (extra: object) => reduceSignup(s, { type: 'reread', status: status(extra) })

    expect(reread({ cardCheckedAt: T0 - 1 }).phase).toBe('unconfirmed')
    expect(reread({ cardCheckedAt: T0 + 5, cardStale: true }).phase).toBe('unconfirmed')
    expect(reread({ cardCheckedAt: T0 + 5 })).toEqual(IDLE_SIGNUP)
    expect(reread({ cardCheckedAt: T0 + 5, cardState: 'ready' }).phase).toBe('done')
    expect(reread({ cardCheckedAt: T0 + 5, cardState: 'signin-pending', cardReauthState: 'ab-12' })).toMatchObject({
      phase: 'expired',
      state: 'ab-12',
      source: 'server'
    })
  })

  it('persists the unconfirmed marker (validated), never the one-time sign-in link', () => {
    const info = cardErrorInfo(answers.timeout as never)

    const s = {
      ...reduceSignup(IDLE_SIGNUP, { type: 'poll-error', info, now: T0 }),
      linkUrl: 'https://agentcard.ai/a?token=x'
    }

    const disk = serializeSignup(s)

    expect(disk.linkUrl).toBeUndefined()
    expect(hydrateSignup(disk, status({ cardCheckedAt: T0 - 10 }), T0 + 60_000).phase).toBe('unconfirmed')
    expect(hydrateSignup(disk, status({ cardCheckedAt: T0 + 10 }), T0 + 60_000)).toEqual(IDLE_SIGNUP)
    expect(hydrateSignup({ phase: 'unconfirmed' }, status(), T0)).toEqual(IDLE_SIGNUP)
  })

  it('one cooldown: it only grows, and an unconfirmed signup stays unconfirmed under it', () => {
    const limited = cardErrorInfo({ ok: false, code: 1, stdout: '{"error":"HTTP 403: blocked"}', stderr: '' } as never)
    const rate = cardErrorInfo({ ok: false, code: 1, stdout: '{"error":"HTTP 429"}', stderr: '' } as never)
    const cool = reduceSignup(IDLE_SIGNUP, { type: 'poll-error', info: limited, now: T0 })
    const after = reduceSignup(cool, { type: 'poll-error', info: rate, now: T0 + 1_000 })

    expect(after.cooldownUntil).toBe(cool.cooldownUntil)

    const unsure = reduceSignup(IDLE_SIGNUP, {
      type: 'poll-error',
      info: cardErrorInfo(answers.timeout as never),
      now: T0
    })

    const held = reduceSignup(unsure, { type: 'poll-error', info: rate, now: T0 })

    expect(held).toMatchObject({ phase: 'unconfirmed', cooldownUntil: T0 + 60_000 })
    expect(reduceSignup(held, { type: 'tick', now: T0 + 60_001 })).toMatchObject({ phase: 'unconfirmed' })
    expect(signupGate(held, status(), T0 + 61_000).gate).toBe('refused')
  })
})

describe('R6 r3 — useCardSteps: ambiguous answers and the one hold', () => {
  beforeEach(() => {
    vi.useFakeTimers()

    for (const fn of Object.values(acp)) {
      fn.mockReset()
    }

    acp.refreshAcpStatus.mockResolvedValue(null)
    acp.inftKvGet.mockResolvedValue({ ok: true, value: null })
    acp.inftKvSet.mockResolvedValue({ ok: true, value: {} })
    acp.inftKvDelete.mockResolvedValue({ ok: true, value: null })
  })
  afterEach(() => vi.useRealTimers())

  const setup = (st = status()) =>
    renderHook(
      ({ s }) => {
        const runner = useStepRunner('inft-1')

        return { card: useCardSteps({ runner, status: s, inftId: 'inft-1' }), runner }
      },
      { initialProps: { s: st } }
    )

  const calls = (sub: string) => acp.runAcp.mock.calls.filter(([, argv]) => argv.slice(0, 2).join(' ') === sub).length
  const cardRefreshes = () => acp.refreshAcpStatus.mock.calls.filter(([, opts]) => opts?.card === true).length

  it('a 502 signup re-reads the card once and holds the gate until that re-read answers', async () => {
    acp.runAcp.mockResolvedValue({ ok: false, code: 1, stdout: '{"error":"HTTP 502: Bad Gateway"}', stderr: '' })

    const { result, rerender } = setup()

    await act(() => vi.advanceTimersByTimeAsync(0))
    await act(() => result.current.card.cardSignup())
    await act(() => result.current.card.cardSignup())
    await act(() => vi.advanceTimersByTimeAsync(2_000))

    expect(calls('card signup')).toBe(1)
    expect(cardRefreshes()).toBe(1)
    expect(result.current.card.signup.phase).toBe('unconfirmed')
    expect(result.current.card.gate.gate).toBe('refused')

    rerender({ s: status({ cardCheckedAt: Date.now() + 1 }) })
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(result.current.card.signup.phase).toBe('idle')
    expect(result.current.card.gate.gate).toBe('allowed')
  })

  it('a REAUTH signup answer adopts the server token and polls it — no second signup', async () => {
    acp.runAcp.mockImplementation(async (_id: string, argv: string[]) =>
      argv[1] === 'signup'
        ? {
            ok: false,
            code: 1,
            stdout: '{"error":"HTTP 401: REAUTH:ab12cd34-0000:agent@mail.acp.virtuals.io"}',
            stderr: ''
          }
        : ok('{"done":false}')
    )

    const { result } = setup()

    await act(() => vi.advanceTimersByTimeAsync(0))
    await act(() => result.current.card.cardSignup())
    await act(() => vi.advanceTimersByTimeAsync(5_001))

    expect(result.current.card.signup).toMatchObject({ phase: 'polling', state: 'ab12cd34-0000', source: 'server' })
    expect(calls('card signup-poll')).toBe(1)
    expect(calls('card signup')).toBe(1)
    expect(cardRefreshes()).toBe(1)
  })

  it('a 403 on a card write starts the cooldown; every card call then waits', async () => {
    acp.runAcp.mockResolvedValue({ ok: false, code: 1, stdout: '{"error":"HTTP 403: Forbidden"}', stderr: '' })

    const { result } = setup()

    await act(() => vi.advanceTimersByTimeAsync(0))
    act(() => {
      result.current.card.setCardFirst('A')
      result.current.card.setCardLast('B')
      result.current.card.setCardPhone('+351900000000')
    })
    await act(() => result.current.card.cardProfile())
    expect(result.current.card.signup.phase).toBe('cooldown')
    expect(result.current.card.cooldownHeld).toBe(true)
    expect(acp.inftKvSet).toHaveBeenLastCalledWith(
      'inft-1',
      'card-signup',
      expect.objectContaining({ phase: 'cooldown' })
    )

    const before = acp.runAcp.mock.calls.length

    await act(() => result.current.card.cardLimit())
    await act(() => result.current.card.cardPaymentMethod())
    await act(() => result.current.card.cardRead(['card', 'limit', '--json']))
    await act(() => result.current.card.cardSignup())
    expect(acp.runAcp.mock.calls.length).toBe(before)
  })

  it('a blocked account holds every card call', async () => {
    acp.runAcp.mockResolvedValue(ok('{}'))

    const { result } = setup(status({ cardState: 'blocked' }))

    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(result.current.card.cooldownHeld).toBe(true)
    await act(() => result.current.card.cardPaymentMethod())
    await act(() => result.current.card.cardRead(['card', 'profile', '--json']))
    expect(acp.runAcp).not.toHaveBeenCalled()
  })
})

describe('R6 r4 — the signup machine stops with its wizard; the forced re-read waits out the hold', () => {
  beforeEach(() => {
    vi.useFakeTimers()

    for (const fn of Object.values(acp)) {
      fn.mockReset()
    }

    ext.openExternal.mockReset()
    acp.refreshAcpStatus.mockResolvedValue(null)
    acp.inftKvGet.mockResolvedValue({ ok: true, value: null })
    acp.inftKvSet.mockResolvedValue({ ok: true, value: {} })
    acp.inftKvDelete.mockResolvedValue({ ok: true, value: null })
  })
  afterEach(() => vi.useRealTimers())

  const setup = (st = status(), id = 'inft-1') =>
    renderHook(
      ({ s, inft }) => {
        const runner = useStepRunner(inft)

        return { card: useCardSteps({ runner, status: s, inftId: inft }), runner }
      },
      { initialProps: { s: st, inft: id } }
    )

  const calls = (sub: string) => acp.runAcp.mock.calls.filter(([, argv]) => argv.slice(0, 2).join(' ') === sub).length
  const cardRefreshes = () => acp.refreshAcpStatus.mock.calls.filter(([, opts]) => opts?.card === true).length
  const kvWrites = () => acp.inftKvSet.mock.calls.length + acp.inftKvDelete.mock.calls.length

  /** runAcp whose `hold` sub-command hangs once until released. */
  const hanging = (hold: string, answers: Record<string, string>) => {
    let release: (v: unknown) => void = () => undefined
    let held = false

    acp.runAcp.mockImplementation((_id: string, argv: string[]) => {
      const sub = argv.slice(0, 2).join(' ')

      if (sub === hold && !held) {
        held = true

        return new Promise(r => {
          release = r
        })
      }

      return Promise.resolve(ok(answers[sub] ?? '{}'))
    })

    return (stdout: string) => release(ok(stdout))
  }

  it('a poll in flight at unmount applies nothing: no new poll, no kv write, no refresh', async () => {
    const release = hanging('card signup-poll', { 'card signup': '{"state":"ab12cd34-0000-1111"}' })
    const { result, unmount } = setup()

    await act(() => vi.advanceTimersByTimeAsync(0))
    await act(() => result.current.card.cardSignup())
    await act(() => vi.advanceTimersByTimeAsync(5_001))
    expect(calls('card signup-poll')).toBe(1)

    unmount()

    const kv = kvWrites()
    const refreshes = acp.refreshAcpStatus.mock.calls.length

    release('{"done":true}')
    await vi.advanceTimersByTimeAsync(15 * 60_000)

    expect(calls('card signup-poll')).toBe(1)
    expect(kvWrites()).toBe(kv)
    expect(acp.refreshAcpStatus.mock.calls.length).toBe(refreshes)
  })

  it('an inbox fetch in flight at unmount opens no link and writes nothing', async () => {
    const release = hanging('email search', {
      'card signup': '{"state":"ab12cd34-0000-1111"}',
      'card signup-poll': '{"done":false}',
      'email extract-links': '{"links":["https://agentcard.ai/auth/verify?token=x"]}'
    })

    const { result, unmount } = setup()

    await act(() => vi.advanceTimersByTimeAsync(0))
    await act(() => result.current.card.cardSignup())
    await act(() => vi.advanceTimersByTimeAsync(15_002))
    expect(calls('email search')).toBe(1)

    unmount()

    const kv = kvWrites()

    release('{"messages":[{"id":"m1","date":"2026-10-16T00:00:00Z"}]}')
    await vi.advanceTimersByTimeAsync(15 * 60_000)

    expect(calls('email extract-links')).toBe(0)
    expect(ext.openExternal).not.toHaveBeenCalled()
    expect(kvWrites()).toBe(kv)
    expect(calls('card signup-poll')).toBe(2)
  })

  it('a signup answered after an iNFT switch never lands on the new iNFT (it is kept for its own)', async () => {
    const release = hanging('card signup', {})
    const { result, rerender } = setup()

    await act(() => vi.advanceTimersByTimeAsync(0))

    let pending: Promise<void> = Promise.resolve()

    act(() => {
      pending = result.current.card.cardSignup()
    })
    rerender({ s: status(), inft: 'inft-2' })
    await act(() => vi.advanceTimersByTimeAsync(0))

    const kv = kvWrites()

    release('{"state":"ab12cd34-0000-1111"}')
    await act(async () => {
      await pending
      await vi.advanceTimersByTimeAsync(60_000)
    })

    expect(kvWrites()).toBe(kv + 1)
    expect(acp.inftKvSet.mock.calls.at(-1)?.slice(0, 2)).toEqual(['inft-1', 'card-signup'])
    expect(calls('card signup-poll')).toBe(0)
    expect(result.current.card.signup.phase).toBe('idle')
  })

  it('one signup in flight: a second call while the first runs sends nothing', async () => {
    const release = hanging('card signup', {})
    const { result } = setup()

    await act(() => vi.advanceTimersByTimeAsync(0))

    let first: Promise<void> = Promise.resolve()

    act(() => {
      first = result.current.card.cardSignup()
    })
    await act(() => result.current.card.cardSignup())
    release('{"state":"ab12cd34-0000-1111"}')
    await act(() => first)

    expect(calls('card signup')).toBe(1)
    expect(result.current.card.signup.phase).toBe('polling')
  })

  for (const [code, holdMs] of [
    [403, 15 * 60_000],
    [429, 60_000]
  ] as const) {
    it(`a ${code} signup defers the forced card re-read until the hold ends — then exactly one`, async () => {
      acp.runAcp.mockResolvedValue({ ok: false, code: 1, stdout: `{"error":"HTTP ${code}: refused"}`, stderr: '' })

      const { result } = setup()

      await act(() => vi.advanceTimersByTimeAsync(0))
      await act(() => result.current.card.cardSignup())
      expect(result.current.card.cooldownHeld).toBe(true)
      await act(() => vi.advanceTimersByTimeAsync(holdMs - 5_000))
      expect(cardRefreshes()).toBe(0)
      await act(() => vi.advanceTimersByTimeAsync(7_000))
      expect(cardRefreshes()).toBe(1)
      await act(() => vi.advanceTimersByTimeAsync(holdMs))
      expect(cardRefreshes()).toBe(1)
      expect(calls('card signup')).toBe(1)
    })
  }

  it('an unconfirmed signup caught by a later 429 is re-read only after that hold', async () => {
    acp.runAcp.mockResolvedValue({ ok: false, code: 1, stdout: '{"error":"HTTP 502: Bad Gateway"}', stderr: '' })

    const { result } = setup()

    await act(() => vi.advanceTimersByTimeAsync(0))
    await act(() => result.current.card.cardSignup())
    expect(cardRefreshes()).toBe(1)

    acp.runAcp.mockResolvedValue({ ok: false, code: 1, stdout: '{"error":"HTTP 429: slow down"}', stderr: '' })
    await act(() => result.current.card.cardRead(['card', 'limit', '--json']))
    expect(result.current.card.signup.phase).toBe('unconfirmed')
    expect(result.current.card.cooldownHeld).toBe(true)
    await act(() => vi.advanceTimersByTimeAsync(55_000))
    expect(cardRefreshes()).toBe(1)
    await act(() => vi.advanceTimersByTimeAsync(7_000))
    expect(cardRefreshes()).toBe(2)
    expect(result.current.card.signup.phase).toBe('unconfirmed')
  })

  it('a pending sign-in never arms "send a new link": each Resend is one click, one minute apart', async () => {
    const kv = new Map<string, unknown>()

    acp.inftKvGet.mockImplementation(async (id: string) => ({ ok: true, value: kv.get(id) ?? null }))
    acp.inftKvSet.mockImplementation(async (id: string, _key: string, value: unknown) => {
      kv.set(id, value)

      return { ok: true, value }
    })
    acp.runAcp.mockImplementation(async (_id: string, argv: string[]) =>
      argv[1] === 'signup' ? ok('{"state":"st-fresh"}') : ok('{"done":false}')
    )

    const { result } = setup(status({ cardState: 'signin-pending', cardReauthState: 'ab-12' }))

    await act(() => vi.advanceTimersByTimeAsync(0))
    await act(() => result.current.card.cardSignup())
    expect(result.current.card.confirmArmed).toBe(false)
    expect(calls('card signup')).toBe(1)

    // The second click inside the minute: refused with the wait, nothing runs.
    await act(() => vi.advanceTimersByTimeAsync(1_000))
    await act(() => result.current.card.cardSignup())
    expect(calls('card signup')).toBe(1)
    expect(result.current.card.gate).toMatchObject({ gate: 'refused', reason: 'resend-wait' })
    expect(result.current.card.confirmArmed).toBe(false)

    await act(() => vi.advanceTimersByTimeAsync(CONFIRM_WINDOW_MS + 1))
    expect(result.current.card.gate.gate).toBe('resend')
    await act(() => result.current.card.cardSignup())
    expect(calls('card signup')).toBe(2)
  })
})

describe('R6 r5 — a card answer that outlives its wizard is kept for its iNFT, once', () => {
  let kv: Record<string, unknown> = {}
  let release: (v: unknown) => void = () => undefined
  let hangSub = 'card signup'
  const sent: Record<string, number> = {}

  beforeEach(() => {
    vi.useFakeTimers()

    for (const fn of Object.values(acp)) {
      fn.mockReset()
    }

    kv = {}
    hangSub = 'card signup'

    for (const key of Object.keys(sent)) {
      delete sent[key]
    }

    acp.refreshAcpStatus.mockResolvedValue(null)
    acp.inftKvSet.mockImplementation(async (id: string, key: string, value: unknown) => {
      kv[`${id}/${key}`] = value

      return { ok: true, value }
    })
    acp.inftKvDelete.mockImplementation(async (id: string, key: string) => {
      delete kv[`${id}/${key}`]

      return { ok: true, value: null }
    })
    acp.inftKvGet.mockImplementation(async (id: string, key: string) => ({
      ok: true,
      value: kv[`${id}/${key}`] ?? null
    }))
    acp.runAcp.mockImplementation(async (id: string, argv: string[]) => {
      const sub = argv.slice(0, 2).join(' ')

      sent[`${id} ${sub}`] = (sent[`${id} ${sub}`] ?? 0) + 1

      if (sub === hangSub && sent[`${id} ${sub}`] === 1) {
        return new Promise(r => {
          release = r
        })
      }

      return ok(sub === 'card signup-poll' ? '{"done":false}' : '{"state":"ab12cd34-9999-0000"}')
    })
  })
  afterEach(() => vi.useRealTimers())

  const mount = (id = 'inft-1') =>
    renderHook(
      ({ inft }) => {
        const runner = useStepRunner(inft)

        return { card: useCardSteps({ runner, status: status(), inftId: inft }), runner }
      },
      { initialProps: { inft: id } }
    )

  const signups = (id = 'inft-1') => sent[`${id} card signup`] ?? 0

  const writesFor = (id: string) =>
    [...acp.inftKvSet.mock.calls, ...acp.inftKvDelete.mock.calls].filter(([inft]) => inft === id).length

  const failed = (body: string) => ({ ok: false, code: 1, stdout: JSON.stringify({ error: body }), stderr: '' })

  for (const [name, answer, phase] of [
    ['429', failed('HTTP 429: too many requests'), 'cooldown'],
    ['403', failed('HTTP 403: account blocked'), 'cooldown'],
    ['state token', ok('{"state":"ab12cd34-0000-1111"}'), 'polling'],
    ['timeout', { ok: false, code: 124, stdout: '', stderr: '', error: 'timed out' }, 'unconfirmed']
  ] as const) {
    it(`a ${name} answered after the wizard closed: one kv write, the reopened wizard refuses a second signup`, async () => {
      const first = mount()

      await act(() => vi.advanceTimersByTimeAsync(0))

      let pending: Promise<void> = Promise.resolve()

      act(() => {
        pending = first.result.current.card.cardSignup()
      })
      await act(() => vi.advanceTimersByTimeAsync(2_000))
      first.unmount()

      const before = writesFor('inft-1')

      release(answer)
      await pending
      // Shorter than the shortest hold (429 = 60 s): a closed wizard schedules nothing in the meantime.
      await vi.advanceTimersByTimeAsync(30_000)

      expect(writesFor('inft-1') - before).toBe(1)
      expect(kv['inft-1/card-signup']).toMatchObject({ phase })
      expect(sent['inft-1 card signup-poll'] ?? 0).toBe(0)
      expect(ext.openExternal).not.toHaveBeenCalled()

      const second = mount()

      await act(() => vi.advanceTimersByTimeAsync(0))
      expect(second.result.current.card.gate.gate).toBe('refused')
      await act(() => second.result.current.card.cardSignup())
      await act(() => second.result.current.card.cardSignup())
      expect(signups()).toBe(1)
      second.unmount()
    })
  }

  it('in flight across a close and reopen: the reopened gate is refused, then it hydrates the late answer', async () => {
    const first = mount()

    await act(() => vi.advanceTimersByTimeAsync(0))
    act(() => {
      void first.result.current.card.cardSignup()
    })
    await act(() => vi.advanceTimersByTimeAsync(2_000))
    first.unmount()

    const second = mount()

    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(second.result.current.card.gate).toMatchObject({
      gate: 'refused',
      reason: 'link-sending'
    })
    await act(() => second.result.current.card.cardSignup())
    expect(signups()).toBe(1)

    release(ok('{"state":"ab12cd34-0000-1111"}'))
    await act(() => vi.advanceTimersByTimeAsync(100))
    expect(second.result.current.card.signup).toMatchObject({ phase: 'polling', state: 'ab12cd34-0000-1111' })
    expect(second.result.current.card.gate.gate).toBe('refused')
    await act(() => second.result.current.card.cardSignup())
    expect(signups()).toBe(1)
    second.unmount()
  })

  it('in flight across a switch away and back: one signup for the iNFT, none for the other', async () => {
    const h = mount('inft-1')

    await act(() => vi.advanceTimersByTimeAsync(0))
    act(() => {
      void h.result.current.card.cardSignup()
    })
    h.rerender({ inft: 'inft-2' })
    await act(() => vi.advanceTimersByTimeAsync(1_000))
    h.rerender({ inft: 'inft-1' })
    await act(() => vi.advanceTimersByTimeAsync(0))
    await act(() => h.result.current.card.cardSignup())
    release(ok('{"state":"ab12cd34-0000-1111"}'))
    await act(() => vi.advanceTimersByTimeAsync(100))
    await act(() => h.result.current.card.cardSignup())

    expect(signups('inft-1')).toBe(1)
    expect(signups('inft-2')).toBe(0)
    expect(kv['inft-2/card-signup']).toBeUndefined()
    expect(h.result.current.card.signup.phase).toBe('polling')
    h.unmount()
  })

  for (const [label, run] of [
    ['card profile set', (c: ReturnType<typeof useCardSteps>) => c.cardProfile()],
    ['card payment-method', (c: ReturnType<typeof useCardSteps>) => c.cardPaymentMethod()],
    ['card limit', (c: ReturnType<typeof useCardSteps>) => c.cardLimit()]
  ] as const) {
    it(`a late 429 of ${label} after unmount still starts the persisted hold; a late success writes nothing`, async () => {
      hangSub = label.split(' ').slice(0, 2).join(' ')

      for (const answer of [failed('HTTP 429: slow down'), ok('{"url":"https://pay.example/x"}')]) {
        delete sent[`inft-1 ${hangSub}`]

        const h = mount()

        act(() => {
          h.result.current.card.setCardFirst('A')
          h.result.current.card.setCardLast('B')
          h.result.current.card.setCardPhone('+351900000000')
        })
        await act(() => vi.advanceTimersByTimeAsync(0))

        let pending: Promise<void> = Promise.resolve()

        act(() => {
          pending = run(h.result.current.card)
        })
        h.unmount()

        const before = writesFor('inft-1')

        release(answer)
        await pending
        await vi.advanceTimersByTimeAsync(10)

        expect(writesFor('inft-1') - before).toBe(answer.ok ? 0 : 1)
      }

      expect(kv['inft-1/card-signup']).toMatchObject({ phase: 'cooldown' })
      expect(ext.openExternal).not.toHaveBeenCalled()
    })
  }

  // R6 r6: a renderer reload (Force Reload, crash recovery) is a fresh module graph — the in-flight registry is gone.
  const reloaded = async (st: object = {}) => {
    vi.resetModules()

    const card = await import('./inft-setup-card')
    const runner = await import('./inft-setup-runner')

    return renderHook(() =>
      card.useCardSteps({ runner: runner.useStepRunner('inft-1'), status: status(st), inftId: 'inft-1' })
    )
  }

  it('R6 r6: the marker is on disk before card signup leaves; a reload mid-flight refuses until a newer card read', async () => {
    let markerAtSend: unknown = 'unset'

    acp.runAcp.mockImplementation(async (id: string, argv: string[]) => {
      if (argv[1] === 'signup') {
        sent[`${id} card signup`] = (sent[`${id} card signup`] ?? 0) + 1
        markerAtSend = kv['inft-1/card-signup'] ?? null

        return new Promise(() => undefined)
      }

      return ok('{}')
    })

    const first = await reloaded()

    await act(() => vi.advanceTimersByTimeAsync(0))
    act(() => {
      void first.result.current.cardSignup()
    })
    await act(() => vi.advanceTimersByTimeAsync(1_500))
    expect(markerAtSend).toMatchObject({ phase: 'unconfirmed', email: 'a@agentcard.ai' })

    const sentAt = (markerAtSend as { sentAt: number }).sentAt

    first.unmount()

    const second = await reloaded({ cardCheckedAt: sentAt - 1 })

    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(second.result.current.gate.gate).toBe('refused')
    await act(() => second.result.current.cardSignup())
    await act(() => second.result.current.cardSignup())
    expect(signups()).toBe(1)
    second.unmount()

    // The service answered "never signed up" in a read that STARTED after the marker: the gate opens again.
    const third = await reloaded({ cardCheckedAt: sentAt + 1 })

    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(third.result.current.signup.phase).toBe('idle')
    expect(third.result.current.gate.gate).toBe('allowed')
    third.unmount()
  })

  it('R6 r6: no marker on disk, no signup sent', async () => {
    acp.inftKvSet.mockResolvedValueOnce({ ok: false, error: 'disk full' } as never)

    const h = mount()

    await act(() => vi.advanceTimersByTimeAsync(0))
    await act(() => h.result.current.card.cardSignup())
    expect(signups()).toBe(0)
    expect(h.result.current.runner.steps.card?.error).toMatch(/nothing was sent/)
    expect(h.result.current.card.gate.gate).toBe('allowed')
    h.unmount()
  })

  for (const [name, answer, expected] of [
    ['clean refusal', failed('HTTP 400: invalid email'), undefined],
    ['state token', ok('{"state":"ab12cd34-0000-1111"}'), 'polling']
  ] as const) {
    it(`R6 r6: a late ${name} replaces the marker (never left as "unconfirmed")`, async () => {
      const h = mount()

      await act(() => vi.advanceTimersByTimeAsync(0))
      act(() => {
        void h.result.current.card.cardSignup()
      })
      await act(() => vi.advanceTimersByTimeAsync(100))
      expect(kv['inft-1/card-signup']).toMatchObject({ phase: 'unconfirmed' })
      h.unmount()
      release(answer)
      await vi.advanceTimersByTimeAsync(100)

      const stored = kv['inft-1/card-signup'] as { phase?: string } | undefined

      expect(stored?.phase).toBe(expected)
      expect(signups()).toBe(1)
    })
  }

  it('R6 r6: a live answer overwrites the marker in place', async () => {
    const h = mount()

    await act(() => vi.advanceTimersByTimeAsync(0))
    act(() => {
      void h.result.current.card.cardSignup()
    })
    await act(() => vi.advanceTimersByTimeAsync(100))
    release(failed('HTTP 400: invalid email'))
    await act(() => vi.advanceTimersByTimeAsync(100))
    expect(kv['inft-1/card-signup']).toBeUndefined()
    expect(h.result.current.card.signup.phase).toBe('idle')
    h.unmount()
  })
})

describe("R6 r7 — main's signup hold reaches the wizard", () => {
  const until = Date.parse('2026-10-16T10:15:00.000Z')
  // Exactly what main's withCardSignupSlot answers inside a 403 hold (electron/iclone-acp-signup.ts).
  const heldReason = `the card service answered this iNFT's last signup with HTTP 403 (blocked) — not sending another until ${new Date(until).toISOString()} [held-until=${until}]`
  const heldAnswer = { ok: false, code: null, stdout: '', stderr: '', error: heldReason }

  it('a refusal inside the hold is a clean cooldown that lasts at least to the hold end', () => {
    const info = cardErrorInfo(heldAnswer)

    expect(info.heldUntil).toBe(until)
    expect(info.unconfirmed).toBeUndefined()
    expect(info.code).toBe('held')

    // Late in the hold: the classifier's own cooldown would end before it; the hold end wins.
    const now = until - 30_000
    const s = reduceSignup(IDLE_SIGNUP, { type: 'poll-error', info, now })

    expect(s.phase).toBe('cooldown')
    expect(s.cooldownUntil).toBeGreaterThanOrEqual(until)
    expect(signupGate(s, status(), until - 1).gate).toBe('refused')

    const rated = cardErrorInfo({
      ...heldAnswer,
      error: `… HTTP 429 (rate limit) — not sending another until x [held-until=${until}]`
    })

    const r = reduceSignup(IDLE_SIGNUP, { type: 'poll-error', info: rated, now: until - 90_000 })

    expect(r.cooldownUntil).toBe(until)
  })

  it('a status that reports the hold refuses the gate until it ends, whatever the carried card says', () => {
    const held = status({ cardState: 'none', cardHeldUntil: until })

    expect(signupGate(IDLE_SIGNUP, held, until - 1)).toEqual({
      gate: 'refused',
      reason: 'held-until',
      at: until
    })
    expect(signupGate(IDLE_SIGNUP, held, until).gate).toBe('allowed')
    expect(signupGate(IDLE_SIGNUP, status({ cardState: 'blocked', cardHeldUntil: until }), until).gate).toBe('refused')
  })
})

describe("R6 r8 — the held-until mark counts only on main's refusal shape", () => {
  const until = Date.parse('2026-10-16T10:15:00.000Z')
  const mark = `[held-until=${until}]`
  const reason = `the card service answered this iNFT's last signup with HTTP 403 (blocked) — not sending another until x ${mark}`

  it("main's refusal (no exit code, no CLI output, the mark ending result.error) is a clean hold", () => {
    const info = cardErrorInfo({ ok: false, code: null, stdout: '', stderr: '', error: reason })

    expect(info.heldUntil).toBe(until)
    expect(info.unconfirmed).toBeUndefined()
  })

  it('the same text inside a CLI answer is that answer: the signup may have gone out', () => {
    const answers = [
      { ok: false, code: 1, stdout: `{"error":"HTTP 502: Bad Gateway ${mark}"}`, stderr: '' },
      { ok: false, code: 1, stdout: '', stderr: `HTTP 502: Bad Gateway ${mark}` },
      { ok: false, code: 1, stdout: '', stderr: '', error: reason },
      { ok: false, code: null, stdout: '{"error":"HTTP 502"}', stderr: '', error: reason },
      { ok: false, code: null, stdout: '', stderr: 'partial', error: reason },
      { ok: false, code: null, stdout: '', stderr: '', error: `${reason} and more` }
    ]

    for (const answer of answers) {
      const info = cardErrorInfo(answer)

      expect(info.heldUntil).toBeUndefined()
      expect(info.unconfirmed).toBe(true)
    }
  })
})

// R16 — the signup door stays shut whenever a card is known (one KYC = one account).
describe('R16.unit.signup_button_hidden_when_card_known', () => {
  it('ready / signin-pending / session-expired (stale ready) / blocked / unknown refuse, with a reason; only an authoritative none allows', () => {
    const known = [
      status({ cardState: 'ready', cardReady: true }),
      status({ authenticated: false, cardState: 'ready', cardReady: true, cardStale: true }),
      status({ cardState: 'blocked' }),
      status({ cardState: undefined }),
      status({ cardStale: true })
    ]

    for (const s of known) {
      const gate = signupGate(IDLE_SIGNUP, s, T0)

      expect(gate.gate).toBe('refused')
      expect(gate.reason).toBeTruthy()
    }

    expect(signupGate(IDLE_SIGNUP, status({ cardState: 'none' }), T0).gate).toBe('allowed')

    // V3-L M1: a signed-up account whose link is unopened is offered a fresh link, never a signup.
    for (const s of [
      status({ cardState: 'signin-pending' }),
      status({ cardState: 'signin-pending', cardReauthState: 'ab-12' })
    ]) {
      expect(signupGate(IDLE_SIGNUP, s, T0).gate).toBe('resend')
    }
  })
})

describe('card copy — every code is a sentence in six locales', () => {
  const refusals = [
    'already-signed-in',
    'cooling',
    'held-until',
    'link-replaces',
    'link-sending',
    'link-waiting',
    'resend-wait',
    'service-refused',
    'state-unknown',
    'unconfirmed'
  ] as const

  const errors = [
    'blocked',
    'failed',
    'held',
    'link-waiting',
    'no-state',
    'not-ready',
    'rate-limited',
    'resend-wait',
    'sent-unanswered',
    'timeout'
  ] as const

  const period = /[.。]$/
  const developerWords = /\bCLI\b|re-probe|rate-limit|\bHermes\b/

  it.each(Object.keys(INFT_WIZARD_COPY))(
    '%s: refusal and error codes end with a period, no developer words',
    locale => {
      const card = INFT_WIZARD_COPY[locale as keyof typeof INFT_WIZARD_COPY].card

      for (const reason of refusals) {
        const text = cardRefusalSentence(card, { gate: 'refused', reason, at: T0 })

        expect(text, reason).toMatch(period)
        expect(text, reason).not.toMatch(developerWords)
      }

      for (const code of errors) {
        const text = cardErrorSentence(card, { code, detail: 'HTTP 502', heldUntil: T0 })

        expect(text, code).toMatch(period)
        expect(text, code).not.toMatch(developerWords)
      }
    }
  )

  it('names the moment, repeats the answer behind a cooldown, and says nothing when allowed', () => {
    const card = INFT_WIZARD_COPY.en.card
    const clock = new Date(T0).toTimeString().slice(0, 5)

    expect(cardRefusalSentence(card, { gate: 'refused', reason: 'held-until', at: T0 })).toContain(clock)
    expect(cardRefusalSentence(card, { gate: 'refused', reason: 'cooling', error: { code: 'rate-limited' } })).toBe(
      card.error['rate-limited']
    )
    expect(cardRefusalSentence(card, { gate: 'refused', reason: 'cooling' })).toBe(card.refusal.cooling)
    expect(cardRefusalSentence(card, SIGNUP_IN_FLIGHT_GATE)).toBe(card.refusal['link-sending'])
    expect(cardRefusalSentence(card, { gate: 'allowed' })).toBeUndefined()
    expect(cardErrorSentence(card, { code: 'failed', detail: 'HTTP 502' })).toContain('HTTP 502')
  })
})

describe('card failure words (UF3B-r2c-1)', () => {
  const PROCESS_WORDS = /CLI|Traceback|node-pty|spawn|stderr/i

  it('never quotes the process: CLI, pty, spawn and stderr text yield a sentence without them in six locales', () => {
    const answers = [
      {
        ok: false,
        code: null,
        stdout: '',
        stderr: 'Traceback (most recent call last)…',
        error: 'the CLI returned no JSON'
      },
      { ok: false, code: null, stdout: '', stderr: '', error: 'node-pty: no exit within 10s' },
      { ok: false, code: null, stdout: '', stderr: 'spawn ENOENT', error: undefined }
    ]

    for (const answer of answers) {
      const info = cardErrorInfo(answer as never)

      expect(info.code).toBe('failed')
      expect(info.detail).toBeUndefined()

      for (const copy of Object.values(INFT_WIZARD_COPY)) {
        const text = cardErrorSentence(copy.card, info)

        expect(text).not.toMatch(PROCESS_WORDS)
        expect(text).not.toContain('()')
      }
    }
  })

  it("keeps the service's own answer, and names a busy iNFT with its own sentence", () => {
    const fromService = cardErrorInfo({
      ok: false,
      code: null,
      stdout: '',
      stderr: '',
      error: 'HTTP 409: {"message":"Card limit reached for this account"}'
    } as never)

    expect(fromService.detail).toBe('Card limit reached for this account')

    const busy = cardErrorInfo({
      ok: false,
      code: null,
      stdout: '',
      stderr: '',
      error: 'busy: another call is running for this iNFT'
    } as never)

    expect(busy.code).toBe('busy')
    expect(cardErrorSentence(INFT_WIZARD_COPY.en.card, busy)).toBe(
      'Another card call is still running for this iNFT. Try again when it finishes.'
    )
  })
})
