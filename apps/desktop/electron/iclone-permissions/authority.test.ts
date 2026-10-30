import { createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { type ConsentRecord, createConsentStore } from '../iclone-consent'
import { createConsentDoor, type DoorRequest } from '../iclone-consent-door'
import { BUNDLED_POLICY } from '../policy-version.generated'

import { type AuditRecord, createAuditLog } from './audit'
import { ATTEST_MS, createPermissionAuthority, type PermissionAuthority } from './authority'
import { type KeySealer, loadPermissionKeys } from './keys'
import { PERMISSION_MODES, type PermissionMode } from './modes'
import { createPolicySigner, type PolicySigner } from './policy-file'
import { permVerb } from './socket-verb'
import { createPermissionStore } from './store'
import { MATRIX_ACTIONS, MATRIX_EXPECTED } from './test-matrix'

/** The OS sealing, in memory: reversible, and refusing anything it did not seal. */
const memorySealer = (): KeySealer => {
  const sealed = new Map<string, string>()

  return {
    seal: plain => {
      const token = `sealed-${sealed.size}`

      sealed.set(token, plain)

      return token
    },
    unseal: token => {
      const plain = sealed.get(token)

      if (plain === undefined) {
        throw new Error('not sealed here')
      }

      return plain
    }
  }
}

let dir: string
let shown: (DoorRequest | null)[]
let door: ReturnType<typeof createConsentDoor>
let authority: PermissionAuthority
let signer: PolicySigner
let audit: ReturnType<typeof createAuditLog>
let consent: ConsentRecord | null
let key: Buffer
let keyId: string
let seq = 0
let clock = Date.parse('2026-10-21T10:00:00.000Z')
let confirmAnswer = true

const ALL_ON = {
  terminal: true,
  fileWriting: true,
  webBrowsing: true,
  automation: true,
  screen: true,
  clipboard: true,
  installSoftware: true,
  scheduledTasks: true,
  sendMessages: true,
  spendTrade: true
}

function build(sealer: KeySealer | null = memorySealer()) {
  const permissions = path.join(dir, 'permissions')
  const keys = loadPermissionKeys(permissions, sealer)

  audit?.close()
  audit = createAuditLog({ dir: path.join(permissions, 'audit'), key: keys.auditKey, kid: keys.kid, durable: false })
  signer = createPolicySigner(permissions, keys, () => clock)
  authority = createPermissionAuthority({
    store: createPermissionStore(permissions, keys),
    audit,
    signer,
    door,
    consent: () => consent,
    paths: { userDataDir: dir, hermesHome: path.join(dir, 'hermes'), home: dir, hermesRoot: null },
    confirmIgnore: async () => confirmAnswer,
    keysSealed: keys.sealed,
    now: () => new Date(clock)
  })
  ;({ key, keyId } = authority.mintSpawnKey())
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'iclone-perm-'))
  shown = []
  confirmAnswer = true
  clock = Date.parse('2026-10-21T10:00:00.000Z')

  const consentStore = createConsentStore(path.join(dir, 'consent.json'))

  consentStore.accept({ version: BUNDLED_POLICY.version })
  consentStore.setPermissions({ permissions: ALL_ON })
  consent = consentStore.read()
  door = createConsentDoor({ store: consentStore, show: request => shown.push(request), userDataDir: dir })
  build()
  seq = 0
})

afterEach(() => {
  audit.close()
  rmSync(dir, { recursive: true, force: true })
})

const call = (action: keyof typeof MATRIX_ACTIONS, sessionId = 's1', extra: Record<string, unknown> = {}) => ({
  pid: 4242,
  seq: (seq += 1),
  tool: { A1: 'write_file', A2: 'write_file', A3: 'terminal', A4: 'acp' }[action],
  target: {
    A1: '/lab/proj/probe.txt',
    A2: '/lab/outside/probe.txt',
    A3: 'ls -la',
    A4: 'wallet send-transaction 0.01 USDC'
  }[action],
  cls: MATRIX_ACTIONS[action].cls,
  facts: MATRIX_ACTIONS[action].facts,
  floor: null,
  ceilingKey: null,
  project: '/lab/proj',
  agent: { inft: 'i01', profile: 'default', session_id: sessionId, subagent_id: null, task_id: 't1' },
  reason: 'probe',
  ...extra
})

