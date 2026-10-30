import { describe, expect, it } from 'vitest'

import { cardStateFrom, nextCardFields, sameCardAgent } from './iclone-acp-card'

const printed = (stdout: string, ok = false) => ({ code: ok ? 0 : 1, ok, stderr: '', stdout })

// R16 — only the card service's own 400 "not set up" is persisted as "no card".
describe('cardStateFrom — authoritative none only', () => {
  it('the service 400 "not set up" is the one answer that says none', () => {
    expect(cardStateFrom(printed('{"error":"HTTP 400: {\\"message\\":\\"Call card signup first.\\"}"}'))).toMatchObject(
      {
        answered: true,
        state: 'none'
      }
    )
  })

  it('an expired session or a missing agent says nothing about the card, whatever HTTP status carries it', () => {
    for (const stdout of [
      '{"error":"Not authenticated.","code":"NOT_AUTHENTICATED","recovery":"Run `acp configure` to authenticate."}',
      '{"error":"HTTP 400: Not authenticated."}',
      '{"error":"HTTP 400: no active agent — run acp configure"}',
      '{"error":"HTTP 404: session expired"}'
    ]) {
      expect(cardStateFrom(printed(stdout))).toMatchObject({ answered: false })
    }
  })

  it('a ready card stays ready', () => {
    expect(cardStateFrom(printed('{"email":"a@example.com","verified":true}', true))).toEqual({
      answered: true,
      state: 'ready'
    })
  })

  it('R16.c1.main_generic_4xx_never_none: a bare 400/404 is not an answer about the card', () => {
    for (const stdout of [
      '{"error":"HTTP 404: Not Found"}',
      '{"error":"HTTP 400: Bad Request — invalid agent id"}',
      '{"error":"HTTP 400: validation failed"}'
    ]) {
      const probe = cardStateFrom(printed(stdout))

      expect(probe.answered).toBe(false)
      expect(probe.state).toBeUndefined()
    }
  })

  it('R16.c1.main_authoritative_400_is_none: the service words or an explicit code say none', () => {
    expect(cardStateFrom(printed('{"error":"HTTP 400: Agent not set up. Call card signup first."}'))).toMatchObject({
      answered: true,
      httpStatus: 400,
      state: 'none'
    })
    expect(cardStateFrom(printed('{"error":"HTTP 400: rejected","code":"CARD_NOT_SET_UP"}'))).toMatchObject({
      answered: true,
      state: 'none'
    })
  })

  it('R16.r4.other_noun_not_set_up_is_not_none: only the card or agent not being set up is "no card"', () => {
    for (const text of [
      'HTTP 400: Agent wallet not set up',
      'HTTP 400: {\\"message\\":\\"Signer policy not set up\\"}',
      'HTTP 400: email inbox not set up yet'
    ]) {
      expect(cardStateFrom(printed(JSON.stringify({ error: text }))).state).toBeUndefined()
    }

    for (const text of [
      'HTTP 400: AgentCard not set up for this agent.',
      'HTTP 400: Card not set up. Call card signup first.',
      'HTTP 400: {\\"message\\":\\"Call card signup first.\\"}'
    ]) {
      expect(cardStateFrom(printed(JSON.stringify({ error: text })))).toMatchObject({ answered: true, state: 'none' })
    }
  })

  it('R16.r4.not_set_up_text_off_400_is_not_none: a 5xx or other status carrying the words is no answer', () => {
    for (const text of [
      'HTTP 503: profile service not set up yet, retry later',
      'HTTP 500: card not set up — call card signup',
      'HTTP 404: card not set up — call card signup',
      'card not set up'
    ]) {
      const probe = cardStateFrom(printed(JSON.stringify({ error: text })))

      expect(probe.answered).toBe(false)
      expect(nextCardFields({ cardKnown: true, cardReady: true, cardState: 'ready' }, probe, 2).cardKnown).toBe(true)
    }
  })
})

// The real REAUTH answer the card service prints while its magic link is unclicked (bank-cli-fixtures CLI_REAUTH).
const REAUTH_STDOUT = JSON.stringify({ error: 'HTTP 401: {"message":"REAUTH:abc-123:pat@example.com"}' })

