import fs, { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'

import { profileSlugFor } from '../src/iclone-shared/inft-slug'

import { type CommandRunner, createDeactivationDoor, createOwnershipService } from './iclone-ownership'
import type { ProofResult } from './iclone-ownership-proof'
import { BUNDLED_REGISTRY } from './iclone-ownership-registry'
import { readRecord } from './iclone-ownership-store'

const OWNER = '0x' + 'a1'.repeat(20)
const BUYER = '0x' + 'b7'.repeat(20)
const C = BUNDLED_REGISTRY.entries[0].contract

const ITEM = {
  id: `robinhood:${C}:7`,
  chain: 'Robinhood',
  contract: C,
  tokenId: '7',
  name: 'i01 #7',
  image: null,
  configured: true
}

const SLUG = `robinhood-${C}-7`
const PROFILE = profileSlugFor(C, '7')
const T0 = 1_800_000_000_000
const TX = { A: 'cd', B: 'ef' } as const

const lostProof = (now: number, tx: string, block: number): ProofResult => ({
  verdict: 'lost',
  verifications: [],
  reason: 'agree',
  agentStatus: null,
  transfer: {
    txHash: '0x' + tx.repeat(32),
    block,
    from: OWNER,
    to: BUYER,
    timestamp: now / 1000 - 60,
    explorerUrl: 'https://x/tx'
  },
  head: { number: block + 30, timestamp: now / 1000 }
})

const heldProof = (now: number, block: number): ProofResult => ({
  verdict: 'held',
  verifications: [],
  transfer: null,
  head: { number: block, timestamp: now / 1000 },
  agentStatus: null,
  reason: 'held'
})

/** Deterministic PRNG (mulberry32): a failing seed replays exactly. */
function prng(seed: number) {
  let a = seed >>> 0

  return (n: number) => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n)
  }
}

const ticks = async (n: number) => {
  for (let i = 0; i < n; i += 1) {
    await new Promise<void>(r => setImmediate(r))
  }
}

/** A promise the test opens by hand, plus one that says the code reached it. */
function gate() {
  let open!: () => void
  let reached!: () => void
  const hold = new Promise<void>(r => (open = r))
  const at = new Promise<void>(r => (reached = r))

  return { hold, at, open: () => open(), reached: () => reached() }
}

let root = ''

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'r9r6-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

type World = 'A' | 'held' | 'B'

/** The production door over a fake CLI. Every external await (verify, CLI, archive) takes `delay()` macrotasks;
 *  `gates` blocks the next call of that kind until the test opens it. The proof is taken when verify is CALLED. */
function harness(delay: () => number = () => 0) {
  const clock = { now: T0 }
  const world = { at: 'held' as World }
  const calls: string[][] = []
  const gates: { verify?: ReturnType<typeof gate>; update?: ReturnType<typeof gate> } = {}

  const pass = async (kind: 'verify' | 'update') => {
    const g = gates[kind]

    if (g) {
      gates[kind] = undefined
      g.reached()
      await g.hold
    }

    await ticks(delay())
  }

  const run: CommandRunner = async (_bin, args) => {
    calls.push(args)

    if (args.includes('update')) {
      await pass('update')
    } else {
      await ticks(delay())
    }

    return { code: 0, stdout: args.includes('whoami') ? '{"data":{"name":"iCLONE Original"}}' : '{}', stderr: '' }
  }

  const s = createOwnershipService({
    root,
    now: () => clock.now,
    registry: async () => BUNDLED_REGISTRY,
    door: createDeactivationDoor({ root, acpBin: '/nonexistent/acp', run }),
    archiver: {
      archive: async () => {
        await ticks(delay())

        return { ok: true, dir: '/tmp/x', remote: null }
      },
      ghStatus: async () => ({ ok: true, detail: '' })
    } as never,
    verify: async () => {
      clock.now += 1000
      const w = world.at
      const proof = w === 'held' ? heldProof(clock.now, 400) : lostProof(clock.now, TX[w], w === 'A' ? 90 : 500)
      await pass('verify')

      return proof
    }
  })

  const renames = (tx: string) =>
    calls.filter(a => a.includes('update') && a.join(' ').includes('0x' + tx.repeat(32))).length

  return { s, clock, world, gates, renames }
}

