import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { paymentsSheetCopy } from '../../src/iclone-shared/payments-sheet-copy'

import { fakeSealer } from './harness.test-helpers'
import { paySpawn } from './ipc'
import { spawnProfile } from './spawn-profile'
import { readSettings } from './store'
import { askSocket, makeWired, type Wired } from './wired.test-helpers'

import { PAYMENT_CHANNELS } from './index'

const worlds: Wired[] = []

async function wired(options?: Parameters<typeof makeWired>[0]): Promise<Wired> {
  const world = await makeWired(options)

  worlds.push(world)

  return world
}

afterEach(async () => {
  for (const world of worlds.splice(0)) {
    await world.close()
  }
})

const HEX64 = /[0-9a-f]{64}/i
const PAYEE_A = '0x1111111111111111111111111111111111111111'

/** Everything secret on disk for this world, unsealed with the fake sealer (to prove no view carries it). */
function secretsOf(world: Wired): string[] {
  const keys = world.registered.payments.paths.keys
  const sealer = fakeSealer()

  return fs
    .readdirSync(keys)
    .flatMap(name => {
      const sealed = fs.readFileSync(path.join(keys, name), 'utf8').trim()

      return [sealed, sealer.unseal(sealed)]
    })
    .concat(
      fs
        .readdirSync(world.registered.payments.paths.mandates)
        .map(name => fs.readFileSync(path.join(world.registered.payments.paths.mandates, name), 'utf8').trim())
    )
}

describe('m-r4-5: main picks the owner-sheet language by exact value', () => {
  it('m-r4-5: a locale the window sends that is an inherited object key (toString, __proto__ …) is English, never a crash', () => {
    for (const odd of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf', 'EN', 'pt', '', 7, null]) {
      expect(paymentsSheetCopy(odd)).toBe(paymentsSheetCopy('en'))
    }

    expect(paymentsSheetCopy('pt-PT')).not.toBe(paymentsSheetCopy('en'))
  })
})

