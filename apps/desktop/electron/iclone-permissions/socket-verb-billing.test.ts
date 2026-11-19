/**
 * R-f1s-5 (v0.0.9, main side) — `perm billing`: the runtime spends main's single-use owner confirm before it charges.
 * Red on the old socket: `billing` was not a verb (usage, exit 64), so the runtime had nothing to ask.
 */
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createBillingChargeLock } from '../gesture-locks-billing'

import type { PermissionAuthority } from './authority'
import type { PolicySigner } from './policy-file'
import { permVerb, setBillingConfirmConsumer } from './socket-verb'

const key = Buffer.alloc(32, 9)
const keyId = 'k-billing'

type PermDeps = Parameters<typeof permVerb>[0]
type AuthorityUsed = 'currentGen' | 'seen' | 'spawnState'

/**
 * A typed fake of exactly what permVerb reads on the billing path: each member is checked against the real
 * PermissionAuthority / PolicySigner signature (Pick), and reading any other member throws, so the test fails if the
 * path starts to depend on something this fake does not model (stricter than the old untyped cast).
 */
function strictFake<T extends object, K extends keyof T>(name: string, used: Pick<T, K>): T {
  const handler: ProxyHandler<Pick<T, K>> = {
    get(target, prop, receiver) {
      if (prop in target || prop === 'then' || typeof prop === 'symbol') {
        return Reflect.get(target, prop, receiver)
      }

      throw new Error(`the billing path read ${name}.${String(prop)}, which this fake does not model`)
    }
  }

  return new Proxy(used, handler) as T
}

function billingDeps(pid: number, keyFor: PolicySigner['keyFor']): PermDeps {
  return {
    authority: strictFake<PermissionAuthority, AuthorityUsed>('authority', {
      currentGen: () => 1,
      // A whole spawn record, as mintSpawnKey + hello leave it (the billing path reads only its pid).
      spawnState: (id: string) => ({
        keyId: id,
        mintedAt: 0,
        pid,
        helloAt: 0,
        beatAt: null,
        reportedUnattested: false,
        reportedStale: false
      }),
      seen: () => undefined
    }),
    signer: strictFake<PolicySigner, 'keyFor'>('signer', { keyFor })
  }
}

// Only what permVerb reads on this path: the spawn key, the generation, the pid binding.
const deps = billingDeps(4242, id => (id === keyId ? key : null))

const signed = (payload: object, withKey = key) => {
  const text = JSON.stringify(payload)

  return ['billing', keyId, text, createHmac('sha256', withKey).update(`billing\n${text}`).digest('hex')]
}

async function billing(payload: object, withKey = key) {
  const result = await permVerb(deps, 'i01', signed(payload, withKey))

  if (result.code === 3) {
    return { code: 3, confirmed: false }
  }

  const envelope = JSON.parse(result.stdout) as { r: string }

  return { code: result.code, confirmed: (JSON.parse(envelope.r) as { confirmed?: boolean }).confirmed === true }
}

function lockWithOneConfirm() {
  const lock = createBillingChargeLock({ gestureOk: () => true, audit: () => ({ id: 'r1' }) })
  const granted = lock.authorize({}, { amountUsd: '25', idempotencyKey: 'key-0000-0001', gesture: {} })

  if (!granted.ok) {
    throw new Error('the fixture lock refused')
  }

  return { lock, token: granted.ownerConfirm }
}

afterEach(() => setBillingConfirmConsumer(null))