const mac = (verb: string, text: string, withKey = key) =>
  createHmac('sha256', withKey).update(`${verb}\n${text}`).digest('hex')

const signed = (verb: string, payload: object, withKey = key, id = keyId) => {
  const text = JSON.stringify(payload)

  return [verb, id, text, mac(verb, text, withKey)]
}

const deps = () => ({ authority, signer })

/** Sends a signed verb and opens main's signed answer (it must verify, like the plugin requires). */
async function send(verb: string, payload: object, signal?: AbortSignal) {
  const argv = signed(verb, payload)
  const result = await permVerb(deps(), 'i01', argv, signal)
  const envelope = JSON.parse(result.stdout) as { r: string; sig: string }
  const expected = createHmac('sha256', key).update(`resp\n${argv[3]}\n${envelope.r}`).digest('hex')

  expect(envelope.sig).toBe(expected)

  return { code: result.code, body: JSON.parse(envelope.r) as Record<string, unknown> & { state?: string } }
}

/** The plugin's two phases: register the ask, then await the owner if it is on the sheet. */
async function ask(payload: object, answerWith?: string) {
  const started = await send('ask', payload)

  if (started.body.state !== 'pending') {
    return started.body
  }

  const waiting = send('await', { askId: started.body.askId, pid: 4242 })

  if (answerWith) {
    await answerFront(answerWith)
  }

  return (await waiting).body
}

/** Sets a mode the way the user does: main's gesture verdict true, Ignore confirmed on main's native dialog. */
const userSets = (
  mode: PermissionMode,
  scope: 'project' | 'session' | 'standing' = 'session',
  key: string | null = 's1'
) => authority.setMode({ mode, scope, key }, true)

const records = (): AuditRecord[] => audit.tail(0, 10_000)

async function answerFront(choice: string) {
  await new Promise(resolve => setImmediate(resolve))

  const front = shown.at(-1)

  expect(front?.permission).toBeTruthy()
  expect(door.answer(front?.id, choice)).toBe(true)
}

describe('V3-F matrix through main: 5 modes × 4 actions, every Q answered Deny then Allow once', () => {
  for (const mode of PERMISSION_MODES) {
    for (const action of Object.keys(MATRIX_ACTIONS) as (keyof typeof MATRIX_ACTIONS)[]) {
      const expected = MATRIX_EXPECTED[mode][action]

      it(`${mode} · ${action} → ${expected}`, async () => {
        expect(await userSets(mode)).toMatchObject({ ok: true })

        if (expected === 'allow') {
          expect(await ask(call(action))).toMatchObject({ state: 'decided', allowed: true })
          expect(shown.filter(Boolean)).toEqual([])
          expect(records().at(-1)).toMatchObject({ kind: 'use', mode })

          return
        }

        if (expected === 'refuse') {
          const refused = await ask(call(action))

          expect(refused).toMatchObject({ state: 'decided', allowed: false, code: 1 })
          expect(String(refused.reason)).toContain(mode)
          expect(shown.filter(Boolean)).toEqual([])
          expect(records().at(-1)).toMatchObject({ kind: 'refuse', mode, reason: expect.stringContaining(mode) })

          return
        }

        expect(await ask(call(action), 'deny')).toMatchObject({ state: 'decided', allowed: false })
        expect(
          records()
            .slice(-2)
            .map(r => [r.kind, r.answer])
        ).toEqual([
          ['ask', null],
          ['answer', 'deny']
        ])

        expect(await ask(call(action), 'once')).toMatchObject({ state: 'decided', allowed: true })
        expect(records().at(-1)).toMatchObject({
          kind: 'answer',
          answer: 'once',
          grant_id: expect.stringMatching(/^once-/),
          gesture: true
        })
        expect(shown.filter(Boolean).at(-1)?.permission?.scopes).toEqual(
          MATRIX_ACTIONS[action].cls === '$' ? ['once'] : ['once', 'session', 'project', 'standing']
        )
      })
    }
  }
})

