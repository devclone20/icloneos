import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import {
  agentRequestAllowed,
  beginOwnerHold,
  bindInstallTarget,
  cancelOwnerHold,
  compatGate,
  decideGate,
  type GateVerdict,
  installTarget,
  LAST_REFUSAL_FILE,
  MAX_TARGET_AGE_MS,
  mintOwnerAck,
  NO_VERDICT,
  publishGateVerdict,
  refreshInstallTarget
} from './gate'
import { readStoreJson, storeRoot, writeStoreJson } from './store'

const NOW = Date.parse('2026-10-07T12:00:00Z')
const at = (ms: number) => new Date(NOW - ms).toISOString()
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iclone-gate-'))

// The rev `hermes update` would install (the runtime's upstream); verdicts carry the abbreviated sha.
const INSTALL = '1ac3f97fbe0958aa2743c0c26202b20b3b4e760e'
const OTHER = '7f2271dee311144cb07aaed86090a122fefa2c1d'

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))
beforeEach(async () => {
  cancelOwnerHold()
  publishGateVerdict(null)
  bindInstallTarget(() => INSTALL)
  await refreshInstallTarget()
})

const verdict = (level: string, extra: Partial<GateVerdict> = {}): GateVerdict => ({
  id: `v-${level}`,
  level,
  computedAt: at(60_000),
  cards: [
    { root: 'server-requests', level: 'RED', names: ['clarify', 'sudo'] },
    { root: 'events', level: 'AMBER', names: ['clarify.expire'] }
  ],
  runtime: { to: INSTALL.slice(0, 11) },
  ...extra
})

const ownerAck = (v: GateVerdict, heldMs: number, names: string[] = ['clarify', 'sudo']) => ({
  verdictId: v.id ?? NO_VERDICT,
  by: 'owner',
  heldMs,
  names,
  at: at(1000)
})

// `v` is what main's producer published (and mirrored to pending.json for the renderer, as the glue does).
function userData(name: string, v: GateVerdict | null, ack: unknown) {
  const dir = path.join(tmp, name)
  const root = storeRoot(dir)
  publishGateVerdict(v)

  if (v) {
    writeStoreJson(root, 'pending.json', v)
  }

  if (ack) {
    writeStoreJson(root, 'ack.json', ack)
  }

  return { dir, audit: path.join(root, 'audit.jsonl'), ack: path.join(root, 'ack.json') }
}

// The owner's hold as main times it: begun `heldMs` before the mint, minted 1 s before the gate runs.
function hold(v: GateVerdict, heldMs: number, names: string[] = ['clarify', 'sudo']) {
  const { nonce } = beginOwnerHold(v.id ?? NO_VERDICT, NOW - 1000 - heldMs)

  return mintOwnerAck({ verdictId: v.id ?? NO_VERDICT, nonce, names }, NOW - 1000)
}