describe('wire-init: main assembles payments (registerPayments)', () => {
  it('wire-init: the guarded channels, a stranger gets null, and the socket gives spawns a token', async () => {
    const world = await wired()

    expect(world.channels().sort()).toEqual([...PAYMENT_CHANNELS].sort())

    for (const channel of PAYMENT_CHANNELS) {
      expect(await world.invoke(channel, {}, false)).toBeNull()
    }

    const status = (await world.invoke('iclone:payments:status')) as { ready: boolean; pocket: string }

    expect(status).toMatchObject({ ready: true, reason: null, stopped: false, ledgerOk: true, todayMicros: 0 })
    expect(status.pocket).toMatch(/^0x[0-9a-f]{40}$/)
    // A profile the seed never verified (no folder in the Hermes home) gets no pay env (fix m-r4-1); once it has one,
    // a spawn of it does.
    expect(paySpawn('agent-a').env).toEqual({})
    await world.token('agent-a')
    expect(paySpawn('agent-a').env.ICLONE_PAY_SOCKET).toBe(path.join(world.socketDir, 'pay.sock'))
  })

  it('wire-init: no OS sealing (Keychain setting off) ⇒ disabled and says why; no key file; the socket answers 3', async () => {
    const world = await wired({ sealer: 'none' })
    const status = (await world.invoke('iclone:payments:status')) as { ready: boolean; reason: string }
    const { token } = await world.token('agent-a')

    expect(status.ready).toBe(false)
    // A code the window words (J4-5); main's own sentence stays in its log.
    expect(status.reason).toBe('sealing_off')
    expect(world.logs.some(line => line.includes('payments not ready: OS sealing unavailable'))).toBe(true)
    expect(fs.existsSync(world.registered.payments.paths.keys)).toBe(false)
    expect((await askSocket(path.join(world.socketDir, 'pay.sock'), token, ['pay', world.url()])).code).toBe(3)
  })

  it('V3-FX M1: the Keychain setting turned on, then off, while the app runs: payments follow at once, both ways', async () => {
    const world = await wired({ sealer: 'none' })
    const status = async () => (await world.invoke('iclone:payments:status')) as { ready: boolean; reason: string }

    expect(await status()).toMatchObject({ ready: false, reason: 'sealing_off' })
    world.registered.reseal(fakeSealer())
    expect(await status()).toMatchObject({ ready: true, reason: null })
    expect(fs.existsSync(world.registered.payments.paths.keys)).toBe(true)

    // r3 (critic k3): the pay socket reads the CURRENT instance — after the reseal a pay is no longer answered
    // "payments off" (3).
    const live = await world.token('agent-a')
    const paid = await askSocket(path.join(world.socketDir, 'pay.sock'), live.token, ['pay', world.url()])

    expect(paid.code).not.toBe(3)
    world.registered.reseal(null)
    expect(await status()).toMatchObject({ ready: false, reason: 'sealing_off' })

    const { token } = await world.token('agent-a')

    expect((await askSocket(path.join(world.socketDir, 'pay.sock'), token, ['pay', world.url()])).code).toBe(3)
  })

  it('wire-init: a pay through the socket asks the $ sheet with the mandate in plain words, and only `once` pays', async () => {
    const world = await wired()
    const jti = world.issue('agent-a', '2.00')
    const { token } = await world.token('agent-a')
    const sock = path.join(world.socketDir, 'pay.sock')

    const paid = await askSocket(sock, token, ['pay', world.url(), '--mandate', jti])

    expect(paid.code).toBe(0)
    expect(JSON.parse(paid.stdout)).toMatchObject({ kind: 'paid', micros: 100_000 })
    expect(world.doorCalls).toHaveLength(1)

    const [call] = world.doorCalls

    expect(call.slug).toBe('agent-a')
    expect(call.permission).toMatchObject({ cls: '$', tool: 'x402-pay', scopes: ['once'], mode: 'manual' })
    expect(call.permission.target).toContain('pay 0.10 USDC → 0x1111111111111111111111111111111111111111')
    expect(call.permission.target).toContain('mandate payees (1):\n  0x1111111111111111111111111111111111111111')
    expect(call.permission.target).toContain('mandate budget 2.00 USDC')
    expect(call.permission.target).toContain('mandate range 0.000001 – 50.00 USDC')
    expect(call.permission.target).toMatch(/mandate expires \d{4}-\d\d-\d\dT/)

    for (const answer of ['deny', 'busy', 'timeout', 'withdrawn', 'session', 'standing'] as const) {
      world.door.answer = answer
      const refused = await askSocket(sock, token, ['pay', world.url(), '--mandate', jti])

      expect({ answer, out: JSON.parse(refused.stdout) }).toMatchObject({
        answer,
        out: { kind: 'refused', reason: 'door_denied' }
      })
    }

    world.door.answer = () => Promise.reject(new Error('sheet crashed'))
    expect(JSON.parse((await askSocket(sock, token, ['pay', world.url(), '--mandate', jti])).stdout)).toMatchObject({
      reason: 'door_denied'
    })
    expect(world.registered.payments.status(true).todayMicros).toBe(100_000)
  })

  it('sheet-full: the $ sheet says what is left of the mandate budget, before this payment', async () => {
    const world = await wired()
    const jti = world.issue('agent-a', '1.00')
    const { token } = await world.token('agent-a')
    const sock = path.join(world.socketDir, 'pay.sock')

    for (let i = 0; i < 3; i += 1) {
      expect((await askSocket(sock, token, ['pay', world.url(`/paid/${i}`), '--mandate', jti])).code).toBe(0)
    }

    expect(world.doorCalls.map(call => call.permission.target.split('\n')[2])).toEqual([
      'mandate budget left 1.00 USDC',
      'mandate budget left 0.90 USDC',
      'mandate budget left 0.80 USDC'
    ])
  })

  it('J6: JM3 (critic M3) the sheet shows the CANONICAL URL — the one fetched and recorded — never the agent’s raw text', async () => {
    const fetched: string[] = []

    const world = await wired({
      hijack: () => request => {
        fetched.push(request.url ?? '')

        return false
      }
    })

    const jti = world.issue('agent-a', '10.00')
    const { token } = await world.token('agent-a')
    const sock = path.join(world.socketDir, 'pay.sock')
    const raw = `${world.url('/paid/x')}\npay 0.01 USDC → 0x1111111111111111111111111111111111111111`
    const canonical = new URL(raw).href
    const answer = JSON.parse((await askSocket(sock, token, ['pay', raw, '--mandate', jti])).stdout)

    expect(answer).toMatchObject({ kind: 'paid' })
    expect(world.doorCalls).toHaveLength(1)

    const lines = world.doorCalls[0].permission.target.split('\n')

    expect(lines).toHaveLength(11)
    expect(lines.filter(line => line.startsWith('pay '))).toHaveLength(1)
    expect(lines).toContain(`resource ${canonical}`)
    // The same string reached the resource server (path + query) and the ledger.
    expect(fetched.length).toBeGreaterThan(0)
    expect(fetched.every(url => `${new URL(canonical).origin}${url}` === canonical)).toBe(true)
    expect(fs.readFileSync(world.registered.payments.paths.ledger, 'utf8')).toContain(JSON.stringify(canonical))
    expect(fs.readFileSync(world.registered.payments.paths.ledger, 'utf8')).not.toContain('\\npay 0.01')
  })

  it('Jm1: (critic m1) 2001 payees or an odd list are refused with the entries named — no sheet, nothing stored, audited', async () => {
    const world = await wired()
    const shown = (await world.invoke('iclone:payments:limits')) as Record<string, unknown>
    const many = Array.from({ length: 2000 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`)
    const before = readSettings(world.registered.payments.paths)

    expect(
      await world.invoke('iclone:payments:set-limits', { shown, next: { ...shown, payees: [PAYEE_A, ...many] } })
    ).toEqual({
      ok: false,
      reason: 'allowlist',
      problems: [{ list: 'payees', kind: 'too_many', count: 2001, entries: [], more: 0 }]
    })

    const odd = await world.invoke('iclone:payments:set-limits', {
      shown,
      next: { ...shown, payees: [PAYEE_A, PAYEE_A, 'vitalik.eth', ` ${PAYEE_A}`] }
    })

    expect(odd).toEqual({
      ok: false,
      reason: 'allowlist',
      problems: [
        {
          list: 'payees',
          kind: 'entries',
          count: 4,
          entries: [`"${PAYEE_A}"`, '"vitalik.eth"', `" ${PAYEE_A}"`],
          more: 0
        }
      ]
    })
    // Main's own words for the same refusal are in its log only.
    expect(world.logs).toContain(
      `[iclone-x402] settings change refused: payees: "${PAYEE_A}", "vitalik.eth", " ${PAYEE_A}"`
    )
    expect(world.doorCalls).toHaveLength(0)
    expect(readSettings(world.registered.payments.paths)).toEqual(before)
    expect(world.audit.filter(entry => entry.reason === 'setting allowlist')).toHaveLength(2)
  })

  it('Jm1: exactly 50 payees pass; the raise sheet lists each added payee on its own line, bounded', async () => {
    const world = await wired()
    const shown = (await world.invoke('iclone:payments:limits')) as Record<string, unknown>
    const fifty = Array.from({ length: 50 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`)
    const result = await world.invoke('iclone:payments:set-limits', { shown, next: { ...shown, payees: fifty } })

    expect(result).toMatchObject({ ok: true, settings: { payees: fifty } })

    const lines = world.doorCalls[0].permission.target.split('\n')

    const before = shown.payees as string[]

    expect(lines[0]).toBe(`payees: ${before.length} → 50 entries`)
    expect(lines.slice(1)).toEqual([
      ...fifty.filter(entry => !before.includes(entry)).map(entry => `  + ${entry}`),
      ...before.filter(entry => !fifty.includes(entry)).map(entry => `  − ${entry}`)
    ])
    expect(lines.length).toBeLessThanOrEqual(1 + 2 * 50)
  })

  it('wire-init: settings need the click lock; a lowering applies with no sheet, a raise asks and shows old → new', async () => {
    const world = await wired()
    const shown = (await world.invoke('iclone:payments:limits')) as Record<string, unknown>

    world.gesture.ok = false
    expect(await world.invoke('iclone:payments:set-limits', { shown, next: { ...shown, perTxMicros: 1 } })).toEqual({
      ok: false,
      reason: 'gesture'
    })
    expect(readSettings(world.registered.payments.paths).perTxMicros).toBe(1_000_000)
    expect(world.audit).toContainEqual({ kind: 'refuse', reason: 'setting gesture', agent: '' })

    world.gesture.ok = true

    const lowered = await world.invoke('iclone:payments:set-limits', {
      shown,
      next: { ...shown, perTxMicros: 500_000 }
    })

    expect(lowered).toMatchObject({ ok: true, settings: { perTxMicros: 500_000 } })
    expect(world.doorCalls).toHaveLength(0)

    const now = (await world.invoke('iclone:payments:limits')) as Record<string, unknown>

    world.door.answer = 'deny'
    expect(
      await world.invoke('iclone:payments:set-limits', { shown: now, next: { ...now, perTxMicros: 2_000_000 } })
    ).toEqual({
      ok: false,
      reason: 'door_denied'
    })
    expect(world.doorCalls[0].permission.target).toBe('perTxMicros: 0.50 USDC → 2.00 USDC')
    expect(world.doorCalls[0].slug).toBe('owner')

    world.door.answer = 'once'
    expect(
      await world.invoke('iclone:payments:set-limits', { shown: now, next: { ...now, perTxMicros: 2_000_000 } })
    ).toMatchObject({ ok: true, settings: { perTxMicros: 2_000_000 } })

    // The pane's form was filled against `now`; what is stored has moved since: nothing applied, no sheet.
    const calls = world.doorCalls.length

    expect(await world.invoke('iclone:payments:set-limits', { shown: now, next: { ...now, perDayMicros: 1 } })).toEqual(
      {
        ok: false,
        reason: 'settings_moved'
      }
    )
    expect(world.doorCalls).toHaveLength(calls)
    expect(readSettings(world.registered.payments.paths).perDayMicros).toBe(5_000_000)
  })

  it('wire-init: STOP on is immediate with no gesture; clearing it needs the gesture and the sheet', async () => {
    const world = await wired()
    const status = () => world.registered.payments.status(true)

    world.gesture.ok = false
    expect(await world.invoke('iclone:payments:stop', { on: true })).toEqual({ ok: true })
    expect(status().stopped).toBe(true)
    expect(await world.invoke('iclone:payments:stop', { on: false })).toEqual({ ok: false, reason: 'gesture' })

    world.gesture.ok = true
    world.door.answer = 'deny'
    expect(await world.invoke('iclone:payments:stop', { on: false })).toEqual({ ok: false, reason: 'door_denied' })
    expect(status().stopped).toBe(true)

    world.door.answer = 'once'
    expect(await world.invoke('iclone:payments:stop', { on: false })).toEqual({ ok: true })
    expect(status().stopped).toBe(false)
    expect(world.doorCalls.at(-1)?.permission.target).toBe('stop: true → false')
    expect(world.registered.payments.ledger.read().records.filter(row => row.kind === 'stop')).toHaveLength(2)
  })

  it('wire-init: revoke needs the gesture; no view carries a key, a sealed blob, a signature or a raw mandate', async () => {
    const world = await wired()
    const jti = world.issue('agent-a')
    const { token } = await world.token('agent-a')

    await askSocket(path.join(world.socketDir, 'pay.sock'), token, ['pay', world.url(), '--mandate', jti])

    world.gesture.ok = false
    expect(await world.invoke('iclone:payments:revoke', { jti })).toEqual({ ok: false, reason: 'gesture' })
    world.gesture.ok = true
    expect(await world.invoke('iclone:payments:revoke', { jti: 'nope' })).toEqual({ ok: false, reason: 'unknown' })
    expect(await world.invoke('iclone:payments:revoke', { jti })).toEqual({ ok: true })

    const views = JSON.stringify([
      await world.invoke('iclone:payments:status'),
      await world.invoke('iclone:payments:limits'),
      await world.invoke('iclone:payments:mandates')
    ])

    expect(JSON.parse(views)[2]).toEqual([
      expect.objectContaining({ jti, agent: 'agent-a', revoked: true, budget: '100.00', payees: [expect.any(String)] })
    ])

    for (const secret of secretsOf(world)) {
      expect(views.includes(secret)).toBe(false)
    }

    // The only long hex in a view is the mandate id (32) — never a key, a signature or a nonce (64+).
    expect(views).not.toMatch(HEX64)
    expect(views).not.toMatch(/~|eyJ|BEGIN|sealed:/)
  })
})

describe('mandate-issue: the owner signs an open mandate from Settings › Economy › Payments', () => {
  const PAYEE = '0x1111111111111111111111111111111111111111'
  const OTHER = '0x2222222222222222222222222222222222222222'
  const T0 = Date.parse('2026-10-21T10:00:00.000Z')

  const mandateFiles = (world: Wired): string[] =>
    fs.existsSync(world.registered.payments.paths.mandates)
      ? fs.readdirSync(world.registered.payments.paths.mandates)
      : []

  const termsAt = (now: number, over: Record<string, unknown> = {}) => ({
    agent: 'agent-a',
    budget: '0.30',
    min: '0.01',
    max: '0.20',
    payees: [PAYEE],
    notBefore: new Date(now).toISOString(),
    notAfter: new Date(now + 3_600_000).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString(),
    ...over
  })

  it('mandate-issue: the click, then the $ sheet with every term in plain words, then main signs it 0600; the agent pays under it', async () => {
    // The pay at the end goes to the stub facilitator, which judges the authorization's window on the wall clock.
    const at = Math.floor(Date.now() / 1000) * 1000
    const world = await wired({ now: () => new Date(Math.max(at, Date.now())), settings: { payees: [PAYEE, OTHER] } })

    world.gesture.ok = false
    expect(await world.invoke('iclone:payments:request-mandate', { terms: termsAt(at) })).toEqual({
      ok: false,
      reason: 'gesture'
    })
    expect(world.doorCalls).toHaveLength(0)

    world.gesture.ok = true
    const terms = termsAt(at, { payees: [PAYEE, OTHER] })
    const issued = (await world.invoke('iclone:payments:request-mandate', { terms })) as { ok: boolean; jti: string }

    expect(issued).toEqual({ ok: true, jti: expect.stringMatching(/^[0-9a-f]{32}$/) })
    expect(Object.keys(issued).sort()).toEqual(['jti', 'ok'])

    const [sheet] = world.doorCalls

    expect(sheet.slug).toBe('owner')
    expect(sheet.permission).toMatchObject({ cls: '$', tool: 'payments.mandate', scopes: ['once'] })
    expect(sheet.permission.target.split('\n')).toEqual([
      'sign an open payment mandate for agent agent-a',
      'budget 0.30 USDC in total',
      'each payment between 0.01 and 0.20 USDC',
      'only to these 2 payees:',
      `  ${PAYEE}`,
      `  ${OTHER}`,
      `payments allowed from ${terms.notBefore} to ${terms.notAfter}`,
      `the mandate expires ${terms.expiresAt}`,
      'your caps still apply: 1.00 USDC per payment, 5.00 USDC per day, 2.00 USDC per agent per day',
      'network Base Sepolia (eip155:84532)',
      'revoking it later is immediate (Settings › Economy › Payments)'
    ])

    const file = path.join(world.registered.payments.paths.mandates, `${issued.jti}.sdjwt`)

    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.statSync(world.registered.payments.paths.mandates).mode & 0o777).toBe(0o700)

    const listed = (await world.invoke('iclone:payments:mandates')) as Record<string, unknown>[]

    expect(listed).toEqual([
      expect.objectContaining({
        jti: issued.jti,
        agent: 'agent-a',
        budget: '0.30',
        range: { min: '0.01', max: '0.20' },
        payees: [PAYEE, OTHER],
        expiresAt: terms.expiresAt,
        revoked: false
      })
    ])
    expect(world.audit).toContainEqual({ kind: 'use', reason: `mandate_issue ${issued.jti}`, agent: 'agent-a' })

    const { token } = await world.token('agent-a')
    const sock = path.join(world.socketDir, 'pay.sock')
    const paid = await askSocket(sock, token, ['pay', world.url(), '--mandate', issued.jti])

    expect(JSON.parse(paid.stdout)).toMatchObject({ kind: 'paid', micros: 100_000 })
  })

  it('mandate-issue: instants are signed in whole seconds, and the sheet says exactly those', async () => {
    const world = await wired({ now: () => new Date(T0) })
    const terms = termsAt(T0 + 250, { expiresAt: new Date(T0 + 3_600_999).toISOString() })
    const issued = (await world.invoke('iclone:payments:request-mandate', { terms })) as { ok: boolean }

    expect(issued.ok).toBe(true)

    const lines = world.doorCalls[0].permission.target.split('\n')

    expect(lines).toContain('payments allowed from 2026-10-21T10:00:00.000Z to 2026-10-21T11:00:00.000Z')
    expect(lines).toContain('the mandate expires 2026-10-21T11:00:00.000Z')
    expect(((await world.invoke('iclone:payments:mandates')) as { expiresAt: string }[])[0].expiresAt).toBe(
      '2026-10-21T11:00:00.000Z'
    )
  })

  it('mandate-issue: bad terms are refused before any sheet and audited, one problem at a time', async () => {
    const world = await wired({ now: () => new Date(T0) })

    const cases: [Record<string, unknown>, string][] = [
      [{ agent: 'Agent A' }, 'agent'],
      [{ budget: '0' }, 'amount'],
      [{ min: '0.30', max: '0.20' }, 'amount'],
      [{ max: '0.40' }, 'amount'],
      [{ budget: '1.0000001' }, 'amount'],
      [{ payees: [] }, 'payees'],
      [{ payees: [OTHER] }, 'payees'],
      [{ payees: [PAYEE, PAYEE] }, 'payees'],
      [{ payees: PAYEE }, 'payees'],
      [{ notAfter: new Date(T0 + 7_200_000).toISOString() }, 'dates'],
      [{ notBefore: new Date(T0 + 3_600_000).toISOString() }, 'dates'],
      [{ expiresAt: new Date(T0).toISOString(), notAfter: new Date(T0).toISOString() }, 'dates'],
      [
        {
          expiresAt: new Date(T0 + 91 * 86_400_000).toISOString(),
          notAfter: new Date(T0 + 86_400_000).toISOString()
        },
        'dates'
      ],
      [{ notBefore: 'soon' }, 'dates']
    ]

    for (const [over, problem] of cases) {
      expect(
        await world.invoke('iclone:payments:request-mandate', { terms: termsAt(T0, over) }),
        JSON.stringify(over)
      ).toEqual({ ok: false, reason: 'invalid' })
      expect(world.audit.at(-1)).toEqual({ kind: 'refuse', reason: `mandate_issue invalid ${problem}`, agent: '' })
    }

    expect(world.doorCalls).toHaveLength(0)
    expect(mandateFiles(world)).toEqual([])
  })

  it('mandate-issue: a sheet that is not `once` signs nothing; a payee removed while the sheet was open signs nothing', async () => {
    const world = await wired({ now: () => new Date(T0) })

    for (const answer of ['deny', 'timeout', 'busy', 'session'] as const) {
      world.door.answer = answer
      expect(await world.invoke('iclone:payments:request-mandate', { terms: termsAt(T0) })).toEqual({
        ok: false,
        reason: 'door_denied'
      })
    }

    world.door.answer = async () => {
      world.settle({ payees: [] })

      return 'once'
    }

    expect(await world.invoke('iclone:payments:request-mandate', { terms: termsAt(T0) })).toEqual({
      ok: false,
      reason: 'settings_moved'
    })
    expect(world.audit.at(-1)).toEqual({
      kind: 'refuse',
      reason: 'mandate_issue settings_moved payees',
      agent: 'agent-a'
    })
    expect(mandateFiles(world)).toEqual([])
  })

  it('mandate-issue: no OS sealing ⇒ not ready, no sheet, no key', async () => {
    const world = await wired({ sealer: 'none', now: () => new Date(T0) })

    expect(await world.invoke('iclone:payments:request-mandate', { terms: termsAt(T0) })).toEqual({
      ok: false,
      reason: 'not_ready'
    })
    expect(world.doorCalls).toHaveLength(0)
  })

  it('mandate-issue: revoking is immediate — a payment whose sheet is open when the owner revokes is refused', async () => {
    const world = await wired({ now: () => new Date() })
    const now = Date.now()

    const issued = (await world.invoke('iclone:payments:request-mandate', { terms: termsAt(now) })) as {
      jti: string
    }

    const { token } = await world.token('agent-a')
    const sock = path.join(world.socketDir, 'pay.sock')

    world.door.answer = async () => {
      expect(await world.invoke('iclone:payments:revoke', { jti: issued.jti })).toEqual({ ok: true })

      return 'once'
    }

    const refused = JSON.parse((await askSocket(sock, token, ['pay', world.url(), '--mandate', issued.jti])).stdout)

    expect(refused).toMatchObject({ kind: 'refused', reason: 'mandate_invalid', detail: 'open mandate revoked' })
    expect(world.stub.counts.settle).toBe(0)
    expect(world.registered.payments.status(true).todayMicros).toBe(0)
  })

  it('mandate-issue: past its window or its expiry the mandate pays nothing', async () => {
    const clock = { t: Date.now() }
    const world = await wired({ now: () => new Date(clock.t) })

    const window = (await world.invoke('iclone:payments:request-mandate', {
      terms: termsAt(clock.t, {
        notAfter: new Date(clock.t + 60_000).toISOString(),
        expiresAt: new Date(clock.t + 3_600_000).toISOString()
      })
    })) as { jti: string }

    const expiring = (await world.invoke('iclone:payments:request-mandate', {
      terms: termsAt(clock.t, {
        notAfter: new Date(clock.t + 120_000).toISOString(),
        expiresAt: new Date(clock.t + 120_000).toISOString()
      })
    })) as { jti: string }

    const { token } = await world.token('agent-a')
    const sock = path.join(world.socketDir, 'pay.sock')

    const pay = async (jti: string) =>
      JSON.parse((await askSocket(sock, token, ['pay', world.url(), '--mandate', jti])).stdout)

    clock.t += 90_000
    expect(await pay(window.jti)).toMatchObject({
      reason: 'mandate_invalid',
      detail: 'outside mandate execution window'
    })
    clock.t += 60_000
    expect(await pay(expiring.jti)).toMatchObject({ reason: 'mandate_invalid', detail: 'open mandate expired' })
    expect(world.stub.counts.settle).toBe(0)
  })
})

