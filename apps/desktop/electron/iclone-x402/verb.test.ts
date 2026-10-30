import { afterEach, describe, expect, it } from 'vitest'

import type { PaymentAuditEntry, X402Client } from './client'
import { makeWorld, type World } from './harness.test-helpers'
import { isStopped, setStop } from './store'
import { paymentsVerb } from './verb'

const worlds: World[] = []

afterEach(async () => {
  for (const w of worlds.splice(0)) {
    await w.close()
  }
})

const sink = () => {
  const entries: PaymentAuditEntry[] = []

  return { entries, audit: { record: (entry: PaymentAuditEntry) => void entries.push(entry) } }
}

const fakeClient = (pay: X402Client['pay']): X402Client & { seen: unknown[] } => {
  const seen: unknown[] = []

  return {
    seen,
    pay: request => {
      seen.push(request)

      return pay(request)
    },
    send: request => {
      seen.push(request)

      return pay({ url: `p2p:${request.payTo}`, agent: request.agent, mandate: request.mandate })
    }
  }
}

describe('merge-verb — the pay verb is the trust boundary: every rejection is refused and audited', () => {
  it('merge-verb: a client that rejects, or answers something that is not a result, is refused internal and audited with the socket’s slug', async () => {
    const answers: (() => Promise<unknown>)[] = [
      () => Promise.reject(new Error('client blew up')),
      () => Promise.resolve(undefined),
      () => Promise.resolve(null),
      () => Promise.resolve({}),
      () => Promise.resolve({ kind: 'paid-ish' }),
      () => Promise.resolve('paid')
    ]

    for (const next of answers) {
      const { entries, audit } = sink()
      const client = fakeClient(() => next() as never)
      const result = await paymentsVerb({ client, audit, stop: null }, 'inft-7', ['pay', 'https://pay.example/x'])

      expect(result.code).toBe(1)
      expect(JSON.parse(result.stdout)).toEqual({ kind: 'refused', reason: 'internal', detail: 'internal error' })
      expect(entries).toEqual([{ kind: 'refuse', reason: 'internal', agent: 'inft-7' }])
    }
  })

  it('merge-verb: the agent is the socket’s slug, never argv; --mandate and --max reach the client parsed', async () => {
    const { audit } = sink()
    const client = fakeClient(async () => ({ kind: 'passthrough', status: 200, body: 'free' }))
    const jti = 'ab'.repeat(16)

    const result = await paymentsVerb({ client, audit, stop: null }, 'inft-7', [
      'pay',
      'https://pay.example/x',
      '--mandate',
      jti,
      '--max',
      '0.25'
    ])

    expect(result.code).toBe(0)
    expect(client.seen).toEqual([{ url: 'https://pay.example/x', mandate: jti, maxMicros: 250_000, agent: 'inft-7' }])

    // A slug the socket could not resolve is nobody: the client refuses it (and audits it itself).
    const nobody = fakeClient(async () => ({ kind: 'refused', reason: 'agent', detail: 'agent is not a profile slug' }))

    expect(
      (await paymentsVerb({ client: nobody, audit, stop: null }, null, ['pay', 'https://pay.example/x'])).code
    ).toBe(1)
    expect(nobody.seen).toMatchObject([{ agent: '' }])
  })

  it('merge-verb: malformed calls are usage (64) and audited; the owner’s functions are not socket verbs; nothing reaches the client', async () => {
    const jti = 'ab'.repeat(16)

    const calls: unknown[][] = [
      [],
      ['settings'],
      ['revoke', jti],
      ['transfer'],
      ['pay'],
      ['pay', ''],
      ['pay', '--mandate', jti],
      ['pay', 'https://pay.example/x', '--agent', 'other-agent'],
      ['pay', 'https://pay.example/x', '--mandate'],
      ['pay', 'https://pay.example/x', '--mandate', jti, '--mandate', jti],
      ['pay', 'https://pay.example/x', '--max', 'lots'],
      ['pay', 'https://pay.example/x', '--max', '-1'],
      ['pay', 'https://pay.example/x', '--max', 5],
      ['pay', 'x'.repeat(9000)],
      ['stop', 'now'],
      ['status', 'everyone'],
      ['send'],
      ['send', '0x1111111111111111111111111111111111111111'],
      ['send', '0x1111111111111111111111111111111111111111', 'lots'],
      ['send', '0x1111111111111111111111111111111111111111', '0.10', '--max', '1'],
      ['send', '0x1111111111111111111111111111111111111111', '0.10', '--mandate'],
      ['send', '0x1111111111111111111111111111111111111111', '0.10', '--mandate', jti, 'extra'],
      ['send', '--mandate', jti, '0.10'],
      [42]
    ]

    for (const argv of calls) {
      const { entries, audit } = sink()
      const client = fakeClient(async () => ({ kind: 'passthrough', status: 200, body: '' }))
      const result = await paymentsVerb({ client, audit, stop: () => true }, 'inft-7', argv)

      expect(result.code, JSON.stringify(argv).slice(0, 80)).toBe(64)
      expect(entries).toEqual([{ kind: 'refuse', reason: 'usage', agent: 'inft-7' }])
      expect(client.seen).toEqual([])
    }

    expect((await paymentsVerb({ client: null, audit: null, stop: null }, 'inft-7', 'pay' as never)).code).toBe(64)
  })

  it('x402-pay: send reaches the client parsed, as the socket’s slug; status answers this agent’s own view', async () => {
    const jti = 'ab'.repeat(16)
    const { entries, audit } = sink()

    const client = fakeClient(async () => ({
      kind: 'paid',
      status: 200,
      body: '',
      micros: 100_000,
      transaction: '0x1'
    }))

    const seenAgents: string[] = []

    const deps = {
      client,
      audit,
      stop: () => true,
      status: (agent: string) => {
        seenAgents.push(agent)

        return { ready: true, mandates: [] }
      }
    }

    const sent = await paymentsVerb(deps, 'inft-7', [
      'send',
      '0xAbC0000000000000000000000000000000000001',
      '0.10',
      '--mandate',
      jti
    ])

    expect(sent.code).toBe(0)
    expect(client.seen).toEqual([
      { payTo: '0xAbC0000000000000000000000000000000000001', micros: 100_000, mandate: jti, agent: 'inft-7' }
    ])

    const status = await paymentsVerb(deps, 'inft-7', ['status'])

    expect(status.code).toBe(0)
    expect(JSON.parse(status.stdout)).toEqual({ kind: 'status', ready: true, mandates: [] })
    expect(seenAgents).toEqual(['inft-7'])
    expect(entries).toEqual([])

    const notStarted = await paymentsVerb({ client: null, audit, stop: null, status: null }, 'inft-7', ['status'])

    expect(notStarted.code).toBe(3)

    const throwing = await paymentsVerb(
      {
        ...deps,
        status: () => {
          throw new Error('fold failed')
        }
      },
      'inft-7',
      ['status']
    )

    expect(throwing.code).toBe(3)
    expect(entries).toEqual([
      { kind: 'refuse', reason: 'not_ready', agent: 'inft-7' },
      { kind: 'refuse', reason: 'not_ready', agent: 'inft-7' }
    ])
  })

  it('merge-verb: payments not started is 3 and audited; an audit sink that throws changes no answer', async () => {
    const { entries, audit } = sink()

    expect(
      (await paymentsVerb({ client: null, audit, stop: null }, 'inft-7', ['pay', 'https://pay.example/x'])).code
    ).toBe(3)
    expect((await paymentsVerb({ client: null, audit, stop: null }, 'inft-7', ['stop'])).code).toBe(3)
    expect(entries).toEqual([
      { kind: 'refuse', reason: 'not_ready', agent: 'inft-7' },
      { kind: 'refuse', reason: 'not_ready', agent: 'inft-7' }
    ])

    const throwing = {
      record: () => {
        throw new Error('sink down')
      }
    }

    const client = fakeClient(() => Promise.reject(new Error('x')))

    expect(
      (await paymentsVerb({ client, audit: throwing, stop: null }, 'inft-7', ['pay', 'https://pay.example/x'])).code
    ).toBe(1)
  })

  it('merge-verb: stop sets the hard stop (one way) and is audited; a stop that cannot be set is refused, never reported stopped', async () => {
    const w = await makeWorld()

    worlds.push(w)

    const { entries, audit } = sink()
    const stop = () => setStop(w.paths, true, w.ledger)

    expect(await paymentsVerb({ client: w.client, audit, stop }, 'inft-7', ['stop'])).toMatchObject({ code: 0 })
    expect(isStopped(w.paths)).toBe(true)
    expect(w.ledger.read().records.map(row => [row.kind, row.note])).toEqual([['stop', 'on']])
    expect(entries).toEqual([{ kind: 'use', reason: 'stop on', agent: 'inft-7' }])

    // The real client behind the verb, with the stop on: refused stop, audited by the client.
    const result = await paymentsVerb({ client: w.client, audit, stop }, 'inft-7', ['pay', w.url()])

    expect(result.code).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({ kind: 'refused', reason: 'stop' })
    expect(w.audit).toEqual([{ kind: 'refuse', reason: 'stop', agent: 'inft-7' }])

    for (const broken of [
      () => false,
      () => {
        throw new Error('disk full')
      }
    ]) {
      const { entries: seen, audit: a } = sink()
      const answer = await paymentsVerb({ client: w.client, audit: a, stop: broken }, 'inft-7', ['stop'])

      expect(answer.code).toBe(1)
      expect(JSON.parse(answer.stdout)).toMatchObject({ kind: 'refused', reason: 'internal' })
      expect(seen).toEqual([{ kind: 'refuse', reason: 'internal', agent: 'inft-7' }])
    }
  })

  it('merge-verb: the round trip through the verb pays once and answers 0 with the result', async () => {
    const w = await makeWorld()

    worlds.push(w)

    const jti = w.issue('inft-7')
    const { audit } = sink()

    const result = await paymentsVerb({ client: w.client, audit, stop: null }, 'inft-7', [
      'pay',
      w.url(),
      '--mandate',
      jti
    ])

    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ kind: 'paid', micros: 1_000_000 })
    expect(w.signer.calls).toBe(1)
  })
})