describe('iclone-compat gate', () => {
  it('P4a.gate.apply: RED is refused without an owner ack', () => {
    const u = userData('red-no-ack', verdict('RED'), null)
    expect(compatGate(u.dir, NOW)).toMatchObject({ ok: false, error: 'compat-gate', level: 'RED' })
    expect(fs.existsSync(u.audit)).toBe(false)
  })

  it('P4a.gate.apply: UNKNOWN (missing, stale or unknown level) is refused without an ack', () => {
    expect(compatGate(userData('none', null, null).dir, NOW)).toMatchObject({ level: 'UNKNOWN', verdictId: NO_VERDICT })
    const stale = verdict('GREEN', { computedAt: at(11 * 60_000) })
    expect(decideGate({ verdict: stale, ack: null, actor: 'owner', now: NOW })).toMatchObject({
      allow: false,
      level: 'UNKNOWN'
    })
    expect(decideGate({ verdict: verdict('PURPLE'), ack: null, actor: 'owner', now: NOW }).level).toBe('UNKNOWN')
  })

  it('P4a.gate.apply: an owner ack held 3 s naming every RED finding lets RED through', () => {
    const v = verdict('RED')
    const u = userData('red-ack', v, null)
    expect(hold(v, 3000)).toEqual({ ok: true, verdictId: 'v-RED', heldMs: 3000 })
    expect(compatGate(u.dir, NOW)).toBeNull()
    hold(v, 2999)
    expect(compatGate(u.dir, NOW)).toMatchObject({ ok: false, reason: 'hold-too-short' })
    const short = decideGate({ verdict: v, ack: ownerAck(v, 2999), actor: 'owner', now: NOW })
    expect(short).toMatchObject({ allow: false, reason: 'hold-too-short' })
    const unnamed = decideGate({ verdict: v, ack: ownerAck(v, 3000, ['clarify']), actor: 'owner', now: NOW })
    expect(unnamed).toMatchObject({ allow: false, reason: 'findings-not-named' })

    const other = decideGate({
      verdict: v,
      ack: { ...ownerAck(v, 3000), verdictId: 'v-old' },
      actor: 'owner',
      now: NOW
    })

    expect(other.allow).toBe(false)
  })

  it('P4a.gate.apply: each override writes exactly one audit line and the ack is single-use', () => {
    const v = verdict('UNKNOWN')
    const u = userData('audit', v, null)
    hold(v, 1500, [])
    expect(compatGate(u.dir, NOW)).toBeNull()
    expect(compatGate(u.dir, NOW)).toMatchObject({ ok: false, reason: 'owner-ack-required' })
    const lines = fs.readFileSync(u.audit, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toMatchObject({
      v: 1,
      by: 'owner',
      verdictId: 'v-UNKNOWN',
      level: 'UNKNOWN',
      heldMs: 1500
    })
  })

  it('P4a.gate.apply: the agent is refused on every non-GREEN level, even with an owner ack on disk', () => {
    for (const level of ['AMBER', 'RED', 'UNKNOWN']) {
      const v = verdict(level)
      expect(agentRequestAllowed(v, NOW)).toBe(false)
      expect(decideGate({ verdict: v, ack: ownerAck(v, 5000), actor: 'agent', now: NOW }).reason).toBe(
        'agent-non-green'
      )
    }

    expect(agentRequestAllowed(null, NOW)).toBe(false)
    expect(agentRequestAllowed(verdict('GREEN'), NOW)).toBe(true)
  })

  it('P4a.gate.apply: GREEN passes with no ack and no audit line', () => {
    const u = userData('green', verdict('GREEN'), null)
    expect(compatGate(u.dir, NOW)).toBeNull()
    expect(fs.existsSync(u.audit)).toBe(false)
  })

  it('P4a.gate.apply: a file-borne ack is never trusted; only the ack main minted for that verdict and nonce counts', () => {
    const v = verdict('RED')
    const u = userData('forged', v, ownerAck(v, 3000))
    expect(compatGate(u.dir, NOW)).toMatchObject({ ok: false, level: 'RED', reason: 'owner-ack-required' })
    expect(fs.existsSync(u.audit)).toBe(false)

    const { nonce } = beginOwnerHold(v.id ?? NO_VERDICT, NOW - 5000)
    expect(
      mintOwnerAck({ verdictId: v.id ?? NO_VERDICT, nonce: 'f'.repeat(32), names: ['clarify', 'sudo'] }, NOW)
    ).toEqual({ ok: false, reason: 'no-hold' })
    expect(mintOwnerAck({ verdictId: v.id ?? NO_VERDICT, nonce, names: ['clarify', 'sudo'] }, NOW)).toEqual({
      ok: false,
      reason: 'no-hold'
    })

    const other = beginOwnerHold('v-other', NOW - 5000)
    expect(mintOwnerAck({ verdictId: 'v-other', nonce: other.nonce, names: ['clarify', 'sudo'] }, NOW).ok).toBe(true)
    expect(compatGate(u.dir, NOW)).toMatchObject({ ok: false, reason: 'owner-ack-required' })
    expect(fs.existsSync(u.audit)).toBe(false)
  })

  it('P4a.x.r5.pending_forge: the gate reads only the verdict main produced; a file-forged GREEN is refused', () => {
    const green = verdict('GREEN')
    const forged = userData('forge-green', null, null)
    writeStoreJson(storeRoot(forged.dir), 'pending.json', green)
    expect(compatGate(forged.dir, NOW)).toMatchObject({ ok: false, level: 'UNKNOWN', verdictId: NO_VERDICT })

    const red = verdict('RED', { id: 'v-real' })
    const swapped = userData('forge-swap', red, null)
    writeStoreJson(storeRoot(swapped.dir), 'pending.json', { ...green, id: 'v-real' })
    expect(compatGate(swapped.dir, NOW)).toMatchObject({ ok: false, level: 'RED', verdictId: 'v-real' })

    const produced = { ...green, cards: [] }
    const u = userData('produced-green', produced, null)
    produced.level = 'RED'
    expect(compatGate(u.dir, NOW)).toBeNull()
    expect(fs.existsSync(u.audit)).toBe(false)
  })

  it('P4a.x.r5.target_bound: a verdict for any rev other than the install target is UNKNOWN', async () => {
    const green = verdict('GREEN', { runtime: { to: OTHER.slice(0, 11) } })
    const u = userData('other-rev', green, null)
    expect(compatGate(u.dir, NOW)).toMatchObject({ ok: false, level: 'UNKNOWN', reason: 'target-unbound' })

    bindInstallTarget(() => null)
    await refreshInstallTarget()
    publishGateVerdict(verdict('GREEN'))
    expect(compatGate(u.dir, NOW)).toMatchObject({ ok: false, level: 'UNKNOWN' })

    bindInstallTarget(() => {
      throw new Error('unreadable')
    })
    await refreshInstallTarget()
    expect(compatGate(u.dir, NOW)).toMatchObject({ ok: false, level: 'UNKNOWN' })

    bindInstallTarget(() => Promise.reject(new Error('offline')))
    await expect(refreshInstallTarget()).resolves.toBeNull()
    expect(compatGate(u.dir, NOW)).toMatchObject({ ok: false, level: 'UNKNOWN' })

    bindInstallTarget(() => OTHER)
    // Bound but not resolved yet: no answer, never the previous resolver's.
    expect(installTarget()).toBeNull()
    await refreshInstallTarget()
    publishGateVerdict(green)
    expect(compatGate(u.dir, NOW)).toBeNull()
  })

  it('V3-0: a refusal is persisted with time, level and the rev the update would install; a pass keeps the history', () => {
    const v = verdict('RED')
    const u = userData('refusal-record', v, null)
    const root = storeRoot(u.dir)
    expect(compatGate(u.dir, NOW)).toMatchObject({ ok: false, level: 'RED' })
    expect(readStoreJson(root, LAST_REFUSAL_FILE)).toEqual({
      v: 1,
      at: new Date(NOW).toISOString(),
      level: 'RED',
      reason: 'owner-ack-required',
      verdictId: 'v-RED',
      // main's resolved install target (full sha), not the verdict's abbreviation
      target: INSTALL
    })
    // A second refusal replaces the record (the last one is what the pane says), never appends.
    compatGate(u.dir, NOW + 5000)
    expect(readStoreJson<{ at: string }>(root, LAST_REFUSAL_FILE)?.at).toBe(new Date(NOW + 5000).toISOString())
    // A pass is not an install (the apply can still stop after the gate): the record stays as history.
    hold(v, 3000)
    expect(compatGate(u.dir, NOW)).toBeNull()
    expect(readStoreJson<{ at: string }>(root, LAST_REFUSAL_FILE)?.at).toBe(new Date(NOW + 5000).toISOString())
  })

  it('V3-0: with no verdict the refusal still names the install target main resolved', () => {
    const u = userData('refusal-none', null, null)
    compatGate(u.dir, NOW)
    expect(readStoreJson(storeRoot(u.dir), LAST_REFUSAL_FILE)).toMatchObject({
      level: 'UNKNOWN',
      verdictId: NO_VERDICT,
      target: INSTALL
    })
  })

  it('P4a.x.r6.install_tip: the gate reads the target main last resolved, and only while it is fresh', async () => {
    let calls = 0
    bindInstallTarget(async () => {
      calls += 1

      return OTHER
    })
    const [a, b] = await Promise.all([refreshInstallTarget(), refreshInstallTarget()])
    expect([a, b, calls]).toEqual([OTHER, OTHER, 1])
    expect(installTarget()).toBe(OTHER)
    expect(installTarget(Date.now() + MAX_TARGET_AGE_MS + 1)).toBeNull()
  })
})