describe('J4-4: an owner sheet speaks the window’s language; its answer is bound to the canonical request', () => {
  const PAYEE = '0x1111111111111111111111111111111111111111'
  const T0 = Date.parse('2026-10-21T10:00:00.000Z')

  const terms = (over: Record<string, unknown> = {}) => ({
    agent: 'agent-a',
    budget: '0.30',
    min: '0.01',
    max: '0.20',
    payees: [PAYEE],
    notBefore: new Date(T0).toISOString(),
    notAfter: new Date(T0 + 3_600_000).toISOString(),
    expiresAt: new Date(T0 + 3_600_000).toISOString(),
    ...over
  })

  /** The request id each owner-sheet answer was audited with, in order. */
  const sheetIds = (world: Wired, tool: string): string[] =>
    world.audit
      .map(
        entry => new RegExp(`^sheet ${tool.replace('.', '\\.')} \\w+ request=([0-9a-f]{32})$`).exec(entry.reason)?.[1]
      )
      .filter((id): id is string => Boolean(id))

  it('J4-4: one mandate request in two locales ⇒ two texts, ONE request id; a value changed ⇒ another id', async () => {
    const world = await wired({ now: () => new Date(T0), settings: { payees: [PAYEE] } })

    world.door.answer = 'deny'

    for (const locale of ['pt-PT', 'ja']) {
      await world.invoke('iclone:payments:request-mandate', { terms: terms(), locale })
    }

    await world.invoke('iclone:payments:request-mandate', { terms: terms({ budget: '0.31' }), locale: 'pt-PT' })

    const [pt, ja, changed] = world.doorCalls.map(call => call.permission.target)
    const ids = sheetIds(world, 'payments.mandate')

    expect(pt).not.toBe(ja)
    expect(pt.split('\n')[0]).toBe('assinar um mandato de pagamento aberto para o agente agent-a')
    expect(ja.split('\n')[0]).toBe('エージェント agent-a のオープン支払いマンデートに署名')
    expect(world.doorCalls[0].reason).toContain('Definições › Economia › Pagamentos')

    // Every value is verbatim in both languages, and the line count is the same.
    for (const text of [pt, ja]) {
      expect(text.split('\n')).toHaveLength(10)
      expect(text.split('\n')).toContain(`  ${PAYEE}`)
      expect(text).toContain('0.30')
      expect(text).toContain(terms().expiresAt)
      expect(text).toContain('eip155:84532')
    }

    expect(ids).toHaveLength(3)
    expect(ids[0]).toBe(ids[1])
    expect(ids[2]).not.toBe(ids[0])
    expect(world.audit).toContainEqual({
      kind: 'refuse',
      reason: `sheet payments.mandate deny request=${ids[0]}`,
      agent: ''
    })

    // The `once` in a third language is audited against the very same id, and the mandate is signed.
    world.door.answer = 'once'

    const issued = (await world.invoke('iclone:payments:request-mandate', { terms: terms(), locale: 'ar' })) as {
      ok: boolean
      jti: string
    }

    expect(issued.ok).toBe(true)
    expect(world.audit).toContainEqual({
      kind: 'use',
      reason: `sheet payments.mandate once request=${ids[0]}`,
      agent: ''
    })
  })

  it('J4-4: an unknown or missing language is English, byte for byte', async () => {
    const world = await wired({ now: () => new Date(T0), settings: { payees: [PAYEE] } })

    world.door.answer = 'deny'

    for (const locale of [undefined, 'xx', 'en', 42]) {
      await world.invoke('iclone:payments:request-mandate', { terms: terms(), locale })
    }

    const texts = world.doorCalls.map(call => call.permission.target)

    expect(new Set(texts).size).toBe(1)
    expect(texts[0].split('\n')[0]).toBe('sign an open payment mandate for agent agent-a')
    expect(new Set(sheetIds(world, 'payments.mandate')).size).toBe(1)
  })

  it('J4-4: the `once` is for the request it was asked on — the network moved under the sheet ⇒ settings_moved, nothing signed', async () => {
    const world = await wired({ now: () => new Date(T0), settings: { payees: [PAYEE] } })

    world.door.answer = async () => {
      world.settle({ network: 'eip155:8453', mainnetEnabled: true })

      return 'once'
    }

    expect(await world.invoke('iclone:payments:request-mandate', { terms: terms(), locale: 'zh' })).toEqual({
      ok: false,
      reason: 'settings_moved'
    })
    expect(
      fs.existsSync(world.registered.payments.paths.mandates)
        ? fs.readdirSync(world.registered.payments.paths.mandates)
        : []
    ).toEqual([])
    expect(world.audit.some(entry => /^mandate_issue settings_moved request=[0-9a-f]{32}$/.test(entry.reason))).toBe(
      true
    )
  })

  it('J4-4: a settings raise and clearing the stop: localized words, verbatim values, one id per request', async () => {
    const world = await wired({ now: () => new Date(T0) })

    world.door.answer = 'deny'

    const shown = await world.invoke('iclone:payments:limits')
    const added = '0x3333333333333333333333333333333333333333'
    const was = shown as { payees: string[] }
    const next = { ...was, perTxMicros: 2_000_000, payees: [...was.payees, added] }

    for (const locale of ['zh-hant', 'pt-PT']) {
      expect(await world.invoke('iclone:payments:set-limits', { shown, next, locale })).toMatchObject({ ok: false })
    }

    const [zhHant, pt] = world.doorCalls.map(call => call.permission.target)

    expect(pt.split('\n')).toEqual([
      'Limite por pagamento: 1.00 USDC → 2.00 USDC',
      'Destinatários: 1 → 2 entradas',
      `  + ${added}`
    ])
    expect(zhHant.split('\n')).toEqual(['每筆付款上限：1.00 USDC → 2.00 USDC', '收款方：1 → 2 項', `  + ${added}`])

    const settingsIds = sheetIds(world, 'payments.settings')

    expect(settingsIds).toHaveLength(2)
    expect(settingsIds[0]).toBe(settingsIds[1])

    // m-r4-5: the id is the request's own: another value, or another list, is another id (never a constant).
    for (const other of [
      { ...was, perTxMicros: 3_000_000, payees: [...was.payees, added] },
      { ...was, perTxMicros: 2_000_000, payees: [...was.payees, '0x4444444444444444444444444444444444444444'] }
    ]) {
      expect(await world.invoke('iclone:payments:set-limits', { shown, next: other, locale: 'en' })).toMatchObject({
        ok: false
      })
    }

    const moreIds = sheetIds(world, 'payments.settings')

    expect(moreIds).toHaveLength(4)
    expect(new Set(moreIds.slice(1)).size).toBe(3)
    world.doorCalls.splice(2)

    expect(await world.invoke('iclone:payments:stop', { on: true })).toEqual({ ok: true })

    for (const locale of ['ja', 'en']) {
      expect(await world.invoke('iclone:payments:stop', { on: false, locale })).toEqual({
        ok: false,
        reason: 'door_denied'
      })
    }

    const [ja, en] = world.doorCalls.slice(2).map(call => call.permission.target)
    const stopIds = sheetIds(world, 'payments.stop')

    expect(ja).toBe('緊急停止: true → false')
    expect(en).toBe('stop: true → false')
    expect(stopIds).toHaveLength(2)
    expect(stopIds[0]).toBe(stopIds[1])
    expect(stopIds[0]).not.toBe(settingsIds[0])
  })
})

