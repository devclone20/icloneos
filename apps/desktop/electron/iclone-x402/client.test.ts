import fs from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createX402Client, type PaymentAuditEntry, type SpendDoor } from './client'
import { EARN_WALLET, fakeSealer, makeWorld, OTHER_WALLET, type World } from './harness.test-helpers'
import { DEFAULTS } from './limits'
import { changeSettings, readSettings, setStop } from './store'
import { base64Json, HEADER_PAYMENT_REQUIRED, HEADER_V1_PAYMENT } from './types'

const worlds: World[] = []

const world = async (...args: Parameters<typeof makeWorld>) => {
  const w = await makeWorld(...args)

  worlds.push(w)

  return w
}

afterEach(async () => {
  for (const w of worlds.splice(0)) {
    await w.close()
  }
})

const rows = (w: World, kind: string) => w.ledger.read().records.filter(row => row.kind === kind)
const refusals = (w: World) => rows(w, 'refuse')

describe('the round trip against the local stub (J1 shape, loopback)', () => {
  it('402 + PAYMENT-REQUIRED → one signature → 200 + PAYMENT-RESPONSE success; the ledger holds signed → mandate_use → settled', async () => {
    const w = await world()
    const jti = w.issue('inft-7')
    const result = await w.client.pay({ url: w.url(), agent: 'inft-7', mandate: jti })

    expect(result).toMatchObject({ kind: 'paid', status: 200, body: 'paid content of /paid/one', micros: 1_000_000 })
    expect(w.signer.calls).toBe(1)
    expect(w.stub.counts).toEqual({ verify: 1, settle: 1, supported: 0 })
    expect(w.door.asked).toBe(1)
    // The mandate store writes to the same ledger (merge round: one ledger, one clock), so the issue comes first.
    expect(w.ledger.read().records.map(row => row.kind)).toEqual(['mandate_issue', 'signed', 'mandate_use', 'settled'])
    expect(rows(w, 'settled')[0]).toMatchObject({
      agent: 'inft-7',
      payTo: EARN_WALLET,
      micros: 1_000_000,
      network: 'eip155:84532',
      mandate: jti
    })
    expect(rows(w, 'settled')[0].transaction).toMatch(/^0x[0-9a-f]{64}$/)
    expect(w.audit).toEqual([{ kind: 'use', reason: 'settled', agent: 'inft-7' }])

    const settled = [...w.stub.settled.values()][0]

    expect(settled).toMatchObject({ payer: w.signer.address, micros: 1_000_000 })
  })

  it('a resource that is not for sale passes through untouched (no door, no signature)', async () => {
    const w = await world()

    expect(await w.client.pay({ url: w.url('/free'), agent: 'inft-7', mandate: w.issue('inft-7') })).toMatchObject({
      kind: 'passthrough',
      status: 404
    })
    expect(w.signer.calls).toBe(0)
    expect(w.door.asked).toBe(0)
    expect(w.ledger.read().records.map(row => row.kind)).toEqual(['mandate_issue'])
  })

  it('the pocket key never reaches the ledger, the audit, the mandates dir or the stub; the only hex64s on disk are the nonce and the transaction', async () => {
    const w = await world()

    await w.client.pay({ url: w.url(), agent: 'inft-7', mandate: w.issue('inft-7') })

    const pocket = fakeSealer().unseal(fs.readFileSync(path.join(w.paths.keys, 'pocket.sealed'), 'utf8').trim())

    const everything = [
      w.paths.ledger,
      ...fs.readdirSync(w.paths.mandates).map(name => path.join(w.paths.mandates, name))
    ]
      .map(file => fs.readFileSync(file, 'utf8'))
      .join('\n')

    const settled = rows(w, 'settled')[0]

    expect(pocket).toMatch(/^0x[0-9a-f]{64}$/)
    expect(everything).not.toContain(pocket)
    expect(everything).not.toContain(pocket.slice(2))
    expect(JSON.stringify(w.audit)).not.toMatch(/0x[0-9a-f]{64}/)
    expect(new Set(everything.match(/0x[0-9a-f]{64}/g))).toEqual(new Set([settled.nonce, settled.transaction]))
    expect(fs.readFileSync(path.join(w.paths.keys, 'pocket.sealed'), 'utf8')).not.toContain(pocket.slice(2, 20))
  })
})

describe('J2 — no mandate', () => {
  it('10 agent requests with no open mandate → 10/10 refused no_mandate, 10 audit rows, 0 signatures, 0 facilitator requests', async () => {
    const w = await world()

    for (let i = 0; i < 10; i += 1) {
      expect(await w.client.pay({ url: w.url(`/paid/${i}`), agent: `inft-${i % 3}`, mandate: null })).toMatchObject({
        kind: 'refused',
        reason: 'no_mandate'
      })
    }

    expect(refusals(w)).toHaveLength(10)
    expect(refusals(w).every(row => row.rule === 'no_mandate')).toBe(true)
    expect(w.audit.filter(entry => entry.kind === 'refuse' && entry.reason === 'no_mandate')).toHaveLength(10)
    expect(w.signer.calls).toBe(0)
    expect(w.stub.counts).toEqual({ verify: 0, settle: 0, supported: 0 })
    expect(w.door.asked).toBe(0)
  })

  it('an expired mandate and a tampered mandate byte are refused the same way (mandate_invalid), 0 signatures', async () => {
    let clock = new Date('2026-10-21T12:00:00Z')
    const w = await world({ now: () => clock })
    const expired = w.issue('inft-7', undefined, 60)

    clock = new Date('2026-10-21T12:02:00Z')
    expect(await w.client.pay({ url: w.url(), agent: 'inft-7', mandate: expired })).toMatchObject({
      kind: 'refused',
      reason: 'mandate_invalid',
      detail: 'open mandate expired'
    })

    const tampered = w.issue('inft-7')
    const file = path.join(w.paths.mandates, `${tampered}.sdjwt`)
    const text = fs.readFileSync(file, 'utf8')

    fs.writeFileSync(
      file,
      text.replace(/~([A-Za-z0-9_-])/, (_, c: string) => `~${c === 'A' ? 'B' : 'A'}`)
    )
    expect(await w.client.pay({ url: w.url(), agent: 'inft-7', mandate: tampered })).toMatchObject({
      kind: 'refused',
      reason: 'mandate_invalid'
    })

    expect(await w.client.pay({ url: w.url(), agent: 'inft-7', mandate: 'f'.repeat(32) })).toMatchObject({
      kind: 'refused',
      reason: 'mandate_invalid',
      detail: 'no such mandate'
    })
    expect(await w.client.pay({ url: w.url(), agent: 'inft-9', mandate: w.issue('inft-7') })).toMatchObject({
      kind: 'refused',
      reason: 'mandate_invalid'
    })

    expect(w.signer.calls).toBe(0)
    expect(w.stub.counts.verify + w.stub.counts.settle).toBe(0)
    expect(refusals(w)).toHaveLength(4)
  })

  it('a revoked mandate is refused; a mandate whose constraints exclude this payee is refused', async () => {
    const w = await world()
    const revoked = w.issue('inft-7')

    w.mandates.revoke(revoked)
    expect(await w.client.pay({ url: w.url(), agent: 'inft-7', mandate: revoked })).toMatchObject({
      kind: 'refused',
      reason: 'mandate_invalid',
      detail: 'open mandate revoked'
    })

    const narrow = w.issue('inft-7', [{ type: 'payment.allowed_payees', payees: [OTHER_WALLET] }])

    expect(await w.client.pay({ url: w.url(), agent: 'inft-7', mandate: narrow })).toMatchObject({
      kind: 'refused',
      reason: 'mandate_invalid',
      detail: 'payee not in mandate'
    })
    expect(w.signer.calls).toBe(0)
  })

  it('the mandate’s own budget is spent down by the ledger: the third 1.00 under a 2.00 budget is refused', async () => {
    const w = await world({ settings: { perAgentDayMicros: 10_000_000, perDayMicros: 10_000_000 } })
    const jti = w.issue('inft-7', [{ type: 'payment.budget', amount: '2.00', currency: 'USDC' }])

    expect((await w.client.pay({ url: w.url('/paid/a'), agent: 'inft-7', mandate: jti })).kind).toBe('paid')
    expect((await w.client.pay({ url: w.url('/paid/b'), agent: 'inft-7', mandate: jti })).kind).toBe('paid')
    expect(await w.client.pay({ url: w.url('/paid/c'), agent: 'inft-7', mandate: jti })).toMatchObject({
      kind: 'refused',
      detail: 'mandate budget exhausted'
    })
    expect(w.signer.calls).toBe(2)
  })
})