describe('floor, ceilings, grants and lineage through main', () => {
  it('rm -rf ~ (floor) is refused in all five modes without a sheet', async () => {
    for (const mode of PERMISSION_MODES) {
      await userSets(mode)
      expect(await ask({ ...call('A3'), target: 'rm -rf ~', floor: 'hardline: delete home' })).toMatchObject({
        allowed: false
      })
      expect(records().at(-1)).toMatchObject({ kind: 'refuse', reason: expect.stringContaining('floor') })
    }

    expect(shown.filter(Boolean)).toEqual([])
  })

  it('a switch OFF refuses even in Ignore; a session grant lifts later asks of that class in that session only', async () => {
    consent = { ...(consent as ConsentRecord), permissions: { ...ALL_ON, fileWriting: false } }
    await userSets('ignore')
    expect(await ask(call('A1'))).toMatchObject({ allowed: false })

    consent = { ...(consent as ConsentRecord), permissions: ALL_ON }
    await userSets('manual')
    expect(await ask(call('A2'), 'session')).toMatchObject({ allowed: true })
    expect(records().some(r => r.kind === 'grant' && r.scope === 'session')).toBe(true)

    const before = shown.length

    expect(await ask(call('A2'))).toMatchObject({ allowed: true })
    expect(shown.length).toBe(before)
    expect(await ask(call('A2', 's2'), 'deny')).toMatchObject({ allowed: false })
  })

  it('F-16: a delegated child inherits its parent session’s mode and grants (lineage), not the standing mode', async () => {
    await userSets('plan', 'session', 'parent')
    await authority.setMode({ mode: 'automatic', scope: 'standing' }, true)
    expect(await ask(call('A1', 'child', { lineage: ['child', 'parent'] }))).toMatchObject({ allowed: false })
    expect(records().at(-1)).toMatchObject({ kind: 'refuse', mode: 'plan' })
    expect(await ask(call('A1', 'child'))).toMatchObject({ allowed: true })
  })

  it('Allow once is one call: a retry asks again, unless the plugin had stopped waiting (then the retry consumes it)', async () => {
    await userSets('manual')
    expect(await ask(call('A2'), 'once')).toMatchObject({ allowed: true })
    expect(await ask(call('A2'), 'deny')).toMatchObject({ allowed: false })

    // The plugin registers, then stops waiting before the owner answers.
    const started = await send('ask', call('A2'))
    const gaveUp = new AbortController()
    const waiting = send('await', { askId: started.body.askId, pid: 4242 }, gaveUp.signal)

    gaveUp.abort()
    expect((await waiting).body).toMatchObject({ state: 'unknown' })
    await answerFront('once')
    await new Promise(resolve => setImmediate(resolve))

    const shownBefore = shown.length

    expect(await ask(call('A2'))).toMatchObject({ allowed: true })
    expect(shown.length).toBe(shownBefore)
    expect(records().at(-1)).toMatchObject({ kind: 'use', grant_id: 'once-late' })
    expect(await ask(call('A2'), 'deny')).toMatchObject({ allowed: false })
  })

  it('two identical calls waiting on one sheet: an Allow once lets exactly one through', async () => {
    await userSets('manual')

    const a = await send('ask', call('A2'))
    const b = await send('ask', call('A2'))

    expect(b.body.askId).toBe(a.body.askId)

    const first = send('await', { askId: a.body.askId, pid: 4242 })
    const second = send('await', { askId: b.body.askId, pid: 4242 })

    await answerFront('once')

    const outcomes = [(await first).body.state, (await second).body.state].sort()

    expect(outcomes).toEqual(['decided', 'unknown'])
    // and each call has its own decision record
    expect(records().filter(r => r.kind === 'ask')).toHaveLength(2)
  })

  it('a Hermes approval relayed by the window is answered on the same sheet, once only, and audited by main', async () => {
    const relayed = authority.hermesApproval(
      { command: 'rm -rf build', description: 'recursive delete', sessionId: 's1' },
      'i01'
    )

    await new Promise(resolve => setImmediate(resolve))
    expect(shown.at(-1)?.permission).toMatchObject({ cls: 'X', scopes: ['once'], target: 'rm -rf build' })
    expect(door.answer(shown.at(-1)?.id, 'standing')).toBe(false)
    expect(door.answer(shown.at(-1)?.id, 'once')).toBe(true)
    expect(await relayed).toBe('once')
    expect(
      records()
        .slice(-2)
        .map(r => [r.src, r.kind, r.src_seq])
    ).toEqual([
      ['main', 'ask', null],
      ['door', 'answer', null]
    ])
  })

  it('a revoke without a gesture is refused and recorded; with one it removes the grant', async () => {
    await userSets('manual')
    await ask(call('A2'), 'standing')

    const grant = authority.state().grants[0]

    expect(authority.revoke(grant.id, false)).toBe(false)
    expect(authority.state().grants).toHaveLength(1)
    expect(authority.revoke(grant.id, true)).toBe(true)
    expect(authority.state().grants).toHaveLength(0)
  })

  it('every decision is in the chain, recorded once, and the chain verifies', async () => {
    await userSets('automatic')
    await ask(call('A1'))

    const event = { ...call('A3'), mode: 'automatic', outcome: 'allow' }

    await send('event', event)
    await send('event', event)
    expect(records().filter(r => r.kind === 'use')).toHaveLength(2)
    expect(authority.state().chain).toMatchObject({ ok: true, gaps: 0 })
  })
})

