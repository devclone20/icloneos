/**
 * Review panel 2, MAJOR A-1 — the files that grant authority (mode.json, functions.json, grants.json, fn-grants.json)
 * are authenticated under the state key derived from the sealed master (keys.ts), so a well-formed edit is refused,
 * not honoured. Each of the critic's three proven consequences is closed here, each with a NEGATIVE case that the
 * pre-A-1 store (plain JSON, shape check only) fails:
 *   1. the pending (`unconfirmed`) mark cannot be deleted into "confirmed": the mark is required in an authenticated
 *      body, and a body nobody signed makes its loosening levels pending (with a signed base, every row it changed);
 *   2. a well-formed tamper that passes the shape check is refused: the narrowest reading, visible in `integrity()`;
 *   3. an offline edit putting payments and trading at Ignore shows no dialog AND yields no Ignore: Manual in force, the
 *      policy main signs says Manual, the ask is refused, and the launch writes an audit `gap` naming it.
 * Plus the upgrade rule (legacy `v: 1` is unverified, never accepted as written), the missing-sibling rule, and the
 * critic's own measurement over store.ts.
 */
import { createHmac } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { type AuditRecord, createAuditLog } from './audit'
import { createPermissionAuthority, parsePluginCall, type PermissionAuthority } from './authority'
import { type FunctionLevel, PERMISSION_FUNCTIONS, type PermissionFunction } from './functions'
import { integrityGapReason, registerPermissions } from './ipc'
import { type KeySealer, loadPermissionKeys, type PermissionKeys } from './keys'
import { createPolicySigner, type PolicySigner } from './policy-file'
import { createPermissionStore, type PermissionStore } from './store'

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

type Envelope = { v: 2; kid: string; mac: string; body: Record<string, unknown> }

let dir: string
let permissions: string
let sealer: KeySealer
let authority: PermissionAuthority
let store: PermissionStore
let signer: PolicySigner
let audit: ReturnType<typeof createAuditLog>
let keys: PermissionKeys
let keyId: string
let seq = 0
const clock = Date.parse('2026-10-28T10:00:00.000Z')

/** One launch: the same directory, the same sealer (the Keychain), a fresh main. `null` sealer = Keychain off. */
function launch(withSealer: KeySealer | null = sealer) {
  audit?.close()
  keys = loadPermissionKeys(permissions, withSealer)
  audit = createAuditLog({ dir: path.join(permissions, 'audit'), key: keys.auditKey, kid: keys.kid, durable: false })
  signer = createPolicySigner(permissions, keys, () => clock)
  store = createPermissionStore(permissions, keys, () => new Date(clock))
  authority = createPermissionAuthority({
    store,
    audit,
    signer,
    door: null,
    consent: () => null,
    paths: { userDataDir: dir, hermesHome: path.join(dir, 'hermes'), home: dir, hermesRoot: null },
    confirmIgnore: async () => true,
    confirmFunctionRaise: async () => true,
    keysSealed: keys.sealed,
    now: () => new Date(clock)
  })
  ;({ keyId } = authority.mintSpawnKey())
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'iclone-perm-a1-'))
  permissions = path.join(dir, 'permissions')
  sealer = memorySealer()
  seq = 0
  launch()
})

afterEach(() => {
  audit.close()
  rmSync(dir, { recursive: true, force: true })
})

const file = (name: string) => path.join(permissions, name)
const readEnvelope = (name: string): Envelope => JSON.parse(readFileSync(file(name), 'utf8')) as Envelope
const writeRaw = (name: string, value: unknown) => writeFileSync(file(name), `${JSON.stringify(value, null, 2)}\n`)

/** The user's click: main's gesture verdict true; a raise also passes the native confirm (mocked true). */
const userSets = (fn: PermissionFunction, level: FunctionLevel) => authority.setFunctionLevel({ fn, level }, true)

