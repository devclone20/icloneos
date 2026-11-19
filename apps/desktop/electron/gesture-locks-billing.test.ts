/**
 * v0.0.9 Q (tests-perf 1, lead decision 1) — the owner-click lock on every billing write, proven in the default run
 * with an injectable clock, gesture verdict and audit sink (the real-Chromium proof is gesture-locks-f1s.live.test.ts).
 */
import { describe, expect, it, vi } from 'vitest'

import {
  BILLING_AUDIT_TOOL,
  BILLING_CHARGE_REFUSED,
  BILLING_CONFIRM_TTL_MS,
  BILLING_GESTURE_REFUSED,
  createBillingChargeLock,
  registerBillingChargeLock
} from './gesture-locks-billing'

type Entry = { kind: 'refuse' | 'use'; reason: string; gesture: boolean; tool: string }

function lockWith(options: { gesture?: boolean; audit?: ((entry: Entry) => unknown) | null; start?: number } = {}) {
  let at = options.start ?? 1_000_000
  const entries: Entry[] = []

  const audit =
    options.audit === null
      ? undefined
      : (options.audit ??
        ((entry: Entry) => {
          entries.push(entry)

          return { id: `r${entries.length}` }
        }))

  const lock = createBillingChargeLock({
    gestureOk: () => options.gesture ?? true,
    audit,
    now: () => at
  })

  return {
    lock,
    entries,
    advance: (ms: number) => {
      at += ms
    }
  }
}

const KEY = 'key-0000-0001'