describe('F-5 · F-7 · F-11 · F-12: generations, attestation, heartbeats and replays', () => {
  it('every publish carries a strictly newer generation, and main reports it on every signed answer', async () => {
    const policyFile = () =>
      JSON.parse(JSON.parse(readFileSync(path.join(dir, 'permissions', 'policy', `${keyId}.json`), 'utf8')).body)

    const before = policyFile().gen

    await userSets('automatic', 'standing', null)

    const after = policyFile().gen

    expect(after).toBeGreaterThan(before)
    expect((await send('beat', { pid: 4242, hi: 0 })).body.gen).toBe(after)

    // a restart cannot go back in time even with the clock behind
    clock -= 86_400_000
    build()
    expect(policyFile().gen).toBeGreaterThan(after)
  })

  it('a spawn that never attests is "not enforced" after ATTEST_MS, with a gap record; hello + beats make it enforced', async () => {
    expect(authority.state().enforcement).toBe('starting')
    clock += ATTEST_MS
    authority.checkSpawns()
    expect(authority.state().enforcement).toBe('not-enforced')
    expect(records().at(-1)).toMatchObject({ kind: 'gap', reason: expect.stringContaining('never attested') })

    authority.spawned(keyId, 4242)
    expect((await send('hello', { pid: 4242, hi: 0 })).body).toMatchObject({ attested: true })
    expect(authority.state().enforcement).toBe('enforced')
    // another pid presenting the same key is not that process
    expect((await send('hello', { pid: 9999, hi: 0 })).code).toBe(1)

    clock += 16_000
    expect(authority.state().enforcement).toBe('not-enforced')
    authority.checkSpawns()
    expect(records().at(-1)).toMatchObject({ kind: 'gap', reason: expect.stringContaining('stopped answering') })
    await send('beat', { pid: 4242, hi: 0 })
    expect(authority.state().enforcement).toBe('enforced')
    authority.exited(keyId)
    expect(authority.state().enforcement).toBe('no-agent')
  })

  it('a heartbeat that says more was allocated than arrived writes a gap for exactly that range', async () => {
    authority.spawned(keyId, 4242)
    await send('hello', { pid: 4242, hi: 0 })
    await send('event', { ...call('A3'), seq: 1, mode: 'manual', outcome: 'refuse' })
    await send('beat', { pid: 4242, hi: 4 })
    expect(records().at(-1)).toMatchObject({
      kind: 'gap',
      reason: 'plugin events 2..4 from pid 4242 were allocated but never arrived'
    })
  })

  it('a dead Hermes’s log replays through a live one under the dead key: recorded once; a forged line is a gap', async () => {
    const dead = authority.mintSpawnKey()

    authority.exited(dead.keyId)

    const payload = JSON.stringify({
      ...call('A3'),
      seq: 1,
      pid: 777,
      keyId: dead.keyId,
      mode: 'manual',
      outcome: 'refuse'
    })

    const line = { keyId: dead.keyId, verb: 'event', payload, mac: mac('event', payload, dead.key) }

    expect((await send('replay', line)).code).toBe(0)
    expect((await send('replay', line)).code).toBe(0)
    expect(records().filter(r => r.hermes_pid === 777)).toHaveLength(1)

    const forged = { ...line, payload: payload.replace('"refuse"', '"allow"') }

    expect((await send('replay', forged)).code).toBe(1)
    expect(records().at(-1)).toMatchObject({ kind: 'gap', reason: expect.stringContaining('could not be verified') })
  })

  it('a retired key cannot ask, attest or send events directly — only inside a replay', async () => {
    const old = { key, keyId }

    authority.exited(keyId)
    expect((await permVerb(deps(), 'i01', signed('ask', call('A1'), old.key, old.keyId))).code).toBe(3)
    expect((await permVerb(deps(), 'i01', signed('hello', { pid: 4242, hi: 0 }, old.key, old.keyId))).code).toBe(3)
  })

  it('without a sealed key the authority runs Manual only and says so', async () => {
    rmSync(path.join(dir, 'permissions'), { recursive: true, force: true })
    build(null)
    await authority.setMode({ mode: 'automatic', scope: 'standing' }, true)
    expect(authority.state().enforcement).toBe('degraded')

    const started = await send('ask', call('A1'))

    expect(started.body).toMatchObject({ state: 'pending' })

    const policy = JSON.parse(
      JSON.parse(readFileSync(path.join(dir, 'permissions', 'policy', `${keyId}.json`), 'utf8')).body
    )

    expect([policy.standing, policy.grants]).toEqual(['manual', []])
  })
})