const userMode = (mode: string, scope = 'standing', key: string | null = null) =>
  authority.setMode({ mode, scope, key }, true)

const policyBody = () =>
  JSON.parse(JSON.parse(readFileSync(path.join(permissions, 'policy', `${keyId}.json`), 'utf8')).body) as {
    functions: Record<string, string>
    standing: string
    grants: unknown[]
    fnGrants: unknown[]
  }

const records = (): AuditRecord[] => audit.tail(0, 10_000)

/** A payment the agent attempts: class `$`, function payments. With a Manual level the answer is decided: refused. */
const payCall = () =>
  parsePluginCall({
    pid: 4242,
    seq: (seq += 1),
    tool: 'terminal',
    target: 'placeholder-pay 0.01',
    cls: '$',
    facts: {},
    floor: null,
    ceilingKey: null,
    project: '/lab/proj',
    agent: { inft: 'i01', profile: 'default', session_id: 's1', subagent_id: null, task_id: 't1' },
    reason: 'probe',
    fns: ['payments'],
    parts: [{ cls: '$', facts: {}, floor: null, ceilingKey: null, fns: ['payments'] }]
  })!

/** What the critic did: a well-formed edit of the body, written back under the envelope's own kid and mac. */
function editBody(name: string, edit: (body: Record<string, unknown>) => void) {
  const envelope = readEnvelope(name)

  edit(envelope.body)
  writeRaw(name, envelope)
}

/** An attacker who read the key would be the OS; this is the test holding the sealer: a MAC the store itself accepts. */
const validMac = (name: 'fnGrants' | 'functions' | 'grants' | 'mode', body: unknown) =>
  createHmac('sha256', keys.stateKey).update(`${name}\n`).update(JSON.stringify(body)).digest('hex')