describe('x402-pay: p2p send and status through the socket', () => {
  const PAYEE = '0x1111111111111111111111111111111111111111'
  const OTHER = '0x2222222222222222222222222222222222222222'

  it('x402-pay: send to an allowlisted payee under a mandate asks the $ sheet, is verified and settled by the facilitator once', async () => {
    const world = await wired()
    const jti = world.issue('agent-a', '1.00')
    const { token } = await world.token('agent-a')
    const sock = path.join(world.socketDir, 'pay.sock')

    const sent = await askSocket(sock, token, ['send', PAYEE, '0.25', '--mandate', jti])

    expect(sent.code).toBe(0)
    expect(JSON.parse(sent.stdout)).toMatchObject({ kind: 'paid', micros: 250_000, transaction: expect.any(String) })
    expect(world.stub.counts).toMatchObject({ verify: 1, settle: 1 })
    expect(world.doorCalls).toHaveLength(1)
    expect(world.doorCalls[0].permission.target.split('\n').slice(0, 3)).toEqual([
      `pay 0.25 USDC → ${PAYEE}`,
      'mandate budget 1.00 USDC',
      'mandate budget left 1.00 USDC'
    ])
    expect(world.doorCalls[0].permission.target).toContain(`resource p2p:${PAYEE}`)

    const rows = world.registered.payments.ledger.read().records

    expect(rows.filter(row => row.kind === 'signed')).toEqual([
      expect.objectContaining({ agent: 'agent-a', resource: `p2p:${PAYEE}`, micros: 250_000, mandate: jti })
    ])
    expect(rows.filter(row => row.kind === 'settled')).toHaveLength(1)
    expect(world.audit).toContainEqual({ kind: 'use', reason: 'settled', agent: 'agent-a' })
  })

  it('x402-pay: send is refused and audited — payee off the allowlist, over the cap, outside the mandate, no mandate, STOP', async () => {
    const world = await wired({ settings: { payees: [PAYEE, OTHER] } })

    const narrow = world.registered.payments.mandatesStore.issue({
      agent: 'agent-a',
      ttlSeconds: 3600,
      constraints: [
        { type: 'payment.budget', amount: '5.00', currency: 'USDC' },
        { type: 'payment.allowed_payees', payees: [PAYEE] }
      ]
    })

    if (!narrow.ok) {
      throw new Error(narrow.reason)
    }

    const jti = narrow.record.jti
    const { token } = await world.token('agent-a')
    const sock = path.join(world.socketDir, 'pay.sock')
    const send = async (...argv: string[]) => JSON.parse((await askSocket(sock, token, ['send', ...argv])).stdout)

    expect(await send('0x3333333333333333333333333333333333333333', '0.10', '--mandate', jti)).toMatchObject({
      kind: 'refused',
      reason: 'payee'
    })
    expect(await send(PAYEE, '1.01', '--mandate', jti)).toMatchObject({ kind: 'refused', reason: 'per_tx' })
    expect(await send(OTHER, '0.10', '--mandate', jti)).toMatchObject({
      kind: 'refused',
      reason: 'mandate_invalid',
      detail: 'payee not in mandate'
    })
    expect(await send(PAYEE, '0.10')).toMatchObject({ kind: 'refused', reason: 'no_mandate' })
    expect(await send('not-an-address', '0.10', '--mandate', jti)).toMatchObject({ kind: 'refused', reason: 'payee' })

    expect((await askSocket(sock, token, ['stop'])).code).toBe(0)
    expect(await send(PAYEE, '0.10', '--mandate', jti)).toMatchObject({ kind: 'refused', reason: 'stop' })

    const refusals = world.audit.filter(entry => entry.kind === 'refuse').map(entry => entry.reason)

    expect(refusals).toEqual(['payee', 'per_tx', 'mandate_invalid', 'no_mandate', 'payee', 'stop'])
    expect(world.stub.counts).toMatchObject({ verify: 0, settle: 0 })
    expect(world.doorCalls).toHaveLength(0)
  })

  it('x402-pay: a send the facilitator says is invalid is failed (it still counts) and never settled or re-signed', async () => {
    const world = await wired()
    const jti = world.issue('agent-a', '1.00')
    const { token } = await world.token('agent-a')
    const sock = path.join(world.socketDir, 'pay.sock')

    world.stub.mode = 'invalid'

    const answer = await askSocket(sock, token, ['send', PAYEE, '0.25', '--mandate', jti])

    expect(answer.code).toBe(1)
    expect(JSON.parse(answer.stdout)).toMatchObject({ kind: 'failed', micros: 250_000 })
    expect(world.stub.counts).toMatchObject({ verify: 1, settle: 0 })
    expect(world.registered.payments.status(true).todayMicros).toBe(250_000)
    expect(world.audit).toContainEqual({ kind: 'gap', reason: 'settlement_failed', agent: 'agent-a' })
  })

  it('x402-pay: status is the agent’s own view — caps, today, its mandates with what is left — and no secret', async () => {
    const world = await wired()
    const mine = world.issue('agent-a', '1.00')

    world.issue('agent-b', '3.00')

    const { token } = await world.token('agent-a')
    const sock = path.join(world.socketDir, 'pay.sock')

    expect((await askSocket(sock, token, ['pay', world.url(), '--mandate', mine])).code).toBe(0)

    const answer = await askSocket(sock, token, ['status'])
    const status = JSON.parse(answer.stdout)

    expect(answer.code).toBe(0)
    expect(status).toMatchObject({
      kind: 'status',
      ready: true,
      stopped: false,
      network: 'eip155:84532',
      caps: { perTx: '1.00', perDay: '5.00', perAgentDay: '2.00' },
      today: { all: '0.10', agent: '0.10' },
      payees: [PAYEE],
      mandates: [{ jti: mine, budget: '1.00', left: '0.90', usable: true, revoked: false }]
    })
    expect(status.mandates).toHaveLength(1)

    for (const secret of secretsOf(world)) {
      expect(answer.stdout).not.toContain(secret)
    }

    expect(answer.stdout).not.toMatch(HEX64)
  })
})