describe('J3 — ceilings (defaults and the owner’s edited set)', () => {
  const cases = (w: World, perTx: number) =>
    [
      [
        'per_tx',
        async () => w.client.pay({ url: w.url('/paid/x'), agent: 'inft-7', mandate: w.issue('inft-7') }),
        { priced: perTx + 10_000 }
      ],
      [
        'payee',
        async () => w.client.pay({ url: w.url('/paid/x'), agent: 'inft-7', mandate: w.issue('inft-7') }),
        { payee: OTHER_WALLET }
      ],
      [
        'origin',
        async () => w.client.pay({ url: `http://localhost:1/paid/x`, agent: 'inft-7', mandate: w.issue('inft-7') }),
        {}
      ]
    ] as const

  for (const [label, edited] of [
    ['DEFAULTS 1.00 / 5.00 / 2.00', null],
    [
      'EDITED 0.50 / 2.00 / 1.00, one payee',
      { perTxMicros: 500_000, perDayMicros: 2_000_000, perAgentDayMicros: 1_000_000 }
    ]
  ] as const) {
    describe(label, () => {
      it('per_tx: cap + 0.01 is refused with the rule name, 0 signatures', async () => {
        const perTx = edited?.perTxMicros ?? DEFAULTS.perTxMicros
        const w = await world({ priceMicros: perTx + 10_000, settings: edited ?? {} })

        for (let i = 0; i < 3; i += 1) {
          expect(
            await w.client.pay({ url: w.url(`/paid/${i}`), agent: 'inft-7', mandate: w.issue('inft-7') })
          ).toMatchObject({ kind: 'refused', reason: 'per_tx' })
        }

        expect(refusals(w).map(row => row.rule)).toEqual(['per_tx', 'per_tx', 'per_tx'])
        expect(refusals(w)[0]).toMatchObject({ micros: perTx + 10_000, payTo: EARN_WALLET })
        expect(w.signer.calls).toBe(0)
        expect(w.stub.counts.settle).toBe(0)
      })

      it('per_day: the day crosses on the n-th payment, derived from the ledger', async () => {
        const perTx = edited?.perTxMicros ?? DEFAULTS.perTxMicros
        const perDay = edited?.perDayMicros ?? DEFAULTS.perDayMicros
        const perAgent = edited?.perAgentDayMicros ?? DEFAULTS.perAgentDayMicros
        const w = await world({ priceMicros: perTx, settings: edited ?? {} })
        const perAgentCount = perAgent / perTx
        const total = perDay / perTx
        let paid = 0

        for (let i = 0; i < total; i += 1) {
          const agent = `inft-${Math.floor(i / perAgentCount)}`

          expect((await w.client.pay({ url: w.url(`/paid/${i}`), agent, mandate: w.issue(agent) })).kind).toBe('paid')
          paid += 1
        }

        for (let i = 0; i < 3; i += 1) {
          expect(
            await w.client.pay({ url: w.url(`/paid/over${i}`), agent: 'inft-99', mandate: w.issue('inft-99') })
          ).toMatchObject({ kind: 'refused', reason: 'per_day' })
        }

        expect(paid).toBe(total)
        expect(w.signer.calls).toBe(total)
        expect(refusals(w).map(row => row.rule)).toEqual(['per_day', 'per_day', 'per_day'])
      })

      it('per_agent_day: one agent crosses its own cap while the day is still open', async () => {
        const perTx = edited?.perTxMicros ?? DEFAULTS.perTxMicros
        const perAgent = edited?.perAgentDayMicros ?? DEFAULTS.perAgentDayMicros
        const w = await world({ priceMicros: perTx, settings: edited ?? {} })
        const count = perAgent / perTx

        for (let i = 0; i < count; i += 1) {
          expect(
            (await w.client.pay({ url: w.url(`/paid/${i}`), agent: 'inft-7', mandate: w.issue('inft-7') })).kind
          ).toBe('paid')
        }

        for (let i = 0; i < 3; i += 1) {
          expect(
            await w.client.pay({ url: w.url(`/paid/over${i}`), agent: 'inft-7', mandate: w.issue('inft-7') })
          ).toMatchObject({ kind: 'refused', reason: 'per_agent_day' })
        }

        expect(
          (await w.client.pay({ url: w.url('/paid/other'), agent: 'inft-8', mandate: w.issue('inft-8') })).kind
        ).toBe('paid')
        expect(refusals(w).map(row => row.rule)).toEqual(['per_agent_day', 'per_agent_day', 'per_agent_day'])
        expect(w.signer.calls).toBe(count + 1)
      })

      it('payee and origin outside the allowlists, and the hard stop (setting and file): 3 × 3 refused, 0 signatures, 0 network for origin/stop', async () => {
        const perTx = edited?.perTxMicros ?? DEFAULTS.perTxMicros
        const w = await world({ priceMicros: perTx, settings: edited ?? {} })
        const payeeWorld = await world({ priceMicros: perTx, settings: { ...(edited ?? {}), payees: [OTHER_WALLET] } })

        for (let i = 0; i < 3; i += 1) {
          expect(
            await payeeWorld.client.pay({
              url: payeeWorld.url(`/paid/${i}`),
              agent: 'inft-7',
              mandate: payeeWorld.issue('inft-7')
            })
          ).toMatchObject({ kind: 'refused', reason: 'payee' })
          expect(
            await w.client.pay({ url: `http://127.0.0.1:1/paid/${i}`, agent: 'inft-7', mandate: w.issue('inft-7') })
          ).toMatchObject({ kind: 'refused', reason: 'origin' })
        }

        const before = w.host.requests

        setStop(w.paths, true, w.ledger)
        expect(
          await w.client.pay({ url: w.url('/paid/s1'), agent: 'inft-7', mandate: w.issue('inft-7') })
        ).toMatchObject({ kind: 'refused', reason: 'stop' })
        setStop(w.paths, false, w.ledger)
        w.settings.stop = true
        expect(
          await w.client.pay({ url: w.url('/paid/s2'), agent: 'inft-7', mandate: w.issue('inft-7') })
        ).toMatchObject({ kind: 'refused', reason: 'stop' })
        expect(
          await w.client.pay({ url: w.url('/paid/s3'), agent: 'inft-7', mandate: w.issue('inft-7') })
        ).toMatchObject({ kind: 'refused', reason: 'stop' })
        w.settings.stop = false

        expect(w.host.requests).toBe(before)
        expect(refusals(w).map(row => row.rule)).toEqual(['origin', 'origin', 'origin', 'stop', 'stop', 'stop'])
        expect(refusals(payeeWorld).map(row => row.rule)).toEqual(['payee', 'payee', 'payee'])
        expect(w.signer.calls + payeeWorld.signer.calls).toBe(0)
        expect(w.stub.counts.settle + payeeWorld.stub.counts.settle).toBe(0)
      })
    })
  }

  it('NEGATIVE CONTROL: caps at the maximum and the payee/origin allowlisted ⇒ the same payment settles (the refusals above are the limits’ doing)', async () => {
    const w = await world({
      priceMicros: 1_010_000,
      settings: {
        perTxMicros: Number.MAX_SAFE_INTEGER,
        perDayMicros: Number.MAX_SAFE_INTEGER,
        perAgentDayMicros: Number.MAX_SAFE_INTEGER
      }
    })

    expect(await w.client.pay({ url: w.url(), agent: 'inft-7', mandate: w.issue('inft-7') })).toMatchObject({
      kind: 'paid',
      micros: 1_010_000
    })
    expect(w.stub.counts.settle).toBe(1)
  })

  it('the agent’s own --max refuses above it (per_tx) and never widens the user’s cap', async () => {
    const w = await world()

    expect(
      await w.client.pay({ url: w.url(), agent: 'inft-7', mandate: w.issue('inft-7'), maxMicros: 999_999 })
    ).toMatchObject({ kind: 'refused', reason: 'per_tx' })
    expect(
      await w.client.pay({
        url: w.url(),
        agent: 'inft-7',
        mandate: w.issue('inft-7'),
        maxMicros: Number.MAX_SAFE_INTEGER
      })
    ).toMatchObject({ kind: 'paid' })

    const over = await world({ priceMicros: 1_500_000 })

    expect(
      await over.client.pay({
        url: over.url(),
        agent: 'inft-7',
        mandate: over.issue('inft-7'),
        maxMicros: Number.MAX_SAFE_INTEGER
      })
    ).toMatchObject({ kind: 'refused', reason: 'per_tx' })
  })
})