describe('A-1 (2): a well-formed tamper is refused, not honoured — and lands on the narrowest reading', () => {
  it('functions.json: payments edited to Ignore under the real kid and mac ⇒ every function Manual, reported', async () => {
    expect(await userSets('payments', 'askOnce')).toMatchObject({ ok: true })
    expect(await userSets('shell', 'automatic')).toMatchObject({ ok: true, raised: true })
    expect(authority.state().integrity).toEqual([])

    editBody('functions.json', body => {
      ;(body.levels as Record<string, string>).payments = 'ignore'
    })

    // The shape is valid (the pre-A-1 validator passed it); the MAC is not.
    expect(authority.levelOf('payments')).toBe('manual')
    expect(authority.levelOf('shell')).toBe('manual')
    expect(authority.state().functions).toEqual(Object.fromEntries(PERMISSION_FUNCTIONS.map(fn => [fn, 'manual'])))
    expect(authority.state().integrity).toEqual([{ file: 'functions', problem: 'tampered' }])
    authority.publish()
    expect(policyBody().functions.payments).toBe('manual')
    expect(policyBody().functions.shell).toBe('manual')
  })

  it('a forged envelope (right kid, wrong mac), another key’s kid, and a re-MACed body under the wrong name are refused', async () => {
    await userSets('payments', 'askOnce')

    const good = readEnvelope('functions.json')

    writeRaw('functions.json', { ...good, mac: 'deadbeef'.repeat(8) })
    expect(authority.levelOf('payments')).toBe('manual')
    expect(authority.state().integrity).toEqual([{ file: 'functions', problem: 'tampered' }])

    writeRaw('functions.json', { ...good, kid: 'ffffffffffffffff', mac: validMac('functions', good.body) })
    expect(authority.state().integrity).toEqual([{ file: 'functions', problem: 'tampered' }])

    // Domain separation: a valid MAC computed as if for mode.json does not authenticate functions.json.
    writeRaw('functions.json', { ...good, mac: validMac('mode', good.body) })
    expect(authority.state().integrity).toEqual([{ file: 'functions', problem: 'tampered' }])

    // The real envelope back: verified again, nothing to report.
    writeRaw('functions.json', good)
    expect(authority.levelOf('payments')).toBe('askOnce')
    expect(authority.state().integrity).toEqual([])
  })

  it('mode.json: a project put at Ignore under the real kid and mac ⇒ Manual everywhere, reported', async () => {
    expect(await userMode('automatic')).toMatchObject({ ok: true })
    expect(store.effective({ project: '/lab/proj' })).toBe('automatic')

    editBody('mode.json', body => {
      ;(body.projects as Record<string, string>)['/lab/proj'] = 'ignore'
    })

    expect(store.effective({ project: '/lab/proj' })).toBe('manual')
    expect(authority.state().mode.standing).toBe('manual')
    expect(authority.state().integrity).toEqual([{ file: 'mode', problem: 'tampered' }])
    authority.publish()
    expect(policyBody().standing).toBe('manual')
  })

  it('grants.json and fn-grants.json: a planted standing grant is not matched', async () => {
    await userMode('automatic')
    expect(store.matchGrant('$', { project: '/lab/proj' })).toBeNull()

    const grants = readEnvelope('grants.json')

    writeRaw('grants.json', {
      ...grants,
      body: {
        v: 1,
        grants: [
          {
            id: 'g-planted',
            cls: '$',
            scope: 'standing',
            sessionId: null,
            project: null,
            createdAt: 'x',
            source: 'prompt'
          }
        ]
      }
    })
    editBody('fn-grants.json', body => {
      body.grants = [
        { id: 'fg-planted', fn: 'payments', scope: 'standing', sessionId: null, project: null, createdAt: 'x' }
      ]
    })

    expect(store.matchGrant('$', { project: '/lab/proj' })).toBeNull()
    expect(store.matchFnGrant('payments', { project: '/lab/proj' })).toBeNull()
    expect(authority.state().grants).toEqual([])
    expect(authority.state().fnGrants).toEqual([])
    expect(authority.state().integrity).toEqual([
      { file: 'grants', problem: 'tampered' },
      { file: 'fnGrants', problem: 'tampered' }
    ])
  })

  it('the critic’s measurement: store.ts now carries an HMAC (`grep -cE "hmac|createHmac|signature|mac\\b"` was 0)', () => {
    const source = readFileSync(path.join(__dirname, 'store.ts'), 'utf8')

    expect(source.match(/hmac|createHmac|signature|mac\b/g)?.length ?? 0).toBeGreaterThan(0)
    expect(source).toContain('timingSafeEqual')
    // Ruling 60: the comment promises what the code does — "tampered" is no longer claimed for a shape check alone.
    expect(source).not.toContain('unreadable or tampered ⇒ every function follows the mode')
  })
})

