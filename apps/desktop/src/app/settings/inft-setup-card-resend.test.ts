import { afterEach, describe, expect, test, vi } from 'vitest'

import type { AcpRunResult, InftAcpStatus } from '../home/acp-setup'

const kv = new Map<string, Record<string, unknown>>()
const writes: Record<string, unknown>[] = []

vi.mock('../home/acp-setup', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  inftKvGet: async (inftId: string) => ({ ok: true, value: kv.get(inftId) ?? null }),
  inftKvSet: async (inftId: string, _key: string, value: Record<string, unknown>) => {
    kv.set(inftId, value)
    writes.push(value)

    return { ok: true, value }
  },
  inftKvDelete: async (inftId: string) => {
    kv.delete(inftId)

    return { ok: true, value: null }
  }
}))

const { confirmedSentAt, readSignInRecord, sendSignInLink } = await import('./inft-setup-card-resend')
const { claimSignup, releaseSignup } = await import('./inft-setup-card-flight')
const { IDLE_SIGNUP, RESEND_WAIT_MS, resendGate, signupGate } = await import('./inft-setup-card-signup')

const answered = (stdout: unknown): AcpRunResult => ({ ok: true, code: 0, stdout: JSON.stringify(stdout), stderr: '' })

afterEach(() => {
  kv.clear()
  writes.length = 0
})

describe('sendSignInLink — the one fresh sign-in link, for the Bank and the wizard', () => {
  test('writes the pre-send marker before the call, and stamps "sent" at the confirmed answer, not the click', async () => {
    let clock = 1_000

    const run = vi.fn(async () => {
      // The marker is on disk while the call is out.
      expect(kv.get('i-1')).toMatchObject({ phase: 'unconfirmed', sentAt: 1_000 })
      clock = 4_500

      return answered({ state: 'st-1' })
    })

    const result = await sendSignInLink('i-1', 'agent@example.com', { run, now: () => clock })

    expect(result).toEqual({ kind: 'sent', at: 4_500 })
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith('i-1', ['card', 'signup', '--email', 'agent@example.com', '--json'], 90_000)
    expect(kv.get('i-1')).toMatchObject({ phase: 'polling', source: 'local', state: 'st-1', sentAt: 4_500 })
    expect((await readSignInRecord('i-1', 4_500)).confirmedAt).toBe(4_500)
  })

  test('an answer without a state token is not a send: nothing is stamped, the record stays unconfirmed', async () => {
    const result = await sendSignInLink('i-2', 'agent@example.com', {
      run: async () => ({ ok: false, code: null, stdout: '', stderr: '', error: 'TIMEOUT' }),
      now: () => 2_000
    })

    expect(result.kind).toBe('failed')
    expect((await readSignInRecord('i-2', 2_000)).confirmedAt).toBeNull()
    expect(kv.get('i-2')).toMatchObject({ phase: 'unconfirmed' })
  })

  test('refuses while another signup for the iNFT is in flight, and inside a recorded hold — nothing runs', async () => {
    const run = vi.fn(async () => answered({ state: 'never' }))

    expect(claimSignup('i-3')).toBe(true)
    expect(await sendSignInLink('i-3', 'a@example.com', { run, now: () => 1 })).toEqual({ kind: 'busy' })
    releaseSignup('i-3')

    kv.set('i-4', { phase: 'cooldown', cooldownUntil: 90_000, attempt: 0, polls: 0, fetches: 0 })
    expect(await sendSignInLink('i-4', 'a@example.com', { run, now: () => 30_000 })).toEqual({
      kind: 'held',
      until: 90_000
    })
    expect(run).not.toHaveBeenCalled()
    expect(writes).toEqual([])
  })
})

describe('confirmedSentAt — only a send the CLI confirmed has a time', () => {
  test('a local token with its time', () => {
    expect(confirmedSentAt({ ...IDLE_SIGNUP, phase: 'polling', source: 'local', state: 's', sentAt: 9 })).toBe(9)
  })

  test('never the pre-send marker, a token adopted from the server, or a record without a time', () => {
    expect(confirmedSentAt({ ...IDLE_SIGNUP, phase: 'unconfirmed', source: 'local', sentAt: 9 })).toBeNull()
    expect(confirmedSentAt({ ...IDLE_SIGNUP, phase: 'expired', source: 'server', state: 's', sentAt: 9 })).toBeNull()
    expect(confirmedSentAt({ ...IDLE_SIGNUP, phase: 'expired', source: 'local', state: 's' })).toBeNull()
    expect(confirmedSentAt(null)).toBeNull()
  })
})