async function lostA(h: ReturnType<typeof harness>) {
  await h.s.observe(OWNER, [ITEM])
  h.world.at = 'A'
  await h.s.check(SLUG)
  expect(readRecord(root, SLUG)?.state).toBe('lost')
}

describe('R9 r6 — one mutate door for every ownership.json writer', () => {
  it('a header report during a check is applied to the record the check writes (no lost write)', async () => {
    const h = harness()
    await lostA(h)
    const g = gate()
    h.gates.verify = g
    const checking = h.s.check(SLUG)
    await g.at
    const marked = h.s.promptHeaderWritten(PROFILE)
    g.open()
    await checking
    expect(await marked).toBe(1)
    expect(readRecord(root, SLUG)?.promptHeaderAt).not.toBeNull()
  })

  it('presaleDetached during a check survives the check', async () => {
    const h = harness()
    await h.s.observe(OWNER, [ITEM])
    expect((await h.s.prepareSell(SLUG, false)).ok).toBe(true)
    const g = gate()
    h.gates.verify = g
    const checking = h.s.check(SLUG)
    await g.at
    const detached = h.s.presaleDetached(SLUG, 2)
    g.open()
    await checking
    expect((await detached)?.state).toBe('held')
    expect(readRecord(root, SLUG)?.presale?.detachedAt).toBeTypeOf('number')
  })

  it('Delete chosen, the token returns mid-door: no persona deletion is asked for, the local data stays', async () => {
    const h = harness()
    await lostA(h)
    const g = gate()
    h.gates.update = g
    const chosen = h.s.choose(SLUG, 'delete', '#7')
    await g.at
    h.world.at = 'held'
    await h.s.check(SLUG)
    g.open()
    const res = await chosen
    const rec = readRecord(root, SLUG)

    expect(res.ok).toBe(true)
    expect(res.deleteHermesProfile).toBe(false)
    expect(res.note).toMatch(/came back/)
    expect(rec?.state).toBe('held')
    expect(rec?.history.some(e => /not applied/.test(e.note))).toBe(true)
    expect(rec?.cycles?.at(-1)?.choice?.deletePending).toBe(true)
  })

  it('Delete chosen and the cycle stays open: deleteHermesProfile=true', async () => {
    const h = harness()
    await lostA(h)
    const res = await h.s.choose(SLUG, 'delete', '#7')

    expect(res.deleteHermesProfile).toBe(true)
    expect(h.renames(TX.A)).toBe(1)
  })

  it('Keep chosen while a Delete door runs: neither call asks for the persona deletion, the local data stays', async () => {
    const h = harness()
    await lostA(h)
    const g = gate()
    h.gates.update = g
    const del = h.s.choose(SLUG, 'delete', '#7')
    await g.at
    const keep = h.s.choose(SLUG, 'keep', '#7')
    g.open()
    const [resDel, resKeep] = await Promise.all([del, keep])
    const rec = readRecord(root, SLUG)

    expect(resDel.ok).toBe(true)
    expect(resDel.deleteHermesProfile).toBe(false)
    expect(resDel.note).toMatch(/later answer \(keep\)/)
    expect(resKeep.deleteHermesProfile).toBe(false)
    expect(rec?.choice).toMatchObject({ kind: 'keep', deletePending: false })
    expect(rec?.history.some(e => /delete not applied: replaced by the later answer keep/.test(e.note))).toBe(true)
    expect(rec?.history.some(e => /deletion done/.test(e.note))).toBe(false)
    expect(h.renames(TX.A)).toBe(1)
  })

  it('Delete chosen and the cycle stays open: the persona is marked removed and the local deletion completes', async () => {
    const h = harness()
    await lostA(h)
    const res = await h.s.choose(SLUG, 'delete', '#7')
    const rec = readRecord(root, SLUG)

    expect(res.deleteHermesProfile).toBe(true)
    expect(rec?.personaRemovedAt).toBeTypeOf('number')
    expect(rec?.deactivation?.steps.find(s => s.step === 'prompt')).toMatchObject({
      ok: true,
      detail: 'persona deleted'
    })
    expect(rec?.deactivation?.complete).toBe(true)
    expect(rec?.choice?.deletePending).toBe(false)
    expect(rec?.history.some(e => /deletion done/.test(e.note))).toBe(true)
  })

  for (const later of ['keep', 'later'] as const) {
    it(`Delete then ${later} mid-door: the persona is never marked removed, the prompt step waits for the header report`, async () => {
      const h = harness()
      await lostA(h)
      const g = gate()
      h.gates.update = g
      const del = h.s.choose(SLUG, 'delete', '#7')
      await g.at
      const other = h.s.choose(SLUG, later, '')
      g.open()
      const [resDel, resOther] = await Promise.all([del, other])
      const rec = readRecord(root, SLUG)

      expect(resDel.deleteHermesProfile).toBe(false)
      expect(resDel.note).toMatch(new RegExp(`later answer \\(${later}\\)`))
      expect(resOther.deleteHermesProfile).toBe(false)
      expect(rec?.choice).toMatchObject({ kind: later, deletePending: false })
      expect(rec?.personaRemovedAt ?? null).toBeNull()
      expect(rec?.deactivation?.steps.find(s => s.step === 'prompt')?.ok).toBe(false)
      expect(rec?.deactivation?.complete).toBe(false)
      expect(rec?.history.some(e => /deletion done/.test(e.note))).toBe(false)

      expect(await h.s.promptHeaderWritten(PROFILE)).toBe(1)
      const healed = readRecord(root, SLUG)

      expect(healed?.deactivation?.steps.find(s => s.step === 'prompt')).toMatchObject({ ok: true })
      expect(healed?.deactivation?.complete).toBe(true)
      expect(healed?.personaRemovedAt ?? null).toBeNull()
      expect(h.renames(TX.A)).toBe(1)
    })
  }

  it('Delete chosen while a Keep door runs: only the Delete call asks for the persona deletion', async () => {
    const h = harness()
    await lostA(h)
    const g = gate()
    h.gates.update = g
    const keep = h.s.choose(SLUG, 'keep', '#7')
    await g.at
    const del = h.s.choose(SLUG, 'delete', '#7')
    g.open()
    const [resKeep, resDel] = await Promise.all([keep, del])
    const rec = readRecord(root, SLUG)

    expect(resKeep.deleteHermesProfile).toBe(false)
    expect(resDel.deleteHermesProfile).toBe(true)
    // The Delete's own after-door step marks the persona removed, settles the prompt step and deletes at once.
    expect(rec?.choice).toMatchObject({ kind: 'delete', deletePending: false })
    expect(rec?.personaRemovedAt).toBeTypeOf('number')
    expect(rec?.deactivation?.complete).toBe(true)
    expect(rec?.history.filter(e => /deletion done/.test(e.note))).toHaveLength(1)
    expect(rec?.history.some(e => /not applied/.test(e.note))).toBe(false)
    expect(h.renames(TX.A)).toBe(1)
  })

  it('cycle B answered while door A runs gets its own door after A (B tx renamed once)', async () => {
    const h = harness()
    await lostA(h)
    const g = gate()
    h.gates.update = g
    const chosenA = h.s.choose(SLUG, 'keep', '#7')
    await g.at
    h.world.at = 'held'
    await h.s.check(SLUG)
    h.world.at = 'B'
    await h.s.check(SLUG)
    const chosenB = h.s.choose(SLUG, 'keep', '#7')
    g.open()
    await chosenA
    const resB = await chosenB
    const rec = readRecord(root, SLUG)

    expect(resB.ok).toBe(true)
    expect(h.renames(TX.B)).toBe(1)
    expect(rec?.deactivation?.steps.find(s => s.step === 'virtuals')?.ok).toBe(true)
  })

  it('two answers for the same cycle share one door', async () => {
    const h = harness()
    await lostA(h)
    await Promise.all([h.s.choose(SLUG, 'keep', '#7'), h.s.choose(SLUG, 'keep', '#7')])

    expect(h.renames(TX.A)).toBe(1)
  })

  // Hostile orderings: every writer races every other at random macrotask offsets (seeded; a failure names its seed).
  it('fuzz: check vs header report vs choose vs return vs re-loss — no lost write, no persona deleted after a return, one door per answered cycle', async () => {
    const failures: string[] = []
    // The race is in the door's ordering, not the disk: 150 seeds of fsync-per-write took 43-60 s under a parallel --full
    // run (the atomic writer's durability has its own tests in electron/lib).
    const fsync = vi.spyOn(fs, 'fsyncSync').mockImplementation(() => {})
    onTestFinished(() => fsync.mockRestore())

    for (let seed = 1; seed <= 150; seed += 1) {
      rmSync(root, { recursive: true, force: true })
      root = mkdtempSync(path.join(os.tmpdir(), 'r9r6-'))

      const rnd = prng(seed)
      const h = harness(() => rnd(4))
      await lostA(h)

      const at = (n: number, fn: () => Promise<unknown>) => ticks(n).then(fn)
      const choice = rnd(2) === 0 ? 'keep' : 'delete'
      const reloss = rnd(2) === 0
      const tReturn = rnd(12)
      const bad: string[] = []
      let marked = 0
      let chosen: { cycle: number | null; ok: boolean } | null = null

      await Promise.all([
        at(rnd(10), async () => {
          const cycle = readRecord(root, SLUG)?.provenAt ?? null
          const res = await h.s.choose(SLUG, choice, '#7')
          const now = readRecord(root, SLUG)
          chosen = { cycle, ok: res.ok }

          if (res.deleteHermesProfile && (now?.state !== 'lost' || now.provenAt !== cycle)) {
            bad.push('persona deleted after a return')
          }
        }),
        at(rnd(10), async () => {
          marked = await h.s.promptHeaderWritten(PROFILE)
        }),
        at(rnd(10), () => h.s.check(SLUG)),
        at(tReturn, async () => {
          h.world.at = 'held'
          await h.s.check(SLUG)

          if (reloss) {
            await ticks(rnd(6))
            h.world.at = 'B'
            await h.s.check(SLUG)
          }
        }),
        at(rnd(12), () => h.s.tick())
      ])

      // Settle against the final world, then answer whatever cycle is open: its door must run exactly once.
      await h.s.check(SLUG)
      const end = readRecord(root, SLUG)

      if (!end) {
        bad.push('record gone')
      } else {
        const everywhere = [end, ...(end.cycles ?? [])]

        if (marked > 0 && !everywhere.some(c => c.promptHeaderAt)) {
          bad.push('header report lost')
        }

        const c = chosen as { cycle: number | null; ok: boolean } | null

        if (c?.ok && !everywhere.some(x => x.choice?.kind === choice)) {
          bad.push('owner choice lost')
        }

        if (h.renames(TX.A) > 1 || h.renames(TX.B) > 1) {
          bad.push(`door ran twice (A=${h.renames(TX.A)} B=${h.renames(TX.B)})`)
        }

        if (end.state === 'lost') {
          const tx = end.transfer?.txHash.includes(TX.B) ? TX.B : TX.A
          await h.s.choose(SLUG, 'keep', '#7')

          if (h.renames(tx) !== 1) {
            bad.push(`open cycle ${tx} door runs=${h.renames(tx)}`)
          }
        }
      }

      if (bad.length) {
        failures.push(`seed ${seed} (${choice}, reloss=${reloss}): ${bad.join('; ')}`)
      }
    }

    expect(failures).toEqual([])
  }, 60_000)
})