describe('billing lock — Buy credits (charge)', () => {
  it("refuses without the owner's click, audits the refusal and holds no confirm", () => {
    const { lock, entries } = lockWith({ gesture: false })

    expect(lock.authorize({}, { amountUsd: '25', idempotencyKey: KEY })).toEqual({
      ok: false,
      error: BILLING_CHARGE_REFUSED.gesture
    })
    expect(entries).toEqual([
      { kind: 'refuse', reason: expect.stringContaining('$25'), gesture: false, tool: 'billing.charge' }
    ])
    expect(lock.pendingCount()).toBe(0)
  })

  it('a gesture verdict that is truthy but not true is a refusal', () => {
    const lock = createBillingChargeLock({
      gestureOk: () => 1 as unknown as boolean,
      audit: () => ({ id: 'r' })
    })

    expect(lock.authorize({}, { amountUsd: '25', idempotencyKey: KEY }).ok).toBe(false)
    expect(lock.pendingCount()).toBe(0)
  })

  it('no audit sink, or a sink that cannot write the use: refused and nothing pending', () => {
    expect(lockWith({ audit: null }).lock.authorize({}, { amountUsd: '25', idempotencyKey: KEY })).toEqual({
      ok: false,
      error: BILLING_CHARGE_REFUSED.audit
    })

    for (const written of [null, undefined, false]) {
      const { lock } = lockWith({ audit: () => written })

      expect(lock.authorize({}, { amountUsd: '25', idempotencyKey: KEY })).toEqual({
        ok: false,
        error: BILLING_CHARGE_REFUSED.audit
      })
      expect(lock.pendingCount()).toBe(0)
    }

    const { lock } = lockWith({
      audit: () => {
        throw new Error('disk full')
      }
    })

    expect(lock.authorize({}, { amountUsd: '25', idempotencyKey: KEY }).ok).toBe(false)
    expect(lock.pendingCount()).toBe(0)
  })

  it.each([
    ['0', KEY],
    ['0.00', KEY],
    ['1e3', KEY],
    ['-5', KEY],
    ['25.999', KEY],
    ['12345678', KEY],
    [' 25', KEY],
    [25, KEY],
    ['25', 'short12'],
    ['25', 'key with spaces'],
    ['25', 'k'.repeat(129)],
    ['25', undefined]
  ])('amount %j with key %j is not a valid charge request', (amountUsd, idempotencyKey) => {
    const { lock, entries } = lockWith()

    expect(lock.authorize({}, { amountUsd, idempotencyKey })).toEqual({
      ok: false,
      error: BILLING_CHARGE_REFUSED.invalid
    })
    expect(entries).toEqual([])
    expect(lock.pendingCount()).toBe(0)
  })

  it('a confirm is valid until the TTL, never at or after it', () => {
    const early = lockWith()
    const first = early.lock.authorize({}, { amountUsd: '25', idempotencyKey: KEY })

    early.advance(BILLING_CONFIRM_TTL_MS - 1)
    expect(first.ok && early.lock.consume(first.ownerConfirm, '25', KEY)).toBe(true)

    const late = lockWith()
    const second = late.lock.authorize({}, { amountUsd: '25', idempotencyKey: KEY })

    late.advance(BILLING_CONFIRM_TTL_MS)
    expect(second.ok && late.lock.consume(second.ownerConfirm, '25', KEY)).toBe(false)
  })

  it('single use, bound to amount and key; a wrong ask spends it', () => {
    const { lock } = lockWith()
    const granted = lock.authorize({}, { amountUsd: '25', idempotencyKey: KEY })

    if (!granted.ok) {
      throw new Error('refused')
    }

    expect(lock.consume(granted.ownerConfirm, '25.00', KEY)).toBe(false)
    expect(lock.consume(granted.ownerConfirm, '25', KEY)).toBe(false)

    const again = lock.authorize({}, { amountUsd: '25', idempotencyKey: KEY })

    expect(again.ok && lock.consume(again.ownerConfirm, '25', KEY)).toBe(true)
    expect(again.ok && lock.consume(again.ownerConfirm, '25', KEY)).toBe(false)
    expect(lock.consume(undefined, '25', KEY)).toBe(false)
  })

  it('m-r2-1: a Retry of the SAME buy gets a fresh confirm bound to the SAME key, each spendable exactly once', () => {
    const { lock, entries } = lockWith()
    const buy = lock.authorize({}, { amountUsd: '10', idempotencyKey: KEY })

    if (!buy.ok) {
      throw new Error('refused')
    }

    // The Buy request went out (answer lost): its confirm is spent by the runtime.
    expect(lock.consume(buy.ownerConfirm, '10', KEY)).toBe(true)

    // The owner clicks Retry: a NEW confirm for the same amount and key, granted on that click.
    const retry = lock.authorize({}, { amountUsd: '10', idempotencyKey: KEY })

    if (!retry.ok) {
      throw new Error('refused')
    }

    expect(retry.ownerConfirm).not.toBe(buy.ownerConfirm)
    expect(lock.consume(buy.ownerConfirm, '10', KEY)).toBe(false)
    expect(lock.consume(retry.ownerConfirm, '10', KEY)).toBe(true)
    expect(lock.consume(retry.ownerConfirm, '10', KEY)).toBe(false)
    expect(entries.map(entry => entry.kind)).toEqual(['use', 'use'])

    // Two clicks on the same key before either request: two confirms, each once, neither pays for the other.
    const one = lock.authorize({}, { amountUsd: '10', idempotencyKey: KEY })
    const two = lock.authorize({}, { amountUsd: '10', idempotencyKey: KEY })

    expect(one.ok && two.ok && lock.consume(two.ownerConfirm, '10', KEY)).toBe(true)
    expect(one.ok && lock.consume(one.ownerConfirm, '10', KEY)).toBe(true)
    expect(one.ok && lock.consume(one.ownerConfirm, '10', KEY)).toBe(false)
    expect(lock.pendingCount()).toBe(0)
  })

  it('holds at most 16 confirms: the 17th pushes out the oldest', () => {
    const { lock } = lockWith()
    const tokens: string[] = []

    for (let i = 0; i < 17; i += 1) {
      const granted = lock.authorize({}, { amountUsd: '1', idempotencyKey: `key-${String(i).padStart(8, '0')}` })

      if (!granted.ok) {
        throw new Error('refused')
      }

      tokens.push(granted.ownerConfirm)
    }

    expect(lock.pendingCount()).toBe(16)
    expect(lock.consume(tokens[0], '1', 'key-00000000')).toBe(false)
    expect(lock.consume(tokens[16], '1', 'key-00000016')).toBe(true)
  })
})

