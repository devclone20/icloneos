// V3-F2 — per-function levels through main: persistence and signing (F2-8), raise/lower (F2-9), main's re-decision
// of an ask with the call's functions (F2-10, main half; the plugin half is pytest), the audit fields (F2-11).
import { createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type ConsentRecord, createConsentStore } from '../iclone-consent'
import { createConsentDoor, type DoorRequest } from '../iclone-consent-door'
import { BUNDLED_POLICY } from '../policy-version.generated'

import { type AuditRecord, createAuditLog, verifyAuditChain } from './audit'
import { createPermissionAuthority, parsePluginCall, type PermissionAuthority } from './authority'
import { type FunctionLevel, PERMISSION_FUNCTIONS, type PermissionFunction } from './functions'
import { type KeySealer, loadPermissionKeys } from './keys'
import { PERMISSION_MODES } from './modes'
import { createPolicySigner, type PolicySigner } from './policy-file'
import { permVerb } from './socket-verb'
import { createPermissionStore } from './store'
import { MATRIX_ACTIONS, MATRIX_EXPECTED } from './test-matrix'

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
let confirmRaise: ReturnType<typeof vi.fn<(request: unknown) => Promise<boolean>>>
const clock = Date.parse('2026-10-21T10:00:00.000Z')

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
    confirmIgnore: async () => true,
    confirmFunctionRaise: confirmRaise,
    keysSealed: keys.sealed,
    now: () => new Date(clock)
  })
  ;({ key, keyId } = authority.mintSpawnKey())
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'iclone-perm-f2-'))
  shown = []
  confirmRaise = vi.fn(async () => true)

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

const call = (
  action: keyof typeof MATRIX_ACTIONS,
  fns: PermissionFunction[],
  sessionId = 's1',
  extra: Record<string, unknown> = {}
) => ({
  pid: 4242,
  seq: (seq += 1),
  tool: { A1: 'write_file', A2: 'write_file', A3: 'terminal', A4: 'terminal' }[action],
  target: { A1: '/lab/proj/p.txt', A2: '/lab/out/p.txt', A3: 'ls -la', A4: 'placeholder-pay 0.01' }[action],
  cls: MATRIX_ACTIONS[action].cls,
  facts: MATRIX_ACTIONS[action].facts,
  floor: null,
  ceilingKey: null,
  project: '/lab/proj',
  agent: { inft: 'i01', profile: 'default', session_id: sessionId, subagent_id: null, task_id: 't1' },
  reason: 'probe',
  fns,
  // R4-UNREAD: a text call the plugin read carries its whole line as part 0 (a structured tool has no parts)
  parts: ['A3', 'A4'].includes(action)
    ? [{ cls: MATRIX_ACTIONS[action].cls, facts: MATRIX_ACTIONS[action].facts, floor: null, ceilingKey: null, fns }]
    : [],
  ...extra
})

async function send(verb: string, payload: object) {
  const text = JSON.stringify(payload)
  const argv = [verb, keyId, text, createHmac('sha256', key).update(`${verb}\n${text}`).digest('hex')]
  const result = await permVerb({ authority, signer }, 'i01', argv)
  const envelope = JSON.parse(result.stdout) as { r: string }

  return JSON.parse(envelope.r) as Record<string, unknown>
}

async function ask(payload: object, answerWith?: string) {
  const started = await send('ask', payload)

  if (started.state !== 'pending') {
    return started
  }

  const waiting = send('await', { askId: started.askId, pid: 4242 })

  if (answerWith) {
    await new Promise(resolve => setImmediate(resolve))
    expect(door.answer(shown.at(-1)?.id, answerWith)).toBe(true)
  }

  return waiting
}

const records = (): AuditRecord[] => audit.tail(0, 10_000)

const policyBody = () =>
  JSON.parse(JSON.parse(readFileSync(path.join(dir, 'permissions', 'policy', `${keyId}.json`), 'utf8')).body)

/** The user's click in the matrix: main's gesture verdict true; a raise also passes the native confirm (mocked). */
const userSets = (fn: PermissionFunction, level: FunctionLevel) => authority.setFunctionLevel({ fn, level }, true)

/** A fresh install with the Keychain off writes no sealed master (keys.ts), so the next sealed launch creates one. */
function freshInstallKeychainOff() {
  rmSync(path.join(dir, 'permissions', 'master.sealed'), { force: true })
  build(null)
}