describe('A-1 (1): the pending mark cannot be deleted into "confirmed"', () => {
  async function pendingTradingVerified() {
    // Keychain off: two wider levels chosen, both pending. Keychain on: the user confirms payments only, so the
    // authenticated file carries `unconfirmed: ['trading']`.
    rmSync(file('master.sealed'), { force: true })
    launch(null)
    expect(await userSets('payments', 'automatic')).toMatchObject({ ok: true })
    expect(await userSets('trading', 'ignore')).toMatchObject({ ok: true })
    expect(authority.state().unconfirmed).toEqual(['payments', 'trading'])
    launch(sealer)
    expect(authority.state().unconfirmed).toEqual(['payments', 'trading'])
    expect(await userSets('payments', 'automatic')).toMatchObject({ ok: true, raised: true })
    expect(authority.state().unconfirmed).toEqual(['trading'])
    expect(readEnvelope('functions.json').body.unconfirmed).toEqual(['trading'])
    expect(authority.levelOf('trading')).toBe('manual')
    expect(authority.levelOf('payments')).toBe('automatic')
  }

  it('deleting `unconfirmed` from the authenticated body is a tamper: trading stays Manual (negative: was Ignore)', async () => {
    await pendingTradingVerified()

    editBody('functions.json', body => {
      delete body.unconfirmed
    })

    // Pre-A-1: the record stayed `v: 1`, the absent key read as "nothing pending", trading went Ignore in force.
    expect(authority.levelOf('trading')).toBe('manual')
    expect(authority.levelOf('payments')).toBe('manual')
    expect(authority.state().integrity).toEqual([{ file: 'functions', problem: 'tampered' }])
  })

  it('absence is distinguishable from empty: a validly MACed authenticated body WITHOUT the mark is refused', async () => {
    await pendingTradingVerified()

    const { body } = readEnvelope('functions.json')

    delete body.unconfirmed
    writeRaw('functions.json', { v: 2, kid: keys.kid, mac: validMac('functions', body), body })
    expect(authority.levelOf('trading')).toBe('manual')
    expect(authority.state().integrity).toEqual([{ file: 'functions', problem: 'tampered' }])

    // The same body WITH an empty mark is the honest encoding of "nothing pending": verified, trading in force.
    body.unconfirmed = []
    writeRaw('functions.json', { v: 2, kid: keys.kid, mac: validMac('functions', body), body })
    expect(authority.state().integrity).toEqual([])
    expect(authority.state().unconfirmed).toEqual([])
    expect(authority.levelOf('trading')).toBe('ignore')
  })

  it('a legacy `v: 1` body (mark deleted) beside verified siblings is a downgrade: refused, every function Manual', async () => {
    await pendingTradingVerified()

    const { body } = readEnvelope('functions.json')

    delete body.unconfirmed
    writeRaw('functions.json', body)
    // The sealed write that confirmed payments re-signed every sibling, so an unsigned file here replaced a signed one.
    // Pre-A-1 this exact file put trading at Ignore with no dialog.
    expect(authority.levelOf('trading')).toBe('manual')
    expect(authority.levelOf('payments')).toBe('manual')
    expect(authority.state().functions).toEqual(Object.fromEntries(PERMISSION_FUNCTIONS.map(fn => [fn, 'manual'])))
    expect(authority.state().integrity).toEqual([{ file: 'functions', problem: 'tampered' }])

    // The user's next click on that row re-signs the file; the finding clears, the other rows start from Manual.
    expect(await userSets('payments', 'automatic')).toMatchObject({ ok: true, raised: true })
    expect(authority.state().integrity).toEqual([])
    expect(authority.levelOf('payments')).toBe('automatic')
    expect(authority.levelOf('trading')).toBe('manual')
    expect(authority.state().unconfirmed).toEqual([])
  })

  it('every authenticated write carries the mark, `[]` included', async () => {
    await userSets('payments', 'askOnce')
    expect(readEnvelope('functions.json').body.unconfirmed).toEqual([])
  })
})