describe('billing lock — upgrade, plan change, resume and auto-reload (lead decision 1)', () => {
  const cases = [
    ['subscription-upgrade', 'tier_pro'],
    ['subscription-change', 'tier_lite'],
    ['subscription-resume', 'resume'],
    ['auto-reload', 'on|10|25.50']
  ] as const

  // v0.0.9 r3 (eng n4): each action refuses in its own words and is audited under its own runtime method. Red on
  // fb85ac6be6: every refusal said "a charge needs your own click on Buy" and every audit tool was billing.charge.
  const TOOLS = {
    'subscription-upgrade': ['subscription.upgrade', /plan upgrade .* Upgrade$/],
    'subscription-change': ['subscription.change', /plan change .* Change plan$/],
    'subscription-resume': ['subscription.resume', /resuming your plan .* Resume$/],
    'auto-reload': ['billing.auto_reload', /auto-reload .* Turn on$/]
  } as const

  it.each(cases)("%s needs the owner's click and is audited", (action, subject) => {
    const refused = lockWith({ gesture: false })
    const [tool, words] = TOOLS[action]
    const answer = refused.lock.authorizeAction({}, { action, subject, idempotencyKey: KEY })

    expect(answer).toEqual({ ok: false, error: BILLING_GESTURE_REFUSED[action] })
    expect(BILLING_GESTURE_REFUSED[action]).toMatch(words)
    expect(BILLING_GESTURE_REFUSED[action]).not.toBe(BILLING_CHARGE_REFUSED.gesture)
    expect(BILLING_GESTURE_REFUSED[action].startsWith('[billing-charge:gesture] ')).toBe(true)
    expect(BILLING_AUDIT_TOOL[action]).toBe(tool)
    expect(refused.entries).toEqual([
      { kind: 'refuse', reason: expect.stringContaining(tool), gesture: false, tool }
    ])
    expect(refused.lock.pendingCount()).toBe(0)

    const { lock, entries } = lockWith()
    const granted = lock.authorizeAction({}, { action, subject, idempotencyKey: KEY })

    expect(granted.ok).toBe(true)
    expect(entries).toEqual([{ kind: 'use', reason: expect.stringContaining(subject), gesture: true, tool }])
  })

  it('Buy keeps its own words and tool', () => {
    const { lock, entries } = lockWith({ gesture: false })

    expect(lock.authorizeAction({}, { action: 'charge', subject: '10', idempotencyKey: KEY })).toEqual({
      ok: false,
      error: '[billing-charge:gesture] a charge needs your own click on Buy'
    })
    expect(entries[0]?.tool).toBe('billing.charge')
  })

  it.each(cases)('a %s confirm is bound to its action, subject and key', (action, subject) => {
    const { lock } = lockWith()

    const fresh = () => {
      const granted = lock.authorizeAction({}, { action, subject, idempotencyKey: KEY })

      if (!granted.ok) {
        throw new Error('refused')
      }

      return granted.ownerConfirm
    }

    const otherAction = action === 'subscription-upgrade' ? 'subscription-change' : 'subscription-upgrade'

    expect(lock.consumeAction(fresh(), otherAction, subject, KEY)).toBe(false)
    expect(lock.consumeAction(fresh(), action, `${subject}x`, KEY)).toBe(false)
    expect(lock.consumeAction(fresh(), action, subject, 'key-0000-0002')).toBe(false)
    expect(lock.consume(fresh(), subject, KEY)).toBe(false)

    const token = fresh()

    expect(lock.consumeAction(token, action, subject, KEY)).toBe(true)
    expect(lock.consumeAction(token, action, subject, KEY)).toBe(false)
  })

  it('a Buy confirm cannot pay for an upgrade', () => {
    const { lock } = lockWith()
    const granted = lock.authorize({}, { amountUsd: '25', idempotencyKey: KEY })

    expect(granted.ok && lock.consumeAction(granted.ownerConfirm, 'subscription-upgrade', '25', KEY)).toBe(false)
  })

  it.each([
    ['refund', 'x'],
    ['subscription-upgrade', ''],
    ['subscription-upgrade', 'tier|pro'],
    ['subscription-upgrade', '-tier'],
    ['subscription-resume', 'tier_pro'],
    ['auto-reload', 'off|10|25'],
    ['auto-reload', 'on|10|0'],
    ['auto-reload', 'on|10|25.555'],
    ['auto-reload', 'on|10'],
    ['charge', '0']
  ])('%s with subject %j is not a valid request', (action, subject) => {
    const { lock, entries } = lockWith()

    expect(lock.authorizeAction({}, { action, subject, idempotencyKey: KEY })).toEqual({
      ok: false,
      error: BILLING_CHARGE_REFUSED.invalid
    })
    expect(entries).toEqual([])
  })
})

describe('registerBillingChargeLock', () => {
  it('registers both channels behind the sender guard; a refused sender gets null and no confirm', async () => {
    const handlers = new Map<string, (event: unknown, input: unknown) => unknown>()
    const ipcMain = { handle: vi.fn((channel: string, fn: never) => handlers.set(channel, fn)) }

    const lock = registerBillingChargeLock({
      ipcMain: ipcMain as never,
      isTrustedSender: () => false,
      gestureOk: () => true,
      audit: () => ({ id: 'r' })
    })

    expect([...handlers.keys()].sort()).toEqual(['iclone:billing:authorize-action', 'iclone:billing:authorize-charge'])

    const event = { sender: { id: 1 }, senderFrame: null }

    expect(
      await handlers.get('iclone:billing:authorize-action')?.(event, {
        action: 'subscription-upgrade',
        subject: 'tier_pro',
        idempotencyKey: KEY
      })
    ).toBeNull()
    expect(lock.pendingCount()).toBe(0)
  })
})