describe('V3-F2 F2-8 — where the levels live', () => {
  it('functions.json is 0600, written only on a change, and every level reaches the signed policy', async () => {
    expect(policyBody().functions).toEqual(Object.fromEntries(PERMISSION_FUNCTIONS.map(fn => [fn, 'mode'])))
    expect(policyBody().fnGrants).toEqual([])

    expect(await userSets('email', 'ignore')).toMatchObject({ ok: true, raised: true })

    const file = path.join(dir, 'permissions', 'functions.json')

    expect(statSync(file).mode & 0o777).toBe(0o600)

    // A-1: the record is the `body` of an authenticated envelope (kid + HMAC under the state key, store.ts).
    const envelope = JSON.parse(readFileSync(file, 'utf8'))

    expect(envelope).toMatchObject({
      v: 2,
      kid: expect.stringMatching(/^[0-9a-f]{16}$/),
      mac: expect.stringMatching(/^[0-9a-f]{64}$/)
    })
    expect(envelope.body.levels.email).toBe('ignore')
    expect(policyBody().functions.email).toBe('ignore')
    expect(authority.levelOf('email')).toBe('ignore')
    expect(authority.state().functions.email).toBe('ignore')
  })

  it('a tampered or unreadable file is every row at Manual (A-1: narrower than the shipped `mode`), never a wider level', async () => {
    await userSets('payments', 'ignore')

    const file = path.join(dir, 'permissions', 'functions.json')

    // Before A-1 these landed on `mode` (follow the standing mode), which under Automatic is wider than a Manual the
    // user may have had. A refused file is now every function Manual, and the pane says so (store-integrity.test.ts).
    writeFileSync(file, JSON.stringify({ v: 1, levels: { payments: 'god-mode' }, updatedAt: 'x' }))
    expect(authority.state().functions.payments).toBe('manual')
    expect(authority.levelOf('payments')).toBe('manual')
    // a valid level under a key that is not a function: the whole file is tampered, not just that key
    writeFileSync(file, JSON.stringify({ v: 1, levels: { payments: 'ignore', root: 'ignore' }, updatedAt: 'x' }))
    expect(authority.state().functions.payments).toBe('manual')
    writeFileSync(file, JSON.stringify({ v: 2, levels: { payments: 'ignore' }, updatedAt: 'x' }))
    expect(authority.state().functions.payments).toBe('manual')
    writeFileSync(file, '{not json')
    expect(authority.state().functions.payments).toBe('manual')
    expect(authority.state().integrity).toEqual([{ file: 'functions', problem: 'tampered' }])
  })

  it('unsealed master key: the choice is stored, but only Manual / Ask always rows are published', async () => {
    // Owner's decision (2026-10-25): the Keychain switch and the matrix are independent — every cell stays clickable
    // and the choice is kept. The floor is unchanged and is what this row guards: nothing wider than Manual is ever
    // PUBLISHED while the key is unsealed, so an unsealed run still allows nothing more.
    build(null)
    expect(await userSets('shell', 'ignore')).toMatchObject({ ok: true })
    // The window sees the stored choice; what is IN FORCE is the pending level, Manual, and so is the published policy
    // (review r2, R2-M1: a pending row is Manual in every run; this row read 'mode' while the unsealed clamp applied).
    expect(authority.state().functions.shell).toBe('ignore')
    expect(authority.levelOf('shell')).toBe('manual')
    expect(policyBody().functions.shell).toBe('manual')
    expect(await userSets('shell', 'manual')).toMatchObject({ ok: true, raised: false })
    expect(policyBody().functions.shell).toBe('manual')
  })

  it('unsealed master key: a stored choice still needs the user’s own click', async () => {
    build(null)
    expect(await authority.setFunctionLevel({ fn: 'shell', level: 'ignore' }, false)).toMatchObject({
      ok: false,
      error: 'gesture'
    })
    expect(authority.levelOf('shell')).toBe('mode')
  })

  it('static: functions.json has one writer, reachable only from setFunctionLevel', () => {
    const read = (file: string) => readFileSync(path.join(__dirname, file), 'utf8')

    expect(read('store.ts').match(/writeFunctionLevel\(/g)).toHaveLength(1)
    expect(read('authority.ts').match(/writeFunctionLevel\(/g)).toHaveLength(1)
    expect(read('ipc.ts')).not.toContain('writeFunctionLevel')
    expect(read('socket-verb.ts')).not.toMatch(/setFunctionLevel|writeFunctionLevel|set-function-level/)
  })
})

describe('V3-F2 F2-9 — raising asks twice, lowering is immediate', () => {
  it('a raise without main’s gesture verdict is refused and audited; the level does not move', async () => {
    expect(await authority.setFunctionLevel({ fn: 'payments', level: 'ignore' }, false)).toMatchObject({
      ok: false,
      error: 'gesture'
    })
    expect(confirmRaise).not.toHaveBeenCalled()
    expect(authority.levelOf('payments')).toBe('mode')
    expect(records().at(-1)).toMatchObject({
      kind: 'fn_level_refused',
      fn: 'payments',
      level: 'ignore',
      gesture: false
    })
  })

  it('the native confirm sees the function and OLD → NEW; Cancel changes nothing', async () => {
    confirmRaise.mockResolvedValueOnce(false)
    expect(await userSets('trading', 'automatic')).toMatchObject({ ok: false, error: 'confirm' })
    expect(confirmRaise).toHaveBeenCalledWith({ fn: 'trading', from: 'mode', to: 'automatic' })
    expect(authority.levelOf('trading')).toBe('mode')
    expect(records().at(-1)).toMatchObject({ kind: 'fn_level_refused', prev_level: 'mode' })
  })

  it('a choice stored unsealed is NOT in force after a sealed restart until its raise is confirmed (review s4, M1)', async () => {
    // Fresh install, Keychain off: the matrix keeps the choice without a dialog (owner, 2026-10-25) — but storing a
    // choice is not authenticating it. With the Keychain on and the app restarted, the raise must still pass the
    // native old → new confirm before it is in force or signed into the policy.
    freshInstallKeychainOff()
    expect(await userSets('trading', 'automatic')).toMatchObject({ ok: true })
    expect(confirmRaise).not.toHaveBeenCalled()
    expect(records().at(-1)).toMatchObject({ kind: 'fn_level_set', fn: 'trading', level: 'automatic' })
    expect(records().at(-1)?.reason).toMatch(/^stored unconfirmed/)

    build(memorySealer()) // the next launch, Keychain on: the master is now sealed

    expect(authority.state()).toMatchObject({ sealed: true, unconfirmed: ['trading'] })
    expect(authority.state().functions.trading).toBe('automatic')
    expect(authority.levelOf('trading')).toBe('manual')
    authority.publish()
    expect(policyBody().functions.trading).toBe('manual')

    // Cancel on the dialog: still not in force, still pending.
    confirmRaise.mockResolvedValueOnce(false)
    expect(await userSets('trading', 'automatic')).toMatchObject({ ok: false, error: 'confirm' })
    expect(confirmRaise).toHaveBeenLastCalledWith({ fn: 'trading', from: 'manual', to: 'automatic' })
    expect(authority.levelOf('trading')).toBe('manual')
    expect(authority.state().unconfirmed).toEqual(['trading'])

    // Confirmed: in force, signed, and the audit names the dialog.
    expect(await userSets('trading', 'automatic')).toMatchObject({ ok: true, raised: true })
    expect(authority.levelOf('trading')).toBe('automatic')
    expect(policyBody().functions.trading).toBe('automatic')
    expect(authority.state().unconfirmed).toEqual([])
    expect(records().at(-1)).toMatchObject({ kind: 'fn_level_set', reason: 'raised: confirmed on the system dialog' })
  })

  it('a pending row acts as Manual in a sealed run, even under a looser standing mode (owner, review s4 r2)', async () => {
    // Lens 6 / critic B: the unsealed clamp sent a pending row to 'mode', which in a sealed run follows the standing
    // mode — an Ask once chosen with the Keychain off let a write through with no ask under Automatic.
    freshInstallKeychainOff()
    expect(await userSets('files', 'askOnce')).toMatchObject({ ok: true })
    build(memorySealer())
    expect(await authority.setMode({ scope: 'standing', mode: 'automatic' }, true)).toMatchObject({ ok: true })
    expect(authority.state().unconfirmed).toEqual(['files'])
    expect(authority.levelOf('files')).toBe('manual')

    const pendingWrite = await send('ask', call('A1', ['files']))

    expect(pendingWrite).toMatchObject({ state: 'decided', allowed: false })

    // Control: the same Ask once confirmed on the dialog is in force, and the same write now asks.
    expect(await userSets('files', 'askOnce')).toMatchObject({ ok: true, raised: true })
    expect(authority.state().unconfirmed).toEqual([])
    expect(await send('ask', call('A1', ['files']))).toMatchObject({ state: 'pending' })
  })

  it('unsealed: a raise the clamp does not cut (manual -> mode) or re-choosing a pending row stays unconfirmed (s4 r3)', async () => {
    // Critic B, round 2: sealed files=manual, then Keychain off and files=mode, then a sealed launch under Automatic let
    // the write through with confirmFunctionRaise called 0 times.
    expect(await userSets('files', 'manual')).toMatchObject({ ok: true })
    freshInstallKeychainOff()
    expect(await userSets('files', 'mode')).toMatchObject({ ok: true })
    expect(authority.state().unconfirmed).toEqual(['files'])
    // A pending row re-chosen as something other than Manual keeps its mark.
    expect(await userSets('payments', 'automatic')).toMatchObject({ ok: true })
    expect(await userSets('payments', 'mode')).toMatchObject({ ok: true })
    expect(authority.state().unconfirmed).toEqual(['files', 'payments'])

    build(memorySealer())
    expect(await authority.setMode({ scope: 'standing', mode: 'automatic' }, true)).toMatchObject({ ok: true })
    expect(authority.levelOf('files')).toBe('manual')
    expect(await send('ask', call('A1', ['files']))).toMatchObject({ state: 'decided', allowed: false })
    expect(confirmRaise).not.toHaveBeenCalled()

    // Confirming it is a raise from Manual through the dialog.
    expect(await userSets('files', 'mode')).toMatchObject({ ok: true, raised: true })
    expect(confirmRaise).toHaveBeenLastCalledWith({ fn: 'files', from: 'manual', to: 'mode' })
  })

  it('unsealed: re-choosing Follow mode over a confirmed Ask once stays unconfirmed (s4 r3, lens 9)', async () => {
    // The clamp shows a confirmed askOnce as 'mode' in an unsealed run, so 'mode' looked like no change and was stored
    // confirmed — then a sealed launch under Automatic let writes through with no ask and no dialog.
    expect(await userSets('files', 'askOnce')).toMatchObject({ ok: true })
    expect(authority.state().unconfirmed).toEqual([])
    freshInstallKeychainOff()
    expect(await userSets('files', 'mode')).toMatchObject({ ok: true })
    expect(authority.state().unconfirmed).toEqual(['files'])
    build(memorySealer())
    expect(await authority.setMode({ scope: 'standing', mode: 'automatic' }, true)).toMatchObject({ ok: true })
    expect(authority.levelOf('files')).toBe('manual')
    expect(await send('ask', call('A1', ['files']))).toMatchObject({ state: 'decided', allowed: false })
  })

  it('R2-M3: unsealed, re-choosing the SAME pending level keeps its mark (a repeated click is not a confirmation)', async () => {
    // The `|| wasUnconfirmed` clause: without it the second click stored the level confirmed, and the next sealed
    // launch put it in force with no dialog (the S1 class). The level chosen twice is the same, so `level !== stored`
    // cannot catch it.
    freshInstallKeychainOff()
    expect(await userSets('payments', 'automatic')).toMatchObject({ ok: true })
    expect(authority.state().unconfirmed).toEqual(['payments'])
    const again = await userSets('payments', 'automatic')

    expect(authority.state().unconfirmed).toEqual(['payments'])
    expect(again).toMatchObject({ ok: true, raised: false })

    build(memorySealer())
    expect(authority.levelOf('payments')).toBe('manual')
    expect(confirmRaise).not.toHaveBeenCalled()
  })

  it('R2-M1: unsealed, Manual -> Ask always is stored pending and NOT in force, as the audit says', async () => {
    // The unsealed clamp keeps Ask always, so this row went from refusing to asking in the same run while the audit
    // wrote "not in force". A pending row is Manual in every run: the audit and the gate now say the same thing.
    build(null)
    expect(await userSets('files', 'manual')).toMatchObject({ ok: true, raised: false })
    expect(await userSets('files', 'askAlways')).toMatchObject({ ok: true })
    expect(authority.state().unconfirmed).toEqual(['files'])
    expect(records().at(-1)).toMatchObject({ kind: 'fn_level_set', fn: 'files', level: 'askAlways' })
    expect(records().at(-1)?.reason).toMatch(/^stored unconfirmed: .*acts as Manual/)
    expect(authority.levelOf('files')).toBe('manual')
    expect(policyBody().functions.files).toBe('manual')
  })

  it('R2-M2 / R2-m3: unsealed, re-choosing the stored, confirmed level is a no-op: not a raise, no write, no revoke', async () => {
    // Sealed: Ask once on payments with a standing grant on the row, and Automatic on trading (confirmed raise).
    expect(await userSets('payments', 'askOnce')).toMatchObject({ ok: true })
    expect(await ask(call('A4', ['payments']), 'standing')).toMatchObject({ allowed: true })
    expect(authority.state().fnGrants).toHaveLength(1)
    expect(await userSets('trading', 'automatic')).toMatchObject({ ok: true, raised: true })

    // Next launch, Keychain off: each row is clamped in force, but re-choosing its stored level changes nothing.
    build(null)

    const file = path.join(dir, 'permissions', 'functions.json')
    const before = readFileSync(file, 'utf8')

    // R2-M2: `from` is the clamped 'mode', so Automatic used to come back as a raise, labelled "equal strictness".
    expect(await userSets('trading', 'automatic')).toMatchObject({ ok: true, raised: false })
    expect(records().at(-1)?.reason).toMatch(/^no change: /)
    // R2-m3: the same no-op used to revoke the row's grants.
    expect(await userSets('payments', 'askOnce')).toMatchObject({ ok: true, raised: false })
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(authority.state().fnGrants).toHaveLength(1)
    expect(authority.state().unconfirmed).toEqual([])
    expect(records().some(r => r.kind === 'revoke' && r.fn === 'payments')).toBe(false)
    expect(records().at(-1)).toMatchObject({ kind: 'fn_level_set', fn: 'payments', level: 'askOnce' })
    expect(records().at(-1)?.reason).toMatch(/^no change: /)
  })

  it('unsealed: a lower level clears the pending mark, so nothing is left to confirm after the restart', async () => {
    freshInstallKeychainOff()
    expect(await userSets('payments', 'automatic')).toMatchObject({ ok: true })
    expect(authority.state().unconfirmed).toEqual(['payments'])
    expect(await userSets('payments', 'manual')).toMatchObject({ ok: true })
    expect(authority.state().unconfirmed).toEqual([])
    build(memorySealer())
    expect(authority.levelOf('payments')).toBe('manual')
  })

  it('a dialog that was never shown refuses with its own reason, not as if the user had cancelled', async () => {
    // Both used to come back as `confirm`, and the matrix stays silent on `confirm` by design ("Keep the current
    // level"), so a raise that never reached a dialog looked exactly like a cell that does nothing — which is how
    // the owner met it in the Set up sheet.
    confirmRaise.mockRejectedValueOnce(new Error('no window to parent the dialog to'))

    const threw = await userSets('trading', 'automatic')

    expect(threw).toMatchObject({ ok: false, error: 'invalid' })
    expect(threw).not.toMatchObject({ error: 'confirm' })
    expect((threw as { message: string }).message).toMatch(/could not be shown/)
    expect(authority.levelOf('trading')).toBe('mode')
  })

  it('R2-m3: a level that moved while the dialog was open refuses the raise and keeps the moved level', async () => {
    // the owner confirms OLD → NEW, but another change lands while the native dialog is up
    confirmRaise.mockImplementationOnce(async () => {
      expect(await authority.setFunctionLevel({ fn: 'trading', level: 'manual' }, true)).toMatchObject({ ok: true })

      return true
    })

    const gen = signer.currentGen()

    expect(await userSets('trading', 'ignore')).toMatchObject({ ok: false, error: 'invalid' })
    expect(authority.levelOf('trading')).toBe('manual')
    expect(records().at(-1)).toMatchObject({ kind: 'fn_level_refused', fn: 'trading', level: 'ignore' })
    expect(records().filter(r => r.kind === 'fn_level_set' && r.level === 'ignore')).toEqual([])
    // only the lowering that landed during the dialog re-signed the policy
    expect(signer.currentGen()).toBe(gen + 1)
  })

  it('a confirmed raise writes, records old/new with the gesture, and re-signs the policy (gen+1)', async () => {
    const gen = signer.currentGen()

    expect(await userSets('shopping', 'automatic')).toMatchObject({ ok: true, raised: true })
    expect(records().at(-1)).toMatchObject({
      kind: 'fn_level_set',
      fn: 'shopping',
      level: 'automatic',
      prev_level: 'mode',
      gesture: true
    })
    expect(signer.currentGen()).toBeGreaterThan(gen)
  })

  it('a lowering applies at once — no dialog, even without a gesture — and is audited', async () => {
    await userSets('messaging', 'ignore')
    confirmRaise.mockClear()
    expect(await authority.setFunctionLevel({ fn: 'messaging', level: 'askAlways' }, false)).toMatchObject({
      ok: true,
      raised: false
    })
    expect(confirmRaise).not.toHaveBeenCalled()
    expect(records().at(-1)).toMatchObject({ kind: 'fn_level_set', level: 'askAlways', prev_level: 'ignore' })
  })

  it('R2-m5: as strict as the row is today applies at once; laxer under any mode in effect asks twice', async () => {
    await authority.setMode({ mode: 'manual', scope: 'standing' }, true)
    // Follow mode under Manual asks for everything: Ask once is not laxer — no dialog, no gesture needed
    expect(await authority.setFunctionLevel({ fn: 'shopping', level: 'askOnce' }, false)).toMatchObject({
      ok: true,
      raised: false
    })
    expect(confirmRaise).not.toHaveBeenCalled()
    // back to Follow mode under Manual: the same asks — still immediate
    expect(await authority.setFunctionLevel({ fn: 'shopping', level: 'mode' }, false)).toMatchObject({ raised: false })
    // a chat in Plan refuses spending: Ask once is laxer there, so it is a raise
    await authority.setMode({ mode: 'plan', scope: 'session', key: 's9' }, true)
    expect(await authority.setFunctionLevel({ fn: 'shopping', level: 'askOnce' }, false)).toMatchObject({
      ok: false,
      error: 'gesture'
    })
    expect(authority.levelOf('shopping')).toBe('mode')
  })

  it('unknown function or level is refused; changing a level revokes that function’s grants', async () => {
    expect(await authority.setFunctionLevel({ fn: 'everything', level: 'ignore' }, true)).toMatchObject({
      error: 'invalid'
    })
    await userSets('payments', 'askOnce')
    expect(await ask(call('A4', ['payments']), 'standing')).toMatchObject({ allowed: true })
    expect(authority.state().fnGrants).toHaveLength(1)
    await userSets('payments', 'askAlways')
    expect(authority.state().fnGrants).toEqual([])
    expect(records().some(r => r.kind === 'revoke' && r.fn === 'payments')).toBe(true)
  })
})

describe('V3-F2 F2-10 — main re-decides an ask with the call’s functions', () => {
  it('all rows at `mode`: the twenty V3-F cells, with the functions attached, are unchanged', async () => {
    for (const mode of PERMISSION_MODES) {
      await authority.setMode({ mode, scope: 'session', key: 's1' }, true)

      for (const action of Object.keys(MATRIX_ACTIONS) as (keyof typeof MATRIX_ACTIONS)[]) {
        const fns: PermissionFunction[] = action === 'A4' ? ['payments'] : action === 'A3' ? ['shell'] : ['files']
        const started = await send('ask', call(action, fns))
        const expected = MATRIX_EXPECTED[mode][action]

        if (expected === 'ask') {
          expect(started.state).toBe('pending')
          await new Promise(resolve => setImmediate(resolve))
          door.answer(shown.at(-1)?.id, 'deny')
        } else {
          expect(started).toMatchObject({ state: 'decided', allowed: expected === 'allow' })
        }
      }
    }
  })

  it('Payments at Ignore: a spend is allowed with no sheet, recorded as Payments', async () => {
    // a spend is decided by every money row (§4.5): the rest of the family at Ignore too
    for (const fn of ['payments', 'trading', 'shopping', 'acp'] as const) {
      await userSets(fn, 'ignore')
    }

    expect(await ask(call('A4', ['payments']))).toMatchObject({ state: 'decided', allowed: true })
    expect(shown.filter(Boolean)).toEqual([])
    expect(records().at(-1)).toMatchObject({ kind: 'use', fn: 'payments', level: 'ignore' })
  })

  it('Email at Manual is off: refused, and the refusal names the row', async () => {
    await userSets('email', 'manual')

    const refused = await ask(call('A3', ['email'], 's1', { cls: 'M', facts: {} }))

    expect(refused).toMatchObject({ allowed: false })
    expect(String(refused.reason)).toContain('email')
    expect(records().at(-1)).toMatchObject({ kind: 'refuse', fn: 'email', reason: expect.stringContaining('email') })
  })

  it('the strictest row decides: Email at Ignore + Shell at Manual on one line is refused', async () => {
    await userSets('email', 'ignore')
    await userSets('shell', 'manual')
    expect(await ask(call('A3', ['email', 'shell'], 's1', { cls: 'M', facts: {} }))).toMatchObject({ allowed: false })
  })

  it('Ask once: the sheet may remember for this function (spending too); the next spend is allowed by that grant', async () => {
    for (const fn of ['trading', 'shopping', 'acp'] as const) {
      await userSets(fn, 'ignore')
    }

    await userSets('payments', 'askOnce')
    expect(await ask(call('A4', ['payments']), 'session')).toMatchObject({ allowed: true })
    expect(shown.filter(Boolean).at(-1)?.permission?.scopes).toEqual(['once', 'session', 'project', 'standing'])
    expect(records().find(r => r.kind === 'grant')).toMatchObject({ fn: 'payments', scope: 'session' })
    expect(policyBody().fnGrants).toMatchObject([{ fn: 'payments', scope: 'session', sessionId: 's1' }])

    const before = shown.length

    expect(await ask(call('A4', ['payments']))).toMatchObject({ allowed: true })
    expect(shown.length).toBe(before)
    expect(records().at(-1)).toMatchObject({ kind: 'use', grant_id: expect.stringMatching(/^fg-/) })
    // Another chat is not covered.
    expect(await ask(call('A4', ['payments'], 's2'), 'deny')).toMatchObject({ allowed: false })
  })

  it('Ask always: once is the only scope, and a class grant does not lift it', async () => {
    await authority.setMode({ mode: 'manual', scope: 'standing' }, true)
    expect(await ask(call('A2', ['files']), 'standing')).toMatchObject({ allowed: true })
    await userSets('files', 'askAlways')

    const started = await send('ask', call('A2', ['files']))

    expect(started.state).toBe('pending')
    await new Promise(resolve => setImmediate(resolve))
    expect(shown.filter(Boolean).at(-1)?.permission?.scopes).toEqual(['once'])
  })

  it('R2-m4: Ask once and Ask always on one call — the sheet offers once only', async () => {
    await userSets('email', 'askOnce')
    await userSets('messaging', 'askAlways')

    const started = await send('ask', call('A3', ['email', 'messaging'], 's1', { cls: 'M', tool: 'send_message' }))

    expect(started.state).toBe('pending')
    await new Promise(resolve => setImmediate(resolve))
    expect(shown.filter(Boolean).at(-1)?.permission?.scopes).toEqual(['once'])
    door.answer(shown.at(-1)?.id, 'deny')
  })

  it('the plugin’s list is data: unknown names dropped, fixed order, capped', () => {
    const parsed = parsePluginCall({ ...call('A3', []), fns: ['shell', 'root', 'email', 'shell', 7] })

    // (a text call: the message family closes over the union, R3-MONO)
    expect(parsed?.fns).toEqual(['email', 'messaging', 'shell'])
    // a text tool always reaches at least the Shell row
    expect(parsePluginCall({ ...call('A3', []), fns: 'shell' })?.fns).toEqual(['shell'])
  })

  it('R2-m1: main re-applies the class coverage itself — the plugin’s list adds rows, never removes one', () => {
    const money = ['payments', 'trading', 'shopping', 'acp']

    // a money-class call that names one money row (or none) reaches every money row
    expect(parsePluginCall({ ...call('A4', ['payments']) })?.fns).toEqual(money)
    // none named: the text falls to Shell, so the message rows join for that part too
    expect(parsePluginCall({ ...call('A4', []) })?.fns).toEqual(PERMISSION_FUNCTIONS.slice(0, 7))
    // a message-class text call reaches both message rows; with a Shell part, the money rows too
    expect(parsePluginCall({ ...call('A3', ['email'], 's1', { cls: 'M' }) })?.fns).toEqual(['email', 'messaging'])
    expect(parsePluginCall({ ...call('A3', ['email', 'shell'], 's1', { cls: 'M' }) })?.fns).toEqual([
      'email',
      ...money,
      'messaging',
      'shell'
    ])
    // a structured message tool keeps its precise row; with another row named, both message rows join
    expect(parsePluginCall({ ...call('A3', ['email'], 's1', { cls: 'M', tool: 'send_message' }) })?.fns).toEqual([
      'email'
    ])
    expect(parsePluginCall({ ...call('A3', ['publish'], 's1', { cls: 'M', tool: 'send_message' }) })?.fns).toEqual([
      'email',
      'messaging',
      'publish'
    ])
    // R3-U: a structured tool the plugin sends with NO row is every function (the plugin never does; main fails closed)
    expect(parsePluginCall({ ...call('A3', [], 's1', { cls: 'M', tool: 'send_message' }) })?.fns).toEqual(
      PERMISSION_FUNCTIONS
    )
    expect(parsePluginCall({ ...call('A2', []) })?.fns).toEqual(PERMISSION_FUNCTIONS)
    expect(parsePluginCall({ ...call('A3', [], 's1', { tool: 'web_search', cls: 'N' }) })?.fns).toEqual([])
    // a write or delete always reaches Files; reading reaches nothing
    expect(parsePluginCall({ ...call('A2', ['publish']) })?.fns).toEqual(['files', 'publish'])
    expect(parsePluginCall({ ...call('A3', ['shell'], 's1', { cls: 'R' }) })?.fns).toEqual(['shell'])
  })

  it('R3-MONO: main covers each part on its own and takes the union — a message part beside a spend (C2-1)', () => {
    const parsed = parsePluginCall({
      ...call('A4', ['trading']),
      parts: [
        { cls: '$', facts: {}, floor: null, ceilingKey: null, fns: ['trading'] },
        { cls: 'M', facts: {}, floor: null, ceilingKey: null, fns: ['messaging'] }
      ]
    })

    expect(parsed?.fns).toEqual(PERMISSION_FUNCTIONS.slice(0, 6))
    expect(parsed?.parts?.map(part => part.fns)).toEqual([
      ['payments', 'trading', 'shopping', 'acp'],
      ['email', 'messaging']
    ])
  })

  it('R3-MONO: a part decides with its own class — the class another part gives the line never lowers it', async () => {
    for (const fn of PERMISSION_FUNCTIONS) {
      await userSets(fn, fn === 'shell' ? 'automatic' : 'ignore')
    }

    const parts = [
      { cls: 'X', facts: { dangerous: true }, floor: null, ceilingKey: null, fns: ['shell'] },
      { cls: '$', facts: {}, floor: null, ceilingKey: null, fns: ['payments'] }
    ]

    // alone the line's own class (`$`, Automatic's clean cell) would let Shell allow; the code part asks
    expect(await ask(call('A4', ['shell', 'payments']))).toMatchObject({ state: 'decided', allowed: true })
    expect((await send('ask', call('A4', ['shell', 'payments'], 's1', { parts }))).state).toBe('pending')
    await new Promise(resolve => setImmediate(resolve))
    expect(shown.filter(Boolean).at(-1)).toBeTruthy()
    door.answer(shown.at(-1)?.id, 'deny')
  })

  it('R3-MONO: parts that are missing, malformed or too many are unread — no user level allows a text call', async () => {
    expect(parsePluginCall({ ...call('A3', ['shell']), parts: undefined })?.parts).toBeNull()
    expect(parsePluginCall({ ...call('A3', ['shell']), parts: [{ cls: 'nope' }] })?.parts).toBeNull()
    expect(
      parsePluginCall({ ...call('A3', ['shell']), parts: Array(65).fill({ cls: 'X', fns: [] }) })?.parts
    ).toBeNull()

    await userSets('shell', 'ignore')
    expect(await ask(call('A3', ['shell']))).toMatchObject({ state: 'decided', allowed: true })
    expect((await send('ask', call('A3', ['shell'], 's1', { parts: null }))).state).toBe('pending')
    await new Promise(resolve => setImmediate(resolve))
    door.answer(shown.at(-1)?.id, 'deny')
    // a structured tool has no parts: nothing to read
    await userSets('files', 'ignore')
    expect(await ask(call('A2', ['files'], 's1', { parts: null }))).toMatchObject({ state: 'decided', allowed: true })
  })

  it('R4-UNREAD: a text call sent [] is unread — every user level asks, once only, and no grant lifts it', async () => {
    for (const fn of PERMISSION_FUNCTIONS) {
      await userSets(fn, 'ignore')
    }

    await userSets('shell', 'askOnce')
    // a grant for Shell, left by an Ask once sheet, lifts the read call …
    expect(await ask(call('A3', ['shell']), 'session')).toMatchObject({ allowed: true })
    expect(await ask(call('A3', ['shell']))).toMatchObject({ state: 'decided', allowed: true })

    // … never the unread one: it is asked, once only (a longer answer could not lift the next unread call)
    for (const parts of [[], null]) {
      const started = await send('ask', call('A3', ['shell'], 's1', { parts }))

      expect(started.state).toBe('pending')
      await new Promise(resolve => setImmediate(resolve))
      expect(shown.filter(Boolean).at(-1)?.permission?.scopes).toEqual(['once'])
      door.answer(shown.at(-1)?.id, 'deny')
    }

    // a row the call does not name, at Manual, refuses it
    await userSets('publish', 'manual')
    expect(await ask(call('A3', ['shell'], 's1', { parts: [] }))).toMatchObject({ state: 'decided', allowed: false })
  })

  it('R5-G: the plugin’s unread flag makes a read call unread — its parts stay, no user level allows it', async () => {
    expect(parsePluginCall({ ...call('A3', ['shell']), unread: true })?.unread).toBe(true)
    // only an explicit true is the plugin’s word (a plugin older than r5 sends nothing)
    expect(parsePluginCall({ ...call('A3', ['shell']), unread: 'true' })?.unread).toBe(false)
    expect(parsePluginCall(call('A3', ['shell']))?.unread).toBe(false)

    await userSets('shell', 'ignore')
    expect(await ask(call('A3', ['shell']))).toMatchObject({ state: 'decided', allowed: true })
    const started = await send('ask', call('A3', ['shell'], 's1', { unread: true }))

    expect(started.state).toBe('pending')
    await new Promise(resolve => setImmediate(resolve))
    expect(shown.filter(Boolean).at(-1)?.permission?.scopes).toEqual(['once'])
    door.answer(shown.at(-1)?.id, 'deny')
  })

  it('R2-m1: a plugin that drops a money row cannot loosen main’s decision', async () => {
    await userSets('payments', 'ignore')
    await userSets('trading', 'manual')
    expect(await ask(call('A4', ['payments']))).toMatchObject({ allowed: false })
    expect(records().at(-1)).toMatchObject({ kind: 'refuse', fn: 'trading' })
  })
})

describe('V3-F2 F2-11 — the audit chain carries the function, and old records keep their bytes', () => {
  it('a chain mixing V3-F records (no fn) and V3-F2 records verifies under the key', async () => {
    await authority.setMode({ mode: 'automatic', scope: 'standing' }, true)

    for (const fn of ['payments', 'trading', 'shopping', 'acp'] as const) {
      await userSets(fn, 'ignore')
    }

    await ask(call('A4', ['payments']))

    const all = records()
    const v3f = all.find(r => r.kind === 'mode_set') as AuditRecord

    expect(Object.hasOwn(v3f, 'fn')).toBe(false)
    expect(all.some(r => r.fn === 'payments')).toBe(true)
    expect(authority.state().chain.ok).toBe(true)
    expect(verifyAuditChain(path.join(dir, 'permissions', 'audit')).ok).toBe(true)
  })
})
