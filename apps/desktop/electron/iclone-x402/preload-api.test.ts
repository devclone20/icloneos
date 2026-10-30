import fs from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  createPaymentsBridge,
  projectMandateResult,
  projectMandates,
  projectSettings,
  projectStatus
} from './preload-api'
import { askSocket, makeWired, type Wired } from './wired.test-helpers'

const worlds: Wired[] = []

afterEach(async () => {
  for (const world of worlds.splice(0)) {
    await world.close()
  }
})

const KEY_HEX = `0x${'ab'.repeat(32)}`

describe('wire-preload: hermesDesktop.payments', () => {
  it('wire-preload: offers exactly status, limits, setLimits, mandates, requestMandate, revoke, stop, onChanged — no sign, pay or issue', () => {
    const bridge = createPaymentsBridge(
      () => Promise.resolve(null),
      () => null,
      () => () => undefined
    ) as unknown as Record<string, unknown>

    expect(Object.keys(bridge).sort()).toEqual([
      'limits',
      'mandates',
      'onChanged',
      'requestMandate',
      'revoke',
      'setLimits',
      'status',
      'stop'
    ])

    for (const absent of ['sign', 'pay', 'issue', 'export', 'key', 'signer']) {
      expect(bridge[absent]).toBeUndefined()
    }

    expect(Object.isFrozen(bridge)).toBe(true)
  })

  it('wire-preload: the click lock is read synchronously, inside the call; stop sends a strict boolean', async () => {
    const sent: { channel: string; payload: unknown }[] = []
    let clicks = 0

    const bridge = createPaymentsBridge(
      (channel, payload) => {
        sent.push({ channel, payload })

        return Promise.resolve({ ok: true })
      },
      () => ({ activation: true, confirm: (clicks += 1) }),
      () => () => undefined
    )

    const settings = projectSettings({})!

    void bridge.setLimits(settings, settings)
    void bridge.revoke('a'.repeat(32))
    void bridge.stop('yes' as unknown as boolean)

    expect(clicks).toBe(3)
    expect(sent.map(entry => entry.channel)).toEqual([
      'iclone:payments:set-limits',
      'iclone:payments:revoke',
      'iclone:payments:stop'
    ])
    expect(sent[0].payload).toMatchObject({ gesture: { confirm: 1 } })
    expect(sent[2].payload).toEqual({ on: false, gesture: { activation: true, confirm: 3 } })
  })

  it('J4-4: the window’s language rides each request that opens an owner sheet (and nothing else); odd values are dropped', async () => {
    const sent: { channel: string; payload: Record<string, unknown> }[] = []
    let lang: unknown = 'pt-PT'

    const bridge = createPaymentsBridge(
      (channel, payload) => {
        sent.push({ channel, payload: payload as Record<string, unknown> })

        return Promise.resolve({ ok: true })
      },
      () => ({ activation: true }),
      () => () => undefined,
      () => lang
    )

    const settings = projectSettings({})!

    const terms = {
      agent: 'a',
      budget: '1',
      min: '0.1',
      max: '1',
      payees: [],
      notBefore: '',
      notAfter: '',
      expiresAt: ''
    }

    void bridge.setLimits(settings, settings)
    void bridge.requestMandate(terms)
    void bridge.stop(false)
    void bridge.revoke('a'.repeat(32))
    lang = 'x'.repeat(17)
    void bridge.stop(false)
    lang = { toString: () => 'ja' }
    void bridge.stop(false)

    expect(sent.map(entry => entry.payload.locale)).toEqual([
      'pt-PT',
      'pt-PT',
      'pt-PT',
      undefined,
      undefined,
      undefined
    ])
    expect('locale' in sent[3].payload).toBe(false)
  })

  it('mandate-issue: requestMandate reads the click lock inside the call and sends the terms field by field, nothing else', async () => {
    const sent: { channel: string; payload: unknown }[] = []
    let clicks = 0

    const bridge = createPaymentsBridge(
      (channel, payload) => {
        sent.push({ channel, payload })

        return Promise.resolve({ ok: true, jti: 'a'.repeat(32), sdjwt: 'eyJ.signed.mandate~', key: KEY_HEX })
      },
      () => ({ activation: true, confirm: (clicks += 1) }),
      () => () => undefined
    )

    const terms = {
      agent: 'agent-a',
      budget: '2.00',
      min: '0.01',
      max: '1.00',
      payees: ['0x1111111111111111111111111111111111111111'],
      notBefore: '2026-10-21T10:00:00.000Z',
      notAfter: '2026-10-22T10:00:00.000Z',
      expiresAt: '2026-10-22T10:00:00.000Z',
      sdjwt: 'smuggled'
    }

    const answered = bridge.requestMandate(terms)

    expect(clicks).toBe(1)
    // Through the bridge itself: main's answer is re-projected to the id alone.
    expect(await answered).toEqual({ ok: true, jti: 'a'.repeat(32) })
    expect(sent).toHaveLength(1)
    expect(sent[0].channel).toBe('iclone:payments:request-mandate')
    expect(sent[0].payload).toEqual({
      terms: { ...terms, sdjwt: undefined },
      gesture: { activation: true, confirm: 1 }
    })
    expect(JSON.stringify(sent[0].payload)).not.toContain('smuggled')
  })

  it('mandate-issue: main’s answer crosses as the id only — a signed mandate or any extra never does', () => {
    const jti = 'b'.repeat(32)

    expect(projectMandateResult({ ok: true, jti, sdjwt: 'eyJ.x.y~', key: KEY_HEX })).toEqual({ ok: true, jti })
    expect(projectMandateResult({ ok: true, jti: `${jti}~eyJ` })).toEqual({ ok: false, reason: 'unknown' })
    expect(projectMandateResult({ ok: false, reason: 'door_denied', detail: KEY_HEX })).toEqual({
      ok: false,
      reason: 'door_denied'
    })
    expect(projectMandateResult({ ok: false, reason: 'made_up' })).toEqual({ ok: false, reason: 'unknown' })
  })

  it('wire-preload: whatever main answers is re-projected — an extra key, a sealed blob or a raw mandate never crosses', async () => {
    const status = projectStatus({
      schema: 1,
      ready: true,
      reason: null,
      pocket: KEY_HEX,
      network: 'eip155:84532',
      stopped: false,
      ledgerOk: true,
      todayMicros: 1,
      agents: [{ agent: 'a', micros: 1, key: KEY_HEX }],
      pocketKey: KEY_HEX,
      sealed: 'sealed:abc'
    })

    expect(JSON.stringify(status)).not.toContain('ab'.repeat(32))
    expect(status?.pocket).toBeNull()
    expect(status).not.toHaveProperty('pocketKey')

    const mandates = projectMandates([
      { jti: 'c'.repeat(32), agent: 'a', sdjwt: 'eyJ.x.y~', signature: KEY_HEX, payees: ['0x1'] },
      { jti: 'd'.repeat(64), agent: 'b' }
    ])

    expect(mandates).toHaveLength(1)
    expect(Object.keys(mandates[0]).sort()).toEqual([
      'agent',
      'budget',
      'expiresAt',
      'issuedAt',
      'jti',
      'payees',
      'range',
      'revoked'
    ])
    expect(projectSettings({ perTxMicros: 1.5, signer: 'evil', payees: [KEY_HEX, 7] })).toMatchObject({
      perTxMicros: 0,
      signer: 'pocket',
      payees: [KEY_HEX]
    })
    expect(projectStatus({ schema: 2 })).toBeNull()
  })

  it('wire-preload: the bridge itself re-projects every read — extra fields from main never reach the page', async () => {
    const answers: Record<string, unknown> = {
      'iclone:payments:status': { schema: 1, ready: true, pocket: KEY_HEX, pocketKey: KEY_HEX, agents: [] },
      'iclone:payments:limits': { perTxMicros: 1, sealed: 'sealed:abc', payees: [] },
      'iclone:payments:mandates': [{ jti: 'c'.repeat(32), agent: 'a', sdjwt: 'eyJ.x.y~' }]
    }

    const bridge = createPaymentsBridge(
      channel => Promise.resolve(answers[channel]),
      () => null,
      () => () => undefined
    )

    const seen = JSON.stringify([await bridge.status(), await bridge.limits(), await bridge.mandates()])

    expect(seen).not.toMatch(/pocketKey|sealed|sdjwt|eyJ/)
    expect(seen).not.toContain('ab'.repeat(32))
  })

  it('wire-preload: end to end on the wired module, after a real payment, the bridge returns views only', async () => {
    const world = await makeWired()

    worlds.push(world)

    const jti = world.issue('agent-a')
    const { token } = await world.token('agent-a')

    expect(
      (await askSocket(path.join(world.socketDir, 'pay.sock'), token, ['pay', world.url(), '--mandate', jti])).code
    ).toBe(0)

    const bridge = createPaymentsBridge(
      (channel, payload) => world.invoke(channel, payload),
      () => null,
      () => () => undefined
    )

    const all = JSON.stringify([await bridge.status(), await bridge.limits(), await bridge.mandates()])

    expect(all).toContain(jti)
    expect(all).not.toMatch(/[0-9a-f]{64}|~|eyJ|BEGIN|sealed:/i)
    expect((await bridge.status())?.todayMicros).toBe(100_000)
  })

  it('Jm1/J4-5: an allowlist refusal carries what is wrong as data (bounded); no text of main crosses', async () => {
    const answers: unknown[] = [
      {
        ok: false,
        reason: 'allowlist',
        detail: 'main words',
        problems: [
          {
            list: 'payees',
            kind: 'entries',
            count: 9,
            entries: ['"vitalik.eth"', 'x'.repeat(200), 1, 2, 3, 4, 5],
            more: 4
          },
          { list: 'evil', kind: 'odd', count: 'x', entries: 'no', more: -1.5 },
          { list: 'origins', kind: 'too_many', count: 51, entries: [], more: 0 }
        ]
      },
      {
        ok: false,
        reason: 'door_denied',
        problems: [{ list: 'payees', kind: 'entries', count: 1, entries: ['a'], more: 0 }]
      },
      { ok: false, reason: 'allowlist', problems: 'not a list' }
    ]

    const bridge = createPaymentsBridge(
      () => Promise.resolve(answers.shift()),
      () => null,
      () => () => undefined
    )

    const shown = {} as never
    const first = await bridge.setLimits(shown, shown)

    expect(first).toEqual({
      ok: false,
      reason: 'allowlist',
      problems: [
        { list: 'payees', kind: 'entries', count: 9, entries: ['"vitalik.eth"', 'x'.repeat(64)], more: 4 },
        { list: 'payees', kind: 'entries', count: 0, entries: [], more: 0 }
      ]
    })
    expect(JSON.stringify(first)).not.toContain('main words')
    expect(await bridge.setLimits(shown, shown)).toEqual({ ok: false, reason: 'door_denied' })
    expect(await bridge.setLimits(shown, shown)).toEqual({ ok: false, reason: 'allowlist' })
  })

  it('J4-5: the status carries a not-ready CODE, never main’s words', () => {
    const base = { schema: 1, ready: false, pocket: null, network: 'eip155:84532', stopped: false, ledgerOk: true }

    expect(projectStatus({ ...base, reason: 'sealing_off' })?.reason).toBe('sealing_off')
    expect(projectStatus({ ...base, reason: 'OS sealing unavailable (Keychain setting off)' })?.reason).toBe('disabled')
    expect(projectStatus({ ...base })?.reason).toBe('disabled')
    expect(projectStatus({ ...base, ready: true, reason: 'socket_down' })?.reason).toBeNull()
  })

  it('wire-preload: preload.ts exposes the namespace through this factory and marks the click lock control', () => {
    const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.ts'), 'utf8')

    expect(preload).toContain('payments: createPaymentsBridge(')
    expect(preload).toContain("closest('[data-payments-confirm]')")
    expect(preload).toContain('() => userGesture(paymentsConfirm)')
    expect(preload).toContain('paymentsConfirm.observe(observed)')
    expect(preload).not.toMatch(/iclone:payments:(sign|pay|issue)/)
  })
})

describe('m-r2-2: the status names unprotected profiles, profile ids only', () => {
  it('m-r2-2: projectStatus keeps Hermes profile ids and drops anything else', () => {
    const status = projectStatus({
      schema: 1,
      ready: true,
      reason: null,
      pocket: null,
      network: 'eip155:84532',
      stopped: false,
      ledgerOk: true,
      todayMicros: 0,
      agents: [],
      unprotectedProfiles: ['inft-out-6', 'Bad Name', '../x', 'a\u202eb', 7, 'x'.repeat(65), 'ok_2']
    })

    expect(status?.unprotectedProfiles).toEqual(['inft-out-6', 'ok_2'])
    expect(projectStatus({ schema: 1 })?.unprotectedProfiles).toEqual([])
  })
})