describe('V3-L M2 — the one-minute wait lives in the record and in the send itself', () => {
  const sendAt = (inft: string, at: number, run = vi.fn(async () => answered({ state: `st-${at}` }))) =>
    sendSignInLink(inft, 'a@example.com', { run, now: () => at }).then(result => ({ result, run }))

  test('send, then a re-mount (a fresh read of the record) and a send inside the minute: refused with its end, 0 runs', async () => {
    const t0 = 1_000_000

    expect((await sendAt('w-1', t0)).result).toEqual({ kind: 'sent', at: t0 })

    // A window that (re)opens reads the wait back; nothing in component state is needed.
    expect(await readSignInRecord('w-1', t0 + 20_000)).toEqual({ confirmedAt: t0, readyAt: t0 + RESEND_WAIT_MS })

    const inside = await sendAt('w-1', t0 + RESEND_WAIT_MS - 1)

    expect(inside.result).toEqual({ kind: 'wait', until: t0 + RESEND_WAIT_MS })
    expect(inside.run).not.toHaveBeenCalled()

    const after = await sendAt('w-1', t0 + RESEND_WAIT_MS)

    expect(after.result).toEqual({ kind: 'sent', at: t0 + RESEND_WAIT_MS })
    expect(after.run).toHaveBeenCalledTimes(1)
  })

  test('a send whose answer never came back counts as a send: the minute holds after it too', async () => {
    const t0 = 2_000_000

    await sendSignInLink('w-2', 'a@example.com', {
      run: async () => ({ ok: false, code: null, stdout: '', stderr: '', error: 'TIMEOUT' }),
      now: () => t0
    })
    expect(kv.get('w-2')).toMatchObject({ phase: 'unconfirmed' })
    expect((await sendAt('w-2', t0 + 30_000)).result).toEqual({ kind: 'wait', until: t0 + RESEND_WAIT_MS })
  })

  test("main's own minute (a send from another window) reads back as a wait, and stamps nothing", async () => {
    const until = 1_792_000_060_000

    const refusal: AcpRunResult = {
      ok: false,
      code: null,
      stdout: '',
      stderr: '',
      error: `a sign-in link for this iNFT went out less than a minute ago — not sending another until x [resend-at=${until}]`
    }

    const { result } = await sendAt(
      'w-3',
      1_792_000_000_000,
      vi.fn(async () => refusal)
    )

    expect(result).toEqual({ kind: 'wait', until })
    expect(kv.get('w-3')).toBeUndefined()
  })

  test('m4: the clock set back an hour after a send — the record never holds Resend for the hour; main decides', async () => {
    const t0 = 3_000_000_000
    const back = t0 - 3_600_000
    const mainUntil = back + RESEND_WAIT_MS

    await sendAt('w-5', t0)

    // A record ahead of the clock is no wait of the renderer's, on any read, and never a minute that rolls on.
    for (const now of [back, back + 30_000, back + RESEND_WAIT_MS]) {
      expect(resendGate({ ...IDLE_SIGNUP, sentAt: t0 }, now)).toEqual({ gate: 'resend' })
      expect(await readSignInRecord('w-5', now)).toEqual({ confirmedAt: t0, readyAt: 0 })
    }

    // The click reaches main, whose minute (clamped once to its clock) refuses: nothing sent, the wait it names.
    const mainRefusal: AcpRunResult = {
      ok: false,
      code: null,
      stdout: '',
      stderr: '',
      error: `a sign-in link for this iNFT went out less than a minute ago — not sending another until x [resend-at=${mainUntil}]`
    }

    const inside = await sendAt(
      'w-5',
      back + 1_000,
      vi.fn(async () => mainRefusal)
    )

    expect(inside.result).toEqual({ kind: 'wait', until: mainUntil })
    expect(inside.result.kind === 'wait' && inside.result.until - (back + 1_000)).toBeLessThanOrEqual(RESEND_WAIT_MS)
    // The record keeps its own send: main's refusal stamps nothing.
    expect(kv.get('w-5')).toMatchObject({ sentAt: t0, source: 'local' })
  })

  test('a 403/429 hold on record refuses as held, ahead of the minute', async () => {
    kv.set('w-4', { phase: 'cooldown', cooldownUntil: 900_000, sentAt: 10, attempt: 0, polls: 0, fetches: 0 })
    expect((await sendAt('w-4', 100_000)).result).toEqual({ kind: 'held', until: 900_000 })
    expect(await readSignInRecord('w-4', 100_000)).toEqual({ confirmedAt: null, readyAt: 900_000 })
  })
})

describe('V3-L M1 — the wizard and the Bank give one answer for a signin-pending card', () => {
  const pending = {
    cli: true,
    authenticated: true,
    cardReady: false,
    configured: true,
    checkedAt: 1,
    slug: 's',
    email: 'a@example.com',
    cardState: 'signin-pending',
    cardReauthState: 'ab-12'
  } as InftAcpStatus

  const T = 5_000_000

  const fixtures = [
    ['nothing on record', IDLE_SIGNUP, 'resend', 'sent'],
    [
      'a link sent 10 s ago',
      { ...IDLE_SIGNUP, phase: 'polling', state: 'st', source: 'local', sentAt: T - 10_000 },
      'refused',
      'wait'
    ],
    [
      'a link sent 2 min ago',
      { ...IDLE_SIGNUP, phase: 'expired', state: 'st', source: 'local', sentAt: T - 120_000 },
      'resend',
      'sent'
    ],
    ['a 429 hold', { ...IDLE_SIGNUP, phase: 'cooldown', cooldownUntil: T + 30_000 }, 'refused', 'held']
  ] as const

  test.each(fixtures)('%s: same gate, and the send does what the gate says', async (_name, record, gate, kind) => {
    const inft = `m1-${_name}`

    expect(signupGate(record, pending, T)).toEqual(resendGate(record, T))
    expect(signupGate(record, pending, T).gate).toBe(gate)

    if (record !== IDLE_SIGNUP) {
      kv.set(inft, record as unknown as Record<string, unknown>)
    }

    const run = vi.fn(async () => answered({ state: 'st-new' }))
    const result = await sendSignInLink(inft, 'a@example.com', { run, now: () => T })

    expect(result.kind).toBe(kind)
    expect(run).toHaveBeenCalledTimes(kind === 'sent' ? 1 : 0)
  })

  test('never a signup of the account: the wizard gate for signin-pending is never "allowed" or "confirm"', () => {
    for (const [, record] of fixtures) {
      expect(['allowed', 'confirm']).not.toContain(signupGate(record, pending, T).gate)
    }
  })
})