describe('perm billing — the runtime asks main before a charge', () => {
  it("confirms once for the exact amount and key main authorized on the owner's click; the second ask is refused", async () => {
    const { lock, token } = lockWithOneConfirm()

    setBillingConfirmConsumer((t, subject, k, action) => lock.consumeAction(t, action, subject, k))

    const payload = { pid: 4242, keyId, ownerConfirm: token, amountUsd: '25', idempotencyKey: 'key-0000-0001' }

    expect(await billing(payload)).toEqual({ code: 0, confirmed: true })
    expect(await billing(payload)).toEqual({ code: 1, confirmed: false })
  })

  it('another amount or key spends the confirm and is refused', async () => {
    for (const change of [{ amountUsd: '2500' }, { idempotencyKey: 'key-0000-0002' }]) {
      const { lock, token } = lockWithOneConfirm()

      setBillingConfirmConsumer((t, subject, k, action) => lock.consumeAction(t, action, subject, k))

      const base = { pid: 4242, keyId, ownerConfirm: token, amountUsd: '25', idempotencyKey: 'key-0000-0001' }

      expect(await billing({ ...base, ...change })).toEqual({ code: 1, confirmed: false })
      expect(await billing(base)).toEqual({ code: 1, confirmed: false })
    }
  })

  it('a made-up confirm, no consumer (lock not registered) or a request not signed by a spawn key: refused', async () => {
    const forged = { pid: 4242, keyId, ownerConfirm: 'a'.repeat(64), amountUsd: '25', idempotencyKey: 'key-0000-0001' }

    expect(await billing(forged)).toEqual({ code: 1, confirmed: false })

    const { lock, token } = lockWithOneConfirm()

    setBillingConfirmConsumer((t, subject, k, action) => lock.consumeAction(t, action, subject, k))

    const real = { ...forged, ownerConfirm: token }

    expect(await billing(real, Buffer.alloc(32, 1))).toEqual({ code: 3, confirmed: false })
    // The unsigned attempt did not reach the lock: the real runtime can still spend it.
    expect(await billing(real)).toEqual({ code: 0, confirmed: true })
  })

  it("a message naming another process's pid is refused", async () => {
    const { lock, token } = lockWithOneConfirm()

    setBillingConfirmConsumer((t, subject, k, action) => lock.consumeAction(t, action, subject, k))

    const result = await billing({ pid: 1, keyId, ownerConfirm: token, amountUsd: '25', idempotencyKey: 'key-0000-0001' })

    expect(result).toEqual({ code: 1, confirmed: false })
  })
})

describe('perm billing — upgrade / change / resume / auto-reload (v0.0.9 Q, lead decision 1)', () => {
  function lockWithAction(action: string, subject: string) {
    const lock = createBillingChargeLock({ gestureOk: () => true, audit: () => ({ id: 'r1' }) })
    const granted = lock.authorizeAction({}, { action, subject, idempotencyKey: 'key-0000-0009', gesture: {} })

    if (!granted.ok) {
      throw new Error('the fixture lock refused')
    }

    setBillingConfirmConsumer((t, s, k, a) => lock.consumeAction(t, a, s, k))

    return granted.ownerConfirm
  }

  it('confirms the exact action and subject once', async () => {
    const token = lockWithAction('subscription-upgrade', 'tier_pro')

    const payload = {
      pid: 4242,
      keyId,
      ownerConfirm: token,
      action: 'subscription-upgrade',
      subject: 'tier_pro',
      idempotencyKey: 'key-0000-0009'
    }

    expect(await billing(payload)).toEqual({ code: 0, confirmed: true })
    expect(await billing(payload)).toEqual({ code: 1, confirmed: false })
  })

  it('an upgrade confirm presented as a charge (no action) or as another action is refused', async () => {
    for (const change of [
      { action: undefined, amountUsd: 'tier_pro' },
      { action: 'subscription-change' },
      { subject: 'tier_max' }
    ]) {
      const token = lockWithAction('subscription-upgrade', 'tier_pro')

      const base = {
        pid: 4242,
        keyId,
        ownerConfirm: token,
        action: 'subscription-upgrade',
        subject: 'tier_pro',
        idempotencyKey: 'key-0000-0009'
      }

      expect(await billing({ ...base, ...change })).toEqual({ code: 1, confirmed: false })
    }
  })
})

describe('perm billing — the shared wire fixture (tests-perf 13)', () => {
  // The runtime's tests (tests/tui_gateway/test_billing_owner_confirm.py) assert channel.py sends exactly these bytes.
  const fixture = JSON.parse(
    readFileSync(path.resolve(__dirname, '../../../../tests/fixtures/perm_billing_wire.json'), 'utf8')
  ) as {
    keyHex: string
    keyId: string
    pid: number
    verb: string
    cases: { action: string; subject: string; ownerConfirm: string; idempotencyKey: string; text: string; mac: string }[]
  }

  it.each(fixture.cases.map(c => [c.action, c] as const))(
    'the %s line the runtime sends reaches the consumer field for field',
    async (_action, c) => {
      const seen: unknown[][] = []
      const wireKey = Buffer.from(fixture.keyHex, 'hex')

      const wireDeps = billingDeps(fixture.pid, id => (id === fixture.keyId ? wireKey : null))

      setBillingConfirmConsumer((...args) => {
        seen.push(args)

        return true
      })

      const result = await permVerb(wireDeps, 'i01', [fixture.verb, fixture.keyId, c.text, c.mac])

      expect(result.code).toBe(0)
      expect(seen).toEqual([[c.ownerConfirm, c.subject, c.idempotencyKey, c.action]])
    }
  )
})