describe('A-1 (3): the offline edit — payments and trading at Ignore, no dialog — is Manual in force and recorded', () => {
  it('through the authority: the signed policy says Manual, the ask is refused, the finding is visible', async () => {
    expect(await userMode('automatic')).toMatchObject({ ok: true })
    expect(await userSets('payments', 'askOnce')).toMatchObject({ ok: true })

    const dialogsBefore = records().filter(r => r.kind === 'fn_level_set').length

    editBody('functions.json', body => {
      body.levels = { payments: 'ignore', trading: 'ignore' }
    })

    // Next launch, same Keychain.
    launch()
    expect(records().filter(r => r.kind === 'fn_level_set')).toHaveLength(dialogsBefore)
    expect(authority.levelOf('payments')).toBe('manual')
    expect(authority.levelOf('trading')).toBe('manual')
    expect(policyBody().functions.payments).toBe('manual')
    expect(policyBody().functions.trading).toBe('manual')
    expect(authority.state().integrity).toEqual([{ file: 'functions', problem: 'tampered' }])

    const asked = authority.ask(payCall(), 'i01')

    expect(asked).toMatchObject({ state: 'decided', allowed: false })
    expect((asked as { reason: string }).reason).toContain('payments level (manual)')
  })

  it('NEGATIVE: the pre-A-1 shape of that edit (a flat `v: 1` record) beside verified state is refused outright', async () => {
    expect(await userMode('automatic')).toMatchObject({ ok: true })

    // Exactly what the critic wrote: valid shape, loosening levels, no mark. The old store honoured it.
    writeRaw('functions.json', { v: 1, levels: { payments: 'ignore', trading: 'ignore' }, updatedAt: 'x' })
    launch()
    expect(authority.levelOf('payments')).not.toBe('ignore')
    expect(authority.levelOf('payments')).toBe('manual')
    expect(authority.levelOf('trading')).toBe('manual')
    expect(authority.state().functions.payments).toBe('manual')
    expect(policyBody().functions.payments).toBe('manual')
    expect(authority.state().integrity).toEqual([{ file: 'functions', problem: 'tampered' }])
    expect(authority.ask(payCall(), 'i01')).toMatchObject({ state: 'decided', allowed: false })
  })

  it('NEGATIVE: the same flat record with nothing verified beside it (an upgrade) is pending, never Ignore in force', () => {
    writeRaw('functions.json', { v: 1, levels: { payments: 'ignore', trading: 'ignore' }, updatedAt: 'x' })
    launch()
    expect(authority.state().functions).toMatchObject({ payments: 'ignore', trading: 'ignore' })
    expect(authority.state().unconfirmed).toEqual(['payments', 'trading'])
    expect(authority.levelOf('payments')).toBe('manual')
    expect(authority.levelOf('trading')).toBe('manual')
    expect(policyBody().functions.payments).toBe('manual')
    expect(authority.state().integrity).toEqual([{ file: 'functions', problem: 'unverified' }])
    expect(authority.ask(payCall(), 'i01')).toMatchObject({ state: 'decided', allowed: false })
  })

  it('through registerPermissions: the launch writes one audit `gap` per finding, so the chain says gaps > 0', async () => {
    audit.close()

    const home = mkdtempSync(path.join(os.tmpdir(), 'iclone-perm-a1-ipc-'))
    const keychain = memorySealer()

    const boot = () =>
      registerPermissions({
        ipcMain: { handle: () => undefined },
        isTrustedSender: () => true,
        userDataDir: home,
        paths: { hermesHome: path.join(home, 'hermes'), home, hermesRoot: null },
        door: null,
        consent: () => null,
        lastInputAt: () => 0,
        sealer: keychain,
        confirmIgnore: async () => false,
        confirmFunctionRaise: async () => true
      })

    try {
      const launched = boot()

      expect(launched.state().chain).toMatchObject({ ok: true, gaps: 0 })
      expect(await launched.setFunctionLevel({ fn: 'payments', level: 'askOnce' }, true)).toMatchObject({ ok: true })

      const target = path.join(home, 'permissions', 'functions.json')
      const envelope = JSON.parse(readFileSync(target, 'utf8')) as Envelope

      envelope.body.levels = { payments: 'ignore', trading: 'ignore' }
      writeFileSync(target, JSON.stringify(envelope))

      const relaunched = boot()
      const state = relaunched.state()

      expect(state.integrity).toEqual([{ file: 'functions', problem: 'tampered' }])
      expect(state.chain).toMatchObject({ ok: true, gaps: 1 })
      expect(relaunched.levelOf('payments')).toBe('manual')

      const gap = relaunched
        .tail(0, 10_000)
        .find(r => r.kind === 'gap' && r.reason?.startsWith('permission state integrity:'))

      expect(gap?.reason).toBe(integrityGapReason({ file: 'functions', problem: 'tampered' }))
      expect(gap?.reason).toContain('the function levels was changed or damaged outside icloneOS and is not in force')
      expect(gap?.reason).toContain('every function is Manual until chosen again')
      expect(gap?.reason).not.toMatch(/^audit integrity:/)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('A-1 upgrade rule: a legacy `v: 1` file is unverified — kept where safe, never in force as written', () => {
  it('functions: the choices are shown, every loosening level is pending until confirmed once', async () => {
    writeRaw('functions.json', {
      v: 1,
      levels: { payments: 'manual', trading: 'automatic', shell: 'askAlways' },
      updatedAt: '2026-10-20T00:00:00.000Z'
    })
    launch()
    expect(authority.state().functions).toMatchObject({ payments: 'manual', trading: 'automatic', shell: 'askAlways' })
    // Only the loosening level is pending: Manual, Ask always and the shipped Follow mode are never wider than the
    // default an absent file reads as, so honouring them unsigned loses nothing.
    expect(authority.state().unconfirmed).toEqual(['trading'])
    expect(authority.levelOf('payments')).toBe('manual')
    expect(authority.levelOf('trading')).toBe('manual')
    expect(authority.levelOf('shell')).toBe('askAlways')
    expect(authority.levelOf('email')).toBe('mode')
    expect(authority.state().integrity).toEqual([{ file: 'functions', problem: 'unverified' }])

    // One click confirms trading; the file is authenticated from now on, with the other rows as they were read.
    expect(await userSets('trading', 'automatic')).toMatchObject({ ok: true, raised: true })
    expect(authority.levelOf('trading')).toBe('automatic')
    expect(authority.levelOf('shell')).toBe('askAlways')
    expect(authority.state().unconfirmed).toEqual([])
    expect(authority.state().integrity).toEqual([])
    expect(readEnvelope('functions.json')).toMatchObject({ v: 2, kid: keys.kid })
  })

  it('declared bound (panel 4): with nothing verified left, a row the user turned off reads the shipped default', async () => {
    // Replacing all four files with legacy records, or deleting all four, leaves the store nothing to tell them from a
    // fresh install. Both routes reach the same bound: a row the user turned off reads Follow mode — never wider than
    // the shipped default, but its request asks instead of being refused. Measured here so the header's declaration is
    // a test, not a sentence; the Keychain-held "a sealed write has happened" fact that closes it is planned for v0.0.4.
    const updatedAt = '2026-10-20T00:00:00.000Z'

    const plantLegacy = (levels: Record<string, string>) => {
      writeRaw('mode.json', { v: 1, standing: 'automatic', projects: {}, sessions: {}, updatedAt })
      writeRaw('functions.json', { v: 1, levels, updatedAt })
      writeRaw('grants.json', { v: 1, grants: [] })
      writeRaw('fn-grants.json', { v: 1, grants: [] })
    }

    expect(await userSets('files', 'manual')).toMatchObject({ ok: true })
    expect(authority.levelOf('files')).toBe('manual')

    // Route 1, replace: the row left out reads the default and is not pending. The route is not silent — the four
    // legacy records are reported unverified — which is the contrast with route 2 below.
    plantLegacy({})
    launch()
    expect(
      authority
        .state()
        .integrity.map(f => `${f.file}:${f.problem}`)
        .sort()
    ).toEqual(['fnGrants:unverified', 'functions:unverified', 'grants:unverified', 'mode:unverified'])
    expect(authority.state().functions.files).toBe('mode')
    expect(authority.state().unconfirmed).not.toContain('files')
    expect(authority.state().mode.standing).toBe('manual')

    // The bound holds: the same route cannot plant anything wider than the default — a loosening level is pending.
    plantLegacy({ files: 'automatic' })
    launch()
    expect(authority.state().unconfirmed).toContain('files')
    expect(authority.levelOf('files')).toBe('manual')

    // Route 2, delete: the same reading, and not even a finding — which is why pending more rows on route 1 alone
    // would close nothing.
    for (const name of ['mode.json', 'functions.json', 'grants.json', 'fn-grants.json']) {
      rmSync(file(name), { force: true })
    }

    launch()
    expect(authority.state().functions.files).toBe('mode')
    expect(authority.levelOf('files')).toBe('mode')
    // "Never wider than the shipped default" rests on that default being Manual: measured on this route too.
    expect(authority.state().mode.standing).toBe('manual')
    expect(authority.state().unconfirmed).toEqual([])
    expect(authority.state().integrity).toEqual([])
  })

  it('mode and grants: no pending notion, so they fall to the narrowest reading and are reported', () => {
    writeRaw('mode.json', {
      v: 1,
      standing: 'automatic',
      projects: { '/lab/proj': 'ignore' },
      sessions: {},
      updatedAt: '2026-10-20T00:00:00.000Z'
    })
    writeRaw('grants.json', {
      v: 1,
      grants: [
        { id: 'g-old', cls: 'X', scope: 'standing', sessionId: null, project: null, createdAt: 'x', source: 'prompt' }
      ]
    })
    launch()
    expect(store.effective({ project: '/lab/proj' })).toBe('manual')
    expect(authority.state().mode.standing).toBe('manual')
    expect(store.matchGrant('X', { project: '/lab/proj' })).toBeNull()
    expect(authority.state().integrity).toEqual([
      { file: 'mode', problem: 'unverified' },
      { file: 'grants', problem: 'unverified' }
    ])
  })

  it('a legacy file planted later, beside verified state, is a downgrade (stateless: no "accept once" to replay)', async () => {
    await userMode('automatic')
    await userSets('payments', 'askOnce')
    writeRaw('functions.json', { v: 1, levels: { payments: 'ignore' }, updatedAt: 'x' })
    expect(authority.levelOf('payments')).toBe('manual')
    launch()
    expect(authority.levelOf('payments')).toBe('manual')
    expect(authority.state().integrity).toEqual([{ file: 'functions', problem: 'tampered' }])
  })

  it('the first sealed write re-signs every unverified sibling with its reading: the upgrade’s choices become trusted', async () => {
    writeRaw('functions.json', {
      v: 1,
      levels: { payments: 'manual', trading: 'automatic', shell: 'askAlways' },
      updatedAt: '2026-10-20T00:00:00.000Z'
    })
    writeRaw('mode.json', { v: 1, standing: 'automatic', projects: {}, sessions: {}, updatedAt: 'x' })
    launch()
    expect(authority.state().integrity).toEqual([
      { file: 'mode', problem: 'unverified' },
      { file: 'functions', problem: 'unverified' }
    ])

    // The user picks the mode again: mode.json is signed, and so is functions.json — as read, trading still pending.
    expect(await userMode('automatic')).toMatchObject({ ok: true })
    expect(authority.state().integrity).toEqual([])

    for (const name of ['mode.json', 'functions.json', 'grants.json', 'fn-grants.json']) {
      expect(readEnvelope(name), name).toMatchObject({ v: 2, kid: keys.kid })
    }

    expect(readEnvelope('functions.json').body).toMatchObject({
      levels: expect.objectContaining({ payments: 'manual', trading: 'automatic', shell: 'askAlways' }),
      unconfirmed: ['trading']
    })
    expect(authority.levelOf('trading')).toBe('manual')
    expect(authority.levelOf('shell')).toBe('askAlways')
    launch()
    expect(authority.state().unconfirmed).toEqual(['trading'])
    expect(authority.state().integrity).toEqual([])
  })
})

describe('A-1 Keychain off: an unsealed run signs nothing and verifies nothing, and never says more than it knows', () => {
  it('a choice made unsealed is written honestly unsealed, and the next sealed launch reads it as pending', async () => {
    rmSync(file('master.sealed'), { force: true })
    launch(null)
    expect(await userSets('payments', 'manual')).toMatchObject({ ok: true })
    expect(await userSets('trading', 'automatic')).toMatchObject({ ok: true })
    expect(JSON.parse(readFileSync(file('functions.json'), 'utf8'))).toMatchObject({ v: 2, unsealed: true })
    // Unsealed, nothing is materialised: a sibling it wrote could never be verified.
    expect(existsSync(file('mode.json'))).toBe(false)
    expect(authority.state().integrity).toEqual([])

    launch(sealer)
    expect(authority.state().functions).toMatchObject({ payments: 'manual', trading: 'automatic' })
    expect(authority.levelOf('trading')).toBe('manual')
    expect(authority.levelOf('payments')).toBe('manual')
    expect(authority.state().unconfirmed).toContain('trading')
    expect(authority.state().integrity).toEqual([{ file: 'functions', problem: 'unverified' }])
  })

  it('an unsealed run shows the stored state and reports nothing it cannot know; in force stays Manual', async () => {
    await userMode('automatic')
    await userSets('payments', 'askOnce')
    launch(null)
    expect(authority.state().sealed).toBe(false)
    expect(authority.state().mode.standing).toBe('automatic')
    expect(authority.state().functions.payments).toBe('askOnce')
    expect(authority.state().integrity).toEqual([])
    // In force: the unsealed clamp (askOnce → Follow mode) over a published Manual mode — nothing wider than Manual.
    expect(authority.levelOf('payments')).toBe('mode')
    expect(policyBody().standing).toBe('manual')
    expect(policyBody().functions.payments).toBe('mode')
  })
})

describe('A-1 missing sibling: a sealed write materialises all four, so a later absence is a deletion', () => {
  it('after a mode set, deleting functions.json is refused (every function Manual), not the shipped defaults', async () => {
    expect(await userMode('automatic')).toMatchObject({ ok: true })

    for (const name of ['mode.json', 'functions.json', 'grants.json', 'fn-grants.json']) {
      expect(existsSync(file(name)), name).toBe(true)
      expect(readEnvelope(name)).toMatchObject({ v: 2, kid: keys.kid })
    }

    expect(authority.state().integrity).toEqual([])
    expect(await userSets('payments', 'manual')).toMatchObject({ ok: true })
    expect(authority.levelOf('shell')).toBe('mode')

    rmSync(file('functions.json'))
    // Pre-A-1 (and with no sibling rule): absent ⇒ every function at `mode` ⇒ shell follows Automatic, payments too.
    expect(authority.levelOf('shell')).toBe('manual')
    expect(authority.levelOf('payments')).toBe('manual')
    expect(authority.state().integrity).toEqual([{ file: 'functions', problem: 'missing' }])

    rmSync(file('grants.json'))
    expect(authority.state().grants).toEqual([])
    expect(authority.state().integrity).toEqual([
      { file: 'grants', problem: 'missing' },
      { file: 'functions', problem: 'missing' }
    ])
  })

  it('a fresh install has no findings, sealed or not, and a sealed round trip verifies with none', async () => {
    expect(authority.state().integrity).toEqual([])
    expect(await userMode('automatic')).toMatchObject({ ok: true })
    expect(await userSets('payments', 'askOnce')).toMatchObject({ ok: true })
    launch()
    expect(authority.state().integrity).toEqual([])
    expect(authority.levelOf('payments')).toBe('askOnce')
    expect(store.effective({})).toBe('automatic')

    rmSync(dir, { recursive: true, force: true })
    launch(null)
    expect(authority.state().integrity).toEqual([])
  })
})

describe('A-1 the store refuses to start without the launch’s keys', () => {
  it('no keys, or a seal fact that is not a boolean, is a TypeError (R2-M4: never defaults to sealed)', () => {
    expect(() => createPermissionStore(permissions, undefined as never)).toThrow(TypeError)
    expect(() => createPermissionStore(permissions, { ...keys, sealed: undefined as never })).toThrow(TypeError)
  })
})