describe('cardStateFrom — only REAUTH:<state> is a waiting link', () => {
  it('R16.c2.main_bare_401_is_not_a_pending_link: a 401 or "unauthorized" without REAUTH is not an answer', () => {
    for (const stdout of ['{"error":"HTTP 401: Unauthorized"}', '{"error":"unauthorized request"}']) {
      const probe = cardStateFrom(printed(stdout))

      expect(probe.answered).toBe(false)
      expect(probe.state).toBeUndefined()
    }
  })

  it('the 401 REAUTH answer is signin-pending with its state and e-mail', () => {
    expect(cardStateFrom(printed(REAUTH_STDOUT))).toEqual({
      answered: true,
      httpStatus: 401,
      reauthEmail: 'pat@example.com',
      reauthState: 'abc-123',
      state: 'signin-pending'
    })
  })
})

describe('nextCardFields — the known card is sticky', () => {
  const ready = cardStateFrom(printed('{"email":"a@example.com","verified":true}', true))
  const reauth = cardStateFrom(printed(REAUTH_STDOUT))
  const timeout = cardStateFrom({ code: null, error: 'acp timed out after 30s', ok: false, stderr: '', stdout: '' })
  const blocked = cardStateFrom(printed('{"error":"HTTP 429: Too Many Requests"}'))
  const none = cardStateFrom(printed('{"error":"HTTP 400: Agent not set up. Call card signup first."}'))

  it('ready -> REAUTH -> timeout -> ready keeps cardKnown the whole way', () => {
    const a = nextCardFields(null, ready, 1000)

    expect(a).toMatchObject({ cardKnown: true, cardKnownAt: 1000, cardReady: true, cardState: 'ready' })

    const b = nextCardFields(a, reauth, 2000)

    expect(b).toMatchObject({
      cardCheckedAt: 2000,
      cardKnown: true,
      cardKnownAt: 1000,
      cardReady: false,
      cardReauthState: 'abc-123',
      cardState: 'signin-pending'
    })

    const c = nextCardFields(b, timeout, 3000)

    expect(c).toMatchObject({ cardCheckedAt: 2000, cardKnown: true, cardKnownAt: 1000, cardStale: true })
    expect(c.cardState).toBe('signin-pending')

    const d = nextCardFields(c, ready, 4000)

    expect(d).toMatchObject({ cardKnown: true, cardKnownAt: 4000, cardReady: true, cardState: 'ready' })
    expect(d.cardStale).toBeUndefined()
    expect(d.cardReauthState).toBeUndefined()
  })

  it('a block keeps the known card', () => {
    expect(nextCardFields(nextCardFields(null, ready, 1), blocked, 2)).toMatchObject({
      cardKnown: true,
      cardState: 'blocked'
    })
  })

  it('ready -> none clears it: the authoritative "not set up" is the only answer that forgets the card', () => {
    const cleared = nextCardFields(nextCardFields(null, ready, 1), none, 2)

    expect(cleared).toMatchObject({ cardReady: false, cardState: 'none' })
    expect(cleared.cardKnown).toBeUndefined()
    expect(cleared.cardKnownAt).toBeUndefined()
  })

  it("a legacy status that carried only cardReady:true (#6's shape) is a known card", () => {
    expect(nextCardFields({ cardReady: true }, reauth, 5)).toMatchObject({
      cardKnown: true,
      cardState: 'signin-pending'
    })
    expect(nextCardFields({ cardReady: true }, timeout, 5)).toMatchObject({ cardKnown: true, cardReady: true })
  })

  it('a waiting link with no card ever seen is not a known card', () => {
    expect(nextCardFields(null, reauth, 1).cardKnown).toBeUndefined()
    expect(nextCardFields({ cardReady: false, cardState: 'signin-pending' }, timeout, 2).cardKnown).toBeUndefined()
  })
})

describe('sameCardAgent — whose card fields a status carries', () => {
  it('keeps the same agent (also re-signed in) and drops another agent', () => {
    const last: { agentId?: string; cardKnown: boolean } = { agentId: 'agent-6', cardKnown: true }

    expect(sameCardAgent(last, 'agent-6')).toBe(last)
    expect(sameCardAgent(last, undefined)).toBe(last)
    expect(sameCardAgent<{ agentId?: string; cardKnown: boolean }>({ cardKnown: true }, 'agent-6')).toEqual({
      cardKnown: true
    })
    expect(sameCardAgent(last, 'agent-7')).toBeNull()
    expect(sameCardAgent(null, 'agent-6')).toBeNull()
  })
})