describe('agentcard-disabled: main seeds the payment skills it ships disabled', () => {
  it('agentcard-disabled: registerPayments puts agentcard in the profile’s skills.disabled once; main passes HERMES_HOME', async () => {
    const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'v3jhh-'))

    fs.writeFileSync(path.join(hermesHome, 'config.yaml'), 'model:\n  default: x\n')

    try {
      const world = await wired({ hermesHome })

      expect(fs.readFileSync(path.join(hermesHome, 'config.yaml'), 'utf8')).toBe(
        'model:\n  default: x\nskills:\n  disabled:\n  - agentcard\n'
      )
      expect(fs.existsSync(path.join(world.registered.payments.paths.root, 'skills-seeded.json'))).toBe(true)
    } finally {
      fs.rmSync(hermesHome, { recursive: true, force: true })
    }

    const main = fs.readFileSync(path.join(__dirname, '..', 'main.ts'), 'utf8')
    const call = main.slice(main.indexOf('registerPayments({'), main.indexOf('registerPayments({') + 1600)

    expect(call).toMatch(/\n {4}hermesHome: HERMES_HOME,\n {4}hermesRoot: ACTIVE_HERMES_ROOT\n {2}\}\)/)
  })
})

describe('m-r2-2: a profile folder outside the Hermes home', () => {
  it('m-r2-2: is never written, is named in the Payments status, and its spawns get no pay env; an inside link is seeded', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'v3jlk-'))
    const hermesHome = path.join(base, 'hermes')
    const outside = path.join(base, 'elsewhere', 'inft-out-6')
    const inside = path.join(hermesHome, 'kept', 'inft-in-5')

    fs.mkdirSync(path.join(hermesHome, 'profiles'), { recursive: true })
    fs.writeFileSync(path.join(hermesHome, 'config.yaml'), 'model:\n  default: x\n')
    fs.mkdirSync(outside, { recursive: true })
    fs.writeFileSync(path.join(outside, 'config.yaml'), '# theirs\n')
    fs.mkdirSync(inside, { recursive: true })
    fs.symlinkSync(outside, path.join(hermesHome, 'profiles', 'inft-out-6'))
    fs.symlinkSync(inside, path.join(hermesHome, 'profiles', 'inft-in-5'))

    try {
      const world = await wired({ hermesHome })
      const status = (await world.invoke('iclone:payments:status')) as { unprotectedProfiles: string[] }

      expect(status.unprotectedProfiles).toEqual(['inft-out-6'])
      expect(fs.readFileSync(path.join(outside, 'config.yaml'), 'utf8')).toBe('# theirs\n')
      expect(fs.readdirSync(outside)).toEqual(['config.yaml'])
      expect(fs.readFileSync(path.join(inside, 'config.yaml'), 'utf8')).toBe('skills:\n  disabled:\n  - agentcard\n')
      expect(paySpawn('inft-out-6').env).toEqual({})
      expect(paySpawn('default').env.ICLONE_PAY_SOCKET).toBeTruthy()
      expect(paySpawn('inft-in-5').env.ICLONE_PAY_SOCKET).toBeTruthy()
      expect(world.audit).toContainEqual({ kind: 'refuse', reason: 'spawn unprotected_profile', agent: 'inft-out-6' })

      // The link is moved inside the home: the next spawn's seed sees it as it is now, and the profile is protected.
      fs.rmSync(path.join(hermesHome, 'profiles', 'inft-out-6'))
      fs.mkdirSync(path.join(hermesHome, 'profiles', 'inft-out-6'))
      expect(paySpawn('inft-out-6').env.ICLONE_PAY_SOCKET).toBeTruthy()
      expect(
        ((await world.invoke('iclone:payments:status')) as { unprotectedProfiles: string[] }).unprotectedProfiles
      ).toEqual([])
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('m-r2-2: a root config.yaml linked outside the Hermes home (lead ruling)', () => {
  it('m-r2-2: is never edited, `default` is named unprotected and its spawns get no pay env', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'v3jcf-'))
    const hermesHome = path.join(base, 'hermes')
    const theirs = path.join(base, 'dotfiles', 'hermes.yaml')

    fs.mkdirSync(hermesHome, { recursive: true })
    fs.mkdirSync(path.dirname(theirs))
    fs.writeFileSync(theirs, 'model:\n  default: x\n')
    fs.symlinkSync(theirs, path.join(hermesHome, 'config.yaml'))

    try {
      const world = await wired({ hermesHome })
      const status = (await world.invoke('iclone:payments:status')) as { unprotectedProfiles: string[] }

      expect(status.unprotectedProfiles).toEqual(['default'])
      expect(fs.readFileSync(theirs, 'utf8')).toBe('model:\n  default: x\n')
      expect(paySpawn('default').env).toEqual({})
      expect(world.audit).toContainEqual({ kind: 'refuse', reason: 'spawn unprotected_profile', agent: 'default' })
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('wire-init: the registration lines in main', () => {
  const source = (file: string) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')

  it('wire-init: main.ts registers payments after the door, sealing only under the Keychain opt-in, auditing via V3-F', () => {
    const main = source('main.ts')
    const at = main.indexOf('registerPayments({')

    expect(at).toBeGreaterThan(main.indexOf('const consentDoor = registerConsentDoor('))
    expect(at).toBeGreaterThan(main.indexOf('registerPermissions({'))

    const call = main.slice(at, main.indexOf('\n  })\n', at))

    // V3-FX M1: the sealer follows the Keychain opt-in live (built only while it is on; re-read on every toggle).
    expect(call).toContain('sealer: paymentsSealing.current()')
    expect(main).toContain('const paymentsSealing = keychain.sealer(() => permissionKeySealer(safeStorage))')
    expect(main).toContain('const keychain = createKeychainSwitch(() => secretStoragePolicy().on)')
    expect(main).toMatch(/keychain\.subscribe\(\(\) => \{\n {4}payments\.reseal\(paymentsSealing\.current\(\)\)/)
    expect(call).toContain('door: consentDoor')
    expect(call).toContain('audit: entry => recordPayment(entry)')
    expect(call).toContain('isTrustedSender: consentSenderGuard')
    expect(call).toContain("socketDir: path.join(app.getPath('userData'), 'run')")
    expect(main).toContain("app.on('will-quit', () => payments.close())")
  })

  it('wire-init: start-hermes gives each spawn its pay env and retires the token with the child', () => {
    const start = source('main/start-hermes.ts')

    expect(start).toContain('const payments = paySpawn(runsAs.slug)')
    expect(start).toContain('...payments.env,')
    expect(start).toContain('payments.attach(hermesProcess)')
  })

  it('J4-1: start-hermes pins the profile it mints for: one resolution feeds the argv and the token (fix m-r3-2)', () => {
    const start = source('main/start-hermes.ts')
    const resolved = start.indexOf('const runsAs = spawnProfile(activeProfile, { hermesHome: HERMES_HOME })')

    expect(resolved).toBeGreaterThan(start.indexOf('const activeProfile = readActiveDesktopProfile()'))
    expect(start.indexOf('backendArgs.unshift(...runsAs.args)')).toBeGreaterThan(resolved)
    expect(start.indexOf('resolveHermesBackend(backendArgs)')).toBeGreaterThan(resolved)
    expect(start.indexOf('paySpawn(runsAs.slug)')).toBeGreaterThan(resolved)
    // No other spawn of the primary backend picks its profile: the argv carries no second --profile.
    expect(start.match(/'--profile'/g)).toBeNull()
    expect(start.match(/paySpawn\(/g)).toHaveLength(1)
  })
})

describe('J4-1: the pay token is for the profile Hermes runs, never `default` by assumption (fix m-r3-2)', () => {
  /** A Hermes home under `<base>/home` whose sticky `active_profile` names `sticky`. */
  function stickyHome(sticky: string): { base: string; hermesHome: string; env: NodeJS.ProcessEnv } {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v3jst-')))
    const hermesHome = path.join(base, 'home', '.hermes')

    fs.mkdirSync(path.join(hermesHome, 'profiles'), { recursive: true })
    fs.writeFileSync(path.join(hermesHome, 'config.yaml'), 'model:\n  default: x\n')
    fs.writeFileSync(path.join(hermesHome, 'active_profile'), `${sticky}\n`)

    return { base, hermesHome, env: { HOME: path.join(base, 'home') } }
  }

  it('J4-1: sticky active profile linked outside the home ⇒ that spawn gets NO pay env, refused and audited by its id', async () => {
    const { base, hermesHome, env } = stickyHome('away')
    const outside = path.join(base, 'elsewhere', 'away')

    fs.mkdirSync(outside, { recursive: true })
    fs.symlinkSync(outside, path.join(hermesHome, 'profiles', 'away'))

    try {
      const world = await wired({ hermesHome })
      const runsAs = spawnProfile(null, { hermesHome, env })

      expect(runsAs).toMatchObject({ args: ['--profile', 'away'], slug: 'away' })
      expect(paySpawn(runsAs.slug).env).toEqual({})
      expect(world.audit).toContainEqual({ kind: 'refuse', reason: 'spawn unprotected_profile', agent: 'away' })
      expect(world.audit).not.toContainEqual({ kind: 'refuse', reason: 'spawn unprotected_profile', agent: 'default' })
      expect(fs.readdirSync(outside)).toEqual([])
      expect(fs.readFileSync(path.join(hermesHome, 'active_profile'), 'utf8')).toBe('away\n')
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  it('m-r4-2: the same scenario with the letter case changed (profiles/Away, linked out or inside) ⇒ no pay env, unprotected', async () => {
    for (const where of ['outside', 'inside']) {
      const { base, hermesHome, env } = stickyHome('away')

      const target =
        where === 'outside' ? path.join(base, 'elsewhere', 'Away') : path.join(hermesHome, 'profiles', 'Away')

      fs.mkdirSync(target, { recursive: true })

      if (where === 'outside') {
        fs.symlinkSync(target, path.join(hermesHome, 'profiles', 'Away'))
      }

      try {
        const world = await wired({ hermesHome })
        const runsAs = spawnProfile(null, { hermesHome, env })

        expect(runsAs.slug, where).toBe('away')
        expect(paySpawn(runsAs.slug).env, where).toEqual({})
        expect(world.audit, where).toContainEqual({
          kind: 'refuse',
          reason: 'spawn unprotected_profile',
          agent: 'away'
        })

        const status = (await world.invoke('iclone:payments:status')) as { unprotectedProfiles: string[] }

        expect(status.unprotectedProfiles, where).toEqual(['away'])
        expect(fs.readdirSync(target), where).toEqual([])
      } finally {
        fs.rmSync(base, { recursive: true, force: true })
      }
    }
  })

  it('J4-1: sticky active profile inside the home ⇒ the token is THAT profile’s: it sees its mandates, not default’s', async () => {
    const { base, hermesHome, env } = stickyHome('coder')

    fs.mkdirSync(path.join(hermesHome, 'profiles', 'coder'))

    try {
      const world = await wired({ hermesHome })
      const mine = world.issue('coder', '1.00')

      world.issue('default', '3.00')

      const runsAs = spawnProfile(null, { hermesHome, env })
      const spawned = paySpawn(runsAs.slug)

      expect(runsAs).toMatchObject({ args: ['--profile', 'coder'], slug: 'coder' })
      expect(spawned.env.ICLONE_PAY_SOCKET).toBeTruthy()

      const token = fs.readFileSync(spawned.env.ICLONE_PAY_TOKEN_FILE, 'utf8').trim()
      const answer = await askSocket(spawned.env.ICLONE_PAY_SOCKET, token, ['status'], spawned.env.ICLONE_PAY_HOME)

      expect(answer.code).toBe(0)
      expect(JSON.parse(answer.stdout).mandates.map((m: { jti: string }) => m.jti)).toEqual([mine])
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  it('J4-1: a sticky value Hermes would refuse ⇒ no flag, no pay env (the seed still runs)', async () => {
    const { base, hermesHome, env } = stickyHome('ghost')

    try {
      await wired({ hermesHome })
      fs.rmSync(path.join(hermesHome, 'config.yaml'))

      const runsAs = spawnProfile(null, { hermesHome, env })

      expect(runsAs).toMatchObject({ args: [], slug: null })
      expect(paySpawn(runsAs.slug).env).toEqual({})
      expect(fs.readFileSync(path.join(hermesHome, 'config.yaml'), 'utf8')).toContain('- agentcard')
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })
})