describe('D5 / RFC 9110 — what is not paid', () => {
  it('a v1 server (x402Version 1 in PAYMENT-REQUIRED) is audited unsupported_version and never paid; v1 X-PAYMENT alone is not x402', async () => {
    const hijacked = await world()

    await hijacked.host.close()

    const { startResourceHost } = await import('./stub')

    hijacked.host = await startResourceHost(hijacked.server, (request, response) => {
      if (request.url === '/v1') {
        const v1 = { ...hijacked.server.requirementsFor(`${hijacked.host.origin}/paid/one`), x402Version: 1 }

        response.writeHead(402, { [HEADER_PAYMENT_REQUIRED]: base64Json.encode(v1) })
        response.end()

        return true
      }

      if (request.url === '/x-payment') {
        response.writeHead(402, { [HEADER_V1_PAYMENT]: 'eyJ4NDAyVmVyc2lvbiI6MX0=' })
        response.end()

        return true
      }

      if (request.url === '/bare') {
        response.writeHead(402)
        response.end('pay me')

        return true
      }

      return false
    })
    hijacked.settings.origins = [hijacked.host.origin]

    expect(
      await hijacked.client.pay({
        url: `${hijacked.host.origin}/v1`,
        agent: 'inft-7',
        mandate: hijacked.issue('inft-7')
      })
    ).toMatchObject({ kind: 'refused', reason: 'unsupported_version' })
    expect(
      await hijacked.client.pay({
        url: `${hijacked.host.origin}/x-payment`,
        agent: 'inft-7',
        mandate: hijacked.issue('inft-7')
      })
    ).toMatchObject({ kind: 'refused', reason: 'not_x402', detail: 'v1 header' })
    expect(
      await hijacked.client.pay({
        url: `${hijacked.host.origin}/bare`,
        agent: 'inft-7',
        mandate: hijacked.issue('inft-7')
      })
    ).toMatchObject({ kind: 'refused', reason: 'not_x402' })
    expect(hijacked.signer.calls).toBe(0)
    expect(refusals(hijacked).map(row => row.rule)).toEqual(['unsupported_version', 'not_x402', 'not_x402'])
  })

  it('a redirect is refused before any payment (never a cross-origin hop into a 402), and a resource.url on another origin is refused', async () => {
    const w = await world()

    await w.host.close()

    const { startResourceHost } = await import('./stub')
    const foreign = { ...w.server.requirementsFor(w.url()), resource: { url: 'https://evil.example/paid/one' } }

    w.host = await startResourceHost(w.server, (request, response) => {
      if (request.url === '/hop') {
        response.writeHead(302, { location: 'https://evil.example/paid' })
        response.end()

        return true
      }

      if (request.url === '/foreign') {
        response.writeHead(402, { [HEADER_PAYMENT_REQUIRED]: base64Json.encode(foreign) })
        response.end()

        return true
      }

      return false
    })
    w.settings.origins = [w.host.origin]

    expect(
      await w.client.pay({ url: `${w.host.origin}/hop`, agent: 'inft-7', mandate: w.issue('inft-7') })
    ).toMatchObject({ kind: 'refused', reason: 'cross_origin_redirect' })
    expect(
      await w.client.pay({ url: `${w.host.origin}/foreign`, agent: 'inft-7', mandate: w.issue('inft-7') })
    ).toMatchObject({ kind: 'refused', reason: 'cross_origin_redirect' })
    expect(w.signer.calls).toBe(0)
  })

  it('an accepts list without exact/USDC on the user’s network is refused (network); mainnet is refused until its switch is on', async () => {
    const w = await world()

    await w.host.close()

    const { startResourceHost } = await import('./stub')

    w.host = await startResourceHost(w.server, (request, response) => {
      const base = w.server.requirementsFor(`${w.host.origin}/paid/one`) as NonNullable<
        ReturnType<typeof w.server.requirementsFor>
      >

      const mainnet = {
        ...base,
        accepts: [{ ...base.accepts[0], network: 'eip155:8453', asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' }]
      }

      const permit2 = { ...base, accepts: [{ ...base.accepts[0], scheme: 'upto' }] }
      const body = request.url === '/mainnet' ? mainnet : request.url === '/upto' ? permit2 : null

      if (!body) {
        return false
      }

      response.writeHead(402, { [HEADER_PAYMENT_REQUIRED]: base64Json.encode(body) })
      response.end()

      return true
    })
    w.settings.origins = [w.host.origin]

    expect(
      await w.client.pay({ url: `${w.host.origin}/mainnet`, agent: 'inft-7', mandate: w.issue('inft-7') })
    ).toMatchObject({ kind: 'refused', reason: 'network' })
    expect(
      await w.client.pay({ url: `${w.host.origin}/upto`, agent: 'inft-7', mandate: w.issue('inft-7') })
    ).toMatchObject({ kind: 'refused', reason: 'network' })

    w.settings.network = 'eip155:8453'
    expect(
      await w.client.pay({ url: `${w.host.origin}/mainnet`, agent: 'inft-7', mandate: w.issue('inft-7') })
    ).toMatchObject({ kind: 'refused', reason: 'network' })
    expect(w.signer.calls).toBe(0)
  })

  it('a malformed PAYMENT-REQUIRED is refused as payload', async () => {
    const w = await world()

    await w.host.close()

    const { startResourceHost } = await import('./stub')

    w.host = await startResourceHost(w.server, (request, response) => {
      if (request.url === '/junk') {
        response.writeHead(402, {
          [HEADER_PAYMENT_REQUIRED]: Buffer.from('{"x402Version":2,"accepts":"no"}').toString('base64')
        })
        response.end()

        return true
      }

      return false
    })
    w.settings.origins = [w.host.origin]

    expect(
      await w.client.pay({ url: `${w.host.origin}/junk`, agent: 'inft-7', mandate: w.issue('inft-7') })
    ).toMatchObject({ kind: 'refused', reason: 'payload' })
  })

  it('a 402 without extra.name / extra.version (no EIP-712 domain) is refused payload before the door: 0 door, 0 signatures', async () => {
    const w = await world()

    await w.host.close()

    const { startResourceHost } = await import('./stub')

    w.host = await startResourceHost(w.server, (request, response) => {
      const base = w.server.requirementsFor(`${w.host.origin}/paid/one`) as NonNullable<
        ReturnType<typeof w.server.requirementsFor>
      >

      const { extra: _dropped, ...bare } = base.accepts[0]

      const body =
        request.url === '/no-extra'
          ? { ...base, accepts: [bare] }
          : request.url === '/half-extra'
            ? { ...base, accepts: [{ ...bare, extra: { name: 'USDC' } }] }
            : null

      if (!body) {
        return false
      }

      response.writeHead(402, { [HEADER_PAYMENT_REQUIRED]: base64Json.encode(body) })
      response.end()

      return true
    })
    w.settings.origins = [w.host.origin]

    for (const route of ['/no-extra', '/half-extra']) {
      expect(
        await w.client.pay({ url: `${w.host.origin}${route}`, agent: 'inft-7', mandate: w.issue('inft-7') })
      ).toMatchObject({
        kind: 'refused',
        reason: 'payload',
        detail: 'EIP-712 domain missing (extra.name / extra.version)'
      })
    }

    expect(w.door.asked).toBe(0)
    expect(w.signer.calls).toBe(0)
    expect(rows(w, 'signed')).toHaveLength(0)
  })
})

describe('the door and the signer (V3-F floor 5; R2)', () => {
  it('no door wired ⇒ refused no_door after the mandate verified; door says no ⇒ door_denied; both 0 signatures', async () => {
    const none = await world({ door: 'none' })

    expect(await none.client.pay({ url: none.url(), agent: 'inft-7', mandate: none.issue('inft-7') })).toMatchObject({
      kind: 'refused',
      reason: 'no_door'
    })

    const w = await world()

    w.door.answer = false
    expect(await w.client.pay({ url: w.url(), agent: 'inft-7', mandate: w.issue('inft-7') })).toMatchObject({
      kind: 'refused',
      reason: 'door_denied'
    })
    expect(w.door.asked).toBe(1)
    expect(none.signer.calls + w.signer.calls).toBe(0)
    expect(w.audit).toEqual([{ kind: 'refuse', reason: 'door_denied', agent: 'inft-7' }])
  })

  it('the door sees the mandate in plain terms: payee, amount, network, the open mandate’s constraints', async () => {
    const seen: unknown[] = []

    const w = await world({
      door: async request => {
        seen.push(request)

        return true
      }
    })

    await w.client.pay({ url: w.url(), agent: 'inft-7', mandate: w.issue('inft-7') })
    expect(seen[0]).toMatchObject({
      agent: 'inft-7',
      payTo: EARN_WALLET,
      micros: 1_000_000,
      network: 'eip155:84532',
      resource: w.url()
    })
    expect((seen[0] as { mandate: { constraints: unknown[] } }).mandate.constraints).toHaveLength(3)
  })

  it('a door that throws is a no', async () => {
    const w = await world({ door: () => Promise.reject(new Error('sheet closed')) })

    expect(await w.client.pay({ url: w.url(), agent: 'inft-7', mandate: w.issue('inft-7') })).toMatchObject({
      kind: 'refused',
      reason: 'door_denied'
    })
  })

  it('n1: only the boolean true opens the door — "yes", 1, {}, [true], "true" and a promise of a truthy value are door_denied, 0 signatures', async () => {
    const answers: [string, () => unknown][] = [
      ['"yes"', () => 'yes'],
      ['"true"', () => 'true'],
      ['1', () => 1],
      ['{}', () => ({})],
      ['[true]', () => [true]],
      ['Promise<"yes">', () => Promise.resolve('yes')],
      ['Promise<1>', () => new Promise(resolve => setTimeout(() => resolve(1), 5))]
    ]

    for (const [, answer] of answers) {
      let asked = 0

      const w = await world({
        door: (async () => {
          asked += 1

          return answer()
        }) as unknown as SpendDoor
      })

      expect(await w.client.pay({ url: w.url(), agent: 'inft-7', mandate: w.issue('inft-7') })).toMatchObject({
        kind: 'refused',
        reason: 'door_denied'
      })
      expect(asked).toBe(1)
      expect(w.signer.calls).toBe(0)
      expect(rows(w, 'signed')).toHaveLength(0)
      expect(w.stub.counts.verify).toBe(0)
    }

    // The control: the same world with the boolean true pays.
    const w = await world({ door: async () => true })

    expect((await w.client.pay({ url: w.url(), agent: 'inft-7', mandate: w.issue('inft-7') })).kind).toBe('paid')
  })

  it('no OS sealing ⇒ signer_unavailable with the Keychain reason; the mandate keys are also unavailable so the refusal is earlier', async () => {
    const w = await world({ sealer: null })

    expect(w.signer).toMatchObject({ status: 'unavailable', address: null })
    expect(await w.client.pay({ url: w.url(), agent: 'inft-7', mandate: 'a'.repeat(32) })).toMatchObject({
      kind: 'refused',
      reason: 'mandate_invalid'
    })
    expect(w.signer.calls).toBe(0)
  })
})

describe('J7 — no auto-retry', () => {
  it('settlement_pending ⇒ exactly 1 /settle, a pending row with the nonce, the reconciler hook called, 0 second signatures', async () => {
    const w = await world({ stubMode: 'pending' })
    const result = await w.client.pay({ url: w.url(), agent: 'inft-7', mandate: w.issue('inft-7') })

    expect(result).toMatchObject({ kind: 'pending', micros: 1_000_000 })
    expect(w.signer.calls).toBe(1)
    expect(w.stub.counts.settle).toBe(1)
    expect(rows(w, 'pending')[0]).toMatchObject({ nonce: (result as { nonce: string }).nonce, micros: 1_000_000 })
    expect(w.ledger.read().records.map(row => row.kind)).toEqual(['mandate_issue', 'signed', 'mandate_use', 'pending'])
    expect(w.audit).toEqual([{ kind: 'timeout', reason: 'settlement_pending', agent: 'inft-7' }])
    expect(w.ledger.limitsView().signed).toHaveLength(1)
  })

  it('a facilitator that never answers /settle ⇒ the server times out once, answers settlement_pending, the client records pending; still 1 /settle', async () => {
    const w = await world({ stubMode: 'timeout', facilitatorTimeoutMs: 300 })
    const result = await w.client.pay({ url: w.url(), agent: 'inft-7', mandate: w.issue('inft-7') })

    expect(result.kind).toBe('pending')
    expect(w.signer.calls).toBe(1)
    expect(w.stub.counts.settle).toBe(1)
    expect(w.stub.counts.verify).toBe(1)
  })

  it('a paid retry answered 402 again is failed, not paid twice; the signed row still counts against the day', async () => {
    const w = await world({ stubMode: 'invalid' })
    const result = await w.client.pay({ url: w.url(), agent: 'inft-7', mandate: w.issue('inft-7') })

    expect(result).toMatchObject({ kind: 'failed', detail: 'paid request answered 402 again (not retried)' })
    expect(w.signer.calls).toBe(1)
    expect(w.stub.counts).toMatchObject({ verify: 1, settle: 0 })
    expect(w.ledger.limitsView().signed).toHaveLength(1)
    expect(w.audit).toEqual([{ kind: 'gap', reason: 'settlement_unknown', agent: 'inft-7' }])
  })

  it('a settle that fails outright is failed with the reason', async () => {
    const w = await world({ stubMode: 'settle_fail' })

    expect(await w.client.pay({ url: w.url(), agent: 'inft-7', mandate: w.issue('inft-7') })).toMatchObject({
      kind: 'failed',
      detail: 'settlement failed: insufficient_funds'
    })
    expect(w.stub.counts.settle).toBe(1)
  })

  it('two concurrent pays for one resource by one agent: the second is refused duplicate, one signature', async () => {
    const w = await world()
    const jti = w.issue('inft-7')

    const [a, b] = await Promise.all([
      w.client.pay({ url: w.url(), agent: 'inft-7', mandate: jti }),
      w.client.pay({ url: w.url(), agent: 'inft-7', mandate: jti })
    ])

    expect([a.kind, b.kind].sort()).toEqual(['paid', 'refused'])
    expect((a.kind === 'refused' ? a : b) as { reason: string }).toMatchObject({ reason: 'duplicate' })
    expect(w.signer.calls).toBe(1)
  })

  it('a ledger that stops verifying mid-day refuses the next payment (ledger rule) before the door', async () => {
    const w = await world()
    // Both mandates first: an issue is a ledger row too, and a broken chain refuses it.
    const [first, second] = [w.issue('inft-7'), w.issue('inft-7')]

    expect((await w.client.pay({ url: w.url(), agent: 'inft-7', mandate: first })).kind).toBe('paid')
    fs.writeFileSync(
      w.paths.ledger,
      fs.readFileSync(w.paths.ledger, 'utf8').replace('"micros":1000000,', '"micros":1,')
    )

    expect(await w.client.pay({ url: w.url('/paid/two'), agent: 'inft-7', mandate: second })).toMatchObject({
      kind: 'refused',
      reason: 'ledger'
    })
    expect(w.door.asked).toBe(1)
    expect(w.signer.calls).toBe(1)
  })
})

describe('m6 — D1 signer: only the pocket signs in this build', () => {
  it('signer "agentcard" is refused signer_unavailable before any network: 0 door, 0 signatures, 0 facilitator', async () => {
    const w = await world({ settings: { signer: 'agentcard' } })

    expect(await w.client.pay({ url: w.url(), agent: 'inft-7', mandate: w.issue('inft-7') })).toMatchObject({
      kind: 'refused',
      reason: 'signer_unavailable',
      detail: expect.stringContaining('not available in this build')
    })
    expect(w.door.asked).toBe(0)
    expect(w.signer.calls).toBe(0)
    expect(w.stub.counts).toEqual({ verify: 0, settle: 0, supported: 0 })
    expect(w.host.requests).toBe(0)
    expect(refusals(w)).toHaveLength(1)
    expect(w.audit).toEqual([{ kind: 'refuse', reason: 'signer_unavailable', agent: 'inft-7' }])
  })

  it('the signer switched to "agentcard" while the sheet is open is refused on the re-check, never pocket-signed', async () => {
    let w: World | null = null

    w = await world({
      door: async () => {
        ;(w as World).settings.signer = 'agentcard'

        return true
      }
    })

    expect(await w.client.pay({ url: w.url(), agent: 'inft-7', mandate: w.issue('inft-7') })).toMatchObject({
      kind: 'refused',
      reason: 'signer_unavailable'
    })
    expect(w.signer.calls).toBe(0)
    expect(rows(w, 'signed')).toHaveLength(0)
  })
})

describe('m4 — nothing the signer says reaches a note', () => {
  it('a signer that throws with key material in its message: failed with the fixed note "sign failed", the message nowhere on disk', async () => {
    const w = await world()
    const secret = 'cafe'.repeat(16)

    w.signer.signAuthorization = () => Promise.reject(new Error(`viem: bad key ${secret} / ${secret.slice(0, 20)}`))

    const result = await w.client.pay({ url: w.url(), agent: 'inft-7', mandate: w.issue('inft-7') })

    expect(result).toMatchObject({ kind: 'failed', detail: 'sign failed' })
    expect(rows(w, 'failed')[0]).toMatchObject({ note: 'sign failed' })
    expect(fs.readFileSync(w.paths.ledger, 'utf8')).not.toContain('bad key')
    expect(JSON.stringify(w.audit)).not.toContain('cafe')
  })
})

describe('M1 — the ceilings are atomic across the door (a real door takes seconds)', () => {
  /** A human at the sheet: answers yes after `ms`, counting the sheets it was shown. */
  const slowDoor = (ms = 150, before?: () => void) => {
    const door = {
      asked: 0,
      fn: async () => {
        door.asked += 1
        before?.()
        await new Promise(resolve => setTimeout(resolve, ms))

        return true
      }
    }

    return door
  }

  const kinds = (results: { kind: string }[]) => results.map(result => result.kind).sort()

  it('same agent, two resources, 2 × 1.00 against a 1.50 day: 1 paid, 1 refused per_day; the second sheet is never shown', async () => {
    const door = slowDoor()
    const w = await world({ door: door.fn, settings: { perDayMicros: 1_500_000, perAgentDayMicros: 1_500_000 } })
    const jti = w.issue('inft-7')

    const results = await Promise.all([
      w.client.pay({ url: w.url('/paid/a'), agent: 'inft-7', mandate: jti }),
      w.client.pay({ url: w.url('/paid/b'), agent: 'inft-7', mandate: jti })
    ])

    expect(kinds(results)).toEqual(['paid', 'refused'])
    expect(results.find(result => result.kind === 'refused')).toMatchObject({ reason: 'per_day' })
    expect(rows(w, 'signed')).toHaveLength(1)
    expect(w.signer.calls).toBe(1)
    expect(w.stub.counts.settle).toBe(1)
    expect(door.asked).toBe(1)
  })

  it('two agents at once, each under its own cap, together over the 1.50 day: both sheets open, the later yes is refused per_day on the re-check', async () => {
    const door = slowDoor()
    const w = await world({ door: door.fn, settings: { perDayMicros: 1_500_000, perAgentDayMicros: 1_000_000 } })

    const results = await Promise.all([
      w.client.pay({ url: w.url('/paid/a'), agent: 'agent-a', mandate: w.issue('agent-a') }),
      w.client.pay({ url: w.url('/paid/b'), agent: 'agent-b', mandate: w.issue('agent-b') })
    ])

    expect(kinds(results)).toEqual(['paid', 'refused'])
    expect(results.find(result => result.kind === 'refused')).toMatchObject({ reason: 'per_day' })
    expect(door.asked).toBe(2)
    expect(rows(w, 'signed')).toHaveLength(1)
    expect(w.signer.calls).toBe(1)
    expect(w.stub.counts.settle).toBe(1)
  })

  it('one mandate, budget 1.50, two uses of 1.00 at once: 1 paid, 1 refused mandate_invalid (budget), one mandate_use row', async () => {
    const door = slowDoor()
    const w = await world({ door: door.fn, settings: { perDayMicros: 50_000_000, perAgentDayMicros: 50_000_000 } })

    const jti = w.issue('inft-7', [
      { type: 'payment.budget', amount: '1.50', currency: 'USDC' },
      { type: 'payment.allowed_payees', payees: [EARN_WALLET] }
    ])

    const results = await Promise.all([
      w.client.pay({ url: w.url('/paid/a'), agent: 'inft-7', mandate: jti }),
      w.client.pay({ url: w.url('/paid/b'), agent: 'inft-7', mandate: jti })
    ])

    expect(kinds(results)).toEqual(['paid', 'refused'])
    expect(results.find(result => result.kind === 'refused')).toMatchObject({
      reason: 'mandate_invalid',
      detail: 'mandate budget exhausted'
    })
    expect(rows(w, 'mandate_use')).toHaveLength(1)
    expect(w.signer.calls).toBe(1)
  })

  it('STOP flipped while the sheet is open (file, then setting), the owner then says yes: refused stop, 0 signatures, 0 signed rows', async () => {
    let w: World | null = null

    const viaFile = slowDoor(50, () => setStop((w as World).paths, true, (w as World).ledger))

    w = await world({ door: viaFile.fn })
    expect(await w.client.pay({ url: w.url(), agent: 'inft-7', mandate: w.issue('inft-7') })).toMatchObject({
      kind: 'refused',
      reason: 'stop'
    })
    expect(viaFile.asked).toBe(1)
    expect(w.signer.calls).toBe(0)
    expect(rows(w, 'signed')).toHaveLength(0)

    let v: World | null = null

    const viaSetting = slowDoor(50, () => {
      ;(v as World).settings.stop = true
    })

    v = await world({ door: viaSetting.fn })
    expect(await v.client.pay({ url: v.url(), agent: 'inft-7', mandate: v.issue('inft-7') })).toMatchObject({
      kind: 'refused',
      reason: 'stop'
    })
    expect(v.signer.calls).toBe(0)
    expect(rows(v, 'signed')).toHaveLength(0)
  })

  it('a cap lowered, a payee removed or the mandate revoked while the sheet is open: refused on the re-check, 0 signatures', async () => {
    const cases: [string, (w: World, jti: string) => void, string][] = [
      ['per_tx', w => (w.settings.perTxMicros = 500_000), 'per_tx'],
      ['payee', w => (w.settings.payees = []), 'payee'],
      ['revoked', (w, jti) => w.mandates.revoke(jti), 'mandate_invalid']
    ]

    for (const [, mutate, reason] of cases) {
      let w: World | null = null
      let jti = ''

      const door = slowDoor(30, () => mutate(w as World, jti))

      w = await world({ door: door.fn })
      jti = w.issue('inft-7')
      expect(await w.client.pay({ url: w.url(), agent: 'inft-7', mandate: jti })).toMatchObject({
        kind: 'refused',
        reason
      })
      expect(w.signer.calls).toBe(0)
      expect(rows(w, 'signed')).toHaveLength(0)
    }
  })

  it('10 concurrent pays by 5 agents (1.00 each; day 3.00, agent-day 2.00; doors 0–120 ms): settled ≤ the day cap, exactly 3 paid, one signature per signed row', async () => {
    const w = await world({
      door: async () => {
        await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 120)))

        return true
      },
      settings: { perDayMicros: 3_000_000, perAgentDayMicros: 2_000_000 }
    })

    const agents = ['a1', 'a2', 'a3', 'a4', 'a5']
    const mandates = new Map(agents.map(agent => [agent, w.issue(agent)]))

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => {
        const agent = agents[i % agents.length]

        return w.client.pay({ url: w.url(`/paid/r${i}`), agent, mandate: mandates.get(agent) as string })
      })
    )

    const settled = rows(w, 'settled').reduce((sum, row) => sum + (row.micros ?? 0), 0)

    expect(settled).toBeLessThanOrEqual(3_000_000)
    expect(results.filter(result => result.kind === 'paid')).toHaveLength(3)
    expect(results.filter(result => result.kind === 'refused')).toHaveLength(7)
    expect(rows(w, 'signed')).toHaveLength(3)
    expect(w.signer.calls).toBe(3)
    expect(w.stub.counts.settle).toBe(3)

    for (const agent of agents) {
      expect(rows(w, 'signed').filter(row => row.agent === agent).length).toBeLessThanOrEqual(2)
    }
  })

  it('a mandate_use row that cannot be written after the signed row: refused ledger, nothing signed, the signed row still counts', async () => {
    const w = await world()

    const client = createX402Client({
      settings: () => w.settings,
      stopped: () => false,
      ledger: {
        ...w.ledger,
        append: (entry, at) => (entry.kind === 'mandate_use' ? null : w.ledger.append(entry, at))
      },
      mandates: w.mandates,
      signer: w.signer,
      door: async () => true,
      audit: null,
      fetch
    })

    expect(await client.pay({ url: w.url(), agent: 'inft-7', mandate: w.issue('inft-7') })).toMatchObject({
      kind: 'refused',
      reason: 'ledger',
      detail: 'ledger write failed (mandate use)'
    })
    expect(w.signer.calls).toBe(0)
    expect(rows(w, 'signed')).toHaveLength(1)
    expect(w.stub.counts.settle).toBe(0)
  })

  it('a door that never answers is a no at its deadline, and the agent’s queue moves on', async () => {
    let calls = 0

    const w = await world({
      doorTimeoutMs: 100,
      door: () => {
        calls += 1

        return calls === 1 ? new Promise<boolean>(() => {}) : Promise.resolve(true)
      }
    })

    const jti = w.issue('inft-7')

    const results = await Promise.all([
      w.client.pay({ url: w.url('/paid/a'), agent: 'inft-7', mandate: jti }),
      w.client.pay({ url: w.url('/paid/b'), agent: 'inft-7', mandate: jti })
    ])

    expect(results[0]).toMatchObject({ kind: 'refused', reason: 'door_denied' })
    expect(results[1]).toMatchObject({ kind: 'paid' })
    expect(w.signer.calls).toBe(1)
  })
})