describe('LOCK PROBES: nothing but the user gesture sets the mode', () => {
  const standing = () => authority.state().mode.standing

  it('set-mode without a gesture (devtools call, synthetic click) is refused and recorded as mode_refused', async () => {
    expect(await authority.setMode({ mode: 'automatic', scope: 'standing' }, false)).toMatchObject({
      ok: false,
      error: 'gesture'
    })
    expect(standing()).toBe('manual')
    expect(records().at(-1)).toMatchObject({ kind: 'mode_refused', gesture: false })
  })

  it('F-17: Ignore needs main’s native confirm, may not be standing, and a declined dialog changes nothing', async () => {
    confirmAnswer = false
    expect(await userSets('ignore')).toMatchObject({ ok: false, error: 'confirm' })
    expect(authority.state().mode.sessions).toEqual({})
    expect(await userSets('ignore', 'standing', null)).toMatchObject({ ok: false, error: 'invalid' })
    confirmAnswer = true
    expect(await userSets('ignore')).toMatchObject({ ok: true })
    expect(standing()).toBe('manual')
  })

  it('the agent socket has no set verb, and a message without the spawn key is refused unsigned', async () => {
    expect((await permVerb(deps(), 'i01', ['set', keyId, '{"mode":"ignore"}', 'x'])).code).toBe(64)

    const forged = await permVerb(deps(), 'i01', signed('ask', call('A1'), Buffer.alloc(32, 7)))

    expect(forged.code).toBe(3)
    expect(JSON.parse(forged.stdout)).not.toHaveProperty('sig')
    expect(standing()).toBe('manual')
  })

  it('the policy main signs is what the plugin verifies; an edited body no longer matches its signature', async () => {
    await userSets('automatic', 'standing', null)

    const file = JSON.parse(readFileSync(path.join(dir, 'permissions', 'policy', `${keyId}.json`), 'utf8'))
    const ok = createHmac('sha256', key).update(file.body).digest('hex') === file.sig
    const tampered = file.body.replace('"standing":"automatic"', '"standing":"ignore"')

    expect(ok).toBe(true)
    expect(JSON.parse(file.body).standing).toBe('automatic')
    expect(createHmac('sha256', key).update(tampered).digest('hex')).not.toBe(file.sig)
  })
})

describe('liveness (soak r2)', () => {
  it('a busy gate that never idles stays enforced: every signed message counts; a goodbye ends the spawn', async () => {
    authority.spawned(keyId, 4242)
    await send('hello', { pid: 4242, hi: 0 })

    for (let i = 0; i < 4; i += 1) {
      clock += 6_000
      await send('event', { ...call('A3'), mode: 'manual', outcome: 'refuse' })
    }

    authority.checkSpawns()
    expect(authority.state().enforcement).toBe('enforced')
    expect(records().some(r => r.kind === 'gap')).toBe(false)
    await send('bye', { pid: 4242, hi: seq })
    expect(authority.state().enforcement).toBe('no-agent')
  })
})
