import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  type CommandRunner,
  createDeactivationDoor,
  createOwnershipService,
  economyRefusal,
  isInftDeactivated
} from './iclone-ownership'
import type { ProofResult } from './iclone-ownership-proof'
import { BUNDLED_REGISTRY } from './iclone-ownership-registry'
import { ownershipFile, readRecord, writeRecord } from './iclone-ownership-store'

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
const HOUR = 3_600_000
const T0 = 1_800_000_000_000
const SEND = ['wallet', 'send-transaction', '--to', BUYER, '--value', '1']

const lostProof = (now: number, tx = 'cd', block = 90): ProofResult => ({
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

const heldProof = (now: number, block = 100): ProofResult => ({
  verdict: 'held',
  verifications: [],
  transfer: null,
  head: { number: block, timestamp: now / 1000 },
  agentStatus: null,
  reason: 'held'
})

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
  root = mkdtempSync(path.join(os.tmpdir(), 'r9r5-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** The production door over a fake CLI; `updateGate` blocks the first `agent update`. */
function harness(opts: { updateGate?: ReturnType<typeof gate>; archiveGate?: ReturnType<typeof gate> } = {}) {
  const clock = { now: T0 }
  let next = heldProof(T0)
  let verifyGate: ReturnType<typeof gate> | undefined
  let updateGate = opts.updateGate
  let archiveGate = opts.archiveGate
  const calls: string[][] = []

  const run: CommandRunner = async (_bin, args) => {
    calls.push(args)

    if (args.includes('update') && updateGate) {
      const g = updateGate
      updateGate = undefined
      g.reached()
      await g.hold
    }

    return { code: 0, stdout: args.includes('whoami') ? '{"data":{"name":"iCLONE Original"}}' : '{}', stderr: '' }
  }

  const archiver = {
    archive: async () => {
      if (archiveGate) {
        const g = archiveGate
        archiveGate = undefined
        g.reached()
        await g.hold
      }

      return { ok: true, dir: '/tmp/x', remote: null }
    },
    ghStatus: async () => ({ ok: true, detail: '' })
  }

  const door = createDeactivationDoor({ root, acpBin: '/nonexistent/acp', run })

  const s = createOwnershipService({
    root,
    now: () => clock.now,
    registry: async () => BUNDLED_REGISTRY,
    door,
    archiver: archiver as never,
    verify: async () => {
      const proof = next

      if (verifyGate) {
        const g = verifyGate
        verifyGate = undefined
        g.reached()
        await g.hold
      }

      return proof
    }
  })

  const renames = (tx?: string) =>
    calls.filter(a => a.includes('update') && (!tx || a.join(' ').includes('0x' + tx.repeat(32)))).length

  return {
    s,
    clock,
    renames,
    set: (p: ProofResult) => (next = p),
    blockNextVerify: (g: ReturnType<typeof gate>) => (verifyGate = g)
  }
}

async function provenLost(h: ReturnType<typeof harness>, tx = 'cd') {
  await h.s.observe(OWNER, [ITEM])
  h.clock.now += HOUR
  h.set(lostProof(h.clock.now, tx))
  await h.s.check(SLUG)
}

describe('R9 r5 — the store fails closed on a corrupt primary', () => {
  it('corrupt primary + mirror lost: the gate refuses on the FIRST call and the primary is restored', async () => {
    await provenLost(harness())
    writeFileSync(ownershipFile(root, SLUG), '{"schema":1, torn')

    expect(economyRefusal(SLUG, SEND, root)).toMatch(/deactivated/i)
    expect(readdirSync(path.dirname(ownershipFile(root, SLUG))).some(f => f.includes('.corrupt-'))).toBe(true)
    expect(readRecord(root, SLUG)?.state).toBe('lost')
    expect(economyRefusal(SLUG, SEND, root)).toMatch(/deactivated/i)
  })

  it('a well-formed but invalid primary (held, no proof fields) also falls back to the mirror', async () => {
    await provenLost(harness())
    writeFileSync(ownershipFile(root, SLUG), JSON.stringify({ schema: 1, slug: SLUG, state: 'held' }))

    expect(isInftDeactivated(SLUG, root)).toBe(true)
    expect(economyRefusal(SLUG, SEND, root)).not.toBeNull()
  })
})

describe('R9 r5 — the door writes only into its own loss cycle', () => {
  it('a return while the door renames: the held record stays clean; the late steps go to the closed cycle', async () => {
    const g = gate()
    const h = harness({ updateGate: g })
    await provenLost(h)
    const lostAt = readRecord(root, SLUG)?.provenAt
    const chosen = h.s.choose(SLUG, 'keep', '#7')
    await g.at

    h.clock.now += HOUR
    h.set(heldProof(h.clock.now, 400))
    await h.s.check(SLUG)
    g.open()
    expect((await chosen).ok).toBe(true)

    const r = readRecord(root, SLUG)
    expect(r?.state).toBe('held')
    expect(r?.deactivation).toBeNull()
    expect(r?.choice).toBeNull()
    const cycle = r?.cycles?.at(-1)
    expect(cycle?.provenAt).toBe(lostAt)
    expect(cycle?.deactivation?.steps.find(s => s.step === 'virtuals')?.ok).toBe(true)
    expect(r?.history.at(-1)?.note).toMatch(/door finished after the return/)
    expect(economyRefusal(SLUG, SEND, root)).toBeNull()

    // the re-loss: a fresh cycle, the door runs again with the NEW tx
    h.clock.now += 24 * HOUR
    h.set(lostProof(h.clock.now, 'ef', 500))
    await h.s.check(SLUG)
    const relost = readRecord(root, SLUG)
    expect(relost?.deactivation).toBeNull()
    expect(relost?.choice).toBeNull()
    expect((await h.s.choose(SLUG, 'keep', '#7')).ok).toBe(true)
    expect(h.renames('ef')).toBe(1)
    expect(readRecord(root, SLUG)?.deactivation?.steps.find(s => s.step === 'virtuals')?.ok).toBe(true)
  })

  it('entering lost resets stale deactivation/choice/prompt fields left on a held record', async () => {
    const h = harness()
    await h.s.observe(OWNER, [ITEM])
    const held = readRecord(root, SLUG)!

    const stale = {
      ...held,
      deactivation: {
        appliedAt: T0,
        by: 'owner' as const,
        steps: (['onchain', 'virtuals', 'prompt'] as const).map(step => ({ step, ok: true, detail: 'old' })),
        complete: true,
        attempts: 1,
        firstAt: T0
      },
      promptHeaderAt: T0,
      personaRemovedAt: T0
    }

    expect(writeRecord(root, stale)).toBe(true)

    h.clock.now += HOUR
    h.set(lostProof(h.clock.now, 'ef'))
    await h.s.check(SLUG)
    const r = readRecord(root, SLUG)
    expect(r?.state).toBe('lost')
    expect(r?.deactivation).toBeNull()
    expect(r?.promptHeaderAt ?? null).toBeNull()
    expect(r?.personaRemovedAt ?? null).toBeNull()
    expect((await h.s.choose(SLUG, 'keep', '#7')).ok).toBe(true)
    expect(h.renames('ef')).toBe(1)
  })

  it("the door's write waits for a check in flight, so neither write is lost", async () => {
    const door = gate()
    const verify = gate()
    const h = harness({ updateGate: door })
    await provenLost(h)
    const chosen = h.s.choose(SLUG, 'keep', '#7')
    await door.at

    h.blockNextVerify(verify)
    const checking = h.s.check(SLUG)
    await verify.at
    door.open()
    await new Promise(r => setTimeout(r, 10))
    verify.open()
    await checking
    await chosen

    const r = readRecord(root, SLUG)
    expect(r?.state).toBe('lost')
    expect(r?.deactivation?.steps.find(s => s.step === 'virtuals')?.ok).toBe(true)
    expect(r?.choice?.kind).toBe('keep')
  })

  it('two callers at once (owner + timer path) run the door once', async () => {
    const g = gate()
    const h = harness({ updateGate: g })
    await provenLost(h)
    const a = h.s.choose(SLUG, 'keep', '#7')
    await g.at
    const b = h.s.choose(SLUG, 'keep', '#7')
    g.open()
    await Promise.all([a, b])

    expect(h.renames()).toBe(1)
    expect(readRecord(root, SLUG)?.deactivation?.attempts).toBe(1)
  })

  it("an owner's answer given while the token comes back is refused, nothing written", async () => {
    const g = gate()
    const h = harness({ archiveGate: g })
    await provenLost(h)
    const chosen = h.s.choose(SLUG, 'archive-local', '#7')
    await g.at

    h.clock.now += HOUR
    h.set(heldProof(h.clock.now, 400))
    await h.s.check(SLUG)
    g.open()

    const res = await chosen
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/came back/)
    expect(readRecord(root, SLUG)?.choice).toBeNull()
    expect(h.renames()).toBe(0)
  })
})