describe('J8 — the earn side', () => {
  it('3 clients pay the iNFT’s resource; payTo is the wallet; the earn ledger has 3 earned rows; the server never signs', async () => {
    const w = await world({ settings: { perDayMicros: 10_000_000 } })

    for (const agent of ['inft-1', 'inft-2', 'inft-3']) {
      const result = await w.client.pay({ url: w.url(`/paid/${agent}`), agent, mandate: w.issue(agent) })

      expect(result.kind).toBe('paid')
    }

    const required = w.server.requirementsFor(w.url()) as NonNullable<ReturnType<typeof w.server.requirementsFor>>

    expect(required.accepts[0]).toMatchObject({
      scheme: 'exact',
      network: 'eip155:84532',
      payTo: EARN_WALLET,
      amount: '1000000',
      extra: { name: 'USDC', version: '2' }
    })
    expect([...w.stub.settled.values()].every(entry => entry.payer === w.signer.address)).toBe(true)
    expect(w.stub.counts).toEqual({ verify: 3, settle: 3, supported: 0 })

    const earn = fs
      .readFileSync(path.join(w.dir, 'earn', 'ledger.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))

    expect(earn.map(row => row.kind)).toEqual(['claim', 'earned', 'claim', 'earned', 'claim', 'earned'])
    expect(earn[1]).toMatchObject({ payTo: null, micros: 1_000_000, network: 'eip155:84532' })
    expect(earn[0].nonce).toBe(earn[1].nonce)
  })

  it('a wrong-network payload is refused by the server before /verify, a forged signature at /verify; 0 settles', async () => {
    const w = await world()
    const required = w.server.requirementsFor(w.url()) as NonNullable<ReturnType<typeof w.server.requirementsFor>>

    const auth = {
      from: w.signer.address as string,
      to: EARN_WALLET,
      value: '1000000',
      validAfter: '0',
      validBefore: String(Math.floor(Date.now() / 1000) + 60),
      nonce: `0x${'ab'.repeat(32)}`
    }

    const forged = {
      x402Version: 2,
      accepted: required.accepts[0],
      payload: { signature: `0x${'11'.repeat(65)}`, authorization: auth }
    }

    const wrongNetwork = { ...forged, accepted: { ...required.accepts[0], network: 'eip155:8453' } }

    const a = await w.server.handle({ url: w.url(), headers: { 'payment-signature': base64Json.encode(wrongNetwork) } })
    const b = await w.server.handle({ url: w.url(), headers: { 'payment-signature': base64Json.encode(forged) } })
    const c = await w.server.handle({ url: w.url(), headers: { 'payment-signature': 'not base64 json' } })

    expect(a.status).toBe(402)
    expect(b.status).toBe(402)
    expect(c.status).toBe(402)
    expect((base64Json.decode(a.headers['payment-required']) as { error: string }).error).toBe(
      'scheme or network mismatch'
    )
    expect((base64Json.decode(b.headers['payment-required']) as { error: string }).error).toBe(
      'invalid_exact_evm_payload_signature'
    )
    expect(w.stub.counts).toEqual({ verify: 1, settle: 0, supported: 0 })
    expect(w.signer.calls).toBe(0)
  })

  /** A correctly signed payload for the server's own requirements (the pocket of this world signs, a throwaway key). */
  const signedPayload = async (w: World, nonce: string, window: { validAfter?: string; validBefore?: string } = {}) => {
    const required = w.server.requirementsFor(w.url()) as NonNullable<ReturnType<typeof w.server.requirementsFor>>
    const requirements = required.accepts[0]

    const authorization = {
      from: w.signer.address as string,
      to: EARN_WALLET,
      value: requirements.amount,
      validAfter: '0',
      validBefore: String(Math.floor(Date.now() / 1000) + 60),
      nonce,
      ...window
    }

    const { domainFor } = await import('./signer')
    const domain = domainFor('eip155:84532', requirements)

    if (!domain) {
      throw new Error('no domain')
    }

    const signature = await w.signer.signAuthorization(authorization, domain)

    return base64Json.encode({
      x402Version: 2,
      resource: { url: w.url() },
      accepted: requirements,
      payload: { signature, authorization }
    })
  }

  it('m1 replay: a settled payload presented again is refused before /verify (nonce already used); 1 verify, 1 settle', async () => {
    const w = await world()
    const header = await signedPayload(w, `0x${'5a'.repeat(32)}`)
    const a = await w.server.handle({ url: w.url(), headers: { 'payment-signature': header } })
    const b = await w.server.handle({ url: w.url(), headers: { 'payment-signature': header } })
    // The same authorization with the nonce's hex in upper case (same bytes32, same signature) is the same nonce.
    const decoded = base64Json.decode(header) as { payload: { authorization: { nonce: string } } }

    decoded.payload.authorization.nonce = `0x${decoded.payload.authorization.nonce.slice(2).toUpperCase()}`

    const upper = await w.server.handle({
      url: w.url(),
      headers: { 'payment-signature': base64Json.encode(decoded) }
    })

    expect(a.status).toBe(200)
    expect(b.status).toBe(402)
    expect((base64Json.decode(b.headers['payment-required']) as { error: string }).error).toBe('nonce already used')
    expect(upper.status).toBe(402)
    expect((base64Json.decode(upper.headers['payment-required']) as { error: string }).error).toBe('nonce already used')
    expect(w.stub.counts).toEqual({ verify: 1, settle: 1, supported: 0 })
  })

  it('m1 race: the same payload presented twice at once between /verify and /settle ⇒ exactly one served, one settle', async () => {
    const w = await world()
    const header = await signedPayload(w, `0x${'6b'.repeat(32)}`)

    const both = await Promise.all([
      w.server.handle({ url: w.url(), headers: { 'payment-signature': header } }),
      w.server.handle({ url: w.url(), headers: { 'payment-signature': header } })
    ])

    expect(both.map(response => response.status).sort()).toEqual([200, 402])
    expect(w.stub.counts.settle).toBe(1)
  })

  it('merge-clocks: the earn server has no clock of its own — `now:` is a type error and ignored; the window is judged on its ledger’s clock', async () => {
    const w = await world()
    // validBefore = wall clock + 60 s: fine on the wall clock, already past on a ledger clock 1 h ahead.
    const header = await signedPayload(w, `0x${'9d'.repeat(32)}`)

    const { createLedger } = await import('./ledger')
    const { createX402Server } = await import('./server')

    const ahead = createLedger({
      file: path.join(w.dir, 'earn-ahead', 'ledger.jsonl'),
      now: () => new Date(Date.now() + 3_600_000)
    })

    const server = createX402Server({
      network: 'eip155:84532',
      payTo: EARN_WALLET,
      facilitator: w.facilitator,
      ledger: ahead,
      priceOf: () => 1_000_000,
      serve: async () => ({ body: 'never served', mimeType: 'text/plain' }),
      // @ts-expect-error — the server has no clock of its own (merge round): the only clock is `ledger.now`.
      now: () => new Date()
    })

    const response = await server.handle({ url: w.url(), headers: { 'payment-signature': header } })

    expect(response.status).toBe(402)
    expect(w.stub.counts).toEqual({ verify: 0, settle: 0, supported: 0 })
    expect(ahead.read().records).toMatchObject([{ kind: 'failed', note: 'earn refused: authorization window' }])
  })

  it('I8: the earn server never rejects — a ledger that throws on read, on the claim, or after /settle, and a resource that throws, each get an answer and an audit entry', async () => {
    const w = await world()
    const { createLedger } = await import('./ledger')
    const { createX402Server } = await import('./server')
    type Fault = 'claim' | 'outcome' | 'read' | 'serve'

    const serverWith = (fault: Fault, name: string) => {
      const real = createLedger({ file: path.join(w.dir, `earn-${name}`, 'ledger.jsonl') })
      const audit: PaymentAuditEntry[] = []
      let served = 0

      const server = createX402Server({
        network: 'eip155:84532',
        payTo: EARN_WALLET,
        facilitator: w.facilitator,
        ledger: {
          ...real,
          read: () => {
            if (fault === 'read') {
              throw new Error('EIO: read')
            }

            return real.read()
          },
          append: (entry, at) => {
            if ((fault === 'claim' && entry.kind === 'claim') || (fault === 'outcome' && entry.kind === 'earned')) {
              throw new Error('EIO: append')
            }

            return real.append(entry, at)
          }
        },
        priceOf: () => 1_000_000,
        serve: async () => {
          if (fault === 'serve') {
            throw new Error('resource gone')
          }

          served += 1

          return { body: 'the resource', mimeType: 'text/plain' }
        },
        audit: { record: entry => audit.push(entry) }
      })

      return { server, real, audit, served: () => served }
    }

    const cases: [Fault, string, number, number, PaymentAuditEntry][] = [
      ['read', 'a1', 402, 0, { kind: 'refuse', reason: 'ledger', agent: '' }],
      ['claim', 'a2', 402, 0, { kind: 'refuse', reason: 'ledger', agent: '' }],
      ['serve', 'a3', 503, 0, { kind: 'gap', reason: 'earn_internal', agent: '' }],
      ['outcome', 'a4', 200, 1, { kind: 'gap', reason: 'ledger_write_failed', agent: '' }]
    ]

    let settles = 0

    for (const [fault, byte, status, settled, audited] of cases) {
      const one = serverWith(fault, byte)
      const header = await signedPayload(w, `0x${byte.repeat(32)}`)
      const response = await one.server.handle({ url: w.url(), headers: { 'payment-signature': header } })

      settles += settled
      expect(response.status, fault).toBe(status)
      expect(one.audit, fault).toEqual([audited])
      expect(w.stub.counts.settle, fault).toBe(settles)
      // Served only when it was settled: never a resource for nothing.
      expect(one.served(), fault).toBe(fault === 'outcome' ? 1 : 0)

      if (status === 200) {
        expect(response.body).toBe('the resource')
        expect(base64Json.decode(response.headers['payment-response'])).toMatchObject({ success: true })
      } else {
        expect(response.body).toBe('')
      }
    }
  })

  it('m1 the claim set survives a restart: a new server on the same earn ledger refuses the replay before /verify', async () => {
    const w = await world()
    const header = await signedPayload(w, `0x${'7c'.repeat(32)}`)

    expect((await w.server.handle({ url: w.url(), headers: { 'payment-signature': header } })).status).toBe(200)

    const { createLedger } = await import('./ledger')
    const { createX402Server } = await import('./server')

    const again = createX402Server({
      network: 'eip155:84532',
      payTo: EARN_WALLET,
      facilitator: w.facilitator,
      ledger: createLedger({ file: path.join(w.dir, 'earn', 'ledger.jsonl') }),
      priceOf: () => 1_000_000,
      serve: async () => ({ body: 'again', mimeType: 'text/plain' })
    })

    expect((await again.handle({ url: w.url(), headers: { 'payment-signature': header } })).status).toBe(402)
    expect(w.stub.counts).toEqual({ verify: 1, settle: 1, supported: 0 })
  })

  it('m5 the server’s own window check: validBefore under 6 s away, or validAfter in the future, is refused BEFORE /verify', async () => {
    const w = await world()
    const seconds = Math.floor(Date.now() / 1000)

    const cases = [
      { nonce: `0x${'81'.repeat(32)}`, window: { validBefore: String(seconds + 3) } },
      { nonce: `0x${'82'.repeat(32)}`, window: { validBefore: String(seconds - 1) } },
      {
        nonce: `0x${'83'.repeat(32)}`,
        window: { validAfter: String(seconds + 60), validBefore: String(seconds + 120) }
      }
    ]

    for (const { nonce, window } of cases) {
      const header = await signedPayload(w, nonce, window)
      const response = await w.server.handle({ url: w.url(), headers: { 'payment-signature': header } })

      expect(response.status).toBe(402)
      expect((base64Json.decode(response.headers['payment-required']) as { error: string }).error).toBe(
        'authorization window'
      )
    }

    expect(w.stub.counts).toEqual({ verify: 0, settle: 0, supported: 0 })
  })
})

describe('m5 — the client’s own controls, each with a test that dies without it', () => {
  /** A client on the world's deps whose fetch keeps every PAYMENT-SIGNATURE it sends. */
  const capturing = (w: World, mandates = w.mandates) => {
    const sent: { authorization: { validBefore: string; validAfter: string } }[] = []

    const client = createX402Client({
      settings: () => w.settings,
      stopped: () => false,
      ledger: w.ledger,
      mandates,
      signer: w.signer,
      door: async () => true,
      audit: null,
      fetch: (input, init) => {
        const header = new Headers(init?.headers).get('payment-signature')

        if (header) {
          sent.push((base64Json.decode(header) as { payload: (typeof sent)[number] }).payload)
        }

        return fetch(input, init)
      }
    })

    return { client, sent }
  }

  it('the authorization lives at most 600 s even when the server offers 3600; a shorter offer is kept', async () => {
    for (const [offer, expected] of [
      [3600, 600],
      [120, 120]
    ]) {
      const w = await world({ maxTimeoutSeconds: offer })
      const { client, sent } = capturing(w)
      const before = Math.floor(Date.now() / 1000)

      expect((await client.pay({ url: w.url(), agent: 'inft-7', mandate: w.issue('inft-7') })).kind).toBe('paid')

      const after = Math.floor(Date.now() / 1000)
      const validBefore = Number(sent[0].authorization.validBefore)

      expect(sent).toHaveLength(1)
      expect(validBefore).toBeGreaterThanOrEqual(before + expected)
      expect(validBefore).toBeLessThanOrEqual(after + expected)
    }
  })

  it('a closed mandate naming another AMOUNT (payee unchanged) is refused by the cross-check; another payee likewise; 0 signatures', async () => {
    for (const forged of [{ micros: 1 }, { payTo: OTHER_WALLET }]) {
      const w = await world()
      const real = w.mandates

      const lying = {
        ...real,
        close: (id: string, input: Parameters<typeof real.close>[1]) => real.close(id, { ...input, ...forged })
      }

      const { client } = capturing(w, lying)

      expect(await client.pay({ url: w.url(), agent: 'inft-7', mandate: w.issue('inft-7') })).toMatchObject({
        kind: 'refused',
        reason: 'mandate_invalid',
        detail: 'closed mandate does not name this payment'
      })
      expect(w.signer.calls).toBe(0)
      expect(rows(w, 'signed')).toHaveLength(0)
    }
  })
})

describe('N1 — identity fields are never redacted: every agent keeps its own per-agent-day cap', () => {
  it('agents named like a provider key or a Luhn-valid number: 1 paid, the rest refused per_agent_day; rows carry the raw name', async () => {
    for (const agent of ['sk-trader-bot-alpha', 'pk-research-agent-01', 'ghp_agentnumberone', '4111111111111111']) {
      const w = await world({ settings: { perDayMicros: 50_000_000, perAgentDayMicros: 1_000_000 } })
      const jti = w.issue(agent)
      const results = []

      for (const route of ['/paid/a', '/paid/b', '/paid/c']) {
        results.push(await w.client.pay({ url: w.url(route), agent, mandate: jti }))
      }

      expect(results.map(result => result.kind)).toEqual(['paid', 'refused', 'refused'])
      expect(results.slice(1)).toMatchObject([{ reason: 'per_agent_day' }, { reason: 'per_agent_day' }])
      expect(w.signer.calls).toBe(1)
      expect(rows(w, 'signed').map(row => row.agent)).toEqual([agent])
      expect(rows(w, 'mandate_use').map(row => row.agent)).toEqual([agent])
      expect(refusals(w).map(row => row.agent)).toEqual([agent, agent])
    }
  })

  it('an agent that is not a profile slug, or a mandate id that is not an id, is refused at pay() entry: no network, no door, nothing signed', async () => {
    for (const agent of ['Agent 7', '../etc', '', 'a'.repeat(65), 'inft-7\nforged']) {
      const w = await world()
      const jti = w.issue('inft-7')

      expect(await w.client.pay({ url: w.url(), agent, mandate: jti })).toMatchObject({
        kind: 'refused',
        reason: 'agent'
      })
      expect(w.door.asked).toBe(0)
      expect(w.signer.calls).toBe(0)
      expect(w.stub.counts.verify).toBe(0)
      expect(refusals(w)).toMatchObject([{ rule: 'agent', agent: null, mandate: null }])
    }

    const w = await world()

    expect(await w.client.pay({ url: w.url(), agent: 'inft-7', mandate: '../../keys/pocket' })).toMatchObject({
      kind: 'refused',
      reason: 'mandate_invalid',
      detail: 'mandate id is not an id'
    })
    expect(refusals(w)).toMatchObject([{ rule: 'mandate_invalid', agent: 'inft-7', mandate: null }])
    expect(w.door.asked).toBe(0)
  })
})

describe('I2 — one clock, the ledger’s: a check and its row never read two clocks', () => {
  const D = Date.parse('2026-10-21T00:00:00.000Z')
  const DAY = 86_400_000

  const signedByDay = (w: World) => {
    const days = new Map<string, number>()

    for (const row of rows(w, 'signed')) {
      days.set(row.ts.slice(0, 10), (days.get(row.ts.slice(0, 10)) ?? 0) + (row.micros ?? 0))
    }

    return Object.fromEntries(days)
  }

  it('a client cannot be given its own clock: a skewed one (client on D+1, ledger on D) is not a dep and is ignored; D never passes its cap', async () => {
    // The ledger (and the world) on the wall clock, today; the would-be client clock a day ahead.
    const w = await world({ settings: { perDayMicros: 1_000_000, perAgentDayMicros: 1_000_000 } })

    const client = createX402Client({
      settings: () => w.settings,
      stopped: () => false,
      ledger: w.ledger,
      mandates: w.mandates,
      signer: w.signer,
      door: async () => true,
      audit: null,
      fetch,
      // @ts-expect-error — the client has no clock of its own (I2): the only clock is `ledger.now`.
      now: () => new Date(Date.now() + DAY)
    })

    const jti = w.issue('inft-7')

    const results = [
      await client.pay({ url: w.url('/paid/a'), agent: 'inft-7', mandate: jti }),
      await client.pay({ url: w.url('/paid/b'), agent: 'inft-7', mandate: jti })
    ]

    expect(results.map(result => result.kind)).toEqual(['paid', 'refused'])
    expect(results[1]).toMatchObject({ reason: 'per_day' })
    expect(Object.values(signedByDay(w))).toEqual([1_000_000])
    expect(rows(w, 'signed')[0].ts.slice(0, 10)).toBe(new Date().toISOString().slice(0, 10))
    expect(w.signer.calls).toBe(1)
  })

  /**
   * A clock the test drives. The sheet opens at D-1 23:59:59.000; while it is open another agent signs 0.60 at
   * D-1 23:59:59.500 (a concurrent signature: its own queue); the sheet answers and `at` is D-1 23:59:59.999; every
   * read after that is 1 ms later, so a second read would already be on D (where nothing is spent yet).
   */
  const midnight = async (perDayMicros: number) => {
    let t = D - 3_600_000
    let tick = 0
    let armed = false

    const clock = () => {
      const instant = new Date(t)

      t += tick

      return instant
    }

    const box: { w: World | null } = { w: null }

    const w = await world({
      now: clock,
      priceMicros: 600_000,
      settings: { perDayMicros, perAgentDayMicros: 1_000_000 },
      door: async () => {
        if (armed && box.w) {
          t = D - 500
          expect(
            box.w.ledger.append({ kind: 'signed', agent: 'agent-b', micros: 600_000 }, box.w.ledger.now())
          ).not.toBeNull()
          t = D - 1
          tick = 1
        }

        return true
      }
    })

    box.w = w

    // D-1 23:00: the mandate (3 h), valid on both sides of midnight.
    const a = w.issue('agent-a', undefined, 3 * 3600)

    t = D - 1000
    armed = true

    return { w, result: await w.client.pay({ url: w.url('/paid/a'), agent: 'agent-a', mandate: a }) }
  }

  it('the clock crosses UTC midnight between the post-door check and the write: the row lands on the day it was checked, and no day passes its cap', async () => {
    // Day cap 2.00: D-1 holds 0.60 (the concurrent row) + 0.60 (agent-a) = 1.20 — paid, sealed at D-1 23:59:59.999.
    const { w, result } = await midnight(2_000_000)

    // The stub facilitator checks validBefore against the REAL wall clock, so a signature made at a driven instant is
    // refused at /verify (`failed`). What is measured is the spend that counts: the `signed` rows and their days.
    expect(['paid', 'failed', 'pending']).toContain(result.kind)
    expect(w.signer.calls).toBe(1)
    expect(signedByDay(w)).toEqual({ '2026-10-20': 1_200_000 })
    expect(rows(w, 'signed').find(row => row.agent === 'agent-a')?.ts).toBe('2026-10-20T23:59:59.999Z')
    expect(rows(w, 'mandate_use').find(row => row.agent === 'agent-a')?.ts).toBe('2026-10-20T23:59:59.999Z')
  })

  it('I2 + I7: the post-door ceilings are judged at `at` (D-1, where a concurrent 0.60 landed during the sheet), not at a later read on D: refused per_day, 0 signatures', async () => {
    // Day cap 1.00: at `at` D-1 holds 0.60 and agent-a's 0.60 would make 1.20. Judged at a later read (D, empty) it
    // would pass. The concurrent row was written during the sheet; time never ran backwards (I7).
    const { w, result } = await midnight(1_000_000)

    expect(result).toMatchObject({ kind: 'refused', reason: 'per_day' })
    expect(w.signer.calls).toBe(0)
    expect(signedByDay(w)).toEqual({ '2026-10-20': 600_000 })
  })
})

describe('merge-n1 — the post-door mandate gate is judged at the one instant `at`, like the ceilings', () => {
  it('merge-n1: the clock crosses the open mandate’s exp between the `at` read and a later read: the payment is judged at `at` and signed once', async () => {
    let t = Date.now()
    let tick = 0
    let expMs = 0

    const clock = () => {
      const instant = new Date(t)

      t += tick

      return instant
    }

    const w = await world({
      now: clock,
      door: async () => {
        // The sheet answers 1 ms before exp; every read after `at` is a full second later, past exp.
        t = expMs - 1
        tick = 1000

        return true
      }
    })

    // The clock stands still until the door: the mandate's iat is this second, its exp 60 s later.
    expMs = (Math.floor(t / 1000) + 60) * 1000

    const jti = w.issue('inft-7', undefined, 60)

    const result = await w.client.pay({ url: w.url(), agent: 'inft-7', mandate: jti })

    expect(['paid', 'failed', 'pending']).toContain(result.kind)
    expect(w.signer.calls).toBe(1)
    expect(refusals(w)).toHaveLength(0)
    expect(rows(w, 'signed').map(row => row.ts)).toEqual([new Date(expMs - 1).toISOString()])
    expect(rows(w, 'mandate_use').map(row => row.ts)).toEqual([new Date(expMs - 1).toISOString()])
  })
})

describe('I1 — a ledger that throws never makes pay() reject: refused and audited before the signature, audited after it', () => {
  /** A client on the world's deps whose ledger throws where `throws` says; the audit sink is the world's. */
  const throwing = (w: World, throws: { append?: (kind: string) => boolean; read?: boolean; now?: boolean }) =>
    createX402Client({
      settings: () => w.settings,
      stopped: () => false,
      ledger: {
        ...w.ledger,
        now: () => {
          if (throws.now) {
            throw new Error('clock gone')
          }

          return w.ledger.now()
        },
        append: (entry, at) => {
          if (throws.append?.(entry.kind)) {
            throw new Error('EIO: ledger')
          }

          return w.ledger.append(entry, at)
        },
        read: () => {
          if (throws.read) {
            throw new Error('EIO: read')
          }

          return w.ledger.read()
        },
        limitsView: () => {
          if (throws.read) {
            throw new Error('EIO: read')
          }

          return w.ledger.limitsView()
        }
      },
      mandates: w.mandates,
      signer: w.signer,
      door: async () => true,
      audit: { record: entry => w.audit.push(entry) },
      fetch
    })

  it('append throws on the signed row: refused ledger, a refuse row, an audit entry, nothing signed', async () => {
    const w = await world()
    const client = throwing(w, { append: kind => kind === 'signed' })

    await expect(client.pay({ url: w.url(), agent: 'inft-7', mandate: w.issue('inft-7') })).resolves.toMatchObject({
      kind: 'refused',
      reason: 'ledger',
      detail: 'ledger write failed'
    })
    expect(w.audit).toEqual([{ kind: 'refuse', reason: 'ledger', agent: 'inft-7' }])
    expect(refusals(w)).toMatchObject([{ rule: 'ledger', agent: 'inft-7' }])
    expect(rows(w, 'signed')).toHaveLength(0)
    expect(w.signer.calls).toBe(0)
    expect(w.stub.counts.verify).toBe(0)
  })

  it('every write and every read throws: refused ledger (the totals cannot be read) and audited, though no row can be written', async () => {
    const w = await world()
    const client = throwing(w, { append: () => true, read: true })

    await expect(client.pay({ url: w.url(), agent: 'inft-7', mandate: w.issue('inft-7') })).resolves.toMatchObject({
      kind: 'refused',
      reason: 'ledger'
    })
    expect(w.audit).toEqual([{ kind: 'refuse', reason: 'ledger', agent: 'inft-7' }])
    expect(w.ledger.read().records.map(row => row.kind)).toEqual(['mandate_issue'])
    expect(w.signer.calls).toBe(0)
  })

  it('the mandate usage cannot be read after the limits were: refused ledger before the door, audited', async () => {
    const w = await world()
    let reads = 0

    const client = createX402Client({
      settings: () => w.settings,
      stopped: () => false,
      ledger: {
        ...w.ledger,
        read: () => {
          reads += 1
          throw new Error('EIO: read')
        }
      },
      mandates: w.mandates,
      signer: w.signer,
      door: async () => {
        w.door.asked += 1

        return true
      },
      audit: { record: entry => w.audit.push(entry) },
      fetch
    })

    await expect(client.pay({ url: w.url(), agent: 'inft-7', mandate: w.issue('inft-7') })).resolves.toMatchObject({
      kind: 'refused',
      reason: 'ledger',
      detail: 'ledger unreadable'
    })
    expect(reads).toBeGreaterThan(0)
    expect(w.door.asked).toBe(0)
    expect(w.audit).toEqual([{ kind: 'refuse', reason: 'ledger', agent: 'inft-7' }])
    expect(w.signer.calls).toBe(0)
  })

  it('anything else that throws before the signature (here the ledger clock): refused internal, audited, never a rejection', async () => {
    const w = await world()
    const client = throwing(w, { now: true })

    await expect(client.pay({ url: w.url(), agent: 'inft-7', mandate: w.issue('inft-7') })).resolves.toMatchObject({
      kind: 'refused',
      reason: 'internal'
    })
    expect(w.audit).toEqual([{ kind: 'refuse', reason: 'internal', agent: 'inft-7' }])
    expect(refusals(w)).toMatchObject([{ rule: 'internal' }])
    expect(w.signer.calls).toBe(0)
  })

  it('append throws on the settled row after the signature: the payment stays paid (money moved) and the missing row is an audited gap', async () => {
    const w = await world()
    const client = throwing(w, { append: kind => kind === 'settled' })

    await expect(client.pay({ url: w.url(), agent: 'inft-7', mandate: w.issue('inft-7') })).resolves.toMatchObject({
      kind: 'paid'
    })
    expect(w.audit).toEqual([
      { kind: 'gap', reason: 'ledger_write_failed', agent: 'inft-7' },
      { kind: 'use', reason: 'settled', agent: 'inft-7' }
    ])
    expect(rows(w, 'signed')).toHaveLength(1)
    expect(rows(w, 'settled')).toHaveLength(0)
    expect(w.signer.calls).toBe(1)
  })

  it('a throw inside send after the signed row (a signer answering a non-string): failed with the nonce, an audited gap, never a refusal', async () => {
    const w = await world()

    const client = createX402Client({
      settings: () => w.settings,
      stopped: () => false,
      ledger: w.ledger,
      mandates: w.mandates,
      signer: { ...w.signer, signAuthorization: async () => 10n as unknown as `0x${string}` },
      door: async () => true,
      audit: { record: entry => w.audit.push(entry) },
      fetch
    })

    const result = await client.pay({ url: w.url(), agent: 'inft-7', mandate: w.issue('inft-7') })

    expect(result).toMatchObject({ kind: 'failed', detail: 'internal error after the signed row' })
    expect(rows(w, 'failed')).toMatchObject([{ nonce: (result as { nonce: string }).nonce }])
    expect(rows(w, 'signed')).toHaveLength(1)
    expect(w.audit).toEqual([{ kind: 'gap', reason: 'internal', agent: 'inft-7' }])
    expect(w.stub.counts.verify).toBe(0)
  })

  it('a reconciler hook that throws leaves the payment pending (the row is what it reads), never a rejection', async () => {
    const w = await world({ stubMode: 'pending' })

    const client = createX402Client({
      settings: () => w.settings,
      stopped: () => false,
      ledger: w.ledger,
      mandates: w.mandates,
      signer: w.signer,
      door: async () => true,
      audit: null,
      fetch,
      onPending: () => {
        throw new Error('reconciler down')
      }
    })

    await expect(client.pay({ url: w.url(), agent: 'inft-7', mandate: w.issue('inft-7') })).resolves.toMatchObject({
      kind: 'pending'
    })
    expect(rows(w, 'pending')).toHaveLength(1)
  })

  it('an audit sink that throws does not change the decision: still refused, the refuse row still written', async () => {
    const w = await world()

    const client = createX402Client({
      settings: () => w.settings,
      stopped: () => false,
      ledger: w.ledger,
      mandates: w.mandates,
      signer: w.signer,
      door: async () => false,
      audit: {
        record: () => {
          throw new Error('sink down')
        }
      },
      fetch
    })

    await expect(client.pay({ url: w.url(), agent: 'inft-7', mandate: w.issue('inft-7') })).resolves.toMatchObject({
      kind: 'refused',
      reason: 'door_denied'
    })
    expect(refusals(w)).toMatchObject([{ rule: 'door_denied' }])
    expect(w.signer.calls).toBe(0)
  })
})

describe('n2 — the entry checks sit behind the backstop: pay() never rejects, whatever it is handed', () => {
  it('n2: pay(null), pay(undefined), a number, a string, an array, and requests whose fields throw on read are refused, audited, 0 signatures', async () => {
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new Error('hostile read')
        }
      }
    )

    const throwingAgent = Object.defineProperty({ url: 'https://example.invalid/x', mandate: null }, 'agent', {
      enumerable: true,
      get: () => {
        throw new Error('agent getter')
      }
    })

    const cases: [unknown, string][] = [
      [null, 'agent'],
      [undefined, 'agent'],
      [42, 'agent'],
      ['inft-7', 'agent'],
      [[], 'agent'],
      [hostile, 'internal'],
      [throwingAgent, 'internal']
    ]

    for (const [request, reason] of cases) {
      const w = await world()

      await expect(w.client.pay(request as never)).resolves.toMatchObject({ kind: 'refused', reason })
      expect(w.audit).toEqual([{ kind: 'refuse', reason, agent: '' }])
      expect(refusals(w)).toMatchObject([{ rule: reason, agent: null, mandate: null }])
      expect(w.door.asked).toBe(0)
      expect(w.signer.calls).toBe(0)
      expect(w.stub.counts.verify).toBe(0)
    }
  })

  it('n2: every field is read ONCE: a getter cannot answer the allowlisted origin to the check and another URL to the fetch', async () => {
    const w = await world()
    const jti = w.issue('inft-7')
    const reads = { url: 0, agent: 0 }
    const first = w.url('/paid/one')

    const request = {
      mandate: jti,
      get url() {
        reads.url += 1

        return reads.url === 1 ? first : 'https://elsewhere.invalid/paid/one'
      },
      get agent() {
        reads.agent += 1

        return 'inft-7'
      }
    }

    await expect(w.client.pay(request)).resolves.toMatchObject({ kind: 'paid' })
    expect(reads).toEqual({ url: 1, agent: 1 })
    expect(rows(w, 'settled')).toMatchObject([{ resource: first }])
    expect(w.signer.calls).toBe(1)
  })
})

describe('merge-stop — STOP is edge-triggered: a stop pulled while a payment is in flight refuses it, even if cleared before the sheet answers', () => {
  /** A door that runs `during` while the sheet is open, then answers yes. */
  const doorRunning = (during: () => void) => {
    const door = {
      asked: 0,
      fn: async () => {
        door.asked += 1
        during()
        await new Promise(resolve => setTimeout(resolve, 20))

        return true
      }
    }

    return door
  }

  it('merge-stop: STOP set and cleared by the owner while the sheet is open, then yes: refused stop (in flight), 0 signatures, audited', async () => {
    const box: { w: World | null } = { w: null }

    const door = doorRunning(() => {
      const w = box.w as World

      expect(setStop(w.paths, true, w.ledger)).toBe(true)
      expect(setStop(w.paths, false, w.ledger)).toBe(true)
    })

    const w = await world({ door: door.fn })

    box.w = w

    const result = await w.client.pay({ url: w.url(), agent: 'inft-7', mandate: w.issue('inft-7') })

    expect(result).toMatchObject({
      kind: 'refused',
      reason: 'stop',
      detail: 'hard stop pulled while this payment was in flight'
    })
    expect(door.asked).toBe(1)
    expect(w.signer.calls).toBe(0)
    expect(rows(w, 'signed')).toHaveLength(0)
    expect(w.audit).toEqual([{ kind: 'refuse', reason: 'stop', agent: 'inft-7' }])
  })

  it('merge-stop: the same through the settings (stop on, then off, by changeSettings): refused; the settings flips are stop rows too', async () => {
    const box: { w: World | null } = { w: null }

    const door = doorRunning(() => {
      const w = box.w as World

      for (const stop of [true, false]) {
        expect(
          changeSettings(w.paths, w.ledger, readSettings(w.paths), { ...readSettings(w.paths), stop })
        ).toMatchObject({ ok: true })
      }
    })

    const w = await world({ door: door.fn })

    box.w = w

    expect(await w.client.pay({ url: w.url(), agent: 'inft-7', mandate: w.issue('inft-7') })).toMatchObject({
      kind: 'refused',
      reason: 'stop'
    })
    expect(rows(w, 'stop').map(row => row.note)).toEqual(['on (setting)', 'off (setting)'])
    expect(w.signer.calls).toBe(0)
  })

  it('merge-stop: a request queued behind the open sheet began before the stop: refused too; one that begins after the clear pays (control)', async () => {
    const box: { w: World | null } = { w: null }
    let first = true

    const door = doorRunning(() => {
      const w = box.w as World

      if (first) {
        first = false
        setStop(w.paths, true, w.ledger)
        setStop(w.paths, false, w.ledger)
      }
    })

    const w = await world({ door: door.fn, settings: { perDayMicros: 10_000_000, perAgentDayMicros: 10_000_000 } })

    box.w = w

    const jti = w.issue('inft-7')

    const results = await Promise.all([
      w.client.pay({ url: w.url('/paid/a'), agent: 'inft-7', mandate: jti }),
      w.client.pay({ url: w.url('/paid/b'), agent: 'inft-7', mandate: jti })
    ])

    expect(results).toMatchObject([
      { kind: 'refused', reason: 'stop' },
      { kind: 'refused', reason: 'stop' }
    ])
    expect(w.signer.calls).toBe(0)

    // After the clear, a new request: nothing was pulled since it began.
    expect(await w.client.pay({ url: w.url('/paid/c'), agent: 'inft-7', mandate: jti })).toMatchObject({ kind: 'paid' })
    expect(w.signer.calls).toBe(1)
  })

  it('merge-stop: a ledger that cannot be read when the request begins (no mark) is refused ledger — an unknown mark is never “nothing pulled”', async () => {
    const w = await world()
    const jti = w.issue('inft-7')
    let reads = 0

    const client = createX402Client({
      settings: () => w.settings,
      stopped: () => false,
      ledger: {
        ...w.ledger,
        // Only the first read (the mark, taken as the request begins) fails; every later read works.
        read: () => {
          reads += 1

          if (reads === 1) {
            throw new Error('EIO: read')
          }

          return w.ledger.read()
        }
      },
      mandates: w.mandates,
      signer: w.signer,
      door: async () => true,
      audit: { record: entry => void w.audit.push(entry) },
      fetch
    })

    expect(await client.pay({ url: w.url(), agent: 'inft-7', mandate: jti })).toMatchObject({
      kind: 'refused',
      reason: 'ledger',
      detail: 'ledger unreadable'
    })
    expect(w.signer.calls).toBe(0)
    expect(w.audit).toEqual([{ kind: 'refuse', reason: 'ledger', agent: 'inft-7' }])
  })

  it('merge-stop: control — a stop set and cleared BEFORE the request began does not refuse it', async () => {
    const w = await world()

    setStop(w.paths, true, w.ledger)
    setStop(w.paths, false, w.ledger)

    expect(await w.client.pay({ url: w.url(), agent: 'inft-7', mandate: w.issue('inft-7') })).toMatchObject({
      kind: 'paid'
    })
  })
})
